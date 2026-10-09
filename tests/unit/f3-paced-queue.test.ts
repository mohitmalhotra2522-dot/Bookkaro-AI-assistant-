/**
 * F3 — paced fair queue for automatic same-train searches (user spec #47, 2026-10-09).
 *
 * Fake clock (vitest fake timers drive Date + setTimeout for the limiter, the scheduler and the engine). Covers:
 *   rate-limit enforcement (background cap with safety margin, interactive headroom, held slot = one counted request),
 *   daily reserve, concurrent searches, fairness / no starvation, FIFO station order, retries + bounded backoff (no storm),
 *   provider timeouts, cancellation (no request spent), partial failures (never "complete"), genuine progress,
 *   request binding, completion of ALL eligible trains, and the async discovery job (polling never re-spends budget).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runSameTrainSearch, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery, type SameTrainProgress } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS, type SameTrainAlternativesResult } from '../../shared/same-train-alternatives';
import { SameTrainScheduler, isRetryableAnswer, type SchedulerConfig } from '../../server/railway/same-train/same-train-scheduler';
import { resetRateLimiters, rateLimiterFor, parseRateHeaders, runWithHeldSlot, consumeHeldSlot, type BackgroundPolicy } from '../../server/railway/providers/live/provider-rate-limiter';
import { RailCoreProvider } from '../../server/railway/providers/live/railcore-provider';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { discoverSameTrainForDisplay, discoverSameTrainForDisplayAsync } from '../../server/railway/same-train/same-train-session';

const DATE = '2026-10-12';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const ROUTE = Array.from({ length: 40 }, (_, i) => ({ station: `S${String(i).padStart(2, '0')}`, stationName: `Stop ${i}`, departure: `${String(i % 24).padStart(2, '0')}:10` }));
const POLICY: BackgroundPolicy = { share: 0.75, windowMs: 61_000, dailyReservePct: 25, dailyReserveMin: 20 };
const CFG: SchedulerConfig = { maxInFlight: 2, maxRetries: 2, backoffBaseMs: 2000, backoffMaxMs: 30_000, callTimeoutMs: 9000, maxQueued: 5000 };
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's1', turnId: null, requestId: null, journeyVersion: 1, trainNumber: '11906', trainName: 'HSX AGC EXP', date: DATE,
  travelClass: 'SL', classes: ['SL'], passengersCount: 2, origin: 'S20', destination: 'S25',
  originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false, terminalSweep: 'AUTO',
  providers: [RC], routeProvider: RC, webProviders: [], ...over
} as any);
const qKey = (q: AvailabilityQuery) => [q.trainNumber, q.travelClass, q.date, q.origin, q.destination, q.passengersCount].join('|');

function newScheduler(cfg: Partial<SchedulerConfig> = {}, policy: Partial<BackgroundPolicy> = {}) {
  return new SameTrainScheduler('railcore', { ...CFG, ...cfg }, { ...POLICY, ...policy }, () => Date.now(), () => true);
}
/** drive fake time until the promise settles */
async function drive<T>(p: Promise<T>, stepMs = 500, maxMs = 4 * 3600_000): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let t = 0; !done && t < maxMs; t += stepMs) await vi.advanceTimersByTimeAsync(stepMs);
  if (!done) throw new Error('did not settle');
  return p;
}
/** max number of starts inside any window of `w` ms */
const maxInWindow = (ts: number[], w: number) => { const s = [...ts].sort((a, b) => a - b); let m = 0; for (let i = 0, j = 0; i < s.length; i++) { while (s[i] - s[j] >= w) j++; m = Math.max(m, i - j + 1); } return m; };

type Answer = (q: AvailabilityQuery, attempt: number) => any;
const okAns = (status: (q: AvailabilityQuery) => string): Answer => q => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: status(q) } });
/** scheduled engine deps over a fake provider (every provider start is recorded with its time) */
function schedDeps(sched: SameTrainScheduler, answer: Answer, o: { isCurrent?: () => boolean; searchId?: string; starts?: number[]; onProgress?: (p: SameTrainProgress) => void } = {}) {
  const searchId = o.searchId || `s_${Math.random().toString(36).slice(2)}`;
  const starts = o.starts || [];
  const calls: { q: AvailabilityQuery; at: number; attempt: number }[] = [];
  const attempts = new Map<string, number>();
  const cancelled = (deadline?: number) => () => (o.isCurrent ? !o.isCurrent() : false) || (deadline !== undefined && Date.now() >= deadline);
  const deps: SameTrainDeps = {
    limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 9000, totalTimeoutMs: 3 * 3600_000 },
    scheduled: true,
    isCurrent: o.isCurrent,
    onProgress: o.onProgress,
    getRoute: () => sched.schedule({ searchId, cancelled: cancelled() }, async () => { starts.push(Date.now()); return { ok: true, data: ROUTE }; }),
    checkAvailability: (_p, q, ctx) => sched.schedule({ searchId, cancelled: cancelled(ctx?.deadline) }, async () => {
      starts.push(Date.now());
      const n = (attempts.get(qKey(q)) || 0) + 1;
      attempts.set(qKey(q), n);
      calls.push({ q: { ...q }, at: Date.now(), attempt: n });
      return answer(q, n);
    })
  };
  return { deps, calls, starts, searchId };
}
const resultOf = async (p: Promise<any>): Promise<SameTrainAlternativesResult> => { const r = await p; if (!r.ok) throw new Error(`expected ok, got ${r.code}`); return r.result; };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-09T06:00:00Z'));
  resetRateLimiters({ clock: () => Date.now(), config: { railcore: { perMinute: 20, minIntervalMs: 250, maxWaitMs: 1500 } } });
});
afterEach(() => { vi.useRealTimers(); resetRateLimiters(); });

describe('F3 [R] rate-limit enforcement — background cap with safety margin, interactive headroom', () => {
  it('[R1] 4 concurrent searches through the queue never exceed 15 starts in any 61 s window (20/min provider limit, 75 % share) and never 20 in 60 s', async () => {
    const sched = newScheduler();
    const starts: number[] = [];
    const runs = Array.from({ length: 4 }, (_, i) => schedDeps(sched, okAns(() => 'GNWL 9'), { starts, searchId: `T${i}` }));
    const all = Promise.all(runs.map((r, i) => runSameTrainSearch(REQ({ trainNumber: `1190${i}` }), r.deps)));
    await drive(all);
    expect(starts.length).toBeGreaterThan(100);
    expect(maxInWindow(starts, 61_000)).toBeLessThanOrEqual(15);
    expect(maxInWindow(starts, 60_000)).toBeLessThanOrEqual(20);
    // min interval honoured
    const s = [...starts].sort((a, b) => a - b);
    expect(s.slice(1).every((t, i) => t - s[i] >= 250)).toBe(true);
  });

  it('[R2] interactive calls keep headroom while the queue is saturated: 5 interactive acquires per minute succeed within their normal wait', async () => {
    const sched = newScheduler();
    const { deps } = schedDeps(sched, okAns(() => 'GNWL 9'));
    const search = runSameTrainSearch(REQ({ classes: ['SL', '3A', '2A'] }), deps);
    await vi.advanceTimersByTimeAsync(30_000);              // queue busy, background share used up
    const lim = rateLimiterFor('railcore');
    const got: boolean[] = [];
    for (let i = 0; i < 5; i++) { const p = lim.acquire(1500); await vi.advanceTimersByTimeAsync(1500); got.push((await p).ok); }
    expect(got).toEqual([true, true, true, true, true]);
    await drive(search);
    expect(lim.snapshot().localRejected).toBe(0);
  });

  it('[R3] background mode never reserves future slots and counts interactive starts against its share', async () => {
    const lim = rateLimiterFor('railcore');
    expect(lim.backgroundCap(POLICY)).toBe(15);
    for (let i = 0; i < 12; i++) { vi.advanceTimersByTime(300); expect(lim.tryStartBackground(POLICY)).toBe(true); }
    // 3 interactive starts → 15 in the window → background must wait for the window, interactive still has 5
    for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(300); expect((await lim.acquire(0)).ok).toBe(true); }
    vi.advanceTimersByTime(300);
    expect(lim.tryStartBackground(POLICY)).toBe(false);
    const g = lim.backgroundCheck(POLICY);
    expect(g.ok && g.at > Date.now()).toBe(true);
    expect(lim.snapshot().backgroundStarted).toBe(12);
  });

  it('[R4] a queue slot is ONE counted provider request: a paced RailCore adapter inside the queue does not take a second slot', async () => {
    vi.useRealTimers();
    resetRateLimiters({ paceInjectedFetch: true, config: { railcore: { perMinute: 20, minIntervalMs: 0, maxWaitMs: 0 } } });
    let http = 0;
    const fetchImpl = vi.fn(async () => {
      http++;
      const body = { success: true, data: { train_number: '12926', journey_date: DATE, quota: 'GN', classes: [{ class_code: '3A', status: 'AVAILABLE', available_count: 5 }] }, meta: { freshness: { mode: 'live', retrieved_at: new Date().toISOString() } } };
      return { status: 200, text: async () => JSON.stringify(body), headers: { get: (_: string) => null } };
    });
    const p = new RailCoreProvider({ apiKey: 'rk_test_dummy', baseUrl: 'https://rc.test/v1', timeoutMs: 1000, fetchImpl: fetchImpl as any });
    const sched = new SameTrainScheduler('railcore', CFG, POLICY, () => Date.now(), () => true);
    const out = await Promise.all(Array.from({ length: 15 }, () => sched.schedule({ searchId: 'x' },
      () => p.checkAvailability({ trainNumber: '12926', travelClass: '3A', date: DATE, origin: 'JUC', destination: 'NDLS' } as any))));
    expect(out.every((r: any) => r.ok)).toBe(true);
    expect(http).toBe(15);
    const snap = rateLimiterFor('railcore').snapshot();
    expect(snap.started).toBe(15);                       // not 30 — the adapter consumed the held slot
    expect(snap.backgroundStarted).toBe(15);
    expect(snap.localRejected).toBe(0);
    // the held slot covers exactly one request of one provider
    await runWithHeldSlot('railcore', async () => { expect(consumeHeldSlot('railradar')).toBe(false); expect(consumeHeldSlot('railcore')).toBe(true); expect(consumeHeldSlot('railcore')).toBe(false); });
    expect(consumeHeldSlot('railcore')).toBe(false);
  });
});

describe('F3 [Q] daily quota reserve', () => {
  it('[Q1] provider day-limit header is parsed; at the interactive reserve the queue stops spending and fails honestly (DAILY_RESERVE), interactive still allowed', async () => {
    const h = parseRateHeaders(n => ({ 'x-railcore-ratelimit-day-remaining': '22', 'x-railcore-ratelimit-day-limit': '80' } as any)[n] ?? null);
    expect(h).toMatchObject({ longRemaining: 22, longLimit: 80 });
    expect(parseRateHeaders(n => ({ 'x-ratelimit-remaining-month': '400', 'x-ratelimit-limit-month': '1000' } as any)[n] ?? null)).toMatchObject({ longRemaining: 400, longLimit: 1000 });
    const lim = rateLimiterFor('railcore');
    lim.observe(200, h);
    expect(lim.longReserve(POLICY)).toBe(20);              // max(20, 25 % of 80)
    const sched = newScheduler();
    let provider = 0;
    const out = await drive(Promise.all(Array.from({ length: 5 }, () => sched.schedule({ searchId: 'q' }, async () => { provider++; return { ok: true }; }))));
    expect(provider).toBe(2);                              // 22 → 20 = reserve
    const refused = out.filter((r: any) => r.ok === false);
    expect(refused).toHaveLength(3);
    for (const r of refused) { expect(r.error.code).toBe('RATE_LIMITED'); expect(r.meta.rateLimit).toMatchObject({ local: true, reason: 'DAILY_RESERVE' }); expect(isRetryableAnswer(r)).toBe(false); }
    expect((await lim.acquire(1500)).ok).toBe(true);       // the reserve is for interactive use
    expect(sched.stats().refusedDailyReserve).toBe(3);
  });
});

describe('F3 [F] fairness, FIFO station order, concurrent searches', () => {
  it('[F1] round-robin across searches: a big search submitted first does not starve two small ones; FIFO inside each search', async () => {
    const sched = newScheduler();
    const order: string[] = [];
    const sub = (id: string, n: number) => Array.from({ length: n }, (_, i) => sched.schedule({ searchId: id }, async () => { order.push(`${id}${i}`); return { ok: true }; }));
    const all = [...sub('A', 30), ...sub('B', 5), ...sub('C', 5)];
    await drive(Promise.all(all));
    // A0 starts at once (alone), A1 was queued before B / C existed; from then on strict A / B / C turns → B and C are
    // finished inside the first 16 starts although A had 30 units queued ahead of them
    expect(order.slice(0, 16)).toEqual(['A0', 'A1', 'B0', 'C0', 'A2', 'B1', 'C1', 'A3', 'B2', 'C2', 'A4', 'B3', 'C3', 'A5', 'B4', 'C4']);
    for (const id of ['A', 'B', 'C']) { const mine = order.filter(x => x.startsWith(id)); expect(mine).toEqual([...mine].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))); }
    expect(order).toHaveLength(40);
  });

  it('[F2] a search that arrives later gets its turn at once (no starvation behind a long queue)', async () => {
    const sched = newScheduler();
    const order: string[] = [];
    const a = Array.from({ length: 40 }, (_, i) => sched.schedule({ searchId: 'A' }, async () => { order.push(`A${i}`); return { ok: true }; }));
    await vi.advanceTimersByTimeAsync(70_000);
    const before = order.length;
    const d = Array.from({ length: 3 }, (_, i) => sched.schedule({ searchId: 'D' }, async () => { order.push(`D${i}`); return { ok: true }; }));
    await drive(Promise.all([...a, ...d]));
    const firstD = order.indexOf('D0');
    expect(firstD).toBeLessThanOrEqual(before + 1);
    expect(order.indexOf('D2') - firstD).toBeLessThanOrEqual(5);
  });

  it('[F3] the engine hands units to the queue in station order (same order as the unscheduled P42-14 search) with the exact request binding', async () => {
    const sched = newScheduler();
    const { deps, calls } = schedDeps(sched, okAns(() => 'GNWL 9'));
    await drive(resultOf(runSameTrainSearch(REQ({ classes: ['SL', '3A'] }), deps)));
    const unsched: AvailabilityQuery[] = [];
    const plain: SameTrainDeps = { limits: { ...SAME_TRAIN_DEFAULT_LIMITS, maxParallel: 1, perCallTimeoutMs: 9000, totalTimeoutMs: 3600_000 },
      getRoute: async () => ({ ok: true, data: ROUTE }), checkAvailability: async (_p, q) => { unsched.push(q); return okAns(() => 'GNWL 9')(q, 1); } };
    await resultOf(runSameTrainSearch(REQ({ classes: ['SL', '3A'] }), plain));
    expect(calls.map(c => qKey(c.q))).toEqual(unsched.map(qKey));
    // nearby earlier stations first, back to the train origin side, then beyond the destination, then up to the terminal
    const sl = calls.filter(c => c.q.travelClass === 'SL').map(c => c.q);
    const earlier = sl.filter(q => q.origin !== 'S20').map(q => Number(q.origin.slice(1)));
    expect(earlier).toEqual([...earlier].sort((x, y) => y - x));
    for (const c of calls) expect(c.q).toMatchObject({ trainNumber: '11906', date: DATE, passengersCount: 2 });
    expect(new Set(calls.map(c => c.q.travelClass))).toEqual(new Set(['SL', '3A']));
  });

  it('[F4] COMPLETION OF ALL ELIGIBLE TRAINS: 6 waitlisted trains searched concurrently → every search completes every planned check (no RATE_LIMITED, searchComplete)', async () => {
    const sched = newScheduler();
    const starts: number[] = [];
    const runs = Array.from({ length: 6 }, (_, i) => schedDeps(sched, okAns(q => (q.origin === 'S12' ? 'AVAILABLE-0004' : 'GNWL 9')), { starts, searchId: `W${i}` }));
    const results = await drive(Promise.all(runs.map((r, i) => resultOf(runSameTrainSearch(REQ({ trainNumber: `1290${i}` }), r.deps)))));
    for (const r of results) {
      expect(r.searchComplete).toBe(true);
      expect(r.status).toBe('OK');
      expect(r.checkSummary).toMatchObject({ failed: 0, skipped: 0, paced: true });
      expect(r.checkSummary!.succeeded).toBe(r.availabilityChecks);
      expect(r.alternatives.some(a => a.ticketOrigin === 'S12' && a.availability === 'AVAILABLE')).toBe(true);
      expect(r.alternatives.flatMap(a => a.evidence).some(e => e.errorCode === 'RATE_LIMITED')).toBe(false);
    }
    expect(maxInWindow(starts, 61_000)).toBeLessThanOrEqual(15);
  });

  it('[F5] control: the same 6 searches on the P42.9 path (1 s pacer wait, no queue) lose checks to the local rate limit', async () => {
    const lim = rateLimiterFor('railcore');
    const plain = (): SameTrainDeps => ({ limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 9000, totalTimeoutMs: 45_000 },
      getRoute: async () => ({ ok: true, data: ROUTE }),
      checkAvailability: async (_p, q) => { const s = await lim.acquire(1000); return s.ok ? okAns(() => 'GNWL 9')(q, 1) : { ok: false, error: { code: 'RATE_LIMITED' }, meta: { rateLimit: { local: true } } }; } });
    const results = await drive(Promise.all(Array.from({ length: 6 }, (_, i) => runSameTrainSearch(REQ({ trainNumber: `1290${i}` }), plain()))));
    expect(results.some((r: any) => !r.ok || r.result.status === 'PARTIAL')).toBe(true);
  });
});

describe('F3 [B] retries, backoff, timeouts — no retry storm', () => {
  it('[B1] provider 429 / 5xx-type answers are retried at most 2× with exponential backoff (2 s, 4 s); the retried unit keeps its place', async () => {
    const sched = newScheduler();
    const at: number[] = [];
    const r: any = await drive(sched.schedule({ searchId: 'b' }, async () => { at.push(Date.now()); return at.length < 3 ? { ok: false, error: { code: 'RATE_LIMITED' }, meta: { rateLimit: { local: false } } } : { ok: true, data: 1 }; }));
    expect(r.ok).toBe(true);
    expect(r.meta.scheduler).toMatchObject({ attempts: 3, retries: 2 });
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(2000);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(4000);
    let n = 0;
    const bad: any = await drive(sched.schedule({ searchId: 'b' }, async () => { n++; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }; }));
    expect(n).toBe(3);
    expect(bad).toMatchObject({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' }, meta: { scheduler: { attempts: 3, retries: 2 } } });
    let m = 0;
    await drive(sched.schedule({ searchId: 'b' }, async () => { m++; return { ok: false, error: { code: 'NOT_FOUND' } }; }));
    expect(m).toBe(1);                                    // a provider verdict is never retried
  });

  it('[B2] no storm: a provider 429 with Retry-After blocks the whole queue until the retry time; total attempts bounded', async () => {
    const sched = newScheduler();
    const lim = rateLimiterFor('railcore');
    const at: number[] = [];
    let first429: number | null = null;
    const units = Array.from({ length: 10 }, () => sched.schedule({ searchId: 'st' }, async () => {
      at.push(Date.now());
      lim.observe(429, { retryAfterMs: 10_000 });          // what the adapter's pacer does with a real 429
      if (first429 === null) first429 = Date.now();
      return { ok: false, error: { code: 'RATE_LIMITED' }, meta: { rateLimit: { local: false } } };
    }));
    const out = await drive(Promise.all(units));
    expect(out.every((r: any) => r.ok === false && r.error.code === 'RATE_LIMITED')).toBe(true);
    expect(at.length).toBeLessThanOrEqual(30);            // 10 units × (1 + 2 retries)
    expect(at.filter(t => t > first429! && t < first429! + 10_000)).toHaveLength(0);
    expect(maxInWindow(at, 61_000)).toBeLessThanOrEqual(15);
  });

  it('[B3] the per-call timeout covers the provider call only (queue wait never times a call out); a hung call is retried then reported as TIMEOUT', async () => {
    const sched = newScheduler({ maxRetries: 1 });
    // 30 queued units → the last ones wait far longer than the 9 s call timeout and still succeed
    const quick = Array.from({ length: 30 }, () => sched.schedule({ searchId: 'q' }, async () => ({ ok: true })));
    const out = await drive(Promise.all(quick));
    expect(out.every((r: any) => r.ok === true)).toBe(true);
    expect(Math.max(...out.map((r: any) => r.meta.scheduler.queuedMs))).toBeGreaterThan(9000);
    let calls = 0;
    const hung: any = await drive(sched.schedule({ searchId: 'h' }, () => { calls++; return new Promise(res => setTimeout(() => res({ ok: true }), 20_000)); }));
    expect(calls).toBe(2);
    expect(hung).toMatchObject({ ok: false, error: { code: 'PROVIDER_TIMEOUT' }, meta: { scheduler: { timedOut: true, attempts: 2 } } });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sched.stats().inFlight).toBe(0);
  });
});

describe('F3 [C] cancellation and partial failures', () => {
  it('[C1] journey superseded mid-search → queued checks are dropped without a provider request; result is STALE (never complete)', async () => {
    const sched = newScheduler();
    let current = true;
    const { deps, calls } = schedDeps(sched, okAns(() => 'GNWL 9'), { isCurrent: () => current });
    const run = runSameTrainSearch(REQ({ classes: ['SL', '3A'] }), deps);
    await vi.advanceTimersByTimeAsync(20_000);
    current = false;
    const sent = calls.length;
    const out: any = await drive(run);
    expect(out).toMatchObject({ ok: false, code: 'STALE_ALTERNATIVE_RESULT' });
    expect(calls.length).toBeLessThanOrEqual(sent + CFG.maxInFlight);
    expect(sched.stats().cancelled).toBeGreaterThan(10);
    // explicit cancelSearch drops a search's queue
    const s2 = newScheduler();
    let ran = 0;
    const ps = Array.from({ length: 30 }, () => s2.schedule({ searchId: 'z' }, async () => { ran++; return { ok: true }; }));
    await vi.advanceTimersByTimeAsync(1000);
    s2.cancelSearch('z');
    const res = await drive(Promise.all(ps));
    expect(res.filter((r: any) => r.error?.code === 'SCHEDULER_CANCELLED').length).toBe(30 - ran);
  });

  it('[C2] persistent provider errors on some stations → PARTIAL with honest counts (never NOT_FOUND / complete); retries recorded per check', async () => {
    const sched = newScheduler();
    const { deps } = schedDeps(sched, (q, _n) => (q.origin === 'S17' || q.origin === 'S14' ? { ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } } : okAns(() => 'GNWL 9')(q, 1)));
    const r = await drive(resultOf(runSameTrainSearch(REQ(), deps)));
    expect(r.status).toBe('PARTIAL');
    expect(r.searchComplete).toBe(false);
    expect(r.errors).not.toContain('NOT_FOUND' as any);
    expect(r.checkSummary).toMatchObject({ failed: 2, skipped: 0, paced: true });
    expect(r.checkSummary!.retried).toBe(4);
    const failedEv = r.alternatives.flatMap(a => a.evidence).filter(e => e.outcome !== 'SUCCESS');
    expect(failedEv.every(e => e.retryCount === 2 && e.errorCode === 'PROVIDER_UNAVAILABLE')).toBe(true);
  });

  it('[C3] search deadline passes while units are queued → they are SKIPPED (SEARCH_TIMEOUT), not sent, and the result is not complete', async () => {
    const sched = newScheduler();
    const { deps, calls } = schedDeps(sched, okAns(() => 'GNWL 9'));
    deps.limits = { ...deps.limits, totalTimeoutMs: 60_000 };
    const r = await drive(resultOf(runSameTrainSearch(REQ({ classes: ['SL', '3A'] }), deps)));
    expect(r.searchComplete).toBe(false);
    expect(r.status).toBe('PARTIAL');
    expect(r.checkSummary!.skipped).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(r.availabilityChecks!);
  });
});

describe('F3 [P] genuine progress', () => {
  it('[P1] progress counts real outcomes: monotonic, done reaches total, interim seats appear before completion; stages ROUTE → CHECKING → FINALIZING', async () => {
    const sched = newScheduler();
    const snaps: SameTrainProgress[] = [];
    const { deps } = schedDeps(sched, okAns(q => (q.origin === 'S18' ? 'RAC 3' : 'GNWL 9')), { onProgress: p => snaps.push(p) });
    const r = await drive(resultOf(runSameTrainSearch(REQ(), deps)));
    expect(snaps[0].stage).toBe('ROUTE');
    expect(snaps[snaps.length - 1].stage).toBe('FINALIZING');
    for (let i = 1; i < snaps.length; i++) { expect(snaps[i].done).toBeGreaterThanOrEqual(snaps[i - 1].done); expect(snaps[i].done).toBeLessThanOrEqual(snaps[i].total); }
    const last = snaps[snaps.length - 1];
    expect(last.done).toBe(last.total);
    expect(last.total).toBe(r.availabilityChecks);
    const firstFound = snaps.findIndex(s => s.found.length > 0);
    expect(firstFound).toBeGreaterThan(0);
    expect(snaps[firstFound].done).toBeLessThan(snaps[firstFound].total);
    expect(snaps[firstFound].found[0]).toMatchObject({ ticketOrigin: 'S18', travelClass: 'SL', status: 'RAC 3' });
  });
});

describe('F3 [J] async discovery job (polling)', () => {
  function sessionWith(classes: Array<[string, string]>) {
    const state = new ConversationStateManager();
    const s: any = state.createSession();
    Object.assign(s, { origin: 'S20', destination: 'S25', date: DATE, passengersCount: 1, searchResultsVersion: 1, journeyVersion: 1,
      searchResults: { version: 1, retrievedAt: new Date().toISOString(), journey: { origin: 'S20', destination: 'S25', date: DATE },
        trains: [{ trainNumber: '11906', trainName: 'HSX AGC EXP', classes: classes.map(([code, availability]) => ({ code, availability })) },
          { trainNumber: '12426', trainName: 'JAT NDLS EXP', classes: classes.map(([code, availability]) => ({ code, availability })) }] } });
    return { state, sid: s.sessionId as string, s };
  }
  const ENV = { SAME_TRAIN_ALTERNATIVES_ENABLED: '1' } as any;

  it('[J1] RUNNING + genuine progress while queued; polls never start a second search or spend budget; the final poll returns the result', async () => {
    const a = sessionWith([['SL', 'WL 16']]);
    const sched = newScheduler();
    const { deps, calls } = schedDeps(sched, okAns(q => (q.origin === 'S15' ? 'AVAILABLE-0002' : 'GNWL 9')));
    const body = { trainNumber: '11906', searchResultsVersion: 1 };
    const poll = () => drive(discoverSameTrainForDisplayAsync(a.state, a.sid, body, { deps, env: ENV, waitMs: 0 }), 1);
    const first = await poll();
    expect(first).toMatchObject({ ok: true, code: 'RUNNING' });
    expect(first.progress).toMatchObject({ state: 'QUEUED' });
    await vi.advanceTimersByTimeAsync(40_000);
    const mid = await poll();
    expect(mid.code).toBe('RUNNING');
    expect(mid.progress!.done).toBeGreaterThan(0);
    expect(mid.progress!.state).toBe('RUNNING');
    expect(a.s.sameTrainAutoBudget).toEqual({ version: 1, used: 1 });
    let fin: any = mid;
    for (let i = 0; i < 200 && fin.code === 'RUNNING'; i++) { await vi.advanceTimersByTimeAsync(2500); fin = await poll(); }
    expect(fin).toMatchObject({ ok: true, code: 'OK' });
    expect(fin.result.searchComplete).toBe(true);
    expect(a.s.sameTrainAutoBudget).toEqual({ version: 1, used: 1 });
    const n = calls.length;
    expect((await poll()).result?.alternativeSearchId).toBe(fin.result.alternativeSearchId);
    expect(calls.length).toBe(n);
  }, 60_000);

  it('[J2] a failed search is remembered for pollers (no silent re-run); the synchronous endpoint behaviour is unchanged', async () => {
    const a = sessionWith([['SL', 'WL 16']]);
    let routeCalls = 0;
    const deps: SameTrainDeps = { limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 150, totalTimeoutMs: 3000 },
      getRoute: async () => { routeCalls++; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }; },
      checkAvailability: async () => ({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }) };
    const body = { trainNumber: '12426', searchResultsVersion: 1 };
    const f1 = await drive(discoverSameTrainForDisplayAsync(a.state, a.sid, body, { deps, env: ENV, waitMs: 50 }));
    expect(f1).toMatchObject({ ok: false, code: 'SEARCH_FAILED' });
    const f2 = await drive(discoverSameTrainForDisplayAsync(a.state, a.sid, body, { deps, env: ENV, waitMs: 0 }), 1);
    expect(f2).toMatchObject({ ok: false, code: 'SEARCH_FAILED' });
    expect(routeCalls).toBe(1);
    const sync = await drive(discoverSameTrainForDisplay(a.state, a.sid, body, { deps, env: ENV }));
    expect(sync.code).toBe('SEARCH_FAILED');
  });
});
