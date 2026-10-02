/**
 * BookingProviderExecutionService — the ONLY path from a validated handoff to a booking provider.
 * Owned by BookingExecutionGateway (gateway.executeBooking). Never an LLM tool.
 *
 *   lock(sessionId+handoffId) → existing record? (duplicate / status check, never resubmit)
 *   → BookingHandoffValidator (14 checks: confirmation, review/session versions, freshness,
 *     passengers, readiness, sensitive data) → registry.resolve (no fallback)
 *   → capability + real health check (UNKNOWN fails closed) → re-validate
 *   → mark handoff session CONSUMED → BOOKING_EXECUTION_REQUESTED → provider.executeBooking (timeout)
 *   → strict schema validation → normalized record → state ONLY from the provider result.
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
  BookingProviderLogRecord, BookingStatusResult, ProviderHealth
} from '@shared/booking-provider';
import type { ConversationStateManager } from '../../ai/state/conversation-state';
import { BookingHandoffValidator } from '../handoff/booking-handoff-validator';
import { markHandoffSessionSubmitted } from '../handoff/booking-handoff-session-service';
import { checkNoSensitiveData } from '../handoff/sensitive-data-guard';
import { transitionLifecycle } from '../execution/booking-lifecycle';
import type { BookingProvider, ProviderCallOptions } from './booking-provider';
import { ProviderTimeoutError } from './booking-provider';
import { BookingProviderRegistry, createProductionBookingProviderRegistry } from './booking-provider-registry';
import { DEFAULT_BOOKING_PROVIDER_CONFIG, type BookingProviderConfig } from './booking-provider-config';
import { validateHealth, validateProviderResult, validateStatusResult } from './provider-response-schema';
import { normalizeProviderError } from './provider-error-normalizer';
import { buildBookingProviderRequest } from './booking-provider-request';
import { randomBytes } from 'node:crypto';

// ---- user-facing messages (derived ONLY from the normalized record) ----
export const EXECUTION_DISABLED_MESSAGE = 'Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.';
export const PROVIDER_UNAVAILABLE_MESSAGE = 'Booking details verify ho gaye hain. Automatic booking provider abhi available nahi hai.';
export const EXTERNAL_HANDOFF_MESSAGE = 'Booking details ready hain aur external booking handoff required hai. Booking handoff ready hai, lekin automatic booking provider available nahi hai.';
export const PROVIDER_CONFIRMED_MESSAGE = 'Booking provider ne booking confirm ki hai.';
export const PROVIDER_FAILED_MESSAGE = 'Booking provider ne booking reject kar di hai. Ticket book nahi hua.';
export const PROVIDER_CANCELLED_MESSAGE = 'Booking provider ke hisaab se ye booking cancelled hai.';
export const PROVIDER_PENDING_MESSAGE = 'Booking request provider ke paas pending hai — abhi confirm nahi hui. Confirm hone par hi PNR milega.';
export const STATUS_UNKNOWN_MESSAGE = 'Booking status abhi confirm nahi ho paaya. Duplicate booking se bachne ke liye request dobara nahi bheji jayegi — provider se status verify karna hoga.';
export const SUBMITTING_MESSAGE = 'Booking request abhi process ho rahi hai — kripya wait karein.';
export const HANDOFF_INVALID_MESSAGE = 'Booking handoff ab valid nahi hai — kripya details dobara review karke confirm karein.';

export function messageForRecord(r: Pick<BookingExecutionRecord, 'status' | 'pnr' | 'code'>): string {
  switch (r.status) {
    case 'DISABLED': return r.code === 'BOOKING_EXECUTION_DISABLED' ? EXECUTION_DISABLED_MESSAGE : PROVIDER_UNAVAILABLE_MESSAGE;
    case 'UNAVAILABLE': return PROVIDER_UNAVAILABLE_MESSAGE;
    case 'REQUIRES_EXTERNAL_HANDOFF': return EXTERNAL_HANDOFF_MESSAGE;
    case 'CONFIRMED': return `${PROVIDER_CONFIRMED_MESSAGE} ${r.pnr ? `PNR: ${r.pnr}.` : 'PNR provider ne abhi nahi diya.'}`;
    case 'FAILED': return PROVIDER_FAILED_MESSAGE;
    case 'CANCELLED': return PROVIDER_CANCELLED_MESSAGE;
    case 'ACCEPTED': case 'IN_PROGRESS': return PROVIDER_PENDING_MESSAGE;
    case 'SUBMITTING': return SUBMITTING_MESSAGE;
    case 'UNKNOWN': default: return STATUS_UNKNOWN_MESSAGE;
  }
}

/** True when no booking request reached any provider (safe to say "ticket not booked"). */
export const NOTHING_SUBMITTED = (r?: BookingExecutionRecord) => !r || !r.submitted;

export interface ProviderExecutionContext {
  requestId: string;
  turnId: string;
  source: 'CONFIRM' | 'DUPLICATE_CONFIRM' | 'API';
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
    submitted: r.submitted, retryBlocked: r.retryBlocked, updatedAt: r.updatedAt
  };
}

export interface ProviderExecutionServiceOptions {
  registry?: BookingProviderRegistry;
  config?: BookingProviderConfig;
  clock?: () => number;
}

const UNCERTAIN: ReadonlySet<BookingExecutionRecordStatus> = new Set(['UNKNOWN', 'ACCEPTED', 'IN_PROGRESS', 'SUBMITTING']);

export class BookingProviderExecutionService {
  readonly registry: BookingProviderRegistry;
  readonly config: BookingProviderConfig;
  private readonly clock: () => number;
  private readonly validator = new BookingHandoffValidator();
  private readonly locks = new Set<string>();
  private readonly logs: BookingProviderLogRecord[] = [];

  constructor(private readonly state: ConversationStateManager, opts: ProviderExecutionServiceOptions = {}) {
    this.registry = opts.registry || createProductionBookingProviderRegistry();
    this.config = opts.config || { ...DEFAULT_BOOKING_PROVIDER_CONFIG, configErrors: [] };
    this.clock = opts.clock || (() => Date.now());
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

  isLocked(sessionId: string, handoffId: string): boolean { return this.locks.has(`${sessionId}:${handoffId}`); }

  async execute(sessionId: string, ctx: ProviderExecutionContext): Promise<ProviderExecutionOutcome> {
    const t0 = this.clock();
    const s = this.state.getSession(sessionId);
    const handoffId = s.handoff?.snapshot.handoffId;
    if (!handoffId) {
      return this.finish(s, ctx, t0, { code: 'HANDOFF_NOT_FOUND', duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: HANDOFF_INVALID_MESSAGE }, 'none');
    }
    const key = `${sessionId}:${handoffId}`;
    if (this.locks.has(key)) {
      // concurrent request (double tap / voice+text / network retry / duplicate LLM action)
      const rec = this.currentRecord(s, handoffId);
      return this.finish(s, ctx, t0, { code: 'BOOKING_EXECUTION_LOCKED', record: rec, duplicate: true, providerCalled: false, retryBlocked: true, manualVerificationRequired: false, message: rec ? messageForRecord(rec) : SUBMITTING_MESSAGE }, rec?.providerName || 'pending');
    }
    this.locks.add(key);                                  // set synchronously — before any await
    try { return await this.run(s, handoffId, ctx, t0); }
    finally { this.locks.delete(key); }
  }

  // --------------------------------------------------------------------------

  private async run(s: BookingSession, handoffId: string, ctx: ProviderExecutionContext, t0: number): Promise<ProviderExecutionOutcome> {
    const existing = this.currentRecord(s, handoffId);
    if (existing) {
      if (UNCERTAIN.has(existing.status)) return this.recheck(s, existing, ctx, t0);
      return this.finish(s, ctx, t0, { code: 'BOOKING_EXECUTION_DUPLICATE', record: existing, duplicate: true, providerCalled: false, retryBlocked: existing.retryBlocked, manualVerificationRequired: false, message: messageForRecord(existing) }, existing.providerName);
    }

    // 1) authoritative handoff validation (fail closed)
    const v = this.validator.validate(s, s.handoffSession, this.clock());
    if (!v.ok) return this.finish(s, ctx, t0, { code: v.code, duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: HANDOFF_INVALID_MESSAGE, detail: v.detail }, 'none');
    if (s.bookingState !== BookingState.IRCTC_HANDOFF_READY) {
      return this.finish(s, ctx, t0, { code: 'BOOKING_EXECUTION_FAILED', duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: HANDOFF_INVALID_MESSAGE, detail: `state ${s.bookingState}` }, 'none');
    }

    // 2) provider resolution — deterministic, no fallback
    const res = this.registry.resolve(this.config);
    ctx.emit?.('BOOKING_PROVIDER_SELECTED', { configured: res.configured, effective: res.effective, providerName: res.capabilities.providerName, available: res.capabilities.available, health: res.capabilities.health });
    if (!res.ok) return this.notSubmitted(s, handoffId, ctx, t0, res.capabilities.providerName === 'none' ? res.configured : res.capabilities.providerName, 'UNAVAILABLE', res.code);
    if (res.masterSwitchOff) return this.notSubmitted(s, handoffId, ctx, t0, res.provider.name, 'DISABLED', 'BOOKING_EXECUTION_DISABLED');
    if (res.provider.kind === 'DISABLED') return this.notSubmitted(s, handoffId, ctx, t0, res.provider.name, 'DISABLED', 'BOOKING_PROVIDER_DISABLED');
    const p = res.provider, cap = res.capabilities;
    if (!cap.available) return this.notSubmitted(s, handoffId, ctx, t0, p.name, 'UNAVAILABLE', 'BOOKING_PROVIDER_UNAVAILABLE');
    if (!cap.supportsBooking) {
      return cap.requiresExternalHandoff
        ? this.notSubmitted(s, handoffId, ctx, t0, p.name, 'REQUIRES_EXTERNAL_HANDOFF', 'BOOKING_REQUIRES_EXTERNAL_HANDOFF')
        : this.notSubmitted(s, handoffId, ctx, t0, p.name, 'UNAVAILABLE', 'BOOKING_PROVIDER_UNAVAILABLE');
    }

    // 3) health — on demand only (no polling); UNKNOWN fails closed; never assumed healthy
    let health: ProviderHealth = cap.health;
    if (p.checkHealth) {
      try { health = validateHealth(await this.withTimeout(o => p.checkHealth!(o))); } catch { health = 'UNKNOWN'; }
    }
    if (health !== 'AVAILABLE') return this.notSubmitted(s, handoffId, ctx, t0, p.name, 'UNAVAILABLE', 'BOOKING_PROVIDER_UNAVAILABLE', health === 'UNKNOWN' ? 'PROVIDER_HEALTH_UNKNOWN' : 'PROVIDER_UNAVAILABLE');

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

    // 6) submission boundary — record + consume handoff + BOOKING_EXECUTION_REQUESTED BEFORE the call
    const rec = this.newRecord(s, handoffId, ctx, p.name, 'SUBMITTING', 'BOOKING_EXECUTION_LOCKED');
    rec.submitted = true; rec.retryBlocked = true;
    markHandoffSessionSubmitted(s, rec.bookingExecutionId, this.clock());
    this.moveState(s, BookingState.BOOKING_EXECUTION_REQUESTED, rec);
    transitionLifecycle(s, 'EXECUTION_STARTED', 'BOOKING_PROVIDER_SUBMISSION', new Date(this.clock()).toISOString(), { providerAuthorized: true });
    ctx.emit?.('BOOKING_EXECUTION_STARTED', { bookingExecutionId: rec.bookingExecutionId, providerName: p.name, handoffId, idempotencyKeySent: cap.supportsIdempotency });

    let raw: unknown, err: unknown;
    const tc = this.clock();
    try { raw = await this.withTimeout(o => p.executeBooking(req, o)); } catch (e) { err = e; }
    const providerLatency = this.clock() - tc;

    if (err !== undefined) {
      const n = normalizeProviderError(err);
      ctx.emit?.('BOOKING_PROVIDER_RESPONSE_RECEIVED', { bookingExecutionId: rec.bookingExecutionId, ok: false, failureCode: n.failureCode, latencyMs: providerLatency });
      if (n.definitelyNotSubmitted) {
        if (n.failureCode === 'PROVIDER_AUTH_FAILED' || n.failureCode === 'PROVIDER_VALIDATION_FAILED' || n.failureCode === 'PROVIDER_REJECTED') {
          return this.applyFinal(s, rec, ctx, t0, 'FAILED', n.code, { failureCode: n.failureCode });
        }
        return this.applyBackToHandoff(s, rec, ctx, t0, 'UNAVAILABLE', n.code, n.failureCode);
      }
      return this.uncertain(s, rec, p, cap, ctx, t0, n.failureCode, n.code === 'BOOKING_PROVIDER_TIMEOUT' ? 'BOOKING_STATUS_UNKNOWN' : n.code);
    }

    const vr = validateProviderResult(raw);
    if (!vr.ok) {
      ctx.emit?.('BOOKING_PROVIDER_RESPONSE_RECEIVED', { bookingExecutionId: rec.bookingExecutionId, ok: false, failureCode: 'INVALID_PROVIDER_RESPONSE', latencyMs: providerLatency });
      return this.uncertain(s, rec, p, cap, ctx, t0, 'INVALID_PROVIDER_RESPONSE', 'INVALID_PROVIDER_RESPONSE');
    }
    const r = vr.value;
    ctx.emit?.('BOOKING_PROVIDER_RESPONSE_RECEIVED', { bookingExecutionId: rec.bookingExecutionId, ok: true, providerStatus: r.status, latencyMs: providerLatency });
    rec.providerStatus = r.status;
    if (r.providerReference) rec.providerReference = r.providerReference;
    switch (r.status) {
      case 'CONFIRMED': return this.applyFinal(s, rec, ctx, t0, 'CONFIRMED', 'BOOKING_CONFIRMED', { pnr: r.pnr });
      case 'FAILED': return this.applyFinal(s, rec, ctx, t0, 'FAILED', 'BOOKING_PROVIDER_REJECTED', { failureCode: r.failureCode || 'PROVIDER_REJECTED' });
      case 'ACCEPTED': case 'IN_PROGRESS': return this.applyPending(s, rec, ctx, t0, r.status, r.status === 'ACCEPTED' ? 'BOOKING_ACCEPTED' : 'BOOKING_IN_PROGRESS');
      case 'REQUIRES_EXTERNAL_HANDOFF': return this.applyBackToHandoff(s, rec, ctx, t0, 'REQUIRES_EXTERNAL_HANDOFF', 'BOOKING_REQUIRES_EXTERNAL_HANDOFF', r.failureCode);
      case 'UNAVAILABLE': default: return this.applyBackToHandoff(s, rec, ctx, t0, 'UNAVAILABLE', 'BOOKING_PROVIDER_UNAVAILABLE', r.failureCode || 'PROVIDER_UNAVAILABLE');
    }
  }

  /** Existing uncertain record → status check only (never a second submission). */
  private async recheck(s: BookingSession, rec: BookingExecutionRecord, ctx: ProviderExecutionContext, t0: number): Promise<ProviderExecutionOutcome> {
    const res = this.registry.resolve(this.config);
    const p = res.ok && res.provider.name === rec.providerName ? res.provider : undefined;
    if (p && res.ok && res.capabilities.supportsStatus && p.getBookingStatus) {
      return this.statusCheck(s, rec, p, res.capabilities, ctx, t0, true);
    }
    const unknown = rec.status === 'UNKNOWN';
    return this.finish(s, ctx, t0, {
      code: unknown ? 'BOOKING_RETRY_BLOCKED' : 'BOOKING_EXECUTION_DUPLICATE', record: rec, duplicate: true, providerCalled: false,
      retryBlocked: true, manualVerificationRequired: unknown, message: messageForRecord(rec), detail: unknown ? 'MANUAL_PROVIDER_VERIFICATION_REQUIRED' : undefined
    }, rec.providerName);
  }

  private async uncertain(s: BookingSession, rec: BookingExecutionRecord, p: BookingProvider, cap: Readonly<BookingProviderCapabilities>, ctx: ProviderExecutionContext, t0: number, failureCode: string, code: BookingExecutionOutcomeCode): Promise<ProviderExecutionOutcome> {
    rec.status = 'UNKNOWN'; rec.code = code; rec.failureCode = failureCode; rec.retryBlocked = true; this.touch(rec);
    ctx.emit?.('BOOKING_STATUS_UNKNOWN', { bookingExecutionId: rec.bookingExecutionId, failureCode });
    if (cap.supportsStatus && p.getBookingStatus) return this.statusCheck(s, rec, p, cap, ctx, t0, false);
    return this.finish(s, ctx, t0, { code: code === 'INVALID_PROVIDER_RESPONSE' ? code : 'BOOKING_STATUS_UNKNOWN', record: rec, duplicate: false, providerCalled: true, retryBlocked: true, manualVerificationRequired: true, message: STATUS_UNKNOWN_MESSAGE, detail: 'MANUAL_PROVIDER_VERIFICATION_REQUIRED' }, p.name);
  }

  /** One authoritative status lookup (no polling). */
  private async statusCheck(s: BookingSession, rec: BookingExecutionRecord, p: BookingProvider, cap: Readonly<BookingProviderCapabilities>, ctx: ProviderExecutionContext, t0: number, duplicate: boolean): Promise<ProviderExecutionOutcome> {
    const ref = rec.providerReference ?? (cap.supportsIdempotency ? s.handoffSession?.idempotencyKey : undefined);
    let st: BookingStatusResult | undefined;
    if (ref) {
      try {
        const raw = await this.withTimeout(o => p.getBookingStatus!(ref, o));
        const v = validateStatusResult(raw);
        if (v.ok) st = v.value;
      } catch { st = undefined; }
    }
    if (!st || st.status === 'UNKNOWN') {
      rec.status = 'UNKNOWN'; rec.retryBlocked = true; this.touch(rec);
      return this.finish(s, ctx, t0, { code: duplicate ? 'BOOKING_RETRY_BLOCKED' : 'BOOKING_STATUS_UNKNOWN', record: rec, duplicate, providerCalled: true, retryBlocked: true, manualVerificationRequired: true, message: STATUS_UNKNOWN_MESSAGE, detail: 'MANUAL_PROVIDER_VERIFICATION_REQUIRED' }, p.name);
    }
    ctx.emit?.('BOOKING_PROVIDER_RESPONSE_RECEIVED', { bookingExecutionId: rec.bookingExecutionId, ok: true, providerStatus: st.status, statusCheck: true });
    rec.providerStatus = st.status;
    if (st.providerReference) rec.providerReference = st.providerReference;
    switch (st.status) {
      case 'CONFIRMED': return this.applyFinal(s, rec, ctx, t0, 'CONFIRMED', 'BOOKING_CONFIRMED', { pnr: st.pnr }, duplicate);
      case 'FAILED': return this.applyFinal(s, rec, ctx, t0, 'FAILED', 'BOOKING_PROVIDER_REJECTED', { failureCode: st.failureCode || 'PROVIDER_REJECTED' }, duplicate);
      case 'CANCELLED': return this.applyFinal(s, rec, ctx, t0, 'CANCELLED', 'BOOKING_CANCELLED', { failureCode: st.failureCode }, duplicate);
      case 'PENDING': case 'IN_PROGRESS': default: return this.applyPending(s, rec, ctx, t0, 'IN_PROGRESS', 'BOOKING_IN_PROGRESS', duplicate);
    }
  }

  // ---- result application (state changes ONLY from a provider result) ----

  private applyFinal(s: BookingSession, rec: BookingExecutionRecord, ctx: ProviderExecutionContext, t0: number, status: 'CONFIRMED' | 'FAILED' | 'CANCELLED', code: BookingExecutionOutcomeCode, extra: { pnr?: string; failureCode?: string }, duplicate = false): ProviderExecutionOutcome {
    rec.status = status; rec.code = code; rec.retryBlocked = true;
    if (status === 'CONFIRMED') {
      if (extra.pnr) rec.pnr = extra.pnr;                      // schema-validated provider PNR only
      rec.failureCode = undefined;
    } else {
      rec.pnr = undefined;
      rec.failureCode = extra.failureCode || rec.failureCode;
    }
    this.touch(rec);
    this.moveState(s, status === 'CONFIRMED' ? BookingState.BOOKING_CONFIRMED : BookingState.BOOKING_FAILED, rec);
    transitionLifecycle(s, status === 'CONFIRMED' ? 'EXECUTION_SUCCESS' : 'EXECUTION_FAILED', `PROVIDER_${status}`, rec.updatedAt, { providerAuthorized: true });
    ctx.emit?.(status === 'CONFIRMED' ? 'BOOKING_CONFIRMED' : 'BOOKING_FAILED', { bookingExecutionId: rec.bookingExecutionId, providerName: rec.providerName, providerStatus: rec.providerStatus, ...(rec.failureCode ? { failureCode: rec.failureCode } : {}), pnrProvided: !!rec.pnr });
    return this.finish(s, ctx, t0, { code, record: rec, duplicate, providerCalled: true, retryBlocked: true, manualVerificationRequired: false, message: messageForRecord(rec), ...(status === 'CONFIRMED' && !rec.pnr ? { detail: 'PNR_NOT_AVAILABLE' } : {}) }, rec.providerName);
  }

  private applyPending(s: BookingSession, rec: BookingExecutionRecord, ctx: ProviderExecutionContext, t0: number, status: 'ACCEPTED' | 'IN_PROGRESS', code: BookingExecutionOutcomeCode, duplicate = false): ProviderExecutionOutcome {
    rec.status = status; rec.code = code; rec.retryBlocked = true; rec.failureCode = undefined; this.touch(rec);
    this.moveState(s, BookingState.BOOKING_IN_PROGRESS, rec);
    return this.finish(s, ctx, t0, { code, record: rec, duplicate, providerCalled: true, retryBlocked: true, manualVerificationRequired: false, message: messageForRecord(rec) }, rec.providerName);
  }

  /** Provider definitely did not book (external handoff / unavailable) → back to IRCTC_HANDOFF_READY. Handoff stays consumed. */
  private applyBackToHandoff(s: BookingSession, rec: BookingExecutionRecord, ctx: ProviderExecutionContext, t0: number, status: 'UNAVAILABLE' | 'REQUIRES_EXTERNAL_HANDOFF', code: BookingExecutionOutcomeCode, failureCode?: string): ProviderExecutionOutcome {
    rec.status = status; rec.code = code; rec.failureCode = failureCode; rec.retryBlocked = true; this.touch(rec);
    this.moveState(s, BookingState.IRCTC_HANDOFF_READY, rec);
    transitionLifecycle(s, 'EXECUTION_FAILED', status, rec.updatedAt, { providerAuthorized: true });
    ctx.emit?.(status === 'REQUIRES_EXTERNAL_HANDOFF' ? 'BOOKING_REQUIRES_EXTERNAL_HANDOFF' : 'BOOKING_PROVIDER_UNAVAILABLE', { bookingExecutionId: rec.bookingExecutionId, providerName: rec.providerName, code, ...(failureCode ? { failureCode } : {}) });
    return this.finish(s, ctx, t0, { code, record: rec, duplicate: false, providerCalled: true, retryBlocked: true, manualVerificationRequired: false, message: messageForRecord(rec) }, rec.providerName);
  }

  /** Provider not invoked at all (disabled / unknown / unavailable / external-only). State unchanged. */
  private notSubmitted(s: BookingSession, handoffId: string, ctx: ProviderExecutionContext, t0: number, providerName: string, status: 'DISABLED' | 'UNAVAILABLE' | 'REQUIRES_EXTERNAL_HANDOFF', code: BookingExecutionOutcomeCode, failureCode?: string): ProviderExecutionOutcome {
    const rec = this.newRecord(s, handoffId, ctx, providerName, status, code);
    if (failureCode) rec.failureCode = failureCode;
    ctx.emit?.(status === 'REQUIRES_EXTERNAL_HANDOFF' ? 'BOOKING_REQUIRES_EXTERNAL_HANDOFF' : 'BOOKING_PROVIDER_UNAVAILABLE', { providerName, code, providerCalled: false, ...(failureCode ? { failureCode } : {}) });
    return this.finish(s, ctx, t0, { code, record: rec, duplicate: false, providerCalled: false, retryBlocked: false, manualVerificationRequired: false, message: messageForRecord(rec) }, providerName);
  }

  // ---- helpers ----

  private currentRecord(s: BookingSession, handoffId: string): BookingExecutionRecord | undefined {
    return s.bookingExecution && s.bookingExecution.handoffId === handoffId ? s.bookingExecution : undefined;
  }

  private newRecord(s: BookingSession, handoffId: string, ctx: ProviderExecutionContext, providerName: string, status: BookingExecutionRecordStatus, code: BookingExecutionOutcomeCode): BookingExecutionRecord {
    const at = new Date(this.clock()).toISOString();
    if (s.bookingExecution) {
      (s.bookingExecutionHistory ||= []).push(s.bookingExecution);
      if (s.bookingExecutionHistory.length > 20) s.bookingExecutionHistory.splice(0, s.bookingExecutionHistory.length - 20);
    }
    const rec: BookingExecutionRecord = {
      bookingExecutionId: 'bx_' + randomBytes(12).toString('hex'), sessionId: s.sessionId, handoffId,
      handoffSessionId: s.handoffSession?.handoffSessionId || '', requestId: ctx.requestId, providerName, status, code,
      submitted: false, retryBlocked: false, createdAt: at, updatedAt: at
    };
    s.bookingExecution = rec;
    return rec;
  }

  private touch(rec: BookingExecutionRecord) { rec.updatedAt = new Date(this.clock()).toISOString(); }

  private moveState(s: BookingSession, to: BookingState, rec: BookingExecutionRecord) {
    if (s.bookingState === to) return;
    this.state.applyProviderExecutionState(s.sessionId, to, { bookingExecutionId: rec.bookingExecutionId, providerName: rec.providerName, providerStatus: rec.providerStatus });
  }

  private withTimeout<T>(fn: (o: ProviderCallOptions) => Promise<T>): Promise<T> {
    const ac = new AbortController();
    const timeoutMs = this.config.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { ac.abort(); reject(new ProviderTimeoutError()); }, timeoutMs);
      Promise.resolve().then(() => fn({ signal: ac.signal, timeoutMs })).then(
        v => { clearTimeout(timer); resolve(v); },
        e => { clearTimeout(timer); reject(e); }
      );
    });
  }

  private finish(s: BookingSession, ctx: ProviderExecutionContext, t0: number, out: ProviderExecutionOutcome, providerName: string): ProviderExecutionOutcome {
    const rec = out.record;
    this.logs.push({
      at: new Date(this.clock()).toISOString(), sessionId: s.sessionId, requestId: ctx.requestId, handoffId: rec?.handoffId ?? s.handoff?.snapshot.handoffId,
      executionId: rec?.bookingExecutionId, providerName, providerStatus: rec?.providerStatus, executionStatus: rec?.status,
      code: out.code, failureCode: rec?.failureCode, duplicate: out.duplicate || undefined, latencyMs: Math.max(0, this.clock() - t0)
    });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    return { ...out, record: rec ? Object.freeze({ ...rec }) : undefined };
  }
}

