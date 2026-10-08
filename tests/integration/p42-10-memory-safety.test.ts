/**
 * PROMPT 42.10 — Group 2: BookKaro Memory safety (existing session memory + session preferences; no new store).
 * Real orchestrator + turn engine, fake OpenAI-compatible server plays Muse, mock railway provider — no network.
 *   [1] a harmless preference (class family / time window) is stored        [2] and retrieved into Muse's context
 *   [3] the current explicit request overrides the preference                 [4] a fare is never answered from memory
 *   [5] availability is never answered from memory                            [6] a date correction invalidates old context
 *   [7] a memory failure does not break a railway search                      [8] sensitive data never enters memory / LLM / logs
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { memoryContextView } from '../../server/ai/context/context-builder';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('p4210-memory', () => new MockRailwayProvider());
const ist = (days: number) => new Date(Date.now() + 5.5 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1), D2 = ist(2);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = (date = D1) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const SECRET = 'Pa55w0rd-IRCTC-9931';
function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P4210-MEMORY', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { fake, views, say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>, s: () => state.getSession(sid) as any };
}
const text = (r: any) => String(r?.voice?.assistantText ?? r?.responseMessage ?? '');
const execs = (r: any) => ((r?.turnLog?.toolExecutions || []) as any[]).map(x => x.tool);
const rejectedOf = (r: any) => ((r?.turnLog?.naturalSpeech?.rejected || []) as any[]).map((x: any) => String(x?.reason ?? x));
const ctxOf = (h: ReturnType<typeof stack>, user: string) => h.views.filter(x => x.user === user).at(-1)!.context.context;
let fetchSpy: any;
beforeEach(() => { railwayRegistry.setActive('p4210-memory'); fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('P42.10 G2 — BookKaro Memory safety', () => {
  it('[1][2] a harmless preference is stored in session memory and retrieved into the next turn context (text + voice share it)', async () => {
    const h = stack({
      'Mujhe subah ki trains pasand hain, AC chahiye': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGERS', { preferredClassRaw: 'AC', preferredTimeRaw: 'MORNING' })] }, { content: 'Theek hai, subah aur AC yaad rakhunga. Kahan jaana hai?' }],
      'Mujhe subah ki trains pasand hain, AC chahiye, yaad rakhna': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGERS', { preferredClassRaw: 'AC', preferredTimeRaw: 'MORNING' })] }, { content: 'Theek hai, subah aur AC yaad rakhunga. Kahan jaana hai?' }],
      'Kal Amritsar se Delhi': [{ content: 'Theek hai.' }]
    });
    await h.say('Mujhe subah ki trains pasand hain, AC chahiye');
    expect(h.s().preferredClass ?? null).toBeNull();                                                    // P-2 (authorized change): no remember instruction → not saved
    expect(h.s().preferredTime ?? null).toBeNull();
    await h.say('Mujhe subah ki trains pasand hain, AC chahiye, yaad rakhna');                           // explicit remember instruction → saved
    expect(h.s()).toMatchObject({ preferredClass: 'AC', preferredTime: 'MORNING' });
    await h.say('Kal Amritsar se Delhi', 'VOICE');                                                       // same session memory in voice
    const ctx = ctxOf(h, 'Kal Amritsar se Delhi');
    expect(ctx.sessionView).toMatchObject({ preferredClass: 'AC', preferredTime: 'MORNING' });
    expect(ctx.memory.contextVersion).toBeTruthy();
  }, 30000);

  it('[3] the current explicit request overrides the remembered preference (AC preferred → user selects + checks SL → SL is used)', async () => {
    const spy = vi.spyOn(MockRailwayProvider.prototype as any, 'checkAvailability');
    const h = stack({
      'AC chahiye': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGERS', { preferredClassRaw: 'AC' })] }, { content: 'Theek hai.' }],
      'AC chahiye, yaad rakhna': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGERS', { preferredClassRaw: 'AC' })] }, { content: 'Theek hai.' }],
      'search': [{ calls: [SEARCH()] }, { content: 'Trains mil gayi.' }],
      '12497 SL wali': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'SL', selectionPurpose: 'BOOKING' })] }, { content: 'Theek hai.' }],
      '12497 mein SL availability check karo': [{ calls: [{ name: 'CHECK_AVAILABILITY', args: { trainNumber: '12497', travelClass: 'SL', date: D1 } }] }, { content: 'Theek hai.' }]
    });
    // search first (the mock provider — unlike the live adapters — narrows classes by a session class preference, Prompt 16)
    await h.say('search');
    await h.say('AC chahiye');
    expect(h.s().preferredClass ?? null).toBeNull();                                                    // P-2 (authorized change): an ordinary request is not saved
    await h.say('AC chahiye, yaad rakhna');                                                             // explicit remember instruction → saved
    expect(h.s().preferredClass).toBe('AC');
    await h.say('12497 SL wali');
    expect(h.s().selectedClass).toBe('SL');                                                             // the explicit class, not the remembered family
    const r = await h.say('12497 mein SL availability check karo');
    expect(execs(r)).toContain('CHECK_AVAILABILITY');
    const asked = spy.mock.calls.map(c => String((c[0] as any)?.travelClass ?? (c[0] as any)?.classCode ?? '').toUpperCase());
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every(c => c === 'SL')).toBe(true);                                                    // never the remembered family
    expect(h.s().preferredClass).toBe('AC');                                                            // preference kept, not applied
  }, 30000);

  it('[4][5] memory never carries fare / availability; a fare or seat claim without a fresh tool result is not accepted', () => {
    const s: any = new ConversationStateManager().createSession();
    Object.assign(s, { origin: 'ASR', destination: 'NDLS', date: D1, fare: { trainNumber: '12497', travelClass: 'CC', date: D1, total: 850 },
      availability: { trainNumber: '12497', classCode: 'CC', travelClass: 'CC', date: D1, status: 'AVAILABLE-0010' } });
    const mem = JSON.stringify(memoryContextView(s));
    expect(mem).not.toMatch(/fare|850|AVAILABLE-00|availability/i);
  });

  it('[4][5] e2e: after a date change, Muse cannot answer the current fare / availability from remembered values', async () => {
    const h = stack({
      'search': [{ calls: [SEARCH()] }, { content: 'Trains mil gayi.' }],
      '12497 CC': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'CC', selectionPurpose: 'BOOKING' })] }, { content: 'Theek hai.' }],
      'fare batao': [{ calls: [{ name: 'GET_FARE', args: { trainNumber: '12497', travelClass: 'CC', date: D1 } }] }, { content: 'Theek hai.' }],
      'kal nahi parso': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: D2 })] }, { content: 'Date badal di.' }],
      '12497 ka current fare aur CC availability?': [{ content: 'Parso 12497 CC ka fare ₹850 hai. Parso 12497 mein CC available hai.' }]
    });
    await h.say('search'); await h.say('12497 CC'); await h.say('fare batao');
    await h.say('kal nahi parso');
    expect(h.s().fare ?? null).toBeNull();
    const r = await h.say('12497 ka current fare aur CC availability?');
    expect(execs(r)).toEqual([]);
    expect(text(r)).not.toMatch(/₹\s?850|CC available hai/);
    expect(rejectedOf(r).length).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('[6] a date correction invalidates old railway context; memory journeyVersion moves; no old result in memory', async () => {
    const h = stack({
      'search': [{ calls: [SEARCH()] }, { content: 'Trains mil gayi.' }],
      'kal nahi parso': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: D2 })] }, { content: 'Date badal di.' }],
      'next': [{ content: 'Theek hai.' }]
    });
    await h.say('search');
    const before = h.s().journeyVersion;
    await h.say('kal nahi parso');
    await h.say('next');
    expect(h.s().date).toBe(D2);
    expect(h.s().journeyVersion).toBeGreaterThan(before);
    const ctx = ctxOf(h, 'next');
    expect(ctx.memory.journeyVersion).toBeGreaterThan(before);
    expect(ctx.memory.sameTrainShown).toBeUndefined();
    expect(h.s().availability).toBeUndefined();
  }, 30000);

  it('[7] a memory failure (corrupt memory data → memoryContextView throws) does not break a railway search', async () => {
    const h = stack({ 'Kal Amritsar se Delhi ki trains': [{ calls: [SEARCH()] }, { content: 'Kal ke liye trains mil gayi.' }] });
    const s = h.s();
    s.sameTrainAutoSets = { corrupt: true };                                                             // not iterable
    expect(() => memoryContextView(s)).toThrow();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
    const r = await h.say('Kal Amritsar se Delhi ki trains');
    logSpy.mockRestore();
    expect(execs(r)).toContain('SEARCH_TRAINS');
    expect((h.s().searchResults?.trains || []).length).toBeGreaterThan(0);
    expect(h.views[0].context.context.memory).toBeUndefined();                                          // memory omitted, turn continues
    const ev = logs.filter(l => l.includes('"event":"memory_unavailable"')).map(l => JSON.parse(l));
    expect(ev.length).toBeGreaterThanOrEqual(1);
    expect(Object.keys(ev[0]).sort()).toEqual(['errorType', 'event', 'memoryRead']);                     // safe metadata only
  }, 30000);

  it('[8] sensitive data is refused, never stored in session memory, never sent to Muse, never logged', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
    const h = stack({});
    const r = await h.say(`Mera IRCTC password ${SECRET} hai, yaad rakhna`);
    const r2 = await h.say('OTP 482913 hai');
    logSpy.mockRestore();
    expect(text(r)).toMatch(/password, OTP/i);
    expect(text(r2)).toMatch(/password, OTP/i);
    expect(JSON.stringify(h.fake.decisionRequests.map(q => q.body))).not.toMatch(new RegExp(`${SECRET}|482913`));
    expect(JSON.stringify(h.s())).not.toMatch(new RegExp(`${SECRET}|482913`));
    expect(JSON.stringify(memoryContextView(h.s()))).not.toMatch(new RegExp(`${SECRET}|482913`));
    expect(logs.join('\n')).not.toMatch(new RegExp(`${SECRET}|482913`));
  }, 30000);
});
