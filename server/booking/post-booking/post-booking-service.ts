/**
 * PostBookingService (Prompt 14) — backend-controlled post-booking experience.
 *
 *  1. Sync: listens to the P13 BookingExecutionLifecycleManager (the only writer of execution
 *     status) and turns AUTHORITATIVE execution records into BookingRecords via the
 *     BookingResultNormalizer → BookingHistoryStore (idempotent, evidence-gated).
 *  2. Controlled history query interface (NOT an LLM tool): getLatestBooking, getRecentBookings,
 *     findBookingsByJourney / Date / Train, getBookingDetails.
 *  3. Conversation: deterministic answers from records ("Ticket book ho gayi?", "PNR kya hai?"),
 *     booking-reference resolution, and grounding for the read-only CHECK_PNR / TRACK_TRAIN tools.
 *  4. LLM context: AUTHORITATIVE_BACKEND_CONTEXT summary — no PNR values, no credentials.
 *
 * PNRs are masked in every event. The service never executes, cancels or re-submits a booking.
 */
import type { BookingSession } from '@shared/entities';
import type { BookingExecutionRecord } from '@shared/booking-provider';
import type { BookingDetailsResponse, BookingProviderEvidence, BookingRecord, BookingStatusSource, PostBookingErrorCode } from '@shared/booking-record';
import { STATUS_LABEL } from '@shared/booking-record';
import { BookingExecutionLifecycleStatus as L, UNRESOLVED_EXECUTION } from '@shared/booking-execution-lifecycle';
import type { ConversationStateManager } from '../../ai/state/conversation-state';
import type { BookingExecutionLifecycleManager, LifecycleCtx } from '../lifecycle/booking-execution-lifecycle-manager';
import { BookingResultNormalizer } from './booking-result-normalizer';
import { InMemoryBookingHistoryStore, type BookingHistoryStore } from './booking-history-store';
import { BookingReferenceResolver, type BookingResolution } from './booking-reference-resolver';
import { maskPnr, extractPnrCandidate, normalizePnrInput, INVALID_PNR_MESSAGE } from './pnr-validator';
import { classifyPostBookingQuery, isPlanningQuestion, INFO_KINDS, POST_BOOKING_READ_ONLY_TOOLS, type PostBookingQueryKind } from './post-booking-conversation';
import { humanDate, shortName } from '../../ai/context/response-formatter';

type Emit = (type: any, data?: Record<string, any>) => void;

export interface PostBookingContextView {
  source: 'AUTHORITATIVE_BACKEND_CONTEXT';
  kind: 'BOOKING_HISTORY';
  readOnly: true;
  rules: string;
  activeBookingId: string | null;
  bookings: Array<{
    bookingId: string; status: string; trainNumber: string; trainName?: string; origin: string; destination: string;
    journeyDate: string; travelClass: string; passengersCount: number; fareTotal: number | null; pnrAvailable: boolean; bookingCreatedAt: string;
  }>;
  pendingClarification?: { kind: PostBookingQueryKind; candidates: Array<{ bookingId: string; trainNumber: string; journeyDate: string }> };
}

/** Grounding handed to ToolCallValidator for CHECK_PNR / TRACK_TRAIN (no PNR leaves the backend via the LLM). */
export interface ToolGrounding {
  userText: string;
  activeBookingId?: string;
  bookings: Array<{ bookingId: string; pnr: string | null; trainNumber: string; status: string }>;
  pnrOwner: (pnr: string) => 'SELF' | 'OTHER' | 'NONE';
  bookingOwner: (bookingId: string) => 'SELF' | 'OTHER' | 'NONE';
}

export type PostBookingTurn =
  | { type: 'DEFER' }
  | { type: 'DIRECT'; kind: PostBookingQueryKind; answer: string; softError?: { code: PostBookingErrorCode; message: string } }
  | { type: 'INFO'; kind: PostBookingQueryKind; allowedTools: readonly string[]; bookingId?: string }
  | { type: 'ERROR'; kind: PostBookingQueryKind; code: PostBookingErrorCode; message: string };

export interface PostBookingOptions {
  store?: BookingHistoryStore;
  clock?: () => number;
}

export class PostBookingService {
  readonly store: BookingHistoryStore;
  private readonly normalizer = new BookingResultNormalizer();
  private readonly resolver = new BookingReferenceResolver();
  private readonly clock: () => number;
  private readonly syncErrors: Array<{ at: string; sessionId: string; executionId: string; code: string }> = [];

  constructor(private readonly state: ConversationStateManager, opts: PostBookingOptions = {}) {
    this.clock = opts.clock || (() => Date.now());
    this.store = opts.store || new InMemoryBookingHistoryStore(this.clock);
  }

  /** Subscribe to the P13 lifecycle (single writer of execution status). */
  attach(lifecycle: BookingExecutionLifecycleManager): void {
    lifecycle.onChange((s, rec, prev, ctx) => this.syncFromExecution(s, rec, prev, ctx));
  }

  syncLog() { return [...this.syncErrors]; }

  // =========================================================================
  // 1. Sync from authoritative execution records
  // =========================================================================

  syncFromExecution(s: BookingSession, rec: Readonly<BookingExecutionRecord>, _prev: string, ctx?: LifecycleCtx): void {
    const emit: Emit = (type, data) => ctx?.emit ? ctx.emit(type, data) : this.state.emit(s.sessionId, type, ctx?.turnId || 'post-booking', data);
    const source: BookingStatusSource = rec.reconciliationAttempts > 0 ? 'PROVIDER_RECONCILIATION' : 'PROVIDER_EXECUTION';
    const n = this.normalizer.fromExecution(rec, s.handoff?.snapshot, source);
    if (!n.ok) {
      // REQUESTED / IN_PROGRESS-before-provider-answer produce no record (not an error)
      if (n.code !== 'INVALID_BOOKING_STATUS' || rec.status === L.CONFIRMED) this.logSync(s.sessionId, rec.bookingExecutionId, n.code);
      return;
    }
    let existing: Readonly<BookingRecord> | null;
    try { existing = this.store.findByExecutionId(rec.bookingExecutionId); }
    catch { this.logSync(s.sessionId, rec.bookingExecutionId, 'BOOKING_HISTORY_UNAVAILABLE'); return; }
    const v = n.value;
    try {
      if (!existing) {
        const c = this.store.createBooking(v);
        if (!c.ok) { this.logSync(s.sessionId, rec.bookingExecutionId, c.code); return; }
        if (!c.created) return;
        const r = c.record;
        this.link(s, r.bookingId);
        emit('BOOKING_RECORD_CREATED', { bookingId: r.bookingId, status: r.bookingStatus, providerName: r.providerName, statusSource: r.statusSource });
        if (r.bookingStatus === 'CONFIRMED') emit('BOOKING_CONFIRMED', { bookingId: r.bookingId, pnrAvailable: !!r.pnr });
        if (r.bookingStatus === 'FAILED') emit('BOOKING_FAILED', { bookingId: r.bookingId, failureCode: r.failureCode });
        if (r.pnr) emit('PNR_ATTACHED', { bookingId: r.bookingId, pnrMasked: maskPnr(r.pnr) });
        return;
      }
      const ev: BookingProviderEvidence = { source, executionId: rec.bookingExecutionId, providerStatus: v.providerStatus };
      if (v.providerReference && !existing.providerReference) {
        const u = this.store.updateProviderReference(s.sessionId, existing.bookingId, v.providerReference, ev);
        if (!u.ok) this.logSync(s.sessionId, rec.bookingExecutionId, u.code);
      }
      if (v.bookingStatus !== existing.bookingStatus) {
        const u = this.store.updateBookingStatus(s.sessionId, existing.bookingId, v.bookingStatus, ev, { failureCode: v.failureCode });
        if (!u.ok) { this.logSync(s.sessionId, rec.bookingExecutionId, u.code); return; }
        emit('BOOKING_STATUS_UPDATED', { bookingId: existing.bookingId, previousStatus: existing.bookingStatus, newStatus: v.bookingStatus, statusSource: source });
        if (v.bookingStatus === 'CONFIRMED') emit('BOOKING_CONFIRMED', { bookingId: existing.bookingId, pnrAvailable: !!v.pnr });
        if (v.bookingStatus === 'FAILED') emit('BOOKING_FAILED', { bookingId: existing.bookingId, failureCode: v.failureCode });
      }
      if (v.pnr && !existing.pnr) {
        const u = this.store.updatePnr(s.sessionId, existing.bookingId, v.pnr, ev);
        if (u.ok && u.changed) emit('PNR_ATTACHED', { bookingId: existing.bookingId, pnrMasked: maskPnr(v.pnr) });
        else if (!u.ok) this.logSync(s.sessionId, rec.bookingExecutionId, u.code);
      }
      this.link(s, existing.bookingId);
    } catch {
      this.logSync(s.sessionId, rec.bookingExecutionId, 'BOOKING_HISTORY_UNAVAILABLE');
    }
  }

  private link(s: BookingSession, bookingId: string) {
    const ids = s.bookingRecordIds || (s.bookingRecordIds = []);
    if (!ids.includes(bookingId)) ids.push(bookingId);
    s.activeBookingId = bookingId;
  }

  private logSync(sessionId: string, executionId: string, code: string) {
    this.syncErrors.push({ at: new Date(this.clock()).toISOString(), sessionId, executionId, code });
    if (this.syncErrors.length > 200) this.syncErrors.splice(0, this.syncErrors.length - 200);
  }

  // =========================================================================
  // 2. Controlled history query interface (backend only — never an LLM tool)
  // =========================================================================

  getLatestBooking(sessionId: string): Readonly<BookingRecord> | null { return this.records(sessionId)[0] || null; }
  getRecentBookings(sessionId: string, limit = 5): Readonly<BookingRecord>[] { return this.store.getRecentBookings(sessionId, limit); }
  findBookingsByJourney(sessionId: string, q: { origin?: string; destination?: string }): Readonly<BookingRecord>[] {
    return this.store.listBookings(sessionId, r => (!q.origin || r.journey.origin === q.origin) && (!q.destination || r.journey.destination === q.destination));
  }
  findBookingsByDate(sessionId: string, date: string): Readonly<BookingRecord>[] { return this.store.listBookings(sessionId, r => r.journeyDate === date); }
  findBookingsByTrain(sessionId: string, trainNumber: string): Readonly<BookingRecord>[] { return this.store.listBookings(sessionId, r => r.train.trainNumber === trainNumber); }
  getBookingDetails(sessionId: string, bookingId: string, opts: { revealPnr?: boolean } = {}):
    { ok: true; details: BookingDetailsResponse } | { ok: false; code: PostBookingErrorCode; message: string } {
    try {
      const g = this.store.getBookingById(sessionId, bookingId);
      if (!g.ok) return g;
      return { ok: true, details: this.toDetails(g.record, !!opts.revealPnr) };
    } catch { return { ok: false, code: 'BOOKING_HISTORY_UNAVAILABLE', message: 'Booking history abhi available nahi hai.' }; }
  }
  /** History list for the frontend: masked PNRs only. */
  listDetails(sessionId: string): BookingDetailsResponse[] { return this.records(sessionId).map(r => this.toDetails(r, false)); }

  toDetails(r: Readonly<BookingRecord>, revealPnr: boolean): BookingDetailsResponse {
    return {
      bookingId: r.bookingId, status: r.bookingStatus, statusLabel: STATUS_LABEL[r.bookingStatus], providerName: r.providerName,
      pnr: r.pnr ? (revealPnr ? r.pnr : maskPnr(r.pnr)) : null, pnrMasked: maskPnr(r.pnr), pnrAvailable: !!r.pnr,
      journey: { ...r.journey }, train: { ...r.train }, travelClass: r.travelClass, passengersCount: r.passengersSummary.count,
      fare: r.fareSummary ? { total: r.fareSummary.total, ...(r.fareSummary.perPassenger !== undefined ? { perPassenger: r.fareSummary.perPassenger } : {}), currency: r.fareSummary.currency } : null,
      journeyDate: r.journeyDate, bookingCreatedAt: r.bookingCreatedAt, lastUpdatedAt: r.lastUpdatedAt, failureCode: r.failureCode,
      source: 'BACKEND_BOOKING_RECORD'
    };
  }

  private records(sessionId: string): Readonly<BookingRecord>[] { return this.store.getBookingsForSession(sessionId); }

  // =========================================================================
  // 3. LLM context + tool grounding
  // =========================================================================

  contextFor(sessionId: string): PostBookingContextView | undefined {
    let recs: Readonly<BookingRecord>[];
    try { recs = this.records(sessionId); } catch { return undefined; }
    const s = this.state.hasSession(sessionId) ? this.state.getSession(sessionId) : undefined;
    const pend = s?.postBookingClarification;
    if (!recs.length && !pend) return undefined;
    return Object.freeze({
      source: 'AUTHORITATIVE_BACKEND_CONTEXT' as const, kind: 'BOOKING_HISTORY' as const, readOnly: true as const,
      rules: 'Backend-owned booking records (read-only). Never infer or invent a PNR, fare, confirmation, seat, coach or status that is not listed. PNR values are not included: use CHECK_PNR with bookingId for a fresh PNR status. Booking cannot be executed, cancelled or modified via tools.',
      activeBookingId: s?.activeBookingId ?? null,
      bookings: recs.slice(0, 10).map(r => ({
        bookingId: r.bookingId, status: r.bookingStatus, trainNumber: r.train.trainNumber, ...(r.train.trainName ? { trainName: r.train.trainName } : {}),
        origin: r.journey.origin, destination: r.journey.destination, journeyDate: r.journeyDate, travelClass: r.travelClass,
        passengersCount: r.passengersSummary.count, fareTotal: r.fareSummary?.total ?? null, pnrAvailable: !!r.pnr, bookingCreatedAt: r.bookingCreatedAt
      })),
      ...(pend ? { pendingClarification: { kind: pend.kind, candidates: recs.filter(r => pend.candidateIds.includes(r.bookingId)).map(r => ({ bookingId: r.bookingId, trainNumber: r.train.trainNumber, journeyDate: r.journeyDate })) } } : {})
    });
  }

  grounding(sessionId: string, userText: string): ToolGrounding {
    let recs: Readonly<BookingRecord>[] = [];
    try { recs = this.records(sessionId); } catch { /* history unavailable → nothing grounded */ }
    const s = this.state.hasSession(sessionId) ? this.state.getSession(sessionId) : undefined;
    return {
      userText,
      activeBookingId: s?.activeBookingId,
      bookings: recs.map(r => ({ bookingId: r.bookingId, pnr: r.pnr, trainNumber: r.train.trainNumber, status: r.bookingStatus })),
      pnrOwner: (pnr: string) => { try { return this.store.pnrOwner(sessionId, pnr); } catch { return 'NONE'; } },
      bookingOwner: (id: string) => { try { return this.store.bookingOwner(sessionId, id); } catch { return 'NONE'; } }
    };
  }

  /** Runtime callback for the read-only live tools (events carry a MASKED PNR only). */
  onLiveTool(sessionId: string, phase: 'REQUESTED' | 'RESULT', name: string, args: Record<string, any>, result: { success: boolean; error?: { code: string } } | undefined, emit: Emit): void {
    const at = new Date(this.clock()).toISOString();
    if (name === 'TRACK_TRAIN' && phase === 'REQUESTED') {
      emit('BOOKING_LIVE_STATUS_REQUESTED', { trainNumber: args.trainNumber, ...(args.bookingId ? { bookingId: args.bookingId } : {}) });
      if (args.bookingId) { try { this.store.updateLiveMeta(sessionId, args.bookingId, { lastLiveStatusAt: at }); } catch { /* audit only */ } }
    }
    if (name === 'CHECK_PNR' && phase === 'RESULT') {
      emit('PNR_STATUS_CHECKED', { pnrMasked: maskPnr(args.pnr), ok: !!result?.success, ...(result?.error ? { code: result.error.code } : {}), ...(args.bookingId ? { bookingId: args.bookingId } : {}) });
      if (args.bookingId) { try { this.store.updateLiveMeta(sessionId, args.bookingId, { lastPnrCheckAt: at, lastPnrCheckOk: !!result?.success }); } catch { /* audit only */ } }
    }
  }

  // =========================================================================
  // 4. Conversation turn (called by ContextualTurnApplier BEFORE any entity is applied)
  // =========================================================================

  handleTurn(sessionId: string, rawText: string, o: { locked: boolean; mode: 'TEXT' | 'VOICE'; turnId: string; emit: Emit; cards: Array<{ type: string; data: any }> }): PostBookingTurn {
    const s = this.state.getSession(sessionId);
    const pend = s.postBookingClarification;
    let kind = classifyPostBookingQuery(rawText);
    let candidateIds: string[] | undefined;
    if (!kind && pend && pend.setAtTurnId !== o.turnId) { kind = pend.kind; candidateIds = pend.candidateIds; }
    if (pend && pend.setAtTurnId !== o.turnId) s.postBookingClarification = undefined;
    if (!kind) return { type: 'DEFER' };

    let recs: Readonly<BookingRecord>[];
    try { recs = this.records(sessionId); }
    catch { return { type: 'ERROR', kind, code: 'BOOKING_HISTORY_UNAVAILABLE', message: 'Booking history abhi available nahi hai. Thodi der baad try karein.' }; }

    const booky = kind === 'BOOKING_STATUS' || kind === 'BOOKING_DETAILS' || kind === 'HISTORY';
    if (!o.locked && booky && (!recs.length && kind !== 'BOOKING_STATUS' || isPlanningQuestion(rawText))) return { type: 'DEFER' };
    // P13 keeps ownership of status questions about an UNRESOLVED execution (bounded reconciliation)
    if (o.locked && kind === 'BOOKING_STATUS' && s.bookingExecution && UNRESOLVED_EXECUTION.has(s.bookingExecution.status) && s.bookingExecution.status !== L.REQUESTED) {
      const active = recs.find(r => r.bookingId === s.activeBookingId);
      if (!active || active.executionId === s.bookingExecution.bookingExecutionId) return { type: 'DEFER' };
    }

    if (kind === 'HISTORY') return this.direct(kind, this.historyAnswer(recs, o.mode), o, { type: 'booking_history', data: { bookings: recs.slice(0, 5).map(r => this.toDetails(r, false)) } }, sessionId);

    // ---- information kinds: explicit data in the user's words needs no resolution ----
    if (kind === 'PNR_STATUS' && extractPnrCandidate(rawText)) return { type: 'INFO', kind, allowedTools: POST_BOOKING_READ_ONLY_TOOLS };
    if (kind === 'PNR_STATUS') {
      // digits typed right after "PNR" that are not a valid PNR → INVALID_PNR (deterministic; provider never called)
      const typed = String(rawText).match(/\bpnr\b\s*(?:no\.?|number|nambar|:|#)?\s*(\d[\d\s-]*\d|\d)/i);
      if (typed && !normalizePnrInput(typed[1].trim()).ok) return { type: 'ERROR', kind, code: 'INVALID_PNR', message: INVALID_PNR_MESSAGE };
    }
    if (kind === 'LIVE_STATUS') {
      const nums = [...String(rawText).matchAll(/(?<!\d)(\d{4,5})(?!\d)/g)].map(m => m[1]);
      if (nums.length) {
        const own = recs.find(r => nums.includes(r.train.trainNumber));
        if (own) s.activeBookingId = own.bookingId;
        return { type: 'INFO', kind, allowedTools: POST_BOOKING_READ_ONLY_TOOLS, ...(own ? { bookingId: own.bookingId } : {}) };
      }
    }

    const res: BookingResolution = this.resolver.resolve(recs, rawText, { activeBookingId: s.activeBookingId, candidateIds });
    if (res.kind === 'AMBIGUOUS') {
      s.postBookingClarification = { kind, candidateIds: res.candidates.map(r => r.bookingId), setAtTurnId: o.turnId };
      return { type: 'ERROR', kind, code: res.code, message: res.message };
    }
    if (res.kind === 'NOT_FOUND') return { type: 'ERROR', kind, code: res.code, message: res.message };
    if (res.kind === 'NONE') {
      if (INFO_KINDS.has(kind)) return { type: 'INFO', kind, allowedTools: POST_BOOKING_READ_ONLY_TOOLS };   // validator asks for PNR / train
      const msg = kind === 'PNR_VALUE'
        ? 'Is session mein abhi koi booking record nahi hai, isliye PNR available nahi hai. Kisi aur ticket ka PNR status dekhna ho to 10-digit PNR batayein.'
        : 'Is session mein abhi koi booking record nahi hai — kisi booking provider ne koi booking confirm nahi ki hai.';
      return { type: 'DIRECT', kind, answer: msg, ...(kind === 'PNR_VALUE' ? { softError: { code: 'PNR_NOT_AVAILABLE' as const, message: 'PNR not available' } } : {}) };
    }
    const r = res.record;
    s.activeBookingId = r.bookingId;
    if (kind === 'PNR_STATUS') {
      if (!r.pnr) return this.direct(kind, this.noPnr(r, true), o, null, sessionId, { code: 'PNR_NOT_AVAILABLE', message: 'PNR not available' });
      return { type: 'INFO', kind, allowedTools: POST_BOOKING_READ_ONLY_TOOLS, bookingId: r.bookingId };
    }
    if (kind === 'LIVE_STATUS') return { type: 'INFO', kind, allowedTools: POST_BOOKING_READ_ONLY_TOOLS, bookingId: r.bookingId };
    if (kind === 'PNR_VALUE') {
      if (!r.pnr) return this.direct(kind, this.noPnr(r, false), o, { type: 'booking_details', data: this.toDetails(r, false) }, sessionId, { code: 'PNR_NOT_AVAILABLE', message: 'PNR not available' });
      return this.direct(kind, `${this.describe(r, o.mode)} — PNR: ${r.pnr}.`, o, { type: 'booking_details', data: this.toDetails(r, true) }, sessionId);
    }
    if (kind === 'BOOKING_STATUS') return this.direct(kind, this.statusAnswer(r, o.mode), o, { type: 'booking_details', data: this.toDetails(r, false) }, sessionId);
    return this.direct(kind, this.detailsAnswer(r, o.mode), o, { type: 'booking_details', data: this.toDetails(r, false) }, sessionId);
  }

  private direct(kind: PostBookingQueryKind, answer: string, o: { emit: Emit; cards: Array<{ type: string; data: any }> }, card: { type: string; data: any } | null, sessionId: string, softError?: { code: PostBookingErrorCode; message: string }): PostBookingTurn {
    o.emit('BOOKING_HISTORY_QUERIED', { kind, activeBookingId: this.state.getSession(sessionId).activeBookingId ?? null });
    if (card) o.cards.push(card);
    return { type: 'DIRECT', kind, answer, ...(softError ? { softError } : {}) };
  }

  // ---- deterministic phrasing (record fields only) ----

  describe(r: Readonly<BookingRecord>, mode: 'TEXT' | 'VOICE'): string {
    const route = `${shortName(r.journey.originName, r.journey.origin)} → ${shortName(r.journey.destinationName, r.journey.destination)}`;
    if (mode === 'VOICE') return `${r.train.trainNumber}, ${humanDate(r.journeyDate)}`;
    return `${r.train.trainNumber}${r.train.trainName ? ' ' + r.train.trainName : ''} · ${route} · ${humanDate(r.journeyDate)} · ${r.travelClass} · ${r.passengersSummary.count} passenger${r.passengersSummary.count > 1 ? 's' : ''}`;
  }

  statusAnswer(r: Readonly<BookingRecord>, mode: 'TEXT' | 'VOICE'): string {
    const d = this.describe(r, mode);
    switch (r.bookingStatus) {
      case 'CONFIRMED': return mode === 'VOICE' ? `Haan, booking provider ne ${d} ki booking confirm ki hai.` : `Haan — booking provider ne yeh booking confirm ki hai: ${d}. ${r.pnr ? 'PNR available hai ("PNR kya hai?" pooch sakte hain).' : 'PNR provider ne abhi nahi diya.'}`;
      case 'PENDING': return `Abhi nahi — booking provider ne ${d} ki booking abhi confirm nahi ki hai (status: pending).`;
      case 'UNKNOWN': return `${d} ki booking ka result abhi confirm nahi hua hai (status: unknown) — ise confirmed nahi maana ja sakta. Main dobara submit nahi karunga; "status check karo" bolkar provider se verify kar sakte hain.`;
      case 'FAILED': return `Nahi — ${d} ki booking attempt provider ne fail ki thi${r.failureCode ? ` (${r.failureCode})` : ''}.`;
      case 'CANCELLED': return `${d} ki booking provider ke hisaab se cancelled hai.`;
      case 'EXTERNAL_HANDOFF_REQUIRED': return `${d} ki booking IRCTC par khud complete karni hogi — provider ne booking confirm nahi ki.`;
    }
  }

  detailsAnswer(r: Readonly<BookingRecord>, mode: 'TEXT' | 'VOICE'): string {
    if (mode === 'VOICE') return `${this.describe(r, mode)} — status: ${STATUS_LABEL[r.bookingStatus]}.`;
    const fare = r.fareSummary ? ` Fare (booking ke waqt verify): ₹${r.fareSummary.total}.` : '';
    const pnr = r.pnr ? ` PNR: ${maskPnr(r.pnr)} (poora PNR: "PNR kya hai?").` : ' PNR: available nahi.';
    return `Booking: ${this.describe(r, mode)}. Status: ${STATUS_LABEL[r.bookingStatus]}.${fare}${pnr}`;
  }

  historyAnswer(recs: readonly Readonly<BookingRecord>[], mode: 'TEXT' | 'VOICE'): string {
    if (!recs.length) return 'Is session mein abhi koi booking record nahi hai.';
    if (mode === 'VOICE') return `Is session mein ${recs.length} booking record${recs.length > 1 ? 's' : ''} hain. Latest: ${recs[0].train.trainNumber}, ${STATUS_LABEL[recs[0].bookingStatus]}.`;
    return `Is session ki bookings:\n${recs.slice(0, 5).map((r, i) => `${i + 1}. ${this.describe(r, 'TEXT')} — ${STATUS_LABEL[r.bookingStatus]}`).join('\n')}`;
  }

  private noPnr(r: Readonly<BookingRecord>, forStatus: boolean): string {
    if (r.bookingStatus === 'CONFIRMED') return `${this.describe(r, 'VOICE')} ki booking ka PNR provider ne abhi nahi diya${forStatus ? ', isliye PNR status check nahi ho sakta' : ''}.`;
    return `${this.describe(r, 'VOICE')} ki booking ${STATUS_LABEL[r.bookingStatus].toLowerCase()} hai — confirmed nahi, isliye PNR available nahi hai.`;
  }
}
