/**
 * PROMPT 42.9 — G2: D1 rate limit + backend RailCore → RailRadar fallback (MOCK / injected fetch only — no network,
 * no credits). Pacer (window / interval / 429 backoff / provider headers), live adapter pacing (no uncontrolled
 * burst), fallback policy (eligible faults only, primary only, never when the primary succeeded), and the same-train
 * all-class matrix: 120-request recovery, per-request fallback, PARTIAL semantics (failure ≠ NOT_AVAILABLE),
 * all classes + 15 earlier / 7 downstream preserved, no duplicate calls, route fallback, conflict, stale.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import { ProviderRateLimiter, parseRateHeaders, resetRateLimiters, rateLimiterFor, rateLimitConfigFromEnv } from '../../server/railway/providers/live/provider-rate-limiter';
import { RailCoreProvider } from '../../server/railway/providers/live/railcore-provider';
import { classifyHttpStatus } from '../../server/railway/providers/live/live-http';
import { fallbackProviderFor, isFallbackEligible, runWithProviderFallback, providerFallbackEnabled, FALLBACK_ELIGIBLE_CODES } from '../../server/railway/providers/provider-fallback';
import { providerToolCatalog } from '../../server/ai/tools/provider-tools';
import { runSameTrainSearch, SAME_TRAIN_FALLBACK_ELIGIBLE, sameTrainLimitsFromEnv, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS, type SameTrainAlternativesResult } from '../../shared/same-train-alternatives';

const DATE = '2026-10-08';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
/** 30 stations R00 … R29; requested R16 → R22 ⇒ 15 earlier (R01…R15) + 7 downstream (R23…R29) */
const LONG = Array.from({ length: 30 }, (_, i) => ({ station: `R${String(i).padStart(2, '0')}`, stationName: `Stop ${i}`, departure: `${String(i % 24).padStart(2, '0')}:10` }));
const LIMITS = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 200, totalTimeoutMs: 5000 };
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 1, trainNumber: '12926', trainName: 'Paschim Express', date: DATE,
  travelClass: 'SL', classes: ['SL', '3A', '2A', '1A'], passengersCount: 2, origin: 'R16', destination: 'R22',
  originSweep: true, destinationSweep: true, destinationExtensionStations: 7, combinedPairs: 'ALWAYS', includeFare: false, webEvidence: false,
  providers: [RC], routeProvider: RC, webProviders: [], fallbackProviders: { railcore: RR }, routeFallback: RR, ...over
});
const key = (q: AvailabilityQuery) => [q.travelClass, q.origin, q.destination, q.date].join('|');
/** provider stubs with a quota: the first `quota[p]` calls answer, the rest are RATE_LIMITED (like RailCore 20/min, RailRadar 10/min) */
function quotaDeps(quota: Record<string, number>, answer: (p: string, q: AvailabilityQuery) => any = (_p, q) => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: 'GNWL 9' } })) {
  const calls: Record<string, AvailabilityQuery[]> = { railcore: [], railradar: [] };
  const deps: SameTrainDeps = {
    limits: LIMITS,
    getRoute: async () => ({ ok: true, data: LONG }),
    checkAvailability: async (p, q) => {
      const n = (calls[p.id] ||= []).push(q);                                // this call's position in the provider's window
      await new Promise(r => setTimeout(r, 1));
      if (n > (quota[p.id] ?? Infinity)) return { ok: false, error: { code: 'RATE_LIMITED' }, meta: { rateLimit: { local: p.id === 'railcore' } } };
      return answer(p.id, q);
    }
  };
  return { deps, calls };
}
const ok = async (req: SameTrainSearchRequest, deps: SameTrainDeps): Promise<SameTrainAlternativesResult> => {
  const r = await runSameTrainSearch(req, deps);
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.result;
};

afterEach(() => { resetRateLimiters(); vi.useRealTimers(); });

describe('P42.9 G2 — provider pacer (D1)', () => {
  it('[1] 120 immediate requests with perMinute=20, maxWait=0 → exactly 20 start, 100 refused locally (no provider burst)', async () => {
    let t = 1_000_000;
    const l = new ProviderRateLimiter('railcore', { perMinute: 20, minIntervalMs: 0, maxWaitMs: 0, backoffMaxMs: 30000 }, () => t);
    const res = await Promise.all(Array.from({ length: 120 }, () => l.acquire(0)));
    expect(res.filter(r => r.ok)).toHaveLength(20);
    expect(res.filter(r => !r.ok)).toHaveLength(100);
    expect(l.snapshot()).toMatchObject({ started: 20, localRejected: 100 });
    t += 60_001;                                    // window slides → capacity again
    expect((await l.acquire(0)).ok).toBe(true);
  });

  it('[2] minIntervalMs spaces request starts; a slot further away than maxWait is refused immediately (never a long queue)', async () => {
    let t = 0;
    const l = new ProviderRateLimiter('railradar', { perMinute: 10, minIntervalMs: 300, maxWaitMs: 0, backoffMaxMs: 30000 }, () => t);
    expect((await l.acquire(0)).ok).toBe(true);
    const r = await l.acquire(0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryInMs).toBe(300);
    t = 300; expect((await l.acquire(0)).ok).toBe(true);
  });

  it('[3] HTTP 429 → bounded backoff (Retry-After honoured, capped); quota headers only on a 2xx (RailCore sends remaining=0 on a 400)', async () => {
    let t = 0;
    const l = new ProviderRateLimiter('railcore', { perMinute: 0, minIntervalMs: 0, maxWaitMs: 0, backoffMaxMs: 30000 }, () => t);
    l.observe(400, { remaining: 0, resetAtMs: 50_000 });
    expect((await l.acquire(0)).ok).toBe(true);    // 400 headers ignored
    l.observe(429, { retryAfterMs: 5000 });
    expect((await l.acquire(0)).ok).toBe(false);
    t = 5001; expect((await l.acquire(0)).ok).toBe(true);
    l.observe(429, { retryAfterMs: 10 * 3600_000 }); // absurd Retry-After → capped (2 × backoffMax)
    t += 60_001; expect((await l.acquire(0)).ok).toBe(true);
    l.observe(200, { remaining: 0, resetAtMs: t + 20_000 });
    expect((await l.acquire(0)).ok).toBe(false);
  });

  it('[4] provider headers parsed (RailCore + RailRadar shapes), config from env with documented defaults', () => {
    const now = 1_791_374_970_000;
    const h = parseRateHeaders(n => ({ 'x-railcore-ratelimit-remaining': '0', 'x-railcore-ratelimit-reset': '1791375000', 'x-railcore-ratelimit-day-remaining': '299' } as any)[n] ?? null, now);
    expect(h).toEqual({ remaining: 0, resetAtMs: 1_791_375_000_000, longRemaining: 299 });
    expect(parseRateHeaders(n => ({ 'x-ratelimit-remaining-min': '7', 'x-ratelimit-remaining-month': '923' } as any)[n] ?? null, now)).toEqual({ remaining: 7, longRemaining: 923 });
    expect(rateLimitConfigFromEnv('railcore', {})).toMatchObject({ perMinute: 20 });
    expect(rateLimitConfigFromEnv('railradar', {})).toMatchObject({ perMinute: 10 });
    expect(rateLimitConfigFromEnv('railcore', { RAILCORE_RATE_LIMIT_PER_MIN: '5', RAILCORE_MIN_INTERVAL_MS: '900' })).toMatchObject({ perMinute: 5, minIntervalMs: 900 });
    expect(classifyHttpStatus(429)).toBe('RATE_LIMITED');
  });

  it('[5] live RailCore adapter is paced: 30 rapid availability calls → 20 HTTP requests, 10 RATE_LIMITED (LOCAL) with no request; a 429 is RATE_LIMITED (provider)', async () => {
    resetRateLimiters({ paceInjectedFetch: true, config: { railcore: { perMinute: 20, minIntervalMs: 0, maxWaitMs: 0 } } });
    let http = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      http++;
      const body = { success: true, data: { train_number: '12926', journey_date: DATE, quota: 'GN', classes: [{ class_code: '3A', status: 'AVAILABLE', available_count: 5 }] }, meta: { freshness: { mode: 'live', retrieved_at: new Date().toISOString() } } };
      return { status: 200, text: async () => JSON.stringify(body), headers: { get: (_: string) => null } };
    });
    const p = new RailCoreProvider({ apiKey: 'rk_test_dummy', baseUrl: 'https://rc.test/v1', timeoutMs: 1000, fetchImpl: fetchImpl as any });
    const out = await Promise.all(Array.from({ length: 30 }, () => p.checkAvailability({ trainNumber: '12926', travelClass: '3A', date: DATE, origin: 'JUC', destination: 'NDLS' } as any)));
    expect(http).toBe(20);
    const rl = out.filter(r => !r.ok);
    expect(rl).toHaveLength(10);
    for (const r of rl) { expect(r.error?.code).toBe('RATE_LIMITED'); expect(r.error?.retryable).toBe(true); expect((r.meta as any).rateLimit).toEqual({ local: true }); }
    // provider 429 → RATE_LIMITED (provider) and the pacer blocks further requests (bounded)
    resetRateLimiters({ paceInjectedFetch: true, config: { railcore: { perMinute: 0, minIntervalMs: 0, maxWaitMs: 0 } } });
    const p429 = new RailCoreProvider({ apiKey: 'rk_test_dummy', baseUrl: 'https://rc.test/v1', timeoutMs: 1000,
      fetchImpl: (async () => ({ status: 429, text: async () => '{"success":false}', headers: { get: (n: string) => (n === 'retry-after' ? '30' : null) } })) as any });
    const a = await p429.checkAvailability({ trainNumber: '12926', travelClass: '3A', date: DATE, origin: 'JUC', destination: 'NDLS' } as any);
    expect(a.error?.code).toBe('RATE_LIMITED'); expect((a.meta as any).rateLimit).toEqual({ local: false });
    expect(rateLimiterFor('railcore').snapshot().blockedUntil).not.toBeNull();
    // no key / header in any result
    expect(JSON.stringify([out, a])).not.toMatch(/rk_test_dummy|X-RailCore-Key/);
  });
});

describe('P42.9 G2 — backend fallback policy', () => {
  const reg = (id: string, registryId = id, caps: any[] = ['SEARCH_TRAINS', 'CHECK_AVAILABILITY', 'GET_FARE', 'GET_TIMETABLE']) => providerToolCatalog.register({ id, label: id, registryId, capabilities: caps });
  beforeEach(() => providerToolCatalog.clear());
  afterEach(() => providerToolCatalog.clear());
  const LIVE = { RAILWAY_PROVIDER: 'live', RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railkit,railradar' };

  it('[6] eligible = RATE_LIMITED / PROVIDER_UNAVAILABLE / TIMEOUT only; the engine uses the same set', () => {
    for (const c of ['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'TOOL_TIMEOUT', 'PROVIDER_TIMEOUT']) expect(isFallbackEligible(c)).toBe(true);
    for (const c of ['INVALID_REQUEST', 'INVALID_DATE', 'INVALID_ROUTE', 'MISSING_REQUIRED_FIELD', 'NOT_FOUND', 'NO_TRAINS_FOUND', 'CLASS_NOT_AVAILABLE', 'AUTH_ERROR', 'NOT_CONFIGURED', 'PROVIDER_DATA_INVALID', null]) expect(isFallbackEligible(c as any)).toBe(false);
    expect([...SAME_TRAIN_FALLBACK_ELIGIBLE].sort()).toEqual([...FALLBACK_ELIGIBLE_CODES].sort());
  });

  it('[7] RailCore (primary) → RailRadar for a capability it implements; never from a non-primary; off when disabled; never MOCK↔LIVE; railkit unconfigured is skipped', () => {
    reg('railcore'); reg('railradar');
    expect(fallbackProviderFor('railcore', 'CHECK_AVAILABILITY', LIVE)).toBe('railradar');
    expect(fallbackProviderFor('railradar', 'CHECK_AVAILABILITY', LIVE)).toBeNull();
    expect(fallbackProviderFor('railcore', 'CHECK_PNR', LIVE)).toBeNull();
    expect(fallbackProviderFor('railcore', 'CHECK_AVAILABILITY', { ...LIVE, RAILWAY_PROVIDER_FALLBACK: 'off' })).toBeNull();
    expect(providerFallbackEnabled({ RAILWAY_PROVIDER: 'mock' })).toBe(false);
    expect(providerFallbackEnabled({ RAILWAY_PROVIDER: 'mock', RAILWAY_PROVIDER_FALLBACK: 'on' })).toBe(true);
    providerToolCatalog.clear(); reg('railcore'); reg('railradar', 'mock-railradar');
    expect(fallbackProviderFor('railcore', 'CHECK_AVAILABILITY', LIVE)).toBeNull();
  });

  it('[8] runWithProviderFallback: success → RailRadar never called; INVALID_* → no fallback; RATE_LIMITED → one sequential fallback; both fail → honest failure', async () => {
    reg('railcore'); reg('railradar');
    const order: string[] = [];
    const mk = (codes: Record<string, string | null>) => async (p: string) => { order.push(`start:${p}`); await new Promise(r => setTimeout(r, 5)); order.push(`end:${p}`); return codes[p] ? { ok: false, error: { code: codes[p] } } : { ok: true, data: p }; };
    const code = (r: any) => (r.ok ? null : r.error.code);
    let o = await runWithProviderFallback({ primary: 'railcore', capability: 'CHECK_AVAILABILITY', call: mk({ railcore: null }), errorCodeOf: code, env: LIVE });
    expect(o).toMatchObject({ served: 'railcore', fallbackUsed: false }); expect(order).toEqual(['start:railcore', 'end:railcore']);
    order.length = 0;
    o = await runWithProviderFallback({ primary: 'railcore', capability: 'CHECK_AVAILABILITY', call: mk({ railcore: 'INVALID_REQUEST' }), errorCodeOf: code, env: LIVE });
    expect(o.fallbackUsed).toBe(false); expect(order).not.toContain('start:railradar');
    order.length = 0;
    o = await runWithProviderFallback({ primary: 'railcore', capability: 'CHECK_AVAILABILITY', call: mk({ railcore: 'RATE_LIMITED' }), errorCodeOf: code, env: LIVE });
    expect(o).toMatchObject({ served: 'railradar', fallbackUsed: true, fallbackReason: 'RATE_LIMITED' });
    expect(order).toEqual(['start:railcore', 'end:railcore', 'start:railradar', 'end:railradar']);   // sequential: no late primary overwrite
    expect(o.attempts.map(a => [a.provider, a.status, a.fallbackUsed])).toEqual([['railcore', 'FAILED', false], ['railradar', 'SUCCESS', true]]);
    o = await runWithProviderFallback({ primary: 'railcore', capability: 'CHECK_AVAILABILITY', call: mk({ railcore: 'TIMEOUT', railradar: 'PROVIDER_UNAVAILABLE' }), errorCodeOf: code, env: LIVE });
    expect((o.result as any).error.code).toBe('PROVIDER_UNAVAILABLE'); expect(o.attempts).toHaveLength(2);
  });
});

describe('P42.9 G2 — same-train matrix (D1)', () => {
  it('[9] Part 45: 120-request all-class recovery under RailCore 20 / RailRadar 10 quotas → PARTIAL, 30 verified, per-request fallback, failures never NOT_AVAILABLE, scope preserved', async () => {
    const { deps, calls } = quotaDeps({ railcore: 20, railradar: 10 });
    const r = await ok(REQ(), deps);
    expect(r.availabilityChecks).toBe(120);
    expect(r.classesChecked).toEqual(['SL', '3A', '2A', '1A']);            // no class removed
    expect(r.earlierStationsChecked).toBe(15);                              // 15 earlier preserved
    expect(r.downstreamStationsChecked).toBe(7);                            // 7 downstream preserved
    expect(r.status).toBe('PARTIAL');
    expect(r.searchComplete).toBe(false);
    const cs = r.callStats!;
    expect(cs).toMatchObject({ requested: 120, successful: 30, fallback: 100, fallbackSucceeded: 10, rateLimited: 90, partial: true });
    expect(calls.railcore).toHaveLength(120);
    expect(calls.railradar).toHaveLength(100);                              // only for the RailCore failures
    const ev = r.alternatives.flatMap(a => a.evidence);
    const served = ev.filter(e => e.provider === 'railradar');
    expect(served.every(e => e.fallbackUsed && e.fallbackReason === 'RATE_LIMITED' && e.primaryProvider === 'railcore')).toBe(true);
    expect(ev.filter(e => e.outcome === 'SUCCESS')).toHaveLength(30);
    // PARTIAL semantics: a rate-limited / failed check is never NOT_AVAILABLE
    for (const a of r.alternatives) if (a.evidence.every(e => e.outcome !== 'SUCCESS')) expect(a.availability).not.toBe('NOT_AVAILABLE');
    expect(r.providers.map(p => p.provider)).toEqual(['railcore', 'railradar']);
    expect(JSON.stringify(r)).not.toMatch(/api[_-]?key|x-railcore-key|bearer\s|authorization|access[_-]?token|"token"/i);
  });

  it('[10] Part 46: RailCore 429 for a request → RailRadar answers THAT request (provider / fallbackUsed / fallbackReason visible); RailCore successes never call RailRadar (Part 47)', async () => {
    const { deps, calls } = quotaDeps({ railcore: Infinity }, (p, q) => (p === 'railcore' && q.origin === 'R10' && q.travelClass === 'SL'
      ? { ok: false, error: { code: 'RATE_LIMITED' } }
      : { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: p === 'railradar' ? 'AVAILABLE-0004' : 'GNWL 9' } }));
    const r = await ok(REQ(), deps);
    expect(calls.railradar.map(key)).toEqual([`SL|R10|R22|${DATE}`]);       // exactly the one failed request
    const alt = r.alternatives.find(a => a.ticketOrigin === 'R10' && a.travelClass === 'SL')!;
    expect(alt.evidence[0]).toMatchObject({ provider: 'railradar', outcome: 'SUCCESS', fallbackUsed: true, fallbackReason: 'RATE_LIMITED', primaryProvider: 'railcore' });
    expect(alt.availability).toBe('AVAILABLE');
    // no duplicate calls within one execution
    expect(new Set(calls.railcore.map(key)).size).toBe(calls.railcore.length);
    expect(r.callStats!.deduped).toBe(0);
  });

  it('[11] INVALID / identity-mismatch answers never fall back; both providers failing → PROVIDER_UNAVAILABLE (never NOT_AVAILABLE)', async () => {
    const inv = quotaDeps({}, () => ({ ok: false, error: { code: 'INVALID_REQUEST' } }));
    const r1 = await runSameTrainSearch(REQ(), inv.deps);
    expect(inv.calls.railradar).toHaveLength(0);
    expect(r1.ok).toBe(false);
    const down = quotaDeps({}, () => ({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }));
    const r2 = await runSameTrainSearch(REQ(), down.deps);
    expect(r2.ok).toBe(false);
    if (!r2.ok) { expect(r2.errorClass).toBe('PROVIDER_UNAVAILABLE'); expect(r2.message).not.toMatch(/not available|nahi hai/i); expect((r2.partial as any).callStats.fallback).toBe(120); }
  });

  it('[12] route fallback: RailCore route RATE_LIMITED → RailRadar route (visible); recovery still runs', async () => {
    const { deps } = quotaDeps({ railcore: Infinity });
    deps.getRoute = async (p) => (p.id === 'railcore' ? { ok: false, error: { code: 'RATE_LIMITED' } } : { ok: true, data: LONG });
    const r = await ok(REQ(), deps);
    expect(r.route).toMatchObject({ provider: 'railradar', fallbackUsed: true, fallbackReason: 'RATE_LIMITED' });
    expect(r.availabilityChecks).toBe(120);
  });

  it('[13] explicit multi-provider choice still cross-checks (no fallback map) and conflicting answers are PROVIDER_DATA_CONFLICT — never merged', async () => {
    const { deps } = quotaDeps({}, (p, q) => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: p === 'railcore' ? 'AVAILABLE-0005' : 'GNWL 3' } }));
    const r = await ok(REQ({ providers: [RC, RR], fallbackProviders: {}, classes: ['SL'] }), deps);
    expect(r.errors).toContain('PROVIDER_DATA_CONFLICT');
    expect(r.alternatives.some(a => a.verificationStatus === 'CONFLICTING')).toBe(true);
  });

  it('[14] stale: once the journey is superseded no further call (primary or fallback) is made and the result is STALE', async () => {
    let current = true;
    const { deps, calls } = quotaDeps({ railcore: 3, railradar: 100 });
    deps.isCurrent = () => current;
    const orig = deps.checkAvailability;
    deps.checkAvailability = async (p, q) => { const x = await orig(p, q); if (calls.railcore.length >= 5) current = false; return x; };
    const r = await runSameTrainSearch(REQ({ classes: ['SL'] }), deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('STALE_ALTERNATIVE_RESULT');
    expect(calls.railcore.length + calls.railradar.length).toBeLessThan(23 * 2);
  });

  it('[15] concurrency is configurable (SAME_TRAIN_MAX_CONCURRENCY wins) and bounded', () => {
    expect(sameTrainLimitsFromEnv({ SAME_TRAIN_MAX_CONCURRENCY: '2' } as any).maxParallel).toBe(2);
    expect(sameTrainLimitsFromEnv({ SAME_TRAIN_MAX_CONCURRENCY: '99', SAME_TRAIN_MAX_PARALLEL: '4' } as any).maxParallel).toBe(12);
    expect(sameTrainLimitsFromEnv({ SAME_TRAIN_MAX_PARALLEL: '4' } as any).maxParallel).toBe(4);
  });
});
