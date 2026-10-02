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
  // P12: a configured provider may run after the (disabled) P10 executor step
  EXECUTION_DISABLED: ['INVALIDATED', 'EXECUTION_STARTED'],
  EXECUTION_STARTED: ['EXECUTION_SUCCESS', 'EXECUTION_FAILED'],
  EXECUTION_SUCCESS: [],
  EXECUTION_FAILED: ['INVALIDATED', 'PREPARING'],
  INVALIDATED: ['PREPARING', 'READY_FOR_CONFIRMATION']
});

/**
 * Only the provider execution path (Prompt 12, { providerAuthorized: true }) may enter these,
 * and only after a provider was actually invoked. No real provider exists in this project.
 */
export const REAL_EXECUTION_LIFECYCLE: ReadonlySet<BookingLifecycleStatus> = new Set(['EXECUTION_STARTED', 'EXECUTION_SUCCESS']);

export function canTransitionLifecycle(from: BookingLifecycleStatus | null, to: BookingLifecycleStatus, opts: { providerAuthorized?: boolean } = {}): boolean {
  if (REAL_EXECUTION_LIFECYCLE.has(to) && !opts.providerAuthorized) return false;   // provider path only
  if (from === null) return to === 'PREPARING' || to === 'READY_FOR_CONFIRMATION';
  return LIFECYCLE_TRANSITIONS[from].includes(to);
}

/** Apply a lifecycle transition. Same-status is a no-op. Illegal transitions are rejected (returns false). */
export function transitionLifecycle(s: BookingSession, to: BookingLifecycleStatus, reason?: string, at = new Date().toISOString(), opts: { providerAuthorized?: boolean } = {}): boolean {
  const from = s.bookingLifecycle?.status ?? null;
  if (from === to) return true;
  if (!canTransitionLifecycle(from, to, opts)) return false;
  if (!s.bookingLifecycle) s.bookingLifecycle = { status: to, history: [] };
  s.bookingLifecycle.status = to;
  s.bookingLifecycle.history.push({ from, to, at, ...(reason ? { reason } : {}) });
  if (s.bookingLifecycle.history.length > 50) s.bookingLifecycle.history.splice(0, s.bookingLifecycle.history.length - 50);
  return true;
}
