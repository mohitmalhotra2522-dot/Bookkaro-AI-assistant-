/**
 * PROMPT 29 — G2: truthful action state + progress-claim hardening (focused unit tests, offline).
 * Action / progress statements ("availability check kar raha hoon", "fare check ho gaya") must be supported by THIS
 * turn's actual execution records; the LLM still decides every tool — the backend never adds a follow-up call.
 * MockLLM / an injected fake OpenAI-compatible server; mock railway spy. No network, credits, booking or handoff.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { naturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';
import {
  actionLedgerFromSteps, guardActionClaims, detectActionClaim, acknowledgementMatchesDispatch, stripStaleActionClaims,
  type ActionExecution
} from '../../server/ai/response/action-claims';

const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;

// ---- ledger fixtures: one runtime step per execution (status = the real ToolExecutionStatus vocabulary) ----
let n = 0;
const st = (tool: string, status: string, a: Record<string, string> = {}, turnId = 'T2') => ({
  toolCall: { callId: `call_${++n}`, name: tool, arguments: a }, validatedArguments: a,
  status: status === 'SUCCEEDED' ? 'ok' : status === 'REJECTED' ? 'rejected' : status === 'STALE' ? 'stale' : 'error',
  result: { toolName: tool, success: status === 'SUCCEEDED', data: a, identity: a, ...(status === 'TIMEOUT' ? { error: { code: 'TOOL_TIMEOUT' } } : {}) },
  execution: { status: status === 'STALE' ? 'SUCCEEDED' : status, toolExecutionId: `te_${n}`, turnId }
});
const AV = (status = 'SUCCEEDED', trainNumber = '12497', travelClass = '3A', date = KAL) => st('CHECK_AVAILABILITY', status, { trainNumber, travelClass, date });
const FARE = (status = 'SUCCEEDED', trainNumber = '12497', travelClass = '3A', date = KAL) => st('GET_FARE', status, { trainNumber, travelClass, date });
const SEARCH = (status = 'SUCCEEDED', date = KAL) => st('SEARCH_TRAINS', status, { origin: 'ASR', destination: 'NDLS', date });
const L = (steps: any[], previous: any[] = []) => actionLedgerFromSteps(steps, { turnId: 'T2', previous: actionLedgerFromSteps(previous, { turnId: 'T1' }).current });
const guard = (text: string, steps: any[], previous: any[] = []) => guardActionClaims(text, L(steps, previous));
const reasonsOf = (g: any) => g.removed.map((r: any) => r.verdict.removalReason);

// ---- composer helper (native agent text judged sentence by sentence) ----
const TRAINS = [
  { trainNumber: '12014', trainName: 'Amritsar Shatabdi Express', origin: 'ASR', destination: 'NDLS', departure: '04:55', arrival: '10:50', duration: '5h 55m', displayIndex: 1, classes: [{ code: 'CC' }, { code: '2S' }] },
  { trainNumber: '12497', trainName: 'Shan-e-Punjab Express', origin: 'ASR', destination: 'NDLS', departure: '06:35', arrival: '13:50', duration: '7h 15m', displayIndex: 2, classes: [{ code: '3A' }, { code: 'CC' }, { code: 'SL' }, { code: '2S' }] }
];
function session(extra: Record<string, any> = {}) {
  const sm = new ConversationStateManager();
  const s: any = sm.getSession(sm.createSession().sessionId);
  Object.assign(s, { origin: 'ASR', destination: 'NDLS', originName: 'Amritsar', destinationName: 'New Delhi', date: KAL, bookingState: 'CLASS_SELECTED',
    searchResults: { trains: TRAINS.map(t => ({ ...t, classes: t.classes.map(c => ({ ...c })) })) },
    selectedTrain: { number: '12497', name: 'Shan-e-Punjab Express', classes: TRAINS[1].classes.map(c => ({ ...c })) }, selectedClass: '3A', pendingInteraction: { type: 'NONE' } }, extra);
  return s;
}
const okData = (tool: string) => tool === 'CHECK_AVAILABILITY' ? { trainNumber: '12497', travelClass: '3A', date: KAL, status: 'Available', available: true }
  : { trainNumber: '12497', travelClass: '3A', passengersCount: 1, perPassenger: 650, total: 650 };
const realStep = (tool: string) => { const x: any = st(tool, 'SUCCEEDED', { trainNumber: '12497', travelClass: '3A', date: KAL }); x.result.data = okData(tool); return x; };
function compose(s: any, agentText: string, steps: any[], o: { general?: boolean } = {}): Promise<any> {
  return naturalResponseComposer.compose({
    llm: { providerId: 'native', agentAuthoredReplies: true, generateStructuredDecision: async () => ({}) as any, generateSpokenResponse: vi.fn(async () => ({ text: 'W' })) } as any,
    session: s, userText: 'batao', backendReply: 'OK', deterministicSpeech: 'DETERMINISTIC', stateBefore: s.bookingState, reviewVersionBefore: null,
    selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null, steps, appliedActions: [], changes: [], error: null,
    pendingQuestionCode: null, pendingQuestion: null, history: [], mode: 'TEXT', agentText, general: !!o.general
  } as any);
}

// ---- full-stack harness (mock railway spy with failure / timeout / gate switches) ----
const pmeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p29u-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; calls: Array<[string, string, string, string]> = []; failAvail = 0; slowAvail = 0; gate: Promise<void> | null = null;
  private b(k: string, r: any) { this.n[k] = (this.n[k] || 0) + 1; this.calls.push([k, String(r?.trainNumber ?? ''), String(r?.travelClass ?? ''), String(r?.date ?? '')]); }
  async searchTrains(r: any): Promise<any> { this.b('search', r); return super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> {
    this.b('avail', r);
    if (this.gate) await this.gate;
    if (this.slowAvail) await new Promise(x => setTimeout(x, this.slowAvail));
    if (this.failAvail > 0) { this.failAvail--; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock availability down.' }, meta: pmeta() }; }
    return super.checkAvailability(r);
  }
  async getFare(r: any): Promise<any> { this.b('fare', r); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p29u-spy', () => rail);
function wire(llm: any, timeoutMs = 1000) {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { eng, sid, state, s: () => state.getSession(sid) as any, say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT', o: any = {}) => eng.processTurn(sid, t, mode, o) as Promise<any> };
}
function native(plan: Record<string, any[]>, timeoutMs = 1000) {
  const fake = new FakeOpenAI((v: TurnView) => { const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-p29-unit', LLM_MODEL: 'fake', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  return wire(sel.provider, timeoutMs);
}
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SRCH = (date: string) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const SEL = (num: string, cls?: string) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: num }, ...(cls ? { classRaw: cls } : {}), selectionPurpose: 'INFORMATION' });
const CAV = (num: string, cls: string) => ({ name: 'CHECK_AVAILABILITY', args: { trainNumber: num, travelClass: cls } });
const CFARE = (num: string, cls: string) => ({ name: 'GET_FARE', args: { trainNumber: num, travelClass: cls } });
const START = { 'Kal Amritsar se Delhi jaana hai': [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' }] };
const actions = (r: any) => (r.turnLog.diagnostics.actionClaims || []) as any[];
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'avail', 'fare'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));
const flush = () => new Promise(r => setTimeout(r, 15));

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p29u-spy');
  Object.assign(rail, { n: {}, calls: [], failAvail: 0, slowAvail: 0, gate: null });
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

describe('P29 G2 — action lifecycle: planned vs requested vs executing vs succeeded', () => {
  it('[1] an action statement DURING real execution is allowed; the LLM acknowledgement is spoken only when that tool genuinely entered execution', async () => {
    const g = guard('Ek second, 12497 ki 3A availability check kar raha hoon.', [AV('RUNNING')]);
    expect(g.removed).toEqual([]);
    expect(g.diagnostics[0]).toMatchObject({ actionType: 'CHECK_AVAILABILITY', actionStatus: 'EXECUTING', validationStatus: 'VALID', removalReason: null });
    expect(acknowledgementMatchesDispatch('Haan, ek second, 12497 ki 3A availability check karta hoon.', [{ toolCallId: 'x', toolName: 'CHECK_AVAILABILITY', status: 'EXECUTING', outcome: 'RUNNING', turnId: 'T', trainNumber: '12497', travelClass: '3A' }])).toBe(true);
    // full stack (VOICE): the ack the LLM sent WITH its tool call is spoken at dispatch
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
      // (the existing P21 fact-free ack check allows only known train numbers as digits — so no "3A" in the ack text)
      'availability batao': [{ content: 'Ek second, 12497 ki availability check karta hoon.', calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const r = await h.say('availability batao', 'VOICE');
    expect(r.turnLog.turnEngine.acknowledgementSource).toBe('LLM');
    expect(r.progress.map((p: any) => p.speechText).filter(Boolean)[0]).toMatch(/12497 ki availability check karta hoon/);
  });

  it('[2] an action statement WITHOUT execution is rejected — a proposal (validator-rejected call) is not execution; a mismatching ack falls back to the dispatched tool', async () => {
    expect(reasonsOf(guard('Availability check kar raha hoon.', []))).toEqual(['NO_CURRENT_TURN_EXECUTION']);
    expect(reasonsOf(guard('Availability check kar raha hoon.', [AV('REJECTED')]))).toEqual(['TOOL_NOT_EXECUTED']);
    expect(guard('Availability check kar raha hoon.', [AV('REJECTED')]).diagnostics[0].actionStatus).toBe('SKIPPED');
    expect(acknowledgementMatchesDispatch('Ek second, 12014 ki availability check karta hoon.', [{ toolCallId: 's', toolName: 'SEARCH_TRAINS', status: 'EXECUTING', outcome: 'RUNNING', turnId: 'T' } as ActionExecution])).toBe(false);
    // full stack: the LLM promises availability but only SEARCH_TRAINS runs → the neutral search ack is spoken instead
    const h = native({ 'Kal Amritsar se Delhi': [{ content: 'Ek second, 12497 ki 3A availability check karta hoon.', calls: [SRCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain.' }] });
    const r = await h.say('Kal Amritsar se Delhi', 'VOICE');
    expect(r.turnLog.turnEngine.acknowledgementSource).toBe('DEFAULT');
    const spoken = r.progress.map((p: any) => p.speechText).filter(Boolean).join(' ');
    expect(spoken).not.toMatch(/availability/i);
    expect(spoken).toMatch(/trains/i);
  });

  it('[3] a SUCCESS statement is allowed only after a successful result (not while running, not for a proposal)', () => {
    expect(reasonsOf(guard('12497 ki availability check ho gayi.', [AV('RUNNING')]))).toEqual(['NO_SUCCESSFUL_CURRENT_TURN_EXECUTION']);
    expect(reasonsOf(guard('12497 ki availability check ho gayi.', [AV('REJECTED')]))).toEqual(['TOOL_NOT_EXECUTED']);
    const ok = guard('12497 ki availability check ho gayi.', [AV('SUCCEEDED')]);
    expect(ok.removed).toEqual([]);
    expect(ok.diagnostics[0]).toMatchObject({ actionSubtype: 'ACTION_SUCCEEDED', actionStatus: 'SUCCEEDED', validationStatus: 'VALID' });
    expect(detectActionClaim('I checked the availability')!.phase).toBe('SUCCEEDED');
    expect(detectActionClaim("I'm checking the fare")!).toMatchObject({ phase: 'EXECUTING', actionTypes: ['GET_FARE'] });
  });

  it('[4] a FAILED tool never yields a success claim; "nahi ho paayi" stays (full stack: provider down twice)', async () => {
    expect(reasonsOf(guard('Availability check ho gayi.', [AV('FAILED')]))).toEqual(['TOOL_FAILED']);
    expect(guard('Availability check nahi ho paayi.', [AV('FAILED')]).removed).toEqual([]);
    rail.failAvail = 2;
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
      'availability batao': [{ calls: [CAV('12497', '3A')] }, { content: 'Availability check ho gayi. 12497 ki 3A availability abhi check nahi ho paayi, thodi der mein dobara try karein.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const r = await h.say('availability batao');
    for (const t of [r.voice.assistantText, r.responseMessage]) expect(String(t)).not.toMatch(/check ho gayi/i);
    expect(actions(r).some(a => a.removalReason === 'TOOL_FAILED' && a.actionStatus === 'FAILED')).toBe(true);
    expect(r.voice.assistantText).toMatch(/nahi ho paayi/);
  });

  it('[5] a TIMEOUT never yields a success claim (existing timeout semantics; no extra retry beyond policy)', async () => {
    expect(reasonsOf(guard('Availability check ho gayi.', [AV('TIMEOUT')]))).toEqual(['TOOL_TIMEOUT']);
    expect(reasonsOf(guard('Availability check ho gayi.', [AV('UNKNOWN')]))).toEqual(['TOOL_TIMEOUT']);
    rail.slowAvail = 150;
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
      'availability batao': [{ calls: [CAV('12497', '3A')] }, { content: '12497 ki 3A availability check kar li.' }] }, 40);
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const n0 = { ...rail.n };
    const r = await h.say('availability batao');
    expect(delta(n0).avail).toBeLessThanOrEqual(2);                          // bounded by the existing retry policy
    for (const t of [r.voice.assistantText, r.responseMessage]) expect(String(t)).not.toMatch(/check kar li/i);
    expect(actions(r).some(a => a.removalReason === 'TOOL_TIMEOUT')).toBe(true);
  });
});

describe('P29 G2 — current-turn scope, dates, entities, interruption', () => {
  it('[6] an OLD turn\'s action cannot validate a current-turn claim (labelled STALE)', () => {
    const g = guard('12497 ki 3A availability check kar li.', [], [AV('SUCCEEDED')]);
    expect(reasonsOf(g)).toEqual(['STALE_PREVIOUS_TURN_ACTION']);
    expect(g.diagnostics[0]).toMatchObject({ actionStatus: 'STALE', actionSubtype: 'ACTION_STALE', validationStatus: 'REJECTED' });
    expect(guard('Parso ke liye dobara availability check kar raha hoon.', [], [AV('SUCCEEDED')]).text).toBe('');
  });

  it('[7] a date change invalidates old action claims; the carry-over note promises nothing (full stack, no auto availability / fare)', async () => {
    const g = guard('Parso ki trains mil gayi hain. Availability aur fare dobara verify kar raha hoon.', [SEARCH('SUCCEEDED', PARSO)], [AV(), FARE()]);
    expect(g.text).toBe('Parso ki trains mil gayi hain.');
    expect(reasonsOf(guard('Kal ki availability check kar li.', [SEARCH('SUCCEEDED', PARSO)]))).toEqual(['NO_SUCCESSFUL_CURRENT_TURN_EXECUTION']);
    // "pehle hi check kar li thi" needs committed session evidence for that date (a date change cleared it)
    const lg = actionLedgerFromSteps([SEARCH('SUCCEEDED', PARSO)], { turnId: 'T2', session: { date: PARSO, availability: {} } });
    expect(reasonsOf(guardActionClaims('12497 ki 3A availability pehle hi check kar li thi.', lg))).toEqual(['PREVIOUS_ACTION_NOT_FOUND']);
    const m = wire(new MockLLMProvider({}));
    await m.say('Kal Amritsar se Delhi trains batao'); await m.say('12497 3A');
    const n0 = { ...rail.n };
    const r = await m.say('Kal nahi parso', 'VOICE');
    expect(delta(n0)).toEqual({ search: 1, avail: 0, fare: 0 });
    for (const t of [r.voice.assistantText, r.responseMessage, r.voice.speechText]) expect(String(t)).not.toMatch(/verify kar raha|check kar raha|dobara verify/i);
    expect(r.responseMessage).toMatch(/abhi check nahi hue/);
  });

  it('[8] train mismatch invalidates the action claim', () => {
    expect(reasonsOf(guard('12497 ki availability check kar li.', [AV('SUCCEEDED', '12014', 'CC')]))).toEqual(['ACTION_TRAIN_MISMATCH']);
    expect(guard('12014 ki CC availability check kar li.', [AV('SUCCEEDED', '12014', 'CC')]).removed).toEqual([]);
  });

  it('[9] class (and date) mismatch invalidates the action claim', () => {
    expect(reasonsOf(guard('12497 ki 3A availability check kar raha hoon.', [AV('RUNNING', '12497', '2A')]))).toEqual(['ACTION_CLASS_MISMATCH']);
    expect(reasonsOf(guard('Parso 12497 ki availability check kar raha hoon.', [AV('RUNNING', '12497', '3A', KAL)]))).toEqual(['ACTION_DATE_MISMATCH']);
    expect(guard('Parso 12497 ki availability check kar raha hoon.', [AV('RUNNING', '12497', '3A', PARSO)]).removed).toEqual([]);
  });

  it('[10] voice interruption: the old turn\'s progress is STALE — no further progress, its action statement never continues', async () => {
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
      'availability check karo': [{ content: 'Ek second, 12497 ki 3A availability check karta hoon.', calls: [CAV('12497', '3A')] }, { content: '12497 ki 3A availability check kar raha hoon. 3A mein seats available hain.' }],
      '12497 CC wali dekho': [{ calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: 'CC' })] }, { content: 'Theek hai, CC.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    let release!: () => void; rail.gate = new Promise<void>(r => { release = r; });
    const p1 = h.say('availability check karo', 'VOICE');
    await flush();
    const t1 = h.eng.getTurns(h.sid).slice(-1)[0];
    const progressBefore = h.eng.events.forTurn(h.sid, t1.turnId).filter((e: any) => e.type === 'TOOL_PROGRESS').length;
    expect(progressBefore).toBeGreaterThan(0);
    const p2 = h.say('12497 CC wali dekho', 'VOICE', { interruptPrevious: true });
    await flush();
    rail.gate = null; release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.progress.length).toBeGreaterThan(0);
    expect(r1.progress.every((p: any) => p.stale === true)).toBe(true);
    expect(h.eng.events.forTurn(h.sid, t1.turnId).filter((e: any) => e.type === 'TOOL_PROGRESS').length).toBe(progressBefore);
    // either discarded, or presented WITHOUT the stale progress statement (text and speech alike)
    if (r1.presentable) for (const t of [r1.voice.assistantText, r1.voice.speechText, r1.responseMessage]) expect(String(t)).not.toMatch(/check kar raha|check karta/i);
    expect(r2.presentable).toBe(true);
    expect(stripStaleActionClaims('12014 ki availability check kar raha hoon. 3A mein seats available hain.', 'T1').text).toBe('3A mein seats available hain.');
  });
});

describe('P29 G2 — partial chains, cleanup, regressions', () => {
  it('[11] a partial tool chain never claims the unfinished tools', () => {
    const g = guard('Parso ki trains mil gayi hain. Availability aur fare bhi check kar liye.', [SEARCH('SUCCEEDED', PARSO)]);
    expect(g.text).toBe('Parso ki trains mil gayi hain.');
    expect(guard('Parso ki trains mil gayi hain. Availability/fare abhi check nahi hua.', [SEARCH('SUCCEEDED', PARSO)]).removed).toEqual([]);
    // availability ran, fare was stopped before the provider → only the fare half of the claim is false → clause removed
    const p = guard('Availability aur fare check kar liye.', [AV(), FARE('CANCELLED')]);
    expect(reasonsOf(p)).toEqual(['TOOL_NOT_EXECUTED']);
    expect(guard('12497 ki availability check kar li.', [AV(), FARE('CANCELLED')]).removed).toEqual([]);
  });

  it('[12] removing an action claim cleans orphaned fragments; untouched lines stay byte-identical; nothing internal leaks', () => {
    expect(guard('Parso ke liye trains mil gayi hain. Availability aur fare dobara verify kar raha hoon. 1.', [SEARCH('SUCCEEDED', PARSO)]).text).toBe('Parso ke liye trains mil gayi hain.');
    expect(guard('Trains mil gayi hain, aur main fare check kar raha hoon.', [SEARCH('SUCCEEDED', PARSO)]).text).toBe('Trains mil gayi hain.');
    const list = 'Amritsar → New Delhi: 3 trains mili hain.\n1. 12014 Amritsar Shatabdi Express — 04:55 → 10:50 · CC/2S\n2. 12497 Shan-e-Punjab Express — 06:35 → 13:50 · 3A/CC/SL/2S';
    const g = guard(`${list}\nNayi date ki fresh list mein 12497 hai — wahi train aur 3A rakhi hai; availability aur fare dobara verify kar raha hoon.`, [SEARCH('SUCCEEDED', PARSO)]);
    expect(g.text).toBe(`${list}\nNayi date ki fresh list mein 12497 hai — wahi train aur 3A rakhi hai.`);
    expect(g.text).not.toMatch(/NO_CURRENT|REJECTED|te_\d|call_\d|toolCallId|provenance/i);
  });

  it('[13] general knowledge stays intact (explanations, user instructions, capability statements are not action claims)', async () => {
    const GK = ['RAC mein cancellation ke baad confirmation ho sakta hai.', 'TTE ticket check karta hai.', 'Aap PNR status IRCTC par check kar sakte hain.',
      'Tatkal booking generally ek din pehle khulti hai.', 'Chart banne ke baad WL status check karna chahiye.', 'Availability usually checked before booking.'];
    for (const t of GK) { const g = guard(t, []); expect(g.text).toBe(t); expect(g.removed).toEqual([]); }
    const r = await compose(session(), 'RAC ka matlab Reservation Against Cancellation hai. Cancellation hone par RAC 1 wale ko poori berth mil sakti hai.', [], { general: true });
    expect(r.rejected).toEqual([]);
    const m = wire(new MockLLMProvider({}));
    const g = await m.say('RAC kya hota hai?');
    expect(actions(g).filter(a => a.validationStatus === 'REJECTED')).toEqual([]);
    expect(g.turnLog.diagnostics.binding.toolCallCount).toBe(0);
  });

  it('[14] railway facts stay intact and still guarded (P25/P26/P28); only the false action clause goes', async () => {
    const s = session();
    const ok = await compose(s, '12497 mein 3A available hai, fare ₹650 per passenger.', [realStep('CHECK_AVAILABILITY'), realStep('GET_FARE')]);
    expect(ok.rejected).toEqual([]);
    const mixed = await compose(s, '12497 mein 3A available hai. Fare bhi check kar raha hoon.', [realStep('CHECK_AVAILABILITY')]);
    expect(mixed.text).toMatch(/12497 mein 3A available hai/);
    expect(mixed.text).not.toMatch(/check kar raha/);
    expect(mixed.rejected.map((x: any) => x.reason)).toEqual(['ACTION_CLAIM:NO_CURRENT_TURN_EXECUTION']);
    const bad = await compose(s, '12497 ka 3A fare ₹999 hai.', [realStep('CHECK_AVAILABILITY'), realStep('GET_FARE')]);
    // still rejected by the existing number / fare guards (P22 UNGROUNDED_NUMBER fires before the fare judge)
    expect(bad.rejected.map((x: any) => x.reason)).toEqual([expect.stringMatching(/^(FARE_MISMATCH|UNGROUNDED_NUMBER|UNGROUNDED_FARE_AMOUNT):999$/)]);
    expect(bad.text || '').not.toMatch(/999/);
  });

  it('[15] the LLM stays free to choose different valid sequences — the backend only validates the chosen action', async () => {
    const Q = 'Kal Amritsar se Delhi 12497 3A';
    const seqs: Record<string, any[]> = {
      A: [{ calls: [SRCH('kal')] }, { calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }],
      B: [{ calls: [SRCH('kal')] }, { calls: [SEL('12497', '3A')] }, { calls: [CFARE('12497', '3A')] }, { content: '12497 ka 3A fare ₹650 per passenger hai.' }],
      C: [{ calls: [SRCH('kal')] }, { calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { calls: [CFARE('12497', '3A')] }, { content: '12497 mein 3A available hai, fare ₹650 per passenger.' }],
      D: [{ content: 'Tatkal booking generally ek din pehle khulti hai.' }],
      E: [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain.' }]
    };
    const expected: Record<string, string[]> = { A: ['SEARCH_TRAINS', 'CHECK_AVAILABILITY'], B: ['SEARCH_TRAINS', 'GET_FARE'], C: ['SEARCH_TRAINS', 'CHECK_AVAILABILITY', 'GET_FARE'], D: [], E: ['SEARCH_TRAINS'] };
    for (const k of Object.keys(seqs)) {
      const h = native({ [Q]: seqs[k] });
      const n0 = { ...rail.n };
      const r = await h.say(Q);
      expect(r.turnLog.diagnostics.binding.toolSequence).toEqual(expected[k]);
      expect(delta(n0)).toEqual({ search: expected[k].includes('SEARCH_TRAINS') ? 1 : 0, avail: expected[k].includes('CHECK_AVAILABILITY') ? 1 : 0, fare: expected[k].includes('GET_FARE') ? 1 : 0 });
    }
  });

  it('[16] the backend does NOT execute a follow-up tool: search succeeds (selection carried over) → no availability / fare unless the LLM asks', async () => {
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
      'Kal nahi parso': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' })] }, { calls: [SRCH('parso')] }, { content: 'Parso ki fresh trains mil gayi hain. Availability aur fare dobara verify kar raha hoon.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso');
    expect(delta(n0)).toEqual({ search: 1, avail: 0, fare: 0 });
    expect(r.turnLog.diagnostics.binding.toolSequence).toEqual(['SEARCH_TRAINS']);
    for (const t of [r.voice.assistantText, r.responseMessage]) expect(String(t)).not.toMatch(/verify kar raha|check kar raha/i);
  });

  it('[17] same-turn duplicate protection still works (provider once) and the success claim is backed by the original call', async () => {
    const h = native({ ...START, '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { content: '12497 ki 3A availability check kar li. 3A mein seats available hain.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say('12497 3A availability');
    expect(delta(n0).avail).toBe(1);
    expect(r.turnLog.diagnostics.binding.duplicateCallPrevented).toBe(true);
    expect(r.voice.assistantText).toMatch(/check kar li/);
    expect(actions(r).filter(a => a.validationStatus === 'REJECTED')).toEqual([]);
  });

  it('[18] a new turn still makes a fresh provider call — and only THAT call backs the new turn\'s claim', async () => {
    const h = native({ ...START, '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { content: '12497 ki 3A availability check kar li.' }],
      'phir se dekho': [{ calls: [CAV('12497', '3A')] }, { content: '12497 ki 3A availability dobara check kar li.' }],
      'aur?': [{ content: '12497 ki 3A availability check kar li.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A availability');
    const n0 = { ...rail.n };
    const r = await h.say('phir se dekho');
    expect(delta(n0).avail).toBe(1);
    expect(r.voice.assistantText).toMatch(/check kar li/);
    const n1 = { ...rail.n };
    const q = await h.say('aur?');                                       // no call this turn → the old call cannot back it
    expect(delta(n1).avail).toBe(0);
    for (const t of [q.voice.assistantText, q.responseMessage]) expect(String(t)).not.toMatch(/check kar li/);
    expect(actions(q).some(a => a.removalReason === 'STALE_PREVIOUS_TURN_ACTION')).toBe(true);
  });
});
