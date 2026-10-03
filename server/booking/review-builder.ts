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
  passengers: Array<{ passengerId: string; index: number; name?: string; age?: number; gender?: string; berthPreference?: string }>;
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

/** Booking-critical fingerprint: any change ⇒ the review is obsolete. */
export function reviewFingerprint(s: BookingSession): string {
  const a: any = s.selectedClass && s.availability ? (s.availability as any)[s.selectedClass] : undefined;
  const f: any = s.fare;
  return JSON.stringify([
    s.origin, s.destination, s.date, tn(s.selectedTrain), s.selectedClass, s.passengersCount,
    (s.passengers || []).map(p => [p.id, p.name, p.age, p.gender, p.berthPreference ?? null]),
    a ? [a.status, a.retrievedAt] : null,
    f ? [f.total, f.passengersCount, f.retrievedAt] : null
  ]);
}

export class ReviewBuilder {
  build(s: BookingSession, opts: BuildOptions = {}): { data: BookingReview; text: string; voiceText: string } {
    const t: any = s.selectedTrain;
    const cls = s.selectedClass;
    const count = s.passengersCount || s.passengers.length || 1;
    const fare: any = s.fare;
    const fareMatch = !!fare && (!fare.trainNumber || fare.trainNumber === tn(t)) && (!fare.travelClass || fare.travelClass === cls)
      && (!fare.passengersCount || fare.passengersCount === count);
    const fareOk = fareMatch && opts.fareFresh !== false;
    const avail: any = cls && s.availability ? (s.availability as any)[cls] : undefined;
    const availMatch = !!avail && (!avail.trainNumber || avail.trainNumber === tn(t)) && (!avail.date || !s.date || avail.date === s.date);
    const availOk = availMatch && opts.availabilityFresh !== false;

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
        ...(p.berthPreference ? { berthPreference: p.berthPreference } : {})
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
    const paxNames = data.passengers.filter(p => p.name).map(p => `${p.name}${p.age ? ` (${p.age}${p.gender ? `, ${G[p.gender] || p.gender}` : ''})` : ''}`);
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
    return { data, text, voiceText: voiceText.replace(/\s+/g, ' ').trim() };
  }
}

export const reviewBuilder = new ReviewBuilder();
