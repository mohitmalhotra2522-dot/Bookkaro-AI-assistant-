/**
 * Booking execution boundary — shared, provider-independent types (Prompt 10).
 *
 * BOOKING PREPARATION (conversation, tools, passengers, review, confirmation)
 * is separated from BOOKING EXECUTION (a future, explicitly enabled executor).
 * In this milestone execution is DISABLED: no IRCTC login, no form submission,
 * no OTP / CAPTCHA, no payment, no PNR.
 *
 * SECURITY: none of these types has — or may ever gain — fields for passwords,
 * OTP, CAPTCHA, card number, CVV, UPI PIN, bank password, auth tokens or
 * session cookies. A future executor must obtain any credentials through a
 * separate secure, user-controlled layer — never through the LLM or this request.
 */

/** Explicit executor outcome. The disabled executor may only return DISABLED / REQUIRES_HANDOFF. */
export type BookingExecutionStatus =
  | 'DISABLED'
  | 'STARTED'
  | 'IN_PROGRESS'
  | 'SUCCESS'
  | 'FAILED'
  | 'CANCELLED'
  | 'REQUIRES_HANDOFF';

export const BOOKING_EXECUTION_STATUSES: readonly BookingExecutionStatus[] =
  ['DISABLED', 'STARTED', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'CANCELLED', 'REQUIRES_HANDOFF'];

/** Outcomes that are legitimate in this milestone (no real execution exists). */
export const NON_EXECUTING_STATUSES: ReadonlySet<BookingExecutionStatus> = new Set(['DISABLED', 'REQUIRES_HANDOFF']);

export type BookingExecutionErrorCode =
  | 'BOOKING_NOT_READY'
  | 'BOOKING_EXECUTION_DISABLED'
  | 'REAL_BOOKING_DISABLED'
  | 'INVALID_BOOKING_HANDOFF'
  | 'STALE_BOOKING_HANDOFF'
  | 'HANDOFF_EXPIRED'
  | 'CONFIRMATION_REQUIRED'
  | 'CONFIRMATION_VERSION_MISMATCH'
  | 'SESSION_VERSION_CONFLICT'
  | 'STALE_AVAILABILITY'
  | 'STALE_FARE'
  | 'INVALID_TRAIN'
  | 'INVALID_CLASS'
  | 'INVALID_PASSENGER_DETAILS'
  | 'UNKNOWN_BOOKING_EXECUTOR'
  | 'BOOKING_EXECUTOR_UNAVAILABLE'
  | 'BOOKING_EXECUTION_FAILED';

/** Validated passenger — ONLY fields of the existing passenger contract. */
export interface ExecutionPassenger {
  passengerId: string;
  name: string;
  age: number;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  berthPreference?: string;
}

export interface ExecutionTrainRef {
  trainNumber: string;
  trainName?: string;
  /** Result row id from the authoritative search that produced the selection. */
  resultId: string;
  date: string;
  origin: string;
  destination: string;
  departure?: string;
  arrival?: string;
}

/**
 * Typed execution request. Built by the BACKEND from the authoritative
 * BookingSession (never by the LLM). Contains only validated booking data.
 */
export interface BookingExecutionRequest {
  sessionId: string;
  requestId: string;
  /** Deterministic key — duplicate confirmations never create duplicate executions. */
  idempotencyKey: string;
  reviewVersion: number;
  /** sessionVersion at confirmation; any later mutation invalidates the request. */
  sessionVersion: number;
  journey: { origin: string; destination: string; originName?: string; destinationName?: string };
  date: string;
  selectedTrain: ExecutionTrainRef;
  selectedClass: string;
  passengers: ExecutionPassenger[];
  confirmedAt: string;
  /** Set only by the backend confirmation guard (AWAITING_CONFIRMATION + explicit reply). */
  explicitConfirmation: true;
}

export interface BookingExecutionResult {
  status: BookingExecutionStatus;
  reason: string;
  executorName: string;
  idempotencyKey: string;
  completedAt: string;
  /**
   * Provider booking reference. Only a REAL, explicitly enabled executor could
   * ever populate this; the gateway NEVER creates one and strips it from any
   * non-production executor. Always undefined in this milestone.
   */
  bookingReference?: undefined;
}

export type HandoffStatus = 'READY' | 'INVALIDATED' | 'CONSUMED' | 'EXPIRED';

export interface AvailabilitySnapshot { status: string; available: boolean; retrievedAt: string; dataSource?: string }
export interface FareSnapshot { perPassenger?: number; total: number; currency: string; passengersCount: number; retrievedAt: string; dataSource?: string }

/** Immutable, deterministic handoff snapshot (deep-frozen once created). */
export interface BookingHandoffSnapshot {
  handoffId: string;
  sessionId: string;
  requestId: string;
  idempotencyKey: string;
  reviewVersion: number;
  sessionVersion: number;
  journey: { origin: string; destination: string; originName?: string; destinationName?: string };
  date: string;
  selectedTrain: ExecutionTrainRef;
  selectedClass: string;
  validatedPassengers: ExecutionPassenger[];
  availabilitySnapshot: AvailabilitySnapshot;
  fareSnapshot: FareSnapshot;
  confirmationTimestamp: string;
  createdAt: string;
  expiresAt: string;
  /** reviewFingerprint() at creation — any booking-critical change invalidates the handoff. */
  fingerprint: string;
  realBooking: false;
}

/** Session record: immutable snapshot + mutable status. */
export interface BookingHandoffRecord {
  snapshot: Readonly<BookingHandoffSnapshot>;
  status: HandoffStatus;
  statusReason?: string;
  statusChangedAt: string;
}

export type BookingLifecycleStatus =
  | 'PREPARING'
  | 'READY_FOR_CONFIRMATION'
  | 'CONFIRMED_BY_USER'
  | 'HANDOFF_CREATED'
  | 'EXECUTION_DISABLED'
  | 'EXECUTION_STARTED'
  | 'EXECUTION_SUCCESS'
  | 'EXECUTION_FAILED'
  | 'INVALIDATED';

export interface BookingLifecycleRecord {
  status: BookingLifecycleStatus;
  history: Array<{ from: BookingLifecycleStatus | null; to: BookingLifecycleStatus; at: string; reason?: string }>;
}

export interface ExecutionCapability {
  /** REAL_BOOKING_ENABLED parsed fail-closed (true only for the exact string "true"). */
  realBookingEnabled: boolean;
  /** Executor configured via BOOKING_EXECUTOR (default "disabled"). */
  configuredExecutor: string;
  /** Executor the gateway will actually use. */
  effectiveExecutor: string;
  /** Why execution is (not) possible — e.g. REAL_BOOKING_DISABLED, UNKNOWN_BOOKING_EXECUTOR. */
  reason: string;
  /** Always false in this milestone. */
  executionPossible: false;
  configErrors: string[];
}

/** Session-side record of the last execution attempt (no PII). */
export interface ExecutionAttemptRecord {
  status: BookingExecutionStatus;
  reason: string;
  executorName: string;
  idempotencyKey: string;
  handoffId?: string;
  at: string;
}

/** Structured, PII-free execution log line (observability). */
export interface ExecutionLogRecord {
  sessionId: string;
  requestId: string;
  reviewVersion?: number;
  sessionVersion?: number;
  handoffId?: string;
  handoffStatus?: HandoffStatus;
  executionCapability: string;
  executorName?: string;
  executionStatus?: BookingExecutionStatus;
  idempotencyKey?: string;
  duplicate?: boolean;
  latencyMs: number;
  rejectionReason?: BookingExecutionErrorCode;
  at: string;
}
