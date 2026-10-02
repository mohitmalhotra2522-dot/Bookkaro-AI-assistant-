/**
 * BookingConfirmationService — deterministic confirmation records.
 *
 * A BookingConfirmation is created ONLY by the backend, ONLY when:
 *   state === AWAITING_CONFIRMATION, a valid current review exists, the review
 *   version the user saw equals the current one, and the reply was classified
 *   EXPLICIT by the backend ConfirmationPolicy (the LLM never creates it).
 * Status: VALID → INVALIDATED (any booking-critical change / rejection) | EXPIRED (handoff session expired).
 */
import { randomBytes } from 'crypto';
import { BookingState } from '@shared/states';
import type { BookingSession } from '@shared/entities';
import type { BookingConfirmation } from '@shared/booking-handoff-session';
import { reviewFingerprint } from '../review-builder';

export type ConfirmationCreateResult =
  | { ok: true; confirmation: BookingConfirmation }
  | { ok: false; code: 'INVALID_CONFIRMATION' | 'CONFIRMATION_VERSION_MISMATCH' | 'BOOKING_DATA_CHANGED'; detail: string };

export class BookingConfirmationService {
  create(s: BookingSession, opts: { requestId: string; now: number; reviewVersion?: number }): ConfirmationCreateResult {
    if (s.bookingState !== BookingState.AWAITING_CONFIRMATION) return { ok: false, code: 'INVALID_CONFIRMATION', detail: `state ${s.bookingState}` };
    const rv = s.review;
    if (!rv || !rv.valid) return { ok: false, code: 'INVALID_CONFIRMATION', detail: 'no valid review' };
    if (s.confirmedReviewVersion !== rv.reviewVersion || (typeof opts.reviewVersion === 'number' && opts.reviewVersion !== rv.reviewVersion)) {
      return { ok: false, code: 'CONFIRMATION_VERSION_MISMATCH', detail: 'confirmation does not belong to the current review' };
    }
    if (reviewFingerprint(s) !== rv.fingerprint) return { ok: false, code: 'BOOKING_DATA_CHANGED', detail: 'booking data changed since review' };
    const at = new Date(opts.now).toISOString();
    if (s.confirmation && s.confirmation.status === 'VALID') this.setStatus(s, 'INVALIDATED', 'SUPERSEDED', opts.now);
    const confirmation: BookingConfirmation = {
      confirmationId: `cf_${randomBytes(12).toString('hex')}`,
      sessionId: s.sessionId,
      requestId: opts.requestId,
      reviewVersion: rv.reviewVersion,
      sessionVersion: s.sessionVersion,
      reviewFingerprint: rv.fingerprint,
      confirmedAt: at,
      status: 'VALID'
    };
    s.confirmation = confirmation;
    return { ok: true, confirmation };
  }

  setStatus(s: BookingSession, status: 'INVALIDATED' | 'EXPIRED', reason: string, now: number): boolean {
    const c = s.confirmation;
    if (!c || c.status !== 'VALID') return false;
    c.status = status;
    c.statusReason = reason;
    c.statusChangedAt = new Date(now).toISOString();
    return true;
  }
}
