/**
 * ReviewBuilder (Prompt 9) — deterministic BookingReview built ONLY from:
 *   BookingSession + authoritative (synced) railway results + validated passengers.
 * The LLM never composes booking facts.
 *
 *  - fare missing / not for current train+class+count  → "Fare abhi verify nahi hua hai."
 *  - availability missing / not for current selection  → "Availability abhi verify nahi hui hai."
 *  - RAC / Waitlist is relayed verbatim and flagged — never upgraded to "confirmed".
 *  - No PNR, no booking status, no seat numbers, no invented fields.
 */
import type { ReviewSnapshot } from '@shared/booking-preparation';
import { availabilityStatus, fareStatus } from './preparation/booking-preparation-guard';
import type { BookingSession } from '@shared/entities';
import { humanDate, shortName } from '../ai/context/response-formatter';

export interface BookingReview {
  reviewVersion: number;
  createdAt: string;
  journey: { origin?: string; originName?: string; destination?: string; destinationName?: string };
  /** @deprecated alias of journey (Prompt 8 UI) */
  route: { origin?: string; originName?: string; destination?: string; destinationName?: string };
  date?: string;
  passengersCount: number;
  passengers: Array<{ passengerId: string; index: number; name?: string; age?: number; gender?: string; berthPreference?: string; foodPreference?: string }>;
  selectedTrain: { number: string; name: string; departure?: string; arrival?: string } | null;
  /** @deprecated alias of selectedTrain (Prompt 8 UI) */
  train: { number: string; name: string; departure?: string; arrival?: string } | null;
  selectedClass?: string;
  availability: { verified: boolean; status?: string; retrievedAt?: string; dependencyStatus?: string };
  fare: { verified: boolean; perPassenger?: number; total?: number; currency?: string; passengersCount?: number; retrievedAt?: string; fareStatus?: string };
  warnings: string[];
  dataSource: string;
  confirmationRequired: true;
  /** This milestone never books. */
  realBooking: false;
}

export interface BuildOptions {
  reviewVersion?: number;
  /** Freshness verdicts from BookingReadinessEvaluator; non-FRESH data is shown as unverified. */
  availabilityFresh?: boolean;
  fareFresh?: boolean;
  now?: number;
}

const tn = (t: any) => (t ? String(t.number || t.trainNumber) : undefined);
const G: Record<string, string> = { MALE: 'M', FEMALE: 'F', OTHER: 'O' };
/** P38: berth / meal choices from the passenger form (only when set; NO_PREFERENCE is not repeated). */
const BERTH_SHORT: Record<string, string> = { LOWER: 'Lower', MIDDLE: 'Middle', UPPER: 'Upper', SIDE_LOWER: 'Side Lower', SIDE_UPPER: 'Side Upper', SIDE_MIDDLE: 'Side Middle', WINDOW: 'Window', CABIN: 'Cabin', COUPE: 'Coupe' };
const FOOD_SHORT: Record<string, string> = { VEG: 'Veg', NON_VEG: 'Non-Veg', NO_FOOD: 'No Food' };
const extras = (p: any): string => { const x = [p.berthPreference && BERTH_SHORT[p.berthPreference], p.foodPreference && FOOD_SHORT[p.foodPreference]].filter(Boolean); return x.length ? ` [${x.join(', ')}]` : ''; };

/** Booking-critical fingerprint: any change ⇒ the review is obsolete. */
export function reviewFingerprint(s: BookingSession): string {
  const a: any = s.selectedClass && s.availability ? (s.availability as any)[s.selectedClass] : undefined;
  const f: any = s.fare;
  return JSON.stringify([
    s.origin, s.destination, s.date, tn(s.selectedTrain), s.selectedClass, s.passengersCount,
    (s.passengers || []).map(p => [p.id, p.name, p.age, p.gender, p.berthPreference ?? null, ...(p.foodPreference ? [p.foodPreference] : [])]),
    a ? [a.status, a.retrievedAt] : null,
    f ? [f.total, f.passengersCount, f.retrievedAt] : null
  ]);
}

/**
 * Prompt 20 — Part 29: ReviewSnapshot from AUTHORITATIVE data only (session journey + current-result train +
 * validator-approved passengers + provider results matching the current basis). Frozen. No LLM text, no seat /
 * coach / PNR; a missing fare / availability is an explicit status, never an estimate.
 */
export function buildReviewSnapshot(s: BookingSession, reviewVersion: number, now: number, fareOk: boolean, availOk: boolean): ReviewSnapshot {
  const t: any = s.selectedTrain;
  const deps: any = (s as any).preparationDependencies || {};
  const fs = fareStatus(s), as = availabilityStatus(s);
  const f: any = s.fare;
  const a: any = s.selectedClass && s.availability ? (s.availability as any)[s.selectedClass] : undefined;
  const snap: ReviewSnapshot = {
    reviewVersion,
    createdAt: new Date(now).toISOString(),
    sessionVersion: s.sessionVersion,
    fingerprint: reviewFingerprint(s),
    journey: { origin: s.origin!, destination: s.destination!, date: s.date!, ...(s.originName ? { originName: s.originName } : {}), ...(s.destinationName ? { destinationName: s.destinationName } : {}) },
    train: { number: tn(t)!, name: t?.name || t?.trainName, departure: t?.departure, arrival: t?.arrival, resultSetId: t?.searchResultId ?? (s.searchResults as any)?.resultId ?? null },
    travelClass: s.selectedClass!,
    passengers: (s.passengers || []).map((p, i) => ({ index: i + 1, name: p.name!, age: p.age!, gender: p.gender!, ...(p.berthPreference ? { berthPreference: p.berthPreference } : {}), ...(p.foodPreference ? { foodPreference: p.foodPreference } : {}) })),
    availability: availOk
      ? { status: 'VERIFIED', value: String(a.status), retrievedAt: a.retrievedAt || a.fetchedAt, toolExecutionId: a.toolExecutionId }
      : as.status === 'UNAVAILABLE' ? { status: 'AVAILABILITY_UNAVAILABLE', errorCode: deps.availability?.errorCode ?? null } : { status: 'NOT_VERIFIED' },
    fare: fareOk
      ? { status: 'VERIFIED', total: f.total, perPassenger: f.perPassenger, currency: f.currency || 'INR', passengersCount: f.passengersCount ?? f.fareBasis?.passengersCount, retrievedAt: f.retrievedAt || f.fetchedAt, toolExecutionId: f.toolExecutionId }
      : fs.status === 'UNAVAILABLE' ? { status: 'FARE_UNAVAILABLE', errorCode: deps.fare?.errorCode ?? null } : { status: 'NOT_VERIFIED' },
    ...(s.dataSourceLabel ? { dataSource: s.dataSourceLabel } : {})
  };
  return deepFreeze(snap);
}
function deepFreeze<T>(o: T): T { if (o && typeof o === 'object') { Object.values(o as any).forEach(deepFreeze); Object.freeze(o); } return o; }

export class ReviewBuilder {
  build(s: BookingSession, opts: BuildOptions = {}): { data: BookingReview; text: string; voiceText: string; snapshot: ReviewSnapshot } {
    const t: any = s.selectedTrain;
    const cls = s.selectedClass;
    const count = s.passengersCount || s.passengers.length || 1;
    const fare: any = s.fare;
    const fareMatch = !!fare && (!fare.trainNumber || fare.trainNumber === tn(t)) && (!fare.travelClass || fare.travelClass === cls)
      && (!fare.passengersCount || fare.passengersCount === count);
    // Prompt 20 (Part 30): only a provider fare whose basis EXACTLY matches journey / train / class / pax
    const fareOk = fareMatch && opts.fareFresh !== false && fareStatus(s).status === 'AVAILABLE';
    const avail: any = cls && s.availability ? (s.availability as any)[cls] : undefined;
    const availMatch = !!avail && (!avail.trainNumber || avail.trainNumber === tn(t)) && (!avail.date || !s.date || avail.date === s.date);
    const availOk = availMatch && opts.availabilityFresh !== false && availabilityStatus(s).status === 'AVAILABLE';

    const warnings: string[] = [];
    if (!availOk) warnings.push('Availability abhi verify nahi hui hai.');
    else if (!/^available/i.test(String(avail.status))) warnings.push(`Availability "${avail.status}" hai — ye confirmed seat nahi hai.`);
    if (!fareOk) warnings.push('Fare abhi verify nahi hua hai.');
    if (/mock/i.test(String(s.dataSourceLabel))) warnings.push('Mock / development data — live railway data nahi hai.');

    const journey = { origin: s.origin, originName: s.originName, destination: s.destination, destinationName: s.destinationName };
    const train = t ? { number: tn(t)!, name: t.name || t.trainName, departure: t.departure, arrival: t.arrival } : null;
    const data: BookingReview = {
      reviewVersion: opts.reviewVersion ?? s.review?.reviewVersion ?? 0,
      createdAt: new Date(opts.now ?? Date.now()).toISOString(),
      journey, route: journey,
      date: s.date,
      passengersCount: count,
      passengers: (s.passengers || []).map((p, i) => ({
        passengerId: p.id, index: i + 1, name: p.name, age: p.age, gender: p.gender,
        ...(p.berthPreference ? { berthPreference: p.berthPreference } : {}), ...(p.foodPreference ? { foodPreference: p.foodPreference } : {})
      })),
      selectedTrain: train, train,
      selectedClass: cls,
      availability: availOk ? { verified: true, status: avail.status, retrievedAt: avail.retrievedAt } : { verified: false, dependencyStatus: availabilityStatus(s).status },
      fare: fareOk ? { verified: true, perPassenger: fare.perPassenger, total: fare.total, currency: fare.currency || 'INR', passengersCount: fare.passengersCount, retrievedAt: fare.retrievedAt } : { verified: false, fareStatus: fareStatus(s).status },
      warnings,
      dataSource: s.dataSourceLabel,
      confirmationRequired: true,
      realBooking: false
    };

    const route = `${shortName(s.originName, s.origin)} → ${shortName(s.destinationName, s.destination)}`;
    const paxNames = data.passengers.filter(p => p.name).map(p => `${p.name}${p.age ? ` (${p.age}${p.gender ? `, ${G[p.gender] || p.gender}` : ''})` : ''}${extras(p)}`);
    const paxLine = `${count} passenger${count > 1 ? 's' : ''}${paxNames.length ? `: ${paxNames.join(', ')}` : ''}`;
    const fareLine = data.fare.verified ? `Fare: ₹${data.fare.total}${count > 1 ? ` (₹${data.fare.perPassenger} × ${count})` : ''}` : 'Fare abhi verify nahi hua hai.';
    const availLine = data.availability.verified ? `Availability: ${data.availability.status}` : 'Availability abhi verify nahi hui hai.';
    const text = [
      `Review (v${data.reviewVersion}):`,
      route,
      humanDate(s.date),
      train ? `${train.number} ${train.name}` : '—',
      cls || '—',
      paxLine,
      fareLine,
      availLine
    ].join('\n');
    const voiceText = `${route}, ${humanDate(s.date)}, ${train?.number || ''} ${cls || ''}, ${count} passenger${count > 1 ? 's' : ''}. `
      + `${data.fare.verified ? `Total fare ₹${data.fare.total}.` : 'Fare abhi verify nahi hua hai.'} `
      + `${data.availability.verified ? `Availability ${data.availability.status}.` : 'Availability abhi verify nahi hui hai.'}`;
    return { data, text, voiceText: voiceText.replace(/\s+/g, ' ').trim(), snapshot: buildReviewSnapshot(s, data.reviewVersion, opts.now ?? Date.now(), fareOk, availOk) };
  }
}

export const reviewBuilder = new ReviewBuilder();
