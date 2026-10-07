/**
 * PROMPT 42.9 — per-provider request pacing (D1: same-train matrix burst → RATE_LIMITED).
 *
 * One limiter per live provider id, shared by EVERY caller in the process (Muse provider tools, the same-train matrix,
 * the booking re-validation), because the provider's quota is per key, not per caller. It is a request PACER, not a
 * cache: it never stores or replays a railway answer.
 *
 *   - sliding window: at most `perMinute` request starts in any 60 s window (provider-documented headers on 2026-10-07:
 *     RailCore x-railcore-ratelimit-limit 20 / day 300 · RailRadar x-ratelimit-limit-min 10 / month 1000);
 *   - `minIntervalMs` between two starts (no micro-burst even when the window has room);
 *   - adaptive: provider headers (remaining = 0 + reset) and HTTP 429 (Retry-After) block the provider until the reset,
 *     bounded; repeated 429s back off exponentially, capped (bounded backoff — never an unbounded retry loop);
 *   - `acquire(maxWaitMs)` either reserves a start slot that is at most `maxWaitMs` away (and waits for it) or returns
 *     immediately with `ok:false` — the caller then reports RATE_LIMITED (LOCAL) without spending a provider request,
 *     which makes the request eligible for the backend RailCore → RailRadar fallback.
 *
 * Config (env, all optional): <ID>_RATE_LIMIT_PER_MIN (0 = no window limit), <ID>_MIN_INTERVAL_MS,
 * RAILWAY_RATE_WAIT_MS (default max wait for a slot), RAILWAY_RATE_BACKOFF_MAX_MS. No key, header value or token is
 * ever logged or returned — only counters.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type Env = Record<string, string | undefined>;

export interface RateLimitConfig { perMinute: number; minIntervalMs: number; maxWaitMs: number; backoffMaxMs: number }
export interface RateHeaders {
  /** requests left in the current short window (minute) */
  remaining?: number;
  /** epoch ms when the short window resets */
  resetAtMs?: number;
  /** HTTP Retry-After (ms) */
  retryAfterMs?: number;
  /** requests left in the long window (day / month) */
  longRemaining?: number;
  /** epoch ms when the long window resets (unknown for monthly quotas) */
  longResetAtMs?: number;
}
export type AcquireResult = { ok: true; queuedMs: number } | { ok: false; reason: 'WINDOW_FULL' | 'BLOCKED'; retryInMs: number };

const WINDOW_MS = 60_000;
const DEFAULTS: Record<string, { perMinute: number; minIntervalMs: number }> = {
  railcore: { perMinute: 20, minIntervalMs: 250 },
  railradar: { perMinute: 10, minIntervalMs: 300 },
  railkit: { perMinute: 0, minIntervalMs: 0 }
};
const num = (v: string | undefined, d: number, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : d;
};

export function rateLimitConfigFromEnv(providerId: string, env: Env = process.env): RateLimitConfig {
  const id = providerId.toUpperCase();
  const d = DEFAULTS[providerId] || { perMinute: 0, minIntervalMs: 0 };
  return {
    perMinute: num(env[`${id}_RATE_LIMIT_PER_MIN`], d.perMinute, 0, 10_000),
    minIntervalMs: num(env[`${id}_MIN_INTERVAL_MS`], d.minIntervalMs, 0, 60_000),
    maxWaitMs: num(env.RAILWAY_RATE_WAIT_MS, 1500, 0, 30_000),
    backoffMaxMs: num(env.RAILWAY_RATE_BACKOFF_MAX_MS, 30_000, 1000, 120_000)
  };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)));

export interface RateLimiterStats { provider: string; started: number; localRejected: number; providerRateLimited: number; queuedMsTotal: number; blockedUntil: number | null }

export class ProviderRateLimiter {
  private starts: number[] = [];          // reserved start times (ms), sorted ascending
  private blockedUntil = 0;
  private consecutive429 = 0;
  private stats = { started: 0, localRejected: 0, providerRateLimited: 0, queuedMsTotal: 0 };

  constructor(readonly provider: string, readonly cfg: RateLimitConfig, private readonly now: () => number = Date.now) {}

  /** earliest start time a new request could get (no reservation). */
  private earliest(t: number): number {
    let at = Math.max(t, this.blockedUntil);
    const last = this.starts[this.starts.length - 1];
    if (last !== undefined && this.cfg.minIntervalMs > 0) at = Math.max(at, last + this.cfg.minIntervalMs);
    if (this.cfg.perMinute > 0) {
      // window full at `at` → move to the time the oldest start inside [at-60s, at] leaves the window
      for (;;) {
        const inWin = this.starts.filter(x => x > at - WINDOW_MS);
        if (inWin.length < this.cfg.perMinute) break;
        at = inWin[inWin.length - this.cfg.perMinute] + WINDOW_MS;
      }
    }
    return at;
  }

  async acquire(maxWaitMs: number = this.cfg.maxWaitMs): Promise<AcquireResult> {
    const t = this.now();
    this.starts = this.starts.filter(x => x > t - WINDOW_MS);
    const at = this.earliest(t);
    const wait = at - t;
    if (wait > maxWaitMs) {
      this.stats.localRejected++;
      return { ok: false, reason: this.blockedUntil > t ? 'BLOCKED' : 'WINDOW_FULL', retryInMs: wait };
    }
    // reserve the slot synchronously (concurrent callers can never take the same slot)
    this.starts.push(at); this.starts.sort((a, b) => a - b);
    this.stats.started++; this.stats.queuedMsTotal += Math.max(0, wait);
    if (wait > 0) await sleep(wait);
    return { ok: true, queuedMs: Math.max(0, wait) };
  }

  /** Provider answered — adapt to its own quota headers; 429 → bounded backoff. */
  observe(httpStatus: number | null, h: RateHeaders = {}): void {
    const t = this.now();
    if (httpStatus === 429) {
      this.stats.providerRateLimited++;
      this.consecutive429++;
      const backoff = Math.min(this.cfg.backoffMaxMs, 1000 * 2 ** Math.min(6, this.consecutive429));
      const hinted = h.retryAfterMs ?? (h.resetAtMs && h.resetAtMs > t ? h.resetAtMs - t : undefined);
      this.block(t + Math.min(this.cfg.backoffMaxMs * 2, Math.max(1000, hinted ?? backoff)));
      return;
    }
    // quota headers are trusted only on a real answer (RailCore sends remaining=0 / credits=0 on a 400 validation error)
    if (httpStatus === null || httpStatus < 200 || httpStatus >= 300) return;
    this.consecutive429 = 0;
    if (h.remaining === 0 && h.resetAtMs && h.resetAtMs > t) this.block(Math.min(h.resetAtMs, t + WINDOW_MS + 5000));
    if (h.longRemaining === 0) this.block(h.longResetAtMs && h.longResetAtMs > t ? Math.min(h.longResetAtMs, t + 24 * 3600_000) : t + 3600_000);
  }

  private block(until: number) { if (until > this.blockedUntil) this.blockedUntil = until; }

  snapshot(): RateLimiterStats {
    return { provider: this.provider, ...this.stats, blockedUntil: this.blockedUntil > this.now() ? this.blockedUntil : null };
  }
}

const limiters = new Map<string, ProviderRateLimiter>();
let clock: () => number = Date.now;
/** Pacing applies to real network calls; adapters with an injected fetch (offline tests) are paced only when a test opts in. */
let paceInjected = false;
export function pacingApplies(injectedFetch: boolean, env: Env = process.env): boolean {
  if (String(env.RAILWAY_RATE_PACING || '').toLowerCase() === 'off') return false;
  return !injectedFetch || paceInjected;
}

export function rateLimiterFor(providerId: string): ProviderRateLimiter {
  let l = limiters.get(providerId);
  if (!l) { l = new ProviderRateLimiter(providerId, rateLimitConfigFromEnv(providerId), () => clock()); limiters.set(providerId, l); }
  return l;
}
/** tests: fresh limiters (optionally with explicit config / clock). */
export function resetRateLimiters(opts: { clock?: () => number; config?: Record<string, Partial<RateLimitConfig>>; paceInjectedFetch?: boolean } = {}): void {
  limiters.clear();
  clock = opts.clock || Date.now;
  paceInjected = !!opts.paceInjectedFetch;
  for (const [id, c] of Object.entries(opts.config || {})) {
    limiters.set(id, new ProviderRateLimiter(id, { ...rateLimitConfigFromEnv(id), ...c }, () => clock()));
  }
}
export function rateLimiterStats(): RateLimiterStats[] { return [...limiters.values()].map(l => l.snapshot()); }

// ---- per-execution wait override (the same-train matrix prefers an immediate fallback to a long queue) ----
const waitScope = new AsyncLocalStorage<number>();
export function withRateWait<T>(maxWaitMs: number, fn: () => Promise<T>): Promise<T> { return waitScope.run(Math.max(0, maxWaitMs), fn); }
export function currentRateWait(): number | undefined { return waitScope.getStore(); }

/** Parse provider rate headers (RailCore x-railcore-ratelimit-* · RailRadar x-ratelimit-*-min/month · Retry-After). */
export function parseRateHeaders(get: (name: string) => string | null | undefined, now = Date.now()): RateHeaders {
  const n = (k: string) => { const v = get(k); const x = v === null || v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(x) ? x : undefined; };
  const epoch = (x: number | undefined) => (x === undefined ? undefined : x > 1e12 ? x : x > 1e9 ? x * 1000 : now + x * 1000);
  const out: RateHeaders = {};
  const remaining = n('x-railcore-ratelimit-remaining') ?? n('x-ratelimit-remaining-min') ?? n('x-ratelimit-remaining');
  if (remaining !== undefined) out.remaining = remaining;
  const reset = epoch(n('x-railcore-ratelimit-reset') ?? n('x-ratelimit-reset'));
  if (reset !== undefined) out.resetAtMs = reset;
  const ra = get('retry-after');
  if (ra) { const s = Number(ra); const d = Number.isFinite(s) ? s * 1000 : Date.parse(ra) - now; if (Number.isFinite(d) && d >= 0) out.retryAfterMs = d; }
  const longRemaining = n('x-railcore-ratelimit-day-remaining') ?? n('x-ratelimit-remaining-month');
  if (longRemaining !== undefined) out.longRemaining = longRemaining;
  const longReset = epoch(n('x-railcore-ratelimit-day-reset'));
  if (longReset !== undefined) out.longResetAtMs = longReset;
  return out;
}
