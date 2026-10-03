/**
 * PROMPT 19 — Parts 15–19: BookingPreparationGuard + train / class / availability / fare dependency guards.
 *
 *   journey + date + selectedTrain (∈ CURRENT displayed result set) + selectedClass (∈ that train's ACTUAL classes)
 *
 * Never trusts an LLM statement ("12014 has CC") or a bare LLM train number: the train is looked up in the
 * session's CURRENT search results and the class in that train's provider class list.
 * Availability / fare are AVAILABLE only when an authoritative provider result exists whose basis matches
 * the current journey / train / class (/ passenger count for fare). Nothing is ever estimated or computed here.
 */
import type { BookingSession } from '@shared/entities';
import type { DependencyStatus, PreparationPrerequisite } from '@shared/booking-preparation';
import type { JourneyValidation } from '@shared/booking-preparation';
import { bookingJourneyValidator, currentResultRecord, providerClassesOf } from './booking-journey-validator';
import { validatePassengerCount } from './passenger-count';
import { passengerValidator } from '../passenger-validator';

const trainNo = (t: any): string | null => (t ? String(t.number || t.trainNumber || '') || null : null);

export interface PreparationGuardResult {
  ready: boolean;
  code?: 'BOOKING_PREPARATION_NOT_READY';
  missing: PreparationPrerequisite[];
  /** One deterministic question for the FIRST missing prerequisite (ask only what is missing). */
  question?: string;
  /** Prompt 20 — the typed journey verdict the guard was derived from. */
  journey?: JourneyValidation;
}

/** Part 16 — the selected train object from the CURRENT result set (null when not displayed there). */
export function currentResultTrain(s: BookingSession): any | null { return currentResultRecord(s); }

/** Part 17 — classes the provider reported for the selected train (never an LLM claim). */
export function actualClassesOf(s: BookingSession): string[] { return providerClassesOf(s); }

const PREREQ_OF: Record<string, PreparationPrerequisite> = {
  'origin:MISSING': 'ROUTE', 'destination:MISSING': 'ROUTE', 'destination:SAME_STATION': 'ROUTE',
  'date:MISSING': 'DATE', 'date:INVALID_DATE': 'DATE',
  'selectedTrain:MISSING': 'TRAIN', 'selectedTrain:INVALID_TRAIN_SELECTION': 'TRAIN_NOT_IN_CURRENT_RESULTS',
  'selectedClass:MISSING': 'CLASS', 'selectedClass:INVALID_CLASS_SELECTION': 'CLASS_NOT_AVAILABLE'
};

export interface ReviewReadiness {
  ready: boolean;
  code?: 'BOOKING_PREPARATION_NOT_READY' | 'INVALID_PASSENGER_COUNT' | 'PASSENGER_DETAILS_INCOMPLETE';
  missing: PreparationPrerequisite[];
  passengerMissing: Array<{ passengerIndex: number; field: string }>;
  question?: string;
}

export class BookingPreparationGuard {
  /** Parts 3 / 15–17 — journey prerequisites (BookingJourneyValidator) before preparation may begin. */
  check(s: BookingSession): PreparationGuardResult {
    const j = bookingJourneyValidator.validate(s);
    const missing: PreparationPrerequisite[] = [];
    for (const i of j.issues) { const m = PREREQ_OF[`${i.field}:${i.code}`]; if (m && !missing.includes(m)) missing.push(m); }
    if (!missing.length) return { ready: true, missing, journey: j };
    return { ready: false, code: 'BOOKING_PREPARATION_NOT_READY', missing, question: this.question(s, missing[0]), journey: j };
  }

  /** Part 23 — journey valid + passenger count valid + every passenger complete → READY_FOR_REVIEW. */
  checkReadyForReview(s: BookingSession): ReviewReadiness {
    const g = this.check(s);
    if (!g.ready) return { ready: false, code: 'BOOKING_PREPARATION_NOT_READY', missing: g.missing, passengerMissing: [], question: g.question };
    const n = s.passengersCount;
    const cv = typeof n === 'number' ? validatePassengerCount(n) : null;
    if (!cv || !cv.ok) return { ready: false, code: 'INVALID_PASSENGER_COUNT', missing: [], passengerMissing: [], question: cv && !cv.ok ? cv.message : 'Kitne passengers hain?' };
    const v = passengerValidator.validateSet(s.passengers, n);
    if (!v.complete || !v.valid) {
      return { ready: false, code: 'PASSENGER_DETAILS_INCOMPLETE', missing: [], passengerMissing: [...v.missingFields, ...v.errors.map(e => ({ passengerIndex: e.passengerIndex, field: e.field }))] };
    }
    return { ready: true, missing: [], passengerMissing: [] };
  }

  private question(s: BookingSession, m: PreparationPrerequisite): string {
    switch (m) {
      case 'ROUTE': return 'Kahan se kahan jaana hai?';
      case 'DATE': return 'Kis date ko jaana hai?';
      case 'TRAIN': return 'Kaunsi train chahiye?';
      case 'TRAIN_NOT_IN_CURRENT_RESULTS': return 'Selected train current search results mein nahi hai. Kaunsi train chahiye?';
      case 'CLASS': return 'Kaunsi class chahiye?';
      case 'CLASS_NOT_AVAILABLE': {
        const cls = actualClassesOf(s);
        return `${s.selectedClass} is train mein available nahi hai.${cls.length ? ` Available classes: ${cls.join(', ')}.` : ''} Kaunsi chahiye?`;
      }
    }
  }
}

/** Basis key of everything a fare depends on (journey + train + class + passenger configuration). */
export function fareBasisKey(s: BookingSession): string {
  return [s.origin, s.destination, s.date, trainNo(s.selectedTrain), s.selectedClass, s.passengersCount || null].join('|');
}
/** Basis key of everything availability depends on (journey + train + class). */
export function availabilityBasisKey(s: BookingSession): string {
  return [s.origin, s.destination, s.date, trainNo(s.selectedTrain), s.selectedClass].join('|');
}

/** Part 18 — availability must match origin / destination / date / train / class and come from the provider. */
export function availabilityStatus(s: BookingSession): { status: DependencyStatus; value?: string; fetchedAt?: string; toolExecutionId?: string } {
  const cls = s.selectedClass;
  const a: any = cls && s.availability ? (s.availability as any)[cls] : undefined;
  const unavailable = (s as any).preparationDependencies?.availability;
  if (!a) return unavailable?.basis === availabilityBasisKey(s) ? { status: 'UNAVAILABLE' } : { status: 'NOT_REQUESTED' };
  const tn = trainNo(s.selectedTrain);
  const matches = !!tn && a.trainNumber === tn && (a.travelClass ? a.travelClass === cls : true) && !!s.date && a.date === s.date
    && (!a.origin || a.origin === s.origin) && (!a.destination || a.destination === s.destination)
    // Prompt 20 (Part 21/27): availability is passenger-dependent only when the provider result was for a count
    && (a.passengersCount === undefined || a.passengersCount === null || Number(a.passengersCount) === Number(s.passengersCount || 1));
  if (!matches) return unavailable?.basis === availabilityBasisKey(s) ? { status: 'UNAVAILABLE' } : { status: 'STALE' };
  return { status: 'AVAILABLE', value: String(a.status), fetchedAt: a.fetchedAt || a.retrievedAt, toolExecutionId: a.toolExecutionId };
}

/** Part 19 — fare must match journey / train / class / passenger count; unavailable → UNAVAILABLE (never an amount). */
export function fareStatus(s: BookingSession): { status: DependencyStatus; total?: number; perPassenger?: number; fetchedAt?: string; toolExecutionId?: string } {
  const f: any = s.fare;
  const unavailable = (s as any).preparationDependencies?.fare;
  if (!f) return unavailable?.basis === fareBasisKey(s) ? { status: 'UNAVAILABLE' } : { status: 'NOT_REQUESTED' };
  const b = f.fareBasis || f;
  const tn = trainNo(s.selectedTrain);
  const matches = !!tn && b.trainNumber === tn && b.travelClass === s.selectedClass && Number(b.passengersCount) === Number(s.passengersCount || 1)
    && (!b.origin || b.origin === s.origin) && (!b.destination || b.destination === s.destination) && (!b.date || b.date === s.date);
  if (!matches) return unavailable?.basis === fareBasisKey(s) ? { status: 'UNAVAILABLE' } : { status: 'STALE' };
  return { status: 'AVAILABLE', total: f.total, perPassenger: f.perPassenger, fetchedAt: f.fetchedAt || f.retrievedAt, toolExecutionId: f.toolExecutionId };
}

export const bookingPreparationGuard = new BookingPreparationGuard();
