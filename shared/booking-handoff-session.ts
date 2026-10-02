/**
 * Secure booking handoff session — shared types (Prompt 11).
 *
 *   BookingExecutionGateway → BookingHandoff → BookingHandoffSession → BookingExecutorAdapter (DISABLED)
 *
 * All objects here are built by the BACKEND from the authoritative BookingSession,
 * validated railway results, validated passengers and the current review — never
 * from LLM output. None of them has (or may gain) credential fields: no IRCTC
 * username / password, OTP, CAPTCHA answer, card number, CVV, UPI PIN, bank
 * password, authorization token or session cookie. A future credential system
 * would be a separate, dedicated milestone.
 */
import type { BookingExecutionStatus, ExecutionPassenger, ExecutionTrainRef, AvailabilitySnapshot, FareSnapshot } from './booking-execution';

/** Immutable (deep-frozen) snapshot of exactly the validated booking data. */
export interface BookingSnapshot {
  snapshotId: string;
  sessionId: string;
  reviewVersion: number;
  journey: { origin: string; destination: string };
  date: string;
  selectedTrain: ExecutionTrainRef;
  selectedClass: string;
  passengers: ExecutionPassenger[];
  availabilitySnapshot: AvailabilitySnapshot;
  fareSnapshot: FareSnapshot;
  /** reviewFingerprint() of the session the snapshot was built from. */
  fingerprint: string;
  createdAt: string;
}

export type BookingConfirmationStatus = 'VALID' | 'INVALIDATED' | 'EXPIRED';

/** Deterministic confirmation record — created by the backend only after validating an explicit reply in AWAITING_CONFIRMATION. */
export interface BookingConfirmation {
  confirmationId: string;
  sessionId: string;
  requestId: string;
  reviewVersion: number;
  sessionVersion: number;
  /** Review fingerprint the user confirmed (ties the confirmation to the exact reviewed data). */
  reviewFingerprint: string;
  confirmedAt: string;
  status: BookingConfirmationStatus;
  statusReason?: string;
  statusChangedAt?: string;
}

/** Capability reported by the resolved executor adapter. Missing / malformed → fail closed. */
export interface BookingExecutorCapability {
  enabled: boolean;
  executorName: string;
  supportsRealBooking: boolean;
  /** Why execution is (not) possible — REAL_BOOKING_DISABLED, EXECUTOR_NOT_FOUND, … */
  reason?: string;
}

export type HandoffSessionStatus = 'CREATED' | 'READY' | 'CONSUMED' | 'EXPIRED' | 'INVALIDATED' | 'FAILED';

/** Short-lived execution handoff context. Snapshot + capability are frozen; only status fields change. */
export interface BookingHandoffSession {
  handoffSessionId: string;
  bookingHandoffId: string;
  sessionId: string;
  requestId: string;
  reviewVersion: number;
  /** BookingSession.sessionVersion right after the handoff was synced. Any later mutation → stale. */
  sessionVersion: number;
  confirmationId: string;
  /** Idempotency key for consumption — derived from the authoritative handoff context. */
  idempotencyKey: string;
  status: HandoffSessionStatus;
  statusReason?: string;
  statusChangedAt: string;
  createdAt: string;
  expiresAt: string;
  bookingSnapshot: Readonly<BookingSnapshot>;
  executorCapability: Readonly<BookingExecutorCapability>;
  /** Number of times an executor adapter was actually invoked (0 in this milestone). */
  executionAttempts: number;
  lastConsumeResult?: { code: HandoffErrorCode | 'OK'; status?: BookingExecutionStatus; reason?: string; at: string };
}

export type HandoffErrorCode =
  | 'HANDOFF_NOT_FOUND'
  | 'HANDOFF_SESSION_EXPIRED'
  | 'HANDOFF_INVALIDATED'
  | 'HANDOFF_ALREADY_CONSUMED'
  | 'INVALID_BOOKING_SNAPSHOT'
  | 'INVALID_CONFIRMATION'
  | 'CONFIRMATION_VERSION_MISMATCH'
  | 'SESSION_VERSION_CONFLICT'
  | 'EXECUTOR_DISABLED'
  | 'EXECUTOR_NOT_FOUND'
  | 'EXECUTOR_UNAVAILABLE'
  | 'SENSITIVE_DATA_REJECTED'
  | 'STALE_AVAILABILITY'
  | 'STALE_FARE'
  | 'BOOKING_DATA_CHANGED'
  | 'BOOKING_EXECUTION_DISABLED';
