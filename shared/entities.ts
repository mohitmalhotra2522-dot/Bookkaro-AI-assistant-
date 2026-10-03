import type { BookingExecutionRecord } from './booking-provider';
import type { BookingHandoffRecord, BookingLifecycleRecord, ExecutionAttemptRecord, HandoffStatus } from './booking-execution';
import type { BookingConfirmation, BookingHandoffSession, HandoffSessionStatus } from './booking-handoff-session';
/**
 * Core domain types. No secrets, credentials, payment, OTP fields EVER.
 */

export type StationCode = string;

// Interaction mode
export type InteractionMode = 'TEXT' | 'VOICE';

// Structured Tool response contract
export interface ToolResult<T = any> {
  ok: boolean;
  data?: T;
  error?: string;
  source: 'railway-provider' | 'mock-provider';
  timestamp: string;
}

export interface Journey {
  origin?: StationCode;
  originName?: string;
  destination?: StationCode;
  destinationName?: string;
  date?: string; // YYYY-MM-DD
  passengerCount?: number;
  preferredTime?: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | 'ANY';
  preferredClass?: 'AC' | 'NON_AC' | 'ANY';
}

export interface TrainClassInfo {
  code: string; // CC, 2S, 3A etc.
  name: string;
  availability?: string;
  availabilitySource?: 'MOCK' | 'LIVE';
  fare?: number;
  fareCurrency?: 'INR';
  fareSource?: 'MOCK' | 'LIVE';
}

export interface Train {
  number: string;
  name: string;
  origin: StationCode;
  destination: StationCode;
  departure: string; // HH:MM
  arrival: string; // HH:MM
  duration: string;
  runsOn?: string[];
  classes: TrainClassInfo[]; // group classes per train
  dataSource: 'MOCK' | 'LIVE';
}

export interface TrainSearchResult {
  trains: Train[];
  dataSource: 'MOCK' | 'LIVE';
}

export interface TrainDetails extends Train {
  timetable?: Array<{ station: StationCode; arrival?: string; departure?: string }>;
}

export interface AvailabilityResult {
  available: boolean;
  status: string;
  dataSource: 'MOCK' | 'LIVE';
  /** Prompt 18 (Part 36): provenance of THIS check — never treated as permanent (a new request re-checks). */
  fetchedAt?: string;
  toolExecutionId?: string;
  trainNumber?: string;
  travelClass?: string;
  date?: string;
  origin?: string;
  destination?: string;
}

export interface FareResult {
  perPassenger: number;
  total: number;
  breakdown: Record<string, number>;
  currency: 'INR';
  dataSource: 'MOCK' | 'LIVE';
  /** Prompt 18 (Part 37): provenance + fare basis (provider-computed; the LLM never calculates fare). */
  fetchedAt?: string;
  toolExecutionId?: string;
  fareBasis?: { trainNumber?: string; travelClass?: string; passengersCount?: number; origin?: string; destination?: string; date?: string };
}

export type Gender = 'MALE' | 'FEMALE' | 'OTHER';
export type BerthPreference =
  | 'WINDOW'
  | 'LOWER'
  | 'MIDDLE'
  | 'UPPER'
  | 'SIDE_LOWER'
  | 'SIDE_UPPER'
  | 'NO_PREFERENCE';

export interface Passenger {
  id: string;
  name?: string;
  age?: number;
  gender?: Gender;
  berthPreference?: BerthPreference;
  manuallyEdited?: boolean;
  missingFields?: ('name' | 'age' | 'gender' | 'berthPreference')[];
}

export interface BookingReview {
  journey: Journey;
  train: Train | null;
  selectedClass?: string;
  passengers: Passenger[];
  fare: FareResult | null;
  confirmationRequired: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'card';
  content: string;
  timestamp: number;
  inputMode?: InteractionMode;
  cardType?: 'trains' | 'passengers' | 'review';
  cardData?: any;
}

/**
 * Typed BookingSession: single source of truth for all booking state.
 */
export interface BookingSession {
  sessionId: string;
  conversationId: string;
  mode: InteractionMode;
  intent?: string;
  origin?: StationCode;
  originName?: string;
  destination?: StationCode;
  destinationName?: string;
  date?: string;
  passengersCount?: number;
  passengers: Passenger[];
  preferredTime?: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | 'ANY';
  preferredClass?: 'AC' | 'NON_AC' | 'ANY';
  availableTrains: Train[];
  lastSearch?: any;
  searchResults?: any;
  selectedTrain?: Train | any;
  selectedClass?: string;
  selectedJourney?: { origin: StationCode; destination: StationCode; date: string; trainNumber: string };
  fare?: FareResult;
  availability?: Record<string, AvailabilityResult>;
  bookingState: import('./states').BookingState;
  /** Prompt 18 (Part 19): pending question code derived from pendingInteraction (MISSING_DATE, SELECT_TRAIN, CONFIRM_REVIEW …). */
  pendingQuestion?: import('./turn-engine').PendingQuestionCode | null;
  reviewConfirmed: boolean;
  irctcHandoffReady: boolean;
  currentPassengerIndex: number;
  lastToolActivity?: string;
  dataSourceLabel: string;
  searchTimestamp?: string;
  providerSource?: string;
  // Track which fields were collected this turn for observability
  lastDetectedChanges?: string[];
  // Ephemeral cache of most recent tool results for response enrichment (never
  // treated as authoritative booking state).
  lastTrainInfo?: any;
  lastTimetable?: any;

  // ---- Multi-turn context hardening (Prompt 8) ----
  /** Structured pending interaction the backend is waiting for. Used to resolve
   *  short/ambiguous replies ("haan", "kal", "doosri") against context. */
  pendingInteraction?: PendingInteraction;
  /** Monotonic session version bumped on every mutating turn. Used for stale
   *  result rejection (late tool results from older versions must not overwrite
   *  newer state). */
  sessionVersion: number;
  /** Prompt 17: increments on every MATERIAL journey change (origin | destination | date). */
  journeyVersion?: number;
  /** Prompt 17: fingerprint the journeyVersion was computed for (internal). */
  journeyKey?: string;
  /** Per-search version. Bumped on every SEARCH_TRAINS execution; train
   *  references by displayIndex must match current version. */
  searchResultsVersion: number;
  /** Stable display metadata for the most recent search. */
  searchMeta?: { resultId: string; retrievedAt: string; totalCount: number };
  /** Event log of typed internal events (for audit/observability). */
  eventLog?: BookingEvent[];
  /** Train most recently discussed (GET_TRAIN_INFO / selection). Used to
   *  resolve "iski", "ye wali", "jo pehle batayi thi". Backend-owned. */
  focusTrainNumber?: string;
  /** Previously selected train number (before a change of mind). */
  previousTrainNumber?: string;
  /** Monotonic per-turn request version + id of the latest started turn.
   *  Results from older requests are rejected as STALE_TOOL_RESULT. */
  requestVersion: number;
  activeRequestId?: string;

  // ---- Booking preparation (Prompt 9) ----
  /** Monotonic counter for stable passenger ids (P1, P2, …). Ids are never reused. */
  passengerSeq?: number;
  /** Passenger most recently referenced/updated — resolves "uska/uski". */
  lastPassengerRefId?: string;
  /** Monotonic review version counter (incremented on every review generation). */
  reviewVersion?: number;
  /** The CURRENT review (deterministic, from authoritative data only). */
  review?: BookingReviewRecord;
  /** reviewVersion the AWAITING_CONFIRMATION prompt refers to. Confirmation is
   *  accepted only if it still equals review.reviewVersion and the review is valid. */
  confirmedReviewVersion?: number;
  /** Last deterministic readiness evaluation (observability / UI). */
  readiness?: BookingReadinessSnapshot;
  /** Selection to carry over after a DATE-only correction (same train/class re-verified on new date). */
  carryOverSelection?: { trainNumber: string; classCode?: string };

  // ---- Booking execution boundary (Prompt 10) ----
  /** Immutable handoff snapshot + status (READY / INVALIDATED / CONSUMED / EXPIRED). Backend-owned. */
  handoff?: BookingHandoffRecord;
  /** Previous handoffs (status history only — snapshots are never mutated). */
  handoffHistory?: Array<{ handoffId: string; status: HandoffStatus; statusReason?: string; at: string }>;
  /** Deterministic booking lifecycle (separate from the conversation state machine). */
  bookingLifecycle?: BookingLifecycleRecord;
  /** Last execution attempt outcome (DISABLED in this milestone). */
  execution?: ExecutionAttemptRecord;

  // ---- Secure handoff session (Prompt 11) — backend-owned, never credential-bearing ----
  /** Deterministic confirmation of the current review (VALID / INVALIDATED / EXPIRED). */
  confirmation?: BookingConfirmation;
  /** Current short-lived handoff session (READY / EXPIRED / INVALIDATED / FAILED). */
  handoffSession?: BookingHandoffSession;
  /** Status history of handoff sessions (snapshots never mutated). */
  handoffSessionHistory?: Array<{ handoffSessionId: string; bookingHandoffId: string; status: HandoffSessionStatus; statusReason?: string; at: string }>;

  // ---- Booking provider execution (Prompt 12) — normalized records only ----
  /** Execution record for the CURRENT handoff (provider status / reference / authoritative PNR). */
  bookingExecution?: BookingExecutionRecord;
  /** Earlier execution records (one per handoff). */
  bookingExecutionHistory?: BookingExecutionRecord[];

  // ---- Post-booking (Prompt 14) — ids only; records live in the backend BookingHistoryStore ----
  /** BookingRecord ids owned by this session (session-scoped ownership). */
  bookingRecordIds?: string[];
  /** The booking the conversation is currently about (latest record / last resolved reference). */
  activeBookingId?: string;
  /** Open booking-reference clarification ("12014 wali ya 14542 wali?"). */
  postBookingClarification?: { kind: 'PNR_STATUS' | 'LIVE_STATUS' | 'PNR_VALUE' | 'BOOKING_STATUS' | 'BOOKING_DETAILS' | 'HISTORY'; candidateIds: string[]; setAtTurnId: string };

  // ---- Booking lifecycle actions (Prompt 15) — ids/status only; action records live in the backend store ----
  /** Destructive action awaiting the user's explicit confirmation on a LATER turn (never the same turn). */
  pendingLifecycleAction?: { actionId: string; setAtTurnId: string; expiresAt: number };
  /** Open lifecycle clarification (which booking / which date / which class). */
  lifecycleClarification?: {
    action: string; candidateIds: string[]; setAtTurnId: string;
    awaiting?: 'BOOKING' | 'DATE' | 'CLASS'; retry?: boolean;
    changes?: { journeyDate?: string; travelClass?: string };
  };
  /** Most recent lifecycle action (duplicate "haan" / retries are answered from it, never re-sent). */
  lastLifecycleAction?: { actionId: string; bookingId: string; actionType: string; status: string; resultStatus: string | null; at: number };
}

/** Provenance attached to every provider result synced into the session. */
export interface ToolResultProvenance {
  sessionId: string;
  requestId?: string;
  sessionVersion: number;
  retrievedAt: string;
}

export interface BookingReviewRecord {
  reviewVersion: number;
  createdAt: string;
  sessionVersion: number;
  /** Fingerprint of booking-critical data the review was built from. */
  fingerprint: string;
  valid: boolean;
  invalidatedReason?: string;
  data: any;
}

export type BookingBlocker =
  | 'MISSING_ORIGIN'
  | 'MISSING_DESTINATION'
  | 'MISSING_DATE'
  | 'MISSING_PASSENGER_COUNT'
  | 'MISSING_TRAIN'
  | 'MISSING_CLASS'
  | 'MISSING_PASSENGER_DETAILS'
  | 'INVALID_PASSENGER_DETAILS'
  | 'INVALID_TRAIN'
  | 'INVALID_CLASS'
  | 'STALE_AVAILABILITY'
  | 'STALE_FARE'
  | 'REQUIRED_TOOL_DATA_MISSING';

export interface BookingReadinessSnapshot {
  ready: boolean;
  blockers: BookingBlocker[];
  missingFields: string[];
  warnings: string[];
  nextRequiredField?: { field: string; passengerId?: string; passengerIndex?: number } | null;
  evaluatedAt: string;
}

export type PendingInteractionType =
  | 'ORIGIN_REQUIRED'
  | 'DESTINATION_REQUIRED'
  | 'DATE_REQUIRED'
  | 'PASSENGERS_REQUIRED'
  | 'TRAIN_SELECTION_REQUIRED'
  | 'CLASS_SELECTION_REQUIRED'
  | 'PASSENGER_DETAILS_REQUIRED'
  | 'REVIEW_APPROVAL_REQUIRED'
  | 'CONFIRMATION_REQUIRED'
  | 'CLARIFICATION_REQUIRED'
  | 'NONE';

export interface PendingInteraction {
  type: PendingInteractionType;
  /** Optional clarifying hint to pass to the LLM (voice-friendly, short). */
  hint?: string;
  /** TurnId that set this pending question — used to invalidate after answer. */
  setAtTurnId?: string;
  /** Structured clarification payload (e.g. { kind:'STATION_ROLE', station:'NDLS' }
   *  or { kind:'TRAIN_CHOICE', candidates:['12014','12497'] }). */
  data?: Record<string, any>;
}

export type BookingEventType =
  | 'JOURNEY_UPDATED'
  | 'DATE_UPDATED'
  | 'PASSENGERS_UPDATED'
  | 'SEARCH_STARTED'
  | 'SEARCH_COMPLETED'
  | 'TRAIN_SELECTED'
  | 'CLASS_SELECTED'
  | 'AVAILABILITY_CHECKED'
  | 'FARE_CHECKED'
  | 'REVIEW_READY'
  | 'CONFIRMATION_REQUESTED'
  | 'BOOKING_CONFIRMATION_REQUESTED'
  | 'TOOL_FAILED'
  | 'SESSION_INVALIDATED'
  // Prompt 16 — conversation context
  | 'CONTEXT_PATCH_REJECTED'
  | 'NEW_JOURNEY_STARTED'
  | 'TOOL_CALL_DEDUPLICATED'
  | 'STALE_RESULT_REJECTED'
  | 'CORRECTION_APPLIED'
  // ---- Prompt 9: booking preparation ----
  | 'BOOKING_PREPARATION_STARTED'
  | 'PASSENGER_COUNT_UPDATED'
  | 'PASSENGER_DETAILS_UPDATED'
  | 'PASSENGER_DETAILS_VALIDATED'
  | 'PASSENGER_REMOVED'
  | 'BOOKING_READINESS_UPDATED'
  | 'AVAILABILITY_REFRESHED'
  | 'FARE_REFRESHED'
  | 'REVIEW_CREATED'
  | 'REVIEW_INVALIDATED'
  | 'IRCTC_HANDOFF_READY'
  // ---- Prompt 10: execution boundary ----
  | 'BOOKING_EXECUTION_REQUESTED'
  | 'BOOKING_HANDOFF_CREATED'
  | 'BOOKING_HANDOFF_INVALIDATED'
  | 'BOOKING_HANDOFF_EXPIRED'
  | 'BOOKING_EXECUTION_DISABLED'
  | 'BOOKING_EXECUTION_REJECTED'
  | 'BOOKING_EXECUTION_DUPLICATE'
  | 'BOOKING_LIFECYCLE_UPDATED'
  // ---- Prompt 11: secure handoff session ----
  | 'BOOKING_CONFIRMATION_CREATED'
  | 'BOOKING_CONFIRMATION_INVALIDATED'
  | 'BOOKING_HANDOFF_SESSION_CREATED'
  | 'BOOKING_HANDOFF_EXECUTION_REQUESTED'
  // ---- Prompt 12: booking provider boundary ----
  | 'BOOKING_PROVIDER_SELECTED'
  | 'BOOKING_EXECUTION_STARTED'
  | 'BOOKING_PROVIDER_RESPONSE_RECEIVED'
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_FAILED'
  | 'BOOKING_PROVIDER_UNAVAILABLE'
  | 'BOOKING_STATUS_UNKNOWN'
  | 'BOOKING_REQUIRES_EXTERNAL_HANDOFF'
  // ---- Prompt 13: execution lifecycle + reconciliation ----
  | 'BOOKING_PROVIDER_ACCEPTED'
  | 'BOOKING_PROVIDER_CONFIRMED'
  | 'BOOKING_PROVIDER_FAILED'
  | 'BOOKING_PROVIDER_TIMEOUT'
  | 'BOOKING_STATUS_CHECK_REQUESTED'
  | 'BOOKING_STATUS_RECONCILED'
  | 'BOOKING_EXECUTION_UNKNOWN'
  | 'BOOKING_MANUAL_VERIFICATION_REQUIRED'
  | 'BOOKING_RETRY_AFTER_FAILURE'
  | 'BOOKING_CANCEL_NOT_SUPPORTED'
  // ---- Prompt 14: post-booking read model (PNR always masked in event data) ----
  | 'BOOKING_RECORD_CREATED'
  | 'BOOKING_STATUS_UPDATED'
  | 'PNR_ATTACHED'
  | 'PNR_STATUS_CHECKED'
  | 'BOOKING_HISTORY_QUERIED'
  | 'BOOKING_LIVE_STATUS_REQUESTED'
  // Prompt 15 — lifecycle actions (no PNR, no passenger values, no secrets)
  | 'BOOKING_ACTION_REQUESTED'
  | 'BOOKING_ACTION_CONFIRMATION_REQUIRED'
  | 'BOOKING_ACTION_CONFIRMED_BY_USER'
  | 'BOOKING_ACTION_SUBMITTED'
  | 'BOOKING_ACTION_RESULT'
  | 'BOOKING_ACTION_REJECTED'
  | 'BOOKING_ACTION_ABANDONED'
  | 'BOOKING_ACTION_RECONCILED'
  | 'BOOKING_CANCELLATION_CONFIRMED'
  | 'BOOKING_MODIFICATION_CONFIRMED'
  | 'REFUND_STATUS_CHECKED';

export interface BookingEvent {
  type: BookingEventType;
  turnId: string;
  timestamp: string;
  sessionVersion: number;
  data?: Record<string, any>;
}

// Alias for backwards compatibility
export type SessionContext = BookingSession;

/**
 * Structured observability record per conversation turn.
 * Logged server-side; no secrets/credentials ever recorded.
 */
export interface TurnLog {
  turnId: string;
  sessionId: string;
  timestamp: string;
  stateBefore: string;
  userInput: string;
  inputMode: InteractionMode;
  detectedChanges: string[];
  toolCalled?: string;
  toolResultStatus?: 'ok' | 'error' | 'none';
  stateAfter: string;
  latencyMs: number;
}
