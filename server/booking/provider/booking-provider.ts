/**
 * BookingProvider — the ONLY interface through which a booking provider may be reached.
 *
 * Reached exclusively via BookingExecutionGateway → BookingProviderExecutionService →
 * BookingProviderRegistry. It is NOT an LLM tool: the LLM can never call executeBooking().
 *
 * A future real adapter (official / partner API) implements this interface and is
 * registered in the BookingProviderRegistry. Its credentials (if its contract needs
 * any) stay inside the adapter's server-side configuration — never in requests,
 * results, the BookingSession, logs, the LLM or the frontend.
 *
 * Only DisabledBookingProvider exists in this project. No real booking API is assumed.
 */
import type { BookingProviderCapabilities, BookingProviderRequest, BookingProviderResult, BookingStatusResult, ProviderHealth, ProviderFailureCode } from '@shared/booking-provider';
import type {
  ProviderCancellationRequest, ProviderCancellationResult, ProviderModificationRequest, ProviderModificationResult,
  ProviderEligibilityRequest, ProviderEligibilityResult, ProviderActionStatusResult, ProviderRefundStatusResult
} from '@shared/booking-lifecycle-action';

export type BookingProviderKind = 'DISABLED' | 'TEST' | 'REAL';

export interface ProviderCallOptions {
  /** Aborted when the gateway timeout elapses — adapters must stop work. */
  signal: AbortSignal;
  timeoutMs: number;
}

export interface BookingProvider {
  readonly name: string;
  readonly kind: BookingProviderKind;
  getCapabilities(): BookingProviderCapabilities;
  executeBooking(request: Readonly<BookingProviderRequest>, options: ProviderCallOptions): Promise<BookingProviderResult>;
  /** Only if the provider has an AUTHORITATIVE status lookup. */
  getBookingStatus?(reference: string, options: ProviderCallOptions): Promise<BookingStatusResult>;
  /** Only if the provider has a REAL health check. Never faked. */
  checkHealth?(options: ProviderCallOptions): Promise<ProviderHealth>;

  // ---- Prompt 15: lifecycle ACTIONS — each OPTIONAL; implemented only if the provider really
  // supports it (capability = declared flag in getCapabilities().actions AND method present).
  // Reached ONLY via BookingLifecycleActionService after BookingActionValidator — never an LLM tool.
  cancelBooking?(request: Readonly<ProviderCancellationRequest>, options: ProviderCallOptions): Promise<ProviderCancellationResult>;
  checkCancellationEligibility?(request: Readonly<ProviderEligibilityRequest>, options: ProviderCallOptions): Promise<ProviderEligibilityResult>;
  getCancellationStatus?(request: Readonly<{ bookingId: string; providerReference: string; idempotencyKey: string }>, options: ProviderCallOptions): Promise<ProviderActionStatusResult>;
  modifyBooking?(request: Readonly<ProviderModificationRequest>, options: ProviderCallOptions): Promise<ProviderModificationResult>;
  checkModificationEligibility?(request: Readonly<ProviderEligibilityRequest>, options: ProviderCallOptions): Promise<ProviderEligibilityResult>;
  getModificationStatus?(request: Readonly<{ bookingId: string; providerReference: string; idempotencyKey: string; modificationId: string }>, options: ProviderCallOptions): Promise<ProviderActionStatusResult>;
  getRefundStatus?(request: Readonly<{ bookingId: string; providerReference: string }>, options: ProviderCallOptions): Promise<ProviderRefundStatusResult>;
}

/**
 * Typed error an adapter may throw. `httpStatus` lets an HTTP-based adapter report the
 * transport status; `kind` the failure category. The message is NEVER shown to users
 * or persisted (it may contain provider internals).
 */
export class BookingProviderError extends Error {
  constructor(readonly kind: ProviderFailureCode | 'NETWORK_NOT_SENT', readonly httpStatus?: number, message = 'provider error') {
    super(message);
    this.name = 'BookingProviderError';
  }
}

export class ProviderTimeoutError extends Error {
  constructor() { super('provider timeout'); this.name = 'ProviderTimeoutError'; }
}
