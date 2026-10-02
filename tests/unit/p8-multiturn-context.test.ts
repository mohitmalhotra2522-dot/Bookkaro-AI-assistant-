/**
 * PROMPT 8 — GROUP 2
 * Multi-turn context + slot filling + reference resolution + corrections + ambiguity.
 *
 * Deterministic: MockLLMProvider + MockRailwayProvider (labelled mock dev data).
 * Dates are computed through DateResolver (never hard-coded "tomorrow").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';
import { TrainReferenceResolver } from '../../server/ai/context/train-reference-resolver';
import { ClassReferenceResolver } from '../../server/ai/context/class-reference-resolver';
import { derivePendingInteraction, isPureAffirmation, isPureNegation } from '../../server/ai/context/pending-interaction';
import { BookingState } from '../../shared/states';

const D = (raw: string) => { const r = resolveDate(raw); if (!r.ok) throw new Error('bad date'); return r.date; };

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const newSession = () => state.createSession().sessionId;
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => orch.processTurn(sid, text, mode);
const toolNames = (r: any) => (r.turnLog.toolResults || []).map((t: any) => t.toolName);

async function toTrainList(sid: string) {
  await say(sid, 'Amritsar se Delhi jaana hai');
  return say(sid, 'Kal 2 log');
}

beforeEach(() => {
  railwayRegistry.setActive('mock');
  state = new ConversationStateManager();
  orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
});

describe('Group 2 — multi-turn context & slot filling', () => {
  it('[1][A][23] multi-turn journey collection: route known, date missing → asks ONLY date, no search', async () => {
    const sid = newSession();
    const r = await say(sid, 'Amritsar se Delhi jaana hai.');
    expect(r.context.origin).toBe('ASR');
    expect(r.context.destination).toBe('NDLS');
    expect(r.context.date).toBeUndefined();
    expect(toolNames(r)).toEqual([]);                      // no premature search
    expect(r.pendingInteraction?.type).toBe('DATE_REQUIRED');
    expect(r.responseMessage).toContain('Kis date ko jaana hai?');
    expect(r.responseMessage).not.toMatch(/kahan se|kahan jaana/i); // never re-asks route
  });

  it('[2][B] date follow-up "Kal 2 log" uses pending context → date+pax filled and SEARCH_TRAINS runs', async () => {
    const sid = newSession();
    await say(sid, 'Amritsar se Delhi jaana hai');
    const r = await say(sid, 'Kal 2 log.');
    expect(r.context.date).toBe(D('kal'));
    expect(r.context.passengersCount).toBe(2);
    expect(r.context.origin).toBe('ASR');                   // route NOT lost / not re-asked
    expect(toolNames(r)).toEqual(['SEARCH_TRAINS']);
    expect(r.newState).toBe(BookingState.SHOWING_TRAINS);
    expect(r.pendingInteraction?.type).toBe('TRAIN_SELECTION_REQUIRED');
    expect(r.cards?.some(c => c.type === 'trains')).toBe(true);
  });

  it('[27] out-of-order slot filling: passengers → route → date accumulates and then searches', async () => {
    const sid = newSession();
    let r = await say(sid, '2 passengers');
    expect(r.context.passengersCount).toBe(2);
    expect(toolNames(r)).toEqual([]);
    expect(r.responseMessage).toContain('Kahan se kahan jaana hai?');
    r = await say(sid, 'Amritsar se Delhi');
    expect(r.context.passengersCount).toBe(2);
    expect(r.responseMessage).toContain('Kis date ko jaana hai?');
    r = await say(sid, 'Kal');
    expect(toolNames(r)).toEqual(['SEARCH_TRAINS']);
    expect(r.context.passengersCount).toBe(2);
    expect(r.context.date).toBe(D('kal'));
  });

  it('multi-slot "Amritsar se Delhi kal jaana hai, 2 log hain, AC chahiye" → search immediately with all slots', async () => {
    const sid = newSession();
    const r = await say(sid, 'Amritsar se Delhi kal jaana hai, 2 log hain, AC chahiye.');
    expect(toolNames(r)).toEqual(['SEARCH_TRAINS']);
    const args = r.turnLog.toolResults![0].validatedArguments!;
    expect(args).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: D('kal'), passengersCount: 2, preferredClass: 'AC' });
  });

  it('[3] passenger follow-up: class selected without count → asks count; "2" answers PASSENGERS_REQUIRED', async () => {
    const sid = newSession();
    await say(sid, 'Amritsar se Delhi');
    await say(sid, 'kal');                                  // no passenger count given
    await say(sid, '12014 wali');
    let r = await say(sid, 'CC');
    // P9: preparation starts right after class selection; count is asked in BOOKING_PREPARE
    expect(r.newState).toBe(BookingState.BOOKING_PREPARE);
    expect(r.pendingInteraction?.type).toBe('PASSENGERS_REQUIRED');
    expect(r.responseMessage).toContain('Kitne passengers hain?');
    r = await say(sid, '2');
    expect(r.context.passengersCount).toBe(2);
    expect(r.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
    expect(r.context.passengers).toHaveLength(2);
  });
});

describe('Group 2 — natural train references (backend-resolved, versioned)', () => {
  it('[5] selection by number "12014 wali" resolves against current results', async () => {
    const sid = newSession();
    await toTrainList(sid);
    const r = await say(sid, '12014 wali');
    expect(r.context.selectedTrain.number).toBe('12014');
    expect(r.newState).toBe(BookingState.CLASS_OPTIONS);
    expect(r.pendingInteraction?.type).toBe('CLASS_SELECTION_REQUIRED');
  });

  it('[6] "pehli wali" → displayIndex 1', async () => {
    const sid = newSession();
    const list = await toTrainList(sid);
    const first = list.context.searchResults.trains[0].trainNumber;
    const r = await say(sid, 'pehli wali');
    expect(r.context.selectedTrain.number).toBe(first);
  });

  it('[7][C] "second wali" → displayIndex 2 → resultId → actual train (never invented)', async () => {
    const sid = newSession();
    const list = await toTrainList(sid);
    const second = list.context.searchResults.trains[1];
    expect(second.displayIndex).toBe(2);
    expect(second.resultId).toMatch(/:2$/);
    const r = await say(sid, 'second wali');
    expect(r.context.selectedTrain.number).toBe(second.trainNumber);
    const ev = r.context.eventLog!.filter(e => e.type === 'TRAIN_SELECTED').pop()!;
    expect(ev.data).toMatchObject({ trainNumber: second.trainNumber, displayIndex: 2, resultId: second.resultId });
  });

  it('[8] "ye wali" resolves to the train in focus (after "12014 batao")', async () => {
    const sid = newSession();
    await toTrainList(sid);
    const info = await say(sid, '12014 batao');
    expect(toolNames(info)).toEqual(['GET_TRAIN_INFO']);
    expect(info.context.selectedTrain).toBeUndefined();     // info ≠ selection
    const r = await say(sid, 'haan ye wali');
    expect(r.context.selectedTrain.number).toBe('12014');
  });

  it('[21] ambiguous references are NOT guessed: "ye wali" w/o focus and "morning wali" with 2 morning trains', async () => {
    const sid = newSession();
    await toTrainList(sid);                                 // 12014 04:55, 12497 06:35, 18238 19:35
    let r = await say(sid, 'ye wali');
    expect(r.error?.code).toBe('AMBIGUOUS_REFERENCE');
    expect(r.context.selectedTrain).toBeUndefined();
    r = await say(sid, 'morning wali');
    expect(r.error?.code).toBe('AMBIGUOUS_REFERENCE');
    expect(r.responseMessage).toContain('12014');
    expect(r.responseMessage).toContain('12497');
    expect(r.context.selectedTrain).toBeUndefined();
    r = await say(sid, 'evening wali');                     // exactly one → resolves
    expect(r.context.selectedTrain.number).toBe('18238');
  });

  it('invalid reference: index beyond list / unknown number → INVALID_TRAIN_REFERENCE, no selection', async () => {
    const sid = newSession();
    await toTrainList(sid);
    let r = await say(sid, 'chauthi wali');
    expect(r.error?.code).toBe('INVALID_TRAIN_REFERENCE');
    r = await say(sid, '99999 wali');
    expect(r.error?.code).toBe('INVALID_TRAIN_REFERENCE');
    expect(r.context.selectedTrain).toBeUndefined();
  });

  it('[18-unit] TrainReferenceResolver rejects a displayIndex minted for an older searchResultsVersion', async () => {
    const sid = newSession();
    const list = await toTrainList(sid);
    const s = state.getSession(sid);
    const res = new TrainReferenceResolver().resolve({ kind: 'DISPLAY_INDEX', value: 2, searchResultsVersion: s.searchResultsVersion - 1 }, s);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('STALE_SEARCH_REFERENCE');
    const ok = new TrainReferenceResolver().resolve({ kind: 'DISPLAY_INDEX', value: 2, searchResultsVersion: s.searchResultsVersion }, s);
    expect(ok.ok && ok.train.trainNumber).toBe(list.context.searchResults.trains[1].trainNumber);
  });

  it('"Nahi, doosri train" (change of mind) with 3 results → ambiguous alternatives, keeps current selection', async () => {
    const sid = newSession();
    await toTrainList(sid);
    await say(sid, '12014 wali');
    const r = await say(sid, 'Nahi, doosri train');
    expect(r.error?.code).toBe('AMBIGUOUS_REFERENCE');
    expect(r.responseMessage).not.toContain('12014 (');     // excludes current
    expect(r.context.selectedTrain.number).toBe('12014');
  });
});

describe('Group 2 — class context', () => {
  it('[4][D] "CC kar do" validates against selectedTrain.availableClasses', async () => {
    const sid = newSession();
    await toTrainList(sid);
    await say(sid, '12014 wali');
    const r = await say(sid, 'CC kar do');
    expect(r.context.selectedClass).toBe('CC');
    expect(r.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
  });

  it('[22] unavailable class is never selected (EC on 12014); generic "AC" with 2 AC classes is ambiguous', async () => {
    const sid = newSession();
    await toTrainList(sid);
    await say(sid, '12014 wali');
    let r = await say(sid, 'EC chahiye');
    expect(r.error?.code).toBe('INVALID_CLASS_SELECTION');
    expect(r.context.selectedClass).toBeUndefined();
    expect(r.responseMessage).toMatch(/available classes CC aur 2S/);
    await say(sid, '12497 wali');
    r = await say(sid, 'AC wali');
    expect(r.error?.code).toBe('AMBIGUOUS_REFERENCE');
    expect(r.context.selectedClass).toBeUndefined();
  });

  it('ClassReferenceResolver unit: chair car→CC, single AC class resolves, unknown rejected', () => {
    const cr = new ClassReferenceResolver();
    const t = { number: '12014', availableClasses: ['CC', '2S'] };
    expect(cr.resolve('chair car', t)).toEqual({ ok: true, code: 'CC' });
    expect(cr.resolve('AC wali', t)).toEqual({ ok: true, code: 'CC' });
    const bad = cr.resolve('3A', t);
    expect(bad.ok).toBe(false);
  });
});

describe('Group 2 — corrections (only the affected slot changes; dependents invalidated)', () => {
  it('[9] class correction "CC nahi 2S" → class changes, fare & availability invalidated (not retained)', async () => {
    const sid = newSession();
    await toTrainList(sid);
    await say(sid, '12014 wali');
    await say(sid, 'CC');
    await say(sid, 'availability bhi check karo');
    let r = await say(sid, 'fare bhi batao');
    expect(r.context.fare).toBeTruthy();
    expect(r.context.availability).toBeTruthy();
    r = await say(sid, 'Class CC nahi 2S');
    expect(r.context.selectedClass).toBe('2S');
    expect(r.context.fare).toBeUndefined();
    expect(r.context.availability).toBeUndefined();
    expect(r.context.selectedTrain.number).toBe('12014');   // unrelated slot preserved
    expect(r.context.passengersCount).toBe(2);
  });

  it('[10][E] destination correction "Actually Ludhiana jaana hai" → old search/selection invalidated, fresh search', async () => {
    const sid = newSession();
    const list = await toTrainList(sid);
    const v1 = list.context.searchResultsVersion;
    await say(sid, '12014 wali');
    await say(sid, 'CC');
    const r = await say(sid, 'Actually Ludhiana jaana hai.');
    expect(r.context.origin).toBe('ASR');                   // origin preserved
    expect(r.context.destination).toBe('LDH');
    expect(r.context.passengersCount).toBe(2);              // unrelated info preserved
    expect(r.context.selectedTrain).toBeUndefined();
    expect(r.context.selectedClass).toBeUndefined();
    expect(r.context.fare).toBeUndefined();
    expect(toolNames(r)).toEqual(['SEARCH_TRAINS']);
    expect(r.context.searchResultsVersion).toBeGreaterThan(v1);
    expect(r.context.searchResults.journey.destination).toBe('LDH');
    expect(r.events).toEqual(expect.arrayContaining(['SESSION_INVALIDATED', 'JOURNEY_UPDATED', 'CORRECTION_APPLIED', 'SEARCH_COMPLETED']));
    expect(r.newState).toBe(BookingState.SHOWING_TRAINS);
  });

  it('"Delhi nahi Ludhiana" and "Amritsar se Chandigarh" / "Chandigarh nahi Jalandhar" corrections', async () => {
    const sid = newSession();
    await toTrainList(sid);
    let r = await say(sid, 'Actually Delhi nahi Ludhiana jaana hai');
    expect(r.context.destination).toBe('LDH');
    r = await say(sid, 'Amritsar se Chandigarh');
    expect(r.context.destination).toBe('CDG');
    r = await say(sid, 'Actually Chandigarh nahi Jalandhar');
    expect(r.context.origin).toBe('ASR');
    expect(r.context.destination).toBe('JUC');
    expect(toolNames(r)).toEqual(['SEARCH_TRAINS']);
  });

  it('[11] date correction "Kal nahi parso" → date via DateResolver, stale facts dropped, fresh search', async () => {
    const sid = newSession();
    await toTrainList(sid);
    await say(sid, 'second wali');
    const r = await say(sid, 'Kal nahi parso.');
    expect(r.context.date).toBe(D('parso'));
    expect(r.context.selectedTrain).toBeUndefined();
    expect(toolNames(r)).toEqual(['SEARCH_TRAINS']);
    expect(r.context.searchResults.journey.date).toBe(D('parso'));
  });

  it('"date change karo" asks for the new date (contextual), then "Sunday" resolves via DateResolver', async () => {
    const sid = newSession();
    await toTrainList(sid);
    let r = await say(sid, 'date change karo');
    expect(r.pendingInteraction?.type).toBe('DATE_REQUIRED');
    expect(r.responseMessage).toContain('Nayi date');
    r = await say(sid, 'Actually Sunday ko jaana hai');
    expect(r.context.date).toBe(D('sunday'));
    expect(toolNames(r)).toEqual(['SEARCH_TRAINS']);
  });

  it('[12] passenger count correction: "Actually 3 passengers", "ek aur add kar do"; fare invalidated, passengers preserved', async () => {
    const sid = newSession();
    await toTrainList(sid);
    await say(sid, '12014 wali');
    await say(sid, 'CC');
    await say(sid, 'Rahul');
    await say(sid, 'fare batao');
    expect(state.getSession(sid).fare).toBeTruthy();
    let r = await say(sid, 'Actually 3 passengers');
    expect(r.context.passengersCount).toBe(3);
    expect(r.context.fare).toBeUndefined();                 // no stale/invented fare
    expect(r.context.passengers).toHaveLength(3);
    expect(r.context.passengers[0].name).toBe('Rahul');     // entered detail preserved
    r = await say(sid, 'ek aur add kar do');
    expect(r.context.passengersCount).toBe(4);
    expect(r.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
    r = await say(sid, 'Sirf 1 passenger');
    expect(r.context.passengersCount).toBe(1);
    expect(r.events).toContain('PASSENGERS_UPDATED');
  });
});

describe('Group 2 — ambiguity & pending interaction', () => {
  it('[20] "Delhi" alone with no context → asks origin-vs-destination; follow-up resolves via pending', async () => {
    const sid = newSession();
    let r = await say(sid, 'Delhi');
    expect(r.error?.code).toBe('AMBIGUOUS_ROUTE');
    expect(r.pendingInteraction?.type).toBe('CLARIFICATION_REQUIRED');
    expect(r.context.origin).toBeUndefined();
    expect(r.context.destination).toBeUndefined();
    r = await say(sid, 'wahan jaana hai');
    expect(r.context.destination).toBe('NDLS');
    expect(r.pendingInteraction?.type).toBe('ORIGIN_REQUIRED');
  });

  it('single station is resolved from context when unambiguous (origin known → destination)', async () => {
    const sid = newSession();
    await say(sid, 'Amritsar se jaana hai');
    const r = await say(sid, 'Delhi');
    expect(r.context.origin).toBe('ASR');
    expect(r.context.destination).toBe('NDLS');
  });

  it('derivePendingInteraction + short reply classifiers are deterministic', () => {
    const s = state.createSession();
    expect(derivePendingInteraction(s).type).toBe('ORIGIN_REQUIRED');
    s.origin = 'ASR'; s.destination = 'NDLS';
    expect(derivePendingInteraction(s).type).toBe('DATE_REQUIRED');
    s.bookingState = BookingState.AWAITING_CONFIRMATION;
    expect(derivePendingInteraction(s).type).toBe('CONFIRMATION_REQUIRED');
    for (const a of ['haan', 'yes', 'okay', 'theek hai', 'kar do', 'Haan book karo.', 'confirm']) expect(isPureAffirmation(a)).toBe(true);
    for (const a of ['haan ye wali', 'CC kar do', '12014', 'kal']) expect(isPureAffirmation(a)).toBe(false);
    expect(isPureNegation('nahi')).toBe(true);
    expect(isPureNegation('nahi, doosri train')).toBe(false);
  });
});
