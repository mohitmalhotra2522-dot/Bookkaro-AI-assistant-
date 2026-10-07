/**
 * P42.5 G2 + G3 + Part 39 — BFE (same train, board from an earlier station) safety-net and selection, end-to-end through
 * the Muse integration (fake OpenAI-compatible server playing Muse, deterministic MOCK connectors — no network, no credits).
 * Muse's choices are scripted; what is under test is the BACKEND: eligibility facts to Muse, a safety-net that only invokes
 * the existing tool on hard eligibility (no duplicate, budget respected, never on unknown / RAC / enough seats / old turns),
 * Muse presenting the result, and selection = fresh recheck → apply (pax kept, fare / review invalidated, boarding UNVERIFIED).
 * Trains / routes / statuses are TEST DATA served by the mock connectors (the app never hardcodes them).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
vi.hoisted(() => {
  process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1';
  process.env.SAME_TRAIN_CALL_TIMEOUT_MS = '500';
  process.env.SAME_TRAIN_TOTAL_TIMEOUT_MS = '4000';
  process.env.BFE_SAFETY_NET_LOG = '1';
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
import { applySameTrainSelection, findAnySameTrainResult, discoverSameTrainForDisplay } from '../../server/railway/same-train/same-train-session';
import { FakeOpenAI, type TurnView, type FakeReply } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P425-BFE-SECRET-4242';
const TOMORROW = (() => { const d = new Date(`${todayInIndia().date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
const ROUTE = [['ASR', 'Amritsar Jn'], ['BEAS', 'Beas'], ['JUC', 'Jalandhar City'], ['PGW', 'Phagwara Jn'], ['LDH', 'Ludhiana Jn'], ['SIR', 'Sirhind Jn'],
  ['RPJ', 'Rajpura Jn'], ['UMB', 'Ambala Cant Jn'], ['KKDE', 'Kurukshetra Jn'], ['PNP', 'Panipat Jn'], ['NDLS', 'New Delhi']]
  .map(([station, stationName]) => ({ station, stationName }));
type Classes = Record<string, Array<[string, string | null]>>;
const train = (num: string, classes: Array<[string, string | null]>) => ({ trainNumber: num, trainName: num === '12414' ? 'Pooja SF Express' : 'Express', origin: 'ASR', destination: 'NDLS',
  departure: '06:00', arrival: '12:00', duration: '6h 0m', classes: classes.map(([code, availability]) => ({ code, availability, availabilityStatus: 'UNKNOWN', fare: null, fareCurrency: null })) });
const SEARCH_ARGS = { origin: 'LDH', destination: 'UMB', date: TOMORROW };
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const ALT = (extra: any = {}) => ({ name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', args: { trainNumber: '12414', travelClass: '3A', date: TOMORROW, origin: 'LDH', destination: 'UMB', combinedPairs: 'NEVER', providers: 'railcore', ...extra } });

let rc: MockProviderConnector, rr: MockProviderConnector, dispose: () => void;
let searchData: Classes = {};
type Script = (v: TurnView) => FakeReply;
function harness(script: Record<string, Script | FakeReply[]>, state = new ConversationStateManager(), sid?: string) {
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
  const id = sid || state.createSession().sessionId;
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(id, t, mode) as Promise<any>;
  return { state, say, sid: id, s: () => state.getSession(id) as any };
}
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage].map(x => String(x ?? '')).join(' | ');
const cards = (r: any) => (r.cards || []).filter((c: any) => c.type === 'same_train_alternatives').map((c: any) => c.data);
const recs = (r: any) => (r.turnLog?.toolExecutions || []) as any[];
const bfeRecs = (r: any) => recs(r).filter(x => x.tool === 'SEARCH_SAME_TRAIN_ALTERNATIVES');
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
/** Part 39 test data: direct LDH→UMB RLWL1/WL1; an earlier station (JUC) RAC 1; everything else waitlisted */
const PART39 = (q: any) => (q.origin === 'JUC' && q.destination === 'UMB' ? 'RAC 1' : q.origin === 'LDH' && q.destination === 'UMB' ? 'RLWL1/WL1' : 'GNWL 9');
const altAvailCalls = () => [...rc.calls, ...rr.calls].filter(x => x[0] === 'availability' && !((x[1] as any).origin === 'LDH' && (x[1] as any).destination === 'UMB'));
const snMsg = (v: TurnView) => ((v.body?.messages || []) as any[]).find(m => m.role === 'system' && String(m.content).startsWith('BACKEND_SAFETY_NET'));
const snJson = (m: any) => JSON.parse(String(m.content).slice('BACKEND_SAFETY_NET '.length).split('\n')[0]);
let logs: any[] = [];

/** Muse: search → select 12414 → select 3A → check availability → (optionally its own BFE call) → answer. */
const museFlow = (o: { pax?: number; museBfe?: boolean; final?: string; afterSn?: string; seen?: (v: TurnView) => void; cls?: string }): Script => (v: TurnView) => {
  o.seen?.(v);
  if (snMsg(v)) return { content: o.afterSn || 'Same train mein Jalandhar City se RAC 1 mil raha hai — Ludhiana se boarding ka rule verify karna zaroori hai.' };
  const steps: FakeReply[] = [
    { calls: [{ name: 'railcore_search', args: { ...SEARCH_ARGS, passengersCount: o.pax ?? 3 } }] },
    { calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12414' } })] },
    { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: o.cls || '3A' })] },
    { calls: [{ name: 'railcore_availability', args: { trainNumber: '12414', travelClass: o.cls || '3A' } }] },
    ...(o.museBfe ? [{ calls: [ALT({ travelClass: o.cls || '3A' })] } as FakeReply] : []),
    { content: o.final || `12414 ${o.cls || '3A'} mein abhi RLWL1/WL1 hai.` }
  ];
  return steps[v.step] || { content: o.final || 'Theek hai.' };
};
const Q = 'Ludhiana se Ambala kal 12414 3A, 3 passengers';

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
  searchData = { '12414': [['3A', 'RLWL1/WL1'], ['2A', 'AVAILABLE-0010'], ['SL', 'RAC 4'], ['1A', 'UNKNOWN']], '12014': [['CC', 'WL 3']] };
  setStatus(PART39);
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

describe('P42.5 G2 — Muse first, backend safety-net only on hard eligibility', () => {
  it('[G2.1] Muse calls the BFE tool itself → no safety-net, exactly one same-train search; eligibility fact was given to Muse', async () => {
    let fact: any;
    const h = harness({ [Q]: museFlow({ museBfe: true, final: 'Jalandhar City se RAC 1 hai.', seen: v => { const r = v.results.find(x => x.name === 'railcore_availability'); if (r) fact = r.content?.bfeEligibility; } }) });
    const r = await h.say(Q);
    expect(fact).toMatchObject({ eligible: true, reason: 'WAITLIST', trainNumber: '12414', classCode: '3A', passengers: 3, confirmedSeats: 0, status: 'RLWL1/WL1' });
    expect(fact.binding).toBeUndefined();                                       // internal binding ids stay backend-side
    expect(bfeRecs(r)).toHaveLength(1);
    expect(logs.find(l => l.museRequestedBfe)).toMatchObject({ safetyNetTriggered: false, bfeEligible: true });
    expect(shown(r)).toContain('RAC 1');
  }, 30000);

  it('[G2.2] Muse answers without BFE on an eligible fact → the existing tool runs once (SAFETY_NET), Muse gets ONE more call and presents it', async () => {
    let sn: any; let calls = 0;
    const h = harness({ [Q]: museFlow({ seen: v => { calls++; const m = snMsg(v); if (m) sn = snJson(m); } }) });
    const r = await h.say(Q);
    const b = bfeRecs(r);
    expect(b).toHaveLength(1);
    expect(b[0].status).toBe('SUCCEEDED');
    expect(sn).toMatchObject({ origin: 'BACKEND_SAFETY_NET', outcome: 'EXECUTED' });
    expect(sn.results[0]).toMatchObject({ ok: true, eligibility: { trainNumber: '12414', classCode: '3A', reason: 'WAITLIST', passengers: 3 } });
    expect(shown(r)).toContain('Jalandhar City se RAC 1');                     // Muse's wording, not a backend template
    expect(cards(r)[0]).toMatchObject({ trainNumber: '12414', travelClass: '3A', triggerSource: 'SAFETY_NET' });
    expect(r.turnLog?.diagnostics?.chain?.steps?.find((s: any) => s.toolName === 'SEARCH_SAME_TRAIN_ALTERNATIVES')?.decisionReason).toBe('BACKEND_SAFETY_NET');
    const l = logs.find(x => x.safetyNetTriggered);
    expect(l).toMatchObject({ event: 'bfe_safety_net', trainNumber: '12414', classCode: '3A', passengerCount: 3, bfeEligible: true, eligibilityReason: 'WAITLIST', museRequestedBfe: false });
    expect(l.verifiedResultsCount).toBeGreaterThan(0);
    expect(l.toolExecutionId).toMatch(/^tx_/);
    expect(JSON.stringify(logs)).not.toMatch(/sk-live|Mohit|otp|password/i);   // metadata only
    // the backend chose / applied nothing: session still the user's own journey + selection + party
    expect({ o: h.s().origin, d: h.s().destination, t: h.s().selectedTrain?.number, c: h.s().selectedClass, p: h.s().passengersCount }).toEqual({ o: 'LDH', d: 'UMB', t: '12414', c: '3A', p: 3 });
    expect(h.s().sameTrainSelection).toBeUndefined();
  }, 30000);

  it('[G2.3] enough seats → not eligible → no safety-net, no same-train provider traffic', async () => {
    setStatus(q => (q.origin === 'LDH' ? 'AVAILABLE-0010' : 'GNWL 9'));
    const h = harness({ [Q]: museFlow({ final: '12414 3A mein 10 seats hain.' }) });
    const r = await h.say(Q);
    expect(bfeRecs(r)).toHaveLength(0);
    expect(altAvailCalls()).toHaveLength(0);
    expect(logs).toHaveLength(0);
  }, 30000);

  it('[G2.4] UNKNOWN / provider error → never a shortage → no safety-net', async () => {
    for (const st of [() => 'UNKNOWN', () => ({ error: 'PROVIDER_TIMEOUT' })] as Array<(q: any) => any>) {
      rc.reset(); rr.reset(); logs = [];
      setStatus(q => (q.origin === 'LDH' && q.destination === 'UMB' ? st(q) : 'RAC 1'));
      const h = harness({ [Q]: museFlow({ final: 'Availability abhi confirm nahi ho paayi.' }) });
      const r = await h.say(Q);
      expect(bfeRecs(r)).toHaveLength(0);
      expect(altAvailCalls()).toHaveLength(0);
    }
  }, 30000);

  it('[G2.5] RAC on the requested pair → usable, not a shortage → no safety-net', async () => {
    setStatus(q => (q.origin === 'LDH' && q.destination === 'UMB' ? 'RAC 3' : 'AVAILABLE-0009'));
    const h = harness({ [Q]: museFlow({ final: '12414 3A mein RAC 3 hai.' }) });
    const r = await h.say(Q);
    expect(bfeRecs(r)).toHaveLength(0);
    expect(altAvailCalls()).toHaveLength(0);
  }, 30000);

  it('[G2.6] budget exhausted → no provider call; Muse is told BFE_SKIPPED_TOOL_BUDGET (no fake result, no card)', async () => {
    process.env.SAME_TRAIN_MAX_SEARCHES_PER_TURN = '1';
    let sn: any;
    // Muse spends the only same-train search of this turn on another class (CC on 12014), then answers about 12414 3A
    const steps: FakeReply[] = [
      { calls: [{ name: 'railcore_search', args: { ...SEARCH_ARGS, passengersCount: 3 } }] },
      { calls: [{ name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', args: { trainNumber: '12014', travelClass: 'CC', date: TOMORROW, origin: 'LDH', destination: 'UMB', combinedPairs: 'NEVER', providers: 'railcore' } }] },
      { calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12414' } })] },
      { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: '3A' })] },
      { calls: [{ name: 'railcore_availability', args: { trainNumber: '12414', travelClass: '3A' } }] },
      { content: '12414 3A mein RLWL1/WL1 hai.' }
    ];
    const h = harness({ [Q]: (v: TurnView) => { const m = snMsg(v); if (m) { sn = snJson(m); return { content: '12414 3A RLWL1/WL1 hai; same train ke aur options is baar check nahi ho paaye.' }; } return steps[v.step] || { content: 'Theek hai.' }; } });
    const before = () => altAvailCalls().filter(x => (x[1] as any).trainNumber === '12414').length;
    const r = await h.say(Q);
    expect(sn).toMatchObject({ origin: 'BACKEND_SAFETY_NET', outcome: 'BFE_SKIPPED_TOOL_BUDGET', results: [] });
    expect(sn.skipped[0]).toMatchObject({ trainNumber: '12414', classCode: '3A', status: 'BFE_SKIPPED_TOOL_BUDGET', availabilityStatus: 'RLWL1/WL1' });
    expect(before()).toBe(0);
    expect(cards(r).filter((c: any) => c.trainNumber === '12414')).toHaveLength(0);
    expect(logs.find(l => l.trainNumber === '12414')).toMatchObject({ skippedReason: 'BFE_SKIPPED_TOOL_BUDGET', safetyNetTriggered: false });
  }, 30000);

  it('[G2.7] no duplicate in one turn; an old turn\'s fact never triggers; an explicit fresh request next turn calls the provider again', async () => {
    const AGAIN = 'same train mein pehle station se dobara check karo';
    const h = harness({ [Q]: museFlow({}), 'theek hai': [{ content: 'Theek hai.' }], [AGAIN]: [{ calls: [ALT()] }, { content: 'Dobara check kiya: Jalandhar City se RAC 1.' }] });
    const r1 = await h.say(Q);
    expect(bfeRecs(r1)).toHaveLength(1);                                         // once, even though Muse answered twice
    const n1 = altAvailCalls().length;
    const r2 = await h.say('theek hai');
    expect(bfeRecs(r2)).toHaveLength(0);                                         // previous turn's eligibility is not reused
    expect(altAvailCalls().length).toBe(n1);
    const r3 = await h.say(AGAIN);
    expect(bfeRecs(r3)).toHaveLength(1);
    expect(bfeRecs(r3)[0].status).toBe('SUCCEEDED');
    expect(altAvailCalls().length).toBeGreaterThan(n1);                          // fresh provider calls, no cache
  }, 30000);

  it('[G2.8] a shortage on a list row that is NOT the current selection never triggers (no WL → BFE routing over every row); flag gate in tool list', async () => {
    const steps: FakeReply[] = [{ calls: [{ name: 'railcore_search', args: { ...SEARCH_ARGS, passengersCount: 3 } }] }, { content: 'Do trains mili: 12414 aur 12014.' }];
    const h = harness({ [Q]: steps });
    const r = await h.say(Q);
    expect(bfeRecs(r)).toHaveLength(0);
    expect(altAvailCalls()).toHaveLength(0);
    expect(logs).toHaveLength(0);
  }, 30000);
});

describe('P42.5 Part 39 + G3 — selection of a safety-net result', () => {
  async function part39() {
    const h = harness({ [Q]: museFlow({}) });
    const r = await h.say(Q);
    const card = cards(r)[0];
    const juc = card.alternatives.find((x: any) => x.ticketOrigin === 'JUC' && x.ticketDestination === 'UMB');
    return { h, r, card, juc };
  }

  it('[P39] 12414 3A, 3 passengers, direct RLWL1/WL1 → earlier station JUC RAC 1 shown (RAC tag, verified, selectable)', async () => {
    const { r, card, juc } = await part39();
    expect(card.requestedPairAssessment ?? card.alternatives.find((a: any) => a.isRequestedPair)).toBeTruthy();
    expect(juc).toMatchObject({ trainNumber: '12414', travelClass: '3A', availability: 'RAC', availabilityStatusText: 'RAC 1', boardingRuleStatus: 'UNVERIFIED' });
    expect(['VERIFIED', 'PARTIALLY_VERIFIED']).toContain(juc.verificationStatus);
    expect(shown(r)).toContain('RAC 1');
    expect(shown(r)).not.toMatch(/confirm(ed)? seat/i);
  }, 30000);

  it('[G3.1–4] select → fresh recheck → apply: origin = bookFrom, destination = bookUpto, train / class, fresh RAC; pax kept; fare cleared; boardAt separate + UNVERIFIED', async () => {
    const { h, card, juc } = await part39();
    h.state.resizePassengers(h.sid, 3);
    h.s().passengers[0].name = 'Asha'; h.s().passengers[0].age = 40; h.s().passengers[0].gender = 'FEMALE';
    h.s().fare = { perPassenger: 999, total: 2997 } as any;
    const { out, applied } = await selectVia(h.state, h.sid, card.alternativeSearchId, juc.alternativeId);
    expect(out.ok).toBe(true);
    expect(applied.applied).toBe(true);
    const s = h.s();
    expect({ o: s.origin, d: s.destination, t: s.selectedTrain?.number, c: s.selectedClass, date: s.date }).toEqual({ o: 'JUC', d: 'UMB', t: '12414', c: '3A', date: TOMORROW });
    expect(s.availability['3A']).toMatchObject({ status: 'RAC 1', available: true, origin: 'JUC', destination: 'UMB' });   // [G3.12] RAC tag kept, counts as available
    expect(s.passengersCount).toBe(3);
    expect(s.passengers[0]).toMatchObject({ name: 'Asha', age: 40, gender: 'FEMALE' });
    expect(s.fare).toBeUndefined();
    expect(s.sameTrainSelection).toMatchObject({ ticketOrigin: 'JUC', ticketDestination: 'UMB', requestedOrigin: 'LDH', boardingRuleStatus: 'UNVERIFIED', freshStatus: 'RAC 1' });
  }, 30000);

  it('[G3.5] review is invalidated by the apply (a confirmable review never survives a ticket-pair change)', async () => {
    const { h, card, juc } = await part39();
    h.s().review = { valid: true, reviewVersion: 3 } as any;
    h.s().confirmedReviewVersion = 3;
    const { applied } = await selectVia(h.state, h.sid, card.alternativeSearchId, juc.alternativeId);
    expect(applied.applied).toBe(true);
    const s = h.s();
    expect(!s.review || s.review.valid === false || s.review.reviewVersion !== 3 || s.confirmedReviewVersion !== 3).toBe(true);
    expect(s.bookingState).not.toBe('AWAITING_CONFIRMATION');
  }, 30000);

  it('[G3.6–7] fresh recheck WAITLIST / REGRET → not applied, session unchanged', async () => {
    const { h, card, juc } = await part39();
    for (const st of ['GNWL 2', 'REGRET']) {
      setStatus(() => st);
      const { out, applied } = await selectVia(h.state, h.sid, card.alternativeSearchId, juc.alternativeId);
      expect(out.ok, st).toBe(false);
      expect(applied.applied).toBe(false);
      expect({ o: h.s().origin, c: h.s().selectedClass }).toEqual({ o: 'LDH', c: '3A' });
      expect(h.s().sameTrainSelection).toBeUndefined();
    }
  }, 30000);

  it('[G3.8] failed recheck (provider error) → nothing changes', async () => {
    const { h, card, juc } = await part39();
    setStatus(() => ({ error: 'PROVIDER_TIMEOUT' }));
    const { out, applied } = await selectVia(h.state, h.sid, card.alternativeSearchId, juc.alternativeId);
    expect(out.ok).toBe(false);
    expect(applied.applied).toBe(false);
    expect(h.s().origin).toBe('LDH');
  }, 30000);

  it('[G3.9] stale result (date changed after the search) → rejected, nothing applied', async () => {
    const { h, card, juc } = await part39();
    h.state.updateJourney(h.sid, { date: '2099-01-02' } as any);
    const { out, applied } = await selectVia(h.state, h.sid, card.alternativeSearchId, juc.alternativeId);
    expect(out.ok).toBe(false);
    expect(applied.applied).toBe(false);
    expect(h.s().sameTrainSelection).toBeUndefined();
  }, 30000);

  it('[G3.10] class / train mismatch → rejected (another class selected after the result; unknown option id)', async () => {
    const { h, card, juc } = await part39();
    const bad = await selectVia(h.state, h.sid, card.alternativeSearchId, 'ALT_DOES_NOT_EXIST');
    expect(bad.out.ok).toBe(false);
    h.s().selectedClass = '2A';
    const mism = await selectVia(h.state, h.sid, card.alternativeSearchId, juc.alternativeId);
    expect(mism.out.ok).toBe(false);
    expect(mism.applied.applied).toBe(false);
    expect(h.s().origin).toBe('LDH');
  }, 30000);

  it('[G3.11] Muse cannot mutate booking state with the result (ranking only); the safety-net applied nothing', async () => {
    const { h, card, juc } = await part39();
    const P = 'pehla wala dikhao';
    const h2 = harness({ [P]: [{ calls: [{ name: 'PRESENT_SAME_TRAIN_ALTERNATIVES', args: { alternativeSearchId: card.alternativeSearchId, bestMatch: juc.alternativeId, order: [juc.alternativeId] } }] }, { content: 'Jalandhar City wala option upar dikha diya.' }] }, h.state, h.sid);
    await h2.say(P);
    expect({ o: h.s().origin, d: h.s().destination, c: h.s().selectedClass }).toEqual({ o: 'LDH', d: 'UMB', c: '3A' });
    expect(h.s().sameTrainSelection).toBeUndefined();
  }, 30000);

  it('[G3.12] the auto inline display reuses the safety-net result for the same list (no second provider fan-out)', async () => {
    const { h, card } = await part39();
    const n = altAvailCalls().length;
    const d = await discoverSameTrainForDisplay(h.state, h.sid, { trainNumber: '12414', travelClass: '3A', searchResultsVersion: h.s().searchResultsVersion });
    expect(d.ok).toBe(true);
    expect(d.result!.alternativeSearchId).toBe(card.alternativeSearchId);
    expect(altAvailCalls().length).toBe(n);
  }, 30000);
});
