/**
 * DisabledBookingExecutor — NON-PRODUCTION, NON-EXECUTING placeholder.
 *
 * It always returns { status: 'DISABLED', reason: 'REAL_BOOKING_DISABLED' }.
 * It NEVER: contacts IRCTC or any API, opens a browser, submits a form,
 * requests OTP / CAPTCHA / payment, generates a PNR, ticket number,
 * confirmation number or booking reference, or returns SUCCESS.
 * It performs no I/O at all.
 */
import type { BookingExecutionRequest, BookingExecutionResult } from '@shared/booking-execution';
import type { BookingExecutor } from './booking-executor';

export const DISABLED_EXECUTOR_NAME = 'disabled';

export class DisabledBookingExecutor implements BookingExecutor {
  readonly name = DISABLED_EXECUTOR_NAME;
  readonly kind = 'DISABLED' as const;
  private calls = 0;

  isAvailable(): boolean { return true; }

  /** Number of (recorded, non-executing) invocations — observability only. */
  get invocationCount(): number { return this.calls; }

  async execute(request: BookingExecutionRequest): Promise<BookingExecutionResult> {
    this.calls++;
    return {
      status: 'DISABLED',
      reason: 'REAL_BOOKING_DISABLED',
      executorName: this.name,
      idempotencyKey: request.idempotencyKey,
      completedAt: new Date().toISOString()
    };
  }
}
