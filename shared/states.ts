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
  COMPLETE = 'COMPLETE'
}

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
  [BookingState.COMPLETE]: [BookingState.IDLE]
};

// Backwards compatible alias
export const ConversationState = BookingState;
