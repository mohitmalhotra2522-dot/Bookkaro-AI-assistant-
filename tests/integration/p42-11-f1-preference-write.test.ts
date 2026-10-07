/**
 * Post-P42.10 — Group 2 (F1): explicit preference memory WRITE through the existing update_booking_session path.
 * Real orchestrator + turn engine, fake OpenAI-compatible server plays Muse, mock railway provider — no network.
 *   [1] "AC prefer hai, yaad rakhna" → Muse's update_booking_session reaches the existing applier (preferredClass AC)
 *   [2] backend update succeeds → the "yaad rakh liya" confirmation is kept
 *   [3] backend update fails / is never sent → the reply must NOT claim it was saved (honest "save nahi ho paayi")
 *   [4] "AC aur 3A mein kya difference hai?" → no memory write (no backend keyword routing)
 *   [5] an explicit current class choice overrides the preference
 *   [6] the preference stays in later turns' context (existing session preference architecture)
 *   [tool] the LLM-facing contract names the preference path; [unit] claim guard boundaries
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
import { nativeToolDefs } from '../../server/ai/providers/openai-compatible-llm';
import { NATIVE_AGENT_SYSTEM_PROMPT } from '../../server/ai/prompts/system-prompt';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { guardPreferenceClaims, detectPreferenceClaim } from '../../server/ai/response/preference-claims';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('p4211-f1', () => new MockRailwayProvider());
const ist = (days: number) => new Date(Date.now() + 5.5 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const PREF = (cls: string) => U('UPDATE_JOURNEY', 'NO_ACTION', { preferredClassRaw: cls });
const SEARCH = { name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: D1 } };
function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P4211-F1', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { fake, views, say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>, s: () => state.getSession(sid) as any };
}
const text = (r: any) => String(r?.voice?.assistantText ?? r?.responseMessage ?? '');
const screen = (r: any) => String(r?.responseMessage ?? '');
const updates = (h: ReturnType<typeof stack>) => h.fake.decisionRequests.flatMap(q => (q.body?.messages || []) as any[])
  .flatMap((m: any) => m.tool_calls || []).filter((c: any) => c.function?.name === 'update_booking_session');
const ctxOf = (h: ReturnType<typeof stack>, user: string) => h.views.filter(x => x.user === user).at(-1)!.context.context;
let fetchSpy: any;
beforeEach(() => { railwayRegistry.setActive('p4211-f1'); fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('Post-P42.10 G2 (F1) — explicit preference write + no false memory confirmation', () => {
  it('[tool] the LLM-facing contract: update_booking_session names preferences; valid preferredClassRaw values; prompt rule', () => {
    const defs = nativeToolDefs({ tools: REGISTERED_TOOLS } as any);
    const upd = defs.find((d: any) => d.function.name === 'update_booking_session').function;
    expect(upd.description).toMatch(/remember a travel preference/);
    expect(upd.parameters.properties.entities.properties.preferredClassRaw.description).toMatch(/AC \| NON_AC \| ANY/);
    expect(upd.parameters.properties.entities.properties.preferredClassRaw.description).not.toMatch(/e\.g\. AC \/ sleeper/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/PREFERENCES \(memory\)/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/ONLY when the outcome shows\s+it applied/);
  });

  it('[1][2] "AC prefer hai, yaad rakhna" → update_booking_session → applier stores AC → confirmation kept', async () => {
    const h = stack({ 'Mujhe AC class prefer hai, yaad rakhna.': [{ calls: [PREF('AC')] },
      (v: TurnView) => ({ content: JSON.stringify(v.results[0]?.content || {}).includes('CLASS_PREFERENCE_SET') ? 'AC class preference yaad rakh liya. Kahan jaana hai?' : 'WRONG' })] });
    const r = await h.say('Mujhe AC class prefer hai, yaad rakhna.');
    expect(updates(h).length).toBe(1);
    expect(h.s().preferredClass).toBe('AC');
    expect(text(r)).toBe('AC class preference yaad rakh liya. Kahan jaana hai?');
    expect(r.turnLog?.diagnostics?.preferenceClaims?.[0]).toMatchObject({ validationStatus: 'VALID', claimedClass: 'AC', sessionClass: 'AC' });
  }, 30000);

  it('[3] update not sent (the production F1 case) or rejected → no "yaad rakh liya"; honest "save nahi ho paayi" (text + voice)', async () => {
    const h = stack({
      'Mujhe AC class prefer hai, yaad rakhna.': [{ content: 'AC class preference yaad rakh liya. Ab batao kahan jaana hai?' }],            // no tool call
      'Window seat preference yaad rakhna, aur AC bhi': [{ calls: [PREF('window')] }, { content: 'AC preference yaad rakh li hai.' }],      // invalid value → rejected
      'Future mein raat ki trains prefer karunga, save kar lena': [{ content: 'Theek hai, raat ki trains ki preference save kar li.' }] });
    const r1 = await h.say('Mujhe AC class prefer hai, yaad rakhna.');
    expect(h.s().preferredClass ?? null).toBeNull();
    expect(text(r1)).not.toMatch(/yaad rakh liya/i);
    expect(screen(r1)).toMatch(/Ye preference abhi save nahi ho paayi\./);
    expect(screen(r1)).toMatch(/kahan jaana hai\?/i);                                                     // rest of the reply kept
    expect(r1.turnLog?.diagnostics?.preferenceClaims?.[0]).toMatchObject({ validationStatus: 'REJECTED', removalReason: 'PREFERENCE_NOT_SAVED' });
    const r2 = await h.say('Window seat preference yaad rakhna, aur AC bhi', 'VOICE');
    expect(h.s().preferredClass ?? null).toBeNull();
    expect(text(r2)).not.toMatch(/yaad rakh li/i);
    expect(screen(r2)).toMatch(/save nahi ho paayi/);
    const r3 = await h.say('Future mein raat ki trains prefer karunga, save kar lena');
    expect(h.s().preferredTime ?? null).toBeNull();
    expect(text(r3)).not.toMatch(/save kar li/i);
  }, 30000);

  it('[4] "AC aur 3A mein kya difference hai?" → Muse answers, no update_booking_session, nothing stored (no backend keyword write)', async () => {
    const h = stack({ 'AC aur 3A mein kya difference hai?': [{ content: '3A ek AC class hai — AC 3 tier. AC ka matlab air-conditioned coaches.' }] });
    const r = await h.say('AC aur 3A mein kya difference hai?');
    expect(updates(h).length).toBe(0);
    expect(h.s().preferredClass ?? null).toBeNull();
    expect(text(r)).toMatch(/3A ek AC class hai/);
  }, 30000);

  it('[5] "AC prefer karta hoon, but is baar SL kar do" → the explicit current choice (SL) wins over the AC preference', async () => {
    const h = stack({
      'Kal Amritsar se Delhi ki trains dikhao': [{ calls: [SEARCH] }, { content: 'Kal ke liye trains mil gayi.' }],
      'AC prefer karta hoon, yaad rakhna': [{ calls: [PREF('AC')] }, { content: 'AC preference yaad rakh liya.' }],
      'But is baar 12497 SL kar do': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'SL', selectionPurpose: 'BOOKING' })] },
        { calls: [{ name: 'CHECK_AVAILABILITY', args: {} }] }, { content: '12497 mein SL Waitlist 12 hai.' }] });
    const spy = vi.spyOn(MockRailwayProvider.prototype, 'checkAvailability');
    await h.say('Kal Amritsar se Delhi ki trains dikhao');
    await h.say('AC prefer karta hoon, yaad rakhna');
    expect(h.s().preferredClass).toBe('AC');
    await h.say('But is baar 12497 SL kar do');
    expect(h.s().selectedClass).toBe('SL');
    expect(spy.mock.calls.at(-1)![0]).toMatchObject({ trainNumber: '12497', travelClass: 'SL' });
    expect(h.s().preferredClass).toBe('AC');                                                              // preference kept, not applied over the choice
  }, 30000);

  it('[6] the saved preference stays in later turns\' context (TEXT → VOICE), never as a seat / fare fact', async () => {
    const h = stack({ 'AC class preference save kar lena': [{ calls: [PREF('AC')] }, { content: 'AC preference save kar li.' }],
      'Meri class preference kya hai?': [{ content: 'Aapki class preference AC hai.' }] });
    await h.say('AC class preference save kar lena');
    const r = await h.say('Meri class preference kya hai?', 'VOICE');
    const ctx = ctxOf(h, 'Meri class preference kya hai?');
    expect(JSON.stringify(ctx)).toMatch(/"preferredClass":"AC"/);
    expect(text(r)).toBe('Aapki class preference AC hai.');
    expect(h.s().availability).toBeUndefined(); expect(h.s().fare).toBeUndefined();
  }, 30000);

  it('[unit] claim guard boundaries: offers, negations, passenger "noted", berth wording and matching session state', () => {
    expect(detectPreferenceClaim('AC preference yaad rakhun?')).toBeNull();                                   // offer
    expect(detectPreferenceClaim('AC preference save nahi ho paayi.')).toBeNull();                            // negation
    expect(detectPreferenceClaim('Naam note kar liya.')).toBeNull();                                          // passenger detail, no preference
    expect(detectPreferenceClaim('Lower berth preference note kar li.')).toBeNull();                          // berth = passenger flow
    expect(detectPreferenceClaim('AC class preference yaad rakh liya.')).toMatchObject({ claimedClass: 'AC' });
    expect(detectPreferenceClaim("Got it, I'll remember you prefer morning trains.")).toMatchObject({ claimedTime: 'MORNING' });
    expect(guardPreferenceClaims('Non-AC preference yaad rakh liya.', { preferredClass: 'AC' }).removed.length).toBe(1);   // mismatch
    expect(guardPreferenceClaims('AC preference yaad rakh liya.', { preferredClass: 'AC' }).removed.length).toBe(0);
    expect(guardPreferenceClaims("I'll remember you prefer morning trains.", {}).text).toBe("I couldn't save that preference right now.");
    expect(guardPreferenceClaims('एसी पसंद याद रख लिया।', {}).text).toBe('यह पसंद अभी सेव नहीं हो पाई।');
  });
});
