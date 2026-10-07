/**
 * PROMPT 28 — G2: tool-result identity binding + claim ↔ entity binding (focused unit tests, offline).
 * MockLLM / an injected fake OpenAI-compatible server decide every step; the backend only validates, executes approved
 * tools, binds results to their entity and binds every railway claim to the entity it is about.
 * No network, no credits, no booking, no handoff. No exact-text equality on LLM wording.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { naturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import type { MockChainScenarioId } from '../../server/ai/providers/mock-llm-chains';
import { TrainReferenceResolver } from '../../server/ai/context/train-reference-resolver';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { buildToolResultIdentity, structuredToolError, entityOf, RESULT_REF_RE } from '../../server/ai/tool-runtime/tool-result-identity';
import { shouldRetry, DEFAULT_TOOL_RETRY_POLICY } from '../../server/ai/tool-runtime/tool-retry-policy';
import { ClaimEntityBinder, bindAndVerifyClaims } from '../../server/ai/response/claim-entity-binding';
import { buildFactIndex } from '../../server/ai/response/claim-facts';
import { collectAvailabilityEvidence } from '../../server/ai/response/availability-authority';
import { factGuard } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;
/** "6 Oct" style for an ISO date (never a hard-coded calendar date) */
const dm = (iso: string) => `${Number(iso.slice(8, 10))} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(iso.slice(5, 7)) - 1]}`;
const TRAINS = [
  { trainNumber: '12014', trainName: 'Amritsar Shatabdi Express', origin: 'ASR', destination: 'NDLS', departure: '04:55', arrival: '10:50', duration: '5h 55m', displayIndex: 1, classes: [{ code: 'CC' }, { code: '2S' }] },
  { trainNumber: '12497', trainName: 'Shan-e-Punjab Express', origin: 'ASR', destination: 'NDLS', departure: '06:35', arrival: '13:50', duration: '7h 15m', displayIndex: 2, classes: [{ code: '3A' }, { code: 'CC' }, { code: 'SL' }, { code: '2S' }] },
  { trainNumber: '18238', trainName: 'Chhattisgarh Express', origin: 'ASR', destination: 'NDLS', departure: '19:35', arrival: '04:10', duration: '8h 35m', displayIndex: 3, classes: [{ code: '3A' }, { code: 'SL' }] }
];
function session(extra: Record<string, any> = {}) {
  const st = new ConversationStateManager();
  const s: any = st.getSession(st.createSession().sessionId);
  Object.assign(s, { origin: 'ASR', destination: 'NDLS', originName: 'Amritsar', destinationName: 'New Delhi', date: KAL, bookingState: 'CLASS_SELECTED',
    searchResults: { trains: TRAINS.map(t => ({ ...t, classes: t.classes.map(c => ({ ...c })) })) },
    selectedTrain: { number: '12497', name: 'Shan-e-Punjab Express', classes: [{ code: '3A' }, { code: 'CC' }, { code: 'SL' }, { code: '2S' }] }, selectedClass: '3A',
    pendingInteraction: { type: 'NONE' } }, extra);
  return s;
}
let seq = 0;
const step = (toolName: string, data: any, identity?: any) => ({ toolCall: { name: toolName, callId: `c${++seq}` }, result: { toolName, success: true, data, identity, toolExecutionId: `te_${seq}` }, status: 'ok', execution: { status: 'SUCCEEDED', toolExecutionId: `te_${seq}` } });
const AV = (d: any = {}) => step('CHECK_AVAILABILITY', { trainNumber: '12497', travelClass: '3A', date: KAL, status: 'Available', available: true, ...d });
const FARE = (d: any = {}, id?: any) => step('GET_FARE', { trainNumber: '12497', travelClass: '3A', passengersCount: 1, perPassenger: 650, total: 650, ...d }, id ?? { trainNumber: d.trainNumber ?? '12497', travelClass: d.travelClass ?? '3A', date: KAL });
const llmStub = () => ({ providerId: 'native', agentAuthoredReplies: true, generateStructuredDecision: async () => ({}) as any, generateSpokenResponse: vi.fn(async () => ({ text: 'WORDING' })) } as any);
function compose(s: any, agentText: string, steps: any[] = [AV(), FARE()], o: { userText?: string; general?: boolean; mode?: 'TEXT' | 'VOICE' } = {}): Promise<any> {
  return naturalResponseComposer.compose({
    llm: llmStub(), session: s, userText: o.userText ?? 'batao', backendReply: 'OK', deterministicSpeech: 'DETERMINISTIC',
    stateBefore: s.bookingState, reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null,
    steps, appliedActions: [], changes: [], error: null, pendingQuestionCode: null, pendingQuestion: null, history: [], mode: o.mode ?? 'TEXT', agentText, general: !!o.general
  } as any);
}
const reasons = (r: any) => r.rejected.map((x: any) => x.reason);

// ---- full-stack helpers (MockLLM + injected fake OpenAI server; mock railway spy) ----
const pmeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p28u-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; calls: Array<[string, string, string, string]> = []; wrongTrain = false;
  private b(k: string, r: any) { this.n[k] = (this.n[k] || 0) + 1; this.calls.push([k, String(r?.trainNumber ?? ''), String(r?.travelClass ?? ''), String(r?.date ?? '')]); }
  async searchTrains(r: any): Promise<any> { this.b('search', r); return super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> {
    this.b('avail', r);
    const res: any = await super.checkAvailability(r);
    // a misbehaving provider answering for ANOTHER train (identity mismatch)
    return this.wrongTrain && res?.ok ? { ...res, data: { ...res.data, trainNumber: '12014' }, meta: pmeta() } : res;
  }
  async getFare(r: any): Promise<any> { this.b('fare', r); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p28u-spy', () => rail);
class SpyLLM extends MockLLMProvider { inputs: any[] = []; async generateStructuredDecision(input: any): Promise<any> { this.inputs.push(input); return super.generateStructuredDecision(input); } }
function wire(llm: any) {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { state, sid, say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>, s: () => state.getSession(sid) as any };
}
const mockStack = (forced?: MockChainScenarioId) => { const llm = new SpyLLM({ chainScenario: forced }); return { llm, ...wire(llm) }; };
function nativeStack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P28-UNIT', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  return { views, fake, ...wire(sel.provider) };
}
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = (date: string) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const SEL = (num: string, cls?: string) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: num }, ...(cls ? { classRaw: cls } : {}), selectionPurpose: 'INFORMATION' });
const binding = (r: any) => r.turnLog.diagnostics.binding;
const chain = (r: any) => r.turnLog.diagnostics.chain;
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'avail', 'fare'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p28u-spy');
  Object.assign(rail, { n: {}, calls: [], wrongTrain: false });
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(((url: any, init: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    throw new Error('network forbidden in tests');
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  fetchSpy.mockRestore(); handoffSpy.mockRestore();
  railwayRegistry.setActive('mock');
});

describe('P28 G2 — tool-result identity', () => {
  it('[1] identity binding: built from validated args + provider fields only; provider disagreement → MISMATCH; no entity for PNR', () => {
    const av = buildToolResultIdentity({ toolName: 'CHECK_AVAILABILITY', resultId: 'te_1', args: { trainNumber: '12497', travelClass: '3A', date: KAL }, data: { trainNumber: '12497', travelClass: '3A', date: KAL, status: 'Available' }, provider: 'mock', status: 'SUCCEEDED' });
    expect(av).toMatchObject({ resultId: 'te_1', toolName: 'CHECK_AVAILABILITY', trainNumber: '12497', travelClass: '3A', date: KAL, dateSource: 'RESULT', provider: 'mock', status: 'SUCCEEDED', binding: 'BOUND' });
    expect(typeof av.receivedAt).toBe('string');
    expect(entityOf(av)).toEqual({ trainNumber: '12497', date: KAL, class: '3A' });
    const sr = buildToolResultIdentity({ toolName: 'SEARCH_TRAINS', resultId: 'te_2', args: { origin: 'ASR', destination: 'NDLS', date: KAL }, data: { journey: { origin: 'ASR', destination: 'NDLS', date: KAL }, trains: [{}, {}, {}] } });
    expect(sr).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: KAL, resultCount: 3, binding: 'BOUND' });
    expect(sr.trainNumber).toBeUndefined();                                                     // never fabricated
    const bad = buildToolResultIdentity({ toolName: 'CHECK_AVAILABILITY', resultId: 'te_3', args: { trainNumber: '12497', travelClass: '3A', date: KAL }, data: { trainNumber: '12014', travelClass: '3A', date: KAL } });
    expect(bad).toMatchObject({ binding: 'MISMATCH', mismatch: ['trainNumber'], trainNumber: '12014' });
    const pnr = buildToolResultIdentity({ toolName: 'CHECK_PNR', resultId: 'te_4', args: { pnr: '1234567890' }, data: { pnr: '1234567890', status: 'CNF' } });
    expect(pnr.binding).toBe('NO_ENTITY');
    expect(JSON.stringify(pnr)).not.toContain('1234567890');
  });
});

describe('P28 G2 — claim ↔ entity binding (cross-train / class / date)', () => {
  it('[2] cross-train: "Is train ki 3A … ₹650" right after naming 12014 is removed (the facts are 12497\'s); the 12014 sentence stays', async () => {
    const r = await compose(session(), 'Sabse pehle 12014 Shatabdi pahunchti hai, lekin usmein sirf CC aur 2S hai. Is train ki 3A seats available hain, fare ₹650 hai.');
    expect(reasons(r)).toEqual(['CROSS_TRAIN_FACT:12014']);
    expect(r.text).toMatch(/12014/); expect(r.text).not.toMatch(/₹650|available hain/);
    expect(r.claimBinding).toMatchObject({ status: 'CROSS_ENTITY_REMOVED', counts: { EXPLICIT: 1, REFERENCE_RESOLVED: 1 } });
    expect(r.claimBinding.crossEntity[0]).toMatchObject({ diagnosis: 'CROSS_TRAIN_FACT', binding: 'REFERENCE_RESOLVED', trainNumber: '12014' });
  });

  it('[3] cross-class: a 12497/3A result never proves 12497 CC (diagnosis CROSS_CLASS_FACT); a 3A fare is not a CC fare', async () => {
    const r = await compose(session(), '12497 mein CC available hai.');
    expect(r.source).toBe('FALLBACK');
    expect(reasons(r)).toEqual(['UNVERIFIED_AVAILABILITY']);
    expect(r.claimBinding.crossEntity).toEqual([expect.objectContaining({ diagnosis: 'CROSS_CLASS_FACT', trainNumber: '12497' })]);
    const f = await compose(session(), '12497 ka CC fare ₹650 hai.');
    expect(reasons(f)).toEqual(['FARE_MISMATCH:650']);
    expect(f.claimBinding.crossEntity[0].diagnosis).toBe('CROSS_CLASS_FACT');
  });

  it('[4] cross-date: a kal result never proves parso / "6 Oct"; a fare for kal is not a fare for another date', async () => {
    for (const t of ['Parso 12497 mein 3A available hai.', `12497 mein ${dm(PARSO)} ko 3A available hai.`]) {
      const r = await compose(session(), t);
      expect(r.source, t).toBe('FALLBACK');
      expect(r.text, t).not.toMatch(/available/);
    }
    const f = await compose(session(), `12497 ka 3A fare ${dm(PARSO)} ke liye ₹650 hai.`);
    expect(reasons(f)[0]).toMatch(/^CROSS_DATE_FACT:/);
    const ok = await compose(session(), `12497 ka 3A fare ${dm(KAL)} ke liye ₹650 hai.`);
    expect(reasons(ok)).toEqual([]);
  });
});

describe('P28 G2 — references', () => {
  it('[5] display index resolves against the CURRENT displayed set (2 → 12497); out of range → structured rejection, never invented', () => {
    const s = session({ selectedTrain: undefined, selectedClass: undefined, bookingState: 'SHOWING_TRAINS' });
    const R = new TrainReferenceResolver();
    const two: any = R.resolve({ kind: 'DISPLAY_INDEX', value: 2 } as any, s);
    expect(two.ok).toBe(true); expect(two.train.trainNumber).toBe('12497');
    const four: any = R.resolve({ kind: 'DISPLAY_INDEX', value: 4 } as any, s);
    expect(four).toMatchObject({ ok: false, code: 'INVALID_TRAIN_REFERENCE' });
    const bogus: any = R.resolve({ kind: 'TRAIN_NUMBER', value: '22439' } as any, s);
    expect(bogus).toMatchObject({ ok: false, code: 'INVALID_TRAIN_REFERENCE' });          // never a silent substitute
  });

  it('[6] unnamed reference: a claim with no train binds to the reply antecedent / session focus and verifies there', async () => {
    const a = await compose(session(), '12497 mein 3A seats available hain. Iska 3A fare ₹650 per passenger hai.');
    expect(reasons(a)).toEqual([]);
    expect(a.claimBinding.counts).toMatchObject({ EXPLICIT: 1, REFERENCE_RESOLVED: 1 });
    const b = await compose(session(), '3A mein seats available hain, fare ₹650.');
    expect(reasons(b)).toEqual([]);
    expect(b.claimBinding.counts).toMatchObject({ SESSION_FOCUS: 1 });
    expect(b.claimProvenance!.find((p: any) => p.claimBindingStatus === 'SESSION_FOCUS')).toMatchObject({ trainNumber: '12497', entityType: 'TRAIN', verificationStatus: 'VERIFIED' });
  });

  it('[7] ambiguous reference: "iski" after two trains, or an unnamed claim whose antecedent ≠ the selected train → removed, never guessed', async () => {
    const r = await compose(session(), '12014 aur 12497 dono subah chalti hain. Iski 3A seats available hain.');
    expect(reasons(r)).toEqual(['AMBIGUOUS_REFERENCE']);
    expect(r.claimBinding.status).toBe('AMBIGUOUS_REMOVED');
    const b = new ClaimEntityBinder({ idx: buildFactIndex(session(), []), session: session() });
    expect(b.bind('12014 sabse pehle pahunchti hai.').status).toBe('EXPLICIT');
    expect(b.bind('3A seats available hain.').status).toBe('AMBIGUOUS');               // antecedent 12014 vs selected 12497
    const none = new ClaimEntityBinder({ idx: buildFactIndex(session({ selectedTrain: undefined }), []), session: session({ selectedTrain: undefined }) });
    expect(none.bind('Is train mein seats available hain.').status).toBe('AMBIGUOUS');
  });

  it('[8] class binding: a class the selected train does not list is rejected BEFORE the provider (structured, no substitute)', () => {
    const v = new ToolCallValidator();
    const s = session({ selectedTrain: { number: '12014', classes: [{ code: 'CC' }, { code: '2S' }] }, selectedClass: 'CC' });
    const bad: any = v.validate({ name: 'CHECK_AVAILABILITY', callId: 'x', arguments: { trainNumber: '12014', travelClass: '3A' } } as any, s);
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_CLASS_SELECTION' } });
    const other: any = v.validate({ name: 'GET_FARE', callId: 'y', arguments: { trainNumber: '12497', travelClass: 'CC' } } as any, s);
    expect(other).toMatchObject({ ok: false, error: { code: 'INVALID_TRAIN_REFERENCE' } });
    const ok: any = v.validate({ name: 'CHECK_AVAILABILITY', callId: 'z', arguments: { trainNumber: '12014', travelClass: 'CC' } } as any, s);
    expect(ok.ok).toBe(true); expect(ok.v.arguments).toMatchObject({ trainNumber: '12014', travelClass: 'CC', date: KAL });
  });
});

describe('P28 G2 — dedup, new information, retries, step limit', () => {
  it('[9] same-turn duplicate (same tool + args + entity + date, no new info) → existing result reused, provider hit once', async () => {
    const h = mockStack('REPEATED_IDENTICAL_CALL');
    const r = await h.say('Kal Amritsar se Delhi 12497 ki 3A availability batao');
    expect(delta({}).avail).toBe(1);
    expect(binding(r)).toMatchObject({ duplicateCallPrevented: true, entityBindingStatus: 'BOUND' });
    expect(chain(r).steps.at(-1)).toMatchObject({ decisionReason: 'DEDUPLICATED' });
  });

  it('[10] new information resets the guard: same raw call after "class → CC" in the same turn executes again (fresh, for CC)', async () => {
    const AVR = { name: 'CHECK_AVAILABILITY', args: { trainNumber: '12497' } };
    const h = nativeStack({
      'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain.' }],
      '12497 3A, phir CC bhi dekho': [{ calls: [SEL('12497', '3A')] }, { calls: [AVR] }, { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: 'CC' })] }, { calls: [AVR] }, { content: '12497 ki availability dekh li.' }]
    });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say('12497 3A, phir CC bhi dekho');
    expect(delta(n0).avail).toBe(2);
    expect(rail.calls.filter(c => c[0] === 'avail').map(c => c[2])).toEqual(['3A', 'CC']);
    expect(binding(r).duplicateCallPrevented).toBe(false);
  });

  it('[11] failure retry decision: structured { errorType, tool, argument, reason, retryable }; no blind retries', () => {
    expect(structuredToolError('CHECK_AVAILABILITY', { code: 'PROVIDER_UNAVAILABLE', message: 'down' }, 1)).toMatchObject({ errorType: 'PROVIDER', tool: 'CHECK_AVAILABILITY', reason: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(structuredToolError('CHECK_AVAILABILITY', { code: 'PROVIDER_UNAVAILABLE' }, 2).retryable).toBe(false);   // backend already retried
    expect(structuredToolError('GET_FARE', { code: 'INVALID_CLASS_SELECTION', message: 'x' }, 1)).toMatchObject({ errorType: 'VALIDATION', argument: 'travelClass', retryable: false });
    expect(structuredToolError('GET_FARE', { code: 'INVALID_ACTION_FOR_STATE' }, 1)).toMatchObject({ errorType: 'STATE', retryable: false });
    expect(structuredToolError('SEARCH_TRAINS', { code: 'AMBIGUOUS_DATE' }, 1)).toMatchObject({ argument: 'date', retryable: false });
    expect(shouldRetry(DEFAULT_TOOL_RETRY_POLICY, 'INVALID_CLASS_SELECTION', 0)).toBe(false);
    expect(shouldRetry(DEFAULT_TOOL_RETRY_POLICY, 'PROVIDER_UNAVAILABLE', 1)).toBe(false);
  });

  it('[12] step limit: execution stops at 8, results preserved, one tools-disabled answer; stepLimitReached logged with reason', async () => {
    const h = mockStack('MAX_TOOL_STEPS'); await h.say('Kal Amritsar se Delhi trains batao');
    const r = await h.say('Sab trains ki poori details batao');
    expect(chain(r)).toMatchObject({ chainStopReason: 'TOOL_BUDGET_EXHAUSTED', stepLimitReached: true, answeredAfterStop: true, providerCallCount: 8 });
    expect(binding(r).stepLimitReached).toBe(true);
    expect(binding(r).stepLimitReason).toMatch(/TOOL_CALL_LIMIT_EXCEEDED|TOOL_BUDGET_EXHAUSTED/);
    expect(binding(r).secondCallReason).toBeTruthy();
    expect(r.voice.assistantText).toMatch(/12014/);
  });
});

describe('P28 G2 — knowledge vs live facts, mixed answers', () => {
  it('[13] GK needs no tools: RAC / Tatkal / CC vs 3A → zero tool calls, no claim binding needed', async () => {
    for (const q of ['RAC kya hota hai?', 'Tatkal kya hota hai?']) {
      const h = mockStack(); const r = await h.say(q);
      expect(binding(r).toolCallCount, q).toBe(0);
      expect(binding(r).claimBindingStatus, q).toBe('NONE');
      expect(rail.n.search || 0, q).toBe(0);
    }
  });

  it('[14] mixed answer: GK sentences are not verified as railway facts; the live sentence needs its own matching evidence', async () => {
    const ok = await compose(session(), 'RAC mein do passengers ek berth share karte hain. 12497 mein 3A seats available hain.');
    expect(reasons(ok)).toEqual([]);
    const bad = await compose(session(), 'RAC mein do passengers ek berth share karte hain. 12014 mein 3A seats available hain.');
    expect(bad.text).toMatch(/berth share/); expect(bad.text).not.toMatch(/12014/);
    expect(reasons(bad)).toHaveLength(1);
  });
});

describe('P28 G2 — fare / availability / timetable identity', () => {
  it('[15] fare identity: a fare\'s train / class / date come from the result identity or fare basis; another train\'s amount fails', async () => {
    const noTrain = FARE({ trainNumber: undefined, travelClass: undefined }, { trainNumber: '12497', travelClass: '3A', date: KAL, provider: 'mock' });
    const idx = buildFactIndex(session(), [{ toolName: 'GET_FARE', ok: true, data: noTrain.result.data, identity: noTrain.result.identity }]);
    expect(idx.fares[0]).toMatchObject({ train: '12497', cls: '3A', date: KAL, provider: 'mock', perPassenger: 650 });
    const sess = session({ fare: { perPassenger: 650, total: 650, currency: 'INR', dataSource: 'MOCK', breakdown: {}, fareBasis: { trainNumber: '12497', travelClass: '3A', passengersCount: 1, date: KAL } } });
    expect(buildFactIndex(sess, []).fares[0]).toMatchObject({ train: '12497', cls: '3A', date: KAL });
    // both fares present (12497 3A ₹650, 12014 CC ₹850): "12014 ka fare ₹650" is a cross-train claim
    const r = await compose(session(), '12014 ka fare ₹650 hai.', [FARE(), FARE({ trainNumber: '12014', travelClass: 'CC', perPassenger: 850, total: 850 })]);
    expect(reasons(r)).toEqual(['FARE_MISMATCH:650']);
    expect(r.claimBinding.crossEntity[0]).toMatchObject({ diagnosis: 'CROSS_TRAIN_FACT', trainNumber: '12014' });
    const g = bindAndVerifyClaims('12014 ka fare ₹850 hai. 12497 ka 3A fare ₹650 hai.', session(), [FARE(), FARE({ trainNumber: '12014', travelClass: 'CC', perPassenger: 850, total: 850 })]);
    expect(g.rejected).toEqual([]);
  });

  it('[16] availability identity: a provider result about ANOTHER train is refused (RESULT_IDENTITY_MISMATCH) and never synced', async () => {
    const h = nativeStack({
      'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain.' }],
      '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [{ name: 'CHECK_AVAILABILITY', args: { trainNumber: '12497', travelClass: '3A' } }] }, { content: 'Availability abhi verify nahi ho paayi.' }]
    });
    await h.say('Kal Amritsar se Delhi jaana hai');
    rail.wrongTrain = true;
    const r = await h.say('12497 3A availability');
    expect(binding(r).entityBindingStatus).toBe('MISMATCH');
    expect(chain(r).steps.at(-1)).toMatchObject({ toolName: 'CHECK_AVAILABILITY', entityBindingStatus: 'MISMATCH' });
    const msg = h.views.filter(v => v.user === '12497 3A availability').at(-1)!.results.at(-1)!.content;
    expect(msg).toMatchObject({ ok: false, error: { code: 'RESULT_IDENTITY_MISMATCH', errorType: 'IDENTITY', retryable: false } });
    expect(Object.keys(h.s().availability || {})).toHaveLength(0);
    // P42.12: the current search rows are availability evidence of their own — the mismatched CHECK result is not
    expect(collectAvailabilityEvidence(h.s(), []).filter(e => e.sourceTool === 'CHECK_AVAILABILITY')).toEqual([]);
  });

  it('[17] timetable identity: GET_TIMETABLE / GET_TRAIN_INFO carry the train; "Yeh 06:35 pe nikalti hai" after 12014 is cross-train', async () => {
    expect(buildToolResultIdentity({ toolName: 'GET_TIMETABLE', resultId: 't', args: { trainNumber: '12014' }, data: { trainNumber: '12014', trainName: 'Amritsar Shatabdi Express', timetable: [] } }))
      .toMatchObject({ trainNumber: '12014', trainName: 'Amritsar Shatabdi Express', binding: 'BOUND' });
    expect(buildToolResultIdentity({ toolName: 'GET_TRAIN_INFO', resultId: 'i', args: { trainNumber: '12497', date: KAL }, data: { trainNumber: '12497' } }))
      .toMatchObject({ trainNumber: '12497', date: KAL, dateSource: 'REQUEST' });
    const r = await compose(session(), '12014 sabse pehle pahunchti hai. Yeh 06:35 pe nikalti hai.', []);
    expect(reasons(r)).toEqual(['CROSS_TRAIN_FACT:12014']);
    const ok = await compose(session(), '12014 sabse pehle pahunchti hai. Yeh 04:55 pe nikalti hai.', []);
    expect(reasons(ok)).toEqual([]);
  });
});

describe('P28 G2 — correction, date change, natural response', () => {
  it('[18] correction flow: "Actually CC" (next turn) → class re-selected and a FRESH availability call for CC (no reuse of the 3A result)', async () => {
    const h = nativeStack({
      'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain.' }],
      '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [{ name: 'CHECK_AVAILABILITY', args: { trainNumber: '12497', travelClass: '3A' } }] }, { content: '12497 mein 3A available hai.' }],
      'Actually CC': [{ calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: 'CC' })] }, { calls: [{ name: 'CHECK_AVAILABILITY', args: { trainNumber: '12497', travelClass: 'CC' } }] }, { content: '12497 CC ki availability upar hai.' }]
    });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A availability');
    const n0 = { ...rail.n };
    const r = await h.say('Actually CC');
    expect(delta(n0).avail).toBe(1);
    expect(rail.calls.at(-1)).toEqual(['avail', '12497', 'CC', KAL]);
    expect(h.s().selectedClass).toBe('CC');
    expect(binding(r).toolEntity.at(-1)).toMatchObject({ trainNumber: '12497', class: 'CC', date: KAL });
  });

  it('[19] "kal nahi parso": fresh search for the new date; followUp states the previous train/class exist (not kept); dependent checks re-run for parso', async () => {
    const AV3 = { name: 'CHECK_AVAILABILITY', args: { trainNumber: '12497', travelClass: '3A' } };
    const FR3 = { name: 'GET_FARE', args: { trainNumber: '12497', travelClass: '3A' } };
    const h = nativeStack({
      'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain.' }],
      '12497 3A availability aur fare': [{ calls: [SEL('12497', '3A')] }, { calls: [AV3, FR3] }, { content: '12497 mein 3A available hai, fare ₹650 per passenger.' }],
      'Kal nahi parso': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' })] }, { calls: [SEARCH('parso')] },
        { calls: [SEL('12497', '3A')] }, { calls: [AV3, FR3] }, { content: 'Parso bhi 12497 mein 3A available hai, fare ₹650 per passenger.' }]
    });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A availability aur fare');
    const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso');
    expect(delta(n0)).toEqual({ search: 1, avail: 1, fare: 1 });
    const v = h.views.filter(x => x.user === 'Kal nahi parso');
    const searchMsg = v[2].results.at(-1)!.content;
    expect(searchMsg).toMatchObject({ tool: 'SEARCH_TRAINS', entity: { date: PARSO }, followUp: { previousSelection: { trainNumber: '12497', travelClass: '3A' }, inFreshResults: true, classListed: true, selectionKept: false } });
    expect(rail.calls.filter(c => c[0] === 'avail').at(-1)).toEqual(['avail', '12497', '3A', PARSO]);
    expect(binding(r).toolEntity.slice(-2)).toEqual([expect.objectContaining({ trainNumber: '12497', date: PARSO }), expect.objectContaining({ trainNumber: '12497', date: PARSO })]);
    expect(binding(r)).toMatchObject({ claimBindingStatus: 'BOUND', stepLimitReached: false, llmCallCount: 5 });
  });

  it('[20] natural response: the LLM\'s own wording is the reply (no template); internal result refs / ids never reach the user', async () => {
    const r = await compose(session(), '12497 Shan-e-Punjab mein 3A seats available hain. Fare ₹650 per passenger hai.');
    expect(r).toMatchObject({ source: 'LLM', authoredBy: 'AGENT', wordingCall: false });
    expect(r.text).toMatch(/Shan-e-Punjab/);
    const leak = await compose(session(), 'Result fare-2 ke hisaab se 12497 ka 3A fare ₹650 hai. 12497 mein 3A seats available hain.');
    expect(reasons(leak)).toEqual(['INTERNAL_ID']);
    expect(leak.text).not.toMatch(RESULT_REF_RE);
    // the backend-reply guard keeps a correct LLM sentence verbatim and removes only the cross-train one
    const steps: any = [AV(), FARE()];
    expect(factGuard('12497 mein 3A available hai, fare ₹650 per passenger.', steps, 'TEXT', session())).toBe('12497 mein 3A available hai, fare ₹650 per passenger.');
    expect(factGuard('12014 Shatabdi sabse pehle pahunchti hai. Is train ki 3A seats available hain, fare ₹650.', steps, 'TEXT', session())).toBe('12014 Shatabdi sabse pehle pahunchti hai.');
  });
});
