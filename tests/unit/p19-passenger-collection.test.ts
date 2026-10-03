/**
 * PROMPT 19 — GROUP 2: passenger count / index / change validation / completeness / preparation guard /
 * preparation sub-state machine / review + confirmation status (deterministic backend logic, no LLM trust).
 * Railway data = labelled mock (non-live). No network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parsePassengerCount, validatePassengerCount } from '../../server/booking/preparation/passenger-count';
import { passengerIndexIn, resolvePassengerIndex, resolveIndexNumber } from '../../server/booking/preparation/passenger-index-resolver';
import { passengerChangeValidator } from '../../server/booking/preparation/passenger-change-validator';
import { passengerValidator, SCHEMA_FIELDS } from '../../server/booking/passenger-validator';
import { bookingPreparationGuard, availabilityStatus, fareStatus, fareBasisKey } from '../../server/booking/preparation/booking-preparation-guard';
import {
  derivePreparationState, preparationPath, syncPreparationState, reviewStatusOf, confirmationStatusOf, confirmationGuard,
  recordDependencyOutcome, bookingPreparationSummary, buildBookingPreparation
} from '../../server/booking/preparation/booking-preparation';
import { PREPARATION_TRANSITIONS, canTransitionPreparation, BookingPreparationState } from '../../shared/booking-preparation';
import { MAX_PASSENGERS } from '../../shared/constants';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { countMentioned } from '../../server/ai/conversation/grounding';

function mk() {
  const state = new ConversationStateManager();
  const eng = new ConversationTurnEngine(new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService()), state);
  const sid = state.createSession().sessionId;
  return { state, eng, sid, say: (t: string, m: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, m) as Promise<any>, s: () => state.getSession(sid) as any };
}
async function atDetails(pax = '2 passengers') { const h = mk(); for (const t of ['Amritsar se Delhi kal', '12014 wali kar do', 'CC', pax]) await h.say(t); return h; }
async function atReview() { const h = mk(); for (const t of ['Amritsar se Delhi kal', '12014 wali kar do', 'CC', '2 passengers. Mohit 31 male, Ravi 28 male.']) await h.say(t); return h; }
const NAMES = /Mohit|Ravi|Riya/;

let fetchSpy: any;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('P19 G2 — passenger count (Parts 2–3)', () => {
  it('parses supported count phrases deterministically', () => {
    const c = (t: string) => { const r = parsePassengerCount(t); return r?.kind === 'COUNT' ? r.count : r?.kind; };
    expect(c('2 passengers')).toBe(2);
    expect(c('2 log')).toBe(2);
    expect(c('hum 3 hain')).toBe(3);
    expect(c('3 tickets')).toBe(3);
    expect(c('do passenger hain')).toBe(2);
    expect(c('one adult and one child')).toBe(2);
    expect(parsePassengerCount('4', { expectingCount: true })).toMatchObject({ kind: 'COUNT', count: 4 });
    expect(parsePassengerCount('Mohit 31 male')).toBeNull();          // an age is never a count
    expect(parsePassengerCount('12014 wali kar do')).toBeNull();      // a train number is never a count
  });
  it('adult / child wording maps to a TOTAL only — no invented passenger categories', () => {
    const r: any = parsePassengerCount('one adult and one child');
    expect(r.count).toBe(2);
    // the Passenger contract has no category field — nothing beyond the count is applied
    expect([...SCHEMA_FIELDS]).not.toContain('category');
    expect([...SCHEMA_FIELDS].sort()).toEqual(expect.arrayContaining(['age', 'gender', 'name']));
  });
  it('zero / negative / above max / fraction → typed INVALID_PASSENGER_COUNT (never silently corrected)', () => {
    for (const [t, reason] of [['zero passengers', 'ZERO'], ['0 passengers', 'ZERO'], ['minus two', 'NEGATIVE'], ['-2 passengers', 'NEGATIVE'], ['100 passengers', 'TOO_MANY'], ['7 passengers', 'TOO_MANY']] as const) {
      const r: any = parsePassengerCount(t, { expectingCount: true });
      expect(r?.kind, t).toBe('INVALID');
      expect(r.code).toBe('INVALID_PASSENGER_COUNT');
      expect(r.reason, t).toBe(reason);
    }
    expect(validatePassengerCount(2.5)).toMatchObject({ ok: false, reason: 'NOT_INTEGER' });
    expect(validatePassengerCount(MAX_PASSENGERS)).toEqual({ ok: true, count: MAX_PASSENGERS });
  });
  it('grounding accepts parser-derived counts (LLM proposal of 2 for "one adult and one child" is grounded)', () => {
    expect(countMentioned('one adult and one child').has(2)).toBe(true);
    expect(countMentioned('hum 3 hain').has(3)).toBe(true);
  });
});

describe('P19 G2 — passenger index (Part 6)', () => {
  it('maps first / second / doosre wale / meri details / passenger 2 deterministically', () => {
    expect(passengerIndexIn('first passenger ka naam Mohit')).toMatchObject({ index: 1 });
    expect(passengerIndexIn('second passenger female hai')).toMatchObject({ index: 2 });
    expect(passengerIndexIn('doosre wale ka naam Riya hai')).toMatchObject({ index: 2 });
    expect(passengerIndexIn('meri details: Mohit 31 male')).toMatchObject({ index: 1, via: 'SELF' });
    expect(passengerIndexIn('passenger 2 ki age 30')).toMatchObject({ index: 2, via: 'NUMBER' });
    expect(passengerIndexIn('pehli train wali kar do')).toBeNull();   // ordinal about a train ≠ passenger
  });
  it('an index outside the current passenger list → INVALID_PASSENGER_INDEX', async () => {
    const h = await atDetails();
    expect(resolvePassengerIndex(h.s(), 'third passenger ka naam Amit')).toMatchObject({ ok: false, code: 'INVALID_PASSENGER_INDEX', passengerIndex: 3 });
    const ok: any = resolveIndexNumber(h.s(), 2);
    expect(ok.ok).toBe(true);
    expect(ok.passengerId).toBe(h.s().passengers[1].id);
    expect(resolveIndexNumber(h.s(), 0)).toMatchObject({ ok: false });
  });
});

describe('P19 G2 — PassengerChangeValidator (Parts 4, 13, 14, 55)', () => {
  it('valid proposal → stable passenger id + normalized fields only', async () => {
    const h = await atDetails();
    const v: any = passengerChangeValidator.validate(h.s(), { passengerIndex: 1, changes: { name: 'Mohit', age: 31, gender: 'male' } });
    expect(v.ok).toBe(true);
    expect(v.passengerId).toBe(h.s().passengers[0].id);
  });
  it('rejects bad index / unknown field / invalid value / sensitive data — errors never carry values', async () => {
    const h = await atDetails();
    const s = h.s();
    expect(passengerChangeValidator.validate(s, { passengerIndex: 5, changes: { age: 30 } })).toMatchObject({ ok: false, code: 'INVALID_PASSENGER_INDEX' });
    const f: any = passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { aadhaarNumber: '1234 5678 9012' } });
    expect(['INVALID_PASSENGER_FIELD', 'SENSITIVE_DATA_REJECTED']).toContain(f.code);
    expect(passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { category: 'CHILD' } })).toMatchObject({ ok: false, code: 'INVALID_PASSENGER_FIELD' });
    const age: any = passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { age: 300 } });
    expect(age).toMatchObject({ ok: false, code: 'INVALID_PASSENGER_VALUE' });
    expect(JSON.stringify(age)).not.toContain('300');
    for (const k of ['otp', 'captcha', 'password', 'pin', 'cvv', 'bankAccount', 'token', 'cookie']) {
      const r: any = passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { name: 'Mohit', [k]: '998877' } });
      expect(r.ok, k).toBe(false);
      expect(r.code, k).toBe('SENSITIVE_DATA_REJECTED');
      expect(JSON.stringify(r)).not.toContain('998877');
    }
    const otpInName: any = passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { name: 'OTP 123456' } });
    expect(otpInName).toMatchObject({ ok: false, code: 'SENSITIVE_DATA_REJECTED', fields: ['name'] });
    expect(JSON.stringify(otpInName)).not.toContain('123456');
  });
});

describe('P19 G2 — completeness (Part 10)', () => {
  it('returns {complete, missing[]} per passenger index & field', () => {
    const r = passengerValidator.completeness([{ id: 'p1', name: 'Mohit', age: 31 } as any], 2);
    expect(r.complete).toBe(false);
    expect(r.missing).toEqual([{ passengerIndex: 1, field: 'gender' }, { passengerIndex: 2, field: 'name' }, { passengerIndex: 2, field: 'age' }, { passengerIndex: 2, field: 'gender' }]);
    expect(passengerValidator.completeness([{ id: 'p1', name: 'Mohit', age: 31, gender: 'MALE' } as any], 1)).toMatchObject({ complete: true, missing: [] });
    expect(passengerValidator.completeness([], 0).complete).toBe(false);
  });
});

describe('P19 G2 — preparation guard + dependency guards (Parts 15–19)', () => {
  it('needs journey + date + train ∈ current results + class ∈ that train', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal');
    expect(bookingPreparationGuard.check(h.s())).toMatchObject({ ready: false, code: 'BOOKING_PREPARATION_NOT_READY', missing: ['TRAIN', 'CLASS'] });
    await h.say('12014 wali kar do');
    expect(bookingPreparationGuard.check(h.s()).missing).toEqual(['CLASS']);
    await h.say('CC');
    expect(bookingPreparationGuard.check(h.s()).ready).toBe(true);
    const s = h.s();
    s.selectedClass = '3A';                                    // 12014 only has CC / 2S
    expect(bookingPreparationGuard.check(s)).toMatchObject({ ready: false, missing: ['CLASS_NOT_AVAILABLE'] });
    s.selectedClass = 'CC';
    s.searchResults.trains = s.searchResults.trains.filter((t: any) => t.trainNumber !== '12014');
    expect(bookingPreparationGuard.check(s)).toMatchObject({ ready: false, missing: ['TRAIN_NOT_IN_CURRENT_RESULTS'] });
  });
  it('availability / fare only AVAILABLE for an exactly matching provider basis; UNAVAILABLE never carries an amount', async () => {
    const h = await atReview();
    const s = h.s();
    expect(availabilityStatus(s).status).toBe('AVAILABLE');
    expect(fareStatus(s)).toMatchObject({ status: 'AVAILABLE', total: 1040 });
    s.passengersCount = 3;                                     // fare basis changed → no longer valid
    expect(fareStatus(s).status).toBe('STALE');
    s.fare = undefined;
    recordDependencyOutcome(s, 'GET_FARE', false, 'PROVIDER_UNAVAILABLE');
    expect(s.preparationDependencies.fare.basis).toBe(fareBasisKey(s));
    expect(fareStatus(s)).toEqual({ status: 'UNAVAILABLE' });
    s.passengersCount = 2;                                     // different basis → marker no longer applies
    expect(fareStatus(s).status).toBe('NOT_REQUESTED');
    recordDependencyOutcome(s, 'GET_FARE', true);
    expect(s.preparationDependencies.fare).toBeUndefined();
  });
});

describe('P19 G2 — preparation sub-state machine (Parts 20–22, 48–49)', () => {
  it('has no COMPLETE state and every path is legal', () => {
    expect(Object.values(BookingPreparationState)).not.toContain('COMPLETE');
    for (const tos of Object.values(PREPARATION_TRANSITIONS)) expect(tos).not.toContain('COMPLETE' as any);
    expect(preparationPath('CLASS_SELECTED', 'COLLECTING_PASSENGER_DETAILS')).toEqual(['BOOKING_PREPARE', 'PASSENGERS_READY', 'COLLECTING_PASSENGER_DETAILS']);
    expect(preparationPath('NOT_STARTED', 'BOOKING_CONFIRMATION_REQUESTED')?.at(-1)).toBe('BOOKING_CONFIRMATION_REQUESTED');
    expect(canTransitionPreparation('COLLECTING_PASSENGERS', 'BOOKING_CONFIRMATION_REQUESTED')).toBe(false);
  });
  it('derives NOT_STARTED → COLLECTING_PASSENGERS → COLLECTING_PASSENGER_DETAILS → AWAITING_CONFIRMATION from session data', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal'); expect(derivePreparationState(h.s())).toBe('NOT_STARTED');
    await h.say('12014 wali kar do'); expect(derivePreparationState(h.s())).toBe('NOT_STARTED');
    await h.say('CC'); expect(derivePreparationState(h.s())).toBe('COLLECTING_PASSENGERS');
    expect(h.s().preparationTrace.path).toEqual(['CLASS_SELECTED', 'BOOKING_PREPARE', 'COLLECTING_PASSENGERS']);
    await h.say('2 passengers'); expect(derivePreparationState(h.s())).toBe('COLLECTING_PASSENGER_DETAILS');
    await h.say('Mohit 31 male, Ravi 28 male');
    expect(derivePreparationState(h.s())).toBe('AWAITING_CONFIRMATION');
    expect(h.s().bookingPreparationState).toBe('AWAITING_CONFIRMATION');
    const again = syncPreparationState(h.s());               // idempotent
    expect(again.path).toEqual([]);
  });
});

describe('P19 G2 — review / confirmation status + PII-free summary (Parts 12, 25–29, 46)', () => {
  it('CURRENT → STALE after a correction; confirmation guard only accepts the CURRENT version', async () => {
    const h = await atReview();
    const s = h.s();
    expect(reviewStatusOf(s)).toBe('CURRENT');
    expect(confirmationStatusOf(s)).toBe('AWAITING_CONFIRMATION');
    expect(confirmationGuard(s)).toEqual({ ok: true, reviewVersion: 1 });
    expect(confirmationGuard(s, { reviewVersion: 0 })).toMatchObject({ ok: false, code: 'STALE_REVIEW' });
    s.passengers[0].age = 40;                                  // data moved after the review was built
    expect(reviewStatusOf(s)).toBe('STALE');
    expect(confirmationGuard(s)).toMatchObject({ ok: false, code: 'STALE_REVIEW' });
  });
  it('confirmation outside AWAITING_CONFIRMATION → INVALID_CONFIRMATION', async () => {
    const h = await atDetails();
    expect(confirmationGuard(h.s())).toMatchObject({ ok: false, code: 'INVALID_CONFIRMATION' });
    expect(confirmationStatusOf(h.s())).toBe('NOT_REQUESTED');
  });
  it('summary / view reference session data; summary carries no passenger names', async () => {
    const h = await atReview();
    const sum = bookingPreparationSummary(h.s());
    expect(sum).toMatchObject({ passengerCount: 2, passengersComplete: 2, reviewVersion: 1, reviewStatus: 'CURRENT', confirmationStatus: 'AWAITING_CONFIRMATION', fareStatus: 'AVAILABLE' });
    expect(JSON.stringify(sum)).not.toMatch(NAMES);
    const v = buildBookingPreparation(h.s());
    expect(v.selectedTrain?.number).toBe('12014');
    expect(v.journey).toEqual({ origin: h.s().origin, destination: h.s().destination, date: h.s().date });
  });
});
