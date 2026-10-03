/**
 * PROMPT 19 — Booking preparation contract (shared by backend + UI).
 *
 * BookingPreparation is a DERIVED view over the authoritative BookingSession: it never stores a second copy
 * of journey / train / class / passengers. The top-level BookingState machine (shared/states.ts) stays
 * authoritative for the conversation; the preparation sub-state below names the Prompt-19 pipeline steps
 * (CLASS_SELECTED → BOOKING_PREPARE → COLLECTING_PASSENGERS → PASSENGERS_READY → COLLECTING_PASSENGER_DETAILS
 *  → REVIEW → AWAITING_CONFIRMATION → BOOKING_CONFIRMATION_REQUESTED). It NEVER reaches COMPLETE — no booking
 * happens in this milestone.
 */

export const BookingPreparationState = {
  NOT_STARTED: 'NOT_STARTED',
  CLASS_SELECTED: 'CLASS_SELECTED',
  BOOKING_PREPARE: 'BOOKING_PREPARE',
  COLLECTING_PASSENGERS: 'COLLECTING_PASSENGERS',
  PASSENGERS_READY: 'PASSENGERS_READY',
  COLLECTING_PASSENGER_DETAILS: 'COLLECTING_PASSENGER_DETAILS',
  /** Prompt 20 (Part 41): journey + train + class + count valid AND every passenger complete — review not built yet. */
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  REVIEW: 'REVIEW',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  BOOKING_CONFIRMATION_REQUESTED: 'BOOKING_CONFIRMATION_REQUESTED'
} as const;
export type BookingPreparationState = typeof BookingPreparationState[keyof typeof BookingPreparationState];

/** Part 48 — allowed preparation transitions. COMPLETE is deliberately absent (Part 49). */
export const PREPARATION_TRANSITIONS: Readonly<Record<BookingPreparationState, readonly BookingPreparationState[]>> = Object.freeze({
  NOT_STARTED: ['NOT_STARTED', 'CLASS_SELECTED'],
  CLASS_SELECTED: ['BOOKING_PREPARE', 'NOT_STARTED'],
  BOOKING_PREPARE: ['COLLECTING_PASSENGERS', 'PASSENGERS_READY', 'NOT_STARTED', 'CLASS_SELECTED'],
  COLLECTING_PASSENGERS: ['COLLECTING_PASSENGERS', 'PASSENGERS_READY', 'NOT_STARTED', 'CLASS_SELECTED'],
  // Prompt 20 (Part 20): details already valid → PASSENGERS_READY → READY_FOR_REVIEW (no re-asking)
  PASSENGERS_READY: ['COLLECTING_PASSENGER_DETAILS', 'READY_FOR_REVIEW', 'COLLECTING_PASSENGERS', 'NOT_STARTED', 'CLASS_SELECTED'],
  COLLECTING_PASSENGER_DETAILS: ['COLLECTING_PASSENGER_DETAILS', 'READY_FOR_REVIEW', 'COLLECTING_PASSENGERS', 'PASSENGERS_READY', 'NOT_STARTED', 'CLASS_SELECTED'],
  READY_FOR_REVIEW: ['REVIEW', 'READY_FOR_REVIEW', 'COLLECTING_PASSENGER_DETAILS', 'COLLECTING_PASSENGERS', 'PASSENGERS_READY', 'NOT_STARTED', 'CLASS_SELECTED'],
  // a review rebuild (correction / fresh recheck) goes back through READY_FOR_REVIEW — Part 35
  REVIEW: ['AWAITING_CONFIRMATION', 'READY_FOR_REVIEW', 'COLLECTING_PASSENGER_DETAILS', 'COLLECTING_PASSENGERS', 'PASSENGERS_READY', 'REVIEW', 'NOT_STARTED', 'CLASS_SELECTED'],
  AWAITING_CONFIRMATION: ['BOOKING_CONFIRMATION_REQUESTED', 'REVIEW', 'READY_FOR_REVIEW', 'COLLECTING_PASSENGER_DETAILS', 'COLLECTING_PASSENGERS', 'PASSENGERS_READY', 'NOT_STARTED', 'CLASS_SELECTED'],
  // a confirmation REQUEST is recorded and the pipeline stops; later edits re-open preparation (never COMPLETE)
  BOOKING_CONFIRMATION_REQUESTED: ['REVIEW', 'READY_FOR_REVIEW', 'COLLECTING_PASSENGER_DETAILS', 'COLLECTING_PASSENGERS', 'NOT_STARTED', 'CLASS_SELECTED']
});

export function canTransitionPreparation(from: BookingPreparationState, to: BookingPreparationState): boolean {
  return (PREPARATION_TRANSITIONS[from] || []).includes(to);
}

/** Part 5 — passenger collection sub-state. */
export type PassengerCollectionState = 'NOT_STARTED' | 'COUNT_REQUIRED' | 'PASSENGERS_READY' | 'COLLECTING_PASSENGER_DETAILS' | 'PASSENGERS_COMPLETE';

/** Part 27 — only CURRENT may move toward confirmation. */
export type ReviewStatus = 'NONE' | 'CURRENT' | 'STALE' | 'INVALID';

export type ConfirmationStatus = 'NOT_REQUESTED' | 'AWAITING_CONFIRMATION' | 'CONFIRMATION_REQUESTED' | 'INVALIDATED';

/** Part 18/19 — authoritative-data status of a dependency (never a guessed value). */
export type DependencyStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'STALE' | 'NOT_REQUESTED';

/** Part 47 — typed preparation errors. */
export type BookingPreparationErrorCode =
  | 'BOOKING_PREPARATION_NOT_READY'
  | 'INVALID_PASSENGER_COUNT'
  | 'INVALID_PASSENGER_INDEX'
  | 'INVALID_PASSENGER_FIELD'
  | 'INVALID_PASSENGER_VALUE'
  | 'PASSENGER_DETAILS_INCOMPLETE'
  | 'INVALID_REVIEW'
  | 'STALE_REVIEW'
  | 'INVALID_CONFIRMATION'
  | 'DEPENDENCY_INVALIDATED'
  // ---- Prompt 20 (Part 51) ----
  | 'INVALID_TRAIN_SELECTION'
  | 'INVALID_CLASS_SELECTION'
  | 'INVALID_AVAILABILITY_CONTEXT'
  | 'INVALID_FARE_CONTEXT'
  | 'REVIEW_BUILD_FAILED'
  | 'UNSUPPORTED_ACTION';

export type PreparationPrerequisite = 'ROUTE' | 'DATE' | 'TRAIN' | 'TRAIN_NOT_IN_CURRENT_RESULTS' | 'CLASS' | 'CLASS_NOT_AVAILABLE';

export interface PassengerMissingField { passengerIndex: number; field: 'name' | 'age' | 'gender' }

export interface PassengerCompleteness { complete: boolean; missing: PassengerMissingField[]; invalid: Array<{ passengerIndex: number; field: string }> }

/** Part 1 — derived booking preparation view (references session values; no PII in the summary variant). */
export interface BookingPreparationView {
  preparationState: BookingPreparationState;
  passengerCollectionState: PassengerCollectionState;
  journey: { origin: string | null; destination: string | null; date: string | null };
  selectedTrain: { number: string; name?: string } | null;
  selectedClass: string | null;
  passengersCount: number | null;
  /** 1-based deterministic index → stable passenger id + field presence. */
  passengerDetails: Array<{ index: number; passengerId: string; name?: string; age?: number; gender?: string; berthPreference?: string; complete: boolean }>;
  availabilityResult: { status: DependencyStatus; value?: string; fetchedAt?: string; toolExecutionId?: string };
  fareResult: { status: DependencyStatus; total?: number; perPassenger?: number; fetchedAt?: string; toolExecutionId?: string };
  reviewVersion: number | null;
  reviewStatus: ReviewStatus;
  confirmationStatus: ConfirmationStatus;
  missingPrerequisites: PreparationPrerequisite[];
  passengerCompleteness: PassengerCompleteness;
  /** Prompt 20 additions (derived; never a second store). */
  passengerCollection: PassengerCollectionView;
  journeyValidation: JourneyValidation | null;
  reviewSnapshot: ReviewSnapshot | null;
}

/** Part 46 — observability summary: counts and statuses only, never passenger names / ages. */
export interface BookingPreparationSummary {
  bookingPreparationState: BookingPreparationState;
  passengerCollectionState: PassengerCollectionState;
  passengerCount: number | null;
  passengersComplete: number;
  reviewVersion: number | null;
  reviewStatus: ReviewStatus;
  confirmationStatus: ConfirmationStatus;
  availabilityStatus: DependencyStatus;
  fareStatus: DependencyStatus;
  missingPrerequisites: PreparationPrerequisite[];
  /** Prompt 20 (Part 9/50) — collection metadata only (no names / ages). */
  passengerCollection?: { expectedCount: number | null; currentPassengerIndex: number | null; missingFieldCount: number };
  /** Prompt 20 (Part 29/49) — snapshot metadata only. */
  reviewSnapshot?: { reviewVersion: number; createdAt: string; availabilityStatus: SnapshotAvailabilityStatus; fareStatus: SnapshotFareStatus } | null;
}

// ==================================================================== Prompt 20

/**
 * Part 2 — Prompt-20 names ↔ existing Prompt-19 names ("use existing project naming if an equivalent enum exists").
 * The persisted / logged value is always the existing name; this table documents the equivalence for clients.
 */
export const PREPARATION_STATE_P20_ALIASES: Readonly<Record<string, BookingPreparationState>> = Object.freeze({
  NOT_READY: 'NOT_STARTED',
  READY_FOR_PASSENGERS: 'BOOKING_PREPARE',
  COLLECTING_PASSENGERS: 'COLLECTING_PASSENGERS',
  PASSENGERS_READY: 'PASSENGERS_READY',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  REVIEW_READY: 'REVIEW',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  CONFIRMATION_REQUESTED: 'BOOKING_CONFIRMATION_REQUESTED'
});

/** Part 4 — journey prerequisite fields validated against the CURRENT BookingSession. */
export type JourneyField = 'origin' | 'destination' | 'date' | 'selectedTrain' | 'selectedClass';
export type JourneyIssueCode = 'MISSING' | 'INVALID_DATE' | 'SAME_STATION' | 'INVALID_TRAIN_SELECTION' | 'INVALID_CLASS_SELECTION';
export interface JourneyValidation {
  valid: boolean;
  /** Typed missing / invalid prerequisite information, in deterministic order. */
  issues: Array<{ field: JourneyField; code: JourneyIssueCode }>;
  /** Result set the selected train was verified against (Part 5). */
  resultSetId: string | null;
}

/** Part 18 — validator verdict over the whole passenger set (the validator, never the LLM, decides). */
export interface PassengerSetValidation {
  valid: boolean;
  complete: boolean;
  missingFields: PassengerMissingField[];
  errors: Array<{ passengerIndex: number; field: string; code: 'INVALID_PASSENGER_VALUE' }>;
}

/** Part 9 — PassengerCollection view (derived from BookingSession.passengers; 1-based indexes). */
export interface PassengerCollectionView {
  expectedCount: number | null;
  passengers: Array<{ index: number; passengerId: string; name?: string; age?: number; gender?: string; berthPreference?: string; complete: boolean }>;
  /** 1-based index of the passenger the next question is about (null when nothing is being collected). */
  currentPassengerIndex: number | null;
  missingFields: PassengerMissingField[];
  status: PassengerCollectionState;
}

/** Part 25/29/32 — explicit authoritative-data states in the review (never a guessed value). */
export type SnapshotAvailabilityStatus = 'VERIFIED' | 'AVAILABILITY_UNAVAILABLE' | 'NOT_VERIFIED';
export type SnapshotFareStatus = 'VERIFIED' | 'FARE_UNAVAILABLE' | 'NOT_VERIFIED';

/**
 * Part 29 — ReviewSnapshot: ONLY authoritative validated data (BookingSession + validated passengers + provider
 * tool results matching the current basis). Frozen when built; never contains LLM text, seat / coach / PNR.
 */
export interface ReviewSnapshot {
  reviewVersion: number;
  createdAt: string;
  sessionVersion: number;
  fingerprint: string;
  journey: { origin: string; destination: string; date: string; originName?: string; destinationName?: string };
  train: { number: string; name?: string; departure?: string; arrival?: string; resultSetId: string | null };
  travelClass: string;
  passengers: Array<{ index: number; name: string; age: number; gender: string; berthPreference?: string }>;
  availability: { status: SnapshotAvailabilityStatus; value?: string; retrievedAt?: string; toolExecutionId?: string; errorCode?: string | null };
  fare: { status: SnapshotFareStatus; total?: number; perPassenger?: number; currency?: string; passengersCount?: number; retrievedAt?: string; toolExecutionId?: string; errorCode?: string | null };
  dataSource?: string;
}

/** Part 45 — what kind of thing the LLM asked for this turn. */
export type AgentActionKind = 'RAILWAY_INFORMATION' | 'BOOKING_SESSION' | 'CONVERSATION';

/**
 * Part 51 — typed preparation error for any orchestrator / service code. Stable legacy codes keep their value
 * (clients + earlier contracts depend on them); this adds the Prompt-20 type alongside. Never maps to success.
 */
export function preparationErrorTypeOf(code: string | null | undefined, tool?: string | null): BookingPreparationErrorCode | 'SENSITIVE_DATA_REJECTED' | null {
  if (!code) return null;
  const direct: Record<string, BookingPreparationErrorCode | 'SENSITIVE_DATA_REJECTED'> = {
    BOOKING_PREPARATION_NOT_READY: 'BOOKING_PREPARATION_NOT_READY', BOOKING_NOT_READY: 'BOOKING_PREPARATION_NOT_READY',
    INVALID_PASSENGER_COUNT: 'INVALID_PASSENGER_COUNT', MISSING_PASSENGER_COUNT: 'INVALID_PASSENGER_COUNT',
    INVALID_PASSENGER_INDEX: 'INVALID_PASSENGER_INDEX', INVALID_PASSENGER_FIELD: 'INVALID_PASSENGER_FIELD',
    INVALID_PASSENGER_VALUE: 'INVALID_PASSENGER_VALUE', INVALID_PASSENGER_DETAILS: 'INVALID_PASSENGER_VALUE',
    PASSENGER_DETAILS_INCOMPLETE: 'PASSENGER_DETAILS_INCOMPLETE', MISSING_PASSENGER_DETAILS: 'PASSENGER_DETAILS_INCOMPLETE',
    INVALID_TRAIN_SELECTION: 'INVALID_TRAIN_SELECTION', INVALID_TRAIN_REFERENCE: 'INVALID_TRAIN_SELECTION', STALE_SEARCH_REFERENCE: 'INVALID_TRAIN_SELECTION',
    INVALID_CLASS_SELECTION: 'INVALID_CLASS_SELECTION',
    INVALID_AVAILABILITY_CONTEXT: 'INVALID_AVAILABILITY_CONTEXT', INVALID_FARE_CONTEXT: 'INVALID_FARE_CONTEXT',
    REVIEW_BUILD_FAILED: 'REVIEW_BUILD_FAILED', INVALID_REVIEW: 'INVALID_REVIEW',
    STALE_REVIEW: 'STALE_REVIEW', CONFIRMATION_VERSION_MISMATCH: 'STALE_REVIEW', REVIEW_INVALIDATED: 'STALE_REVIEW',
    INVALID_CONFIRMATION: 'INVALID_CONFIRMATION', CONFIRMATION_NOT_PENDING: 'INVALID_CONFIRMATION',
    UNSUPPORTED_ACTION: 'UNSUPPORTED_ACTION', DEPENDENCY_INVALIDATED: 'DEPENDENCY_INVALIDATED',
    SENSITIVE_REQUEST_REJECTED: 'SENSITIVE_DATA_REJECTED', SENSITIVE_DATA_REJECTED: 'SENSITIVE_DATA_REJECTED'
  };
  if (direct[code]) return direct[code];
  // a CHECK_AVAILABILITY / GET_FARE request whose arguments did not fit the authoritative selection
  if (tool === 'CHECK_AVAILABILITY' && /MISMATCH|MISSING_REQUIRED|INVALID_ARG|REQUIRES_STATE|STATE_REQUIRED|INVALID_TOOL_ARGUMENTS/.test(code)) return 'INVALID_AVAILABILITY_CONTEXT';
  if (tool === 'GET_FARE' && /MISMATCH|MISSING_REQUIRED|INVALID_ARG|REQUIRES_STATE|STATE_REQUIRED|INVALID_TOOL_ARGUMENTS/.test(code)) return 'INVALID_FARE_CONTEXT';
  return null;
}
