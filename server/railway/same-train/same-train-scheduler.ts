/**
 * F3 — paced fair queue for AUTOMATIC same-train searches (user approval 2026-10-09, spec #47).
 *
 * Problem (P42-14 live check): every waitlisted train starts its own same-train matrix at once; the per-provider pacer
 * (P42.9) fast-fails a matrix call after ~1 s of queueing → later trains / stations were cut off as RATE_LIMITED.
 *
 * Design — one scheduler per provider id, shared by every automatic search in the process:
 *   - BACKGROUND pacing with a safety margin: a unit is dispatched only when the provider's limiter grants a
 *     NON-reserving background slot (≤ share × perMinute starts in a 61 s window, min interval, provider blocks honoured)
 *     — interactive chat calls always keep the remaining headroom and never wait behind the queue;
 *   - daily / monthly quota reserve: when the provider's long-window remaining reaches the reserve the queue stops
 *     spending and the unit fails HONESTLY (RATE_LIMITED, reason DAILY_RESERVE) — never a silent "no seat";
 *   - fairness: round-robin across searches (one unit per search per turn), FIFO inside a search (the engine submits in
 *     station order: nearby earlier stations → origin → beyond destination → remaining segments) → no starvation;
 *   - bounded concurrency (maxInFlight) and per-call timeout on the PROVIDER CALL only (queue wait never times out a call);
 *   - retries: at most `maxRetries` per unit, only for a provider 429 / timeout / 5xx-type answer, exponential backoff
 *     (honours Retry-After through the limiter block) — a retried unit keeps its place at the head of its search;
 *   - cancellation: a queued unit whose search is no longer current (or past its deadline) is dropped WITHOUT spending a
 *     provider request.
 * It is a pacer, never a cache: every dispatched unit is a fresh provider call; no answer is stored or replayed.
 * No key, header value or token is ever read here — only counters.
 */
import { rateLimiterFor, pacingApplies, runWithHeldSlot, backgroundPolicyFromEnv, type BackgroundPolicy } from '../providers/live/provider-rate-limiter';

type Env = Record<string, string | undefined>;

export interface SchedulerConfig {
  maxInFlight: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  callTimeoutMs: number;
  maxQueued: number;
}

const num = (v: string | undefined, d: number, min: number, max: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : d;
};

export function schedulerConfigFromEnv(env: Env = process.env): SchedulerConfig {
  return {
    maxInFlight: num(env.SAME_TRAIN_QUEUE_MAX_IN_FLIGHT, 2, 1, 6),
    maxRetries: num(env.SAME_TRAIN_QUEUE_MAX_RETRIES, 2, 0, 3),
    backoffBaseMs: num(env.SAME_TRAIN_QUEUE_BACKOFF_BASE_MS, 2000, 100, 60_000),
    backoffMaxMs: num(env.SAME_TRAIN_QUEUE_BACKOFF_MAX_MS, 30_000, 1000, 300_000),
    callTimeoutMs: num(env.SAME_TRAIN_CALL_TIMEOUT_MS, 9000, 500, 30_000),
    maxQueued: num(env.SAME_TRAIN_QUEUE_MAX_QUEUED, 3000, 10, 20_000)
  };
}

/** What the scheduler adds to the value it returns (engine reads it; never shown as a railway fact). */
export interface SchedulerMeta { attempts: number; retries: number; queuedMs: number; timedOut?: boolean; cancelled?: boolean; refused?: 'DAILY_RESERVE' | 'QUEUE_FULL' }

export interface ScheduleOptions {
  /** search (one train's same-train matrix) the unit belongs to — the fairness key */
  searchId: string;
  /** true → drop the unit without a provider request (journey superseded / search deadline passed) */
  cancelled?: () => boolean;
}

/** Provider answer that may be retried: a REAL provider 429, a timeout, or an unavailable / 5xx-type answer. */
export function isRetryableAnswer(v: any): boolean {
  if (!v || v.ok !== false) return false;
  const code = String(v.error?.code || '');
  if (code === 'RATE_LIMITED') return v.meta?.rateLimit?.reason !== 'DAILY_RESERVE';
  return code === 'PROVIDER_TIMEOUT' || code === 'TIMEOUT' || code === 'TOOL_TIMEOUT' || code === 'PROVIDER_UNAVAILABLE';
}

interface Unit {
  searchId: string;
  run: () => Promise<any>;
  cancelled?: () => boolean;
  resolve: (v: any) => void;
  enqueuedAt: number;
  notBefore: number;
  attempts: number;
}

export interface SchedulerStats {
  provider: string; queued: number; inFlight: number; searches: number; dispatched: number; completed: number; retried: number;
  cancelled: number; timedOut: number; refusedDailyReserve: number; refusedQueueFull: number; maxQueueWaitMs: number;
  maxInFlightSeen: number; backgroundCap: number | null;
}

export class SameTrainScheduler {
  private queues = new Map<string, Unit[]>();     // insertion-ordered → round-robin order
  private rr = 0;
  private inFlight = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;
  private s = { dispatched: 0, completed: 0, retried: 0, cancelled: 0, timedOut: 0, refusedDailyReserve: 0, refusedQueueFull: 0, maxQueueWaitMs: 0, maxInFlightSeen: 0 };

  constructor(readonly provider: string, readonly cfg: SchedulerConfig = schedulerConfigFromEnv(),
    private readonly policy: BackgroundPolicy = backgroundPolicyFromEnv(),
    private readonly now: () => number = () => Date.now(),
    private readonly paced: () => boolean = () => pacingApplies(false)) {}

  private queuedCount(): number { let n = 0; for (const q of this.queues.values()) n += q.length; return n; }

  /** Queue one provider call. Resolves with the provider value (+ meta.scheduler) — never rejects. */
  schedule<T = any>(opts: ScheduleOptions, run: () => Promise<T>): Promise<T | any> {
    return new Promise(resolve => {
      const t = this.now();
      if (this.queuedCount() >= this.cfg.maxQueued) {
        this.s.refusedQueueFull++;
        resolve(this.refusal('QUEUE_FULL', 0, 0));
        return;
      }
      const u: Unit = { searchId: opts.searchId, run, cancelled: opts.cancelled, resolve, enqueuedAt: t, notBefore: t, attempts: 0 };
      const q = this.queues.get(opts.searchId);
      if (q) q.push(u); else this.queues.set(opts.searchId, [u]);
      this.pump();
    });
  }

  /** Drop every queued unit of a search (no provider request is spent). */
  cancelSearch(searchId: string): void {
    const q = this.queues.get(searchId);
    if (!q) return;
    this.queues.delete(searchId);
    for (const u of q) this.finishCancelled(u);
  }

  private refusal(reason: 'DAILY_RESERVE' | 'QUEUE_FULL', attempts: number, queuedMs: number) {
    const meta: SchedulerMeta = { attempts, retries: Math.max(0, attempts - 1), queuedMs, refused: reason };
    return { ok: false, error: { code: 'RATE_LIMITED', message: reason === 'DAILY_RESERVE' ? 'provider daily quota reserve reached' : 'same-train queue full', retryable: false },
      meta: { rateLimit: { local: true, reason }, scheduler: meta } };
  }

  private finishCancelled(u: Unit) {
    this.s.cancelled++;
    const meta: SchedulerMeta = { attempts: u.attempts, retries: Math.max(0, u.attempts - 1), queuedMs: this.now() - u.enqueuedAt, cancelled: true };
    u.resolve({ ok: false, error: { code: 'SCHEDULER_CANCELLED', message: 'cancelled before dispatch', retryable: false }, meta: { scheduler: meta } });
  }

  private wake(at: number) {
    if (at >= this.timerAt && this.timer) return;
    if (this.timer) clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => { this.timer = null; this.timerAt = Infinity; this.pump(); }, Math.max(0, at - this.now()));
  }

  /** Remove cancelled units everywhere (cheap; keeps cancelled searches from holding the round-robin). */
  private sweepCancelled() {
    for (const [id, q] of this.queues) {
      const keep: Unit[] = [];
      for (const u of q) { let c = false; try { c = !!u.cancelled?.(); } catch { c = true; } if (c) this.finishCancelled(u); else keep.push(u); }
      if (keep.length) this.queues.set(id, keep); else this.queues.delete(id);
    }
  }

  /** next ready unit: round-robin over searches, FIFO (first ready) inside a search. */
  private pick(t: number): { unit: Unit; nextAt: number } | { unit: null; nextAt: number } {
    const ids = [...this.queues.keys()];
    let nextAt = Infinity;
    for (let k = 0; k < ids.length; k++) {
      const idx = (this.rr + k) % ids.length;
      const q = this.queues.get(ids[idx])!;
      const i = q.findIndex(u => u.notBefore <= t);
      if (i >= 0) {
        const [unit] = q.splice(i, 1);
        if (!q.length) this.queues.delete(ids[idx]);
        // advance the pointer past this search (fair turn); deleting a search shifts later ids left by one
        this.rr = q.length ? idx + 1 : idx;
        return { unit, nextAt };
      }
      for (const u of q) nextAt = Math.min(nextAt, u.notBefore);
    }
    return { unit: null, nextAt };
  }

  private pump(): void {
    for (;;) {
      this.sweepCancelled();
      if (!this.queues.size || this.inFlight >= this.cfg.maxInFlight) return;
      const t = this.now();
      const limiter = this.paced() ? rateLimiterFor(this.provider) : null;
      if (limiter) {
        const g = limiter.backgroundCheck(this.policy);
        if (!g.ok) {
          // quota reserve → honest refusal of everything queued for this provider (no provider request spent)
          const all = [...this.queues.values()].flat();
          this.queues.clear();
          for (const u of all) { this.s.refusedDailyReserve++; u.resolve(this.refusal('DAILY_RESERVE', u.attempts, t - u.enqueuedAt)); }
          return;
        }
        if (g.at > t) { this.wake(g.at); return; }
      }
      const { unit, nextAt } = this.pick(t);
      if (!unit) { if (Number.isFinite(nextAt)) this.wake(nextAt); return; }
      if (limiter && !limiter.tryStartBackground(this.policy)) { this.queues.set(unit.searchId, [unit, ...(this.queues.get(unit.searchId) || [])]); this.wake(t + 50); return; }
      this.dispatch(unit, t);
    }
  }

  private dispatch(u: Unit, t: number) {
    u.attempts++;
    this.inFlight++;
    this.s.dispatched++;
    this.s.maxInFlightSeen = Math.max(this.s.maxInFlightSeen, this.inFlight);
    this.s.maxQueueWaitMs = Math.max(this.s.maxQueueWaitMs, t - u.enqueuedAt);
    let settled = false;
    let timedOut = false;
    const finish = (v: any) => {
      if (settled) return;
      settled = true;
      const retryable = timedOut || isRetryableAnswer(v);
      let cancelled = false;
      try { cancelled = !!u.cancelled?.(); } catch { cancelled = true; }
      if (retryable && u.attempts <= this.cfg.maxRetries && !cancelled) {
        // bounded exponential backoff; the limiter block (429 Retry-After / remaining=0) gates the retry as well
        this.s.retried++;
        u.notBefore = this.now() + Math.min(this.cfg.backoffMaxMs, this.cfg.backoffBaseMs * 2 ** (u.attempts - 1));
        this.queues.set(u.searchId, [u, ...(this.queues.get(u.searchId) || [])]);
        return;
      }
      this.s.completed++;
      const meta: SchedulerMeta = { attempts: u.attempts, retries: u.attempts - 1, queuedMs: t - u.enqueuedAt, ...(timedOut ? { timedOut: true } : {}) };
      if (timedOut) { this.s.timedOut++; u.resolve({ ok: false, error: { code: 'PROVIDER_TIMEOUT', message: 'provider call timed out', retryable: true }, meta: { scheduler: meta } }); return; }
      u.resolve(v && typeof v === 'object' ? { ...v, meta: { ...(v.meta || {}), scheduler: meta } } : v);
    };
    const timer = setTimeout(() => { timedOut = true; finish(undefined); this.pump(); }, this.cfg.callTimeoutMs);
    // the slot is already counted by the limiter → the adapter's pacer must not take a second one for this call
    Promise.resolve()
      .then(() => runWithHeldSlot(this.provider, u.run))
      .then(v => v, e => ({ ok: false, error: { code: String(e?.code || 'PROVIDER_ERROR'), message: 'provider call failed', retryable: false } }))
      .then(v => {
        clearTimeout(timer);
        // in-flight is released when the provider call REALLY settles (a timed-out call still occupies its slot)
        this.inFlight--;
        finish(v);
        this.pump();
      });
  }

  stats(): SchedulerStats {
    const lim = this.paced() ? rateLimiterFor(this.provider) : null;
    return { provider: this.provider, queued: this.queuedCount(), inFlight: this.inFlight, searches: this.queues.size, ...this.s,
      backgroundCap: lim ? lim.backgroundCap(this.policy) : null };
  }
}

const schedulers = new Map<string, SameTrainScheduler>();
let factory: ((provider: string) => SameTrainScheduler) | null = null;

/**
 * Process-wide scheduler of a provider. `paced:false` (development MOCK refs — no real provider quota, like the P42.9
 * pacer that never paces injected / mock adapters) keeps the queue, fairness, retries and timeouts without the limiter.
 */
export function sameTrainSchedulerFor(provider: string, opts: { paced?: boolean } = {}): SameTrainScheduler {
  const paced = opts.paced !== false;
  const key = paced ? provider : `${provider}#unpaced`;
  let s = schedulers.get(key);
  if (!s) {
    s = factory ? factory(provider) : paced ? new SameTrainScheduler(provider)
      : new SameTrainScheduler(provider, schedulerConfigFromEnv(), backgroundPolicyFromEnv(), () => Date.now(), () => false);
    schedulers.set(key, s);
  }
  return s;
}
/** tests: fresh schedulers (optional factory for injected config / clock / pacing). */
export function resetSameTrainSchedulers(f: ((provider: string) => SameTrainScheduler) | null = null): void { schedulers.clear(); factory = f; }
export function sameTrainSchedulerStats(): SchedulerStats[] { return [...schedulers.values()].map(s => s.stats()); }
