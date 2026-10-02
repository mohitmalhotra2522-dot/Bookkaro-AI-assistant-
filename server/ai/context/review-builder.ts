/**
 * Compatibility shim (Prompt 8 import path). The deterministic review builder
 * now lives in the booking domain: server/booking/review-builder.ts.
 */
import type { BookingSession } from '@shared/entities';
import { reviewBuilder, type BookingReview } from '../../booking/review-builder';

export type ReviewData = BookingReview;

export function buildReview(s: BookingSession): { data: ReviewData; text: string; voiceText: string } {
  return reviewBuilder.build(s);
}
