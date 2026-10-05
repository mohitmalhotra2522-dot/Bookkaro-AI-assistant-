/**
 * PROMPT 19 — BookingPreparation domain (Parts 1, 5, 20–22, 25–29, 46, 48–49).
 *
 * A derived view over BookingSession — authoritative values are READ from the session, never copied into a
 * second store. The only persisted additions are the preparation sub-state (+ its last legal path) and
 * "provider said unavailable" markers for fare / availability (so the review can say "Fare abhi verify nahi
 * hua hai" instead of inventing an amount).
 *
 * The preparation state only moves along PREPARATION_TRANSITIONS (shortest legal path, recorded for
 * observability). It can reach BOOKING_CONFIRMATION_REQUESTED but NEVER COMPLETE — no booking happens here.
 */
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';
import {
  PREPARATION_TRANSITIONS, canTransitionPreparation,
  type BookingPreparationState, type BookingPreparationSummary, type BookingPreparationView, type ConfirmationStatus,
  type PassengerCollectionState, type ReviewStatus
} from '@shared/booking-preparation';
import { passengerValidator } from '../passenger-validator';
import { passengerCollection } from '../passenger-collection';
import { reviewFingerprint } from '../review-builder';
import { bookingPreparationGuard, availabilityStatus, fareStatus, fareBasisKey, availabilityBasisKey } from './booking-preparation-guard';

const ORDER: BookingState[] = [
  BookingState.IDLE, BookingState.COLLECTING_JOURNEY, BookingState.COLLECTING_DATE, BookingState.COLLECTING_PASSENGERS,
  BookingState.SEARCHING_TRAINS, BookingState.SHOWING_TRAINS, BookingState.TRAIN_SELECTED, BookingState.CLASS_OPTIONS,
  BookingState.CLASS_SELECTED, BookingState.BOOKING_PREPARE, BookingState.COLLECTING_PASSENGER_DETAILS, BookingState.PASSENGERS_READY,
  BookingState.REVIEW, BookingState.AWAITING_CONFIRMATION, BookingState.IRCTC_HANDOFF_READY
];
const at = (st: BookingState) => ORDER.indexOf(st);

// ------------------------------------------------------------------ review / confirmation status

/** Part 27 — CURRENT only when valid, built from exactly the current booking data, and still preparable. */
export function reviewStatusOf(s: BookingSession): ReviewStatus {
  const rv = s.review;
  if (!rv) return 'NONE';
  const sameData = rv.fingerprint === reviewFingerprint(s);
  if (rv.valid && sameData) {
    const guard = bookingPreparationGuard.check(s);
    const pax = passengerValidator.completeness(s.passengers, s.passengersCount);
    return guard.ready && pax.complete ? 'CURRENT' : 'INVALID';
  }
  // the data moved on after the review was generated (route / date / train / class / count / details / refresh)
  if (!sameData || /SUPERSEDED|CHANGED|STALE|REFRESH|EXPIRED|INVALIDATED|CORRECTION/i.test(String(rv.invalidatedReason || ''))) return 'STALE';
  return 'INVALID';
}

export function confirmationStatusOf(s: BookingSession): ConfirmationStatus {
  const rv = s.review;
  if (s.bookingState === BookingState.IRCTC_HANDOFF_READY && s.confirmation?.status === 'VALID') return 'CONFIRMATION_REQUESTED';
  if (s.confirmation?.status === 'VALID' && rv && s.confirmation.reviewVersion === rv.reviewVersion && reviewStatusOf(s) === 'CURRENT') return 'CONFIRMATION_REQUESTED';
  if (s.bookingState === BookingState.AWAITING_CONFIRMATION) return 'AWAITING_CONFIRMATION';
  if (s.confirmation && s.confirmation.status !== 'VALID') return 'INVALIDATED';
  return 'NOT_REQUESTED';
}

/** Parts 28–30 — a confirmation REQUEST is acceptable only for the CURRENT review in AWAITING_CONFIRMATION. */
export function confirmationGuard(s: BookingSession, opts: { reviewVersion?: number } = {}):
  { ok: true; reviewVersion: number } | { ok: false; code: 'INVALID_CONFIRMATION' | 'STALE_REVIEW' | 'INVALID_REVIEW'; message: string } {
  if (s.bookingState !== BookingState.AWAITING_CONFIRMATION) {
    return { ok: false, code: 'INVALID_CONFIRMATION', message: 'Abhi koi booking confirmation pending nahi hai.' };
  }
  const st = reviewStatusOf(s);
  const cur = s.review?.reviewVersion;
  if (st === 'STALE' || (typeof opts.reviewVersion === 'number' && opts.reviewVersion !== cur)) {
    return { ok: false, code: 'STALE_REVIEW', message: 'Review purana ho chuka hai — updated review dekh kar confirm karein.' };
  }
  if (st !== 'CURRENT' || typeof cur !== 'number' || s.confirmedReviewVersion !== cur) {
    return { ok: false, code: 'INVALID_REVIEW', message: 'Current review valid nahi hai — pehle details poori karke naya review dekhiye.' };
  }
  return { ok: true, reviewVersion: cur };
}

// ------------------------------------------------------------------ preparation sub-state

export function passengerCollectionStateOf(s: BookingSession): PassengerCollectionState {
  const guard = bookingPreparationGuard.check(s);
  if (!guard.ready || at(s.bookingState) < at(BookingState.CLASS_SELECTED)) return 'NOT_STARTED';
  if (!s.passengersCount) return 'COUNT_REQUIRED';
  const c = passengerValidator.completeness(s.passengers, s.passengersCount);
  if (c.complete) return 'PASSENGERS_COMPLETE';
  const anyData = (s.passengers || []).some(p => p.name || p.age || p.gender);
  return anyData || at(s.bookingState) >= at(BookingState.COLLECTING_PASSENGER_DETAILS) ? 'COLLECTING_PASSENGER_DETAILS' : 'PASSENGERS_READY';
}

/** Where the Prompt-19 pipeline currently stands — derived ONLY from authoritative session data. */
export function derivePreparationState(s: BookingSession): BookingPreparationState {
  const conf = confirmationStatusOf(s);
  if (conf === 'CONFIRMATION_REQUESTED') return 'BOOKING_CONFIRMATION_REQUESTED';
  const guard = bookingPreparationGuard.check(s);
  if (!guard.ready || at(s.bookingState) < at(BookingState.CLASS_SELECTED) || at(s.bookingState) === -1) return 'NOT_STARTED';
  if (s.bookingState === BookingState.CLASS_SELECTED) return 'CLASS_SELECTED';
  const rs = reviewStatusOf(s);
  if (s.bookingState === BookingState.AWAITING_CONFIRMATION && rs === 'CURRENT') return 'AWAITING_CONFIRMATION';
  if (s.bookingState === BookingState.REVIEW && rs === 'CURRENT') return 'REVIEW';
  const pc = passengerCollectionStateOf(s);
  if (pc === 'COUNT_REQUIRED') return 'COLLECTING_PASSENGERS';
  if (pc === 'COLLECTING_PASSENGER_DETAILS') return 'COLLECTING_PASSENGER_DETAILS';
  if (pc === 'PASSENGERS_READY') return 'PASSENGERS_READY';
  // Prompt 20 (Part 23/41): details complete + guard satisfied, review not built (or being rebuilt) yet
  return bookingPreparationGuard.checkReadyForReview(s).ready ? 'READY_FOR_REVIEW' : 'COLLECTING_PASSENGER_DETAILS';
}

/** Shortest legal path from → to over PREPARATION_TRANSITIONS (BFS). */
export function preparationPath(from: BookingPreparationState, to: BookingPreparationState): BookingPreparationState[] | null {
  if (from === to) return [];
  const prev = new Map<BookingPreparationState, BookingPreparationState>();
  const q: BookingPreparationState[] = [from];
  const seen = new Set([from]);
  while (q.length) {
    const cur = q.shift()!;
    for (const nx of PREPARATION_TRANSITIONS[cur]) {
      if (seen.has(nx)) continue;
      seen.add(nx); prev.set(nx, cur);
      if (nx === to) {
        const path: BookingPreparationState[] = [to];
        let p = cur;
        while (p !== from) { path.unshift(p); p = prev.get(p)!; }
        return path;
      }
      q.push(nx);
    }
  }
  return null;
}

/**
 * Move the persisted preparation state to the derived one along LEGAL transitions only (Part 20–22, 48).
 * e.g. class chosen with a known count: CLASS_SELECTED → BOOKING_PREPARE → PASSENGERS_READY → COLLECTING_PASSENGER_DETAILS.
 */
export function syncPreparationState(s: BookingSession): { from: BookingPreparationState; to: BookingPreparationState; path: BookingPreparationState[] } {
  const from = ((s as any).bookingPreparationState as BookingPreparationState) || 'NOT_STARTED';
  let to = derivePreparationState(s);
  // the pipeline passes through BOOKING_PREPARE when it starts (Part 20): CLASS_SELECTED → BOOKING_PREPARE
  let path = preparationPath(from, to);
  if (path && from === 'NOT_STARTED' && to !== 'NOT_STARTED' && to !== 'CLASS_SELECTED' && !path.includes('BOOKING_PREPARE')) {
    path = ['CLASS_SELECTED', 'BOOKING_PREPARE', ...(preparationPath('BOOKING_PREPARE', to) || [to])];
  }
  // Prompt 20 (Part 35): a correction / fresh recheck rebuilt the review in place — record the legal rebuild path
  const rv = s.review?.reviewVersion ?? null;
  const prevRv = (s as any).preparationTrace?.reviewVersion ?? null;
  const REVIEWED: BookingPreparationState[] = ['REVIEW', 'AWAITING_CONFIRMATION', 'BOOKING_CONFIRMATION_REQUESTED'];
  if (path && rv !== null && prevRv !== null && rv !== prevRv && REVIEWED.includes(from) && (to === 'REVIEW' || to === 'AWAITING_CONFIRMATION')) {
    path = ['READY_FOR_REVIEW', 'REVIEW', ...(to === 'AWAITING_CONFIRMATION' ? ['AWAITING_CONFIRMATION' as const] : [])];
  }
  if (!path) { to = from; path = []; }
  for (let i = 0, cur = from; i < path.length; cur = path[i], i++) {
    if (!canTransitionPreparation(cur, path[i])) { to = from; path = []; break; }
  }
  (s as any).bookingPreparationState = to;
  const prevTrace = (s as any).preparationTrace;
  if (path.length) (s as any).preparationTrace = { from, to, path, at: new Date().toISOString(), reviewVersion: rv };
  else if (prevTrace) prevTrace.reviewVersion = rv;
  else (s as any).preparationTrace = { from, to, path: [], at: new Date().toISOString(), reviewVersion: rv };
  return { from, to, path };
}

// ------------------------------------------------------------------ dependency outcomes (Part 19: fareStatus = UNAVAILABLE)

/** Record that the provider could NOT return fare / availability for the CURRENT basis (no amount is ever stored). */
export function recordDependencyOutcome(s: BookingSession, tool: 'GET_FARE' | 'CHECK_AVAILABILITY', ok: boolean, errorCode?: string | null): void {
  const deps = ((s as any).preparationDependencies ||= {});
  const key = tool === 'GET_FARE' ? 'fare' : 'availability';
  if (ok) { delete deps[key]; return; }
  deps[key] = { status: 'UNAVAILABLE', basis: tool === 'GET_FARE' ? fareBasisKey(s) : availabilityBasisKey(s), errorCode: errorCode || null, at: new Date().toISOString() };
}

// ------------------------------------------------------------------ views

export function buildBookingPreparation(s: BookingSession): BookingPreparationView {
  const guard = bookingPreparationGuard.check(s);
  const pax = passengerValidator.completeness(s.passengers, s.passengersCount);
  const t: any = s.selectedTrain;
  return {
    preparationState: ((s as any).bookingPreparationState as BookingPreparationState) || derivePreparationState(s),
    passengerCollectionState: passengerCollectionStateOf(s),
    journey: { origin: s.origin ?? null, destination: s.destination ?? null, date: s.date ?? null },
    selectedTrain: t ? { number: String(t.number || t.trainNumber), name: t.name } : null,
    selectedClass: s.selectedClass ?? null,
    passengersCount: s.passengersCount ?? null,
    passengerDetails: (s.passengers || []).map((p, i) => ({
      index: i + 1, passengerId: p.id, name: p.name, age: p.age, gender: p.gender, berthPreference: p.berthPreference,
      ...(p.foodPreference ? { foodPreference: p.foodPreference } : {}),
      complete: passengerValidator.missingRequired(p).length === 0
    })),
    availabilityResult: availabilityStatus(s),
    fareResult: fareStatus(s),
    reviewVersion: s.review?.reviewVersion ?? null,
    reviewStatus: reviewStatusOf(s),
    confirmationStatus: confirmationStatusOf(s),
    missingPrerequisites: guard.missing,
    passengerCompleteness: pax,
    passengerCollection: passengerCollection.view(s, passengerCollectionStateOf(s)),
    journeyValidation: guard.journey || null,
    reviewSnapshot: s.review?.snapshot ?? null
  };
}

/** Part 46 — PII-free summary (counts / statuses only) for logs, turnLog, resume and the debug inspector. */
export function bookingPreparationSummary(s: BookingSession): BookingPreparationSummary {
  const v = buildBookingPreparation(s);
  return {
    bookingPreparationState: v.preparationState,
    passengerCollectionState: v.passengerCollectionState,
    passengerCount: v.passengersCount,
    passengersComplete: v.passengerDetails.filter(p => p.complete).length,
    reviewVersion: v.reviewVersion,
    reviewStatus: v.reviewStatus,
    confirmationStatus: v.confirmationStatus,
    availabilityStatus: v.availabilityResult.status,
    fareStatus: v.fareResult.status,
    missingPrerequisites: v.missingPrerequisites,
    passengerCollection: {
      expectedCount: v.passengerCollection.expectedCount,
      currentPassengerIndex: v.passengerCollection.currentPassengerIndex,
      missingFieldCount: v.passengerCollection.missingFields.length
    },
    reviewSnapshot: v.reviewSnapshot
      ? { reviewVersion: v.reviewSnapshot.reviewVersion, createdAt: v.reviewSnapshot.createdAt, availabilityStatus: v.reviewSnapshot.availability.status, fareStatus: v.reviewSnapshot.fare.status }
      : null
  };
}
