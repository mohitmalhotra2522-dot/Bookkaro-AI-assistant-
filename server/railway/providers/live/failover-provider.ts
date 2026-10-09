/**
 * PROMPT 35 — Provider failover = PROVIDER NORMALIZATION, not agent decision-making.
 *
 * The LLM chose ONE tool. This provider executes THAT SAME tool down an ordered chain of live providers
 * (default RAILCORE → RAILKIT → RAILRADAR) and stops at the first usable answer:
 *
 *   DATA (success, well-formed)          → return it (served-by provider recorded)
 *   NO_RESULTS (valid empty / not found) → return it — a valid railway answer is NEVER "confirmed" elsewhere
 *   REJECTED (invalid request)           → return it — the LLM fixes the request; never blindly retried on another provider
 *   TIMEOUT / PROVIDER_FAILURE / MALFORMED_DATA / UNSUPPORTED / NOT_CONFIGURED → try the next provider that declares the capability
 *
 * It never calls a different tool, never adds a follow-up call, never caches, never mixes MOCK and LIVE (the chain holds
 * live adapters only), and never asks the LLM to re-word anything. Every attempt is recorded in meta.attempts.
 * The whole chain fits one budget so the runtime's own tool timeout is never the one that fires.
 */
import type { RailwayProvider } from '../railway-provider';
import type { RailwayResponse, ProviderAttempt, RailwayErrorCode } from '../../types/railway-types';
import type { LiveRailwayProvider } from './live-provider-base';
import { METHOD_CAPABILITY, type ProviderMethod } from './provider-capabilities';

export interface FailoverOptions {
  /** Upper bound for the whole chain (must stay below the runtime tool timeout). */
  budgetMs: number;
  /** Upper bound for one provider attempt. */
  perAttemptMs: number;
  /** 2026-10-09: optional per-capability order of provider ids (RAILWAY_AVAILABILITY_PROVIDERS → CHECK_AVAILABILITY /
   *  GET_FARE). A capability without an entry uses the constructor chain order. */
  capabilityOrder?: Readonly<Record<string, readonly string[]>>;
}

const NO_RESULT_CODES = new Set(['NO_TRAINS_FOUND', 'NOT_FOUND', 'CLASS_NOT_AVAILABLE', 'FARE_UNAVAILABLE', 'AVAILABILITY_UNAVAILABLE']);
const REJECT_CODES = new Set(['INVALID_REQUEST', 'MISSING_REQUIRED_FIELD', 'INVALID_ROUTE', 'INVALID_DATE', 'AMBIGUOUS_DATE', 'AMBIGUOUS_STATION', 'TRAIN_NOT_IN_RESULTS']);
const MIN_ATTEMPT_MS = 250;

export function attemptOutcome(r: RailwayResponse<any>, method: ProviderMethod): ProviderAttempt['outcome'] {
  if (r.ok) return method === 'searchTrains' && Array.isArray((r.data as any)?.trains) && (r.data as any).trains.length === 0 ? 'NO_RESULTS' : 'DATA';
  const c = String(r.error?.code || '');
  if (NO_RESULT_CODES.has(c)) return 'NO_RESULTS';
  if (REJECT_CODES.has(c)) return 'REJECTED';
  if (c === 'TIMEOUT' || c === 'TOOL_TIMEOUT') return 'TIMEOUT';
  if (c === 'PROVIDER_DATA_INVALID') return 'MALFORMED_DATA';
  if (c === 'TOOL_NOT_IMPLEMENTED') return 'UNSUPPORTED';
  if (c === 'NOT_CONFIGURED') return 'NOT_CONFIGURED';
  return 'PROVIDER_FAILURE';   // PROVIDER_UNAVAILABLE / RATE_LIMITED / AUTH_ERROR / unknown
}
const TERMINAL = new Set<ProviderAttempt['outcome']>(['DATA', 'NO_RESULTS', 'REJECTED']);
const REAL_FAILURE = new Set<ProviderAttempt['outcome']>(['TIMEOUT', 'PROVIDER_FAILURE', 'MALFORMED_DATA']);

export class FailoverRailwayProvider implements RailwayProvider {
  readonly providerId = 'live-failover';
  readonly source = 'railway-provider' as const;
  readonly isMock = false;
  readonly label: string;

  constructor(readonly chain: readonly LiveRailwayProvider[], private readonly opts: FailoverOptions) {
    if (!chain.length) throw new Error('FailoverRailwayProvider needs at least one live provider');
    const co = opts.capabilityOrder?.CHECK_AVAILABILITY;
    this.label = `Live railway data (${chain.map(p => p.providerId.toUpperCase()).join(' → ')})`
      + (co && co.length ? `; availability/fare: ${co.map(s => s.toUpperCase()).join(' → ')}` : '');
  }

  /** Providers in the order used for `cap` (capability order when configured, else the chain order). */
  chainFor(cap: string): readonly LiveRailwayProvider[] {
    const order = this.opts.capabilityOrder?.[cap];
    if (!order || !order.length) return this.chain;
    const ordered = order.map(id => this.chain.find(p => p.providerId === id)).filter((p): p is LiveRailwayProvider => !!p);
    return ordered.length ? ordered : this.chain;
  }

  searchTrains(r: any) { return this.run('searchTrains', p => p.searchTrains(r)); }
  getTrainInfo(r: any) { return this.run('getTrainInfo', p => p.getTrainInfo(r)); }
  getTimetable(r: any) { return this.run('getTimetable', p => p.getTimetable(r)); }
  checkAvailability(r: any) { return this.run('checkAvailability', p => p.checkAvailability(r)); }
  getFare(r: any) { return this.run('getFare', p => p.getFare(r)); }
  trackTrain(r: any) { return this.run('trackTrain', p => p.trackTrain(r)); }
  checkPNR(r: any) { return this.run('checkPNR', p => p.checkPNR(r)); }

  private async run<T>(method: ProviderMethod, call: (p: LiveRailwayProvider) => Promise<RailwayResponse<T>>): Promise<RailwayResponse<T>> {
    const cap = METHOD_CAPABILITY[method];
    const t0 = Date.now();
    const attempts: ProviderAttempt[] = [];
    const responses: Array<{ p: LiveRailwayProvider; r: RailwayResponse<T> }> = [];
    const chain = this.chainFor(cap);
    const primary = chain[0].providerId;
    for (const p of chain) {
      const n = attempts.length + 1;
      const rec = (outcome: ProviderAttempt['outcome'], r: RailwayResponse<T> | null, latencyMs: number): ProviderAttempt => {
        const a: ProviderAttempt = { provider: p.providerId, attempt: n, outcome, errorCode: r && !r.ok ? String(r.error?.code || '') : null,
          httpStatus: r && !r.ok ? (r.error?.httpStatus ?? null) : null, latencyMs, retryable: !!(r && !r.ok && r.error?.retryable) };
        attempts.push(a); return a;
      };
      if (!p.supports(cap)) { rec('UNSUPPORTED', null, 0); continue; }
      if (!p.configured) { rec('NOT_CONFIGURED', null, 0); continue; }
      const remaining = this.opts.budgetMs - (Date.now() - t0);
      if (remaining < MIN_ATTEMPT_MS) { rec('SKIPPED_BUDGET', null, 0); break; }
      const s = Date.now();
      let r: RailwayResponse<T>;
      try { r = await call(p.withTimeout(Math.min(this.opts.perAttemptMs, remaining))); }
      catch { r = { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Railway provider abhi uplabdh nahi hai.', retryable: true }, meta: { source: 'railway-provider', providerId: p.providerId, requestTimestamp: new Date(s).toISOString(), responseTimestamp: new Date().toISOString(), latencyMs: Date.now() - s, cache: 'disabled' } }; }
      const a = rec(attemptOutcome(r, method), r, Date.now() - s);
      responses.push({ p, r });
      if (TERMINAL.has(a.outcome)) return this.finish(r, p.providerId, attempts, primary);
    }
    // No provider produced a usable answer. Report the highest-priority REAL failure (timeout / provider failure /
    // malformed) — never NO_RESULTS. If nothing was even attempted: unsupported vs not configured, honestly.
    const realIdx = attempts.findIndex(a => REAL_FAILURE.has(a.outcome));
    if (realIdx >= 0) {
      const served = responses.find(x => x.p.providerId === attempts[realIdx].provider)!;
      return this.finish(served.r, served.p.providerId, attempts, primary);
    }
    const anyCapable = chain.some(p => p.supports(cap));
    const code: RailwayErrorCode = anyCapable ? 'PROVIDER_UNAVAILABLE' : 'TOOL_NOT_IMPLEMENTED';
    const message = anyCapable ? 'Is jaankari ke liye koi live railway provider configured nahi hai.' : 'Configured railway providers is jaankari ko support nahi karte.';
    const now = new Date().toISOString();
    return { ok: false, error: { code, message, retryable: false },
      meta: { source: 'railway-provider', providerId: primary, requestTimestamp: new Date(t0).toISOString(), responseTimestamp: now, latencyMs: Date.now() - t0, cache: 'disabled', attempts, fallbackUsed: false } };
  }

  private finish<T>(r: RailwayResponse<T>, served: string, attempts: ProviderAttempt[], primary: string): RailwayResponse<T> {
    return { ...r, meta: { ...r.meta, providerId: served, source: 'railway-provider', attempts, fallbackUsed: served !== primary } };
  }
}
