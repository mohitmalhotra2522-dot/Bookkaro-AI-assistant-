/**
 * BookingPreparationService (Prompt 9) — deterministic booking preparation.
 *
 *   CLASS_SELECTED → BOOKING_PREPARE → (count?) → COLLECTING_PASSENGER_DETAILS
 *   → PASSENGERS_READY → [fresh CHECK_AVAILABILITY / GET_FARE] → REVIEW (vN)
 *   → AWAITING_CONFIRMATION (confirmedReviewVersion = N)
 *   → explicit confirmation of the CURRENT review → IRCTC_HANDOFF_READY
 *
 * Responsibilities: verify journey/date/count/train/class, verify required
 * railway data (freshness), find missing passenger details, build the review,
 * version reviews, guard confirmation. It NEVER books, logs in, submits,
 * pays, requests OTP/CAPTCHA or produces a PNR.
 */
import { BookingState } from '@shared/states';
import type { BookingSession, BookingEventType, PendingInteraction } from '@shared/entities';
import type { ConversationStateManager } from '../ai/state/conversation-state';
import type { OrchestratorError } from '../ai/decisions/agent-decision';
import type { ToolCall } from '../ai/tools/tool-registry';
import type { ToolCallStep } from '../ai/runtime/llm-tool-runtime';
import { STATE_ORDER } from '../ai/state/state-transition-validator';
import { BookingReadinessEvaluator, defaultPolicy, type BookingReadinessResult, type PreparationPolicy } from './booking-readiness';
import { reviewBuilder, reviewFingerprint } from './review-builder';
import { passengerCollection } from './passenger-collection';
import { IrctcHandoffAdapter } from '../irctc/handoff/irctc-handoff-adapter';
import { v4 as uuid } from '../ai/orchestrator/utils';

export interface PrepCtx {
  turnId: string;
  mode: 'TEXT' | 'VOICE';
  cards: Array<{ type: string; data: any }>;
  events: string[];
  changes: string[];
}

export type RunRequiredTools = (calls: ToolCall[]) => Promise<{ steps: ToolCallStep[]; stale: boolean }>;

export interface PrepOutcome {
  notes: string[];
  error?: OrchestratorError;
  steps: ToolCallStep[];
  stale?: boolean;
  readiness: BookingReadinessResult;
  pendingOverride?: PendingInteraction;
}

export interface PrepOptions {
  /** The applier accepted an explicit confirmation reply in AWAITING_CONFIRMATION. */
  confirm?: boolean;
  /** reviewVersion the confirming UI/user referred to (e.g. review-card tap). */
  reviewVersion?: number;
  /** The user explicitly approved an existing (valid) review while in REVIEW. */
  approveReview?: boolean;
}

const idx = (s: BookingState) => STATE_ORDER.indexOf(s);
const FP_PARTS = ['origin', 'destination', 'date', 'train', 'class', 'passengersCount', 'passengers', 'availability', 'fare'];

export const HANDOFF_READY_MESSAGE = 'Booking details ready hain. Actual booking handoff abhi enabled nahi hai.';
export const NO_EXECUTION_NOTE = 'Ticket abhi book nahi hua hai — koi IRCTC login, submission ya payment nahi hua.';

export class BookingPreparationService {
  readonly readiness: BookingReadinessEvaluator;
  private readonly clock: () => number;
  private irctc = new IrctcHandoffAdapter();

  constructor(private readonly state: ConversationStateManager, opts: { policy?: Partial<PreparationPolicy>; clock?: () => number } = {}) {
    this.readiness = new BookingReadinessEvaluator({ ...defaultPolicy(), ...(opts.policy || {}) });
    this.clock = opts.clock || (() => Date.now());
  }

  now(): number { return this.clock(); }

  /** Deterministic readiness; snapshot stored on the session; event on change. */
  evaluate(sessionId: string, ctx?: PrepCtx): BookingReadinessResult {
    const s = this.state.getSession(sessionId);
    const r = this.readiness.evaluate(s, this.clock());
    const prev = s.readiness;
    s.readiness = { ready: r.ready, blockers: r.blockers, missingFields: r.missingFields, warnings: r.warnings, nextRequiredField: r.nextRequiredField as any, evaluatedAt: r.evaluatedAt };
    const changed = !prev || prev.ready !== r.ready || prev.blockers.join() !== r.blockers.join() || prev.missingFields.join() !== r.missingFields.join();
    if (ctx && changed && idx(s.bookingState) >= idx(BookingState.TRAIN_SELECTED)) {
      this.emit(sessionId, ctx, 'BOOKING_READINESS_UPDATED', { ready: r.ready, blockers: r.blockers, missingFields: r.missingFields.length });
    }
    return r;
  }

  /**
   * If any booking-critical value changed since the current review was built,
   * the review (and any pending confirmation) is invalidated. In REVIEW /
   * AWAITING_CONFIRMATION / PASSENGERS_READY the flow rewinds so readiness is
   * recalculated and a NEW review version is generated.
   */
  invalidateReviewIfChanged(sessionId: string, ctx: PrepCtx, reason?: string): boolean {
    const s = this.state.getSession(sessionId);
    const rv = s.review;
    if (!rv || !rv.valid) return false;
    const fp = reviewFingerprint(s);
    if (fp === rv.fingerprint) return false;
    let changed: string[] = [];
    try {
      const a = JSON.parse(rv.fingerprint), b = JSON.parse(fp);
      changed = FP_PARTS.filter((_, i) => JSON.stringify(a[i]) !== JSON.stringify(b[i]));
    } catch { /* ignore */ }
    rv.valid = false;
    rv.invalidatedReason = reason || `CHANGED:${changed.join(',')}`;
    s.confirmedReviewVersion = undefined;
    s.reviewConfirmed = false;
    this.state.bump(sessionId);
    this.emit(sessionId, ctx, 'REVIEW_INVALIDATED', { reviewVersion: rv.reviewVersion, changed });
    ctx.changes.push('invalidated:review');
    const st = s.bookingState;
    if ([BookingState.PASSENGERS_READY, BookingState.REVIEW, BookingState.AWAITING_CONFIRMATION].includes(st)) {
      this.state.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
    }
    return true;
  }

  /** Deterministic forward progress after each turn. */
  async advance(sessionId: string, ctx: PrepCtx, runTools: RunRequiredTools, opts: PrepOptions = {}): Promise<PrepOutcome> {
    const S = () => this.state.getSession(sessionId);
    const out: PrepOutcome = { notes: [], steps: [], readiness: this.evaluate(sessionId) };

    if (opts.confirm) {
      const c = await this.confirm(sessionId, ctx, runTools, opts, out);
      const regenerate = !c.stale && c.error && ['STALE_REVIEW', 'REVIEW_INVALIDATED'].includes(c.error.code)
        && S().bookingState === BookingState.COLLECTING_PASSENGER_DETAILS;
      if (!regenerate) return c;
      // Obsolete review was invalidated at confirmation — rebuild it in the same
      // turn (new version) and ask for confirmation again. Nothing is handed off.
      opts = { ...opts, confirm: false };
    }

    this.invalidateReviewIfChanged(sessionId, ctx);

    // CLASS_SELECTED → BOOKING_PREPARE (preparation begins only after train + class)
    if (S().bookingState === BookingState.CLASS_SELECTED) {
      this.state.transitionState(sessionId, BookingState.BOOKING_PREPARE);
      const t: any = S().selectedTrain;
      this.emit(sessionId, ctx, 'BOOKING_PREPARATION_STARTED', { trainNumber: t?.number, selectedClass: S().selectedClass, passengersCount: S().passengersCount ?? null });
    }
    // BOOKING_PREPARE: passenger count first (pending PASSENGERS_REQUIRED keeps
    // the selected train — rewinding to pre-search COLLECTING_PASSENGERS would discard it).
    if (S().bookingState === BookingState.BOOKING_PREPARE) {
      if (!S().passengersCount) { out.readiness = this.evaluate(sessionId, ctx); return out; }
      const added = passengerCollection.ensureSlots(S());
      if (added.length) this.state.bump(sessionId);
      this.state.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
    }
    if (S().bookingState === BookingState.COLLECTING_PASSENGER_DETAILS) {
      passengerCollection.ensureSlots(S());
      if (passengerCollection.allComplete(S())) {
        this.state.transitionState(sessionId, BookingState.PASSENGERS_READY);
        this.emit(sessionId, ctx, 'PASSENGER_DETAILS_VALIDATED', { passengersCount: S().passengersCount, passengerIds: S().passengers.map(p => p.id) });
      }
    }
    if (S().bookingState === BookingState.PASSENGERS_READY) {
      const r = await this.refreshAndReview(sessionId, ctx, runTools, out);
      if (r === 'stale') return { ...out, stale: true };
    } else if (S().bookingState === BookingState.REVIEW && S().review?.valid && opts.approveReview) {
      // Only an explicit approval moves an existing review back to confirmation
      // (after "nahi" the session deliberately rests in REVIEW).
      this.enterAwaiting(sessionId, ctx);
    }
    out.readiness = this.evaluate(sessionId, ctx);
    return out;
  }

  // ------------------------------------------------------------------ internals

  /**
   * Confirmation could not proceed (required data missing/stale after refresh):
   * rest in PASSENGERS_READY with a retry clarification — never a dead end,
   * never a handoff.
   */
  private blockForRetry(sessionId: string, ctx: PrepCtx, r: BookingReadinessResult, out: PrepOutcome): PrepOutcome {
    const st = this.state.getSession(sessionId).bookingState;
    if (st !== BookingState.COLLECTING_PASSENGER_DETAILS && st !== BookingState.PASSENGERS_READY) {
      this.state.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
    }
    if (this.state.getSession(sessionId).bookingState === BookingState.COLLECTING_PASSENGER_DETAILS && passengerCollection.allComplete(this.state.getSession(sessionId))) {
      this.state.transitionState(sessionId, BookingState.PASSENGERS_READY);
    }
    out.error = { code: 'BOOKING_NOT_READY', message: this.blockerMessage(r), details: { blockers: r.blockers } };
    out.notes.push(out.error.message);
    out.pendingOverride = { type: 'CLARIFICATION_REQUIRED', hint: 'Dobara check karun? Haan boliye.', data: { kind: 'RETRY_PREPARATION', blockers: r.blockers } };
    out.readiness = this.evaluate(sessionId, ctx);
    return out;
  }

  /** PASSENGERS_READY → fresh railway data → REVIEW (new version) → AWAITING_CONFIRMATION. */
  private async refreshAndReview(sessionId: string, ctx: PrepCtx, runTools: RunRequiredTools, out: PrepOutcome): Promise<'ok' | 'blocked' | 'stale'> {
    let r = this.evaluate(sessionId, ctx);
    if (r.refreshNeeded.length) {
      const res = await this.refresh(sessionId, ctx, runTools, r.refreshNeeded);
      out.steps.push(...res.steps);
      if (res.stale) return 'stale';
      r = this.evaluate(sessionId, ctx);
    }
    if (!r.ready) {
      out.error = { code: 'BOOKING_NOT_READY', message: this.blockerMessage(r), details: { blockers: r.blockers } };
      out.notes.push(out.error.message);
      out.pendingOverride = { type: 'CLARIFICATION_REQUIRED', hint: 'Dobara check karun? Haan boliye.', data: { kind: 'RETRY_PREPARATION', blockers: r.blockers } };
      return 'blocked';
    }
    this.createReview(sessionId, ctx, r, out);
    this.enterAwaiting(sessionId, ctx);
    return 'ok';
  }

  private async refresh(sessionId: string, ctx: PrepCtx, runTools: RunRequiredTools, what: Array<'AVAILABILITY' | 'FARE'>) {
    const calls: ToolCall[] = what.map(w => ({ callId: uuid(), name: w === 'AVAILABILITY' ? 'CHECK_AVAILABILITY' : 'GET_FARE', arguments: {} } as ToolCall));
    const res = await runTools(calls);
    if (res.stale) return res;
    for (const st of res.steps) {
      if (st.status !== 'ok') continue;
      if (st.result.toolName === 'CHECK_AVAILABILITY') this.emit(sessionId, ctx, 'AVAILABILITY_REFRESHED', { trainNumber: st.result.data?.trainNumber, travelClass: st.result.data?.travelClass, status: st.result.data?.status, retrievedAt: st.result.timestamp });
      if (st.result.toolName === 'GET_FARE') this.emit(sessionId, ctx, 'FARE_REFRESHED', { trainNumber: st.result.data?.trainNumber, travelClass: st.result.data?.travelClass, total: st.result.data?.total, passengersCount: st.result.data?.passengersCount, retrievedAt: st.result.timestamp });
    }
    return res;
  }

  private createReview(sessionId: string, ctx: PrepCtx, r: BookingReadinessResult, out: PrepOutcome) {
    const s = this.state.getSession(sessionId);
    if (s.review?.valid) { s.review.valid = false; s.review.invalidatedReason = 'SUPERSEDED'; }
    s.reviewVersion = (s.reviewVersion || 0) + 1;
    const built = reviewBuilder.build(s, { reviewVersion: s.reviewVersion, availabilityFresh: r.availability === 'FRESH', fareFresh: r.fare === 'FRESH', now: this.clock() });
    if (s.bookingState !== BookingState.REVIEW) this.state.transitionState(sessionId, BookingState.REVIEW);
    s.review = { reviewVersion: s.reviewVersion, createdAt: built.data.createdAt, sessionVersion: s.sessionVersion, fingerprint: reviewFingerprint(s), valid: true, data: built.data };
    this.state.bump(sessionId);
    this.emit(sessionId, ctx, 'REVIEW_CREATED', {
      reviewVersion: s.reviewVersion, trainNumber: built.data.selectedTrain?.number, selectedClass: built.data.selectedClass,
      passengersCount: built.data.passengersCount, fareVerified: built.data.fare.verified, availabilityVerified: built.data.availability.verified
    });
    ctx.cards.push({ type: 'passengers', data: { passengers: s.passengers } });
    ctx.cards.push({ type: 'review', data: built.data });
    out.notes.push(ctx.mode === 'VOICE' ? built.voiceText : built.text);
  }

  private enterAwaiting(sessionId: string, ctx: PrepCtx) {
    const s = this.state.getSession(sessionId);
    if (!s.review?.valid) return;
    this.state.transitionState(sessionId, BookingState.AWAITING_CONFIRMATION);
    s.confirmedReviewVersion = s.review.reviewVersion;
    this.emit(sessionId, ctx, 'CONFIRMATION_REQUESTED', { reviewVersion: s.review.reviewVersion });
  }

  /** Explicit confirmation — accepted only for the CURRENT, still-fresh review. */
  private async confirm(sessionId: string, ctx: PrepCtx, runTools: RunRequiredTools, opts: PrepOptions, out: PrepOutcome): Promise<PrepOutcome> {
    const S = () => this.state.getSession(sessionId);
    const s = S();
    if (s.bookingState !== BookingState.AWAITING_CONFIRMATION) {
      out.error = { code: 'CONFIRMATION_NOT_PENDING', message: 'Abhi koi confirmation pending nahi hai.' };
      out.notes.push(out.error.message);
      return out;
    }
    const rv = s.review;
    const cur = rv?.reviewVersion;
    // 1) the confirmation must refer to the CURRENT review version
    if (typeof opts.reviewVersion === 'number' && opts.reviewVersion !== cur) {
      out.error = { code: 'CONFIRMATION_VERSION_MISMATCH', message: `Ye confirmation purane review (v${opts.reviewVersion}) ke liye tha. Latest review v${cur} hai — use dekh kar confirm karein.` };
      out.notes.push(out.error.message);
      if (rv?.valid) ctx.cards.push({ type: 'review', data: rv.data });
      return out;
    }
    if (!rv || !rv.valid || s.confirmedReviewVersion !== cur) {
      out.error = { code: 'STALE_REVIEW', message: 'Review purana ho chuka hai. Updated review bana raha hoon.' };
      this.invalidateReviewIfChanged(sessionId, ctx, 'STALE_AT_CONFIRMATION');
      out.notes.push(out.error.message);
      return out;
    }
    // 2) booking-critical data must still match the review
    if (reviewFingerprint(s) !== rv.fingerprint) {
      this.invalidateReviewIfChanged(sessionId, ctx);
      out.error = { code: 'REVIEW_INVALIDATED', message: 'Review ke baad details badal gayi hain — naya review confirm karna hoga.' };
      out.notes.push(out.error.message);
      return out;
    }
    // 3) railway data must still be fresh — otherwise refresh, regenerate, re-confirm
    let r = this.evaluate(sessionId, ctx);
    const staleCodes = r.blockers.filter(b => b === 'STALE_AVAILABILITY' || b === 'STALE_FARE');
    if (r.refreshNeeded.length) {
      const res = await this.refresh(sessionId, ctx, runTools, r.refreshNeeded);
      out.steps.push(...res.steps);
      if (res.stale) return { ...out, stale: true };
      if (reviewFingerprint(S()) !== rv.fingerprint) {
        rv.valid = false; rv.invalidatedReason = 'REFRESHED_AT_CONFIRMATION';
        S().confirmedReviewVersion = undefined;
        this.emit(sessionId, ctx, 'REVIEW_INVALIDATED', { reviewVersion: rv.reviewVersion, changed: ['railway-data-refresh'] });
        this.state.transitionState(sessionId, BookingState.REVIEW);
        r = this.evaluate(sessionId, ctx);
        if (!r.ready) return this.blockForRetry(sessionId, ctx, r, out);
        const code = staleCodes.includes('STALE_AVAILABILITY') ? 'STALE_AVAILABILITY' : staleCodes.includes('STALE_FARE') ? 'STALE_FARE' : 'STALE_REVIEW';
        out.error = { code: 'STALE_REVIEW', message: 'Confirm se pehle availability/fare dobara check kiya — review update hua hai, naye review ko confirm karein.', details: { reason: code } };
        out.notes.push(out.error.message);
        this.createReview(sessionId, ctx, r, out);
        this.enterAwaiting(sessionId, ctx);
        return out;
      }
    }
    r = this.evaluate(sessionId, ctx);
    if (!r.ready) {
      rv.valid = false; rv.invalidatedReason = 'NOT_READY_AT_CONFIRMATION';
      S().confirmedReviewVersion = undefined;
      this.emit(sessionId, ctx, 'REVIEW_INVALIDATED', { reviewVersion: rv.reviewVersion, changed: ['readiness'] });
      return this.blockForRetry(sessionId, ctx, r, out);
    }
    // 4) handoff payload validation (NO execution, NO IRCTC call)
    const hr = this.irctc.prepareHandoff(S());
    if (hr.status !== 'READY') {
      out.error = { code: 'BOOKING_NOT_READY', message: 'Booking details poori nahi hain, handoff tayyar nahi ho saka.' };
      out.notes.push(out.error.message);
      return out;
    }
    this.state.markReviewConfirmed(sessionId);
    this.state.transitionState(sessionId, BookingState.IRCTC_HANDOFF_READY);
    this.state.markHandoffReady(sessionId);
    const fin = S();
    this.emit(sessionId, ctx, 'BOOKING_CONFIRMATION_REQUESTED', {
      reviewVersion: cur, origin: fin.origin, destination: fin.destination, date: fin.date,
      trainNumber: (fin.selectedTrain as any)?.number, selectedClass: fin.selectedClass, passengersCount: fin.passengersCount
    });
    this.emit(sessionId, ctx, 'IRCTC_HANDOFF_READY', { reviewVersion: cur, payloadStatus: hr.status, executionEnabled: false });
    ctx.cards.push({ type: 'handoff', data: {
      status: 'IRCTC_HANDOFF_READY', payloadStatus: hr.status, reviewVersion: cur,
      realBooking: false, executionEnabled: false,
      message: `${HANDOFF_READY_MESSAGE} ${NO_EXECUTION_NOTE}`
    } });
    out.notes.push(`${HANDOFF_READY_MESSAGE} ${NO_EXECUTION_NOTE}`);
    out.readiness = this.evaluate(sessionId, ctx);
    return out;
  }

  blockerMessage(r: BookingReadinessResult): string {
    if (r.blockers.includes('REQUIRED_TOOL_DATA_MISSING')) {
      const what = [r.availability === 'MISSING' && this.readiness.preparationPolicy.requireAvailability ? 'availability' : null,
        r.fare === 'MISSING' && this.readiness.preparationPolicy.requireFare ? 'fare' : null].filter(Boolean).join(' aur ');
      return `Review ke liye ${what || 'zaroori railway data'} verify hona zaroori hai, par abhi provider se nahi mil paaya. Isliye review abhi nahi bana.`;
    }
    if (r.blockers.includes('STALE_AVAILABILITY') || r.blockers.includes('STALE_FARE')) return 'Availability/fare purana ho gaya hai aur refresh nahi ho paaya. Review abhi nahi bana.';
    if (r.blockers.includes('MISSING_PASSENGER_DETAILS') || r.blockers.includes('INVALID_PASSENGER_DETAILS')) return 'Passenger details abhi poori nahi hain.';
    if (r.blockers.includes('MISSING_PASSENGER_COUNT')) return 'Passengers ki ginti abhi pata nahi hai.';
    if (r.blockers.includes('MISSING_TRAIN') || r.blockers.includes('INVALID_TRAIN')) return 'Train abhi select nahi hui hai.';
    if (r.blockers.includes('MISSING_CLASS') || r.blockers.includes('INVALID_CLASS')) return 'Class abhi select nahi hui hai.';
    return 'Booking abhi review ke liye tayyar nahi hai.';
  }

  private emit(sessionId: string, ctx: PrepCtx, type: BookingEventType, data?: Record<string, any>) {
    this.state.emit(sessionId, type, ctx.turnId, data);
    ctx.events.push(type);
  }
}

export type { BookingSession };
