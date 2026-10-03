/**
 * Booking lifecycle ACTIONS (Prompt 15) — cancellation, modification, refund status.
 *
 *   LLM (identifies intent only) → BookingActionValidator → BookingReferenceResolver →
 *   BookingLifecycleActionService → provider capability check → provider action →
 *   normalized result → BookingRecord / BookingHistoryStore → BookingSession → response
 *
 * The LLM can never execute any of these: there is NO lifecycle tool. Every action name
 * coming from an LLM is parsed against the closed enum below (anything else →
 * UNSUPPORTED_ACTION), and the backend acts only on the user's own explicit words.
 *
 * Status concepts are deliberately SEPARATE (never collapsed into one field):
 *   BookingStatus (P14 read model) · CancellationStatus · ModificationStatus · RefundStatus
 * Only provider evidence can establish CANCELLED / MODIFIED / a refund status.
 * Nothing here carries credentials, OTP, CAPTCHA, payment data or raw provider payloads.
 */

// ---------------------------------------------------------------------------
// 1. Controlled action enum
// ---------------------------------------------------------------------------

export const BOOKING_LIFECYCLE_ACTIONS = [
  'REQUEST_CANCELLATION',
  'CHECK_CANCELLATION_ELIGIBILITY',
  'REQUEST_MODIFICATION',
  'CHECK_MODIFICATION_ELIGIBILITY',
  'REQUEST_JOURNEY_CHANGE',
  'REQUEST_CLASS_CHANGE',
  'REQUEST_PASSENGER_CHANGE',
  'CHECK_REFUND_STATUS',
  'NO_ACTION'
] as const;
export type BookingLifecycleAction = typeof BOOKING_LIFECYCLE_ACTIONS[number];
export type ParsedLifecycleAction = BookingLifecycleAction | 'UNSUPPORTED_ACTION';

/** Untrusted (LLM) action label → closed enum. Absent → NO_ACTION; anything unknown → UNSUPPORTED_ACTION. */
export function parseLifecycleAction(raw: unknown): ParsedLifecycleAction {
  if (raw === undefined || raw === null || raw === '') return 'NO_ACTION';
  return typeof raw === 'string' && (BOOKING_LIFECYCLE_ACTIONS as readonly string[]).includes(raw) ? raw as BookingLifecycleAction : 'UNSUPPORTED_ACTION';
}

/** Actions that mutate a booking at the provider → explicit confirmation + idempotency key required. */
export const DESTRUCTIVE_LIFECYCLE_ACTIONS: ReadonlySet<BookingLifecycleAction> = new Set([
  'REQUEST_CANCELLATION', 'REQUEST_JOURNEY_CHANGE', 'REQUEST_CLASS_CHANGE', 'REQUEST_PASSENGER_CHANGE'
]);

export type ModificationChangeType = 'JOURNEY' | 'CLASS' | 'PASSENGER';
export const CHANGE_TYPE_FOR_ACTION: Readonly<Partial<Record<BookingLifecycleAction, ModificationChangeType>>> = {
  REQUEST_JOURNEY_CHANGE: 'JOURNEY', REQUEST_CLASS_CHANGE: 'CLASS', REQUEST_PASSENGER_CHANGE: 'PASSENGER'
};

// ---------------------------------------------------------------------------
// 2. Provider action capabilities (only what the provider ACTUALLY implements)
// ---------------------------------------------------------------------------

export const PROVIDER_ACTION_CAPABILITIES = [
  'BOOK',
  'GET_BOOKING_STATUS',
  'CANCEL_BOOKING',
  'CHECK_CANCELLATION_ELIGIBILITY',
  'GET_CANCELLATION_STATUS',
  'MODIFY_BOOKING',
  'CHANGE_JOURNEY',
  'CHANGE_CLASS',
  'CHANGE_PASSENGER',
  'CHECK_MODIFICATION_ELIGIBILITY',
  'GET_MODIFICATION_STATUS',
  'GET_REFUND_STATUS'
] as const;
export type ProviderActionCapability = typeof PROVIDER_ACTION_CAPABILITIES[number];
export type ProviderActionCapabilities = Readonly<Record<ProviderActionCapability, boolean>>;

export const NO_ACTION_CAPABILITIES: ProviderActionCapabilities = Object.freeze(
  Object.fromEntries(PROVIDER_ACTION_CAPABILITIES.map(c => [c, false])) as Record<ProviderActionCapability, boolean>
);

// ---------------------------------------------------------------------------
// 3. Provider action request / raw result contracts (validated before use)
// ---------------------------------------------------------------------------

/** Passenger fields that exist in the BookingProvider contract (ExecutionPassenger). Nothing else. */
export const PASSENGER_CHANGE_FIELDS = ['name', 'age', 'gender', 'berthPreference'] as const;
export type PassengerChangeField = typeof PASSENGER_CHANGE_FIELDS[number];

export interface RequestedChanges {
  journeyDate?: string;                 // YYYY-MM-DD — resolved by the backend DateResolver, never by the LLM
  travelClass?: string;
  passenger?: { op: 'CORRECT' | 'REMOVE' | 'ADD'; passengerNumber?: number; field?: PassengerChangeField; value?: string | number };
}

export interface ProviderCancellationRequest { bookingId: string; providerReference: string; idempotencyKey: string; actionId: string }
export interface ProviderModificationRequest {
  bookingId: string; providerReference: string; idempotencyKey: string; actionId: string; modificationId: string;
  changeType: ModificationChangeType; changes: RequestedChanges;
}
export interface ProviderEligibilityRequest { bookingId: string; providerReference: string; changeType?: ModificationChangeType | 'ANY'; changes?: RequestedChanges }

export interface ProviderCancellationResult { status: 'CANCELLED' | 'PENDING' | 'FAILED' | 'NOT_ELIGIBLE'; cancellationReference?: string; failureCode?: string }
export interface ProviderModificationResult { status: 'MODIFIED' | 'PENDING' | 'FAILED' | 'NOT_ELIGIBLE'; applied?: { journeyDate?: string; travelClass?: string }; failureCode?: string }
export interface ProviderActionStatusResult { status: 'CANCELLED' | 'MODIFIED' | 'PENDING' | 'FAILED' | 'UNKNOWN' | 'NOT_REQUESTED'; failureCode?: string }
export interface ProviderEligibilityResult { eligible: boolean; reasonCode?: string; fareDifference?: { amount: number; currency: string } }
export interface ProviderRefundStatusResult { status: 'NOT_INITIATED' | 'PENDING' | 'PROCESSED' | 'FAILED'; amount?: number; currency?: string; refundReference?: string }

// ---------------------------------------------------------------------------
// 4. Separate status concepts
// ---------------------------------------------------------------------------

export type CancellationStatus = 'NOT_REQUESTED' | 'PENDING' | 'CANCELLED' | 'FAILED' | 'UNKNOWN' | 'MANUAL_VERIFICATION_REQUIRED';
export type ModificationStatus = 'NOT_REQUESTED' | 'PENDING' | 'MODIFIED' | 'FAILED' | 'UNKNOWN' | 'MANUAL_VERIFICATION_REQUIRED';
export type RefundStatus = 'NOT_AVAILABLE' | 'NOT_INITIATED' | 'PENDING' | 'PROCESSED' | 'FAILED' | 'UNKNOWN';

/** Normalized cancellation outcome. CANCELLED exists ONLY with provider evidence. */
export type CancellationResultStatus = 'CANCELLED' | 'CANCELLATION_PENDING' | 'CANCELLATION_FAILED' | 'UNKNOWN' | 'NOT_ELIGIBLE' | 'UNSUPPORTED';
export interface CancellationResult {
  status: CancellationResultStatus;
  evidence: 'PROVIDER' | 'NONE';
  providerStatus: string | null;
  cancellationReference: string | null;
  failureCode: string | null;
}

/** Normalized modification outcome. MODIFIED exists ONLY with provider evidence. */
export type ModificationResultStatus = 'MODIFIED' | 'PENDING' | 'FAILED' | 'UNKNOWN' | 'NOT_ELIGIBLE' | 'UNSUPPORTED';
export interface ModificationResult {
  status: ModificationResultStatus;
  evidence: 'PROVIDER' | 'NONE';
  providerStatus: string | null;
  applied: { journeyDate?: string; travelClass?: string } | null;
  failureCode: string | null;
}

export interface RefundStatusResult {
  status: RefundStatus;
  evidence: 'PROVIDER' | 'NONE';
  amount: number | null;
  currency: string | null;
  refundReference: string | null;
}

// ---------------------------------------------------------------------------
// 5. Action lifecycle (uses the existing session state machine — session stays in its
//    post-booking state; the ACTION has its own lifecycle record)
// ---------------------------------------------------------------------------

export type LifecycleActionStatus =
  | 'ACTION_REQUESTED'
  | 'AWAITING_ACTION_CONFIRMATION'
  | 'ACTION_IN_PROGRESS'
  | 'ACTION_CONFIRMED'
  | 'ACTION_PENDING'
  | 'ACTION_FAILED'
  | 'ACTION_UNKNOWN'
  | 'MANUAL_VERIFICATION_REQUIRED'
  | 'ACTION_ABANDONED'
  | 'ACTION_EXPIRED';

export const ACTION_TRANSITIONS: Readonly<Record<LifecycleActionStatus, readonly LifecycleActionStatus[]>> = Object.freeze({
  ACTION_REQUESTED: ['AWAITING_ACTION_CONFIRMATION', 'ACTION_IN_PROGRESS', 'ACTION_ABANDONED'],
  AWAITING_ACTION_CONFIRMATION: ['ACTION_IN_PROGRESS', 'ACTION_ABANDONED', 'ACTION_EXPIRED'],
  ACTION_IN_PROGRESS: ['ACTION_CONFIRMED', 'ACTION_PENDING', 'ACTION_FAILED', 'ACTION_UNKNOWN', 'MANUAL_VERIFICATION_REQUIRED'],
  ACTION_PENDING: ['ACTION_CONFIRMED', 'ACTION_FAILED', 'ACTION_UNKNOWN', 'MANUAL_VERIFICATION_REQUIRED'],
  ACTION_UNKNOWN: ['ACTION_CONFIRMED', 'ACTION_PENDING', 'ACTION_FAILED', 'MANUAL_VERIFICATION_REQUIRED'],
  MANUAL_VERIFICATION_REQUIRED: ['ACTION_CONFIRMED', 'ACTION_PENDING', 'ACTION_FAILED'],
  ACTION_CONFIRMED: [], ACTION_FAILED: [], ACTION_ABANDONED: [], ACTION_EXPIRED: []
});
export const UNRESOLVED_ACTION_STATUSES: ReadonlySet<LifecycleActionStatus> = new Set(['ACTION_IN_PROGRESS', 'ACTION_PENDING', 'ACTION_UNKNOWN', 'MANUAL_VERIFICATION_REQUIRED']);

/** Pending provider-side modification. The historical BookingRecord is never mutated by it. */
export interface BookingModificationRequest {
  modificationId: string;
  bookingId: string;
  sessionId: string;
  changeType: ModificationChangeType;
  /** For PASSENGER changes the new value is kept ONLY here (sent to the provider), never logged. */
  requestedChanges: RequestedChanges;
  previous: { journeyDate: string; travelClass: string; passengersCount: number };
  fareDifference: { amount: number; currency: string; source: 'PROVIDER' } | null;
  requestedAt: string;
  status: 'AWAITING_CONFIRMATION' | ModificationStatus | 'ABANDONED';
  updatedAt: string;
}

export interface BookingLifecycleActionRecord {
  actionId: string;
  bookingId: string;
  sessionId: string;
  actionType: BookingLifecycleAction;
  requestedAt: string;
  confirmedAt: string | null;
  providerName: string;
  providerReference: string | null;
  status: LifecycleActionStatus;
  /** Normalized provider outcome (CancellationResultStatus / ModificationResultStatus / RefundStatus). */
  resultStatus: string | null;
  failureCode: string | null;
  completedAt: string | null;
  /** Destructive actions only: `${kind}:${bookingId}:${actionId}` — one provider request per action, ever. */
  idempotencyKey: string | null;
  modificationId: string | null;
  reconciliationAttempts: number;
  history: ReadonlyArray<{ at: string; status: LifecycleActionStatus; note?: string }>;
}

export type LifecycleActionErrorCode =
  | 'BOOKING_NOT_FOUND'
  | 'MULTIPLE_BOOKINGS_MATCHED'
  | 'ACTION_NOT_SUPPORTED'
  | 'ACTION_NOT_ALLOWED'
  | 'ACTION_REQUIRES_CONFIRMATION'
  | 'INVALID_BOOKING_STATE'
  | 'CANCELLATION_NOT_ELIGIBLE'
  | 'MODIFICATION_NOT_ELIGIBLE'
  | 'CANCELLATION_UNKNOWN'
  | 'MODIFICATION_UNKNOWN'
  | 'REFUND_STATUS_UNAVAILABLE'
  | 'UNSAFE_RETRY'
  | 'ACTION_ALREADY_COMPLETED'
  | 'ACTION_ALREADY_PENDING'
  | 'INVALID_ACTION_TRANSITION'
  | 'PROVIDER_ACTION_FAILED'
  | 'PROVIDER_ACTION_TIMEOUT'
  | 'PROVIDER_ACTION_UNAVAILABLE'
  | 'MANUAL_VERIFICATION_REQUIRED'
  | 'FARE_UNAVAILABLE';

/** Observability record (Part 31). No secrets, no PNR, no passenger values. */
export interface LifecycleActionLogRecord {
  at: string;
  sessionId: string;
  turnId: string | null;
  bookingId: string | null;
  actionId: string | null;
  actionType: ParsedLifecycleAction;
  provider: string | null;
  previousStatus: string | null;
  newStatus: string | null;
  capability: ProviderActionCapability | null;
  validationResult: 'OK' | 'REJECTED';
  confirmationRequired: boolean;
  confirmationReceived: boolean;
  providerResult: string | null;
  latencyMs: number | null;
  rejectionReason: LifecycleActionErrorCode | null;
}

/** Session-visible action view (BookingSession) — no provider payloads. */
export interface BookingActionView {
  actionId: string;
  bookingId: string;
  actionType: BookingLifecycleAction;
  status: LifecycleActionStatus;
  resultStatus: string | null;
}
