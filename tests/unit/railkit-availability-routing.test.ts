/**
 * 2026-10-09 (approved) — capability routing: RailCore for train search / route discovery; RailKit preferred for
 * CHECK_AVAILABILITY + GET_FARE (RAILWAY_AVAILABILITY_PROVIDERS) with the RailCore → RailRadar fallback preserved.
 * Offline only (injected fetch / stubs, dummy keys) — no network, no credits.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import { providerChainFor, parseAvailabilityChain, createFailoverProvider, liveProviderStatus, allChainProviderIds } from '../../server/railway/providers/live/live-config';
import { registerLiveProviderTools } from '../../server/railway/registry/provider-registry';
import { fallbackChainFor, fallbackProviderFor, primaryProviderId, runWithProviderFallback } from '../../server/railway/providers/provider-fallback';
import { providerToolCatalog } from '../../server/ai/tools/provider-tools';
import { resolveSameTrainProviders } from '../../server/railway/same-train/same-train-service';
import { runSameTrainSearch, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS } from '../../shared/same-train-alternatives';
import { resetRateLimiters } from '../../server/railway/providers/live/provider-rate-limiter';

const ROUTED = { RAILWAY_PROVIDER: 'live', RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railradar', RAILWAY_AVAILABILITY_PROVIDERS: 'railkit,railcore,railradar' };
const KEYS = { RAILCORE_API_KEY: 'rc_dummy_test', RAILKIT_API_KEY: 'rk_dummy_test', RAILRADAR_API_KEY: 'rr_dummy_test' };

afterEach(() => { providerToolCatalog.clear(); resetRateLimiters(); });

describe('RK-R1 capability chains', () => {
  it('availability / fare use RAILWAY_AVAILABILITY_PROVIDERS; search / route / PNR keep the general chain; unset = unchanged', () => {
    expect(providerChainFor('CHECK_AVAILABILITY', ROUTED)).toEqual(['railkit', 'railcore', 'railradar']);
    expect(providerChainFor('GET_FARE', ROUTED)).toEqual(['railkit', 'railcore', 'railradar']);
    for (const c of ['SEARCH_TRAINS', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'CHECK_PNR', 'TRACK_TRAIN']) expect(providerChainFor(c, ROUTED)).toEqual(['railcore', 'railradar']);
    // unset / empty → identical to the pre-change general chain for every capability
    const legacy = { RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railkit,railradar' };
    for (const c of ['CHECK_AVAILABILITY', 'GET_FARE', 'SEARCH_TRAINS']) {
      expect(providerChainFor(c, legacy)).toEqual(['railcore', 'railkit', 'railradar']);
      expect(providerChainFor(c, { ...legacy, RAILWAY_AVAILABILITY_PROVIDERS: ' ' })).toEqual(['railcore', 'railkit', 'railradar']);
    }
    expect(parseAvailabilityChain({})).toBeNull();
    // a general-chain provider the availability list omits is appended (no configured fallback is lost)
    expect(providerChainFor('CHECK_AVAILABILITY', { ...ROUTED, RAILWAY_AVAILABILITY_PROVIDERS: 'railkit' })).toEqual(['railkit', 'railcore', 'railradar']);
    expect(allChainProviderIds(ROUTED)).toEqual(['railcore', 'railradar', 'railkit']);
    expect(() => providerChainFor('CHECK_AVAILABILITY', { ...ROUTED, RAILWAY_AVAILABILITY_PROVIDERS: 'railkit,confirmtkt' })).toThrow(/Unknown railway provider "confirmtkt"/);
    const st = liveProviderStatus({ ...ROUTED, ...KEYS });
    expect(st.find(s => s.provider === 'RAILKIT')).toMatchObject({ priority: null, availabilityPriority: 1, configured: true });
    expect(st.find(s => s.provider === 'RAILCORE')).toMatchObject({ priority: 1, availabilityPriority: 2 });
    expect(JSON.stringify(st)).not.toMatch(/dummy_test/);
  });
});

describe('RK-R2 provider tools follow the routing (LLM cannot pick an unrouted capability)', () => {
  it('RailKit (availability chain only) exposes ONLY availability + fare tools; RailCore / RailRadar keep everything', () => {
    registerLiveProviderTools({ ...ROUTED, ...KEYS } as any);
    expect([...providerToolCatalog.get('railkit')!.capabilities].sort()).toEqual(['CHECK_AVAILABILITY', 'GET_FARE']);
    expect(providerToolCatalog.get('railcore')!.capabilities).toEqual(expect.arrayContaining(['SEARCH_TRAINS', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE']));
    expect(providerToolCatalog.resolve('railkit_search')).toMatchObject({ kind: 'UNSUPPORTED' });
    expect(providerToolCatalog.resolve('railkit_availability')).toMatchObject({ kind: 'PROVIDER_TOOL', canonical: 'CHECK_AVAILABILITY' });
  });
  it('unset availability chain → RailKit in the general chain keeps its documented capabilities (unchanged)', () => {
    registerLiveProviderTools({ RAILWAY_PROVIDER: 'live', RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railkit,railradar', ...KEYS } as any);
    expect([...providerToolCatalog.get('railkit')!.capabilities].sort()).toEqual(['CHECK_AVAILABILITY', 'GET_FARE', 'SEARCH_TRAINS']);
  });
});

describe('RK-R3 backend failover chain (canonical path)', () => {
  it('checkAvailability: RailKit → RailCore → RailRadar; searchTrains: RailCore → RailRadar (RailKit never asked)', async () => {
    const hosts: string[] = [];
    const fetchImpl = async (url: string) => { hosts.push(new URL(url).host); return { status: 503, text: async () => '{}' }; };
    const f = createFailoverProvider({ ...ROUTED, ...KEYS, RAILWAY_TOOL_TIMEOUT_MS: '9000' }, fetchImpl as any);
    expect(f.label).toMatch(/RAILCORE → RAILRADAR → RAILKIT\); availability\/fare: RAILKIT → RAILCORE → RAILRADAR/);
    const a: any = await f.checkAvailability({ trainNumber: '12425', travelClass: '3A', date: '2026-10-20', origin: 'LDH', destination: 'JAT', quota: 'GN' } as any);
    expect(a.ok).toBe(false);
    expect(a.meta.attempts.map((x: any) => x.provider)).toEqual(['railkit', 'railcore', 'railradar']);
    expect(hosts).toEqual(['api.railkit.in', 'ir.railcore.tech', 'api.railradar.in']);
    hosts.length = 0;
    const s: any = await f.searchTrains({ origin: 'LDH', destination: 'JAT', date: '2026-10-20' } as any);
    expect(s.meta.attempts.map((x: any) => x.provider)).toEqual(['railcore', 'railradar']);
    expect(hosts).not.toContain('api.railkit.in');
  });
});

describe('RK-R4 P42.9 provider-tool fallback walks the capability chain', () => {
  const reg = (id: string, caps: any[]) => providerToolCatalog.register({ id, label: id, registryId: id, capabilities: caps });
  beforeEach(() => {
    reg('railcore', ['SEARCH_TRAINS', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE']);
    reg('railradar', ['SEARCH_TRAINS', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE']);
    reg('railkit', ['CHECK_AVAILABILITY', 'GET_FARE']);
  });
  const code = (r: any) => (r.ok ? null : r.error.code);
  const mk = (codes: Record<string, string | null>, order: string[]) => async (p: string) => { order.push(p); return codes[p] ? { ok: false, error: { code: codes[p] } } : { ok: true, data: p }; };

  it('primary per capability; fallback chain only from that capability primary', () => {
    expect(primaryProviderId(ROUTED, 'CHECK_AVAILABILITY')).toBe('railkit');
    expect(primaryProviderId(ROUTED, 'GET_FARE')).toBe('railkit');
    expect(primaryProviderId(ROUTED)).toBe('railcore');
    expect(primaryProviderId(ROUTED, 'SEARCH_TRAINS')).toBe('railcore');
    expect(fallbackChainFor('railkit', 'CHECK_AVAILABILITY', ROUTED)).toEqual(['railcore', 'railradar']);
    expect(fallbackChainFor('railcore', 'CHECK_AVAILABILITY', ROUTED)).toEqual([]);     // not the availability primary
    expect(fallbackChainFor('railcore', 'SEARCH_TRAINS', ROUTED)).toEqual(['railradar']);
    expect(fallbackProviderFor('railkit', 'GET_FARE', ROUTED)).toBe('railcore');
  });
  it('RailKit RATE_LIMITED → RailCore RATE_LIMITED → RailRadar answers (sequential, visible attempts)', async () => {
    const order: string[] = [];
    const o = await runWithProviderFallback({ primary: 'railkit', capability: 'CHECK_AVAILABILITY', call: mk({ railkit: 'RATE_LIMITED', railcore: 'RATE_LIMITED', railradar: null }, order), errorCodeOf: code, env: ROUTED });
    expect(order).toEqual(['railkit', 'railcore', 'railradar']);
    expect(o).toMatchObject({ served: 'railradar', fallbackUsed: true, fallbackReason: 'RATE_LIMITED' });
    expect(o.attempts.map(a => [a.provider, a.attempt, a.status])).toEqual([['railkit', 1, 'FAILED'], ['railcore', 2, 'FAILED'], ['railradar', 3, 'SUCCESS']]);
  });
  it('a RailCore success or a non-eligible answer stops the walk (RailRadar never asked); success at RailKit asks nobody else', async () => {
    let order: string[] = [];
    let o = await runWithProviderFallback({ primary: 'railkit', capability: 'CHECK_AVAILABILITY', call: mk({ railkit: 'PROVIDER_UNAVAILABLE', railcore: null }, order), errorCodeOf: code, env: ROUTED });
    expect(order).toEqual(['railkit', 'railcore']); expect(o.served).toBe('railcore');
    order = [];
    o = await runWithProviderFallback({ primary: 'railkit', capability: 'CHECK_AVAILABILITY', call: mk({ railkit: 'TIMEOUT', railcore: 'CLASS_NOT_AVAILABLE' }, order), errorCodeOf: code, env: ROUTED });
    expect(order).toEqual(['railkit', 'railcore']); expect((o.result as any).error.code).toBe('CLASS_NOT_AVAILABLE');
    order = [];
    o = await runWithProviderFallback({ primary: 'railkit', capability: 'CHECK_AVAILABILITY', call: mk({ railkit: 'INVALID_DATE' }, order), errorCodeOf: code, env: ROUTED });
    expect(order).toEqual(['railkit']); expect(o.fallbackUsed).toBe(false);
    order = [];
    o = await runWithProviderFallback({ primary: 'railkit', capability: 'CHECK_AVAILABILITY', call: mk({}, order), errorCodeOf: code, env: ROUTED });
    expect(order).toEqual(['railkit']);
    // canFallback veto (budget) after the first fallback stops the walk
    order = []; let n = 0;
    o = await runWithProviderFallback({ primary: 'railkit', capability: 'CHECK_AVAILABILITY', call: mk({ railkit: 'RATE_LIMITED', railcore: 'RATE_LIMITED' }, order), errorCodeOf: code, env: ROUTED, canFallback: () => ++n <= 1 });
    expect(order).toEqual(['railkit', 'railcore']);
  });
});

describe('RK-R5 same-train uses the availability primary + linked fallbacks', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of Object.keys(ROUTED)) { saved[k] = process.env[k]; process.env[k] = (ROUTED as any)[k]; }
    providerToolCatalog.register({ id: 'railcore', label: 'RailCore', registryId: 'railcore', capabilities: ['SEARCH_TRAINS', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE'] });
    providerToolCatalog.register({ id: 'railradar', label: 'RailRadar', registryId: 'railradar', capabilities: ['SEARCH_TRAINS', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE'] });
    providerToolCatalog.register({ id: 'railkit', label: 'RailKit', registryId: 'railkit', capabilities: ['CHECK_AVAILABILITY', 'GET_FARE'] });
  });
  afterEach(() => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it('default → RailKit availability, RailCore route; fallbacks railkit→railcore→railradar; an LLM choice is honoured but gets no hidden fallback', () => {
    const r: any = resolveSameTrainProviders();
    expect(r.ok).toBe(true);
    expect(r.selection).toBe('DEFAULT_PRIMARY');
    expect(r.providers.map((p: any) => p.id)).toEqual(['railkit']);
    expect(r.routeProvider.id).toBe('railcore');                      // route discovery stays on RailCore
    expect(r.routeFallback?.id).toBe('railradar');
    expect(Object.fromEntries(Object.entries(r.fallbacks).map(([k, v]: any) => [k, v.id]))).toEqual({ railkit: 'railcore', railcore: 'railradar' });
    const llm: any = resolveSameTrainProviders('railcore');
    expect(llm.selection).toBe('LLM'); expect(llm.providers.map((p: any) => p.id)).toEqual(['railcore']);
    expect(llm.fallbacks).toEqual({});
  });

  it('engine: RailKit RATE_LIMITED → RailCore RATE_LIMITED → RailRadar answers THAT request; a RailKit success asks nobody else', async () => {
    const RK: ProviderRef = { id: 'railkit', label: 'RailKit', level: 'PROVIDER_API' };
    const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
    const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
    const stops = ['A', 'B', 'C', 'D'].map((s, i) => ({ station: s, stationName: s, departure: `0${i}:10`, day: 1 }));
    const calls: string[] = [];
    const deps: SameTrainDeps = {
      limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 500, totalTimeoutMs: 5000 },
      getRoute: async () => ({ ok: true, data: stops }),
      checkAvailability: async (p, q: AvailabilityQuery) => {
        calls.push(`${p.id}:${q.origin}-${q.destination}`);
        if (q.origin === 'A' && p.id !== 'railradar') return { ok: false, error: { code: 'RATE_LIMITED' } };
        return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: q.origin === 'B' ? 'GNWL 20' : 'GNWL 3' } };
      }
    };
    const req: SameTrainSearchRequest = { sessionId: 's', turnId: 't', requestId: 'r', journeyVersion: 1, trainNumber: '12425', trainName: 'T', date: '2026-10-20',
      travelClass: '3A', classes: ['3A'], passengersCount: 1, origin: 'B', destination: 'D', originSweep: true, destinationSweep: false, destinationExtensionStations: 0,
      combinedPairs: 'NEVER', includeFare: false, webEvidence: false, providers: [RK], routeProvider: RC, webProviders: [], fallbackProviders: { railkit: RC, railcore: RR }, routeFallback: RR } as any;
    const out = await runSameTrainSearch(req, deps);
    expect(out.ok).toBe(true);
    const fromA = calls.filter(c => c.includes(':A-'));
    expect(fromA).toEqual(['railkit:A-D', 'railcore:A-D', 'railradar:A-D']);
    const ev = (out as any).result.alternatives.flatMap((a: any) => a.evidence).find((e: any) => e.provider === 'railradar');
    expect(ev).toMatchObject({ outcome: 'SUCCESS', fallbackUsed: true, fallbackReason: 'RATE_LIMITED', primaryProvider: 'railkit' });
    expect(calls.filter(c => c.includes(':B-'))).toEqual(['railkit:B-D']);   // RailKit answered → no fallback call
  });
});
