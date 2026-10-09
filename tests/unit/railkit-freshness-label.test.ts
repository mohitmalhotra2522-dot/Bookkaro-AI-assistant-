/**
 * 2026-10-09 (approved) — provider FRESHNESS label. A response is freshness-verified ONLY with a provider timestamp within
 * the limit; RailKit (no timestamp field) → "Provider timestamp unavailable — freshness cannot be verified." everywhere:
 * tool result data (any provider, incl. an LLM-selected provider tool), same-train options, Muse view, fallback text and
 * the fresh re-check before Select. The 120-minute guard is unchanged; no timestamp is ever invented.
 * Offline only (injected fetch / stubs, dummy key).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import { providerFreshnessOf, PROVIDER_TIMESTAMP_UNAVAILABLE_LABEL } from '../../shared/provider-freshness';
import { RailwayToolService, providerFreshnessMaxAgeMs } from '../../server/railway/tools/railway-tool-service';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { runWithProvider } from '../../server/railway/providers/provider-scope';
import { createLiveProvider } from '../../server/railway/providers/live/live-config';
import { resetRailKitMonthlyQuota } from '../../server/railway/providers/live/monthly-quota';
import { evaluateAvailabilityAnswer, runSameTrainSearch, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef } from '../../server/railway/same-train/same-train-engine';
import { revalidateSameTrainAlternative } from '../../server/railway/same-train/same-train-service';
import { sameTrainLLMView, sameTrainFallbackText } from '../../server/railway/same-train/same-train-view';
import { SAME_TRAIN_DEFAULT_LIMITS } from '../../shared/same-train-alternatives';

const LABEL = 'Provider timestamp unavailable — freshness cannot be verified.';
const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN).toISOString();

const rkBody = JSON.stringify({ success: true, data: {
  train: { trainNo: '12425', trainName: 'JAMMU RAJDHANI', from: 'LDH', to: 'JAT', travelClass: '3A', quota: 'GN' },
  fare: { baseFare: 700, reservationCharge: 40, superfastCharge: 45, serviceTax: 75, totalFare: 860 },
  availability: [{ date: '20-10-2026', status: 'WAITLIST', availabilityText: 'WL 1', rawStatus: 'RLWL1/WL1', prediction: 'x', predictionPercentage: 90, canBook: true }] } });
const rkFactory = () => createLiveProvider('railkit', { RAILKIT_API_KEY: 'rk-TEST-not-a-key' } as any,
  (async () => ({ status: 200, text: async () => rkBody, headers: { get: () => null } })) as any);
const stub = (providerId: string, providerUpdatedAt: string | null): any => ({
  providerId, label: providerId, source: 'railway-provider', isMock: false,
  checkAvailability: async (r: any) => ({ ok: true, data: { trainNumber: r.trainNumber, travelClass: r.travelClass, date: r.date, status: 'WL 4', available: false, providerUpdatedAt }, meta: {} })
});

afterEach(() => {
  railwayRegistry.register('railkit', () => createLiveProvider('railkit'));
  railwayRegistry.register('railcore', () => createLiveProvider('railcore'));
  railwayRegistry.register('railradar', () => createLiveProvider('railradar'));
  resetRailKitMonthlyQuota();
});

describe('RK-F1 providerFreshnessOf — verified only with a provider timestamp within the limit', () => {
  it('exact label; no / bad / far-future timestamp → TIMESTAMP_UNAVAILABLE; never an invented time', () => {
    expect(PROVIDER_TIMESTAMP_UNAVAILABLE_LABEL).toBe(LABEL);
    for (const v of [undefined, null, '', '  ', 'not-a-date', 1234, new Date(Date.now() + 60 * MIN).toISOString()]) {
      const f = providerFreshnessOf(v, { maxAgeMs: 120 * MIN });
      expect(f).toEqual({ status: 'TIMESTAMP_UNAVAILABLE', freshnessVerified: false, label: LABEL });
    }
    expect(providerFreshnessOf(ago(30), { maxAgeMs: 120 * MIN })).toMatchObject({ status: 'VERIFIED_WITHIN_LIMIT', freshnessVerified: true, ageMinutes: 30, maxAgeMinutes: 120 });
    expect(providerFreshnessOf(ago(300), { maxAgeMs: 120 * MIN })).toMatchObject({ status: 'OLDER_THAN_LIMIT', freshnessVerified: false, ageMinutes: 300 });
    expect(providerFreshnessOf(ago(5), { maxAgeMs: 0 })).toMatchObject({ status: 'NO_LIMIT_CONFIGURED', freshnessVerified: false });
    expect(providerFreshnessOf(new Date(Date.now() + 2 * MIN).toISOString(), { maxAgeMs: 120 * MIN })).toMatchObject({ status: 'VERIFIED_WITHIN_LIMIT', ageMinutes: 0 });  // small clock skew
    expect(providerFreshnessMaxAgeMs({})).toBe(120 * MIN);
    expect(providerFreshnessMaxAgeMs({ SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN: '60' })).toBe(60 * MIN);
  });
});

describe('RK-F2 tool results — any provider, incl. an LLM-selected provider tool (provider scope)', () => {
  it('RailKit via its own provider scope → WL 1 with TIMESTAMP_UNAVAILABLE + exact label (fare too); dated RailCore → VERIFIED_WITHIN_LIMIT', async () => {
    railwayRegistry.register('railkit', rkFactory);
    railwayRegistry.register('railcore', () => stub('railcore', ago(20)));
    railwayRegistry.register('railradar', () => stub('railradar', null));
    const svc = new RailwayToolService();
    const P = { trainNumber: '12425', origin: 'LDH', destination: 'JAT', date: '2026-10-20', travelClass: '3A', passengersCount: 1 } as any;
    const a: any = await runWithProvider('railkit', () => svc.CHECK_AVAILABILITY(P));
    expect(a.ok).toBe(true);
    expect(a.data).toMatchObject({ status: 'WL 1', providerUpdatedAt: null, freshness: { status: 'TIMESTAMP_UNAVAILABLE', freshnessVerified: false, label: LABEL } });
    expect(a.data.freshness.providerUpdatedAt).toBeUndefined();          // never invented
    const f: any = await runWithProvider('railkit', () => svc.GET_FARE(P));
    expect(f.ok).toBe(true); expect(f.data.total).toBe(860);
    expect(f.data.freshness).toMatchObject({ status: 'TIMESTAMP_UNAVAILABLE', label: LABEL });
    const rc: any = await runWithProvider('railcore', () => svc.CHECK_AVAILABILITY(P));
    expect(rc.data.freshness).toMatchObject({ status: 'VERIFIED_WITHIN_LIMIT', freshnessVerified: true, ageMinutes: 20 });
    expect(rc.data.freshness.label).toBeUndefined();
    const rr: any = await runWithProvider('railradar', () => svc.CHECK_AVAILABILITY(P));
    expect(rr.data.freshness).toMatchObject({ status: 'TIMESTAMP_UNAVAILABLE', label: LABEL });   // generic: any undated provider
    expect(JSON.stringify([a, f])).not.toContain('rk-TEST-not-a-key');
  });
});

describe('RK-F3 same-train — label on undated options; the 120-minute guard is unchanged', () => {
  const Q = { trainNumber: '12425', travelClass: '3A', date: '2026-10-20', origin: 'LDH', destination: 'JAT', passengersCount: 1 };
  const ans = (status: string, providerUpdatedAt?: string | null) => ({ ok: true, data: { trainNumber: '12425', travelClass: '3A', date: '2026-10-20', status, providerUpdatedAt } });

  it('evaluateAvailabilityAnswer: undated stays a SUCCESS (label, not a block); dated old → STALE_PROVIDER_DATA (guard)', () => {
    const u = evaluateAvailabilityAnswer(ans('WL 1', null), Q, { maxSnapshotAgeMs: 120 * MIN });
    expect(u.outcome).toBe('SUCCESS');
    expect(u.availability!.freshness).toMatchObject({ status: 'TIMESTAMP_UNAVAILABLE', label: LABEL });
    const d = evaluateAvailabilityAnswer(ans('WL 1', ago(15)), Q, { maxSnapshotAgeMs: 120 * MIN });
    expect(d.availability!.freshness).toMatchObject({ status: 'VERIFIED_WITHIN_LIMIT', freshnessVerified: true });
    const s = evaluateAvailabilityAnswer(ans('WL 1', ago(121)), Q, { maxSnapshotAgeMs: 120 * MIN });
    expect(s).toMatchObject({ outcome: 'FAILED', errorCode: 'STALE_PROVIDER_DATA' });
  });

  const stops = ['A', 'B', 'C', 'D'].map((s, i) => ({ station: s, stationName: `Stop ${s}`, departure: `0${i}:10`, day: 1 }));
  const RK: ProviderRef = { id: 'railkit', label: 'RailKit', level: 'PROVIDER_API' };
  const req = (): SameTrainSearchRequest => ({ sessionId: 's', turnId: 't', requestId: 'r', journeyVersion: 1, trainNumber: '12425', trainName: 'T', date: '2026-10-20',
    travelClass: '3A', classes: ['3A'], passengersCount: 1, origin: 'B', destination: 'D', originSweep: true, destinationSweep: false, destinationExtensionStations: 0,
    combinedPairs: 'NEVER', includeFare: false, webEvidence: false, providers: [RK], routeProvider: RK, webProviders: [], fallbackProviders: {}, routeFallback: null } as any);
  const deps = (updatedAt: () => string | null): SameTrainDeps => ({
    limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 500, totalTimeoutMs: 5000 },
    getRoute: async () => ({ ok: true, data: stops }),
    checkAvailability: async (_p, q) => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: q.origin === 'A' ? 'AVAILABLE-0004' : 'GNWL 5', providerUpdatedAt: updatedAt() } })
  });

  it('undated (RailKit): option carries TIMESTAMP_UNAVAILABLE; verificationStatus unchanged; Muse view + fallback text say the exact label', async () => {
    const out: any = await runSameTrainSearch(req(), deps(() => null));
    expect(out.ok).toBe(true);
    const alt = out.result.alternatives.find((a: any) => a.ticketOrigin === 'A' && a.availability === 'AVAILABLE');
    expect(alt).toBeTruthy();
    expect(alt.freshness).toMatchObject({ status: 'TIMESTAMP_UNAVAILABLE', freshnessVerified: false, label: LABEL });
    expect(['VERIFIED', 'PARTIALLY_VERIFIED']).toContain(alt.verificationStatus);   // binding verification, not freshness
    const v: any = sameTrainLLMView(out.result);
    // all answers undated → the exact label ONCE (transcript budget), no per-entry marker
    expect(v.freshnessNote).toBe(`All answers: ${LABEL}`);
    expect(v.alternatives[alt.alternativeId].freshness).toBeUndefined();
    expect(sameTrainFallbackText(out.result)).toContain(LABEL);
  });

  it('mixed dated / undated answers: only the undated entries carry the marker; the note names them', async () => {
    const d = deps(() => null);
    const base = d.checkAvailability;
    d.checkAvailability = async (p, q, ctx) => { const r: any = await base(p, q, ctx); if (q.origin === 'B') r.data.providerUpdatedAt = ago(10); return r; };
    const out: any = await runSameTrainSearch(req(), d);
    const undated = out.result.alternatives.find((a: any) => a.ticketOrigin === 'A' && a.availability === 'AVAILABLE');
    const dated = out.result.alternatives.find((a: any) => a.ticketOrigin === 'B' && a.freshness);
    expect(dated.freshness.status).toBe('VERIFIED_WITHIN_LIMIT');
    const v: any = sameTrainLLMView(out.result);
    expect(v.alternatives[undated.alternativeId].freshness).toBe('TIMESTAMP_UNAVAILABLE');
    expect(v.alternatives[dated.alternativeId].freshness).toBeUndefined();
    expect(v.freshnessNote).toBe(`Entries with freshness TIMESTAMP_UNAVAILABLE: ${LABEL}`);
  });

  it('dated within the limit: VERIFIED_WITHIN_LIMIT, no label / note', async () => {
    const out: any = await runSameTrainSearch(req(), deps(() => ago(10)));
    const alt = out.result.alternatives.find((a: any) => a.ticketOrigin === 'A' && a.availability === 'AVAILABLE');
    expect(alt.freshness).toMatchObject({ status: 'VERIFIED_WITHIN_LIMIT', freshnessVerified: true });
    const v: any = sameTrainLLMView(out.result);
    expect(v.freshnessNote).toBeUndefined();
    expect(v.alternatives[alt.alternativeId].freshness).toBeUndefined();
    expect(sameTrainFallbackText(out.result)).not.toContain(LABEL);
  });

  it('transcript budget: 40 pairs with fares, all undated — RailKit alone (default routing): the note is in and fits the 14,000-char clip; an explicit two-provider cross-check: the note yields to the budget (options never clipped), every option keeps its label', async () => {
    const LONG = Array.from({ length: 22 }, (_, i) => ({ station: `S${String.fromCharCode(65 + i)}X`, stationName: `Station ${i}` }));
    const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
    const d: SameTrainDeps = {
      limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 500, totalTimeoutMs: 5000, maxParallel: 12 },
      getRoute: async () => ({ ok: true, data: LONG }),
      checkAvailability: async (_p, q) => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: 'GNWL 12', providerUpdatedAt: null } }),
      getFare: async (_p, q) => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, total: 1500, currency: 'INR' } })
    };
    const run = (providers: ProviderRef[]) => runSameTrainSearch({ ...req(), trainNumber: '12014', travelClass: 'CC', classes: undefined, origin: 'SMX', destination: 'SOX', destinationSweep: true,
      combinedPairs: 'ALWAYS', includeFare: true, providers, routeProvider: RC } as any, d);
    // the LLM adapter's own trimming (strings <= 240 chars, arrays <= 12) + envelope, then the 14,000-char clip
    const trim = (v: any, depth = 0): any => v === null || v === undefined || depth > 5 ? v ?? null : Array.isArray(v) ? v.slice(0, 12).map(x => trim(x, depth + 1))
      : typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)])) : typeof v === 'string' && v.length > 240 ? `${v.slice(0, 240)}…` : v;
    const wire = (view: any) => JSON.stringify({ tool: 'SEARCH_SAME_TRAIN_ALTERNATIVES', callId: 'call_0123456789abcdef', ok: true, outcome: 'DATA', dataSource: 'LIVE', providerStatus: 'SUCCESS', data: trim(view) });

    const one: any = await run([RK]);
    expect(one.result.isMock).toBe(false); expect(one.result.candidateCount).toBe(40);
    const v1: any = sameTrainLLMView(one.result);
    expect(v1.freshnessNote).toBe(`All answers: ${LABEL}`);
    expect(JSON.stringify(v1).length).toBeLessThan(14000);
    expect(wire(v1).length).toBeLessThan(14000); expect(wire(v1)).toContain(LABEL);

    const two: any = await run([RK, RC]);
    const v2: any = sameTrainLLMView(two.result);
    expect(v2.freshnessNote).toBeUndefined();                                     // no room left → the note is not added
    expect(JSON.stringify(v2).length).toBeLessThan(14000);                         // … so it never pushes the view past the clip
    expect(Object.keys(v2.alternatives)).toHaveLength(two.result.alternatives.length);
    expect(two.result.alternatives.filter((a: any) => a.freshness).every((a: any) => a.freshness.label === LABEL)).toBe(true);   // screen label
  });

  it('MOCK results (development data, isMock) get no freshness note in the Muse view — isMock already says "not live"', async () => {
    const MK: ProviderRef = { id: 'mock-railkit', label: 'RailKit (MOCK)', level: 'PROVIDER_API', isMock: true } as any;
    const out: any = await runSameTrainSearch({ ...req(), providers: [MK], routeProvider: MK } as any, deps(() => null));
    expect(out.result.isMock).toBe(true);
    expect(sameTrainLLMView(out.result).freshnessNote).toBeUndefined();
  });

  it('fresh re-check before Select: an undated answer is allowed but labelled (never called fresh data)', async () => {
    const d = deps(() => null);
    const out: any = await runSameTrainSearch(req(), d);
    const stored = out.result;
    const alt = stored.alternatives.find((a: any) => a.ticketOrigin === 'A' && a.availability === 'AVAILABLE');
    const r: any = await revalidateSameTrainAlternative(stored, stored.alternativeSearchId, alt.alternativeId, stored.journeyKey, { deps: d, acknowledgeUnverifiedRules: true });
    expect(r.ok).toBe(true);
    expect(r.message).toContain(LABEL);
    expect(r.freshnessUnverified).toBe(true);
    expect(r.fresh[0].freshness).toMatchObject({ status: 'TIMESTAMP_UNAVAILABLE' });
  });

  it('fresh re-check REFUSALS also carry the label when undated (no longer available / not enough seats); a dated re-check has none', async () => {
    const recheck = (status: string, updatedAt: string | null): SameTrainDeps => ({ ...deps(() => null),
      checkAvailability: async (_p, q) => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status, providerUpdatedAt: updatedAt } }) });
    const run = async (pax: number) => { const out: any = await runSameTrainSearch({ ...req(), passengersCount: pax } as any, deps(() => null));
      return { stored: out.result, alt: out.result.alternatives.find((a: any) => a.ticketOrigin === 'A' && a.availability === 'AVAILABLE') }; };
    const { stored, alt } = await run(1);
    const gone: any = await revalidateSameTrainAlternative(stored, stored.alternativeSearchId, alt.alternativeId, stored.journeyKey, { deps: recheck('GNWL 3', null), acknowledgeUnverifiedRules: true });
    expect(gone).toMatchObject({ ok: false, code: 'ALTERNATIVE_NO_LONGER_AVAILABLE' });
    expect(gone.message).toBe(`Fresh check: GNWL 3 — yeh option ab available nahi. ${LABEL}`);
    const dated: any = await revalidateSameTrainAlternative(stored, stored.alternativeSearchId, alt.alternativeId, stored.journeyKey, { deps: recheck('GNWL 3', ago(5)), acknowledgeUnverifiedRules: true });
    expect(dated.code).toBe('ALTERNATIVE_NO_LONGER_AVAILABLE');
    expect(dated.message).not.toContain(LABEL);
    const two = await run(2);
    const few: any = await revalidateSameTrainAlternative(two.stored, two.stored.alternativeSearchId, two.alt.alternativeId, two.stored.journeyKey, { deps: recheck('AVAILABLE-0001', null), acknowledgeUnverifiedRules: true });
    expect(few).toMatchObject({ ok: false, code: 'ALTERNATIVE_INSUFFICIENT_SEATS' });
    expect(few.message).toContain(LABEL);
  });
});
