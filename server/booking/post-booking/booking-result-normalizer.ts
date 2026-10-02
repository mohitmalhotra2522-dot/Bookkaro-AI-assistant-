/**
 * BookingResultNormalizer (Prompt 14) — the ONLY way provider-side booking data becomes a
 * NormalizedBookingResult (and therefore a BookingRecord).
 *
 * Accepted inputs:
 *   - fromExecution(): a validated BookingExecutionRecord (written exclusively by the P13
 *     lifecycle manager from schema-valid provider responses) + the immutable handoff snapshot
 *     that was submitted;
 *   - normalizeProviderResult(): a raw provider result, validated by the P12 provider schema.
 *
 * Rules: every field is validated; free text (messages, "success", HTTP 200) is never proof
 * of confirmation; CONFIRMED needs providerStatus === 'CONFIRMED'; a PNR is accepted only with
 * CONFIRMED and only as exactly 10 digits; NOT_STARTED / REQUESTED (request merely sent) and
 * IN_PROGRESS without a provider response never produce a record.
 */
import type { BookingExecutionRecord } from '@shared/booking-provider';
import type { BookingHandoffSnapshot } from '@shared/booking-execution';
import { BookingExecutionLifecycleStatus as L } from '@shared/booking-execution-lifecycle';
import type { BookingStatusSource, NormalizedBookingResult, PostBookingStatus } from '@shared/booking-record';
import { validateProviderResult, validateStatusResult } from '../provider/provider-response-schema';
import { PNR_RE } from './pnr-validator';

export type NormalizeResult =
  | { ok: true; value: Readonly<NormalizedBookingResult> }
  | { ok: false; code: 'INVALID_BOOKING_RESULT' | 'INVALID_BOOKING_STATUS' | 'BOOKING_CONTEXT_MISSING'; detail: string };

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FAILURE_RE = /^[A-Z][A-Z0-9_]{0,47}$/;
const TRAIN_RE = /^\d{5}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLASS_RE = /^[A-Z0-9]{1,3}$/;
const STATION_RE = /^[A-Z]{2,5}$/;
const ID_RE = /^[A-Za-z0-9_:.-]{1,128}$/;
const bad = (detail: string, code: 'INVALID_BOOKING_RESULT' | 'INVALID_BOOKING_STATUS' | 'BOOKING_CONTEXT_MISSING' = 'INVALID_BOOKING_RESULT') => ({ ok: false as const, code, detail });

/** Lifecycle status → post-booking read-model status (null = no record for this status). */
export function postBookingStatusFor(status: string, providerStatus?: string | null): PostBookingStatus | null {
  switch (status) {
    case L.CONFIRMED: return 'CONFIRMED';
    case L.IN_PROGRESS: return providerStatus ? 'PENDING' : null;   // only once the provider has answered
    case L.FAILED: return 'FAILED';
    case L.UNKNOWN:
    case L.MANUAL_VERIFICATION_REQUIRED: return 'UNKNOWN';
    case L.CANCELLED: return 'CANCELLED';
    case L.REQUIRES_EXTERNAL_HANDOFF: return 'EXTERNAL_HANDOFF_REQUIRED';
    default: return null;                                           // NOT_STARTED / REQUESTED
  }
}

/** Raw provider result → post-booking status (schema-validated; free text ignored). */
export function normalizeProviderResult(raw: unknown, kind: 'EXECUTION' | 'STATUS' = 'EXECUTION'):
  { ok: true; status: PostBookingStatus; pnr: string | null; providerReference: string | null; failureCode: string | null } | { ok: false; code: 'INVALID_BOOKING_RESULT'; detail: string } {
  const v = kind === 'EXECUTION' ? validateProviderResult(raw) : validateStatusResult(raw);
  if (!v.ok) return { ok: false, code: 'INVALID_BOOKING_RESULT', detail: v.detail };
  const r: any = v.value;
  const map: Record<string, PostBookingStatus> = {
    CONFIRMED: 'CONFIRMED', FAILED: 'FAILED', ACCEPTED: 'PENDING', IN_PROGRESS: 'PENDING', PENDING: 'PENDING', UNKNOWN: 'UNKNOWN',
    CANCELLED: 'CANCELLED', REQUIRES_EXTERNAL_HANDOFF: 'EXTERNAL_HANDOFF_REQUIRED', UNAVAILABLE: 'FAILED'
  };
  const status = map[r.status];
  if (!status) return { ok: false, code: 'INVALID_BOOKING_RESULT', detail: `unmapped provider status ${r.status}` };
  return { ok: true, status, pnr: status === 'CONFIRMED' && r.pnr ? r.pnr : null, providerReference: r.providerReference ?? null, failureCode: r.failureCode ?? null };
}

export class BookingResultNormalizer {
  fromExecution(rec: Readonly<BookingExecutionRecord> | null | undefined, snapshot: Readonly<BookingHandoffSnapshot> | null | undefined, source: BookingStatusSource): NormalizeResult {
    if (!rec || typeof rec !== 'object') return bad('no execution record');
    for (const k of ['bookingExecutionId', 'sessionId', 'handoffId', 'providerName'] as const) {
      if (typeof rec[k] !== 'string' || !ID_RE.test(rec[k])) return bad(`invalid ${k}`);
    }
    const status = postBookingStatusFor(rec.status, rec.providerStatus ?? null);
    if (!status) return bad(`no post-booking record for lifecycle status ${rec.status}`, 'INVALID_BOOKING_STATUS');
    // CONFIRMED needs an authoritative provider CONFIRMED (never inferred from text / HTTP status)
    if (status === 'CONFIRMED' && rec.providerStatus !== 'CONFIRMED') return bad('CONFIRMED without provider CONFIRMED status', 'INVALID_BOOKING_STATUS');
    if (rec.pnr != null) {
      if (status !== 'CONFIRMED') return bad('pnr only allowed with CONFIRMED');
      if (typeof rec.pnr !== 'string' || !PNR_RE.test(rec.pnr)) return bad('invalid pnr');
    }
    if (rec.providerReference != null && (typeof rec.providerReference !== 'string' || !REF_RE.test(rec.providerReference))) return bad('invalid providerReference');
    if (rec.failureCode != null && (typeof rec.failureCode !== 'string' || !FAILURE_RE.test(rec.failureCode))) return bad('invalid failureCode');

    // booking facts come ONLY from the immutable snapshot that was actually submitted
    if (!snapshot || snapshot.handoffId !== rec.handoffId || snapshot.sessionId !== rec.sessionId) return bad('handoff snapshot missing / mismatched', 'BOOKING_CONTEXT_MISSING');
    const t = snapshot.selectedTrain;
    if (!t || typeof t.trainNumber !== 'string' || !TRAIN_RE.test(t.trainNumber)) return bad('invalid train number');
    if (typeof snapshot.date !== 'string' || !DATE_RE.test(snapshot.date)) return bad('invalid journey date');
    if (typeof snapshot.selectedClass !== 'string' || !CLASS_RE.test(snapshot.selectedClass)) return bad('invalid class');
    const j = snapshot.journey;
    if (!j || !STATION_RE.test(String(j.origin)) || !STATION_RE.test(String(j.destination)) || j.origin === j.destination) return bad('invalid journey');
    const count = Array.isArray(snapshot.validatedPassengers) ? snapshot.validatedPassengers.length : 0;
    if (!(count >= 1 && count <= 6)) return bad('invalid passenger count');
    const f = snapshot.fareSnapshot;
    const fare = f && typeof f.total === 'number' && Number.isFinite(f.total) && f.total >= 0
      ? { total: f.total, ...(typeof f.perPassenger === 'number' ? { perPassenger: f.perPassenger } : {}), currency: String(f.currency || 'INR').slice(0, 3), passengersCount: count, ...(f.dataSource ? { dataSource: String(f.dataSource).slice(0, 16) } : {}) }
      : null;

    const value: NormalizedBookingResult = {
      executionId: rec.bookingExecutionId, sessionId: rec.sessionId, handoffId: rec.handoffId,
      idempotencyKey: typeof rec.idempotencyKey === 'string' ? rec.idempotencyKey.slice(0, 128) : '',
      providerName: rec.providerName, bookingStatus: status, statusSource: source,
      providerReference: rec.providerReference ?? null,
      pnr: status === 'CONFIRMED' ? (rec.pnr ?? null) : null,
      failureCode: status === 'CONFIRMED' ? null : (rec.failureCode ?? null),
      journey: { origin: j.origin, destination: j.destination, ...(j.originName ? { originName: String(j.originName).slice(0, 64) } : {}), ...(j.destinationName ? { destinationName: String(j.destinationName).slice(0, 64) } : {}) },
      train: { trainNumber: t.trainNumber, ...(t.trainName ? { trainName: String(t.trainName).slice(0, 64) } : {}), ...(t.departure ? { departure: String(t.departure).slice(0, 8) } : {}), ...(t.arrival ? { arrival: String(t.arrival).slice(0, 8) } : {}) },
      passengersSummary: { count },
      travelClass: snapshot.selectedClass,
      fareSummary: fare,
      journeyDate: snapshot.date,
      providerStatus: rec.providerStatus ?? null,
      at: rec.updatedAt || new Date().toISOString()
    };
    return { ok: true, value: Object.freeze(value) };
  }
}
