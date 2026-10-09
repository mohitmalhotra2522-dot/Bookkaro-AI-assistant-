/**
 * P42.7 G2 — intelligent same-train recovery: all-class route matrix (MOCK only — no network, no credits).
 * Engine (bounded matrix: ≤15 earlier stations, ≤7 downstream, terminal stop, requested class first, per-(pair × class)
 * alternatives), the tool validator (authoritative classes only, explicit override) and the per-train eligibility gate of the
 * automatic display (requested class decides; another class being available never suppresses recovery).
 * Routes / trains / statuses are TEST DATA (the app always takes them from the provider).
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import {
  normalizeRoute, planCandidates, runSameTrainSearch, sameTrainLimitsFromEnv, matrixClasses,
  type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery
} from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS, MAX_EARLIER_STATIONS, MAX_DOWNSTREAM_STATIONS, toSameTrainRecoveryResults, type SameTrainAlternativesResult } from '../../shared/same-train-alternatives';
import { evaluateBfeEligibility, recoveryEligibilityView } from '../../shared/bfe-eligibility';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { discoverSameTrainForDisplay } from '../../server/railway/same-train/same-train-session';

// ---------------------------------------------------------------- test data
/** 30 stations: R00 … R29 (train origin R00, terminal R29) */
const LONG = Array.from({ length: 30 }, (_, i) => ({ station: `R${String(i).padStart(2, '0')}`, stationName: `Stop ${i}`, departure: `${String(i % 24).padStart(2, '0')}:10` }));
/** Part 49 shape (test data): JUC precedes ASR on this train's route */
const ROUTE49 = [['JAT', 'Jammu Tawi'], ['PTKC', 'Pathankot Cantt'], ['JUC', 'Jalandhar City'], ['ASR', 'Amritsar Jn'], ['LDH', 'Ludhiana Jn'], ['UMB', 'Ambala Cant Jn'], ['NDLS', 'New Delhi']]
  .map(([station, stationName]) => ({ station, stationName }));
const DATE = '2026-10-08';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const LIMITS = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 150, totalTimeoutMs: 3000 };

type StatusFn = (q: AvailabilityQuery) => string | { error: string } | 'HANG';
function mkDeps(status: StatusFn, route: any = ROUTE49, limits: any = LIMITS, jitter = false) {
  const calls: AvailabilityQuery[] = [];
  const deps: SameTrainDeps = {
    limits,
    getRoute: async () => ({ ok: true, data: route }),
    checkAvailability: async (_p, q) => {
      calls.push(q);
      await new Promise(r => setTimeout(r, jitter ? Math.floor(Math.random() * 8) : 1));
      const s = status(q);
      if (s === 'HANG') return new Promise(() => { /* never */ });
      if (typeof s === 'object') return { ok: false, error: { code: s.error } };
      return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: s } };
    }
  };
  return { deps, calls };
}
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 1,
  trainNumber: '12414', trainName: 'Pooja SF Express', date: DATE, travelClass: 'SL', classes: ['SL', '3A', '2A', '1A'], passengersCount: 3,
  origin: 'ASR', destination: 'NDLS', originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false,
  providers: [RC], routeProvider: RC, webProviders: [], ...over
});
const ok = async (req: SameTrainSearchRequest, deps: SameTrainDeps): Promise<SameTrainAlternativesResult> => {
  const r = await runSameTrainSearch(req, deps);
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.result;
};
/** Part 49 data: ASR→NDLS SL WL1 (2A / 1A AVL direct); JUC→NDLS SL AVL 3, 3A AVL 4, 2A RAC 4; everything else WL */
const P49: StatusFn = q => {
  if (q.origin === 'ASR' && q.destination === 'NDLS') return q.travelClass === 'SL' ? 'WL 1' : q.travelClass === '3A' ? 'WL 6' : 'AVAILABLE-0009';
  if (q.origin === 'JUC' && q.destination === 'NDLS') return ({ SL: 'AVAILABLE-0003', '3A': 'AVAILABLE-0004', '2A': 'RAC 4', '1A': 'GNWL 2' } as any)[q.travelClass];
  return 'GNWL 9';
};

// session with a displayed search list (for the validator + automatic display gate)
function sessionWith(classes: Array<[string, string]>, opts: { requestedClass?: string; pax?: number } = {}) {
  const state = new ConversationStateManager();
  const s: any = state.createSession();
  Object.assign(s, { origin: 'ASR', destination: 'NDLS', date: DATE, passengersCount: opts.pax ?? 3, requestedClass: opts.requestedClass, searchResultsVersion: 1, journeyVersion: 1,
    searchResults: { version: 1, retrievedAt: new Date().toISOString(), journey: { origin: 'ASR', destination: 'NDLS', date: DATE },
      trains: [{ trainNumber: '12414', trainName: 'Pooja SF Express', classes: classes.map(([code, availability]) => ({ code, availability })) }] } });
  return { state, s, sid: s.sessionId as string };
}


/** Phase 2 shared policy (user-authorized 2026-10-09, "mixed"): tests that pin the PRE-Phase-2 Muse rules run with the
 *  documented rollback switch SAME_TRAIN_MUSE_SHARED_POLICY=off; the env is restored afterwards. Assertions unchanged. */
async function withMuseSharedPolicyOff(fn: () => unknown): Promise<void> {
  const prev = process.env.SAME_TRAIN_MUSE_SHARED_POLICY;
  process.env.SAME_TRAIN_MUSE_SHARED_POLICY = 'off';
  try { await fn(); } finally { if (prev === undefined) delete process.env.SAME_TRAIN_MUSE_SHARED_POLICY; else process.env.SAME_TRAIN_MUSE_SHARED_POLICY = prev; }
}

describe('P42.7 G2 — recovery search (all-class route matrix)', () => {
  it('[G2.1] WL on the requested class → recovery eligible; the search finds JUC → NDLS SL AVL 3', async () => {
    const e = evaluateBfeEligibility({ ok: true, status: 'WL 1', trainNumber: '12414', classCode: 'SL', passengers: 3, binding: {} as any });
    expect(recoveryEligibilityView(e)).toMatchObject({ trainNumber: '12414', requestedClass: 'SL', recoveryEligible: true, reason: 'WAITLIST', confirmedSeats: 0, passengers: 3 });
    const r = await ok(REQ(), mkDeps(P49).deps);
    expect(r.requestedPairAssessment).toMatchObject({ shortage: true, triggerReason: 'WAITLIST' });
    expect(r.alternatives.find(a => a.ticketOrigin === 'JUC' && a.travelClass === 'SL')).toMatchObject({ availability: 'AVAILABLE', availableSeatCount: 3, seatSufficiency: 'SUFFICIENT' });
  });
  it('[G2.2] NOT AVAILABLE on the requested class → eligible (NOT_AVAILABLE)', () => {
    const e = evaluateBfeEligibility({ ok: true, status: 'NOT AVAILABLE', trainNumber: '12414', classCode: 'SL', passengers: 3, binding: {} as any });
    expect(e).toMatchObject({ eligible: true, reason: 'NOT_AVAILABLE' });
  });
  it('[G2.3] REGRET on the requested class → eligible (REGRET stays REGRET)', () => {
    const e = evaluateBfeEligibility({ ok: true, status: 'REGRET', trainNumber: '12414', classCode: 'SL', passengers: 3, binding: {} as any });
    expect(e).toMatchObject({ eligible: true, reason: 'REGRET' });
  });
  it('[G2.4] insufficient seats (AVAILABLE-0001 for 3) → eligible INSUFFICIENT_SEATS with the exact count; 3 seats for 3 → not eligible', () => {
    expect(evaluateBfeEligibility({ ok: true, status: 'AVAILABLE-0001', trainNumber: '12414', classCode: 'SL', passengers: 3, binding: {} as any }))
      .toMatchObject({ eligible: true, reason: 'INSUFFICIENT_SEATS', confirmedSeats: 1 });
    expect(evaluateBfeEligibility({ ok: true, status: 'AVAILABLE-0003', trainNumber: '12414', classCode: 'SL', passengers: 3, binding: {} as any }))
      .toMatchObject({ eligible: false, notEligibleReason: 'SEATS_SUFFICIENT' });
  });
  it('[G2.5] another class AVAILABLE does not suppress recovery: SL WL1 + 2A/1A AVL → automatic search runs (requested SL); SL enough → NOT_NEEDED even with 2A WL', async () => {
    const a = sessionWith([['SL', 'WL 1'], ['3A', 'WL 6'], ['2A', 'AVAILABLE-0009'], ['1A', 'AVAILABLE-0004']], { requestedClass: 'SL' });
    const { deps, calls } = mkDeps(P49);
    const out = await discoverSameTrainForDisplay(a.state, a.sid, { trainNumber: '12414', searchResultsVersion: 1 }, { deps, env: { SAME_TRAIN_ALTERNATIVES_ENABLED: '1' } as any });
    expect(out).toMatchObject({ ok: true, code: 'OK' });
    expect(out.result!.travelClass).toBe('SL');
    expect(calls.length).toBeGreaterThan(0);
    const b = sessionWith([['SL', 'AVAILABLE-0005'], ['2A', 'WL 3']], { requestedClass: 'SL' });
    const m = mkDeps(P49);
    expect(await discoverSameTrainForDisplay(b.state, b.sid, { trainNumber: '12414', searchResultsVersion: 1 }, { deps: m.deps, env: { SAME_TRAIN_ALTERNATIVES_ENABLED: '1' } as any }))
      .toMatchObject({ ok: false, code: 'NOT_NEEDED' });
    expect(m.calls).toHaveLength(0);
  });
  it('[G2.6] all-class: every listed class is checked at each earlier pair; each option carries its OWN class; the requested pair only for the requested class', async () => {
    const { deps, calls } = mkDeps(P49);
    const r = await ok(REQ(), deps);
    expect(r.classesChecked).toEqual(['SL', '3A', '2A', '1A']);
    for (const c of ['SL', '3A', '2A', '1A']) expect(calls.some(q => q.origin === 'JUC' && q.destination === 'NDLS' && q.travelClass === c), c).toBe(true);
    expect(calls.filter(q => q.origin === 'ASR' && q.destination === 'NDLS').map(q => q.travelClass)).toEqual(['SL']);
    const juc = r.alternatives.filter(a => a.ticketOrigin === 'JUC' && a.ticketDestination === 'NDLS');
    expect(juc.map(a => `${a.travelClass}:${a.availabilityStatusText}`)).toEqual(['SL:AVAILABLE-0003', '3A:AVAILABLE-0004', '2A:RAC 4', '1A:GNWL 2']);
    const rec = toSameTrainRecoveryResults(r);
    expect(rec.map(x => `${x.ticketOrigin}-${x.ticketDestination}:${x.classCode}:${x.availability}:${x.confirmedSeats}`)).toEqual(['JUC-NDLS:SL:AVAILABLE:3', 'JUC-NDLS:3A:AVAILABLE:4', 'JUC-NDLS:2A:RAC:null']);
    // a class with fewer seats than the party (3A AVL 2 for 3) is never a recovery option — 2 seats are never turned into 3
    const short = await ok(REQ(), mkDeps(q => (q.origin === 'JUC' && q.travelClass === '3A' ? 'AVAILABLE-0002' : P49(q) as string)).deps);
    expect(toSameTrainRecoveryResults(short).map(x => x.classCode)).toEqual(['SL', '2A']);
    expect(rec[0]).toMatchObject({ trainNumber: '12414', trainName: 'Pooja SF Express', date: DATE, requestedOrigin: 'ASR', requestedDestination: 'NDLS', boardAt: 'JUC', passengers: 3, provider: 'railcore', stale: false, journeyVersion: 1, sourceResultId: r.resultSetId });
  });
  it('[G2.7] at most 15 earlier stations (nearest first); env / caller limits can never raise it', async () => {
    const n = normalizeRoute(LONG); if (!n.ok) throw new Error();
    const plan = planCandidates(n.stations, n.duplicates, { origin: 'R25', destination: 'R27', originSweep: true, destinationSweep: false }, { ...LIMITS, maxOriginSweepStations: 40 });
    if (!plan.ok) throw new Error();
    expect(plan.plan.originAlternatives.map(s => s.code)).toEqual(Array.from({ length: 15 }, (_, i) => `R${String(10 + i).padStart(2, '0')}`));
    expect(MAX_EARLIER_STATIONS).toBe(15);
    expect(sameTrainLimitsFromEnv({ SAME_TRAIN_MAX_ORIGIN_SWEEP: '30' } as any).maxOriginSweepStations).toBe(15);
    const { deps } = mkDeps(() => 'GNWL 4', LONG);
    const r = await ok(REQ({ origin: 'R25', destination: 'R27', classes: ['SL'], destinationSweep: false }), deps);
    expect(r.earlierStationsChecked).toBe(15);
  });
  it('[G2.8] at most 7 downstream stations past the destination (Muse 5–7, clamped)', async () => {
    const n = normalizeRoute(LONG); if (!n.ok) throw new Error();
    const ext = (k?: number) => { const p = planCandidates(n.stations, n.duplicates, { origin: 'R05', destination: 'R08', originSweep: false, destinationSweep: true, destinationExtensionStations: k }, { ...LIMITS, maxDestinationSweep: 50 }); if (!p.ok) throw new Error(); return p.plan.destinationExtension.length; };
    expect(ext(7)).toBe(7); expect(ext(30)).toBe(7); expect(ext()).toBe(MAX_DOWNSTREAM_STATIONS);
    expect(sameTrainLimitsFromEnv({ SAME_TRAIN_MAX_DESTINATION_SWEEP: '99' } as any).maxDestinationSweep).toBeLessThanOrEqual(7);
    const { deps } = mkDeps(() => 'GNWL 4', LONG);
    const r = await ok(REQ({ origin: 'R05', destination: 'R08', classes: ['SL'], originSweep: false, destinationExtensionStations: 7 }), deps);
    expect(r.downstreamStationsChecked).toBe(7);
  });
  it('[G2.9] the terminal stops the search: 2 stops before the terminal → 2 downstream; destination = terminal → none', async () => {
    const { deps } = mkDeps(() => 'GNWL 4', LONG);
    const r = await ok(REQ({ origin: 'R20', destination: 'R27', classes: ['SL'], originSweep: false, destinationExtensionStations: 7 }), deps);
    expect(r.route.destinationExtension).toEqual(['R28', 'R29']);
    expect(r.downstreamStationsChecked).toBe(2);
    const t = await ok(REQ({ origin: 'R20', destination: 'R29', classes: ['SL'], originSweep: false }), mkDeps(() => 'GNWL 4', LONG).deps);
    expect(t.route.destinationSweep).toBe('NONE_TERMINAL');
    expect(t.downstreamStationsChecked).toBe(0);
  });
  it('[G2.10] route / class order is deterministic and neutral (no "best" ranking) even when provider answers arrive in random order', async () => {
    const order = async () => (await ok(REQ({ origin: 'R20', destination: 'R22' }), mkDeps(q => (q.travelClass === '2A' ? 'RAC 2' : 'AVAILABLE-0004'), LONG, LIMITS, true).deps))
      .alternatives.map(a => `${a.ticketOrigin}-${a.ticketDestination}:${a.travelClass}`);
    const a = await order(); const b = await order();
    expect(a).toEqual(b);
    expect(a[0]).toBe('R20-R22:SL');                                   // requested pair first
    expect(a.slice(1, 5)).toEqual(['R05-R22:SL', 'R05-R22:3A', 'R05-R22:2A', 'R05-R22:1A']);   // route order, then the row's class order
    const r = await ok(REQ(), mkDeps(P49).deps);
    expect(r.presentation).toEqual({ bestMatchId: null, order: r.alternatives.map(x => x.alternativeId), decidedBy: 'NONE' });
  });
  it('[G2.11] unsupported class: the validator rejects a class the train row does not list; matrixClasses never invents one', () => withMuseSharedPolicyOff(() => {
    const { s } = sessionWith([['SL', 'WL 1'], ['2A', 'AVAILABLE-0009']], { requestedClass: 'SL' });
    const v = new ToolCallValidator();
    const call = (args: any) => ({ callId: 'c1', name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', arguments: { trainNumber: '12414', ...args } });
    expect(v.validate(call({ classes: 'SL,EC' }) as any, s, { userText: 'x' } as any)).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });
    expect(v.validate(call({ travelClass: '3A' }) as any, s, { userText: 'x' } as any)).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });
    const good = v.validate(call({}) as any, s, { userText: 'x' } as any);     // no selection: requested class from the session (named at search)
    expect(good).toMatchObject({ ok: true, v: { arguments: { travelClass: 'SL', classes: 'SL,2A' } } });
    expect(matrixClasses('SL', ['2A', 'sl', '', 'bad code!', '2A'])).toEqual(['SL', '2A']);
  }));
  it('[G2.12] UNKNOWN stays UNKNOWN: an unrecognised answer is never NOT_AVAILABLE / verified; an UNKNOWN requested class is not a shortage', async () => {
    const r = await ok(REQ(), mkDeps(q => (q.origin === 'JUC' && q.travelClass === '3A' ? 'SOMETHING ODD' : P49(q) as string)).deps);
    const a = r.alternatives.find(x => x.ticketOrigin === 'JUC' && x.travelClass === '3A')!;
    expect(a.availability).toBe('UNKNOWN');
    expect(a.verificationStatus).toBe('UNVERIFIED');
    expect(toSameTrainRecoveryResults(r).some(x => x.classCode === '3A')).toBe(false);
    expect(evaluateBfeEligibility({ ok: true, status: 'UNKNOWN', trainNumber: '12414', classCode: 'SL', passengers: 3, binding: {} as any })).toMatchObject({ eligible: false, notEligibleReason: 'UNKNOWN_STATUS' });
  });
  it('[G2.13] TIMEOUT ≠ NOT_AVAILABLE: a hanging class times out (UNKNOWN, unverified) while the other classes still answer', async () => {
    const r = await ok(REQ(), mkDeps(q => (q.travelClass === '3A' ? 'HANG' : P49(q) as string)).deps);
    const a = r.alternatives.find(x => x.ticketOrigin === 'JUC' && x.travelClass === '3A')!;
    expect(a.availability).toBe('UNKNOWN');
    expect(a.evidence[0].outcome).toBe('TIMEOUT');
    expect(r.errors).toContain('ALTERNATIVE_SEARCH_TIMEOUT');
    expect(r.alternatives.find(x => x.ticketOrigin === 'JUC' && x.travelClass === 'SL')!.availability).toBe('AVAILABLE');
  });
  it('[G2.14] PROVIDER_ERROR ≠ WL: a failed class call is UNKNOWN (FAILED evidence), never WAITLIST / NOT_AVAILABLE', async () => {
    const r = await ok(REQ(), mkDeps(q => (q.travelClass === '2A' ? { error: 'PROVIDER_ERROR' } : P49(q) as string)).deps);
    const a = r.alternatives.find(x => x.ticketOrigin === 'JUC' && x.travelClass === '2A')!;
    expect(a.availability).toBe('UNKNOWN');
    expect(a.evidence[0]).toMatchObject({ outcome: 'FAILED', errorCode: 'PROVIDER_ERROR' });
    expect(r.status).toBe('PARTIAL');
  });
  it('[G2.15] fresh repeat: a second search calls the provider again (no app cache) and gets a new result id', async () => {
    const m = mkDeps(P49);
    const a = await ok(REQ(), m.deps); const n1 = m.calls.length;
    const b = await ok(REQ(), m.deps);
    expect(m.calls.length).toBe(n1 * 2);
    expect(b.alternativeSearchId).not.toBe(a.alternativeSearchId);
    expect(b).toMatchObject({ fresh: true, cached: false });
  });
  it('[G2.16] bounded total checks: the requested class is searched over the whole window first; the cap truncates other classes (searchComplete false)', async () => {
    const { deps, calls } = mkDeps(() => 'GNWL 4', LONG, { ...LIMITS, maxAvailabilityChecks: 20 });
    const r = await ok(REQ({ origin: 'R20', destination: 'R22', combinedPairs: 'NEVER' }), deps);
    expect(calls).toHaveLength(20);
    expect(calls.every(q => q.travelClass === 'SL')).toBe(true);            // 23 SL units (1 + 15 + 7) > 20 → only SL ran
    expect(r).toMatchObject({ checksTruncated: true, searchComplete: false });
  });
});
