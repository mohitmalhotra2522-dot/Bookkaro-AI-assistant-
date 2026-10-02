/**
 * BookingHandoffValidator — runs BEFORE any executor adapter may receive a handoff session.
 *
 *  1 handoff exists              8 date valid
 *  2 status READY                9 train valid (vs current authoritative results)
 *  3 not expired                10 class valid
 *  4 review version matches     11 passenger details valid (validator re-run)
 *  5 session version matches    12 availability + fare FRESH (execution policy)
 *  6 booking snapshot exists    13 confirmation exists and is VALID
 *  7 journey valid              14 confirmation belongs to the exact handed-off review
 *
 * Pure: never mutates the session. Returns the first failure.
 */
import type { BookingSession } from '@shared/entities';
import type { BookingHandoffSession, HandoffErrorCode } from '@shared/booking-handoff-session';
import { reviewFingerprint } from '../review-builder';
import { validateBookingData } from '../execution/booking-data-validator';

export type HandoffValidation = { ok: true } | { ok: false; code: HandoffErrorCode; detail: string };

const STATUS_ERROR: Record<string, HandoffErrorCode> = {
  CONSUMED: 'HANDOFF_ALREADY_CONSUMED', EXPIRED: 'HANDOFF_SESSION_EXPIRED', INVALIDATED: 'HANDOFF_INVALIDATED', FAILED: 'HANDOFF_INVALIDATED', CREATED: 'HANDOFF_INVALIDATED'
};

export class BookingHandoffValidator {
  validate(s: BookingSession, hs: BookingHandoffSession | undefined, now: number, opts: { allowCreated?: boolean } = {}): HandoffValidation {
    const no = (code: HandoffErrorCode, detail: string): HandoffValidation => ({ ok: false, code, detail });
    // 1) exists (and belongs to this session)
    if (!hs || hs.sessionId !== s.sessionId) return no('HANDOFF_NOT_FOUND', 'no handoff session');
    const h = s.handoff;
    if (!h || h.snapshot.handoffId !== hs.bookingHandoffId) return no('HANDOFF_NOT_FOUND', 'booking handoff missing');
    // 2) READY
    if (hs.status !== 'READY' && !(opts.allowCreated && hs.status === 'CREATED')) return no(STATUS_ERROR[hs.status] || 'HANDOFF_INVALIDATED', `status ${hs.status}`);
    if (h.status !== 'READY') return no(h.status === 'EXPIRED' ? 'HANDOFF_SESSION_EXPIRED' : 'HANDOFF_INVALIDATED', `booking handoff ${h.status}`);
    // 3) not expired
    if (!(now < Date.parse(hs.expiresAt)) || !(now < Date.parse(h.snapshot.expiresAt))) return no('HANDOFF_SESSION_EXPIRED', 'expired');
    // 4) review version
    const rv = s.review;
    if (!rv || !rv.valid || rv.reviewVersion !== hs.reviewVersion || h.snapshot.reviewVersion !== hs.reviewVersion) {
      return no('CONFIRMATION_VERSION_MISMATCH', 'review version mismatch');
    }
    // 5) session version
    if (s.sessionVersion !== hs.sessionVersion) return no('SESSION_VERSION_CONFLICT', 'session changed after handoff');
    // 6) snapshot exists, immutable, complete, and still equal to the authoritative data
    const snap = hs.bookingSnapshot;
    if (!snap || !Object.isFrozen(snap) || !snap.journey || !snap.selectedTrain || !snap.selectedClass || !Array.isArray(snap.passengers) || !snap.passengers.length || !snap.availabilitySnapshot || !snap.fareSnapshot) {
      return no('INVALID_BOOKING_SNAPSHOT', 'snapshot missing or incomplete');
    }
    if (snap.reviewVersion !== hs.reviewVersion || snap.sessionId !== s.sessionId) return no('CONFIRMATION_VERSION_MISMATCH', 'snapshot belongs to another review');
    const fp = reviewFingerprint(s);
    if (snap.fingerprint !== fp || rv.fingerprint !== fp || h.snapshot.fingerprint !== fp) return no('BOOKING_DATA_CHANGED', 'booking data changed since snapshot');
    const a: any = s.availability?.[snap.selectedClass];
    const f: any = s.fare;
    if (!a || a.retrievedAt !== snap.availabilitySnapshot.retrievedAt || String(a.status) !== snap.availabilitySnapshot.status) return no('BOOKING_DATA_CHANGED', 'availability changed');
    if (!f || f.retrievedAt !== snap.fareSnapshot.retrievedAt || f.total !== snap.fareSnapshot.total) return no('BOOKING_DATA_CHANGED', 'fare changed');
    // 7–12) journey, date, train, class, passengers, freshness — independent re-validation
    const v = validateBookingData(s, { journey: snap.journey, date: snap.date, selectedTrain: snap.selectedTrain, selectedClass: snap.selectedClass, passengers: snap.passengers }, now);
    if (v) {
      if (v.code === 'STALE_AVAILABILITY' || v.code === 'STALE_FARE') return no(v.code, v.detail);
      return no('INVALID_BOOKING_SNAPSHOT', `${v.code}: ${v.detail}`);
    }
    // 13) confirmation exists + VALID
    const c = s.confirmation;
    if (!c || c.confirmationId !== hs.confirmationId || c.sessionId !== s.sessionId) return no('INVALID_CONFIRMATION', 'confirmation missing');
    if (c.status !== 'VALID') return no('INVALID_CONFIRMATION', `confirmation ${c.status}`);
    // 14) confirmation belongs to this exact review / data / session version
    if (c.reviewVersion !== hs.reviewVersion || c.reviewFingerprint !== snap.fingerprint) return no('CONFIRMATION_VERSION_MISMATCH', 'confirmation is for another review');
    if (c.sessionVersion !== h.snapshot.sessionVersion) return no('SESSION_VERSION_CONFLICT', 'confirmation from another session version');
    return { ok: true };
  }
}
