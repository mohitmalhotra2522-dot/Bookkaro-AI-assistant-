/**
 * P42-13 (follow-up) — RailCore route-DATA limitation is never presented as a railway fact.
 * When the provider's route data does not contain (or order) the requested station pair the engine keeps the
 * deterministic INVALID_STATION_PAIR code (+ errorClass ROUTE_DATA_UNVERIFIED) but words it as "the route data could not
 * verify this pair"; the claim guard replaces a definite "ASR is route par nahi hai" with the truthful limitation line;
 * a genuinely unusable route stays INVALID_TRAIN_ROUTE; no alternative is invented; no extra provider call is made.
 * Test data only (the observed 12498 shape: RailCore schedule starts at DDL, no ASR).
 */
import { describe, it, expect } from 'vitest';
import { runSameTrainSearch, planCandidates, normalizeRoute, type SameTrainDeps, type ProviderRef, type SameTrainSearchRequest } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS, SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE, SAME_TRAIN_ALL_FAILED_MESSAGE } from '../../shared/same-train-alternatives';
import { sameTrainFallbackText } from '../../server/railway/same-train/same-train-view';
import { guardSameTrainRuleClaims, guardRouteDataClaims } from '../../server/ai/response/same-train-claims';

const DATE = '2026-10-09';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
/** observed RailCore 12498 schedule (test data): DDL … NDLS — no ASR / BEAS / JUC / LDH */
const ROUTE_12498 = ['DDL', 'KNN', 'RPJ', 'UMB', 'KKDE', 'KUN', 'PNP', 'BDMJ', 'SNP', 'SZM', 'NDLS'].map(station => ({ station, stationName: station }));
const LIMITS = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 150, totalTimeoutMs: 2000 };
function deps(route: any) {
  const calls: string[] = []; const routeCalls: string[] = []; const fareCalls: string[] = [];
  const d: SameTrainDeps = {
    limits: LIMITS,
    getRoute: async p => { routeCalls.push(p.id); return typeof route === 'function' ? route(p) : route; },
    checkAvailability: async (p, q) => { calls.push(`${p.id}:${q.origin}-${q.destination}`); return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: 'AVAILABLE-0009' } }; },
    getFare: async p => { fareCalls.push(p.id); return { ok: true, data: { total: 1, currency: 'INR' } }; }
  };
  return { d, calls, routeCalls, fareCalls };
}
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 1, trainNumber: '12498', date: DATE, travelClass: 'CC', passengersCount: 1,
  origin: 'ASR', destination: 'NDLS', originSweep: true, destinationSweep: true, combinedPairs: 'AUTO', includeFare: true, webEvidence: false,
  providers: [RC], routeProvider: RC, routeFallback: RR, fallbackProviders: { railcore: RR }, webProviders: [], ...over
} as any);
const failedStep = (code: string, status = 'error') => ({ status, result: { toolName: 'SEARCH_SAME_TRAIN_ALTERNATIVES', error: { code, message: 'x' } } });
const ABSENCE = /route\s*(par|pe|mein|me)\s*nahi|not on (this|the|its) (train'?s? )?route|रूट\s*पर\s*नहीं|nahi rukti/i;

describe('P42-13 — route-data limitation is truthful', () => {
  it('[A] provider route missing the requested station → INVALID_STATION_PAIR kept, errorClass ROUTE_DATA_UNVERIFIED, data-relative wording', async () => {
    const m = deps({ ok: true, data: ROUTE_12498 });
    const r = await runSameTrainSearch(REQ(), m.d);
    expect(r).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', errorClass: 'ROUTE_DATA_UNVERIFIED' });
    if (r.ok) throw new Error('expected failure');
    expect(r.message).toMatch(/route data mein ASR nahi mila/);
    expect(r.message).toMatch(/adhoora ho sakta hai|verify nahi ho paaya/);
    expect(sameTrainFallbackText(null, 'INVALID_STATION_PAIR')).toBe(SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE);
    expect(SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE).toMatch(/route data .*verify nahi/);
  });
  it('[B] no definite real-world claim: neither the engine message, the fallback line nor guarded Muse wording says the station is not on the route', async () => {
    const r = await runSameTrainSearch(REQ(), deps({ ok: true, data: ROUTE_12498 }).d);
    if (r.ok) throw new Error('expected failure');
    // the engine message only describes the data (and explicitly does not deny the stop)
    expect(r.message).not.toMatch(/route par nahi (hai|mila\.)$/);
    expect(guardRouteDataClaims(r.message, [failedStep('INVALID_STATION_PAIR')] as any)).toEqual({ text: r.message, removed: [] });
    expect(SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE).not.toMatch(ABSENCE);
    const steps = [failedStep('INVALID_STATION_PAIR')] as any;
    for (const muse of [
      'Railway data ke according is train ka origin Dhandari Kalan DDL hai aur yeh NDLS tak jaati hai, ASR is route par nahi hai.',   // observed live
      'ASR is not on this train\'s route.',
      '12498 ASR इस ट्रेन के रूट पर नहीं है।',
      'Yeh train ASR par nahi rukti.'
    ]) {
      const g = guardSameTrainRuleClaims(muse, steps);
      expect(g.removed).toContain('ROUTE_DATA_UNVERIFIED');
      expect(g.text).not.toMatch(ABSENCE);
      expect(g.text).toContain(SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE);
    }
    // several absence sentences → the limitation line appears once; other sentences survive untouched
    const many = guardSameTrainRuleClaims('ASR is route par nahi hai. 12498 ka departure 05:30 hai. NDLS route mein nahi aata.', steps);
    expect(many.text).toBe(`${SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE} 12498 ka departure 05:30 hai.`);
    // hedged wording is kept as Muse wrote it
    const hedged = 'Current route data mein ASR nahi mila, isliye yeh verify nahi ho paaya — route par nahi hai aisa pakka nahi keh sakte.';
    expect(guardSameTrainRuleClaims(hedged, steps)).toEqual({ text: hedged, removed: [] });
  });
  it('[C] a genuinely unusable route stays INVALID_TRAIN_ROUTE (distinct class); the guard only acts on the route-data case', async () => {
    expect(await runSameTrainSearch(REQ(), deps({ ok: false, error: { code: 'NOT_FOUND' } }).d)).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE', errorClass: 'INVALID_TRAIN_ROUTE' });
    expect(await runSameTrainSearch(REQ(), deps({ ok: true, data: [{ station: 'ASR' }] }).d)).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE', errorClass: 'INVALID_TRAIN_ROUTE' });
    const loop = normalizeRoute([{ station: 'ASR' }, { station: 'BBB' }, { station: 'ASR' }, { station: 'NDLS' }]);
    if (!loop.ok) throw new Error('route');
    expect(planCandidates(loop.stations, loop.duplicates, { origin: 'ASR', destination: 'NDLS', originSweep: true, destinationSweep: true } as any, LIMITS)).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE' });
    // wrong direction in the data → still INVALID_STATION_PAIR / ROUTE_DATA_UNVERIFIED, worded as what the data shows
    const dir = await runSameTrainSearch(REQ({ origin: 'NDLS', destination: 'UMB' }), deps({ ok: true, data: ROUTE_12498 }).d);
    expect(dir).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', errorClass: 'ROUTE_DATA_UNVERIFIED' });
    if (!dir.ok) expect(dir.message).toMatch(/route data mein .*nahi dikh raha/);
    // the guard does nothing for other failures, rejected calls or successful searches
    const claim = 'ASR is route par nahi hai.';
    for (const st of [failedStep('INVALID_TRAIN_ROUTE'), failedStep('RATE_LIMITED'), failedStep('INVALID_STATION_PAIR', 'rejected')]) {
      expect(guardSameTrainRuleClaims(claim, [st] as any)).toEqual({ text: claim, removed: [] });
    }
    expect(guardSameTrainRuleClaims(claim, [])).toEqual({ text: claim, removed: [] });
    expect(sameTrainFallbackText(null, 'INVALID_TRAIN_ROUTE')).toMatch(/route verify nahi/);
    expect(sameTrainFallbackText(null, 'ALTERNATIVE_SEARCH_FAILED')).toBe(SAME_TRAIN_ALL_FAILED_MESSAGE);
  });
  it('[D] no fabricated alternative: the failure carries no result / alternatives and no availability or fare was requested', async () => {
    const m = deps({ ok: true, data: ROUTE_12498 });
    const r: any = await runSameTrainSearch(REQ(), m.d);
    expect(r.ok).toBe(false);
    expect(r.result).toBeUndefined();
    expect(JSON.stringify(r)).not.toMatch(/alternatives|AVAILABLE/);
    expect(m.calls).toEqual([]); expect(m.fareCalls).toEqual([]);
  });
  it('[E] no new provider call: the route comes from RailCore once; RailRadar (configured as fallback) is never called for a route-data limitation', async () => {
    const m = deps({ ok: true, data: ROUTE_12498 });
    await runSameTrainSearch(REQ(), m.d);
    expect(m.routeCalls).toEqual(['railcore']);
    expect(m.calls.filter(c => c.startsWith('railradar'))).toEqual([]);
  });
});
