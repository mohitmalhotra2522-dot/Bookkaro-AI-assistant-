/**
 * 2026-10-09 — same-train freshness (all trains): a provider availability snapshot older than the freshness limit
 * (providerUpdatedAt, default 120 min, SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN) is NEVER a verdict — FAILED / STALE_PROVIDER_DATA,
 * the search is PARTIAL / not complete, the stale status + time are reported as "not confirmed", no fallback launders it.
 * Route below is TEST DATA shaped like the reported case (origin sweep up to the train's origin). MOCK only.
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import {
  evaluateAvailabilityAnswer, snapshotAgeMs, runSameTrainSearch, sameTrainLimitsFromEnv,
  type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery
} from '../../server/railway/same-train/same-train-engine';
import { sameTrainLLMView, sameTrainCardData } from '../../server/railway/same-train/same-train-view';
import { SAME_TRAIN_DEFAULT_LIMITS, SameTrainErrorCode as E } from '../../shared/same-train-alternatives';
import { partialCountText, checkSummaryOf, staleLineText, staleTimeIST } from '../../src/components/trains/SameTrainInline';

const ROUTE = [['NDLS', 'New Delhi'], ['LDH', 'Ludhiana Jn'], ['PTKC', 'Pathankot Cantt'], ['MSKT', 'Station M'], ['JAT', 'Jammu Tawi']]
  .map(([station, stationName], i) => ({ station, stationName, departure: `0${i}:00`, day: 1 }));
const DATE = '2026-10-20';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN).toISOString();
const Q: AvailabilityQuery = { trainNumber: '12425', travelClass: '3A', date: DATE, origin: 'NDLS', destination: 'JAT', passengersCount: 1 };
const ans = (status: string, updated?: string | null) => ({ ok: true, data: { trainNumber: '12425', travelClass: '3A', date: DATE, status, ...(updated !== undefined ? { providerUpdatedAt: updated } : {}) } });

type Row = { status: string; updated?: string | null };
function mkDeps(rows: (p: ProviderRef, q: AvailabilityQuery) => Row, limits: any = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 300, totalTimeoutMs: 3000 }) {
  const calls: string[] = [];
  const deps: SameTrainDeps = {
    limits,
    getRoute: async () => ({ ok: true, data: ROUTE }),
    checkAvailability: async (p, q) => {
      calls.push(`${p.id}:${q.origin}-${q.destination}:${q.travelClass}`);
      const r = rows(p, q);
      return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: r.status, ...(r.updated !== undefined ? { providerUpdatedAt: r.updated } : {}) } };
    }
  };
  return { deps, calls };
}
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's-stale', turnId: 't1', requestId: 'r1', journeyVersion: 1,
  trainNumber: '12425', date: DATE, travelClass: '3A', passengersCount: 1, origin: 'LDH', destination: 'JAT',
  originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false,
  providers: [RC], routeProvider: RC, webProviders: [], fallbackProviders: { railcore: RR }, ...over
} as any);

describe('freshness of one provider answer', () => {
  it('[S1] snapshot older than the limit → FAILED / STALE_PROVIDER_DATA with the stale status + time kept (never SUCCESS)', () => {
    const r = evaluateAvailabilityAnswer(ans('GNWL84/WL17', ago(282)), Q, { maxSnapshotAgeMs: 60 * MIN });
    expect(r.outcome).toBe('FAILED');
    expect(r.errorCode).toBe(E.STALE_PROVIDER_DATA);
    expect(r.availability).toBeUndefined();
    expect(r.staleSnapshot).toMatchObject({ status: 'GNWL84/WL17' });
    expect(r.staleSnapshot!.ageMinutes).toBeGreaterThanOrEqual(281);
  });
  it('[S2] fresh snapshot / no timestamp / unparsable / future (clock skew) → SUCCESS as before', () => {
    expect(evaluateAvailabilityAnswer(ans('RAC 77', ago(5)), Q, { maxSnapshotAgeMs: 60 * MIN }).outcome).toBe('SUCCESS');
    expect(evaluateAvailabilityAnswer(ans('RAC 77'), Q, { maxSnapshotAgeMs: 60 * MIN }).outcome).toBe('SUCCESS');
    expect(evaluateAvailabilityAnswer(ans('RAC 77', null), Q, { maxSnapshotAgeMs: 60 * MIN }).outcome).toBe('SUCCESS');
    expect(evaluateAvailabilityAnswer(ans('RAC 77', 'not-a-date'), Q, { maxSnapshotAgeMs: 60 * MIN }).outcome).toBe('SUCCESS');
    expect(evaluateAvailabilityAnswer(ans('RAC 77', new Date(Date.now() + 10 * MIN).toISOString()), Q, { maxSnapshotAgeMs: 60 * MIN }).outcome).toBe('SUCCESS');
  });
  it('[S3] the check applies to every status (an old AVAILABLE is not a seat either); limit 0 / absent = off', () => {
    expect(evaluateAvailabilityAnswer(ans('AVAILABLE-0012', ago(90)), Q, { maxSnapshotAgeMs: 60 * MIN }).errorCode).toBe(E.STALE_PROVIDER_DATA);
    expect(evaluateAvailabilityAnswer(ans('AVAILABLE-0012', ago(90)), Q, { maxSnapshotAgeMs: 0 }).outcome).toBe('SUCCESS');
    expect(evaluateAvailabilityAnswer(ans('AVAILABLE-0012', ago(90)), Q).outcome).toBe('SUCCESS');
  });
  it('[S4] provider offset timestamps (+05:30) are parsed; snapshotAgeMs is null without a timestamp', () => {
    const now = Date.parse('2026-10-09T11:47:00+05:30');
    expect(snapshotAgeMs('2026-10-09T07:05:27+05:30', now)).toBe(Date.parse('2026-10-09T11:47:00+05:30') - Date.parse('2026-10-09T07:05:27+05:30'));
    expect(snapshotAgeMs(undefined, now)).toBeNull();
    expect(snapshotAgeMs('', now)).toBeNull();
  });
  it('[S5] env: default 120 min; SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN overrides (0 = off), bounded', () => {
    expect(sameTrainLimitsFromEnv({} as any).maxSnapshotAgeMs).toBe(120 * MIN);
    expect(SAME_TRAIN_DEFAULT_LIMITS.maxSnapshotAgeMs).toBe(120 * MIN);
    expect(sameTrainLimitsFromEnv({ SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN: '30' } as any).maxSnapshotAgeMs).toBe(30 * MIN);
    expect(sameTrainLimitsFromEnv({ SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN: '0' } as any).maxSnapshotAgeMs).toBe(0);
  });
});

describe('same-train search with a stale snapshot (any train)', () => {
  it('[S6] origin pair stale → search PARTIAL, not complete, stale reported (status + time), never "no seat", no fallback call', async () => {
    const stale = ago(282);
    const { deps, calls } = mkDeps((_p, q) => q.origin === 'NDLS' ? { status: 'GNWL84/WL17', updated: stale } : { status: 'RLWL1/WL1', updated: ago(3) });
    const r = await runSameTrainSearch(REQ(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.result;
    expect(res.status).toBe('PARTIAL');
    expect(res.searchComplete).toBe(false);
    expect(res.errors).toContain(E.STALE_PROVIDER_DATA);
    expect(res.checkSummary!.stale).toBeGreaterThanOrEqual(1);
    const st = res.staleChecks!.find(c => c.ticketOrigin === 'NDLS' && c.ticketDestination === 'JAT' && c.travelClass === '3A')!;
    expect(st).toMatchObject({ provider: 'railcore', status: 'GNWL84/WL17', providerUpdatedAt: stale });
    // a stale answer is never a verdict: the pair stays UNKNOWN / UNVERIFIED (like a timeout), never WAITLIST / no seat
    const nd = res.alternatives.find(a => a.ticketOrigin === 'NDLS' && a.ticketDestination === 'JAT' && a.travelClass === '3A');
    if (nd) { expect(nd.availability).toBe('UNKNOWN'); expect(nd.verificationStatus).toBe('UNVERIFIED'); expect(nd.availabilityStatusText).toBeUndefined(); }
    // STALE is not a fallback-eligible fault: the secondary (same upstream snapshot) is never asked to launder it
    expect(calls.some(c => c.startsWith('railradar:'))).toBe(false);
    // the LLM view says it is not a verdict; the card carries the stale list for the screen
    const v: any = sameTrainLLMView(res);
    expect(v.searchComplete).toBe(false);
    expect(v.staleChecksNotVerdict.join(' ')).toMatch(/NDLS→JAT 3A: provider snapshot \d+ min old \(GNWL84\/WL17\) — fresh status not confirmed/);
    const card: any = sameTrainCardData(res);
    expect(card.staleChecks.length).toBe(res.staleChecks!.length);
  });
  it('[S7] fresh answers everywhere → unchanged behaviour (complete, no stale fields)', async () => {
    const { deps } = mkDeps(() => ({ status: 'GNWL 12', updated: ago(2) }));
    const r = await runSameTrainSearch(REQ(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.searchComplete).toBe(true);
    expect(r.result.staleChecks).toBeUndefined();
    expect(r.result.checkSummary!.stale).toBe(0);
    expect(r.result.errors).not.toContain(E.STALE_PROVIDER_DATA);
  });
  it('[S8] a stale RAC / AVAILABLE on an earlier station is NOT offered as an option (fresh-only)', async () => {
    const { deps } = mkDeps((_p, q) => q.origin === 'NDLS' ? { status: 'RAC 77', updated: ago(240) } : { status: 'GNWL 12', updated: ago(2) });
    const r = await runSameTrainSearch(REQ(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.verifiedAlternativeCount).toBe(0);
    expect(r.result.staleChecks!.some(c => c.status === 'RAC 77')).toBe(true);
    expect(r.result.status).toBe('PARTIAL');
  });
  it('[S9] every check stale → failure carries the stale list (never ALTERNATIVE_NOT_FOUND)', async () => {
    const { deps } = mkDeps(() => ({ status: 'GNWL 50', updated: ago(300) }));
    const r: any = await runSameTrainSearch(REQ(), deps);
    expect(r.ok).toBe(false);
    expect(r.code).toBe(E.SEARCH_FAILED);
    expect(r.partial.staleChecks.length).toBeGreaterThan(0);
  });
});

describe('stale texts (UI helpers)', () => {
  it('[S10] partial count text names stale data separately; unchanged wording without stale', () => {
    expect(partialCountText({ total: 40, unchecked: 4 })).toBe('Search adhoora: 4 / 40 checks provider limit / error ki wajah se nahi ho paaye — inke liye koi result nahi.');
    expect(partialCountText({ total: 3, unchecked: 1, stale: 1 })).toBe('Search adhoora: 1 / 3 checks ka provider data purana tha — inke liye fresh result nahi.');
    expect(partialCountText({ total: 10, unchecked: 3, stale: 1 })).toMatch(/3 \/ 10 checks verify nahi ho paaye \(1 purana provider data, 2 provider limit \/ error\)/);
    expect(checkSummaryOf({ checkSummary: { total: 3, succeeded: 2, failed: 1, skipped: 0, retried: 0, paced: true, stale: 1 } })).toEqual({ total: 3, succeeded: 2, unchecked: 1, stale: 1 });
  });
  it('[S11] stale line: route, class, provider time in IST, age, status, "fresh status confirm nahi"', () => {
    expect(staleTimeIST('2026-10-09T07:05:27+05:30')).toBe('07:05');
    expect(staleLineText({ ticketOrigin: 'NDLS', ticketDestination: 'JAT', travelClass: '3A', status: 'GNWL84/WL17', providerUpdatedAt: '2026-10-09T07:05:27+05:30', ageMinutes: 282 }))
      .toBe('NDLS → JAT 3A: provider data 07:05 ka (282 min purana · GNWL84/WL17) — fresh status confirm nahi ho paaya');
  });
});
