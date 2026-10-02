/**
 * ContextualTurnApplier — deterministic application of an LLM decision to the
 * authoritative BookingSession (Prompt 8).
 *
 * The LLM interprets language and proposes entities/references. This class:
 *   - resolves stations (RouteResolver) and dates (DateResolver),
 *   - resolves train references against CURRENT, versioned search results,
 *   - resolves classes against selectedTrain.availableClasses,
 *   - applies corrections changing ONLY the affected slot while invalidating
 *     every dependent railway fact,
 *   - guards confirmation (only at AWAITING_CONFIRMATION + CONFIRMATION_REQUIRED),
 *   - drives every state change through StateTransitionValidator,
 *   - emits typed events with authoritative values.
 *
 * It is invoked by the runtime for EVERY LLM decision BEFORE that decision's
 * tool calls are validated, so "12014 ki CC availability" can select the train
 * + class and then run CHECK_AVAILABILITY in the same turn.
 */
import { classifyConfirmation, AMBIGUOUS_CONFIRMATION_PROMPT } from '../../booking/handoff/confirmation-policy';
import { BookingState, EXECUTION_LOCKED_STATES } from '@shared/states';
import { messageForRecord, SUBMITTING_MESSAGE, UNSAFE_RETRY_MESSAGE, ALREADY_CONFIRMED_MESSAGE, ALREADY_ACTIVE_MESSAGE, VOICE_INTERRUPTION_MESSAGE } from '../../booking/provider/booking-provider-execution-service';

/** Prompt 13: deterministic intent while a booking execution owns the session. */
export type LockedIntent = 'CANCEL' | 'STATUS' | 'RETRY' | 'OTHER';
const CANCEL_RE = /\b(cancel|cancle|ruko|ruk jao|rok do|rokdo|band karo|band kar do|stop|mat karo|rehne do)\b|रुको|कैंसल/i;
const STATUS_RE = /\b(status|kya hua|update|verify|check|confirm hua|hua ya nahi|ho gaya kya|ho gayi kya)\b/i;
const RETRY_RE = /\b(phir se|fir se|phirse|firse|dobara|dubara|again|retry|re-try|book karo|book kar do|book kardo|book it|try karo)\b/i;
export function classifyLockedIntent(raw: string, affirmativeLabel = false): LockedIntent {
  const t = (raw || '').toLowerCase();
  if (CANCEL_RE.test(t)) return 'CANCEL';
  if (STATUS_RE.test(t)) return 'STATUS';
  if (RETRY_RE.test(t) || affirmativeLabel) return 'RETRY';
  return 'OTHER';
}
import type { BookingSession, PendingInteraction, BookingEventType } from '@shared/entities';
import type { AgentDecision, OrchestratorError, OrchestratorErrorCode } from '../decisions/agent-decision';
import type { ConversationStateManager } from '../state/conversation-state';
import { STATE_ORDER } from '../state/state-transition-validator';
import { resolveStationToken } from '../../railway/resolvers/route-resolver';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { TrainReferenceResolver, currentResults, type ResultTrain } from './train-reference-resolver';
import { ClassReferenceResolver } from './class-reference-resolver';
import { passengerCollection, passengerLabel } from '../../booking/passenger-collection';
import { derivePendingInteraction, questionFor } from './pending-interaction';
import { compareArrival, durationMinutes, absoluteArrival, shortName, humanDate } from './response-formatter';
import type { PostBookingService, PostBookingTurn } from '../../booking/post-booking/post-booking-service';

export interface ApplyCtx {
  turnId: string;
  mode: 'TEXT' | 'VOICE';
  cards: Array<{ type: string; data: any }>;
  events: string[];
  changes: string[];
  /** The user's own (normalized) words this turn — the backend ConfirmationPolicy reads them, not the LLM's label. */
  rawText?: string;
  /** Request id of the turn (audit correlation). */
  requestId?: string;
}

export interface ApplyOutcome {
  notes: string[];
  error?: OrchestratorError;
  /** Tool calls attached to this decision must NOT run (context could not be applied). */
  blockTools: boolean;
  pendingOverride?: PendingInteraction;
  /** Deterministic computed answer (comparison / refinement over authoritative results). */
  directAnswer?: string;
  applied: string[];
  /** Explicit confirmation accepted by the guard; BookingPreparationService
   *  verifies review version + freshness and performs the handoff transition. */
  confirmRequested?: boolean;
  /** Non-blocking validation error (e.g. INVALID_PASSENGER_DETAILS for one field). */
  softError?: OrchestratorError;
  /** Confirmation repeated after the handoff exists → routed to gateway idempotency (no new handoff). */
  duplicateConfirmation?: boolean;
  /** Prompt 13: run a bounded provider status check (never a resubmission). */
  reconcileRequested?: boolean;
  /** Prompt 13: explicit user retry after an authoritative FAILED / CANCELLED execution. */
  retryAfterFailure?: boolean;
  /** Prompt 14: post-booking turn (answered from BookingRecords / read-only lookups; no booking progression). */
  postBooking?: boolean;
  /** Prompt 14: only these tools may run for this decision (read-only post-booking lookups). */
  allowedTools?: readonly string[];
}

const ALLOWED_INTENTS = new Set(['GENERAL_RAILWAY_QUERY', 'BOOK_TRAIN', 'SEARCH_TRAINS', 'SELECT_TRAIN', 'SELECT_CLASS', 'UPDATE_JOURNEY', 'UPDATE_DATE', 'UPDATE_PASSENGERS', 'COLLECT_PASSENGER_DETAILS', 'SHOW_REVIEW', 'CONFIRM_BOOKING', 'CANCEL_FLOW', 'UNKNOWN']);
const ALLOWED_ACTIONS = new Set(['ASK_CLARIFICATION', 'SEARCH_TRAINS', 'SELECT_TRAIN', 'SELECT_CLASS', 'UPDATE_JOURNEY', 'UPDATE_DATE', 'UPDATE_PASSENGERS', 'COLLECT_PASSENGER_DETAILS', 'SHOW_REVIEW', 'REQUEST_CONFIRMATION', 'PREPARE_IRCTC_HANDOFF', 'REFINE_RESULTS', 'COMPARE_TRAINS', 'NO_ACTION']);

const idx = (s: BookingState) => STATE_ORDER.indexOf(s);

export class ContextualTurnApplier {
  private trainRefs = new TrainReferenceResolver();
  private classRefs = new ClassReferenceResolver();

  /** Per-turn memo so a multi-iteration tool loop classifies / resolves a post-booking query once. */
  private pbMemo = new Map<string, PostBookingTurn>();

  constructor(private readonly state: ConversationStateManager, private readonly postBooking?: PostBookingService) {}

  apply(sessionId: string, d: AgentDecision, ctx: ApplyCtx): ApplyOutcome {
    const out: ApplyOutcome = { notes: [], blockTools: false, applied: [] };
    const S = () => this.state.getSession(sessionId);
    const e = d?.entities || {};
    const fail = (code: OrchestratorErrorCode, message: string, pendingOverride?: PendingInteraction): ApplyOutcome =>
      ({ ...out, error: { code, message }, blockTools: true, pendingOverride: pendingOverride ?? out.pendingOverride });
    const emit = (type: BookingEventType, data?: Record<string, any>) => { this.state.emit(sessionId, type, ctx.turnId, data); ctx.events.push(type); };

    // 0) Structural validation of untrusted LLM output
    if (!d || typeof d !== 'object' || !ALLOWED_INTENTS.has(d.intent) || !ALLOWED_ACTIONS.has(d.action)) {
      return fail('INVALID_CONTEXT', 'Maaf kijiye, request samajh nahi aayi. Thoda alag tareeke se batayein?');
    }

    // 0b) Prompt 14 — post-booking questions are classified from the user's OWN words and answered
    //     from authoritative BookingRecords (or via read-only CHECK_PNR / TRACK_TRAIN) BEFORE any
    //     entity is applied, so "kal wali booking" can never change the journey date and a PNR
    //     question can never progress / execute / re-submit a booking.
    if (this.postBooking && ctx.rawText) {
      const locked = EXECUTION_LOCKED_STATES.has(S().bookingState);
      let pb = this.pbMemo.get(ctx.turnId);
      if (!pb) {
        pb = this.postBooking.handleTurn(sessionId, ctx.rawText, { locked, mode: ctx.mode, turnId: ctx.turnId, emit, cards: ctx.cards });
        this.pbMemo.clear();
        this.pbMemo.set(ctx.turnId, pb);
      }
      if (pb.type === 'DIRECT') {
        out.applied.push('POST_BOOKING_ANSWER');
        return { ...out, blockTools: true, postBooking: true, directAnswer: pb.answer, ...(pb.softError ? { softError: pb.softError } : {}) };
      }
      if (pb.type === 'ERROR') {
        out.applied.push('POST_BOOKING_CLARIFICATION');
        return { ...fail(pb.code, pb.message), postBooking: true };
      }
      if (pb.type === 'INFO') {
        out.applied.push('POST_BOOKING_LOOKUP');
        return { ...out, blockTools: false, postBooking: true, allowedTools: pb.allowedTools };
      }
    }

    // 1) Confirmation guard — "haan/yes/confirm/book it/continue" is booking
    //    confirmation ONLY when state === AWAITING_CONFIRMATION and
    //    pendingInteraction === CONFIRMATION_REQUIRED. Version + freshness checks
    //    and the IRCTC_HANDOFF_READY transition are done by BookingPreparationService.
    // Prompt 12: once a booking provider owns the session (execution states), the
    // conversation can neither change booking details nor trigger anything — every turn
    // only reports the normalized provider record. Booking is never an LLM action.
    // Prompt 13: lifecycle-aware handling, classified DETERMINISTICALLY from the raw text
    // (never from an LLM label): cancel ≠ provider cancellation; retry never resubmits an
    // unresolved / confirmed booking; status questions only trigger a status lookup.
    if (EXECUTION_LOCKED_STATES.has(S().bookingState)) {
      const rec = S().bookingExecution;
      const msg = rec ? messageForRecord(rec) : SUBMITTING_MESSAGE;
      const st = rec?.status;
      const intent = classifyLockedIntent(ctx.rawText ?? '', !!e.executionRequested || !!e.affirmation || d.intent === 'CONFIRM_BOOKING');
      const unresolved = st === 'UNKNOWN' || st === 'MANUAL_VERIFICATION_REQUIRED' || st === 'IN_PROGRESS' || st === 'REQUESTED';
      if (intent === 'CANCEL') {
        out.applied.push('PROVIDER_CANCELLATION_UNSUPPORTED');
        emit('BOOKING_CANCEL_NOT_SUPPORTED', { bookingState: S().bookingState, executionStatus: st ?? null });
        return fail('PROVIDER_CANCELLATION_UNSUPPORTED', unresolved || st === 'CONFIRMED' ? `${VOICE_INTERRUPTION_MESSAGE} ${msg}` : msg);
      }
      if (intent === 'STATUS' && unresolved && st !== 'REQUESTED') {
        out.applied.push('BOOKING_STATUS_CHECK');
        return { ...fail(st === 'IN_PROGRESS' ? 'EXECUTION_ALREADY_ACTIVE' : 'EXECUTION_UNKNOWN', 'Booking provider se status verify kar raha hoon.'), reconcileRequested: true };
      }
      if (intent === 'RETRY') {
        if (st === 'CONFIRMED') return fail('EXECUTION_ALREADY_CONFIRMED', `${ALREADY_CONFIRMED_MESSAGE}${rec?.pnr ? ` PNR: ${rec.pnr}.` : ''}`);
        if (st === 'UNKNOWN' || st === 'MANUAL_VERIFICATION_REQUIRED') {
          out.applied.push('UNSAFE_RETRY_BLOCKED');
          return { ...fail('UNSAFE_RETRY', UNSAFE_RETRY_MESSAGE), reconcileRequested: true };
        }
        if (st === 'IN_PROGRESS' || st === 'REQUESTED') return fail('EXECUTION_ALREADY_ACTIVE', ALREADY_ACTIVE_MESSAGE);
        if ((st === 'FAILED' || st === 'CANCELLED') && S().bookingState === BookingState.BOOKING_FAILED && classifyLockedIntent(ctx.rawText ?? '') === 'RETRY') {
          // explicit retry after an AUTHORITATIVE failure — fresh data + new review/confirmation/handoff
          out.applied.push('RETRY_AFTER_FAILURE');
          return { ...fail('EXECUTION_ALREADY_FAILED', 'Pichhli booking attempt provider ne fail ki thi — wahi request dobara nahi bheji jayegi. Nayi attempt ke liye fresh availability aur fare check kar raha hoon; naya review confirm karna hoga.'), retryAfterFailure: true };
        }
      }
      out.applied.push('EXECUTION_LOCKED');
      return fail('EXECUTION_LOCKED', this.hasSubstantiveEntities(e) ? `${msg} Booking request provider ko bheji ja chuki hai — ab details change nahi ho sakti.` : msg);
    }
    if (S().bookingState === BookingState.IRCTC_HANDOFF_READY && (e.executionRequested || e.affirmation || d.intent === 'CONFIRM_BOOKING')) {
      const rec = S().bookingExecution;
      if (rec?.submitted && rec.handoffId === S().handoff?.snapshot.handoffId) {
        // this handoff already went to a provider (e.g. external handoff required) — never resubmitted
        const o = fail('BOOKING_EXECUTION_DUPLICATE', messageForRecord(rec));
        return { ...o, duplicateConfirmation: !e.executionRequested };
      }
      const o = fail('BOOKING_EXECUTION_DISABLED', 'Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai — main ticket book, IRCTC login, submission ya payment nahi kar sakta.');
      return { ...o, duplicateConfirmation: !e.executionRequested };
    }
    // Ambiguous reply while a booking confirmation is pending ("hmm", "achha", "theek hai?")
    // — whatever the LLM labelled it — is never a confirmation: ask explicitly.
    if (S().bookingState === BookingState.AWAITING_CONFIRMATION && !this.hasSubstantiveEntities(e) && !e.negation
      && classifyConfirmation(ctx.rawText ?? '') === 'AMBIGUOUS') {
      out.applied.push('CONFIRMATION_AMBIGUOUS');
      return fail('INVALID_CONFIRMATION', AMBIGUOUS_CONFIRMATION_PROMPT, { type: 'CONFIRMATION_REQUIRED' });
    }
    if (e.executionRequested) {
      return fail('BOOKING_EXECUTION_DISABLED', 'Actual booking, IRCTC login, submission ya payment is milestone mein enabled nahi hai. Main sirf booking details tayyar karke confirmation tak le ja sakta hoon.');
    }
    if (d.intent === 'CONFIRM_BOOKING' || d.action === 'PREPARE_IRCTC_HANDOFF' || d.action === 'REQUEST_CONFIRMATION') {
      const s = S();
      if (s.bookingState === BookingState.REVIEW && d.action === 'REQUEST_CONFIRMATION') {
        out.applied.push('REVIEW_APPROVED'); // BookingPreparationService moves REVIEW → AWAITING_CONFIRMATION
        return out;
      }
      if (s.bookingState === BookingState.PASSENGERS_READY && e.affirmation) {
        out.applied.push('RETRY_PREPARATION');
        return out;
      }
      if (s.bookingState !== BookingState.AWAITING_CONFIRMATION || s.pendingInteraction?.type !== 'CONFIRMATION_REQUIRED' || d.action === 'REQUEST_CONFIRMATION') {
        return fail('CONFIRMATION_NOT_PENDING', this.contextualNudge(s, ctx.mode));
      }
      // Backend ConfirmationPolicy: only the user's EXPLICIT words confirm a booking.
      // AMBIGUOUS ("theek hai", "okay", "haan?") / NEGATIVE / NONE → no confirmation, ask again.
      const cls = classifyConfirmation(ctx.rawText ?? '');
      if (cls !== 'EXPLICIT') {
        out.applied.push(`CONFIRMATION_${cls}`);
        return fail('INVALID_CONFIRMATION', AMBIGUOUS_CONFIRMATION_PROMPT, { type: 'CONFIRMATION_REQUIRED' });
      }
      out.confirmRequested = true;
      out.applied.push('CONFIRMATION_ACCEPTED_BY_GUARD');
      return out;
    }

    // 2) Bare negation at review/confirmation → back to REVIEW (no booking).
    if (e.negation && !this.hasSubstantiveEntities(e)) {
      const s = S();
      if (s.bookingState === BookingState.AWAITING_CONFIRMATION) {
        this.state.transitionState(sessionId, BookingState.REVIEW);
        out.notes.push('Theek hai, booking aage nahi badha raha. Kya badalna hai — train, class, date ya passengers?');
        out.pendingOverride = { type: 'CLARIFICATION_REQUIRED', hint: 'Kya badalna hai — train, class, date ya passengers?' };
        out.applied.push('NEGATION_AT_CONFIRMATION');
        return out;
      }
      return { ...out, notes: ['Theek hai.'], applied: ['NEGATION'] };
    }

    // 3) Bare affirmation outside a confirmation context → contextual clarification.
    if (e.affirmation && !this.hasSubstantiveEntities(e)) {
      if (S().bookingState === BookingState.PASSENGERS_READY) return { ...out, applied: ['RETRY_PREPARATION'] };
      return fail('CONFIRMATION_NOT_PENDING', this.contextualNudge(S(), ctx.mode));
    }

    // 4) Change requested without a value ("date change karo")
    if (e.changeRequested && !this.hasSubstantiveEntities(e)) {
      const s = S();
      if (e.changeRequested === 'date') return { ...out, notes: [], pendingOverride: { type: 'DATE_REQUIRED', data: { correction: true } }, applied: ['CHANGE_DATE_REQUESTED'] };
      if (e.changeRequested === 'route') return { ...out, pendingOverride: { type: 'CLARIFICATION_REQUIRED', hint: 'Naya route batayein — kahan se kahan?' }, applied: ['CHANGE_ROUTE_REQUESTED'] };
      if (e.changeRequested === 'destination') return { ...out, pendingOverride: { type: 'DESTINATION_REQUIRED', data: { correction: true } }, applied: ['CHANGE_DESTINATION_REQUESTED'] };
      if (e.changeRequested === 'origin') return { ...out, pendingOverride: { type: 'ORIGIN_REQUIRED', data: { correction: true } }, applied: ['CHANGE_ORIGIN_REQUESTED'] };
      if (e.changeRequested === 'details') {
        if (s.bookingState === BookingState.AWAITING_CONFIRMATION) this.state.transitionState(sessionId, BookingState.REVIEW);
        return { ...out, pendingOverride: { type: 'CLARIFICATION_REQUIRED', hint: 'Kya badalna hai — train, class, date ya passengers?' }, applied: ['CHANGE_DETAILS_REQUESTED'] };
      }
      if (e.changeRequested === 'passengers') return { ...out, pendingOverride: { type: 'PASSENGERS_REQUIRED' }, applied: ['CHANGE_PASSENGERS_REQUESTED'] };
      if (e.changeRequested === 'train') {
        if (!currentResults(s).length) return fail('MISSING_REQUIRED_FIELD', 'Abhi koi train list nahi hai. Pehle trains search kar lete hain.');
        this.rewindTo(sessionId, BookingState.SHOWING_TRAINS);
        return { ...out, applied: ['CHANGE_TRAIN_REQUESTED'] };
      }
      if (e.changeRequested === 'class') {
        if (!s.selectedTrain) return fail('MISSING_REQUIRED_FIELD', 'Pehle train select kar lete hain.');
        this.rewindTo(sessionId, BookingState.CLASS_OPTIONS);
        return { ...out, applied: ['CHANGE_CLASS_REQUESTED'] };
      }
    }

    // 5) Single station without role → resolve role from context, else ask.
    if (e.stationOnlyRaw && !e.originRaw && !e.destinationRaw) {
      const st = resolveStationToken(e.stationOnlyRaw);
      if (!st) return fail('AMBIGUOUS_ROUTE', `"${e.stationOnlyRaw}" station samajh nahi aaya. Kaunsa station?`);
      const s = S();
      const pend = s.pendingInteraction?.type;
      if (pend === 'ORIGIN_REQUIRED' && !s.pendingInteraction?.data?.route) e.originRaw = st.code;
      else if (pend === 'DESTINATION_REQUIRED' || (s.origin && !s.destination)) e.destinationRaw = st.code;
      else if (s.destination && !s.origin) e.originRaw = st.code;
      else {
        return fail('AMBIGUOUS_ROUTE', `${shortName(st.name)} se chalna hai ya ${shortName(st.name)} jaana hai?`,
          { type: 'CLARIFICATION_REQUIRED', data: { kind: 'STATION_ROLE', code: st.code, name: st.name } });
      }
    }

    // 6) Journey slots (origin / destination / date)
    if (e.originRaw || e.destinationRaw || e.dateRaw) {
      const r = this.applyJourney(sessionId, e, ctx, emit);
      if (r.error) return fail(r.error.code, r.error.message, r.pending);
      out.applied.push(...r.applied);
    }

    // 7) Passenger count (absolute or delta)
    if (e.passengersCountRaw !== undefined || typeof e.passengersDelta === 'number') {
      const r = this.applyPassengerCount(sessionId, e, ctx, emit);
      if (r.error) return fail(r.error.code, r.error.message);
      out.notes.push(...r.notes);
      out.applied.push(...r.applied);
    }

    // 8) Train reference
    if (e.trainRef) {
      const res = this.trainRefs.resolve(e.trainRef, S());
      if (!res.ok) return fail(res.code, res.message, res.code === 'AMBIGUOUS_REFERENCE' ? { type: 'TRAIN_SELECTION_REQUIRED', data: { candidates: (res.candidates || []).map(c => c.trainNumber) } } : undefined);
      const r = this.applyTrainSelection(sessionId, res.train, ctx, emit);
      out.notes.push(...r.notes);
      out.applied.push(...r.applied);
    }

    // 9) Class
    if (e.classRaw) {
      const s = S();
      if (!s.selectedTrain) return fail('MISSING_REQUIRED_FIELD', currentResults(s).length ? 'Pehle train select kar lete hain, phir class choose karenge.' : 'Pehle trains search kar lete hain, phir class choose karenge.');
      const res = this.classRefs.resolve(e.classRaw, s.selectedTrain);
      if (!res.ok) return fail(res.code, res.message, { type: 'CLASS_SELECTION_REQUIRED' });
      const r = this.applyClassSelection(sessionId, res.code, ctx, emit);
      out.notes.push(...r.notes);
      out.applied.push(...r.applied);
    }

    // 10) Passenger collection (remove / field-change / updates) — resolved to stable ids.
    //     Never before train + class are selected (backend guard, independent of the LLM).
    if ((e.passengerUpdates?.length || e.passengerRemove || e.passengerFieldChange) && (!S().selectedTrain || !S().selectedClass)) {
      out.notes.push('Passenger details train aur class select hone ke baad lunga.');
      out.applied.push('PASSENGER_DETAILS_DEFERRED');
      delete (e as any).passengerUpdates; delete (e as any).passengerRemove; delete (e as any).passengerFieldChange;
    }
    if (e.passengerRemove) {
      const r = this.applyPassengerRemove(sessionId, e.passengerRemove, ctx, emit);
      if (r.error) return fail(r.error.code, r.error.message);
      out.notes.push(...r.notes); out.applied.push(...r.applied);
    }
    if (e.passengerFieldChange) {
      const s = S();
      if (!s.passengers?.length) return fail('MISSING_PASSENGER_DETAILS', 'Abhi koi passenger detail nahi hai.');
      const ref = e.passengerFieldChange.ref;
      let target = ref ? passengerCollection.resolveRef(s, ref) : null;
      if (target && !target.ok) return fail(target.code, target.message);
      const resolved = target && target.ok ? target : (() => {
        const i = s.lastPassengerRefId ? s.passengers.findIndex(p => p.id === s.lastPassengerRefId) : (s.passengers.length === 1 ? 0 : -1);
        return i >= 0 ? { ok: true as const, passenger: s.passengers[i], index: i } : null;
      })();
      if (!resolved) return fail('INVALID_PASSENGER_INDEX', 'Kis passenger ki detail badalni hai? Passenger number batayein.');
      const field = ['name', 'age', 'gender'].includes(e.passengerFieldChange.field) ? e.passengerFieldChange.field : 'name';
      s.lastPassengerRefId = resolved.passenger.id;
      out.pendingOverride = { type: 'PASSENGER_DETAILS_REQUIRED', data: { passengerId: resolved.passenger.id, index: resolved.index, field, correction: true } };
      out.applied.push('PASSENGER_FIELD_CHANGE_REQUESTED');
    }
    if (e.passengerUpdates?.length) {
      const r = this.applyPassengerUpdates(sessionId, e, ctx, emit);
      if (r.error) return fail(r.error.code, r.error.message, r.pending);
      out.notes.push(...r.notes); out.applied.push(...r.applied);
      if (r.softError) out.softError = r.softError;
    }

    // 11) Deterministic answers over authoritative results
    if (d.action === 'COMPARE_TRAINS' && e.compareTrainNumbers?.length === 2) {
      const ts = currentResults(S());
      const [a, b] = e.compareTrainNumbers.map(n => ts.find(t => t.trainNumber === n));
      const missing = e.compareTrainNumbers.filter((n, i) => ![a, b][i]);
      out.directAnswer = compareArrival(a, b, missing);
      out.applied.push('COMPARE_TRAINS');
    }
    if (d.action === 'REFINE_RESULTS' && e.refinement && ['FASTEST', 'EARLIEST_ARRIVAL', 'ALTERNATIVES'].includes(e.refinement.kind)) {
      out.directAnswer = this.refine(S(), e.refinement.kind as any, e.refinement.value);
      out.applied.push(`REFINE_${e.refinement.kind}`);
    }

    // 12) Review request
    if (d.action === 'SHOW_REVIEW') {
      const s = S();
      if (s.review?.valid && [BookingState.REVIEW, BookingState.AWAITING_CONFIRMATION].includes(s.bookingState)) {
        ctx.cards.push({ type: 'review', data: s.review.data });
      } else if (![BookingState.PASSENGERS_READY].includes(s.bookingState)) {
        return fail('BOOKING_NOT_READY', 'Review ke liye abhi details poori nahi hain.');
      }
    }
    return out;
  }

  // ---------------- helpers ----------------

  private hasSubstantiveEntities(e: AgentDecision['entities']): boolean {
    return !!(e.originRaw || e.destinationRaw || e.dateRaw || e.passengersCountRaw || typeof e.passengersDelta === 'number'
      || e.trainRef || e.classRaw || e.stationOnlyRaw || (e.infoRequests && e.infoRequests.length) || e.refinement || e.compareTrainNumbers
      || (e.passengerUpdates && e.passengerUpdates.length) || e.passengerRemove || e.passengerFieldChange || e.executionRequested);
  }

  /** Contextual clarification for a short reply that has no meaning in the current state. */
  private contextualNudge(s: BookingSession, mode: 'TEXT' | 'VOICE'): string {
    const p = s.pendingInteraction && s.pendingInteraction.type !== 'NONE' ? s.pendingInteraction : derivePendingInteraction(s);
    const q = questionFor(p, s, mode);
    if (s.bookingState === BookingState.SHOWING_TRAINS) return `Abhi koi booking confirm karne ke liye pending nahi hai. ${q}`;
    if (s.bookingState === BookingState.IRCTC_HANDOFF_READY) return 'Booking confirmation request pehle hi record ho chuki hai. Aur kuch madad chahiye?';
    return q ? `Kis baare mein "haan"? ${q}` : 'Aap kya karna chahte hain — train search, ya kisi train ki jaankari?';
  }

  private rewindTo(sessionId: string, target: BookingState) {
    const s = this.state.getSession(sessionId);
    if (idx(s.bookingState) > idx(target)) this.state.transitionState(sessionId, target);
  }

  private applyJourney(sessionId: string, e: AgentDecision['entities'], ctx: ApplyCtx, emit: (t: BookingEventType, d?: any) => void)
    : { error?: OrchestratorError; pending?: PendingInteraction; applied: string[] } {
    const s = this.state.getSession(sessionId);
    const applied: string[] = [];
    let o: { code: string; name: string } | null = null;
    let dst: { code: string; name: string } | null = null;
    let date: string | null = null;
    if (e.originRaw) {
      o = resolveStationToken(e.originRaw);
      if (!o) return { error: { code: 'AMBIGUOUS_ROUTE', message: `"${e.originRaw}" station samajh nahi aaya. Kahan se chalna hai?` }, pending: { type: 'ORIGIN_REQUIRED' }, applied };
    }
    if (e.destinationRaw) {
      dst = resolveStationToken(e.destinationRaw);
      if (!dst) return { error: { code: 'AMBIGUOUS_ROUTE', message: `"${e.destinationRaw}" station samajh nahi aaya. Kahan jaana hai?` }, pending: { type: 'DESTINATION_REQUIRED' }, applied };
    }
    if (e.dateRaw) {
      const r = /^\d{4}-\d{2}-\d{2}$/.test(e.dateRaw) ? resolveDate(e.dateRaw) : resolveDate(e.dateRaw);
      if (!r.ok) return { error: { code: 'AMBIGUOUS_DATE', message: r.message }, pending: { type: 'DATE_REQUIRED' }, applied };
      date = r.date;
    }
    const newOrigin = o?.code ?? s.origin;
    const newDest = dst?.code ?? s.destination;
    if (newOrigin && newDest && newOrigin === newDest) {
      return { error: { code: 'AMBIGUOUS_ROUTE', message: 'Shuruaat aur manzil ek hi station nahi ho sakte. Kahan jaana hai?' }, applied };
    }

    const routeChanged = (o && o.code !== s.origin) || (dst && dst.code !== s.destination);
    const dateChanged = !!date && date !== s.date;
    const hadFacts = !!(s.searchResults || s.selectedTrain || s.selectedClass || s.fare || s.availability || (s.availableTrains && s.availableTrains.length));
    const isCorrection = (routeChanged && !!((o && s.origin) || (dst && s.destination))) || (dateChanged && !!s.date);

    if (routeChanged || dateChanged) {
      const before = { origin: s.origin, destination: s.destination, date: s.date };
      // DATE-only correction: remember the chosen train/class so it can be re-selected
      // from the FRESH search for the new date (and re-verified) — never assumed.
      const selNum = s.selectedTrain ? ((s.selectedTrain as any).number || (s.selectedTrain as any).trainNumber) : undefined;
      // Carry-over only once booking preparation has started (train + class chosen):
      // the same train/class is re-verified on the new date so the review can regenerate.
      s.carryOverSelection = dateChanged && !routeChanged && selNum && s.selectedClass ? { trainNumber: selNum, classCode: s.selectedClass } : undefined;
      if (hadFacts) {
        const cleared = this.state.invalidate(sessionId, routeChanged ? 'ROUTE' : 'DATE');
        emit('SESSION_INVALIDATED', { reason: routeChanged ? 'ROUTE_CHANGED' : 'DATE_CHANGED', cleared });
        ctx.changes.push(...cleared.map(c => `invalidated:${c}`));
      }
      if (o) { s.origin = o.code; s.originName = o.name; ctx.changes.push('origin'); }
      if (dst) { s.destination = dst.code; s.destinationName = dst.name; ctx.changes.push('destination'); }
      if (date) { s.date = date; ctx.changes.push('date'); }
      this.state.bump(sessionId);
      if (routeChanged) emit('JOURNEY_UPDATED', { origin: s.origin, destination: s.destination });
      if (dateChanged) emit('DATE_UPDATED', { date: s.date });
      if (isCorrection) emit('CORRECTION_APPLIED', { before, after: { origin: s.origin, destination: s.destination, date: s.date } });
      applied.push(routeChanged ? 'JOURNEY_UPDATED' : 'DATE_UPDATED');
    }

    // State: back into journey collection (search will move it forward).
    const cur = this.state.getSession(sessionId);
    if (cur.bookingState === BookingState.IDLE) this.state.transitionState(sessionId, BookingState.COLLECTING_JOURNEY);
    else if ((routeChanged || dateChanged) && idx(cur.bookingState) >= idx(BookingState.SEARCHING_TRAINS)) {
      this.state.transitionState(sessionId, BookingState.COLLECTING_JOURNEY);
    }
    const c2 = this.state.getSession(sessionId);
    if ([BookingState.COLLECTING_JOURNEY, BookingState.COLLECTING_DATE, BookingState.COLLECTING_PASSENGERS].includes(c2.bookingState)) {
      const target = !c2.origin || !c2.destination ? BookingState.COLLECTING_JOURNEY : !c2.date ? BookingState.COLLECTING_DATE : c2.bookingState;
      if (target !== c2.bookingState) this.state.transitionState(sessionId, target);
    }
    return { applied };
  }

  private applyPassengerCount(sessionId: string, e: AgentDecision['entities'], ctx: ApplyCtx, emit: (t: BookingEventType, d?: any) => void)
    : { error?: OrchestratorError; notes: string[]; applied: string[] } {
    const s = this.state.getSession(sessionId);
    const base = s.passengersCount || 1;
    let n: number;
    if (typeof e.passengersDelta === 'number') n = (s.passengersCount ? base : 1) + e.passengersDelta;
    else n = parseInt(String(e.passengersCountRaw), 10);
    if (!passengerCollection.validCount(n)) {
      return { error: { code: 'INVALID_CONTEXT', message: 'Ek booking mein 1 se 6 passengers tak ho sakte hain. Kitne passengers hain?' }, notes: [], applied: [] };
    }
    if (n === s.passengersCount) return { notes: [], applied: [] };
    const prev = s.passengersCount;
    if (s.fare) {
      // Fare depends on passenger count in the provider contract; availability does not.
      const cleared = this.state.invalidate(sessionId, 'PASSENGER_COUNT');
      if (cleared.length) { emit('SESSION_INVALIDATED', { reason: 'PASSENGER_COUNT_CHANGED', cleared }); ctx.changes.push(...cleared.map(c => `invalidated:${c}`)); }
    }
    s.passengersCount = n;
    ctx.changes.push('passengersCount');
    this.state.bump(sessionId);
    emit('PASSENGERS_UPDATED', { passengersCount: n, previous: prev });
    emit('PASSENGER_COUNT_UPDATED', { passengersCount: n, previous: prev ?? null });
    if (s.bookingState === BookingState.IDLE) this.state.transitionState(sessionId, BookingState.COLLECTING_JOURNEY);

    const notes: string[] = [];
    // Passenger records exist once booking preparation started (or details were volunteered).
    const st = this.state.getSession(sessionId).bookingState;
    if (idx(st) >= idx(BookingState.BOOKING_PREPARE) || (s.passengers && s.passengers.length)) {
      const { removed, added } = passengerCollection.reconcile(s, n);
      for (const p of removed) {
        emit('PASSENGER_REMOVED', { passengerId: p.id, hadDetails: !!(p.name || p.age || p.gender) });
        notes.push(p.name ? `${p.name} (${p.id}) ko list se hata diya.` : `Khaali passenger slot ${p.id} hata diya.`);
      }
      if (added.length) ctx.changes.push(...added.map(id => `added:${id}`));
      if (idx(st) > idx(BookingState.COLLECTING_PASSENGER_DETAILS)) this.state.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
    }
    if (prev !== undefined) notes.unshift(`Passengers ${prev} se ${n} kar diye.`);
    return { notes, applied: ['PASSENGERS_UPDATED'] };
  }

  private applyPassengerRemove(sessionId: string, ref: NonNullable<AgentDecision['entities']['passengerRemove']>, ctx: ApplyCtx, emit: (t: BookingEventType, d?: any) => void)
    : { error?: OrchestratorError; notes: string[]; applied: string[] } {
    const s = this.state.getSession(sessionId);
    if (!s.passengers?.length) return { error: { code: 'INVALID_PASSENGER_INDEX', message: 'Abhi koi passenger record nahi hai.' }, notes: [], applied: [] };
    const prev = s.passengersCount;
    const r = passengerCollection.remove(s, ref);
    if (!r.ok) return { error: { code: r.code, message: r.message }, notes: [], applied: [] };
    if (s.fare) {
      const cleared = this.state.invalidate(sessionId, 'PASSENGER_COUNT');
      if (cleared.length) { emit('SESSION_INVALIDATED', { reason: 'PASSENGER_REMOVED', cleared }); ctx.changes.push(...cleared.map(c => `invalidated:${c}`)); }
    }
    this.state.bump(sessionId);
    ctx.changes.push(`removed:${r.removed.id}`, 'passengersCount');
    emit('PASSENGER_REMOVED', { passengerId: r.removed.id, hadDetails: !!(r.removed.name || r.removed.age || r.removed.gender) });
    emit('PASSENGER_COUNT_UPDATED', { passengersCount: s.passengersCount, previous: prev ?? null });
    emit('PASSENGERS_UPDATED', { passengersCount: s.passengersCount, previous: prev });
    const st = this.state.getSession(sessionId).bookingState;
    if (idx(st) > idx(BookingState.COLLECTING_PASSENGER_DETAILS)) this.state.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
    const who = r.removed.name ? `${r.removed.name}` : `Passenger ${r.index + 1}`;
    return { notes: [`${who} ko hata diya. Ab ${s.passengersCount} passenger${(s.passengersCount || 0) > 1 ? 's' : ''} hain.`], applied: ['PASSENGER_REMOVED'] };
  }

  private applyPassengerUpdates(sessionId: string, e: AgentDecision['entities'], ctx: ApplyCtx, emit: (t: BookingEventType, d?: any) => void)
    : { error?: OrchestratorError; pending?: PendingInteraction; softError?: OrchestratorError; notes: string[]; applied: string[] } {
    const s = this.state.getSession(sessionId);
    if (!s.passengersCount) {
      return { error: { code: 'MISSING_PASSENGER_COUNT', message: 'Pehle bataiye kitne passengers hain?' }, pending: { type: 'PASSENGERS_REQUIRED' }, notes: [], applied: [] };
    }
    passengerCollection.ensureSlots(s);
    const r = passengerCollection.applyUpdates(s, e.passengerUpdates || []);
    const notes = [...r.notes];
    if (r.rejectedFields.length) notes.push('Main passengers ke liye sirf naam, umar aur gender hi leta hoon — baaki jaankari store nahi ki.');
    if (r.refError && !r.changed) return { error: { code: r.refError.code, message: r.refError.message }, notes, applied: [] };
    if (r.refError) notes.push(r.refError.message);
    if (!r.changed && r.errors.length) {
      return { error: { code: 'INVALID_PASSENGER_DETAILS', message: r.errors.map(x => x.message).join(' ') }, notes, applied: [] };
    }
    const softError: OrchestratorError | undefined = r.errors.length ? { code: 'INVALID_PASSENGER_DETAILS', message: r.errors.map(x => x.message).join(' ') } : undefined;
    if (softError) notes.push(softError.message);
    if (r.changed) {
      this.state.bump(sessionId);
      for (const w of r.written) {
        ctx.changes.push(...w.fields.map(f => `${w.passengerId}.${f}`));
        // privacy: ids + field names only, never values
        emit('PASSENGER_DETAILS_UPDATED', { passengerId: w.passengerId, fields: w.fields, overwritten: w.overwritten });
        if (w.overwritten.length) emit('CORRECTION_APPLIED', { passengerId: w.passengerId, fields: w.overwritten });
      }
      const st = this.state.getSession(sessionId).bookingState;
      if (idx(st) > idx(BookingState.COLLECTING_PASSENGER_DETAILS)) this.state.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
    }
    return { notes, softError, applied: r.changed ? ['PASSENGER_DETAILS_UPDATED'] : [] };
  }

  /**
   * After a DATE-only correction the fresh search for the new date ran: if the
   * previously chosen train is in the NEW results (and offers the class), keep
   * it — its availability/fare are re-verified by BookingPreparationService.
   */
  applyCarryOver(sessionId: string, ctx: ApplyCtx): string[] {
    const s = this.state.getSession(sessionId);
    const co = s.carryOverSelection;
    if (!co || s.bookingState !== BookingState.SHOWING_TRAINS) return [];
    s.carryOverSelection = undefined;
    const emit = (type: BookingEventType, data?: Record<string, any>) => { this.state.emit(sessionId, type, ctx.turnId, data); ctx.events.push(type); };
    const t = currentResults(s).find(x => x.trainNumber === co.trainNumber);
    if (!t) return [`${co.trainNumber} nayi date ki list mein nahi hai — nayi train chuniye.`];
    const notes = [...this.applyTrainSelection(sessionId, t, ctx, emit).notes];
    if (co.classCode && (t.classes || []).some(c => c.code === co.classCode)) {
      notes.push(...this.applyClassSelection(sessionId, co.classCode, ctx, emit).notes);
      return [`Nayi date ki fresh list mein ${co.trainNumber} hai — wahi train aur ${co.classCode} rakhi hai; availability aur fare dobara verify kar raha hoon.`];
    }
    return notes;
  }

  private applyTrainSelection(sessionId: string, train: ResultTrain, ctx: ApplyCtx, emit: (t: BookingEventType, d?: any) => void)
    : { notes: string[]; applied: string[] } {
    const s = this.state.getSession(sessionId);
    const curNum = s.selectedTrain ? ((s.selectedTrain as any).number || (s.selectedTrain as any).trainNumber) : undefined;
    if (curNum === train.trainNumber) return { notes: [`${train.trainNumber} hi selected hai.`], applied: ['TRAIN_ALREADY_SELECTED'] };
    if (idx(s.bookingState) > idx(BookingState.SHOWING_TRAINS)) this.state.transitionState(sessionId, BookingState.SHOWING_TRAINS);
    if (s.selectedClass || s.fare || s.availability) {
      const cleared = this.state.invalidate(sessionId, 'TRAIN');
      if (cleared.length) { emit('SESSION_INVALIDATED', { reason: 'TRAIN_CHANGED', cleared }); ctx.changes.push(...cleared.map(c => `invalidated:${c}`)); }
    }
    this.state.setSelectedTrain(sessionId, train);
    this.state.transitionState(sessionId, BookingState.TRAIN_SELECTED);
    this.state.transitionState(sessionId, BookingState.CLASS_OPTIONS);
    ctx.changes.push('selectedTrain');
    emit('TRAIN_SELECTED', { trainNumber: train.trainNumber, displayIndex: train.displayIndex, searchResultsVersion: s.searchResultsVersion, resultId: train.resultId });
    ctx.cards.push({ type: 'selected_train', data: train });
    return { notes: [`${train.trainNumber} ${train.trainName} select ho gayi.`], applied: ['TRAIN_SELECTED'] };
  }

  private applyClassSelection(sessionId: string, code: string, ctx: ApplyCtx, emit: (t: BookingEventType, d?: any) => void)
    : { notes: string[]; applied: string[] } {
    const s = this.state.getSession(sessionId);
    if (s.selectedClass === code) return { notes: [], applied: ['CLASS_ALREADY_SELECTED'] };
    if (idx(s.bookingState) > idx(BookingState.CLASS_OPTIONS)) this.state.transitionState(sessionId, BookingState.CLASS_OPTIONS);
    if (s.selectedClass || s.fare || s.availability) {
      const cleared = this.state.invalidate(sessionId, 'CLASS');
      if (cleared.length) { emit('SESSION_INVALIDATED', { reason: 'CLASS_CHANGED', cleared }); ctx.changes.push(...cleared.map(c => `invalidated:${c}`)); }
    }
    this.state.setSelectedClass(sessionId, code);
    this.state.transitionState(sessionId, BookingState.CLASS_SELECTED);
    ctx.changes.push('selectedClass');
    emit('CLASS_SELECTED', { trainNumber: (s.selectedTrain as any)?.number, selectedClass: code });
    ctx.cards.push({ type: 'selected_class', data: { classCode: code } });
    return { notes: [`${code} class select ho gayi.`], applied: ['CLASS_SELECTED'] };
  }

  private refine(s: BookingSession, kind: 'FASTEST' | 'EARLIEST_ARRIVAL' | 'ALTERNATIVES', value?: string): string {
    const ts = currentResults(s);
    if (!ts.length) return 'Abhi koi train list nahi hai. Pehle trains search kar lete hain.';
    if (kind === 'ALTERNATIVES') {
      const others = ts.filter(t => t.trainNumber !== value);
      if (!others.length) return `Is route aur date par ${value || 'is train'} ke alawa koi train nahi mili.`;
      return `${value ? `${value} ke alawa` : 'Doosre options'}: ${others.map(t => `${t.trainNumber} (${t.departure} → ${t.arrival})`).join(', ')}.`;
    }
    const scored = ts.map(t => ({ t, v: kind === 'FASTEST' ? durationMinutes(t.duration) : absoluteArrival(t) }));
    const known = scored.filter(x => x.v !== null) as Array<{ t: ResultTrain; v: number }>;
    if (!known.length) return 'Is list mein timing data poora nahi hai, isliye ye abhi verify nahi ho sakta.';
    const best = known.reduce((a, b) => (b.v < a.v ? b : a));
    const caveat = known.length < ts.length ? ' (kuch trains ka timing data available nahi tha)' : '';
    return kind === 'FASTEST'
      ? `Current results mein sabse fast ${best.t.trainNumber} hai — ${best.t.duration}${caveat}.`
      : `Current results mein sabse pehle ${best.t.trainNumber} pahunchti hai — ${best.t.arrival}${caveat}.`;
  }
}

export { humanDate };
