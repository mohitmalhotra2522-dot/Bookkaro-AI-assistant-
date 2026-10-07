/**
 * PROMPT 15 — GROUP 2 (domain): booking lifecycle actions.
 * cancel intent · confirmation guard · capability guard · cancel success / failure / timeout / UNKNOWN ·
 * duplicate cancel protection · modification capability + validation · refund separation ·
 * idempotency · history preservation. MockBookingProvider is TEST-ONLY; nothing here is live data.
 */
import { describe, it, expect } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { BookingState } from '../../shared/states';
import { BookingProviderRegistry } from '../../server/booking/provider/booking-provider-registry';
import type { BookingProviderConfig } from '../../server/booking/provider/booking-provider-config';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { MockBookingProvider, type MockBookingProviderOptions } from '../../server/booking/testing/mock-booking-provider';
import { InMemoryBookingHistoryStore } from '../../server/booking/post-booking/booking-history-store';
import { BookingLifecycleActionService } from '../../server/booking/lifecycle-actions/booking-lifecycle-action-service';
import { classifyLifecycleIntent, isLifecycleConfirmation } from '../../server/booking/lifecycle-actions/lifecycle-action-intent';
import { BookingActionValidator, LIFECYCLE_MESSAGES } from '../../server/booking/lifecycle-actions/booking-action-validator';
import { resolveProviderActionCapabilities, normalizeCancellationResponse, normalizeModificationResponse, normalizeRefundResponse } from '../../server/booking/lifecycle-actions/provider-action-normalizer';
import { LifecycleActionStore } from '../../server/booking/lifecycle-actions/lifecycle-action-store';
import { parseLifecycleAction, NO_ACTION_CAPABILITIES } from '../../shared/booking-lifecycle-action';
import { lifecycleClaimGuard } from '../../server/ai/agent/conversation-agent-orchestrator';
import { findSensitiveFields } from '../../server/booking/handoff/sensitive-data-guard';
import type { NormalizedBookingResult } from '../../shared/booking-record';
/** P42.1: the backend states that the explicit confirmation is REQUIRED (it verifies it itself); no backend question. */
const CONFIRM_REQUIRED = /(bolne|karne) par hi request provider ko jayegi/;

const istDay = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
const TODAY = istDay(Date.now());
const TOMORROW = istDay(Date.now() + 86400_000);
const PNR = '9123456780';
const cfg = (provider: string): BookingProviderConfig => ({ provider, enabled: true, timeoutMs: 2000, configErrors: [] });

let seq = 0;
function seed(store: InMemoryBookingHistoryStore, sid: string, providerName: string, o: Partial<NormalizedBookingResult> = {}) {
  seq++;
  const n: NormalizedBookingResult = {
    executionId: `exe_${seq}`, sessionId: sid, handoffId: `ho_${seq}`, idempotencyKey: `idem_${seq}`, providerName,
    bookingStatus: 'CONFIRMED', statusSource: 'PROVIDER_EXECUTION', providerReference: `TEST-REF-${seq}`, pnr: PNR, failureCode: null,
    journey: { origin: 'NDLS', destination: 'ASR', originName: 'New Delhi', destinationName: 'Amritsar' },
    train: { trainNumber: '12014', trainName: 'Shatabdi Express' }, passengersSummary: { count: 2 }, travelClass: 'CC',
    fareSummary: { total: 980, currency: 'INR', passengersCount: 2 }, journeyDate: TOMORROW, providerStatus: 'CONFIRMED', at: new Date().toISOString(),
    ...o
  };
  const r = store.createBooking(n);
  if (!r.ok) throw new Error(r.code);
  return r.record;
}

function setup(o: Partial<MockBookingProviderOptions> = {}, extra: { ttl?: number; clock?: () => number } = {}) {
  const state = new ConversationStateManager();
  const p = new MockBookingProvider({ execute: 'CONFIRMED', ...o });
  const reg = new BookingProviderRegistry({ allowTestProviders: true }); reg.register(p);
  const store = new InMemoryBookingHistoryStore();
  const svc = new BookingLifecycleActionService(state, {
    store, providers: { registry: reg, config: cfg(p.name) }, sleep: async () => {}, timeoutMs: 40,
    reconcile: { attempts: 1, delayMs: 0 }, ...(extra.ttl !== undefined ? { confirmationTtlMs: extra.ttl } : {}), ...(extra.clock ? { clock: extra.clock } : {})
  });
  const sid = state.createSession().sessionId;
  state.getSession(sid).bookingState = BookingState.BOOKING_CONFIRMED;
  const rec = seed(store, sid, p.name);
  return { state, p, store, svc, sid, rec };
}
let tn = 0;
async function turn(svc: BookingLifecycleActionService, sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT', llmAction?: unknown) {
  const turnId = `t${++tn}`; const events: string[] = [];
  const emit = (t: string) => { events.push(t); };
  const h = svc.handleTurn(sid, text, { turnId, mode, emit: emit as any, llmAction });
  if (h.type === 'ASYNC') { const r = await svc.run(sid, h.plan, { turnId, mode, emit: emit as any }); return { h, r, events, msg: r.message, code: r.error?.code }; }
  return { h, events, msg: h.type === 'DIRECT' ? h.answer : h.type === 'ERROR' ? h.message : '', code: h.type === 'ERROR' ? h.code : undefined };
}
const cur = (store: InMemoryBookingHistoryStore, sid: string, id: string) => { const g = store.getBookingById(sid, id); if (!g.ok) throw new Error(g.code); return g.record; };

describe('G2 — intent + enum (deterministic, user words only)', () => {
  it('[1] natural cancel phrasing → REQUEST_CANCELLATION; interruptions / negation / bare "cancel" are NOT cancellations', () => {
    for (const t of ['ticket cancel kar do', 'booking hata do', '12014 wali booking cancel karo', 'cancel it', 'Delhi wali ticket cancel karni hai', 'phir se cancel karo']) {
      expect(classifyLifecycleIntent(t)?.action, t).toBe('REQUEST_CANCELLATION');
    }
    expect(classifyLifecycleIntent('phir se cancel karo')!.retry).toBe(true);
    for (const t of ['cancel', 'ruk jao', 'cancel karo ruko', 'cancel mat karo', 'rehne do', 'stop', 'band karo', 'booking cancel nahi karni']) expect(classifyLifecycleIntent(t), t).toBeNull();
    expect(classifyLifecycleIntent('cancel hua kya?')?.action).toBe('ACTION_STATUS');
    expect(classifyLifecycleIntent('kya ye booking cancel ho sakti hai')?.action).toBe('CHECK_CANCELLATION_ELIGIBILITY');
    expect(classifyLifecycleIntent('refund status kya hai')?.action).toBe('CHECK_REFUND_STATUS');
    expect(classifyLifecycleIntent('passenger 2 hata do')).toMatchObject({ action: 'REQUEST_PASSENGER_CHANGE', changes: { passenger: { op: 'REMOVE', passengerNumber: 2 } } });
  });
  it('[2] modification parsing: date via backend DateResolver, class target, passenger contract fields only', () => {
    const d = classifyLifecycleIntent('journey date parso kar do')!;
    expect(d.action).toBe('REQUEST_JOURNEY_CHANGE');
    expect(d.changes.journeyDate).toBe(istDay(Date.now() + 2 * 86400_000));
    expect(classifyLifecycleIntent('CC se 2A kar do')).toMatchObject({ action: 'REQUEST_CLASS_CHANGE', changes: { travelClass: '2A' } });
    expect(classifyLifecycleIntent('class change karni hai')).toMatchObject({ action: 'REQUEST_CLASS_CHANGE', changes: {} });
    expect(classifyLifecycleIntent('passenger 2 ki age 29 kar do')).toMatchObject({ changes: { passenger: { op: 'CORRECT', passengerNumber: 2, field: 'age', value: 29 } } });
    expect(classifyLifecycleIntent('passenger 1 ka naam Priya Sharma kar do')).toMatchObject({ changes: { passenger: { field: 'name', value: 'Priya Sharma' } } });
    expect(classifyLifecycleIntent('booking change karni hai')?.action).toBe('REQUEST_MODIFICATION');
    expect(classifyLifecycleIntent('Amritsar se Delhi kal 2 log')).toBeNull();
  });
  it('[3] controlled enum: unknown LLM labels → UNSUPPORTED_ACTION; confirmation words are explicit only', () => {
    expect(parseLifecycleAction('REQUEST_CANCELLATION')).toBe('REQUEST_CANCELLATION');
    expect(parseLifecycleAction('CANCEL_AND_REFUND_NOW')).toBe('UNSUPPORTED_ACTION');
    expect(parseLifecycleAction({ evil: true })).toBe('UNSUPPORTED_ACTION');
    expect(parseLifecycleAction(undefined)).toBe('NO_ACTION');
    for (const t of ['haan', 'yes', 'confirm', 'cancel it', 'haan cancel kar do', 'Haan.']) expect(isLifecycleConfirmation(t), t).toBe(true);
    for (const t of ['nahi', 'haan nahi', 'shayad', 'ruk jao', 'kal batata hoon', 'cancel mat karo']) expect(isLifecycleConfirmation(t), t).toBe(false);
  });
});

describe('G2 — capability + validator guards', () => {
  it('[4] capability = declared AND implemented; disabled provider → nothing; specific changes need MODIFY_BOOKING', () => {
    expect(resolveProviderActionCapabilities(new DisabledBookingProvider() as any)).toEqual(NO_ACTION_CAPABILITIES);
    expect(resolveProviderActionCapabilities(new MockBookingProvider({ execute: 'CONFIRMED' }))).toMatchObject({ BOOK: true, CANCEL_BOOKING: false, MODIFY_BOOKING: false, GET_REFUND_STATUS: false });
    const lying = new MockBookingProvider({ execute: 'CONFIRMED', declareOnly: ['CANCEL_BOOKING', 'GET_REFUND_STATUS', 'CHANGE_CLASS'] });
    expect(resolveProviderActionCapabilities(lying)).toMatchObject({ CANCEL_BOOKING: false, GET_REFUND_STATUS: false, CHANGE_CLASS: false });
    const c = resolveProviderActionCapabilities(new MockBookingProvider({ execute: 'CONFIRMED', cancel: 'CONFIRMED', modify: 'MODIFIED', modifyTypes: ['CLASS'], refund: 'PENDING' }));
    expect(c).toMatchObject({ CANCEL_BOOKING: true, MODIFY_BOOKING: true, CHANGE_CLASS: true, CHANGE_JOURNEY: false, CHANGE_PASSENGER: false, GET_REFUND_STATUS: true, GET_CANCELLATION_STATUS: false });
  });
  it('[5] validator order + typed rejections (no provider call on any failure)', () => {
    const { rec } = setup({ cancel: 'CONFIRMED' });
    const v = new BookingActionValidator();
    const caps = resolveProviderActionCapabilities(new MockBookingProvider({ execute: 'CONFIRMED', cancel: 'CONFIRMED' }));
    const base = { action: 'REQUEST_CANCELLATION' as const, record: rec, capabilities: caps, latestDestructive: null, phase: 'PREPARE' as const, explicitIntent: true, today: TODAY };
    expect(v.validate({ ...base, action: 'UNSUPPORTED_ACTION' })).toMatchObject({ ok: false, code: 'ACTION_NOT_SUPPORTED' });
    expect(v.validate({ ...base, record: null })).toMatchObject({ ok: false, code: 'BOOKING_NOT_FOUND' });
    expect(v.validate({ ...base, explicitIntent: false })).toMatchObject({ ok: false, code: 'ACTION_NOT_ALLOWED' });
    expect(v.validate({ ...base, record: { ...rec, bookingStatus: 'CANCELLED' } as any })).toMatchObject({ ok: false, code: 'ACTION_ALREADY_COMPLETED', message: LIFECYCLE_MESSAGES.ALREADY_CANCELLED });
    expect(v.validate({ ...base, record: { ...rec, cancellationStatus: 'PENDING' } as any })).toMatchObject({ ok: false, code: 'ACTION_ALREADY_PENDING' });
    expect(v.validate({ ...base, record: { ...rec, cancellationStatus: 'UNKNOWN' } as any, retryRequested: true })).toMatchObject({ ok: false, code: 'UNSAFE_RETRY' });
    expect(v.validate({ ...base, record: { ...rec, bookingStatus: 'UNKNOWN' } as any })).toMatchObject({ ok: false, code: 'INVALID_BOOKING_STATE' });
    expect(v.validate({ ...base, record: { ...rec, journeyDate: '2020-01-01' } as any })).toMatchObject({ ok: false, code: 'CANCELLATION_NOT_ELIGIBLE' });
    expect(v.validate({ ...base, capabilities: null })).toMatchObject({ ok: false, code: 'PROVIDER_ACTION_UNAVAILABLE' });
    expect(v.validate({ ...base, capabilities: NO_ACTION_CAPABILITIES })).toMatchObject({ ok: false, code: 'ACTION_NOT_SUPPORTED', message: LIFECYCLE_MESSAGES.CANCEL_UNSUPPORTED });
    expect(v.validate({ ...base, record: { ...rec, providerReference: null } as any })).toMatchObject({ ok: false, code: 'ACTION_NOT_ALLOWED' });
    expect(v.validate({ ...base, phase: 'EXECUTE' })).toMatchObject({ ok: false, code: 'ACTION_REQUIRES_CONFIRMATION' });
    expect(v.validate({ ...base, phase: 'EXECUTE', confirmation: { required: true, received: true } })).toMatchObject({ ok: true, capability: 'CANCEL_BOOKING' });
    expect(v.validate({ ...base, action: 'CHECK_REFUND_STATUS', phase: 'READ', capabilities: NO_ACTION_CAPABILITIES })).toMatchObject({ ok: false, code: 'REFUND_STATUS_UNAVAILABLE' });
  });
  it('[6] unsupported cancellation → exact message, provider never called (method absent)', async () => {
    const { svc, sid, p } = setup({});
    const r = await turn(svc, sid, 'ticket cancel kar do');
    expect(r.code).toBe('ACTION_NOT_SUPPORTED');
    expect(r.msg).toBe('Is booking ke liye cancellation provider ke through available nahi hai.');
    expect((p as any).cancelBooking).toBeUndefined();
    expect(svc.listActions(sid)).toEqual([]);
  });
});

describe('G2 — confirmation guard', () => {
  it('[7] request → confirmation prompt (no call); only an explicit "haan" on a LATER turn authorizes an attempt', async () => {
    const { svc, sid, p, state } = setup({ cancel: 'CONFIRMED' });
    const a = await turn(svc, sid, '12014 wali booking cancel kar do');
    expect(a.msg).toContain('Main 12014 ki booking cancel karne ki request prepare kar raha hoon');
    expect(a.msg).toMatch(CONFIRM_REQUIRED); expect(a.msg).not.toMatch(/\?/);   // P42.1: confirmation-required fact; the LLM words the question
    expect(p.cancelCalls).toBe(0);
    const pend = state.getSession(sid).pendingLifecycleAction!;
    expect(svc.actions.get(pend.actionId)!.status).toBe('AWAITING_ACTION_CONFIRMATION');
    // same-turn confirmation is impossible: the pending action is ignored on its own turn
    const same = svc.handleTurn(sid, 'haan', { turnId: pend.setAtTurnId, mode: 'TEXT', emit: () => {} });
    expect(same.type).not.toBe('ASYNC');
    const b = await turn(svc, sid, 'haan');
    expect(b.h.type).toBe('ASYNC');
    expect(p.cancelCalls).toBe(1);
  });
  it('[8] topic change / "nahi" / expiry → abandoned, nothing sent; LLM label alone never acts', async () => {
    let now = Date.now();
    const { svc, sid, p } = setup({ cancel: 'CONFIRMED' }, { ttl: 1000, clock: () => now });
    await turn(svc, sid, 'booking cancel kar do');
    const no = await turn(svc, sid, 'nahi rehne do');
    expect(no.msg).toMatch(/koi request provider ko nahi bheji/);
    await turn(svc, sid, 'booking cancel kar do');
    await turn(svc, sid, 'kal ka weather kaisa hai');           // topic change → abandoned
    expect((await turn(svc, sid, 'haan')).h.type).not.toBe('ASYNC');
    await turn(svc, sid, 'booking cancel kar do');
    now += 5000;                                                // expired
    expect((await turn(svc, sid, 'haan')).h.type).not.toBe('ASYNC');
    const llm = await turn(svc, sid, 'theek hai', 'TEXT', 'REQUEST_CANCELLATION');
    expect(llm.h.type).toBe('DEFER');
    expect(p.cancelCalls).toBe(0);
    expect(svc.listActions(sid).every(a => ['ACTION_ABANDONED', 'ACTION_EXPIRED'].includes(a.status))).toBe(true);
    expect(svc.actionLog(sid).some(l => l.actionType === 'REQUEST_CANCELLATION' && l.rejectionReason === 'ACTION_NOT_ALLOWED')).toBe(true);
  });
});

describe('G2 — cancellation outcomes', () => {
  it('[9] success: provider CANCELLED → record CANCELLED (PROVIDER_ACTION), history preserved, refund stays NOT_AVAILABLE', async () => {
    const { svc, sid, p, store, rec } = setup({ cancel: 'CONFIRMED' });
    await turn(svc, sid, 'booking cancel kar do');
    const r = await turn(svc, sid, 'haan');
    expect(r.msg).toContain('Booking provider ne cancellation confirm kar di hai.');
    const after = cur(store, sid, rec.bookingId);
    expect(after).toMatchObject({ bookingStatus: 'CANCELLED', cancellationStatus: 'CANCELLED', statusSource: 'PROVIDER_ACTION', refundStatus: 'NOT_AVAILABLE', modificationStatus: 'NOT_REQUESTED' });
    for (const k of ['journey', 'train', 'bookingCreatedAt', 'providerReference', 'pnr', 'fareSummary', 'journeyDate', 'travelClass', 'executionId'] as const) expect(after[k]).toEqual(rec[k]);
    expect(Object.isFrozen(after)).toBe(true);
    expect(svc.listActions(sid)[0]).toMatchObject({ actionType: 'REQUEST_CANCELLATION', status: 'ACTION_CONFIRMED', resultStatus: 'CANCELLED' });
    expect(p.cancelRequests[0].idempotencyKey).toBe(`cancel:${rec.bookingId}:${svc.listActions(sid)[0].actionId}`);
    expect(r.events).toEqual(expect.arrayContaining(['BOOKING_ACTION_CONFIRMED_BY_USER', 'BOOKING_ACTION_SUBMITTED', 'BOOKING_CANCELLATION_CONFIRMED', 'BOOKING_ACTION_RESULT']));
    // already cancelled → no call
    const again = await turn(svc, sid, 'booking cancel kar do');
    expect(again.msg).toBe('Ye booking already cancelled status mein hai.');
    expect(p.cancelCalls).toBe(1);
  });
  it('[10] provider FAILED → booking still CONFIRMED; a NEW explicit request (new action + confirmation) is allowed', async () => {
    const { svc, sid, p, store, rec } = setup({ cancel: 'FAILED' });
    await turn(svc, sid, 'booking cancel kar do');
    const r = await turn(svc, sid, 'haan');
    expect(r.code).toBe('PROVIDER_ACTION_FAILED');
    expect(r.msg).toMatch(/reject kar di.*Booking abhi bhi confirmed hai/);
    expect(cur(store, sid, rec.bookingId)).toMatchObject({ bookingStatus: 'CONFIRMED', cancellationStatus: 'FAILED' });
    const again = await turn(svc, sid, 'booking cancel kar do');
    expect(again.msg).toMatch(CONFIRM_REQUIRED); expect(again.msg).not.toMatch(/\?/);   // P42.1: confirmation-required fact; the LLM words the question
    expect(p.cancelCalls).toBe(1);
  });
  it('[11] timeout without status support → MANUAL_VERIFICATION_REQUIRED (never CANCELLED); "phir se cancel karo" blocked', async () => {
    const { svc, sid, p, store, rec } = setup({ cancel: 'TIMEOUT' });
    await turn(svc, sid, 'booking cancel kar do');
    const r = await turn(svc, sid, 'haan');
    expect(r.msg).toContain('Cancellation request ka final status abhi verify nahi hua hai. Duplicate cancellation avoid karne ke liye main dobara request nahi bhej raha.');
    expect(r.code).toBe('MANUAL_VERIFICATION_REQUIRED');
    expect(cur(store, sid, rec.bookingId)).toMatchObject({ bookingStatus: 'CONFIRMED', cancellationStatus: 'MANUAL_VERIFICATION_REQUIRED' });
    const retry = await turn(svc, sid, 'phir se cancel karo');
    expect(retry.code).toBe('UNSAFE_RETRY');
    expect(retry.msg).toMatch(/result abhi establish nahi hua hai/);
    expect(p.cancelCalls).toBe(1);
  });
  it('[12] UNKNOWN (5xx after send) → bounded reconciliation → still UNKNOWN; later status check resolves CANCELLED; never resent', async () => {
    const { svc, sid, p, store, rec } = setup({ cancel: 'UNKNOWN', cancelStatus: ['UNKNOWN', 'CANCELLED'] });
    await turn(svc, sid, 'booking cancel kar do');
    const r = await turn(svc, sid, 'haan');
    expect(r.code).toBe('CANCELLATION_UNKNOWN');
    expect(cur(store, sid, rec.bookingId)).toMatchObject({ bookingStatus: 'CONFIRMED', cancellationStatus: 'UNKNOWN' });
    expect(p.cancelStatusCalls).toBe(1);
    const retry = await turn(svc, sid, 'phir se cancel karo');           // unsafe retry → status check only
    expect(retry.code).toBe('UNSAFE_RETRY');
    expect(retry.msg).toMatch(/dobara request nahi bhej raha.*Booking provider ne cancellation confirm kar di hai/);
    expect(cur(store, sid, rec.bookingId)).toMatchObject({ bookingStatus: 'CANCELLED', cancellationStatus: 'CANCELLED' });
    expect(p.cancelCalls).toBe(1);
    expect(p.cancelStatusCalls).toBe(2);
  });
  it('[13] duplicate protection: concurrent EXECUTE (HTTP / websocket / voice retries) → one provider call; repeated "haan" answered from the record', async () => {
    const { svc, sid, p, state } = setup({ cancel: 'CONFIRMED' });
    await turn(svc, sid, 'booking cancel kar do');
    const actionId = state.getSession(sid).pendingLifecycleAction!.actionId;
    const ctx = { turnId: 'x', mode: 'TEXT' as const, emit: () => {} };
    const [a, b, c] = await Promise.all([svc.run(sid, { kind: 'EXECUTE', actionId }, ctx), svc.run(sid, { kind: 'EXECUTE', actionId }, ctx), svc.run(sid, { kind: 'EXECUTE', actionId }, ctx)]);
    expect(p.cancelCalls).toBe(1);
    expect([a, b, c].filter(x => !x.error).length).toBe(1);
    const dup = await turn(svc, sid, 'haan');
    expect(dup.code).toBe('ACTION_ALREADY_COMPLETED');
    expect(p.cancelCalls).toBe(1);
    expect(p.duplicateKeyCalls).toBe(0);
  });
  it('[14] PENDING → no new request; NOT_SENT → nothing happened at provider', async () => {
    const pend = setup({ cancel: 'PENDING' });
    await turn(pend.svc, pend.sid, 'booking cancel kar do');
    expect((await turn(pend.svc, pend.sid, 'haan')).msg).toMatch(/pending hai/);
    expect(cur(pend.store, pend.sid, pend.rec.bookingId)).toMatchObject({ bookingStatus: 'CONFIRMED', cancellationStatus: 'PENDING' });
    expect((await turn(pend.svc, pend.sid, 'booking cancel kar do')).code).toBe('ACTION_ALREADY_PENDING');
    expect(pend.p.cancelCalls).toBe(1);
    const ns = setup({ cancel: 'NOT_SENT' });
    await turn(ns.svc, ns.sid, 'booking cancel kar do');
    expect((await turn(ns.svc, ns.sid, 'haan')).code).toBe('PROVIDER_ACTION_UNAVAILABLE');
    expect(cur(ns.store, ns.sid, ns.rec.bookingId).cancellationStatus).toBe('NOT_REQUESTED');
  });
  it('[15] eligibility NOT_ELIGIBLE → no request prepared; invalid provider response → UNKNOWN (never CANCELLED)', async () => {
    const e = setup({ cancel: 'CONFIRMED', cancelEligibility: 'NOT_ELIGIBLE' });
    const r = await turn(e.svc, e.sid, 'booking cancel kar do');
    expect(r.code).toBe('CANCELLATION_NOT_ELIGIBLE');
    expect(e.state.getSession(e.sid).pendingLifecycleAction).toBeUndefined();
    expect(e.p.cancelCalls).toBe(0);
    expect(normalizeCancellationResponse({ status: 'DONE' }).status).toBe('UNKNOWN');
    expect(normalizeCancellationResponse({ status: 'CANCELLED' })).toMatchObject({ status: 'CANCELLED', evidence: 'PROVIDER' });
    expect(normalizeModificationResponse({ status: 'MODIFIED', applied: { journeyDate: 'kal' } }).status).toBe('UNKNOWN');
    expect(normalizeRefundResponse({ status: 'MAYBE' })).toBeNull();
  });
});

describe('G2 — modification', () => {
  it('[16] capability: no modify → generic / date / class messages; modifyTypes restrict change types', async () => {
    const none = setup({});
    expect((await turn(none.svc, none.sid, 'booking change karni hai')).msg).toBe('Is booking ke liye modification provider ke through available nahi hai.');
    expect((await turn(none.svc, none.sid, 'journey date parso kar do')).msg).toBe('Is booking ke liye date modification available nahi hai.');
    const cls = setup({ modify: 'MODIFIED', modifyTypes: ['CLASS'], modifyEligibility: 'ELIGIBLE' });
    expect((await turn(cls.svc, cls.sid, 'journey date parso kar do')).msg).toBe('Is booking ke liye date modification available nahi hai.');
    expect((await turn(cls.svc, cls.sid, 'booking change karni hai')).msg).toMatch(/change ho sakte hain: class/);   // P42.1: fact (options); the LLM asks
    expect(cls.p.modifyCalls).toBe(0);
  });
  it('[17] validation: same class, invalid passenger, ADD passenger, missing fare → rejected, nothing sent', async () => {
    const m = setup({ modify: 'MODIFIED', modifyEligibility: 'ELIGIBLE' });
    expect((await turn(m.svc, m.sid, 'class CC kar do')).code).toBe('MODIFICATION_NOT_ELIGIBLE');
    expect((await turn(m.svc, m.sid, 'passenger 5 ki age 29 kar do')).code).toBe('MODIFICATION_NOT_ELIGIBLE');
    expect((await turn(m.svc, m.sid, 'passenger 2 ki age 300 kar do')).code).toBe('MODIFICATION_NOT_ELIGIBLE');
    expect((await turn(m.svc, m.sid, 'ek aur passenger add kar do')).msg).toMatch(/supported nahi hai/);
    const nf = setup({ modify: 'MODIFIED' });                                  // no eligibility API → no fare
    const r = await turn(nf.svc, nf.sid, 'CC se 2A kar do');
    expect(r.code).toBe('FARE_UNAVAILABLE');
    expect(r.msg).not.toMatch(/₹/);
    const nf2 = setup({ modify: 'MODIFIED', modifyEligibility: 'ELIGIBLE_NO_FARE' });
    expect((await turn(nf2.svc, nf2.sid, 'CC se 2A kar do')).code).toBe('FARE_UNAVAILABLE');
    expect(m.p.modifyCalls + nf.p.modifyCalls + nf2.p.modifyCalls).toBe(0);
  });
  it('[18] class change: provider fare shown, confirmation, MODIFIED → current representation; original preserved', async () => {
    const { svc, sid, p, store, rec } = setup({ modify: 'MODIFIED', modifyEligibility: 'ELIGIBLE', fareDifference: 500 });
    const a = await turn(svc, sid, 'CC se 2A kar do');
    expect(a.msg).toMatch(/class 2A karne ki request prepare/);
    expect(a.msg).toContain('₹500 extra');
    expect(p.modifyCalls).toBe(0);
    const mods = svc.actions.modificationsFor(sid, rec.bookingId);
    expect(mods[0]).toMatchObject({ changeType: 'CLASS', status: 'AWAITING_CONFIRMATION', previous: { travelClass: 'CC' }, fareDifference: { amount: 500, source: 'PROVIDER' } });
    const b = await turn(svc, sid, 'haan');
    expect(b.msg).toMatch(/class change confirm kar diya hai — nayi class: 2A/);
    const after = cur(store, sid, rec.bookingId);
    expect(after).toMatchObject({ travelClass: 'CC', modificationStatus: 'MODIFIED', current: { travelClass: '2A', journeyDate: TOMORROW, passengersCount: 2 } });
    expect(after.fareSummary).toEqual(rec.fareSummary);
    expect(p.modifyRequests[0]).toMatchObject({ changeType: 'CLASS', changes: { travelClass: '2A' } });
    expect(p.modifyRequests[0].idempotencyKey).toMatch(/^modify:/);
  });
  it('[19] journey change timeout → MANUAL; failed / ALREADY_MODIFIED → no change; passenger correction needs no fare', async () => {
    const t = setup({ modify: 'TIMEOUT', modifyEligibility: 'ELIGIBLE' });
    await turn(t.svc, t.sid, 'journey date parso kar do');
    const r = await turn(t.svc, t.sid, 'haan');
    expect(r.msg).toMatch(/Modification request ka final status abhi verify nahi hua hai/);
    expect(cur(t.store, t.sid, t.rec.bookingId)).toMatchObject({ modificationStatus: 'MANUAL_VERIFICATION_REQUIRED', current: null, journeyDate: TOMORROW });
    expect((await turn(t.svc, t.sid, 'CC se 2A kar do')).code).toBe('MODIFICATION_UNKNOWN');
    expect(t.p.modifyCalls).toBe(1);
    const f = setup({ modify: 'ALREADY_MODIFIED', modifyEligibility: 'ELIGIBLE' });
    await turn(f.svc, f.sid, 'CC se 2A kar do');
    expect((await turn(f.svc, f.sid, 'haan')).code).toBe('PROVIDER_ACTION_FAILED');
    expect(cur(f.store, f.sid, f.rec.bookingId)).toMatchObject({ travelClass: 'CC', current: null, modificationStatus: 'FAILED' });
    const pc = setup({ modify: 'MODIFIED' });
    const a = await turn(pc.svc, pc.sid, 'passenger 2 ki age 29 kar do');
    expect(a.msg).toMatch(/passenger 2 ki age update karne ki request/);
    await turn(pc.svc, pc.sid, 'haan');
    expect(pc.p.modifyRequests[0].changes.passenger).toEqual({ op: 'CORRECT', passengerNumber: 2, field: 'age', value: 29 });
  });
});

describe('G2 — refund separation, store guards, idempotency, history', () => {
  it('[20] refund: unsupported → REFUND_STATUS_UNAVAILABLE; supported → separate RefundStatus, cancellation untouched', async () => {
    const u = setup({ cancel: 'CONFIRMED' });
    await turn(u.svc, u.sid, 'booking cancel kar do'); await turn(u.svc, u.sid, 'haan');
    const r = await turn(u.svc, u.sid, 'refund kab aayega?');
    expect(r.code).toBe('REFUND_STATUS_UNAVAILABLE');
    expect(cur(u.store, u.sid, u.rec.bookingId)).toMatchObject({ cancellationStatus: 'CANCELLED', refundStatus: 'NOT_AVAILABLE' });
    const s = setup({ refund: 'PROCESSED' });
    const r2 = await turn(s.svc, s.sid, 'refund status batao');
    expect(r2.msg).toMatch(/refund processed hai \(₹410\)/);
    expect(cur(s.store, s.sid, s.rec.bookingId)).toMatchObject({ refundStatus: 'PROCESSED', cancellationStatus: 'NOT_REQUESTED', bookingStatus: 'CONFIRMED' });
    await turn(s.svc, s.sid, 'refund status batao');
    expect(s.p.refundCalls).toBe(2);                                    // always a fresh provider call
  });
  it('[21] store: lifecycle updates need provider action evidence; history fields immutable', () => {
    const { store, sid, rec } = setup({});
    expect(store.applyCancellation(sid, rec.bookingId, { source: 'ACTION_OUTCOME_UNCERTAIN', actionId: 'a', providerStatus: 'CANCELLED' })).toMatchObject({ ok: false, code: 'AUTHORITATIVE_DATA_REQUIRED' });
    expect(store.applyCancellation(sid, rec.bookingId, { source: 'PROVIDER_ACTION', actionId: 'a', providerStatus: 'PENDING' })).toMatchObject({ ok: false, code: 'AUTHORITATIVE_DATA_REQUIRED' });
    expect(store.updateCancellationStatus(sid, rec.bookingId, 'PENDING', { source: 'ACTION_OUTCOME_UNCERTAIN', actionId: 'a', providerStatus: null })).toMatchObject({ ok: false });
    expect(store.updateModificationStatus(sid, rec.bookingId, 'MODIFIED', { source: 'PROVIDER_ACTION', actionId: 'a', providerStatus: 'MODIFIED' })).toMatchObject({ ok: false });
    expect(store.updateRefundStatus(sid, rec.bookingId, 'PROCESSED', null, { source: 'ACTION_OUTCOME_UNCERTAIN', actionId: 'a', providerStatus: null })).toMatchObject({ ok: false });
    expect(store.updateCancellationStatus(sid, rec.bookingId, 'UNKNOWN', { source: 'ACTION_OUTCOME_UNCERTAIN', actionId: 'a', providerStatus: null })).toMatchObject({ ok: true });
    expect(store.applyCancellation('other-session', rec.bookingId, { source: 'PROVIDER_ACTION', actionId: 'a', providerStatus: 'CANCELLED' })).toMatchObject({ ok: false, code: 'BOOKING_ACCESS_DENIED' });
    const ok = store.applyCancellation(sid, rec.bookingId, { source: 'PROVIDER_ACTION', actionId: 'a', providerStatus: 'CANCELLED' });
    expect(ok.ok).toBe(true);
    expect(store.updateCancellationStatus(sid, rec.bookingId, 'FAILED', { source: 'PROVIDER_ACTION', actionId: 'b', providerStatus: 'FAILED' })).toMatchObject({ ok: false, code: 'BOOKING_RECORD_NOT_MUTABLE' });
  });
  it('[22] action store: idempotency key claimable once; invalid transitions rejected; records frozen', () => {
    const st = new LifecycleActionStore();
    expect(st.claimKey('cancel:bk:act')).toBe(true);
    expect(st.claimKey('cancel:bk:act')).toBe(false);
    const a = st.create({ actionId: 'act_1', bookingId: 'bk', sessionId: 's', actionType: 'REQUEST_CANCELLATION', requestedAt: new Date().toISOString(), providerName: 'test', providerReference: 'R', status: 'AWAITING_ACTION_CONFIRMATION', idempotencyKey: 'k', modificationId: null });
    expect(Object.isFrozen(a)).toBe(true);
    expect(st.transition('act_1', 'ACTION_CONFIRMED')).toMatchObject({ ok: false, code: 'INVALID_ACTION_TRANSITION' });
    expect(st.transition('act_1', 'ACTION_IN_PROGRESS').ok).toBe(true);
    expect(st.transition('act_1', 'AWAITING_ACTION_CONFIRMATION')).toMatchObject({ ok: false });
    expect(st.get('act_1')!.history.map(h => h.status)).toEqual(['ACTION_REQUESTED', 'AWAITING_ACTION_CONFIRMATION', 'ACTION_IN_PROGRESS']);
  });
  it('[23] multiple bookings → clarification (never a guess); follow-up resolves; 0 matches → BOOKING_NOT_FOUND', async () => {
    const { svc, sid, store, p } = setup({ cancel: 'CONFIRMED' });
    seed(store, sid, p.name, { train: { trainNumber: '14542', trainName: 'Test Express' }, providerReference: 'TEST-REF-X2' });
    const a = await turn(svc, sid, 'Delhi wali booking cancel kar do');
    expect(a.code).toBe('MULTIPLE_BOOKINGS_MATCHED');
    expect(a.msg).toMatch(/12014|14542/);
    const b = await turn(svc, sid, '14542 wali');
    expect(b.msg).toContain('Main 14542 ki booking cancel karne ki request prepare kar raha hoon');
    expect((await turn(svc, sid, '99999 wali booking cancel karo')).code).toBe('BOOKING_NOT_FOUND');
    expect(p.cancelCalls).toBe(0);
  });
  it('[24] observability: required fields, no PNR / passenger values / secrets; LLM claim guard strips fake outcomes', async () => {
    const { svc, sid } = setup({ cancel: 'CONFIRMED', modify: 'MODIFIED' });
    await turn(svc, sid, 'booking cancel kar do'); await turn(svc, sid, 'haan');
    const log = svc.actionLog(sid);
    expect(log.length).toBeGreaterThan(1);
    for (const k of ['sessionId', 'turnId', 'bookingId', 'actionId', 'actionType', 'provider', 'previousStatus', 'newStatus', 'capability', 'validationResult', 'confirmationRequired', 'confirmationReceived', 'providerResult', 'latencyMs', 'rejectionReason']) expect(log[log.length - 1]).toHaveProperty(k);
    expect(JSON.stringify(log)).not.toContain(PNR);
    expect(findSensitiveFields(log)).toEqual([]);
    expect(findSensitiveFields(svc.actions.forSession(sid))).toEqual([]);
    expect(lifecycleClaimGuard('Aapki booking cancel ho gayi hai. Refund mil gaya. 12014 kal chalegi.')).not.toMatch(/cancel ho gayi|Refund mil gaya/);
    expect(lifecycleClaimGuard('Date change ho gayi hai, ₹500 extra lagega.')).not.toMatch(/change ho gayi|₹500/);
    expect(lifecycleClaimGuard('12014 kal 6 baje chalegi.')).toBe('12014 kal 6 baje chalegi.');
  });
});
