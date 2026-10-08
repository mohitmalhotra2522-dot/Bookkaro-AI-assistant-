/**
 * CHECK_AVAILABILITY grounding fix — a train merely appearing in the current search results does NOT authorize an
 * availability lookup. The train must be the selected train, a number the user typed this turn, a row the user named
 * (P42.12 namedResultRow), a train the user already enquired about in this journey + result set (P42-12 F3 record) or a trainRef (the LLM's reading of the user's reference, resolved by the backend) against a
 * result set the user has already seen. Everything else is rejected BEFORE the provider is called.
 * Real orchestrator + turn engine + runtime + validator; a fake OpenAI-compatible server plays Muse; MOCK railway provider
 * (ASR→NDLS = 1 12014 04:55 [CC, 2S] · 2 12497 06:35 [3A, CC, SL, 2S] · 3 18238 19:35 [3A, SL]; ASR→LDH = 12014 / 04672).
 *   [A] explicit train number typed by the user → allowed (earlier-shown list and same-turn search)
 *   [B] selected train → allowed (no argument / its number / "iski" while selected)
 *   [C] valid current reference ("doosri wali" DISPLAY_INDEX, "evening wali" TIME_PREFERENCE, named "Shan-e-Punjab",
 *       "iski" DEMONSTRATIVE after a grounded lookup) → allowed
 *   [D] a train merely present in the results, never referred to → rejected (earlier-shown list, same-turn search,
 *       generic "availability batao" with an invented train, trainRef TRAIN_NUMBER, positional ref to an unseen list)
 *   [E] random / unmentioned train number → rejected
 *   [F] stale train after a route / date / new-search change → rejected
 *   [G] rejected availability never reaches the provider (spy on MockRailwayProvider.checkAvailability)
 *   [H] rejected availability creates no availability card, changes no selection / focus / availability evidence and its
 *       invented value never reaches the final answer
 *   [I] "abhi" / "dobara" / "fresh" → a NEW provider call every time (no caching), also without repeating the number
 *       after an earlier grounded enquiry of that train in the same journey + result set (P42-12 F3 evidence record)
 *   [K] TEXT and VOICE: every behavioural case runs in both modes
 *   [V] validator-level rules (unit)
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
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('tool-grounding-availability', () => new MockRailwayProvider());
const ist = (d: number) => new Date(Date.now() + 5.5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1), D2 = ist(2);
const SEARCH = (date = D1, destination = 'Delhi') => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination, date } });
const AV = (args: any) => ({ name: 'CHECK_AVAILABILITY', args });
const TT = (trainNumber: string) => ({ name: 'GET_TIMETABLE', args: { trainNumber } });
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH_T = 'Amritsar se Delhi kal ki trains dikhao';
type Mode = 'TEXT' | 'VOICE';
const MODES: Mode[] = ['TEXT', 'VOICE'];

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-AVGROUND', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
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
const avCards = (r: any) => cardsOf(r).filter(c => c.type === 'availability');
const execs = (r: any) => ((r?.turnLog?.toolExecutions || []) as any[]);
const av = (r: any) => execs(r).filter(x => x.tool === 'CHECK_AVAILABILITY').map(x => [x.status, x.rejectionReason ?? null]);
const NOT_GROUNDED: [string, string] = ['REJECTED', 'AUTHORITATIVE_DATA_REQUIRED'];
const selectedOf = (h: any) => h.s().selectedTrain ? String(h.s().selectedTrain.number ?? h.s().selectedTrain.trainNumber) : null;

let fetchSpy: any, availSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('tool-grounding-availability');
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  availSpy = vi.spyOn(MockRailwayProvider.prototype, 'checkAvailability');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); railwayRegistry.setActive('mock'); });
const avCalls = () => availSpy.mock.calls.map((c: any[]) => `${c[0]?.trainNumber}/${c[0]?.travelClass}`);

describe('CHECK_AVAILABILITY grounding fix (MOCK, scripted Muse)', () => {
  for (const mode of MODES) {
    it(`[A] explicit train number typed by the user → allowed; also in the same turn as a search (${mode})`, async () => {
      const U2 = 'Amritsar se Delhi kal ki trains dikhao aur 18238 ki 3A availability bhi batao';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '12497 ki SL availability batao': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }],
        [U2]: [{ calls: [SEARCH()] }, { calls: [AV({ trainNumber: '18238', travelClass: '3A' })] }, { content: '18238 mein 3A available hai.' }]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say('12497 ki SL availability batao', mode);
      expect(av(r)).toEqual([['SUCCEEDED', null]]);
      expect(avCalls()).toEqual(['12497/SL']);
      expect(avCards(r).length).toBe(1);
      expect(selectedOf(h)).toBeNull();                                   // an enquiry never selects
      const r2 = await h.say(U2, mode);
      expect(av(r2)).toEqual([['SUCCEEDED', null]]);
      expect(avCalls()).toEqual(['12497/SL', '18238/3A']);
    });

    it(`[B] selected train → allowed (no argument, its number, "iski") (${mode})`, async () => {
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '12497 SL select karo': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'SL', selectionPurpose: 'BOOKING' })] }, { content: '12497 SL select ho gayi.' }],
        'availability batao': [{ calls: [AV({})] }, { content: '12497 mein SL Waitlist 12 hai.' }],
        'iski 3A availability bhi batao': [{ calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }, { content: '12497 mein 3A available hai.' }]
      });
      await h.say(SEARCH_T, mode);
      await h.say('12497 SL select karo', mode);
      expect(selectedOf(h)).toBe('12497');
      const r1 = await h.say('availability batao', mode);
      expect(av(r1)).toEqual([['SUCCEEDED', null]]);
      const r2 = await h.say('iski 3A availability bhi batao', mode);
      expect(av(r2)).toEqual([['SUCCEEDED', null]]);
      expect(avCalls()).toEqual(['12497/SL', '12497/3A']);
      expect(selectedOf(h)).toBe('12497');
      expect(h.s().selectedClass).toBe('SL');
    });

    it(`[C] valid current references: "doosri wali", "evening wali", named "Shan-e-Punjab", "iski" after a grounded lookup → allowed (${mode})`, async () => {
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        'doosri wali ki SL availability': [{ calls: [AV({ trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }],
        'evening wali ki 3A availability': [{ calls: [AV({ trainRef: { kind: 'TIME_PREFERENCE', value: 'EVENING' }, travelClass: '3A' })] }, { content: '18238 mein 3A available hai.' }],
        'Shan-e-Punjab ki CC availability': [{ calls: [AV({ trainNumber: '12497', travelClass: 'CC' })] }, { content: '12497 mein CC RAC 4 hai.' }],
        'pehli wali ka timetable batao': [{ calls: [TT('12014')] }, { content: '12014 ka timetable mil gaya.' }],
        'iski CC availability': [{ calls: [AV({ trainRef: { kind: 'DEMONSTRATIVE', value: 'THIS' }, travelClass: 'CC' })] }, { content: '12014 mein CC available hai.' }]
      });
      await h.say(SEARCH_T, mode);
      expect(av(await h.say('doosri wali ki SL availability', mode))).toEqual([['SUCCEEDED', null]]);
      expect(av(await h.say('evening wali ki 3A availability', mode))).toEqual([['SUCCEEDED', null]]);
      expect(av(await h.say('Shan-e-Punjab ki CC availability', mode))).toEqual([['SUCCEEDED', null]]);
      await h.say('pehli wali ka timetable batao', mode);
      expect(h.s().focusTrainNumber).toBe('12014');
      expect(av(await h.say('iski CC availability', mode))).toEqual([['SUCCEEDED', null]]);
      expect(avCalls()).toEqual(['12497/SL', '18238/3A', '12497/CC', '12014/CC']);
      expect(selectedOf(h)).toBeNull();
    });

    it(`[D] a train merely present in the results, never referred to → rejected (shown list, same-turn search, invented train, TRAIN_NUMBER ref, unseen-list position) (${mode})`, async () => {
      const U2 = 'subah 6 baje tak Delhi pahunchna hai';
      const U3 = 'availability batao';
      const U4 = 'Amritsar se Delhi parso ki 3A trains dikhao';
      const U5 = 'Amritsar se Delhi parso ki trains dikhao aur pehli wali ki availability bhi';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [U2]: [{ calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }, { content: 'Theek hai.' }],                         // staging 7a-T t4 shape
        [U3]: [{ calls: [AV({ trainNumber: '18238', travelClass: 'SL' }), AV({ trainRef: { kind: 'TRAIN_NUMBER', value: '12014' }, travelClass: 'CC' })] }, { content: 'Kaunsi train?' }],
        [U4]: [{ calls: [SEARCH(D2)] }, { calls: [AV({ trainNumber: '12497', travelClass: '3A' }), AV({ trainNumber: '18238', travelClass: '3A' })] }, { content: 'Parso ki trains mil gayi.' }],   // staging 1D-T shape
        [U5]: [{ calls: [SEARCH(D2)] }, { calls: [AV({ trainRef: { kind: 'DISPLAY_INDEX', value: 1 }, travelClass: 'CC' })] }, { content: 'Parso ki trains mil gayi.' }]
      });
      await h.say(SEARCH_T, mode);
      expect(av(await h.say(U2, mode))).toEqual([NOT_GROUNDED]);
      expect(av(await h.say(U3, mode))).toEqual([NOT_GROUNDED, NOT_GROUNDED]);
      const r4 = await h.say(U4, mode);
      expect(execs(r4)[0]).toMatchObject({ tool: 'SEARCH_TRAINS', status: 'SUCCEEDED' });   // the requested search itself is untouched
      expect(av(r4)).toEqual([NOT_GROUNDED, NOT_GROUNDED]);
      expect(av(await h.say(U5, mode))).toEqual([NOT_GROUNDED]);
      expect(availSpy).not.toHaveBeenCalled();                             // [G]
      expect(selectedOf(h)).toBeNull();
    });

    it(`[E] random / unmentioned train numbers → rejected, provider never called (${mode})`, async () => {
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        'seat hai kya?': [{ calls: [AV({ trainNumber: '12030', travelClass: 'CC' }), AV({ trainNumber: '55555', travelClass: 'SL' })] }, { content: 'Kaunsi train?' }]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say('seat hai kya?', mode);
      expect(av(r).map(x => x[0])).toEqual(['REJECTED', 'REJECTED']);
      expect(availSpy).not.toHaveBeenCalled();
      expect(avCards(r)).toEqual([]);
    });

    it(`[F] stale train after a route / date / new-search change → rejected (${mode})`, async () => {
      const ROUTE = 'Amritsar se Ludhiana kal ki trains dikhao';
      const DATE = 'parso ki trains dikhao';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        'doosri wali ka timetable batao': [{ calls: [TT('12497')] }, { content: '12497 ka timetable mil gaya.' }],
        [ROUTE]: [{ calls: [SEARCH(D1, 'Ludhiana')] }, { content: 'Ludhiana ki trains mil gayi.' }],
        'uski SL availability': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' }), AV({ trainRef: { kind: 'DEMONSTRATIVE', value: 'THIS' }, travelClass: 'SL' })] }, { content: 'Theek hai.' }],
        [SEARCH_T + ' phir se']: [{ calls: [SEARCH()] }, { content: 'Kal ki trains phir se.' }],
        '18238 ki 3A availability': [{ calls: [AV({ trainNumber: '18238', travelClass: '3A' })] }, { content: '18238 mein 3A available hai.' }],
        [DATE]: [{ calls: [SEARCH(D2)] }, { calls: [AV({ trainNumber: '18238', travelClass: '3A' })] }, { content: 'Parso ki trains mil gayi.' }],
        'wahi wali dobara': [{ calls: [AV({ trainNumber: '18238', travelClass: '3A' })] }, { content: 'Theek hai.' }]
      });
      await h.say(SEARCH_T, mode);
      await h.say('doosri wali ka timetable batao', mode);
      await h.say(ROUTE, mode);                                             // route change: 12497 is not on ASR→LDH
      const r1 = await h.say('uski SL availability', mode);
      expect(av(r1).map(x => x[0])).toEqual(['REJECTED', 'REJECTED']);
      expect(availSpy).not.toHaveBeenCalled();
      await h.say(SEARCH_T + ' phir se', mode);
      expect(av(await h.say('18238 ki 3A availability', mode))).toEqual([['SUCCEEDED', null]]);
      const r3 = await h.say(DATE, mode);                                   // date change via a new search in the same turn
      expect(h.s().searchResults.date).toBe(D2);
      expect(av(r3)).toEqual([NOT_GROUNDED]);
      const r4 = await h.say('wahi wali dobara', mode);                     // the D1 enquiry does not carry over to D2 by number
      expect(av(r4)).toEqual([NOT_GROUNDED]);
      expect(avCalls()).toEqual(['18238/3A']);
    });

    it(`[G/H] a rejected availability never reaches the provider, cards, selection, focus, evidence or the final answer (${mode})`, async () => {
      const U2 = 'Kal ki trains mein kya options hain?';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        'pehli wali ka timetable batao': [{ calls: [TT('12014')] }, { content: '12014 ka timetable mil gaya.' }],
        [U2]: [{ calls: [AV({ trainNumber: '18238', travelClass: '3A' })] },
          { content: '18238 Chhattisgarh Express mein 3A mein 45 seats available hain.' }]
      });
      await h.say(SEARCH_T, mode);
      await h.say('pehli wali ka timetable batao', mode);
      const before = { focus: h.s().focusTrainNumber, info: JSON.stringify(h.s().infoAvailability ?? null), avail: JSON.stringify(h.s().availability ?? null) };
      const r = await h.say(U2, mode);
      expect(av(r)).toEqual([NOT_GROUNDED]);
      expect(availSpy).not.toHaveBeenCalled();
      expect(avCards(r)).toEqual([]);
      expect(selectedOf(h)).toBeNull();
      expect(h.s().focusTrainNumber).toBe(before.focus);
      expect(JSON.stringify(h.s().infoAvailability ?? null)).toBe(before.info);
      expect(JSON.stringify(h.s().availability ?? null)).toBe(before.avail);
      expect(shown(r)).not.toMatch(/45 seats/i);                           // invented value never reaches the user
      const fb = h.feedback(U2).filter((x: any) => x.name === 'CHECK_AVAILABILITY');
      expect(fb.length).toBe(1);
      expect(JSON.stringify(fb[0].content)).toMatch(/identify nahi hui|AUTHORITATIVE_DATA_REQUIRED/);
      expect(JSON.stringify(fb[0].content)).not.toMatch(/AVAILABLE|Waitlist|seats/i);   // no availability data in the rejection
    });

    it(`[I] "abhi" / "dobara" / "fresh" → a NEW provider call every time (no caching) (${mode})`, async () => {
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '12497 SL availability abhi batao': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }],
        '12497 SL dobara check karo': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }],
        'Abhi dobara check karo': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }],
        'aur 3A mein?': [{ calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }, { content: '12497 mein 3A available hai.' }],
        'doosri wali SL fresh check karo': [{ calls: [AV({ trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }],
        '12497 SL select karo': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'SL', selectionPurpose: 'BOOKING' })] }, { content: 'Select ho gayi.' }],
        'abhi dobara availability check karo': [{ calls: [AV({})] }, { content: '12497 mein SL Waitlist 12 hai.' }]
      });
      await h.say(SEARCH_T, mode);
      expect(av(await h.say('12497 SL availability abhi batao', mode))).toEqual([['SUCCEEDED', null]]);
      expect(av(await h.say('12497 SL dobara check karo', mode))).toEqual([['SUCCEEDED', null]]);
      // no number repeated: the earlier grounded enquiry of 12497 in THIS journey + result set (P42-12 F3 record) grounds it
      expect(av(await h.say('Abhi dobara check karo', mode))).toEqual([['SUCCEEDED', null]]);
      expect(av(await h.say('aur 3A mein?', mode))).toEqual([['SUCCEEDED', null]]);
      expect(av(await h.say('doosri wali SL fresh check karo', mode))).toEqual([['SUCCEEDED', null]]);
      await h.say('12497 SL select karo', mode);
      expect(av(await h.say('abhi dobara availability check karo', mode))).toEqual([['SUCCEEDED', null]]);
      expect(avCalls()).toEqual(['12497/SL', '12497/SL', '12497/SL', '12497/3A', '12497/SL', '12497/SL']);
    });
  }
});

describe('[V] validator rules for CHECK_AVAILABILITY (unit)', () => {
  const v = new ToolCallValidator();
  const rows = [['12014', 'Amritsar Shatabdi Express', '04:55', ['CC', '2S']], ['12497', 'Shan-e-Punjab Express', '06:35', ['3A', 'CC', 'SL', '2S']], ['18238', 'Chhattisgarh Express', '19:35', ['3A', 'SL']]]
    .map(([n, name, dep, cls], i) => ({ trainNumber: n, trainName: name, departure: dep, arrival: '12:00', classes: (cls as string[]).map(code => ({ code })), displayIndex: i + 1 }));
  const sess = (o: any = {}) => ({ sessionId: 's', origin: 'ASR', destination: 'NDLS', originName: 'Amritsar Junction', destinationName: 'New Delhi', date: D1,
    searchResults: { trains: rows, date: D1, origin: 'ASR', destination: 'NDLS', sourceTurnId: 'turn-1' }, searchResultsVersion: 1, ...o }) as any;
  const g = (userText: string) => ({ userText, bookings: [], pnrOwner: () => 'NONE', bookingOwner: () => 'NONE' }) as any;
  const call = (args: any) => ({ callId: 'c', name: 'CHECK_AVAILABILITY', arguments: { ...args } }) as any;
  const run = (args: any, s: any, text: string, turnId = 'turn-2') => v.validate(call(args), s, g(text), { turnId, userText: text });
  const code = (r: any) => (r.ok ? 'OK' : r.error.code);
  const selected = { number: '12014', trainNumber: '12014', availableClasses: ['CC', '2S'], classes: [{ code: 'CC' }, { code: '2S' }] };

  it('allowed: typed number / named row / trainRef on a shown list / selected train / typed number on a same-turn list', () => {
    expect(code(run({ trainNumber: '12497', travelClass: 'SL' }, sess(), '12497 SL mein seat hai?'))).toBe('OK');
    expect(code(run({ trainNumber: '12497', travelClass: 'SL' }, sess(), 'Shan-e-Punjab ki SL availability'))).toBe('OK');
    expect(code(run({ trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, travelClass: 'SL' }, sess(), 'doosri wali ki SL'))).toBe('OK');
    expect(code(run({ trainRef: { kind: 'TIME_PREFERENCE', value: 'EVENING' }, travelClass: '3A' }, sess(), 'shaam wali ki 3A'))).toBe('OK');
    expect(code(run({ trainRef: { kind: 'TRAIN_NAME', value: 'Chhattisgarh' }, travelClass: '3A' }, sess(), 'Chhattisgarh wali 3A'))).toBe('OK');
    expect(code(run({ trainRef: { kind: 'DEMONSTRATIVE', value: 'THIS' }, travelClass: 'SL' }, sess({ focusTrainNumber: '12497' }), 'iski SL'))).toBe('OK');
    expect(code(run({ travelClass: 'CC' }, sess({ selectedTrain: selected }), 'availability batao'))).toBe('OK');
    expect(code(run({ trainNumber: '12014', travelClass: '2S' }, sess({ selectedTrain: selected, selectedClass: 'CC' }), 'iski 2S'))).toBe('OK');
    expect(code(run({ trainNumber: '12014' }, sess({ selectedTrain: selected, selectedClass: 'CC' }), 'availability batao'))).toBe('OK');
    expect(code(run({ trainNumber: '18238', travelClass: '3A' }, sess(), 'trains dikhao aur 18238 ki 3A bhi', 'turn-1'))).toBe('OK');
    expect(code(run({ trainNumber: '18238', travelClass: '3A' }, sess(), 'trains dikhao aur Chhattisgarh ki 3A bhi', 'turn-1'))).toBe('OK');
  });

  it('rejected: a listed train never referred to / TRAIN_NUMBER ref / positional ref to a same-turn list / focus by bare number', () => {
    const NG = 'AUTHORITATIVE_DATA_REQUIRED';
    expect(code(run({ trainNumber: '12497', travelClass: 'SL' }, sess(), 'subah 6 baje tak pahunchna hai'))).toBe(NG);
    expect(code(run({ trainNumber: '18238', travelClass: '3A' }, sess(), 'availability batao'))).toBe(NG);
    expect(code(run({ trainRef: { kind: 'TRAIN_NUMBER', value: '18238' }, travelClass: '3A' }, sess(), 'availability batao'))).toBe(NG);
    expect(code(run({ trainNumber: '18238', travelClass: '3A' }, sess(), 'Amritsar se Delhi kal ki 3A trains dikhao', 'turn-1'))).toBe(NG);
    expect(code(run({ trainRef: { kind: 'DISPLAY_INDEX', value: 1 }, travelClass: 'CC' }, sess(), 'trains dikhao aur pehli wali ki availability', 'turn-1'))).toBe(NG);
    expect(code(run({ trainNumber: '12497', travelClass: 'SL' }, sess({ focusTrainNumber: '12497' }), 'aur batao'))).toBe(NG);
    expect(code(run({ trainNumber: '18238', travelClass: '3A' }, sess({ selectedTrain: selected }), 'availability batao'))).toBe(NG);
  });

  it('earlier grounded enquiry (P42-12 F3 record) grounds a follow-up only for the CURRENT result set', () => {
    const rec = (searchResultId: string) => ({ ['12497|SL|' + D1 + '|ASR|NDLS']: { trainNumber: '12497', travelClass: 'SL', date: D1, origin: 'ASR', destination: 'NDLS', searchResultId, status: 'WL 12' } });
    const withRs = (o: any = {}) => sess({ searchResults: { trains: rows, date: D1, origin: 'ASR', destination: 'NDLS', sourceTurnId: 'turn-1', resultId: 'rs-1' }, ...o });
    expect(code(run({ trainNumber: '12497', travelClass: 'SL' }, withRs({ infoAvailability: rec('rs-1') }), 'abhi dobara check karo'))).toBe('OK');
    expect(code(run({ trainNumber: '12497', travelClass: '3A' }, withRs({ infoAvailability: rec('rs-1') }), 'aur 3A mein?'))).toBe('OK');
    expect(code(run({ trainNumber: '12497', travelClass: 'SL' }, withRs({ infoAvailability: rec('rs-OLD') }), 'abhi dobara check karo'))).toBe('AUTHORITATIVE_DATA_REQUIRED');
    expect(code(run({ trainNumber: '18238', travelClass: '3A' }, withRs({ infoAvailability: rec('rs-1') }), 'abhi dobara check karo'))).toBe('AUTHORITATIVE_DATA_REQUIRED');
  });

  it('rejected (unchanged codes): unknown number, stale result set, no result set, ungrounded selected-class mismatch', () => {
    expect(code(run({ trainNumber: '12030', travelClass: 'CC' }, sess(), '12030 CC'))).toBe('INVALID_TRAIN_REFERENCE');
    expect(code(run({ trainNumber: '55555', travelClass: 'CC' }, sess(), 'availability batao'))).toBe('INVALID_TRAIN_REFERENCE');
    expect(code(run({ trainNumber: '12497', travelClass: 'SL' }, sess({ date: D2 }), '12497 SL'))).toBe('INVALID_ACTION_FOR_STATE');
    expect(code(run({ trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, travelClass: 'SL' }, sess({ origin: 'LDH' }), 'doosri wali'))).toBe('INVALID_ACTION_FOR_STATE');
    expect(code(run({ trainNumber: '12497', travelClass: 'SL' }, sess({ searchResults: undefined, searchResultsVersion: 0 }), '12497 SL'))).toBe('INVALID_ACTION_FOR_STATE');
    expect(code(run({}, sess(), 'availability batao'))).toBe('INVALID_ACTION_FOR_STATE');
  });
});
