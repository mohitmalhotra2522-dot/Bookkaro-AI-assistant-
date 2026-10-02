/**
 * BookingExecutor — the ONLY abstraction through which a booking could ever be
 * executed. Future executors (official-API / partner / user-assisted handoff)
 * plug in here without changing the orchestrator, LLM runtime, RailwayProvider,
 * BookingSession, passenger collection, ReviewBuilder or confirmation logic.
 *
 * Executors are invoked exclusively by BookingExecutionGateway after it has
 * independently re-validated the confirmed booking. The LLM can never reach an
 * executor (there is no booking tool in the tool registry).
 */
import type { BookingExecutionRequest, BookingExecutionResult } from '@shared/booking-execution';

/**
 * DISABLED — non-production placeholder, never executes anything.
 * TEST     — test doubles (must be named TestBookingExecutor*); only allowed in a
 *            registry created with { allowTestExecutors: true } — never in production.
 * REAL     — a future, explicitly enabled production executor. Registration of
 *            REAL executors is refused in this milestone.
 */
export type BookingExecutorKind = 'DISABLED' | 'TEST' | 'REAL';

export interface BookingExecutor {
  readonly name: string;
  readonly kind: BookingExecutorKind;
  /** Health/capability probe. Must not perform network I/O in this milestone. */
  isAvailable(): boolean;
  execute(request: BookingExecutionRequest): Promise<BookingExecutionResult>;
}
