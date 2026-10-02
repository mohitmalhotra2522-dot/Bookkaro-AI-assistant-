/**
 * BookingSnapshot — immutable, deep-frozen copy of exactly the validated booking data.
 *
 * Source of truth: BookingSession + validated railway results (availability / fare
 * provenance) + validated passengers + the CURRENT review. Never LLM output.
 * Only existing domain-contract fields are copied (no invented booking fields).
 * If data changes, a NEW snapshot is built — an existing one is never mutated.
 */
import { randomBytes } from 'crypto';
import type { BookingSession } from '@shared/entities';
import type { BookingSnapshot } from '@shared/booking-handoff-session';
import { reviewFingerprint } from '../review-builder';
import { deepFreeze } from '../execution/booking-handoff';

export type SnapshotBuildResult = { ok: true; snapshot: Readonly<BookingSnapshot> } | { ok: false; code: 'INVALID_BOOKING_SNAPSHOT'; detail: string };

export function buildBookingSnapshot(s: BookingSession, now: number): SnapshotBuildResult {
  const t: any = s.selectedTrain;
  const rv = s.review;
  const cls = s.selectedClass;
  const a: any = cls ? s.availability?.[cls] : undefined;
  const f: any = s.fare;
  if (!rv?.valid) return { ok: false, code: 'INVALID_BOOKING_SNAPSHOT', detail: 'no valid review' };
  if (!s.origin || !s.destination || !s.date || !t || !cls) return { ok: false, code: 'INVALID_BOOKING_SNAPSHOT', detail: 'journey/train/class missing' };
  if (!a?.retrievedAt || !f?.retrievedAt || typeof f.total !== 'number') return { ok: false, code: 'INVALID_BOOKING_SNAPSHOT', detail: 'railway data missing' };
  if (!t.resultId) return { ok: false, code: 'INVALID_BOOKING_SNAPSHOT', detail: 'train provenance missing' };
  const snapshot: BookingSnapshot = {
    snapshotId: `sn_${randomBytes(12).toString('hex')}`,
    sessionId: s.sessionId,
    reviewVersion: rv.reviewVersion,
    journey: { origin: s.origin, destination: s.destination },
    date: s.date,
    selectedTrain: {
      trainNumber: String(t.number || t.trainNumber), trainName: t.name || t.trainName, resultId: String(t.resultId),
      date: String(t.date ?? s.date), origin: t.origin, destination: t.destination, departure: t.departure, arrival: t.arrival
    },
    selectedClass: cls,
    passengers: (s.passengers || []).map((p: any) => ({
      passengerId: String(p.id), name: String(p.name ?? ''), age: Number(p.age), gender: p.gender,
      ...(p.berthPreference ? { berthPreference: String(p.berthPreference) } : {})
    })),
    availabilitySnapshot: { status: String(a.status), available: !!a.available, retrievedAt: a.retrievedAt, dataSource: a.dataSource },
    fareSnapshot: { perPassenger: f.perPassenger, total: f.total, currency: f.currency || 'INR', passengersCount: f.passengersCount, retrievedAt: f.retrievedAt, dataSource: f.dataSource },
    fingerprint: reviewFingerprint(s),
    createdAt: new Date(now).toISOString()
  };
  return { ok: true, snapshot: deepFreeze(snapshot) };
}
