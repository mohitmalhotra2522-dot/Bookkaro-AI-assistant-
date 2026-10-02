/**
 * BookingProviderRequest — built ONLY from the validated BookingHandoff + READY
 * BookingHandoffSession snapshot (authoritative backend state). Never from LLM output.
 * Deep-frozen; credential-free (verified by the SensitiveDataGuard before sending).
 */
import type { BookingSession } from '@shared/entities';
import type { BookingProviderRequest } from '@shared/booking-provider';
import { deepFreeze } from '../execution/booking-handoff';

export function buildBookingProviderRequest(s: BookingSession, requestId: string, opts: { includeIdempotencyKey: boolean }): Readonly<BookingProviderRequest> | null {
  const hs = s.handoffSession;
  const h = s.handoff;
  if (!hs || !h || hs.bookingHandoffId !== h.snapshot.handoffId) return null;
  const snap = hs.bookingSnapshot;
  return deepFreeze({
    requestId,
    handoffId: h.snapshot.handoffId,
    ...(opts.includeIdempotencyKey ? { idempotencyKey: hs.idempotencyKey } : {}),
    journey: { origin: snap.journey.origin, destination: snap.journey.destination },
    date: snap.date,
    train: { ...snap.selectedTrain },
    travelClass: snap.selectedClass,
    passengers: snap.passengers.map(p => ({ ...p })),
    availabilitySnapshot: { ...snap.availabilitySnapshot },
    fareSnapshot: { ...snap.fareSnapshot }
  });
}
