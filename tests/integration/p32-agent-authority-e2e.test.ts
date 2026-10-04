/**
 * PROMPT 32 — G3: full LLM agent authority + honest railway outcomes through the FULL stack
 *   user → ConversationTurnEngine → orchestrator → LLM decides (native tool calls) → validator → RailwayToolRuntime →
 *   railway provider spy → LLM answers → fact / binding / action / reference / OUTCOME guards → text + TTS.
 * The native OpenAI-compatible adapter runs against an injected fake server (the "LLM" there makes every decision);
 * MockLLM covers the offline default. No network, credits, booking, handoff or real IRCTC.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';
import { currentResults } from '../../server/ai/context/train-reference-resolver';
import { SAFE_ERROR_MESSAGE } from '../../server/ai/tool-runtime/tool-error-normalizer';

const pmeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p32-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
type Mode = 'ok' | 'timeout' | 'fail' | 'malformed' | 'empty';
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; calls: Array<[string, string, string, string, string]> = [];
  mode: Record<string, Mode> = {};
  private b(k: string, r: any) { this.n[k] = (this.n[k] || 0) + 1; this.calls.push([k, String(r?.trainNumber ?? ''), String(r?.travelClass ?? ''), String(r?.date ?? ''), `${r?.origin ?? ''}-${r?.destination ?? ''}`]); }
  private fault(k: string): any {
    const m = this.mode[k] || 'ok';
    if (m === 'timeout') return new Promise(() => { /* never answers → runtime TIMEOUT */ });
    if (m === 'fail') return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'upstream down' }, meta: pmeta() };
    if (m === 'malformed') return { ok: true, data: k === 'search' ? { foo: 1 } : { weird: true }, meta: pmeta() };
    if (m === 'empty' && k === 'search') return { ok: false, error: { code: 'NO_TRAINS_FOUND', message: 'none' }, meta: pmeta() };
    return null;
  }
  async searchTrains(r: any): Promise<any> { this.b('search', r); return this.fault('search') ?? super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> { this.b('avail', r); return this.fault('avail') ?? super.checkAvailability(r); }
  async getFare(r: any): Promise<any> { this.b('fare', r); return this.fault('fare') ?? super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p32-spy', () => rail);

const KEY = 'sk-live-P32-E2E-SECRET-32323';
const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;
const outputs: string[] = [];
function wire(llm: any) {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 150, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = async (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT', o: any = {}) => { const r: any = await eng.processTurn(sid, t, mode, o); outputs.push(JSON.stringify({ r, s: state.getSession(sid) })); return r; };
  return { eng, sid, say, s: () => state.getSession(sid) as any };
}
const mock = () => wire(new MockLLMProvider({}));
function native(plan: Record<string, any[]>) {
  const fake = new FakeOpenAI((v: TurnView) => { const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  return { ...wire(sel.provider), fake };
}
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SRCH = (date: string, origin = 'Amritsar') => ({ name: 'SEARCH_TRAINS', args: { origin, destination: 'Delhi', date } });
const REF = (trainRef: any, extra: any = {}) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef, selectionPurpose: 'INFORMATION', ...extra });
const SEL = (num: string, cls?: string) => REF({ kind: 'TRAIN_NUMBER', value: num }, cls ? { classRaw: cls } : {});
const CAV = (num: string, cls: string) => ({ name: 'CHECK_AVAILABILITY', args: { trainNumber: num, travelClass: cls } });
const CFARE = (num: string, cls: string) => ({ name: 'GET_FARE', args: { trainNumber: num, travelClass: cls } });
const START = { 'Kal Amritsar se Delhi jaana hai': [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' }] };
const text = (r: any) => String(r.voice?.assistantText ?? '');
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage, r.voice?.speechText, ...(r.voice?.segments || [])].map(x => String(x ?? '')).join(' | ');
const tools = (r: any) => (r.turnLog.diagnostics.tools || []) as any[];
const rejected = (r: any) => (r.turnLog.diagnostics.validation?.rejected || []) as string[];
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'avail', 'fare'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));
const toolMsgs = (fake: any, i: number) => (fake.decisionRequests[i]?.body.messages || []).filter((m: any) => m.role === 'tool').map((m: any) => JSON.parse(m.content));

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p32-spy');
  Object.assign(rail, { n: {}, calls: [], mode: {} });
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

describe('P32 G3 — the LLM decides (general, search, multi-step, references)', () => {
  it('[1] general railway question → the LLM answers with ZERO tools (no forced search)', async () => {
    const h = native({ 'Tatkal booking kab khulti hai?': [{ content: 'Tatkal booking aam taur par yatra se ek din pehle khulti hai — AC ke liye subah aur non-AC ke liye thodi der baad.' }] });
    const r = await h.say('Tatkal booking kab khulti hai?');
    expect(r.turnLog.diagnostics.toolCalls).toBe(0);
    expect(rail.n.search || 0).toBe(0);
    expect(text(r)).toMatch(/Tatkal/);
  });

  it('[2] fresh railway search: one provider call, outcome DATA, provider identity MOCK observable; LLM sees outcome + dataSource', async () => {
    const h = native(START);
    const r = await h.say('Kal Amritsar se Delhi jaana hai');
    expect(rail.n.search).toBe(1);
    expect(tools(r)).toEqual([expect.objectContaining({ tool: 'SEARCH_TRAINS', status: 'SUCCEEDED', outcome: 'DATA', providerKind: 'MOCK', attempt: 1, retried: false, fresh: true })]);
    expect(typeof tools(r)[0].latencyMs).toBe('number');
    expect(toolMsgs(h.fake, 1)[0]).toMatchObject({ tool: 'SEARCH_TRAINS', ok: true, outcome: 'DATA', dataSource: 'MOCK' });
    expect(r.turnLog.diagnostics.steps).toMatchObject({ limitReached: false, timeouts: 0, retries: 0 });
  });

  it('[3] search → availability in ONE turn: the LLM chains search, selection and CHECK_AVAILABILITY itself', async () => {
    const h = native({ 'Kal Amritsar se Delhi 12497 3A availability': [{ calls: [SRCH('kal')] }, { calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { content: '12497 mein kal 3A available hai.' }] });
    const r = await h.say('Kal Amritsar se Delhi 12497 3A availability');
    expect(delta({})).toMatchObject({ search: 1, avail: 1, fare: 0 });
    expect(tools(r).map(t => `${t.tool}:${t.outcome}`)).toEqual(['SEARCH_TRAINS:DATA', 'CHECK_AVAILABILITY:DATA']);
    expect(text(r)).toMatch(/12497.*available/);
  });

  it('[4] search → fare: no automatic availability call', async () => {
    const h = native({ 'Kal Amritsar se Delhi 12497 3A fare': [{ calls: [SRCH('kal')] }, { calls: [SEL('12497', '3A')] }, { calls: [CFARE('12497', '3A')] }, { content: '12497 mein 3A ka fare ₹650 per passenger hai.' }] });
    const r = await h.say('Kal Amritsar se Delhi 12497 3A fare');
    expect(delta({})).toMatchObject({ search: 1, fare: 1, avail: 0 });
    expect(text(r)).toMatch(/650/);
  });

  it('[5] multi-step availability + fare: the LLM runs both in parallel after selecting; both facts bound to 12497 3A', async () => {
    const h = native({ ...START, '12497 3A ki availability aur fare': [{ calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A'), CFARE('12497', '3A')] }, { content: '12497 mein 3A available hai aur fare ₹650 per passenger hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say('12497 3A ki availability aur fare');
    expect(delta(n0)).toMatchObject({ search: 0, avail: 1, fare: 1 });
    expect(text(r)).toMatch(/available/); expect(text(r)).toMatch(/650/);
  });

  it('[6] "doosri wali" → the LLM\'s DISPLAY_INDEX 2 binds to the current set\'s second train', async () => {
    const h = native({ ...START, 'Doosri wali': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 2 })] }, { content: 'Doosri wali 12497 hai — Shan-e-Punjab.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const second = currentResults(h.s())[1].trainNumber;
    await h.say('Doosri wali');
    expect(h.s().selectedTrain.number).toBe(second);
  });

  it('[7] "iska fare" → fare for the focus train only (no search, no availability)', async () => {
    const h = native({ ...START, 'Doosri wali': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 2 })] }, { content: 'Theek hai, 12497.' }],
      'Iska 3A fare': [{ calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: '3A', selectionPurpose: 'INFORMATION' })] }, { calls: [CFARE('12497', '3A')] }, { content: '12497 mein 3A ka fare ₹650 per passenger hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('Doosri wali');
    const n0 = { ...rail.n };
    const r = await h.say('Iska 3A fare');
    expect(delta(n0)).toMatchObject({ fare: 1, avail: 0, search: 0 });
    expect(rail.calls.filter(c => c[0] === 'fare').slice(-1)[0].slice(1, 3)).toEqual(['12497', '3A']);
    expect(text(r)).toMatch(/650/);
  });

  it('[8] date change: the LLM searches again with the NEW canonical date; old availability is not carried as a fact', async () => {
    const h = native({ ...START, '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }],
      'Parso ka dekho': [{ calls: [SRCH('parso')] }, { content: 'Parso ke liye trainein mil gayi hain.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A availability');
    const r = await h.say('Parso ka dekho');
    expect(rail.calls.filter(c => c[0] === 'search').slice(-1)[0][3]).toBe(PARSO);
    expect(h.s().date).toBe(PARSO);
    expect(h.s().availability).toBeFalsy();
    expect(tools(r)[0]).toMatchObject({ tool: 'SEARCH_TRAINS', outcome: 'DATA' });
  });

  it('[9] route change: a new route is a new logical request → fresh provider search for that route', async () => {
    const h = native({ ...START, 'Ludhiana se Delhi kal': [{ calls: [SRCH('kal', 'Ludhiana')] }, { content: 'Ludhiana se Delhi ki trainein mil gayi hain.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    await h.say('Ludhiana se Delhi kal');
    expect(rail.n.search).toBe(2);
    expect(rail.calls.filter(c => c[0] === 'search').map(c => c[4].split('-')[0])).toEqual(['ASR', 'LDH']);
    expect(h.s().origin).toBe('LDH');
  });

  it('[10] comparison is LLM-owned and grounded in the current results', async () => {
    const h = native({ ...START, 'Inme se sabse pehle kaunsi pahunchti hai?': [{ content: '12014 sabse pehle 10:50 par pahunchti hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('Inme se sabse pehle kaunsi pahunchti hai?');
    expect(text(r)).toMatch(/12014.*10:50/);
    expect(r.turnLog.diagnostics.toolCalls).toBe(0);
  });

  it('[11] mixed GK + live: one turn, the LLM answers the general part and searches for the live part', async () => {
    const h = native({ 'Tatkal kya hota hai aur kal Amritsar se Delhi trains dikhao': [{ calls: [SRCH('kal')] }, { content: 'Tatkal ek last-minute booking quota hai.' }] });
    const r = await h.say('Tatkal kya hota hai aur kal Amritsar se Delhi trains dikhao');
    expect(rail.n.search).toBe(1);
    expect(shown(r)).toMatch(/Tatkal/);
    expect((r.cards || r.assistantResponse?.cards || []).some((c: any) => c.type === 'trains') || /12014|12497/.test(shown(r))).toBe(true);
  });
});

describe('P32 G3 — honest failures (8 outcomes stay distinct)', () => {
  it('[12] search TIMEOUT: the LLM\'s "koi train nahi mili" is removed; the user hears the timeout, not "no trains"', async () => {
    rail.mode.search = 'timeout';
    const h = native({ 'Kal Amritsar se Delhi': [{ calls: [SRCH('kal')] }, { content: 'Kal Amritsar se Delhi ke liye koi train nahi mili.' }] });
    const r = await h.say('Kal Amritsar se Delhi');
    expect(shown(r)).not.toMatch(/koi train nahi/i);
    expect(text(r)).toBe(SAFE_ERROR_MESSAGE.TOOL_TIMEOUT);
    expect(rejected(r)).toContain('OUTCOME_CLAIM:NO_RESULTS_CLAIM_ON_TIMEOUT');
    expect(tools(r)[0]).toMatchObject({ tool: 'SEARCH_TRAINS', status: 'TIMEOUT', outcome: 'TIMEOUT' });
    expect(r.turnLog.diagnostics.steps.timeouts).toBe(1);
    expect(toolMsgs(h.fake, 1)[0]).toMatchObject({ ok: false, outcome: 'TIMEOUT' });
  });

  it('[13] provider FAILURE (availability): bounded retry, honest failure, "seat nahi hai" never survives', async () => {
    const h = native({ ...START, '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A mein seat nahi hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    rail.mode.avail = 'fail';
    const n0 = { ...rail.n };
    const r = await h.say('12497 3A availability');
    expect(delta(n0).avail).toBe(2); // original + one retry, never more
    expect(shown(r)).not.toMatch(/seat nahi hai/i);
    expect(tools(r).map(t => `${t.outcome}:${t.attempt}`)).toEqual(['PROVIDER_FAILURE:1', 'PROVIDER_FAILURE:2']);
    expect(text(r)).toContain(SAFE_ERROR_MESSAGE.PROVIDER_UNAVAILABLE); // after the (real) selection notes
  });

  it('[13b] MALFORMED provider data: never "no trains", never committed, not retried', async () => {
    rail.mode.search = 'malformed';
    const h = native({ 'Kal Amritsar se Delhi': [{ calls: [SRCH('kal')] }, { content: 'Kal Amritsar se Delhi ke liye koi train nahi mili.' }] });
    const r = await h.say('Kal Amritsar se Delhi');
    expect(rail.n.search).toBe(1);
    expect(shown(r)).not.toMatch(/koi train nahi/i);
    expect(text(r)).toBe(SAFE_ERROR_MESSAGE.PROVIDER_DATA_INVALID);
    expect(tools(r)[0]).toMatchObject({ outcome: 'MALFORMED_DATA', errorCode: 'PROVIDER_DATA_INVALID' });
    expect(h.s().searchResults?.trains?.length || 0).toBe(0);
    // MockLLM (offline default) gives the same honest category
    const m = mock();
    const r2 = await m.say('Kal Amritsar se Delhi');
    expect(tools(r2)[0]).toMatchObject({ outcome: 'MALFORMED_DATA' });
    expect(shown(r2)).not.toMatch(/koi train nahi/i);
  });

  it('[13c] a REAL empty search keeps the LLM\'s "koi train nahi mili" (NO_RESULTS is the only zero-result evidence)', async () => {
    rail.mode.search = 'empty';
    const h = native({ 'Kal Amritsar se Delhi': [{ calls: [SRCH('kal')] }, { content: 'Kal Amritsar se Delhi ke liye koi train nahi mili.' }] });
    const r = await h.say('Kal Amritsar se Delhi');
    expect(text(r)).toMatch(/koi train nahi mili/);
    expect(tools(r)[0]).toMatchObject({ outcome: 'NO_RESULTS', resultCount: 0 });
    expect(toolMsgs(h.fake, 1)[0]).toMatchObject({ ok: true, outcome: 'NO_RESULTS' });
  });

  it('[13d] UNSUPPORTED tool → honest "not available", never an empty list', async () => {
    const h = native({ 'Aaj kaunsi trains cancel hui?': [{ calls: [{ name: 'GET_CANCELLED_TRAINS', args: { date: 'aaj' } }] }, { content: 'Aaj koi train cancel nahi hui.' }] });
    const r = await h.say('Aaj kaunsi trains cancel hui?');
    expect(shown(r)).not.toMatch(/koi train cancel nahi hui/i);
    expect((r.turnLog.diagnostics.outcomeClaims || []).some((d: any) => d.kind === 'NO_RESULTS' && d.reason === 'NO_RESULTS_CLAIM_ON_UNSUPPORTED')).toBe(true);
  });

  it('[13e] MOCK data is never presented as "live"; "railway data ke according" needs provider data', async () => {
    const h = native({ ...START, 'Pehli train kab chalti hai?': [{ content: 'Live data ke hisaab se 12014 subah 04:55 par chalti hai.' }],
      'Tatkal ke rules kya hain?': [{ content: 'Railway data ke according Tatkal ek din pehle khulta hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('Pehli train kab chalti hai?');
    expect(shown(r)).not.toMatch(/live data/i);
    expect(rejected(r)).toContain('OUTCOME_CLAIM:MOCK_DATA_PRESENTED_AS_LIVE');
    const g = native({ 'Tatkal ke rules kya hain?': [{ content: 'Railway data ke according Tatkal ek din pehle khulta hai. Tatkal quota limited hota hai.' }] });
    const r2 = await g.say('Tatkal ke rules kya hain?');
    expect(shown(r2)).not.toMatch(/Railway data ke according/i);
    expect(shown(r2)).toMatch(/quota limited/);
  });

  it('[14] ambiguous / invalid reference → nothing guessed, selection unchanged', async () => {
    const h = native({ ...START, 'Paanchvi wali': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 5 })] }, { content: 'Kaunsi train? List mein 3 trainein hain.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('Paanchvi wali');
    expect(h.s().selectedTrain).toBeFalsy();
    expect(shown(r)).not.toMatch(/paanchvi wali \d{5}/i);
  });
});

describe('P32 G3 — freshness, parity, truth, boundaries', () => {
  it('[15] same-turn duplicate call → ONE provider call', async () => {
    const h = native({ ...START, '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A'), CAV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say('12497 3A availability');
    expect(delta(n0).avail).toBe(1);
    expect(r.turnLog.diagnostics.binding.duplicateCallPrevented).toBe(true);
  });

  it('[16] new-turn enquiry ("dobara check karo") → a FRESH provider call (no cross-turn cache)', async () => {
    const plan = [{ calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }];
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, ...plan], 'Dobara check karo': plan });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const n0 = { ...rail.n };
    const r = await h.say('Dobara check karo');
    expect(delta(n0).avail).toBe(1);
    expect(tools(r)[0]).toMatchObject({ tool: 'CHECK_AVAILABILITY', fresh: true, outcome: 'DATA' });
  });

  it('[17] voice / text parity: same tools, same outcomes, same validated text (voice = TTS of the same reply)', async () => {
    const res: Record<string, any> = {};
    for (const mode of ['TEXT', 'VOICE'] as const) {
      Object.assign(rail, { mode: { search: 'timeout' } });
      const h = native({ 'Kal Amritsar se Delhi': [{ calls: [SRCH('kal')] }, { content: 'Koi train nahi mili.' }] });
      const r = await h.say('Kal Amritsar se Delhi', mode);
      res[mode] = { tools: tools(r).map(t => `${t.tool}:${t.outcome}`), rej: rejected(r), text: text(r) };
      expect(shown(r)).not.toMatch(/koi train nahi/i);
    }
    expect(res.VOICE.tools).toEqual(res.TEXT.tools);
    expect(res.VOICE.rej).toEqual(res.TEXT.rej);
    expect(res.VOICE.text).toBe(res.TEXT.text);
  });

  it('[18] truthful action claim: "fare check kar liya" without a GET_FARE call is removed', async () => {
    const h = native({ ...START, 'Theek hai': [{ content: 'Maine 12497 ka fare check kar liya hai. Kaunsi class chahiye?' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('Theek hai');
    expect(shown(r)).not.toMatch(/fare check kar liya/i);
    expect(rail.n.fare || 0).toBe(0);
  });

  it('[19] no stale fact: after a date change, yesterday\'s availability is not restated without a fresh check', async () => {
    const h = native({ ...START, '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }],
      'Parso ka dekho': [{ calls: [SRCH('parso')] }, { content: 'Parso ke liye bhi 12497 mein 3A available hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A availability');
    const n0 = { ...rail.n };
    const r = await h.say('Parso ka dekho');
    expect(delta(n0).avail).toBe(0);
    expect(shown(r)).not.toMatch(/3A available hai/);
    // the stale sentence never reaches the user (removed by the availability authority, or — after a carry-over changed
    // the session post-loop — the agent text is not used at all)
    expect(shown(r)).not.toMatch(/Parso ke liye bhi 12497/);
  });

  it('[20] booking stays disabled: booking / payment tools are rejected; no handoff, no PNR, no fake success', async () => {
    const h = native({ ...START, 'Book karke payment kar do': [{ calls: [{ name: 'BOOK_TICKET', args: {} }, { name: 'MAKE_PAYMENT', args: {} }] }, { content: 'Booking ho gayi, PNR 4512345678.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('Book karke payment kar do');
    expect(tools(r).map(t => `${t.tool}:${t.status}`)).toEqual(['BOOK_TICKET:REJECTED', 'MAKE_PAYMENT:REJECTED']);
    expect(shown(r)).not.toMatch(/Booking ho gayi|4512345678/);
    expect(h.s().bookingState).not.toMatch(/CONFIRMED|BOOKED|COMPLETE/);
  });

  it('[21] secrets never leave the server: no key in any turn output, tool message or diagnostics', () => {
    expect(outputs.length).toBeGreaterThan(20);
    for (const o of outputs) { expect(o).not.toContain(KEY); expect(o).not.toContain('"sourceResultId"'); }
  });
});
