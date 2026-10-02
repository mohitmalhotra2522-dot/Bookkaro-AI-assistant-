/**
 * BookingExecutorAdapter — the ONLY interface a future external booking executor
 * (official API / partner / user-assisted) may implement. It receives a validated,
 * READY BookingHandoffSession through consumeHandoff() — never raw LLM output,
 * never credentials.
 *
 * In this milestone only DisabledBookingExecutorAdapter exists. No IRCTC adapter.
 */
import type { BookingExecutionResult } from '@shared/booking-execution';
import type { BookingExecutorCapability, BookingHandoffSession } from '@shared/booking-handoff-session';

export type BookingExecutorAdapterKind = 'DISABLED' | 'TEST' | 'REAL';

export interface BookingExecutorAdapter {
  readonly name: string;
  readonly kind: BookingExecutorAdapterKind;
  capability(): BookingExecutorCapability;
  execute(handoffSession: Readonly<BookingHandoffSession>): Promise<BookingExecutionResult>;
}
