// @vitest-environment happy-dom
/**
 * P42-14 — same-train only recovery (user decision 2026-10-09). MOCK only — no network, no credits.
 *   - engine: bounded window first (≤15 earlier stations / train origin, destination + 5..7); when NO searched class has a
 *     bookable seat (AVAILABLE for the whole party / RAC) the destination continues up to the train's terminal
 *     (terminalSweep AUTO); default NEVER keeps the pre-P42-14 behaviour;
 *   - automatic display: only the classes that show a shortage (waiting) on the train row are searched, requested first;
 *   - UI: 3 same-train options, then "See other alternatives (N)" reveals ALL the rest (nothing cut); a partial search with
 *     nothing verified says so honestly; the TrainCard never lists other trains (p42-13 [36]).
 * Routes / statuses are TEST DATA (the app always takes them from the provider).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { runSameTrainSearch, planCandidates, normalizeRoute, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS, type SameTrainAlternativesResult } from '../../shared/same-train-alternatives';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { discoverSameTrainForDisplay } from '../../server/railway/same-train/same-train-session';
import { SameTrainOptionList, SameTrainInline, SAME_TRAIN_PREVIEW, SAME_TRAIN_PARTIAL_NOTE } from '../../src/components/trains/SameTrainInline';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const DATE = '2026-10-12';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const LIMITS = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 150, totalTimeoutMs: 3000 };
/** 40 stations S00 … S39: requested origin S20, requested destination S25 (terminal S39) */
const ROUTE = Array.from({ length: 40 }, (_, i) => ({ station: `S${String(i).padStart(2, '0')}`, stationName: `Stop ${i}`, departure: `${String(i % 24).padStart(2, '0')}:10` }));

type StatusFn = (q: AvailabilityQuery) => string;
function mkDeps(status: StatusFn) {
  const calls: AvailabilityQuery[] = [];
  const deps: SameTrainDeps = {
    limits: LIMITS,
    getRoute: async () => ({ ok: true, data: ROUTE }),
    checkAvailability: async (_p, q) => { calls.push(q); return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: status(q) } }; }
  };
  return { deps, calls };
}
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's1', turnId: null, requestId: null, journeyVersion: 1, trainNumber: '11906', trainName: 'HSX AGC EXP', date: DATE,
  travelClass: 'SL', classes: ['SL', '3A'], passengersCount: 1, origin: 'S20', destination: 'S25',
  originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false,
  providers: [RC], routeProvider: RC, webProviders: [], ...over
});
const ok = async (req: SameTrainSearchRequest, deps: SameTrainDeps): Promise<SameTrainAlternativesResult> => {
  const r = await runSameTrainSearch(req, deps);
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.result;
};
const idx = (code: string) => Number(code.slice(1));

describe('P42-14 engine — bounded window, then up to the train terminal', () => {
  it('[1] plan: ≤15 earlier stations (train origin bound), destination + 5..7, terminal phase = rest of the route (AUTO only)', () => {
    const route = normalizeRoute(ROUTE as any);
    if (!route.ok) throw new Error('route');
    const auto = planCandidates(route.stations, route.duplicates, { origin: 'S20', destination: 'S25', originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', terminalSweep: 'AUTO' }, LIMITS);
    if (!auto.ok) throw new Error('plan');
    expect(auto.plan.originAlternatives.map(s => s.code)).toEqual(Array.from({ length: 15 }, (_, i) => `S${String(i + 5).padStart(2, '0')}`));
    expect(auto.plan.destinationExtension.map(s => s.code)).toEqual(['S26', 'S27', 'S28', 'S29', 'S30', 'S31']);
    expect(auto.plan.terminalExtension.map(s => s.code)).toEqual(['S32', 'S33', 'S34', 'S35', 'S36', 'S37', 'S38', 'S39']);
    expect(auto.plan.phase3.every(p => p.ticketOrigin === 'S20' && p.kind === 'DESTINATION_EXTENSION')).toBe(true);
    const never = planCandidates(route.stations, route.duplicates, { origin: 'S20', destination: 'S25', originSweep: true, destinationSweep: true, combinedPairs: 'NEVER' }, LIMITS);
    if (!never.ok) throw new Error('plan');
    expect(never.plan.phase3).toEqual([]); expect(never.plan.terminalExtension).toEqual([]);
    // short route: origin sweep stops at the train origin
    const short = planCandidates(route.stations, route.duplicates, { origin: 'S03', destination: 'S38', originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', terminalSweep: 'AUTO' }, LIMITS);
    if (!short.ok) throw new Error('plan');
    expect(short.plan.originAlternatives.map(s => s.code)).toEqual(['S00', 'S01', 'S02']);
    expect(short.plan.destinationExtension.map(s => s.code)).toEqual(['S39']);
    expect(short.plan.phase3).toEqual([]);
  });
  it('[2] nothing bookable in the window (every searched class WL) → destination continues to the terminal; a far seat is found and listed', async () => {
    const { deps, calls } = mkDeps(q => (q.origin === 'S20' && q.destination === 'S36' && q.travelClass === '3A' ? 'AVAILABLE-0004' : 'GNWL 9'));
    const r = await ok(REQ({ terminalSweep: 'AUTO' }), deps);
    const far = calls.filter(q => idx(q.destination) > 31);
    expect(far.length).toBe(8 * 2);                                            // S32 … S39 × SL, 3A
    expect(far.every(q => q.origin === 'S20')).toBe(true);
    expect(r.route.terminalSweep).toEqual(['S32', 'S33', 'S34', 'S35', 'S36', 'S37', 'S38', 'S39']);
    expect(r.downstreamStationsChecked).toBe(6 + 8);
    expect(r.alternatives.find(a => a.ticketDestination === 'S36' && a.travelClass === '3A')).toMatchObject({ availability: 'AVAILABLE', ticketOrigin: 'S20' });
    expect(r.route.stations[r.route.stations.length - 1].code).toBe('S39');
  });
  it('[3] a bookable seat in ANY searched class inside the window (RAC counts) → no terminal phase, no extra provider call', async () => {
    const { deps, calls } = mkDeps(q => (q.origin === 'S12' && q.destination === 'S25' && q.travelClass === '3A' ? 'RAC 6' : 'GNWL 9'));
    const r = await ok(REQ({ terminalSweep: 'AUTO' }), deps);
    expect(calls.some(q => idx(q.destination) > 31)).toBe(false);
    expect(r.route.terminalSweep).toBeUndefined();
    expect(r.downstreamStationsChecked).toBe(6);
  });
  it('[4] default (terminalSweep absent) = pre-P42-14 behaviour: never past the 5..7 window', async () => {
    const { deps, calls } = mkDeps(() => 'GNWL 9');
    const r = await ok(REQ(), deps);
    expect(calls.some(q => idx(q.destination) > 31)).toBe(false);
    expect(r.route.terminalSweep).toBeUndefined();
  });
  it('[5] WL / UNKNOWN / rate-limited answers never count as a seat (terminal phase still runs; nothing invented)', async () => {
    const { deps, calls } = mkDeps(q => (idx(q.destination) <= 31 ? 'WL 3' : 'GNWL 1'));
    const r = await ok(REQ({ terminalSweep: 'AUTO' }), deps);
    expect(calls.some(q => idx(q.destination) > 31)).toBe(true);
    expect(r.verifiedAlternativeCount).toBe(0);
    expect(r.alternatives.every(a => a.availability !== 'AVAILABLE' && a.availability !== 'RAC')).toBe(true);
  });
});

function sessionWith(classes: Array<[string, string]>, requestedClass?: string) {
  const state = new ConversationStateManager();
  const s: any = state.createSession();
  Object.assign(s, { origin: 'S20', destination: 'S25', date: DATE, passengersCount: 1, requestedClass, searchResultsVersion: 1, journeyVersion: 1,
    searchResults: { version: 1, retrievedAt: new Date().toISOString(), journey: { origin: 'S20', destination: 'S25', date: DATE },
      trains: [{ trainNumber: '11906', trainName: 'HSX AGC EXP', classes: classes.map(([code, availability]) => ({ code, availability })) }] } });
  return { state, sid: s.sessionId as string };
}

describe('P42-14 automatic display — waiting classes only, terminal sweep on', () => {
  it('[6] only the classes that show a shortage on the row are searched (requested / first waiting class first); an available class is not re-searched', async () => {
    const a = sessionWith([['SL', 'GNWL74/WL16'], ['3E', 'AVAILABLE-0006'], ['3A', 'GNWL14/WL6'], ['2A', 'REGRET']]);
    const { deps, calls } = mkDeps(() => 'GNWL 9');
    const out = await discoverSameTrainForDisplay(a.state, a.sid, { trainNumber: '11906', searchResultsVersion: 1 }, { deps, env: { SAME_TRAIN_ALTERNATIVES_ENABLED: '1' } as any });
    expect(out).toMatchObject({ ok: true, code: 'OK' });
    expect(out.result!.classesChecked).toEqual(['SL', '3A', '2A']);
    expect(new Set(calls.map(q => q.travelClass))).toEqual(new Set(['SL', '3A', '2A']));
    // nothing bookable in the window → the terminal phase ran (automatic display uses terminalSweep AUTO)
    expect(calls.some(q => idx(q.destination) > 31)).toBe(true);
    expect(out.result!.route.terminalSweep?.length).toBe(8);
  });
  it('[7] requested class known and waiting → it is checked first, other waiting classes follow', async () => {
    const a = sessionWith([['SL', 'WL 16'], ['3A', 'WL 6'], ['2A', 'AVAILABLE-0003']], '3A');
    const { deps } = mkDeps(q => (q.origin === 'S15' ? 'AVAILABLE-0002' : 'WL 9'));
    const out = await discoverSameTrainForDisplay(a.state, a.sid, { trainNumber: '11906', searchResultsVersion: 1 }, { deps, env: { SAME_TRAIN_ALTERNATIVES_ENABLED: '1' } as any });
    expect(out.result!.classesChecked).toEqual(['3A', 'SL']);
    expect(out.result!.route.terminalSweep).toBeUndefined();                  // seat found in the window
  });
});

// ------------------------------------------------------------------ UI
const alt = (id: string, o: string, d: string, extra: any = {}) => ({
  alternativeId: id, trainNumber: '11906', travelClass: 'SL', kind: 'ORIGIN_SWEEP', requestedOrigin: 'LDH', requestedDestination: 'NDLS',
  ticketOrigin: o, ticketDestination: d, availability: 'RAC', availabilityStatusText: 'RAC 28', verificationStatus: 'PARTIALLY_VERIFIED',
  boardingRuleStatus: 'UNVERIFIED', alightingRuleStatus: 'NOT_REQUIRED', boardingStation: o, alightingStation: d, isRequestedPair: false, evidence: [], ...extra });
const cardOf = (alternatives: any[], over: any = {}) => ({ alternativeSearchId: 'sta_p4214', trainNumber: '11906', trainName: 'HSX AGC EXP', travelClass: 'SL', date: DATE,
  passengersCount: 1, requestedPassengerCount: 1, requestedOrigin: 'LDH', requestedDestination: 'NDLS', status: 'OK', alternatives, ...over });
const SEVEN = ['HSX', 'KHRD', 'JRC', 'JUC', 'PGW', 'GRY', 'BDMJ'].map((o, i) => alt(`A${i + 1}`, o, 'NDLS'));

let root: Root; let host: HTMLElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const opts = () => [...host.querySelectorAll('.bk-sti__pair')].map(e => (e.textContent || '').replace(/^BOOK\s*/, ''));
const button = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent || '')) as HTMLButtonElement | undefined;

describe('P42-14 UI — 3 options, then "See other alternatives" (nothing cut)', () => {
  it('[8] 7 verified options → first 3 in backend route order + "See other alternatives (4) →"; expanding shows ALL 7; Hide returns to 3', async () => {
    act(() => root.render(React.createElement(SameTrainOptionList, { d: cardOf(SEVEN), sessionId: 's', onHandoff: () => {}, showTrain: true })));
    expect(SAME_TRAIN_PREVIEW).toBe(3);
    expect(opts()).toEqual(['HSX → NDLS', 'KHRD → NDLS', 'JRC → NDLS']);
    expect(button(/See other alternatives/)?.textContent).toBe('See other alternatives (4) →');
    await act(async () => { button(/See other alternatives/)!.click(); });
    expect(opts()).toEqual(['HSX → NDLS', 'KHRD → NDLS', 'JRC → NDLS', 'JUC → NDLS', 'PGW → NDLS', 'GRY → NDLS', 'BDMJ → NDLS']);
    expect(button(/See other alternatives/)).toBeUndefined();
    await act(async () => { button(/Hide other alternatives/)!.click(); });
    expect(opts()).toHaveLength(3);
    expect(host.textContent).not.toMatch(/best|recommended|fastest/i);
  });
  it('[9] ≤3 options → all shown, no "See other alternatives"; the list is the SAME train only', async () => {
    act(() => root.render(React.createElement(SameTrainOptionList, { d: cardOf([...SEVEN.slice(0, 2), alt('B1', 'JUC', 'NDLS', { trainNumber: '12904' })]), sessionId: 's', onHandoff: () => {} })));
    expect(opts()).toEqual(['HSX → NDLS', 'KHRD → NDLS']);
    expect(button(/See other alternatives/)).toBeUndefined();
  });
  it('[10] 20+ options are never truncated (no 15 cap)', async () => {
    const many = Array.from({ length: 22 }, (_, i) => alt(`M${i}`, `X${String(i).padStart(2, '0')}`, 'NDLS'));
    act(() => root.render(React.createElement(SameTrainOptionList, { d: cardOf(many), sessionId: 's', onHandoff: () => {} })));
    expect(button(/See other alternatives/)?.textContent).toBe('See other alternatives (19) →');
    await act(async () => { button(/See other alternatives/)!.click(); });
    expect(opts()).toHaveLength(22);
  });
  it('[11] automatic section: partial search (rate limit) with nothing verified → honest note + existing tap action; complete search with nothing → nothing', async () => {
    let card: any = cardOf([alt('W1', 'HSX', 'NDLS', { availability: 'WAITLIST', availabilityStatusText: 'WL 3' })], { status: 'PARTIAL' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, code: 'OK', card }) })));
    const fallbacks: string[] = [];
    const el = (key: string) => React.createElement(SameTrainInline, { key, sessionId: 'sess-' + key, trainNumber: '12446', searchResultsVersion: 1, visible: true, onHandoff: () => {}, onFallback: () => fallbacks.push('x') });
    act(() => root.render(el('a'))); await flush();
    expect(host.textContent).toContain(SAME_TRAIN_PARTIAL_NOTE);
    expect(host.textContent).not.toMatch(/seat nahi hai|no seats|not available/i);
    await act(async () => { button(/Same Train Alternative/)!.click(); });
    expect(fallbacks).toEqual(['x']);
    card = cardOf([alt('W1', 'HSX', 'NDLS', { availability: 'WAITLIST', availabilityStatusText: 'WL 3' })], { status: 'NOT_FOUND' });
    act(() => root.render(el('b'))); await flush();
    expect(host.textContent).toBe('');
  });
});
