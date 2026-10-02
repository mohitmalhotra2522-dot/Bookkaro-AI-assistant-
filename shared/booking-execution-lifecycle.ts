/**
 * Booking execution LIFECYCLE (Prompt 13) — shared, normalized.
 *
 * Named BookingExecutionLifecycleStatus because `BookingExecutionStatus` already exists
 * (Prompt 10: result statuses of the disabled BookingExecutor — DISABLED / SUCCESS / …).
 * Re-using that name for a different set of values would create contradictory states.
 *
 *   NOT_STARTED → REQUESTED → IN_PROGRESS → CONFIRMED | FAILED | UNKNOWN | REQUIRES_EXTERNAL_HANDOFF
 *   UNKNOWN → (reconciliation) → CONFIRMED | FAILED | CANCELLED | IN_PROGRESS | MANUAL_VERIFICATION_REQUIRED
 *
 * UNKNOWN is NOT FAILED: a timeout / lost connection does not prove the booking failed.
 * CONFIRMED / FAILED / CANCELLED are only ever set from an authoritative provider result.
 */
export enum BookingExecutionLifecycleStatus {
  NOT_STARTED = 'NOT_STARTED',
  REQUESTED = 'REQUESTED',
  IN_PROGRESS = 'IN_PROGRESS',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
  CANCELLED = 'CANCELLED',
  REQUIRES_EXTERNAL_HANDOFF = 'REQUIRES_EXTERNAL_HANDOFF',
  MANUAL_VERIFICATION_REQUIRED = 'MANUAL_VERIFICATION_REQUIRED'
}

const L = BookingExecutionLifecycleStatus;

/**
 * Allowed lifecycle transitions. Anything else → INVALID_EXECUTION_TRANSITION.
 * Additions beyond the base spec (all provider-result driven, documented):
 *  - NOT_STARTED is also the honest final status when no provider could be invoked.
 *  - IN_PROGRESS → REQUIRES_EXTERNAL_HANDOFF (provider answered REQUIRES_EXTERNAL_HANDOFF).
 *  - IN_PROGRESS / UNKNOWN → CANCELLED only if the PROVIDER reports CANCELLED.
 *  - UNKNOWN → IN_PROGRESS when reconciliation says the provider is still processing.
 *  - MANUAL_VERIFICATION_REQUIRED → CONFIRMED / FAILED / CANCELLED / IN_PROGRESS only through an
 *    EXPLICIT, user-requested status verification (never automatic).
 * Never allowed: CONFIRMED → anything, FAILED → CONFIRMED, CANCELLED → anything, any → NOT_STARTED.
 */
export const EXECUTION_STATUS_TRANSITIONS: Readonly<Record<BookingExecutionLifecycleStatus, readonly BookingExecutionLifecycleStatus[]>> = Object.freeze({
  [L.NOT_STARTED]: [L.REQUESTED],
  [L.REQUESTED]: [L.IN_PROGRESS, L.FAILED, L.REQUIRES_EXTERNAL_HANDOFF],
  [L.IN_PROGRESS]: [L.CONFIRMED, L.FAILED, L.UNKNOWN, L.REQUIRES_EXTERNAL_HANDOFF, L.CANCELLED],
  [L.UNKNOWN]: [L.CONFIRMED, L.FAILED, L.CANCELLED, L.IN_PROGRESS, L.MANUAL_VERIFICATION_REQUIRED],
  [L.MANUAL_VERIFICATION_REQUIRED]: [L.CONFIRMED, L.FAILED, L.CANCELLED, L.IN_PROGRESS],
  [L.CONFIRMED]: [],
  [L.FAILED]: [],
  [L.CANCELLED]: [],
  [L.REQUIRES_EXTERNAL_HANDOFF]: []
});

export function canTransitionExecution(from: BookingExecutionLifecycleStatus, to: BookingExecutionLifecycleStatus): boolean {
  return (EXECUTION_STATUS_TRANSITIONS[from] || []).includes(to);
}

/** Outcome cannot be established yet → reconciliation required, NEVER a new submission. */
export const UNRESOLVED_EXECUTION: ReadonlySet<BookingExecutionLifecycleStatus> = new Set([L.REQUESTED, L.IN_PROGRESS, L.UNKNOWN, L.MANUAL_VERIFICATION_REQUIRED]);
/** Authoritative terminal outcomes from the provider. */
export const TERMINAL_EXECUTION: ReadonlySet<BookingExecutionLifecycleStatus> = new Set([L.CONFIRMED, L.FAILED, L.CANCELLED, L.REQUIRES_EXTERNAL_HANDOFF]);

export type BookingExecutionEventType =
  | 'BOOKING_EXECUTION_REQUESTED'
  | 'BOOKING_EXECUTION_STARTED'
  | 'BOOKING_PROVIDER_ACCEPTED'
  | 'BOOKING_PROVIDER_CONFIRMED'
  | 'BOOKING_PROVIDER_FAILED'
  | 'BOOKING_PROVIDER_TIMEOUT'
  | 'BOOKING_PROVIDER_UNAVAILABLE'
  | 'BOOKING_STATUS_CHECK_REQUESTED'
  | 'BOOKING_STATUS_RECONCILED'
  | 'BOOKING_EXECUTION_UNKNOWN'
  | 'BOOKING_MANUAL_VERIFICATION_REQUIRED'
  | 'BOOKING_REQUIRES_EXTERNAL_HANDOFF';

/** Append-only audit entry. Safe data only (status, failure category, attempt, latency) — never credentials or raw responses. */
export interface BookingExecutionEvent {
  eventId: string;
  executionId: string;
  type: BookingExecutionEventType;
  previousStatus: BookingExecutionLifecycleStatus;
  newStatus: BookingExecutionLifecycleStatus;
  at: string;
  data?: Readonly<Record<string, string | number | boolean | null>>;
}

/** Lifecycle errors / outcome codes (Prompt 13). */
export type BookingLifecycleErrorCode =
  | 'EXECUTION_ALREADY_ACTIVE'
  | 'EXECUTION_ALREADY_CONFIRMED'
  | 'EXECUTION_ALREADY_FAILED'
  | 'EXECUTION_UNKNOWN'
  | 'RECONCILIATION_UNAVAILABLE'
  | 'RECONCILIATION_FAILED'
  | 'RECONCILIATION_TIMEOUT'
  | 'MANUAL_VERIFICATION_REQUIRED'
  | 'UNSAFE_RETRY'
  | 'PROVIDER_STATUS_UNKNOWN'
  | 'INVALID_EXECUTION_TRANSITION'
  | 'EXECUTION_LOCKED';

/** PII-free observability line per lifecycle event. */
export interface BookingLifecycleLogRecord {
  at: string;
  sessionId: string;
  requestId: string;
  handoffId: string;
  executionId: string;
  providerName: string;
  previousStatus: BookingExecutionLifecycleStatus;
  newStatus: BookingExecutionLifecycleStatus;
  event: BookingExecutionEventType;
  latencyMs: number;
  failureCode: string | null;
  reconciliationAttempt: number | null;
}

/** Safe, client-facing execution history entry (no credentials, no raw provider data). */
export interface BookingExecutionHistoryEntry {
  executionId: string;
  handoffId: string;
  providerName: string;
  status: BookingExecutionLifecycleStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  lastCheckedAt: string | null;
  providerReference: string | null;
  /** Only when the provider authoritatively CONFIRMED and returned one. */
  pnr: string | null;
  failureCode: string | null;
  failureReason: string | null;
  attemptCount: number;
  reconciliation: { status: 'NOT_REQUIRED' | 'PENDING' | 'RESOLVED' | 'MANUAL_VERIFICATION_REQUIRED'; attempts: number; lastCheckedAt: string | null };
  events: Array<{ type: BookingExecutionEventType; previousStatus: string; newStatus: string; at: string }>;
}
