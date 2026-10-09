/**
 * 2026-10-10 (approved, blocker 5) — RailKit's documented route endpoint (GET /api/v1/trains/:n/info) for the SAME-TRAIN
 * flow only. Route chain via SAME_TRAIN_ROUTE_PROVIDERS (e.g. railcore,railkit,railradar). Chat GET_TRAIN_INFO /
 * GET_TIMETABLE, the provider tool catalog and the general failover chain are unchanged. Offline (injected fetch / stubs,
 * dummy keys) — no network, no credits.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import { RailKitProvider } from '../../server/railway/providers/live/railkit-provider';
import { parseSameTrainRouteChain, createFailoverProvider, providerChainFor } from '../../server/railway/providers/live/live-config';
import { registerLiveProviderTools } from '../../server/railway/registry/provider-registry';
import { providerToolCatalog } from '../../server/ai/tools/provider-tools';
import { resolveSameTrainProviders, liveSameTrainDeps } from '../../server/railway/same-train/same-train-service';
import { runSameTrainSearch, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS } from '../../shared/same-train-alternatives';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { scopedProviderId } from '../../server/railway/providers/provider-scope';
import { MonthlyRequestQuota, resetRailKitMonthlyQuota } from '../../server/railway/providers/live/monthly-quota';
import { resetRateLimiters } from '../../server/railway/providers/live/provider-rate-limiter';

const KEY = 'rk_dummy_route_key';
/** recorded shape of the live 2026-10-10 /api/v1/trains/12425/info answer (coordinates trimmed) */
const INFO_12425 = {
  success: true,
  data: {
    trainInfo: { train_no: '12425', train_name: 'JAMMU RAJDHANI', from_stn_code: 'NDLS', to_stn_code: 'JAT', from_time: '20:40', to_time: '05:00', travel_time: '08:20 hrs', running_days: '1111111' },
    route: [
      { stnCode: 'NDLS', stnName: 'New Delhi', arrival: '--', departure: '20:40', haltMinutes: 0, distance: '0', day: '1', platform: 12 },
      { stnCode: 'LDH', stnName: 'Ludhiana Jn', arrival: '00:28', departure: '00:38', haltMinutes: 10, distance: '312', day: '2', platform: 2 },
      { stnCode: 'PTKC', stnName: 'Pathankot Cantt', arrival: '03:10', departure: '03:12', haltMinutes: 2, distance: '478', day: '2', platform: 2 },
      { stnCode: 'MSKT', stnName: 'Mc Sunil Kathua', arrival: '03:41', departure: '03:43', haltMinutes: 2, distance: '501', day: '2', platform: 1 },
      { stnCode: 'JAT', stnName: 'Jammu Tawi', arrival: '05:00', departure: '--', haltMinutes: 0, distance: '577', day: '2', platform: 1 }
    ]
  }
};
const respond = (status: number, body: any) => ({ status, text: async () => JSON.stringify(body), headers: { get: () => null } });
function fake(status: number, body: any) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = async (url: string, init: any) => { calls.push({ url, headers: init?.headers || {} }); return respond(status, body); };
  return { calls, fetchImpl };
}
const rk = (fetchImpl: any, apiKey: string | undefined = KEY) => new RailKitProvider({ apiKey, baseUrl: 'https://api.railkit.in', timeoutMs: 2000, fetchImpl });

afterEach(() => { providerToolCatalog.clear(); resetRateLimiters(); resetRailKitMonthlyQuota(); });

describe('RK-ROUTE-1 RailKit adapter: documented /api/v1/trains/:n/info → RailCore-shaped stops', () => {
  it('maps the recorded 12425 route (day offsets as numbers, no arrival at origin / departure at terminus)', async () => {
    const f = fake(200, INFO_12425);
    const r: any = await rk(f.fetchImpl).sameTrainRoute({ trainNumber: '12425' });
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(new URL(f.calls[0].url).pathname).toBe('/api/v1/trains/12425/info');
    expect(f.calls[0].headers['x-api-key']).toBe(KEY);
    expect(r.data).toEqual([
      { station: 'NDLS', stationName: 'New Delhi', departure: '20:40', day: 1, distanceKm: 0, platform: '12' },
      { station: 'LDH', stationName: 'Ludhiana Jn', arrival: '00:28', departure: '00:38', day: 2, distanceKm: 312, platform: '2' },
      { station: 'PTKC', stationName: 'Pathankot Cantt', arrival: '03:10', departure: '03:12', day: 2, distanceKm: 478, platform: '2' },
      { station: 'MSKT', stationName: 'Mc Sunil Kathua', arrival: '03:41', departure: '03:43', day: 2, distanceKm: 501, platform: '1' },
      { station: 'JAT', stationName: 'Jammu Tawi', arrival: '05:00', day: 2, distanceKm: 577, platform: '1' }
    ]);
    expect(r.meta).toMatchObject({ providerId: 'railkit', source: 'railway-provider' });
  });

  it('no key → NOT_CONFIGURED and invalid train number → INVALID_REQUEST, both without any request', async () => {
    const f = fake(200, INFO_12425);
    expect(((await rk(f.fetchImpl, '').sameTrainRoute({ trainNumber: '12425' })) as any).error.code).toBe('NOT_CONFIGURED');
    expect(((await rk(f.fetchImpl).sameTrainRoute({ trainNumber: '1242' })) as any).error.code).toBe('INVALID_REQUEST');
    expect(((await rk(f.fetchImpl).sameTrainRoute({ trainNumber: '12425/../x' })) as any).error.code).toBe('INVALID_REQUEST');
    expect(f.calls).toHaveLength(0);
  });

  it('a missing / invalid day offset, a different train number or a too-short route is PROVIDER_DATA_INVALID (never guessed)', async () => {
    const noDay = structuredClone(INFO_12425); delete (noDay.data.route[1] as any).day;
    const badDay = structuredClone(INFO_12425); (badDay.data.route[2] as any).day = 'two';
    const other = structuredClone(INFO_12425); other.data.trainInfo.train_no = '12426';
    const short = structuredClone(INFO_12425); short.data.route = short.data.route.slice(0, 1);
    const noCode = structuredClone(INFO_12425); (noCode.data.route[3] as any).stnCode = '';
    for (const body of [noDay, badDay, other, short, noCode, { success: true, data: {} }]) {
      const r: any = await rk(fake(200, body).fetchImpl).sameTrainRoute({ trainNumber: '12425' });
      expect(r.ok).toBe(false); expect(r.error.code).toBe('PROVIDER_DATA_INVALID');
    }
  });

  it('provider errors keep their real class (429 → RATE_LIMITED, 5xx → PROVIDER_UNAVAILABLE, 401 → AUTH_ERROR) — never a route verdict', async () => {
    const codeOf = async (status: number) => ((await rk(fake(status, { success: false, error: 'x' }).fetchImpl).sameTrainRoute({ trainNumber: '12425' })) as any).error.code;
    expect(await codeOf(429)).toBe('RATE_LIMITED');
    expect(await codeOf(503)).toBe('PROVIDER_UNAVAILABLE');
    expect(await codeOf(401)).toBe('AUTH_ERROR');
  });

  it('counts against the LOCAL monthly quota like every RailKit request; at the local limit no request is sent', async () => {
    const q = new MonthlyRequestQuota({ limit: 1, safetyMargin: 0 }); resetRailKitMonthlyQuota(q);
    const f = fake(200, INFO_12425);
    expect(((await rk(f.fetchImpl).sameTrainRoute({ trainNumber: '12425' })) as any).ok).toBe(true);
    expect(q.snapshot().used).toBe(1);
    const r2: any = await rk(f.fetchImpl).sameTrainRoute({ trainNumber: '12425' });
    expect(r2.error.code).toBe('RATE_LIMITED');
    expect(r2.meta.rateLimit).toMatchObject({ local: true, reason: 'LOCAL_MONTHLY_QUOTA' });
    expect(f.calls).toHaveLength(1);
  });
});

describe('RK-ROUTE-2 chat GET_TRAIN_INFO / GET_TIMETABLE, tool catalog and general failover are unchanged', () => {
  const KEYS = { RAILCORE_API_KEY: 'rc_dummy_test', RAILKIT_API_KEY: KEY, RAILRADAR_API_KEY: 'rr_dummy_test' };
  it('RailKit still declares no GET_TIMETABLE / GET_TRAIN_INFO; its getTimetable stays TOOL_NOT_IMPLEMENTED without a request', async () => {
    const f = fake(200, INFO_12425);
    const p = rk(f.fetchImpl);
    expect(p.supports('GET_TIMETABLE')).toBe(false);
    expect(p.supports('GET_TRAIN_INFO')).toBe(false);
    expect(((await p.getTimetable({ trainNumber: '12425' })) as any).error.code).toBe('TOOL_NOT_IMPLEMENTED');
    expect(((await p.getTrainInfo({ trainNumber: '12425' })) as any).error.code).toBe('TOOL_NOT_IMPLEMENTED');
    expect(f.calls).toHaveLength(0);
  });

  it('SAME_TRAIN_ROUTE_PROVIDERS never adds a RailKit timetable tool (routed and legacy env) nor changes the GET_TIMETABLE chain', () => {
    for (const env of [
      { RAILWAY_PROVIDER: 'live', RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railradar', RAILWAY_AVAILABILITY_PROVIDERS: 'railkit,railcore,railradar' },
      { RAILWAY_PROVIDER: 'live', RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railkit,railradar' }
    ]) {
      providerToolCatalog.clear();
      const before = providerChainFor('GET_TIMETABLE', env);
      registerLiveProviderTools({ ...env, ...KEYS, SAME_TRAIN_ROUTE_PROVIDERS: 'railkit,railcore,railradar' } as any);
      expect(providerToolCatalog.get('railkit')!.capabilities).not.toContain('GET_TIMETABLE');
      expect(providerToolCatalog.get('railkit')!.capabilities).not.toContain('GET_TRAIN_INFO');
      expect(providerToolCatalog.resolve('railkit_timetable')).toMatchObject({ kind: 'UNSUPPORTED' });
      expect(providerChainFor('GET_TIMETABLE', { ...env, SAME_TRAIN_ROUTE_PROVIDERS: 'railkit,railcore,railradar' })).toEqual(before);
    }
  });

  it('legacy env (RailKit in the general chain): the canonical failover getTimetable never asks RailKit', async () => {
    const hosts: string[] = [];
    const fetchImpl = async (url: string) => { hosts.push(new URL(url).host); return respond(503, {}); };
    const f = createFailoverProvider({ RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railkit,railradar', ...KEYS, SAME_TRAIN_ROUTE_PROVIDERS: 'railkit,railcore,railradar', RAILWAY_TOOL_TIMEOUT_MS: '9000' } as any, fetchImpl as any);
    const t: any = await f.getTimetable({ trainNumber: '12425' });
    expect(t.ok).toBe(false);
    expect(hosts).not.toContain('api.railkit.in');
  });
});

describe('RK-ROUTE-3 SAME_TRAIN_ROUTE_PROVIDERS parsing', () => {
  it('unset / blank → null (unchanged); ordered, de-duplicated, case-insensitive; unknown id → configuration error at startup', () => {
    expect(parseSameTrainRouteChain({})).toBeNull();
    expect(parseSameTrainRouteChain({ SAME_TRAIN_ROUTE_PROVIDERS: ' , ' })).toBeNull();
    expect(parseSameTrainRouteChain({ SAME_TRAIN_ROUTE_PROVIDERS: 'RailCore, railkit ,railradar,railkit' })).toEqual(['railcore', 'railkit', 'railradar']);
    expect(() => parseSameTrainRouteChain({ SAME_TRAIN_ROUTE_PROVIDERS: 'railcore,erail' })).toThrow(/Unknown railway provider "erail" in SAME_TRAIN_ROUTE_PROVIDERS/);
    expect(() => createFailoverProvider({ RAILWAY_PRIMARY_PROVIDER: 'railcore', SAME_TRAIN_ROUTE_PROVIDERS: 'nope' } as any)).toThrow(/SAME_TRAIN_ROUTE_PROVIDERS/);
  });
});

describe('RK-ROUTE-4 same-train route resolution', () => {
  const ENV: Record<string, string> = {
    RAILWAY_PROVIDER: 'live', RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railradar', RAILWAY_AVAILABILITY_PROVIDERS: 'railkit,railcore,railradar',
    RAILKIT_API_KEY: KEY, SAME_TRAIN_ROUTE_PROVIDERS: 'railcore,railkit,railradar'
  };
  const saved: Record<string, string | undefined> = {};
  const setEnv = (over: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(over)) { if (!(k in saved)) saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  beforeEach(() => {
    setEnv(ENV);
    providerToolCatalog.register({ id: 'railcore', label: 'RailCore', registryId: 'railcore', capabilities: ['SEARCH_TRAINS', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE'] });
    providerToolCatalog.register({ id: 'railradar', label: 'RailRadar', registryId: 'railradar', capabilities: ['SEARCH_TRAINS', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE'] });
    providerToolCatalog.register({ id: 'railkit', label: 'RailKit', registryId: 'railkit', capabilities: ['CHECK_AVAILABILITY', 'GET_FARE'] });
  });
  afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; delete saved[k]; } });
  const ids = (xs: any[] | undefined) => (xs || []).map(x => x.id);

  it('railcore,railkit,railradar → route RailCore; fallbacks RailKit then RailRadar; availability routing untouched', () => {
    const r: any = resolveSameTrainProviders();
    expect(r.ok).toBe(true);
    expect(r.routeProvider.id).toBe('railcore');
    expect(r.routeFallback?.id).toBe('railkit');
    expect(ids(r.routeFallbacks)).toEqual(['railradar']);
    expect(r.providers.map((p: any) => p.id)).toEqual(['railkit']);
    expect(Object.fromEntries(Object.entries(r.fallbacks).map(([k, v]: any) => [k, v.id]))).toEqual({ railkit: 'railcore', railcore: 'railradar' });
  });

  it('unset → exactly the previous resolution (route RailCore → RailRadar, no routeFallbacks)', () => {
    setEnv({ SAME_TRAIN_ROUTE_PROVIDERS: undefined });
    const r: any = resolveSameTrainProviders();
    expect(r.routeProvider.id).toBe('railcore');
    expect(r.routeFallback?.id).toBe('railradar');
    expect(r.routeFallbacks).toBeUndefined();
  });

  it('RailKit without a key is skipped; mock mode ignores the chain (never mixes LIVE into MOCK)', () => {
    setEnv({ RAILKIT_API_KEY: '' });
    const r: any = resolveSameTrainProviders();
    expect(r.routeProvider.id).toBe('railcore'); expect(r.routeFallback?.id).toBe('railradar'); expect(ids(r.routeFallbacks)).toEqual([]);
    setEnv({ RAILKIT_API_KEY: KEY, RAILWAY_PROVIDER: 'mock' });
    const m: any = resolveSameTrainProviders();
    expect(m.routeFallbacks).toBeUndefined();
    expect(m.routeFallback?.id).not.toBe('railkit');
  });

  it('one env change puts RailKit first; an LLM-chosen route provider is validated as before and keeps only the members after it', () => {
    setEnv({ SAME_TRAIN_ROUTE_PROVIDERS: 'railkit,railcore,railradar' });
    const r: any = resolveSameTrainProviders();
    expect(r.routeProvider).toMatchObject({ id: 'railkit', level: 'PROVIDER_API' });
    expect(r.routeProvider.isMock).toBe(false);
    expect(r.routeFallback?.id).toBe('railcore'); expect(ids(r.routeFallbacks)).toEqual(['railradar']);
    setEnv({ SAME_TRAIN_ROUTE_PROVIDERS: 'railcore,railkit,railradar' });
    const rr: any = resolveSameTrainProviders(null, 'railradar');
    expect(rr.routeProvider.id).toBe('railradar'); expect(rr.routeFallback).toBeNull(); expect(ids(rr.routeFallbacks)).toEqual([]);
    // the LLM still cannot name RailKit as route provider (no timetable tool) — unchanged validation
    const bad: any = resolveSameTrainProviders(null, 'railkit');
    expect(bad.ok).toBe(false); expect(bad.code).toBe('INVALID_TOOL_CALL');
  });
});

describe('RK-ROUTE-5 engine walks the route chain only on eligible faults', () => {
  const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
  const RK: ProviderRef = { id: 'railkit', label: 'RailKit', level: 'PROVIDER_API' };
  const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
  const KIT_STOPS = INFO_12425.data.route.map((s, i, all) => ({ station: s.stnCode, stationName: s.stnName, ...(i > 0 ? { arrival: s.arrival } : {}), ...(i < all.length - 1 ? { departure: s.departure } : {}), day: Number(s.day) }));
  const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
    sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 1, trainNumber: '12425', date: '2026-10-20', travelClass: '3A', passengersCount: 1,
    origin: 'LDH', destination: 'JAT', originSweep: true, destinationSweep: true, combinedPairs: 'AUTO', includeFare: false, webEvidence: false,
    providers: [RC], routeProvider: RC, routeFallback: RK, routeFallbacks: [RR], fallbackProviders: {}, webProviders: [], ...over
  } as any);
  function deps(route: Record<string, any>) {
    const routeCalls: string[] = []; const avail: { origin: string; destination: string; date: string }[] = [];
    const d: SameTrainDeps = {
      limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 500, totalTimeoutMs: 5000 },
      getRoute: async p => { routeCalls.push(p.id); return route[p.id] ?? { ok: false, error: { code: 'NOT_CONFIGURED' } }; },
      checkAvailability: async (_p, q) => { avail.push({ origin: q.origin, destination: q.destination, date: q.date }); return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: 'WL 7' } }; },
      getFare: async () => ({ ok: true, data: { total: 860, currency: 'INR' } })
    };
    return { d, routeCalls, avail };
  }
  const OK = { ok: true, data: KIT_STOPS };

  it('RailCore PROVIDER_UNAVAILABLE → RailKit route serves it (visible provider + primary fault); RailRadar not asked', async () => {
    const m = deps({ railcore: { ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }, railkit: OK, railradar: { ok: true, data: [] } });
    const r = await runSameTrainSearch(REQ(), m.d);
    expect(m.routeCalls).toEqual(['railcore', 'railkit']);
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
    expect(r.result.route).toMatchObject({ provider: 'railkit', fallbackUsed: true, fallbackReason: 'PROVIDER_UNAVAILABLE' });
  });

  it('RailCore RATE_LIMITED → RailKit RATE_LIMITED (e.g. local monthly limit) → RailRadar; reason stays the primary fault', async () => {
    const m = deps({ railcore: { ok: false, error: { code: 'RATE_LIMITED' } }, railkit: { ok: false, error: { code: 'RATE_LIMITED' } }, railradar: OK });
    const r = await runSameTrainSearch(REQ(), m.d);
    expect(m.routeCalls).toEqual(['railcore', 'railkit', 'railradar']);
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
    expect(r.result.route).toMatchObject({ provider: 'railradar', fallbackUsed: true, fallbackReason: 'RATE_LIMITED' });
  });

  it('a non-eligible fault (AUTH_ERROR / route verdict) never walks the chain; a RailKit non-eligible fault stops it', async () => {
    const a = deps({ railcore: { ok: false, error: { code: 'AUTH_ERROR' } }, railkit: OK, railradar: OK });
    const ra = await runSameTrainSearch(REQ(), a.d);
    expect(a.routeCalls).toEqual(['railcore']); expect(ra.ok).toBe(false);
    const b = deps({ railcore: { ok: false, error: { code: 'TIMEOUT' } }, railkit: { ok: false, error: { code: 'PROVIDER_DATA_INVALID' } }, railradar: OK });
    const rb = await runSameTrainSearch(REQ(), b.d);
    expect(b.routeCalls).toEqual(['railcore', 'railkit']); expect(rb.ok).toBe(false);
  });

  it('without routeFallbacks the behaviour is exactly the previous single fallback', async () => {
    const m = deps({ railcore: { ok: false, error: { code: 'RATE_LIMITED' } }, railradar: { ok: false, error: { code: 'RATE_LIMITED' } }, railkit: OK });
    const r = await runSameTrainSearch(REQ({ routeFallback: RR, routeFallbacks: undefined } as any), m.d);
    expect(m.routeCalls).toEqual(['railcore', 'railradar']);
    expect(r.ok).toBe(false);
  });

  it('RailKit route day offsets drive the ticket date: boarding at NDLS (day 1) for a LDH (day 2) journey → one day earlier; never the journey date blindly', async () => {
    const m = deps({ railcore: { ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }, railkit: OK });
    const r = await runSameTrainSearch(REQ(), m.d);
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
    const ndls = m.avail.filter(q => q.origin === 'NDLS');
    expect(ndls.length).toBeGreaterThan(0);
    expect(new Set(ndls.map(q => q.date))).toEqual(new Set(['2026-10-19']));
    const day2 = m.avail.filter(q => q.origin !== 'NDLS');
    expect(day2.length).toBeGreaterThan(0);
    expect(new Set(day2.map(q => q.date))).toEqual(new Set(['2026-10-20']));
  });
});

describe('RK-ROUTE-6 live wiring: the RailKit route call runs in RailKit\'s own scope (never the unscoped failover)', () => {
  it('liveSameTrainDeps → SAME_TRAIN_ROUTE inside the provider scope; RailKit (no catalog entry) still scoped to railkit', async () => {
    providerToolCatalog.register({ id: 'railcore', label: 'RailCore', registryId: 'railcore', capabilities: ['GET_TIMETABLE'] });
    const seen: (string | null)[] = [];
    const tools: any = {
      SAME_TRAIN_ROUTE: async () => { seen.push(scopedProviderId()); return { ok: true, data: [] }; },
      GET_TIMETABLE: async () => { throw new Error('GET_TIMETABLE must not be called when SAME_TRAIN_ROUTE exists'); }
    };
    const d = liveSameTrainDeps(tools);
    await d.getRoute({ id: 'railkit', label: 'railkit', level: 'PROVIDER_API' }, '12425');
    await d.getRoute({ id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' }, '12425');
    expect(seen).toEqual(['railkit', 'railcore']);
  });

  it('a tool service without SAME_TRAIN_ROUTE (older stubs) keeps using GET_TIMETABLE', async () => {
    providerToolCatalog.register({ id: 'railcore', label: 'RailCore', registryId: 'railcore', capabilities: ['GET_TIMETABLE'] });
    const tools: any = { GET_TIMETABLE: vi.fn(async () => ({ ok: true, data: [] })) };
    await liveSameTrainDeps(tools).getRoute({ id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' }, '12425');
    expect(tools.GET_TIMETABLE).toHaveBeenCalledWith('12425');
  });

  it('RailwayToolService.SAME_TRAIN_ROUTE: RailKit → its sameTrainRoute; any other provider → exactly GET_TIMETABLE', async () => {
    const svc = new RailwayToolService();
    const kit = { sameTrainRoute: vi.fn(async () => ({ ok: true, data: ['kit'] })), getTimetable: vi.fn() };
    Object.defineProperty(svc, 'provider', { get: () => kit });
    expect(((await svc.SAME_TRAIN_ROUTE('12425')) as any).data).toEqual(['kit']);
    expect(kit.sameTrainRoute).toHaveBeenCalledWith({ trainNumber: '12425' }); expect(kit.getTimetable).not.toHaveBeenCalled();
    const svc2 = new RailwayToolService();
    const core = { getTimetable: vi.fn(async () => ({ ok: true, data: ['core'] })) };
    Object.defineProperty(svc2, 'provider', { get: () => core });
    expect(((await svc2.SAME_TRAIN_ROUTE('12425')) as any).data).toEqual(['core']);
    expect(core.getTimetable).toHaveBeenCalledWith({ trainNumber: '12425' });
  });
});
