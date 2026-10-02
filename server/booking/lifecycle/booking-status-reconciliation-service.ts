/**
 * BookingStatusReconciliationService (Prompt 13).
 *
 * Resolves an UNKNOWN / IN_PROGRESS execution ONLY by asking the provider's status API
 * (getBookingStatus) — it NEVER re-submits a booking. Bounded: maxAttempts per run with
 * deterministic backoff and a per-attempt timeout; maxTotalAttempts per record; then
 * MANUAL_VERIFICATION_REQUIRED. No status API / no reference → MANUAL_VERIFICATION_REQUIRED
 * immediately (no retry). Statuses are applied only from schema-valid provider responses.
 */
import type { BookingSession } from '@shared/entities';
import type { BookingProviderCapabilities, BookingStatusResult } from '@shared/booking-provider';
import { BookingExecutionLifecycleStatus as L, type BookingLifecycleErrorCode } from '@shared/booking-execution-lifecycle';
import type { BookingProvider } from '../provider/booking-provider';
import { ProviderTimeoutError } from '../provider/booking-provider';
import { callWithTimeout } from '../provider/call-with-timeout';
import { validateStatusResult } from '../provider/provider-response-schema';
import type { BookingExecutionLifecycleManager, LifecycleCtx } from './booking-execution-lifecycle-manager';
import { backoffDelay, type ReconciliationConfig } from './reconciliation-config';

export type ReconcileCode = 'RESOLVED' | 'STILL_IN_PROGRESS' | 'NOT_REQUIRED' | BookingLifecycleErrorCode;

export interface ReconcileResult {
  code: ReconcileCode;
  /** The record reached an authoritative provider status (CONFIRMED / FAILED / CANCELLED). */
  resolved: boolean;
  /** Status checks performed in this run. */
  attempts: number;
  providerCalled: boolean;
}

export interface ReconciliationDeps {
  config: ReconciliationConfig;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

export class BookingStatusReconciliationService {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly lifecycle: BookingExecutionLifecycleManager, private readonly deps: ReconciliationDeps) {
    this.sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  }

  private now(): number { return (this.deps.clock || Date.now)(); }

  get config(): ReconciliationConfig { return this.deps.config; }

  /**
   * @param explicit true only for a user-requested status verification — the only way out
   *                 of MANUAL_VERIFICATION_REQUIRED.
   */
  async reconcile(s: BookingSession, provider: BookingProvider | undefined, cap: Readonly<BookingProviderCapabilities> | undefined, ctx: LifecycleCtx, opts: { explicit: boolean }): Promise<ReconcileResult> {
    const cfg = this.deps.config;
    let rec = s.bookingExecution;
    const none: ReconcileResult = { code: 'NOT_REQUIRED', resolved: false, attempts: 0, providerCalled: false };
    if (!rec || ![L.UNKNOWN, L.IN_PROGRESS, L.MANUAL_VERIFICATION_REQUIRED].includes(rec.status)) return none;
    if (rec.status === L.MANUAL_VERIFICATION_REQUIRED && !opts.explicit) return { ...none, code: 'MANUAL_VERIFICATION_REQUIRED' };

    // status API + a reference are required — otherwise manual verification (no retry)
    const usable = !!provider && provider.name === rec.providerName && !!cap?.supportsStatus && typeof provider.getBookingStatus === 'function';
    const ref = rec.providerReference ?? (cap?.supportsIdempotency && rec.idempotencyKey ? rec.idempotencyKey : null);
    if (!usable || !ref) {
      this.toManual(s, ctx, usable ? 'NO_STATUS_REFERENCE' : 'STATUS_API_UNAVAILABLE');
      return { ...none, code: 'RECONCILIATION_UNAVAILABLE' };
    }
    if (rec.reconciliationAttempts >= cfg.maxTotalAttempts) {
      this.toManual(s, ctx, 'RECONCILIATION_ATTEMPTS_EXHAUSTED');
      return { ...none, code: 'MANUAL_VERIFICATION_REQUIRED' };
    }

    let last: ReconcileCode = 'PROVIDER_STATUS_UNKNOWN';
    let attempts = 0;
    for (let i = 0; i < cfg.maxAttempts && s.bookingExecution!.reconciliationAttempts < cfg.maxTotalAttempts; i++) {
      const delay = backoffDelay(cfg, i);
      if (delay > 0) await this.sleep(delay);
      rec = s.bookingExecution!;
      const attempt = rec.reconciliationAttempts + 1;
      attempts++;
      const at = new Date(this.now()).toISOString();
      this.lifecycle.note(s, 'BOOKING_STATUS_CHECK_REQUESTED', ctx, {
        patch: { reconciliationAttempts: attempt, lastCheckedAt: at }, data: { attempt, maxAttempts: cfg.maxAttempts, explicit: opts.explicit }, reconciliationAttempt: attempt
      });
      let st: BookingStatusResult | undefined;
      const t0 = this.now();
      try {
        const v = validateStatusResult(await callWithTimeout(o => provider!.getBookingStatus!(ref, o), cfg.attemptTimeoutMs));
        if (v.ok) st = v.value; else last = 'RECONCILIATION_FAILED';
      } catch (e) {
        last = e instanceof ProviderTimeoutError ? 'RECONCILIATION_TIMEOUT' : 'RECONCILIATION_FAILED';
      }
      if (!st) continue;
      if (st.status === 'UNKNOWN') { last = 'PROVIDER_STATUS_UNKNOWN'; continue; }
      return this.apply(s, st, ctx, attempt, attempts, this.now() - t0);
    }

    // unresolved after this bounded run — NEVER resubmit
    rec = s.bookingExecution!;
    if (rec.reconciliationAttempts >= cfg.maxTotalAttempts) {
      this.toManual(s, ctx, 'RECONCILIATION_ATTEMPTS_EXHAUSTED');
      return { code: 'MANUAL_VERIFICATION_REQUIRED', resolved: false, attempts, providerCalled: true };
    }
    if (rec.status === L.MANUAL_VERIFICATION_REQUIRED) return { code: 'MANUAL_VERIFICATION_REQUIRED', resolved: false, attempts, providerCalled: true };
    return { code: rec.status === L.IN_PROGRESS ? 'STILL_IN_PROGRESS' : last, resolved: false, attempts, providerCalled: true };
  }

  private apply(s: BookingSession, st: BookingStatusResult, ctx: LifecycleCtx, attempt: number, attempts: number, latencyMs: number): ReconcileResult {
    const cur = s.bookingExecution!;
    const ref = st.providerReference ?? cur.providerReference;
    const now = new Date(this.now()).toISOString();
    const base = { reconciliationAttempt: attempt, latencyMs };
    if (st.status === 'PENDING' || st.status === 'IN_PROGRESS') {
      if (cur.status === L.IN_PROGRESS) this.lifecycle.note(s, 'BOOKING_STATUS_RECONCILED', ctx, { ...base, patch: { providerStatus: st.status, providerReference: ref }, data: { providerStatus: st.status } });
      else this.lifecycle.transition(s, L.IN_PROGRESS, 'BOOKING_STATUS_RECONCILED', ctx, { ...base, patch: { providerStatus: st.status, providerReference: ref, code: 'BOOKING_IN_PROGRESS', failureCode: null }, data: { providerStatus: st.status } });
      return { code: 'STILL_IN_PROGRESS', resolved: false, attempts, providerCalled: true };
    }
    this.lifecycle.note(s, 'BOOKING_STATUS_RECONCILED', ctx, { ...base, data: { providerStatus: st.status } });
    if (st.status === 'CONFIRMED') {
      this.lifecycle.transition(s, L.CONFIRMED, 'BOOKING_PROVIDER_CONFIRMED', ctx, { ...base, patch: { providerStatus: 'CONFIRMED', providerReference: ref, pnr: st.pnr ?? null, failureCode: null, code: 'BOOKING_CONFIRMED', completedAt: now } });
    } else if (st.status === 'FAILED') {
      this.lifecycle.transition(s, L.FAILED, 'BOOKING_PROVIDER_FAILED', ctx, { ...base, patch: { providerStatus: 'FAILED', providerReference: ref, failureCode: st.failureCode || 'PROVIDER_REJECTED', code: 'BOOKING_PROVIDER_REJECTED', completedAt: now } });
    } else {
      this.lifecycle.transition(s, L.CANCELLED, 'BOOKING_STATUS_RECONCILED', ctx, { ...base, patch: { providerStatus: 'CANCELLED', providerReference: ref, failureCode: st.failureCode || 'PROVIDER_CANCELLED', code: 'BOOKING_CANCELLED', completedAt: now } });
    }
    return { code: 'RESOLVED', resolved: true, attempts, providerCalled: true };
  }

  private toManual(s: BookingSession, ctx: LifecycleCtx, reason: string) {
    const r = s.bookingExecution!;
    if (r.status === L.MANUAL_VERIFICATION_REQUIRED) return;
    // IN_PROGRESS is a provider-acknowledged state — it is not downgraded by a missing status API
    if (r.status === L.IN_PROGRESS) return;
    this.lifecycle.transition(s, L.MANUAL_VERIFICATION_REQUIRED, 'BOOKING_MANUAL_VERIFICATION_REQUIRED', ctx, { data: { reason } });
  }
}
