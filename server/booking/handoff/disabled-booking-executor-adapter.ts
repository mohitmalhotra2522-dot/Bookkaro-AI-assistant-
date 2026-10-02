/**
 * DisabledBookingExecutorAdapter — NON-PRODUCTION, NON-EXECUTING.
 * capability() → { enabled: false, executorName: 'disabled', supportsRealBooking: false }.
 * consumeHandoff() never calls execute() on a disabled adapter; execute() is still
 * defensive and only ever returns DISABLED. No I/O, no IRCTC, no PNR, no SUCCESS.
 */
import type { BookingExecutionResult } from '@shared/booking-execution';
import type { BookingExecutorCapability, BookingHandoffSession } from '@shared/booking-handoff-session';
import type { BookingExecutorAdapter } from './booking-executor-adapter';

export const DISABLED_ADAPTER_NAME = 'disabled';

export class DisabledBookingExecutorAdapter implements BookingExecutorAdapter {
  readonly name = DISABLED_ADAPTER_NAME;
  readonly kind = 'DISABLED' as const;

  capability(): BookingExecutorCapability {
    return { enabled: false, executorName: this.name, supportsRealBooking: false, reason: 'REAL_BOOKING_DISABLED' };
  }

  async execute(hs: Readonly<BookingHandoffSession>): Promise<BookingExecutionResult> {
    return { status: 'DISABLED', reason: 'BOOKING_EXECUTION_DISABLED', executorName: this.name, idempotencyKey: hs.idempotencyKey, completedAt: new Date().toISOString() };
  }
}
