/**
 * BookingExecutionLifecycleManager (Prompt 13) — the ONLY writer of BookingExecutionRecord
 * status. Every change:
 *   1. is validated against EXECUTION_STATUS_TRANSITIONS (else INVALID_EXECUTION_TRANSITION),
 *   2. produces a NEW frozen record (copy-on-write) with an appended BookingExecutionEvent,
 *   3. syncs the session BookingState through ConversationStateManager.applyProviderExecutionState
 *      (evidence-checked — CONFIRMED needs an authoritative CONFIRMED record),
 *   4. emits a session event + a PII-free lifecycle log line.
 * It never calls a provider; it never invents a status, reference or PNR.
 */
import { randomBytes } from 'node:crypto';
import { BookingState } from '@shared/states';
import type { BookingSession } from '@shared/entities';
import type { BookingExecutionOutcomeCode, BookingExecutionRecord } from '@shared/booking-provider';
import {
  BookingExecutionLifecycleStatus as L, canTransitionExecution,
  type BookingExecutionEvent, type BookingExecutionEventType, type BookingExecutionLifecycleStatus, type BookingLifecycleLogRecord
} from '@shared/booking-execution-lifecycle';
import type { ConversationStateManager } from '../../ai/state/conversation-state';
import { transitionLifecycle } from '../execution/booking-lifecycle';

export interface LifecycleCtx {
  requestId: string;
  turnId?: string;
  emit?: (type: any, data?: Record<string, any>) => void;
}

export interface LifecycleChange {
  patch?: Partial<Omit<BookingExecutionRecord, 'bookingExecutionId' | 'sessionId' | 'events' | 'status'>>;
  data?: Record<string, string | number | boolean | null>;
  latencyMs?: number;
  reconciliationAttempt?: number;
}

export type LifecycleResult =
  | { ok: true; record: Readonly<BookingExecutionRecord> }
  | { ok: false; code: 'INVALID_EXECUTION_TRANSITION'; record: Readonly<BookingExecutionRecord>; message: string };

/** Lifecycle status → session BookingState (null = leave the session state unchanged). */
export function sessionStateFor(status: BookingExecutionLifecycleStatus): BookingState | null {
  switch (status) {
    case L.REQUESTED: return BookingState.BOOKING_EXECUTION_REQUESTED;
    case L.IN_PROGRESS: return BookingState.BOOKING_IN_PROGRESS;
    case L.CONFIRMED: return BookingState.BOOKING_CONFIRMED;
    case L.FAILED: case L.CANCELLED: return BookingState.BOOKING_FAILED;
    case L.UNKNOWN: case L.MANUAL_VERIFICATION_REQUIRED: return BookingState.BOOKING_STATUS_UNKNOWN;
    case L.REQUIRES_EXTERNAL_HANDOFF: return BookingState.IRCTC_HANDOFF_READY;
    case L.NOT_STARTED: default: return null;
  }
}

const SAFE_DATA_KEY = /^(attempt|reason|failureCode|providerStatus|latencyMs|idempotencyKeySent|pnrProvided|referenceProvided|providerCalled|source|explicit|maxAttempts)$/;

export class BookingExecutionLifecycleManager {
  private readonly logs: BookingLifecycleLogRecord[] = [];

  constructor(private readonly state: ConversationStateManager, private readonly clock: () => number = () => Date.now()) {}

  private iso() { return new Date(this.clock()).toISOString(); }

  /** New NOT_STARTED record for a handoff (the previous record moves to history, unchanged). */
  create(s: BookingSession, init: { handoffId: string; requestId: string; providerName: string; code: BookingExecutionOutcomeCode; failureCode?: string | null }): Readonly<BookingExecutionRecord> {
    const at = this.iso();
    if (s.bookingExecution) {
      (s.bookingExecutionHistory ||= []).push(s.bookingExecution);
      if (s.bookingExecutionHistory.length > 20) s.bookingExecutionHistory.splice(0, s.bookingExecutionHistory.length - 20);
    }
    const rec: BookingExecutionRecord = Object.freeze({
      bookingExecutionId: 'bx_' + randomBytes(12).toString('hex'),
      sessionId: s.sessionId,
      handoffId: init.handoffId,
      handoffSessionId: s.handoffSession?.handoffSessionId || '',
      requestId: init.requestId,
      idempotencyKey: s.handoffSession?.idempotencyKey || '',
      providerName: init.providerName,
      status: L.NOT_STARTED,
      code: init.code,
      providerReference: null,
      pnr: null,
      failureCode: init.failureCode ?? null,
      submitted: false,
      retryBlocked: false,
      createdAt: at, startedAt: null, completedAt: null, lastCheckedAt: null,
      attemptCount: 0, reconciliationAttempts: 0,
      events: Object.freeze([]) as readonly BookingExecutionEvent[],
      updatedAt: at
    });
    s.bookingExecution = rec;
    return rec;
  }

  /** Validated status transition with an audit event. Invalid → record unchanged + INVALID_EXECUTION_TRANSITION. */
  transition(s: BookingSession, to: BookingExecutionLifecycleStatus, event: BookingExecutionEventType, ctx: LifecycleCtx, ch: LifecycleChange = {}): LifecycleResult {
    const cur = s.bookingExecution;
    if (!cur) throw new Error('no execution record');
    if (!canTransitionExecution(cur.status, to)) {
      this.log(cur, cur.status, cur.status, event, ctx, { ...ch, data: { reason: 'INVALID_EXECUTION_TRANSITION' } }, 'INVALID_EXECUTION_TRANSITION');
      return { ok: false, code: 'INVALID_EXECUTION_TRANSITION', record: cur, message: `Execution transition ${cur.status} → ${to} is not allowed.` };
    }
    const rec = this.write(s, cur, to, event, ch);
    this.syncSession(s, rec);
    this.log(rec, cur.status, to, event, ctx, ch);
    ctx.emit?.(event, this.eventData(rec, cur.status, ch));
    return { ok: true, record: rec };
  }

  /** Audit event without a status change (ACCEPTED / TIMEOUT / STATUS_CHECK_REQUESTED / RECONCILED). */
  note(s: BookingSession, event: BookingExecutionEventType, ctx: LifecycleCtx, ch: LifecycleChange = {}): Readonly<BookingExecutionRecord> {
    const cur = s.bookingExecution!;
    const rec = this.write(s, cur, cur.status, event, ch);
    this.log(rec, cur.status, cur.status, event, ctx, ch);
    ctx.emit?.(event, this.eventData(rec, cur.status, ch));
    return rec;
  }

  /**
   * Lazy TTL check (no polling): an unresolved record older than ttlMs becomes
   * MANUAL_VERIFICATION_REQUIRED (IN_PROGRESS → UNKNOWN → MANUAL). Returns true if changed.
   */
  enforceTtl(s: BookingSession, ttlMs: number, ctx: LifecycleCtx): boolean {
    const r = s.bookingExecution;
    if (!r || (r.status !== L.IN_PROGRESS && r.status !== L.UNKNOWN)) return false;
    const since = Date.parse(r.startedAt || r.createdAt);
    if (!(this.clock() - since > ttlMs)) return false;
    if (r.status === L.IN_PROGRESS) this.transition(s, L.UNKNOWN, 'BOOKING_EXECUTION_UNKNOWN', ctx, { data: { reason: 'UNRESOLVED_TTL_EXCEEDED' } });
    this.transition(s, L.MANUAL_VERIFICATION_REQUIRED, 'BOOKING_MANUAL_VERIFICATION_REQUIRED', ctx, { data: { reason: 'UNRESOLVED_TTL_EXCEEDED' } });
    return true;
  }

  /**
   * Explicit retry after an AUTHORITATIVE failure: BOOKING_FAILED → target (passengers),
   * validated by the state manager (requires a FAILED / CANCELLED record).
   */
  leaveFailedForRetry(s: BookingSession, target: BookingState.PASSENGERS_READY | BookingState.COLLECTING_PASSENGER_DETAILS): boolean {
    const r = s.bookingExecution;
    if (!r || (r.status !== L.FAILED && r.status !== L.CANCELLED) || s.bookingState !== BookingState.BOOKING_FAILED) return false;
    const chk = this.state.applyProviderExecutionState(s.sessionId, target, { bookingExecutionId: r.bookingExecutionId, providerName: r.providerName, providerStatus: r.providerStatus });
    return chk.ok;
  }

  lifecycleLog(sessionId?: string): BookingLifecycleLogRecord[] {
    return sessionId ? this.logs.filter(l => l.sessionId === sessionId) : [...this.logs];
  }

  // ---------------------------------------------------------------------------

  private write(s: BookingSession, cur: BookingExecutionRecord, to: BookingExecutionLifecycleStatus, type: BookingExecutionEventType, ch: LifecycleChange): Readonly<BookingExecutionRecord> {
    const at = this.iso();
    const ev: BookingExecutionEvent = Object.freeze({
      eventId: 'bxe_' + randomBytes(8).toString('hex'), executionId: cur.bookingExecutionId, type,
      previousStatus: cur.status, newStatus: to, at,
      ...(ch.data ? { data: Object.freeze(this.safeData(ch.data)) } : {})
    });
    const next: BookingExecutionRecord = Object.freeze({
      ...cur, ...(ch.patch || {}), status: to,
      // CONFIRMED is the only status that may carry a PNR
      pnr: to === L.CONFIRMED ? (ch.patch?.pnr ?? cur.pnr ?? null) : null,
      events: Object.freeze([...cur.events, ev]),
      updatedAt: at
    });
    s.bookingExecution = next;
    return next;
  }

  private syncSession(s: BookingSession, rec: BookingExecutionRecord) {
    const target = sessionStateFor(rec.status);
    const at = rec.updatedAt;
    if (target && s.bookingState !== target) {
      this.state.applyProviderExecutionState(s.sessionId, target, { bookingExecutionId: rec.bookingExecutionId, providerName: rec.providerName, providerStatus: rec.status === L.CONFIRMED ? 'CONFIRMED' : rec.providerStatus });
    }
    // coarse P10 booking lifecycle (provider path only)
    if (rec.status === L.REQUESTED) transitionLifecycle(s, 'EXECUTION_STARTED', 'BOOKING_PROVIDER_SUBMISSION', at, { providerAuthorized: true });
    else if (rec.status === L.CONFIRMED) transitionLifecycle(s, 'EXECUTION_SUCCESS', 'PROVIDER_CONFIRMED', at, { providerAuthorized: true });
    else if (rec.status === L.FAILED || rec.status === L.CANCELLED || rec.status === L.REQUIRES_EXTERNAL_HANDOFF) transitionLifecycle(s, 'EXECUTION_FAILED', `PROVIDER_${rec.status}`, at, { providerAuthorized: true });
  }

  private safeData(d: Record<string, string | number | boolean | null>) {
    const o: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(d)) if (SAFE_DATA_KEY.test(k) && v !== undefined) o[k] = typeof v === 'string' ? v.slice(0, 80) : v;
    return o;
  }

  private eventData(rec: BookingExecutionRecord, previousStatus: BookingExecutionLifecycleStatus, ch: LifecycleChange): Record<string, any> {
    return {
      bookingExecutionId: rec.bookingExecutionId, providerName: rec.providerName, previousStatus, newStatus: rec.status,
      ...(rec.failureCode ? { failureCode: rec.failureCode } : {}),
      ...(rec.providerStatus ? { providerStatus: rec.providerStatus } : {}),
      ...(rec.status === L.CONFIRMED ? { pnrProvided: !!rec.pnr } : {}),
      ...(ch.reconciliationAttempt ? { reconciliationAttempt: ch.reconciliationAttempt } : {}),
      ...(ch.data ? this.safeData(ch.data) : {})
    };
  }

  private log(rec: BookingExecutionRecord, prev: BookingExecutionLifecycleStatus, next: BookingExecutionLifecycleStatus, event: BookingExecutionEventType, ctx: LifecycleCtx, ch: LifecycleChange, failure?: string) {
    this.logs.push({
      at: this.iso(), sessionId: rec.sessionId, requestId: ctx.requestId, handoffId: rec.handoffId, executionId: rec.bookingExecutionId,
      providerName: rec.providerName, previousStatus: prev, newStatus: next, event, latencyMs: Math.max(0, ch.latencyMs ?? 0),
      failureCode: failure ?? rec.failureCode ?? null, reconciliationAttempt: ch.reconciliationAttempt ?? null
    });
    if (this.logs.length > 1000) this.logs.splice(0, this.logs.length - 1000);
  }
}
