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
import { optionalToAsk, passengerOptionsView } from '../../booking/passenger-options';
import { referenceContextView } from './reference-context';
import type { BookingSession } from '@shared/entities';
import { currentResults } from './train-reference-resolver';
import { BookingState } from '@shared/states';
import { STATE_ORDER } from '../state/state-transition-validator';
import { availabilityStatus, fareStatus } from '../../booking/preparation/booking-preparation-guard';
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
    focusTrainNumber?: string; previousTrainNumber?: string;
    fareVerified: boolean; availabilityVerified: boolean;
    passengerDetails: { required: number; completed: number; currentIndex: number };
    sessionVersion: number;
  };
  pendingInteraction: BookingSession['pendingInteraction'];
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
    const miss = (['name', 'age', 'gender'] as const).filter(f => p[f] === undefined || p[f] === null || p[f] === '');
    return { passenger: k + 1, ...(p.name ? { name: p.name } : {}), ...(p.age ? { age: p.age } : {}), ...(p.gender ? { gender: p.gender } : {}),
      ...(p.berthPreference ? { berthPreference: p.berthPreference } : {}), ...(p.foodPreference ? { foodPreference: p.foodPreference } : {}), missing: miss };
  });
  // P39.2: optional details this train + class actually offer and the user has not answered yet (ask once)
  const alsoAsk: string[] = [];
  for (let k = 0; k < count; k++) for (const f of optionalToAsk(s, (s.passengers || [])[k])) alsoAsk.push(`passenger${k + 1}.${f}`);
  // v0.39.6: the next single passenger detail still open, in the order the user asked for (name → age → berth → gender →
  // meal; berth / meal only when this train + class offer them) — passenger 1 is finished before passenger 2. A fact
  // derived from the session; the LLM writes the question.
  let nextToAsk: { passenger: number; field: string } | null = null;
  for (let k = 0; k < count && !nextToAsk; k++) {
    const p: any = (s.passengers || [])[k] || {};
    const opt = optionalToAsk(s, (s.passengers || [])[k]);
    const isMissing = (f: string) => p[f] === undefined || p[f] === null || p[f] === '';
    const order = ['name', 'age', ...(opt.includes('berthPreference') ? ['berthPreference'] : []), 'gender', ...(opt.includes('foodPreference') ? ['foodPreference'] : [])];
    const f = order.find(x => (x === 'berthPreference' || x === 'foodPreference') ? true : isMissing(x));
    if (f) nextToAsk = { passenger: k + 1, field: f };
  }
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
    pendingInteraction: s.pendingInteraction,
    searchResults: {
      version: s.searchResultsVersion,
      trains: currentResults(s).map(x => ({
        displayIndex: x.displayIndex, trainNumber: x.trainNumber, trainName: x.trainName,
        departure: x.departure, arrival: x.arrival, duration: x.duration, classes: (x.classes || []).map(c => c.code)
      }))
    },
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
