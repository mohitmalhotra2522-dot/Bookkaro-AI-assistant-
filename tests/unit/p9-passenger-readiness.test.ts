/**
 * PROMPT 9 — GROUP 2
 * Passenger collection, validation, multi-slot extraction, index references,
 * corrections, count changes, removal, readiness evaluation, review builder.
 *
 * Deterministic: MockLLMProvider (regex Hinglish NLU) + MockRailwayProvider
 * (labelled non-live development data). The backend validates every
 * LLM-extracted passenger value — tests below include a hostile LLM.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import type { LLMProvider, LLMTurnInput } from '../../server/ai/providers/llm-provider';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { passengerValidator } from '../../server/booking/passenger-validator';
import { passengerCollection } from '../../server/booking/passenger-collection';
import { BookingReadinessEvaluator, getNextRequiredField, defaultPolicy } from '../../server/booking/booking-readiness';
import { reviewBuilder, reviewFingerprint } from '../../server/booking/review-builder';
import { BookingState } from '../../shared/states';
import type { BookingSession } from '../../shared/entities';
import { nextPassengerDetail } from '../../server/booking/passenger-options';

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const mk = (llm: LLMProvider = new MockLLMProvider()) => { state = new ConversationStateManager(); orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService()); };
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => orch.processTurn(sid, text, mode);
const pax = (r: any) => (r.context.passengers || []).map((p: any) => `${p.id}:${p.name ?? '?'}/${p.age ?? '?'}/${p.gender ?? '?'}`);

/** Journey + date + count + train + class → COLLECTING_PASSENGER_DETAILS. */
async function toDetails(sid: string, count = 2, train = '12014', cls = 'CC') {
  await say(sid, `Amritsar se Delhi kal ${count} log`);
  await say(sid, train);
  return say(sid, cls);
}
async function toAwaiting(sid: string) {
  await toDetails(sid);
  return say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
}

beforeEach(() => { railwayRegistry.setActive('mock'); mk(); });

// ------------------------------------------------------------------------------------------
describe('G2 — passenger collection only after train + class; one field at a time', () => {
  it('[1] no passenger details are asked before train and class are selected', async () => {
    const sid = state.createSession().sessionId;
    let r = await say(sid, 'Amritsar se Delhi kal 2 log');
    expect(r.pendingInteraction?.type).toBe('TRAIN_SELECTION_REQUIRED');
    expect(r.responseMessage).not.toMatch(/passenger ka naam/i);
    r = await say(sid, '12014');
    expect(r.pendingInteraction?.type).toBe('CLASS_SELECTION_REQUIRED');
    expect(r.context.passengers ?? []).toHaveLength(0);
    // a name typed before train/class is NOT stored as passenger data
    const sid2 = state.createSession().sessionId;
    await say(sid2, 'Amritsar se Delhi kal 2 log');
    r = await say(sid2, 'Rahul Sharma 31 male');
    expect((r.context.passengers || []).some((p: any) => p.name)).toBe(false);
  });

  it('[2] class selected without count → BOOKING_PREPARE asks ONLY the count; then the next missing field only', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal');
    await say(sid, '12014');
    let r = await say(sid, 'CC');
    expect(r.newState).toBe(BookingState.BOOKING_PREPARE);
    expect(r.events).toContain('BOOKING_PREPARATION_STARTED');
    expect(r.pendingInteraction?.type).toBe('PASSENGERS_REQUIRED');
    expect(r.responseMessage).not.toMatch(/\?/);                     // P42.1: structured PASSENGERS_REQUIRED, no backend question
    expect(r.context.selectedTrain.number).toBe('12014');            // train not discarded
    r = await say(sid, '2 passengers');
    expect(r.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
    expect(r.context.passengers.map((p: any) => p.id)).toEqual(['P1', 'P2']);   // stable ids
    expect(r.pendingInteraction).toMatchObject({ type: 'PASSENGER_DETAILS_REQUIRED', data: { field: 'name', passengerId: 'P1' } });
    r = await say(sid, 'Rahul Sharma');
    expect(nextPassengerDetail(state.getSession(sid))).toEqual({ passenger: 1, field: 'age' });   // P42.1: structured, no backend question
    expect(r.responseMessage).not.toMatch(/\?/);
    expect(r.responseMessage).not.toMatch(/gender/);                   // one question at a time
    r = await say(sid, '34');
    // P42.1: structured next detail (v0.39.6 order: CC seat preference before gender); no backend question
    expect(nextPassengerDetail(state.getSession(sid))).toEqual({ passenger: 1, field: 'berthPreference' });
    expect(r.responseMessage).not.toMatch(/\?/);
    r = await say(sid, 'male');
    expect(r.pendingInteraction?.data).toMatchObject({ field: 'name', passengerId: 'P2' });
    expect(r.responseMessage).not.toMatch(/\?/);   // P42.1: the structured pending (above) carries it; the LLM asks
  });
});

// ------------------------------------------------------------------------------------------
describe('G2 — multi-slot extraction (backend-validated)', () => {
  it('[3] several passengers in one turn (comma separated) → both validated → review', async () => {
    const sid = state.createSession().sessionId;
    await toDetails(sid);
    const r = await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
    expect(pax(r)).toEqual(['P1:Rahul Sharma/31/MALE', 'P2:Neha Sharma/28/FEMALE']);
    expect(r.events).toContain('PASSENGER_DETAILS_VALIDATED');
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
  });

  it('[4] count + ordinal-segmented passengers in ONE spoken sentence (no commas, voice)', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'amritsar se delhi kal', 'VOICE');
    await say(sid, '12014', 'VOICE');
    await say(sid, 'cc', 'VOICE');
    const r = await say(sid, 'do passenger hain pehla rahul sharma 31 male doosra neha sharma 28 female', 'VOICE');
    expect(r.context.passengersCount).toBe(2);
    expect(pax(r)).toEqual(['P1:Rahul Sharma/31/MALE', 'P2:Neha Sharma/28/FEMALE']);
  });

  it('[5] invalid details are rejected with INVALID_PASSENGER_DETAILS; valid parts kept; retry completes the SAME passenger', async () => {
    const sid = state.createSession().sessionId;
    await toDetails(sid);
    let r = await say(sid, 'Rahul 150 male');
    expect(r.error?.code).toBe('INVALID_PASSENGER_DETAILS');
    expect(r.context.passengers[0]).toMatchObject({ name: 'Rahul', gender: 'MALE' });
    expect(r.context.passengers[0].age).toBeUndefined();
    r = await say(sid, 'Rahul 31 male');
    expect(pax(r)).toEqual(['P1:Rahul/31/MALE', 'P2:?/?/?']);         // not duplicated into P2
  });

  it('[6] hostile/incorrect LLM extraction: non-schema fields dropped, invalid values rejected, nothing trusted blindly', async () => {
    const base = new MockLLMProvider();
    const evil: LLMProvider = {
      providerId: 'evil-extractor', init: async () => {},
      generateStructuredDecision: async (input: LLMTurnInput) => {
        if (input.userText !== 'EVIL') return base.generateStructuredDecision(input);
        return { decision: { intent: 'COLLECT_PASSENGER_DETAILS', action: 'COLLECT_PASSENGER_DETAILS', missingFields: [], clarification: null, confidence: 1, toolCalls: [],
          entities: { passengerUpdates: [
            { fields: { name: 'Amit Kumar', age: 'abc', gender: 'robot', aadhaar: '1234 5678 9012', irctcPassword: 'x' } },
            { ref: { kind: 'INDEX', value: 7 }, fields: { name: 'Ghost' } }
          ] } } as any };
      }
    };
    mk(evil);
    const sid = state.createSession().sessionId;
    await toDetails(sid);
    const r = await say(sid, 'EVIL');
    const p1 = state.getSession(sid).passengers[0] as any;
    expect(p1.name).toBe('Amit Kumar');
    expect(p1.age).toBeUndefined();
    expect(p1.gender).toBeUndefined();
    expect(p1.aadhaar).toBeUndefined();
    expect(p1.irctcPassword).toBeUndefined();
    expect(['INVALID_PASSENGER_DETAILS', 'INVALID_PASSENGER_INDEX']).toContain(r.error?.code);
    expect(state.getSession(sid).passengers).toHaveLength(2);           // P7 never created
    expect(JSON.stringify(state.getSession(sid))).not.toContain('Ghost');
  });
});

// ------------------------------------------------------------------------------------------
describe('G2 — index / pronoun / name references', () => {
  it('[7] "first passenger", "second passenger", "passenger 2", "uska" resolve to stable ids', async () => {
    const sid = state.createSession().sessionId;
    await toDetails(sid);
    let r = await say(sid, 'First passenger ka naam Rahul hai');
    expect(pax(r)[0]).toBe('P1:Rahul/?/?');
    r = await say(sid, 'Second passenger female hai');
    expect(r.context.passengers[1].gender).toBe('FEMALE');
    r = await say(sid, 'Passenger 2 ka age 28 hai');
    expect(r.context.passengers[1].age).toBe(28);
    r = await say(sid, 'Uska naam Neha hai');                         // "uska" = last referenced (P2)
    expect(r.context.passengers[1].name).toBe('Neha');
    expect(r.context.passengers[0].name).toBe('Rahul');
    // still asks only the first missing field (P1 age)
    expect(r.pendingInteraction?.data).toMatchObject({ passengerId: 'P1', field: 'age' });
  });

  it('[8] invalid index → INVALID_PASSENGER_INDEX, nothing changes', async () => {
    const sid = state.createSession().sessionId;
    await toDetails(sid);
    const before = JSON.stringify(state.getSession(sid).passengers);
    const r = await say(sid, 'Passenger 5 ka naam Amit hai');
    expect(r.error?.code).toBe('INVALID_PASSENGER_INDEX');
    expect(r.responseMessage).toMatch(/Passenger 5 nahi hai — abhi 2 passengers hain/);
    expect(JSON.stringify(state.getSession(sid).passengers)).toBe(before);
  });

  it('[9] duplicate first names → AMBIGUOUS_REFERENCE instead of guessing', () => {
    const s = state.createSession();
    s.passengersCount = 2;
    passengerCollection.ensureSlots(s);
    s.passengers[0].name = 'Rahul Sharma'; s.passengers[1].name = 'Rahul Verma';
    const r = passengerCollection.resolveRef(s, { kind: 'NAME', value: 'rahul' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('AMBIGUOUS_REFERENCE');
    const ok = passengerCollection.resolveRef(s, { kind: 'NAME', value: 'rahul verma' });
    expect(ok.ok && ok.passenger.id).toBe('P2');
  });
});

// ------------------------------------------------------------------------------------------
describe('G2 — corrections without restart', () => {
  it('[10] name correction mid-collection ("Actually naam Rohit Sharma hai") is announced, flow continues', async () => {
    const sid = state.createSession().sessionId;
    await toDetails(sid);
    await say(sid, 'Rahul Sharma');
    const r = await say(sid, 'Actually naam Rohit Sharma hai');
    expect(r.context.passengers[0].name).toBe('Rohit Sharma');
    expect(r.responseMessage).toMatch(/Passenger 1 ka naam Rahul Sharma se Rohit Sharma kar diya/);
    expect(r.events).toContain('CORRECTION_APPLIED');
    expect(r.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
    expect(nextPassengerDetail(state.getSession(sid))).toEqual({ passenger: 1, field: 'age' });   // continues, no restart (P42.1: structured)
    expect(r.responseMessage).not.toMatch(/\?/);
  });

  it('[11] age and gender corrections by name / index; implicit values never silently overwrite', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    let r = await say(sid, 'Rahul ki age 32 hai');
    expect(r.context.passengers[0].age).toBe(32);
    expect(r.responseMessage).toMatch(/umar 31 se 32 kar di/);
    r = await say(sid, 'Passenger 2 ka gender male hai');
    expect(r.context.passengers[1].gender).toBe('MALE');
    expect(r.context.selectedTrain.number).toBe('12014');            // nothing else reset
    expect(r.context.selectedClass).toBe('CC');
    // implicit (non-explicit) update cannot overwrite an existing value
    const s = state.getSession(sid);
    const out = passengerCollection.applyUpdates(s, [{ ref: { kind: 'ID', value: 'P1' }, fields: { age: 50 }, explicit: false }]);
    expect(s.passengers[0].age).toBe(32);
    expect(out.notes.join(' ')).toMatch(/pehle se 32 hai/);
  });

  it('[12] field change without value ("Passenger 2 ka naam change karo") asks for it, then applies to P2', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    let r = await say(sid, 'Passenger 2 ka naam change karo');
    expect(r.pendingInteraction).toMatchObject({ type: 'PASSENGER_DETAILS_REQUIRED', data: { passengerId: 'P2', field: 'name', correction: true } });
    expect(r.responseMessage).not.toMatch(/\?/);   // P42.1: the structured pending (above) carries the request; the LLM asks
    r = await say(sid, 'Neha Verma');
    expect(r.context.passengers[1].name).toBe('Neha Verma');
    expect(r.context.passengers[0].name).toBe('Rahul Sharma');
  });
});

// ------------------------------------------------------------------------------------------
describe('G2 — passenger count changes & removal', () => {
  it('[13] "2 nahi 3 passengers hain" → count 3, records reconciled (P1/P2 kept, P3 added), fare invalidated, asks P3', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    expect(state.getSession(sid).fare).toBeTruthy();
    const r = await say(sid, '2 nahi 3 passengers hain');
    expect(r.context.passengersCount).toBe(3);
    expect(r.context.passengers.map((p: any) => p.id)).toEqual(['P1', 'P2', 'P3']);
    expect(r.context.passengers[0].name).toBe('Rahul Sharma');
    expect(r.context.fare).toBeUndefined();                           // dependent fare invalidated
    expect(r.events).toEqual(expect.arrayContaining(['PASSENGER_COUNT_UPDATED', 'REVIEW_INVALIDATED']));
    expect(r.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
    expect(r.context.passengers[2].name).toBeFalsy();                 // P3 still open
    expect(nextPassengerDetail(state.getSession(sid))).toEqual({ passenger: 1, field: 'berthPreference' });   // P42.1: structured next detail (P1's optional seat preference comes first)
    expect(r.responseMessage).not.toMatch(/\?|bataiye/);
  });

  it('[14] "ek aur add kar do" and "Sirf 1 passenger": delta + shrink keep entered details', async () => {
    const sid = state.createSession().sessionId;
    await toDetails(sid);
    await say(sid, 'Rahul');
    let r = await say(sid, 'ek aur add kar do');
    expect(r.context.passengersCount).toBe(3);
    expect(r.context.passengers.map((p: any) => p.id)).toEqual(['P1', 'P2', 'P3']);
    r = await say(sid, 'Sirf 1 passenger');
    expect(r.context.passengersCount).toBe(1);
    expect(pax(r)).toEqual(['P1:Rahul/?/?']);
    expect(r.events).toContain('PASSENGER_COUNT_UPDATED');
  });

  it('[15] removal by reference ("Actually second passenger nahi aa raha") keeps stable ids; last passenger cannot be removed', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    await say(sid, 'ek aur add kar do');
    await say(sid, 'Amit 40 male');
    let r = await say(sid, 'Actually second passenger nahi aa raha');
    expect(r.context.passengers.map((p: any) => p.id)).toEqual(['P1', 'P3']);   // ids never renumbered
    expect(r.context.passengersCount).toBe(2);
    expect(r.events).toContain('PASSENGER_REMOVED');
    const removedEv = r.context.eventLog!.find((e: any) => e.type === 'PASSENGER_REMOVED');
    expect(JSON.stringify(removedEv)).not.toContain('Neha');          // events carry ids, not names
    r = await say(sid, 'Passenger 2 hata do');
    expect(r.context.passengers.map((p: any) => p.id)).toEqual(['P1']);
    r = await say(sid, 'Passenger 1 hata do');
    expect(r.context.passengers).toHaveLength(1);                     // supported op refuses empty booking
    expect(r.error?.code).toBeTruthy();
  });

  it('[16] count outside 1–6 is rejected', async () => {
    const sid = state.createSession().sessionId;
    await toDetails(sid);
    const r = await say(sid, '9 passengers');
    expect(r.context.passengersCount).toBe(2);
    expect(r.error).toBeTruthy();
  });
});

// ------------------------------------------------------------------------------------------
describe('G2 — validator, readiness evaluator, review builder (pure, deterministic)', () => {
  it('[17] PassengerValidator accepts only the existing schema', () => {
    const v = passengerValidator.validatePartial({ name: 'rahul  sharma', age: '31', gender: 'mahila', berthPreference: 'LOWER', pan: 'X', otp: '1' });
    expect(v.valid).toEqual({ name: 'Rahul Sharma', age: 31, gender: 'FEMALE', berthPreference: 'LOWER' });
    expect(v.rejectedFields.sort()).toEqual(['otp', 'pan']);
    for (const bad of [{ age: 0 }, { age: 121 }, { age: '3.5' }, { name: 'train' }, { name: '12345' }, { gender: 'xyz' }]) {
      expect(passengerValidator.validatePartial(bad).errors[0]?.code).toBe('INVALID_PASSENGER_DETAILS');
    }
  });

  it('[18] readiness blockers & next required field are computed by the backend (never by the LLM)', async () => {
    const empty = state.createSession();
    const e = new BookingReadinessEvaluator().evaluate(empty);
    expect(e.ready).toBe(false);
    expect(e.blockers).toEqual(expect.arrayContaining(['MISSING_ORIGIN', 'MISSING_DESTINATION', 'MISSING_DATE', 'MISSING_TRAIN', 'MISSING_CLASS', 'MISSING_PASSENGER_COUNT']));
    expect(getNextRequiredField(empty)).toEqual({ field: 'origin' });

    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const s = state.getSession(sid);
    const ev = new BookingReadinessEvaluator();
    const ok = ev.evaluate(s);
    expect(ok.ready).toBe(true);
    expect(ok.checks).toEqual({ journeyReady: true, dateReady: true, passengersReady: true, passengerDetailsReady: true, trainReady: true, classReady: true, availabilityReady: true, fareReady: true, reviewReady: true, confirmationReady: true });

    const missing = structuredClone(s) as BookingSession;
    delete (missing.passengers[1] as any).age;
    const m = ev.evaluate(missing);
    expect(m.blockers).toContain('MISSING_PASSENGER_DETAILS');
    expect(m.missingFields).toContain('P2.age');
    expect(getNextRequiredField(missing)).toEqual({ field: 'age', passengerId: 'P2', passengerIndex: 1 });

    const badClass = structuredClone(s) as BookingSession;
    badClass.selectedClass = 'SL';                                     // 12014 has no SL
    expect(ev.evaluate(badClass).blockers).toContain('INVALID_CLASS');
  });

  it('[19] freshness policy: availability stale after 2 min, fare after 10 min → refresh needed', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const s = state.getSession(sid);
    const ev = new BookingReadinessEvaluator(defaultPolicy());
    const t3 = ev.evaluate(s, Date.now() + 3 * 60_000);
    expect(t3.availability).toBe('STALE');
    expect(t3.fare).toBe('FRESH');
    expect(t3.blockers).toContain('STALE_AVAILABILITY');
    expect(t3.refreshNeeded).toEqual(['AVAILABILITY']);
    const t11 = ev.evaluate(s, Date.now() + 11 * 60_000);
    expect(t11.blockers).toEqual(expect.arrayContaining(['STALE_AVAILABILITY', 'STALE_FARE']));
    expect(t11.refreshNeeded).toEqual(['AVAILABILITY', 'FARE']);
    // required-but-missing data blocks under a strict policy
    const strict = new BookingReadinessEvaluator({ ...defaultPolicy(), requireFare: true });
    const noFare = structuredClone(s) as BookingSession; noFare.fare = undefined;
    expect(strict.evaluate(noFare).blockers).toContain('REQUIRED_TOOL_DATA_MISSING');
  });

  it('[20] ReviewBuilder is deterministic; unknown values are labelled, never estimated; fingerprint tracks critical fields', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const s = state.getSession(sid);
    const a = reviewBuilder.build(s, { reviewVersion: 3, availabilityFresh: true, fareFresh: true });
    const b = reviewBuilder.build(s, { reviewVersion: 3, availabilityFresh: true, fareFresh: true });
    expect(a.text).toBe(b.text);
    expect(a.data).toMatchObject({ reviewVersion: 3, selectedClass: 'CC', passengersCount: 2, confirmationRequired: true, realBooking: false });
    expect(a.data.passengers.map(p => p.passengerId)).toEqual(['P1', 'P2']);
    expect(a.data.fare).toMatchObject({ verified: true, total: 1040 });
    const unverified = reviewBuilder.build(s, { reviewVersion: 3, availabilityFresh: false, fareFresh: false });
    expect(unverified.text).toContain('Fare abhi verify nahi hua hai.');
    expect(unverified.text).toContain('Availability abhi verify nahi hui hai.');
    expect(unverified.text).not.toMatch(/₹/);
    const fp = reviewFingerprint(s);
    const changed = structuredClone(s) as BookingSession; changed.passengers[0].age = 33;
    expect(reviewFingerprint(changed)).not.toBe(fp);
  });
});
