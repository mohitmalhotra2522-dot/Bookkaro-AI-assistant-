/**
 * Train-selection grounding — a train becomes the SELECTED train only when the user's own reference establishes it.
 * Observed live (staging, gpt-oss): "3A mein 2 log hain" → the model selected 12716, which the user never mentioned; the
 * selected train is trusted downstream (availability / info / timetable), so that selection would unlock lookups too.
 * Real orchestrator + turn engine + runtime + applier; a fake OpenAI-compatible server plays the native agent; MOCK railway
 * provider (ASR→NDLS = 1 12014 SHATABDI 04:55 [CC, 2S] · 2 12497 SHAN-E-PUNJAB 06:35 [3A, CC, SL, 2S] · 3 18238 19:35 [3A, SL];
 * ASR→LDH = 12014 / 04672).
 *   [A] explicit train number typed by the user (earlier list and same-turn search) / a named row → selected
 *   [B] valid current result reference ("doosri wali", "last wali", "evening wali") → selected; "subah wali" with two
 *       morning trains → never guessed (resolver ambiguity)
 *   [C] confirmation of the selected train / of a train the user already enquired about in this journey + result set /
 *       "ye wali" after a grounded lookup → selected
 *   [D] "3A mein 2 log hain" → no selection
 *   [E] "2 tickets chahiye" → no selection
 *   [F] "AC chahiye" → no selection
 *   [G] model-generated train number (its "best" pick, a listed row) not grounded by the user → rejected
 *   [H] stale train after a route / date / new-search change → rejected
 *   [I] rejected selection changes neither the selection nor the focus
 *   [J] rejected selection gives no downstream authority: no availability / info call reaches the provider
 *   [K] TEXT and VOICE: every behavioural case runs in both modes
 *   [U] selectionGrounding rules (unit): CLASS_PREFERENCE never selects; stale result set never selects
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
import { selectionGrounding } from '../../server/ai/context/train-selection-grounding';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('train-selection-grounding', () => new MockRailwayProvider());
const ist = (d: number) => new Date(Date.now() + 5.5 * 3600_000 + d * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1), D2 = ist(2);
const SEARCH = (date = D1, destination = 'Delhi') => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination, date } });
const AV = (args: any) => ({ name: 'CHECK_AVAILABILITY', args });
const INFO = (args: any = {}) => ({ name: 'GET_TRAIN_INFO', args });
const TT = (trainNumber?: string) => ({ name: 'GET_TIMETABLE', args: trainNumber ? { trainNumber } : {} });
const U = (entities: any, intent = 'BOOK_TRAIN', action = 'SELECT_TRAIN') => ({ name: 'update_booking_session', args: { intent, action, entities } });
const NUM = (value: string) => ({ kind: 'TRAIN_NUMBER', value });
const SEARCH_T = 'Amritsar se Delhi kal ki trains dikhao';
type Mode = 'TEXT' | 'VOICE';
const MODES: Mode[] = ['TEXT', 'VOICE'];

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-SELGROUND', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
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
const execs = (r: any) => ((r?.turnLog?.toolExecutions || []) as any[]);
const refs = (r: any) => ((r?.turnLog?.diagnostics?.references?.records || []) as any[]).filter(x => x.via === 'SELECTION');
const eventsOf = (r: any) => ((r?.turnLog?.events || []) as any[]).map(e => (typeof e === 'string' ? e : e?.type));
const selectedOf = (h: any) => h.s().selectedTrain ? String(h.s().selectedTrain.number ?? h.s().selectedTrain.trainNumber) : null;
/** what the agent was told about its rejected update_booking_session proposal */
const updateFeedback = (h: any, u: string) => h.feedback(u).filter((x: any) => x.name === 'update_booking_session').map((x: any) => x.content);
const INTERNAL = /TRAIN_NOT_GROUNDED|STALE_RESULT_SET|INVALID_TRAIN_REFERENCE|UNGROUNDED|validator|selectionGrounding|tool call|update_booking_session/i;

/** the rejection contract: nothing selected / focused, no TRAIN_SELECTED, record + agent feedback carry the structured reason */
function expectRejected(h: any, r: any, u: string, focusBefore: string | null | undefined, reason = 'TRAIN_NOT_GROUNDED') {
  expect(selectedOf(h)).toBeNull();
  expect(h.s().focusTrainNumber ?? null).toBe(focusBefore ?? null);
  expect(eventsOf(r)).not.toContain('TRAIN_SELECTED');
  expect(cardsOf(r).some(c => c.type === 'selected_train')).toBe(false);
  const rec = refs(r).at(-1);
  expect(rec).toMatchObject({ grounding: reason, resolvedTrainNumber: null });
  const fb = updateFeedback(h, u).at(-1);
  expect(JSON.stringify(fb)).toContain(reason);
  expect(JSON.stringify(fb)).toContain('"missingField":"TRAIN"');
  expect(shown(r)).not.toMatch(INTERNAL);
}

let fetchSpy: any, availSpy: any, infoSpy: any, ttSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('train-selection-grounding');
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  availSpy = vi.spyOn(MockRailwayProvider.prototype, 'checkAvailability');
  infoSpy = vi.spyOn(MockRailwayProvider.prototype as any, 'getTrainInfo');
  ttSpy = vi.spyOn(MockRailwayProvider.prototype as any, 'getTimetable');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); railwayRegistry.setActive('mock'); });

describe('Train-selection grounding (MOCK, scripted native agent)', () => {
  for (const mode of MODES) {
    it(`[A] explicit train number / named row → selected; also in the same turn as the search (${mode})`, async () => {
      const SAME = 'Amritsar se Delhi kal ki trains dikhao aur 18238 select karo';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '12497 select karo': [{ calls: [U({ trainRef: NUM('12497') })] }, { content: '12497 select ho gayi.' }],
        'Shatabdi wali book karni hai': [{ calls: [U({ trainRef: NUM('12014') })] }, { content: '12014 select ho gayi.' }],
        [SAME]: [{ calls: [SEARCH()] }, { calls: [U({ trainRef: NUM('18238') })] }, { content: '18238 select ho gayi.' }]
      });
      await h.say(SEARCH_T, mode);
      const r1 = await h.say('12497 select karo', mode);
      expect(selectedOf(h)).toBe('12497');
      expect(eventsOf(r1)).toContain('TRAIN_SELECTED');
      expect(refs(r1).at(-1)).toMatchObject({ status: 'VALID', resolvedTrainNumber: '12497', grounding: 'TYPED_NUMBER' });
      const r2 = await h.say('Shatabdi wali book karni hai', mode);
      expect(selectedOf(h)).toBe('12014');
      expect(refs(r2).at(-1)).toMatchObject({ grounding: 'NAMED_ROW' });
      const h2 = stack({ [SAME]: [{ calls: [SEARCH()] }, { calls: [U({ trainRef: NUM('18238') })] }, { content: '18238 select ho gayi.' }] });
      await h2.say(SAME, mode);
      expect(selectedOf(h2)).toBe('18238');
    });

    it(`[B] valid current result references → selected; "subah wali" with two morning trains is never guessed (${mode})`, async () => {
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        'doosri wali le lo': [{ calls: [U({ trainRef: { kind: 'DISPLAY_INDEX', value: 2 } })] }, { content: 'Doosri train select ho gayi.' }],
        'nahi, last wali': [{ calls: [U({ trainRef: { kind: 'DEMONSTRATIVE', value: 'LAST' } })] }, { content: 'Last train select ho gayi.' }],
        'subah wali chahiye': [{ calls: [U({ trainRef: { kind: 'TIME_PREFERENCE', value: 'MORNING' } })] }, { content: 'Subah do trains hain.' }],
        'shaam wali chahiye': [{ calls: [U({ trainRef: { kind: 'TIME_PREFERENCE', value: 'EVENING' } })] }, { content: 'Shaam wali select ho gayi.' }]
      });
      await h.say(SEARCH_T, mode);
      const r1 = await h.say('doosri wali le lo', mode);
      expect(selectedOf(h)).toBe('12497');
      expect(refs(r1).at(-1)).toMatchObject({ referenceType: 'DISPLAY_INDEX', status: 'VALID', grounding: 'RESOLVED_REFERENCE' });
      await h.say('nahi, last wali', mode);
      expect(selectedOf(h)).toBe('18238');
      const h2 = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        'subah wali chahiye': [{ calls: [U({ trainRef: { kind: 'TIME_PREFERENCE', value: 'MORNING' } })] }, { content: 'Subah do trains hain.' }],
        'shaam wali chahiye': [{ calls: [U({ trainRef: { kind: 'TIME_PREFERENCE', value: 'EVENING' } })] }, { content: 'Shaam wali select ho gayi.' }]
      });
      await h2.say(SEARCH_T, mode);
      const r3 = await h2.say('subah wali chahiye', mode);              // 12014 04:55 + 12497 06:35 → ambiguous, never a guess
      expect(selectedOf(h2)).toBeNull();
      expect(refs(r3).at(-1)).toMatchObject({ status: 'AMBIGUOUS' });
      await h2.say('shaam wali chahiye', mode);                         // exactly one evening train → resolver proves it
      expect(selectedOf(h2)).toBe('18238');
    });

    it(`[C] confirmation: the selected train, a train the user enquired about, "ye wali" after a grounded lookup → selected (${mode})`, async () => {
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '18238 ki 3A availability batao': [{ calls: [AV({ trainNumber: '18238', travelClass: '3A' })] }, { content: '18238 mein 3A available hai.' }],
        'theek hai, wahi book karo': [{ calls: [U({ trainRef: NUM('18238'), selectionPurpose: 'BOOKING' })] }, { content: '18238 select ho gayi.' }],
        'haan wahi wali rakho': [{ calls: [U({ trainRef: NUM('18238') })] }, { content: '18238 hi selected hai.' }]
      });
      await h.say(SEARCH_T, mode);
      await h.say('18238 ki 3A availability batao', mode);
      expect(selectedOf(h)).toBeNull();                                 // the enquiry itself never selects
      const r1 = await h.say('theek hai, wahi book karo', mode);
      expect(selectedOf(h)).toBe('18238');
      expect(refs(r1).at(-1)).toMatchObject({ grounding: 'GROUNDED_ENQUIRY' });
      const r2 = await h.say('haan wahi wali rakho', mode);
      expect(selectedOf(h)).toBe('18238');
      expect(refs(r2).at(-1)).toMatchObject({ grounding: 'ALREADY_SELECTED' });

      const h2 = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '12497 ka timetable batao': [{ calls: [TT('12497')] }, { content: '12497 ka timetable mil gaya.' }],
        'ye wali book karo': [{ calls: [U({ trainRef: { kind: 'DEMONSTRATIVE', value: 'THIS' } })] }, { content: '12497 select ho gayi.' }]
      });
      await h2.say(SEARCH_T, mode);
      await h2.say('12497 ka timetable batao', mode);
      expect(h2.s().focusTrainNumber).toBe('12497');
      const r3 = await h2.say('ye wali book karo', mode);
      expect(selectedOf(h2)).toBe('12497');
      expect(refs(r3).at(-1)).toMatchObject({ referenceType: 'DEMONSTRATIVE', grounding: 'RESOLVED_REFERENCE' });
    });

    it(`[D] "3A mein 2 log hain" → no train selected (staging H1-V-r2 t3 shape) (${mode})`, async () => {
      const u = '3A mein 2 log hain';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [u]: [{ calls: [U({ trainRef: NUM('18238'), classRaw: '3A', passengersCountRaw: 2 })] }, { content: 'Kaunsi train mein jaana hai?' }]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(u, mode);
      expectRejected(h, r, u, null);
      expect(h.s().selectedClass ?? null).toBeNull();
      expect(shown(r)).toBe('Kaunsi train mein jaana hai?');           // the agent words the clarification itself
    });

    it(`[E] "2 tickets chahiye" → no train selected (${mode})`, async () => {
      const u = '2 tickets chahiye';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [u]: [{ calls: [U({ trainRef: NUM('12014'), passengersCountRaw: 2 })] }, { content: 'Kaunsi train chahiye?' }]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(u, mode);
      expectRejected(h, r, u, null);
    });

    it(`[F] "AC chahiye" → no train selected (TRAIN_NUMBER and CLASS_PREFERENCE proposals) (${mode})`, async () => {
      const u = 'AC chahiye';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [u]: [{ calls: [U({ trainRef: NUM('12497'), classRaw: '3A' })] }, { calls: [U({ trainRef: { kind: 'CLASS_PREFERENCE', value: '3A' } })] }, { content: 'AC kaunsi train mein chahiye?' }]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(u, mode);
      expect(selectedOf(h)).toBeNull();
      expect(refs(r)[0]).toMatchObject({ referenceType: 'TRAIN_NUMBER', grounding: 'TRAIN_NOT_GROUNDED' });
      expect(eventsOf(r)).not.toContain('TRAIN_SELECTED');
      expect(shown(r)).not.toMatch(INTERNAL);
    });

    it(`[G] the model's own pick (a listed row / its "best" option) or an invented number → rejected (${mode})`, async () => {
      const BEST = 'sabse achhi wali book kar do';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        [BEST]: [{ calls: [U({ trainRef: NUM('12014'), selectionPurpose: 'BOOKING' })] }, { content: 'Kaunsi train chahiye?' }],
        'koi bhi chalegi': [{ calls: [U({ trainRef: NUM('55555') })] }, { content: 'Kaunsi train chahiye?' }]
      });
      await h.say(SEARCH_T, mode);
      const r1 = await h.say(BEST, mode);
      expectRejected(h, r1, BEST, null);
      const r2 = await h.say('koi bhi chalegi', mode);                   // not in the results at all → resolver refuses
      expect(selectedOf(h)).toBeNull();
      expect(refs(r2).at(-1)).toMatchObject({ status: 'INVALID', resolvedTrainNumber: null });
      expect(eventsOf(r2)).not.toContain('TRAIN_SELECTED');
    });

    it(`[H] stale train after a route / date / new-search change → rejected (${mode})`, async () => {
      const ROUTE = 'Amritsar se Ludhiana kal ki trains dikhao';
      const DATE = 'parso ki trains dikhao';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '12014 select karo': [{ calls: [U({ trainRef: NUM('12014') })] }, { content: '12014 select ho gayi.' }],
        [ROUTE]: [{ calls: [SEARCH(D1, 'Ludhiana')] }, { content: 'Ludhiana ki trains mil gayi.' }],
        'pichli wali hi rakho': [{ calls: [U({ trainRef: NUM('12014') })] }, { content: 'Kaunsi train?' }]
      });
      await h.say(SEARCH_T, mode);
      await h.say('12014 select karo', mode);
      expect(selectedOf(h)).toBe('12014');
      await h.say(ROUTE, mode);                                             // 12014 runs on both routes
      expect(selectedOf(h)).toBeNull();
      const r1 = await h.say('pichli wali hi rakho', mode);
      expectRejected(h, r1, 'pichli wali hi rakho', h.s().focusTrainNumber);

      const h2 = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '18238 ki 3A availability batao': [{ calls: [AV({ trainNumber: '18238', travelClass: '3A' })] }, { content: '18238 mein 3A available hai.' }],
        [DATE]: [{ calls: [SEARCH(D2)] }, { content: 'Parso ki trains mil gayi.' }],
        'wahi wali book karo': [{ calls: [U({ trainRef: NUM('18238') })] }, { content: 'Kaunsi train?' }]
      });
      await h2.say(SEARCH_T, mode);
      await h2.say('18238 ki 3A availability batao', mode);
      await h2.say(DATE, mode);                                             // new search for a new date: the D1 enquiry is gone
      expect(h2.s().searchResults.date).toBe(D2);
      const r2 = await h2.say('wahi wali book karo', mode);
      expectRejected(h2, r2, 'wahi wali book karo', h2.s().focusTrainNumber);
    });

    it(`[I] a rejected selection changes neither the selection nor the focus (${mode})`, async () => {
      const u = '3A mein 2 log hain';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '12497 ka timetable batao': [{ calls: [TT('12497')] }, { content: '12497 ka timetable mil gaya.' }],
        [u]: [{ calls: [U({ trainRef: NUM('18238'), classRaw: '3A', passengersCountRaw: 2 })] }, { content: 'Kaunsi train?' }],
        '12014 select karo': [{ calls: [U({ trainRef: NUM('12014') })] }, { content: '12014 select ho gayi.' }],
        'AC chahiye': [{ calls: [U({ trainRef: NUM('12497') })] }, { content: 'Theek hai.' }]
      });
      await h.say(SEARCH_T, mode);
      await h.say('12497 ka timetable batao', mode);
      expect(h.s().focusTrainNumber).toBe('12497');
      const r = await h.say(u, mode);
      expectRejected(h, r, u, '12497');
      expect(h.s().previousTrainNumber ?? null).toBeNull();
      // with a selection in place, a rejected proposal for another train keeps the existing selection and its focus
      await h.say('12014 select karo', mode);
      expect(selectedOf(h)).toBe('12014');
      const v = h.s().sessionVersion;
      const r2 = await h.say('AC chahiye', mode);
      expect(selectedOf(h)).toBe('12014');
      expect(h.s().focusTrainNumber).toBe('12014');
      expect(eventsOf(r2)).not.toContain('TRAIN_SELECTED');
      expect(refs(r2).at(-1)).toMatchObject({ grounding: 'TRAIN_NOT_GROUNDED' });
      expect(h.s().sessionVersion).toBeGreaterThanOrEqual(v);
    });

    it(`[J] a rejected selection creates no downstream authority: availability / info never reach the provider (${mode})`, async () => {
      const u = '3A mein 2 log hain';
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        // the same decision carries a lookup for the train it tried to select; then the agent retries with lookups that
        // would fall back to "the selected train" (no train argument) — the rejected selection never becomes that train.
        // (A GET_TRAIN_INFO naming a row of an already-shown list is allowed by the eabfc1c rule independently of any
        //  selection; it is not what this test is about.)
        [u]: [{ calls: [U({ trainRef: NUM('18238'), classRaw: '3A', passengersCountRaw: 2 }), AV({ trainNumber: '18238', travelClass: '3A' })] },
          { calls: [AV({ travelClass: '3A' }), INFO(), TT()] }, { content: 'Kaunsi train?' }],
        'availability batao': [{ calls: [AV({})] }, { content: 'Kaunsi train?' }]
      });
      await h.say(SEARCH_T, mode);
      const r = await h.say(u, mode);
      expect(selectedOf(h)).toBeNull();
      const looked = execs(r).filter(x => ['CHECK_AVAILABILITY', 'GET_TRAIN_INFO', 'GET_TIMETABLE'].includes(x.tool));
      expect(looked.map(x => x.tool)).toEqual(['CHECK_AVAILABILITY', 'GET_TRAIN_INFO', 'GET_TIMETABLE']);
      expect(looked.every(x => x.status === 'REJECTED')).toBe(true);           // nothing selected → no train to fall back to
      expect(cardsOf(r).some(c => ['availability', 'train_info', 'timetable'].includes(c.type))).toBe(false);
      const r2 = await h.say('availability batao', mode);
      expect(execs(r2).filter(x => x.tool === 'CHECK_AVAILABILITY').map(x => x.status)).toEqual(['REJECTED']);
      expect(availSpy).not.toHaveBeenCalled();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(ttSpy).not.toHaveBeenCalled();
      expect(h.s().availability ?? null).toBeNull();
      expect(Object.keys(h.s().infoAvailability || {})).toEqual([]);
      expect(h.s().lastTrainInfo ?? null).toBeNull();
      expect(h.s().lastTimetable ?? null).toBeNull();
      expect(h.s().focusTrainNumber ?? null).toBeNull();
    });
  }

  it('[K] TEXT and VOICE give the same selection outcome for the same proposals', async () => {
    const out: Record<string, any> = {};
    for (const mode of MODES) {
      const h = stack({
        [SEARCH_T]: [{ calls: [SEARCH()] }, { content: 'Kal ki 3 trains mili hain.' }],
        '3A mein 2 log hain': [{ calls: [U({ trainRef: NUM('18238'), classRaw: '3A', passengersCountRaw: 2 })] }, { content: 'Kaunsi train?' }],
        '12497 select karo': [{ calls: [U({ trainRef: NUM('12497') })] }, { content: '12497 select ho gayi.' }]
      });
      await h.say(SEARCH_T, mode);
      const a = await h.say('3A mein 2 log hain', mode);
      const s1 = selectedOf(h);
      const b = await h.say('12497 select karo', mode);
      out[mode] = { s1, s2: selectedOf(h), g: [refs(a).at(-1)?.grounding, refs(b).at(-1)?.grounding] };
    }
    expect(out.TEXT).toEqual({ s1: null, s2: '12497', g: ['TRAIN_NOT_GROUNDED', 'TYPED_NUMBER'] });
    expect(out.VOICE).toEqual(out.TEXT);
  });
});

describe('selectionGrounding (unit)', () => {
  const rows = [
    { trainNumber: '11111', trainName: 'ALPHA EXPRESS', departure: '06:00', classes: [{ code: '3A' }] },
    { trainNumber: '22222', trainName: 'BRAVO MAIL', departure: '21:00', classes: [{ code: 'SL' }] }
  ];
  const sess = (o: any = {}) => ({ origin: 'ASR', destination: 'NDLS', date: '2030-01-02', searchResultsVersion: 1,
    searchResults: { date: '2030-01-02', origin: 'ASR', destination: 'NDLS', trains: rows, sourceTurnId: 't1' }, ...o }) as any;

  it('[U1] typed number / named row / already selected / grounded enquiry → grounded', () => {
    expect(selectionGrounding(NUM('22222') as any, '22222', sess(), 'haan 22222 wali')).toEqual({ ok: true, via: 'TYPED_NUMBER' });
    expect(selectionGrounding(NUM('22222') as any, '22222', sess(), 'bravo wali chahiye')).toEqual({ ok: true, via: 'NAMED_ROW' });
    expect(selectionGrounding(NUM('22222') as any, '22222', sess({ selectedTrain: { number: '22222' } }), 'theek hai')).toEqual({ ok: true, via: 'ALREADY_SELECTED' });
    // the backend itself asked "11111 selected hai. 22222 check karna hai?" (pending CONTEXT_CONFLICT on selectedTrain) → "haan"
    const conflict = { type: 'CLARIFICATION_REQUIRED', data: { kind: 'CONTEXT_CONFLICT', field: 'selectedTrain', proposedCode: '22222', current: '11111' } };
    expect(selectionGrounding(NUM('22222') as any, '22222', sess({ selectedTrain: { number: '11111' }, pendingInteraction: conflict }), 'haan')).toEqual({ ok: true, via: 'PENDING_CONFIRMATION' });
    // …but that pending proposal grounds only the proposed train
    expect(selectionGrounding(NUM('11111') as any, '11111', sess({ pendingInteraction: conflict }), 'haan')).toEqual({ ok: false, reason: 'TRAIN_NOT_GROUNDED' });
    // an earlier grounded enquiry of that train in THIS journey + result set (P42-12 F3 record) grounds the plain number
    const rec = { trainNumber: '22222', travelClass: 'SL', status: 'WL 4', date: '2030-01-02', origin: 'ASR', destination: 'NDLS', searchResultId: 'rs-1' };
    const withRec = (o: any = {}) => { const x = sess({ infoAvailability: { k: rec }, ...o }); x.searchResults.resultId = 'rs-1'; return x; };
    expect(selectionGrounding(NUM('22222') as any, '22222', withRec(), 'wahi book karo')).toEqual({ ok: true, via: 'GROUNDED_ENQUIRY' });
    // the record belongs to its result set: another result set (new search) → no longer grounds it
    const other = withRec(); other.searchResults.resultId = 'rs-2';
    expect(selectionGrounding(NUM('22222') as any, '22222', other, 'wahi book karo')).toEqual({ ok: false, reason: 'TRAIN_NOT_GROUNDED' });
  });

  it('[U2] a plain TRAIN_NUMBER the model produced, never referred to by the user → not grounded', () => {
    for (const t of ['3A mein 2 log hain', '2 tickets chahiye', 'AC chahiye', '', undefined]) {
      expect(selectionGrounding(NUM('11111') as any, '11111', sess(), t as any)).toEqual({ ok: false, reason: 'TRAIN_NOT_GROUNDED' });
    }
    // a number typed for something else does not ground a different train
    expect(selectionGrounding(NUM('11111') as any, '11111', sess(), '22222 ka timetable')).toEqual({ ok: false, reason: 'TRAIN_NOT_GROUNDED' });
  });

  it('[U3] CLASS_PREFERENCE never selects, even when exactly one row has the class', () => {
    expect(selectionGrounding({ kind: 'CLASS_PREFERENCE', value: '3A' } as any, '11111', sess(), '3A mein 2 log hain')).toEqual({ ok: false, reason: 'TRAIN_NOT_GROUNDED' });
  });

  it('[U4] positional / descriptive references resolved by the backend resolver → grounded', () => {
    for (const ref of [{ kind: 'DISPLAY_INDEX', value: 2 }, { kind: 'DEMONSTRATIVE', value: 'LAST' }, { kind: 'TIME_PREFERENCE', value: 'NIGHT' }, { kind: 'TRAIN_NAME', value: 'BRAVO' }, { kind: 'ALTERNATIVE', value: 'OTHER' }]) {
      expect(selectionGrounding(ref as any, '22222', sess(), 'x')).toEqual({ ok: true, via: 'RESOLVED_REFERENCE' });
    }
  });

  it('[U5] a result set for an older date / route never yields a selection — not even for a typed number', () => {
    expect(selectionGrounding(NUM('22222') as any, '22222', sess({ date: '2030-01-03' }), '22222 select karo')).toEqual({ ok: false, reason: 'STALE_RESULT_SET' });
    expect(selectionGrounding({ kind: 'DISPLAY_INDEX', value: 2 } as any, '22222', sess({ destination: 'LDH' }), 'doosri wali')).toEqual({ ok: false, reason: 'STALE_RESULT_SET' });
  });
});
