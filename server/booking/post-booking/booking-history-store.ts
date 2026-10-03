/**
 * BookingHistoryStore (Prompt 14) — backend-owned store of normalized BookingRecords.
 *
 *  - created ONLY from a NormalizedBookingResult (BookingResultNormalizer output)
 *  - idempotent: executionId / providerName+providerReference / idempotencyKey identify a booking;
 *    a duplicate confirmation returns the existing record (never a second one)
 *  - immutable after creation: ids, provider, journey, train, class, passenger count, original fare,
 *    createdAt; providerReference / PNR / confirmedAt may only go null → value (once)
 *  - every mutation needs provider evidence for the SAME execution; CONFIRMED needs providerStatus CONFIRMED
 *  - session-scoped ownership: another session's booking → BOOKING_ACCESS_DENIED
 *  - records are deep-frozen (copy-on-write); callers can never mutate them
 * In-memory implementation (Phase 1). The interface allows a persistent store later.
 */
import { randomBytes } from 'node:crypto';
import type {
  BookingActionEvidence, BookingCurrentRepresentation, BookingRefundSummary,
  BookingLiveMeta, BookingProviderEvidence, BookingRecord, NormalizedBookingResult, PostBookingErrorCode, PostBookingStatus
} from '@shared/booking-record';
import { POST_BOOKING_STATUSES } from '@shared/booking-record';
import { PNR_RE } from './pnr-validator';
import type { CancellationStatus, ModificationStatus, RefundStatus } from '@shared/booking-lifecycle-action';

export type StoreError = { ok: false; code: PostBookingErrorCode; message: string };
export type StoreResult<T> = { ok: true; record: T; created?: boolean; changed?: boolean } | StoreError;

/** Allowed post-booking status changes (read model over the P13 lifecycle). */
const NEXT: Readonly<Record<PostBookingStatus, readonly PostBookingStatus[]>> = Object.freeze({
  PENDING: ['CONFIRMED', 'FAILED', 'UNKNOWN', 'CANCELLED', 'EXTERNAL_HANDOFF_REQUIRED'],
  UNKNOWN: ['CONFIRMED', 'FAILED', 'CANCELLED', 'PENDING'],
  CONFIRMED: ['CANCELLED'],             // only an authoritative provider cancellation
  FAILED: [], CANCELLED: [], EXTERNAL_HANDOFF_REQUIRED: []
});

export interface BookingHistoryStore {
  createBooking(n: NormalizedBookingResult): StoreResult<Readonly<BookingRecord>>;
  getBookingById(sessionId: string, bookingId: string): StoreResult<Readonly<BookingRecord>>;
  getBookingsForSession(sessionId: string): Readonly<BookingRecord>[];
  getRecentBookings(sessionId: string, limit?: number): Readonly<BookingRecord>[];
  listBookings(sessionId: string, filter?: (r: Readonly<BookingRecord>) => boolean): Readonly<BookingRecord>[];
  findByExecutionId(executionId: string): Readonly<BookingRecord> | null;
  /** Owner lookup for a PNR (never reveals the record to a non-owner). */
  pnrOwner(sessionId: string, pnr: string): 'SELF' | 'OTHER' | 'NONE';
  bookingOwner(sessionId: string, bookingId: string): 'SELF' | 'OTHER' | 'NONE';
  updateBookingStatus(sessionId: string, bookingId: string, next: PostBookingStatus, ev: BookingProviderEvidence, extra?: { failureCode?: string | null }): StoreResult<Readonly<BookingRecord>>;
  updatePnr(sessionId: string, bookingId: string, pnr: string, ev: BookingProviderEvidence): StoreResult<Readonly<BookingRecord>>;
  updateProviderReference(sessionId: string, bookingId: string, ref: string, ev: BookingProviderEvidence): StoreResult<Readonly<BookingRecord>>;
  markUnknown(sessionId: string, bookingId: string, ev: BookingProviderEvidence): StoreResult<Readonly<BookingRecord>>;
  markCancelled(sessionId: string, bookingId: string, ev: BookingProviderEvidence): StoreResult<Readonly<BookingRecord>>;
  updateLiveMeta(sessionId: string, bookingId: string, meta: BookingLiveMeta): StoreResult<Readonly<BookingRecord>>;
  // ---- Prompt 15: lifecycle-action updates (evidence-guarded; history never rewritten) ----
  updateCancellationStatus(sessionId: string, bookingId: string, next: CancellationStatus, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>>;
  /** Provider-confirmed cancellation: cancellationStatus CANCELLED + bookingStatus CANCELLED (source PROVIDER_ACTION). */
  applyCancellation(sessionId: string, bookingId: string, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>>;
  updateModificationStatus(sessionId: string, bookingId: string, next: ModificationStatus, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>>;
  /** Provider-confirmed modification: sets the CURRENT representation only; original fields stay. */
  applyModification(sessionId: string, bookingId: string, current: Omit<BookingCurrentRepresentation, 'updatedAt'>, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>>;
  updateRefundStatus(sessionId: string, bookingId: string, next: RefundStatus, summary: Omit<BookingRefundSummary, 'checkedAt'> | null, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>>;
}

const CANCEL_STATUSES: readonly CancellationStatus[] = ['NOT_REQUESTED', 'PENDING', 'CANCELLED', 'FAILED', 'UNKNOWN', 'MANUAL_VERIFICATION_REQUIRED'];
const MODIFY_STATUSES: readonly ModificationStatus[] = ['NOT_REQUESTED', 'PENDING', 'MODIFIED', 'FAILED', 'UNKNOWN', 'MANUAL_VERIFICATION_REQUIRED'];
const REFUND_STATUSES: readonly RefundStatus[] = ['NOT_AVAILABLE', 'NOT_INITIATED', 'PENDING', 'PROCESSED', 'FAILED', 'UNKNOWN'];
/** Statuses that need an authoritative PROVIDER_ACTION result with the matching provider status. */
const CANCEL_EVIDENCE: Partial<Record<CancellationStatus, string>> = { PENDING: 'PENDING', CANCELLED: 'CANCELLED', FAILED: 'FAILED' };
const MODIFY_EVIDENCE: Partial<Record<ModificationStatus, string>> = { PENDING: 'PENDING', MODIFIED: 'MODIFIED', FAILED: 'FAILED' };

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as any)) deepFreeze(v);
  }
  return o;
}
const err = (code: PostBookingErrorCode, message: string): StoreError => ({ ok: false, code, message });
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class InMemoryBookingHistoryStore implements BookingHistoryStore {
  private readonly byId = new Map<string, Readonly<BookingRecord>>();
  private readonly byExecution = new Map<string, string>();
  private readonly byRef = new Map<string, string>();
  private readonly byIdem = new Map<string, string>();

  constructor(private readonly clock: () => number = () => Date.now(), private readonly maxPerSession = 50) {}

  private iso() { return new Date(this.clock()).toISOString(); }

  createBooking(n: NormalizedBookingResult): StoreResult<Readonly<BookingRecord>> {
    if (!n || !(POST_BOOKING_STATUSES as readonly string[]).includes(n.bookingStatus)) return err('INVALID_BOOKING_STATUS', 'Invalid booking status.');
    if (n.bookingStatus === 'CONFIRMED' && n.providerStatus !== 'CONFIRMED') return err('AUTHORITATIVE_DATA_REQUIRED', 'CONFIRMED requires provider evidence.');
    if (n.pnr != null && (n.bookingStatus !== 'CONFIRMED' || !PNR_RE.test(n.pnr))) return err('INVALID_BOOKING_RESULT', 'PNR only from a provider-confirmed booking.');
    // idempotency: same execution / provider reference / idempotency key → same booking
    const existingId = this.byExecution.get(n.executionId)
      || (n.providerReference ? this.byRef.get(`${n.providerName}:${n.providerReference}`) : undefined)
      || (n.idempotencyKey ? this.byIdem.get(n.idempotencyKey) : undefined);
    if (existingId) {
      const ex = this.byId.get(existingId)!;
      if (ex.sessionId !== n.sessionId) return err('BOOKING_RECORD_CONFLICT', 'Booking identifier belongs to a different session.');
      // matched by providerReference / idempotencyKey = the same provider booking: facts must agree
      const conflict = ex.providerName !== n.providerName
        || !sameJson(ex.journey, n.journey) || ex.train.trainNumber !== n.train.trainNumber || ex.travelClass !== n.travelClass
        || ex.passengersSummary.count !== n.passengersSummary.count || ex.journeyDate !== n.journeyDate
        || (ex.fareSummary?.total ?? null) !== (n.fareSummary?.total ?? null)
        || (ex.providerReference && n.providerReference && ex.providerReference !== n.providerReference)
        || (ex.pnr && n.pnr && ex.pnr !== n.pnr);
      if (conflict) return err('BOOKING_RECORD_CONFLICT', 'Conflicting data for an existing booking record (immutable fields).');
      return { ok: true, record: ex, created: false, changed: false };
    }
    const at = this.iso();
    const rec: BookingRecord = deepFreeze({
      bookingId: 'bk_' + randomBytes(10).toString('hex'),
      sessionId: n.sessionId, executionId: n.executionId, handoffId: n.handoffId, idempotencyKey: n.idempotencyKey,
      providerName: n.providerName,
      journey: { ...n.journey }, train: { ...n.train }, passengersSummary: { count: n.passengersSummary.count },
      travelClass: n.travelClass, fareSummary: n.fareSummary ? { ...n.fareSummary } : null, journeyDate: n.journeyDate,
      bookingCreatedAt: at,
      providerReference: n.providerReference, pnr: n.bookingStatus === 'CONFIRMED' ? n.pnr : null,
      confirmedAt: n.bookingStatus === 'CONFIRMED' ? at : null,
      bookingStatus: n.bookingStatus, statusSource: n.statusSource, failureCode: n.failureCode,
      lastUpdatedAt: at, liveMeta: {},
      cancellationStatus: 'NOT_REQUESTED', modificationStatus: 'NOT_REQUESTED', refundStatus: 'NOT_AVAILABLE',
      refundSummary: null, current: null
    });
    this.index(rec);
    this.trim(n.sessionId);
    return { ok: true, record: rec, created: true, changed: true };
  }

  getBookingById(sessionId: string, bookingId: string): StoreResult<Readonly<BookingRecord>> {
    const r = typeof bookingId === 'string' ? this.byId.get(bookingId) : undefined;
    if (!r) return err('BOOKING_NOT_FOUND', 'Booking record nahi mila.');
    if (r.sessionId !== sessionId) return err('BOOKING_ACCESS_DENIED', 'Yeh booking is session ki nahi hai.');
    return { ok: true, record: r };
  }

  getBookingsForSession(sessionId: string): Readonly<BookingRecord>[] {
    return [...this.byId.values()].filter(r => r.sessionId === sessionId)
      .sort((a, b) => b.bookingCreatedAt.localeCompare(a.bookingCreatedAt) || this.seq(b) - this.seq(a));
  }

  getRecentBookings(sessionId: string, limit = 5): Readonly<BookingRecord>[] {
    return this.getBookingsForSession(sessionId).slice(0, Math.max(1, Math.min(20, limit)));
  }

  listBookings(sessionId: string, filter?: (r: Readonly<BookingRecord>) => boolean): Readonly<BookingRecord>[] {
    const all = this.getBookingsForSession(sessionId);
    return filter ? all.filter(filter) : all;
  }

  findByExecutionId(executionId: string): Readonly<BookingRecord> | null {
    const id = this.byExecution.get(executionId);
    return id ? this.byId.get(id) || null : null;
  }

  pnrOwner(sessionId: string, pnr: string): 'SELF' | 'OTHER' | 'NONE' {
    let other = false;
    for (const r of this.byId.values()) if (r.pnr === pnr) { if (r.sessionId === sessionId) return 'SELF'; other = true; }
    return other ? 'OTHER' : 'NONE';
  }

  bookingOwner(sessionId: string, bookingId: string): 'SELF' | 'OTHER' | 'NONE' {
    const r = this.byId.get(bookingId);
    return !r ? 'NONE' : r.sessionId === sessionId ? 'SELF' : 'OTHER';
  }

  updateBookingStatus(sessionId: string, bookingId: string, next: PostBookingStatus, ev: BookingProviderEvidence, extra: { failureCode?: string | null } = {}): StoreResult<Readonly<BookingRecord>> {
    const g = this.guard(sessionId, bookingId, ev);
    if (!g.ok) return g;
    const cur = g.record;
    if (!(POST_BOOKING_STATUSES as readonly string[]).includes(next)) return err('INVALID_BOOKING_STATUS', 'Invalid booking status.');
    if (cur.bookingStatus === next) return { ok: true, record: cur, changed: false };
    if (next === 'CONFIRMED' && ev.providerStatus !== 'CONFIRMED') return err('AUTHORITATIVE_DATA_REQUIRED', 'CONFIRMED requires provider CONFIRMED evidence.');
    if (!NEXT[cur.bookingStatus].includes(next)) {
      return NEXT[cur.bookingStatus].length === 0
        ? err('BOOKING_RECORD_NOT_MUTABLE', `Booking ${cur.bookingStatus} hai — status ab nahi badal sakta.`)
        : err('INVALID_BOOKING_STATUS', `Status ${cur.bookingStatus} → ${next} allowed nahi hai.`);
    }
    const at = this.iso();
    return this.write(cur, {
      bookingStatus: next, statusSource: ev.source, lastUpdatedAt: at,
      ...(next === 'CONFIRMED' ? { confirmedAt: cur.confirmedAt ?? at, failureCode: null } : {}),
      ...(next === 'FAILED' || next === 'CANCELLED' || next === 'EXTERNAL_HANDOFF_REQUIRED' ? { failureCode: extra.failureCode ?? cur.failureCode } : {})
    });
  }

  updatePnr(sessionId: string, bookingId: string, pnr: string, ev: BookingProviderEvidence): StoreResult<Readonly<BookingRecord>> {
    const g = this.guard(sessionId, bookingId, ev);
    if (!g.ok) return g;
    const cur = g.record;
    if (typeof pnr !== 'string' || !PNR_RE.test(pnr)) return err('INVALID_PNR', 'Invalid PNR from provider.');
    if (cur.bookingStatus !== 'CONFIRMED' || ev.providerStatus !== 'CONFIRMED') return err('AUTHORITATIVE_DATA_REQUIRED', 'PNR only for a provider-confirmed booking.');
    if (cur.pnr === pnr) return { ok: true, record: cur, changed: false };
    if (cur.pnr) return err('BOOKING_RECORD_CONFLICT', 'PNR already attached — it cannot change.');
    return this.write(cur, { pnr, lastUpdatedAt: this.iso() });
  }

  updateProviderReference(sessionId: string, bookingId: string, ref: string, ev: BookingProviderEvidence): StoreResult<Readonly<BookingRecord>> {
    const g = this.guard(sessionId, bookingId, ev);
    if (!g.ok) return g;
    const cur = g.record;
    if (typeof ref !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ref)) return err('INVALID_BOOKING_RESULT', 'Invalid provider reference.');
    if (cur.providerReference === ref) return { ok: true, record: cur, changed: false };
    if (cur.providerReference) return err('BOOKING_RECORD_NOT_MUTABLE', 'Provider reference is immutable once set.');
    const clash = this.byRef.get(`${cur.providerName}:${ref}`);
    if (clash && clash !== cur.bookingId) return err('BOOKING_RECORD_CONFLICT', 'Provider reference already belongs to another booking.');
    return this.write(cur, { providerReference: ref, lastUpdatedAt: this.iso() });
  }

  markUnknown(sessionId: string, bookingId: string, ev: BookingProviderEvidence) { return this.updateBookingStatus(sessionId, bookingId, 'UNKNOWN', ev); }
  markCancelled(sessionId: string, bookingId: string, ev: BookingProviderEvidence) {
    if (ev?.providerStatus !== 'CANCELLED') return err('AUTHORITATIVE_DATA_REQUIRED', 'Cancellation requires an authoritative provider CANCELLED status.');
    return this.updateBookingStatus(sessionId, bookingId, 'CANCELLED', ev);
  }

  updateLiveMeta(sessionId: string, bookingId: string, meta: BookingLiveMeta): StoreResult<Readonly<BookingRecord>> {
    const g = this.getBookingById(sessionId, bookingId);
    if (!g.ok) return g;
    const clean: BookingLiveMeta = {};
    if (typeof meta.lastPnrCheckAt === 'string') clean.lastPnrCheckAt = meta.lastPnrCheckAt;
    if (typeof meta.lastPnrCheckOk === 'boolean') clean.lastPnrCheckOk = meta.lastPnrCheckOk;
    if (typeof meta.lastLiveStatusAt === 'string') clean.lastLiveStatusAt = meta.lastLiveStatusAt;
    return this.write(g.record, { liveMeta: { ...g.record.liveMeta, ...clean } });
  }

  // ---------------------------------------------------------------------------
  // Prompt 15 — lifecycle-action updates
  // ---------------------------------------------------------------------------

  private actionGuard(sessionId: string, bookingId: string, ev: BookingActionEvidence, next: string, required?: string): StoreResult<Readonly<BookingRecord>> {
    const g = this.getBookingById(sessionId, bookingId);
    if (!g.ok) return g;
    if (!ev || typeof ev.actionId !== 'string' || !ev.actionId || (ev.source !== 'PROVIDER_ACTION' && ev.source !== 'ACTION_OUTCOME_UNCERTAIN')) {
      return err('AUTHORITATIVE_DATA_REQUIRED', 'Lifecycle update requires provider action evidence.');
    }
    if (required !== undefined && (ev.source !== 'PROVIDER_ACTION' || ev.providerStatus !== required)) {
      return err('AUTHORITATIVE_DATA_REQUIRED', `${next} requires an authoritative provider ${required} result.`);
    }
    if (required === undefined && ev.source === 'ACTION_OUTCOME_UNCERTAIN' && next !== 'UNKNOWN' && next !== 'MANUAL_VERIFICATION_REQUIRED') {
      return err('AUTHORITATIVE_DATA_REQUIRED', 'Uncertain outcomes may only record UNKNOWN / MANUAL_VERIFICATION_REQUIRED.');
    }
    return g;
  }

  updateCancellationStatus(sessionId: string, bookingId: string, next: CancellationStatus, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>> {
    if (!CANCEL_STATUSES.includes(next) || next === 'NOT_REQUESTED') return err('INVALID_BOOKING_STATUS', 'Invalid cancellation status.');
    if (next === 'CANCELLED') return this.applyCancellation(sessionId, bookingId, ev);
    const g = this.actionGuard(sessionId, bookingId, ev, next, CANCEL_EVIDENCE[next]);
    if (!g.ok) return g;
    const cur = g.record;
    if (cur.cancellationStatus === 'CANCELLED' || cur.bookingStatus === 'CANCELLED') return err('BOOKING_RECORD_NOT_MUTABLE', 'Booking already cancelled — cancellation status ab nahi badal sakta.');
    if (cur.cancellationStatus === next) return { ok: true, record: cur, changed: false };
    return this.write(cur, { cancellationStatus: next, lastUpdatedAt: this.iso() });
  }

  applyCancellation(sessionId: string, bookingId: string, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>> {
    const g = this.actionGuard(sessionId, bookingId, ev, 'CANCELLED', 'CANCELLED');
    if (!g.ok) return g;
    const cur = g.record;
    if (cur.cancellationStatus === 'CANCELLED' && cur.bookingStatus === 'CANCELLED') return { ok: true, record: cur, changed: false };
    if (cur.bookingStatus !== 'CONFIRMED' && cur.bookingStatus !== 'CANCELLED') return err('INVALID_BOOKING_STATUS', `Booking ${cur.bookingStatus} — provider cancellation cannot apply.`);
    // History preserved: journey / train / createdAt / providerReference / PNR / fare untouched.
    return this.write(cur, { bookingStatus: 'CANCELLED', statusSource: 'PROVIDER_ACTION', cancellationStatus: 'CANCELLED', lastUpdatedAt: this.iso() });
  }

  updateModificationStatus(sessionId: string, bookingId: string, next: ModificationStatus, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>> {
    if (!MODIFY_STATUSES.includes(next) || next === 'NOT_REQUESTED') return err('INVALID_BOOKING_STATUS', 'Invalid modification status.');
    if (next === 'MODIFIED') return err('AUTHORITATIVE_DATA_REQUIRED', 'MODIFIED only via applyModification with provider evidence.');
    const g = this.actionGuard(sessionId, bookingId, ev, next, MODIFY_EVIDENCE[next]);
    if (!g.ok) return g;
    const cur = g.record;
    if (cur.bookingStatus === 'CANCELLED') return err('BOOKING_RECORD_NOT_MUTABLE', 'Cancelled booking — modification status ab nahi badal sakta.');
    if (cur.modificationStatus === next) return { ok: true, record: cur, changed: false };
    return this.write(cur, { modificationStatus: next, lastUpdatedAt: this.iso() });
  }

  applyModification(sessionId: string, bookingId: string, current: Omit<BookingCurrentRepresentation, 'updatedAt'>, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>> {
    const g = this.actionGuard(sessionId, bookingId, ev, 'MODIFIED', 'MODIFIED');
    if (!g.ok) return g;
    const cur = g.record;
    if (cur.bookingStatus !== 'CONFIRMED') return err('INVALID_BOOKING_STATUS', `Booking ${cur.bookingStatus} — modification cannot apply.`);
    if (!current || !/^\d{4}-\d{2}-\d{2}$/.test(current.journeyDate) || typeof current.travelClass !== 'string' || !current.travelClass
      || !Number.isInteger(current.passengersCount) || current.passengersCount < 1 || !current.modificationId) {
      return err('INVALID_BOOKING_RESULT', 'Invalid modified booking representation.');
    }
    const at = this.iso();
    return this.write(cur, {
      modificationStatus: 'MODIFIED', lastUpdatedAt: at,
      current: { journeyDate: current.journeyDate, travelClass: current.travelClass, passengersCount: current.passengersCount, modificationId: current.modificationId, updatedAt: at }
    });
  }

  updateRefundStatus(sessionId: string, bookingId: string, next: RefundStatus, summary: Omit<BookingRefundSummary, 'checkedAt'> | null, ev: BookingActionEvidence): StoreResult<Readonly<BookingRecord>> {
    if (!REFUND_STATUSES.includes(next) || next === 'NOT_AVAILABLE') return err('INVALID_BOOKING_STATUS', 'Invalid refund status.');
    const g = this.actionGuard(sessionId, bookingId, ev, next, next === 'UNKNOWN' ? undefined : next);
    if (!g.ok) return g;
    const at = this.iso();
    const clean: BookingRefundSummary | null = summary
      ? { amount: typeof summary.amount === 'number' && Number.isFinite(summary.amount) && summary.amount >= 0 ? summary.amount : null, currency: typeof summary.currency === 'string' ? summary.currency.slice(0, 3) : null, checkedAt: at }
      : { amount: null, currency: null, checkedAt: at };
    return this.write(g.record, { refundStatus: next, refundSummary: clean, lastUpdatedAt: at });
  }

  // ---------------------------------------------------------------------------

  private guard(sessionId: string, bookingId: string, ev: BookingProviderEvidence): StoreResult<Readonly<BookingRecord>> {
    const g = this.getBookingById(sessionId, bookingId);
    if (!g.ok) return g;
    if (!ev || (ev.source !== 'PROVIDER_EXECUTION' && ev.source !== 'PROVIDER_RECONCILIATION') || ev.executionId !== g.record.executionId) {
      return err('AUTHORITATIVE_DATA_REQUIRED', 'Update requires provider evidence for this booking execution.');
    }
    return g;
  }

  /** Copy-on-write: only the listed MUTABLE fields can be passed here. */
  private write(cur: Readonly<BookingRecord>, patch: Partial<Pick<BookingRecord, 'bookingStatus' | 'statusSource' | 'failureCode' | 'lastUpdatedAt' | 'pnr' | 'providerReference' | 'confirmedAt' | 'liveMeta'
    | 'cancellationStatus' | 'modificationStatus' | 'refundStatus' | 'refundSummary' | 'current'>>): StoreResult<Readonly<BookingRecord>> {
    const next = deepFreeze({ ...cur, ...patch, liveMeta: { ...(patch.liveMeta ?? cur.liveMeta) } }) as BookingRecord;
    this.byId.set(cur.bookingId, next);
    this.index(next);
    return { ok: true, record: next, changed: true };
  }

  private order = new Map<string, number>();
  private counter = 0;
  private seq(r: Readonly<BookingRecord>) { return this.order.get(r.bookingId) ?? 0; }

  private index(r: Readonly<BookingRecord>) {
    this.byId.set(r.bookingId, r);
    if (!this.order.has(r.bookingId)) this.order.set(r.bookingId, ++this.counter);
    this.byExecution.set(r.executionId, r.bookingId);
    if (r.providerReference) this.byRef.set(`${r.providerName}:${r.providerReference}`, r.bookingId);
    if (r.idempotencyKey) this.byIdem.set(r.idempotencyKey, r.bookingId);
  }

  private trim(sessionId: string) {
    const all = this.getBookingsForSession(sessionId);
    for (const r of all.slice(this.maxPerSession)) {
      this.byId.delete(r.bookingId); this.byExecution.delete(r.executionId); this.order.delete(r.bookingId);
      if (r.providerReference) this.byRef.delete(`${r.providerName}:${r.providerReference}`);
      if (r.idempotencyKey) this.byIdem.delete(r.idempotencyKey);
    }
  }
}
