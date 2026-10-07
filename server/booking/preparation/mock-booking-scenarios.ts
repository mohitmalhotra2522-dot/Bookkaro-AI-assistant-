/**
 * PROMPT 20 — Part 53: deterministic booking-preparation / passenger / review scenarios (DEVELOPMENT fixtures).
 *
 * Every railway fact in these scenarios comes from the labelled (non-live) MockRailwayProvider through the real
 * ToolCallValidator → RailwayToolRuntime → RailwaySearchOrchestrator path; passenger / review / confirmation steps
 * are deterministic state actions. Nothing here books a ticket: the furthest state is
 * BOOKING_CONFIRMATION_REQUESTED (actual booking disabled) — never COMPLETE, never a PNR / booked claim.
 *
 * The passenger names below are fixture values for the test harness only — the application never logs them.
 */
export type ScenarioStep =
  | { text: string; mode?: 'TEXT' | 'VOICE'; opts?: { reviewVersion?: number; interruptPrevious?: boolean } }
  | { op: 'INTERRUPT' }
  | { op: 'RESUME' }
  /** the (mock) fare provider keeps failing for the rest of the scenario — retries cannot rescue it */
  | { op: 'FARE_PROVIDER_DOWN' };

export interface BookingScenarioExpectation {
  bookingState?: string;
  preparationState?: string;
  passengerCount?: number;
  /** "name/age/gender" per active passenger ("_" = missing). */
  passengers?: string[];
  reviewVersion?: number | null;
  reviewStatus?: string;
  confirmationStatus?: string;
  availabilityStatus?: string;
  fareStatus?: string;
  selectedTrain?: string | null;
  selectedClass?: string | null;
  errorCode?: string | null;
  /** Part 51 typed error (stable code may differ). */
  errorType?: string | null;
  /** Railway tools that actually executed this turn (exact, order-insensitive). */
  toolsExecuted?: string[];
  /** Case-insensitive regex sources the reply must / must not match. */
  responseMatches?: string[];
  responseExcludes?: string[];
  /** P42.1: what the backend waits for (structured) — the LLM words any question. */
  pendingType?: string | null;
  nextDetail?: string | null;
  /** Regex the frozen ReviewSnapshot.dataSource must match (mock data is always labelled non-live). */
  reviewDataSource?: string;
  /** ReviewSnapshot.fare.status (VERIFIED | FARE_UNAVAILABLE | NOT_VERIFIED). */
  snapshotFareStatus?: string;
  /** RESUME step: expected subset of resume().bookingPreparation. */
  resume?: Record<string, unknown>;
}

export interface MockBookingScenario {
  id: string;
  title: string;
  steps: ScenarioStep[];
  expect: BookingScenarioExpectation;
}

const UPTO_CLASS: ScenarioStep[] = [{ text: 'Amritsar se Delhi kal' }, { text: '12014 wali kar do' }, { text: 'CC' }];
const REVIEW_2: ScenarioStep[] = [...UPTO_CLASS, { text: '2 passengers. Mohit 31 male, Ravi 28 male.' }];
const T = (text: string, mode: 'TEXT' | 'VOICE' = 'TEXT'): ScenarioStep => ({ text, mode });

export const MOCK_BOOKING_SCENARIOS: readonly MockBookingScenario[] = Object.freeze([
  { id: 'B01_COUNT', title: 'passenger count after class → collection starts',
    steps: [...UPTO_CLASS, T('2 log')],
    expect: { preparationState: 'COLLECTING_PASSENGER_DETAILS', passengerCount: 2, passengers: ['_/_/_', '_/_/_'], toolsExecuted: [], nextDetail: '1.name', responseExcludes: ['\\?'] } },
  { id: 'B02_INVALID_COUNT', title: '0 passengers → INVALID_PASSENGER_COUNT, nothing stored',
    steps: [...UPTO_CLASS, T('0 passengers')],
    expect: { errorType: 'INVALID_PASSENGER_COUNT', toolsExecuted: [], selectedClass: 'CC', responseExcludes: ['0 passengers ke details'] } },
  { id: 'B03_ONE_COMPLETE', title: 'one passenger, all fields → review + confirmation question',
    steps: [...UPTO_CLASS, T('1 passenger. Mohit 31 male')],
    expect: { bookingState: 'AWAITING_CONFIRMATION', preparationState: 'AWAITING_CONFIRMATION', passengers: ['Mohit/31/MALE'], reviewVersion: 1, reviewStatus: 'CURRENT', fareStatus: 'AVAILABLE', availabilityStatus: 'AVAILABLE', responseMatches: ['520'], pendingType: 'CONFIRMATION_REQUIRED' } },
  { id: 'B04_ONE_INCOMPLETE', title: 'one passenger, name only → asks ONLY the age',
    steps: [...UPTO_CLASS, T('1 passenger'), T('Mohit')],
    expect: { preparationState: 'COLLECTING_PASSENGER_DETAILS', passengers: ['Mohit/_/_'], reviewVersion: null, nextDetail: '1.age', responseExcludes: ['gender', 'naam bataiye', '\\?'] } },
  { id: 'B05_TWO_COMPLETE', title: 'two passengers in one line → review',
    steps: REVIEW_2,
    expect: { preparationState: 'AWAITING_CONFIRMATION', passengerCount: 2, passengers: ['Mohit/31/MALE', 'Ravi/28/MALE'], reviewVersion: 1, responseMatches: ['1040'] } },
  { id: 'B06_MULTI_FIELD', title: 'multi-field input fills P1 and moves to P2',
    steps: [...UPTO_CLASS, T('2 passengers'), T('Mohit 31 male')],
    expect: { passengers: ['Mohit/31/MALE', '_/_/_'], preparationState: 'COLLECTING_PASSENGER_DETAILS', nextDetail: '1.berthPreference' } },
  { id: 'B07_CORRECTION', title: 'field-only correction rebuilds the review (v2)',
    steps: [...REVIEW_2, T('First passenger ki age 32 kar do')],
    expect: { passengers: ['Mohit/32/MALE', 'Ravi/28/MALE'], reviewVersion: 2, reviewStatus: 'CURRENT', preparationState: 'AWAITING_CONFIRMATION', toolsExecuted: ['CHECK_AVAILABILITY', 'GET_FARE'], responseMatches: ['31 se 32'] } },  // P33: a new review version is built from THIS turn's availability + fare (review-boundary refresh)
  { id: 'B08_COUNT_INCREASE', title: '2 → 3 keeps both passengers, review stale, asks for P3',
    steps: [...REVIEW_2, T('3 passengers kar do')],
    expect: { passengerCount: 3, passengers: ['Mohit/31/MALE', 'Ravi/28/MALE', '_/_/_'], reviewStatus: 'STALE', preparationState: 'COLLECTING_PASSENGER_DETAILS', nextDetail: '1.berthPreference' } },
  { id: 'B09_COUNT_DECREASE', title: '"Actually 2 hi hain" removes P3, fresh fare, review v2',
    steps: [...UPTO_CLASS, T('3 passengers. Mohit 31 male, Ravi 28 male, Amit 40 male.'), T('Actually 2 hi hain.')],
    expect: { passengerCount: 2, passengers: ['Mohit/31/MALE', 'Ravi/28/MALE'], reviewVersion: 2, reviewStatus: 'CURRENT', toolsExecuted: ['CHECK_AVAILABILITY', 'GET_FARE'], responseMatches: ['3 se 2', '1040'] } },  // P33: fresh availability + fare for the new review
  { id: 'B10_TRAIN', title: '"12014 wali" stores the actual train from the current results',
    steps: [T('Amritsar se Delhi kal'), T('12014 wali kar do')],
    expect: { selectedTrain: '12014', selectedClass: null, bookingState: 'CLASS_OPTIONS', pendingType: 'CLASS_SELECTION_REQUIRED' } },
  { id: 'B11_CLASS', title: 'class from the train\'s real classes',
    steps: UPTO_CLASS,
    expect: { selectedTrain: '12014', selectedClass: 'CC', preparationState: 'COLLECTING_PASSENGERS', pendingType: 'PASSENGERS_REQUIRED' } },
  { id: 'B12_INVALID_CLASS', title: '3A is not on 12014 → refused, real classes offered',
    steps: [T('Amritsar se Delhi kal'), T('12014 wali kar do'), T('3A')],
    expect: { selectedTrain: '12014', selectedClass: null, responseMatches: ['CC'] } },
  { id: 'B13_AVAILABILITY_DEPENDENCY', title: 'class change after review → fresh availability + fare, review v2',
    steps: [...REVIEW_2, T('2S kar do')],
    expect: { selectedClass: '2S', reviewVersion: 2, reviewStatus: 'CURRENT', toolsExecuted: ['CHECK_AVAILABILITY', 'GET_FARE'], responseMatches: ['240'] } },
  { id: 'B14_FARE_DEPENDENCY', title: 'fare provider down → no review (P33: fare is required), honest reason, no invented fare',
    steps: [...UPTO_CLASS, { op: 'FARE_PROVIDER_DOWN' }, T('1 passenger. Mohit 31 male')],
    expect: { fareStatus: 'UNAVAILABLE', reviewVersion: null, errorCode: 'BOOKING_NOT_READY', responseMatches: ['fare check mein', 'review abhi nahi bana'], responseExcludes: ['₹', 'Confirm karna hai'] } },
  { id: 'B15_REVIEW_GENERATION', title: 'review snapshot from authoritative data',
    steps: REVIEW_2,
    expect: { reviewVersion: 1, reviewStatus: 'CURRENT', confirmationStatus: 'AWAITING_CONFIRMATION', reviewDataSource: 'mock', responseMatches: ['Amritsar', '12014', 'CC', '1040'] } },
  { id: 'B16_INVALIDATION', title: 'date change → fresh search; same train/class carried only if still valid; review rebuilt',
    steps: [...REVIEW_2, T('Date parso kar do')],
    expect: { selectedTrain: '12014', selectedClass: 'CC', reviewVersion: 2, reviewStatus: 'CURRENT', passengers: ['Mohit/31/MALE', 'Ravi/28/MALE'] } },
  { id: 'B17_REBUILD', title: 'explicit fare recheck → fresh GET_FARE + review v2 without restarting',
    steps: [...REVIEW_2, T('Abhi fare dobara check karo')],
    expect: { reviewVersion: 2, reviewStatus: 'CURRENT', toolsExecuted: ['CHECK_AVAILABILITY', 'GET_FARE'], passengers: ['Mohit/31/MALE', 'Ravi/28/MALE'] } },  // P33: the agent's GET_FARE + boundary availability refresh
  { id: 'B18_STALE_CONFIRMATION', title: 'confirmation for an older reviewVersion → STALE_REVIEW, current review shown',
    steps: [...REVIEW_2, T('First passenger ki age 32 kar do'), { text: 'haan', opts: { reviewVersion: 1 } }],
    expect: { errorCode: 'CONFIRMATION_VERSION_MISMATCH', errorType: 'STALE_REVIEW', reviewVersion: 2, confirmationStatus: 'AWAITING_CONFIRMATION' } },
  { id: 'B19_VALID_CONFIRMATION', title: '"haan" on the current review → confirmation REQUESTED (booking disabled)',
    steps: [...REVIEW_2, T('haan')],
    expect: { bookingState: 'IRCTC_HANDOFF_READY', preparationState: 'BOOKING_CONFIRMATION_REQUESTED', confirmationStatus: 'CONFIRMATION_REQUESTED', toolsExecuted: [], responseMatches: ['book nahi hua'] } },
  { id: 'B20_CONFIRM_WITHOUT_REVIEW', title: '"Confirm." with no current review → no confirmation',
    steps: [...UPTO_CLASS, T('Confirm.')],
    expect: { errorType: 'INVALID_CONFIRMATION', reviewVersion: null, responseMatches: ['koi current review nahi'] } },
  { id: 'B21_VOICE', title: 'same pipeline in VOICE → confirmation requested',
    steps: [T('Amritsar se Delhi kal', 'VOICE'), T('12014 wali kar do', 'VOICE'), T('CC', 'VOICE'), T('1 passenger. Mohit 31 male', 'VOICE'), T('haan', 'VOICE')],
    expect: { confirmationStatus: 'CONFIRMATION_REQUESTED', preparationState: 'BOOKING_CONFIRMATION_REQUESTED' } },
  { id: 'B22_INTERRUPTION', title: 'stop tap + barge-in mid-collection keeps collected fields and index',
    steps: [...UPTO_CLASS, T('2 passengers'), T('Mohit 31 male', 'VOICE'), { op: 'INTERRUPT' }, { text: 'Ravi 28 male', mode: 'VOICE', opts: { interruptPrevious: true } }],
    expect: { passengers: ['Mohit/31/MALE', 'Ravi/28/MALE'], reviewVersion: 1 } },
  { id: 'B23_RECOVERY', title: 'resume restores preparation + collection + review meta, same session, no PII',
    steps: [...REVIEW_2, T('First passenger ki age 32 kar do'), { op: 'RESUME' }],
    expect: { resume: { bookingPreparationState: 'AWAITING_CONFIRMATION', passengerCount: 2, passengersComplete: 2, reviewVersion: 2, reviewStatus: 'CURRENT', confirmationStatus: 'AWAITING_CONFIRMATION' } } },
  { id: 'B24_SENSITIVE', title: 'OTP mid-collection → refused, nothing stored, never sent to the LLM',
    steps: [...UPTO_CLASS, T('2 passengers'), T('Mohit 31 male. My OTP is 482913')],
    expect: { errorCode: 'SENSITIVE_REQUEST_REJECTED', passengers: ['_/_/_', '_/_/_'], toolsExecuted: [], responseExcludes: ['482913'] } }
]);
