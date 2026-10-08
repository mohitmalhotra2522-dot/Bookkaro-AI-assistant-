/**
 * Post-audit P-2 + P-3 — saved preferences vs search.
 * Real orchestrator + turn engine; a fake OpenAI-compatible server plays Muse; mock railway provider — no network.
 *   P-2  only an explicit remember / save instruction creates or updates a SAVED preference:
 *        [1] an ordinary search filter (SEARCH_TRAINS preferredClass / preferredTime) is never saved
 *        [2] ordinary class / time wording proposed via update_booking_session is not saved
 *        [3] "AC prefer hai, yaad rakhna" / "Mujhe hamesha AC chahiye, yaad rakhna" / "Prefer 3A, isse remember karna" are saved
 *        [4] a save that did not happen is never confirmed ("yaad rakh liya" → honest "save nahi ho paayi")
 *   P-3  a saved preference never silently filters SEARCH_TRAINS:
 *        [5] saved class / time preference → the provider request carries no filter; every train and class is returned
 *        [6] a CURRENT-turn explicit filter still applies to that search only
 *        [7] the saved preference stays visible to Muse as context, never as an injected tool constraint
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
import { explicitPreferenceSaveRequested } from '../../server/ai/context/preference-save-grounding';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('post-audit-p2p3', () => new MockRailwayProvider());
const ist = (d: number) => new Date(Date.now() + 5.5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1), D2 = ist(2);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const PREF = (e: any) => U('UPDATE_JOURNEY', 'NO_ACTION', e);
const SEARCH = (extra: any = {}, date = D1) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date, ...extra } });
type Mode = 'TEXT' | 'VOICE';
const MODES: Mode[] = ['TEXT', 'VOICE'];

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-POSTAUDIT-P2P3', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { fake, views, say: (t: string, m: Mode) => eng.processTurn(sid, t, m) as Promise<any>, s: () => state.getSession(sid) as any,
    events: () => (state as any).getEvents ? (state as any).getEvents(sid) : null,
    lastView: (u: string) => views.filter(v => v.user === u).at(-1)! };
}
const shown = (r: any) => String(r?.voice?.assistantText ?? r?.responseMessage ?? '');
const sessionOutcome = (v: TurnView) => v.results.find(x => x.name === 'update_booking_session')?.content;
const trainNums = (s: any) => ((s.searchResults?.trains || []) as any[]).map(t => String(t.trainNumber ?? t.number));
const classCodes = (s: any) => [...new Set(((s.searchResults?.trains || []) as any[]).flatMap(t => (t.classes || []).map((c: any) => c.code)))].sort();
const SAVED_CLAIM = /yaad rakh (liya|li)|save kar (liya|li)/i;

let fetchSpy: any;
let searchSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('post-audit-p2p3');
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  searchSpy = vi.spyOn(MockRailwayProvider.prototype, 'searchTrains');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const lastSearchReq = () => searchSpy.mock.calls.at(-1)![0] as any;

describe('P-2 — only an explicit remember / save instruction creates a saved preference', () => {
  it('[unit] explicitPreferenceSaveRequested: remember / save / always markers (any script); ordinary search wording and negations are not', () => {
    for (const t of ['AC prefer hai, yaad rakhna', 'Mujhe hamesha AC chahiye, yaad rakhna', 'Prefer 3A, isse remember karna', 'Shaam prefer hai, yaad rakh lo',
      'Future mein raat ki trains prefer karunga, save kar lena', 'मुझे AC पसंद है, याद रखना', 'हमेशा AC चाहिए', 'always book AC for me', 'AC yaad rakhna, SL nahi chahiye']) {
      expect(explicitPreferenceSaveRequested(t), t).toBe(true);
    }
    for (const t of ['AC trains dikhao', 'shaam ki trains', '3A mein trains dikhao', 'subah wali trains', 'Amritsar se Delhi kal ki AC trains dikhao', 'AC chahiye',
      'AC aur 3A mein kya difference hai?', 'AC yaad mat rakhna', 'save mat karo', "don't remember this", 'yaad rakhne ki zarurat nahi', 'याद मत रखना', '']) {
      expect(explicitPreferenceSaveRequested(t), t).toBe(false);
    }
  });

  for (const mode of MODES) {
    it(`[1] ordinary search filters are never saved: "AC trains dikhao" / "3A mein trains dikhao" / "shaam ki trains" / "subah wali trains" (${mode})`, async () => {
      const cases: Array<[string, any]> = [
        ['Amritsar se Delhi kal ki AC trains dikhao', { preferredClass: 'AC' }],
        ['Amritsar se Delhi kal 3A mein trains dikhao', { preferredClass: 'AC' }],
        ['Amritsar se Delhi kal shaam ki trains', { preferredTime: 'EVENING' }],
        ['Amritsar se Delhi kal subah wali trains', { preferredTime: 'MORNING' }]
      ];
      for (const [utt, filter] of cases) {
        const h = stack({ [utt]: [{ calls: [SEARCH(filter)] }, { content: 'Trains mil gayi.' }], 'theek hai': [{ content: 'Aapki preference yaad rakh li hai.' }] });
        await h.say(utt, mode);
        expect(lastSearchReq(), utt).toMatchObject(filter);                                  // the current-turn filter reached the provider
        expect(h.s().preferredClass ?? null, utt).toBeNull();
        expect(h.s().preferredTime ?? null, utt).toBeNull();
        const r = await h.say('theek hai', mode);                                            // a later false memory claim is not confirmed
        expect(shown(r), utt).not.toMatch(SAVED_CLAIM);
      }
    }, 60000);

    it(`[2] ordinary class / time wording proposed as a preference is NOT saved (rejected PREFERENCE_NOT_EXPLICIT); no success claim (${mode})`, async () => {
      const cases: Array<[string, any]> = [
        ['AC chahiye', { preferredClassRaw: 'AC' }],
        ['3A mein trains dikhao', { preferredClassRaw: '3A' }],
        ['shaam ki trains', { preferredTimeRaw: 'EVENING' }],
        ['subah wali trains', { preferredTimeRaw: 'MORNING' }]
      ];
      for (const [utt, ent] of cases) {
        const h = stack({ [utt]: [{ calls: [PREF(ent)] }, (v: TurnView) => ({ content: JSON.stringify(sessionOutcome(v) || {}).match(/CLASS_PREFERENCE_SET|TIME_PREFERENCE_SET/) ? 'WRONG: applied' : 'Preference yaad rakh li.' })] });
        const r = await h.say(utt, mode);
        expect(h.s().preferredClass ?? null, utt).toBeNull();
        expect(h.s().preferredTime ?? null, utt).toBeNull();
        expect(JSON.stringify(sessionOutcome(h.lastView(utt)) || {}), utt).not.toMatch(/CLASS_PREFERENCE_SET|TIME_PREFERENCE_SET/);
        expect(shown(r), utt).not.toMatch(SAVED_CLAIM);                                     // Muse's false "yaad rakh li" is removed
        expect(shown(r), utt).toMatch(/save nahi ho paayi/);
        expect(JSON.stringify(r.turnLog?.diagnostics?.rejectedProposals ?? r.turnLog ?? {}), utt).toMatch(/preferred(Class|Time)/);
      }
    }, 60000);

    it(`[3] explicit remember instructions ARE saved and confirmed (${mode})`, async () => {
      const cases: Array<[string, any, string, string]> = [
        ['AC prefer hai, yaad rakhna', { preferredClassRaw: 'AC' }, 'preferredClass', 'AC'],
        ['Mujhe hamesha AC chahiye, yaad rakhna', { preferredClassRaw: 'AC' }, 'preferredClass', 'AC'],
        ['Prefer 3A, isse remember karna', { preferredClassRaw: '3A' }, 'preferredClass', 'AC'],   // stored as its class family (existing design)
        ['Shaam prefer hai, yaad rakhna', { preferredTimeRaw: 'EVENING' }, 'preferredTime', 'EVENING']
      ];
      for (const [utt, ent, field, want] of cases) {
        const h = stack({ [utt]: [{ calls: [PREF(ent)] }, (v: TurnView) => ({ content: JSON.stringify(sessionOutcome(v) || {}).match(/CLASS_PREFERENCE_SET|TIME_PREFERENCE_SET/) ? 'Theek hai, preference yaad rakh liya.' : 'WRONG' })] });
        const r = await h.say(utt, mode);
        expect(h.s()[field], utt).toBe(want);
        expect(shown(r), utt).toBe('Theek hai, preference yaad rakh liya.');
      }
    }, 60000);

    it(`[4] a save that did not happen is never confirmed: no tool call / invalid value / negated instruction (${mode})`, async () => {
      const h = stack({
        'AC prefer hai, yaad rakhna': [{ content: 'AC preference yaad rakh liya.' }],                                       // Muse never called the tool
        // invalid value (berth / seat wording itself is passenger-flow territory, outside the session preference guard by design)
        'Window seat yaad rakhna': [{ calls: [PREF({ preferredClassRaw: 'window' })] }, { content: 'AC preference yaad rakh li hai.' }],
        'AC yaad mat rakhna': [{ calls: [PREF({ preferredClassRaw: 'AC' })] }, { content: 'AC preference yaad rakh liya.' }]          // negated
      });
      for (const u of ['AC prefer hai, yaad rakhna', 'Window seat yaad rakhna', 'AC yaad mat rakhna']) {
        const r = await h.say(u, mode);
        expect(h.s().preferredClass ?? null, u).toBeNull();
        expect(shown(r), u).not.toMatch(SAVED_CLAIM);
        expect(shown(r), u).toMatch(/save nahi ho paayi/);
      }
    }, 60000);
  }
});

describe('P-3 — a saved preference never silently filters SEARCH_TRAINS', () => {
  for (const mode of MODES) {
    it(`[5] saved AC / EVENING preference → plain search: provider request unfiltered, all trains + all classes returned (${mode})`, async () => {
      const h = stack({
        'AC prefer hai, yaad rakhna': [{ calls: [PREF({ preferredClassRaw: 'AC' })] }, { content: 'Ok.' }],
        'Shaam prefer hai, yaad rakhna': [{ calls: [PREF({ preferredTimeRaw: 'EVENING' })] }, { content: 'Ok.' }],
        'Amritsar se Delhi parso ki trains': [{ calls: [SEARCH({}, D2)] }, { content: 'Trains mil gayi.' }]
      });
      await h.say('AC prefer hai, yaad rakhna', mode);
      await h.say('Shaam prefer hai, yaad rakhna', mode);
      expect(h.s()).toMatchObject({ preferredClass: 'AC', preferredTime: 'EVENING' });
      await h.say('Amritsar se Delhi parso ki trains', mode);
      expect(lastSearchReq()).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: D2, preferredClass: 'ANY', preferredTime: 'ANY' });
      expect(trainNums(h.s())).toEqual(['12014', '12497', '18238']);                       // morning trains are not hidden
      expect(classCodes(h.s())).toEqual(['2S', '3A', 'CC', 'SL']);                          // non-AC classes are not hidden
      expect(h.s()).toMatchObject({ preferredClass: 'AC', preferredTime: 'EVENING' });      // the saved preference itself is kept
    }, 60000);

    it(`[6] a CURRENT-turn explicit filter still applies to that search only, and is not saved (${mode})`, async () => {
      const h = stack({
        'Amritsar se Delhi kal shaam ki AC trains': [{ calls: [SEARCH({ preferredTime: 'EVENING', preferredClass: 'AC' })] }, { content: 'Ok.' }],
        'Kal nahi, parso ki trains': [{ calls: [SEARCH({}, D2)] }, { content: 'Ok.' }]
      });
      await h.say('Amritsar se Delhi kal shaam ki AC trains', mode);
      expect(lastSearchReq()).toMatchObject({ preferredTime: 'EVENING', preferredClass: 'AC' });
      expect(trainNums(h.s())).toEqual(['18238']);
      expect(classCodes(h.s())).toEqual(['3A']);
      await h.say('Kal nahi, parso ki trains', mode);
      expect(lastSearchReq()).toMatchObject({ date: D2, preferredClass: 'ANY', preferredTime: 'ANY' });
      expect(trainNums(h.s())).toEqual(['12014', '12497', '18238']);
      expect(h.s().preferredClass ?? null).toBeNull();
      expect(h.s().preferredTime ?? null).toBeNull();
    }, 60000);

    it(`[7] the saved preference is context for Muse, never injected into the SEARCH_TRAINS tool arguments / provider request (${mode})`, async () => {
      const h = stack({
        'AC prefer hai, yaad rakhna': [{ calls: [PREF({ preferredClassRaw: 'AC' })] }, { content: 'Ok.' }],
        'Amritsar se Delhi kal ki trains': [{ calls: [SEARCH()] }, { content: 'Ok.' }]
      });
      await h.say('AC prefer hai, yaad rakhna', mode);
      await h.say('Amritsar se Delhi kal ki trains', mode);
      const v = h.lastView('Amritsar se Delhi kal ki trains');
      expect(JSON.stringify(v.context)).toMatch(/"preferredClass":"AC"/);                  // visible to Muse as conversational context
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect(lastSearchReq().preferredClass).toBe('ANY');                                   // not a hidden constraint
      const search = v.results.find(x => x.name === 'SEARCH_TRAINS')?.content;
      expect(JSON.stringify(search)).not.toMatch(/"preferredClass":"AC"/);
    }, 60000);
  }
});
