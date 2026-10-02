/**
 * Booking state machine (updated per specification).
 * All explicit valid transitions; no state may skip required validation.
 */
export enum BookingState {
  IDLE = 'IDLE',
  COLLECTING_JOURNEY = 'COLLECTING_JOURNEY',
  COLLECTING_DATE = 'COLLECTING_DATE',
  COLLECTING_PASSENGERS = 'COLLECTING_PASSENGERS',
  SEARCHING_TRAINS = 'SEARCHING_TRAINS',
  SHOWING_TRAINS = 'SHOWING_TRAINS',
  TRAIN_SELECTED = 'TRAIN_SELECTED',
  CLASS_OPTIONS = 'CLASS_OPTIONS',
  CLASS_SELECTED = 'CLASS_SELECTED',
  BOOKING_PREPARE = 'BOOKING_PREPARE',
  COLLECTING_PASSENGER_DETAILS = 'COLLECTING_PASSENGER_DETAILS',
  PASSENGERS_READY = 'PASSENGERS_READY',
  REVIEW = 'REVIEW',
  AWAITING_CONFIRMATION = 'AWAITING_CONFIRMATION',
  IRCTC_HANDOFF_READY = 'IRCTC_HANDOFF_READY',
  COMPLETE = 'COMPLETE',
  // ---- Prompt 10: future execution states (LOCKED in this milestone) ----
  // Defined so a future executor can plug in without changing the enum, but
  // the transition validator HARD-REJECTS every transition into them while
  // real booking execution is disabled. The final state of this milestone
  // remains IRCTC_HANDOFF_READY.
  BOOKING_EXECUTION_REQUESTED = 'BOOKING_EXECUTION_REQUESTED',
  BOOKING_IN_PROGRESS = 'BOOKING_IN_PROGRESS',
  BOOKING_CONFIRMED = 'BOOKING_CONFIRMED',
  BOOKING_FAILED = 'BOOKING_FAILED',
  // ---- Prompt 13: outcome of a submitted booking could not be established (timeout /
  // lost connection / invalid response). NOT a failure — reconciliation required.
  // Covers lifecycle UNKNOWN and MANUAL_VERIFICATION_REQUIRED (the record distinguishes).
  BOOKING_STATUS_UNKNOWN = 'BOOKING_STATUS_UNKNOWN'
}

/**
 * States that can only be entered by the BookingProviderExecutionService on an
 * AUTHORITATIVE provider response (Prompt 12). The generic transition validator
 * rejects them for every other caller (LLM decisions, applier, preparation).
 */
export const EXECUTION_LOCKED_STATES: ReadonlySet<BookingState> = new Set([
  BookingState.BOOKING_EXECUTION_REQUESTED,
  BookingState.BOOKING_IN_PROGRESS,
  BookingState.BOOKING_CONFIRMED,
  BookingState.BOOKING_FAILED,
  BookingState.BOOKING_STATUS_UNKNOWN
]);

/**
 * Provider-result-driven execution transitions (Prompt 12) — checked by
 * StateTransitionValidator.checkExecution(), used ONLY by the provider execution path.
 * With the provider disabled none of these is ever taken: IRCTC_HANDOFF_READY stays final.
 */
export const EXECUTION_TRANSITIONS: Readonly<Partial<Record<BookingState, readonly BookingState[]>>> = Object.freeze({
  [BookingState.IRCTC_HANDOFF_READY]: [BookingState.BOOKING_EXECUTION_REQUESTED],
  // back to IRCTC_HANDOFF_READY only for REQUIRES_EXTERNAL_HANDOFF (provider did not book)
  [BookingState.BOOKING_EXECUTION_REQUESTED]: [BookingState.BOOKING_IN_PROGRESS, BookingState.BOOKING_FAILED, BookingState.IRCTC_HANDOFF_READY],
  [BookingState.BOOKING_IN_PROGRESS]: [BookingState.BOOKING_CONFIRMED, BookingState.BOOKING_FAILED, BookingState.BOOKING_STATUS_UNKNOWN, BookingState.IRCTC_HANDOFF_READY],
  // Prompt 13: only reconciliation (authoritative provider status) leaves UNKNOWN
  [BookingState.BOOKING_STATUS_UNKNOWN]: [BookingState.BOOKING_CONFIRMED, BookingState.BOOKING_FAILED, BookingState.BOOKING_IN_PROGRESS],
  // Prompt 13: explicit user retry after an AUTHORITATIVE failure → fresh data + new review/confirmation/handoff
  [BookingState.BOOKING_FAILED]: [BookingState.PASSENGERS_READY, BookingState.COLLECTING_PASSENGER_DETAILS]
});

/**
 * Valid state transitions per specification. Any transition not listed is blocked.
 */
export const VALID_BOOKING_TRANSITIONS: Record<BookingState, BookingState[]> = {
  [BookingState.IDLE]: [BookingState.COLLECTING_JOURNEY],
  [BookingState.COLLECTING_JOURNEY]: [
    BookingState.COLLECTING_JOURNEY,
    BookingState.COLLECTING_DATE,
    BookingState.COLLECTING_PASSENGERS,
    BookingState.SEARCHING_TRAINS
  ],
  [BookingState.COLLECTING_DATE]: [
    BookingState.COLLECTING_DATE,
    BookingState.COLLECTING_PASSENGERS,
    BookingState.COLLECTING_JOURNEY,
    BookingState.SEARCHING_TRAINS
  ],
  [BookingState.COLLECTING_PASSENGERS]: [
    BookingState.COLLECTING_PASSENGERS,
    BookingState.SEARCHING_TRAINS,
    BookingState.COLLECTING_JOURNEY,
    BookingState.COLLECTING_DATE
  ],
  [BookingState.SEARCHING_TRAINS]: [
    BookingState.SHOWING_TRAINS,
    BookingState.COLLECTING_JOURNEY,
    BookingState.COLLECTING_DATE,
    BookingState.COLLECTING_PASSENGERS
  ],
  [BookingState.SHOWING_TRAINS]: [
    BookingState.TRAIN_SELECTED,
    BookingState.SEARCHING_TRAINS,
    BookingState.COLLECTING_JOURNEY,
    BookingState.COLLECTING_DATE,
    BookingState.COLLECTING_PASSENGERS
  ],
  [BookingState.TRAIN_SELECTED]: [
    BookingState.CLASS_OPTIONS,
    BookingState.CLASS_SELECTED,
    BookingState.SHOWING_TRAINS,
    BookingState.SEARCHING_TRAINS
  ],
  [BookingState.CLASS_OPTIONS]: [
    BookingState.CLASS_SELECTED,
    BookingState.TRAIN_SELECTED,
    BookingState.SHOWING_TRAINS
  ],
  [BookingState.CLASS_SELECTED]: [
    BookingState.BOOKING_PREPARE,
    BookingState.CLASS_OPTIONS,
    BookingState.TRAIN_SELECTED,
    BookingState.SHOWING_TRAINS
  ],
  [BookingState.BOOKING_PREPARE]: [BookingState.COLLECTING_PASSENGER_DETAILS, BookingState.CLASS_SELECTED],
  [BookingState.COLLECTING_PASSENGER_DETAILS]: [
    BookingState.COLLECTING_PASSENGER_DETAILS,
    BookingState.PASSENGERS_READY,
    BookingState.CLASS_SELECTED,
    BookingState.SHOWING_TRAINS
  ],
  [BookingState.PASSENGERS_READY]: [BookingState.REVIEW, BookingState.COLLECTING_PASSENGER_DETAILS],
  [BookingState.REVIEW]: [
    BookingState.AWAITING_CONFIRMATION,
    BookingState.COLLECTING_JOURNEY,
    BookingState.COLLECTING_DATE,
    BookingState.COLLECTING_PASSENGERS,
    BookingState.SEARCHING_TRAINS,
    BookingState.SHOWING_TRAINS,
    BookingState.TRAIN_SELECTED,
    BookingState.CLASS_SELECTED,
    BookingState.COLLECTING_PASSENGER_DETAILS
  ],
  [BookingState.AWAITING_CONFIRMATION]: [
    BookingState.IRCTC_HANDOFF_READY,
    BookingState.REVIEW,
    BookingState.COLLECTING_PASSENGER_DETAILS
  ],
  [BookingState.IRCTC_HANDOFF_READY]: [BookingState.COMPLETE, BookingState.REVIEW],
  [BookingState.COMPLETE]: [BookingState.IDLE],
  // Locked: no edges in or out while execution is disabled (Prompt 10).
  [BookingState.BOOKING_EXECUTION_REQUESTED]: [],
  [BookingState.BOOKING_IN_PROGRESS]: [],
  [BookingState.BOOKING_CONFIRMED]: [],
  [BookingState.BOOKING_FAILED]: [],
  [BookingState.BOOKING_STATUS_UNKNOWN]: []
};

// Backwards compatible alias
export const ConversationState = BookingState;
