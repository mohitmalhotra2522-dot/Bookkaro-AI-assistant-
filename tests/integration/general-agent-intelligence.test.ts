/**
 * General Agent Intelligence — capability catalog, generated CAPABILITY ROUTING prompt section, capability-annotated tool
 * descriptions and the one-shot backend fact-authority recovery.
 *
 * Real orchestrator + turn engine + runtime + applier + guards; a fake OpenAI-compatible server plays the native agent
 * (scripted, so these tests prove the PLUMBING and AUTHORITY around the model's decisions — that whatever capability the
 * agent picks reaches the provider through the unchanged validators, that its answers stay grounded, and that a tool-less
 * invented answer is never shown); MOCK railway provider (ASR→NDLS = 1 12014 SHATABDI 04:55 [CC, 2S] · 2 12497
 * SHAN-E-PUNJAB 06:35 [3A Available ₹650, CC RAC 4, SL WL 12, 2S] · 3 18238 19:35 [3A, SL]).
 *   [1]  novel general questions → knowledge answer, no tool, no recovery, one model call
 *   [2]  availability → CHECK_AVAILABILITY            [3] timetable → GET_TIMETABLE      [4] live status → TRACK_TRAIN
 *   [5]  fare → GET_FARE (via grounded selection)      [6] PNR → CHECK_PNR                [7] search → SEARCH_TRAINS
 *   [8]  ambiguous reference → clarification, nothing selected
 *   [9]  current data is never answered from invented knowledge (fact-authority recovery → owning capability; a second
 *        invented answer is stripped, no further recovery)
 *   [10] tool failure / unavailable → no invented facts, no recovery after a tool ran
 *   [11] session context reused (no re-asking; tool arguments from the session)
 *   [12] SELECT_TRAIN grounding stays final (also inside a recovery)
 *   [13] P42-12 authority: an explicit re-check is a fresh provider call; recovery never runs once a railway tool ran
 *   [14] P29 action claims / P42-13 tools untouched
 *   [15] TEXT and VOICE route identically (tool sequence + reply)
 *   [N]  novel phrasings not used anywhere else in the suite
 *   [U]  catalog ↔ registry coverage, prompt section, tool descriptions, pure recovery function
 * No network, no credits, no booking.
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
import { NATIVE_AGENT_SYSTEM_PROMPT, nativeAgentSystemPrompt } from '../../server/ai/prompts/system-prompt';
import { REGISTERED_TOOLS, SEARCH_SAME_TRAIN_ALTERNATIVES_TOOL, PRESENT_SAME_TRAIN_ALTERNATIVES_TOOL } from '../../server/ai/tools/tool-registry';
const SAME_TRAIN_ALTERNATIVE_TOOLS = [SEARCH_SAME_TRAIN_ALTERNATIVES_TOOL, PRESENT_SAME_TRAIN_ALTERNATIVES_TOOL];
import { CAPABILITIES, capabilityRoutingPrompt, capabilityToolNote, UNVERIFIED_FACT_OWNERS } from '../../server/ai/intelligence/capability-catalog';
import { factAuthorityRecovery, FACT_AUTHORITY_INSTRUCTION } from '../../server/ai/intelligence/fact-authority-recovery';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('general-agent-intelligence', () => new MockRailwayProvider());
const ist = (d: number) => new Date(Date.now() + 5.5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1);
const SEARCH = (date = D1) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const AV = (args: any = {}) => ({ name: 'CHECK_AVAILABILITY', args });
const U = (entities: any, intent = 'BOOK_TRAIN', action = 'SELECT_TRAIN') => ({ name: 'update_booking_session', args: { intent, action, entities } });
const NUM = (value: string) => ({ kind: 'TRAIN_NUMBER', value });
const SEARCH_T = 'Amritsar se Delhi kal ki trains dikhao';
type Mode = 'TEXT' | 'VOICE';
const MODES: Mode[] = ['TEXT', 'VOICE'];

/** the backend's structured fact-authority message in a model request (null = none) */
const faOf = (v: TurnView): any => {
  const m = (v.body?.messages || []).find((x: any) => x.role === 'system' && String(x.content).startsWith('BACKEND_FACT_AUTHORITY '));
  return m ? JSON.parse(String(m.content).split('\n')[0].slice('BACKEND_FACT_AUTHORITY '.length)) : null;
};
/** a scripted step that answers differently once the backend asked the agent to decide again */
const onFA = (first: any, retry: any) => (v: TurnView) => (faOf(v) ? (typeof retry === 'function' ? retry(v) : retry) : first);

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-GAI', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { views, fake, say: (t: string, m: Mode) => eng.processTurn(sid, t, m) as Promise<any>, s: () => state.getSession(sid) as any,
    callsFor: (u: string) => views.filter(v => v.user === u).length, viewsFor: (u: string) => views.filter(v => v.user === u) };
}
const shown = (r: any) => String(r?.voice?.assistantText ?? r?.assistantText ?? r?.responseMessage ?? '');
const execs = (r: any) => ((r?.turnLog?.toolExecutions || []) as any[]).map(e => e.tool);
const eventsOf = (r: any) => ((r?.turnLog?.events || []) as any[]).map(e => (typeof e === 'string' ? e : e?.type));
const selectedOf = (h: any) => h.s().selectedTrain ? String(h.s().selectedTrain.number ?? h.s().selectedTrain.trainNumber) : null;
const INTERNAL = /BACKEND_FACT_AUTHORITY|FACT_AUTHORITY|CHECK_AVAILABILITY|GET_TIMETABLE|TRACK_TRAIN|GET_FARE|CHECK_PNR|SEARCH_TRAINS|tool|capabilit|guard|routing/i;

let fetchSpy: any, availSpy: any, ttSpy: any, fareSpy: any, trackSpy: any, pnrSpy: any, searchSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('general-agent-intelligence');
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  availSpy = vi.spyOn(MockRailwayProvider.prototype, 'checkAvailability');
  ttSpy = vi.spyOn(MockRailwayProvider.prototype as any, 'getTimetable');
  fareSpy = vi.spyOn(MockRailwayProvider.prototype, 'getFare');
  trackSpy = vi.spyOn(MockRailwayProvider.prototype, 'trackTrain');
  pnrSpy = vi.spyOn(MockRailwayProvider.prototype, 'checkPNR');
  searchSpy = vi.spyOn(MockRailwayProvider.prototype, 'searchTrains');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); railwayRegistry.setActive('mock'); });

describe('General Agent Intelligence — behaviour (MOCK, scripted native agent)', () => {
  for (const mode of MODES) {
    it(`[1] novel general questions → answered from knowledge: no tool, no recovery, one model call, reply unchanged (${mode})`, async () => {
      const QA: Array<[string, string]> = [
        ['Agar ticket RAC pe atki ho toh train mein chadh sakte hain kya?', 'Haan, RAC ticket par aap safar kar sakte hain — berth kisi aur ke saath share hoti hai, chart ke baad full berth mil sakti hai.'],
        ['3A aur sleeper mein AC ke alawa aur kya farak hota hai?', '3A mein bedding milti hai, coach band aur kam bheed wala hota hai; sleeper sasta hai par khula aur garam ho sakta hai.'],
        ['Vande Bharat aur Shatabdi mein se kaunsi zyada modern hai generally?', 'Vande Bharat naya, self-propelled design hai; Shatabdi purani loco-hauled chair car service hai. Dono day trains hain.'],
        ['chart prepare hona matlab kya hota hai exactly', 'Chart banne ka matlab hai final berth allotment ho gaya — uske baad RAC ya waiting ki final sthiti pata chalti hai.']
      ];
      const h = stack(Object.fromEntries(QA.map(([q, a]) => [q, [{ content: a }]])));
      for (const [q, a] of QA) {
        const r = await h.say(q, mode);
        expect(h.callsFor(q)).toBe(1);
        expect(execs(r)).toEqual([]);
        expect(eventsOf(r)).not.toContain('FACT_AUTHORITY_RECOVERY');
        expect(h.viewsFor(q).some(faOf)).toBe(false);
        expect(shown(r)).toBe(a);
      }
      for (const s of [availSpy, ttSpy, fareSpy, trackSpy, pnrSpy, searchSpy]) expect(s).not.toHaveBeenCalled();
    });

    it(`[2] seat question in any wording → CHECK_AVAILABILITY reaches the provider; the reply carries the provider status (${mode})`, async () => {
      const Q = '12497 mein 3A ki koi berth bachi hai kya?';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [{ calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }, (v: TurnView) => ({ content: `12497 mein 3A ${v.results.at(-1)!.content.data.status} hai.` })]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(availSpy).toHaveBeenCalledTimes(1);
      expect(availSpy.mock.calls[0][0]).toMatchObject({ trainNumber: '12497', travelClass: '3A', date: D1 });
      expect(execs(r)).toEqual(['CHECK_AVAILABILITY']);
      expect(shown(r)).toBe('12497 mein 3A Available hai.');
      expect(selectedOf(h)).toBeNull();                                    // availability never selects
    });

    it(`[3] stops / timings of one train → GET_TIMETABLE (${mode})`, async () => {
      const Q = '18238 beech mein kin stations pe rukti hai?';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [{ calls: [{ name: 'GET_TIMETABLE', args: { trainNumber: '18238' } }] }, { content: '18238 ke stops upar dikhaye gaye hain.' }]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(ttSpy).toHaveBeenCalledTimes(1);
      expect(execs(r)).toEqual(['GET_TIMETABLE']);
      expect(shown(r)).toBe('18238 ke stops upar dikhaye gaye hain.');
    });

    it(`[4] where is the train / how late → TRACK_TRAIN; live facts shown only from its result (${mode})`, async () => {
      const meta = (await new MockRailwayProvider().getTimetable({ trainNumber: '12014' } as any)).meta;
      trackSpy.mockResolvedValue({ ok: true, data: { trainNumber: '12497', currentStatus: 'Running', currentStationName: 'Ludhiana Jn', delayMinutes: 20, lastUpdated: new Date().toISOString() }, meta });
      const Q = '12497 is waqt kidhar pahunchi hogi?';             // live tools need the user's own train number (P14 grounding)
      const h = stack({
        [Q]: [{ calls: [{ name: 'TRACK_TRAIN', args: { trainNumber: '12497' } }] }, (v: TurnView) => ({ content: `Train ${v.results.at(-1)!.content.data.currentStationName} ke paas hai, ${v.results.at(-1)!.content.data.delayMinutes} minute late chal rahi hai.` })]
      });
      const r = await h.say(Q, mode);
      expect(trackSpy).toHaveBeenCalledTimes(1);
      expect(execs(r)).toEqual(['TRACK_TRAIN']);
      // live facts are worded by the backend's authoritative live-status path; MOCK data is never presented as live
      expect(shown(r)).toMatch(/^12497.*live status \(mock \/ non-live development data\).*Ludhiana Jn.*20 min late/);
    });

    it(`[5] cost question → grounded selection (typed train) + class → GET_FARE; fare only from the result (${mode})`, async () => {
      const Q = '12497 ke 3A mein ek bande ka kitna lagega?';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [{ calls: [U({ trainRef: NUM('12497') })] }, { calls: [U({ classRaw: '3A' }, 'BOOK_TRAIN', 'SELECT_CLASS')] }, { calls: [{ name: 'GET_FARE', args: {} }] },
          (v: TurnView) => ({ content: `12497 ke 3A ka fare ₹${v.results.at(-1)!.content.data.perPassenger} per passenger hai.` })]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(fareSpy).toHaveBeenCalledTimes(1);
      expect(fareSpy.mock.calls[0][0]).toMatchObject({ trainNumber: '12497', travelClass: '3A' });
      expect(execs(r)).toContain('GET_FARE');
      expect(shown(r)).toBe('12497 ke 3A ka fare ₹650 per passenger hai.');
    });

    it(`[6] PNR question → CHECK_PNR with the typed PNR; unavailable provider → honest reply, no status invented (${mode})`, async () => {
      const Q = 'mera PNR 4512345678 hai, iska kya scene hai?';
      const h = stack({
        [Q]: [{ calls: [{ name: 'CHECK_PNR', args: { pnr: '4512345678' } }] }, { content: 'Abhi PNR ki jaankari nahi mil paayi. Thodi der baad dobara try karein.' }]
      });
      const r = await h.say(Q, mode);
      expect(pnrSpy).toHaveBeenCalledTimes(1);
      expect(execs(r)).toEqual(['CHECK_PNR']);
      expect(shown(r)).toBe('PNR status check abhi available nahi hai — railway provider se PNR data nahi mila.');   // existing honest reply
      expect(shown(r)).not.toMatch(/confirm|CNF|berth|coach/i);
      expect(eventsOf(r)).not.toContain('FACT_AUTHORITY_RECOVERY');
    });

    it(`[7] "which trains" in new wording → SEARCH_TRAINS (${mode})`, async () => {
      const Q = 'kal Amritsar se Dilli nikalna hai, kaun se options milenge?';
      const h = stack({ [Q]: [{ calls: [SEARCH()] }, (v: TurnView) => ({ content: `Kal ke liye ${v.results[0].content.data.trains.length} trainein mili hain.` })] });
      const r = await h.say(Q, mode);
      expect(searchSpy).toHaveBeenCalledTimes(1);
      expect(execs(r)).toEqual(['SEARCH_TRAINS']);
      expect(shown(r)).toBe('Kal ke liye 3 trainein mili hain.');
      expect(h.s().searchResults.trains.length).toBe(3);
    });

    it(`[8] ambiguous reference (two 3A trains) → the agent asks; a guessed pick is rejected; nothing selected (${mode})`, async () => {
      const Q = '3A wali le lo';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [{ calls: [U({ trainRef: { kind: 'CLASS_PREFERENCE', value: '3A' } })] }, { content: '3A do trains mein hai — 12497 Shan-e-Punjab aur 18238 Chhattisgarh. Kaunsi chahiye?' }]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(selectedOf(h)).toBeNull();
      expect(eventsOf(r)).not.toContain('TRAIN_SELECTED');
      expect(shown(r)).toBe('3A do trains mein hai — 12497 Shan-e-Punjab aur 18238 Chhattisgarh. Kaunsi chahiye?');
      expect(eventsOf(r)).not.toContain('FACT_AUTHORITY_RECOVERY');      // grounded train numbers in a question are fine
    });

    it(`[9a] seat status answered from memory → not shown; the agent hears which facts are unverified and calls the owner (${mode})`, async () => {
      const Q = '12497 ke 3A mein jagah milegi?';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [onFA({ content: '12497 ke 3A mein 14 seats available hain.' }, { calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }),
          (v: TurnView) => ({ content: `12497 ke 3A mein abhi ${v.results.at(-1)!.content.data.status} hai.` })]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(h.viewsFor(Q).filter(v => faOf(v)).length).toBe(1);        // consumed by exactly one retry call
      const fa = h.viewsFor(Q).map(faOf).find(Boolean);
      expect(fa).toEqual({ origin: 'BACKEND_FACT_AUTHORITY', unverified: [{ kind: 'AVAILABILITY', capabilities: ['CHECK_AVAILABILITY'] }] });
      expect(h.viewsFor(Q).find(v => faOf(v))!.body.messages.at(-1).content).toContain(FACT_AUTHORITY_INSTRUCTION);
      expect(eventsOf(r)).toContain('FACT_AUTHORITY_RECOVERY');
      expect(availSpy).toHaveBeenCalledTimes(1);
      expect(shown(r)).toBe('12497 ke 3A mein abhi Available hai.');
      expect(shown(r)).not.toMatch(/14 seats/);
      expect(shown(r)).not.toMatch(INTERNAL);
    });

    it(`[9b] invented fare / timing / live / PNR status → owner capability named; second invention stripped, no further recovery (${mode})`, async () => {
      const cases: Array<[string, string, Array<{ kind: string; capabilities: string[] }>]> = [
        ['Shan-e-Punjab ke 3A ka rate kya chal raha hai?', 'Shan-e-Punjab ke 3A ka fare ₹1450 hai.', [{ kind: 'FARE', capabilities: ['GET_FARE'] }]],
        ['Shatabdi subah kitne baje chalti hai?', 'Shatabdi subah 07:20 pe chalti hai.', [{ kind: 'TIMING', capabilities: ['GET_TIMETABLE', 'GET_TRAIN_INFO', 'SEARCH_TRAINS'] }]],
        ['Shan-e-Punjab late hai kya aaj?', 'Haan, train 40 minute late chal rahi hai.', [{ kind: 'LIVE_STATUS', capabilities: ['TRACK_TRAIN'] }]],
        ['PNR 4512345678 confirm hua kya?', 'Haan, aapka PNR confirmed hai.', [{ kind: 'PNR_STATUS', capabilities: ['CHECK_PNR'] }]]
      ];
      for (const [q, invented, expected] of cases) {
        const h = stack({ [q]: [{ content: invented }] });           // the agent invents again on the retry (same step)
        const r = await h.say(q, mode);
        const fas = h.viewsFor(q).map(faOf).filter(Boolean);
        expect(fas).toEqual([{ origin: 'BACKEND_FACT_AUTHORITY', unverified: expected }]);   // exactly one recovery
        expect(h.callsFor(q)).toBe(2);
        expect(shown(r)).not.toContain(invented);
        expect(shown(r)).not.toMatch(/1450|07:20|40 minute|confirmed/);
        expect(shown(r)).not.toMatch(INTERNAL);
      }
      for (const s of [availSpy, ttSpy, fareSpy, trackSpy, pnrSpy, searchSpy]) expect(s).not.toHaveBeenCalled();
    });

    it(`[10] tool failure / timeout → the agent's invented fill-in is stripped; no recovery after a tool ran (${mode})`, async () => {
      const meta = (await new MockRailwayProvider().getTimetable({ trainNumber: '12014' } as any)).meta;
      availSpy.mockResolvedValue({ ok: false, error: { code: 'PROVIDER_TIMEOUT', message: 'timeout' }, meta });
      const Q1 = '12497 3A mein seat hai abhi?';
      const Q2 = '12497 kahan pahunchi?';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q1]: [{ calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }, { content: '12497 ke 3A mein 14 seats available hain.' }],
        [Q2]: [{ calls: [{ name: 'TRACK_TRAIN', args: { trainNumber: '12497' } }] }, { content: 'Train Ambala ke paas hai, 25 minute late chal rahi hai.' }]
      });
      await h.say(SEARCH_T, mode);
      const r1 = await h.say(Q1, mode);
      expect(availSpy).toHaveBeenCalledTimes(1);
      expect(shown(r1)).not.toMatch(/14 seats/);
      expect(h.callsFor(Q1)).toBe(2);
      const r2 = await h.say(Q2, mode);                              // mock: live status unavailable
      expect(trackSpy).toHaveBeenCalledTimes(1);
      expect(shown(r2)).not.toMatch(/Ambala|25 minute/);
      expect(h.callsFor(Q2)).toBe(2);
      for (const r of [r1, r2]) { expect(eventsOf(r)).not.toContain('FACT_AUTHORITY_RECOVERY'); expect(shown(r)).not.toMatch(INTERNAL); }
    });

    it(`[11] context reused: selected train + class come from the session; the agent sees them and does not re-ask (${mode})`, async () => {
      const Q = 'ab isme seat ka kya haal hai?';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '12497 3A mein chahiye': [{ calls: [U({ trainRef: NUM('12497') })] }, { calls: [U({ classRaw: '3A' }, 'BOOK_TRAIN', 'SELECT_CLASS')] }, { content: '12497 mein 3A le liya.' }],
        [Q]: [{ calls: [AV({})] }, (v: TurnView) => ({ content: `3A mein ${v.results.at(-1)!.content.data.status} hai.` })]
      });
      await h.say(SEARCH_T, mode);
      await h.say('12497 3A mein chahiye', mode);
      expect(selectedOf(h)).toBe('12497');
      const r = await h.say(Q, mode);
      const ctx = JSON.stringify(h.viewsFor(Q)[0].context);
      expect(ctx).toContain('12497');
      expect(ctx).toContain('3A');
      expect(availSpy).toHaveBeenCalledTimes(1);
      expect(availSpy.mock.calls[0][0]).toMatchObject({ trainNumber: '12497', travelClass: '3A', date: D1 });
      expect(shown(r)).toBe('3A mein Available hai.');
    });

    it(`[12] SELECT_TRAIN grounding stays final — also when the agent tries to select during a recovery (${mode})`, async () => {
      const Q = 'jo bhi theek ho uska fare bata do';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q]: [onFA({ content: '18238 ke 3A ka fare ₹999 hai.' }, { calls: [U({ trainRef: NUM('18238') })] }), { content: 'Kaunsi train ka fare dekhun?' }]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(Q, mode);
      expect(h.viewsFor(Q).some(faOf)).toBe(true);
      expect(selectedOf(h)).toBeNull();
      expect(eventsOf(r)).not.toContain('TRAIN_SELECTED');
      expect(JSON.stringify(h.viewsFor(Q).flatMap(v => v.results))).toContain('TRAIN_NOT_GROUNDED');
      expect(fareSpy).not.toHaveBeenCalled();
      expect(shown(r)).toBe('Kaunsi train ka fare dekhun?');
    });

    it(`[13] P42-12: an explicit re-check is a fresh provider call; once a railway tool ran, no fact-authority recovery (${mode})`, async () => {
      const Q1 = '12497 3A dekho';
      const Q2 = 'ek baar phir se check karke batao';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [Q1]: [{ calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }, (v: TurnView) => ({ content: `3A ${v.results.at(-1)!.content.data.status} hai.` })],
        [Q2]: [{ calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }, (v: TurnView) => ({ content: `Abhi bhi 3A ${v.results.at(-1)!.content.data.status} hai.` })]
      });
      await h.say(SEARCH_T, mode);
      await h.say(Q1, mode);
      const r2 = await h.say(Q2, mode);
      expect(availSpy).toHaveBeenCalledTimes(2);                      // never served from the earlier answer
      expect(shown(r2)).toBe('Abhi bhi 3A Available hai.');
      expect(eventsOf(r2)).not.toContain('FACT_AUTHORITY_RECOVERY');
      expect(selectedOf(h)).toBeNull();
    });

    it(`[14] P29 action claims are not a recovery case: false booking claim removed by the unchanged guard, one call (${mode})`, async () => {
      const Q = 'theek hai book kar do';
      const h = stack({ [Q]: [{ content: 'Aapki ticket book ho gayi hai.' }] });
      const r = await h.say(Q, mode);
      expect(h.callsFor(Q)).toBe(1);
      expect(shown(r)).not.toMatch(/book ho gayi/);
      expect(eventsOf(r)).not.toContain('FACT_AUTHORITY_RECOVERY');
    });
  }

  it('[15] TEXT and VOICE route identically: same tool sequence, same recovery, same reply', async () => {
    const plan = () => ({
      [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
      '18238 ka 3A kaisa hai abhi?': [onFA({ content: '18238 mein 3A mein 9 seats available hain.' }, { calls: [AV({ trainNumber: '18238', travelClass: '3A' })] }), (v: TurnView) => ({ content: `18238 3A ${v.results.at(-1)!.content.data.status} hai.` })],
      'RAC aur WL mein kya fark hai?': [{ content: 'RAC mein berth share karke safar ho jaata hai; WL mein confirm hone tak berth nahi milti.' }],
      '12014 kitne baje Delhi pahunchti hai?': [{ calls: [{ name: 'GET_TIMETABLE', args: { trainNumber: '12014' } }] }, { content: '12014 ka timetable upar hai.' }]
    });
    const out: Record<Mode, any[]> = { TEXT: [], VOICE: [] };
    for (const mode of MODES) {
      const h = stack(plan());
      for (const q of [SEARCH_T, '18238 ka 3A kaisa hai abhi?', 'RAC aur WL mein kya fark hai?', '12014 kitne baje Delhi pahunchti hai?']) {
        const r = await h.say(q, mode);
        out[mode].push({ q, tools: execs(r), fa: h.viewsFor(q).map(faOf).filter(Boolean), calls: h.callsFor(q), text: shown(r) });
      }
    }
    expect(out.VOICE).toEqual(out.TEXT);
    expect(out.TEXT[1].fa).toEqual([{ origin: 'BACKEND_FACT_AUTHORITY', unverified: [{ kind: 'AVAILABILITY', capabilities: ['CHECK_AVAILABILITY'] }] }]);
    expect(out.TEXT[1].tools).toEqual(['CHECK_AVAILABILITY']);
    expect(out.TEXT[1].text).toBe('18238 3A Available hai.');
    expect(out.TEXT[2]).toMatchObject({ tools: [], fa: [], calls: 1 });
    expect(out.TEXT[3].tools).toEqual(['GET_TIMETABLE']);
  });

  for (const mode of MODES) {
    it(`[N] novel phrasings (not used elsewhere) reach the capability the agent chose; knowledge stays tool-free (${mode})`, async () => {
      const N: Array<[string, any[], string | null]> = [
        ['bhai Shatabdi wali gaadi Delhi kitne baje utaarti hai?', [{ calls: [{ name: 'GET_TIMETABLE', args: { trainNumber: '12014' } }] }, { content: '12014 ka timetable upar hai.' }], 'GET_TIMETABLE'],
        ['12497 ki gaadi chal rahi hai ya ruki padi hai?', [{ calls: [{ name: 'TRACK_TRAIN', args: { trainNumber: '12497' } }] }, { content: 'Abhi live jaankari nahi mil paayi.' }], 'TRACK_TRAIN'],
        ['is train mein khana milta hai kya, kaunsi classes hain 12014 mein?', [{ calls: [{ name: 'GET_TRAIN_INFO', args: { trainNumber: '12014' } }] }, { content: '12014 ki details upar hain.' }], 'GET_TRAIN_INFO'],
        ['Can I carry my pet dog on an Indian train?', [{ content: 'Yes, dogs can travel in AC First Class coupes or in the brake van with a booking at the parcel office; rules vary by zone.' }], null],
        ['waitlist wala ticket cancel karna pade toh paisa wapas aata hai?', [{ content: 'Haan, waitlisted e-ticket chart ke baad bhi confirm na ho toh apne aap cancel hokar refund hota hai, thoda clerkage katta hai.' }], null],
        ['18238 ke sleeper mein abhi ki position kya hai?', [{ calls: [AV({ trainNumber: '18238', travelClass: 'SL' })] }, (v: TurnView) => ({ content: `18238 SL ${v.results.at(-1)!.content.data.status} hai.` })], 'CHECK_AVAILABILITY']
      ];
      const h = stack({ [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }], ...Object.fromEntries(N.map(([q, p]) => [q, p])) });
      await h.say(SEARCH_T, mode);
      for (const [q, , tool] of N) {
        const r = await h.say(q, mode);
        expect(execs(r)).toEqual(tool ? [tool] : []);
        expect(eventsOf(r)).not.toContain('FACT_AUTHORITY_RECOVERY');
        expect(shown(r)).not.toMatch(INTERNAL);
      }
      expect(shown(await h.say('Can I carry my pet dog on an Indian train?', mode))).toMatch(/^Yes, dogs can travel/);
    });
  }
});

describe('General Agent Intelligence — catalog, prompt and tool descriptions [U]', () => {
  it('[U1] every registered tool has exactly one capability; unavailable capabilities are never exposed tools', () => {
    for (const t of REGISTERED_TOOLS) expect(CAPABILITIES.filter(c => c.tool === t.name).length).toBe(1);
    const exposed = new Set(REGISTERED_TOOLS.map(t => t.name));
    for (const c of CAPABILITIES) if (c.tool) expect(exposed.has(c.tool)).toBe(true);
    expect(CAPABILITIES.find(c => c.id === 'ROUTE_CANCELLATIONS')).toMatchObject({ tool: null, available: false });
    expect(exposed.has('GET_CANCELLED_TRAINS' as any)).toBe(false);
    expect(exposed.has('GENERAL_RAILWAY_ANSWER' as any)).toBe(false);
    for (const owners of Object.values(UNVERIFIED_FACT_OWNERS)) for (const t of owners) expect(exposed.has(t)).toBe(true);
  });

  it('[U2] CAPABILITY ROUTING is part of the native prompt once, before FACTS, outside the same-train slot; no template residue, no example user phrases', () => {
    const p = NATIVE_AGENT_SYSTEM_PROMPT;
    expect(p.split('CAPABILITY ROUTING').length).toBe(2);
    expect(p.indexOf('CAPABILITY ROUTING')).toBeGreaterThan(p.indexOf('HOW YOU WORK'));
    expect(p.indexOf('CAPABILITY ROUTING')).toBeLessThan(p.indexOf('\nFACTS'));
    expect(p).toContain(capabilityRoutingPrompt());
    expect(nativeAgentSystemPrompt(true)).toContain(capabilityRoutingPrompt());
    expect(p).not.toMatch(/\{\{|\$\{/);
    const sec = capabilityRoutingPrompt();
    expect(sec).not.toMatch(/"/);                                     // no quoted user phrases — definitions only
    for (const c of CAPABILITIES.filter(x => x.tool)) expect(sec).toContain(`• ${c.id}: when ${c.need}`);
    expect(sec).toMatch(/NOT AVAILABLE — route cancellations/);
    expect(sec).toMatch(/never fill the gap from memory/);
    expect(sec).toMatch(/ask ONE short question only when an essential detail is genuinely unknown/);
  });

  it('[U3] tool descriptions carry the capability intent + authority; names, count and parameters unchanged; same-train tools untouched', () => {
    const defs = nativeToolDefs({ tools: REGISTERED_TOOLS } as any);
    expect(defs.map((d: any) => d.function.name)).toEqual([...REGISTERED_TOOLS.map(t => t.name), 'update_booking_session']);
    for (const t of REGISTERED_TOOLS) {
      const d = defs.find((x: any) => x.function.name === t.name).function;
      expect(d.description.startsWith(t.description)).toBe(true);
      expect(d.description).toContain(capabilityToolNote(t.name));
      expect(d.description).toMatch(/never answer these from memory/);
    }
    const st = nativeToolDefs({ tools: [...REGISTERED_TOOLS, ...SAME_TRAIN_ALTERNATIVE_TOOLS] } as any);
    for (const t of SAME_TRAIN_ALTERNATIVE_TOOLS) expect(st.find((x: any) => x.function.name === t.name).function.description).toBe(t.description);
    expect(defs.find((x: any) => x.function.name === 'update_booking_session').function.description).not.toContain('[Use when');
  });

  it('[U4] factAuthorityRecovery is pure and reads only the draft: knowledge → null; every fact kind of a sentence found; unexposed owner → null', () => {
    const st = new ConversationStateManager();
    const session = st.getSession(st.createSession().sessionId) as any;
    const all = new Set(REGISTERED_TOOLS.map(t => t.name as string));
    const run = (t: string, exposed = all) => factAuthorityRecovery(t, { session, steps: [], userText: 'x', exposed })?.unverified ?? null;
    expect(run('RAC matlab Reservation Against Cancellation; chart ke baad berth confirm ho sakti hai.')).toBeNull();
    expect(run('')).toBeNull();
    expect(run('12497 mein 3A mein 14 seats available hain.')).toEqual([{ kind: 'TRAIN', capabilities: ['SEARCH_TRAINS', 'GET_TRAIN_INFO'] }, { kind: 'AVAILABILITY', capabilities: ['CHECK_AVAILABILITY'] }]);
    expect(run('12497 ka 3A fare ₹1,450 hai.')).toEqual([{ kind: 'TRAIN', capabilities: ['SEARCH_TRAINS', 'GET_TRAIN_INFO'] }, { kind: 'FARE', capabilities: ['GET_FARE'] }]);
    expect(run('Shan-e-Punjab ka 3A fare ₹1450 hai.', new Set(['SEARCH_TRAINS']))).toBeNull();
    const before = JSON.stringify(session);
    run('Kal 12014 Shatabdi 04:55 pe nikalti hai.');
    expect(JSON.stringify(session)).toBe(before);
  });
});
