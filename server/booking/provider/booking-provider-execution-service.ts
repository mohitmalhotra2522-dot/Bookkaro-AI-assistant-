/**
 * BookingProviderExecutionService — the ONLY path from a validated handoff to a booking provider.
 * Owned by BookingExecutionGateway (gateway.executeBooking). Never an LLM tool.
 *
 *   lock(sessionId+handoffId) → existing record? (duplicate / status check, never resubmit)
 *   → BookingHandoffValidator (14 checks: confirmation, review/session versions, freshness,
 *     passengers, readiness, sensitive data) → registry.resolve (no fallback)
 *   → capability + real health check (UNKNOWN fails closed) → re-validate
 *   → REQUESTED → mark handoff session CONSUMED → IN_PROGRESS → provider.executeBooking (timeout)
 *   → strict schema validation → lifecycle transition ONLY from the provider result.
 *
 * Prompt 13: every status change goes through BookingExecutionLifecycleManager (validated
 * transitions, immutable record + events). Timeout / lost connection / invalid response →
 * UNKNOWN (never FAILED) → bounded reconciliation via the provider status API → else
 * MANUAL_VERIFICATION_REQUIRED. A submitted request is NEVER re-submitted automatically.
 *
 * With the production registry (disabled provider) the provider is never invoked and
 * IRCTC_HANDOFF_READY stays final. Nothing here can mark a booking CONFIRMED or create
 * a PNR locally — both come only from a schema-valid provider response.
 */
import { BookingState } from '@shared/states';
import type { BookingSession } from '@shared/entities';
import type { HandoffErrorCode } from '@shared/booking-handoff-session';
import type {
  BookingExecutionOutcomeCode, BookingExecutionRecord, BookingExecutionRecordStatus, BookingProviderCapabilities,
  BookingProviderLogRecord, ProviderHealth
} from '@shared/booking-provider';
import type { ConversationStateManager } from '../../ai/state/conversation-state';
import { BookingHandoffValidator } from '../handoff/booking-handoff-validator';
import { markHandoffSessionSubmitted } from '../handoff/booking-handoff-session-service';
import { checkNoSensitiveData } from '../handoff/sensitive-data-guard';
import type { BookingProvider, ProviderCallOptions } from './booking-provider';
import { callWithTimeout } from './call-with-timeout';
import { BookingExecutionLifecycleStatus as L, UNRESOLVED_EXECUTION } from '@shared/booking-execution-lifecycle';
import { BookingExecutionLifecycleManager } from '../lifecycle/booking-execution-lifecycle-manager';
import { BookingStatusReconciliationService, type ReconcileResult } from '../lifecycle/booking-status-reconciliation-service';
import { normalizeReconciliationConfig, type ReconciliationConfig } from '../lifecycle/reconciliation-config';
import { bookingExecutionHistory } from '../lifecycle/booking-execution-history';
import { BookingProviderRegistry, createProductionBookingProviderRegistry } from './booking-provider-registry';
import { DEFAULT_BOOKING_PROVIDER_CONFIG, type BookingProviderConfig } from './booking-provider-config';
import { validateHealth, validateProviderResult } from './provider-response-schema';
import { normalizeProviderError } from './provider-error-normalizer';
import { buildBookingProviderRequest } from './booking-provider-request';

// ---- user-facing messages (derived ONLY from the normalized record / lifecycle status) ----
export const EXECUTION_DISABLED_MESSAGE = 'Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.';
export const PROVIDER_UNAVAILABLE_MESSAGE = 'Booking details verify ho gaye hain. Automatic booking provider abhi available nahi hai.';
export const EXTERNAL_HANDOFF_MESSAGE = 'Booking details ready hain aur external booking handoff required hai. Booking handoff ready hai, lekin automatic booking provider available nahi hai.';
export const PROVIDER_CONFIRMED_MESSAGE = 'Booking provider ne booking confirm ki hai.';
export const PROVIDER_FAILED_MESSAGE = 'Booking provider ne booking reject/fail ki hai. Ticket book nahi hua.';
export const PROVIDER_NOT_REACHED_MESSAGE = 'Booking request provider tak nahi pahunchi — koi booking nahi hui. Automatic booking provider abhi available nahi hai.';
export const PROVIDER_CANCELLED_MESSAGE = 'Booking provider ke hisaab se ye booking cancelled hai.';
export const IN_PROGRESS_MESSAGE = 'Booking abhi process ho rahi hai — provider ne abhi final status nahi diya. Confirm hone par hi PNR milega.';
export const STATUS_UNKNOWN_MESSAGE = 'Booking attempt ka final status abhi verify nahi hua hai. Duplicate booking se bachne ke liye request dobara nahi bheji jayegi.';
export const MANUAL_VERIFICATION_MESSAGE = 'Booking attempt ka final status abhi verify nahi hua hai. Duplicate booking se bachne ke liye pehle provider se status verify karna zaroori hai.';
export const UNSAFE_RETRY_MESSAGE = 'Previous booking attempt ka final status verify nahi hua hai. Duplicate booking avoid karne ke liye pehle status verify karna zaroori hai.';
export const ALREADY_CONFIRMED_MESSAGE = 'Ye booking authoritative provider result ke hisaab se pehle hi confirm ho chuki hai — dobara booking request nahi bheji jayegi.';
export const ALREADY_ACTIVE_MESSAGE = 'Booking abhi process ho rahi hai — dobara request nahi bheji jayegi.';
export const ALREADY_FAILED_MESSAGE = 'Pichhli booking attempt provider ne fail ki thi — wahi request dobara nahi bheji jayegi. Nayi koshish ke liye "phir se book karo" bolein; fresh availability/fare aur naya confirmation zaroori hoga.';
export const VOICE_INTERRUPTION_MESSAGE = 'Booking request provider ke paas process ho rahi ho sakti hai; local voice interruption se booking automatically cancel nahi hoti.';
export const SUBMITTING_MESSAGE = 'Booking abhi process ho rahi hai — kripya wait karein.';
export const HANDOFF_INVALID_MESSAGE = 'Booking handoff ab valid nahi hai — kripya details dobara review karke confirm karein.';

const NOT_REACHED = new Set(['PROVIDER_UNAVAILABLE', 'PROVIDER_RATE_LIMITED']);

export function messageForRecord(r: Pick<BookingExecutionRecord, 'status' | 'pnr' | 'code'> & { failureCode?: string | null; submitted?: boolean }): string {
  switch (r.status) {
    case 'NOT_STARTED': return r.code === 'BOOKING_EXECUTION_DISABLED' ? EXECUTION_DISABLED_MESSAGE : PROVIDER_UNAVAILABLE_MESSAGE;
    case 'REQUIRES_EXTERNAL_HANDOFF': return EXTERNAL_HANDOFF_MESSAGE;
    case 'CONFIRMED': return `${PROVIDER_CONFIRMED_MESSAGE} ${r.pnr ? `PNR: ${r.pnr}.` : 'PNR provider ne abhi nahi diya.'}`;
    case 'FAILED': return r.code === 'BOOKING_PROVIDER_UNAVAILABLE' && NOT_REACHED.has(r.failureCode || '') ? PROVIDER_NOT_REACHED_MESSAGE : PROVIDER_FAILED_MESSAGE;
    case 'CANCELLED': return PROVIDER_CANCELLED_MESSAGE;
    case 'REQUESTED': case 'IN_PROGRESS': return IN_PROGRESS_MESSAGE;
    case 'MANUAL_VERIFICATION_REQUIRED': return MANUAL_VERIFICATION_MESSAGE;
    case 'UNKNOWN': default: return STATUS_UNKNOWN_MESSAGE;
  }
}

/** True when no booking request reached any provider (safe to say "ticket not booked"). */
export const NOTHING_SUBMITTED = (r?: BookingExecutionRecord) => !r || !r.submitted;

export interface ProviderExecutionContext {
  requestId: string;
  turnId: string;
  source: 'CONFIRM' | 'DUPLICATE_CONFIRM' | 'API' | 'STATUS_CHECK' | 'TURN';
  emit?: (type: any, data?: Record<string, any>) => void;
}

export interface ProviderExecutionOutcome {
  code: BookingExecutionOutcomeCode | HandoffErrorCode;
  record?: Readonly<BookingExecutionRecord>;
  duplicate: boolean;
  providerCalled: boolean;
  retryBlocked: boolean;
  manualVerificationRequired: boolean;
  message: string;
  detail?: string;
}

/** Safe view for the frontend / API / LLM: status, safe reference, authoritative PNR only. */
export interface BookingExecutionView {
  bookingExecutionId: string;
  providerName: string;
  status: BookingExecutionRecordStatus;
  code: string;
  providerStatus?: string;
  providerReference?: string;
  pnr?: string;
  failureCode?: string;
  submitted: boolean;
  retryBlocked: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastCheckedAt: string | null;
  attemptCount: number;
  reconciliationAttempts: number;
  /** Outcome not yet established — status verification possible / required. */
  unresolved: boolean;
  manualVerificationRequired: boolean;
  updatedAt: string;
}

export function bookingExecutionView(r?: BookingExecutionRecord): BookingExecutionView | undefined {
  if (!r) return undefined;
  return {
    bookingExecutionId: r.bookingExecutionId, providerName: r.providerName, status: r.status, code: r.code,
    ...(r.providerStatus ? { providerStatus: r.providerStatus } : {}),
    ...(r.providerReference ? { providerReference: r.providerReference } : {}),
    ...(r.status === 'CONFIRMED' && r.pnr ? { pnr: r.pnr } : {}),
    ...(r.failureCode ? { failureCode: r.failureCode } : {}),
    submitted: r.submitted, retryBlocked: r.retryBlocked,
    createdAt: r.createdAt, startedAt: r.startedAt, completedAt: r.completedAt, lastCheckedAt: r.lastCheckedAt,
    attemptCount: r.attemptCount, reconciliationAttempts: r.reconciliationAttempts,
    unresolved: UNRESOLVED_EXECUTION.has(r.status), manualVerificationRequired: r.status === 'MANUAL_VERIFICATION_REQUIRED',
    updatedAt: r.updatedAt
  };
}

export interface ProviderExecutionServiceOptions {
  registry?: BookingProviderRegistry;
  config?: BookingProviderConfig;
  clock?: () => number;
  /** Prompt 13: bounded reconciliation config (deterministic) + injectable sleep for tests. */
  reconciliation?: Partial<ReconciliationConfig>;
  sleep?: (ms: number) => Promise<void>;
}

export class BookingProviderExecutionService {
  readonly registry: BookingProviderRegistry;
  readonly config: BookingProviderConfig;
  readonly lifecycle: BookingExecutionLifecycleManager;
  readonly reconciliation: BookingStatusReconciliationService;
  readonly reconciliationConfig: ReconciliationConfig;
  private readonly clock: () => number;
  private readonly validator = new BookingHandoffValidator();
  private readonly locks = new Set<string>();
  private readonly logs: BookingProviderLogRecord[] = [];

  constructor(private readonly state: ConversationStateManager, opts: ProviderExecutionServiceOptions = {}) {
    this.registry = opts.registry || createProductionBookingProviderRegistry();
    this.config = opts.config || { ...DEFAULT_BOOKING_PROVIDER_CONFIG, configErrors: [] };
    this.clock = opts.clock || (() => Date.now());
    this.reconciliationConfig = normalizeReconciliationConfig(opts.reconciliation);
    this.lifecycle = new BookingExecutionLifecycleManager(state, this.clock);
    this.reconciliation = new BookingStatusReconciliationService(this.lifecycle, { config: this.reconciliationConfig, sleep: opts.sleep, clock: this.clock });
  }

  /** Static provider status (no I/O, no live health check). */
  providerStatus(): { configured: string; effective: string; enabled: boolean; resolved: boolean; code?: string; capabilities: Readonly<BookingProviderCapabilities> } {
    const r = this.registry.resolve(this.config);
    return r.ok
      ? { configured: r.configured, effective: r.effective, enabled: !r.masterSwitchOff, resolved: true, capabilities: r.capabilities }
      : { configured: r.configured, effective: r.effective, enabled: this.config.enabled, resolved: false, code: r.code, capabilities: r.capabilities };
  }

  executionLog(sessionId?: string): BookingProviderLogRecord[] {
    return sessionId ? this.logs.filter(l => l.sessionId === sessionId) : [...this.logs];
  }

  lifecycleLog(sessionId?: string) { return this.lifecycle.lifecycleLog(sessionId); }

  history(sessionId: string) { return bookingExecutionHistory(this.state.getSession(sessionId)); }

  isLocked(sessionId: string, handoffId: string): boolean { return this.locks.has(`${sessionId}:${handoffId}`); }

  /** Lazy TTL enforcement (called on turns / API reads — there is no background polling). */
  refreshStaleness(sessionId: string, ctx: ProviderExecutionContext): boolean {
    const s = this.state.getSession(sessionId);
    const r = s.bookingExecution;
    if (!r || this.isLocked(sessionId, r.handoffId)) return false;
    return this.lifecycle.enforceTtl(s, this.reconciliationConfig.unresolvedTtlMs, ctx);
  }

  async execute(sessionId: string, ctx: ProviderExecutionContext): Promise<ProviderExecutionOutcome> {
    const t0 = this.clock();
    const s = this.state.getSession(sessionId);
    const handoffId = s.handoff?.snapshot.handoffId;
    if (!handoffId) {
      return this.finish(s, ctx, t0, { code: 'HANDOFF_NOT_FOUND', duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: HANDOFF_INVALID_MESSAGE }, 'none');
    }
    const key = `${sessionId}:${handoffId}`;
    if (this.locks.has(key)) {
      // concurrent request (double tap / voice+text / network retry / duplicate LLM action) → existing state
      const rec = this.currentRecord(s, handoffId);
      return this.finish(s, ctx, t0, { code: 'EXECUTION_LOCKED', record: rec, duplicate: true, providerCalled: false, retryBlocked: true, manualVerificationRequired: false, message: rec ? messageForRecord(rec) : SUBMITTING_MESSAGE }, rec?.providerName || 'pending');
    }
    this.locks.add(key);                                  // set synchronously — before any await
    try {
      this.lifecycle.enforceTtl(s, this.reconciliationConfig.unresolvedTtlMs, ctx);
      return await this.run(s, handoffId, ctx, t0);
    } finally { this.locks.delete(key); }
  }

  /**
   * Explicit status verification (user "status check karo" / API). Never submits a booking.
   * The only path out of MANUAL_VERIFICATION_REQUIRED.
   */
  async reconcile(sessionId: string, ctx: ProviderExecutionContext): Promise<ProviderExecutionOutcome> {
    const t0 = this.clock();
    const s = this.state.getSession(sessionId);
    const rec = s.bookingExecution;
    if (!rec) return this.finish(s, ctx, t0, { code: 'RECONCILIATION_UNAVAILABLE', duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: 'Abhi koi booking attempt nahi hai jiska status verify karna ho.' }, 'none');
    const key = `${sessionId}:${rec.handoffId}`;
    if (this.locks.has(key)) return this.finish(s, ctx, t0, { code: 'EXECUTION_LOCKED', record: rec, duplicate: true, providerCalled: false, retryBlocked: true, manualVerificationRequired: false, message: messageForRecord(rec) }, rec.providerName);
    this.locks.add(key);
    try {
      this.lifecycle.enforceTtl(s, this.reconciliationConfig.unresolvedTtlMs, ctx);
      const cur = s.bookingExecution!;
      if (!UNRESOLVED_EXECUTION.has(cur.status) || cur.status === L.REQUESTED) {
        return this.finish(s, ctx, t0, { code: cur.code, record: cur, duplicate: false, providerCalled: false, retryBlocked: cur.retryBlocked, manualVerificationRequired: false, message: messageForRecord(cur) }, cur.providerName);
      }
      const rr = await this.runReconciliation(s, ctx, true);
      return this.reconciled(s, ctx, t0, rr, false);
    } finally { this.locks.delete(key); }
  }

  // --------------------------------------------------------------------------

  private async run(s: BookingSession, handoffId: string, ctx: ProviderExecutionContext, t0: number): Promise<ProviderExecutionOutcome> {
    const existing = this.currentRecord(s, handoffId);
    if (existing) return this.handleExisting(s, existing, ctx, t0);

    // 1) authoritative handoff validation (fail closed)
    const v = this.validator.validate(s, s.handoffSession, this.clock());
    if (!v.ok) return this.finish(s, ctx, t0, { code: v.code, duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: HANDOFF_INVALID_MESSAGE, detail: v.detail }, 'none');
    if (s.bookingState !== BookingState.IRCTC_HANDOFF_READY) {
      return this.finish(s, ctx, t0, { code: 'BOOKING_EXECUTION_FAILED', duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: HANDOFF_INVALID_MESSAGE, detail: `state ${s.bookingState}` }, 'none');
    }

    // 2) provider resolution — deterministic, no fallback
    const res = this.registry.resolve(this.config);
    ctx.emit?.('BOOKING_PROVIDER_SELECTED', { configured: res.configured, effective: res.effective, providerName: res.capabilities.providerName, available: res.capabilities.available, health: res.capabilities.health });
    if (!res.ok) return this.notStarted(s, handoffId, ctx, t0, res.capabilities.providerName === 'none' ? res.configured : res.capabilities.providerName, res.code);
    if (res.masterSwitchOff) return this.notStarted(s, handoffId, ctx, t0, res.provider.name, 'BOOKING_EXECUTION_DISABLED');
    if (res.provider.kind === 'DISABLED') return this.notStarted(s, handoffId, ctx, t0, res.provider.name, 'BOOKING_PROVIDER_DISABLED');
    const p = res.provider, cap = res.capabilities;
    if (!cap.available) return this.notStarted(s, handoffId, ctx, t0, p.name, 'BOOKING_PROVIDER_UNAVAILABLE');
    if (!cap.supportsBooking) {
      if (!cap.requiresExternalHandoff) return this.notStarted(s, handoffId, ctx, t0, p.name, 'BOOKING_PROVIDER_UNAVAILABLE');
      // capability-only external handoff: REQUESTED → REQUIRES_EXTERNAL_HANDOFF, nothing sent
      this.lifecycle.create(s, { handoffId, requestId: ctx.requestId, providerName: p.name, code: 'BOOKING_REQUIRES_EXTERNAL_HANDOFF' });
      this.lifecycle.transition(s, L.REQUESTED, 'BOOKING_EXECUTION_REQUESTED', ctx, { data: { providerCalled: false } });
      const r2 = this.lifecycle.transition(s, L.REQUIRES_EXTERNAL_HANDOFF, 'BOOKING_REQUIRES_EXTERNAL_HANDOFF', ctx, { patch: { completedAt: this.iso() }, data: { providerCalled: false } });
      return this.finish(s, ctx, t0, { code: 'BOOKING_REQUIRES_EXTERNAL_HANDOFF', record: r2.record, duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: EXTERNAL_HANDOFF_MESSAGE }, p.name);
    }

    // 3) health — on demand only (no polling); UNKNOWN fails closed; never assumed healthy
    let health: ProviderHealth = cap.health;
    if (p.checkHealth) {
      try { health = validateHealth(await this.withTimeout(o => p.checkHealth!(o))); } catch { health = 'UNKNOWN'; }
    }
    if (health !== 'AVAILABLE') return this.notStarted(s, handoffId, ctx, t0, p.name, 'BOOKING_PROVIDER_UNAVAILABLE', health === 'UNKNOWN' ? 'PROVIDER_HEALTH_UNKNOWN' : 'PROVIDER_UNAVAILABLE');

    // 4) re-validate after the await (nothing may have changed meanwhile)
    const v2 = this.validator.validate(s, s.handoffSession, this.clock());
    if (!v2.ok || s.bookingState !== BookingState.IRCTC_HANDOFF_READY || this.currentRecord(s, handoffId)) {
      return this.finish(s, ctx, t0, { code: v2.ok ? 'BOOKING_EXECUTION_FAILED' : v2.code, duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: HANDOFF_INVALID_MESSAGE }, p.name);
    }

    // 5) request — from the handoff snapshot only; idempotency key only if supported
    const req = buildBookingProviderRequest(s, ctx.requestId, { includeIdempotencyKey: cap.supportsIdempotency });
    if (!req) return this.finish(s, ctx, t0, { code: 'BOOKING_EXECUTION_FAILED', duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: HANDOFF_INVALID_MESSAGE }, p.name);
    const sens = checkNoSensitiveData(req);
    if (!sens.ok) return this.finish(s, ctx, t0, { code: 'SENSITIVE_DATA_REJECTED', duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: HANDOFF_INVALID_MESSAGE }, p.name);

    // 6) submission boundary — REQUESTED → consume handoff → IN_PROGRESS, all BEFORE the call
    const rec0 = this.lifecycle.create(s, { handoffId, requestId: ctx.requestId, providerName: p.name, code: 'BOOKING_IN_PROGRESS' });
    this.lifecycle.transition(s, L.REQUESTED, 'BOOKING_EXECUTION_REQUESTED', ctx, { data: { idempotencyKeySent: cap.supportsIdempotency } });
    markHandoffSessionSubmitted(s, rec0.bookingExecutionId, this.clock());
    this.lifecycle.transition(s, L.IN_PROGRESS, 'BOOKING_EXECUTION_STARTED', ctx, {
      patch: { submitted: true, retryBlocked: true, attemptCount: 1, startedAt: this.iso(), code: 'BOOKING_IN_PROGRESS' },
      data: { idempotencyKeySent: cap.supportsIdempotency }
    });

    let raw: unknown, err: unknown;
    const tc = this.clock();
    try { raw = await this.withTimeout(o => p.executeBooking(req, o)); } catch (e) { err = e; }
    const latencyMs = this.clock() - tc;
    const id = rec0.bookingExecutionId;

    if (err !== undefined) {
      const n = normalizeProviderError(err);
      ctx.emit?.('BOOKING_PROVIDER_RESPONSE_RECEIVED', { bookingExecutionId: id, ok: false, failureCode: n.failureCode, latencyMs });
      if (n.failureCode === 'PROVIDER_TIMEOUT') {
        // a timeout NEVER means failed — the provider may have processed the request
        this.lifecycle.note(s, 'BOOKING_PROVIDER_TIMEOUT', ctx, { latencyMs, data: { failureCode: 'PROVIDER_TIMEOUT' } });
        return this.toUnknown(s, p, cap, ctx, t0, 'PROVIDER_TIMEOUT', 'BOOKING_STATUS_UNKNOWN', latencyMs);
      }
      if (n.definitelyNotSubmitted) {
        const unavailable = !(n.failureCode === 'PROVIDER_AUTH_FAILED' || n.failureCode === 'PROVIDER_VALIDATION_FAILED' || n.failureCode === 'PROVIDER_REJECTED');
        return this.final(s, ctx, t0, L.FAILED, unavailable ? 'BOOKING_PROVIDER_UNAVAILABLE' : 'BOOKING_PROVIDER_FAILED', n.code, { failureCode: n.failureCode }, latencyMs);
      }
      // 5xx / connection reset / unknown error after a possible send → UNKNOWN (never FAILED)
      return this.toUnknown(s, p, cap, ctx, t0, n.failureCode, 'BOOKING_STATUS_UNKNOWN', latencyMs);
    }

    const vr = validateProviderResult(raw);
    if (!vr.ok) {
      ctx.emit?.('BOOKING_PROVIDER_RESPONSE_RECEIVED', { bookingExecutionId: id, ok: false, failureCode: 'INVALID_PROVIDER_RESPONSE', latencyMs });
      return this.toUnknown(s, p, cap, ctx, t0, 'INVALID_PROVIDER_RESPONSE', 'INVALID_PROVIDER_RESPONSE', latencyMs);
    }
    const r = vr.value;
    ctx.emit?.('BOOKING_PROVIDER_RESPONSE_RECEIVED', { bookingExecutionId: id, ok: true, providerStatus: r.status, latencyMs });
    const ref = r.providerReference ?? null;
    switch (r.status) {
      case 'CONFIRMED':
        return this.final(s, ctx, t0, L.CONFIRMED, 'BOOKING_PROVIDER_CONFIRMED', 'BOOKING_CONFIRMED', { providerStatus: 'CONFIRMED', providerReference: ref, pnr: r.pnr ?? null, failureCode: null }, latencyMs);
      case 'FAILED':
        return this.final(s, ctx, t0, L.FAILED, 'BOOKING_PROVIDER_FAILED', 'BOOKING_PROVIDER_REJECTED', { providerStatus: 'FAILED', providerReference: ref, failureCode: r.failureCode || 'PROVIDER_REJECTED' }, latencyMs);
      case 'ACCEPTED': case 'IN_PROGRESS': {
        const rec = this.lifecycle.note(s, 'BOOKING_PROVIDER_ACCEPTED', ctx, { latencyMs, patch: { providerStatus: r.status, providerReference: ref, code: r.status === 'ACCEPTED' ? 'BOOKING_ACCEPTED' : 'BOOKING_IN_PROGRESS' }, data: { providerStatus: r.status, referenceProvided: !!ref } });
        return this.finish(s, ctx, t0, { code: rec.code, record: rec, duplicate: false, providerCalled: true, retryBlocked: true, manualVerificationRequired: false, message: messageForRecord(rec) }, rec.providerName);
      }
      case 'REQUIRES_EXTERNAL_HANDOFF':
        return this.final(s, ctx, t0, L.REQUIRES_EXTERNAL_HANDOFF, 'BOOKING_REQUIRES_EXTERNAL_HANDOFF', 'BOOKING_REQUIRES_EXTERNAL_HANDOFF', { providerStatus: r.status, providerReference: ref, failureCode: r.failureCode ?? null }, latencyMs);
      case 'UNAVAILABLE': default:
        // provider explicitly answered "unavailable" → it did not book
        return this.final(s, ctx, t0, L.FAILED, 'BOOKING_PROVIDER_UNAVAILABLE', 'BOOKING_PROVIDER_UNAVAILABLE', { providerStatus: 'UNAVAILABLE', providerReference: ref, failureCode: r.failureCode || 'PROVIDER_UNAVAILABLE' }, latencyMs);
    }
  }

  /** A record already exists for this handoff → never a second submission. */
  private async handleExisting(s: BookingSession, rec: BookingExecutionRecord, ctx: ProviderExecutionContext, t0: number): Promise<ProviderExecutionOutcome> {
    const base = { record: rec, duplicate: true, providerCalled: false, retryBlocked: true };
    switch (rec.status) {
      case L.CONFIRMED:
        return this.finish(s, ctx, t0, { ...base, code: 'EXECUTION_ALREADY_CONFIRMED', manualVerificationRequired: false, message: `${ALREADY_CONFIRMED_MESSAGE} ${rec.pnr ? `PNR: ${rec.pnr}.` : ''}`.trim() }, rec.providerName);
      case L.FAILED: case L.CANCELLED:
        return this.finish(s, ctx, t0, { ...base, code: 'EXECUTION_ALREADY_FAILED', manualVerificationRequired: false, message: `${messageForRecord(rec)} ${ALREADY_FAILED_MESSAGE}` }, rec.providerName);
      case L.MANUAL_VERIFICATION_REQUIRED:
        return this.finish(s, ctx, t0, { ...base, code: 'MANUAL_VERIFICATION_REQUIRED', manualVerificationRequired: true, message: UNSAFE_RETRY_MESSAGE, detail: 'MANUAL_PROVIDER_VERIFICATION_REQUIRED' }, rec.providerName);
      case L.UNKNOWN: case L.IN_PROGRESS: case L.REQUESTED: {
        if (rec.status === L.REQUESTED) return this.finish(s, ctx, t0, { ...base, code: 'EXECUTION_ALREADY_ACTIVE', manualVerificationRequired: false, message: ALREADY_ACTIVE_MESSAGE }, rec.providerName);
        // status check only (bounded); unresolved → UNSAFE_RETRY / ALREADY_ACTIVE
        const wasUnknown = rec.status === L.UNKNOWN;
        const rr = await this.runReconciliation(s, ctx, false);
        const cur = s.bookingExecution!;
        if (rr.resolved) return this.reconciled(s, ctx, t0, rr, true);
        if (cur.status === L.IN_PROGRESS) return this.finish(s, ctx, t0, { ...base, record: cur, providerCalled: rr.providerCalled, code: 'EXECUTION_ALREADY_ACTIVE', manualVerificationRequired: false, message: ALREADY_ACTIVE_MESSAGE }, cur.providerName);
        return this.finish(s, ctx, t0, { ...base, record: cur, providerCalled: rr.providerCalled, code: 'UNSAFE_RETRY', manualVerificationRequired: cur.status === L.MANUAL_VERIFICATION_REQUIRED || wasUnknown, message: UNSAFE_RETRY_MESSAGE, detail: cur.status === L.MANUAL_VERIFICATION_REQUIRED ? 'MANUAL_PROVIDER_VERIFICATION_REQUIRED' : undefined }, cur.providerName);
      }
      case L.NOT_STARTED: case L.REQUIRES_EXTERNAL_HANDOFF: default:
        return this.finish(s, ctx, t0, { ...base, code: 'BOOKING_EXECUTION_DUPLICATE', retryBlocked: rec.retryBlocked, manualVerificationRequired: false, message: messageForRecord(rec) }, rec.providerName);
    }
  }

  /** Uncertain outcome → UNKNOWN (never FAILED) → bounded reconciliation → else manual verification. */
  private async toUnknown(s: BookingSession, p: BookingProvider, cap: Readonly<BookingProviderCapabilities>, ctx: ProviderExecutionContext, t0: number, failureCode: string, code: BookingExecutionOutcomeCode, latencyMs: number): Promise<ProviderExecutionOutcome> {
    this.lifecycle.transition(s, L.UNKNOWN, 'BOOKING_EXECUTION_UNKNOWN', ctx, { latencyMs, patch: { failureCode, code, retryBlocked: true }, data: { failureCode } });
    const rr = await this.reconciliation.reconcile(s, p, cap, ctx, { explicit: false });
    if (rr.resolved || s.bookingExecution!.status === L.IN_PROGRESS) return this.reconciled(s, ctx, t0, rr, false);
    const rec = s.bookingExecution!;
    const manual = rec.status === L.MANUAL_VERIFICATION_REQUIRED;
    return this.finish(s, ctx, t0, {
      code, record: rec, duplicate: false, providerCalled: true, retryBlocked: true, manualVerificationRequired: manual,
      message: manual ? MANUAL_VERIFICATION_MESSAGE : STATUS_UNKNOWN_MESSAGE,
      detail: manual ? 'MANUAL_PROVIDER_VERIFICATION_REQUIRED' : rr.code
    }, rec.providerName);
  }

  private async runReconciliation(s: BookingSession, ctx: ProviderExecutionContext, explicit: boolean): Promise<ReconcileResult> {
    const rec = s.bookingExecution!;
    const res = this.registry.resolve(this.config);
    const p = res.ok && res.provider.name === rec.providerName ? res.provider : undefined;
    return this.reconciliation.reconcile(s, p, p && res.ok ? res.capabilities : undefined, ctx, { explicit });
  }

  private reconciled(s: BookingSession, ctx: ProviderExecutionContext, t0: number, rr: ReconcileResult, duplicate: boolean): ProviderExecutionOutcome {
    const rec = s.bookingExecution!;
    const manual = rec.status === L.MANUAL_VERIFICATION_REQUIRED;
    const code: ProviderExecutionOutcome['code'] = rr.resolved || rec.status === L.IN_PROGRESS ? rec.code
      : rr.code === 'RESOLVED' || rr.code === 'STILL_IN_PROGRESS' || rr.code === 'NOT_REQUIRED' ? rec.code : rr.code;
    return this.finish(s, ctx, t0, {
      code, record: rec, duplicate, providerCalled: rr.providerCalled, retryBlocked: true, manualVerificationRequired: manual,
      message: messageForRecord(rec), ...(rec.status === L.CONFIRMED && !rec.pnr ? { detail: 'PNR_NOT_AVAILABLE' } : manual ? { detail: 'MANUAL_PROVIDER_VERIFICATION_REQUIRED' } : {})
    }, rec.providerName);
  }

  // ---- result application (state changes ONLY from a provider result) ----

  private final(s: BookingSession, ctx: ProviderExecutionContext, t0: number, to: L, event: Parameters<BookingExecutionLifecycleManager['transition']>[2], code: BookingExecutionOutcomeCode, patch: Partial<BookingExecutionRecord>, latencyMs: number): ProviderExecutionOutcome {
    const r = this.lifecycle.transition(s, to, event, ctx, { latencyMs, patch: { ...patch, code, retryBlocked: true, completedAt: this.iso() }, data: { ...(patch.failureCode ? { failureCode: patch.failureCode } : {}) } });
    const rec = r.record;
    if (!r.ok) return this.finish(s, ctx, t0, { code: 'INVALID_EXECUTION_TRANSITION', record: rec, duplicate: false, providerCalled: true, retryBlocked: true, manualVerificationRequired: true, message: MANUAL_VERIFICATION_MESSAGE }, rec.providerName);
    return this.finish(s, ctx, t0, {
      code, record: rec, duplicate: false, providerCalled: true, retryBlocked: true, manualVerificationRequired: false, message: messageForRecord(rec),
      ...(to === L.CONFIRMED && !rec.pnr ? { detail: 'PNR_NOT_AVAILABLE' } : {})
    }, rec.providerName);
  }

  /** Provider not invoked at all (disabled / unknown / unavailable). Record NOT_STARTED; state unchanged. */
  private notStarted(s: BookingSession, handoffId: string, ctx: ProviderExecutionContext, t0: number, providerName: string, code: BookingExecutionOutcomeCode, failureCode?: string): ProviderExecutionOutcome {
    const rec = this.lifecycle.create(s, { handoffId, requestId: ctx.requestId, providerName, code, failureCode: failureCode ?? null });
    ctx.emit?.('BOOKING_PROVIDER_UNAVAILABLE', { providerName, code, providerCalled: false, ...(failureCode ? { failureCode } : {}) });
    return this.finish(s, ctx, t0, { code, record: rec, duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: messageForRecord(rec) }, providerName);
  }

  // ---- helpers ----

  private iso() { return new Date(this.clock()).toISOString(); }

  private currentRecord(s: BookingSession, handoffId: string): Readonly<BookingExecutionRecord> | undefined {
    return s.bookingExecution && s.bookingExecution.handoffId === handoffId ? s.bookingExecution : undefined;
  }

  private withTimeout<T>(fn: (o: ProviderCallOptions) => Promise<T>): Promise<T> {
    return callWithTimeout(fn, this.config.timeoutMs);
  }

  private finish(s: BookingSession, ctx: ProviderExecutionContext, t0: number, out: ProviderExecutionOutcome, providerName: string): ProviderExecutionOutcome {
    const rec = out.record;
    this.logs.push({
      at: new Date(this.clock()).toISOString(), sessionId: s.sessionId, requestId: ctx.requestId, handoffId: rec?.handoffId ?? s.handoff?.snapshot.handoffId,
      executionId: rec?.bookingExecutionId, providerName, providerStatus: rec?.providerStatus, executionStatus: rec?.status,
      code: out.code, failureCode: rec?.failureCode ?? undefined, duplicate: out.duplicate || undefined, latencyMs: Math.max(0, this.clock() - t0)
    });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    return out;
  }
}
