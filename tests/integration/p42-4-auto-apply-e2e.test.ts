/**
 * P42.4 — phone-test feedback (2026-10-07), deterministic MOCK connectors + fake OpenAI-compatible server (no network):
 *   [D] AUTO display discovery gates: only a displayed train / listed class / current list / real shortage; budget,
 *       in-flight dedupe, primary provider only, combined pairs never, booking untouched.
 *   [S] "Use this option" → fresh recheck → backend APPLIES ticket pair + train + class (passengers kept, review / fare
 *       invalid, fresh status = availability evidence) → the next Muse reply about that ticket is NOT replaced by
 *       "Is information ka verified result available nahi hai." (exact phone repro).
 *   [R] RAC keeps its RAC tag and is actionable; a pair that fell to WAITLIST at the fresh check is not applied.
 * Trains / routes / statuses are TEST DATA served by the mock connectors.
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
import { revalidateSameTrainAlternative, sameTrainSelectionKey } from '../../server/railway/same-train/same-train-service';
import { discoverSameTrainForDisplay, applySameTrainSelection, findAnySameTrainResult } from '../../server/railway/same-train/same-train-session';
import { memoryContextView } from '../../server/ai/context/context-builder';
import { isVerifiedSameTrainAlternative } from '../../shared/same-train-shortage';
import { FakeOpenAI, type TurnView, type FakeReply } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P424-AUTO-SECRET-4242';
const FALLBACK = 'Is information ka verified result available nahi hai.';
const TOMORROW = (() => { const d = new Date(`${todayInIndia().date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const ROUTE = [['ASR', 'Amritsar Jn'], ['BEAS', 'Beas'], ['JUC', 'Jalandhar City'], ['PGW', 'Phagwara Jn'], ['LDH', 'Ludhiana Jn'], ['SIR', 'Sirhind Jn'],
  ['RPJ', 'Rajpura Jn'], ['UMB', 'Ambala Cant Jn'], ['KKDE', 'Kurukshetra Jn'], ['PNP', 'Panipat Jn'], ['NDLS', 'New Delhi']]
  .map(([station, stationName]) => ({ station, stationName }));
type Classes = Record<string, Array<[string, string | null]>>;
const train = (num: string, classes: Array<[string, string | null]>) => ({ trainNumber: num, trainName: num === '12903' ? 'Golden Temple Mail' : 'Express', origin: 'ASR', destination: 'NDLS',
  departure: '06:00', arrival: '12:00', duration: '6h 0m', classes: classes.map(([code, availability]) => ({ code, availability, availabilityStatus: 'UNKNOWN', fare: null, fareCurrency: null })) });
const SEARCH_ARGS = { origin: 'LDH', destination: 'UMB', date: TOMORROW };
const ALT = (extra: any = {}) => ({ name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', args: { trainNumber: '12903', travelClass: '1A', date: TOMORROW, origin: 'LDH', destination: 'UMB', combinedPairs: 'NEVER', providers: 'railcore', ...extra } });

let rc: MockProviderConnector, rr: MockProviderConnector, dispose: () => void;
let searchData: Classes = {};
type Script = (v: TurnView) => FakeReply;
function harness(script: Record<string, Script | FakeReply[]>) {
  const fake = new FakeOpenAI((v: TurnView) => {
    const p = script[v.user];
    if (!p) return { content: 'Theek hai.' };
    if (typeof p === 'function') return p(v);
    return v.step < p.length ? p[v.step] : { content: 'Theek hai.' };
  });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 120, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>;
  return { state, say, sid, s: () => state.getSession(sid) as any };
}
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage].map(x => String(x ?? '')).join(' | ');
const cards = (r: any) => (r.cards || []).filter((c: any) => c.type === 'same_train_alternatives').map((c: any) => c.data);
function setStatus(fn: (q: any) => string) {
  for (const c of [rc, rr]) {
    (c as any).checkAvailability = async (req: any) => {
      c.calls.push(['availability', req]);
      return { ok: true, data: { trainNumber: req.trainNumber, travelClass: req.travelClass, date: req.date, status: fn(req) }, meta: { source: 'mock' } };
    };
  }
}
const availCalls = (c: MockProviderConnector) => c.calls.filter(x => x[0] === 'availability');
/** the select endpoint's sequence (server/main.ts) */
async function selectViaEndpoint(state: ConversationStateManager, sid: string, alternativeSearchId: string, alternativeId: string, ack = true) {
  const s: any = state.getSession(sid);
  const stored = findAnySameTrainResult(s, alternativeSearchId) || s.sameTrainAlternatives;
  const out = await revalidateSameTrainAlternative(stored, alternativeSearchId, alternativeId, stored ? sameTrainSelectionKey(s, stored) : '', { acknowledgeUnverifiedRules: ack });
  const applied = out.ok && stored ? applySameTrainSelection(state, sid, stored, out) : { applied: false };
  return { out, applied };
}
const searchFlow = (pax: number, after: Array<(v: TurnView) => FakeReply> = []): Script => (v: TurnView) =>
  (v.step === 0 ? { calls: [{ name: 'railcore_search', args: { ...SEARCH_ARGS, passengersCount: pax } }] } : (after[v.step - 1] || (() => ({ content: 'Trains mil gayi.' })))(v));

const realFetch = globalThis.fetch.bind(globalThis);
beforeAll(() => {
  ({ railcore: rc, railradar: rr, dispose } = registerMockProviderConnectors());
  providerToolCatalog.register({ id: 'railcore', label: rc.connectorLabel, registryId: rc.mockProviderId, capabilities: [...MOCK_CONNECTOR_CAPS.railcore, 'GET_TIMETABLE' as any] });
  providerToolCatalog.register({ id: 'railradar', label: rr.connectorLabel, registryId: rr.mockProviderId, capabilities: [...MOCK_CONNECTOR_CAPS.railradar, 'GET_TIMETABLE' as any] });
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
  searchData = { '12903': [['1A', 'GNWL 5'], ['2A', 'AVAILABLE-0010'], ['3A', 'RAC 4'], ['SL', 'REGRET']], '12014': [['CC', 'WL 3']] };
  setStatus(q => (q.origin === 'JUC' ? 'RAC 1' : q.origin === 'LDH' && q.destination === 'UMB' ? 'GNWL 5' : 'GNWL 9'));
  railwayRegistry.setActive('mock');
  vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => { if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i); throw new Error(`NO NETWORK IN TESTS: ${u}`); }) as any);
  vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.restoreAllMocks(); });

const U = 'Ludhiana se Ambala kal, 3 passengers';

describe('P42.4 [D] auto display discovery', () => {
  it('[D1] gates: stale list / undisplayed train / unlisted class / no shortage (AVAILABLE enough, RAC) / flag off → no provider call', async () => {
    const h = harness({ [U]: searchFlow(3) });
    expect((await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12903', travelClass: '1A', searchResultsVersion: 0 })).code).toBe('RESULTS_STALE');   // no list yet
    await h.say(U);
    const v = h.s().searchResultsVersion;
    expect(h.s().searchResults.trains.length).toBe(2);
    const D = (trainNumber: string, travelClass: string, ver = v, env?: any) => discoverSameTrainForDisplay(h.state, h.sid, { trainNumber, travelClass, searchResultsVersion: ver }, env ? { env } : {});
    expect((await D('12903', '1A', v - 1)).code).toBe('RESULTS_STALE');
    expect((await D('22222', '1A')).code).toBe('TRAIN_NOT_DISPLAYED');
    expect((await D('12903', 'CC')).code).toBe('CLASS_NOT_LISTED');
    expect((await D('12903', '2A')).code).toBe('NOT_NEEDED');          // 10 seats ≥ 3 passengers
    expect((await D('12903', '3A')).code).toBe('NOT_NEEDED');          // RAC is not a shortage trigger
    expect((await D('12903', '1A', v, { SAME_TRAIN_ALTERNATIVES_ENABLED: '0' })).code).toBe('NOT_ENABLED');
    expect((await D('12903', '1a; drop')).code).toBe('INVALID_REQUEST');
    expect(availCalls(rc).length + availCalls(rr).length).toBe(0);
    expect(h.s().sameTrainAutoSets).toBeUndefined();
  }, 30000);

  it('[D2] WL class → bounded search (primary provider only, no combined pairs, AUTO_DISPLAY); stored for the card only; booking untouched; dedupe; budget', async () => {
    const h = harness({ [U]: searchFlow(3) });
    await h.say(U);
    const v = h.s().searchResultsVersion;
    const before = { origin: h.s().origin, destination: h.s().destination, train: h.s().selectedTrain, cls: h.s().selectedClass, ver: h.s().sessionVersion };
    const [a, b] = await Promise.all([
      discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12903', travelClass: '1A', searchResultsVersion: v }),
      discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12903', travelClass: '1A', searchResultsVersion: v })
    ]);
    expect(a.ok).toBe(true);
    expect(b.result?.alternativeSearchId).toBe(a.result?.alternativeSearchId);                       // in-flight dedupe
    const calls1 = availCalls(rc).length;
    expect(calls1).toBeGreaterThan(0);
    expect(availCalls(rr).length).toBe(0);                                                           // primary provider only
    expect(a.result).toMatchObject({ trainNumber: '12903', travelClass: '1A', passengersCount: 3, triggerSource: 'AUTO_DISPLAY', triggerReason: 'WAITLIST' });
    expect((a.result!.alternatives || []).some((x: any) => x.kind === 'COMBINED')).toBe(false);
    const juc = a.result!.alternatives.find((x: any) => x.ticketOrigin === 'JUC' && x.ticketDestination === 'UMB')!;
    expect(juc).toMatchObject({ availability: 'RAC' });
    expect(isVerifiedSameTrainAlternative(juc)).toBe(true);                                         // [R] RAC = verified / actionable
    expect((juc as any).availabilityStatusText || '').toMatch(/RAC 1/);                              // RAC keeps its tag
    // booking never touched by discovery
    expect({ origin: h.s().origin, destination: h.s().destination, train: h.s().selectedTrain, cls: h.s().selectedClass }).toEqual({ origin: before.origin, destination: before.destination, train: before.train, cls: before.cls });
    expect(h.s().sameTrainAlternatives).toBeUndefined();                                             // Muse's latest result not clobbered
    expect(h.s().sameTrainAutoSets).toHaveLength(1);
    // same list again → same stored result, no new provider calls
    const again = await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12903', travelClass: '1A', searchResultsVersion: v });
    expect(again.result?.alternativeSearchId).toBe(a.result?.alternativeSearchId);
    expect(availCalls(rc).length).toBe(calls1);
    // budget: 1 per list → the next class is refused before any provider call
    const over = await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12014', travelClass: 'CC', searchResultsVersion: v }, { env: { ...process.env, SAME_TRAIN_AUTO_MAX_PER_RESULTS: '1' } });
    expect(over).toMatchObject({ ok: false, code: 'BUDGET_EXCEEDED', budget: { used: 1, max: 1 } });
    expect(availCalls(rc).length).toBe(calls1);
    // the Muse context sees what is on screen (codes / counts only)
    expect(memoryContextView(h.s()).sameTrainShown).toEqual([expect.objectContaining({ trainNumber: '12903', travelClass: '1A', source: 'AUTO_DISPLAY', verifiedOptions: expect.any(Number) })]);
  }, 30000);
});

describe('P42.4 [S] select applies the ticket', () => {
  it('[S1] exact phone repro: select RAC alternative → session = ticket pair / train / class / fresh RAC; Muse\'s next sentence about it is shown (no UNVERIFIED fallback)', async () => {
    const PICK = 'Jalandhar City se Ambala Cant ka ticket RAC 1 hai. Ludhiana se boarding ka rule verify karna zaroori hai.';
    const h = harness({ [U]: searchFlow(3) });
    await h.say(U);
    // passengers already entered before switching (must be kept)
    h.state.resizePassengers(h.sid, 3);
    h.s().passengers[0].name = 'Mohit'; h.s().passengers[0].age = 31; h.s().passengers[0].gender = 'MALE';
    const v = h.s().searchResultsVersion;
    const d = await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12903', travelClass: '1A', searchResultsVersion: v });
    const juc = d.result!.alternatives.find((x: any) => x.ticketOrigin === 'JUC' && x.ticketDestination === 'UMB')!;
    const { out, applied } = await selectViaEndpoint(h.state, h.sid, d.result!.alternativeSearchId, juc.alternativeId);
    expect(out.ok).toBe(true);
    expect(applied.applied).toBe(true);
    const s = h.s();
    expect({ o: s.origin, d: s.destination, date: s.date, train: s.selectedTrain?.number, cls: s.selectedClass }).toEqual({ o: 'JUC', d: 'UMB', date: TOMORROW, train: '12903', cls: '1A' });
    expect(s.availability['1A']).toMatchObject({ status: 'RAC 1', available: true, origin: 'JUC', destination: 'UMB', trainNumber: '12903' });
    expect(s.fare).toBeUndefined();
    expect(s.passengers[0]).toMatchObject({ name: 'Mohit', age: 31, gender: 'MALE' });            // passengers kept
    expect(s.passengersCount).toBe(3);
    expect(s.sameTrainSelection).toMatchObject({ ticketOrigin: 'JUC', ticketDestination: 'UMB', requestedOrigin: 'LDH', boardingRuleStatus: 'UNVERIFIED', freshStatus: 'RAC 1' });
    expect(memoryContextView(s).sameTrainSelection).toMatchObject({ ticketOrigin: 'JUC', boardingRuleStatus: 'UNVERIFIED', appliedBy: 'BACKEND_AFTER_FRESH_CHECK' });
    // the client sends handoffText to chat; Muse words the confirmation — the guard now has evidence for it
    // the client sends handoffText to chat; Muse words the confirmation — the guard now has session evidence for it
    const scripted = harnessOn(h, { [out.handoffText!]: [{ content: PICK }] });
    const r = await scripted.say(out.handoffText!);
    expect(shown(r)).toContain('RAC 1');
    expect(shown(r)).not.toContain(FALLBACK);
  }, 30000);

  it('[S2] fresh check WAITLIST → not selectable, nothing applied; REGRET → not applied', async () => {
    const h = harness({ [U]: searchFlow(3) });
    await h.say(U);
    const d = await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12903', travelClass: '1A', searchResultsVersion: h.s().searchResultsVersion });
    const juc = d.result!.alternatives.find((x: any) => x.ticketOrigin === 'JUC' && x.ticketDestination === 'UMB')!;
    setStatus(() => 'GNWL 2');
    const w = await selectViaEndpoint(h.state, h.sid, d.result!.alternativeSearchId, juc.alternativeId);
    expect(w.out).toMatchObject({ ok: false, code: 'ALTERNATIVE_NO_LONGER_AVAILABLE' });
    expect(w.applied.applied).toBe(false);
    expect(h.s().origin).toBe('LDH');
    expect(h.s().sameTrainSelection).toBeUndefined();
    setStatus(() => 'REGRET');
    const g = await selectViaEndpoint(h.state, h.sid, d.result!.alternativeSearchId, juc.alternativeId);
    expect(g.applied.applied).toBe(false);
    expect(h.s().selectedTrain).toBeUndefined();
  }, 30000);

  it('[S3] Muse-searched result (chat card) selects + applies the same way; a later date change drops the selection from context', async () => {
    let card: any;
    const h = harness({ [U]: searchFlow(3, [() => ({ calls: [ALT()] }), () => ({ content: '12903 1A waitlist hai; Jalandhar City se RAC 1 hai.' })]) });
    const r = await h.say(U);
    card = cards(r)[0];
    expect(card).toBeTruthy();
    const juc = card.alternatives.find((x: any) => x.ticketOrigin === 'JUC' && x.ticketDestination === 'UMB');
    const { applied } = await selectViaEndpoint(h.state, h.sid, card.alternativeSearchId, juc.alternativeId);
    expect(applied.applied).toBe(true);
    expect(h.s().origin).toBe('JUC');
    expect(memoryContextView(h.s()).sameTrainSelection).toBeTruthy();
    h.state.updateJourney(h.sid, { date: '2099-01-02' } as any);
    const m = memoryContextView(h.s());
    expect(m.sameTrainSelection).toBeUndefined();                                                     // stale → not given to Muse
    expect(m.staleRejected).toBeGreaterThan(0);
  }, 30000);
});

/** a second scripted LLM on the SAME session/state (to script the post-select reply) */
function harnessOn(h: { state: ConversationStateManager; sid: string }, script: Record<string, FakeReply[]>) {
  const fake = new FakeOpenAI((v: TurnView) => { const p = script[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const orch = new ConversationAgentOrchestrator(sel.provider, h.state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 120, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, h.state, { longWaitMs: 0 });
  return { say: (t: string) => eng.processTurn(h.sid, t, 'TEXT') as Promise<any> };
}
