/**
 * RailRadar Phase 1 — route verification cross-check (same-train engine only).
 *   CASE A primary (RailCore) route verifies the pair          → VERIFIED_BY_RAILCORE, no RailRadar call
 *   CASE B primary cannot verify → ONE RailRadar route call     → ROUTE_VERIFIED_BY_RAILRADAR when its data has the pair
 *          in order and agrees with RailCore on the order of every shared station (absence ≠ contradiction)
 *   CASE C both fail / RailRadar error / timeout                → ROUTE_UNVERIFIED (INVALID_STATION_PAIR kept, limitation text)
 *   CASE D incompatible positive claims (order disagreement)    → ROUTE_DATA_CONFLICT (unverified, never resolved by choice)
 * The cross-check makes route calls only — never search / availability / fare / live / PNR; availability & fare after a
 * verified cross-check still come from the unchanged provider chain. Test data only (observed 12498 shapes).
 */
import { describe, it, expect } from 'vitest';
import { runSameTrainSearch, crossCheckRoute, normalizeRoute, sameTrainLimitsFromEnv, type SameTrainDeps, type ProviderRef, type SameTrainSearchRequest } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS, SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE } from '../../shared/same-train-alternatives';
import { sameTrainFallbackText } from '../../server/railway/same-train/same-train-view';
import { guardSameTrainRuleClaims, guardRouteDataClaims } from '../../server/ai/response/same-train-claims';

const DATE = '2026-10-09';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
const st = (codes: string[]) => codes.map(station => ({ station, stationName: station }));
/** observed RailCore 12498 schedule shape: starts at DDL — no ASR / BEAS / JUC / LDH */
const RC_12498 = st(['DDL', 'KNN', 'RPJ', 'UMB', 'KKDE', 'KUN', 'PNP', 'BDMJ', 'SNP', 'SZM', 'NDLS']);
/** observed RailRadar 12498 route shape: ASR … NDLS (halts; some RailCore stops absent — absence is not contradiction) */
const RR_12498 = st(['ASR', 'BEAS', 'JUC', 'PGW', 'LDH', 'SIR', 'RPJ', 'UMB', 'KKDE', 'PNP', 'SNP', 'NDLS']);
const RC_FULL = st(['ASR', 'BEAS', 'JUC', 'PGW', 'LDH', 'RPJ', 'UMB', 'KKDE', 'PNP', 'SNP', 'NDLS']);
const LIMITS = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 150, totalTimeoutMs: 3000 };
const FAIL_STATES = ['WL', 'REGRET'];

function deps(routes: Record<string, any>, o: { avail?: (p: ProviderRef, q: any) => any } = {}) {
  const events: string[] = [];
  const d: SameTrainDeps = {
    limits: LIMITS,
    getRoute: async p => { events.push(`route:${p.id}`); const r = routes[p.id]; return typeof r === 'function' ? r() : r; },
    checkAvailability: async (p, q) => { events.push(`avail:${p.id}:${q.origin}-${q.destination}`);
      return o.avail ? o.avail(p, q) : { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: q.origin === 'ASR' && q.destination === 'NDLS' ? 'WL 12' : 'AVAILABLE-0009' } }; },
    getFare: async (p, q) => { events.push(`fare:${p.id}:${q.origin}-${q.destination}`); return { ok: true, data: { total: 900, currency: 'INR' } }; }
  };
  const routeCalls = () => events.filter(e => e.startsWith('route:'));
  const nonRoute = () => events.filter(e => !e.startsWith('route:'));
  return { d, events, routeCalls, nonRoute };
}
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 1, trainNumber: '12498', date: DATE, travelClass: 'CC', passengersCount: 1,
  origin: 'ASR', destination: 'NDLS', originSweep: true, destinationSweep: true, combinedPairs: 'AUTO', includeFare: true, webEvidence: false,
  providers: [RC], routeProvider: RC, routeFallback: RR, fallbackProviders: { railcore: RR }, webProviders: [], ...over
} as any);
const ABSENCE = /route\s*(par|pe|mein|me)\s*nahi|not on (this|the|its) (train'?s? )?route|रूट\s*पर\s*नहीं|nahi rukti/i;
const failedStep = (code: string) => ({ status: 'error', result: { toolName: 'SEARCH_SAME_TRAIN_ALTERNATIVES', error: { code, message: 'x' } } });
const ok = (data: any) => ({ ok: true, data });

describe('RailRadar Phase 1 — route cross-check', () => {
  it('[A] RailCore route has both stations in order → VERIFIED_BY_RAILCORE; RailRadar is NOT called', async () => {
    const m = deps({ railcore: ok(RC_FULL), railradar: () => { throw new Error('RailRadar must not be called'); } });
    const r = await runSameTrainSearch(REQ(), m.d);
    expect(m.routeCalls()).toEqual(['route:railcore']);
    if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
    expect(r.result.route).toMatchObject({ provider: 'railcore', verification: 'VERIFIED_BY_RAILCORE', verifiedBy: 'railcore' });
    expect(r.result.route.primaryRouteProvider).toBeUndefined();
    expect(m.nonRoute().every(e => !e.includes(':railradar'))).toBe(true);
  });

  it('[B] RailCore route missing the requested station (12498 shape) → exactly ONE RailRadar route call (cross-check)', async () => {
    const m = deps({ railcore: ok(RC_12498), railradar: ok(RR_12498) });
    await runSameTrainSearch(REQ(), m.d);
    expect(m.routeCalls()).toEqual(['route:railcore', 'route:railradar']);
    // the cross-check happens BEFORE any availability / fare work
    expect(m.events.slice(0, 2)).toEqual(['route:railcore', 'route:railradar']);
  });

  it('[C] RailRadar confirms the pair in order + shared stations agree → ROUTE_VERIFIED_BY_RAILRADAR; deterministic continuation on RailCore availability', async () => {
    const m = deps({ railcore: ok(RC_12498), railradar: ok(RR_12498) });
    const r = await runSameTrainSearch(REQ(), m.d);
    if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
    expect(r.result.route).toMatchObject({ provider: 'railradar', verification: 'ROUTE_VERIFIED_BY_RAILRADAR', verifiedBy: 'railradar',
      primaryRouteProvider: 'railcore', primaryRouteResult: 'STATION_MISSING' });
    expect(r.result.route.stations.map(s => s.code)[0]).toBe('ASR');
    // availability / fare authority unchanged: RailCore only (RailRadar only as the unchanged P42.9 fault fallback)
    expect(m.nonRoute().length).toBeGreaterThan(0);
    expect(m.nonRoute().every(e => e.includes(':railcore:'))).toBe(true);
    // same input → same plan (deterministic), and no cache: a second run re-checks the route
    const m2 = deps({ railcore: ok(RC_12498), railradar: ok(RR_12498) });
    const r2 = await runSameTrainSearch(REQ(), m2.d);
    if (!r2.ok) throw new Error('expected ok');
    expect(m2.routeCalls()).toEqual(['route:railcore', 'route:railradar']);
    expect(r2.result.alternatives.map(a => `${a.ticketOrigin}-${a.ticketDestination}`)).toEqual(r.result.alternatives.map(a => `${a.ticketOrigin}-${a.ticketDestination}`));
    expect(m2.nonRoute()).toEqual(m.nonRoute());
    // pure decision function
    const a = normalizeRoute(RC_12498), b = normalizeRoute(RR_12498);
    if (!a.ok || !b.ok) throw new Error('route');
    expect(crossCheckRoute(a.stations, a.duplicates, b.stations, b.duplicates, 'ASR', 'NDLS')).toEqual({ verdict: 'VERIFIED' });
  });

  it('[D] both route data fail (or RailRadar errors / times out) → ROUTE_UNVERIFIED: INVALID_STATION_PAIR kept + truthful limitation, never a claim', async () => {
    const cases: Array<[any, string]> = [
      [ok(st(['DDL', 'UMB', 'PNP', 'NDLS'])), 'NOT_IN_ROUTE'],
      [{ ok: false, error: { code: 'NOT_FOUND' } }, 'NOT_FOUND'],
      [{ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }, 'PROVIDER_UNAVAILABLE'],
      [{ ok: false, error: { code: 'RATE_LIMITED' } }, 'RATE_LIMITED'],
      [() => new Promise(() => {}), 'TIMEOUT'],
      [() => Promise.reject(new Error('boom')), 'PROVIDER_ERROR'],
      [ok([{ station: 'ASR' }]), 'ROUTE_INVALID'],
      [ok(st(['ASR', 'XYZ', 'NDLS'])), 'NO_OVERLAP']   // pair in order but nothing shared with RailCore → no corroboration
    ];
    for (const [rr, result] of cases) {
      const m = deps({ railcore: ok(RC_12498), railradar: rr });
      const r: any = await runSameTrainSearch(REQ(), m.d);
      expect(r, result).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', errorClass: 'ROUTE_DATA_UNVERIFIED',
        routeCheck: { verdict: 'ROUTE_UNVERIFIED', primaryProvider: 'railcore', primaryResult: 'STATION_MISSING', crossCheckProvider: 'railradar', crossCheckResult: result } });
      expect(r.message).toMatch(/route data mein ASR nahi mila/);
      expect(r.message).not.toMatch(ABSENCE);
      expect(m.nonRoute()).toEqual([]);
    }
    expect(sameTrainFallbackText(null, 'INVALID_STATION_PAIR')).toBe(SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE);
  });

  it('[E] providers make incompatible claims → ROUTE_DATA_CONFLICT (still INVALID_STATION_PAIR / unverified; no provider picked)', async () => {
    // (1) RailCore holds the pair in the OPPOSITE order to RailRadar
    const rev = deps({ railcore: ok(st([...RR_12498.map(s => s.station)].reverse())), railradar: ok(RR_12498) });
    const r1: any = await runSameTrainSearch(REQ(), rev.d);
    expect(r1).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', errorClass: 'ROUTE_DATA_CONFLICT',
      routeCheck: { verdict: 'ROUTE_DATA_CONFLICT', primaryResult: 'ORDER_NOT_VERIFIED', crossCheckResult: 'ORDER_DISAGREEMENT' } });
    // (2) shared intermediate stations in a different order (PNP/KKDE swapped) while RailCore lacks ASR
    const swap = deps({ railcore: ok(st(['DDL', 'UMB', 'PNP', 'KKDE', 'SNP', 'NDLS'])), railradar: ok(RR_12498) });
    const r2: any = await runSameTrainSearch(REQ(), swap.d);
    expect(r2).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', errorClass: 'ROUTE_DATA_CONFLICT', routeCheck: { verdict: 'ROUTE_DATA_CONFLICT', primaryResult: 'STATION_MISSING' } });
    for (const r of [r1, r2]) {
      expect(r.message).toMatch(/route data .*match nahi karta/);
      expect(r.message).not.toMatch(ABSENCE);
      expect(guardRouteDataClaims(r.message, [failedStep('INVALID_STATION_PAIR')] as any)).toEqual({ text: r.message, removed: [] });
    }
    expect(rev.nonRoute()).toEqual([]); expect(swap.nonRoute()).toEqual([]);
  });

  it('[F] origin after destination → not verified (RailRadar order, RailCore order); a repeated station never verifies', async () => {
    const back = deps({ railcore: ok(RC_12498), railradar: ok(st(['NDLS', 'SNP', 'PNP', 'UMB', 'LDH', 'ASR'])) });
    expect(await runSameTrainSearch(REQ(), back.d)).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', routeCheck: { verdict: 'ROUTE_UNVERIFIED', crossCheckResult: 'ORDER' } });
    // RailCore has ASR after NDLS, RailRadar does not list ASR at all → unverified (absence is not confirmation)
    const rcBack = deps({ railcore: ok(st(['NDLS', 'SNP', 'UMB', 'ASR'])), railradar: ok(st(['NDLS', 'SNP', 'UMB'])) });
    expect(await runSameTrainSearch(REQ(), rcBack.d)).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', routeCheck: { primaryResult: 'ORDER_NOT_VERIFIED', crossCheckResult: 'NOT_IN_ROUTE' } });
    const loop = deps({ railcore: ok(RC_12498), railradar: ok(st(['ASR', 'BEAS', 'ASR', 'UMB', 'NDLS'])) });
    const r: any = await runSameTrainSearch(REQ(), loop.d);
    expect(r.ok).toBe(false);
    expect(r.code).toMatch(/INVALID_STATION_PAIR|INVALID_TRAIN_ROUTE/);
    expect(r.errorClass).not.toBe(undefined);
  });

  it('[G] no availability call during the cross-check (any outcome)', async () => {
    for (const rr of [ok(RR_12498), ok(st(['DDL', 'NDLS', 'UMB'])), { ok: false, error: { code: 'TIMEOUT' } }]) {
      const m = deps({ railcore: ok(RC_12498), railradar: rr });
      await runSameTrainSearch(REQ(), m.d);
      const rrRoute = m.events.indexOf('route:railradar');
      expect(rrRoute).toBe(1);
      expect(m.events.slice(0, rrRoute + 1).filter(e => e.startsWith('avail:'))).toEqual([]);
      expect(m.events.filter(e => e.startsWith('avail:railradar'))).toEqual([]);
    }
  });

  it('[H] no fare call during the cross-check (any outcome)', async () => {
    for (const rr of [ok(RR_12498), { ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }]) {
      const m = deps({ railcore: ok(RC_12498), railradar: rr });
      await runSameTrainSearch(REQ(), m.d);
      expect(m.events.slice(0, 2).filter(e => e.startsWith('fare:'))).toEqual([]);
      expect(m.events.filter(e => e.startsWith('fare:railradar'))).toEqual([]);
    }
  });

  it('[X] cross-check gates: disabled flag, no distinct secondary, route already from the P42.9 fallback, stale request → no extra call', async () => {
    expect(sameTrainLimitsFromEnv({} as any).routeCrossCheck).toBe(true);
    for (const v of ['off', 'false', '0', 'OFF']) expect(sameTrainLimitsFromEnv({ SAME_TRAIN_ROUTE_CROSS_CHECK: v } as any).routeCrossCheck).toBe(false);
    const off = deps({ railcore: ok(RC_12498), railradar: ok(RR_12498) }); off.d.limits = { ...LIMITS, routeCrossCheck: false };
    expect(await runSameTrainSearch(REQ(), off.d)).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', routeCheck: { crossCheckResult: 'DISABLED' } });
    expect(off.routeCalls()).toEqual(['route:railcore']);
    const none = deps({ railcore: ok(RC_12498), railradar: ok(RR_12498) });
    expect(await runSameTrainSearch(REQ({ routeFallback: undefined } as any), none.d)).toMatchObject({ ok: false, routeCheck: { crossCheckResult: 'NOT_CONFIGURED' } });
    expect(await runSameTrainSearch(REQ({ routeFallback: RC } as any), none.d)).toMatchObject({ ok: false, routeCheck: { crossCheckResult: 'NOT_CONFIGURED' } });
    expect(none.routeCalls()).toEqual(['route:railcore', 'route:railcore']);
    // RailCore route busy → the existing P42.9 fallback serves the RailRadar route; it lacks the pair → no second call
    const fb = deps({ railcore: { ok: false, error: { code: 'RATE_LIMITED' } }, railradar: ok(st(['DDL', 'UMB', 'NDLS'])) });
    expect(await runSameTrainSearch(REQ(), fb.d)).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', routeCheck: { crossCheckResult: 'ALREADY_SECONDARY' } });
    expect(fb.routeCalls()).toEqual(['route:railcore', 'route:railradar']);
    // stale request → no cross-check call, stale result
    let journeyChanged = false;
    const stale = deps({ railcore: () => { journeyChanged = true; return ok(RC_12498); }, railradar: ok(RR_12498) });
    stale.d.isCurrent = () => !journeyChanged;
    const rs: any = await runSameTrainSearch(REQ(), stale.d);
    expect(rs).toMatchObject({ ok: false, code: 'STALE_ALTERNATIVE_RESULT', errorClass: 'STALE_SAME_TRAIN_ALTERNATIVE' });
    expect(stale.routeCalls()).not.toContain('route:railradar');
  });

  it('[N] P42-13 guard unchanged: unverified / conflict keep INVALID_STATION_PAIR so the limitation line + Muse claim guard still apply', async () => {
    const steps = [failedStep('INVALID_STATION_PAIR')] as any;
    const g = guardSameTrainRuleClaims('Railway data ke according ASR is route par nahi hai.', steps);
    expect(g.removed).toContain('ROUTE_DATA_UNVERIFIED');
    expect(g.text).toContain(SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE);
    expect(g.text).not.toMatch(ABSENCE);
    expect(SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE).not.toMatch(ABSENCE);
    // a genuinely unusable primary route is still INVALID_TRAIN_ROUTE and is NOT cross-checked (not a pair-verification case)
    const m = deps({ railcore: { ok: false, error: { code: 'NOT_FOUND' } }, railradar: ok(RR_12498) });
    expect(await runSameTrainSearch(REQ(), m.d)).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE' });
    expect(m.routeCalls()).toEqual(['route:railcore']);
    void FAIL_STATES;
  });
});
