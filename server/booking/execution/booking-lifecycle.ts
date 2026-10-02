/**
 * Booking lifecycle — deterministic, separate from the conversation state machine.
 *
 * Normal path (this milestone):
 *   PREPARING → READY_FOR_CONFIRMATION → CONFIRMED_BY_USER → HANDOFF_CREATED → EXECUTION_DISABLED
 * EXECUTION_STARTED / EXECUTION_SUCCESS are reserved for a future REAL executor and
 * are unreachable while execution is disabled (the gateway never trusts SUCCESS).
 */
import type { BookingSession } from '@shared/entities';
import type { BookingLifecycleStatus } from '@shared/booking-execution';

export const LIFECYCLE_TRANSITIONS: Readonly<Record<BookingLifecycleStatus, readonly BookingLifecycleStatus[]>> = Object.freeze({
  PREPARING: ['READY_FOR_CONFIRMATION', 'INVALIDATED'],
  READY_FOR_CONFIRMATION: ['CONFIRMED_BY_USER', 'PREPARING', 'INVALIDATED'],
  CONFIRMED_BY_USER: ['HANDOFF_CREATED', 'PREPARING', 'INVALIDATED'],
  HANDOFF_CREATED: ['EXECUTION_DISABLED', 'EXECUTION_STARTED', 'EXECUTION_FAILED', 'INVALIDATED'],
  EXECUTION_DISABLED: ['INVALIDATED'],
  EXECUTION_STARTED: ['EXECUTION_SUCCESS', 'EXECUTION_FAILED'],
  EXECUTION_SUCCESS: [],
  EXECUTION_FAILED: ['INVALIDATED', 'PREPARING'],
  INVALIDATED: ['PREPARING', 'READY_FOR_CONFIRMATION']
});

/** Only a REAL executor (none exists in this milestone) could ever enter these. */
export const REAL_EXECUTION_LIFECYCLE: ReadonlySet<BookingLifecycleStatus> = new Set(['EXECUTION_STARTED', 'EXECUTION_SUCCESS']);

export function canTransitionLifecycle(from: BookingLifecycleStatus | null, to: BookingLifecycleStatus): boolean {
  if (REAL_EXECUTION_LIFECYCLE.has(to)) return false;           // locked in this milestone
  if (from === null) return to === 'PREPARING' || to === 'READY_FOR_CONFIRMATION';
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Apply a lifecycle transition. Same-status is a no-op. Illegal transitions are rejected (returns false). */
export function transitionLifecycle(s: BookingSession, to: BookingLifecycleStatus, reason?: string, at = new Date().toISOString()): boolean {
  const from = s.bookingLifecycle?.status ?? null;
  if (from === to) return true;
  if (!canTransitionLifecycle(from, to)) return false;
  if (!s.bookingLifecycle) s.bookingLifecycle = { status: to, history: [] };
  s.bookingLifecycle.status = to;
  s.bookingLifecycle.history.push({ from, to, at, ...(reason ? { reason } : {}) });
  if (s.bookingLifecycle.history.length > 50) s.bookingLifecycle.history.splice(0, s.bookingLifecycle.history.length - 50);
  return true;
}
