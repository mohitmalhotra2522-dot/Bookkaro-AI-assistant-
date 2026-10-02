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
