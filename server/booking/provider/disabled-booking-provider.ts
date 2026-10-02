/**
 * DisabledBookingProvider — honest "no booking provider" adapter.
 * Claims nothing: not available, no booking, no status, no health (UNAVAILABLE —
 * never "healthy"). executeBooking() makes no I/O and only ever returns UNAVAILABLE.
 * The execution service never even calls it (capability check fails first).
 */
import type { BookingProviderCapabilities, BookingProviderResult } from '@shared/booking-provider';
import type { BookingProvider } from './booking-provider';

export const DISABLED_PROVIDER_NAME = 'disabled';

export class DisabledBookingProvider implements BookingProvider {
  readonly name = DISABLED_PROVIDER_NAME;
  readonly kind = 'DISABLED' as const;

  getCapabilities(): BookingProviderCapabilities {
    return {
      providerName: this.name, available: false, supportsBooking: false, supportsStatus: false, supportsCancellation: false,
      requiresExternalHandoff: false, supportsIdempotency: false, health: 'UNAVAILABLE', reason: 'BOOKING_PROVIDER_DISABLED'
    };
  }

  async executeBooking(): Promise<BookingProviderResult> {
    return { status: 'UNAVAILABLE', failureCode: 'PROVIDER_UNAVAILABLE' };
  }
}
