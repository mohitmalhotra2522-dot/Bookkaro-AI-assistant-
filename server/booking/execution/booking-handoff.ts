/**
 * BookingHandoffService — deterministic, immutable handoff snapshots.
 *
 * - Built ONLY from the authoritative BookingSession + the validated execution
 *   request (never from LLM text). Payload completeness is cross-checked with
 *   IrctcHandoffAdapter.validateHandoff (validation only — executeHandoff is never called).
 * - The snapshot is deep-frozen; only the record's status may change:
 *     READY → INVALIDATED (booking-critical change) | EXPIRED (TTL / data age)
 *   CONSUMED is reserved for a future real executor and is never set here.
 * - expiresAt = min(createdAt + ttl, availability.retrievedAt + availabilityMaxAge,
 *   fare.retrievedAt + fareMaxAge) — a handoff never outlives the railway data it
 *   was built from. After expiry fresh railway data must be fetched again.
 */
import { createHash } from 'crypto';
import type { BookingSession } from '@shared/entities';
import type { BookingExecutionRequest, BookingHandoffRecord, BookingHandoffSnapshot, HandoffStatus, BookingExecutionErrorCode } from '@shared/booking-execution';
import { FRESHNESS_POLICY } from '@shared/constants';
import { IrctcHandoffAdapter } from '../../irctc/handoff/irctc-handoff-adapter';
import { reviewFingerprint } from '../review-builder';
import { DEFAULT_HANDOFF_TTL_MS } from './execution-config';

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as any)) deepFreeze(v);
  }
  return o;
}

/** Deterministic idempotency key: same session + same confirmed review (same data) → same key. */
export function computeIdempotencyKey(sessionId: string, reviewVersion: number, fingerprint: string): string {
  return 'bk_' + createHash('sha256').update(`${sessionId}|${reviewVersion}|${fingerprint}`).digest('hex').slice(0, 32);
}

export interface HandoffServiceOptions {
  ttlMs?: number;
  availabilityMaxAgeMs?: number;
  fareMaxAgeMs?: number;
}

export type HandoffBuildResult =
  | { ok: true; snapshot: Readonly<BookingHandoffSnapshot> }
  | { ok: false; code: BookingExecutionErrorCode; detail: string };

export class BookingHandoffService {
  private readonly ttlMs: number;
  private readonly availabilityMaxAgeMs: number;
  private readonly fareMaxAgeMs: number;
  private readonly adapter = new IrctcHandoffAdapter();

  constructor(opts: HandoffServiceOptions = {}) {
    this.ttlMs = opts.ttlMs && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_HANDOFF_TTL_MS;
    this.availabilityMaxAgeMs = opts.availabilityMaxAgeMs ?? FRESHNESS_POLICY.AVAILABILITY_MAX_AGE_MS;
    this.fareMaxAgeMs = opts.fareMaxAgeMs ?? FRESHNESS_POLICY.FARE_MAX_AGE_MS;
  }

  get handoffTtlMs(): number { return this.ttlMs; }

  build(s: BookingSession, req: BookingExecutionRequest, handoffId: string, now: number): HandoffBuildResult {
    const errs = this.adapter.validateHandoff(s);           // validation ONLY
    if (errs.length) return { ok: false, code: 'INVALID_BOOKING_HANDOFF', detail: errs.map(e => e.field).join(',') };
    const a: any = s.availability?.[req.selectedClass];
    const f: any = s.fare;
    if (!a?.retrievedAt) return { ok: false, code: 'STALE_AVAILABILITY', detail: 'availability snapshot missing' };
    if (!f?.retrievedAt || typeof f.total !== 'number') return { ok: false, code: 'STALE_FARE', detail: 'fare snapshot missing' };
    const expires = Math.min(now + this.ttlMs, Date.parse(a.retrievedAt) + this.availabilityMaxAgeMs, Date.parse(f.retrievedAt) + this.fareMaxAgeMs);
    if (!(expires > now)) return { ok: false, code: 'STALE_BOOKING_HANDOFF', detail: 'railway data too old for a handoff' };
    const snapshot: BookingHandoffSnapshot = {
      handoffId,
      sessionId: req.sessionId,
      requestId: req.requestId,
      idempotencyKey: req.idempotencyKey,
      reviewVersion: req.reviewVersion,
      sessionVersion: req.sessionVersion,
      journey: { ...req.journey },
      date: req.date,
      selectedTrain: { ...req.selectedTrain },
      selectedClass: req.selectedClass,
      validatedPassengers: req.passengers.map(p => ({ ...p })),
      availabilitySnapshot: { status: String(a.status), available: !!a.available, retrievedAt: a.retrievedAt, dataSource: a.dataSource },
      fareSnapshot: { perPassenger: f.perPassenger, total: f.total, currency: f.currency || 'INR', passengersCount: f.passengersCount, retrievedAt: f.retrievedAt, dataSource: f.dataSource },
      confirmationTimestamp: req.confirmedAt,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(expires).toISOString(),
      fingerprint: reviewFingerprint(s),
      realBooking: false
    };
    return { ok: true, snapshot: deepFreeze(snapshot) };
  }

  /**
   * Integrity check of the CURRENT handoff against the live session.
   * Returns the status the handoff should have now (does not mutate).
   */
  check(s: BookingSession, now: number): { status: HandoffStatus; reason?: string } | null {
    const h = s.handoff;
    if (!h) return null;
    if (h.status !== 'READY') return { status: h.status, reason: h.statusReason };
    if (now >= Date.parse(h.snapshot.expiresAt)) return { status: 'EXPIRED', reason: 'HANDOFF_EXPIRED' };
    if (reviewFingerprint(s) !== h.snapshot.fingerprint) return { status: 'INVALIDATED', reason: 'BOOKING_DETAILS_CHANGED' };
    if (!s.review || s.review.reviewVersion !== h.snapshot.reviewVersion || !s.review.valid) return { status: 'INVALIDATED', reason: 'REVIEW_INVALIDATED' };
    return { status: 'READY' };
  }

  /** Status-only transition; the snapshot is never touched. CONSUMED is not allowed in this milestone. */
  setStatus(s: BookingSession, status: Exclude<HandoffStatus, 'READY' | 'CONSUMED'>, reason: string, now: number): boolean {
    const h = s.handoff as BookingHandoffRecord | undefined;
    if (status !== 'INVALIDATED' && status !== 'EXPIRED') return false;      // runtime guard (CONSUMED / READY never set here)
    if (!h || h.status !== 'READY') return false;
    h.status = status;
    h.statusReason = reason;
    h.statusChangedAt = new Date(now).toISOString();
    (s.handoffHistory ||= []).push({ handoffId: h.snapshot.handoffId, status, statusReason: reason, at: h.statusChangedAt });
    return true;
  }
}
