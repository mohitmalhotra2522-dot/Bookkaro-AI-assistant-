/**
 * P42.2 G3 — intelligent Same Train Alternative through the Muse integration (deterministic MOCK connectors, fake
 * OpenAI-compatible server playing Muse — no network, no credits). Muse's choices are scripted (it sometimes "tries"
 * a wrong call on purpose); what is under test is the BACKEND: structured shortage facts to Muse (seatCheck), hard
 * constraints (no search when seats suffice, no invented class), party-bound sufficiency, typed outcomes, cards only
 * for verified alternatives, stale protection, fresh recheck, claim binding and voice = screen.
 * Trains / routes / statuses below are TEST DATA served by the mock connectors (the app never hardcodes them).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.hoisted(() => {
  process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1';
  process.env.SAME_TRAIN_CALL_TIMEOUT_MS = '500';
  process.env.SAME_TRAIN_TOTAL_TIMEOUT_MS = '4000';
});
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { providerToolCatalog } from '../../server/ai/tools/provider-tools';
import { registerMockProviderConnectors, MOCK_CONNECTOR_CAPS, type MockProviderConnector } from '../../server/railway/providers/mock/mock-provider-connectors';
import { todayInIndia } from '../../server/ai/providers/openai-compatible-llm';
import { revalidateSameTrainAlternative, sameTrainSelectionKey, findSameTrainResult, isSameTrainResultStale } from '../../server/railway/same-train/same-train-service';
import { FakeOpenAI, type TurnView, type FakeReply } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P422-TRIGGER-SECRET-4242';
const TOMORROW = (() => { const d = new Date(`${todayInIndia().date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const ROUTE = [['ASR', 'Amritsar Jn'], ['BEAS', 'Beas'], ['JUC', 'Jalandhar City'], ['PGW', 'Phagwara Jn'], ['LDH', 'Ludhiana Jn'], ['SIR', 'Sirhind Jn'],
  ['RPJ', 'Rajpura Jn'], ['UMB', 'Ambala Cant Jn'], ['KKDE', 'Kurukshetra Jn'], ['PNP', 'Panipat Jn'], ['NDLS', 'New Delhi']]
  .map(([station, stationName]) => ({ station, stationName }));
/** TEST DATA — the SEARCH_TRAINS answer (per-class provider availability, exact counts where the provider gives one) */
type Classes = Record<string, Array<[string, string | null]>>;
const train = (num: string, name: string, classes: Array<[string, string | null]>) => ({ trainNumber: num, trainName: name, origin: 'ASR', destination: 'NDLS',
  departure: '06:00', arrival: '12:00', duration: '6h 0m', classes: classes.map(([code, availability]) => ({ code, availability, availabilityStatus: 'UNKNOWN', fare: null, fareCurrency: null })) });
const SEARCH_ARGS = { origin: 'LDH', destination: 'UMB', date: TOMORROW };
const ALT = (extra: any = {}) => ({ name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', args: { trainNumber: '12903', travelClass: '1A', date: TOMORROW, origin: 'LDH', destination: 'UMB', combinedPairs: 'NEVER', providers: 'railcore', ...extra } });

type Script = (v: TurnView) => FakeReply;
let rc: MockProviderConnector, rr: MockProviderConnector, dispose: () => void;
let state: ConversationStateManager;
let searchData: Classes = {};

function harness(script: Record<string, Script | FakeReply[]>) {
  const fake = new FakeOpenAI((v: TurnView) => {
    const p = script[v.user];
    if (!p) return { content: 'Theek hai.' };
    if (typeof p === 'function') return p(v);
    return v.step < p.length ? p[v.step] : { content: 'Theek hai.' };
  });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 120, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>;
  return { fake, say, sid, s: () => state.getSession(sid) as any };
}
const recs = (r: any) => (r.turnLog?.toolExecutions || []) as any[];
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage].map(x => String(x ?? '')).join(' | ');
const cards = (r: any) => (r.cards || []).filter((c: any) => c.type === 'same_train_alternatives').map((c: any) => c.data);
const resultsOf = (v: TurnView, name: string) => v.results.filter(x => x.name === name).map(x => x.content);
function deep(o: any, k: string): any {
  if (!o || typeof o !== 'object') return undefined;
  if (k in o) return o[k];
  for (const v of Object.values(o)) { const r = deep(v, k); if (r !== undefined) return r; }
  return undefined;
}
type StatusFn = (q: any) => string | 'HANG' | { error: string };
function setStatus(fn: StatusFn) {
  for (const c of [rc, rr]) {
    (c as any).checkAvailability = async (req: any) => {
      c.calls.push(['availability', req]);
      const s = fn(req);
      if (s === 'HANG') return new Promise(() => { /* never */ });
      if (typeof s === 'object') return { ok: false, error: { code: s.error, message: 'mock fault' } };
      return { ok: true, data: { trainNumber: req.trainNumber, travelClass: req.travelClass, date: req.date, status: s }, meta: { source: 'mock' } };
    };
  }
}
const availCalls = (c: MockProviderConnector) => c.calls.filter(x => x[0] === 'availability');

const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(() => {
  ({ railcore: rc, railradar: rr, dispose } = registerMockProviderConnectors());
  providerToolCatalog.register({ id: 'railcore', label: rc.connectorLabel, registryId: rc.mockProviderId, capabilities: [...MOCK_CONNECTOR_CAPS.railcore, 'GET_TIMETABLE' as any] });
});
afterAll(() => dispose());
beforeEach(() => {
  rc.reset(); rr.reset();
  for (const c of [rc, rr]) {
    (c as any).getTimetable = async (req: any) => { c.calls.push(['timetable' as any, req]); return { ok: true, data: ROUTE, meta: { source: 'mock' } }; };
    (c as any).searchTrains = async (req: any) => {
      c.calls.push(['search', req]);
      const trains = Object.entries(searchData).map(([num, cls]) => train(num, num === '12903' ? 'Golden Temple Mail' : 'Express', cls));
      return { ok: true, data: { journey: { origin: req.origin, destination: req.destination, date: req.date }, trains, totalCount: trains.length }, meta: { source: 'mock', providerId: c.mockProviderId } };
    };
  }
  searchData = { '12903': [['1A', 'AVAILABLE-0001'], ['2A', 'AVAILABLE-0010'], ['3A', 'GNWL 5']] };
  setStatus(q => (q.origin === 'JUC' ? 'AVAILABLE-0003' : q.origin === 'LDH' && q.destination === 'UMB' ? 'AVAILABLE-0001' : 'GNWL 9'));
  railwayRegistry.setActive('mock');
  vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => { if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i); throw new Error(`NO NETWORK IN TESTS: ${u}`); }) as any);
  vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.restoreAllMocks(); });

/** step 0: Muse searches trains (pax from the user); later steps scripted per test */
const flow = (pax: number, after: Array<(v: TurnView) => FakeReply>): Script => (v: TurnView) =>
  (v.step === 0 ? { calls: [{ name: 'railcore_search', args: { ...SEARCH_ARGS, passengersCount: pax } }] } : (after[v.step - 1] || (() => ({ content: 'Theek hai.' })))(v));
const seatCheckSeen = (v: TurnView) => deep(resultsOf(v, 'railcore_search')[0], 'seatCheck');
const altResults = (v: TurnView) => resultsOf(v, 'SEARCH_SAME_TRAIN_ALTERNATIVES');

describe('P42.2 G3 — intelligent Same Train Alternative through Muse', () => {
  it('[A] sufficient seats → Muse sees no shortage; a same-train call is refused (NOT_NEEDED) before any provider call; no card', async () => {
    let sc: any, err: any;
    const U = 'Ludhiana se Ambala kal 12903 2A, 3 passengers';
    const h = harness({ [U]: flow(3, [v => { sc = seatCheckSeen(v); return { calls: [ALT({ travelClass: '2A' })] }; }, v => { err = altResults(v)[0]; return { content: '12903 2A mein 10 seats available hain.' }; }]) });
    const r = await h.say(U);
    expect(sc.shortages.some((x: any) => x.class === '2A')).toBe(false);
    expect(JSON.stringify(err)).toMatch(/SAME_TRAIN_ALTERNATIVE_NOT_NEEDED/);
    expect(availCalls(rc).length + availCalls(rr).length).toBe(0);
    expect(cards(r)).toHaveLength(0);
  });

  it('[B][G] 3 passengers, 1 seat → INSUFFICIENT_SEATS fact → alternative found (Jalandhar 3 seats) → card; honest wording kept', async () => {
    let sc: any, res: any;
    const U = 'Ludhiana se Ambala kal 12903 1A, 3 passengers';
    const final = '12903 1A mein Ludhiana se sirf 1 seat hai. Jalandhar se 3 seats available hain, lekin Ludhiana se boarding ka rule verify karna zaroori hai.';
    const h = harness({ [U]: flow(3, [v => { sc = seatCheckSeen(v); return { calls: [ALT()] }; }, v => { res = altResults(v)[0]; return { content: final }; }]) });
    const r = await h.say(U);
    expect(sc.shortages).toEqual(expect.arrayContaining([{ train: '12903', class: '1A', availabilityStatus: 'AVAILABLE', availableSeatCount: 1, triggerReason: 'INSUFFICIENT_SEATS' }]));
    expect(sc.requestedPassengerCount).toBe(3);
    expect(res.data).toMatchObject({ outcome: 'VERIFIED_ALTERNATIVE_FOUND', triggerReason: 'INSUFFICIENT_SEATS', passengersCount: 3, verifiedAlternativeCount: 1 });
    expect(deep(res.data.alternatives, 'A1')).toMatchObject({ kind: 'REQUESTED', availableSeatCount: 1, seatSufficiency: 'INSUFFICIENT' });   // Muse sees the exact count
    const c = cards(r);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ trainNumber: '12903', travelClass: '1A', passengersCount: 3, requestedPassengerCount: 3, triggerSource: 'SESSION_EVIDENCE', verifiedAlternativeCount: 1 });
    expect(c[0].toolExecutionId).toBeTruthy();
    expect(c[0].alternatives.find((a: any) => a.isRequestedPair)).toMatchObject({ availableSeatCount: 1, seatSufficiency: 'INSUFFICIENT' });
    expect(c[0].alternatives.find((a: any) => a.ticketOrigin === 'JUC')).toMatchObject({ availableSeatCount: 3, seatSufficiency: 'SUFFICIENT', boardingRuleStatus: 'UNVERIFIED' });
    expect(shown(r)).toContain('sirf 1 seat');
    expect(shown(r)).toContain('Jalandhar se 3 seats available');
    expect(h.s().selectedTrain ?? null).toBeNull();                                              // nothing booked / selected
  });

  it('[C] WAITLIST → trigger WAITLIST; [D][H] NOT AVAILABLE with nothing better → NO_VERIFIED outcome to Muse, no fake card', async () => {
    searchData = { '12903': [['1A', 'GNWL 12'], ['2A', 'NOT AVAILABLE']] };
    let resC: any, resD: any;
    const U1 = 'Ludhiana se Ambala kal 12903 1A, 2 passengers';
    const U2 = '12903 2A ka bhi same train option dekho';
    setStatus(q => (q.travelClass === '1A' && q.origin === 'BEAS' ? 'AVAILABLE 4' : q.travelClass === '2A' ? 'NOT AVAILABLE' : 'GNWL 9'));
    const h = harness({
      [U1]: flow(2, [() => ({ calls: [ALT()] }), v => { resC = altResults(v)[0]; return { content: 'Beas se 4 seats available hain, lekin Ludhiana se boarding ka rule verify karna zaroori hai.' }; }]),
      [U2]: [{ calls: [ALT({ travelClass: '2A' })] }, { content: 'Koi verified option nahi mila.' }]
    });
    const r1 = await h.say(U1);
    expect(resC.data).toMatchObject({ triggerReason: 'WAITLIST', outcome: 'VERIFIED_ALTERNATIVE_FOUND' });
    expect(cards(r1)).toHaveLength(1);
    const r2 = await h.say(U2);
    const rec = recs(r2).find((x: any) => x.tool === 'SEARCH_SAME_TRAIN_ALTERNATIVES');
    expect(rec).toBeTruthy();
    const stored = findSameTrainResult(h.s(), h.s().sameTrainAlternatives.alternativeSearchId)!;
    expect(stored).toMatchObject({ travelClass: '2A', triggerReason: 'NOT_AVAILABLE', outcome: 'NO_VERIFIED_SAME_TRAIN_ALTERNATIVE', verifiedAlternativeCount: 0 });
    expect(cards(r2)).toHaveLength(0);                                                           // no empty / fake card
    expect(shown(r2)).toContain('Koi verified option nahi mila');
  });

  it('[E] mixed classes: shortages only for 1A (1 seat) + 3A (WL); 2A (10 seats) refused; invented EC refused; 1A + 3A searched in parallel → one card each', async () => {
    let sc: any, results: any[] = [];
    setStatus(q => (q.origin === 'JUC' ? 'AVAILABLE-0003' : 'GNWL 9'));
    const U = 'Ludhiana se Ambala kal 12903, 3 passengers — koi bhi AC class';
    const h = harness({ [U]: flow(3, [v => { sc = seatCheckSeen(v); return { calls: [ALT(), ALT({ travelClass: '3A' }), ALT({ travelClass: '2A' }), ALT({ travelClass: 'EC' })] }; },
      v => { results = altResults(v); return { content: 'Jalandhar se 3 seats available hain, lekin Ludhiana se boarding ka rule verify karna zaroori hai.' }; }]) });
    const r = await h.say(U);
    expect(sc.shortages.map((x: any) => x.class).sort()).toEqual(['1A', '3A']);
    const s = JSON.stringify(results);
    expect(s).toMatch(/SAME_TRAIN_ALTERNATIVE_NOT_NEEDED/);
    expect(s).toMatch(/EC class nahi hai/);
    const classesCalled = new Set(availCalls(rc).map(x => x[1].travelClass));
    expect([...classesCalled].sort()).toEqual(['1A', '3A']);                                     // never 2A, never EC
    expect(cards(r).map((c: any) => c.travelClass).sort()).toEqual(['1A', '3A']);
    expect(h.s().sameTrainAlternativeSets.length).toBe(2);
  });

  it('[F] multi-train: two displayed trains with a shortage are both eligible; each result keeps its own train identity', async () => {
    searchData = { '12903': [['1A', 'GNWL 3']], '12497': [['CC', 'REGRET'], ['2S', 'AVAILABLE-0040']] };
    let sc: any;
    setStatus(q => (q.origin === 'JUC' ? 'AVAILABLE-0006' : 'GNWL 9'));
    const U = 'Ludhiana se Ambala kal, 2 passengers — koi seat wali train?';
    const h = harness({ [U]: flow(2, [v => { sc = seatCheckSeen(v); return { calls: [ALT(), ALT({ trainNumber: '12497', travelClass: 'CC' })] }; },
      () => ({ content: 'Jalandhar se dono trains mein seats available hain, lekin Ludhiana se boarding ka rule verify karna zaroori hai.' })]) });
    const r = await h.say(U);
    expect(sc.shortages).toHaveLength(2);                                                          // 12497 2S (40 seats) is not a shortage
    expect(sc.shortages).toEqual(expect.arrayContaining([{ train: '12903', class: '1A', availabilityStatus: 'WAITLIST', triggerReason: 'WAITLIST' }, { train: '12497', class: 'CC', availabilityStatus: 'REGRET', triggerReason: 'REGRET' }]));
    const c = cards(r);
    expect(c.map((x: any) => `${x.trainNumber}:${x.travelClass}`).sort()).toEqual(['12497:CC', '12903:1A']);
    for (const x of c) expect(x.alternatives.every((a: any) => a.trainNumber === x.trainNumber)).toBe(true);
    expect(availCalls(rc).every(x => (x[1].trainNumber === '12903' && x[1].travelClass === '1A') || (x[1].trainNumber === '12497' && x[1].travelClass === 'CC'))).toBe(true);
  });

  it('[budget + duplicate] identical call in the same turn is deduplicated (one fan-out); more than 4 searches per turn stop safely', async () => {
    searchData = { '12903': [['1A', 'GNWL 3'], ['2A', 'GNWL 4'], ['3A', 'GNWL 5'], ['SL', 'GNWL 6'], ['2S', 'GNWL 7']] };
    let last: any[] = [];
    const U = 'Ludhiana se Ambala kal 12903, 1 passenger, sab classes';
    const h = harness({ [U]: flow(1, [() => ({ calls: [ALT()] }), () => ({ calls: [ALT()] }),
      () => ({ calls: [ALT({ travelClass: '2A' }), ALT({ travelClass: '3A' }), ALT({ travelClass: 'SL' }), ALT({ travelClass: '2S' })] }), v => { last = v.results; return { content: 'Theek hai.' }; }]) });
    await h.say(U);
    const st = last.filter(x => x.name === 'SEARCH_SAME_TRAIN_ALTERNATIVES').map(x => x.content);
    expect(st[0].toolResultId).toBe(st[1].toolResultId);                                         // the repeated 1A call reuses the same-turn result
    expect(st[0].data.alternativeSearchId).toBe(st[1].data.alternativeSearchId);
    expect(availCalls(rc).filter(x => x[1].travelClass === '1A' && x[1].origin === 'LDH' && x[1].destination === 'UMB').length).toBe(1);
    expect(st[st.length - 1]).toMatchObject({ ok: false, error: { code: 'SAME_TRAIN_SEARCH_BUDGET_EXCEEDED' } });   // 5th distinct search refused; earlier results kept
    expect(st.slice(0, -1).every((x: any) => x.ok === true)).toBe(true);
    expect(new Set(availCalls(rc).map(x => x[1].travelClass)).size).toBe(4);                     // 1A + three more; the 5th never ran
  });

  it('[I] selection: fresh recheck against the result set; fewer seats now → refused; [J] date change → stale, no provider call', async () => {
    const U = 'Ludhiana se Ambala kal 12903 1A, 3 passengers';
    const h = harness({ [U]: flow(3, [() => ({ calls: [ALT()] }), () => ({ content: 'Jalandhar se 3 seats available hain, lekin Ludhiana se boarding ka rule verify karna zaroori hai.' })]) });
    await h.say(U);
    const s = h.s();
    const r = findSameTrainResult(s, s.sameTrainAlternatives.alternativeSearchId)!;
    const juc = r.alternatives.find(a => a.ticketOrigin === 'JUC')!.alternativeId;
    const n = availCalls(rc).length;
    const okSel = await revalidateSameTrainAlternative(r, r.alternativeSearchId, juc, sameTrainSelectionKey(s, r), { acknowledgeUnverifiedRules: true });
    expect(okSel).toMatchObject({ ok: true });
    expect(availCalls(rc).length).toBe(n + 1);
    setStatus(() => 'AVAILABLE-0001');
    expect(await revalidateSameTrainAlternative(r, r.alternativeSearchId, juc, sameTrainSelectionKey(s, r), { acknowledgeUnverifiedRules: true })).toMatchObject({ ok: false, code: 'ALTERNATIVE_INSUFFICIENT_SEATS' });
    state.updateJourney(h.sid, { date: '2026-12-01' } as any);
    const m = availCalls(rc).length;
    expect(isSameTrainResultStale(h.s(), r)).toBe(true);
    expect(await revalidateSameTrainAlternative(r, r.alternativeSearchId, juc, sameTrainSelectionKey(h.s(), r), { acknowledgeUnverifiedRules: true })).toMatchObject({ ok: false, code: 'ALTERNATIVE_RESULT_STALE' });
    expect(availCalls(rc).length).toBe(m);
  });

  it('[K] passenger change invalidates; the next search is fresh for the new count (not deduplicated)', async () => {
    const U1 = 'Ludhiana se Ambala kal 12903 1A, 2 passengers';
    const U2 = 'Actually 3 passengers — phir se same train option dekho';
    const h = harness({ [U1]: flow(2, [() => ({ calls: [ALT()] }), () => ({ content: 'Theek hai.' })]), [U2]: [{ calls: [ALT({ passengersCount: 3 })] }, { content: 'Theek hai.' }] });
    await h.say(U1);
    const first = h.s().sameTrainAlternatives;
    expect(first.passengersCount).toBe(2);
    h.s().passengersCount = 3;                                                                    // TEST SETUP: the validated pax update
    expect(isSameTrainResultStale(h.s(), first)).toBe(true);
    const n = availCalls(rc).length;
    await h.say(U2);
    const second = h.s().sameTrainAlternatives;
    expect(second.alternativeSearchId).not.toBe(first.alternativeSearchId);
    expect(second).toMatchObject({ passengersCount: 3, requestedPassengerCount: 3 });
    expect(availCalls(rc).length).toBeGreaterThan(n);
  });

  it('[L] class change: "Actually 3A" makes the 1A result stale (PRESENT refused)', async () => {
    let presentErr: any;
    const U1 = 'Ludhiana se Ambala kal 12903 1A, 3 passengers';
    const h = harness({
      [U1]: flow(3, [() => ({ calls: [ALT()] }), () => ({ content: 'Theek hai.' })]),
      'ab best wala dikhao': (v: TurnView) => (v.step === 0 ? { calls: [{ name: 'PRESENT_SAME_TRAIN_ALTERNATIVES', args: { alternativeSearchId: h.s().sameTrainAlternatives.alternativeSearchId, bestMatch: 'A2' } }] } : (presentErr = v.results[0]?.content, { content: 'Theek hai.' }))
    });
    await h.say(U1);
    const r = h.s().sameTrainAlternatives;
    expect(isSameTrainResultStale(h.s(), r)).toBe(false);
    state.setSelectedClass(h.sid, '3A');                                                         // the user changed the class
    expect(isSameTrainResultStale(h.s(), r)).toBe(true);
    await h.say('ab best wala dikhao');
    expect(JSON.stringify(presentErr)).toMatch(/STALE_ALTERNATIVE_RESULT/);
  });

  it('[M][N] cross-train and cross-class seat claims are removed from the reply; the grounded sentence stays', async () => {
    const U = 'Ludhiana se Ambala kal 12903 1A, 3 passengers';
    const final = 'Jalandhar se 3 seats available hain, lekin Ludhiana se boarding ka rule verify karna zaroori hai. 12497 mein bhi Jalandhar se 3 seats available hain. 12903 2A mein bhi Jalandhar se 3 seats available hain.';
    const h = harness({ [U]: flow(3, [() => ({ calls: [ALT()] }), () => ({ content: final })]) });
    const r = await h.say(U);
    expect(shown(r)).toContain('Jalandhar se 3 seats available hain');
    expect(shown(r)).not.toContain('12497 mein bhi');
    expect(shown(r)).not.toContain('2A mein bhi');
  });

  it('[O] voice = screen: same card, spoken words grounded in the same result, unverified claim never spoken', async () => {
    const U = 'Ludhiana se Ambala kal 12903 1A, 3 passengers';
    const final = 'Jalandhar se 3 seats available hain, lekin Ludhiana se boarding ka rule verify karna zaroori hai. 12497 mein bhi Jalandhar se 3 seats available hain.';
    const ht = harness({ [U]: flow(3, [() => ({ calls: [ALT()] }), () => ({ content: final })]) });
    const t = await ht.say(U, 'TEXT');
    const hv = harness({ [U]: flow(3, [() => ({ calls: [ALT()] }), () => ({ content: final })]) });
    const v = await hv.say(U, 'VOICE');
    const strip = (c: any) => c.map((x: any) => ({ train: x.trainNumber, cls: x.travelClass, pax: x.passengersCount, alts: x.alternatives.map((a: any) => [a.pairId, a.availabilityStatusText, a.seatSufficiency]) }));
    expect(strip(cards(v))).toEqual(strip(cards(t)));
    const speech = String(v.voice?.speechText || '');
    expect(speech.length).toBeGreaterThan(0);
    expect(speech).not.toContain('12497');
    expect(speech).toMatch(/Jalandhar/);
  });
});
