/**
 * PROMPT 28 — G3: tool-result identity binding + multi-step accuracy through the FULL agent stack
 *   user → ConversationTurnEngine → orchestrator → LLM decides → validator → RailwayToolRuntime → (labelled, non-live)
 *   mock railway spy → identity-bound result back to the LLM → … → reply whose every railway claim is entity-bound.
 * MockLLM (offline) for A–D, I, N; the native OpenAI-compatible adapter against an injected fake server for E–H, J–M
 * (the "LLM" there deliberately writes cross-entity claims / duplicate calls). No network, no credits, no booking.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { FORBIDDEN_SUCCESS_CLAIMS } from '../../server/ai/turn-engine/mock-conversation-scenarios';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { MockBookingProvider } from '../../server/booking/testing/mock-booking-provider';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; calls: Array<[string, string, string, string]> = [];
  private b(k: string, r: any) { this.n[k] = (this.n[k] || 0) + 1; this.calls.push([k, String(r?.trainNumber ?? ''), String(r?.travelClass ?? ''), String(r?.date ?? '')]); }
  async searchTrains(r: any): Promise<any> { this.b('search', r); return super.searchTrains(r); }
  async getTrainInfo(r: any): Promise<any> { this.b('info', r); return super.getTrainInfo(r); }
  async getTimetable(r: any): Promise<any> { this.b('tt', r); return super.getTimetable(r); }
  async checkAvailability(r: any): Promise<any> { this.b('avail', r); return super.checkAvailability(r); }
  async getFare(r: any): Promise<any> { this.b('fare', r); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p28-spy', () => rail);

const KEY = 'sk-live-P28-E2E-SECRET-88888';
const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;
const outputs: string[] = [];
function wire(llm: any) {
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = async (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => { const r: any = await eng.processTurn(sid, t, mode); outputs.push(JSON.stringify({ r, s: state.getSession(sid) })); return r; };
  return { state, sid, say, s: () => state.getSession(sid) as any };
}
const mock = () => wire(new MockLLMProvider({}));
function native(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  return { views, fake, ...wire(sel.provider) };
}
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = (date: string) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const SEL = (num: string, cls?: string) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: num }, ...(cls ? { classRaw: cls } : {}), selectionPurpose: 'INFORMATION' });
const AV = (num: string, cls: string) => ({ name: 'CHECK_AVAILABILITY', args: { trainNumber: num, travelClass: cls } });
const FARE = (num: string, cls: string) => ({ name: 'GET_FARE', args: { trainNumber: num, travelClass: cls } });
const START = { 'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' }] };
const binding = (r: any) => r.turnLog.diagnostics.binding;
const chain = (r: any) => r.turnLog.diagnostics.chain;
const text = (r: any) => String(r.voice?.assistantText ?? '');
const both = (r: any) => `${text(r)}\n${r.responseMessage ?? ''}`;
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'info', 'tt', 'avail', 'fare'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));
const BOOK_CLAIM = new RegExp(FORBIDDEN_SUCCESS_CLAIMS.join('|'), 'i');

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any, execSpies: any[] = [];
const envBefore = process.env.REAL_IRCTC_ENABLED;
beforeEach(() => {
  railwayRegistry.setActive('p28-spy');
  Object.assign(rail, { n: {}, calls: [] });
  outputs.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(((url: any, init: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    throw new Error('network forbidden in tests');
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff execution forbidden'); });
  execSpies = [vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking'), vi.spyOn(MockBookingProvider.prototype, 'executeBooking')];
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  for (const s of execSpies) expect(s).not.toHaveBeenCalled();
  expect(process.env.REAL_IRCTC_ENABLED).toBe(envBefore);
  for (const out of outputs) {
    const o = JSON.parse(out);
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/"bookingState":"COMPLETE"/);
    // internal ids / result refs / provenance never reach the user-facing text
    for (const t of [o.r?.voice?.assistantText, o.r?.responseMessage]) {
      expect(String(t ?? '')).not.toMatch(/\b(search|availability|fare|timetable|info)-\d+\b|toolResultId|te_[0-9a-f]|sourceResultId/i);
      expect(String(t ?? '')).not.toMatch(BOOK_CLAIM);
    }
  }
  fetchSpy.mockRestore(); handoffSpy.mockRestore(); for (const s of execSpies) s.mockRestore();
  railwayRegistry.setActive('mock');
});

describe('P28 G3 — knowledge vs live facts', () => {
  it('[A] "RAC kya hota hai?" → answered with ZERO tool calls (no forced provider call)', async () => {
    const h = mock(); const r = await h.say('RAC kya hota hai?');
    expect(binding(r)).toMatchObject({ toolCallCount: 0, claimBindingStatus: 'NONE' });
    expect(delta({})).toEqual({ search: 0, info: 0, tt: 0, avail: 0, fare: 0 });
    expect(text(r)).toMatch(/RAC/);
  });

  it('[B] Shatabdi vs Vande Bharat → ZERO tool calls', async () => {
    const h = mock(); const r = await h.say('Shatabdi aur Vande Bharat mein kya difference hai?');
    expect(binding(r).toolCallCount).toBe(0);
    expect(delta({})).toEqual({ search: 0, info: 0, tt: 0, avail: 0, fare: 0 });
    expect(text(r)).toMatch(/Vande Bharat/);
  });
});

describe('P28 G3 — search, display index, class + fare binding', () => {
  it('[C] "Kal Amritsar se Delhi ki morning trains dikhao" → SEARCH_TRAINS once; the result identity carries route + canonical date', async () => {
    const h = mock(); const r = await h.say('Kal Amritsar se Delhi ki morning trains dikhao');
    expect(binding(r).toolSequence).toEqual(['SEARCH_TRAINS']);
    expect(binding(r).toolEntity[0]).toEqual({ origin: 'ASR', destination: 'NDLS', date: KAL });
    expect(delta({}).search).toBe(1);
    expect(binding(r).entityBindingStatus).toBe('BOUND');
  });

  it('[D] "Beech wali mein 3A ka fare batao" → display reference on the CURRENT set (12497) → class validated → GET_FARE bound to 12497/3A; 2-train set → asks, never guesses', async () => {
    const h = mock(); await h.say('Kal Amritsar se Delhi trains batao');
    const n0 = { ...rail.n };
    const r = await h.say('Beech wali mein 3A ka fare batao');
    expect(delta(n0)).toMatchObject({ fare: 1, avail: 0, search: 0 });
    // Prompt 35: GET_FARE carries the authoritative session date (live providers price per date)
    expect(rail.calls.at(-1)).toEqual(['fare', '12497', '3A', '2026-10-05']);
    expect(binding(r).toolEntity.at(-1)).toMatchObject({ trainNumber: '12497', class: '3A', date: KAL });
    expect(text(r)).toMatch(/₹650/);
    expect(binding(r).claimBindingStatus).toBe('BOUND');
    // the "morning" set has 2 trains → no middle train exists → clarification, no tool
    const m = mock(); await m.say('Kal Amritsar se Delhi ki morning trains dikhao');
    const n1 = { ...rail.n };
    const q = await m.say('Beech wali mein 3A ka fare batao');
    expect(delta(n1)).toMatchObject({ fare: 0, avail: 0 });
    expect(text(q)).toMatch(/12014[\s\S]*12497/);
  });
});

describe('P28 G3 — no cross-train / cross-class / cross-date facts', () => {
  it('[E] with 12497 3A ₹650 and 12014 CC fares in hand, "12014 ka fare ₹650 hai" is rejected (cross-train); the 12497 sentence stays', async () => {
    const h = native({ ...START,
      '12497 3A aur 12014 CC dono ka fare': [{ calls: [SEL('12497', '3A')] }, { calls: [FARE('12497', '3A')] }, { calls: [SEL('12014', 'CC')] }, { calls: [FARE('12014', 'CC')] },
        { content: '12014 ka fare ₹650 hai. 12497 ka 3A fare ₹650 per passenger hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('12497 3A aur 12014 CC dono ka fare');
    expect(delta({}).fare).toBe(2);
    for (const t of [text(r), String(r.responseMessage)]) expect(t).not.toMatch(/12014 ka fare ₹650/);
    expect(text(r)).toMatch(/12497 ka 3A fare ₹650/);
    expect(binding(r).crossEntityRejections).toContain('FARE_MISMATCH:650');
    expect(r.turnLog.naturalSpeech).toBeTruthy();
  });

  it('[F] a 12497/3A availability result never proves "12497 CC available hai" (cross-class) — removed; the 3A claim stays', async () => {
    const h = native({ ...START,
      '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [AV('12497', '3A')] }, { content: '12497 CC available hai. 12497 mein 3A available hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('12497 3A availability');
    expect(text(r)).not.toMatch(/CC available/);
    expect(text(r)).toMatch(/12497 mein 3A available/);
    expect(binding(r).claimBindingStatus).toBe('CROSS_ENTITY_REMOVED');
  });

  it('[G] a date-A (kal) result claimed for date B (parso) without a new call → rejected; no provider call is invented', async () => {
    const h = native({ ...START,
      '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [AV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }],
      'Aur parso ka?': [{ content: 'Parso bhi 12497 mein 3A available hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A availability');
    const n0 = { ...rail.n };
    const r = await h.say('Aur parso ka?');
    expect(delta(n0)).toEqual({ search: 0, info: 0, tt: 0, avail: 0, fare: 0 });
    expect(text(r)).not.toMatch(/parso bhi 12497 mein 3A available/i);
    expect(r.turnLog.naturalSpeech.rejected.length).toBeGreaterThan(0);
  });

  it('[H] "kal nahi parso" → fresh search for parso, re-selection by the LLM (followUp is information only), fresh dependent checks for parso', async () => {
    const h = native({ ...START,
      '12497 3A availability aur fare': [{ calls: [SEL('12497', '3A')] }, { calls: [AV('12497', '3A'), FARE('12497', '3A')] }, { content: '12497 mein 3A available hai, fare ₹650 per passenger.' }],
      'Kal nahi parso, 12497 3A hi': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' })] }, { calls: [SEARCH('parso')] },
        { calls: [SEL('12497', '3A')] }, { calls: [AV('12497', '3A'), FARE('12497', '3A')] }, { content: 'Parso bhi 12497 mein 3A available hai, fare ₹650 per passenger.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A availability aur fare');
    const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso, 12497 3A hi');
    expect(delta(n0)).toMatchObject({ search: 1, avail: 1, fare: 1 });
    expect(rail.calls.slice(-3).map(c => c[0])).toEqual(expect.arrayContaining(['avail', 'fare']));
    expect(rail.calls.filter(c => c[0] === 'avail').at(-1)).toEqual(['avail', '12497', '3A', PARSO]);
    const searchMsg = h.views.filter(v => v.user === 'Kal nahi parso, 12497 3A hi')[2].results.at(-1)!.content;
    expect(searchMsg.followUp).toMatchObject({ inFreshResults: true, classListed: true, selectionKept: false });
    expect(h.s()).toMatchObject({ date: PARSO, selectedClass: '3A' });
    expect(Object.values(h.s().availability || {}).every((a: any) => a.date === PARSO)).toBe(true);
    expect(binding(r)).toMatchObject({ claimBindingStatus: 'BOUND', stepLimitReached: false, duplicateCallPrevented: false });
    expect(binding(r).llmCallCount).toBeLessThanOrEqual(5);
    expect(text(r)).toMatch(/12497/);
  });
});

describe('P28 G3 — language, GK with numbers, multi-tool binding', () => {
  it('[I] "Which train reaches Delhi earliest?" → an English answer from the returned times', async () => {
    const h = mock(); await h.say('Kal Amritsar se Delhi trains batao');
    const r = await h.say('Which train reaches Delhi earliest?');
    expect(text(r)).toMatch(/12014/); expect(text(r)).toMatch(/earliest|reaches/i);
    expect(text(r)).not.toMatch(/\b(hai|hain|chahiye)\b/);
  });

  it('[J] "RAC cancellation hone par kya hota hai?" with numbers (RAC 1, 2 passengers, WL 1) → kept; zero tools', async () => {
    const GK = 'RAC mein 2 passengers ek side lower berth share karte hain. Agar kisi confirmed passenger ki ticket cancel hoti hai, to RAC 1 wale ko poori berth mil jaati hai. Chart banne ke baad WL 1 wala RAC mein aa sakta hai.';
    const h = native({ 'RAC cancellation hone par kya hota hai?': [{ content: GK }] });
    const r = await h.say('RAC cancellation hone par kya hota hai?');
    expect(binding(r).toolCallCount).toBe(0);
    expect(r.turnLog.naturalSpeech.rejected).toEqual([]);
    expect(text(r)).toMatch(/RAC 1/); expect(text(r)).toMatch(/WL 1/);
  });

  it('[K] "12014 ki 3A availability aur fare" → 3A not listed → rejected BEFORE the provider; then 12497 3A → two tools, both bound to 12497/3A', async () => {
    const h = native({ ...START,
      '12014 ki 3A availability aur fare batao': [{ calls: [SEL('12014', '3A')] }, { calls: [AV('12014', '3A'), FARE('12014', '3A')] }, { content: '12014 mein 3A class listed nahi hai — sirf CC aur 2S.' }],
      '12497 ki 3A availability aur fare batao': [{ calls: [SEL('12497', '3A')] }, { calls: [AV('12497', '3A'), FARE('12497', '3A')] }, { content: '12497 mein 3A available hai, fare ₹650 per passenger.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const k = await h.say('12014 ki 3A availability aur fare batao');
    expect(delta(n0)).toMatchObject({ avail: 0, fare: 0 });
    expect(chain(k).steps.every((s: any) => s.decisionReason.startsWith('REJECTED'))).toBe(true);
    const err = h.views.filter(v => v.user === '12014 ki 3A availability aur fare batao')[2].results.at(-1)!.content;
    expect(err.error).toMatchObject({ errorType: expect.any(String), tool: expect.any(String), retryable: false });
    const n1 = { ...rail.n };
    const r = await h.say('12497 ki 3A availability aur fare batao');
    expect(delta(n1)).toMatchObject({ avail: 1, fare: 1 });
    expect(binding(r).toolEntity).toEqual([{ trainNumber: '12497', date: KAL, class: '3A' }, { trainNumber: '12497', date: KAL, class: '3A' }]);
    expect(binding(r)).toMatchObject({ entityBindingStatus: 'BOUND', claimBindingStatus: 'BOUND' });
    expect(text(r)).toMatch(/12497[\s\S]*₹650/);
  });
});

describe('P28 G3 — efficiency, correction, parity', () => {
  it('[L] an identical repeated call in the same turn → provider called ONCE (existing result returned; not a cache)', async () => {
    const h = native({ ...START,
      '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [AV('12497', '3A')] }, { calls: [AV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = { ...rail.n };
    const r = await h.say('12497 3A availability');
    expect(delta(n0).avail).toBe(1);
    expect(binding(r).duplicateCallPrevented).toBe(true);
    // a NEW turn asking again → fresh provider call (no cross-turn reuse)
    const n1 = { ...rail.n };
    await h.say('12497 3A availability');
    expect(delta(n1).avail).toBe(1);
  });

  it('[M] "Actually CC" → class changes → a FRESH CC availability call (new info resets the guard)', async () => {
    const h = native({ ...START,
      '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [AV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }],
      'Actually CC': [{ calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: 'CC' })] }, { calls: [AV('12497', 'CC')] }, { content: '12497 CC ki availability dekh li hai.' }] });
    await h.say('Kal Amritsar se Delhi jaana hai'); await h.say('12497 3A availability');
    const n0 = { ...rail.n };
    const r = await h.say('Actually CC', 'VOICE');
    expect(delta(n0).avail).toBe(1);
    expect(rail.calls.at(-1)).toEqual(['avail', '12497', 'CC', KAL]);
    expect(binding(r).toolEntity.at(-1)).toEqual({ trainNumber: '12497', date: KAL, class: 'CC' });
    expect(binding(r).duplicateCallPrevented).toBe(false);
  });

  it('[N] voice / text parity: the same request → same tools, same bound entities, same claim binding; voice is not longer', async () => {
    const t = mock(); const v = mock();
    const rt = await t.say('Kal Amritsar se Delhi 12497 ki 3A availability aur fare batao', 'TEXT');
    const rv = await v.say('Kal Amritsar se Delhi 12497 ki 3A availability aur fare batao', 'VOICE');
    expect(binding(rv).toolSequence).toEqual(binding(rt).toolSequence);
    expect(binding(rv).toolEntity).toEqual(binding(rt).toolEntity);
    expect(binding(rv).claimBindingStatus).toBe(binding(rt).claimBindingStatus);
    expect(binding(rt).toolEntity.filter((e: any) => e?.trainNumber)).toEqual(expect.arrayContaining([expect.objectContaining({ trainNumber: '12497', class: '3A', date: KAL })]));
    for (const r of [rt, rv]) { expect(text(r)).toMatch(/3A/); expect(both(r)).toMatch(/12497/); }
    expect(text(rv).length).toBeLessThanOrEqual(Math.max(text(rt).length, String(rt.responseMessage).length));
  });
});
