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
import { v4 as uuid } from '../ai/orchestrator/utils';
import type { ExecutionLogRecord } from '@shared/booking-execution';
import { BookingExecutionGateway, type GatewayOutcome } from './execution/booking-execution-gateway';
import { buildExecutionRequest } from './execution/execution-request';
import { transitionLifecycle } from './execution/booking-lifecycle';

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
  /** Execution-gateway log line for this turn (PII-free). */
  execution?: ExecutionLogRecord;
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

export const HANDOFF_READY_MESSAGE = 'Booking details ready hain. Actual railway booking abhi enabled nahi hai.';
export const HANDOFF_DUPLICATE_MESSAGE = 'Ye booking pehle hi confirm ho chuki hai — wahi booking handoff ready hai, naya handoff nahi banaya.';
export const HANDOFF_EXPIRED_MESSAGE = 'Pichla booking handoff expire ho gaya. Fresh availability aur fare check karke naya review bana raha hoon.';
export const HANDOFF_INVALIDATED_MESSAGE = 'Booking details badalne se pichla handoff cancel ho gaya — naya review confirm karna hoga.';
/** Gateway rejections after which the review is rebuilt in the same turn and confirmation re-asked. */
const REGENERATE_CODES = ['STALE_REVIEW', 'REVIEW_INVALIDATED', 'STALE_BOOKING_HANDOFF', 'CONFIRMATION_REQUIRED', 'SESSION_VERSION_CONFLICT', 'INVALID_BOOKING_HANDOFF'];
const PREP_STATES = [BookingState.CLASS_SELECTED, BookingState.BOOKING_PREPARE, BookingState.COLLECTING_PASSENGER_DETAILS, BookingState.PASSENGERS_READY, BookingState.REVIEW];
export const NO_EXECUTION_NOTE = 'Ticket abhi book nahi hua hai — koi IRCTC login, submission ya payment nahi hua.';

export class BookingPreparationService {
  readonly readiness: BookingReadinessEvaluator;
  private readonly clock: () => number;
  /** The ONLY path from a confirmed review to a BookingExecutor (Disabled in this milestone). */
  readonly gateway: BookingExecutionGateway;

  constructor(private readonly state: ConversationStateManager, opts: { policy?: Partial<PreparationPolicy>; clock?: () => number; gateway?: BookingExecutionGateway } = {}) {
    this.readiness = new BookingReadinessEvaluator({ ...defaultPolicy(), ...(opts.policy || {}) });
    this.clock = opts.clock || (() => Date.now());
    this.gateway = opts.gateway || new BookingExecutionGateway(state, { clock: this.clock });
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
    this.invalidateHandoff(sessionId, ctx, 'INVALIDATED', `BOOKING_DETAILS_CHANGED:${changed.join(',')}`);
    const st = s.bookingState;
    if ([BookingState.PASSENGERS_READY, BookingState.REVIEW, BookingState.AWAITING_CONFIRMATION, BookingState.IRCTC_HANDOFF_READY].includes(st)) {
      this.state.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
    }
    return true;
  }

  /**
   * Handoff status change (status only — the snapshot stays immutable).
   * Clears the confirmation; a NEW review + confirmation + handoff is required.
   */
  invalidateHandoff(sessionId: string, ctx: PrepCtx, status: 'INVALIDATED' | 'EXPIRED', reason: string): boolean {
    const s = this.state.getSession(sessionId);
    if (!s.handoff || s.handoff.status !== 'READY') return false;
    const now = this.clock();
    this.gateway.handoffs.setStatus(s, status, reason, now);
    s.irctcHandoffReady = false;
    s.reviewConfirmed = false;
    transitionLifecycle(s, 'INVALIDATED', reason, new Date(now).toISOString());
    this.emit(sessionId, ctx, status === 'EXPIRED' ? 'BOOKING_HANDOFF_EXPIRED' : 'BOOKING_HANDOFF_INVALIDATED', { handoffId: s.handoff.snapshot.handoffId, reason: reason.split(':')[0] });
    ctx.cards.push({ type: 'handoff_status', data: { handoffId: s.handoff.snapshot.handoffId, status, reason: reason.split(':')[0], reviewVersion: s.handoff.snapshot.reviewVersion } });
    ctx.changes.push(`handoff:${status.toLowerCase()}`);
    this.state.bump(sessionId);
    return true;
  }

  /**
   * Per-turn handoff integrity check (run at turn start, before the LLM):
   *  - expired  → EXPIRED, railway data dropped, review invalidated, flow rewinds
   *               so fresh CHECK_AVAILABILITY / GET_FARE + a new review are required;
   *  - critical data changed → INVALIDATED (+ review invalidated / rewound).
   */
  syncHandoff(sessionId: string, ctx: PrepCtx): { notes: string[]; error?: OrchestratorError } {
    const s = this.state.getSession(sessionId);
    const c = this.gateway.handoffs.check(s, this.clock());
    if (!c || c.status === 'READY' || s.handoff?.status !== 'READY') return { notes: [] };
    if (c.status === 'EXPIRED') {
      this.invalidateHandoff(sessionId, ctx, 'EXPIRED', 'HANDOFF_EXPIRED');
      const rv = s.review;
      if (rv?.valid) {
        rv.valid = false; rv.invalidatedReason = 'HANDOFF_EXPIRED';
        this.emit(sessionId, ctx, 'REVIEW_INVALIDATED', { reviewVersion: rv.reviewVersion, changed: ['handoff-expired'] });
      }
      s.confirmedReviewVersion = undefined;
      this.state.invalidate(sessionId, 'CLASS');          // availability + fare must be fetched fresh
      if (s.bookingState === BookingState.IRCTC_HANDOFF_READY || s.bookingState === BookingState.AWAITING_CONFIRMATION) {
        this.state.transitionState(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
        if (passengerCollection.allComplete(s)) this.state.transitionState(sessionId, BookingState.PASSENGERS_READY);
      }
      return { notes: [HANDOFF_EXPIRED_MESSAGE], error: { code: 'HANDOFF_EXPIRED', message: HANDOFF_EXPIRED_MESSAGE } };
    }
    if (!this.invalidateReviewIfChanged(sessionId, ctx, 'HANDOFF_INTEGRITY')) this.invalidateHandoff(sessionId, ctx, 'INVALIDATED', c.reason || 'BOOKING_DETAILS_CHANGED');
    return { notes: [HANDOFF_INVALIDATED_MESSAGE] };
  }

  /**
   * A repeated confirmation after the handoff exists ("haan" again). Routed
   * through the gateway's idempotency: the SAME handoff is returned and the
   * executor is NOT invoked again. Never creates a second handoff.
   */
  async duplicateConfirmation(sessionId: string, ctx: PrepCtx): Promise<ExecutionLogRecord | undefined> {
    const s = this.state.getSession(sessionId);
    if (s.bookingState !== BookingState.IRCTC_HANDOFF_READY || s.handoff?.status !== 'READY') return undefined;
    const req = buildExecutionRequest(s, { requestId: ctx.turnId, confirmedAt: new Date(this.clock()).toISOString() });
    if (!req) return undefined;
    const g = await this.gateway.execute(req, { turnId: ctx.turnId, emit: (t, d) => this.emit(sessionId, ctx, t, d) });
    if (g.ok) ctx.cards.push({ type: 'handoff', data: this.handoffCard(sessionId, g, true) });
    return g.log;
  }

  /** Lifecycle mirrors the preparation flow (separate from the conversation state machine). */
  private syncLifecycle(sessionId: string) {
    const s = this.state.getSession(sessionId);
    const at = new Date(this.clock()).toISOString();
    const st = s.bookingState;
    const lc = s.bookingLifecycle?.status;
    if (st === BookingState.IRCTC_HANDOFF_READY) return;
    if ((lc === 'EXECUTION_DISABLED' || lc === 'HANDOFF_CREATED' || lc === 'EXECUTION_FAILED') && s.handoff?.status !== 'READY') transitionLifecycle(s, 'INVALIDATED', 'handoff no longer ready', at);
    if (st === BookingState.AWAITING_CONFIRMATION && s.review?.valid) {
      if (s.bookingLifecycle?.status === 'READY_FOR_CONFIRMATION') return;
      if (s.bookingLifecycle?.status !== 'PREPARING' && s.bookingLifecycle?.status !== 'INVALIDATED') transitionLifecycle(s, 'PREPARING', undefined, at);
      transitionLifecycle(s, 'READY_FOR_CONFIRMATION', `review v${s.review.reviewVersion}`, at);
    } else if (PREP_STATES.includes(st) || (s.bookingLifecycle && st !== BookingState.AWAITING_CONFIRMATION)) {
      transitionLifecycle(s, 'PREPARING', undefined, at);
    }
  }

  /** Deterministic forward progress after each turn. */
  async advance(sessionId: string, ctx: PrepCtx, runTools: RunRequiredTools, opts: PrepOptions = {}): Promise<PrepOutcome> {
    const S = () => this.state.getSession(sessionId);
    const out: PrepOutcome = { notes: [], steps: [], readiness: this.evaluate(sessionId) };

    if (opts.confirm) {
      const c = await this.confirm(sessionId, ctx, runTools, opts, out);
      const regenerate = !c.stale && c.error && REGENERATE_CODES.includes(c.error.code)
        && S().bookingState === BookingState.COLLECTING_PASSENGER_DETAILS;
      if (!regenerate) { this.syncLifecycle(sessionId); return c; }
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
    this.syncLifecycle(sessionId);
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
    // 4) BookingExecutionGateway — independent re-validation, immutable handoff,
    //    Disabled executor (NO IRCTC call, NO login / form / OTP / CAPTCHA / payment).
    const req = buildExecutionRequest(S(), { requestId: ctx.turnId, confirmedAt: new Date(this.clock()).toISOString() });
    if (!req) {
      out.error = { code: 'BOOKING_NOT_READY', message: 'Booking details poori nahi hain, handoff tayyar nahi ho saka.' };
      out.notes.push(out.error.message);
      return out;
    }
    this.syncLifecycle(sessionId);
    this.emit(sessionId, ctx, 'BOOKING_CONFIRMATION_REQUESTED', {
      reviewVersion: cur, origin: req.journey.origin, destination: req.journey.destination, date: req.date,
      trainNumber: req.selectedTrain.trainNumber, selectedClass: req.selectedClass, passengersCount: req.passengers.length
    });
    const g = await this.gateway.execute(req, { turnId: ctx.turnId, emit: (t, d) => this.emit(sessionId, ctx, t, d) });
    out.execution = g.log;
    if (!g.ok) return this.handleGatewayRejection(sessionId, ctx, g, out);
    this.emit(sessionId, ctx, 'IRCTC_HANDOFF_READY', { reviewVersion: cur, handoffId: g.handoff.snapshot.handoffId, executionStatus: g.execution.status, executionEnabled: false });
    ctx.cards.push({ type: 'handoff', data: this.handoffCard(sessionId, g, false) });
    out.notes.push(ctx.mode === 'VOICE' ? HANDOFF_READY_MESSAGE : `${HANDOFF_READY_MESSAGE} ${NO_EXECUTION_NOTE}`);
    out.readiness = this.evaluate(sessionId, ctx);
    return out;
  }

  private handoffCard(sessionId: string, g: Extract<GatewayOutcome, { ok: true }>, duplicate: boolean) {
    const s = this.state.getSession(sessionId);
    const h = g.handoff.snapshot;
    return {
      status: 'IRCTC_HANDOFF_READY', payloadStatus: 'READY', handoffId: h.handoffId, handoffStatus: s.handoff?.status ?? g.handoff.status,
      reviewVersion: h.reviewVersion, createdAt: h.createdAt, expiresAt: h.expiresAt,
      executorName: g.execution.executorName, executionStatus: g.execution.status, executionReason: g.execution.reason,
      executionCapability: g.capability.reason, realBookingEnabled: g.capability.realBookingEnabled,
      realBooking: false, executionEnabled: false, duplicate,
      message: duplicate ? `${HANDOFF_DUPLICATE_MESSAGE} ${HANDOFF_READY_MESSAGE}` : `${HANDOFF_READY_MESSAGE} ${NO_EXECUTION_NOTE}`
    };
  }

  /** Gateway rejected the confirmed request: nothing was executed or handed off. Recover safely. */
  private handleGatewayRejection(sessionId: string, ctx: PrepCtx, g: Extract<GatewayOutcome, { ok: false }>, out: PrepOutcome): PrepOutcome {
    const s = this.state.getSession(sessionId);
    const rv = s.review;
    const dropReview = (why: string) => {
      if (rv?.valid) {
        rv.valid = false; rv.invalidatedReason = why;
        this.emit(sessionId, ctx, 'REVIEW_INVALIDATED', { reviewVersion: rv.reviewVersion, changed: [why] });
      }
      s.confirmedReviewVersion = undefined;
      s.reviewConfirmed = false;
    };
    const code = g.code;
    if (code === 'STALE_AVAILABILITY' || code === 'STALE_FARE') {
      // Fresh data could not be verified → execution not allowed; retry later.
      dropReview(`UNVERIFIED_AT_EXECUTION:${code}`);
      const r = this.evaluate(sessionId, ctx);
      this.blockForRetry(sessionId, ctx, r, out);
      const what = code === 'STALE_AVAILABILITY' ? 'availability' : 'fare';
      out.notes = [`Booking se pehle fresh ${what} verify nahi ho paaya, isliye booking handoff nahi banaya gaya.`];
      out.error = { code, message: out.notes[0], details: { blockers: r.blockers } };
      return out;
    }
    if (code === 'INVALID_CLASS') {
      dropReview('INVALID_CLASS');
      this.state.invalidate(sessionId, 'CLASS');
      s.selectedClass = undefined;
      this.state.tryTransition(sessionId, BookingState.CLASS_OPTIONS);
      out.error = { code: 'INVALID_CLASS_SELECTION', message: 'Selected class is train ke liye valid nahi hai, isliye handoff nahi banaya. Kaunsi class chahiye?', details: { gatewayCode: code } };
      out.notes.push(out.error.message);
      return out;
    }
    if (code === 'INVALID_TRAIN') {
      dropReview('INVALID_TRAIN');
      this.state.invalidate(sessionId, 'TRAIN');
      s.selectedTrain = undefined;
      this.state.tryTransition(sessionId, s.searchResults ? BookingState.SHOWING_TRAINS : BookingState.COLLECTING_JOURNEY);
      out.error = { code: 'INVALID_TRAIN', message: 'Selected train current search results se match nahi karti, isliye handoff nahi banaya. Kripya train dobara chuniye.' };
      out.notes.push(out.error.message);
      return out;
    }
    if (code === 'INVALID_PASSENGER_DETAILS') {
      dropReview('INVALID_PASSENGER_DETAILS');
      this.state.tryTransition(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
      out.error = { code, message: 'Passenger details valid nahi hain, isliye handoff nahi banaya. Kripya passenger details check karein.' };
      out.notes.push(out.error.message);
      return out;
    }
    // Version / handoff / readiness inconsistencies → rebuild the review in this turn, re-ask.
    dropReview(`GATEWAY_REJECTED:${code}`);
    this.state.tryTransition(sessionId, BookingState.COLLECTING_PASSENGER_DETAILS);
    out.error = { code: REGENERATE_CODES.includes(code) ? code : 'STALE_REVIEW', message: 'Confirm karte waqt booking details verify nahi ho paayi — handoff nahi banaya. Updated review dekh kar dobara confirm karein.', details: { gatewayCode: code } };
    out.notes.push(out.error.message);
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
