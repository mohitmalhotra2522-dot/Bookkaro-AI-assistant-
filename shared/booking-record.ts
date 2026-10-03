/**
 * Prompt 14 — Post-booking read model.
 *
 * A BookingRecord is a backend-owned, normalized view over the Prompt 13 execution lifecycle
 * (NOT a second booking state machine). It is created ONLY from an authoritative provider
 * execution / reconciliation result (a validated BookingExecutionRecord) — never from a user
 * "yes", LLM text, a tool request, UI text, or the mere sending of a booking request.
 *
 * It never contains credentials, OTP, CAPTCHA, payment data, passenger names or raw
 * provider payloads. The PNR comes ONLY from a schema-valid provider response.
 */
import type { CancellationStatus, ModificationStatus, RefundStatus } from './booking-lifecycle-action';

export const POST_BOOKING_STATUSES = ['CONFIRMED', 'PENDING', 'FAILED', 'UNKNOWN', 'CANCELLED', 'EXTERNAL_HANDOFF_REQUIRED'] as const;
export type PostBookingStatus = typeof POST_BOOKING_STATUSES[number];

export type PostBookingErrorCode =
  | 'BOOKING_NOT_FOUND'
  | 'BOOKING_HISTORY_UNAVAILABLE'
  | 'INVALID_BOOKING_REFERENCE'
  | 'MULTIPLE_BOOKINGS_MATCHED'
  | 'PNR_NOT_AVAILABLE'
  | 'INVALID_PNR'
  | 'PNR_STATUS_UNAVAILABLE'
  | 'PNR_PROVIDER_TIMEOUT'
  | 'PNR_PROVIDER_ERROR'
  | 'INVALID_BOOKING_RESULT'
  | 'INVALID_BOOKING_STATUS'
  | 'BOOKING_RECORD_CONFLICT'
  | 'BOOKING_RECORD_NOT_MUTABLE'
  | 'AUTHORITATIVE_DATA_REQUIRED'
  | 'BOOKING_CONTEXT_MISSING'
  | 'BOOKING_ACCESS_DENIED';

export type BookingStatusSource = 'PROVIDER_EXECUTION' | 'PROVIDER_RECONCILIATION' | 'PROVIDER_ACTION';

/** Prompt 15 — evidence for lifecycle-action updates (cancellation / modification / refund). */
export interface BookingActionEvidence {
  /** PROVIDER_ACTION = authoritative provider action / status result; ACTION_OUTCOME_UNCERTAIN = only UNKNOWN / MANUAL states. */
  source: 'PROVIDER_ACTION' | 'ACTION_OUTCOME_UNCERTAIN';
  actionId: string;
  providerStatus: string | null;
}

/** Post-modification CURRENT representation. The original booking fields stay untouched (history). */
export interface BookingCurrentRepresentation {
  journeyDate: string;
  travelClass: string;
  passengersCount: number;
  modificationId: string;
  updatedAt: string;
}
export interface BookingRefundSummary { amount: number | null; currency: string | null; checkedAt: string }

export interface BookingJourney { origin: string; destination: string; originName?: string; destinationName?: string }
export interface BookingTrain { trainNumber: string; trainName?: string; departure?: string; arrival?: string }
/** Counts only — passenger names / ages are never copied into the history read model. */
export interface BookingPassengersSummary { count: number }
export interface BookingFareSummary { total: number; perPassenger?: number; currency: string; passengersCount: number; dataSource?: string }

/** Mutable, non-authoritative audit metadata about LIVE lookups (never served as current data). */
export interface BookingLiveMeta {
  lastPnrCheckAt?: string;
  lastPnrCheckOk?: boolean;
  lastLiveStatusAt?: string;
}

export interface BookingRecord {
  // ---- immutable after creation ----
  bookingId: string;
  sessionId: string;
  executionId: string;
  handoffId: string;
  idempotencyKey: string;
  providerName: string;
  journey: BookingJourney;
  train: BookingTrain;
  passengersSummary: BookingPassengersSummary;
  travelClass: string;
  /** Fare verified before confirmation (original fare — immutable). */
  fareSummary: BookingFareSummary | null;
  journeyDate: string;
  bookingCreatedAt: string;
  // ---- set once (null → value), then immutable ----
  providerReference: string | null;
  pnr: string | null;
  confirmedAt: string | null;
  // ---- mutable with provider evidence ----
  bookingStatus: PostBookingStatus;
  statusSource: BookingStatusSource;
  failureCode: string | null;
  lastUpdatedAt: string;
  liveMeta: BookingLiveMeta;
  // ---- Prompt 15: SEPARATE lifecycle statuses (each changes only with provider action evidence) ----
  cancellationStatus: CancellationStatus;
  modificationStatus: ModificationStatus;
  refundStatus: RefundStatus;
  refundSummary: BookingRefundSummary | null;
  /** null until a provider CONFIRMS a modification; original fields above are never rewritten. */
  current: BookingCurrentRepresentation | null;
}

/** Output of BookingResultNormalizer — validated, provider-derived fields only. */
export interface NormalizedBookingResult {
  executionId: string;
  sessionId: string;
  handoffId: string;
  idempotencyKey: string;
  providerName: string;
  bookingStatus: PostBookingStatus;
  statusSource: BookingStatusSource;
  providerReference: string | null;
  pnr: string | null;
  failureCode: string | null;
  journey: BookingJourney;
  train: BookingTrain;
  passengersSummary: BookingPassengersSummary;
  travelClass: string;
  fareSummary: BookingFareSummary | null;
  journeyDate: string;
  /** Provider status that justified bookingStatus (CONFIRMED requires 'CONFIRMED'). */
  providerStatus: string | null;
  at: string;
}

/** Provider evidence required for every status / PNR / reference update. */
export interface BookingProviderEvidence {
  source: BookingStatusSource;
  executionId: string;
  providerStatus: string | null;
}

/** Frontend / conversation DTO — no secrets, no raw provider payloads, no passenger names. */
export interface BookingDetailsResponse {
  bookingId: string;
  status: PostBookingStatus;
  statusLabel: string;
  providerName: string;
  /** Full PNR only when the requested operation needs it; otherwise masked. null = PNR_NOT_AVAILABLE. */
  pnr: string | null;
  pnrMasked: string | null;
  pnrAvailable: boolean;
  journey: BookingJourney;
  train: BookingTrain;
  travelClass: string;
  passengersCount: number;
  fare: { total: number; perPassenger?: number; currency: string } | null;
  journeyDate: string;
  bookingCreatedAt: string;
  lastUpdatedAt: string;
  failureCode: string | null;
  /** Prompt 15 — separate lifecycle statuses + post-modification current view (original kept above). */
  cancellationStatus?: CancellationStatus;
  modificationStatus?: ModificationStatus;
  refundStatus?: RefundStatus;
  current?: BookingCurrentRepresentation | null;
  source: 'BACKEND_BOOKING_RECORD';
}

export type PostBookingEventType =
  | 'BOOKING_RECORD_CREATED'
  | 'BOOKING_CONFIRMED'
  | 'BOOKING_FAILED'
  | 'BOOKING_STATUS_UPDATED'
  | 'PNR_ATTACHED'
  | 'PNR_STATUS_CHECKED'
  | 'BOOKING_HISTORY_QUERIED'
  | 'BOOKING_LIVE_STATUS_REQUESTED';

export const STATUS_LABEL: Readonly<Record<PostBookingStatus, string>> = Object.freeze({
  CONFIRMED: 'Provider confirmed',
  PENDING: 'Pending (provider ne abhi confirm nahi kiya)',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown (result confirm nahi hua)',
  CANCELLED: 'Cancelled',
  EXTERNAL_HANDOFF_REQUIRED: 'IRCTC par khud complete karna hoga'
});
