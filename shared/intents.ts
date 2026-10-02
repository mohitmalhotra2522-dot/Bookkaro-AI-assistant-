/**
 * All allowed AI intents. Any intent not listed is automatically rejected
 * by the security validator. AI cannot execute arbitrary code or actions.
 */
export enum Intent {
  SEARCH_TRAINS = 'SEARCH_TRAINS',
  GET_TRAIN_INFO = 'GET_TRAIN_INFO',
  GET_TIMETABLE = 'GET_TIMETABLE',
  CHECK_AVAILABILITY = 'CHECK_AVAILABILITY',
  GET_FARE = 'GET_FARE',
  TRACK_TRAIN = 'TRACK_TRAIN',
  CHECK_PNR = 'CHECK_PNR',
  SELECT_TRAIN = 'SELECT_TRAIN',
  SELECT_CLASS = 'SELECT_CLASS',
  ADD_PASSENGER = 'ADD_PASSENGER',
  UPDATE_PASSENGER = 'UPDATE_PASSENGER',
  REVIEW_BOOKING = 'REVIEW_BOOKING',
  CHANGE_BOOKING_DETAIL = 'CHANGE_BOOKING_DETAIL',
  CONFIRM_BOOKING = 'CONFIRM_BOOKING',
  HANDOFF_TO_IRCTC = 'HANDOFF_TO_IRCTC',
  GENERAL_RAILWAY_QUERY = 'GENERAL_RAILWAY_QUERY',
  ASK_FIELD = 'ASK_FIELD',
  PROVIDE_FIELD = 'PROVIDE_FIELD',
  SHOW_RESULTS = 'SHOW_RESULTS'
}

export interface Action {
  type: Intent;
  payload?: Record<string, any>;
}

export interface AIResponse {
  message: string;
  action: Action;
}
