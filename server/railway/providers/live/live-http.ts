/**
 * PROMPT 35 — Secret-safe HTTP for live railway providers.
 *
 *  - one bounded GET per call (AbortController timeout); no cache, no retry here (fallback is the failover layer's job);
 *  - HTTP / transport failures are classified onto the EXISTING railway error vocabulary — a timeout, a 5xx or a
 *    malformed body is NEVER "no results"; only a documented not-found answer (adapter predicate) is NOT_FOUND;
 *  - error messages are fixed, generic strings: never the URL (could carry a query key), never headers, never the raw
 *    provider body, never a stack trace. Credentials only ever travel in the request headers built by the adapter.
 */
import type { RailwayErrorCode } from '../../types/railway-types';

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  status: number; text(): Promise<string>;
}>;

export interface LiveHttpError { code: RailwayErrorCode; message: string; retryable: boolean; httpStatus: number | null }
export type LiveHttpResult =
  | { ok: true; httpStatus: number; json: any; latencyMs: number }
  | { ok: false; error: LiveHttpError; json?: any; latencyMs: number };

export interface LiveGetOptions {
  timeoutMs: number;
  fetchImpl?: FetchLike;
  /** Adapter-specific: is this 4xx body the provider's DOCUMENTED "nothing matches" answer? (valid empty result) */
  isNotFound?: (httpStatus: number, json: any) => boolean;
}

const MSG: Record<string, string> = {
  TIMEOUT: 'Railway provider ne time par jawab nahi diya.',
  PROVIDER_UNAVAILABLE: 'Railway provider abhi uplabdh nahi hai.',
  RATE_LIMITED: 'Railway provider ki request limit abhi poori ho gayi hai.',
  AUTH_ERROR: 'Railway provider ne is request ko authorize nahi kiya.',
  PROVIDER_DATA_INVALID: 'Railway provider ka jawab sahi format mein nahi tha.',
  INVALID_REQUEST: 'Railway provider ne request ko invalid bataya.',
  NOT_FOUND: 'Provider ke paas is request ka koi record nahi mila.'
};
export const liveError = (code: RailwayErrorCode, httpStatus: number | null = null, retryable?: boolean): LiveHttpError => ({
  code, message: MSG[code] || MSG.PROVIDER_UNAVAILABLE, httpStatus,
  retryable: retryable ?? (code === 'TIMEOUT' || code === 'PROVIDER_UNAVAILABLE' || code === 'RATE_LIMITED')
});

/** HTTP status → railway error code (documented gateway semantics of RailCore / RailRadar / RailKit). */
export function classifyHttpStatus(status: number): RailwayErrorCode {
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  if (status === 401 || status === 402 || status === 403) return 'AUTH_ERROR';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  return 'PROVIDER_UNAVAILABLE';   // 404 without a documented not-found body (wrong route), 410 sunset, 5xx, anything else
}

export async function liveGet(url: string, headers: Record<string, string>, o: LiveGetOptions): Promise<LiveHttpResult> {
  const f: FetchLike = o.fetchImpl || (globalThis.fetch as unknown as FetchLike);
  const ctrl = new AbortController();
  const t0 = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(1, o.timeoutMs));
  try {
    const res = await f(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal });
    const text = await res.text();
    const latencyMs = Date.now() - t0;
    let json: any; let parsed = true;
    try { json = text ? JSON.parse(text) : undefined; } catch { parsed = false; }
    if (res.status >= 200 && res.status < 300) {
      if (!parsed || json === undefined || json === null || typeof json !== 'object') return { ok: false, error: liveError('PROVIDER_DATA_INVALID', res.status), latencyMs };
      return { ok: true, httpStatus: res.status, json, latencyMs };
    }
    if (parsed && o.isNotFound?.(res.status, json)) return { ok: false, error: liveError('NOT_FOUND', res.status, false), json, latencyMs };
    return { ok: false, error: liveError(classifyHttpStatus(res.status), res.status), json: parsed ? json : undefined, latencyMs };
  } catch {
    return { ok: false, error: liveError(timedOut ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE'), latencyMs: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

// ---- small normalization helpers shared by the adapters (only provider-returned values; nothing invented) ----
export const VALID_CLASSES = new Set(['1A', '2A', '3A', '3E', 'CC', 'EC', 'SL', '2S', 'FC', 'EA', 'EV', 'VS']);
export const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : typeof x === 'number' && Number.isFinite(x) ? String(x) : undefined);
export const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : undefined);
export const hhmm = (x: unknown): string | undefined => { const s = str(x); const m = s?.match(/^(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined; };
export const durationText = (minutes: number | undefined): string | undefined => (minutes === undefined || minutes < 0 ? undefined : `${Math.floor(minutes / 60)}h ${minutes % 60}m`);
/** YYYY-MM-DD → DD-MM-YYYY (RailKit path format). */
export const toDMY = (iso: string): string => { const [y, m, d] = iso.split('-'); return `${d}-${m}-${y}`; };
/** Today's journey date in IST (TRACK_TRAIN needs a run date; the tool contract has no date argument). */
export const todayIST = (now = Date.now()): string => new Date(now + 5.5 * 3600_000).toISOString().slice(0, 10);

/**
 * Canonical availability text from provider status fields so the P26 availability authority can compare claims:
 * "AVAILABLE 24" · "RAC 5" · "WL 30" · "NOT AVAILABLE" · "REGRET" · "TRAIN CANCELLED" · "TRAIN DEPARTED".
 * UNKNOWN / unrecognised → undefined (the adapter reports PROVIDER_DATA_INVALID — never a guessed status).
 */
export function canonicalAvailability(status: string | undefined, counts: { available?: number; rac?: number; wl?: number }): { status: string; available: boolean } | undefined {
  const s = String(status || '').toUpperCase().replace(/[\s-]+/g, '_');
  if (s === 'AVAILABLE' || s === 'CURR_AVBL' || s === 'AVBL') return { status: counts.available !== undefined && counts.available > 0 ? `AVAILABLE ${counts.available}` : 'AVAILABLE', available: true };
  if (s === 'RAC') return { status: counts.rac !== undefined ? `RAC ${counts.rac}` : 'RAC', available: false };
  if (s === 'WAITLIST' || s === 'WL' || s === 'WAITING_LIST') return { status: counts.wl !== undefined ? `WL ${counts.wl}` : 'WL', available: false };
  if (s === 'REGRET') return { status: 'REGRET', available: false };
  if (s === 'NOT_AVAILABLE') return { status: 'NOT AVAILABLE', available: false };
  if (s === 'TRAIN_CANCELLED') return { status: 'TRAIN CANCELLED', available: false };
  if (s === 'TRAIN_DEPARTED') return { status: 'TRAIN DEPARTED', available: false };
  return undefined;
}
