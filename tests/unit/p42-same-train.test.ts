/**
 * P42 — Same Train Alternative (G2 focused, MOCK only — no network, no credits).
 * Engine planning / execution / validation / conflict / staleness, the tool validator, the claim + availability
 * guards, the LLM / card views and the explicit-selection revalidation. Provider adapters are deterministic fakes;
 * the route below is TEST DATA (the app never hardcodes routes — it always comes from a route-capable provider).
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import {
  normalizeRoute, planCandidates, availabilityCategory, statusKey, evaluateAvailabilityAnswer, evaluateFareAnswer,
  runSameTrainSearch, sameTrainLimitsFromEnv, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery
} from '../../server/railway/same-train/same-train-engine';
import { revalidateSameTrainAlternative, currentSameTrainKey, isSameTrainResultStale } from '../../server/railway/same-train/same-train-service';
import { sameTrainLLMView, sameTrainCardData, sameTrainFallbackText } from '../../server/railway/same-train/same-train-view';
import { guardSameTrainRuleClaims } from '../../server/ai/response/same-train-claims';
import { collectAvailabilityEvidence } from '../../server/ai/response/availability-authority';
import { SAME_TRAIN_ALL_FAILED_MESSAGE, SAME_TRAIN_DEFAULT_LIMITS, type SameTrainAlternativesResult } from '../../shared/same-train-alternatives';
import { REGISTERED_TOOLS, sameTrainAlternativesEnabledFromEnv } from '../../server/ai/tools/tool-registry';
import { RAILWAY_TOOL_NAMES } from '../../shared/railway-tool-runtime';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';

// ---------------------------------------------------------------- fixtures (test data only)
const ROUTE = [
  ['ASR', 'Amritsar Jn'], ['BEAS', 'Beas'], ['JUC', 'Jalandhar City'], ['PGW', 'Phagwara Jn'], ['LDH', 'Ludhiana Jn'],
  ['SIR', 'Sirhind Jn'], ['RPJ', 'Rajpura Jn'], ['UMB', 'Ambala Cant Jn'], ['KKDE', 'Kurukshetra Jn'], ['PNP', 'Panipat Jn'], ['NDLS', 'New Delhi']
].map(([station, stationName], i) => ({ station, stationName, departure: `0${i}:00`, day: 1 }));
const LONG_ROUTE = Array.from({ length: 22 }, (_, i) => ({ station: `S${String.fromCharCode(65 + i)}X`, stationName: `Station ${i}` }));
const TOMORROW = '2026-10-07';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
const WEB: ProviderRef = { id: 'erail', label: 'eRail', level: 'UNVERIFIED_WEB' };
const LIMITS = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 200, totalTimeoutMs: 2000 };

type StatusFn = (p: ProviderRef, q: AvailabilityQuery) => string | { error: string } | { raw: any } | 'HANG';
function mkDeps(o: { status?: StatusFn; route?: any; fare?: (p: ProviderRef, q: AvailabilityQuery) => any; extra?: Partial<SameTrainDeps> } = {}) {
  const calls: Array<{ p: string; q: AvailabilityQuery }> = [];
  const routeCalls: string[] = [];
  const fareCalls: string[] = [];
  const inFlight: Record<string, number> = {}; const maxInFlight: Record<string, number> = {};
  const deps: SameTrainDeps = {
    limits: LIMITS,
    getRoute: async (p) => { routeCalls.push(p.id); return o.route !== undefined ? (typeof o.route === 'function' ? o.route(p) : o.route) : { ok: true, data: ROUTE }; },
    checkAvailability: async (p, q) => {
      calls.push({ p: p.id, q });
      inFlight[p.id] = (inFlight[p.id] || 0) + 1; maxInFlight[p.id] = Math.max(maxInFlight[p.id] || 0, inFlight[p.id]);
      await new Promise(r => setTimeout(r, 2));
      inFlight[p.id]--;
      const s = (o.status || (() => 'GNWL 12'))(p, q);
      if (s === 'HANG') return new Promise(() => { /* never resolves */ });
      if (typeof s === 'object' && 'error' in s) return { ok: false, error: { code: s.error } };
      if (typeof s === 'object' && 'raw' in s) return s.raw;
      return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: s } };
    },
    getFare: async (p, q) => { fareCalls.push(`${p.id}:${q.origin}-${q.destination}`); return o.fare ? o.fare(p, q) : { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, total: 1500, currency: 'INR' } }; },
    ...(o.extra || {})
  };
  return { deps, calls, routeCalls, fareCalls, maxInFlight };
}
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 1,
  trainNumber: '12014', date: TOMORROW, travelClass: 'CC', passengersCount: 1, origin: 'LDH', destination: 'UMB',
  originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false,
  providers: [RC, RR], routeProvider: RC, webProviders: [], ...over
});
const pair = (q: AvailabilityQuery) => `${q.origin}-${q.destination}`;
const okRes = async (req: SameTrainSearchRequest, deps: SameTrainDeps) => {
  const r = await runSameTrainSearch(req, deps);
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.result;
};
const byPair = (r: SameTrainAlternativesResult, p: string) => r.alternatives.find(a => a.pairId === p)!;
const stations = () => { const n = normalizeRoute(ROUTE); if (!n.ok) throw new Error('route'); return n; };

// ================================================================= 1. route + planning

/** Phase 2 shared policy (user-authorized 2026-10-09, "mixed"): tests that pin the PRE-Phase-2 Muse rules run with the
 *  documented rollback switch SAME_TRAIN_MUSE_SHARED_POLICY=off; the env is restored afterwards. Assertions unchanged. */
async function withMuseSharedPolicyOff(fn: () => unknown): Promise<void> {
  const prev = process.env.SAME_TRAIN_MUSE_SHARED_POLICY;
  process.env.SAME_TRAIN_MUSE_SHARED_POLICY = 'off';
  try { await fn(); } finally { if (prev === undefined) delete process.env.SAME_TRAIN_MUSE_SHARED_POLICY; else process.env.SAME_TRAIN_MUSE_SHARED_POLICY = prev; }
}

describe('P42 G2 — route + candidate planning', () => {
  it('[1] route is normalised from provider stops (order kept, codes upper-cased, < 2 stations → INVALID_TRAIN_ROUTE)', () => {
    const n = stations();
    expect(n.stations.map(s => s.code)).toEqual(ROUTE.map(r => r.station));
    expect(n.stations[4]).toMatchObject({ code: 'LDH', name: 'Ludhiana Jn', index: 4 });
    expect(normalizeRoute([{ station: 'ASR' }])).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE' });
    expect(normalizeRoute(null)).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE' });
    expect(normalizeRoute({ stops: ROUTE }).ok).toBe(true);
  });
  it('[2] origin sweep = train origin … requested origin, nearest first (P1); requested pair is P0 and first', () => {
    const n = stations();
    const r = planCandidates(n.stations, n.duplicates, { origin: 'LDH', destination: 'UMB', originSweep: true, destinationSweep: false }, LIMITS);
    if (!r.ok) throw new Error();
    expect(r.plan.originAlternatives.map(s => s.code)).toEqual(['ASR', 'BEAS', 'JUC', 'PGW']);
    expect(r.plan.phase1[0]).toMatchObject({ priority: 'P0', kind: 'REQUESTED', ticketOrigin: 'LDH', ticketDestination: 'UMB' });
    expect(r.plan.phase1.slice(1).map(p => p.ticketOrigin)).toEqual(['PGW', 'JUC', 'BEAS', 'ASR']);
    expect(r.plan.phase1.slice(1).every(p => p.priority === 'P1' && p.ticketDestination === 'UMB')).toBe(true);
    expect(r.plan.destinationSweep).toBe('DISABLED');
  });
  it('[3] requested destination == terminal → NONE_TERMINAL (no destination sweep, no P2 / P3)', () => {
    const n = stations();
    const r = planCandidates(n.stations, n.duplicates, { origin: 'LDH', destination: 'NDLS', originSweep: true, destinationSweep: true, combinedPairs: 'ALWAYS' }, LIMITS);
    if (!r.ok) throw new Error();
    expect(r.plan.destinationSweep).toBe('NONE_TERMINAL');
    expect(r.plan.destinationExtension).toEqual([]);
    expect([...r.plan.phase1, ...r.plan.phase2].some(p => p.priority === 'P2' || p.priority === 'P3')).toBe(false);
  });
  it('[4] destination extension never goes past the terminal and never invents stations', () => {
    const n = stations();
    const r = planCandidates(n.stations, n.duplicates, { origin: 'LDH', destination: 'UMB', originSweep: false, destinationSweep: true, destinationExtensionStations: 7 }, LIMITS);
    if (!r.ok) throw new Error();
    expect(r.plan.destinationExtension.map(s => s.code)).toEqual(['KKDE', 'PNP', 'NDLS']);   // only 3 exist after UMB
    expect(r.plan.phase1.filter(p => p.priority === 'P2').map(p => p.ticketDestination)).toEqual(['KKDE', 'PNP', 'NDLS']);
  });
  it('[5] extension length: default 6, Muse value clamped to 5..7', () => {
    const n = normalizeRoute(LONG_ROUTE); if (!n.ok) throw new Error();
    const ext = (k?: number) => { const r = planCandidates(n.stations, n.duplicates, { origin: 'SCX', destination: 'SEX', originSweep: false, destinationSweep: true, destinationExtensionStations: k }, LIMITS); if (!r.ok) throw new Error(); return r.plan.destinationExtension.length; };
    expect(ext()).toBe(6); expect(ext(5)).toBe(5); expect(ext(7)).toBe(7); expect(ext(2)).toBe(5); expect(ext(30)).toBe(7);
  });
  it('[6] off-route station → INVALID_STATION_PAIR; wrong direction → INVALID_STATION_PAIR; repeated station → INVALID_TRAIN_ROUTE', () => {
    const n = stations();
    expect(planCandidates(n.stations, n.duplicates, { origin: 'BCT', destination: 'UMB', originSweep: true, destinationSweep: true }, LIMITS)).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR' });
    expect(planCandidates(n.stations, n.duplicates, { origin: 'UMB', destination: 'LDH', originSweep: true, destinationSweep: true }, LIMITS)).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR' });
    const loop = normalizeRoute([{ station: 'AAA' }, { station: 'BBB' }, { station: 'CCC' }, { station: 'BBB' }, { station: 'DDD' }]); if (!loop.ok) throw new Error();
    expect(planCandidates(loop.stations, loop.duplicates, { origin: 'BBB', destination: 'DDD', originSweep: true, destinationSweep: true }, LIMITS)).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE' });
  });
  it('[7] caps: maxCandidatePairs bounds everything (P0 always kept, truncated flagged); originSweep=false → no P1', () => {
    const n = stations();
    const r = planCandidates(n.stations, n.duplicates, { origin: 'LDH', destination: 'UMB', originSweep: true, destinationSweep: true, combinedPairs: 'ALWAYS' }, { ...LIMITS, maxCandidatePairs: 3 });
    if (!r.ok) throw new Error();
    expect(r.plan.phase1.length + r.plan.phase2.length).toBe(3);
    expect(r.plan.phase1[0].priority).toBe('P0');
    expect(r.plan.truncated).toBe(true);
    const r2 = planCandidates(n.stations, n.duplicates, { origin: 'LDH', destination: 'UMB', originSweep: false, destinationSweep: true }, LIMITS);
    if (!r2.ok) throw new Error();
    expect(r2.plan.phase1.some(p => p.priority === 'P1')).toBe(false);
  });
  it('[8] P3 combined pairs only when allowed, ordered by smallest deviation; NEVER → none; no duplicate pairs', () => {
    const n = stations();
    const r = planCandidates(n.stations, n.duplicates, { origin: 'LDH', destination: 'UMB', originSweep: true, destinationSweep: true, combinedPairs: 'AUTO' }, LIMITS);
    if (!r.ok) throw new Error();
    expect(r.plan.phase2[0]).toMatchObject({ priority: 'P3', ticketOrigin: 'PGW', ticketDestination: 'KKDE' });
    expect(r.plan.phase2.length).toBe(4 * 3);
    const ids = [...r.plan.phase1, ...r.plan.phase2].map(p => p.pairId);
    expect(new Set(ids).size).toBe(ids.length);
    const r2 = planCandidates(n.stations, n.duplicates, { origin: 'LDH', destination: 'UMB', originSweep: true, destinationSweep: true, combinedPairs: 'NEVER' }, LIMITS);
    if (!r2.ok) throw new Error();
    expect(r2.plan.phase2).toEqual([]);
  });
  it('[9] limits from env are clamped (no unbounded fan-out)', () => {
    const l = sameTrainLimitsFromEnv({ SAME_TRAIN_MAX_CANDIDATE_PAIRS: '9999', SAME_TRAIN_MAX_PARALLEL: '0', SAME_TRAIN_MAX_DESTINATION_SWEEP: '50' } as any);
    expect(l.maxCandidatePairs).toBeLessThanOrEqual(80);
    expect(l.maxParallel).toBeGreaterThanOrEqual(1);
    expect(l.maxDestinationSweep).toBeLessThanOrEqual(7);
    expect(sameTrainLimitsFromEnv({} as any)).toMatchObject({ maxCandidatePairs: 40, maxDestinationSweep: 6 });
  });
});

// ================================================================= 2. provider answer validation
describe('P42 G2 — provider answers', () => {
  const q: AvailabilityQuery = { trainNumber: '12014', travelClass: 'CC', date: TOMORROW, origin: 'ASR', destination: 'UMB', passengersCount: 1 };
  it('[10] status categories preserved; unknown text stays UNKNOWN (never NOT_AVAILABLE)', () => {
    expect(availabilityCategory('AVAILABLE 0045')).toBe('AVAILABLE');
    expect(availabilityCategory('CURR_AVBL-0012')).toBe('AVAILABLE');
    expect(availabilityCategory('RAC 4')).toBe('RAC');
    expect(availabilityCategory('GNWL 12/WL 8')).toBe('WAITLIST');
    expect(availabilityCategory('REGRET')).toBe('NOT_AVAILABLE');
    expect(availabilityCategory('TRAIN CANCELLED')).toBe('NOT_AVAILABLE');
    for (const s of ['', 'CHART PREPARED', 'xyz', null]) expect(availabilityCategory(s)).toBe('UNKNOWN');
    expect(statusKey('WL 12')).not.toBe(statusKey('WL 15'));
    expect(statusKey('GNWL 12')).toBe(statusKey('WL 12'));
  });
  it('[11] answer binding: wrong train / date / class → REJECTED; timeout → TIMEOUT; error → FAILED', () => {
    const ok = (d: any) => ({ ok: true, data: { trainNumber: '12014', travelClass: 'CC', date: TOMORROW, status: 'AVAILABLE 5', ...d } });
    expect(evaluateAvailabilityAnswer(ok({}), q)).toMatchObject({ outcome: 'SUCCESS', availability: { category: 'AVAILABLE', status: 'AVAILABLE 5' } });
    expect(evaluateAvailabilityAnswer(ok({ trainNumber: '12013' }), q)).toMatchObject({ outcome: 'REJECTED', rejectedReason: 'WRONG_TRAIN' });
    expect(evaluateAvailabilityAnswer(ok({ date: '2026-10-08' }), q)).toMatchObject({ outcome: 'REJECTED', rejectedReason: 'WRONG_DATE' });
    expect(evaluateAvailabilityAnswer(ok({ travelClass: 'EC' }), q)).toMatchObject({ outcome: 'REJECTED', rejectedReason: 'WRONG_CLASS' });
    expect(evaluateAvailabilityAnswer(ok({ status: '' }), q)).toMatchObject({ outcome: 'REJECTED', rejectedReason: 'MALFORMED' });
    expect(evaluateAvailabilityAnswer({ ok: false, error: { code: 'PROVIDER_TIMEOUT' } }, q)).toMatchObject({ outcome: 'TIMEOUT' });
    expect(evaluateAvailabilityAnswer({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } }, q)).toMatchObject({ outcome: 'FAILED' });
  });
  it('[12] fare is provider-only (positive numbers for this train + class), never computed', () => {
    expect(evaluateFareAnswer({ ok: true, data: { total: 1520, currency: 'INR' } }, q)).toMatchObject({ ok: true, total: 1520 });
    expect(evaluateFareAnswer({ ok: true, data: { perPassenger: 760 } }, q)).toEqual({ ok: true, perPassenger: 760, currency: 'INR' });
    expect(evaluateFareAnswer({ ok: true, data: { total: 0 } }, q)).toMatchObject({ ok: false });
    expect(evaluateFareAnswer({ ok: true, data: { total: 900, trainNumber: '12013' } }, q)).toMatchObject({ ok: false, code: 'RESULT_IDENTITY_MISMATCH' });
    expect(evaluateFareAnswer({ ok: false, error: { code: 'PROVIDER_TIMEOUT' } }, q)).toMatchObject({ ok: false, timeout: true });
  });
});

// ================================================================= 3. execution
describe('P42 G2 — search execution', () => {
  it('[13] happy path: both providers agree → ASR ticket AVAILABLE; ticket ≠ travel station; boarding rule UNVERIFIED → PARTIALLY_VERIFIED', async () => {
    const { deps, calls } = mkDeps({ status: (_p, q) => (q.origin === 'ASR' ? 'AVAILABLE 5' : 'GNWL 12') });
    const r = await okRes(REQ(), deps);
    expect(r.alternatives[0]).toMatchObject({ alternativeId: 'A1', isRequestedPair: true, pairId: 'LDH-UMB', availability: 'WAITLIST', verificationStatus: 'VERIFIED', boardingRuleStatus: 'NOT_REQUIRED', actionable: true });
    const asr = byPair(r, 'ASR-UMB');
    expect(asr).toMatchObject({ availability: 'AVAILABLE', availabilityStatusText: 'AVAILABLE 5', verificationStatus: 'PARTIALLY_VERIFIED', actionable: false,
      ticketOrigin: 'ASR', boardingStation: 'ASR', intendedBoardingStation: 'LDH', boardingRuleStatus: 'UNVERIFIED', alightingRuleStatus: 'NOT_REQUIRED' });
    expect(asr.warnings).toContain('BOARDING_RULE_UNVERIFIED');
    expect(asr.evidence.map(e => e.provider).sort()).toEqual(['railcore', 'railradar']);
    expect(r.candidateCount).toBe(1 + 4 + 3);                    // P0 + 4 origin alts + 3 downstream (terminal-bounded)
    expect(calls.length).toBe(r.candidateCount * 2);              // every candidate × both providers, fresh
    expect(calls.every(c => c.q.trainNumber === '12014' && c.q.travelClass === 'CC' && c.q.date === TOMORROW)).toBe(true);
    expect(r.status).toBe('OK');
    expect(r.presentation).toEqual({ bestMatchId: null, order: r.alternatives.map(a => a.alternativeId), decidedBy: 'NONE' });   // backend never ranks
  });
  it('[14] destination extension: ticket beyond destination → alighting rule UNVERIFIED, extensionStations counted', async () => {
    const { deps } = mkDeps({ status: (_p, q) => (q.destination === 'PNP' ? 'AVAILABLE 2' : 'GNWL 30') });
    const r = await okRes(REQ(), deps);
    const pnp = byPair(r, 'LDH-PNP');
    expect(pnp).toMatchObject({ kind: 'DESTINATION_EXTENSION', alightingStation: 'PNP', intendedAlightingStation: 'UMB', alightingRuleStatus: 'UNVERIFIED', extensionStations: 2, verificationStatus: 'PARTIALLY_VERIFIED' });
    expect(pnp.warnings).toContain('ALIGHTING_RULE_UNVERIFIED');
    expect(r.route.destinationSweep).toBe('EXTENSION');
    expect(r.route.destinationExtension).toEqual(['KKDE', 'PNP', 'NDLS']);
  });
  it('[15] provider conflict (AVAILABLE vs WL) → CONFLICTING, PROVIDER_DATA_CONFLICT, no value as fact', async () => {
    const { deps } = mkDeps({ status: (p, q) => (q.origin === 'JUC' ? (p.id === 'railcore' ? 'AVAILABLE 3' : 'GNWL 4') : 'GNWL 20') });
    const r = await okRes(REQ(), deps);
    const juc = byPair(r, 'JUC-UMB');
    expect(juc).toMatchObject({ availability: 'CONFLICTING', verificationStatus: 'CONFLICTING', actionable: false });
    expect(juc.availabilityStatusText).toBeUndefined();
    expect(juc.conflict!.values).toEqual(expect.arrayContaining([{ provider: 'railcore', status: 'AVAILABLE 3' }, { provider: 'railradar', status: 'GNWL 4' }]));
    expect(r.errors).toContain('PROVIDER_DATA_CONFLICT');
  });
  it('[16] same category, different number (WL 12 vs WL 15) is also a conflict', async () => {
    const { deps } = mkDeps({ status: (p) => (p.id === 'railcore' ? 'GNWL 12' : 'GNWL 15') });
    const r = await okRes(REQ({ originSweep: false, destinationSweep: false }), deps);
    expect(r.alternatives[0]).toMatchObject({ availability: 'CONFLICTING' });
  });
  it('[17] partial provider failure keeps the successful evidence; timeout never becomes NOT_AVAILABLE', async () => {
    const { deps } = mkDeps({ status: (p, q) => (p.id === 'railradar' ? 'HANG' : q.origin === 'BEAS' ? 'RAC 7' : 'GNWL 9') });
    const r = await okRes(REQ(), deps);
    expect(r.status).toBe('PARTIAL');
    expect(r.errors).toContain('ALTERNATIVE_SEARCH_TIMEOUT');
    const beas = byPair(r, 'BEAS-UMB');
    expect(beas.availability).toBe('RAC');
    expect(beas.evidence.find(e => e.provider === 'railradar')!.outcome).toBe('TIMEOUT');
    expect(r.alternatives.some(a => a.availability === 'NOT_AVAILABLE')).toBe(false);
    expect(r.providers.find(p => p.provider === 'railradar')).toMatchObject({ succeeded: 0, timeouts: r.candidateCount });
  });
  it('[18] all providers fail → ALTERNATIVE_SEARCH_FAILED with the pinned honest message; all time out → ALTERNATIVE_SEARCH_TIMEOUT', async () => {
    const f = await runSameTrainSearch(REQ(), mkDeps({ status: () => ({ error: 'PROVIDER_UNAVAILABLE' }) }).deps);
    expect(f).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_FAILED', message: SAME_TRAIN_ALL_FAILED_MESSAGE });
    const t = await runSameTrainSearch(REQ({ originSweep: false, destinationSweep: false }), mkDeps({ status: () => 'HANG' }).deps);
    expect(t).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_TIMEOUT', message: SAME_TRAIN_ALL_FAILED_MESSAGE });
  });
  it('[19] answered-but-unrecognised status stays UNKNOWN + UNVERIFIED (not verified, not a conflict)', async () => {
    const { deps } = mkDeps({ status: (p) => (p.id === 'railcore' ? 'CHART PREPARED' : 'GNWL 4') });
    const r = await okRes(REQ({ originSweep: false, destinationSweep: false }), deps);
    expect(r.alternatives[0]).toMatchObject({ availability: 'WAITLIST', verificationStatus: 'VERIFIED' });   // the recognised answer stands
    const r2 = await okRes(REQ({ originSweep: false, destinationSweep: false, providers: [RC] }), mkDeps({ status: () => 'CHART PREPARED' }).deps);
    expect(r2.alternatives[0]).toMatchObject({ availability: 'UNKNOWN', verificationStatus: 'UNVERIFIED', actionable: false });
  });
  it('[20] answers for a different train / class are rejected; all-rejected pairs are INVALID and hidden', async () => {
    const { deps } = mkDeps({ status: (_p, q) => (q.origin === 'PGW' ? { raw: { ok: true, data: { trainNumber: '12459', travelClass: 'CC', date: TOMORROW, status: 'AVAILABLE 40' } } } : 'GNWL 6') });
    const r = await okRes(REQ(), deps);
    expect(r.alternatives.some(a => a.pairId === 'PGW-UMB')).toBe(false);
    expect(r.invalidCount).toBe(1);
    expect(r.alternatives.some(a => a.availabilityStatusText === 'AVAILABLE 40')).toBe(false);
  });
  it('[21] fare: only when requested, only after availability succeeded, provider values only; disagreement → CONFLICTING', async () => {
    const none = await okRes(REQ({ originSweep: false, destinationSweep: false }), mkDeps().deps);
    expect(none.alternatives[0].fare).toEqual({ status: 'NOT_REQUESTED' });
    const m = mkDeps({ status: (p) => (p.id === 'railradar' ? { error: 'PROVIDER_UNAVAILABLE' } : 'AVAILABLE 9') });
    const r = await okRes(REQ({ originSweep: false, destinationSweep: false, includeFare: true }), m.deps);
    expect(r.alternatives[0].fare).toMatchObject({ status: 'PROVIDER', total: 1500, provider: 'railcore' });
    expect(m.fareCalls).toEqual(['railcore:LDH-UMB']);                 // no fare call for the failed provider
    const c = await okRes(REQ({ originSweep: false, destinationSweep: false, includeFare: true }),
      mkDeps({ fare: (p, q) => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, total: p.id === 'railcore' ? 1500 : 1650 } }) }).deps);
    expect(c.alternatives[0].fare).toEqual({ status: 'CONFLICTING' });
  });
  it('[22] every search is fresh — two identical searches call providers twice and get new ids (no cache)', async () => {
    const m = mkDeps();
    const a = await okRes(REQ(), m.deps);
    const b = await okRes(REQ(), m.deps);
    expect(m.calls.length).toBe(2 * 2 * a.candidateCount);
    expect(m.routeCalls.length).toBe(2);
    expect(a.alternativeSearchId).not.toBe(b.alternativeSearchId);
    expect(a.resultSetId).not.toBe(b.resultSetId);
    expect(a).toMatchObject({ fresh: true, cached: false });
  });
  it('[23] concurrency per provider never exceeds maxParallel', async () => {
    const m = mkDeps();
    await okRes(REQ({ combinedPairs: 'ALWAYS' }), { ...m.deps, limits: { ...LIMITS, maxParallel: 2 } });
    expect(m.maxInFlight.railcore).toBeLessThanOrEqual(2);
    expect(m.maxInFlight.railradar).toBeLessThanOrEqual(2);
  });
  it('[24] superseded journey mid-search → STALE_ALTERNATIVE_RESULT, remaining calls skipped', async () => {
    let n = 0;
    const m = mkDeps();
    const r = await runSameTrainSearch(REQ({ combinedPairs: 'ALWAYS' }), { ...m.deps, limits: { ...LIMITS, maxParallel: 1 }, isCurrent: () => ++n < 4 });
    expect(r).toMatchObject({ ok: false, code: 'STALE_ALTERNATIVE_RESULT' });
    expect(m.calls.length).toBeLessThan(10);
  });
  it('[25] route comes from the chosen route provider only (no failover); route failure → INVALID_TRAIN_ROUTE, route timeout → TIMEOUT', async () => {
    const m = mkDeps({ route: { ok: false, error: { code: 'NOT_FOUND' } } });
    expect(await runSameTrainSearch(REQ({ routeProvider: RR }), m.deps)).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE' });
    expect(m.routeCalls).toEqual(['railradar']);
    expect(m.calls.length).toBe(0);
    const h = mkDeps({ route: () => new Promise(() => { /* hang */ }) });
    expect(await runSameTrainSearch(REQ(), h.deps)).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_TIMEOUT' });
  });
  it('[26] combined pairs AUTO run only when P0–P2 found nothing AVAILABLE / RAC', async () => {
    const found = await okRes(REQ({ combinedPairs: 'AUTO' }), mkDeps({ status: (_p, q) => (q.origin === 'PGW' && q.destination === 'UMB' ? 'AVAILABLE 1' : 'GNWL 9') }).deps);
    expect(found.alternatives.some(a => a.priority === 'P3')).toBe(false);
    const none = await okRes(REQ({ combinedPairs: 'AUTO' }), mkDeps({ status: (_p, q) => (q.origin === 'JUC' && q.destination === 'KKDE' ? 'AVAILABLE 1' : 'GNWL 9') }).deps);
    expect(none.alternatives.some(a => a.priority === 'P3')).toBe(true);
    expect(byPair(none, 'JUC-KKDE')).toMatchObject({ kind: 'ORIGIN_AND_DESTINATION', boardingRuleStatus: 'UNVERIFIED', alightingRuleStatus: 'UNVERIFIED', availability: 'AVAILABLE' });
  });
  it('[27] VERIFIED boarding rule (rule-evidence source) → board at requested station, VERIFIED + actionable; rule source error → UNVERIFIED', async () => {
    const v = await okRes(REQ({ destinationSweep: false }), mkDeps({ status: () => 'AVAILABLE 4', extra: { ruleEvidence: async () => 'VERIFIED' } }).deps);
    expect(byPair(v, 'ASR-UMB')).toMatchObject({ boardingStation: 'LDH', boardingRuleStatus: 'VERIFIED', verificationStatus: 'VERIFIED', actionable: true });
    const e = await okRes(REQ({ destinationSweep: false }), mkDeps({ status: () => 'AVAILABLE 4', extra: { ruleEvidence: async () => { throw new Error('x'); } } }).deps);
    expect(byPair(e, 'ASR-UMB')).toMatchObject({ boardingStation: 'ASR', boardingRuleStatus: 'UNVERIFIED' });
  });
  it('[28] web evidence is optional, UNVERIFIED_WEB only, never availability; unavailable → WEB_EVIDENCE_UNAVAILABLE', async () => {
    const u = await okRes(REQ({ webEvidence: true }), mkDeps().deps);
    expect(u.webEvidence).toBe('UNAVAILABLE'); expect(u.errors).toContain('WEB_EVIDENCE_UNAVAILABLE');
    const w = await okRes(REQ({ webEvidence: true, webProviders: [WEB] }), mkDeps({ extra: { webListsTrain: async (_p, q) => ({ ok: true, listed: q.origin !== 'BEAS' }) } }).deps);
    expect(w.webEvidence).toBe('COLLECTED');
    const asr = byPair(w, 'ASR-UMB');
    expect(asr.webEvidence[0]).toMatchObject({ provider: 'erail', level: 'UNVERIFIED_WEB', listed: true });
    expect(asr.availability).toBe('WAITLIST');                       // web never changes availability
    expect(byPair(w, 'LDH-UMB').webEvidence).toEqual([]);            // the requested pair is not web-checked
    const allFail = await runSameTrainSearch(REQ({ webEvidence: true, webProviders: [WEB] }), mkDeps({ status: () => ({ error: 'PROVIDER_UNAVAILABLE' }), extra: { webListsTrain: async () => ({ ok: true, listed: true }) } }).deps);
    expect(allFail).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_FAILED' });   // web alone never makes a result
  });
  it('[29] unique ids A1..An, deduped pairs, NOT_FOUND flagged when no better option, mock flag carried', async () => {
    const r = await okRes(REQ({ combinedPairs: 'ALWAYS', providers: [{ ...RC, isMock: true }] }), mkDeps().deps);
    const ids = r.alternatives.map(a => a.alternativeId);
    expect(ids).toEqual(ids.map((_, i) => `A${i + 1}`));
    expect(new Set(r.alternatives.map(a => a.pairId)).size).toBe(r.alternatives.length);
    expect(r.errors).toContain('ALTERNATIVE_NOT_FOUND');
    expect(r.status).toBe('NOT_FOUND');
    expect(r.isMock).toBe(true);
  });
  it('[30] metadata only (ids, timestamps, counts, latency) — no secrets / PII in the result or the log', async () => {
    const logs: any[] = [];
    const r = await okRes(REQ(), { ...mkDeps().deps, log: (e, f) => logs.push({ e, f }) });
    expect(r).toMatchObject({ sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 1 });
    expect(typeof r.latencyMs).toBe('number');
    expect(Date.parse(r.completedAt)).toBeGreaterThanOrEqual(Date.parse(r.startedAt));
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0].f).sort()).toEqual(['alternativeSearchId', 'candidateCount', 'latencyMs', 'providers', 'resultCount', 'succeeded', 'timeouts']);
    expect(JSON.stringify(r)).not.toMatch(/api[_-]?key|bearer|token|password/i);
  });
});

// ================================================================= 4. tool exposure + validator
describe('P42 G2 — tool registry + validator', () => {
  const v = new ToolCallValidator();
  const mk = () => new ConversationStateManager().createSession() as any;
  const call = (args: any) => ({ callId: 'c1', name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', arguments: args });
  const full = { trainNumber: '12014', travelClass: 'CC', date: TOMORROW, origin: 'LDH', destination: 'UMB' };
  it('[31] feature flag gates the composite tools; the locked RailwayToolName enum is unchanged', () => {
    expect(sameTrainAlternativesEnabledFromEnv({} as any)).toBe(false);
    expect(sameTrainAlternativesEnabledFromEnv({ SAME_TRAIN_ALTERNATIVES_ENABLED: '1' } as any)).toBe(true);
    expect((REGISTERED_TOOLS as any[]).map(t => (typeof t === 'string' ? t : t.name))).toEqual(expect.arrayContaining(['SEARCH_SAME_TRAIN_ALTERNATIVES', 'PRESENT_SAME_TRAIN_ALTERNATIVES']));
    expect(RAILWAY_TOOL_NAMES).not.toContain('SEARCH_SAME_TRAIN_ALTERNATIVES' as any);
    expect(RAILWAY_TOOL_NAMES).toHaveLength(10);
  });
  it('[32] the train must be grounded (typed by the user or on screen) — Muse cannot invent one', () => withMuseSharedPolicyOff(() => {
    const s = mk();
    expect(v.validate(call(full) as any, s, { userText: 'koi aur option?' } as any)).toMatchObject({ ok: false, error: { code: 'AUTHORITATIVE_DATA_REQUIRED' } });
    const ok = v.validate(call(full) as any, s, { userText: '12014 ka same train alternative' } as any);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.v.arguments).toMatchObject({ trainNumber: '12014', travelClass: 'CC', origin: 'LDH', destination: 'UMB', passengersCount: 1, originSweep: true, destinationSweep: true, combinedPairs: 'AUTO', includeFare: false, webEvidence: false });
  }));
  it('[33] missing class / date / stations → SAME_TRAIN_ALTERNATIVE_NOT_READY; same origin/destination → INVALID_STATION_PAIR', () => {
    const s = mk(); const g = { userText: '12014' } as any;
    expect(v.validate(call({ ...full, travelClass: undefined }) as any, s, g)).toMatchObject({ ok: false, error: { code: 'SAME_TRAIN_ALTERNATIVE_NOT_READY' } });
    expect(v.validate(call({ ...full, date: undefined }) as any, s, g)).toMatchObject({ ok: false, error: { code: 'SAME_TRAIN_ALTERNATIVE_NOT_READY' } });
    expect(v.validate(call({ ...full, origin: undefined }) as any, s, g)).toMatchObject({ ok: false, error: { code: 'SAME_TRAIN_ALTERNATIVE_NOT_READY' } });
    expect(v.validate(call({ ...full, destination: 'LDH' }) as any, s, g)).toMatchObject({ ok: false, error: { code: 'INVALID_STATION_PAIR' } });
  });
  it('[34] bounded arguments: extension 5..7, passengers 1..6, train 5 digits', () => {
    const s = mk(); const g = { userText: '12014' } as any;
    expect(v.validate(call({ ...full, destinationExtensionStations: 9 }) as any, s, g)).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });
    expect(v.validate(call({ ...full, passengersCount: 9 }) as any, s, g)).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });
    expect(v.validate(call({ ...full, trainNumber: '120' }) as any, s, g)).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });
  });
  it('[35] never while a booking execution is locked', () => {
    const s = mk(); s.bookingState = 'BOOKING_IN_PROGRESS';
    expect(v.validate(call(full) as any, s, { userText: '12014' } as any)).toMatchObject({ ok: false, error: { code: 'INVALID_ACTION_FOR_STATE' } });
  });
  it('[36] PRESENT: only the current, non-stale result; best match must be shown and VERIFIED / PARTIALLY_VERIFIED', async () => {
    const r = await okRes(REQ(), mkDeps({ status: (p, q) => (q.origin === 'ASR' ? 'AVAILABLE 5' : q.origin === 'JUC' ? (p.id === 'railcore' ? 'AVAILABLE 1' : 'GNWL 2') : 'GNWL 9') }).deps);
    const s = mk(); s.sameTrainAlternatives = r;
    const P = (a: any) => v.validate({ callId: 'p', name: 'PRESENT_SAME_TRAIN_ALTERNATIVES', arguments: a } as any, s);
    const asr = byPair(r, 'ASR-UMB').alternativeId; const juc = byPair(r, 'JUC-UMB').alternativeId;
    expect(P({ alternativeSearchId: 'sta_other' })).toMatchObject({ ok: false, error: { code: 'ALTERNATIVE_NOT_FOUND' } });
    expect(P({ alternativeSearchId: r.alternativeSearchId, bestMatch: 'A99' })).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });
    expect(P({ alternativeSearchId: r.alternativeSearchId, bestMatch: juc })).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });   // CONFLICTING
    expect(P({ alternativeSearchId: r.alternativeSearchId, bestMatch: asr, order: `${asr},A1` })).toMatchObject({ ok: true, v: { arguments: { bestMatch: asr, order: `${asr},A1` } } });
    s.selectedClass = 'EC';                                     // journey changed → stale
    expect(P({ alternativeSearchId: r.alternativeSearchId, bestMatch: asr })).toMatchObject({ ok: false, error: { code: 'STALE_ALTERNATIVE_RESULT' } });
  });
});

// ================================================================= 5. guards + views
describe('P42 G2 — claim guard, availability evidence, views', () => {
  let R: SameTrainAlternativesResult;
  const steps = () => [{ status: 'ok', result: { toolName: 'SEARCH_SAME_TRAIN_ALTERNATIVES', data: R } }];
  it('[37] unverified "book X, board at Y" claims are removed; honest hedged wording and requested-pair sentences stay', async () => {
    R = await okRes(REQ(), mkDeps({ status: (_p, q) => (q.origin === 'ASR' || q.destination === 'PNP' ? 'AVAILABLE 5' : 'GNWL 12') }).deps);
    const unsafe = 'Amritsar ka ticket lekar Ludhiana se board kar lijiye. Yeh best hai.';
    const g = guardSameTrainRuleClaims(unsafe, steps());
    expect(g.text).toBe('Yeh best hai.');
    expect(g.removed).toEqual(['BOARDING_RULE_UNVERIFIED']);
    const hedged = 'Amritsar se availability mil rahi hai, lekin Ludhiana se boarding ka rule verify karna zaroori hai.';
    expect(guardSameTrainRuleClaims(hedged, steps()).text).toBe(hedged);
    expect(guardSameTrainRuleClaims('Ludhiana se board karke Ambala tak WL 12 hai.', steps()).removed).toEqual([]);
    expect(guardSameTrainRuleClaims('Panipat tak ticket lo aur Ambala par utar jaana.', steps()).removed).toEqual(['ALIGHTING_RULE_UNVERIFIED']);
    expect(guardSameTrainRuleClaims(unsafe, []).text).toBe(unsafe);   // no same-train result this turn → untouched
  });
  it('[38] availability evidence: same-train provider successes count; failed / web evidence never does', () => {
    const ev = collectAvailabilityEvidence({}, steps());
    expect(ev.some((e: any) => String(e.status).includes('AVAILABLE 5'))).toBe(true);
    expect(JSON.stringify(ev)).not.toMatch(/UNVERIFIED_WEB/);
  });
  it('[39] LLM view keeps EVERY alternative (object keyed by id, survives array trimming) + searchRef alias + rules', async () => {
    const big = await okRes(REQ({ combinedPairs: 'ALWAYS' }), mkDeps().deps);
    expect(big.alternatives.length).toBeGreaterThan(12);
    const v = sameTrainLLMView(big) as any;
    expect(Array.isArray(v.alternatives)).toBe(false);
    expect(Object.keys(v.alternatives)).toHaveLength(big.alternatives.length);
    expect(v.searchRef).toBe(big.alternativeSearchId);
    expect(v.rules).toMatch(/UNVERIFIED/);
    expect(JSON.stringify(v)).not.toMatch(/toolExecutionId/);
    // worst case (40 pairs, both providers) still fits the composite transcript budget → Muse sees every pair
    const n = normalizeRoute(LONG_ROUTE); if (!n.ok) throw new Error();
    const worst = await okRes(REQ({ origin: 'SMX', destination: 'SOX', combinedPairs: 'ALWAYS', includeFare: true }),
      { ...mkDeps({ route: { ok: true, data: LONG_ROUTE } }).deps, limits: { ...LIMITS, maxParallel: 12 } });
    expect(worst.candidateCount).toBe(40);
    const wire = JSON.stringify({ toolResultId: 'x', tool: 'SEARCH_SAME_TRAIN_ALTERNATIVES', providerStatus: 'SUCCESS', ok: true, outcome: 'DATA', dataSource: 'MOCK', data: sameTrainLLMView(worst) });
    expect(wire.length).toBeLessThan(14000);
  });
  it('[40] card data summarises evidence (no raw bodies) and carries the stale flag; fallback text is fact-only and hedged', () => {
    const c = sameTrainCardData(R, { stale: true }) as any;
    expect(c.stale).toBe(true);
    expect(Object.keys(c.alternatives[0].evidence[0]).every(k => ['provider', 'providerLabel', 'level', 'outcome', 'fetchedAt', 'status', 'category', 'errorCode', 'fare'].includes(k))).toBe(true);
    const t = sameTrainFallbackText(R);
    expect(t).toMatch(/station pairs check kiye/);
    expect(t).toMatch(/boarding ka rule verify karna zaroori hai/);
    expect(sameTrainFallbackText(null)).toBe(SAME_TRAIN_ALL_FAILED_MESSAGE);
  });
});

// ================================================================= 6. staleness + explicit selection
describe('P42 G2 — staleness + "Use this option" revalidation', () => {
  let R: SameTrainAlternativesResult;
  const sess = (o: any = {}) => ({ origin: 'LDH', destination: 'UMB', date: TOMORROW, passengersCount: 1, ...o });
  it('[41] changing train / class / date / origin / destination / passengers makes the result stale; unset fields do not', async () => {
    R = await okRes(REQ(), mkDeps({ status: (_p, q) => (q.origin === 'ASR' ? 'AVAILABLE 5' : q.origin === 'BEAS' ? 'AVAILABLE 2' : 'GNWL 12') }).deps);
    expect(isSameTrainResultStale({}, R)).toBe(false);
    expect(isSameTrainResultStale(sess(), R)).toBe(false);
    for (const ch of [{ selectedTrain: { number: '12460' } }, { selectedClass: 'EC' }, { date: '2026-10-09' }, { origin: 'JUC' }, { destination: 'NDLS' }, { passengersCount: 3 }]) {
      expect(isSameTrainResultStale(sess(ch), R)).toBe(true);
    }
  });
  it('[42] stale / unknown search / unknown option are refused before any provider call', async () => {
    const m = mkDeps();
    const key = currentSameTrainKey(sess(), R);
    expect(await revalidateSameTrainAlternative(R, R.alternativeSearchId, 'A1', currentSameTrainKey(sess({ passengersCount: 2 }), R), { deps: m.deps })).toMatchObject({ ok: false, code: 'ALTERNATIVE_RESULT_STALE' });
    expect(await revalidateSameTrainAlternative(R, 'sta_x', 'A1', key, { deps: m.deps })).toMatchObject({ ok: false, code: 'ALTERNATIVE_NOT_FOUND' });
    expect(await revalidateSameTrainAlternative(R, R.alternativeSearchId, 'A77', key, { deps: m.deps })).toMatchObject({ ok: false, code: 'ALTERNATIVE_NOT_FOUND' });
    expect(await revalidateSameTrainAlternative(undefined, R.alternativeSearchId, 'A1', key, { deps: m.deps })).toMatchObject({ ok: false, code: 'ALTERNATIVE_NOT_FOUND' });
    expect(m.calls.length).toBe(0);
  });
  it('[43] PARTIALLY_VERIFIED needs an explicit acknowledgement of the unverified boarding rule', async () => {
    const m = mkDeps({ status: () => 'AVAILABLE 5' });
    const asr = byPair(R, 'ASR-UMB').alternativeId;
    expect(await revalidateSameTrainAlternative(R, R.alternativeSearchId, asr, currentSameTrainKey(sess(), R), { deps: m.deps })).toMatchObject({ ok: false, code: 'BOARDING_RULE_UNVERIFIED' });
    expect(m.calls.length).toBe(0);
  });
  it('[44] acknowledged + fresh availability still good → ok with handoff text (ticket stations, no mutation); fresh calls hit the same providers', async () => {
    const m = mkDeps({ status: () => 'AVAILABLE 4' });
    const asr = byPair(R, 'ASR-UMB').alternativeId;
    const before = JSON.stringify(R);
    const out = await revalidateSameTrainAlternative(R, R.alternativeSearchId, asr, currentSameTrainKey(sess(), R), { acknowledgeUnverifiedRules: true, deps: m.deps });
    expect(out).toMatchObject({ ok: true, alternative: { ticketOrigin: 'ASR', ticketDestination: 'UMB', boardingStation: 'ASR' } });
    expect(out.handoffText).toMatch(/ticket ASR se UMB/);
    expect(out.fresh!.map(f => f.provider).sort()).toEqual(['railcore', 'railradar']);
    expect(m.calls.every(c => c.q.origin === 'ASR' && c.q.destination === 'UMB')).toBe(true);
    expect(JSON.stringify(R)).toBe(before);                         // the stored result is not mutated
  });
  it('[45] fresh revalidation: now REGRET → NO_LONGER_AVAILABLE; providers now disagree → PROVIDER_DATA_CONFLICT; all fail → SEARCH_FAILED', async () => {
    const id = byPair(R, 'BEAS-UMB').alternativeId; const key = currentSameTrainKey(sess(), R); const o = { acknowledgeUnverifiedRules: true };
    expect(await revalidateSameTrainAlternative(R, R.alternativeSearchId, id, key, { ...o, deps: mkDeps({ status: () => 'REGRET' }).deps })).toMatchObject({ ok: false, code: 'ALTERNATIVE_NO_LONGER_AVAILABLE' });
    expect(await revalidateSameTrainAlternative(R, R.alternativeSearchId, id, key, { ...o, deps: mkDeps({ status: p => (p.id === 'railcore' ? 'AVAILABLE 1' : 'GNWL 3') }).deps })).toMatchObject({ ok: false, code: 'PROVIDER_DATA_CONFLICT' });
    expect(await revalidateSameTrainAlternative(R, R.alternativeSearchId, id, key, { ...o, deps: mkDeps({ status: () => ({ error: 'PROVIDER_UNAVAILABLE' }) }).deps })).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_FAILED' });
  });
  it('[46] UNVERIFIED / CONFLICTING options are never selectable', async () => {
    const r = await okRes(REQ({ providers: [RC, RR] }), mkDeps({ status: (p, q) => (q.origin === 'JUC' ? (p.id === 'railcore' ? 'AVAILABLE 1' : 'GNWL 2') : q.origin === 'BEAS' ? { error: 'PROVIDER_UNAVAILABLE' } : 'GNWL 9') }).deps);
    const key = currentSameTrainKey(sess(), r);
    expect(await revalidateSameTrainAlternative(r, r.alternativeSearchId, byPair(r, 'JUC-UMB').alternativeId, key, { acknowledgeUnverifiedRules: true, deps: mkDeps().deps })).toMatchObject({ ok: false, code: 'ALTERNATIVE_NOT_ACTIONABLE' });
    expect(await revalidateSameTrainAlternative(r, r.alternativeSearchId, byPair(r, 'BEAS-UMB').alternativeId, key, { acknowledgeUnverifiedRules: true, deps: mkDeps().deps })).toMatchObject({ ok: false, code: 'ALTERNATIVE_NOT_ACTIONABLE' });
  });
});
