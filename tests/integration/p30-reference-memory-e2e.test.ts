/**
 * PROMPT 30 — G3: contextual reference resolution through the FULL stack
 *   user → ConversationTurnEngine → orchestrator → LLM interprets the reference → applier / validator → railway tool
 *   runtime → mock railway spy → LLM answers → fact guards → entity / date binding → action guard → REFERENCE-CLAIM
 *   GUARD (step 7) → text + TTS.
 * The native OpenAI-compatible adapter runs against an injected fake server (the "LLM" there makes the interpretation —
 * sometimes a wrong one); MockLLM covers the offline default. No network, credits, booking, handoff or real IRCTC.
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

const pmeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p30-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; calls: Array<[string, string, string, string]> = []; omit: { date: string; train: string } | null = null;
  private b(k: string, r: any) { this.n[k] = (this.n[k] || 0) + 1; this.calls.push([k, String(r?.trainNumber ?? ''), String(r?.travelClass ?? ''), String(r?.date ?? '')]); }
  async searchTrains(r: any): Promise<any> {
    this.b('search', r);
    const res: any = await super.searchTrains(r);
    if (this.omit && res.ok && r.date === this.omit.date) res.data = { ...res.data, trains: res.data.trains.filter((t: any) => t.trainNumber !== this.omit!.train) };
    return res;
  }
  async checkAvailability(r: any): Promise<any> { this.b('avail', r); return super.checkAvailability(r); }
  async getFare(r: any): Promise<any> { this.b('fare', r); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p30-spy', () => rail);
void pmeta;

const KEY = 'sk-live-P30-E2E-SECRET-30303';
const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;
const outputs: string[] = [];
function wire(llm: any) {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
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
const SRCH = (date: string) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const REF = (trainRef: any, extra: any = {}) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef, selectionPurpose: 'INFORMATION', ...extra });
const SEL = (num: string, cls?: string) => REF({ kind: 'TRAIN_NUMBER', value: num }, cls ? { classRaw: cls } : {});
const CAV = (num: string, cls: string) => ({ name: 'CHECK_AVAILABILITY', args: { trainNumber: num, travelClass: cls } });
const CFARE = (num: string, cls: string) => ({ name: 'GET_FARE', args: { trainNumber: num, travelClass: cls } });
const UPDATE_PARSO = U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' });
const START = { 'Kal Amritsar se Delhi jaana hai': [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' }] };
const refs = (r: any) => r.turnLog.diagnostics.references as { records: any[]; claims: any[] };
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage, r.voice?.speechText, ...(r.voice?.segments || [])].map(x => String(x ?? ''));
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'avail', 'fare'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p30-spy');
  Object.assign(rail, { n: {}, calls: [], omit: null });
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

describe('P30 G3 — references across turns (full stack)', () => {
  it('[A] search → "doosri wali": the LLM\'s DISPLAY_INDEX 2 binds to the current set\'s second train; a true position claim stays', async () => {
    const h = native({ ...START, 'Doosri wali': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 2 })] }, { content: 'Doosri wali 12497 hai — Shan-e-Punjab.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const second = currentResults(h.s())[1].trainNumber;
    const r = await h.say('Doosri wali');
    expect(h.s().selectedTrain.number).toBe(second);
    expect(h.s().focusTrainNumber).toBe(second);
    expect(refs(r).records[0]).toMatchObject({ via: 'SELECTION', referenceType: 'DISPLAY_INDEX', displayIndex: 2, status: 'VALID', source: { date: KAL } });
    expect(String(r.voice.assistantText)).toMatch(/Doosri wali 12497 hai/);
    expect(refs(r).claims.every((c: any) => c.status === 'VALID')).toBe(true);
  });

  it('[B] → "iska 3A fare": the fare is called for the FOCUS train + 3A; the reply is bound to it', async () => {
    const h = native({ ...START, 'Doosri wali': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 2 })] }, { content: 'Theek hai, 12497.' }],
      'Iska 3A fare batao': [{ calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: '3A', selectionPurpose: 'INFORMATION' })] }, { calls: [CFARE('12497', '3A')] }, { content: '12497 mein 3A ka fare ₹650 per passenger hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('Doosri wali');
    const n0 = { ...rail.n };
    const r = await h.say('Iska 3A fare batao');
    expect(delta(n0)).toMatchObject({ fare: 1, avail: 0, search: 0 });
    expect(rail.calls.filter(c => c[0] === 'fare').slice(-1)[0].slice(1, 3)).toEqual(['12497', '3A']);
    expect(String(r.voice.assistantText)).toMatch(/650/);
    expect(refs(r).records.find((x: any) => x.tool === 'GET_FARE')).toMatchObject({ status: 'VALID', resolvedTrainNumber: '12497', displayIndex: 2 });
  });

  it('[C] "last wali" (text, MockLLM default and native) → the last train of the current set', async () => {
    const m = mock();
    await m.say('Kal Amritsar se Delhi');
    const list = currentResults(m.s());
    await m.say('last wali');
    expect(m.s().selectedTrain.number).toBe(list[list.length - 1].trainNumber);
    const h = native({ ...START, 'Last wali': [{ calls: [REF({ kind: 'DEMONSTRATIVE', value: 'LAST' })] }, { content: 'Last wali 18238 hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('Last wali');
    expect(h.s().selectedTrain.number).toBe('18238');
    expect(refs(r).records[0]).toMatchObject({ resolutionType: 'POSITION', status: 'VALID' });
  });

  it('[D] "12014 wali" — an explicit train wins over the current focus', async () => {
    const h = native({ ...START, 'Doosri wali': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 2 })] }, { content: 'Theek hai, 12497.' }],
      '12014 wali': [{ calls: [SEL('12014')] }, { content: 'Theek hai, 12014.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('Doosri wali');
    expect(h.s().focusTrainNumber).toBe('12497');
    const r = await h.say('12014 wali');
    expect(h.s().selectedTrain.number).toBe('12014');
    expect(h.s().focusTrainNumber).toBe('12014');
    expect(refs(r).records[0]).toMatchObject({ referenceType: 'TRAIN_NUMBER', resolvedTrainNumber: '12014', status: 'VALID' });
  });

  it('[E] date change → fresh search → "doosri wali" uses the NEW set; an old-version index is refused; a wrong position claim is removed', async () => {
    const h = native({ ...START,
      'Kal nahi parso': [{ calls: [UPDATE_PARSO] }, { calls: [SRCH('parso')] }, { content: 'Parso ke liye trainein mil gayi.' }],
      'Doosri wali': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 2 })] }, { content: 'Doosri wali 12497 hai. Pehli wali 12497 thi.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const oldVersion = h.s().searchResultsVersion;
    const n0 = { ...rail.n };
    await h.say('Kal nahi parso');
    expect(delta(n0)).toMatchObject({ search: 1, avail: 0, fare: 0 });                 // only the LLM's own search
    expect(h.s().searchResultsVersion).toBeGreaterThan(oldVersion);
    const r = await h.say('Doosri wali');
    expect(h.s().selectedTrain.number).toBe(currentResults(h.s())[1].trainNumber);
    expect(refs(r).records[0]).toMatchObject({ status: 'VALID', source: { date: PARSO } });
    expect(String(r.voice.assistantText)).toMatch(/Doosri wali 12497 hai/);
    expect(String(r.voice.assistantText)).not.toMatch(/Pehli wali 12497/);
    // the LLM quoting the OLD list's version is refused (never silently mapped onto the new list)
    const h3 = native({ ...START, 'Doosri wali': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 2, searchResultsVersion: -1 })] }, { content: 'Kaunsi train?' }] });
    await h3.say('Kal Amritsar se Delhi jaana hai');
    const r3 = await h3.say('Doosri wali');
    expect(h3.s().selectedTrain).toBeUndefined();
    expect(refs(r3).records[0].status).toBe('STALE');
  });

  it('[F] the old train is absent from the new date: no silent replacement, the false "ismein bhi hai" claim is removed, the LLM sees it only as an expired preference', async () => {
    rail.omit = { date: PARSO, train: '12497' };
    const h = native({ ...START, '12497 wali': [{ calls: [SEL('12497')] }, { content: 'Theek hai, 12497.' }],
      'Kal nahi parso': [{ calls: [UPDATE_PARSO] }, { calls: [SRCH('parso')] }, { content: '12497 parso ki list mein bhi hai. Parso ke liye trainein mil gayi.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 wali');
    const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso');
    expect(delta(n0)).toMatchObject({ avail: 0, fare: 0 });
    expect(h.s().selectedTrain).toBeUndefined();
    for (const t of shown(r)) expect(t).not.toMatch(/12497 parso ki list mein bhi hai/);
    // removed by the first guard that catches it (railway-fact step 1 UNGROUNDED_NUMBER, or step-7 NOT_IN_CURRENT_RESULTS)
    expect(r.turnLog.diagnostics.validation.rejected.join(',')).toMatch(/UNGROUNDED_NUMBER:12497|NOT_IN_CURRENT_RESULTS:12497/);
    expect(h.s().staleReference).toMatchObject({ trainNumber: '12497', date: KAL, reason: 'DATE_CHANGED' });
    // the next LLM call receives it as an expired preference (no ids)
    const last = h.fake.decisionRequests[h.fake.decisionRequests.length - 1];
    const ctxMsg = String(last.body.messages.find((m: any) => m.role === 'system' && String(m.content).startsWith('AUTHORITATIVE SESSION CONTEXT'))?.content || '');
    expect(ctxMsg).toMatch(/previousChoiceForOlderJourney/);
    expect(ctxMsg).toMatch(/"factsExpired":true/);
  });

  it('[G] availability → same train asked again in a NEW turn → a fresh provider call (no cross-turn cache)', async () => {
    const h = native({ ...START, '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
      'Availability batao': [{ calls: [CAV('12497', '3A')] }, { content: 'Ho gaya.' }],
      'Iski availability phir se batao': [{ calls: [CAV('12497', '3A')] }, { content: 'Ho gaya.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A');
    const n0 = { ...rail.n };
    await h.say('Availability batao');
    const r = await h.say('Iski availability phir se batao');
    expect(delta(n0).avail).toBe(2);
    expect(refs(r).records.find((x: any) => x.tool === 'CHECK_AVAILABILITY')).toMatchObject({ status: 'VALID', resolvedTrainNumber: '12497' });
  });

  it('[H] voice "doosri wali" resolves exactly like text (same pipeline, same train, same record)', async () => {
    const t = mock(); const v = mock();
    await t.say('Kal Amritsar se Delhi'); await v.say('Kal Amritsar se Delhi', 'VOICE');
    const rt = await t.say('doosri wali'); const rv = await v.say('doosri wali', 'VOICE');
    expect(v.s().selectedTrain.number).toBe(t.s().selectedTrain.number);
    const strip = (x: any) => ({ ...x, source: x.source && { ...x.source, toolResultId: null, turnId: null } });
    expect(strip(refs(rv).records[0])).toEqual(strip(refs(rt).records[0]));
    expect(rv.voice.speechText || rv.voice.assistantText).toBeTruthy();
  });

  it('[I] ambiguous "uska fare" (nothing in focus) → clarification; no fare call, nothing selected', async () => {
    const h = native({ ...START, 'Uska fare batao': [{ calls: [REF({ kind: 'DEMONSTRATIVE', value: 'THIS' })] }, { content: 'Kaunsi train — 12014, 12497 ya 18238?' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say('Uska fare batao');
    expect(delta(n0)).toMatchObject({ fare: 0, avail: 0 });
    expect(h.s().selectedTrain).toBeUndefined();
    expect(refs(r).records[0]).toMatchObject({ status: 'AMBIGUOUS', ambiguityReason: 'NO_FOCUS_MULTIPLE_RESULTS' });
    expect(String(r.voice.assistantText)).toMatch(/\?/);
    expect(String(r.voice.assistantText)).not.toMatch(/₹/);
  });

  it('[J] "RAC kya hota hai?" uses no tool and creates no reference; secrets / ids never leak anywhere', async () => {
    const h = native({ ...START, 'RAC kya hota hai?': [{ content: 'RAC matlab Reservation Against Cancellation — aadhi berth confirm hoti hai, chart ke baad poori mil sakti hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say('RAC kya hota hai?');
    expect(delta(n0)).toEqual({ search: 0, avail: 0, fare: 0 });
    expect(r.turnLog.diagnostics.toolCalls).toBe(0);
    expect(refs(r)).toEqual({ records: [], claims: [] });
    expect(String(r.voice.assistantText)).toMatch(/RAC/);
    for (const o of outputs) expect(o).not.toContain(KEY);
    for (const t of shown(r)) expect(t).not.toMatch(/\bturn_|\btx_|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
