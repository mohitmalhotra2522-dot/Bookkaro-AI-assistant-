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
  /** F3: size of the long window quota (day / month) when the provider sends it */
  longLimit?: number;
}

/**
 * F3: BACKGROUND (automatic same-train queue) pacing policy. Background starts never reserve future slots and never
 * exceed `share` × perMinute inside a `windowMs` window (counting EVERY start, interactive ones included) → interactive
 * chat calls always keep (1 − share) of the provider minute quota. The long-window (day / month) reserve keeps
 * max(reserveMin, reservePct % of the provider limit) requests for interactive use.
 */
export interface BackgroundPolicy { share: number; windowMs: number; dailyReservePct: number; dailyReserveMin: number }
export function backgroundPolicyFromEnv(env: Env = process.env): BackgroundPolicy {
  const share = Number(env.SAME_TRAIN_QUEUE_RATE_SHARE);
  return {
    share: Number.isFinite(share) && share > 0 && share <= 1 ? share : 0.75,
    windowMs: num(env.SAME_TRAIN_QUEUE_WINDOW_MS, 61_000, 60_000, 120_000),
    dailyReservePct: num(env.SAME_TRAIN_QUEUE_DAILY_RESERVE_PCT, 25, 0, 90),
    dailyReserveMin: num(env.SAME_TRAIN_QUEUE_DAILY_RESERVE_MIN, 20, 0, 100_000)
  };
}
export type BackgroundCheck = { ok: true; at: number } | { ok: false; reason: 'DAILY_RESERVE'; longRemaining: number; reserve: number };
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

export interface RateLimiterStats { provider: string; started: number; localRejected: number; providerRateLimited: number; queuedMsTotal: number; blockedUntil: number | null;
  /** F3 counters: background (queue) starts, and the provider's own long-window quota as last reported (null = unknown) */
  backgroundStarted?: number; longRemaining?: number | null; longLimit?: number | null }

export class ProviderRateLimiter {
  private starts: number[] = [];          // reserved start times (ms), sorted ascending
  private blockedUntil = 0;
  private consecutive429 = 0;
  private stats = { started: 0, localRejected: 0, providerRateLimited: 0, queuedMsTotal: 0, backgroundStarted: 0 };
  // F3: provider long-window quota (day / month) — from headers, decremented locally per start until the next answer
  private longRemaining: number | undefined;
  private longLimit: number | undefined;
  private longResetAtMs: number | undefined;
  private longSeenAt = 0;

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
    if (this.longRemaining !== undefined) this.longRemaining = Math.max(0, this.longRemaining - 1);
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
    if (h.longRemaining !== undefined) { this.longRemaining = h.longRemaining; this.longSeenAt = t; this.longResetAtMs = h.longResetAtMs && h.longResetAtMs > t ? h.longResetAtMs : undefined; }
    if (h.longLimit !== undefined && h.longLimit > 0) this.longLimit = h.longLimit;
    if (h.remaining === 0 && h.resetAtMs && h.resetAtMs > t) this.block(Math.min(h.resetAtMs, t + WINDOW_MS + 5000));
    if (h.longRemaining === 0) this.block(h.longResetAtMs && h.longResetAtMs > t ? Math.min(h.longResetAtMs, t + 24 * 3600_000) : t + 3600_000);
  }

  private block(until: number) { if (until > this.blockedUntil) this.blockedUntil = until; }

  // ---------------------------------------------------------------- F3 background (automatic queue) mode
  /** most background starts allowed per policy window (Infinity when the provider has no minute limit). */
  backgroundCap(p: BackgroundPolicy): number {
    return this.cfg.perMinute > 0 ? Math.max(1, Math.floor(this.cfg.perMinute * p.share)) : Number.POSITIVE_INFINITY;
  }
  /** interactive reserve of the long-window quota (requests kept back from the background queue). */
  longReserve(p: BackgroundPolicy): number {
    return Math.max(p.dailyReserveMin, this.longLimit ? Math.ceil(this.longLimit * p.dailyReservePct / 100) : 0);
  }
  private longKnown(t: number): boolean {
    if (this.longRemaining === undefined) return false;
    // forget a stale long-window reading (reset passed, or older than a day without a reset time)
    if (this.longResetAtMs ? t >= this.longResetAtMs : t - this.longSeenAt > 24 * 3600_000) { this.longRemaining = undefined; return false; }
    return true;
  }
  /**
   * NON-reserving: earliest time a background start may happen. Counts every start (interactive + background, future
   * reservations included) inside the policy window against the background cap; honours provider blocks and the min
   * interval. Long-window quota at / below the interactive reserve → refused (DAILY_RESERVE).
   */
  backgroundCheck(p: BackgroundPolicy): BackgroundCheck {
    const t = this.now();
    this.starts = this.starts.filter(x => x > t - Math.max(WINDOW_MS, p.windowMs));
    if (this.longKnown(t) && this.longRemaining! <= this.longReserve(p)) return { ok: false, reason: 'DAILY_RESERVE', longRemaining: this.longRemaining!, reserve: this.longReserve(p) };
    let at = Math.max(t, this.blockedUntil);
    const last = this.starts[this.starts.length - 1];
    if (last !== undefined && this.cfg.minIntervalMs > 0) at = Math.max(at, last + this.cfg.minIntervalMs);
    const cap = this.backgroundCap(p);
    if (Number.isFinite(cap)) {
      for (;;) {
        const inWin = this.starts.filter(x => x > at - p.windowMs);
        if (inWin.length < cap) break;
        at = inWin[inWin.length - cap] + p.windowMs;
      }
    }
    return { ok: true, at };
  }
  /** Take a background start NOW if the policy allows it (never waits, never reserves the future). */
  tryStartBackground(p: BackgroundPolicy): boolean {
    const g = this.backgroundCheck(p);
    if (!g.ok || g.at > this.now()) return false;
    this.starts.push(this.now()); this.starts.sort((a, b) => a - b);
    this.stats.started++; this.stats.backgroundStarted++;
    if (this.longRemaining !== undefined) this.longRemaining = Math.max(0, this.longRemaining - 1);
    return true;
  }

  snapshot(): RateLimiterStats {
    const t = this.now();
    return { provider: this.provider, ...this.stats, blockedUntil: this.blockedUntil > t ? this.blockedUntil : null,
      longRemaining: this.longKnown(t) ? this.longRemaining! : null, longLimit: this.longLimit ?? null };
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

// ---- F3: a background queue slot already counted for exactly ONE provider request of this async context ----
const heldScope = new AsyncLocalStorage<{ provider: string; used: boolean }>();
export function runWithHeldSlot<T>(provider: string, fn: () => Promise<T>): Promise<T> { return heldScope.run({ provider, used: false }, fn); }
/** true (once) when the caller already holds a queue slot for this provider → the pacer must not take a second one. */
export function consumeHeldSlot(provider: string): boolean {
  const h = heldScope.getStore();
  if (!h || h.used || h.provider !== provider) return false;
  h.used = true;
  return true;
}

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
  // F3: long-window quota size (RailCore day limit · RailRadar month limit) → interactive reserve of the background queue
  const longLimit = n('x-railcore-ratelimit-day-limit') ?? n('x-ratelimit-limit-month');
  if (longLimit !== undefined) out.longLimit = longLimit;
  return out;
}
