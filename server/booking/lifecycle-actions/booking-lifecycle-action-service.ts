/**
 * BookingLifecycleActionService (Prompt 15) — the ONLY path to cancellation / modification /
 * refund-status provider calls.
 *
 *   user text → classifyLifecycleIntent (deterministic) → BookingReferenceResolver (store records)
 *   → BookingActionValidator → [eligibility] → confirmation request (pending action)
 *   → explicit "haan / confirm" on a LATER turn → validator (EXECUTE) → idempotency claim
 *   → provider call (bounded timeout) → normalized result → evidence-guarded store update
 *
 *  - The LLM never executes anything: its lifecycle label is parsed against the closed enum and
 *    only logged; the backend acts on the user's own explicit words.
 *  - Confirmation authorizes an ATTEMPT, never success. CANCELLED / MODIFIED / refund statuses come
 *    only from an authoritative provider response.
 *  - Timeout / ambiguous transport → UNKNOWN (never CANCELLED), bounded reconciliation if the
 *    provider supports status, else MANUAL_VERIFICATION_REQUIRED. No automatic retry, ever.
 *  - One provider request per action (idempotency key claimed once) + per-booking in-flight lock.
 *  - Session state machine untouched: the session stays in its post-booking state; the action has
 *    its own lifecycle record (ACTION_REQUESTED → AWAITING_ACTION_CONFIRMATION → ACTION_IN_PROGRESS
 *    → ACTION_CONFIRMED / ACTION_FAILED / ACTION_UNKNOWN …).
 *  - Logs / events: no PNR, no passenger values, no credentials.
 */
import type { ConversationStateManager } from '../../ai/state/conversation-state';
import { BookingState } from '@shared/states';
import type { BookingEventType } from '@shared/entities';
import type { BookingRecord } from '@shared/booking-record';
import type {
  BookingActionView, BookingLifecycleAction, BookingLifecycleActionRecord, CancellationResult, LifecycleActionErrorCode,
  LifecycleActionLogRecord, ModificationChangeType, ModificationResult, ParsedLifecycleAction, ProviderActionCapabilities,
  ProviderActionCapability, RequestedChanges
} from '@shared/booking-lifecycle-action';
import { CHANGE_TYPE_FOR_ACTION, DESTRUCTIVE_LIFECYCLE_ACTIONS, UNRESOLVED_ACTION_STATUSES, parseLifecycleAction } from '@shared/booking-lifecycle-action';
import type { BookingHistoryStore } from '../post-booking/booking-history-store';
import { BookingReferenceResolver } from '../post-booking/booking-reference-resolver';
import type { BookingProvider } from '../provider/booking-provider';
import type { BookingProviderRegistry } from '../provider/booking-provider-registry';
import type { BookingProviderConfig } from '../provider/booking-provider-config';
import { callWithTimeout } from '../provider/call-with-timeout';
import { humanDate } from '../../ai/context/response-formatter';
import { classifyLifecycleIntent, isLifecycleConfirmation, isLifecycleRejection, type LifecycleIntent } from './lifecycle-action-intent';
import { BookingActionValidator, LIFECYCLE_MESSAGES, capabilityFor } from './booking-action-validator';
import { LifecycleActionStore } from './lifecycle-action-store';
import {
  classifyActionError, normalizeCancellationResponse, normalizeCancellationStatus, normalizeEligibility,
  normalizeModificationResponse, normalizeModificationStatus, normalizeRefundResponse, resolveProviderActionCapabilities
} from './provider-action-normalizer';

type Emit = (type: BookingEventType, data: Record<string, unknown>) => void;
type Mode = 'TEXT' | 'VOICE';

export type LifecyclePlan =
  | { kind: 'PREPARE'; action: BookingLifecycleAction; bookingId: string; changes: RequestedChanges }
  | { kind: 'EXECUTE'; actionId: string }
  | { kind: 'RECONCILE'; actionId: string; reason: 'STATUS' | 'RETRY' }
  | { kind: 'REFUND'; bookingId: string }
  | { kind: 'ELIGIBILITY'; action: 'CHECK_CANCELLATION_ELIGIBILITY' | 'CHECK_MODIFICATION_ELIGIBILITY'; bookingId: string; changeType: ModificationChangeType | 'ANY' };

export type LifecycleTurn =
  | { type: 'DEFER' }
  | { type: 'DIRECT'; answer: string }
  | { type: 'ERROR'; code: LifecycleActionErrorCode; message: string }
  | { type: 'ASYNC'; plan: LifecyclePlan };

export interface LifecycleRunResult { message: string; error?: { code: LifecycleActionErrorCode; message: string }; card?: { type: string; data: any } }

export interface LifecycleActionServiceOptions {
  store: BookingHistoryStore;
  providers: { registry: BookingProviderRegistry; config: BookingProviderConfig };
  actions?: LifecycleActionStore;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  confirmationTtlMs?: number;
  reconcile?: { attempts?: number; delayMs?: number; maxTotal?: number };
  today?: () => string;
}

/** Session states in which lifecycle actions are considered (never during planning / execution). */
const LIFECYCLE_STATES: ReadonlySet<string> = new Set([BookingState.BOOKING_CONFIRMED, BookingState.BOOKING_FAILED, BookingState.IDLE, BookingState.COMPLETE]);
const DUPLICATE_CONFIRM_WINDOW_MS = 10 * 60_000;

function istToday(ms: number): string { return new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10); }
const money = (amount: number, currency: string) => currency === 'INR' ? `₹${Math.abs(amount)}` : `${currency} ${Math.abs(amount)}`;

export class BookingLifecycleActionService {
  readonly actions: LifecycleActionStore;
  readonly validator = new BookingActionValidator();
  private readonly resolver = new BookingReferenceResolver();
  private readonly store: BookingHistoryStore;
  private readonly providers: { registry: BookingProviderRegistry; config: BookingProviderConfig };
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ttl: number;
  private readonly rc: { attempts: number; delayMs: number; maxTotal: number };
  private readonly todayFn: () => string;
  private readonly timeoutOverride?: number;
  private readonly inFlight = new Set<string>();
  private readonly logs: LifecycleActionLogRecord[] = [];

  constructor(private readonly state: ConversationStateManager, o: LifecycleActionServiceOptions) {
    this.store = o.store;
    this.providers = o.providers;
    this.clock = o.clock || (() => Date.now());
    this.actions = o.actions || new LifecycleActionStore(this.clock);
    this.sleep = o.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    this.ttl = o.confirmationTtlMs ?? 5 * 60_000;
    this.rc = { attempts: o.reconcile?.attempts ?? 2, delayMs: o.reconcile?.delayMs ?? 750, maxTotal: o.reconcile?.maxTotal ?? 6 };
    this.todayFn = o.today || (() => istToday(this.clock()));
    this.timeoutOverride = o.timeoutMs;
  }

  // =========================================================================
  // Provider / capability resolution (fail closed)
  // =========================================================================

  /** Provider for THIS booking: the configured, enabled provider must be the one that made it. */
  providerFor(r: Readonly<BookingRecord>): BookingProvider | null {
    try {
      const res = this.providers.registry.resolve(this.providers.config);
      if (!res.ok || res.masterSwitchOff) return null;
      if (res.provider.name !== r.providerName && res.effective !== r.providerName) return null;
      return res.provider;
    } catch { return null; }
  }
  capabilitiesFor(r: Readonly<BookingRecord>): ProviderActionCapabilities | null {
    const p = this.providerFor(r);
    return p ? resolveProviderActionCapabilities(p) : null;
  }
  private timeoutMs() { return this.timeoutOverride ?? this.providers.config.timeoutMs; }

  // =========================================================================
  // Read API (frontend / tests) — no provider payloads, no PNR
  // =========================================================================

  listActions(sessionId: string): BookingActionView[] {
    return this.actions.forSession(sessionId).map(a => ({ actionId: a.actionId, bookingId: a.bookingId, actionType: a.actionType, status: a.status, resultStatus: a.resultStatus }));
  }
  actionLog(sessionId?: string): readonly LifecycleActionLogRecord[] {
    return sessionId ? this.logs.filter(l => l.sessionId === sessionId) : [...this.logs];
  }

  // =========================================================================
  // 1. Conversation turn (synchronous, deterministic) — called by ContextualTurnApplier
  // =========================================================================

  handleTurn(sessionId: string, rawText: string, o: { turnId: string; mode: Mode; emit: Emit; llmAction?: unknown }): LifecycleTurn {
    const s = this.state.getSession(sessionId);
    const now = this.clock();
    const llm = parseLifecycleAction(o.llmAction);

    // ---- (a) pending confirmation — consumed or abandoned on the next turn, never reused ----
    const pend = s.pendingLifecycleAction;
    if (pend && pend.setAtTurnId !== o.turnId) {
      s.pendingLifecycleAction = undefined;
      const act = this.actions.get(pend.actionId);
      if (act && act.status === 'AWAITING_ACTION_CONFIRMATION' && act.sessionId === sessionId) {
        if (now > pend.expiresAt) {
          this.abandon(act, 'ACTION_EXPIRED', o);
        } else if (isLifecycleConfirmation(rawText)) {
          o.emit('BOOKING_ACTION_CONFIRMED_BY_USER', { actionId: act.actionId, bookingId: act.bookingId, actionType: act.actionType });
          return { type: 'ASYNC', plan: { kind: 'EXECUTE', actionId: act.actionId } };
        } else if (isLifecycleRejection(rawText)) {
          this.abandon(act, 'ACTION_ABANDONED', o);
          return { type: 'DIRECT', answer: 'Theek hai — koi request provider ko nahi bheji gayi. Booking mein koi change nahi hua.' };
        } else {
          this.abandon(act, 'ACTION_ABANDONED', o); // topic changed → no hidden carry-over
        }
      }
    }

    // ---- (b) scope gates: records exist, post-booking state, no unresolved execution ----
    let recs: Readonly<BookingRecord>[];
    try { recs = this.store.getBookingsForSession(sessionId); } catch { recs = []; }
    const clar = s.lifecycleClarification;
    if (clar && clar.setAtTurnId !== o.turnId) s.lifecycleClarification = undefined;
    if (!recs.length || !LIFECYCLE_STATES.has(s.bookingState)) {
      if (llm !== 'NO_ACTION') this.log({ sessionId, turnId: o.turnId, actionType: llm, rejectionReason: llm === 'UNSUPPORTED_ACTION' ? 'ACTION_NOT_SUPPORTED' : 'ACTION_NOT_ALLOWED' });
      return { type: 'DEFER' };
    }

    // ---- (c) classify (user's own words) ----
    let intent = classifyLifecycleIntent(rawText, clar && clar.setAtTurnId !== o.turnId && (clar.awaiting === 'DATE' || clar.awaiting === 'CLASS') ? { awaiting: clar.awaiting } : {});
    let candidateIds: string[] | undefined;
    if (clar && clar.setAtTurnId !== o.turnId) {
      if (!intent && clar.awaiting === 'BOOKING') {
        // follow-up answer to "kaunsi booking?" → reuse the original request, restricted to candidates
        intent = { action: clar.action as any, family: clar.action === 'REQUEST_CANCELLATION' || clar.action === 'CHECK_CANCELLATION_ELIGIBILITY' ? 'CANCEL' : clar.action === 'CHECK_REFUND_STATUS' ? 'REFUND' : 'MODIFY', retry: !!clar.retry, changes: { ...(clar.changes || {}) }, referenceText: rawText };
        candidateIds = clar.candidateIds;
      } else if (intent && (clar.awaiting === 'DATE' || clar.awaiting === 'CLASS') && intent.action === clar.action) {
        candidateIds = clar.candidateIds;
      }
    }

    if (!intent) {
      // duplicate "haan" after an action already ran → answered from the action record, never re-sent
      const last = s.lastLifecycleAction;
      if (last && isLifecycleConfirmation(rawText) && now - last.at < DUPLICATE_CONFIRM_WINDOW_MS) {
        const act = this.actions.get(last.actionId);
        if (act) return this.duplicateAnswer(act, o.mode);
      }
      if (llm !== 'NO_ACTION') {
        // LLM label alone (no explicit user words) → never acted upon
        this.log({ sessionId, turnId: o.turnId, actionType: llm, rejectionReason: llm === 'UNSUPPORTED_ACTION' ? 'ACTION_NOT_SUPPORTED' : 'ACTION_NOT_ALLOWED' });
      }
      return { type: 'DEFER' };
    }

    // ---- (d) resolve the booking (store records only; never guess) ----
    const res = this.resolver.resolve(recs, intent.referenceText, { activeBookingId: s.activeBookingId, candidateIds, today: this.todayFn() });
    if (res.kind === 'NONE') return { type: 'DEFER' };
    if (res.kind === 'NOT_FOUND') return this.reject(sessionId, o, intent.action, null, 'BOOKING_NOT_FOUND', res.message);
    if (res.kind === 'AMBIGUOUS') {
      s.lifecycleClarification = { action: intent.action, candidateIds: res.candidates.map(r => r.bookingId), setAtTurnId: o.turnId, awaiting: 'BOOKING', retry: intent.retry, changes: { ...(intent.changes.journeyDate ? { journeyDate: intent.changes.journeyDate } : {}), ...(intent.changes.travelClass ? { travelClass: intent.changes.travelClass } : {}) } };
      const verb = intent.family === 'CANCEL' ? 'cancel karni hai' : intent.family === 'REFUND' ? 'ka refund status chahiye' : 'change karni hai';
      return this.reject(sessionId, o, intent.action, null, 'MULTIPLE_BOOKINGS_MATCHED', res.message.replace(/dekhna chahte ho\?$/, `${verb}?`));
    }
    const r = res.record;
    s.activeBookingId = r.bookingId;
    return this.route(sessionId, r, intent, o);
  }

  private route(sessionId: string, r: Readonly<BookingRecord>, intent: LifecycleIntent, o: { turnId: string; mode: Mode; emit: Emit }): LifecycleTurn {
    const s = this.state.getSession(sessionId);
    const caps = this.capabilitiesFor(r);
    const today = this.todayFn();

    // ---- status of a previous action (reconcile when unresolved and supported) ----
    if (intent.action === 'ACTION_STATUS') {
      const fam = intent.family === 'CANCEL' ? 'CANCEL' : 'MODIFY';
      const last = this.actions.latestOfFamily(sessionId, r.bookingId, fam);
      const word = fam === 'CANCEL' ? 'cancellation' : 'modification';
      if (!last || last.status === 'AWAITING_ACTION_CONFIRMATION') {
        if (fam === 'CANCEL' && r.bookingStatus === 'CANCELLED') return { type: 'DIRECT', answer: LIFECYCLE_MESSAGES.ALREADY_CANCELLED };
        return { type: 'DIRECT', answer: `Is booking ke liye koi ${word} request provider ko nahi bheji gayi hai.` };
      }
      if (UNRESOLVED_ACTION_STATUSES.has(last.status) && last.status !== 'ACTION_IN_PROGRESS') {
        const statusCap: ProviderActionCapability = fam === 'CANCEL' ? 'GET_CANCELLATION_STATUS' : 'GET_MODIFICATION_STATUS';
        if (caps?.[statusCap]) return { type: 'ASYNC', plan: { kind: 'RECONCILE', actionId: last.actionId, reason: 'STATUS' } };
      }
      return { type: 'DIRECT', answer: this.describeAction(last, r) };
    }

    const action = intent.action as BookingLifecycleAction;
    const latestDestructive = this.actions.latestDestructive(sessionId, r.bookingId);
    const v = this.validator.validate({
      action, record: r, capabilities: caps, latestDestructive, explicitIntent: true, retryRequested: intent.retry,
      phase: action === 'CHECK_REFUND_STATUS' || action === 'CHECK_CANCELLATION_ELIGIBILITY' || action === 'CHECK_MODIFICATION_ELIGIBILITY' || action === 'REQUEST_MODIFICATION' ? 'READ' : 'PREPARE',
      changes: intent.changes, today
    });
    if (!v.ok) {
      // unsafe retry while the previous result is unknown → safe status check if supported, never a resend
      if ((v.code === 'UNSAFE_RETRY' || v.code === 'CANCELLATION_UNKNOWN' || v.code === 'MODIFICATION_UNKNOWN') && latestDestructive) {
        const statusCap: ProviderActionCapability = latestDestructive.actionType === 'REQUEST_CANCELLATION' ? 'GET_CANCELLATION_STATUS' : 'GET_MODIFICATION_STATUS';
        this.log({ sessionId, turnId: o.turnId, bookingId: r.bookingId, actionId: latestDestructive.actionId, actionType: action, provider: r.providerName, capability: v.capability, rejectionReason: v.code });
        if (caps?.[statusCap] && latestDestructive.reconciliationAttempts < this.rc.maxTotal) return { type: 'ASYNC', plan: { kind: 'RECONCILE', actionId: latestDestructive.actionId, reason: 'RETRY' } };
        return { type: 'ERROR', code: v.code, message: v.message + (caps?.[statusCap] ? '' : ' Provider status check support nahi karta — kripya provider ke saath manually verify karein.') };
      }
      // missing details → ask one short question (with a typed rejection, nothing sent)
      if (v.code === 'MODIFICATION_NOT_ELIGIBLE' && action === 'REQUEST_JOURNEY_CHANGE' && !intent.changes.journeyDate && !intent.changeError) {
        s.lifecycleClarification = { action, candidateIds: [r.bookingId], setAtTurnId: o.turnId, awaiting: 'DATE' };
        return this.reject(sessionId, o, action, r, 'MODIFICATION_NOT_ELIGIBLE', o.mode === 'VOICE' ? 'Nayi journey date kya chahiye?' : 'Nayi journey date batayein — jaise "25 October kar do". (Date backend resolve karega; provider confirm karega tabhi change hoga.)', v.capability);
      }
      if (v.code === 'MODIFICATION_NOT_ELIGIBLE' && action === 'REQUEST_CLASS_CHANGE' && !intent.changes.travelClass) {
        s.lifecycleClarification = { action, candidateIds: [r.bookingId], setAtTurnId: o.turnId, awaiting: 'CLASS' };
        return this.reject(sessionId, o, action, r, 'MODIFICATION_NOT_ELIGIBLE', 'Kaunsi class chahiye? Jaise "2A kar do".', v.capability);
      }
      if (intent.changeError && v.code === 'MODIFICATION_NOT_ELIGIBLE') return this.reject(sessionId, o, action, r, 'MODIFICATION_NOT_ELIGIBLE', intent.changeError.message, v.capability);
      return this.reject(sessionId, o, action, r, v.code, v.message, v.capability);
    }

    switch (action) {
      case 'CHECK_REFUND_STATUS': return { type: 'ASYNC', plan: { kind: 'REFUND', bookingId: r.bookingId } };
      case 'CHECK_CANCELLATION_ELIGIBILITY': return { type: 'ASYNC', plan: { kind: 'ELIGIBILITY', action, bookingId: r.bookingId, changeType: 'ANY' } };
      case 'CHECK_MODIFICATION_ELIGIBILITY': return { type: 'ASYNC', plan: { kind: 'ELIGIBILITY', action, bookingId: r.bookingId, changeType: 'ANY' } };
      case 'REQUEST_MODIFICATION': {
        const opts = [caps!.CHANGE_JOURNEY ? 'journey date' : '', caps!.CHANGE_CLASS ? 'class' : '', caps!.CHANGE_PASSENGER ? 'passenger details' : ''].filter(Boolean);
        if (!opts.length) return this.reject(sessionId, o, action, r, 'ACTION_NOT_SUPPORTED', LIFECYCLE_MESSAGES.MODIFY_UNSUPPORTED, 'MODIFY_BOOKING');
        return { type: 'DIRECT', answer: `Kya change karna hai — ${opts.join(', ')}? Jaise "date 25 October kar do"${caps!.CHANGE_CLASS ? ' ya "CC se 2A kar do"' : ''}.` };
      }
      default: return { type: 'ASYNC', plan: { kind: 'PREPARE', action, bookingId: r.bookingId, changes: intent.changes } };
    }
  }

  // =========================================================================
  // 2. Async execution (provider calls) — called by the orchestrator after the applier
  // =========================================================================

  async run(sessionId: string, plan: LifecyclePlan, ctx: { turnId: string; mode: Mode; emit: Emit }): Promise<LifecycleRunResult> {
    try {
      switch (plan.kind) {
        case 'PREPARE': return await this.prepare(sessionId, plan, ctx);
        case 'EXECUTE': return await this.execute(sessionId, plan.actionId, ctx);
        case 'RECONCILE': return await this.reconcileTurn(sessionId, plan.actionId, plan.reason, ctx);
        case 'REFUND': return await this.refund(sessionId, plan.bookingId, ctx);
        case 'ELIGIBILITY': return await this.eligibility(sessionId, plan, ctx);
      }
    } catch {
      return this.fail('PROVIDER_ACTION_UNAVAILABLE', 'Booking action abhi process nahi ho paaya — koi change confirm nahi hua hai.');
    }
  }

  private record(sessionId: string, bookingId: string): Readonly<BookingRecord> | null {
    try { const g = this.store.getBookingById(sessionId, bookingId); return g.ok ? g.record : null; } catch { return null; }
  }

  private async callProvider<T>(fn: (o: { signal: AbortSignal; timeoutMs: number }) => Promise<T>): Promise<{ ok: true; value: T; latencyMs: number } | { ok: false; error: ReturnType<typeof classifyActionError>; latencyMs: number }> {
    const t0 = this.clock();
    try { const value = await callWithTimeout(fn, this.timeoutMs()); return { ok: true, value, latencyMs: this.clock() - t0 }; }
    catch (e) { return { ok: false, error: classifyActionError(e), latencyMs: this.clock() - t0 }; }
  }

  // ---- PREPARE: eligibility (if supported / required) → action record → confirmation request ----
  private async prepare(sessionId: string, plan: Extract<LifecyclePlan, { kind: 'PREPARE' }>, ctx: { turnId: string; mode: Mode; emit: Emit }): Promise<LifecycleRunResult> {
    const s = this.state.getSession(sessionId);
    const r = this.record(sessionId, plan.bookingId);
    const caps = r ? this.capabilitiesFor(r) : null;
    const v = this.validator.validate({ action: plan.action, record: r, capabilities: caps, latestDestructive: r ? this.actions.latestDestructive(sessionId, r.bookingId) : null, explicitIntent: true, phase: 'PREPARE', changes: plan.changes, today: this.todayFn() });
    if (!v.ok) return this.rejectRun(sessionId, ctx, plan.action, r, v.code, v.message, v.capability);
    const rec = r!;
    const provider = this.providerFor(rec)!;
    const label = this.label(rec, ctx.mode);
    const isCancel = plan.action === 'REQUEST_CANCELLATION';
    const changeType = CHANGE_TYPE_FOR_ACTION[plan.action];
    let fare: { amount: number; currency: string; source: 'PROVIDER' } | null = null;

    if (isCancel && caps!.CHECK_CANCELLATION_ELIGIBILITY) {
      const e = await this.callProvider(o => provider.checkCancellationEligibility!({ bookingId: rec.bookingId, providerReference: rec.providerReference! }, o));
      const n = e.ok ? normalizeEligibility(e.value) : null;
      if (!n) return this.rejectRun(sessionId, ctx, plan.action, rec, 'PROVIDER_ACTION_UNAVAILABLE', 'Cancellation eligibility abhi provider se verify nahi ho paayi — koi request nahi bheji gayi.', 'CHECK_CANCELLATION_ELIGIBILITY', e.latencyMs);
      if (!n.eligible) return this.rejectRun(sessionId, ctx, plan.action, rec, 'CANCELLATION_NOT_ELIGIBLE', `Provider ke hisaab se ye booking abhi cancel nahi ho sakti${n.reasonCode ? ` (${n.reasonCode})` : ''}. Koi request nahi bheji gayi.`, 'CHECK_CANCELLATION_ELIGIBILITY', e.latencyMs);
    }
    if (changeType) {
      const needsFare = changeType === 'JOURNEY' || changeType === 'CLASS';
      if (needsFare && !caps!.CHECK_MODIFICATION_ELIGIBILITY) {
        return this.rejectRun(sessionId, ctx, plan.action, rec, 'FARE_UNAVAILABLE', 'Is change ka fare difference provider se available nahi hai, isliye request prepare nahi kar sakta. Main khud fare calculate ya assume nahi karta.', 'CHECK_MODIFICATION_ELIGIBILITY');
      }
      if (caps!.CHECK_MODIFICATION_ELIGIBILITY) {
        const e = await this.callProvider(o => provider.checkModificationEligibility!({ bookingId: rec.bookingId, providerReference: rec.providerReference!, changeType, changes: plan.changes }, o));
        const n = e.ok ? normalizeEligibility(e.value) : null;
        if (!n) return this.rejectRun(sessionId, ctx, plan.action, rec, needsFare ? 'FARE_UNAVAILABLE' : 'PROVIDER_ACTION_UNAVAILABLE', needsFare ? 'Is change ka fare difference provider se verify nahi ho paaya — request prepare nahi ki gayi.' : 'Modification eligibility abhi provider se verify nahi ho paayi — koi request nahi bheji gayi.', 'CHECK_MODIFICATION_ELIGIBILITY', e.latencyMs);
        if (!n.eligible) return this.rejectRun(sessionId, ctx, plan.action, rec, 'MODIFICATION_NOT_ELIGIBLE', `Provider ke hisaab se ye change abhi possible nahi hai${n.reasonCode ? ` (${n.reasonCode})` : ''}. Koi request nahi bheji gayi.`, 'CHECK_MODIFICATION_ELIGIBILITY', e.latencyMs);
        if (needsFare && !n.fareDifference) return this.rejectRun(sessionId, ctx, plan.action, rec, 'FARE_UNAVAILABLE', 'Provider ne is change ka fare difference nahi diya, isliye request prepare nahi kar sakta. Main fare assume nahi karta.', 'CHECK_MODIFICATION_ELIGIBILITY', e.latencyMs);
        fare = n.fareDifference;
      }
    }

    const at = new Date(this.clock()).toISOString();
    const actionId = this.actions.newId('act');
    let modificationId: string | null = null;
    if (changeType) {
      modificationId = this.actions.newId('mod');
      this.actions.createModification({
        modificationId, bookingId: rec.bookingId, sessionId, changeType, requestedChanges: plan.changes,
        previous: { journeyDate: rec.current?.journeyDate ?? rec.journeyDate, travelClass: rec.current?.travelClass ?? rec.travelClass, passengersCount: rec.current?.passengersCount ?? rec.passengersSummary.count },
        fareDifference: fare, requestedAt: at, status: 'AWAITING_CONFIRMATION', updatedAt: at
      });
    }
    const act = this.actions.create({
      actionId, bookingId: rec.bookingId, sessionId, actionType: plan.action, requestedAt: at, providerName: rec.providerName,
      providerReference: rec.providerReference, status: 'AWAITING_ACTION_CONFIRMATION',
      idempotencyKey: `${isCancel ? 'cancel' : 'modify'}:${rec.bookingId}:${actionId}`, modificationId
    });
    s.pendingLifecycleAction = { actionId, setAtTurnId: ctx.turnId, expiresAt: this.clock() + this.ttl };
    s.lastLifecycleAction = { actionId, bookingId: rec.bookingId, actionType: plan.action, status: act.status, resultStatus: null, at: this.clock() };
    ctx.emit('BOOKING_ACTION_REQUESTED', { actionId, bookingId: rec.bookingId, actionType: plan.action });
    ctx.emit('BOOKING_ACTION_CONFIRMATION_REQUIRED', { actionId, bookingId: rec.bookingId, actionType: plan.action, ...(fare ? { fareDifference: fare.amount, currency: fare.currency } : {}) });
    this.log({ sessionId, turnId: ctx.turnId, bookingId: rec.bookingId, actionId, actionType: plan.action, provider: rec.providerName, previousStatus: 'ACTION_REQUESTED', newStatus: act.status, capability: v.capability, confirmationRequired: true });

    let message: string;
    if (isCancel) {
      message = ctx.mode === 'VOICE'
        ? `Main ${rec.train.trainNumber} ki booking cancel karne ki request prepare kar raha hoon. Kya aap cancellation confirm karte hain?`
        : `Main ${rec.train.trainNumber} ki booking cancel karne ki request prepare kar raha hoon (${label}). Kya aap cancellation confirm karte hain? "Haan / confirm" bolne par hi request provider ko jayegi — final result provider batayega.`;
    } else {
      const desc = this.changeDesc(changeType!, plan.changes);
      const fareTxt = fare ? (fare.amount > 0 ? ` Provider ke hisaab se fare difference: ${money(fare.amount, fare.currency)} extra.` : fare.amount < 0 ? ` Provider ke hisaab se fare ${money(fare.amount, fare.currency)} kam hoga.` : ' Provider ke hisaab se koi fare difference nahi hai.') : '';
      message = ctx.mode === 'VOICE'
        ? `Main ${rec.train.trainNumber} booking mein ${desc} ki request prepare kar raha hoon.${fareTxt} Kya aap confirm karte hain?`
        : `Main ${rec.train.trainNumber} booking (${label}) mein ${desc} ki request prepare kar raha hoon.${fareTxt} Kya aap ye change confirm karte hain? Confirm karne par request provider ko jayegi — change tabhi hoga jab provider confirm kare.`;
    }
    return { message, card: { type: 'booking_action', data: this.view(act) } };
  }

  // ---- EXECUTE: re-validate → in-flight lock → idempotency claim → provider → normalize → apply ----
  private async execute(sessionId: string, actionId: string, ctx: { turnId: string; mode: Mode; emit: Emit }): Promise<LifecycleRunResult> {
    const act = this.actions.get(actionId);
    if (!act || act.sessionId !== sessionId) return this.fail('ACTION_NOT_ALLOWED', 'Ye action is session ka nahi hai.');
    if (act.status !== 'AWAITING_ACTION_CONFIRMATION') return this.duplicateRun(act);
    const r = this.record(sessionId, act.bookingId);
    const caps = r ? this.capabilitiesFor(r) : null;
    const mod = act.modificationId ? this.actions.getModification(act.modificationId) : null;
    const v = this.validator.validate({
      action: act.actionType, record: r, capabilities: caps, latestDestructive: r ? this.actions.latestDestructive(sessionId, r.bookingId, actionId) : null,
      explicitIntent: true, phase: 'EXECUTE', confirmation: { required: true, received: true }, changes: mod?.requestedChanges, today: this.todayFn()
    });
    if (!v.ok) {
      this.abandon(act, 'ACTION_ABANDONED', ctx, v.code);
      return this.rejectRun(sessionId, ctx, act.actionType, r, v.code, v.message, v.capability);
    }
    const rec = r!;
    if (this.inFlight.has(rec.bookingId)) return this.fail('ACTION_ALREADY_PENDING', 'Is booking par ek request abhi process ho rahi hai — dobara nahi bheji jayegi.');
    if (!act.idempotencyKey || !this.actions.claimKey(act.idempotencyKey)) return this.duplicateRun(act);
    const provider = this.providerFor(rec)!;
    this.inFlight.add(rec.bookingId);
    try {
      const at = new Date(this.clock()).toISOString();
      const t = this.actions.transition(actionId, 'ACTION_IN_PROGRESS', { confirmedAt: at });
      if (!t.ok) return this.fail('INVALID_ACTION_TRANSITION', t.message);
      ctx.emit('BOOKING_ACTION_SUBMITTED', { actionId, bookingId: rec.bookingId, actionType: act.actionType, provider: rec.providerName });
      this.log({ sessionId, turnId: ctx.turnId, bookingId: rec.bookingId, actionId, actionType: act.actionType, provider: rec.providerName, previousStatus: 'AWAITING_ACTION_CONFIRMATION', newStatus: 'ACTION_IN_PROGRESS', capability: v.capability, confirmationRequired: true, confirmationReceived: true });

      if (act.actionType === 'REQUEST_CANCELLATION') {
        const call = await this.callProvider(o => provider.cancelBooking!({ bookingId: rec.bookingId, providerReference: rec.providerReference!, idempotencyKey: act.idempotencyKey!, actionId }, o));
        let result: CancellationResult;
        let notSent = false; let timedOut = false;
        if (call.ok) result = normalizeCancellationResponse(call.value);
        else {
          notSent = call.error.kind === 'NOT_SENT'; timedOut = call.error.kind === 'TIMEOUT';
          result = { status: notSent ? 'CANCELLATION_FAILED' : 'UNKNOWN', evidence: 'NONE', providerStatus: null, cancellationReference: null, failureCode: call.error.failureCode };
        }
        if (notSent) return this.finishCancellationNotSent(sessionId, act, rec, result, call.latencyMs, ctx);
        if (result.status === 'UNKNOWN' && caps!.GET_CANCELLATION_STATUS) result = await this.reconcileCancellation(sessionId, act, rec, provider, this.rc.attempts, ctx);
        return this.applyCancellation(sessionId, actionId, rec, result, call.latencyMs, ctx, timedOut);
      }

      const changeType = CHANGE_TYPE_FOR_ACTION[act.actionType]!;
      const call = await this.callProvider(o => provider.modifyBooking!({ bookingId: rec.bookingId, providerReference: rec.providerReference!, idempotencyKey: act.idempotencyKey!, actionId, modificationId: mod!.modificationId, changeType, changes: mod!.requestedChanges }, o));
      let result: ModificationResult;
      let timedOut = false;
      if (call.ok) result = normalizeModificationResponse(call.value);
      else {
        timedOut = call.error.kind === 'TIMEOUT';
        if (call.error.kind === 'NOT_SENT') {
          this.actions.transition(actionId, 'ACTION_FAILED', { failureCode: call.error.failureCode, completedAt: new Date(this.clock()).toISOString(), resultStatus: 'FAILED' }, 'NOT_SENT');
          this.actions.updateModification(mod!.modificationId, 'FAILED');
          this.syncLast(sessionId, actionId);
          this.log({ sessionId, turnId: ctx.turnId, bookingId: rec.bookingId, actionId, actionType: act.actionType, provider: rec.providerName, previousStatus: 'ACTION_IN_PROGRESS', newStatus: 'ACTION_FAILED', providerResult: 'NOT_SENT', latencyMs: call.latencyMs, confirmationRequired: true, confirmationReceived: true, rejectionReason: 'PROVIDER_ACTION_UNAVAILABLE' });
          return this.fail('PROVIDER_ACTION_UNAVAILABLE', 'Modification request provider tak nahi pahunchi — booking mein koi change nahi hua.');
        }
        result = { status: 'UNKNOWN', evidence: 'NONE', providerStatus: null, applied: null, failureCode: call.error.failureCode };
      }
      if (result.status === 'UNKNOWN' && caps!.GET_MODIFICATION_STATUS) result = await this.reconcileModification(sessionId, act, rec, provider, this.rc.attempts, ctx);
      return this.applyModification(sessionId, actionId, rec, result, call.latencyMs, ctx, timedOut);
    } finally {
      this.inFlight.delete(rec.bookingId);
    }
  }

  private async reconcileCancellation(sessionId: string, act: Readonly<BookingLifecycleActionRecord>, rec: Readonly<BookingRecord>, provider: BookingProvider, attempts: number, ctx: { turnId: string; emit: Emit }): Promise<CancellationResult> {
    let last: CancellationResult = { status: 'UNKNOWN', evidence: 'NONE', providerStatus: null, cancellationReference: null, failureCode: 'PROVIDER_TIMEOUT' };
    for (let i = 0; i < attempts; i++) {
      const cur = this.actions.get(act.actionId)!;
      if (cur.reconciliationAttempts >= this.rc.maxTotal) break;
      if (i > 0 || this.rc.delayMs > 0) await this.sleep(this.rc.delayMs);
      this.actions.noteReconciliation(act.actionId);
      const c = await this.callProvider(o => provider.getCancellationStatus!({ bookingId: rec.bookingId, providerReference: rec.providerReference!, idempotencyKey: act.idempotencyKey! }, o));
      last = c.ok ? normalizeCancellationStatus(c.value) : last;
      ctx.emit('BOOKING_ACTION_RECONCILED', { actionId: act.actionId, bookingId: rec.bookingId, attempt: cur.reconciliationAttempts + 1, result: last.status });
      if (last.status !== 'UNKNOWN') break;
    }
    return last;
  }
  private async reconcileModification(sessionId: string, act: Readonly<BookingLifecycleActionRecord>, rec: Readonly<BookingRecord>, provider: BookingProvider, attempts: number, ctx: { turnId: string; emit: Emit }): Promise<ModificationResult> {
    let last: ModificationResult = { status: 'UNKNOWN', evidence: 'NONE', providerStatus: null, applied: null, failureCode: 'PROVIDER_TIMEOUT' };
    for (let i = 0; i < attempts; i++) {
      const cur = this.actions.get(act.actionId)!;
      if (cur.reconciliationAttempts >= this.rc.maxTotal) break;
      if (i > 0 || this.rc.delayMs > 0) await this.sleep(this.rc.delayMs);
      this.actions.noteReconciliation(act.actionId);
      const c = await this.callProvider(o => provider.getModificationStatus!({ bookingId: rec.bookingId, providerReference: rec.providerReference!, idempotencyKey: act.idempotencyKey!, modificationId: act.modificationId! }, o));
      last = c.ok ? normalizeModificationStatus(c.value) : last;
      ctx.emit('BOOKING_ACTION_RECONCILED', { actionId: act.actionId, bookingId: rec.bookingId, attempt: cur.reconciliationAttempts + 1, result: last.status });
      if (last.status !== 'UNKNOWN') break;
    }
    return last;
  }

  /** User-triggered status check of an unresolved action (bounded; never a resend). */
  private async reconcileTurn(sessionId: string, actionId: string, reason: 'STATUS' | 'RETRY', ctx: { turnId: string; mode: Mode; emit: Emit }): Promise<LifecycleRunResult> {
    const act = this.actions.get(actionId);
    if (!act || act.sessionId !== sessionId) return this.fail('BOOKING_NOT_FOUND', 'Action nahi mila.');
    const rec = this.record(sessionId, act.bookingId);
    if (!rec) return this.fail('BOOKING_NOT_FOUND', 'Booking nahi mili.');
    const provider = this.providerFor(rec);
    const caps = provider ? resolveProviderActionCapabilities(provider) : null;
    const prefix = reason === 'RETRY' ? (act.actionType === 'REQUEST_CANCELLATION' ? LIFECYCLE_MESSAGES.CANCEL_UNKNOWN_RETRY : LIFECYCLE_MESSAGES.MODIFY_UNKNOWN_RETRY) + ' Provider se status check kiya: ' : '';
    const code: LifecycleActionErrorCode | undefined = reason === 'RETRY' ? 'UNSAFE_RETRY' : undefined;
    if (!UNRESOLVED_ACTION_STATUSES.has(act.status) || act.status === 'ACTION_IN_PROGRESS') return { message: prefix + this.describeAction(act, rec), ...(code ? { error: { code, message: 'retry blocked' } } : {}) };
    if (this.inFlight.has(rec.bookingId)) return this.fail('ACTION_ALREADY_PENDING', 'Is booking par ek request abhi process ho rahi hai.');
    this.inFlight.add(rec.bookingId);
    try {
      if (act.actionType === 'REQUEST_CANCELLATION') {
        if (!provider || !caps?.GET_CANCELLATION_STATUS) return { message: prefix + this.describeAction(act, rec), error: { code: code || 'MANUAL_VERIFICATION_REQUIRED', message: 'status unavailable' } };
        const result = await this.reconcileCancellation(sessionId, act, rec, provider, 1, ctx);
        const out = this.applyCancellation(sessionId, actionId, rec, result, null, ctx, false, act.status);
        return { ...out, message: prefix + out.message, ...(code ? { error: { code, message: out.error?.message || 'retry blocked' } } : {}) };
      }
      if (!provider || !caps?.GET_MODIFICATION_STATUS) return { message: prefix + this.describeAction(act, rec), error: { code: code || 'MANUAL_VERIFICATION_REQUIRED', message: 'status unavailable' } };
      const result = await this.reconcileModification(sessionId, act, rec, provider, 1, ctx);
      const out = this.applyModification(sessionId, actionId, rec, result, null, ctx, false, act.status);
      return { ...out, message: prefix + out.message, ...(code ? { error: { code, message: out.error?.message || 'retry blocked' } } : {}) };
    } finally { this.inFlight.delete(rec.bookingId); }
  }

  // ---- apply normalized outcomes (store updates need provider evidence) ----
  private applyCancellation(sessionId: string, actionId: string, rec: Readonly<BookingRecord>, result: CancellationResult, latencyMs: number | null, ctx: { turnId: string; emit: Emit }, timedOut: boolean, prevStatus?: string): LifecycleRunResult {
    const act = this.actions.get(actionId)!;
    const now = new Date(this.clock()).toISOString();
    const ev = (providerStatus: string | null, uncertain = false) => ({ source: uncertain ? 'ACTION_OUTCOME_UNCERTAIN' as const : 'PROVIDER_ACTION' as const, actionId, providerStatus });
    const caps = this.capabilitiesFor(rec);
    let out: LifecycleRunResult;
    switch (result.status) {
      case 'CANCELLED': {
        const w = this.store.applyCancellation(sessionId, rec.bookingId, ev('CANCELLED'));
        if (!w.ok) { out = this.fail('MANUAL_VERIFICATION_REQUIRED', 'Provider ka cancellation result record nahi ho paaya — kripya provider ke saath verify karein.'); break; }
        this.actions.transition(actionId, 'ACTION_CONFIRMED', { completedAt: now, resultStatus: 'CANCELLED' });
        ctx.emit('BOOKING_CANCELLATION_CONFIRMED', { actionId, bookingId: rec.bookingId, provider: rec.providerName });
        out = { message: 'Booking provider ne cancellation confirm kar di hai. Refund ka status alag hai — cancellation ka matlab refund complete hona nahi hai ("refund status" pooch sakte hain).' };
        break;
      }
      case 'CANCELLATION_PENDING':
        this.store.updateCancellationStatus(sessionId, rec.bookingId, 'PENDING', ev('PENDING'));
        this.actions.transition(actionId, 'ACTION_PENDING', { resultStatus: 'CANCELLATION_PENDING' });
        out = { message: 'Provider ne cancellation request receive ki hai, lekin final confirmation abhi pending hai — booking ko abhi cancelled nahi maana ja sakta. Dobara request nahi bheji jayegi.' };
        break;
      case 'CANCELLATION_FAILED':
        this.store.updateCancellationStatus(sessionId, rec.bookingId, 'FAILED', ev('FAILED'));
        this.actions.transition(actionId, 'ACTION_FAILED', { completedAt: now, failureCode: result.failureCode, resultStatus: 'CANCELLATION_FAILED' });
        out = { message: `Booking provider ne cancellation request reject kar di${result.failureCode ? ` (${result.failureCode})` : ''}. Booking abhi bhi confirmed hai.`, error: { code: 'PROVIDER_ACTION_FAILED', message: 'Provider rejected the cancellation.' } };
        break;
      case 'NOT_ELIGIBLE':
        this.actions.transition(actionId, 'ACTION_FAILED', { completedAt: now, failureCode: result.failureCode, resultStatus: 'NOT_ELIGIBLE' });
        out = { message: 'Provider ke hisaab se ye booking cancel nahi ho sakti. Booking abhi bhi confirmed hai.', error: { code: 'CANCELLATION_NOT_ELIGIBLE', message: 'Not eligible.' } };
        break;
      default: {
        // UNKNOWN — never CANCELLED; reconcile was attempted if supported; else manual verification
        const manual = !caps?.GET_CANCELLATION_STATUS;
        const target = manual ? 'MANUAL_VERIFICATION_REQUIRED' : 'ACTION_UNKNOWN';
        this.store.updateCancellationStatus(sessionId, rec.bookingId, manual ? 'MANUAL_VERIFICATION_REQUIRED' : 'UNKNOWN', ev(null, true));
        if (act.status !== target) this.actions.transition(actionId, target, { failureCode: result.failureCode, resultStatus: 'UNKNOWN' });
        out = {
          message: LIFECYCLE_MESSAGES.CANCEL_TIMEOUT + (manual ? ' Provider status check support nahi karta — kripya provider ke saath manually verify karein.' : ' "Cancellation status check karo" bolkar provider se verify kar sakte hain.'),
          error: { code: manual ? 'MANUAL_VERIFICATION_REQUIRED' : timedOut ? 'PROVIDER_ACTION_TIMEOUT' : 'CANCELLATION_UNKNOWN', message: 'Cancellation outcome not established.' }
        };
      }
    }
    const fin = this.actions.get(actionId)!;
    this.syncLast(sessionId, actionId);
    ctx.emit('BOOKING_ACTION_RESULT', { actionId, bookingId: rec.bookingId, actionType: fin.actionType, status: fin.status, result: result.status, ...(result.failureCode ? { failureCode: result.failureCode } : {}) });
    this.log({ sessionId, turnId: ctx.turnId, bookingId: rec.bookingId, actionId, actionType: fin.actionType, provider: rec.providerName, previousStatus: prevStatus ?? 'ACTION_IN_PROGRESS', newStatus: fin.status, capability: 'CANCEL_BOOKING', confirmationRequired: true, confirmationReceived: true, providerResult: result.status, latencyMs, rejectionReason: out.error?.code ?? null });
    return { ...out, card: { type: 'booking_action', data: this.view(fin) } };
  }

  private finishCancellationNotSent(sessionId: string, act: Readonly<BookingLifecycleActionRecord>, rec: Readonly<BookingRecord>, result: CancellationResult, latencyMs: number, ctx: { turnId: string; emit: Emit }): LifecycleRunResult {
    // definitely not submitted (auth / validation / rate limit) → nothing happened at the provider
    this.actions.transition(act.actionId, 'ACTION_FAILED', { completedAt: new Date(this.clock()).toISOString(), failureCode: result.failureCode, resultStatus: 'CANCELLATION_FAILED' }, 'NOT_SENT');
    this.syncLast(sessionId, act.actionId);
    this.log({ sessionId, turnId: ctx.turnId, bookingId: rec.bookingId, actionId: act.actionId, actionType: act.actionType, provider: rec.providerName, previousStatus: 'ACTION_IN_PROGRESS', newStatus: 'ACTION_FAILED', providerResult: 'NOT_SENT', latencyMs, confirmationRequired: true, confirmationReceived: true, rejectionReason: 'PROVIDER_ACTION_UNAVAILABLE' });
    ctx.emit('BOOKING_ACTION_RESULT', { actionId: act.actionId, bookingId: rec.bookingId, actionType: act.actionType, status: 'ACTION_FAILED', result: 'NOT_SENT' });
    return this.fail('PROVIDER_ACTION_UNAVAILABLE', 'Cancellation request provider tak nahi pahunchi — booking abhi bhi confirmed hai.');
  }

  private applyModification(sessionId: string, actionId: string, rec: Readonly<BookingRecord>, result: ModificationResult, latencyMs: number | null, ctx: { turnId: string; emit: Emit }, timedOut: boolean, prevStatus?: string): LifecycleRunResult {
    const act = this.actions.get(actionId)!;
    const mod = this.actions.getModification(act.modificationId!)!;
    const now = new Date(this.clock()).toISOString();
    const ev = (providerStatus: string | null, uncertain = false) => ({ source: uncertain ? 'ACTION_OUTCOME_UNCERTAIN' as const : 'PROVIDER_ACTION' as const, actionId, providerStatus });
    const caps = this.capabilitiesFor(rec);
    let out: LifecycleRunResult;
    switch (result.status) {
      case 'MODIFIED': {
        const prev = mod.previous;
        const req = mod.requestedChanges;
        const current = {
          journeyDate: result.applied?.journeyDate ?? (mod.changeType === 'JOURNEY' ? req.journeyDate! : prev.journeyDate),
          travelClass: result.applied?.travelClass ?? (mod.changeType === 'CLASS' ? req.travelClass! : prev.travelClass),
          passengersCount: mod.changeType === 'PASSENGER' && req.passenger?.op === 'REMOVE' ? prev.passengersCount - 1 : prev.passengersCount,
          modificationId: mod.modificationId
        };
        const w = this.store.applyModification(sessionId, rec.bookingId, current, ev('MODIFIED'));
        if (!w.ok) { out = this.fail('MANUAL_VERIFICATION_REQUIRED', 'Provider ka modification result record nahi ho paaya — kripya provider ke saath verify karein.'); break; }
        this.actions.transition(actionId, 'ACTION_CONFIRMED', { completedAt: now, resultStatus: 'MODIFIED' });
        this.actions.updateModification(mod.modificationId, 'MODIFIED');
        ctx.emit('BOOKING_MODIFICATION_CONFIRMED', { actionId, bookingId: rec.bookingId, changeType: mod.changeType });
        const what = mod.changeType === 'JOURNEY' ? `date change confirm kar di hai — nayi journey date: ${humanDate(current.journeyDate)}`
          : mod.changeType === 'CLASS' ? `class change confirm kar diya hai — nayi class: ${current.travelClass}`
          : req.passenger?.op === 'REMOVE' ? `passenger ${req.passenger.passengerNumber} ko hatana confirm kar diya hai` : `passenger ${req.passenger?.passengerNumber} ki details update confirm kar di hain`;
        out = { message: `Booking provider ne ${what}. Original booking details history mein preserved hain.` };
        break;
      }
      case 'PENDING':
        this.store.updateModificationStatus(sessionId, rec.bookingId, 'PENDING', ev('PENDING'));
        this.actions.transition(actionId, 'ACTION_PENDING', { resultStatus: 'PENDING' });
        this.actions.updateModification(mod.modificationId, 'PENDING');
        out = { message: 'Provider ne modification request receive ki hai, lekin change abhi confirm nahi hua (pending). Booking details abhi purani hi hain.' };
        break;
      case 'FAILED':
        this.store.updateModificationStatus(sessionId, rec.bookingId, 'FAILED', ev('FAILED'));
        this.actions.transition(actionId, 'ACTION_FAILED', { completedAt: now, failureCode: result.failureCode, resultStatus: 'FAILED' });
        this.actions.updateModification(mod.modificationId, 'FAILED');
        out = { message: `Booking provider ne modification request reject kar di${result.failureCode ? ` (${result.failureCode})` : ''}. Booking mein koi change nahi hua.`, error: { code: 'PROVIDER_ACTION_FAILED', message: 'Provider rejected the modification.' } };
        break;
      case 'NOT_ELIGIBLE':
        this.actions.transition(actionId, 'ACTION_FAILED', { completedAt: now, failureCode: result.failureCode, resultStatus: 'NOT_ELIGIBLE' });
        this.actions.updateModification(mod.modificationId, 'FAILED');
        out = { message: 'Provider ke hisaab se ye change possible nahi hai. Booking mein koi change nahi hua.', error: { code: 'MODIFICATION_NOT_ELIGIBLE', message: 'Not eligible.' } };
        break;
      default: {
        const manual = !caps?.GET_MODIFICATION_STATUS;
        const target = manual ? 'MANUAL_VERIFICATION_REQUIRED' : 'ACTION_UNKNOWN';
        this.store.updateModificationStatus(sessionId, rec.bookingId, manual ? 'MANUAL_VERIFICATION_REQUIRED' : 'UNKNOWN', ev(null, true));
        if (act.status !== target) this.actions.transition(actionId, target, { failureCode: result.failureCode, resultStatus: 'UNKNOWN' });
        this.actions.updateModification(mod.modificationId, manual ? 'MANUAL_VERIFICATION_REQUIRED' : 'UNKNOWN');
        out = {
          message: 'Modification request ka final status abhi verify nahi hua hai. Duplicate request avoid karne ke liye main dobara request nahi bhej raha.' + (manual ? ' Kripya provider ke saath manually verify karein.' : ' "Modification status check karo" bolkar verify kar sakte hain.'),
          error: { code: manual ? 'MANUAL_VERIFICATION_REQUIRED' : timedOut ? 'PROVIDER_ACTION_TIMEOUT' : 'MODIFICATION_UNKNOWN', message: 'Modification outcome not established.' }
        };
      }
    }
    const fin = this.actions.get(actionId)!;
    this.syncLast(sessionId, actionId);
    ctx.emit('BOOKING_ACTION_RESULT', { actionId, bookingId: rec.bookingId, actionType: fin.actionType, status: fin.status, result: result.status, ...(result.failureCode ? { failureCode: result.failureCode } : {}) });
    this.log({ sessionId, turnId: ctx.turnId, bookingId: rec.bookingId, actionId, actionType: fin.actionType, provider: rec.providerName, previousStatus: prevStatus ?? 'ACTION_IN_PROGRESS', newStatus: fin.status, capability: capabilityFor(fin.actionType), confirmationRequired: true, confirmationReceived: true, providerResult: result.status, latencyMs, rejectionReason: out.error?.code ?? null });
    return { ...out, card: { type: 'booking_action', data: this.view(fin) } };
  }

  // ---- REFUND STATUS (read-only, always a fresh provider call; separate from cancellation) ----
  private async refund(sessionId: string, bookingId: string, ctx: { turnId: string; mode: Mode; emit: Emit }): Promise<LifecycleRunResult> {
    const rec = this.record(sessionId, bookingId);
    const caps = rec ? this.capabilitiesFor(rec) : null;
    const v = this.validator.validate({ action: 'CHECK_REFUND_STATUS', record: rec, capabilities: caps, latestDestructive: null, explicitIntent: true, phase: 'READ', today: this.todayFn() });
    if (!v.ok) return this.rejectRun(sessionId, ctx, 'CHECK_REFUND_STATUS', rec, v.code, v.message, v.capability);
    const r = rec!;
    const provider = this.providerFor(r)!;
    const actionId = this.actions.newId('act');
    const at = new Date(this.clock()).toISOString();
    this.actions.create({ actionId, bookingId: r.bookingId, sessionId, actionType: 'CHECK_REFUND_STATUS', requestedAt: at, providerName: r.providerName, providerReference: r.providerReference, status: 'ACTION_IN_PROGRESS', idempotencyKey: null, modificationId: null, confirmedAt: null });
    const call = await this.callProvider(o => provider.getRefundStatus!({ bookingId: r.bookingId, providerReference: r.providerReference! }, o));
    const n = call.ok ? normalizeRefundResponse(call.value) : null;
    if (!n) {
      this.actions.transition(actionId, 'ACTION_FAILED', { completedAt: new Date(this.clock()).toISOString(), failureCode: call.ok ? 'INVALID_PROVIDER_RESPONSE' : call.error.failureCode, resultStatus: 'UNAVAILABLE' });
      ctx.emit('REFUND_STATUS_CHECKED', { bookingId: r.bookingId, ok: false });
      this.log({ sessionId, turnId: ctx.turnId, bookingId: r.bookingId, actionId, actionType: 'CHECK_REFUND_STATUS', provider: r.providerName, capability: 'GET_REFUND_STATUS', providerResult: 'UNAVAILABLE', latencyMs: call.latencyMs, rejectionReason: 'REFUND_STATUS_UNAVAILABLE' });
      return this.fail('REFUND_STATUS_UNAVAILABLE', 'Refund status abhi provider se verify nahi ho paaya. Main refund ka koi status assume nahi karta.');
    }
    this.store.updateRefundStatus(sessionId, r.bookingId, n.status, { amount: n.amount, currency: n.currency }, { source: 'PROVIDER_ACTION', actionId, providerStatus: n.status });
    this.actions.transition(actionId, 'ACTION_CONFIRMED', { completedAt: new Date(this.clock()).toISOString(), resultStatus: n.status });
    ctx.emit('REFUND_STATUS_CHECKED', { bookingId: r.bookingId, ok: true, status: n.status });
    this.log({ sessionId, turnId: ctx.turnId, bookingId: r.bookingId, actionId, actionType: 'CHECK_REFUND_STATUS', provider: r.providerName, capability: 'GET_REFUND_STATUS', newStatus: n.status, providerResult: n.status, latencyMs: call.latencyMs });
    const amt = n.amount !== null ? ` (${money(n.amount, n.currency || 'INR')})` : '';
    const msg = n.status === 'PROCESSED' ? `Provider ke hisaab se refund processed hai${amt}.`
      : n.status === 'PENDING' ? `Provider ke hisaab se refund abhi pending hai${amt}.`
      : n.status === 'NOT_INITIATED' ? 'Provider ke hisaab se refund abhi initiate nahi hua hai.'
      : 'Provider ke hisaab se refund fail hua hai.';
    return { message: msg + (ctx.mode === 'TEXT' ? ' (Provider se abhi check kiya gaya status.)' : '') };
  }

  // ---- ELIGIBILITY (read-only) ----
  private async eligibility(sessionId: string, plan: Extract<LifecyclePlan, { kind: 'ELIGIBILITY' }>, ctx: { turnId: string; mode: Mode; emit: Emit }): Promise<LifecycleRunResult> {
    const rec = this.record(sessionId, plan.bookingId);
    const caps = rec ? this.capabilitiesFor(rec) : null;
    const v = this.validator.validate({ action: plan.action, record: rec, capabilities: caps, latestDestructive: null, explicitIntent: true, phase: 'READ', today: this.todayFn() });
    if (!v.ok) return this.rejectRun(sessionId, ctx, plan.action, rec, v.code, v.message, v.capability);
    const r = rec!;
    const provider = this.providerFor(r)!;
    const isCancel = plan.action === 'CHECK_CANCELLATION_ELIGIBILITY';
    const call = await this.callProvider(o => isCancel
      ? provider.checkCancellationEligibility!({ bookingId: r.bookingId, providerReference: r.providerReference! }, o)
      : provider.checkModificationEligibility!({ bookingId: r.bookingId, providerReference: r.providerReference!, changeType: plan.changeType }, o));
    const n = call.ok ? normalizeEligibility(call.value) : null;
    this.log({ sessionId, turnId: ctx.turnId, bookingId: r.bookingId, actionType: plan.action, provider: r.providerName, capability: v.capability, providerResult: n ? (n.eligible ? 'ELIGIBLE' : 'NOT_ELIGIBLE') : 'UNAVAILABLE', latencyMs: call.latencyMs, rejectionReason: n ? null : 'PROVIDER_ACTION_UNAVAILABLE' });
    if (!n) return this.fail('PROVIDER_ACTION_UNAVAILABLE', 'Eligibility abhi provider se verify nahi ho paayi.');
    if (isCancel) return { message: n.eligible ? 'Provider ke hisaab se ye booking cancel ho sakti hai. Cancel karna ho to "booking cancel kar do" boliye — confirmation ke baad hi request jayegi.' : `Provider ke hisaab se ye booking abhi cancel nahi ho sakti${n.reasonCode ? ` (${n.reasonCode})` : ''}.` };
    return { message: n.eligible ? 'Provider ke hisaab se is booking mein change possible hai. Kya change karna hai — date, class ya passenger details?' : `Provider ke hisaab se is booking mein abhi change possible nahi hai${n.reasonCode ? ` (${n.reasonCode})` : ''}.` };
  }

  // =========================================================================
  // helpers
  // =========================================================================

  private abandon(act: Readonly<BookingLifecycleActionRecord>, to: 'ACTION_ABANDONED' | 'ACTION_EXPIRED', o: { turnId: string; emit: Emit }, reason?: string) {
    this.actions.transition(act.actionId, to, { completedAt: new Date(this.clock()).toISOString() }, reason);
    if (act.modificationId) this.actions.updateModification(act.modificationId, 'ABANDONED');
    o.emit('BOOKING_ACTION_ABANDONED', { actionId: act.actionId, bookingId: act.bookingId, actionType: act.actionType, status: to });
    this.syncLast(act.sessionId, act.actionId);
    this.log({ sessionId: act.sessionId, turnId: o.turnId, bookingId: act.bookingId, actionId: act.actionId, actionType: act.actionType, provider: act.providerName, previousStatus: 'AWAITING_ACTION_CONFIRMATION', newStatus: to, confirmationRequired: true, confirmationReceived: false });
  }

  private syncLast(sessionId: string, actionId: string) {
    if (!this.state.hasSession(sessionId)) return;
    const s = this.state.getSession(sessionId);
    const a = this.actions.get(actionId);
    if (a && (!s.lastLifecycleAction || s.lastLifecycleAction.actionId === actionId)) {
      s.lastLifecycleAction = { actionId, bookingId: a.bookingId, actionType: a.actionType, status: a.status, resultStatus: a.resultStatus, at: s.lastLifecycleAction?.at ?? this.clock() };
    }
  }

  private duplicateAnswer(act: Readonly<BookingLifecycleActionRecord>, _mode: Mode): LifecycleTurn {
    const d = this.duplicateRun(act);
    return d.error ? { type: 'ERROR', code: d.error.code, message: d.message } : { type: 'DIRECT', answer: d.message };
  }
  private duplicateRun(act: Readonly<BookingLifecycleActionRecord>): LifecycleRunResult {
    const rec = this.record(act.sessionId, act.bookingId);
    const msg = rec ? this.describeAction(act, rec) : 'Ye request pehle hi process ho chuki hai.';
    switch (act.status) {
      case 'ACTION_CONFIRMED': return { message: msg, error: { code: 'ACTION_ALREADY_COMPLETED', message: 'Already completed — not re-sent.' } };
      case 'ACTION_IN_PROGRESS': case 'ACTION_PENDING': return { message: msg, error: { code: 'ACTION_ALREADY_PENDING', message: 'Already pending — not re-sent.' } };
      case 'ACTION_UNKNOWN': case 'MANUAL_VERIFICATION_REQUIRED': return { message: msg, error: { code: 'UNSAFE_RETRY', message: 'Outcome unknown — not re-sent.' } };
      case 'ACTION_ABANDONED': case 'ACTION_EXPIRED': return { message: 'Pichli request confirm ke bina band ho chuki thi — koi request nahi bheji gayi. Zaroorat ho to dobara bolein.', error: { code: 'ACTION_REQUIRES_CONFIRMATION', message: 'No pending action.' } };
      default: return { message: msg, error: { code: 'ACTION_ALREADY_COMPLETED', message: 'Not re-sent.' } };
    }
  }

  describeAction(act: Readonly<BookingLifecycleActionRecord>, r: Readonly<BookingRecord>): string {
    const word = act.actionType === 'REQUEST_CANCELLATION' ? 'Cancellation' : 'Modification';
    switch (act.status) {
      case 'ACTION_CONFIRMED': return act.actionType === 'REQUEST_CANCELLATION' ? `${LIFECYCLE_MESSAGES.ALREADY_CANCELLED} (provider ne confirm kiya tha — dobara request nahi bheji jayegi.)` : 'Ye change provider pehle hi confirm kar chuka hai — dobara request nahi bheji jayegi.';
      case 'ACTION_PENDING': case 'ACTION_IN_PROGRESS': return `${word} request provider ke paas pending hai — final confirmation abhi nahi aaya. Dobara request nahi bheji jayegi.`;
      case 'ACTION_UNKNOWN': return `${word} request ka final status abhi verify nahi hua hai. Duplicate request avoid karne ke liye main dobara request nahi bhej raha.`;
      case 'MANUAL_VERIFICATION_REQUIRED': return `${word} request ka final status verify nahi hua hai — kripya provider ke saath manually verify karein. Dobara request nahi bheji jayegi.`;
      case 'ACTION_FAILED': return `Pichli ${word.toLowerCase()} request ${act.resultStatus === 'NOT_ELIGIBLE' ? 'eligible nahi thi' : 'provider ne reject ki thi'}${act.failureCode ? ` (${act.failureCode})` : ''}. Booking status: ${r.bookingStatus.toLowerCase()}.`;
      default: return `${word} request confirm ke bina band ho gayi thi — provider ko kuch nahi bheja gaya.`;
    }
  }

  private changeDesc(t: ModificationChangeType, c: RequestedChanges): string {
    if (t === 'JOURNEY') return `journey date ${humanDate(c.journeyDate!)} karne`;
    if (t === 'CLASS') return `class ${c.travelClass} karne`;
    const p = c.passenger!;
    if (p.op === 'REMOVE') return `passenger ${p.passengerNumber} ko hatane`;
    const f = p.field === 'name' ? 'naam' : p.field === 'berthPreference' ? 'berth preference' : p.field;
    return `passenger ${p.passengerNumber} ki ${f} update karne`;
  }

  private label(r: Readonly<BookingRecord>, mode: Mode): string {
    const d = humanDate(r.current?.journeyDate ?? r.journeyDate);
    if (mode === 'VOICE') return `${r.train.trainNumber}, ${d}`;
    return `${r.journey.originName || r.journey.origin} → ${r.journey.destinationName || r.journey.destination}, ${d}, ${r.current?.travelClass ?? r.travelClass}`;
  }

  private view(a: Readonly<BookingLifecycleActionRecord>): BookingActionView {
    return { actionId: a.actionId, bookingId: a.bookingId, actionType: a.actionType, status: a.status, resultStatus: a.resultStatus };
  }

  private reject(sessionId: string, o: { turnId: string; emit: Emit }, action: ParsedLifecycleAction | 'ACTION_STATUS', r: Readonly<BookingRecord> | null, code: LifecycleActionErrorCode, message: string, capability: ProviderActionCapability | null = null): LifecycleTurn {
    const at = action === 'ACTION_STATUS' ? 'NO_ACTION' : action;
    o.emit('BOOKING_ACTION_REJECTED', { actionType: at, code, ...(r ? { bookingId: r.bookingId } : {}) });
    this.log({ sessionId, turnId: o.turnId, bookingId: r?.bookingId ?? null, actionType: at, provider: r?.providerName ?? null, capability, rejectionReason: code, confirmationRequired: DESTRUCTIVE_LIFECYCLE_ACTIONS.has(at as any) });
    return { type: 'ERROR', code, message };
  }
  private rejectRun(sessionId: string, o: { turnId: string; emit: Emit }, action: ParsedLifecycleAction, r: Readonly<BookingRecord> | null, code: LifecycleActionErrorCode, message: string, capability: ProviderActionCapability | null = null, latencyMs: number | null = null): LifecycleRunResult {
    o.emit('BOOKING_ACTION_REJECTED', { actionType: action, code, ...(r ? { bookingId: r.bookingId } : {}) });
    this.log({ sessionId, turnId: o.turnId, bookingId: r?.bookingId ?? null, actionType: action, provider: r?.providerName ?? null, capability, rejectionReason: code, latencyMs, confirmationRequired: DESTRUCTIVE_LIFECYCLE_ACTIONS.has(action as any) });
    return this.fail(code, message);
  }
  private fail(code: LifecycleActionErrorCode, message: string): LifecycleRunResult { return { message, error: { code, message } }; }

  private log(p: Partial<LifecycleActionLogRecord> & { sessionId: string; actionType: ParsedLifecycleAction }) {
    const rec: LifecycleActionLogRecord = {
      at: new Date(this.clock()).toISOString(), sessionId: p.sessionId, turnId: p.turnId ?? null, bookingId: p.bookingId ?? null, actionId: p.actionId ?? null,
      actionType: p.actionType, provider: p.provider ?? null, previousStatus: p.previousStatus ?? null, newStatus: p.newStatus ?? null, capability: p.capability ?? null,
      validationResult: p.rejectionReason ? 'REJECTED' : 'OK', confirmationRequired: !!p.confirmationRequired, confirmationReceived: !!p.confirmationReceived,
      providerResult: p.providerResult ?? null, latencyMs: p.latencyMs ?? null, rejectionReason: p.rejectionReason ?? null
    };
    this.logs.push(Object.freeze(rec));
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
  }
}
