/**
 * Tool-grounding fix — GET_TRAIN_INFO / GET_TIMETABLE train numbers must be grounded (same sources as TRACK_TRAIN, bound
 * to the CURRENT context). A well-formed train number alone is never evidence of user intent.
 * Real orchestrator + turn engine + runtime + validator; a fake OpenAI-compatible server plays Muse; MOCK railway provider
 * (ASR→NDLS = 12014 / 12497 / 18238; 12030 exists only on LDH→NDLS; ASR→LDH = 12014 / 04672). No network.
 *   [A] explicit train number typed by the user → allowed (GET_TRAIN_INFO and GET_TIMETABLE)
 *   [B] "pehli wali" after a search shown in an earlier turn → allowed (resolved train of the current results)
 *   [C] "doosri wali" → allowed
 *   [D] a generic search turn followed by a lookup the user never mentioned / referred to → rejected, provider NOT called
 *       (D1: train not in the results at all — 12030; D2: train inside the results produced in this very turn — 18238)
 *   [E] context invalidation → an old train is no longer grounded (route change / date change / stale result set)
 *   [F] a rejected lookup cannot affect cards, selection, focus, lastTrainInfo or the final answer's facts
 *   [G] TEXT and VOICE behave the same (every behavioural case runs in both)
 *   [V] validator-level rules (typed / selected / focus / shown / same-turn / stale / booking record) + malformed tool name
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
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('tool-grounding-lookup', () => new MockRailwayProvider());
const ist = (d: number) => new Date(Date.now() + 5.5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1), D2 = ist(2);
const SEARCH = (extra: any = {}, date = D1) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date, ...extra } });
const INFO = (trainNumber?: string) => ({ name: 'GET_TRAIN_INFO', args: trainNumber ? { trainNumber } : {} });
const TT = (trainNumber?: string) => ({ name: 'GET_TIMETABLE', args: trainNumber ? { trainNumber } : {} });
type Mode = 'TEXT' | 'VOICE';
const MODES: Mode[] = ['TEXT', 'VOICE'];

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-TOOLGROUND', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { views, say: (t: string, m: Mode) => eng.processTurn(sid, t, m) as Promise<any>, s: () => state.getSession(sid) as any,
    feedback: (u: string) => views.filter(v => v.user === u).flatMap(v => v.results) };
}
const shown = (r: any) => String(r?.voice?.assistantText ?? r?.responseMessage ?? r?.message ?? '');
const cardsOf = (r: any) => ((r?.cards || r?.response?.cards || []) as any[]);
const lookupCards = (r: any) => cardsOf(r).filter(c => c.type === 'train_info' || c.type === 'timetable');
const toolResults = (r: any, tool: string) => ((r?.turnLog?.toolResults || []) as any[]).filter(x => x.toolName === tool);
const succeeded = (r: any, tool: string) => toolResults(r, tool).filter(x => x.resultStatus === 'SUCCEEDED' || x.executionStatus === 'SUCCEEDED');
const rejectedFeedback = (fb: any[], tool: string) => fb.filter(x => x.name === tool && /AUTHORITATIVE_DATA_REQUIRED|INVALID_REQUEST|identify nahi hui|REJECTED/i.test(JSON.stringify(x.content)));

let fetchSpy: any, infoSpy: any, ttSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('tool-grounding-lookup');
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  infoSpy = vi.spyOn(MockRailwayProvider.prototype, 'getTrainInfo');
  ttSpy = vi.spyOn(MockRailwayProvider.prototype, 'getTimetable');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
const infoCalls = () => infoSpy.mock.calls.map((c: any[]) => String(c[0]?.trainNumber));
const ttCalls = () => ttSpy.mock.calls.map((c: any[]) => String(c[0]?.trainNumber));

describe('Tool-grounding fix — GET_TRAIN_INFO / GET_TIMETABLE (MOCK, scripted Muse)', () => {
  for (const mode of MODES) {
    it(`[A] explicit train number typed by the user → allowed (${mode})`, async () => {
      const h = stack({
        '12014 ki info batao': [{ calls: [INFO('12014')] }, { content: '12014 Amritsar Shatabdi Express ki info mil gayi.' }],
        '12497 ka timetable batao': [{ calls: [TT('12497')] }, { content: '12497 ka timetable mil gaya.' }]
      });
      const r1 = await h.say('12014 ki info batao', mode);
      expect(infoCalls()).toEqual(['12014']);
      expect(succeeded(r1, 'GET_TRAIN_INFO').length).toBe(1);
      expect(lookupCards(r1).map(c => c.type)).toEqual(['train_info']);
      expect(h.s().focusTrainNumber).toBe('12014');
      const r2 = await h.say('12497 ka timetable batao', mode);
      expect(ttCalls()).toEqual(['12497']);
      expect(succeeded(r2, 'GET_TIMETABLE').length).toBe(1);
      expect(h.s().focusTrainNumber).toBe('12497');
    });

    it(`[B] "pehli wali ka timetable" after a search shown in an earlier turn → allowed (${mode})`, async () => {
      const U1 = 'Amritsar se Delhi kal ki trains dikhao';
      const h = stack({
        [U1]: [{ calls: [SEARCH()] }, { content: 'Kal ki trains mil gayi.' }],
        'pehli wali ka timetable batao': [{ calls: [TT('12014')] }, { content: '12014 ka timetable mil gaya.' }],
        'pehli wali ki info bhi batao': [{ calls: [INFO('12014')] }, { content: '12014 ki info mil gayi.' }]
      });
      await h.say(U1, mode);
      expect(h.s().searchResults.trains.map((t: any) => String(t.trainNumber))).toEqual(['12014', '12497', '18238']);
      const r2 = await h.say('pehli wali ka timetable batao', mode);
      expect(ttCalls()).toEqual(['12014']);
      expect(succeeded(r2, 'GET_TIMETABLE').length).toBe(1);
      expect(lookupCards(r2).map(c => c.type)).toEqual(['timetable']);
      const r3 = await h.say('pehli wali ki info bhi batao', mode);
      expect(infoCalls()).toEqual(['12014']);
      expect(succeeded(r3, 'GET_TRAIN_INFO').length).toBe(1);
    });

    it(`[C] "doosri wali" → allowed; "12014 wali ka info" (typed + in current results) → allowed (${mode})`, async () => {
      const U1 = 'Amritsar se Delhi kal ki trains dikhao';
      const h = stack({
        [U1]: [{ calls: [SEARCH()] }, { content: 'Kal ki trains mil gayi.' }],
        'doosri wali check karo': [{ calls: [INFO('12497')] }, { content: '12497 ki info mil gayi.' }],
        '12014 wali ka info batao': [{ calls: [INFO('12014')] }, { content: '12014 ki info mil gayi.' }]
      });
      await h.say(U1, mode);
      const r2 = await h.say('doosri wali check karo', mode);
      expect(infoCalls()).toEqual(['12497']);
      expect(succeeded(r2, 'GET_TRAIN_INFO').length).toBe(1);
      expect(h.s().focusTrainNumber).toBe('12497');
      const r3 = await h.say('12014 wali ka info batao', mode);
      expect(infoCalls()).toEqual(['12497', '12014']);
      expect(succeeded(r3, 'GET_TRAIN_INFO').length).toBe(1);
    });

    it(`[D1] generic search, then GET_TRAIN_INFO / GET_TIMETABLE for 12030 (not in results, never mentioned) → rejected, no provider call (${mode})`, async () => {
      const U = 'Amritsar se Delhi trains dikhao';
      const h = stack({ [U]: [{ calls: [SEARCH()] }, { calls: [INFO('12030'), TT('12030')] }, { content: 'Kal ki trains mil gayi.' }] });
      const r = await h.say(U, mode);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(ttSpy).not.toHaveBeenCalled();
      expect(succeeded(r, 'GET_TRAIN_INFO').length + succeeded(r, 'GET_TIMETABLE').length).toBe(0);
      expect(rejectedFeedback(h.feedback(U), 'GET_TRAIN_INFO').length).toBe(1);
      expect(rejectedFeedback(h.feedback(U), 'GET_TIMETABLE').length).toBe(1);
      expect(lookupCards(r)).toEqual([]);
      expect(h.s().focusTrainNumber ?? null).toBeNull();
      expect(h.s().lastTrainInfo ?? null).toBeNull();
      expect(h.s().searchResults.trains.length).toBe(3);            // the requested search itself is untouched
    });

    it(`[D2] generic search, then a same-turn lookup of a train INSIDE the fresh results (18238) the user never referred to → rejected (${mode})`, async () => {
      const U = 'Amritsar se Delhi kal ki trains dikhao';
      const h = stack({ [U]: [{ calls: [SEARCH()] }, { calls: [INFO('18238'), TT('12497')] }, { content: 'Kal ki trains mil gayi.' }] });
      const r = await h.say(U, mode);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(ttSpy).not.toHaveBeenCalled();
      expect(lookupCards(r)).toEqual([]);
      expect(h.s().focusTrainNumber ?? null).toBeNull();
      expect(rejectedFeedback(h.feedback(U), 'GET_TRAIN_INFO').length).toBe(1);
      expect(rejectedFeedback(h.feedback(U), 'GET_TIMETABLE').length).toBe(1);
    });

    it(`[D3] same-turn search + lookup of a train the user typed in that turn → allowed (${mode})`, async () => {
      const U = 'Amritsar se Delhi kal ki trains dikhao aur 18238 ki info bhi';
      const h = stack({ [U]: [{ calls: [SEARCH()] }, { calls: [INFO('18238')] }, { content: 'Trains aur 18238 ki info mil gayi.' }] });
      const r = await h.say(U, mode);
      expect(infoCalls()).toEqual(['18238']);
      expect(succeeded(r, 'GET_TRAIN_INFO').length).toBe(1);
    });

    it(`[E1] route change: an old train no longer in the current results / focus is not grounded (${mode})`, async () => {
      const U1 = 'Amritsar se Delhi kal ki trains dikhao';
      const U3 = 'Amritsar se Ludhiana kal ki trains dikhao';
      const h = stack({
        [U1]: [{ calls: [SEARCH()] }, { content: 'Trains mil gayi.' }],
        'doosri wali ka timetable batao': [{ calls: [TT('12497')] }, { content: '12497 ka timetable.' }],
        [U3]: [{ calls: [{ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Ludhiana', date: D1 } }] }, { content: 'Ludhiana ki trains mil gayi.' }],
        'aur batao': [{ calls: [INFO('12497'), TT()] }, { content: 'Theek hai.' }]
      });
      await h.say(U1, mode);
      await h.say('doosri wali ka timetable batao', mode);
      expect(ttCalls()).toEqual(['12497']);
      await h.say(U3, mode);
      expect(h.s().searchResults.trains.map((t: any) => String(t.trainNumber))).not.toContain('12497');
      const r4 = await h.say('aur batao', mode);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(ttCalls()).toEqual(['12497']);                          // no second timetable call (stale focus not used)
      expect(lookupCards(r4)).toEqual([]);
    });

    it(`[E2] date change via a new search: the old focus train is not looked up in the same turn without being mentioned (${mode})`, async () => {
      const U1 = 'Amritsar se Delhi kal ki trains dikhao';
      const U3 = 'parso wali trains dikhao';
      const h = stack({
        [U1]: [{ calls: [SEARCH()] }, { content: 'Trains mil gayi.' }],
        'pehli wali ki info batao': [{ calls: [INFO('12014')] }, { content: '12014 ki info.' }],
        [U3]: [{ calls: [SEARCH({}, D2)] }, { calls: [INFO('12014'), TT()] }, { content: 'Parso ki trains mil gayi.' }]
      });
      await h.say(U1, mode);
      await h.say('pehli wali ki info batao', mode);
      expect(infoCalls()).toEqual(['12014']);
      const r3 = await h.say(U3, mode);
      expect(h.s().searchResults.date).toBe(D2);
      expect(infoCalls()).toEqual(['12014']);                         // the stale one is NOT re-fetched
      expect(ttSpy).not.toHaveBeenCalled();
      expect(lookupCards(r3)).toEqual([]);
    });

    it(`[F] a rejected lookup never feeds cards / selection / focus / final-answer facts (${mode})`, async () => {
      const U = 'Amritsar se Delhi kal ki trains dikhao';
      const h = stack({ [U]: [{ calls: [SEARCH()] }, { calls: [INFO('12030')] },
        { content: 'Kal ki trains mil gayi. 12030 Swarna Shatabdi ka CC fare ₹1450 hai, CC mein 40 seats available hain aur yeh abhi 20 minute late chal rahi hai.' }] });
      const r = await h.say(U, mode);
      expect(infoSpy).not.toHaveBeenCalled();
      expect(cardsOf(r).filter(c => ['train_info', 'timetable', 'fare', 'availability', 'live_status'].includes(c.type))).toEqual([]);
      const s = h.s();
      expect(s.selectedTrain ?? null).toBeNull();
      expect(s.focusTrainNumber ?? null).toBeNull();
      expect(s.lastTrainInfo ?? null).toBeNull();
      expect(s.lastTimetable ?? null).toBeNull();
      const text = shown(r);
      expect(text).not.toMatch(/1450/);
      expect(text).not.toMatch(/40 seats/i);
      expect(text).not.toMatch(/20 minute late/i);
      // the rejection fed back to Muse carries no train data
      const fb = h.feedback(U).filter(x => x.name === 'GET_TRAIN_INFO');
      expect(fb.length).toBe(1);
      expect(JSON.stringify(fb[0].content)).not.toMatch(/Swarna|07:50|12:50/);
    });
  }
});

describe('[V] validator rules for GET_TRAIN_INFO / GET_TIMETABLE (unit)', () => {
  const v = new ToolCallValidator();
  const rows = ['12014', '12497', '18238'].map((n, i) => ({ trainNumber: n, trainName: `T${n}`, departure: '06:00', arrival: '12:00', classes: [{ code: 'CC' }], displayIndex: i + 1 }));
  const sess = (o: any = {}) => ({ sessionId: 's', origin: 'ASR', destination: 'NDLS', date: D1,
    searchResults: { trains: rows, date: D1, origin: 'ASR', destination: 'NDLS', sourceTurnId: 'turn-1' }, searchResultsVersion: 1, ...o }) as any;
  const g = (userText: string, bookings: any[] = []) => ({ userText, bookings, pnrOwner: () => 'NONE', bookingOwner: () => 'NONE' }) as any;
  const call = (name: string, args: any) => ({ callId: 'c', name, arguments: { ...args } }) as any;
  const run = (name: string, args: any, s: any, text: string, turnId = 'turn-2', bookings: any[] = []) => v.validate(call(name, args), s, g(text, bookings), { turnId, userText: text });
  const code = (r: any) => (r.ok ? 'OK' : r.error.code);

  for (const tool of ['GET_TRAIN_INFO', 'GET_TIMETABLE']) {
    it(`${tool}: typed / shown-earlier / selected / bound focus / own booking → allowed`, () => {
      expect(code(run(tool, { trainNumber: '12030' }, sess({ searchResults: undefined, searchResultsVersion: 0 }), '12030 ka timetable batao'))).toBe('OK');
      expect(code(run(tool, { trainNumber: '12497' }, sess(), 'doosri wali ka timetable'))).toBe('OK');
      expect(code(run(tool, { trainNumber: '12030' }, sess({ searchResults: undefined, selectedTrain: { number: '12030' } }), 'iska timetable'))).toBe('OK');
      expect(code(run(tool, { trainNumber: '12030' }, sess({ searchResults: undefined, focusTrainNumber: '12030' }), 'iska timetable'))).toBe('OK');
      expect(code(run(tool, { trainNumber: '22222' }, sess(), 'meri train ka timetable', 'turn-2', [{ bookingId: 'b1', pnr: null, trainNumber: '22222', status: 'CONFIRMED' }]))).toBe('OK');
      expect(code(run(tool, {}, sess({ focusTrainNumber: '12497' }), 'uska timetable'))).toBe('OK');
    });
    it(`${tool}: unmentioned train / same-turn results / stale set / unbound focus → rejected`, () => {
      expect(code(run(tool, { trainNumber: '12030' }, sess(), 'Amritsar se Delhi trains dikhao'))).toBe('AUTHORITATIVE_DATA_REQUIRED');
      expect(code(run(tool, { trainNumber: '18238' }, sess(), 'Amritsar se Delhi trains dikhao', 'turn-1'))).toBe('AUTHORITATIVE_DATA_REQUIRED');
      expect(code(run(tool, { trainNumber: '12497' }, sess({ date: D2 }), 'doosri wali'))).toBe('AUTHORITATIVE_DATA_REQUIRED');   // journey moved on
      expect(code(run(tool, { trainNumber: '12030' }, sess({ focusTrainNumber: '12030' }), 'aur batao'))).toBe('AUTHORITATIVE_DATA_REQUIRED');
      expect(code(run(tool, {}, sess({ focusTrainNumber: '12030' }), 'aur batao'))).toBe('MISSING_REQUIRED_FIELD');
      expect(code(run(tool, { trainNumber: '2' }, sess(), '2 tickets chahiye'))).not.toBe('OK');
    });
  }
  it('malformed / unknown tool name stays UNKNOWN_TOOL (no special recovery)', () => {
    expect(code(v.validate(call('railcore_train_info<|channel|>commentary', { trainNumber: '12030' }), sess(), g('x')))).toBe('UNKNOWN_TOOL');
  });
  it('TRACK_TRAIN grounding is unchanged (typed / session trains)', () => {
    expect(code(v.validate(call('TRACK_TRAIN', { trainNumber: '18238' }), sess(), g('Amritsar se Delhi trains dikhao')))).toBe('OK');
    expect(code(v.validate(call('TRACK_TRAIN', { trainNumber: '12030' }), sess(), g('Amritsar se Delhi trains dikhao')))).toBe('AUTHORITATIVE_DATA_REQUIRED');
    expect(code(v.validate(call('TRACK_TRAIN', { trainNumber: '12030' }), sess(), g('12030 ka status')))).toBe('OK');
  });
});
