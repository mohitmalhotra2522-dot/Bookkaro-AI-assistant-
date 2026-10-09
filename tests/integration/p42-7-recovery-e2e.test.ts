/**
 * P42.7 G3 + G5 + Part 49 — intelligent same-train recovery end-to-end through the Muse integration (fake OpenAI-compatible
 * server playing Muse, deterministic MOCK connectors — no network, no credits). NO train / class selection anywhere: Muse
 * only searches (with the class the user named) — recovery eligibility, the all-class matrix, the once-per-turn safety-net,
 * the automatic display, stale protection and the explicit select → fresh recheck → apply are what is under test.
 * Trains / routes / statuses are TEST DATA served by the mock connectors (the app never hardcodes them). The route places
 * JUC before ASR so that the user's Part 49 scenario (board earlier at JUC for ASR → NDLS) exists as data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.hoisted(() => {
  process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1';
  process.env.SAME_TRAIN_CALL_TIMEOUT_MS = '500';
  process.env.SAME_TRAIN_TOTAL_TIMEOUT_MS = '4000';
  process.env.BFE_SAFETY_NET_LOG = '1';
});
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
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
import { revalidateSameTrainAlternative, sameTrainSelectionKey, isSameTrainResultStale } from '../../server/railway/same-train/same-train-service';
import { applySameTrainSelection, findAnySameTrainResult, discoverSameTrainForDisplay } from '../../server/railway/same-train/same-train-session';
import { sameTrainCardData } from '../../server/railway/same-train/same-train-view';
import { memoryContextView } from '../../server/ai/context/context-builder';
import { groupRecoveryByPair, SameTrainOptionList, BFE_HEADING } from '../../src/components/trains/SameTrainInline';
import { FakeOpenAI, type TurnView, type FakeReply } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P427-RECOVERY-SECRET-4242';
const TOMORROW = (() => { const d = new Date(`${todayInIndia().date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const ROUTE = [['JAT', 'Jammu Tawi'], ['PTKC', 'Pathankot Cantt'], ['JUC', 'Jalandhar City'], ['ASR', 'Amritsar Jn'], ['LDH', 'Ludhiana Jn'], ['UMB', 'Ambala Cant Jn'], ['NDLS', 'New Delhi']]
  .map(([station, stationName]) => ({ station, stationName }));
type Classes = Record<string, Array<[string, string | null]>>;
const train = (num: string, classes: Array<[string, string | null]>) => ({ trainNumber: num, trainName: num === '12414' ? 'Pooja SF Express' : 'Express', origin: 'ASR', destination: 'NDLS',
  departure: '06:00', arrival: '12:00', duration: '6h 0m', classes: classes.map(([code, availability]) => ({ code, availability, availabilityStatus: 'UNKNOWN', fare: null, fareCurrency: null })) });
const ALT = (extra: any = {}) => ({ name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', args: { trainNumber: '12414', travelClass: 'SL', date: TOMORROW, origin: 'ASR', destination: 'NDLS', combinedPairs: 'NEVER', providers: 'railcore', ...extra } });
const SEARCH = (extra: any = {}) => ({ name: 'railcore_search', args: { origin: 'ASR', destination: 'NDLS', date: TOMORROW, passengersCount: 3, requestedClass: 'SL', ...extra } });

let rc: MockProviderConnector, rr: MockProviderConnector, dispose: () => void;
let searchData: Classes = {};
type Script = (v: TurnView) => FakeReply;
function harness(script: Record<string, Script | FakeReply[]>, state = new ConversationStateManager()) {
  const fake = new FakeOpenAI((v: TurnView) => {
    const p = script[v.user];
    if (!p) return { content: 'Theek hai.' };
    if (typeof p === 'function') return p(v);
    return v.step < p.length ? p[v.step] : { content: 'Theek hai.' };
  });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 120, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const id = state.createSession().sessionId;
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(id, t, mode) as Promise<any>;
  return { state, say, sid: id, s: () => state.getSession(id) as any };
}
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage].map(x => String(x ?? '')).join(' | ');
const cards = (r: any) => (r.cards || []).filter((c: any) => c.type === 'same_train_alternatives').map((c: any) => c.data);
const recs = (r: any) => (r.turnLog?.toolExecutions || []) as any[];
const stRecs = (r: any) => recs(r).filter(x => x.tool === 'SEARCH_SAME_TRAIN_ALTERNATIVES');
function setStatus(fn: (q: any) => string | { error: string }) {
  for (const c of [rc, rr]) {
    (c as any).checkAvailability = async (req: any) => {
      c.calls.push(['availability', req]);
      const s = fn(req);
      if (typeof s === 'object') return { ok: false, error: { code: s.error, message: 'mock fault' } };
      return { ok: true, data: { trainNumber: req.trainNumber, travelClass: req.travelClass, date: req.date, status: s }, meta: { source: 'mock' } };
    };
  }
}
/** Part 49 data: ASR→NDLS SL WL1 (2A / 1A AVL); JUC→NDLS SL AVL 3, 3A AVL 4, 2A RAC 4; everything else waitlisted */
const P49 = (q: any): string => {
  if (q.origin === 'ASR' && q.destination === 'NDLS') return q.travelClass === 'SL' ? 'WL 1' : q.travelClass === '3A' ? 'WL 6' : 'AVAILABLE-0009';
  if (q.origin === 'JUC' && q.destination === 'NDLS') return ({ SL: 'AVAILABLE-0003', '3A': 'AVAILABLE-0004', '2A': 'RAC 4', '1A': 'GNWL 2' } as any)[q.travelClass] || 'GNWL 9';
  return 'GNWL 9';
};
const P49_ROW: Array<[string, string]> = [['SL', 'WL 1'], ['3A', 'WL 6'], ['2A', 'AVAILABLE-0009'], ['1A', 'AVAILABLE-0004']];
const altCalls = () => [...rc.calls, ...rr.calls].filter(x => x[0] === 'availability' && !((x[1] as any).origin === 'ASR' && (x[1] as any).destination === 'NDLS'));
const snMsg = (v: TurnView) => ((v.body?.messages || []) as any[]).find(m => m.role === 'system' && String(m.content).startsWith('BACKEND_SAFETY_NET'));
const snJson = (m: any) => JSON.parse(String(m.content).slice('BACKEND_SAFETY_NET '.length).split('\n')[0]);
let logs: any[] = [];
const Q = 'Amritsar se New Delhi kal 12414 SL, 3 passengers';

/** Muse: search (with the class the user named) → optionally its own recovery call → answer. No SELECT_TRAIN / SELECT_CLASS. */
const museFlow = (o: { recovery?: any; final?: string; afterSn?: string; seen?: (v: TurnView) => void; search?: any }): Script => (v: TurnView) => {
  o.seen?.(v);
  if (snMsg(v)) return { content: o.afterSn || 'SL mein WL 1 hai. Same train mein Jalandhar City se SL AVL 3 mil raha hai — Amritsar se boarding ka rule verify karna zaroori hai.' };
  const steps: FakeReply[] = [{ calls: [SEARCH(o.search)] }, ...(o.recovery ? [{ calls: [ALT(o.recovery === true ? {} : o.recovery)] } as FakeReply] : []), { content: o.final || '12414 SL mein abhi WL 1 hai.' }];
  return steps[v.step] || { content: o.final || 'Theek hai.' };
};

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
      const trains = Object.entries(searchData).map(([num, cls]) => train(num, cls));
      return { ok: true, data: { journey: { origin: req.origin, destination: req.destination, date: req.date }, trains, totalCount: trains.length }, meta: { source: 'mock', providerId: c.mockProviderId } };
    };
  }
  searchData = { '12414': P49_ROW };
  setStatus(P49);
  railwayRegistry.setActive('mock');
  logs = [];
  const realLog = console.log.bind(console);
  vi.spyOn(console, 'log').mockImplementation((...a: any[]) => {
    const t = String(a[0] ?? '');
    if (t.startsWith('{"event":"bfe_safety_net"')) { logs.push(JSON.parse(t)); return; }
    realLog(...a);
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => { if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i); throw new Error(`NO NETWORK IN TESTS: ${u}`); }) as any);
  vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.SAME_TRAIN_MAX_SEARCHES_PER_TURN; });

async function selectVia(state: ConversationStateManager, sid: string, alternativeSearchId: string, alternativeId: string, ack = true) {
  const s: any = state.getSession(sid);
  const stored = findAnySameTrainResult(s, alternativeSearchId);
  const out = await revalidateSameTrainAlternative(stored, alternativeSearchId, alternativeId, stored ? sameTrainSelectionKey(s, stored) : '', { acknowledgeUnverifiedRules: ack });
  const applied = out.ok && stored ? applySameTrainSelection(state, sid, stored, out) : { applied: false };
  return { out, applied };
}
const altOf = (res: any, o: string, cls: string) => (res.alternatives || []).find((a: any) => a.ticketOrigin === o && a.travelClass === cls);

// ================================================================= G3 — Muse + safety-net

/** Phase 2 shared policy (user-authorized 2026-10-09, "mixed"): tests that pin the PRE-Phase-2 Muse rules run with the
 *  documented rollback switch SAME_TRAIN_MUSE_SHARED_POLICY=off; the env is restored afterwards. Assertions unchanged. */
async function withMuseSharedPolicyOff(fn: () => unknown): Promise<void> {
  const prev = process.env.SAME_TRAIN_MUSE_SHARED_POLICY;
  process.env.SAME_TRAIN_MUSE_SHARED_POLICY = 'off';
  try { await fn(); } finally { if (prev === undefined) delete process.env.SAME_TRAIN_MUSE_SHARED_POLICY; else process.env.SAME_TRAIN_MUSE_SHARED_POLICY = prev; }
}

describe('P42.7 G3 — Muse decides, safety-net once, no selection required', () => {
  it('[G3.1] Muse requests recovery (no train / class selected): all-class search, recoveryEligibility on the search result (2A AVL does not cancel SL WL)', () => withMuseSharedPolicyOff(async () => {
    let elig: any;
    const h = harness({ [Q]: museFlow({ recovery: true, final: 'SL WL 1 hai; Jalandhar City se SL AVL 3 mil raha hai.', seen: v => { const r = v.results.find(x => x.name === 'railcore_search'); if (r) elig = r.content?.recoveryEligibility; } }) });
    const r = await h.say(Q);
    expect(h.s().selectedTrain).toBeFalsy(); expect(h.s().selectedClass).toBeFalsy();
    expect(h.s().requestedClass).toBe('SL');
    expect(elig).toEqual([expect.objectContaining({ trainNumber: '12414', requestedClass: 'SL', status: 'WL 1', recoveryEligible: true, reason: 'WAITLIST', passengers: 3, confirmedSeats: 0, requestedOrigin: 'ASR', requestedDestination: 'NDLS' })]);
    expect(stRecs(r)).toHaveLength(1);
    const c = cards(r)[0];
    expect(c.classesChecked).toEqual(['SL', '3A', '2A', '1A']);
    expect(altOf(c, 'JUC', 'SL')).toMatchObject({ availability: 'AVAILABLE', availableSeatCount: 3 });
    expect(logs.find(l => l.museRequestedBfe)).toMatchObject({ safetyNetTriggered: false });
    expect(logs.some(l => l.safetyNetTriggered)).toBe(false);
  }), 30000);

  it('[G3.2] Muse does not request → the safety-net invokes the existing tool once (search fact + requested class, no selection) and Muse presents', () => withMuseSharedPolicyOff(async () => {
    let sn: any;
    const h = harness({ [Q]: museFlow({ seen: v => { const m = snMsg(v); if (m) sn = snJson(m); } }) });
    const r = await h.say(Q);
    expect(stRecs(r)).toHaveLength(1);
    expect(sn).toMatchObject({ origin: 'BACKEND_SAFETY_NET', outcome: 'EXECUTED' });
    expect(sn.results[0].eligibility).toMatchObject({ trainNumber: '12414', classCode: 'SL', reason: 'WAITLIST', passengers: 3 });
    expect(cards(r)[0]).toMatchObject({ trainNumber: '12414', travelClass: 'SL', triggerSource: 'SAFETY_NET', classesChecked: ['SL', '3A', '2A', '1A'] });
    expect(logs.find(l => l.safetyNetTriggered)).toMatchObject({ trainNumber: '12414', classCode: 'SL', eligibilityReason: 'WAITLIST' });
    expect(h.s().sameTrainSelection).toBeUndefined();
  }), 30000);

  it('[G3.3] requested class has enough seats → recoveryEligible false → no safety-net, no same-train provider traffic', async () => {
    searchData = { '12414': [['SL', 'AVAILABLE-0005'], ['2A', 'WL 3']] };
    setStatus(q => (q.origin === 'ASR' ? (q.travelClass === 'SL' ? 'AVAILABLE-0005' : 'WL 3') : 'AVAILABLE-0009'));
    let elig: any;
    const h = harness({ [Q]: museFlow({ final: 'SL mein 5 seats hain.', seen: v => { const r = v.results.find(x => x.name === 'railcore_search'); if (r) elig = r.content?.recoveryEligibility; } }) });
    const r = await h.say(Q);
    expect(elig[0]).toMatchObject({ requestedClass: 'SL', recoveryEligible: false, reason: 'SEATS_SUFFICIENT', confirmedSeats: 5 });
    expect(stRecs(r)).toHaveLength(0);
    expect(altCalls()).toHaveLength(0);
    expect(logs).toHaveLength(0);
  }, 30000);

  it('[G3.4] explicit user request overrides SAME_TRAIN_NOT_NEEDED ("aur options dikhao"); without it the tool refuses', () => withMuseSharedPolicyOff(async () => {
    searchData = { '12414': [['SL', 'AVAILABLE-0005'], ['2A', 'AVAILABLE-0009']] };
    setStatus(q => (q.origin === 'ASR' ? 'AVAILABLE-0005' : 'AVAILABLE-0009'));
    let refused: any;
    const h = harness({
      [Q]: museFlow({ recovery: true, final: 'SL mein 5 seats hain.', seen: v => { const r = v.results.find(x => x.name === 'SEARCH_SAME_TRAIN_ALTERNATIVES'); if (r) refused = r.content; } }),
      'aur options dikhao': [{ calls: [ALT({ explicitUserRequest: true })] }, { content: 'Jalandhar City se bhi seats hain.' }]
    });
    const r1 = await h.say(Q);
    expect(JSON.stringify(refused)).toMatch(/SAME_TRAIN_ALTERNATIVE_NOT_NEEDED/);
    expect(altCalls()).toHaveLength(0);
    const r2 = await h.say('aur options dikhao');
    expect(stRecs(r2)).toHaveLength(1);
    expect(stRecs(r2)[0].status).toBe('SUCCEEDED');
    expect(cards(r2)[0]).toMatchObject({ explicitUserRequest: true });
    expect(altCalls().length).toBeGreaterThan(0);
    expect(r1).toBeTruthy();
  }), 30000);

  it('[G3.5] duplicate prevented: Muse already searched this train → no safety-net; a repeated identical call in the turn reuses one fan-out', async () => {
    const h = harness({ [Q]: (v: TurnView) => (v.step === 0 ? { calls: [SEARCH()] } : v.step === 1 ? { calls: [ALT(), ALT()] } : { content: 'Jalandhar City se SL AVL 3.' }) });
    const r = await h.say(Q);
    expect(stRecs(r).filter(x => x.status === 'SUCCEEDED')).toHaveLength(1);
    expect(logs.some(l => l.safetyNetTriggered)).toBe(false);
    const jucSl = altCalls().filter(x => (x[1] as any).origin === 'JUC' && (x[1] as any).travelClass === 'SL');
    expect(jucSl).toHaveLength(1);
  }, 30000);

  it('[G3.6] new information (a fresh "dobara check" turn) allows a fresh provider call — never an app cache', async () => {
    const h = harness({ [Q]: museFlow({ recovery: true, final: 'Jalandhar City se SL AVL 3.' }), 'dobara check karo': [{ calls: [ALT()] }, { content: 'Abhi bhi Jalandhar City se SL AVL 3.' }] });
    const r1 = await h.say(Q);
    const n1 = altCalls().length;
    const r2 = await h.say('dobara check karo');
    expect(altCalls().length).toBe(n1 * 2);
    expect(cards(r2)[0].alternativeSearchId).not.toBe(cards(r1)[0].alternativeSearchId);
    expect(cards(r2)[0]).toMatchObject({ fresh: true, cached: false });
  }, 30000);

  it('[G3.7] Muse presents: its own words reach the user; the backend never ranks (no best match unless Muse presents one)', () => withMuseSharedPolicyOff(async () => {
    const h = harness({ [Q]: museFlow({ afterSn: 'SL abhi WL 1 hai. Isi train mein Jalandhar City se SL ki 3 seats mil rahi hain, aur 2A mein RAC 4 hai.' }) });
    const r = await h.say(Q);
    expect(shown(r)).toContain('Jalandhar City se SL ki 3 seats');
    expect(cards(r)[0].presentation).toMatchObject({ bestMatchId: null, decidedBy: 'NONE' });
  }), 30000);

  it('[G3.8] several eligible trains and nothing selected → the backend does not pick one (no safety-net call); the UI shows recovery per train', async () => {
    searchData = { '12414': P49_ROW, '12904': [['SL', 'WL 7'], ['3A', 'AVAILABLE-0009']] };
    const h = harness({ [Q]: museFlow({ search: {}, final: 'Dono trains mein SL waitlisted hai.' }) });
    const r = await h.say(Q);
    expect(stRecs(r)).toHaveLength(0);
    expect(altCalls()).toHaveLength(0);
    expect(logs.filter(l => l.skippedReason === 'MULTIPLE_ELIGIBLE_TRAINS').map(l => l.trainNumber).sort()).toEqual(['12414', '12904']);
  }, 30000);
});

// ================================================================= Part 49 regression
describe('P42.7 Part 49 — 12414, 3 pax, ASR → NDLS SL (SL WL1; 2A / 1A AVL)', () => {
  it('[P49] recovery still runs; JUC → NDLS SL AVL 3 shown automatically with Select; Select → fresh check → apply (ticketOrigin JUC, 12414, SL, pax kept, fare / review invalidated)', () => withMuseSharedPolicyOff(async () => {
    const h = harness({ [Q]: museFlow({}) });
    await h.say(Q);
    const s0 = h.s();
    // automatic display for the list on screen: reuses the safety-net's all-class result (no second fan-out)
    const before = altCalls().length;
    const d = await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12414', searchResultsVersion: s0.searchResultsVersion });
    expect(d).toMatchObject({ ok: true, code: 'OK' });
    expect(altCalls().length).toBe(before);
    const card = sameTrainCardData(d.result!, { stale: false });
    const groups = groupRecoveryByPair(card, 'SL');
    expect(groups[0]).toMatchObject({ ticketOrigin: 'JUC', ticketDestination: 'NDLS', earlier: true });
    expect(groups[0].options.map((a: any) => a.travelClass)).toEqual(['SL', '3A', '2A']);
    const html = renderToStaticMarkup(React.createElement(SameTrainOptionList, { d: card, sessionId: h.sid, onHandoff: () => {}, requestedClass: 'SL', showTrain: true }));
    expect(html).toContain(BFE_HEADING);
    expect(html).toContain('bk-tag--good">AVL 3<');
    expect(html).toContain('bk-tag--warn">RAC 4<');
    expect(html).toMatch(/>Select</);
    expect(html).not.toMatch(/Alternative trains/i);
    // booking state the selection must invalidate
    s0.fare = { totalFare: 999, trainNumber: '12414' }; s0.review = { valid: true, reviewVersion: 1 };
    const sl = altOf(d.result, 'JUC', 'SL');
    const before2 = [...rc.calls].filter(x => x[0] === 'availability').length;
    const { out, applied } = await selectVia(h.state, h.sid, d.result!.alternativeSearchId, sl.alternativeId);
    expect(out.ok).toBe(true);
    expect([...rc.calls].filter(x => x[0] === 'availability').length).toBe(before2 + 1);     // fresh recheck before any change
    expect(applied.applied).toBe(true);
    const s = h.s();
    expect({ o: s.origin, d: s.destination, t: s.selectedTrain?.number, c: s.selectedClass, p: s.passengersCount }).toEqual({ o: 'JUC', d: 'NDLS', t: '12414', c: 'SL', p: 3 });
    expect(s.fare).toBeUndefined();
    expect(s.review.valid).toBe(false);
    expect(s.sameTrainSelection).toMatchObject({ ticketOrigin: 'JUC', ticketDestination: 'NDLS', requestedOrigin: 'ASR', travelClass: 'SL', boardingRuleStatus: 'UNVERIFIED', freshStatus: 'AVAILABLE-0003' });
  }), 30000);
});

// ================================================================= G5 — stale / security
describe('P42.7 G5 — stale protection and security', () => {
  async function recovered() {
    const h = harness({ [Q]: museFlow({ recovery: true, final: 'Jalandhar City se SL AVL 3.' }) });
    await h.say(Q);
    const res = h.s().sameTrainAlternatives;
    return { h, res };
  }
  it('[G5.1] date change → result stale → select refused, no provider call', async () => {
    const { h, res } = await recovered();
    h.s().date = '2031-01-01';
    expect(isSameTrainResultStale(h.s(), res)).toBe(true);
    const n = rc.calls.length;
    const { out } = await selectVia(h.state, h.sid, res.alternativeSearchId, altOf(res, 'JUC', 'SL').alternativeId);
    expect(out).toMatchObject({ ok: false, code: 'ALTERNATIVE_RESULT_STALE' });
    expect(rc.calls.length).toBe(n);
  }, 30000);
  it('[G5.2] passenger-count change → stale → select refused', async () => {
    const { h, res } = await recovered();
    h.s().passengersCount = 4;
    const { out } = await selectVia(h.state, h.sid, res.alternativeSearchId, altOf(res, 'JUC', 'SL').alternativeId);
    expect(out).toMatchObject({ ok: false, code: 'ALTERNATIVE_RESULT_STALE' });
  }, 30000);
  it('[G5.3] train change → the 12414 result is stale for the newly selected train', async () => {
    const { h, res } = await recovered();
    h.state.setSelectedTrain(h.sid, train('12904', [['SL', 'WL 7']]) as any);
    expect(isSameTrainResultStale(h.s(), res)).toBe(true);
  }, 30000);
  it('[G5.4] journeyVersion change during the automatic search → RESULTS_STALE, nothing stored for the old journey', async () => {
    const h = harness({ [Q]: museFlow({ search: { requestedClass: 'SL' }, final: 'Theek hai.' }) });
    searchData = { '12414': P49_ROW, '12904': [['SL', 'WL 7']] };           // two trains → no safety-net, the UI discovers
    await h.say(Q);
    const s = h.s();
    setStatus(q => { s.journeyVersion = (s.journeyVersion || 0) + 1; return P49(q); });
    const d = await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12414', searchResultsVersion: s.searchResultsVersion });
    expect(d).toMatchObject({ ok: false, code: 'RESULTS_STALE' });
    expect((s.sameTrainAutoSets || []).length).toBe(0);
  }, 30000);
  it('[G5.5] no cross-train contamination: every option of a result is the same train; the UI never lists another train', async () => {
    const { res } = await recovered();
    expect(res.alternatives.every((a: any) => a.trainNumber === '12414')).toBe(true);
    const mixed = { ...sameTrainCardData(res), alternatives: [...res.alternatives, { ...altOf(res, 'JUC', 'SL'), alternativeId: 'X9', trainNumber: '12904' }] };
    expect(groupRecoveryByPair(mixed, 'SL').flatMap(g => g.options).every((a: any) => a.trainNumber === '12414')).toBe(true);
  }, 30000);
  it('[G5.6] no cross-class contamination: a 3A chip rechecks / applies 3A (its own class); a requested-class change (SL → 3A) makes the SL result stale', async () => {
    const { h, res } = await recovered();
    const { out, applied } = await selectVia(h.state, h.sid, res.alternativeSearchId, altOf(res, 'JUC', '3A').alternativeId);
    expect(out.ok).toBe(true); expect(applied.applied).toBe(true);
    expect(rc.calls.filter(x => x[0] === 'availability').pop()![1]).toMatchObject({ travelClass: '3A', origin: 'JUC', destination: 'NDLS' });
    expect(h.s().selectedClass).toBe('3A');
    const again = await recovered();
    again.h.s().requestedClass = '3A';
    expect(isSameTrainResultStale(again.h.s(), again.res)).toBe(true);
  }, 30000);
  it('[G5.7] no cross-date contamination: a provider answer for another date is rejected (never shown as availability)', async () => {
    setStatus(q => P49(q));
    for (const c of [rc, rr]) {
      const orig = (c as any).checkAvailability;
      (c as any).checkAvailability = async (req: any) => { const r = await orig(req); return req.origin === 'JUC' ? { ...r, data: { ...r.data, date: '2031-01-01' } } : r; };
    }
    const { res } = await recovered();
    expect(res.alternatives.filter((a: any) => a.ticketOrigin === 'JUC')).toHaveLength(0);     // INVALID (wrong date) → hidden
  }, 30000);
  it('[G5.8] stale list: discovery for an older search-results version is refused with no provider call; stale context is dropped from Muse memory', () => withMuseSharedPolicyOff(async () => {
    const { h, res } = await recovered();
    const n = altCalls().length;
    expect(await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12414', searchResultsVersion: h.s().searchResultsVersion - 1 })).toMatchObject({ ok: false, code: 'RESULTS_STALE' });
    expect(altCalls().length).toBe(n);
    expect(memoryContextView(h.s()).sameTrainShown?.[0]).toMatchObject({ trainNumber: '12414', classesChecked: 'SL,3A,2A,1A', verifiedClasses: 'SL,3A,2A' });
    expect(memoryContextView(h.s()).requestedClass).toBe('SL');
    h.s().date = '2031-01-01';
    const m = memoryContextView(h.s());
    expect(m.sameTrainShown).toBeUndefined();
    expect(m.staleRejected).toBeGreaterThan(0);
    expect(res).toBeTruthy();
  }), 30000);
  it('[G5.9] boarding stays UNVERIFIED and separate: ticket JUC, boarding JUC (never "board at ASR allowed")', async () => {
    const { h, res } = await recovered();
    const a = altOf(res, 'JUC', 'SL');
    expect(a).toMatchObject({ boardingRuleStatus: 'UNVERIFIED', boardingStation: 'JUC', intendedBoardingStation: 'ASR' });
    const html = renderToStaticMarkup(React.createElement(SameTrainOptionList, { d: sameTrainCardData(res), sessionId: h.sid, onHandoff: () => {}, requestedClass: 'SL' }));
    expect(html).toMatch(/Amritsar Jn se boarding ka rule verify nahi hua/);
    expect(html).toMatch(/BOARD<\/b> Jalandhar City/);
  }, 30000);
  it('[G5.10] no automatic booking: search / safety-net / automatic display never select, apply or hand off — only an explicit Select does', async () => {
    const h = harness({ [Q]: museFlow({}) });
    await h.say(Q);
    const d = await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12414', searchResultsVersion: h.s().searchResultsVersion });
    expect(d.ok).toBe(true);
    const s = h.s();
    expect(s.sameTrainSelection).toBeUndefined();
    expect({ o: s.origin, d: s.destination, t: s.selectedTrain ?? null, c: s.selectedClass ?? null }).toEqual({ o: 'ASR', d: 'NDLS', t: null, c: null });
    expect(IrctcHandoffAdapter.prototype.executeHandoff).not.toHaveBeenCalled();
    expect(JSON.stringify(logs)).not.toMatch(/sk-live|password|otp/i);
  }, 30000);
});
