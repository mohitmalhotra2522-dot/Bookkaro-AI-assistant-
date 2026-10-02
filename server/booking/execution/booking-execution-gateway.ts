/**
 * BookingExecutionGateway — the ONLY path from a user-confirmed review to a
 * BookingExecutor.
 *
 *   execute(request):
 *     1. receive the validated BookingExecutionRequest (backend-built, typed)
 *     2. verify session            (exists, id match, sessionVersion unchanged)
 *     3. verify confirmation       (AWAITING_CONFIRMATION + explicit backend confirmation)
 *     4. verify review version     (request == current review == confirmed version, fingerprint)
 *     5. verify readiness          (journey, train vs authoritative results, class,
 *                                   passengers re-validated, availability + fare FRESH)
 *     6. verify execution capability (fail-closed flag / registry resolution)
 *     7. invoke the executor ONLY when resolved (Disabled in this milestone)
 *     8. normalize the result      (never manufactures SUCCESS / PNR / reference)
 *     9. sync the authoritative result back to the BookingSession — atomically,
 *        and only if the session did not change while the executor ran.
 *
 * The gateway does NOT trust the LLM, the frontend, or stale references: every
 * check is re-done here against the authoritative BookingSession, independently
 * of what BookingPreparationService already verified. On any rejection it does
 * not mutate the session (fail closed); the caller decides recovery.
 *
 * Idempotency: idempotencyKey = H(sessionId | reviewVersion | review fingerprint).
 * A duplicate confirmation of the same review returns the existing handoff and
 * never invokes the executor again (concurrent duplicates share one in-flight run).
 */
import { BookingState } from '@shared/states';
import type { BookingSession } from '@shared/entities';
import type {
  BookingExecutionRequest, BookingExecutionResult, BookingExecutionErrorCode, BookingHandoffRecord,
  ExecutionCapability, ExecutionLogRecord, BookingHandoffSnapshot
} from '@shared/booking-execution';
import { BOOKING_EXECUTION_STATUSES, NON_EXECUTING_STATUSES } from '@shared/booking-execution';
import { MAX_PASSENGERS } from '@shared/constants';
import type { ConversationStateManager } from '../../ai/state/conversation-state';
import { currentResults } from '../../ai/context/train-reference-resolver';
import { trainClassCodes } from '../../ai/context/class-reference-resolver';
import { BookingReadinessEvaluator, defaultPolicy } from '../booking-readiness';
import { passengerValidator } from '../passenger-validator';
import { reviewFingerprint } from '../review-builder';
import { v4 as uuid } from '../../ai/orchestrator/utils';
import type { BookingExecutor } from './booking-executor';
import { BookingExecutorRegistry, createProductionExecutorRegistry } from './booking-executor-registry';
import { BookingHandoffService, computeIdempotencyKey } from './booking-handoff';
import { DEFAULT_EXECUTION_CONFIG, type ExecutionConfig } from './execution-config';
import { findSensitiveKeys } from './execution-request';
import { transitionLifecycle } from './booking-lifecycle';

export interface GatewayContext {
  turnId: string;
  /** Event sink (BookingSession event log + turn events). */
  emit?: (type: any, data?: Record<string, any>) => void;
}

export type GatewayOutcome =
  | { ok: true; duplicate: boolean; handoff: BookingHandoffRecord; execution: BookingExecutionResult; capability: ExecutionCapability; log: ExecutionLogRecord }
  | { ok: false; code: BookingExecutionErrorCode; detail?: string; capability: ExecutionCapability; log: ExecutionLogRecord };

export interface GatewayOptions {
  registry?: BookingExecutorRegistry;
  config?: ExecutionConfig;
  clock?: () => number;
  handoffs?: BookingHandoffService;
}

const tn = (t: any): string | undefined => (t ? String(t.number || t.trainNumber) : undefined);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class BookingExecutionGateway {
  readonly registry: BookingExecutorRegistry;
  readonly config: ExecutionConfig;
  readonly handoffs: BookingHandoffService;
  private readonly clock: () => number;
  /** Execution policy is STRICTER than the review policy: availability AND fare must be FRESH. */
  private readonly executionReadiness = new BookingReadinessEvaluator({ ...defaultPolicy(), requireAvailability: true, requireFare: true });
  private readonly completed = new Map<string, Extract<GatewayOutcome, { ok: true }>>();
  private readonly inFlight = new Map<string, Promise<GatewayOutcome>>();
  private readonly logs: ExecutionLogRecord[] = [];

  constructor(private readonly state: ConversationStateManager, opts: GatewayOptions = {}) {
    this.registry = opts.registry || createProductionExecutorRegistry();
    this.config = opts.config || DEFAULT_EXECUTION_CONFIG;
    this.clock = opts.clock || (() => Date.now());
    this.handoffs = opts.handoffs || new BookingHandoffService({ ttlMs: this.config.handoffTtlMs });
  }

  /** Current capability (no side effects) — for UI / API / logs. */
  capability(): ExecutionCapability { return this.registry.resolve(this.config).capability; }

  /** PII-free execution log (observability). */
  executionLog(sessionId?: string): ExecutionLogRecord[] {
    return sessionId ? this.logs.filter(l => l.sessionId === sessionId) : [...this.logs];
  }

  async execute(request: BookingExecutionRequest, ctx: GatewayContext): Promise<GatewayOutcome> {
    const key = request?.idempotencyKey;
    const running = key ? this.inFlight.get(key) : undefined;
    if (running) {
      const prev = await running;
      return prev.ok ? this.duplicateOf(prev, request, ctx, this.clock()) : prev;
    }
    const p = this.run(request, ctx);
    if (key) this.inFlight.set(key, p);
    try { return await p; } finally { if (key) this.inFlight.delete(key); }
  }

  // --------------------------------------------------------------------------

  private async run(request: BookingExecutionRequest, ctx: GatewayContext): Promise<GatewayOutcome> {
    const t0 = this.clock();
    const resolution = this.registry.resolve(this.config);
    const capability = resolution.capability;
    const reject = (code: BookingExecutionErrorCode, detail?: string, extra: Partial<ExecutionLogRecord> = {}): GatewayOutcome => {
      const log = this.record({
        sessionId: String(request?.sessionId ?? ''), requestId: String(request?.requestId ?? ''),
        reviewVersion: request?.reviewVersion, sessionVersion: request?.sessionVersion,
        executionCapability: capability.reason, idempotencyKey: request?.idempotencyKey,
        latencyMs: this.clock() - t0, rejectionReason: code, ...extra
      });
      ctx.emit?.('BOOKING_EXECUTION_REJECTED', { code, reviewVersion: request?.reviewVersion });
      return { ok: false, code, detail, capability, log };
    };

    // 1) typed, credential-free request
    if (!request || request.explicitConfirmation !== true) return reject('CONFIRMATION_REQUIRED', 'explicit backend confirmation missing');
    const sensitive = findSensitiveKeys(request);
    if (sensitive.length) return reject('INVALID_BOOKING_HANDOFF', 'request contains forbidden credential-like fields');

    // 2) session
    let s: BookingSession;
    try { s = this.state.getSession(request.sessionId); } catch { return reject('BOOKING_NOT_READY', 'unknown session'); }
    if (!s || s.sessionId !== request.sessionId) return reject('BOOKING_NOT_READY', 'session mismatch');

    // Idempotency — duplicate confirmation of the same review → same handoff, executor NOT re-invoked
    const prev = this.completed.get(request.idempotencyKey);
    if (prev && s.handoff?.snapshot.idempotencyKey === request.idempotencyKey && s.handoff.status === 'READY'
      && s.bookingState === BookingState.IRCTC_HANDOFF_READY) {
      return this.duplicateOf(prev, request, ctx, t0);
    }

    // 3) confirmation
    if (s.bookingState !== BookingState.AWAITING_CONFIRMATION) return reject('CONFIRMATION_REQUIRED', `state ${s.bookingState}`);
    const rv = s.review;
    if (!rv || !rv.valid) return reject('CONFIRMATION_REQUIRED', 'no valid review');

    // 4) review version + session version + fingerprint
    if (request.reviewVersion !== rv.reviewVersion || s.confirmedReviewVersion !== rv.reviewVersion) return reject('CONFIRMATION_VERSION_MISMATCH');
    if (request.sessionVersion !== s.sessionVersion) return reject('SESSION_VERSION_CONFLICT');
    const fp = reviewFingerprint(s);
    if (fp !== rv.fingerprint) return reject('STALE_BOOKING_HANDOFF', 'booking data changed since review');
    if (request.idempotencyKey !== computeIdempotencyKey(s.sessionId, rv.reviewVersion, rv.fingerprint)) return reject('INVALID_BOOKING_HANDOFF', 'idempotency key does not match the confirmed review');

    // 5) readiness — every booking-critical value re-validated against authoritative data
    const now = this.clock();
    const v = this.validateBookingData(s, request, now);
    if (v) return reject(v.code, v.detail);

    // Build the immutable handoff (not yet stored)
    const handoffId = `HO-${uuid().slice(0, 8).toUpperCase()}`;
    const hb = this.handoffs.build(s, request, handoffId, now);
    if (!hb.ok) return reject(hb.code, hb.detail);
    ctx.emit?.('BOOKING_EXECUTION_REQUESTED', { reviewVersion: rv.reviewVersion, handoffId, executionCapability: capability.reason });

    // 6) + 7) capability → executor (only if resolved)
    const frozenRequest = Object.freeze({ ...request, passengers: request.passengers.map(p => Object.freeze({ ...p })) }) as BookingExecutionRequest;
    let raw: BookingExecutionResult | undefined;
    let executor: BookingExecutor | null = resolution.executor;
    if (executor) {
      try { raw = await executor.execute(frozenRequest); }
      catch { raw = { status: 'FAILED', reason: 'EXECUTOR_THREW', executorName: executor.name, idempotencyKey: request.idempotencyKey, completedAt: new Date(this.clock()).toISOString() }; }
    }

    // Session must not have changed while the executor ran — otherwise discard the result.
    const after = this.state.getSession(request.sessionId);
    if (after.sessionVersion !== request.sessionVersion || after.bookingState !== BookingState.AWAITING_CONFIRMATION
      || after.review?.reviewVersion !== request.reviewVersion || reviewFingerprint(after) !== hb.snapshot.fingerprint) {
      return reject('SESSION_VERSION_CONFLICT', 'session changed during execution — result discarded', { handoffId, executorName: executor?.name });
    }

    // 8) normalize
    const result = this.normalize(raw, executor, capability, request);

    // 9) sync atomically
    const record = this.sync(after, hb.snapshot, result, ctx);
    const log = this.record({
      sessionId: request.sessionId, requestId: request.requestId, reviewVersion: request.reviewVersion,
      sessionVersion: after.sessionVersion, handoffId, handoffStatus: record.status,
      executionCapability: capability.reason, executorName: result.executorName, executionStatus: result.status,
      idempotencyKey: request.idempotencyKey, latencyMs: this.clock() - t0,
      ...(result.status === 'FAILED' ? { rejectionReason: 'BOOKING_EXECUTION_FAILED' as const } : {})
    });
    const outcome = { ok: true as const, duplicate: false, handoff: record, execution: result, capability, log };
    this.completed.set(request.idempotencyKey, outcome);
    return outcome;
  }

  /** Independent re-validation of all booking-critical data. Returns the first failure. */
  private validateBookingData(s: BookingSession, req: BookingExecutionRequest, now: number): { code: BookingExecutionErrorCode; detail: string } | null {
    // Journey
    if (!s.origin || !s.destination || s.origin === s.destination) return { code: 'BOOKING_NOT_READY', detail: 'invalid journey' };
    if (req.journey?.origin !== s.origin || req.journey?.destination !== s.destination) return { code: 'BOOKING_NOT_READY', detail: 'journey mismatch' };
    if (!s.date || !ISO_DATE.test(s.date) || req.date !== s.date) return { code: 'BOOKING_NOT_READY', detail: 'invalid date' };
    if (s.date < new Date(now - 24 * 3600_000).toISOString().slice(0, 10)) return { code: 'BOOKING_NOT_READY', detail: 'date in the past' };

    // Train — against the CURRENT authoritative search results (never LLM / old refs)
    const t: any = s.selectedTrain;
    const rt = req.selectedTrain;
    const sr: any = s.searchResults;
    if (!t || !rt || !sr) return { code: 'INVALID_TRAIN', detail: 'no selected train / results' };
    if (rt.trainNumber !== tn(t)) return { code: 'INVALID_TRAIN', detail: 'train number mismatch' };
    if (!t.resultId || rt.resultId !== t.resultId) return { code: 'INVALID_TRAIN', detail: 'resultId mismatch' };
    if (!sr.resultId || t.searchResultId !== sr.resultId || !String(t.resultId).startsWith(`${sr.resultId}:`)) return { code: 'INVALID_TRAIN', detail: 'selection not from current results' };
    if (sr.journey?.origin !== s.origin || sr.journey?.destination !== s.destination || sr.journey?.date !== s.date) return { code: 'INVALID_TRAIN', detail: 'results belong to another journey' };
    if (t.date !== s.date || rt.date !== s.date) return { code: 'INVALID_TRAIN', detail: 'train date mismatch' };
    const row: any = currentResults(s).find((r: any) => r.resultId === t.resultId);
    if (!row || String(row.trainNumber || row.number) !== tn(t)) return { code: 'INVALID_TRAIN', detail: 'train not in current results' };
    if (row.origin !== t.origin || row.destination !== t.destination || rt.origin !== t.origin || rt.destination !== t.destination) return { code: 'INVALID_TRAIN', detail: 'train route mismatch' };

    // Class
    if (!s.selectedClass || req.selectedClass !== s.selectedClass || !trainClassCodes(row).includes(s.selectedClass)) return { code: 'INVALID_CLASS', detail: 'class not valid for train' };

    // Passengers — validator re-run, request must equal session
    const ps: any[] = s.passengers || [];
    const count = s.passengersCount || 0;
    if (count < 1 || count > MAX_PASSENGERS || ps.length !== count || req.passengers.length !== count) return { code: 'INVALID_PASSENGER_DETAILS', detail: 'passenger count mismatch' };
    for (let i = 0; i < ps.length; i++) {
      const vr = passengerValidator.validateRecord(ps[i]);
      if (!vr.complete || !vr.valid) return { code: 'INVALID_PASSENGER_DETAILS', detail: `passenger ${i + 1} invalid` };
      const q = req.passengers[i];
      if (!q || q.passengerId !== ps[i].id || q.name !== ps[i].name || q.age !== ps[i].age || q.gender !== ps[i].gender) return { code: 'INVALID_PASSENGER_DETAILS', detail: `passenger ${i + 1} mismatch` };
    }

    // Readiness + freshness (execution policy: availability AND fare must be FRESH)
    const r = this.executionReadiness.evaluate(s, now);
    if (r.blockers.includes('INVALID_TRAIN') || r.blockers.includes('MISSING_TRAIN')) return { code: 'INVALID_TRAIN', detail: 'readiness' };
    if (r.blockers.includes('INVALID_CLASS') || r.blockers.includes('MISSING_CLASS')) return { code: 'INVALID_CLASS', detail: 'readiness' };
    if (r.blockers.includes('INVALID_PASSENGER_DETAILS') || r.blockers.includes('MISSING_PASSENGER_DETAILS')) return { code: 'INVALID_PASSENGER_DETAILS', detail: 'readiness' };
    if (r.availability !== 'FRESH') return { code: 'STALE_AVAILABILITY', detail: `availability ${r.availability}` };
    if (r.fare !== 'FRESH') return { code: 'STALE_FARE', detail: `fare ${r.fare}` };
    if (r.blockers.length) return { code: 'BOOKING_NOT_READY', detail: r.blockers.join(',') };
    return null;
  }

  /** Never manufactures success. Non-REAL executors can only yield DISABLED / REQUIRES_HANDOFF / FAILED. */
  private normalize(raw: BookingExecutionResult | undefined, executor: BookingExecutor | null, cap: ExecutionCapability, req: BookingExecutionRequest): BookingExecutionResult {
    const at = new Date(this.clock()).toISOString();
    const base = { executorName: executor?.name ?? 'none', idempotencyKey: req.idempotencyKey, completedAt: at };
    if (!executor) return { ...base, status: 'DISABLED', reason: cap.reason };           // fail closed: nothing invoked
    if (!raw || !BOOKING_EXECUTION_STATUSES.includes(raw.status)) return { ...base, status: 'FAILED', reason: 'BOOKING_EXECUTION_FAILED' };
    if (executor.kind === 'DISABLED') {
      return raw.status === 'DISABLED' ? { ...base, status: 'DISABLED', reason: 'REAL_BOOKING_DISABLED' } : { ...base, status: 'FAILED', reason: 'BOOKING_EXECUTION_FAILED' };
    }
    // TEST (or any non-production) executor: success-like statuses are untrusted.
    if (!NON_EXECUTING_STATUSES.has(raw.status)) return { ...base, status: 'FAILED', reason: 'UNTRUSTED_EXECUTOR_RESULT' };
    // bookingReference is NEVER propagated (only whitelisted fields are copied).
    return { ...base, status: raw.status, reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 60) : raw.status };
  }

  private sync(s: BookingSession, snapshot: Readonly<BookingHandoffSnapshot>, result: BookingExecutionResult, ctx: GatewayContext): BookingHandoffRecord {
    const at = new Date(this.clock()).toISOString();
    if (s.handoff && s.handoff.snapshot.handoffId !== snapshot.handoffId && s.handoff.status === 'READY') {
      this.handoffs.setStatus(s, 'INVALIDATED', 'SUPERSEDED', this.clock());
    }
    const record: BookingHandoffRecord = { snapshot, status: 'READY', statusChangedAt: at };
    s.handoff = record;
    (s.handoffHistory ||= []).push({ handoffId: snapshot.handoffId, status: 'READY', at });
    transitionLifecycle(s, 'READY_FOR_CONFIRMATION', 'review', at);
    transitionLifecycle(s, 'CONFIRMED_BY_USER', 'explicit confirmation', at);
    transitionLifecycle(s, 'HANDOFF_CREATED', snapshot.handoffId, at);
    transitionLifecycle(s, result.status === 'FAILED' ? 'EXECUTION_FAILED' : 'EXECUTION_DISABLED', result.reason, at);
    s.execution = { status: result.status, reason: result.reason, executorName: result.executorName, idempotencyKey: result.idempotencyKey, handoffId: snapshot.handoffId, at };
    this.state.markReviewConfirmed(s.sessionId);
    this.state.transitionState(s.sessionId, BookingState.IRCTC_HANDOFF_READY);
    this.state.markHandoffReady(s.sessionId);
    ctx.emit?.('BOOKING_HANDOFF_CREATED', { handoffId: snapshot.handoffId, reviewVersion: snapshot.reviewVersion, expiresAt: snapshot.expiresAt });
    ctx.emit?.('BOOKING_LIFECYCLE_UPDATED', { status: s.bookingLifecycle?.status });
    ctx.emit?.('BOOKING_EXECUTION_DISABLED', { status: result.status, reason: result.reason, executor: result.executorName });
    return record;
  }

  private duplicateOf(prev: Extract<GatewayOutcome, { ok: true }>, request: BookingExecutionRequest, ctx: GatewayContext, t0: number): GatewayOutcome {
    const s = this.state.getSession(prev.handoff.snapshot.sessionId);
    const log = this.record({
      sessionId: request.sessionId, requestId: request.requestId, reviewVersion: request.reviewVersion, sessionVersion: s.sessionVersion,
      handoffId: prev.handoff.snapshot.handoffId, handoffStatus: s.handoff?.status, executionCapability: prev.capability.reason,
      executorName: prev.execution.executorName, executionStatus: prev.execution.status, idempotencyKey: request.idempotencyKey,
      duplicate: true, latencyMs: this.clock() - t0
    });
    ctx.emit?.('BOOKING_EXECUTION_DUPLICATE', { handoffId: prev.handoff.snapshot.handoffId, reviewVersion: request.reviewVersion });
    return { ...prev, duplicate: true, handoff: s.handoff || prev.handoff, log };
  }

  private record(l: Omit<ExecutionLogRecord, 'at'>): ExecutionLogRecord {
    const rec: ExecutionLogRecord = { ...l, at: new Date(this.clock()).toISOString() };
    this.logs.push(rec);
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    return rec;
  }
}
