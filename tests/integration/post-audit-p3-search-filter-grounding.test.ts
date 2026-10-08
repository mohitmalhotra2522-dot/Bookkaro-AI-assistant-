/**
 * Post-audit P-3 follow-up — SEARCH_TRAINS filter arguments must be grounded in the CURRENT user turn.
 * Live staging showed Muse copying saved preferences (AC + evening) into a plain "parso ki trains" search.
 * Real orchestrator + turn engine; a fake OpenAI-compatible server plays Muse (and deliberately copies the saved
 * preference into its tool arguments); mock railway provider (honours filters → any leak is visible). No network.
 *   [1] saved AC + evening → plain search: filters stripped from the provider request + validated arguments; result set
 *       identical to a fresh session; saved preferences still in session + Muse context
 *   [2] "parso AC trains dikhao" → AC kept (an injected evening is stripped)
 *   [3] "parso shaam ki trains" → evening kept (an injected AC is stripped)
 *   [4] "parso AC shaam ki trains" → both kept
 *   [5] Devanagari wording grounds the same way
 *   [unit] value-specific grounding table
 * Every behavioural case runs in TEXT and VOICE.
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
import { classFilterGrounded, timeFilterGrounded, groundSearchFilterArgs } from '../../server/ai/context/search-filter-grounding';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('post-audit-p3-filters', () => new MockRailwayProvider());
const ist = (d: number) => new Date(Date.now() + 5.5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const D2 = ist(2);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const PREF = (e: any) => U('UPDATE_JOURNEY', 'NO_ACTION', e);
// Muse copies the saved preference into EVERY search it makes (the live staging behaviour)
const LEAKY_SEARCH = { name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: D2, preferredClass: 'AC', preferredTime: 'EVENING' } };
type Mode = 'TEXT' | 'VOICE';
const MODES: Mode[] = ['TEXT', 'VOICE'];

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-POSTAUDIT-P3F', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { views, say: (t: string, m: Mode) => eng.processTurn(sid, t, m) as Promise<any>, s: () => state.getSession(sid) as any,
    lastView: (u: string) => views.filter(v => v.user === u).at(-1)! };
}
const trainNums = (s: any) => ((s.searchResults?.trains || []) as any[]).map(t => String(t.trainNumber ?? t.number));
const classCodes = (s: any) => [...new Set(((s.searchResults?.trains || []) as any[]).flatMap(t => (t.classes || []).map((c: any) => c.code)))].sort();
const validatedSearchArgs = (r: any) => ((r.turnLog?.toolResults || []) as any[]).filter(t => t.toolName === 'SEARCH_TRAINS').at(-1)?.validatedArguments;
const SAVES = {
  'AC prefer hai, yaad rakhna': [{ calls: [PREF({ preferredClassRaw: 'AC' })] }, { content: 'Ok.' }],
  'Shaam prefer hai, yaad rakhna': [{ calls: [PREF({ preferredTimeRaw: 'EVENING' })] }, { content: 'Ok.' }]
};
async function saveBoth(h: ReturnType<typeof stack>, mode: Mode) {
  await h.say('AC prefer hai, yaad rakhna', mode);
  await h.say('Shaam prefer hai, yaad rakhna', mode);
  expect(h.s()).toMatchObject({ preferredClass: 'AC', preferredTime: 'EVENING' });
}

let fetchSpy: any;
let searchSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('post-audit-p3-filters');
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  searchSpy = vi.spyOn(MockRailwayProvider.prototype, 'searchTrains');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const lastReq = () => searchSpy.mock.calls.at(-1)![0] as any;

describe('P-3 follow-up — SEARCH_TRAINS filters only from the current user turn', () => {
  it('[unit] value-specific grounding: class / time words of THIS message; ANY is never a filter', () => {
    const yes: Array<[string, string, string]> = [['AC', 'C', 'parso AC trains dikhao'], ['AC', 'C', 'parso 3A mein trains'], ['AC', 'C', 'chair car wali'], ['AC', 'C', '3 tier chahiye'],
      ['NON_AC', 'C', 'sleeper trains dikhao'], ['NON_AC', 'C', 'non AC trains'], ['AC', 'C', 'परसों एसी ट्रेन'],
      ['EVENING', 'T', 'parso shaam ki trains'], ['MORNING', 'T', 'subah wali trains'], ['NIGHT', 'T', 'raat ki train'], ['AFTERNOON', 'T', 'dopahar wali'], ['EVENING', 'T', 'परसों शाम की ट्रेन'],
      ['ANY', 'C', 'parso ki trains'], ['ANY', 'T', 'parso ki trains']];
    for (const [v, k, t] of yes) expect(k === 'C' ? classFilterGrounded(v, t) : timeFilterGrounded(v, t), `${v} ← ${t}`).toBe(true);
    const no: Array<[string, string, string]> = [['AC', 'C', 'parso ki trains'], ['AC', 'C', 'non AC trains'], ['AC', 'C', 'acha, parso ki trains'], ['NON_AC', 'C', 'parso AC trains'],
      ['EVENING', 'T', 'parso ki trains'], ['EVENING', 'T', 'parso subah ki trains'], ['MORNING', 'T', 'kal nahi, parso'], ['AC', 'C', 'परसों की ट्रेन'], ['EVENING', 'T', 'परसों की ट्रेन']];
    for (const [v, k, t] of no) expect(k === 'C' ? classFilterGrounded(v, t) : timeFilterGrounded(v, t), `${v} ← ${t}`).toBe(false);
    const g = groundSearchFilterArgs({ origin: 'ASR', preferredClass: 'AC', preferredTime: 'EVENING', passengersCount: 2 }, 'parso shaam ki trains');
    expect(g).toEqual({ args: { origin: 'ASR', preferredTime: 'EVENING', passengersCount: 2 }, stripped: ['preferredClass'] });
  });

  for (const mode of MODES) {
    it(`[1] saved AC + evening → plain "parso ki trains": no filter reaches the provider; result set identical to a fresh session; preferences kept in context (${mode})`, async () => {
      const fresh = stack({ 'Amritsar se Delhi parso ki trains': [{ calls: [{ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: D2 } }] }, { content: 'Ok.' }] });
      await fresh.say('Amritsar se Delhi parso ki trains', mode);
      const freshReq = lastReq();
      const h = stack({ ...SAVES, 'Amritsar se Delhi parso ki trains': [{ calls: [LEAKY_SEARCH] }, { content: 'Ok.' }], 'aur batao': [{ content: 'Ok.' }] });
      await saveBoth(h, mode);
      const r = await h.say('Amritsar se Delhi parso ki trains', mode);
      expect(lastReq()).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: D2, preferredClass: 'ANY', preferredTime: 'ANY' });
      expect(lastReq()).toEqual(freshReq);                                                    // the exact same provider request
      const va = validatedSearchArgs(r);
      expect(va).toBeTruthy();
      expect(va.preferredClass).toBeUndefined();
      expect(va.preferredTime).toBeUndefined();
      expect(trainNums(h.s())).toEqual(trainNums(fresh.s()));
      expect(trainNums(h.s())).toEqual(['12014', '12497', '18238']);
      expect(classCodes(h.s())).toEqual(classCodes(fresh.s()));
      expect(h.s()).toMatchObject({ preferredClass: 'AC', preferredTime: 'EVENING' });        // saved preferences untouched
      await h.say('aur batao', mode);
      expect(JSON.stringify(h.lastView('aur batao').context)).toMatch(/"preferredClass":"AC"/);  // still in Muse's context
      expect(JSON.stringify(h.lastView('aur batao').context)).toMatch(/"preferredTime":"EVENING"/);
    }, 60000);

    it(`[2] "parso AC trains dikhao" → AC allowed (explicit this turn); an injected evening is stripped (${mode})`, async () => {
      const h = stack({ ...SAVES, 'Amritsar se Delhi parso AC trains dikhao': [{ calls: [LEAKY_SEARCH] }, { content: 'Ok.' }] });
      await saveBoth(h, mode);
      const r = await h.say('Amritsar se Delhi parso AC trains dikhao', mode);
      expect(lastReq()).toMatchObject({ preferredClass: 'AC', preferredTime: 'ANY' });
      expect(validatedSearchArgs(r)).toMatchObject({ preferredClass: 'AC' });
      expect(validatedSearchArgs(r).preferredTime).toBeUndefined();
      expect(trainNums(h.s())).toEqual(['12014', '12497', '18238']);
      expect(classCodes(h.s())).toEqual(['3A', 'CC']);
    }, 60000);

    it(`[3] "parso shaam ki trains" → evening allowed; an injected AC is stripped (${mode})`, async () => {
      const h = stack({ ...SAVES, 'Amritsar se Delhi parso shaam ki trains': [{ calls: [LEAKY_SEARCH] }, { content: 'Ok.' }] });
      await saveBoth(h, mode);
      const r = await h.say('Amritsar se Delhi parso shaam ki trains', mode);
      expect(lastReq()).toMatchObject({ preferredClass: 'ANY', preferredTime: 'EVENING' });
      expect(validatedSearchArgs(r)).toMatchObject({ preferredTime: 'EVENING' });
      expect(validatedSearchArgs(r).preferredClass).toBeUndefined();
      expect(trainNums(h.s())).toEqual(['18238']);
      expect(classCodes(h.s())).toEqual(['3A', 'SL']);
    }, 60000);

    it(`[4] "parso AC shaam ki trains" → both allowed — also without any saved preference (${mode})`, async () => {
      const h = stack({ 'Amritsar se Delhi parso AC shaam ki trains': [{ calls: [LEAKY_SEARCH] }, { content: 'Ok.' }] });
      const r = await h.say('Amritsar se Delhi parso AC shaam ki trains', mode);
      expect(lastReq()).toMatchObject({ preferredClass: 'AC', preferredTime: 'EVENING' });
      expect(validatedSearchArgs(r)).toMatchObject({ preferredClass: 'AC', preferredTime: 'EVENING' });
      expect(trainNums(h.s())).toEqual(['18238']);
      expect(classCodes(h.s())).toEqual(['3A']);
      expect(h.s().preferredClass ?? null).toBeNull();                                         // a current-turn filter is not saved (P-2)
    }, 60000);

    it(`[5] Devanagari: "परसों शाम की एसी ट्रेन" keeps both; "परसों की ट्रेन" strips both (${mode})`, async () => {
      const h = stack({ ...SAVES,
        'अमृतसर से दिल्ली परसों शाम की एसी ट्रेन': [{ calls: [LEAKY_SEARCH] }, { content: 'Ok.' }],
        'अमृतसर से दिल्ली परसों की ट्रेन': [{ calls: [LEAKY_SEARCH] }, { content: 'Ok.' }] });
      await saveBoth(h, mode);
      await h.say('अमृतसर से दिल्ली परसों शाम की एसी ट्रेन', mode);
      expect(lastReq()).toMatchObject({ preferredClass: 'AC', preferredTime: 'EVENING' });
      await h.say('अमृतसर से दिल्ली परसों की ट्रेन', mode);
      expect(lastReq()).toMatchObject({ preferredClass: 'ANY', preferredTime: 'ANY' });
      expect(trainNums(h.s())).toEqual(['12014', '12497', '18238']);
    }, 60000);
  }
});
