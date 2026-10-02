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
}

export interface FareResult {
  perPassenger: number;
  total: number;
  breakdown: Record<string, number>;
  currency: 'INR';
  dataSource: 'MOCK' | 'LIVE';
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
  | 'BOOKING_HANDOFF_EXECUTION_REQUESTED';

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
