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
  PASSENGERS_READY: ['COLLECTING_PASSENGER_DETAILS', 'REVIEW', 'COLLECTING_PASSENGERS', 'NOT_STARTED', 'CLASS_SELECTED'],
  COLLECTING_PASSENGER_DETAILS: ['COLLECTING_PASSENGER_DETAILS', 'REVIEW', 'COLLECTING_PASSENGERS', 'PASSENGERS_READY', 'NOT_STARTED', 'CLASS_SELECTED'],
  REVIEW: ['AWAITING_CONFIRMATION', 'COLLECTING_PASSENGER_DETAILS', 'COLLECTING_PASSENGERS', 'PASSENGERS_READY', 'REVIEW', 'NOT_STARTED', 'CLASS_SELECTED'],
  AWAITING_CONFIRMATION: ['BOOKING_CONFIRMATION_REQUESTED', 'REVIEW', 'COLLECTING_PASSENGER_DETAILS', 'COLLECTING_PASSENGERS', 'PASSENGERS_READY', 'NOT_STARTED', 'CLASS_SELECTED'],
  // a confirmation REQUEST is recorded and the pipeline stops; later edits re-open preparation (never COMPLETE)
  BOOKING_CONFIRMATION_REQUESTED: ['REVIEW', 'COLLECTING_PASSENGER_DETAILS', 'COLLECTING_PASSENGERS', 'NOT_STARTED', 'CLASS_SELECTED']
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
  | 'DEPENDENCY_INVALIDATED';

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
}
