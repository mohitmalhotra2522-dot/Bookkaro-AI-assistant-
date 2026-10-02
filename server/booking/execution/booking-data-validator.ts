/**
 * Shared booking-data re-validation (Prompt 10, extracted in Prompt 11).
 * Used by BookingExecutionGateway (before a handoff is created) AND by
 * BookingHandoffValidator (before an executor adapter may receive a handoff session).
 * Never trusts earlier validation, the LLM or stale references.
 */
import type { BookingSession } from '@shared/entities';
import type { BookingExecutionRequest, BookingExecutionErrorCode } from '@shared/booking-execution';
import { MAX_PASSENGERS } from '@shared/constants';
import { currentResults } from '../../ai/context/train-reference-resolver';
import { trainClassCodes } from '../../ai/context/class-reference-resolver';
import { BookingReadinessEvaluator, defaultPolicy } from '../booking-readiness';
import { passengerValidator } from '../passenger-validator';

/** Execution policy is STRICTER than the review policy: availability AND fare must be FRESH. */
export const EXECUTION_READINESS = new BookingReadinessEvaluator({ ...defaultPolicy(), requireAvailability: true, requireFare: true });

const tn = (t: any): string | undefined => (t ? String(t.number || t.trainNumber) : undefined);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Independent re-validation of all booking-critical data against the AUTHORITATIVE session. Returns the first failure. */
export function validateBookingData(
s: BookingSession,
req: Pick<BookingExecutionRequest, 'journey' | 'date' | 'selectedTrain' | 'selectedClass' | 'passengers'>,
now: number,
executionReadiness: BookingReadinessEvaluator = EXECUTION_READINESS
): { code: BookingExecutionErrorCode; detail: string } | null {
  // Journey
  if (!s.origin || !s.destination || s.origin === s.destination) return { code: 'BOOKING_NOT_READY', detail: 'invalid journey' };
  if (req.journey?.origin !== s.origin || req.journey?.destination !== s.destination) return { code: 'BOOKING_NOT_READY', detail: 'journey mismatch' };
  if (!s.date || !ISO_DATE.test(s.date) || req.date !== s.date) return { code: 'BOOKING_NOT_READY', detail: 'invalid date' };
  if (s.date < new Date(now - 24 * 3600_000).toISOString().slice(0, 10)) return { code: 'BOOKING_NOT_READY', detail: 'date in the past' };

  // Train — against the CURRENT authoritative search results (never LLM / old refs)
  const t: any = s.selectedTrain;
  const rt = req.selectedTrain;
  const sr: any = s.searchResults;
  if (!t || !rt || !sr) return { code: 'INVALID_TRAIN', detail: 'no selected train / results' };
  if (rt.trainNumber !== tn(t)) return { code: 'INVALID_TRAIN', detail: 'train number mismatch' };
  if (!t.resultId || rt.resultId !== t.resultId) return { code: 'INVALID_TRAIN', detail: 'resultId mismatch' };
  if (!sr.resultId || t.searchResultId !== sr.resultId || !String(t.resultId).startsWith(`${sr.resultId}:`)) return { code: 'INVALID_TRAIN', detail: 'selection not from current results' };
  if (sr.journey?.origin !== s.origin || sr.journey?.destination !== s.destination || sr.journey?.date !== s.date) return { code: 'INVALID_TRAIN', detail: 'results belong to another journey' };
  if (t.date !== s.date || rt.date !== s.date) return { code: 'INVALID_TRAIN', detail: 'train date mismatch' };
  const row: any = currentResults(s).find((r: any) => r.resultId === t.resultId);
  if (!row || String(row.trainNumber || row.number) !== tn(t)) return { code: 'INVALID_TRAIN', detail: 'train not in current results' };
  if (row.origin !== t.origin || row.destination !== t.destination || rt.origin !== t.origin || rt.destination !== t.destination) return { code: 'INVALID_TRAIN', detail: 'train route mismatch' };

  // Class
  if (!s.selectedClass || req.selectedClass !== s.selectedClass || !trainClassCodes(row).includes(s.selectedClass)) return { code: 'INVALID_CLASS', detail: 'class not valid for train' };

  // Passengers — validator re-run, request must equal session
  const ps: any[] = s.passengers || [];
  const count = s.passengersCount || 0;
  if (count < 1 || count > MAX_PASSENGERS || ps.length !== count || req.passengers.length !== count) return { code: 'INVALID_PASSENGER_DETAILS', detail: 'passenger count mismatch' };
  for (let i = 0; i < ps.length; i++) {
    const vr = passengerValidator.validateRecord(ps[i]);
    if (!vr.complete || !vr.valid) return { code: 'INVALID_PASSENGER_DETAILS', detail: `passenger ${i + 1} invalid` };
    const q = req.passengers[i];
    if (!q || q.passengerId !== ps[i].id || q.name !== ps[i].name || q.age !== ps[i].age || q.gender !== ps[i].gender) return { code: 'INVALID_PASSENGER_DETAILS', detail: `passenger ${i + 1} mismatch` };
  }

  // Readiness + freshness (execution policy: availability AND fare must be FRESH)
  const r = executionReadiness.evaluate(s, now);
  if (r.blockers.includes('INVALID_TRAIN') || r.blockers.includes('MISSING_TRAIN')) return { code: 'INVALID_TRAIN', detail: 'readiness' };
  if (r.blockers.includes('INVALID_CLASS') || r.blockers.includes('MISSING_CLASS')) return { code: 'INVALID_CLASS', detail: 'readiness' };
  if (r.blockers.includes('INVALID_PASSENGER_DETAILS') || r.blockers.includes('MISSING_PASSENGER_DETAILS')) return { code: 'INVALID_PASSENGER_DETAILS', detail: 'readiness' };
  if (r.availability !== 'FRESH') return { code: 'STALE_AVAILABILITY', detail: `availability ${r.availability}` };
  if (r.fare !== 'FRESH') return { code: 'STALE_FARE', detail: `fare ${r.fare}` };
  if (r.blockers.length) return { code: 'BOOKING_NOT_READY', detail: r.blockers.join(',') };
  return null;
}
