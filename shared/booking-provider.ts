/**
 * Booking provider boundary — shared, normalized types (Prompt 12).
 *
 *   BookingExecutionGateway → BookingProviderRegistry → BookingProvider → normalized result → BookingSession
 *
 * These are the ONLY shapes that cross the provider boundary into the application.
 * No real booking provider / API exists in this project: the production registry
 * contains only the DisabledBookingProvider. Nothing here carries credentials —
 * a future provider's authentication would be configured server-side and never
 * enter these objects, the BookingSession, the LLM or the frontend.
 */
import type { AvailabilitySnapshot, ExecutionPassenger, ExecutionTrainRef, FareSnapshot } from './booking-execution';

export type ProviderHealth = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

/** What a provider honestly supports. Missing / malformed → fail closed. */
export interface BookingProviderCapabilities {
  providerName: string;
  /** Provider can be used right now (configured, reachable). UNKNOWN health is never "available". */
  available: boolean;
  supportsBooking: boolean;
  supportsStatus: boolean;
  supportsCancellation: boolean;
  requiresExternalHandoff: boolean;
  /** Provider de-duplicates on the idempotency key. Never assumed. */
  supportsIdempotency: boolean;
  /** Static health as known WITHOUT a live check. Only a real health check may say AVAILABLE. */
  health: ProviderHealth;
  reason?: string;
}

/** Built ONLY from the BookingHandoff / BookingHandoffSession snapshot + authoritative backend state. */
export interface BookingProviderRequest {
  requestId: string;
  handoffId: string;
  /** Present ONLY if the provider declares supportsIdempotency (never pretend otherwise). */
  idempotencyKey?: string;
  journey: { origin: string; destination: string };
  date: string;
  train: ExecutionTrainRef;
  travelClass: string;
  passengers: ExecutionPassenger[];
  availabilitySnapshot: AvailabilitySnapshot;
  fareSnapshot: FareSnapshot;
}

export type BookingProviderResultStatus = 'ACCEPTED' | 'IN_PROGRESS' | 'CONFIRMED' | 'FAILED' | 'REQUIRES_EXTERNAL_HANDOFF' | 'UNAVAILABLE';
export const BOOKING_PROVIDER_RESULT_STATUSES: readonly BookingProviderResultStatus[] = ['ACCEPTED', 'IN_PROGRESS', 'CONFIRMED', 'FAILED', 'REQUIRES_EXTERNAL_HANDOFF', 'UNAVAILABLE'];

/** Normalized provider result. `pnr` only ever comes from the provider (schema-validated) — never generated locally. */
export interface BookingProviderResult {
  status: BookingProviderResultStatus;
  providerReference?: string;
  pnr?: string;
  message?: string;
  failureCode?: string;
}

export type BookingStatusResultStatus = 'PENDING' | 'IN_PROGRESS' | 'CONFIRMED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
export const BOOKING_STATUS_RESULT_STATUSES: readonly BookingStatusResultStatus[] = ['PENDING', 'IN_PROGRESS', 'CONFIRMED', 'FAILED', 'CANCELLED', 'UNKNOWN'];

export interface BookingStatusResult {
  status: BookingStatusResultStatus;
  providerReference?: string;
  pnr?: string;
  failureCode?: string;
}

/** Normalized provider failure categories (raw provider errors never leave the adapter boundary). */
export type ProviderFailureCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_VALIDATION_FAILED'
  | 'PROVIDER_REJECTED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNKNOWN_ERROR';

export type BookingProviderErrorCode =
  | 'BOOKING_PROVIDER_UNAVAILABLE'
  | 'BOOKING_PROVIDER_DISABLED'
  | 'BOOKING_PROVIDER_UNKNOWN'
  | 'BOOKING_PROVIDER_TIMEOUT'
  | 'BOOKING_PROVIDER_REJECTED'
  | 'BOOKING_PROVIDER_AUTH_FAILED'
  | 'BOOKING_PROVIDER_VALIDATION_FAILED'
  | 'BOOKING_STATUS_UNKNOWN'
  | 'BOOKING_RETRY_BLOCKED'
  | 'BOOKING_EXECUTION_LOCKED'
  | 'BOOKING_EXECUTION_DUPLICATE'
  | 'BOOKING_EXECUTION_FAILED'
  | 'BOOKING_REQUIRES_EXTERNAL_HANDOFF'
  | 'INVALID_PROVIDER_RESPONSE'
  | 'PNR_NOT_AVAILABLE'
  | 'BOOKING_EXECUTION_DISABLED';

/** Outcome codes of one execution request (errors above + authoritative provider outcomes). */
export type BookingExecutionOutcomeCode =
  | BookingProviderErrorCode
  | 'BOOKING_ACCEPTED'
  | 'BOOKING_IN_PROGRESS'
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_FAILED'
  | 'BOOKING_CANCELLED';

export type BookingExecutionRecordStatus =
  | 'DISABLED'                    // REAL_BOOKING_ENABLED off / provider "disabled" — nothing sent
  | 'UNAVAILABLE'                 // provider missing / unknown / unhealthy — nothing sent (or definitely not received)
  | 'REQUIRES_EXTERNAL_HANDOFF'   // provider cannot execute automatically
  | 'SUBMITTING'                  // request in flight (lock held)
  | 'ACCEPTED'
  | 'IN_PROGRESS'
  | 'CONFIRMED'                   // ONLY from an authoritative, schema-valid provider response
  | 'FAILED'                      // authoritative provider failure / definite rejection
  | 'CANCELLED'                   // ONLY if the provider reports it
  | 'UNKNOWN';                    // outcome uncertain (timeout / invalid response) → never auto-retried

/** Persisted, normalized execution record. Never contains provider secrets or raw responses. */
export interface BookingExecutionRecord {
  bookingExecutionId: string;
  sessionId: string;
  handoffId: string;
  handoffSessionId: string;
  requestId: string;
  providerName: string;
  status: BookingExecutionRecordStatus;
  code: BookingExecutionOutcomeCode;
  providerStatus?: BookingProviderResultStatus | BookingStatusResultStatus;
  providerReference?: string;
  /** Authoritative PNR from a schema-valid provider response — otherwise absent. */
  pnr?: string;
  failureCode?: string;
  /** A booking request may have reached the provider. */
  submitted: boolean;
  /** Automatic re-submission is forbidden (uncertain outcome / already submitted). */
  retryBlocked: boolean;
  createdAt: string;
  updatedAt: string;
}

/** PII-free observability line for one execution request. */
export interface BookingProviderLogRecord {
  at: string;
  sessionId: string;
  requestId: string;
  handoffId?: string;
  executionId?: string;
  providerName: string;
  providerStatus?: string;
  executionStatus?: BookingExecutionRecordStatus;
  code: BookingExecutionOutcomeCode | string;
  failureCode?: string;
  duplicate?: boolean;
  latencyMs: number;
}
