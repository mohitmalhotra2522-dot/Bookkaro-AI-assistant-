/**
 * PROMPT 14 — GROUP 2 (domain): BookingRecord read model, normalizer, history store, PNR validation,
 * reference resolution, PNR / live status normalization, tool-call grounding. No network.
 */
import { describe, it, expect } from 'vitest';
import { normalizeProviderResult, postBookingStatusFor } from '../../server/booking/post-booking/booking-result-normalizer';
import { InMemoryBookingHistoryStore } from '../../server/booking/post-booking/booking-history-store';
import { BookingReferenceResolver } from '../../server/booking/post-booking/booking-reference-resolver';
import { normalizePnrInput, maskPnr, maskPnrsInText, maskPnrDeep, extractPnrCandidate } from '../../server/booking/post-booking/pnr-validator';
import { PnrStatusService, normalizePnrResponse, normalizeTrackResponse } from '../../server/booking/post-booking/pnr-status-service';
import { classifyPostBookingQuery } from '../../server/booking/post-booking/post-booking-conversation';
import { PostBookingService } from '../../server/booking/post-booking/post-booking-service';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { findSensitiveFields } from '../../server/booking/handoff/sensitive-data-guard';
import { BookingExecutionLifecycleStatus as L } from '../../shared/booking-execution-lifecycle';
import type { NormalizedBookingResult, BookingProviderEvidence } from '../../shared/booking-record';

let n = 0;
const norm = (o: Partial<NormalizedBookingResult> = {}): NormalizedBookingResult => {
  n++;
  return {
    executionId: `exec_${n}`, sessionId: 'sess-A', handoffId: `ho_${n}`, idempotencyKey: `idem_${n}`, providerName: 'test-mock-booking',
    bookingStatus: 'CONFIRMED', statusSource: 'PROVIDER_EXECUTION', providerReference: `REF-${n}`, pnr: '1234567890', failureCode: null,
    journey: { origin: 'ASR', destination: 'NDLS', originName: 'Amritsar Junction', destinationName: 'New Delhi' },
    train: { trainNumber: '12014', trainName: 'Shatabdi Express' }, passengersSummary: { count: 2 }, travelClass: 'CC',
    fareSummary: { total: 980, perPassenger: 490, currency: 'INR', passengersCount: 2 }, journeyDate: '2026-10-04',
    providerStatus: 'CONFIRMED', at: new Date().toISOString(), ...o
  };
};
const ev = (executionId: string, providerStatus: string | null = 'CONFIRMED'): BookingProviderEvidence => ({ source: 'PROVIDER_RECONCILIATION', executionId, providerStatus });

describe('G2 — normalizer: provider result → post-booking status (schema-validated, free text ignored)', () => {
  it('[1] confirmed / failed / unknown / pending normalization; PNR only from CONFIRMED', () => {
    const c = normalizeProviderResult({ status: 'CONFIRMED', providerReference: 'R-1', pnr: '1234567890' });
    expect(c).toMatchObject({ ok: true, status: 'CONFIRMED', pnr: '1234567890', providerReference: 'R-1' });
    const f = normalizeProviderResult({ status: 'FAILED', failureCode: 'TEST_PROVIDER_REJECTED' });
    expect(f).toMatchObject({ ok: true, status: 'FAILED', pnr: null, failureCode: 'TEST_PROVIDER_REJECTED' });
    const u = normalizeProviderResult({ status: 'UNKNOWN' }, 'STATUS');
    expect(u).toMatchObject({ ok: true, status: 'UNKNOWN', pnr: null });
    expect(normalizeProviderResult({ status: 'PENDING' }, 'STATUS')).toMatchObject({ ok: true, status: 'PENDING' });
    expect(normalizeProviderResult({ status: 'IN_PROGRESS', providerReference: 'R-2' })).toMatchObject({ ok: true, status: 'PENDING', pnr: null });
  });

  it('[2] invalid / free-text results are never proof of confirmation → INVALID_BOOKING_RESULT', () => {
    for (const raw of [{ status: 'OK', pnr: 'BOOKED!!', ticket: true }, { message: 'Booking confirmed! PNR 1234567890' }, 'confirmed', null, { status: 'CONFIRMED', pnr: 'ABC' }]) {
      const r = normalizeProviderResult(raw as any);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_BOOKING_RESULT');
    }
  });

  it('[3] lifecycle → read-model status: REQUESTED / NOT_STARTED produce no record; IN_PROGRESS only after a provider answer', () => {
    expect(postBookingStatusFor(L.CONFIRMED)).toBe('CONFIRMED');
    expect(postBookingStatusFor(L.UNKNOWN)).toBe('UNKNOWN');
    expect(postBookingStatusFor(L.MANUAL_VERIFICATION_REQUIRED)).toBe('UNKNOWN');
    expect(postBookingStatusFor(L.FAILED)).toBe('FAILED');
    expect(postBookingStatusFor(L.REQUESTED)).toBeNull();
    expect(postBookingStatusFor(L.IN_PROGRESS)).toBeNull();
    expect(postBookingStatusFor(L.IN_PROGRESS, 'IN_PROGRESS')).toBe('PENDING');
  });
});

describe('G2 — PNR validation, masking, extraction (deterministic; no provider call when malformed)', () => {
  it('[4] normalize valid formats; malformed → INVALID_PNR', () => {
    expect(normalizePnrInput('1234567890')).toEqual({ ok: true, pnr: '1234567890' });
    expect(normalizePnrInput(' 123-456 7890 ')).toEqual({ ok: true, pnr: '1234567890' });
    expect(normalizePnrInput(1234567890)).toEqual({ ok: true, pnr: '1234567890' });   // LLM JSON may send a number
    for (const bad of ['12345', '12345678901', 'ABCDEFGHIJ', '', null, undefined, 12345, '12345abcde', { pnr: '1234567890' }]) {
      const r = normalizePnrInput(bad as any);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('INVALID_PNR');
    }
  });

  it('[5] masking: 12******90 in text / deep objects; extraction only of 10-digit candidates', () => {
    expect(maskPnr('1234567890')).toBe('12******90');
    expect(maskPnr(null)).toBeNull();
    expect(maskPnrsInText('PNR: 1234567890, train 12014')).toBe('PNR: 12******90, train 12014');
    expect(JSON.stringify(maskPnrDeep({ a: { pnr: '1234567890', list: ['9876543210'] } }))).not.toMatch(/1234567890|9876543210/);
    expect(extractPnrCandidate('mera PNR 1234567890 check karo')).toBe('1234567890');
    expect(extractPnrCandidate('12014 wali booking ka PNR')).toBeNull();
  });

  it('[6] malformed PNR → INVALID_PNR WITHOUT a provider call', async () => {
    let calls = 0;
    const tools: any = { CHECK_PNR: async () => { calls++; return { ok: true, data: {} }; } };
    const r = await new PnrStatusService(tools).check('12345');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_PNR');
    expect(calls).toBe(0);
  });

  it('[7] PNR status normalization: must echo the requested PNR + a status; unavailable / timeout / not found mapped', () => {
    const meta = { providerId: 'p', source: 'mock', latencyMs: 1 };
    const ok = normalizePnrResponse({ ok: true, data: { pnr: '1234567890', status: 'CNF', chartStatus: 'Chart not prepared', passengers: [{ number: 1, bookingStatus: 'WL 5', currentStatus: 'CNF' }] } }, '1234567890', meta);
    expect(ok.ok).toBe(true);
    if (ok.ok) { expect(ok.data).toMatchObject({ pnrMasked: '12******90', pnrStatus: 'CNF', dataSource: 'MOCK', fresh: true }); expect(ok.data.passengers).toHaveLength(1); }
    expect(normalizePnrResponse({ ok: true, data: { pnr: '9999999999', status: 'CNF' } }, '1234567890', meta).ok).toBe(false);   // wrong PNR echoed
    expect(normalizePnrResponse({ ok: true, data: { pnr: '1234567890' } }, '1234567890', meta).ok).toBe(false);                 // no status
    const code = (raw: any) => { const r = normalizePnrResponse(raw, '1234567890', meta); return r.ok ? 'OK' : r.error.code; };
    expect(code({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } })).toBe('PNR_STATUS_UNAVAILABLE');
    expect(code({ ok: false, error: { code: 'PROVIDER_TIMEOUT' } })).toBe('PNR_PROVIDER_TIMEOUT');
    expect(code({ ok: false, error: { code: 'PNR_NOT_FOUND' } })).toBe('INVALID_PNR');
    expect(code({ ok: false, error: { code: 'WHATEVER' } })).toBe('PNR_PROVIDER_ERROR');
    const tr = normalizeTrackResponse({ ok: true, data: { trainNumber: '12014', currentStatus: 'Running', delayMinutes: 7 } }, '12014', meta);
    expect(tr.ok && tr.data.delayMinutes).toBe(7);
    expect(normalizeTrackResponse({ ok: true, data: { trainNumber: '99999', currentStatus: 'Running' } }, '12014', meta).ok).toBe(false);
  });
});

describe('G2 — BookingHistoryStore: creation, idempotency, immutability, PNR attach, no fake records', () => {
  it('[8] history creation from a normalized provider result; DTO-safe (no credential-like keys)', () => {
    const st = new InMemoryBookingHistoryStore();
    const c = st.createBooking(norm());
    expect(c.ok && c.created).toBe(true);
    if (!c.ok) return;
    expect(c.record.bookingId).toMatch(/^bk_[0-9a-f]{20}$/);
    expect(c.record.pnr).toBe('1234567890');
    expect(Object.isFrozen(c.record)).toBe(true);
    expect(findSensitiveFields(c.record)).toEqual([]);
    expect(st.getBookingsForSession('sess-A')).toHaveLength(1);
    expect(st.getBookingsForSession('sess-B')).toHaveLength(0);
  });

  it('[9] duplicate confirmation (same executionId / providerReference / idempotencyKey) → same record, no duplicate', () => {
    const st = new InMemoryBookingHistoryStore();
    const base = norm();
    const a = st.createBooking(base);
    const b = st.createBooking({ ...base });
    const c = st.createBooking({ ...base, executionId: 'exec-other' });              // same provider:ref
    const d = st.createBooking({ ...base, executionId: 'exec-x', providerReference: null });   // same idempotencyKey
    for (const r of [b, c, d]) { expect(r.ok).toBe(true); if (r.ok && a.ok) { expect(r.created).toBe(false); expect(r.record.bookingId).toBe(a.record.bookingId); } }
    expect(st.getBookingsForSession('sess-A')).toHaveLength(1);
    const conflict = st.createBooking({ ...base, executionId: 'exec-y', travelClass: '3A' });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('BOOKING_RECORD_CONFLICT');
    const otherSession = st.createBooking({ ...base, sessionId: 'sess-B' });
    expect(!otherSession.ok && otherSession.code).toBe('BOOKING_RECORD_CONFLICT');
  });

  it('[10] no fake booking / PNR: CONFIRMED without provider evidence, PNR on a non-confirmed record, malformed PNR → rejected', () => {
    const st = new InMemoryBookingHistoryStore();
    const r1 = st.createBooking(norm({ providerStatus: 'IN_PROGRESS' }));
    expect(!r1.ok && r1.code).toBe('AUTHORITATIVE_DATA_REQUIRED');
    const r2 = st.createBooking(norm({ bookingStatus: 'UNKNOWN', providerStatus: null, pnr: '1234567890' }));
    expect(!r2.ok && r2.code).toBe('INVALID_BOOKING_RESULT');
    const r3 = st.createBooking(norm({ pnr: 'PNR-PLACEHOLDER' }));
    expect(!r3.ok && r3.code).toBe('INVALID_BOOKING_RESULT');
    const r4 = st.createBooking(norm({ bookingStatus: 'BOOKED' as any }));
    expect(!r4.ok && r4.code).toBe('INVALID_BOOKING_STATUS');
    expect(st.getBookingsForSession('sess-A')).toHaveLength(0);
  });

  it('[11] UNKNOWN record: no PNR; UNKNOWN → CONFIRMED only with provider CONFIRMED evidence; then PNR attach once', () => {
    const st = new InMemoryBookingHistoryStore();
    const c = st.createBooking(norm({ bookingStatus: 'UNKNOWN', providerStatus: null, pnr: null, providerReference: null }));
    if (!c.ok) throw new Error(c.code);
    expect(c.record.pnr).toBeNull();
    const id = c.record.bookingId, ex = c.record.executionId;
    expect(st.updateBookingStatus('sess-A', id, 'CONFIRMED', ev(ex, 'UNKNOWN'))).toMatchObject({ ok: false, code: 'AUTHORITATIVE_DATA_REQUIRED' });
    expect(st.updateBookingStatus('sess-A', id, 'CONFIRMED', ev('exec-wrong'))).toMatchObject({ ok: false, code: 'AUTHORITATIVE_DATA_REQUIRED' });
    expect(st.updatePnr('sess-A', id, '1234567890', ev(ex))).toMatchObject({ ok: false, code: 'AUTHORITATIVE_DATA_REQUIRED' });   // not confirmed yet
    expect(st.updateBookingStatus('sess-A', id, 'CONFIRMED', ev(ex))).toMatchObject({ ok: true, changed: true });
    expect(st.updatePnr('sess-A', id, '12345', ev(ex))).toMatchObject({ ok: false, code: 'INVALID_PNR' });
    expect(st.updatePnr('sess-A', id, '1234567890', ev(ex))).toMatchObject({ ok: true, changed: true });
    expect(st.updatePnr('sess-A', id, '1234567890', ev(ex))).toMatchObject({ ok: true, changed: false });
    expect(st.updatePnr('sess-A', id, '1111111111', ev(ex))).toMatchObject({ ok: false, code: 'BOOKING_RECORD_CONFLICT' });
    const g = st.getBookingById('sess-A', id);
    expect(g.ok && g.record.pnr).toBe('1234567890');
    expect(g.ok && g.record.confirmedAt).toBeTruthy();
  });

  it('[12] immutable fields + terminal statuses: providerReference set-once, FAILED not mutable, CONFIRMED → only authoritative CANCELLED', () => {
    const st = new InMemoryBookingHistoryStore();
    const c = st.createBooking(norm({ providerReference: null }));
    if (!c.ok) throw new Error(c.code);
    const id = c.record.bookingId, ex = c.record.executionId;
    expect(st.updateProviderReference('sess-A', id, 'REF-NEW', ev(ex))).toMatchObject({ ok: true, changed: true });
    expect(st.updateProviderReference('sess-A', id, 'REF-OTHER', ev(ex))).toMatchObject({ ok: false, code: 'BOOKING_RECORD_NOT_MUTABLE' });
    expect(st.updateBookingStatus('sess-A', id, 'FAILED', ev(ex, 'FAILED'))).toMatchObject({ ok: false, code: 'INVALID_BOOKING_STATUS' });
    expect(st.markCancelled('sess-A', id, ev(ex, 'CONFIRMED'))).toMatchObject({ ok: false, code: 'AUTHORITATIVE_DATA_REQUIRED' });
    expect(st.markCancelled('sess-A', id, ev(ex, 'CANCELLED'))).toMatchObject({ ok: true });
    expect(st.updateBookingStatus('sess-A', id, 'CONFIRMED', ev(ex))).toMatchObject({ ok: false, code: 'BOOKING_RECORD_NOT_MUTABLE' });
    const f = st.createBooking(norm({ bookingStatus: 'FAILED', providerStatus: 'FAILED', pnr: null, failureCode: 'TEST_PROVIDER_REJECTED' }));
    if (!f.ok) throw new Error(f.code);
    expect(st.updateBookingStatus('sess-A', f.record.bookingId, 'CONFIRMED', ev(f.record.executionId))).toMatchObject({ ok: false, code: 'BOOKING_RECORD_NOT_MUTABLE' });
    // frozen: direct mutation impossible
    const g = st.getBookingById('sess-A', id);
    expect(() => { (g as any).record.train.trainNumber = '99999'; }).toThrow();
    expect(g.ok && g.record.journey.origin).toBe('ASR');
    expect(g.ok && g.record.fareSummary?.total).toBe(980);
  });

  it('[13] session-scoped ownership: other session → BOOKING_ACCESS_DENIED; owners for PNR / booking', () => {
    const st = new InMemoryBookingHistoryStore();
    const c = st.createBooking(norm());
    if (!c.ok) throw new Error(c.code);
    expect(st.getBookingById('sess-B', c.record.bookingId)).toMatchObject({ ok: false, code: 'BOOKING_ACCESS_DENIED' });
    expect(st.getBookingById('sess-A', 'bk_nope')).toMatchObject({ ok: false, code: 'BOOKING_NOT_FOUND' });
    expect(st.pnrOwner('sess-A', '1234567890')).toBe('SELF');
    expect(st.pnrOwner('sess-B', '1234567890')).toBe('OTHER');
    expect(st.pnrOwner('sess-B', '5555555555')).toBe('NONE');
    expect(st.bookingOwner('sess-B', c.record.bookingId)).toBe('OTHER');
  });
});

describe('G2 — BookingReferenceResolver: latest, train, station, pronoun, ambiguity (never guesses)', () => {
  const st = new InMemoryBookingHistoryStore();
  const a = st.createBooking(norm({ train: { trainNumber: '12014' } }));
  const b = st.createBooking(norm({ train: { trainNumber: '14542' }, journeyDate: '2026-10-06' }));
  const c = st.createBooking(norm({ train: { trainNumber: '12497' }, journey: { origin: 'NDLS', destination: 'LKO', originName: 'New Delhi', destinationName: 'Lucknow' }, journeyDate: '2026-10-08' }));
  const recs = st.getBookingsForSession('sess-A');
  const R = new BookingReferenceResolver();
  const id = (x: any) => x.ok ? x.record.bookingId : '';

  it('[14] latest / last / jo abhi → newest record', () => {
    for (const q of ['latest ticket dikhao', 'last booking ka PNR', 'jo abhi book hua uska status']) {
      const r = R.resolve(recs, q);
      expect(r.kind).toBe('RESOLVED');
      if (r.kind === 'RESOLVED') expect(r.record.bookingId).toBe(id(c));
    }
  });

  it('[15] "12014 wali" → train; "Lucknow wali" → station; "iska" → active booking; "aaj" date', () => {
    const t = R.resolve(recs, '12014 wali booking ka PNR check karo');
    expect(t.kind === 'RESOLVED' && t.record.bookingId).toBe(id(a));
    const s = R.resolve(recs, 'Lucknow wali booking dikhao');
    expect(s.kind === 'RESOLVED' && s.record.bookingId).toBe(id(c));
    const p = R.resolve(recs, 'iska status kya hai', { activeBookingId: id(b) });
    expect(p.kind === 'RESOLVED' && p.record.bookingId).toBe(id(b));
    const d = R.resolve(recs, 'kal wali booking ka status', { today: '2026-10-05' });
    expect(d.kind).not.toBe('AMBIGUOUS');
  });

  it('[16] ambiguity: two Delhi bookings → MULTIPLE_BOOKINGS_MATCHED with the exact clarification; never a guess', () => {
    const r = R.resolve(recs.filter(x => x.bookingId !== id(c)), 'Delhi wali booking dikhao');
    expect(r.kind).toBe('AMBIGUOUS');
    if (r.kind === 'AMBIGUOUS') {
      expect(r.code).toBe('MULTIPLE_BOOKINGS_MATCHED');
      expect(r.message).toBe('Do Delhi bookings mil rahi hain. Aap 14542 wali dekhna chahte ho ya 12014 wali?');
    }
    const followUp = R.resolve(recs, '12014 wali', { candidateIds: [id(a), id(b)] });
    expect(followUp.kind === 'RESOLVED' && followUp.record.bookingId).toBe(id(a));
  });

  it('[17] unknown train / station → BOOKING_NOT_FOUND; empty history → NONE', () => {
    expect(R.resolve(recs, '22439 wali booking')).toMatchObject({ kind: 'NOT_FOUND', code: 'BOOKING_NOT_FOUND' });
    expect(R.resolve([], 'latest booking')).toEqual({ kind: 'NONE' });
  });
});

describe('G2 — conversation classification + tool grounding (LLM cannot invent a PNR / train)', () => {
  it('[18] classifier separates PNR status / PNR value / booking status / live status; booking intents are NOT post-booking', () => {
    expect(classifyPostBookingQuery('PNR status check karo')).toBe('PNR_STATUS');
    expect(classifyPostBookingQuery('PNR kya hai?')).toBe('PNR_VALUE');
    expect(classifyPostBookingQuery('PNR 12345 check karo')).toBe('PNR_STATUS');            // malformed → INVALID_PNR later
    expect(classifyPostBookingQuery('Ticket book ho gayi?')).toBe('BOOKING_STATUS');
    expect(classifyPostBookingQuery('meri train abhi kaha hai?')).toBe('LIVE_STATUS');
    expect(classifyPostBookingQuery('latest ticket dikhao')).toBe('BOOKING_DETAILS');
    expect(classifyPostBookingQuery('meri sabhi bookings dikhao')).toBe('HISTORY');
    for (const q of ['haan book karo', 'phir se book karo', 'status kya hai', 'status check karo', 'cancel karo ruko', 'Amritsar se Delhi kal 2 log']) expect(classifyPostBookingQuery(q)).toBeNull();
  });

  it('[19] validator: CHECK_PNR grounded in the user text / own booking only; other session → BOOKING_ACCESS_DENIED; missing → PNR_NOT_AVAILABLE', () => {
    const state = new ConversationStateManager();
    const store = new InMemoryBookingHistoryStore();
    const pb = new PostBookingService(state, { store });
    const A = state.createSession().sessionId, B = state.createSession().sessionId;
    const own = store.createBooking(norm({ sessionId: A, pnr: '2222222222' }));
    const noPnr = store.createBooking(norm({ sessionId: A, pnr: null, train: { trainNumber: '14542' } }));
    if (!own.ok || !noPnr.ok) throw new Error('seed');
    const v = new ToolCallValidator();
    const call = (args: any) => ({ callId: 'c', name: 'CHECK_PNR' as const, arguments: args });
    const code = (r: any) => r.ok ? 'OK' : r.error.code;
    // LLM-invented PNR (not typed, not owned)
    expect(code(v.validate(call({ pnr: '9876543210' }), state.getSession(A), pb.grounding(A, 'PNR status check karo')))).toBe('AUTHORITATIVE_DATA_REQUIRED');
    // typed by the user → allowed (external PNR lookup)
    expect(code(v.validate(call({ pnr: '9876543210' }), state.getSession(A), pb.grounding(A, 'PNR 9876543210 check karo')))).toBe('OK');
    // own booking PNR via bookingId → resolved server-side
    const ok: any = v.validate(call({ bookingId: own.record.bookingId }), state.getSession(A), pb.grounding(A, 'PNR status'));
    expect(ok.ok && ok.v.arguments.pnr).toBe('2222222222');
    // another session's booking / PNR
    expect(code(v.validate(call({ bookingId: own.record.bookingId }), state.getSession(B), pb.grounding(B, 'PNR status')))).toBe('BOOKING_ACCESS_DENIED');
    expect(code(v.validate(call({ pnr: '2222222222' }), state.getSession(B), pb.grounding(B, 'PNR 2222222222 status')))).toBe('BOOKING_ACCESS_DENIED');
    expect(code(v.validate(call({ bookingId: noPnr.record.bookingId }), state.getSession(A), pb.grounding(A, 'PNR status')))).toBe('PNR_NOT_AVAILABLE');
    expect(code(v.validate(call({ pnr: '12345' }), state.getSession(A), pb.grounding(A, 'PNR 12345')))).toBe('INVALID_PNR');
    // TRACK_TRAIN: invented train rejected; booking train allowed
    const tr = (args: any, text: string) => code(v.validate({ callId: 't', name: 'TRACK_TRAIN', arguments: args }, state.getSession(A), pb.grounding(A, text)));
    expect(tr({ trainNumber: '22439' }, 'meri train abhi kaha hai')).toBe('AUTHORITATIVE_DATA_REQUIRED');
    expect(tr({ trainNumber: '12014' }, 'meri train abhi kaha hai')).toBe('OK');
  });

  it('[20] LLM context: AUTHORITATIVE_BACKEND_CONTEXT, read-only, NO PNR values, no credentials', () => {
    const state = new ConversationStateManager();
    const store = new InMemoryBookingHistoryStore();
    const pb = new PostBookingService(state, { store });
    const A = state.createSession().sessionId;
    store.createBooking(norm({ sessionId: A, pnr: '3333333333' }));
    const ctx: any = pb.contextFor(A);
    expect(ctx.source).toBe('AUTHORITATIVE_BACKEND_CONTEXT');
    expect(ctx.readOnly).toBe(true);
    expect(ctx.bookings[0].pnrAvailable).toBe(true);
    expect(JSON.stringify(ctx)).not.toContain('3333333333');
    expect(findSensitiveFields(ctx)).toEqual([]);
    expect(Object.isFrozen(ctx)).toBe(true);
    // DTO: masked unless revealed for an operation that needs it
    const list = pb.listDetails(A);
    expect(list[0].pnr).toBe('33******33');
    expect(list[0].source).toBe('BACKEND_BOOKING_RECORD');
    const full = pb.getBookingDetails(A, list[0].bookingId, { revealPnr: true });
    expect(full.ok && full.details.pnr).toBe('3333333333');
    const B = state.createSession().sessionId;
    expect(pb.getBookingDetails(B, list[0].bookingId)).toMatchObject({ ok: false, code: 'BOOKING_ACCESS_DENIED' });
  });
});
