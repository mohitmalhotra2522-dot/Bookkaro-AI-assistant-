/**
 * BookingHandoffSessionService — short-lived, secure handoff context between the
 * AI booking agent and any FUTURE external executor adapter.
 *
 *   createHandoff()  : BookingHandoff (READY) + BookingConfirmation (VALID)
 *                      → sensitive-data guard → BookingSnapshot (immutable)
 *                      → BookingHandoffSession CREATED → BookingHandoffValidator → READY
 *                      → executor capability recorded (disabled). NOTHING is executed.
 *   consumeHandoff() : a SEPARATE, explicit execution boundary. Validates again, resolves
 *                      the adapter fail-closed, and — with the disabled adapter — returns
 *                      BOOKING_EXECUTION_DISABLED without invoking the adapter. Never CONSUMED.
 *
 * Lifecycle: CREATED → READY → (EXPIRED | INVALIDATED | FAILED); CONSUMED is reserved
 * for a future real executor and is never set in this milestone.
 */
import { createHash, randomBytes } from 'crypto';
import type { BookingSession } from '@shared/entities';
import type { BookingExecutionResult } from '@shared/booking-execution';
import { BOOKING_EXECUTION_STATUSES, NON_EXECUTING_STATUSES } from '@shared/booking-execution';
import type { BookingExecutorCapability, BookingHandoffSession, HandoffErrorCode, HandoffSessionStatus } from '@shared/booking-handoff-session';
import { deepFreeze } from '../execution/booking-handoff';
import { DEFAULT_EXECUTION_CONFIG, type ExecutionConfig } from '../execution/execution-config';
import { buildBookingSnapshot } from './booking-snapshot';
import { BookingHandoffValidator } from './booking-handoff-validator';
import { checkNoSensitiveData } from './sensitive-data-guard';
import { BookingExecutorAdapterRegistry, createProductionAdapterRegistry, isValidCapability } from './booking-executor-adapter-registry';

export const HANDOFF_SESSION_TRANSITIONS: Readonly<Record<HandoffSessionStatus, readonly HandoffSessionStatus[]>> = Object.freeze({
  CREATED: ['READY', 'FAILED'],
  READY: ['EXPIRED', 'INVALIDATED', 'FAILED'],      // 'CONSUMED' intentionally absent in this milestone
  CONSUMED: [],
  EXPIRED: [],
  INVALIDATED: [],
  FAILED: []
});

export interface HandoffEventCtx { requestId?: string; emit?: (type: any, data?: Record<string, any>) => void }

export type CreateHandoffOutcome =
  | { ok: true; duplicate: boolean; handoffSession: BookingHandoffSession }
  | { ok: false; code: HandoffErrorCode; detail: string };

export interface ConsumeHandoffOutcome {
  ok: boolean;
  code: HandoffErrorCode | 'OK';
  detail?: string;
  duplicate?: boolean;
  handoffSessionId?: string;
  executionStatus?: BookingExecutionResult['status'];
  executorAttempted: boolean;
  capability?: Readonly<BookingExecutorCapability>;
}

export interface HandoffSessionServiceOptions {
  registry?: BookingExecutorAdapterRegistry;
  config?: ExecutionConfig;
  clock?: () => number;
}

export class BookingHandoffSessionService {
  readonly validator = new BookingHandoffValidator();
  readonly registry: BookingExecutorAdapterRegistry;
  readonly config: ExecutionConfig;
  private readonly clock: () => number;
  private readonly consumed = new Map<string, ConsumeHandoffOutcome>();
  private readonly inFlight = new Map<string, Promise<ConsumeHandoffOutcome>>();

  constructor(opts: HandoffSessionServiceOptions = {}) {
    this.registry = opts.registry || createProductionAdapterRegistry();
    this.config = opts.config || DEFAULT_EXECUTION_CONFIG;
    this.clock = opts.clock || (() => Date.now());
  }

  /** Current executor capability (fail-closed). */
  capability(): Readonly<BookingExecutorCapability> { return this.registry.resolve(this.config).capability; }

  static audit(hs: BookingHandoffSession) {
    return { sessionId: hs.sessionId, requestId: hs.requestId, handoffId: hs.bookingHandoffId, handoffSessionId: hs.handoffSessionId,
      reviewVersion: hs.reviewVersion, sessionVersion: hs.sessionVersion, status: hs.status };
  }

  /** createHandoff — builds the handoff session. Does NOT execute anything. */
  create(s: BookingSession, ctx: HandoffEventCtx = {}, extra?: Record<string, unknown>): CreateHandoffOutcome {
    const now = this.clock();
    const h = s.handoff;
    if (!h) return { ok: false, code: 'HANDOFF_NOT_FOUND', detail: 'no booking handoff' };
    if (h.status !== 'READY') return { ok: false, code: h.status === 'EXPIRED' ? 'HANDOFF_SESSION_EXPIRED' : 'HANDOFF_INVALIDATED', detail: `booking handoff ${h.status}` };
    // duplicate confirmation → resolve against the existing READY session
    const cur = s.handoffSession;
    if (cur && cur.status === 'READY' && cur.bookingHandoffId === h.snapshot.handoffId) return { ok: true, duplicate: true, handoffSession: cur };

    const c = s.confirmation;
    if (!c || c.status !== 'VALID') return { ok: false, code: 'INVALID_CONFIRMATION', detail: 'no valid confirmation' };
    if (c.reviewVersion !== h.snapshot.reviewVersion || c.reviewFingerprint !== h.snapshot.fingerprint) return { ok: false, code: 'CONFIRMATION_VERSION_MISMATCH', detail: 'confirmation is for another review' };
    if (c.sessionVersion !== h.snapshot.sessionVersion) return { ok: false, code: 'SESSION_VERSION_CONFLICT', detail: 'confirmation from another session version' };

    const sb = buildBookingSnapshot(s, now);
    if (!sb.ok) return { ok: false, code: sb.code, detail: sb.detail };
    if (sb.snapshot.fingerprint !== h.snapshot.fingerprint) return { ok: false, code: 'BOOKING_DATA_CHANGED', detail: 'data changed between handoff and snapshot' };

    // secure data boundary — nothing credential-like may be persisted
    const sens = checkNoSensitiveData(sb.snapshot, h.snapshot, c, extra);
    if (!sens.ok) return { ok: false, code: 'SENSITIVE_DATA_REJECTED', detail: `rejected fields: ${sens.fields.length}` };

    const resolution = this.registry.resolve(this.config);
    const hs: BookingHandoffSession = {
      handoffSessionId: `hs_${randomBytes(12).toString('hex')}`,
      bookingHandoffId: h.snapshot.handoffId,
      sessionId: s.sessionId,
      requestId: ctx.requestId || h.snapshot.requestId,
      reviewVersion: h.snapshot.reviewVersion,
      sessionVersion: s.sessionVersion,
      confirmationId: c.confirmationId,
      idempotencyKey: 'hx_' + createHash('sha256').update(`${h.snapshot.idempotencyKey}|${h.snapshot.handoffId}|${c.confirmationId}|${sb.snapshot.fingerprint}`).digest('hex').slice(0, 32),
      status: 'CREATED',
      statusChangedAt: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(Math.min(now + this.config.handoffSessionTtlMs, Date.parse(h.snapshot.expiresAt))).toISOString(),
      bookingSnapshot: sb.snapshot,
      executorCapability: deepFreeze({ ...resolution.capability }),
      executionAttempts: 0
    };
    const v = this.validator.validate(s, hs, now, { allowCreated: true });
    if (!v.ok) {
      hs.status = 'FAILED'; hs.statusReason = v.code;
      (s.handoffSessionHistory ||= []).push({ handoffSessionId: hs.handoffSessionId, bookingHandoffId: hs.bookingHandoffId, status: 'FAILED', statusReason: v.code, at: hs.statusChangedAt });
      return { ok: false, code: v.code, detail: v.detail };
    }
    if (cur && cur.status === 'READY') this.setStatus(s, 'INVALIDATED', 'SUPERSEDED', now);
    hs.status = 'READY';
    s.handoffSession = hs;
    (s.handoffSessionHistory ||= []).push({ handoffSessionId: hs.handoffSessionId, bookingHandoffId: hs.bookingHandoffId, status: 'READY', at: hs.statusChangedAt });
    ctx.emit?.('BOOKING_HANDOFF_SESSION_CREATED', { ...BookingHandoffSessionService.audit(hs), expiresAt: hs.expiresAt, executorEnabled: hs.executorCapability.enabled, executorName: hs.executorCapability.executorName });
    return { ok: true, duplicate: false, handoffSession: hs };
  }

  /** Status that the CURRENT handoff session should have now (pure). */
  check(s: BookingSession, now: number): { status: HandoffSessionStatus; reason?: string } | null {
    const hs = s.handoffSession;
    if (!hs) return null;
    if (hs.status !== 'READY') return { status: hs.status, reason: hs.statusReason };
    if (!(now < Date.parse(hs.expiresAt))) return { status: 'EXPIRED', reason: 'HANDOFF_SESSION_EXPIRED' };
    if (s.sessionVersion !== hs.sessionVersion) return { status: 'INVALIDATED', reason: 'SESSION_VERSION_CHANGED' };
    if (!s.handoff || s.handoff.snapshot.handoffId !== hs.bookingHandoffId || s.handoff.status !== 'READY') return { status: 'INVALIDATED', reason: 'BOOKING_HANDOFF_NOT_READY' };
    return { status: 'READY' };
  }

  setStatus(s: BookingSession, status: 'EXPIRED' | 'INVALIDATED' | 'FAILED', reason: string, now: number): boolean {
    const hs = s.handoffSession;
    if (!hs || !HANDOFF_SESSION_TRANSITIONS[hs.status].includes(status)) return false;
    hs.status = status;
    hs.statusReason = reason;
    hs.statusChangedAt = new Date(now).toISOString();
    (s.handoffSessionHistory ||= []).push({ handoffSessionId: hs.handoffSessionId, bookingHandoffId: hs.bookingHandoffId, status, statusReason: reason, at: hs.statusChangedAt });
    return true;
  }

  /**
   * consumeHandoff — explicit execution boundary (separate from createHandoff).
   * Current milestone: always ends in BOOKING_EXECUTION_DISABLED (or an earlier rejection).
   */
  async consume(s: BookingSession, handoffSessionId: string, ctx: HandoffEventCtx = {}, options?: Record<string, unknown>): Promise<ConsumeHandoffOutcome> {
    const sens = checkNoSensitiveData(options);
    if (!sens.ok) return { ok: false, code: 'SENSITIVE_DATA_REJECTED', detail: `rejected fields: ${sens.fields.length}`, executorAttempted: false };
    const hs = s.handoffSession && s.handoffSession.handoffSessionId === handoffSessionId ? s.handoffSession : undefined;
    if (!hs) {
      const old = (s.handoffSessionHistory || []).filter(x => x.handoffSessionId === handoffSessionId).pop();
      if (!old) return { ok: false, code: 'HANDOFF_NOT_FOUND', detail: 'unknown handoff session', executorAttempted: false };
      const code: HandoffErrorCode = old.status === 'EXPIRED' ? 'HANDOFF_SESSION_EXPIRED' : old.status === 'CONSUMED' ? 'HANDOFF_ALREADY_CONSUMED' : 'HANDOFF_INVALIDATED';
      return { ok: false, code, detail: `superseded handoff session (${old.status})`, handoffSessionId, executorAttempted: false };
    }
    // an executor attempt already happened for this key → never a second attempt
    const prior = this.consumed.get(hs.idempotencyKey);
    if (prior?.executorAttempted) return { ...prior, duplicate: true };
    const running = this.inFlight.get(hs.idempotencyKey);
    if (running) return { ...(await running), duplicate: true };

    const now = this.clock();
    if (hs.status === 'READY' && !(now < Date.parse(hs.expiresAt))) {
      this.setStatus(s, 'EXPIRED', 'HANDOFF_SESSION_EXPIRED', now);
      ctx.emit?.('BOOKING_HANDOFF_EXPIRED', BookingHandoffSessionService.audit(hs));
    }
    const v = this.validator.validate(s, hs, now);
    if (!v.ok) return { ok: false, code: v.code, detail: v.detail, handoffSessionId, executorAttempted: false };
    if (prior) return { ...prior, duplicate: true };                       // same disabled outcome, recorded once

    const p = this.runConsume(s, hs, ctx);
    this.inFlight.set(hs.idempotencyKey, p);
    try { return await p; } finally { this.inFlight.delete(hs.idempotencyKey); }
  }

  private async runConsume(s: BookingSession, hs: BookingHandoffSession, ctx: HandoffEventCtx): Promise<ConsumeHandoffOutcome> {
    const record = (o: ConsumeHandoffOutcome): ConsumeHandoffOutcome => {
      this.consumed.set(hs.idempotencyKey, o);
      hs.lastConsumeResult = { code: o.code, status: o.executionStatus, reason: o.detail, at: new Date(this.clock()).toISOString() };
      return o;
    };
    // capability: must be present + valid on the session AND match the currently resolved adapter
    if (!isValidCapability(hs.executorCapability)) return { ok: false, code: 'EXECUTOR_UNAVAILABLE', detail: 'capability missing', handoffSessionId: hs.handoffSessionId, executorAttempted: false };
    const res = this.registry.resolve(this.config);
    ctx.emit?.('BOOKING_HANDOFF_EXECUTION_REQUESTED', { ...BookingHandoffSessionService.audit(hs), executorName: res.capability.executorName });
    if (!res.ok) return record({ ok: false, code: res.code, detail: res.capability.reason, handoffSessionId: hs.handoffSessionId, executorAttempted: false, capability: res.capability });
    if (res.capability.executorName !== hs.executorCapability.executorName || res.capability.enabled !== hs.executorCapability.enabled) {
      return record({ ok: false, code: 'EXECUTOR_UNAVAILABLE', detail: 'executor capability changed since handoff creation', handoffSessionId: hs.handoffSessionId, executorAttempted: false, capability: res.capability });
    }
    if (res.capability.enabled !== true) {
      // fail closed: a disabled adapter is never invoked
      ctx.emit?.('BOOKING_EXECUTION_DISABLED', { ...BookingHandoffSessionService.audit(hs), executorName: res.capability.executorName, reason: 'EXECUTOR_DISABLED' });
      return record({ ok: false, code: 'BOOKING_EXECUTION_DISABLED', detail: 'EXECUTOR_DISABLED', handoffSessionId: hs.handoffSessionId, executionStatus: 'DISABLED', executorAttempted: false, capability: res.capability });
    }
    // Only reachable with TEST adapters in a test registry (production cannot register enabled adapters).
    hs.executionAttempts++;
    let raw: BookingExecutionResult | undefined;
    try { raw = await res.adapter.execute(Object.freeze({ ...hs })); } catch { raw = undefined; }
    const versionOk = s.sessionVersion === hs.sessionVersion && s.handoffSession === hs && hs.status === 'READY';
    const status = !versionOk || !raw || !BOOKING_EXECUTION_STATUSES.includes(raw.status) || (res.adapter.kind !== 'REAL' && !NON_EXECUTING_STATUSES.has(raw.status)) ? 'FAILED' : raw.status;
    if (status === 'FAILED') {
      this.setStatus(s, 'FAILED', versionOk ? 'UNTRUSTED_OR_FAILED_EXECUTOR_RESULT' : 'SESSION_VERSION_CONFLICT', this.clock());
      return record({ ok: false, code: versionOk ? 'BOOKING_EXECUTION_DISABLED' : 'SESSION_VERSION_CONFLICT', detail: 'UNTRUSTED_EXECUTOR_RESULT', handoffSessionId: hs.handoffSessionId, executionStatus: 'FAILED', executorAttempted: true, capability: res.capability });
    }
    return record({ ok: false, code: 'BOOKING_EXECUTION_DISABLED', detail: raw!.status, handoffSessionId: hs.handoffSessionId, executionStatus: status, executorAttempted: true, capability: res.capability });
  }
}
