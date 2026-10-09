/**
 * PROMPT 35 — common base for LIVE railway provider adapters (RailCore / RailKit / RailRadar).
 *
 * An adapter only: builds the documented request, calls it once (bounded), and normalizes the provider body into the
 * EXISTING internal railway schema. It populates ONLY fields the provider returned. Anything it cannot normalize is
 * PROVIDER_DATA_INVALID (never a partial guess); an undeclared capability is TOOL_NOT_IMPLEMENTED (UNSUPPORTED); a
 * missing key is NOT_CONFIGURED. Keys live only in `cfg.apiKey` and the request headers — never in meta, errors,
 * results or logs. `source` is always 'railway-provider' (LIVE) — a live adapter can never report MOCK, and vice versa.
 */
import type { RailwayProvider } from '../railway-provider';
import type {
  RailwayResponse, RailwayErrorCode, RailwayMeta, SearchTrainsRequest, TrainSearchResultData, TrainInfoRequest, TrainDetails,
  TimetableRequest, AvailabilityRequest, AvailabilityData, FareRequest, FareData, TrackRequest, TrackData, PNRRequest, PNRData
} from '../../types/railway-types';
import { liveGet, liveError, type FetchLike, type LiveHttpResult } from './live-http';
import { rateLimiterFor, currentRateWait, pacingApplies, consumeHeldSlot } from './provider-rate-limiter';
import { providerSupports, type LiveProviderId, type RailwayCapability } from './provider-capabilities';
import type { MonthlyRequestQuota } from './monthly-quota';

export interface LiveProviderConfig {
  apiKey?: string;
  baseUrl: string;
  /** Per-call timeout (the failover layer may lower it to fit the remaining turn budget). */
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

/** Thrown by normalizers when the provider body does not have the documented shape → PROVIDER_DATA_INVALID. */
export class MalformedProviderData extends Error { constructor(what: string) { super(`malformed:${what}`); } }
export const need = <T>(v: T | undefined | null, what: string): T => { if (v === undefined || v === null || (v as any) === '') throw new MalformedProviderData(what); return v; };

export abstract class LiveRailwayProvider implements RailwayProvider {
  abstract readonly providerId: LiveProviderId;
  abstract readonly label: string;
  readonly source = 'railway-provider' as const;
  readonly isMock = false;

  constructor(protected readonly cfg: LiveProviderConfig) {}

  get configured(): boolean { return typeof this.cfg.apiKey === 'string' && this.cfg.apiKey.trim().length > 0; }
  supports(cap: RailwayCapability): boolean { return providerSupports(this.providerId, cap); }
  /** Same adapter with a tighter per-call timeout (used by the failover budget). */
  withTimeout(timeoutMs: number): this {
    const Ctor = this.constructor as new (cfg: LiveProviderConfig) => this;
    return new Ctor({ ...this.cfg, timeoutMs: Math.max(1, Math.floor(timeoutMs)) });
  }

  protected abstract authHeaders(): Record<string, string>;

  protected meta(t0: number, freshness?: RailwayMeta['freshness']): RailwayMeta {
    const now = new Date().toISOString();
    return { source: this.source, providerId: this.providerId, requestTimestamp: new Date(t0).toISOString(), responseTimestamp: now,
      latencyMs: Date.now() - t0, cache: 'disabled', ...(freshness ? { freshness } : {}) };
  }
  protected fail<T>(code: RailwayErrorCode, t0: number, extra: { httpStatus?: number | null; retryable?: boolean; message?: string; localThrottle?: boolean; localQuota?: boolean } = {}): RailwayResponse<T> {
    const e = liveError(code, extra.httpStatus ?? null, extra.retryable);
    const rl = code === 'RATE_LIMITED' && extra.localThrottle !== undefined
      ? { rateLimit: { local: extra.localThrottle, ...(extra.localQuota ? { reason: 'LOCAL_MONTHLY_QUOTA' as const } : {}) } } : {};
    return { ok: false, error: { code, message: extra.message || e.message, retryable: e.retryable, httpStatus: e.httpStatus }, meta: { ...this.meta(t0), ...rl } };
  }
  protected httpFail<T>(r: Extract<LiveHttpResult, { ok: false }>, t0: number, notFoundCode: RailwayErrorCode = 'NOT_FOUND'): RailwayResponse<T> {
    const code = r.error.code === 'NOT_FOUND' ? notFoundCode : r.error.code;
    return this.fail<T>(code, t0, { httpStatus: r.error.httpStatus, retryable: r.error.retryable, ...(code === 'RATE_LIMITED' ? { localThrottle: !!r.localThrottle, ...(r.localQuota ? { localQuota: true } : {}) } : {}) });
  }
  protected get(path: string, query: Record<string, string | undefined> = {}, isNotFound?: (status: number, json: any) => boolean): Promise<LiveHttpResult> {
    const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');
    const url = `${this.cfg.baseUrl.replace(/\/+$/, '')}${path}${qs ? `?${qs}` : ''}`;
    const send = () => liveGet(url, this.authHeaders(), { timeoutMs: this.cfg.timeoutMs, fetchImpl: this.cfg.fetchImpl, isNotFound });
    const quota = this.monthlyQuota();
    if (!quota) return this.paced(send);
    // 2026-10-09: reserve BEFORE the pacer / dispatch; count exactly when the HTTP request is sent; release if never sent
    const res = quota.reserve();
    if (!res.ok) {
      try { console.warn(JSON.stringify({ event: 'provider_local_monthly_quota', provider: this.providerId, month: res.month, used: res.used, effectiveLimit: res.effectiveLimit, source: 'LOCAL_ESTIMATE' })); } catch { /* never throws */ }
      return Promise.resolve({ ok: false, error: { ...liveError('RATE_LIMITED', null, false) }, latencyMs: 0, localThrottle: true, localQuota: true });
    }
    return this.paced(() => { quota.commit(res); return send(); }).finally(() => quota.release(res));
  }

  /** 2026-10-09: local monthly request accounting (RailKit only); null = none. */
  protected monthlyQuota(): MonthlyRequestQuota | null { return null; }

  /**
   * P42.9: every provider request goes through the per-provider pacer (shared by all callers). No slot within the wait
   * budget → RATE_LIMITED (LOCAL, retryable) WITHOUT a provider request — eligible for the backend fallback. The
   * provider's own rate headers / 429 adapt the pacer. Nothing is cached or replayed.
   */
  private async paced(call: () => Promise<LiveHttpResult>): Promise<LiveHttpResult> {
    if (!pacingApplies(!!this.cfg.fetchImpl)) return call();
    const limiter = rateLimiterFor(this.providerId);
    // F3: the automatic same-train queue already took (and counted) this request's slot → no second slot; still observed
    const slot = consumeHeldSlot(this.providerId) ? { ok: true as const, queuedMs: 0 } : await limiter.acquire(currentRateWait());
    if (!slot.ok) return { ok: false, error: { ...liveError('RATE_LIMITED', null, true) }, latencyMs: 0, localThrottle: true };
    const r = await call();
    limiter.observe(r.ok ? r.httpStatus : r.error.httpStatus, r.rate);
    return r;
  }

  /** Gate + normalization boundary shared by every capability. */
  protected async run<T>(cap: RailwayCapability, body: (t0: number) => Promise<RailwayResponse<T>>): Promise<RailwayResponse<T>> {
    const t0 = Date.now();
    if (!this.supports(cap)) return this.fail<T>('TOOL_NOT_IMPLEMENTED', t0, { retryable: false, message: `${this.label}: ${cap} supported nahi hai.` });
    if (!this.configured) return this.fail<T>('NOT_CONFIGURED', t0, { retryable: false, message: `${this.label} configured nahi hai.` });
    try { return await body(t0); }
    catch { return this.fail<T>('PROVIDER_DATA_INVALID', t0, { retryable: false }); }
  }

  // Default: UNSUPPORTED. Adapters override only capabilities they declare in the matrix.
  searchTrains(_r: SearchTrainsRequest): Promise<RailwayResponse<TrainSearchResultData>> { return this.run('SEARCH_TRAINS', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  getTrainInfo(_r: TrainInfoRequest): Promise<RailwayResponse<TrainDetails | null>> { return this.run('GET_TRAIN_INFO', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  getTimetable(_r: TimetableRequest): Promise<RailwayResponse<any[]>> { return this.run('GET_TIMETABLE', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  checkAvailability(_r: AvailabilityRequest): Promise<RailwayResponse<AvailabilityData>> { return this.run('CHECK_AVAILABILITY', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  getFare(_r: FareRequest): Promise<RailwayResponse<FareData>> { return this.run('GET_FARE', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  trackTrain(_r: TrackRequest): Promise<RailwayResponse<TrackData>> { return this.run('TRACK_TRAIN', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }
  checkPNR(_r: PNRRequest): Promise<RailwayResponse<PNRData>> { return this.run('CHECK_PNR', async t0 => this.fail('TOOL_NOT_IMPLEMENTED', t0)); }

  /** Journey segment needed by live availability / fare endpoints (authoritative session journey, never guessed). */
  protected segment(r: { origin?: string; destination?: string }): { from: string; to: string } | null {
    const from = String(r.origin || '').trim().toUpperCase(), to = String(r.destination || '').trim().toUpperCase();
    return /^[A-Z]{1,5}$/.test(from) && /^[A-Z]{1,5}$/.test(to) ? { from, to } : null;
  }
}
