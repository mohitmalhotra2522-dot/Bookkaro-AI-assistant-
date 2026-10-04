/**
 * BookingReadinessEvaluator (Prompt 9) — the ONLY component that decides
 * whether a booking is ready. The LLM never decides readiness.
 *
 * Pure & deterministic: (BookingSession, policy, now) → BookingReadinessResult.
 *
 * Freshness: availability / fare are usable only when they
 *   (a) belong to the CURRENT train + class + date (+ passenger count & route for fare), and
 *   (b) are younger than FRESHNESS_POLICY limits (conversation memory is not a cache).
 */
import type { BookingSession, BookingBlocker } from '@shared/entities';
import { BookingState } from '@shared/states';
import { FRESHNESS_POLICY, DEFAULT_PREPARATION_POLICY, MAX_PASSENGERS } from '@shared/constants';
import { passengerValidator } from './passenger-validator';
import { reviewFingerprint } from './review-builder';
import { currentResults } from '../ai/context/train-reference-resolver';
import { trainClassCodes } from '../ai/context/class-reference-resolver';

export interface PreparationPolicy {
  requireAvailability: boolean;
  requireFare: boolean;
  availabilityMaxAgeMs: number;
  fareMaxAgeMs: number;
}

export const defaultPolicy = (): PreparationPolicy => ({
  ...DEFAULT_PREPARATION_POLICY,
  availabilityMaxAgeMs: FRESHNESS_POLICY.AVAILABILITY_MAX_AGE_MS,
  fareMaxAgeMs: FRESHNESS_POLICY.FARE_MAX_AGE_MS
});

export type NextRequiredField =
  | { field: 'origin' | 'destination' | 'date' | 'train' | 'class' | 'passengersCount' }
  | { field: 'name' | 'age' | 'gender'; passengerId: string; passengerIndex: number };

export type DataFreshness = 'FRESH' | 'STALE' | 'MISSING';

export interface BookingReadinessResult {
  /** Ready for REVIEW (no blockers). */
  ready: boolean;
  checks: {
    journeyReady: boolean;
    dateReady: boolean;
    passengersReady: boolean;
    passengerDetailsReady: boolean;
    trainReady: boolean;
    classReady: boolean;
    availabilityReady: boolean;
    fareReady: boolean;
    reviewReady: boolean;
    confirmationReady: boolean;
  };
  availability: DataFreshness;
  fare: DataFreshness;
  blockers: BookingBlocker[];
  missingFields: string[];
  warnings: string[];
  /** Railway data that must be (re)fetched from the provider before review/confirmation. */
  refreshNeeded: Array<'AVAILABILITY' | 'FARE'>;
  nextRequiredField: NextRequiredField | null;
  evaluatedAt: string;
}

const trainNo = (t: any): string | undefined => t ? String(t.number || t.trainNumber) : undefined;
/**
 * Prompt 33: was this provider result obtained in the CURRENT turn? By execution identity (this turn's tool executions —
 * robust to equal / frozen clocks); the retrieval time is only a fallback for an entry without an execution id.
 * No turn context (freshSince undefined) → no current-turn requirement (TTL policy only, e.g. confirmation).
 */
function currentTurn(x: any, freshSince?: number, freshIds?: ReadonlySet<string>): boolean {
  if (freshSince === undefined) return true;
  if (x?.toolExecutionId && freshIds) return freshIds.has(String(x.toolExecutionId));
  return Date.parse(x?.retrievedAt || x?.fetchedAt || '') >= freshSince;
}
const ageMs = (iso: string | undefined, now: number) => (iso ? now - Date.parse(iso) : Number.POSITIVE_INFINITY);

export class BookingReadinessEvaluator {
  constructor(private readonly policy: PreparationPolicy = defaultPolicy()) {}

  get preparationPolicy(): PreparationPolicy { return this.policy; }

  /**
   * Prompt 33: `freshSince` (epoch ms, the current turn's start) — when given, data fetched BEFORE it is STALE. A NEW
   * review version is only built from availability / fare obtained in the review-building turn (by the LLM's own tool
   * call or the booking-review refresh boundary); a previous turn's fare / availability is never review authority.
   */
  availabilityFreshness(s: BookingSession, now = Date.now(), freshSince?: number, freshIds?: ReadonlySet<string>): DataFreshness {
    const t = trainNo(s.selectedTrain);
    const cls = s.selectedClass;
    const a: any = cls && s.availability ? (s.availability as any)[cls] : undefined;
    if (!a) return 'MISSING';
    const matches = (!a.trainNumber || a.trainNumber === t) && (!a.travelClass || a.travelClass === cls) && (!a.date || !s.date || a.date === s.date);
    if (!matches) return 'STALE';
    if (!currentTurn(a, freshSince, freshIds)) return 'STALE';
    return ageMs(a.retrievedAt, now) <= this.policy.availabilityMaxAgeMs ? 'FRESH' : 'STALE';
  }

  fareFreshness(s: BookingSession, now = Date.now(), freshSince?: number, freshIds?: ReadonlySet<string>): DataFreshness {
    const f: any = s.fare;
    if (!f) return 'MISSING';
    const matches = (!f.trainNumber || f.trainNumber === trainNo(s.selectedTrain))
      && (!f.travelClass || f.travelClass === s.selectedClass)
      && (!f.passengersCount || f.passengersCount === (s.passengersCount || 1))
      && (!f.origin || f.origin === s.origin) && (!f.destination || f.destination === s.destination);
    if (!matches) return 'STALE';
    if (!currentTurn(f, freshSince, freshIds)) return 'STALE';
    return ageMs(f.retrievedAt, now) <= this.policy.fareMaxAgeMs ? 'FRESH' : 'STALE';
  }

  evaluate(s: BookingSession, now = Date.now(), opts: { freshSince?: number; freshIds?: ReadonlySet<string> } = {}): BookingReadinessResult {
    const blockers: BookingBlocker[] = [];
    const missing: string[] = [];
    const warnings: string[] = [];
    const refresh: Array<'AVAILABILITY' | 'FARE'> = [];
    const add = (b: BookingBlocker) => { if (!blockers.includes(b)) blockers.push(b); };

    // journey / date
    if (!s.origin) { add('MISSING_ORIGIN'); missing.push('origin'); }
    if (!s.destination) { add('MISSING_DESTINATION'); missing.push('destination'); }
    if (!s.date) { add('MISSING_DATE'); missing.push('date'); }
    const journeyReady = !!(s.origin && s.destination && s.origin !== s.destination);
    const dateReady = !!s.date && /^\d{4}-\d{2}-\d{2}$/.test(s.date);

    // train
    const t: any = s.selectedTrain;
    let trainReady = false;
    if (!t) { add('MISSING_TRAIN'); missing.push('train'); }
    else {
      const results = currentResults(s);
      trainReady = !results.length || results.some(r => r.trainNumber === trainNo(t));
      if (!trainReady) add('INVALID_TRAIN');
    }

    // class
    let classReady = false;
    if (!s.selectedClass) { add('MISSING_CLASS'); missing.push('class'); }
    else if (t) {
      classReady = trainClassCodes(t).includes(s.selectedClass);
      if (!classReady) add('INVALID_CLASS');
    }

    // passengers (count, then details per stable id)
    const n = s.passengersCount;
    const passengersReady = !!n && Number.isInteger(n) && n >= 1 && n <= MAX_PASSENGERS;
    if (!passengersReady) { add('MISSING_PASSENGER_COUNT'); missing.push('passengersCount'); }
    let passengerDetailsReady = false;
    if (passengersReady) {
      const ps = s.passengers || [];
      let anyMissing = ps.length !== n, anyInvalid = false;
      ps.forEach(p => {
        const r = passengerValidator.validateRecord(p);
        r.missing.forEach(f => missing.push(`${p.id}.${f}`));
        if (r.missing.length) anyMissing = true;
        if (!r.valid) anyInvalid = true;
      });
      for (let i = ps.length; i < (n || 0); i++) missing.push(`passenger${i + 1}`);
      if (anyMissing) add('MISSING_PASSENGER_DETAILS');
      if (anyInvalid) add('INVALID_PASSENGER_DETAILS');
      passengerDetailsReady = !anyMissing && !anyInvalid;
    }

    // railway facts (only meaningful once train + class are valid)
    let availability: DataFreshness = 'MISSING', fare: DataFreshness = 'MISSING';
    if (trainReady && classReady) {
      availability = this.availabilityFreshness(s, now, opts.freshSince, opts.freshIds);
      fare = this.fareFreshness(s, now, opts.freshSince, opts.freshIds);
      if (availability !== 'FRESH') refresh.push('AVAILABILITY');
      if (fare !== 'FRESH') refresh.push('FARE');
      if (availability === 'STALE') add('STALE_AVAILABILITY');
      if (fare === 'STALE') add('STALE_FARE');
      if (availability === 'MISSING') {
        if (this.policy.requireAvailability) add('REQUIRED_TOOL_DATA_MISSING');
        else warnings.push('AVAILABILITY_NOT_VERIFIED');
      }
      if (fare === 'MISSING') {
        if (this.policy.requireFare) add('REQUIRED_TOOL_DATA_MISSING');
        else warnings.push('FARE_NOT_VERIFIED');
      }
      const a: any = s.availability?.[s.selectedClass!];
      if (availability === 'FRESH' && a && !/^available/i.test(String(a.status || ''))) warnings.push('AVAILABILITY_NOT_CONFIRMED_SEAT');
    }
    const availabilityReady = availability === 'FRESH' || (availability === 'MISSING' && !this.policy.requireAvailability);
    const fareReady = fare === 'FRESH' || (fare === 'MISSING' && !this.policy.requireFare);

    const ready = blockers.length === 0;
    const rv = s.review;
    const reviewReady = ready && !!rv && rv.valid && rv.fingerprint === reviewFingerprint(s);
    const confirmationReady = reviewReady && s.bookingState === BookingState.AWAITING_CONFIRMATION
      && s.confirmedReviewVersion === rv!.reviewVersion;

    return {
      ready,
      checks: { journeyReady, dateReady, passengersReady, passengerDetailsReady, trainReady, classReady, availabilityReady, fareReady, reviewReady, confirmationReady },
      availability, fare, blockers, missingFields: missing, warnings, refreshNeeded: refresh,
      nextRequiredField: getNextRequiredField(s),
      evaluatedAt: new Date(now).toISOString()
    };
  }
}

/**
 * Deterministic next question. Never asks for something that already exists
 * (origin, fare, …) and never asks passenger details before train + class.
 */
export function getNextRequiredField(s: BookingSession): NextRequiredField | null {
  if (!s.origin) return { field: 'origin' };
  if (!s.destination) return { field: 'destination' };
  if (!s.date) return { field: 'date' };
  if (!s.selectedTrain) return { field: 'train' };
  if (!s.selectedClass) return { field: 'class' };
  if (!s.passengersCount) return { field: 'passengersCount' };
  const ps = s.passengers || [];
  for (let i = 0; i < s.passengersCount; i++) {
    const p = ps[i];
    if (!p) return { field: 'name', passengerId: `(slot ${i + 1})`, passengerIndex: i };
    const m = passengerValidator.missingRequired(p);
    if (m.length) return { field: m[0], passengerId: p.id, passengerIndex: i };
  }
  return null;
}
