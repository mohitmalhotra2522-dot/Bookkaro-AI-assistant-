/**
 * PROMPT 20 — GROUP 2: passenger workflow (deterministic backend logic, the LLM only proposes).
 *   count increase / decrease parsing · BookingJourneyValidator (typed missing fields, current-result train,
 *   real classes, IST past date) · passenger-set validator · PassengerCollection view · READY_FOR_REVIEW guard
 *   + preparation states · ReviewSnapshot (authoritative, frozen, no invented fare) · state actions vs tools ·
 *   typed errors · 24 mock scenarios catalogue. Railway data = labelled mock (non-live). No network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parsePassengerCount } from '../../server/booking/preparation/passenger-count';
import { BookingJourneyValidator, isValidCalendarDate, providerClassesOf } from '../../server/booking/preparation/booking-journey-validator';
import { bookingPreparationGuard, fareBasisKey } from '../../server/booking/preparation/booking-preparation-guard';
import { derivePreparationState, preparationPath, bookingPreparationSummary } from '../../server/booking/preparation/booking-preparation';
import { passengerValidator } from '../../server/booking/passenger-validator';
import { passengerCollection } from '../../server/booking/passenger-collection';
import { reviewBuilder, buildReviewSnapshot } from '../../server/booking/review-builder';
import { normalizeStateAction, classifyAgentTurn, STATE_ACTION_ALIASES } from '../../server/ai/decisions/state-actions';
import { MOCK_BOOKING_SCENARIOS } from '../../server/booking/preparation/mock-booking-scenarios';
import {
  canTransitionPreparation, PREPARATION_TRANSITIONS, PREPARATION_STATE_P20_ALIASES, preparationErrorTypeOf, BookingPreparationState
} from '../../shared/booking-preparation';
import { MAX_PASSENGERS } from '../../shared/constants';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';

function mk() {
  const state = new ConversationStateManager();
  const eng = new ConversationTurnEngine(new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService()), state);
  const sid = state.createSession().sessionId;
  return { state, eng, sid, say: (t: string) => eng.processTurn(sid, t, 'TEXT') as Promise<any>, s: () => state.getSession(sid) as any };
}
async function at(turns: string[]) { const h = mk(); for (const t of turns) await h.say(t); return h; }
const UPTO_CLASS = ['Amritsar se Delhi kal', '12014 wali kar do', 'CC'];
const REVIEW_2 = [...UPTO_CLASS, '2 passengers. Mohit 31 male, Ravi 28 male.'];
const NAMES = /Mohit|Ravi/;
const fixedClock = (iso: string) => () => Date.parse(iso);

let fetchSpy: any;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('P20 G2 — passenger count (Parts 7, 8, 21, 22)', () => {
  it('count + decrease phrases parse; field corrections and class codes never become a count', () => {
    const c = (t: string) => parsePassengerCount(t);
    for (const [t, n] of [['2 log', 2], ['hum teen hain', 3], ['3 tickets', 3], ['Actually 2 hi hain', 2], ['2 hi log hain', 2], ['sirf 2 passengers', 2], ['bas do log', 2], ['do hi hain', 2]] as const) {
      expect(c(t), t).toMatchObject({ kind: 'COUNT', count: n });
    }
    expect(c('0 hi hain')).toMatchObject({ kind: 'INVALID', code: 'INVALID_PASSENGER_COUNT' });
    expect(c('0 passengers')).toMatchObject({ kind: 'INVALID', code: 'INVALID_PASSENGER_COUNT', reason: 'ZERO' });
    expect(c(`${MAX_PASSENGERS + 1} passengers`)).toMatchObject({ kind: 'INVALID', reason: 'TOO_MANY' });
    for (const t of ['Age 32 kar do', 'CC nahi 2S kar do', 'sirf 2S', 'Gender female kar do']) expect(c(t), t).toBeNull();
  });
});

describe('P20 G2 — BookingJourneyValidator (Parts 3–6)', () => {
  it('typed missing fields in deterministic order for an empty session', async () => {
    const h = mk();
    const v = new BookingJourneyValidator(fixedClock('2026-10-03T06:00:00Z')).validate(h.s());
    expect(v.valid).toBe(false);
    expect(v.issues).toEqual([
      { field: 'origin', code: 'MISSING' }, { field: 'destination', code: 'MISSING' }, { field: 'date', code: 'MISSING' },
      { field: 'selectedTrain', code: 'MISSING' }, { field: 'selectedClass', code: 'MISSING' }
    ]);
  });

  it('valid journey: train from the CURRENT result set, class from its real provider classes', async () => {
    const h = await at(UPTO_CLASS);
    const s = h.s();
    const v = new BookingJourneyValidator(() => Date.now()).validate(s);
    expect(v).toMatchObject({ valid: true, issues: [] });
    expect(v.resultSetId).toBe(s.searchResults.resultId);
    expect(s.selectedTrain.number).toBe('12014');
    expect(providerClassesOf(s)).toEqual(['CC', '2S']);
  });

  it('rejects a past IST date, an impossible calendar date, a train not in current results and an unavailable class', async () => {
    const h = await at(UPTO_CLASS);
    const s = h.s();
    const later = new BookingJourneyValidator(() => Date.parse(`${s.date}T06:00:00Z`) + 3 * 86_400_000).validate(s);
    expect(later.issues).toContainEqual({ field: 'date', code: 'INVALID_DATE' });
    expect(isValidCalendarDate('2026-02-30')).toBe(false);
    expect(isValidCalendarDate('2026-10-04')).toBe(true);

    const now = new BookingJourneyValidator(() => Date.now());
    const cls = s.selectedClass; s.selectedClass = '3A';
    expect(now.validate(s).issues).toEqual([{ field: 'selectedClass', code: 'INVALID_CLASS_SELECTION' }]);
    s.selectedClass = cls;
    const trains = s.searchResults.trains; s.searchResults.trains = trains.filter((t: any) => t.trainNumber !== '12014');
    expect(now.validate(s).issues).toEqual([{ field: 'selectedTrain', code: 'INVALID_TRAIN_SELECTION' }]);
    s.searchResults.trains = trains;
    const rid = s.selectedTrain.searchResultId; s.selectedTrain.searchResultId = 'old-set';
    expect(now.validate(s).issues).toEqual([{ field: 'selectedTrain', code: 'INVALID_TRAIN_SELECTION' }]);
    s.selectedTrain.searchResultId = rid;
  });
});

describe('P20 G2 — passenger validation + collection (Parts 9–19)', () => {
  it('validateSet → { valid, complete, missingFields, errors } without echoing values', () => {
    const v = passengerValidator.validateSet([{ id: 'a', name: 'Mohit', age: 31, gender: 'MALE' } as any, { id: 'b', name: 'Ravi' } as any], 2);
    expect(v).toMatchObject({ valid: true, complete: false });
    expect(v.missingFields).toEqual([{ passengerIndex: 2, field: 'age' }, { passengerIndex: 2, field: 'gender' }]);
    const bad = passengerValidator.validateSet([{ id: 'a', name: 'Mohit', age: 230, gender: 'MALE' } as any], 1);
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]).toMatchObject({ passengerIndex: 1, field: 'age', code: 'INVALID_PASSENGER_VALUE' });
    expect(JSON.stringify(bad.errors)).not.toMatch(/230|Mohit/);
  });

  it('PassengerCollection view: expectedCount, 1-based currentPassengerIndex, missing fields, status', async () => {
    const h = await at([...UPTO_CLASS, '2 passengers', 'Mohit 31 male']);
    const view = passengerCollection.view(h.s(), 'COLLECTING_PASSENGER_DETAILS');
    expect(view).toMatchObject({ expectedCount: 2, currentPassengerIndex: 2, status: 'COLLECTING_PASSENGER_DETAILS' });
    expect(view.missingFields).toEqual([{ passengerIndex: 2, field: 'name' }, { passengerIndex: 2, field: 'age' }, { passengerIndex: 2, field: 'gender' }]);
    expect(view.passengers.map(p => p.complete)).toEqual([true, false]);
    // summary (logs / resume) carries no PII
    const sum = bookingPreparationSummary(h.s());
    expect(sum.passengerCollection).toEqual({ expectedCount: 2, currentPassengerIndex: 2, missingFieldCount: 3 });
    expect(JSON.stringify(sum)).not.toMatch(NAMES);
  });

  it('only supported Passenger fields exist; no mealPreference / sensitive fields', async () => {
    const h = await at(REVIEW_2);
    for (const p of h.s().passengers) expect(Object.keys(p).filter(k => !['id', 'name', 'age', 'gender', 'berthPreference', 'missingFields', 'source', 'manuallyEdited', 'editedFields'].includes(k))).toEqual([]);
    expect(JSON.stringify(h.s().passengers)).not.toMatch(/meal|otp|password|aadhaar|card/i);
  });
});

describe('P20 G2 — READY_FOR_REVIEW guard + preparation states (Parts 2, 20, 23, 41)', () => {
  it('guard: journey + count + complete passengers → ready; typed codes otherwise', async () => {
    const h = await at([...UPTO_CLASS, '2 passengers', 'Mohit 31 male']);
    expect(bookingPreparationGuard.checkReadyForReview(h.s())).toMatchObject({ ready: false, code: 'PASSENGER_DETAILS_INCOMPLETE' });
    const e = mk();
    expect(bookingPreparationGuard.checkReadyForReview(e.s())).toMatchObject({ ready: false, code: 'BOOKING_PREPARATION_NOT_READY' });
    const r = await at(REVIEW_2);
    expect(bookingPreparationGuard.checkReadyForReview(r.s())).toMatchObject({ ready: true });
    // complete details but no current review → READY_FOR_REVIEW (skip-ahead, Part 20)
    const s = r.s(); const rev = s.review; s.review = null;
    expect(derivePreparationState(s)).toBe('READY_FOR_REVIEW');
    s.review = rev;
  });

  it('READY_FOR_REVIEW sits between passengers and review; rebuild path legal; COMPLETE never reachable', () => {
    expect(canTransitionPreparation('COLLECTING_PASSENGER_DETAILS', 'READY_FOR_REVIEW')).toBe(true);
    expect(canTransitionPreparation('READY_FOR_REVIEW', 'REVIEW')).toBe(true);
    expect(canTransitionPreparation('AWAITING_CONFIRMATION', 'READY_FOR_REVIEW')).toBe(true);
    expect(preparationPath('COLLECTING_PASSENGER_DETAILS', 'AWAITING_CONFIRMATION')).toEqual(['READY_FOR_REVIEW', 'REVIEW', 'AWAITING_CONFIRMATION']);
    const all = Object.values(PREPARATION_TRANSITIONS).flat() as string[];
    expect(all).not.toContain('COMPLETE');
    expect(Object.keys(BookingPreparationState)).not.toContain('COMPLETE');
    expect(PREPARATION_STATE_P20_ALIASES).toMatchObject({ COLLECTING_PASSENGERS: expect.any(String), REVIEW_READY: expect.any(String), CONFIRMATION_REQUESTED: 'BOOKING_CONFIRMATION_REQUESTED' });
  });
});

describe('P20 G2 — ReviewSnapshot (Parts 28–34)', () => {
  it('authoritative, deep-frozen snapshot stored with the review; fare only from GET_FARE', async () => {
    const h = await at(REVIEW_2);
    const snap = h.s().review.snapshot;
    expect(snap).toMatchObject({
      reviewVersion: 1, journey: { origin: 'ASR', destination: 'NDLS', date: h.s().date }, train: { number: '12014' }, travelClass: 'CC',
      availability: { status: 'VERIFIED' }, fare: { status: 'VERIFIED', total: 1040, passengersCount: 2 }
    });
    expect(snap.passengers.map((p: any) => p.index)).toEqual([1, 2]);
    expect(String(snap.dataSource)).toMatch(/mock/i);
    expect(Object.isFrozen(snap) && Object.isFrozen(snap.fare) && Object.isFrozen(snap.passengers[0])).toBe(true);
    expect(() => { (snap as any).fare.total = 1; }).toThrow();
  });

  it('no provider fare → NOT_VERIFIED / FARE_UNAVAILABLE, never an amount', async () => {
    const h = await at(REVIEW_2);
    const s = h.s();
    const noFare = buildReviewSnapshot({ ...s, fare: null } as any, 9, Date.now(), false, true);
    expect(noFare.fare).toEqual({ status: 'NOT_VERIFIED' });
    const down = buildReviewSnapshot({ ...s, fare: null, preparationDependencies: { ...s.preparationDependencies, fare: { status: 'UNAVAILABLE', basis: fareBasisKey(s), errorCode: 'PROVIDER_UNAVAILABLE' } } } as any, 9, Date.now(), false, true);
    expect(down.fare).toMatchObject({ status: 'FARE_UNAVAILABLE' });
    expect(JSON.stringify(down.fare)).not.toMatch(/total|perPassenger/);
    const built = reviewBuilder.build({ ...s, fare: null } as any, { reviewVersion: 9 });
    expect(built.text).not.toMatch(/₹/);
    expect(built.snapshot.fare.status).not.toBe('VERIFIED');
  });
});

describe('P20 G2 — state actions vs railway tools + typed errors (Parts 42–45, 51–53)', () => {
  it('Prompt-20 action names are aliases of existing actions; never railway tools', () => {
    expect(normalizeStateAction({ action: 'SET_PASSENGER_COUNT' } as any)).toMatchObject({ action: 'UPDATE_PASSENGERS', requestedAction: 'SET_PASSENGER_COUNT' });
    expect(normalizeStateAction({ action: 'UPDATE_PASSENGER' } as any).action).toBe('COLLECT_PASSENGER_DETAILS');
    expect(normalizeStateAction({ action: 'START_PASSENGER_COLLECTION' } as any).action).toBe('COLLECT_PASSENGERS');
    expect(normalizeStateAction({ action: 'TELEPORT' } as any).action).toBe('TELEPORT');
    const tools = REGISTERED_TOOLS.map(t => t.name as string);
    for (const a of Object.keys(STATE_ACTION_ALIASES)) expect(tools).not.toContain(a);
    expect(classifyAgentTurn({ action: 'UPDATE_PASSENGER' } as any)).toMatchObject({ kind: 'BOOKING_SESSION', stateAction: 'COLLECT_PASSENGER_DETAILS' });
    expect(classifyAgentTurn({ action: 'NO_ACTION', toolCalls: [{ name: 'GET_FARE' }] } as any)).toMatchObject({ kind: 'RAILWAY_INFORMATION', stateAction: null, railwayTools: ['GET_FARE'] });
    expect(classifyAgentTurn({ action: 'NO_ACTION' } as any).kind).toBe('CONVERSATION');
  });

  it('typed error categories; stable legacy codes keep their value', () => {
    expect(preparationErrorTypeOf('CONFIRMATION_VERSION_MISMATCH')).toBe('STALE_REVIEW');
    expect(preparationErrorTypeOf('CONFIRMATION_NOT_PENDING')).toBe('INVALID_CONFIRMATION');
    expect(preparationErrorTypeOf('BOOKING_NOT_READY')).toBe('BOOKING_PREPARATION_NOT_READY');
    expect(preparationErrorTypeOf('INVALID_TRAIN_REFERENCE')).toBe('INVALID_TRAIN_SELECTION');
    expect(preparationErrorTypeOf('MISSING_PASSENGER_DETAILS')).toBe('PASSENGER_DETAILS_INCOMPLETE');
    expect(preparationErrorTypeOf('ARGUMENT_MISMATCH', 'GET_FARE')).toBe('INVALID_FARE_CONTEXT');
    expect(preparationErrorTypeOf('ARGUMENT_MISMATCH', 'CHECK_AVAILABILITY')).toBe('INVALID_AVAILABILITY_CONTEXT');
    expect(preparationErrorTypeOf('REVIEW_BUILD_FAILED')).toBe('REVIEW_BUILD_FAILED');
    expect(preparationErrorTypeOf(null)).toBeNull();
  });

  it('Part 53 catalogue: 24 unique scenarios, all labelled development fixtures, none ends in COMPLETE', () => {
    expect(MOCK_BOOKING_SCENARIOS).toHaveLength(24);
    expect(new Set(MOCK_BOOKING_SCENARIOS.map(s => s.id)).size).toBe(24);
    expect(JSON.stringify(MOCK_BOOKING_SCENARIOS)).not.toMatch(/"COMPLETE"/);
    expect(Object.isFrozen(MOCK_BOOKING_SCENARIOS)).toBe(true);
  });
});
