/**
 * Booking execution history (Prompt 13) — SAFE abstraction for UI / API.
 * Status, timestamps, provider name, provider reference, authoritative PNR (CONFIRMED only),
 * failure reason and reconciliation status. No credentials, no raw provider data, no
 * passenger PII, no idempotency key.
 */
import type { BookingSession } from '@shared/entities';
import type { BookingExecutionRecord } from '@shared/booking-provider';
import { BookingExecutionLifecycleStatus as L, type BookingExecutionHistoryEntry } from '@shared/booking-execution-lifecycle';

const FAILURE_REASON: Record<string, string> = {
  PROVIDER_REJECTED: 'Provider ne booking reject ki',
  TEST_PROVIDER_REJECTED: 'Provider ne booking reject ki (test)',
  PROVIDER_CANCELLED: 'Provider ke hisaab se booking cancelled',
  PROVIDER_AUTH_FAILED: 'Provider authentication fail (request process nahi hui)',
  PROVIDER_VALIDATION_FAILED: 'Provider ne request invalid batayi (request process nahi hui)',
  PROVIDER_UNAVAILABLE: 'Provider available nahi tha',
  PROVIDER_RATE_LIMITED: 'Provider ne request abhi accept nahi ki',
  PROVIDER_TIMEOUT: 'Provider response time par nahi aaya — final status unknown',
  PROVIDER_UNKNOWN_ERROR: 'Connection/response problem — final status unknown',
  INVALID_PROVIDER_RESPONSE: 'Provider response valid nahi tha — final status unknown',
  PROVIDER_HEALTH_UNKNOWN: 'Provider health verify nahi hui (request nahi bheji gayi)'
};

export function historyEntry(r: BookingExecutionRecord): BookingExecutionHistoryEntry {
  const unresolved = r.status === L.UNKNOWN || r.status === L.IN_PROGRESS || r.status === L.REQUESTED;
  const reconciliationStatus = r.status === L.MANUAL_VERIFICATION_REQUIRED ? 'MANUAL_VERIFICATION_REQUIRED'
    : unresolved && r.submitted ? 'PENDING'
    : r.reconciliationAttempts > 0 ? 'RESOLVED' : 'NOT_REQUIRED';
  return {
    executionId: r.bookingExecutionId, handoffId: r.handoffId, providerName: r.providerName, status: r.status,
    createdAt: r.createdAt, startedAt: r.startedAt, completedAt: r.completedAt, lastCheckedAt: r.lastCheckedAt,
    providerReference: r.providerReference ?? null,
    pnr: r.status === L.CONFIRMED ? r.pnr ?? null : null,
    failureCode: r.failureCode ?? null,
    failureReason: r.failureCode ? FAILURE_REASON[r.failureCode] || 'Provider failure' : null,
    attemptCount: r.attemptCount,
    reconciliation: { status: reconciliationStatus, attempts: r.reconciliationAttempts, lastCheckedAt: r.lastCheckedAt },
    events: r.events.map(e => ({ type: e.type, previousStatus: e.previousStatus, newStatus: e.newStatus, at: e.at }))
  };
}

/** Newest first. */
export function bookingExecutionHistory(s: BookingSession): BookingExecutionHistoryEntry[] {
  const all = [...(s.bookingExecutionHistory || []), ...(s.bookingExecution ? [s.bookingExecution] : [])];
  return all.reverse().map(historyEntry);
}
