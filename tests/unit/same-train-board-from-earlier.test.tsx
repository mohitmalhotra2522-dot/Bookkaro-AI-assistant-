/**
 * Phase 2 (2026-10-09) — findBoardFromEarlier spec on the existing same-train engine. MOCK only — no network, no credits.
 *   - only WAITLISTED trains / classes are searched (AVAILABLE / RAC / REGRET / CANCELLED / NOT AVAILABLE never);
 *   - staged depth: stage A = 2 earlier + 3 ahead; nothing bookable → B1 = rest of the earlier stops up to the origin;
 *     still nothing → the terminus; probes per train bounded (3); trains in parallel bounded (3);
 *   - a too-old RAC / AVAILABLE snapshot is shown with ⚠ + age and is selectable ONLY through a fresh re-check;
 *   - better WL: nothing bookable → a fresh lower WL from an earlier station is marked (WL, never confirmed);
 *   - output fields bookFrom / boardAt / stopsBefore / stopsAfter.
 * Routes / statuses are TEST DATA (the app always takes them from the provider).
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { runSameTrainSearch, planCandidates, normalizeRoute, markBetterWaitlist, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS, BOARD_EARLIER_STOPS, BOOK_UPTO_STOPS, EARLIER_PROBE_CONCURRENCY, SAME_TRAIN_TRAIN_CONCURRENCY, type SameTrainAlternativesResult } from '../../shared/same-train-alternatives';
import { currentWaitlistNumber, isWaitlistStatus } from '../../shared/same-train-shortage';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { discoverSameTrainForDisplay, boardFromEarlierConfigFromEnv, sameTrainTrainSlotsForTests } from '../../server/railway/same-train/same-train-session';
import { revalidateSameTrainAlternative } from '../../server/railway/same-train/same-train-service';
import { sameTrainLLMView, sameTrainCardData } from '../../server/railway/same-train/same-train-view';
import { SameTrainOptionList, staleSelectable, staleOptionLine, betterWaitlistOf, betterWaitlistLine, BetterWaitlistLines, BETTER_WL_HEADING, needsSameTrainDiscovery } from '../../src/components/trains/SameTrainInline';

const DATE = '2026-10-12';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const LIMITS = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 300, totalTimeoutMs: 5000 };
/** 40 stations S00 … S39 (all day 1): requested origin S20, requested destination S25, terminal S39 */
const ROUTE = Array.from({ length: 40 }, (_, i) => ({ station: `S${String(i).padStart(2, '0')}`, stationName: `Stop ${i}`, departure: `${String(i % 24).padStart(2, '0')}:10`, day: 1 }));
const STAGED = { earlier: BOARD_EARLIER_STOPS, ahead: BOOK_UPTO_STOPS };
const idx = (code: string) => Number(code.slice(1));
const MIN = 60_000;

type Answer = string | { status: string; updated?: string };
function mkDeps(fn: (q: AvailabilityQuery) => Answer, delayMs = 0) {
  const calls: AvailabilityQuery[] = [];
  let inflight = 0; let maxInflight = 0;
  const deps: SameTrainDeps = {
    limits: LIMITS,
    getRoute: async () => ({ ok: true, data: ROUTE }),
    checkAvailability: async (_p, q) => {
      calls.push(q); inflight++; maxInflight = Math.max(maxInflight, inflight);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      inflight--;
      const a = fn(q); const st = typeof a === 'string' ? { status: a } : a;
      return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: st.status, ...(st.updated ? { providerUpdatedAt: st.updated } : {}) } };
    }
  };
  return { deps, calls, max: () => maxInflight };
}
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's-bfe', turnId: null, requestId: null, journeyVersion: 1, trainNumber: '11906', trainName: 'HSX AGC EXP', date: DATE,
  travelClass: 'SL', classes: ['SL'], passengersCount: 1, origin: 'S20', destination: 'S25',
  originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false, terminalSweep: 'AUTO',
  providers: [RC], routeProvider: RC, webProviders: [], staged: STAGED, probeConcurrency: EARLIER_PROBE_CONCURRENCY, ...over
} as any);
const ok = async (req: SameTrainSearchRequest, deps: SameTrainDeps): Promise<SameTrainAlternativesResult> => {
  const r = await runSameTrainSearch(req, deps);
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.result;
};

describe('Phase 2 helpers + config', () => {
  it('[BF1] WAITLIST detection + current waitlist number (current status after the slash; never inferred)', () => {
    expect(isWaitlistStatus('GNWL84/WL17')).toBe(true);
    expect(isWaitlistStatus('RAC 4')).toBe(false);
    expect(isWaitlistStatus('REGRET')).toBe(false);
    expect(isWaitlistStatus('AVAILABLE-0001')).toBe(false);
    expect(currentWaitlistNumber('GNWL84/WL17')).toBe(17);
    expect(currentWaitlistNumber('RLWL1/WL1')).toBe(1);
    expect(currentWaitlistNumber('WL 84')).toBe(84);
    expect(currentWaitlistNumber('PQWL5')).toBe(5);
    expect(currentWaitlistNumber('GNWL51/RAC78')).toBeUndefined();      // RAC now — not a waitlist position
    expect(currentWaitlistNumber('WAITLIST')).toBeUndefined();
    expect(currentWaitlistNumber('RAC 3')).toBeUndefined();
  });
  it('[BF2] config: defaults 2 / 3 / 3 probes / 3 trains, WL-only + staged on; env overrides (bounded); off switches', () => {
    expect(boardFromEarlierConfigFromEnv({} as any)).toEqual({ wlOnly: true, staged: { earlier: 2, ahead: 3 }, probeConcurrency: 3, trainConcurrency: 3 });
    expect([BOARD_EARLIER_STOPS, BOOK_UPTO_STOPS, EARLIER_PROBE_CONCURRENCY, SAME_TRAIN_TRAIN_CONCURRENCY]).toEqual([2, 3, 3, 3]);
    const c = boardFromEarlierConfigFromEnv({ SAME_TRAIN_BOARD_EARLIER_STOPS: '4', SAME_TRAIN_BOOK_UPTO_STOPS: '99', SAME_TRAIN_PROBE_CONCURRENCY: '0', SAME_TRAIN_TRAIN_CONCURRENCY: '2' } as any);
    expect(c).toEqual({ wlOnly: true, staged: { earlier: 4, ahead: 7 }, probeConcurrency: 1, trainConcurrency: 2 });
    const off = boardFromEarlierConfigFromEnv({ SAME_TRAIN_WL_ONLY: 'off', SAME_TRAIN_STAGED_DEPTH: '0' } as any);
    expect(off.wlOnly).toBe(false);
    expect(off.staged).toBeNull();
  });
});

describe('Phase 2 staged depth', () => {
  it('[BF3] plan: stage A = requested pair + 2 nearest earlier + 3 ahead; B1 = remaining earlier nearest first (≤15 back); terminus = the rest', () => {
    const r = normalizeRoute(ROUTE as any); if (!r.ok) throw new Error('route');
    const p = planCandidates(r.stations, r.duplicates, { origin: 'S20', destination: 'S25', originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', terminalSweep: 'AUTO', staged: STAGED }, LIMITS);
    if (!p.ok) throw new Error('plan');
    expect(p.plan.phase1.map(x => x.pairId)).toEqual(['S20-S25', 'S19-S25', 'S18-S25', 'S20-S26', 'S20-S27', 'S20-S28']);
    expect(p.plan.stageB.map(x => x.ticketOrigin)).toEqual(Array.from({ length: 13 }, (_, i) => `S${String(17 - i).padStart(2, '0')}`));
    expect(p.plan.phase3.map(x => x.ticketDestination)).toEqual(Array.from({ length: 11 }, (_, i) => `S${29 + i}`));
    // unstaged → the pre-Phase-2 plan (no stage B)
    const u = planCandidates(r.stations, r.duplicates, { origin: 'S20', destination: 'S25', originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', terminalSweep: 'AUTO' }, LIMITS);
    if (!u.ok) throw new Error('plan');
    expect(u.plan.stageB).toEqual([]);
    expect(u.plan.destinationExtension.length).toBeGreaterThanOrEqual(5);
  });
  it('[BF4] a bookable seat in stage A → nothing else is checked (no B1, no terminus)', async () => {
    const { deps, calls } = mkDeps(q => (q.origin === 'S19' ? 'RAC 5' : 'WL 9'));
    const r = await ok(REQ(), deps);
    expect(calls.map(q => `${q.origin}-${q.destination}`).sort()).toEqual(['S18-S25', 'S19-S25', 'S20-S25', 'S20-S26', 'S20-S27', 'S20-S28']);
    expect(r.verifiedAlternativeCount).toBe(1);
    expect(r.route.terminalSweep).toBeUndefined();
    expect(r.earlierStationsChecked).toBe(2);
    expect(r.downstreamStationsChecked).toBe(3);
  });
  it('[BF5] nothing in stage A, seat 5 stops back → B1 runs (nearest first) and finds it; the terminus is not swept', async () => {
    const { deps, calls } = mkDeps(q => (q.origin === 'S15' ? 'AVAILABLE-0004' : 'WL 9'));
    const r = await ok(REQ(), deps);
    expect(calls.some(q => q.origin === 'S15')).toBe(true);
    expect(calls.some(q => idx(q.destination) > 28)).toBe(false);
    expect(r.route.terminalSweep).toBeUndefined();
    expect(r.alternatives.find(a => a.ticketOrigin === 'S15')!.availability).toBe('AVAILABLE');
    expect(r.earlierStationsChecked).toBe(15);
  });
  it('[BF6] nothing anywhere → stage A, then B1 (to the origin, ≤15 back), then the terminus — in that order; never NOT_FOUND before all ran', async () => {
    const { deps, calls } = mkDeps(() => 'WL 9');
    const r = await ok(REQ(), deps);
    const order = calls.map(q => (q.destination === 'S25' && q.origin !== 'S20' && idx(q.origin) < 18 ? 'B1' : idx(q.destination) > 28 ? 'T' : 'A'));
    const firstB1 = order.indexOf('B1'); const lastA = order.lastIndexOf('A'); const firstT = order.indexOf('T'); const lastB1 = order.lastIndexOf('B1');
    expect(lastA).toBeLessThan(firstB1);
    expect(lastB1).toBeLessThan(firstT);
    expect(r.route.terminalSweep?.length).toBe(11);
    expect(r.searchComplete).toBe(true);
    expect(r.status).toBe('NOT_FOUND');
  });
  it('[BF7] at most 3 probes of one train in flight at once (EARLIER_PROBE_CONCURRENCY)', async () => {
    const m = mkDeps(() => 'WL 9', 5);
    await ok(REQ({ classes: ['SL', '3A'] } as any), { ...m.deps, limits: { ...LIMITS, maxParallel: 12 } });
    expect(m.max()).toBeLessThanOrEqual(3);
    expect(m.max()).toBeGreaterThan(1);           // probes do run in parallel
  });
  it('[BF8] output fields: bookFrom (ticket origin), boardAt (requested origin), stopsBefore / stopsAfter (route distance)', async () => {
    const { deps } = mkDeps(q => (q.origin === 'S18' || q.destination === 'S27' ? 'RAC 2' : 'WL 9'));
    const r = await ok(REQ(), deps);
    const e = r.alternatives.find(a => a.ticketOrigin === 'S18')!;
    expect(e).toMatchObject({ bookFrom: 'S18', boardAt: 'S20', stopsBefore: 2, stopsAfter: 0 });
    const x = r.alternatives.find(a => a.ticketDestination === 'S27')!;
    expect(x).toMatchObject({ bookFrom: 'S20', boardAt: 'S20', stopsBefore: 0, stopsAfter: 2 });
  });
});

describe('Phase 2 stale snapshots: shown with ⚠ + age, selectable only through a fresh re-check', () => {
  const staleDeps = (fresh: () => Answer) => {
    let phase: 'search' | 'recheck' = 'search';
    const m = mkDeps(q => (phase === 'recheck' ? fresh() : q.origin === 'S19' ? { status: 'RAC 7', updated: new Date(Date.now() - 200 * MIN).toISOString() } : 'WL 9'));
    return { ...m, recheck: () => { phase = 'recheck'; } };
  };
  it('[BF9] a too-old RAC snapshot → the option carries staleSnapshot (status, age); never VERIFIED / counted; search not complete', async () => {
    const s = staleDeps(() => 'RAC 7');
    const r = await ok(REQ(), s.deps);
    const a = r.alternatives.find(x => x.ticketOrigin === 'S19')!;
    expect(a.availability).toBe('UNKNOWN');
    expect(a.verificationStatus).toBe('UNVERIFIED');
    expect(a.staleSnapshot).toMatchObject({ provider: 'railcore', status: 'RAC 7', category: 'RAC' });
    expect(a.staleSnapshot!.ageMinutes).toBeGreaterThanOrEqual(199);
    expect(r.verifiedAlternativeCount).toBe(0);
    expect(r.searchComplete).toBe(false);
    // screen: ⚠ option with age + "Fresh check + Select"
    const card: any = sameTrainCardData(r);
    expect(staleSelectable(card.alternatives.find((x: any) => x.ticketOrigin === 'S19'))).toBe(true);
    expect(staleOptionLine(a)).toMatch(/^⚠ Provider data .*\(\d+ min purana\) — Select par pehle fresh check hoga$/);
    const html = renderToStaticMarkup(<SameTrainOptionList d={card} sessionId="s-bfe" onHandoff={() => {}} />);
    expect(html).toContain('Fresh check + Select');
    expect(html).toContain('⚠ RAC 7');
    expect(html).toContain('min purana');
  });
  it('[BF10] Select on a stale option = fresh re-check: fresh RAC → ok (fresh status); fresh stale again → refused; fresh WL → refused', async () => {
    for (const [fresh, expectOk, code] of [['RAC 6', true, undefined], [{ status: 'RAC 7', updated: new Date(Date.now() - 300 * MIN).toISOString() }, false, 'STALE_PROVIDER_DATA'], ['WL 3', false, 'ALTERNATIVE_NO_LONGER_AVAILABLE']] as const) {
      const s = staleDeps(() => fresh as Answer);
      const r = await ok(REQ(), s.deps);
      const a = r.alternatives.find(x => x.ticketOrigin === 'S19')!;
      s.recheck(); s.calls.length = 0;
      const out = await revalidateSameTrainAlternative(r, r.alternativeSearchId, a.alternativeId, r.journeyKey, { acknowledgeUnverifiedRules: true, deps: s.deps });
      expect(s.calls).toHaveLength(1);                                   // one FRESH call to the provider that answered
      expect(s.calls[0]).toMatchObject({ origin: 'S19', destination: 'S25', travelClass: 'SL' });
      expect(out.ok).toBe(expectOk);
      if (code) expect(out.code).toBe(code);
      else expect(out.fresh![0].status).toBe('RAC 6');
    }
  });
  it('[BF11] the boarding-rule acknowledgement still applies to a stale option; a stale WAITLIST is never selectable', async () => {
    const s = staleDeps(() => 'RAC 6');
    const r = await ok(REQ(), s.deps);
    const a = r.alternatives.find(x => x.ticketOrigin === 'S19')!;
    const noAck = await revalidateSameTrainAlternative(r, r.alternativeSearchId, a.alternativeId, r.journeyKey, { deps: s.deps });
    expect(noAck.ok).toBe(false);
    expect(noAck.code).toBe('BOARDING_RULE_UNVERIFIED');
    const wl = { ...a, staleSnapshot: { ...a.staleSnapshot!, status: 'WL 4', category: 'WAITLIST' as const } };
    expect(staleSelectable(wl)).toBe(false);
    const r2 = { ...r, alternatives: r.alternatives.map(x => (x.alternativeId === a.alternativeId ? wl : x)) };
    const out = await revalidateSameTrainAlternative(r2, r.alternativeSearchId, a.alternativeId, r.journeyKey, { acknowledgeUnverifiedRules: true, deps: s.deps });
    expect(out.code).toBe('ALTERNATIVE_NOT_ACTIONABLE');
  });
});

describe('Phase 2 better WL (fresh, earlier station, lower than the direct WL — never confirmed)', () => {
  it('[BF12] nothing bookable → earlier-station WL lower than the direct WL is marked; shown as WL (screen + Muse view); no Select', async () => {
    const { deps } = mkDeps(q => (q.origin === 'S18' ? 'GNWL20/WL4' : q.origin === 'S19' ? 'WL 30' : 'GNWL60/WL17'));
    const r = await ok(REQ({ directStatus: { SL: 'GNWL60/WL17' } } as any), deps);
    const s18 = r.alternatives.find(a => a.ticketOrigin === 'S18' && a.travelClass === 'SL')!;
    expect(s18.betterWaitlist).toEqual({ waitlist: 4, directWaitlist: 17 });
    expect(r.alternatives.find(a => a.ticketOrigin === 'S19')!.betterWaitlist).toBeUndefined();          // 30 ≥ 17
    expect(r.alternatives.filter(a => a.betterWaitlist).every(a => a.kind === 'ORIGIN_ALTERNATIVE')).toBe(true);
    expect(r.betterWaitlistCount).toBeGreaterThanOrEqual(1);
    expect(r.verifiedAlternativeCount).toBe(0);
    const v: any = sameTrainLLMView(r);
    expect(v.betterWaitlistNotConfirmed.join(' ')).toMatch(/S18→S25 SL WL 4 \(direct WL 17\)/);
    const card: any = sameTrainCardData(r);
    expect(betterWaitlistOf(card).map((a: any) => a.ticketOrigin)).toContain('S18');
    expect(betterWaitlistLine(card.alternatives.find((a: any) => a.ticketOrigin === 'S18'))).toBe('S18 → S25 · SL · WL 4 (direct WL 17) — WL hai, confirm nahi');
    const html = renderToStaticMarkup(<BetterWaitlistLines d={card} />);
    expect(html).toContain(BETTER_WL_HEADING);
    expect(html).not.toMatch(/Select/);
  });
  it('[BF13] no better WL when a bookable option exists, when the direct status is not a waitlist (fresh P0 RAC), or without the direct status (Muse tool path — unchanged)', async () => {
    const a = mkDeps(q => (q.origin === 'S18' ? 'WL 4' : q.origin === 'S19' ? 'RAC 3' : 'WL 17'));
    const r1 = await ok(REQ({ directStatus: { SL: 'WL 17' } } as any), a.deps);
    expect(r1.alternatives.some(x => x.betterWaitlist)).toBe(false);
    const b = mkDeps(q => (q.origin === 'S18' ? 'WL 4' : q.origin === 'S20' && q.destination === 'S25' ? 'RAC 9' : 'WL 17'));
    const r2 = await ok(REQ({ directStatus: { SL: 'WL 17' } } as any), b.deps);
    expect(r2.alternatives.some(x => x.betterWaitlist)).toBe(false);
    const c = mkDeps(q => (q.origin === 'S18' ? 'WL 4' : 'WL 17'));
    // findBoardFromEarlier request (directStatus present, row has no SL status) → the fresh requested-pair WL 17 is the direct WL
    const r3 = await ok(REQ({ directStatus: {} } as any), c.deps);
    expect(r3.alternatives.find(x => x.ticketOrigin === 'S18')!.betterWaitlist).toEqual({ waitlist: 4, directWaitlist: 17 });
    // unit: the row status is used only when the requested pair gave no fresh WL
    const alts: any[] = [{ isRequestedPair: false, kind: 'ORIGIN_ALTERNATIVE', availability: 'WAITLIST', verificationStatus: 'VERIFIED', availabilityStatusText: 'WL 2', travelClass: '3A' }];
    expect(markBetterWaitlist(alts as any, { '3A': 'GNWL9/WL5' })).toBe(1);
    expect(alts[0].betterWaitlist).toEqual({ waitlist: 2, directWaitlist: 5 });
    expect(markBetterWaitlist([{ ...alts[0], betterWaitlist: undefined }] as any, undefined)).toBe(0);
    // engine without directStatus (Muse tool path) → never marked
    const d = mkDeps(q => (q.origin === 'S18' ? 'WL 4' : 'WL 17'));
    expect((await ok(REQ(), d.deps)).alternatives.some(x => x.betterWaitlist)).toBe(false);
  });
});

function sessionWith(classes: Array<[string, string]>, train = '11906') {
  const state = new ConversationStateManager();
  const s: any = state.createSession();
  Object.assign(s, { origin: 'S20', destination: 'S25', date: DATE, passengersCount: 1, searchResultsVersion: 1, journeyVersion: 1,
    searchResults: { version: 1, retrievedAt: new Date().toISOString(), journey: { origin: 'S20', destination: 'S25', date: DATE },
      trains: [{ trainNumber: train, trainName: 'HSX AGC EXP', classes: classes.map(([code, availability]) => ({ code, availability })) }] } });
  return { state, sid: s.sessionId as string, s };
}
const ENV = { SAME_TRAIN_ALTERNATIVES_ENABLED: '1' } as any;

describe('Phase 2 automatic discovery: waitlisted trains / classes only, staged, bounded', () => {
  it('[BF14] REGRET / NOT AVAILABLE / AVAILABLE (even fewer seats than the party) / RAC / CANCELLED → never searched (no provider call)', async () => {
    for (const st of ['REGRET', 'NOT AVAILABLE', 'AVAILABLE-0001', 'RAC 4', 'TRAIN CANCELLED']) {
      const a = sessionWith([['SL', st]]); a.s.passengersCount = 3;
      const m = mkDeps(() => 'WL 1');
      const out = await discoverSameTrainForDisplay(a.state, a.sid, { trainNumber: '11906', searchResultsVersion: 1 }, { deps: m.deps, env: ENV });
      expect(out.code).toBe('NOT_NEEDED');
      expect(m.calls).toHaveLength(0);
    }
    expect(needsSameTrainDiscovery('GNWL 5', 1)).toBe(true);
    for (const st of ['REGRET', 'AVAILABLE-0001', 'RAC 4', 'NOT AVAILABLE', null]) expect(needsSameTrainDiscovery(st, 3)).toBe(false);
  });
  it('[BF15] a waitlisted train: only its waitlisted classes are searched (REGRET / AVAILABLE classes ignored), staged, direct status passed', async () => {
    const a = sessionWith([['SL', 'GNWL74/WL16'], ['3E', 'AVAILABLE-0006'], ['3A', 'GNWL14/WL6'], ['2A', 'REGRET']]);
    const m = mkDeps(q => (q.origin === 'S18' && q.travelClass === '3A' ? 'WL 2' : 'WL 40'));
    const out = await discoverSameTrainForDisplay(a.state, a.sid, { trainNumber: '11906', searchResultsVersion: 1 }, { deps: m.deps, env: ENV });
    expect(out).toMatchObject({ ok: true, code: 'OK' });
    expect(out.result!.classesChecked).toEqual(['SL', '3A']);
    expect(new Set(m.calls.map(q => q.travelClass))).toEqual(new Set(['SL', '3A']));
    // stage A first: 2 earlier + 3 ahead (then B1 / terminus because nothing bookable)
    expect(out.result!.route.destinationExtension).toEqual(['S26', 'S27', 'S28']);
    // better WL uses the train's direct WL per class (3A direct WL 6 from the row; requested-pair answer WL 40 is SL-only)
    const bw = out.result!.alternatives.find(x => x.ticketOrigin === 'S18' && x.travelClass === '3A')!;
    expect(bw.betterWaitlist).toEqual({ waitlist: 2, directWaitlist: 6 });
  });
  it('[BF16] SAME_TRAIN_WL_ONLY=off → the previous trigger (REGRET searched); SAME_TRAIN_STAGED_DEPTH=off → the previous window (5..7 ahead)', async () => {
    const a = sessionWith([['SL', 'REGRET']]);
    const m = mkDeps(() => 'WL 1');
    const out = await discoverSameTrainForDisplay(a.state, a.sid, { trainNumber: '11906', searchResultsVersion: 1 }, { deps: m.deps, env: { ...ENV, SAME_TRAIN_WL_ONLY: 'off', SAME_TRAIN_STAGED_DEPTH: 'off' } });
    expect(out.code).toBe('OK');
    expect(out.result!.route.destinationExtension.length).toBeGreaterThanOrEqual(5);
  });
  it('[BF17] at most 3 automatic train searches run at once; the rest wait (QUEUED) and all complete', async () => {
    const trains = ['11901', '11902', '11903', '11904', '11905'];
    const state = new ConversationStateManager();
    const s: any = state.createSession();
    Object.assign(s, { origin: 'S20', destination: 'S25', date: DATE, passengersCount: 1, searchResultsVersion: 1, journeyVersion: 1,
      searchResults: { version: 1, retrievedAt: new Date().toISOString(), journey: { origin: 'S20', destination: 'S25', date: DATE },
        trains: trains.map(t => ({ trainNumber: t, trainName: 'T', classes: [{ code: 'SL', availability: 'WL 5' }] })) } });
    let maxUsed = 0; let sawWaiting = false; const started = new Set<string>();
    const deps: SameTrainDeps = {
      limits: LIMITS, getRoute: async () => ({ ok: true, data: ROUTE }),
      checkAvailability: async (_p, q) => {
        started.add(q.trainNumber);
        const slots = sameTrainTrainSlotsForTests();
        maxUsed = Math.max(maxUsed, slots.used); if (slots.waiting > 0) sawWaiting = true;
        await new Promise(r => setTimeout(r, 2));
        return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: q.origin === 'S19' ? 'RAC 1' : 'WL 9' } };
      }
    };
    const outs = await Promise.all(trains.map(t => discoverSameTrainForDisplay(state, s.sessionId, { trainNumber: t, searchResultsVersion: 1 }, { deps, env: ENV })));
    expect(outs.every(o => o.ok && o.code === 'OK')).toBe(true);
    expect(started.size).toBe(5);
    expect(maxUsed).toBe(3);
    expect(sawWaiting).toBe(true);
    expect(sameTrainTrainSlotsForTests()).toEqual({ used: 0, waiting: 0 });     // every slot released
  });
});
