/**
 * LLM context builder — the MEMORY MODEL boundary (Prompt 8).
 *
 * Four separate stores:
 *   1. Conversational history  (orchestrator, user/assistant text, redacted)
 *   2. BookingSession          (ConversationStateManager — AUTHORITATIVE)
 *   3. Railway tool results    (per-turn records; synced into session by runtime)
 *   4. Temporary LLM context   (THIS — rebuilt from 1+2 every LLM call)
 *
 * The LLM never receives a free-form "memory" it could trust over the session:
 * the structured sessionView is always loaded fresh from BookingSession. When
 * history grows, older turns are compressed into a deterministic summary that
 * is ALSO built from BookingSession — an LLM-generated summary can never
 * replace BookingSession.
 */
import { pendingInfoView, pendingConfirmationOf, missingInformationOf } from '../response/backend-question-policy';
import { nextPassengerDetail, optionalToAsk, optionalUnanswered, optionalAlreadyAsked, passengerOptionsView, berthLabel, foodLabel } from '../../booking/passenger-options';
import { isLatinName } from '../../booking/passenger-validator';
import { referenceContextView } from './reference-context';
import type { BookingSession } from '@shared/entities';
import { currentResults } from './train-reference-resolver';
import { BookingState } from '@shared/states';
import { STATE_ORDER } from '../state/state-transition-validator';
import { availabilityStatus, fareStatus } from '../../booking/preparation/booking-preparation-guard';
import { sameTrainResultsOf, isSameTrainResultStale } from '../../railway/same-train/same-train-service';
import { isVerifiedSameTrainAlternative } from '@shared/same-train-shortage';
import { syncJourneyVersion } from '../tool-runtime/journey-version';
import { reviewStatusOf, confirmationStatusOf } from '../../booking/preparation/booking-preparation';
import type { PostBookingContextView } from '../../booking/post-booking/post-booking-service';

export interface HistoryMsg { role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolName?: string; /** Prompt 16: active journey the message belongs to */ journeyId?: string }

export interface LLMContext {
  /** Authoritative snapshot (safe fields only; no secrets ever stored). */
  sessionView: {
    state: string;
    origin?: string; originName?: string; destination?: string; destinationName?: string;
    date?: string; passengersCount?: number; preferredClass?: string; preferredTime?: string;
    selectedTrain?: { number: string; name: string; availableClasses: string[] } | null;
    selectedClass?: string | null;
    /** P42.7: the class code the user named at search (may differ from / precede a selection) */
    requestedClass?: string | null;
    focusTrainNumber?: string; previousTrainNumber?: string;
    fareVerified: boolean; availabilityVerified: boolean;
    passengerDetails: { required: number; completed: number; currentIndex: number };
    sessionVersion: number;
  };
  /** P42.1: structured (type + data + missingField) — no canned hint / question text. */
  pendingInteraction: BookingSession['pendingInteraction'];
  /** P42.1: what is still missing for the booking flow — present / missing per field (structured, never a question). */
  missingInformation?: Record<string, 'present' | 'missing'>;
  /** P42.1 (Category B): a protected step awaiting the user's explicit confirmation. The backend verifies the
   *  confirmation itself before any protected mutation; the LLM only words the request. */
  pendingConfirmation?: { action: string; confirmationRequired: true; confirmationStatus: 'PENDING' } | null;
  searchResults: { version: number; trains: Array<{ displayIndex: number; trainNumber: string; trainName: string; departure: string; arrival: string; duration: string; classes: string[] }> };
  /** Deterministic summary of compressed older turns (from BookingSession). */
  summary?: string;
  recentMessages: HistoryMsg[];
  /**
   * Prompt 12 — normalized, READ-ONLY booking execution summary (status / provider /
   * failure category / authoritative PNR). The LLM cannot change it and has no tool to
   * execute bookings. Never contains provider config, URLs, credentials or raw responses.
   */
  bookingExecution?: { providerName: string; status: string; code: string; failureCode?: string; providerReference?: string; pnrAvailable?: boolean; retryBlocked: boolean };
  /**
   * Prompt 14 — AUTHORITATIVE_BACKEND_CONTEXT: backend-owned booking history summary (read-only).
   * Contains NO PNR values (only pnrAvailable), no credentials, no raw provider data.
   */
  postBooking?: PostBookingContextView;
  /**
   * Prompt 16 — STRUCTURED conversation context (ConversationContextSummarizer): active journey,
   * displayed result set, pending question, missing slots, verified flags. Deterministic; built
   * from BookingSession — never an LLM-written summary, never PNR values / names / secrets.
   */
  conversationContext?: Readonly<Record<string, any>>;
  /**
   * Prompt 30 — what references can point at: the active result set's journey (display positions address ONLY it),
   * the current focus, and the previous choice for an older journey (an expired preference, never a fact).
   * No internal ids.
   */
  referenceContext?: ReturnType<typeof referenceContextView>;
  /** Prompt 33: structured booking preparation state (what is known / missing) — the LLM decides what to ask next. */
  bookingPreparation?: ReturnType<typeof bookingPreparationView>;
  /** P42.4 (Part 2.1): compact memory versions + same-train selection / shown alternatives (current journey only). */
  memory?: ReturnType<typeof memoryContextView>;
}

export const LLM_CONTEXT_VERSION = 'p42.7-memory-2';

/**
 * P42.4 — Part 2.1 memory block: versions the LLM needs to tell current facts from stale ones, plus the same-train
 * selection the backend applied and the same-train results currently on screen. Only results / selections that still
 * belong to the CURRENT journey are included (a changed date / train / class / route drops them — counted in
 * staleRejected). Station codes / statuses only; no names, no ids beyond the result id the UI uses.
 */
/**
 * P42.10 (Part 27): memory is an enhancement, never a hard dependency — if the memory view cannot be built, the turn
 * continues with the current session / conversation context + fresh railway tools (memory block omitted). Safe log:
 * event + error type only (no memory contents, no PII).
 */
export function safeMemoryContextView(s: BookingSession): ReturnType<typeof memoryContextView> | undefined {
  try { return memoryContextView(s); }
  catch (e) {
    try { console.log(JSON.stringify({ event: 'memory_unavailable', memoryRead: false, errorType: (e as any)?.name || 'Error' })); } catch { /* never break the turn */ }
    return undefined;
  }
}

export function memoryContextView(s: BookingSession) {
  const x: any = s;
  const sel: any = x.sameTrainSelection;
  const selTrain = s.selectedTrain ? String((s.selectedTrain as any).number ?? (s.selectedTrain as any).trainNumber ?? '') : '';
  const selCurrent = !!sel && s.origin === sel.ticketOrigin && s.destination === sel.ticketDestination && s.date === sel.date
    && selTrain === sel.trainNumber && String(s.selectedClass || '').toUpperCase() === sel.travelClass;
  const all = [...sameTrainResultsOf(s), ...((x.sameTrainAutoSets || []) as any[])];
  const seen = new Set<string>();
  const uniq = all.filter(r => r?.alternativeSearchId && !seen.has(r.alternativeSearchId) && (seen.add(r.alternativeSearchId), true));
  const current = uniq.filter(r => !isSameTrainResultStale(s, r));
  const staleRejected = (uniq.length - current.length) + (sel && !selCurrent ? 1 : 0);
  return {
    contextVersion: LLM_CONTEXT_VERSION,
    sessionVersion: s.sessionVersion,
    journeyVersion: syncJourneyVersion(s),
    reviewVersion: s.review?.reviewVersion ?? null,
    // P42.7 Part 44: review status + the class the user asked for (selected → named at search; null = unknown)
    reviewStatus: s.review ? reviewStatusOf(s) : null,
    requestedClass: (s.selectedClass || x.requestedClass) ? String(s.selectedClass || x.requestedClass).toUpperCase() : null,
    resultSetId: (s.searchResults as any)?.resultId ?? null,
    ...(selCurrent ? { sameTrainSelection: {
      trainNumber: sel.trainNumber, travelClass: sel.travelClass, date: sel.date,
      ticketOrigin: sel.ticketOrigin, ticketDestination: sel.ticketDestination,
      requestedOrigin: sel.requestedOrigin, requestedDestination: sel.requestedDestination,
      boardingStation: sel.boardingStation, alightingStation: sel.alightingStation,
      boardingRuleStatus: sel.boardingRuleStatus, alightingRuleStatus: sel.alightingRuleStatus,
      freshStatus: sel.freshStatus, fetchedAt: sel.fetchedAt, appliedBy: 'BACKEND_AFTER_FRESH_CHECK'
    } } : {}),
    ...(current.length ? { sameTrainShown: current.slice(0, 8).map(r => ({
      trainNumber: r.trainNumber, travelClass: r.travelClass, source: r.triggerSource === 'AUTO_DISPLAY' ? 'AUTO_DISPLAY' : 'TOOL',
      verifiedOptions: (r.alternatives || []).filter((a: any) => isVerifiedSameTrainAlternative(a)).length, completedAt: r.completedAt ?? null,
      // P42.7: matrix coverage + which classes have a verified option (codes only; Muse presents, the backend never ranks)
      ...(Array.isArray(r.classesChecked) ? { classesChecked: r.classesChecked.join(',') } : {}),
      verifiedClasses: [...new Set((r.alternatives || []).filter((a: any) => isVerifiedSameTrainAlternative(a)).map((a: any) => String(a.travelClass)))].join(',') || null,
      resultSetId: r.resultSetId ?? null
    })) } : {}),
    staleRejected
  };
}

/** P42.4 — safe metadata for the `llm_context` log: field NAMES / versions / counts only — never values. */
export function llmContextLogRecord(ctx: any, s: BookingSession): Record<string, unknown> {
  const m = ctx?.memory || {};
  const used: string[] = [];
  const sv = ctx?.sessionView || {};
  if (sv.origin || sv.destination) used.push('route');
  if (sv.date) used.push('date');
  if (sv.passengersCount) used.push('passengersCount');
  if (sv.selectedTrain) used.push('selectedTrain');
  if (sv.selectedClass) used.push('selectedClass');
  const bp = ctx?.bookingPreparation;
  if (bp?.passengers?.some((p: any) => p.name || p.age || p.gender)) used.push('passengerFields');
  if (bp?.nextToAsk) used.push('nextToAsk');
  if (m.reviewVersion != null) used.push('review');
  if (m.sameTrainSelection) used.push('sameTrainSelection');
  if (m.sameTrainShown) used.push('sameTrainShown');
  if (ctx?.searchResults?.trains?.length) used.push('displayedTrains');
  if (ctx?.recentMessages?.length) used.push('recentTurns');
  if (ctx?.turnContext?.lastToolResults?.length) used.push('toolResults');
  return {
    event: 'llm_context',
    contextFieldsProvided: Object.keys(ctx || {}).filter(k => ctx[k] !== undefined && ctx[k] !== null),
    contextVersion: m.contextVersion ?? LLM_CONTEXT_VERSION,
    journeyVersion: m.journeyVersion ?? s.journeyVersion ?? null,
    pendingInteraction: (s.pendingInteraction as any)?.type ?? null,
    memoryFieldsUsed: used,
    staleContextRejected: Number(m.staleRejected || 0)
  };
}

const DEP_VIEW: Record<string, string> = { AVAILABLE: 'MATCHING_RESULT', STALE: 'STALE', UNAVAILABLE: 'LAST_CHECK_FAILED', NOT_REQUESTED: 'NOT_CHECKED' };

/**
 * Prompt 33 — the booking preparation state as the LLM sees it. Built from the authoritative BookingSession (no second
 * state system): known journey / train / class / passengers, and `missing` = what review still needs. Statuses only —
 * no fare amounts or availability values (those come from THIS turn's tool results or the review), no internal ids,
 * no credentials (never collected). The LLM decides what to ask; the backend only validates what it proposes.
 */
export function bookingPreparationView(s: BookingSession) {
  const t: any = s.selectedTrain;
  const started = !!t || !!s.selectedClass || !!s.passengersCount || STATE_ORDER.indexOf(s.bookingState) >= STATE_ORDER.indexOf(BookingState.TRAIN_SELECTED);
  if (!started) return undefined;
  const count = s.passengersCount || 0;
  const passengers = Array.from({ length: count }, (_, k) => {
    const p: any = (s.passengers || [])[k] || {};
    // P42.1 hardening: a stored non-Latin name is not a valid IRCTC name → still missing, with a structured reason
    const badName = !!p.name && !isLatinName(p.name);
    const miss = (['name', 'age', 'gender'] as const).filter(f => p[f] === undefined || p[f] === null || p[f] === '' || (f === 'name' && badName));
    return { passenger: k + 1, ...(p.name && !badName ? { name: p.name } : {}), ...(p.age ? { age: p.age } : {}), ...(p.gender ? { gender: p.gender } : {}),
      ...(p.berthPreference ? { berthPreference: p.berthPreference } : {}), ...(p.foodPreference ? { foodPreference: p.foodPreference } : {}), missing: miss,
      ...(badName ? { invalid: [{ field: 'name', reason: 'INVALID_PASSENGER_NAME_SCRIPT', userActionRequired: true }] } : {}) };
  });
  // P39.2: optional details this train + class actually offer and the user has not answered yet (ask once)
  const alsoAsk: string[] = [];
  for (let k = 0; k < count; k++) for (const f of optionalToAsk(s, (s.passengers || [])[k])) alsoAsk.push(`passenger${k + 1}.${f}`);
  // P42.1 hardening: optional details already asked once and still unanswered (never asked again; may be volunteered)
  const alreadyAsked: string[] = [];
  for (let k = 0; k < count; k++) {
    const p = (s.passengers || [])[k];
    for (const f of optionalUnanswered(s, p)) if (optionalAlreadyAsked(s, p, f)) alreadyAsked.push(`passenger${k + 1}.${f}`);
  }
  // …and the one the previous reply asked (still unanswered): a short answer that fits it maps there
  const la: any = (s as any).lastAskedOptional;
  const laP: any = la ? (s.passengers || [])[la.passenger - 1] : null;
  const lastAsked = la && laP && laP.id === la.passengerId && !laP[la.field] ? (() => {
    const o = la.field === 'berthPreference' ? passengerOptionsView(s)?.berth : passengerOptionsView(s)?.food;
    return { passenger: la.passenger, field: la.field, ...(o?.options?.length ? { options: [...o.options], optionLabels: o.options.map((v: string) => la.field === 'berthPreference' ? berthLabel(v) : foodLabel(v)) } : {}) };
  })() : null;
  // v0.39.6: the next single passenger detail still open, in the order the user asked for (name → age → berth → gender →
  // meal; berth / meal only when this train + class offer them) — passenger 1 is finished before passenger 2. A fact
  // derived from the session; the LLM writes the question.
  const nx = nextPassengerDetail(s);
  const nxOpts = nx?.field === 'berthPreference' ? passengerOptionsView(s)?.berth.options : nx?.field === 'foodPreference' ? passengerOptionsView(s)?.food.options : undefined;
  const nextToAsk = nx ? { ...nx, ...(nxOpts?.length ? { options: [...nxOpts], optionLabels: nxOpts.map(v => nx.field === 'berthPreference' ? berthLabel(v) : foodLabel(v)) } : {}), askOnlyThis: true,
    saveAnswerWith: `update_booking_session entities.passengerChanges [{ passengerIndex: ${nx.passenger}, changes: { ${nx.field}: <answer> } }] — before replying` } : null;
  const missing: string[] = [];
  if (!s.origin) missing.push('origin');
  if (!s.destination) missing.push('destination');
  if (!s.date) missing.push('journeyDate');
  if (!t) missing.push('train');
  if (!s.selectedClass) missing.push('class');
  if (!count) missing.push('passengerCount');
  passengers.forEach(p => p.missing.forEach(f => missing.push(`passenger${p.passenger}.${f}`)));
  const review = s.review ? { version: s.review.reviewVersion, status: reviewStatusOf(s) } : null;
  return {
    origin: s.origin ?? null, destination: s.destination ?? null, journeyDate: s.date ?? null,
    train: t ? { number: String(t.number || t.trainNumber), name: t.name || t.trainName } : null,
    class: s.selectedClass ?? null, passengerCount: count || null, passengers, missing,
    // P39.2: berth choices of the selected class + meal status from provider data (NOT_CHECKED → GET_TRAIN_INFO)
    ...((): { passengerOptions?: ReturnType<typeof passengerOptionsView> } => { const o = passengerOptionsView(s); return o ? { passengerOptions: o } : {}; })(),
    ...(alsoAsk.length ? { alsoAsk } : {}),
    ...(alreadyAsked.length ? { optionalAlreadyAsked: alreadyAsked } : {}),
    ...(lastAsked ? { lastAsked } : {}),
    ...(nextToAsk ? { nextToAsk } : {}),
    // matching provider result for the CURRENT train/class/date/route (not a value — never reuse an old fare/availability)
    availabilityCheck: DEP_VIEW[availabilityStatus(s).status], fareCheck: DEP_VIEW[fareStatus(s).status],
    review, confirmation: confirmationStatusOf(s), handoff: s.handoffSession?.status ?? s.handoff?.status ?? null
  };
}

export const MAX_RECENT_MESSAGES = 12;

export function buildLLMContext(s: BookingSession, history: HistoryMsg[], maxRecent = MAX_RECENT_MESSAGES, postBooking?: PostBookingContextView): LLMContext {
  const t: any = s.selectedTrain;
  const recent = history.filter(h => h.role !== 'tool').slice(-maxRecent);
  const compressed = history.filter(h => h.role !== 'tool').length > maxRecent;
  return {
    sessionView: {
      state: s.bookingState,
      origin: s.origin, originName: s.originName, destination: s.destination, destinationName: s.destinationName,
      date: s.date, passengersCount: s.passengersCount, preferredClass: s.preferredClass, preferredTime: s.preferredTime,
      selectedTrain: t ? { number: t.number || t.trainNumber, name: t.name || t.trainName, availableClasses: t.availableClasses || (t.classes || []).map((c: any) => c.code) } : null,
      selectedClass: s.selectedClass ?? null,
      requestedClass: (s as any).requestedClass ?? null,
      focusTrainNumber: s.focusTrainNumber, previousTrainNumber: s.previousTrainNumber,
      fareVerified: !!s.fare, availabilityVerified: !!s.availability,
      passengerDetails: {
        required: s.passengersCount || 0,
        completed: (s.passengers || []).filter(p => p.name && p.age && p.gender).length,
        currentIndex: s.currentPassengerIndex || 0,
        // P38: details given before train/class exist are held (applied automatically once both are selected)
        ...((s as any).heldPassengerChanges ? { heldUntilTrainAndClassSelected: (s as any).heldPassengerChanges.changes.length } : {})
      },
      sessionVersion: s.sessionVersion
    },
    pendingInteraction: (pendingInfoView(s.pendingInteraction) ?? s.pendingInteraction) as any,
    missingInformation: missingInformationOf(s),
    pendingConfirmation: pendingConfirmationOf(s, s.bookingState === BookingState.AWAITING_CONFIRMATION),
    searchResults: {
      version: s.searchResultsVersion,
      trains: currentResults(s).map(x => ({
        displayIndex: x.displayIndex, trainNumber: x.trainNumber, trainName: x.trainName,
        departure: x.departure, arrival: x.arrival, duration: x.duration, classes: (x.classes || []).map(c => c.code)
      }))
    },
    ...((): { memory?: ReturnType<typeof memoryContextView> } => { const m = safeMemoryContextView(s); return m ? { memory: m } : {}; })(),
    referenceContext: referenceContextView(s),
    ...((): { bookingPreparation?: ReturnType<typeof bookingPreparationView> } => { const v = bookingPreparationView(s); return v ? { bookingPreparation: v } : {}; })(),
    summary: compressed ? summarizeFromSession(s) : undefined,
    recentMessages: recent,
    ...(s.bookingExecution ? { bookingExecution: Object.freeze({
      providerName: s.bookingExecution.providerName, status: s.bookingExecution.status, code: s.bookingExecution.code,
      ...(s.bookingExecution.failureCode ? { failureCode: s.bookingExecution.failureCode } : {}),
      ...(s.bookingExecution.providerReference ? { providerReference: s.bookingExecution.providerReference } : {}),
      // Prompt 14: the PNR value never enters LLM context — only whether one exists
      ...(s.bookingExecution.status === 'CONFIRMED' ? { pnrAvailable: !!s.bookingExecution.pnr } : {}),
      retryBlocked: s.bookingExecution.retryBlocked
    }) } : {}),
    ...(postBooking ? { postBooking } : {})
  };
}

/** Deterministic summary — authoritative values only. */
export function summarizeFromSession(s: BookingSession): string {
  const t: any = s.selectedTrain;
  const parts = [
    s.origin || s.destination ? `journey=${s.origin || '?'}→${s.destination || '?'}` : null,
    s.date ? `date=${s.date}` : null,
    s.passengersCount ? `passengers=${s.passengersCount}` : null,
    s.preferredClass && s.preferredClass !== 'ANY' ? `pref=${s.preferredClass}` : null,
    t ? `selectedTrain=${t.number || t.trainNumber}` : null,
    s.selectedClass ? `selectedClass=${s.selectedClass}` : null,
    s.pendingInteraction && s.pendingInteraction.type !== 'NONE' ? `pending=${s.pendingInteraction.type}` : null,
    `state=${s.bookingState}`
  ].filter(Boolean);
  return `Earlier conversation summary (from BookingSession): ${parts.join(', ')}`;
}
