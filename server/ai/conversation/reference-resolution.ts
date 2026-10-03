/**
 * Prompt 16 — ConversationReferenceResolver: one backend entry point for natural references.
 *
 *   train   ("12014 wali", "second wali", "ye wali", "morning wali", "last wali") → TrainReferenceResolver
 *            strictly against the CURRENT DisplayedResultsContext (old result sets are stale)
 *   class   ("CC", "chair car", "AC wali")    → ClassReferenceResolver against the selected train's classes
 *   booking ("meri latest booking", "Delhi wali ticket", "jo kal book ki thi") → BookingReferenceResolver
 *            against the session's BookingHistoryStore records
 *   "iska"  → the unique referent in current valid context, else clarification (never a guess)
 */
import type { BookingSession } from '@shared/entities';
import type { BookingRecord } from '@shared/booking-record';
import type { TrainReference } from '../decisions/agent-decision';
import { TrainReferenceResolver, type TrainRefResolution } from '../context/train-reference-resolver';
import { ClassReferenceResolver, type ClassResolution } from '../context/class-reference-resolver';
import { BookingReferenceResolver, type BookingResolution } from '../../booking/post-booking/booking-reference-resolver';

export type PronounTarget = 'BOOKING' | 'TRAIN' | 'LIVE_TRAIN';
export type PronounResolution =
  | { ok: true; kind: 'BOOKING'; bookingId: string }
  | { ok: true; kind: 'TRAIN'; trainNumber: string; source: 'SELECTED_TRAIN' | 'FOCUS_TRAIN' | 'BOOKING_RECORD' }
  | { ok: false; code: 'MISSING_CONTEXT' | 'AMBIGUOUS_REFERENCE'; message: string };

const trainOf = (s: BookingSession): string | undefined => { const t: any = s.selectedTrain; return t ? (t.number || t.trainNumber) : undefined; };

export class ConversationReferenceResolver {
  private trains = new TrainReferenceResolver();
  private classes = new ClassReferenceResolver();
  private bookings = new BookingReferenceResolver();

  train(ref: TrainReference, s: BookingSession): TrainRefResolution { return this.trains.resolve(ref, s); }

  cls(raw: string, s: BookingSession): ClassResolution | { ok: false; code: 'MISSING_CONTEXT'; message: string; available: string[] } {
    if (!s.selectedTrain) return { ok: false, code: 'MISSING_CONTEXT', message: 'Pehle train select kar lete hain, phir class choose karenge.', available: [] };
    return this.classes.resolve(raw, s.selectedTrain);
  }

  booking(records: readonly Readonly<BookingRecord>[], raw: string, activeBookingId?: string): BookingResolution {
    return this.bookings.resolve(records, raw, { activeBookingId } as any);
  }

  /** "iska …" — resolve only when exactly one valid referent exists for the requested kind. */
  pronoun(target: PronounTarget, s: BookingSession, records: readonly Readonly<BookingRecord>[]): PronounResolution {
    const active = s.activeBookingId ? records.find(r => r.bookingId === s.activeBookingId) : undefined;
    if (target === 'BOOKING') {
      if (active) return { ok: true, kind: 'BOOKING', bookingId: active.bookingId };
      if (records.length === 1) return { ok: true, kind: 'BOOKING', bookingId: records[0].bookingId };
      if (!records.length) return { ok: false, code: 'MISSING_CONTEXT', message: 'Is session mein abhi koi booking nahi hai. Kis booking ki baat kar rahe hain?' };
      return { ok: false, code: 'AMBIGUOUS_REFERENCE', message: `Kaunsi booking? ${records.map(r => `${r.train.trainNumber} (${r.journeyDate})`).join(', ')}.` };
    }
    const sel = trainOf(s);
    if (sel) return { ok: true, kind: 'TRAIN', trainNumber: sel, source: 'SELECTED_TRAIN' };
    if (s.focusTrainNumber) return { ok: true, kind: 'TRAIN', trainNumber: s.focusTrainNumber, source: 'FOCUS_TRAIN' };
    if (target === 'LIVE_TRAIN') {
      const r = active || (records.length === 1 ? records[0] : undefined);
      if (r) return { ok: true, kind: 'TRAIN', trainNumber: r.train.trainNumber, source: 'BOOKING_RECORD' };
    }
    return { ok: false, code: 'MISSING_CONTEXT', message: 'Kis train ki baat kar rahe hain? Train number ya list mein se option batayein.' };
  }
}
