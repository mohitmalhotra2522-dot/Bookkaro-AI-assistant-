/**
 * P39.2 — the chat asks for (and accepts) every passenger detail the IRCTC form needs: name, age, gender, berth
 * preference (only the selected class's choices) and meal (only when provider data says catering is included).
 * Pure functions + the MockLLM / mock railway data (labelled mock, non-live). No network, no real LLM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { passengerOptionsView, foodStatusOf, optionalToAsk, gateOptionalField } from '../../server/booking/passenger-options';
import { passengerValidator } from '../../server/booking/passenger-validator';
import { passengerCollection } from '../../server/booking/passenger-collection';
import { passengerChangeValidator } from '../../server/booking/preparation/passenger-change-validator';
import { bookingPreparationView } from '../../server/ai/context/context-builder';
import { classifyAvailabilityClaim } from '../../server/ai/response/availability-authority';
import { NATIVE_AGENT_SYSTEM_PROMPT } from '../../server/ai/prompts/system-prompt';
import { nativeToolDefs } from '../../server/ai/providers/openai-compatible-llm';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { ContextualTurnApplier } from '../../server/ai/context/turn-applier';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { prefetchTrainFacilities, awaitTrainFacilities, resetFacilitiesPrefetch } from '../../server/booking/train-facilities-prefetch';

const sess = (cls: string, extra: any = {}): any => ({
  sessionId: 's1', sessionVersion: 3, bookingState: 'COLLECTING_PASSENGER_DETAILS', origin: 'ASR', destination: 'NDLS', date: '2026-10-06',
  selectedTrain: { number: '12926', name: 'PASCHIM EXP' }, selectedClass: cls, passengersCount: 2,
  passengers: [{ id: 'P1' }, { id: 'P2' }], passengerSeq: 2, ...extra
});
const info = (trainNumber: string, facilities?: any) => ({ lastTrainInfo: { trainNumber, trainName: 'X', ...(facilities ? { facilities } : {}) } });

let fetchSpy: any;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('[1] passenger options the chat may ask — nothing invented', () => {
  it('berth choices only from the selected class; seat classes get none', () => {
    expect(passengerOptionsView(sess('3A'))!.berth).toMatchObject({ ask: true, options: ['NO_PREFERENCE', 'LOWER', 'MIDDLE', 'UPPER', 'SIDE_LOWER', 'SIDE_UPPER'] });
    expect(passengerOptionsView(sess('2A'))!.berth.options).not.toContain('MIDDLE');
    expect(passengerOptionsView(sess('CC'))!.berth).toMatchObject({ ask: false, options: [] });
    expect(passengerOptionsView(sess('3A', { selectedClass: undefined }))).toBeUndefined();
  });
  it('meal status comes only from a provider result for THIS train', () => {
    expect(foodStatusOf(sess('3A')).status).toBe('NOT_CHECKED');
    expect(foodStatusOf(sess('3A', info('12926', { catering: true }))).status).toBe('OFFERED');
    expect(foodStatusOf(sess('3A', info('12926', { catering: false, pantry: true })))).toEqual({ status: 'NOT_INCLUDED', pantry: true });
    expect(foodStatusOf(sess('3A', info('12926'))).status).toBe('UNKNOWN');
    expect(foodStatusOf(sess('3A', info('12014', { catering: true }))).status).toBe('NOT_CHECKED');   // another train's data never applies
    expect(foodStatusOf(sess('CC', { trainFacilities: { trainNumber: '12926', catering: true, pantry: null, provider: 'railcore', dataSource: 'LIVE' } })).status).toBe('OFFERED');
    const nc = passengerOptionsView(sess('3A'))!.food as any;
    expect(nc).toMatchObject({ status: 'NOT_CHECKED', ask: false, options: [] });
    expect(nc.howToCheck).toMatch(/GET_TRAIN_INFO/);
    expect(passengerOptionsView(sess('3A', info('12926', { catering: true })))!.food).toMatchObject({ status: 'OFFERED', ask: true, options: ['VEG', 'NON_VEG', 'NO_FOOD'] });
  });
  it('context.bookingPreparation carries passengerOptions + alsoAsk (required fields stay in missing)', () => {
    const v: any = bookingPreparationView(sess('3A', { ...info('12926', { catering: true }), passengers: [{ id: 'P1', name: 'Rahul Sharma', age: 32, gender: 'MALE', berthPreference: 'LOWER' }, { id: 'P2' }] }));
    expect(v.passengerOptions.berth.ask).toBe(true);
    expect(v.passengers[0]).toMatchObject({ missing: [] });
    expect(v.passengers[1]).toMatchObject({ missing: ['name', 'age', 'gender'] });
    expect(v.alsoAsk).toEqual(['passenger1.foodPreference', 'passenger2.berthPreference', 'passenger2.foodPreference']);
    expect(v.missing).toEqual(['passenger2.name', 'passenger2.age', 'passenger2.gender']);
    const cc: any = bookingPreparationView(sess('CC', info('12926', { catering: false })));
    expect(cc.alsoAsk).toBeUndefined();
    expect(optionalToAsk(sess('CC'), {})).toEqual([]);
  });
});

describe('[2] validation of chat-proposed berth / meal', () => {
  it('meal enum is normalised; anything else is an error; credentials are still rejected', () => {
    expect(passengerValidator.validatePartial({ foodPreference: 'non veg' }).valid).toEqual({ foodPreference: 'NON_VEG' });
    expect(passengerValidator.validatePartial({ foodPreference: 'No-Food' }).valid).toEqual({ foodPreference: 'NO_FOOD' });
    expect(passengerValidator.validatePartial({ foodPreference: 'pizza' }).errors[0].field).toBe('foodPreference');
    const s = sess('3A');
    expect(passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { name: 'Rahul', foodPreference: 'VEG' } })).toMatchObject({ ok: true });
    expect(passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { otp: '123456' } })).toMatchObject({ ok: false, code: 'SENSITIVE_DATA_REJECTED' });
  });
  it('gate: berth must be a choice of the class; meal only when OFFERED', () => {
    expect(gateOptionalField(sess('3A'), 'berthPreference', 'SIDE_UPPER')).toEqual({ ok: true });
    expect(gateOptionalField(sess('2A'), 'berthPreference', 'MIDDLE')).toMatchObject({ ok: false, message: expect.stringMatching(/2A mein berth options/) });
    expect(gateOptionalField(sess('CC'), 'berthPreference', 'LOWER')).toMatchObject({ ok: false, message: expect.stringMatching(/berth choice nahi/) });
    expect(gateOptionalField(sess('CC'), 'berthPreference', 'NO_PREFERENCE')).toMatchObject({ ok: false, silent: true });
    expect(gateOptionalField(sess('3A'), 'foodPreference', 'VEG')).toMatchObject({ ok: false, message: expect.stringMatching(/verify nahi/) });
    expect(gateOptionalField(sess('3A', info('12926', { catering: false })), 'foodPreference', 'VEG')).toMatchObject({ ok: false, message: expect.stringMatching(/shaamil nahi/) });
    expect(gateOptionalField(sess('3A', info('12926', { catering: true })), 'foodPreference', 'VEG')).toEqual({ ok: true });
  });
  it('PassengerCollection stores allowed values, drops the rest with a reason (other fields still saved)', () => {
    const s = sess('2A');
    const r = passengerCollection.applyUpdates(s, [{ ref: { kind: 'ID', value: 'P1' }, fields: { name: 'Rahul Sharma', age: 32, gender: 'male', berthPreference: 'MIDDLE', foodPreference: 'VEG' }, explicit: true } as any]);
    expect(s.passengers[0]).toMatchObject({ name: 'Rahul Sharma', age: 32, gender: 'MALE' });
    expect(s.passengers[0].berthPreference).toBeUndefined();
    expect(s.passengers[0].foodPreference).toBeUndefined();
    expect(r.notes.join(' ')).toMatch(/2A mein berth options/);
    expect(r.notes.join(' ')).toMatch(/verify nahi/);
    const ok = sess('2A', info('12926', { catering: true }));
    passengerCollection.applyUpdates(ok, [{ ref: { kind: 'ID', value: 'P2' }, fields: { name: 'Neha Sharma', age: 29, gender: 'female', berthPreference: 'SIDE_LOWER', foodPreference: 'NO_FOOD' }, explicit: true } as any]);
    expect(ok.passengers[1]).toMatchObject({ berthPreference: 'SIDE_LOWER', foodPreference: 'NO_FOOD' });
  });
});

describe('[3] end-to-end apply through the turn applier (mock railway data, labelled mock)', () => {
  function mk() {
    const state = new ConversationStateManager();
    const eng = new ConversationTurnEngine(new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService()), state);
    const sid = state.createSession().sessionId;
    return { state, sid, say: (t: string) => eng.processTurn(sid, t, 'TEXT') as Promise<any>, s: () => state.getSession(sid) as any };
  }
  const ctx = (rawText: string): any => ({ turnId: 't-p392', mode: 'TEXT', cards: [], events: [], changes: [], rawText });
  it('one message with name/age/gender/berth/meal for two passengers fills the session (form reads the same session)', async () => {
    const h = mk();
    for (const t of ['Amritsar se Delhi kal', '12497 wali kar do', '3A', '2 passengers']) await h.say(t);
    expect(h.s().selectedClass).toBe('3A');
    expect(h.s().passengersCount).toBe(2);
    h.s().lastTrainInfo = { trainNumber: '12497', trainName: 'Shan-e-Punjab Express', facilities: { catering: true } };   // test fixture: provider says catering
    const applier = new ContextualTurnApplier(h.state);
    const text = 'Rahul Sharma 32 male lower veg, Neha Sharma 29 female upper no food';
    const o: any = applier.apply(h.sid, { intent: 'COLLECT_PASSENGER_DETAILS', action: 'UPDATE_PASSENGER', confidence: 0.9, entities: { passengerChanges: [
      { passengerIndex: 1, changes: { name: 'Rahul Sharma', age: 32, gender: 'male', berthPreference: 'LOWER', foodPreference: 'VEG' } },
      { passengerIndex: 2, changes: { name: 'Neha Sharma', age: 29, gender: 'female', berthPreference: 'UPPER', foodPreference: 'NO_FOOD' } }
    ] } } as any, ctx(text));
    expect(o.error).toBeUndefined();
    expect(h.s().passengers.map((p: any) => [p.name, p.age, p.gender, p.berthPreference, p.foodPreference])).toEqual([
      ['Rahul Sharma', 32, 'MALE', 'LOWER', 'VEG'], ['Neha Sharma', 29, 'FEMALE', 'UPPER', 'NO_FOOD']
    ]);
    const v: any = bookingPreparationView(h.s());
    expect(v.missing).toEqual([]);
    expect(v.alsoAsk).toBeUndefined();
  });
  it('meal for a train whose catering is not verified is not stored, but the other details are', async () => {
    const h = mk();
    for (const t of ['Amritsar se Delhi kal', '12497 wali kar do', '3A', '1 passenger']) await h.say(t);
    const o: any = new ContextualTurnApplier(h.state).apply(h.sid, { intent: 'COLLECT_PASSENGER_DETAILS', action: 'UPDATE_PASSENGER', confidence: 0.9, entities: { passengerChanges: [
      { passengerIndex: 1, changes: { name: 'Rahul Sharma', age: 32, gender: 'male', foodPreference: 'VEG' } }] } } as any, ctx('Rahul Sharma 32 male veg'));
    expect(o.error).toBeUndefined();
    expect(h.s().passengers[0]).toMatchObject({ name: 'Rahul Sharma', age: 32, gender: 'MALE' });
    expect(h.s().passengers[0].foodPreference).toBeUndefined();
    expect(o.notes.join(' ')).toMatch(/verify nahi/);
  });
});

describe('[4] prompt, tool schema and reply guard', () => {
  it('the agent is told to ask passenger details itself, with berth / meal rules', () => {
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/PASSENGER DETAILS — ASK THEM YOURSELF/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/passengerOptions\.berth\.ask/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/NOT_CHECKED → call GET_TRAIN_INFO/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/name\|age\|gender\|berthPreference\|foodPreference/);
  });
  it('update_booking_session schema offers berth / meal enums', () => {
    const defs = nativeToolDefs({ tools: REGISTERED_TOOLS as any });
    const sessionTool = defs.find((d: any) => d.function?.name === 'update_booking_session');
    const ch = sessionTool.function.parameters.properties.entities.properties.passengerChanges.items.properties.changes.properties;
    expect(ch.foodPreference.enum).toEqual(['VEG', 'NON_VEG', 'NO_FOOD']);
    expect(ch.berthPreference.enum).toContain('SIDE_LOWER');
  });
  it('asking for a berth preference is not an availability claim; real seat claims still are', () => {
    expect(classifyAvailabilityClaim('12926 3A mein berth preference bhi batayein: Lower, Middle, Upper ya No preference.')).toBe('NONE');
    expect(classifyAvailabilityClaim('Rahul ko 12926 mein Side lower berth chahiye — note kar liya.')).toBe('NONE');
    expect(classifyAvailabilityClaim('12926 mein lower berth khaali hai.')).toBe('LIVE_AVAILABILITY_CLAIM');
    expect(classifyAvailabilityClaim('12926 3A mein Lower berth available hai.')).toBe('LIVE_AVAILABILITY_CLAIM');
    expect(classifyAvailabilityClaim('12926 mein 3A WL 5 hai.')).toBe('LIVE_AVAILABILITY_CLAIM');
  });
});

describe('[5] catering prefetch after train + class selection (provider of the results; mock here, labelled)', () => {
  it('fetches once per session + train, records only flags, never invents catering', async () => {
    resetFacilitiesPrefetch();
    const s: any = sess('3A', { selectedTrain: { number: '12497', name: 'Shan-e-Punjab Express' }, providerSource: 'mock' });
    const get = () => s;
    expect(foodStatusOf(s).status).toBe('NOT_CHECKED');
    await awaitTrainFacilities(get, 'sx', 2000);
    expect(s.trainFacilities).toMatchObject({ trainNumber: '12497', catering: null });     // mock data has no catering flag
    expect(foodStatusOf(s).status).toBe('UNKNOWN');                                         // → no meal choice offered
    expect(prefetchTrainFacilities(get, 'sx')).toBeNull();                                  // not fetched again
    expect(prefetchTrainFacilities(() => sess('3A', { selectedClass: undefined }), 'sy')).toBeNull();   // no class → nothing
  });
});

describe('[6] details + "review dikhao" in ONE decision → preparation decides (no premature refusal)', () => {
  class OneShot extends MockLLMProvider {
    script = new Map<string, any>();
    async generateStructuredDecision(input: any): Promise<any> {
      const d = this.script.get(input.userText);
      if (d && !(input.currentTurnToolResults || []).length) return { decision: { missingFields: [], confidence: 0.9, clarification: null, toolCalls: [], ...d } };
      if (d) return { decision: { missingFields: [], confidence: 0.9, clarification: null, toolCalls: [], intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', entities: {} } };
      return super.generateStructuredDecision(input);
    }
  }
  const setup = async () => {
    const llm = new OneShot(); const state = new ConversationStateManager();
    const eng = new ConversationTurnEngine(new ConversationAgentOrchestrator(llm, state, new RailwayToolService()), state);
    const sid = state.createSession().sessionId;
    const say = (t: string) => eng.processTurn(sid, t, 'TEXT') as Promise<any>;
    for (const t of ['Amritsar se Delhi kal', '12497 wali kar do', '3A', '2 passengers']) await say(t);
    return { llm, state, sid, say };
  };
  it('complete set → review built with the berth; incomplete set → no review, next detail asked', async () => {
    const h = await setup();
    const full = 'Rahul Sharma 32 male lower, Neha Sharma 29 female, review dikhao';
    h.llm.script.set(full, { intent: 'COLLECT_PASSENGER_DETAILS', action: 'SHOW_REVIEW', entities: { passengerChanges: [
      { passengerIndex: 1, changes: { name: 'Rahul Sharma', age: 32, gender: 'male', berthPreference: 'LOWER' } },
      { passengerIndex: 2, changes: { name: 'Neha Sharma', age: 29, gender: 'female' } }] } });
    const r = await h.say(full);
    expect(r.responseMessage).not.toMatch(/Review ke liye abhi details poori nahi hain/);
    const s: any = h.state.getSession(h.sid);
    expect(s.passengers.map((p: any) => p.berthPreference ?? null)).toEqual(['LOWER', null]);
    expect(s.review?.valid).toBe(true);

    const g = await setup();
    const part = 'Rahul Sharma 32 male, review dikhao';
    g.llm.script.set(part, { intent: 'COLLECT_PASSENGER_DETAILS', action: 'SHOW_REVIEW', entities: { passengerChanges: [
      { passengerIndex: 1, changes: { name: 'Rahul Sharma', age: 32, gender: 'male' } }] } });
    await g.say(part);
    const s2: any = g.state.getSession(g.sid);
    expect(s2.review?.valid).toBeFalsy();                                // nothing skipped: passenger 2 still missing
    expect(s2.passengers[0]).toMatchObject({ name: 'Rahul Sharma', age: 32, gender: 'MALE' });
  });
});

describe('[7] details in one round, SHOW_REVIEW in a later round of the SAME turn → review (prep runs after the loop)', () => {
  it('two-round turn builds the review', async () => {
    class TwoRound extends MockLLMProvider {
      async generateStructuredDecision(input: any): Promise<any> {
        if (input.userText !== 'Rahul Sharma 32 male upper, Neha Sharma 29 female') return super.generateStructuredDecision(input);
        const n = (input.currentTurnToolResults || []).length;
        if (n === 0) return { decision: { missingFields: [], confidence: 0.9, clarification: null, intent: 'COLLECT_PASSENGER_DETAILS', action: 'UPDATE_PASSENGER',
          entities: { passengerChanges: [{ passengerIndex: 1, changes: { name: 'Rahul Sharma', age: 32, gender: 'male', berthPreference: 'UPPER' } },
            { passengerIndex: 2, changes: { name: 'Neha Sharma', age: 29, gender: 'female' } }] },
          toolCalls: [{ callId: 'c1', name: 'CHECK_AVAILABILITY', arguments: { trainNumber: '12497', travelClass: '3A', date: input.context?.date } }] } };
        return { decision: { missingFields: [], confidence: 0.9, clarification: null, intent: 'SHOW_REVIEW', action: 'SHOW_REVIEW', entities: {}, toolCalls: [] } };
      }
    }
    const state = new ConversationStateManager();
    const eng = new ConversationTurnEngine(new ConversationAgentOrchestrator(new TwoRound(), state, new RailwayToolService()), state);
    const sid = state.createSession().sessionId;
    for (const t of ['Amritsar se Delhi kal', '12497 wali kar do', '3A', '2 passengers']) await eng.processTurn(sid, t, 'TEXT');
    const r: any = await eng.processTurn(sid, 'Rahul Sharma 32 male upper, Neha Sharma 29 female', 'TEXT');
    expect(r.responseMessage).not.toMatch(/Review ke liye abhi details poori nahi hain/);
    const s: any = state.getSession(sid);
    expect(s.passengers[0].berthPreference).toBe('UPPER');
    expect(s.review?.valid).toBe(true);
  });
});
