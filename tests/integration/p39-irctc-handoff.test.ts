/**
 * P39 — G4 (backend): IRCTCHandoffManager + IRCTCStationFormatter on the real confirmation chain
 * (MockLLMProvider + mock railway provider — no network, no IRCTC, nothing booked).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { BookingState } from '../../shared/states';
import { IrctcHandoffManager } from '../../server/irctc/handoff/irctc-handoff-manager';
import { formatIrctcClass, formatIrctcDate, formatIrctcPassenger, formatIrctcStation } from '../../server/irctc/handoff/irctc-station-formatter';
import { IRCTC_TEXT, IRCTC_MAX_PASSENGERS } from '../../shared/irctc-handoff';
import { checkNoSensitiveData } from '../../server/booking/handoff/sensitive-data-guard';

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT'): Promise<any> => orch.processTurn(sid, text, mode);
const S = (sid: string): any => state.getSession(sid);
async function toHandoff() {
  const sid = state.createSession().sessionId;
  await say(sid, 'Amritsar se Delhi kal 2 log');
  await say(sid, '12497');
  await say(sid, 'CC');
  await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
  const r = await say(sid, 'haan book karo');
  expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  return { sid, r };
}
const M = () => orch.preparation.irctcHandoffs;

let fetchSpy: any, execSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('mock');
  state = new ConversationStateManager();
  orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  execSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); expect(execSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('P39 G4 — handoff only after the confirmed current review', () => {
  it('[1] confirmation → IRCTC handoff card; booking event sequence unchanged; snapshot from validated data only', async () => {
    const { sid, r } = await toHandoff();
    expect(r.events).toEqual(['BOOKING_CONFIRMATION_REQUESTED', 'BOOKING_CONFIRMATION_CREATED', 'BOOKING_EXECUTION_REQUESTED', 'BOOKING_HANDOFF_CREATED', 'BOOKING_LIFECYCLE_UPDATED', 'BOOKING_EXECUTION_DISABLED', 'BOOKING_HANDOFF_SESSION_CREATED', 'IRCTC_HANDOFF_READY', 'BOOKING_PROVIDER_SELECTED', 'BOOKING_PROVIDER_UNAVAILABLE']);
    const card = r.cards.find((c: any) => c.type === 'irctc_handoff');
    expect(card.data).toMatchObject({ status: 'READY', trainNumber: '12497', travelClass: 'CC', passengersCount: 2, mockData: true });
    expect(JSON.stringify(card.data)).not.toMatch(/Rahul|Neha|bridgeToken/);
    expect(S(sid).irctcHandoff.handoffId).toBe(card.data.handoffId);
    const a = M().ownerAccess(S(sid), Date.now())!;
    expect(a.snapshot.journey.from.code).toBe(S(sid).handoff.snapshot.journey.origin);
    expect(a.snapshot.journey.dateIrctc).toBe(formatIrctcDate(S(sid).handoff.snapshot.date));
    expect(a.snapshot.train.number).toBe('12497');
    expect(a.snapshot.travelClass).toEqual({ code: 'CC', label: 'AC Chair car (CC)' });
    expect(a.snapshot.quota).toEqual({ code: 'GN', label: 'GENERAL' });
    expect(a.snapshot.passengers.map(p => [p.name, p.age, p.gender])).toEqual([['Rahul Sharma', 31, 'Male'], ['Neha Sharma', 28, 'Female']]);
    expect(a.snapshot.userActions.join(' ')).toMatch(/login.*CAPTCHA.*OTP.*Final Book.*Payment/s);
    expect(checkNoSensitiveData(a.snapshot).ok).toBe(true);
    expect(a.bridgeToken).toMatch(/^[0-9a-f]{64}$/);
    expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[2] repeated confirmation ("IRCTC par le chalo" again) re-shows the SAME IRCTC handoff (idempotent)', async () => {
    const { sid, r } = await toHandoff();
    const id = r.cards.find((c: any) => c.type === 'irctc_handoff').data.handoffId;
    const r2 = await say(sid, 'haan book karo');
    const c2 = r2.cards.find((c: any) => c.type === 'irctc_handoff');
    expect(c2?.data.handoffId).toBe(id);
  });

  it('[3] no confirmed review → IRCTC_HANDOFF_NOT_READY (backend-validated, nothing created)', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log');
    await say(sid, '12497'); await say(sid, 'CC');
    await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
    const res = M().create(S(sid), Date.now());
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('IRCTC_HANDOFF_NOT_READY');
    expect(S(sid).irctcHandoff).toBeUndefined();
  });

  it('[4] booking details change after the handoff → STALE_HANDOFF; the extension gets the stale status, events refused', async () => {
    const { sid } = await toHandoff();
    const a = M().ownerAccess(S(sid), Date.now())!;
    await say(sid, 'Actually 3A kar do');
    expect(S(sid).handoff.status).toBe('INVALIDATED');
    const v = M().viewFor(S(sid), Date.now())!;
    expect(v.status).toBe('STALE_HANDOFF');
    expect(v.message).toBe(IRCTC_TEXT.STALE_HANDOFF);
    const snap = M().snapshot(a.view.handoffId, a.bridgeToken, S(sid), Date.now());
    expect(snap.ok && snap.value.status).toBe('STALE_HANDOFF');
    const ev = M().applyEvent(a.view.handoffId, a.bridgeToken, { type: 'PAGE_DETECTED', page: 'PASSENGER' }, S(sid), Date.now());
    expect(!ev.ok && ev.code).toBe('HANDOFF_TERMINAL');
  });
});

describe('P39 G4 — bridge security + metadata-only events', () => {
  it('[5] wrong / missing token rejected; values, unknown keys and credential keys rejected', async () => {
    const { sid } = await toHandoff();
    const a = M().ownerAccess(S(sid), Date.now())!;
    const id = a.view.handoffId;
    expect(M().snapshot(id, 'f'.repeat(64), S(sid), Date.now())).toMatchObject({ ok: false, code: 'BRIDGE_TOKEN_INVALID', status: 401 });
    expect(M().snapshot(id, undefined, S(sid), Date.now())).toMatchObject({ ok: false, code: 'BRIDGE_TOKEN_INVALID' });
    expect(M().snapshot('irh_nope', a.bridgeToken, S(sid), Date.now())).toMatchObject({ ok: false, code: 'IRCTC_HANDOFF_NOT_FOUND' });
    expect(M().applyEvent(id, a.bridgeToken, { type: 'FIELDS_FILLED', page: 'PASSENGER', filled: ['passengerName'], value: 'Rahul' }, S(sid), Date.now())).toMatchObject({ ok: false, code: 'INVALID_EVENT' });
    expect(M().applyEvent(id, a.bridgeToken, { type: 'PAGE_DETECTED', page: 'LOGIN', password: 'x' }, S(sid), Date.now())).toMatchObject({ ok: false, code: 'SENSITIVE_DATA_REJECTED' });
    expect(M().applyEvent(id, a.bridgeToken, { type: 'PAGE_DETECTED', page: 'LOGIN', otp: '123456' }, S(sid), Date.now())).toMatchObject({ ok: false, code: 'SENSITIVE_DATA_REJECTED' });
    expect(M().applyEvent(id, a.bridgeToken, { type: 'BOOK_NOW' }, S(sid), Date.now())).toMatchObject({ ok: false, code: 'INVALID_EVENT' });
    expect(M().eventsOf(id)).toEqual([]);
  });

  it('[6] page flow: login → journey → passengers → READY_FOR_USER_BOOK → OTP → payment → ended without confirmation = BOOKING_STATUS_UNKNOWN', async () => {
    const { sid } = await toHandoff();
    const a = M().ownerAccess(S(sid), Date.now())!;
    const E = (e: any) => { const r = M().applyEvent(a.view.handoffId, a.bridgeToken, e, S(sid), Date.now()); if (!r.ok) throw new Error(r.code); return r.value; };
    expect(E({ type: 'PAGE_DETECTED', page: 'LOGIN' })).toMatchObject({ status: 'LOGIN_REQUIRED', message: 'IRCTC login required. Please enter your User ID and Password.' });
    expect(E({ type: 'PAGE_DETECTED', page: 'HOME_SEARCH' }).status).toBe('JOURNEY_PAGE');
    E({ type: 'FIELDS_FILLED', page: 'HOME_SEARCH', filled: ['from', 'to', 'date', 'travelClass', 'quota'] });
    expect(E({ type: 'PAGE_DETECTED', page: 'TRAIN_LIST' }).status).toBe('TRAIN_LIST');
    expect(E({ type: 'PAGE_DETECTED', page: 'PASSENGER' }).status).toBe('PASSENGER_PAGE');
    E({ type: 'FIELDS_FILLED', page: 'PASSENGER', filled: ['passengerName', 'passengerAge', 'passengerGender'] });
    expect(E({ type: 'FINAL_CONTROL_HIGHLIGHTED', page: 'PASSENGER' })).toMatchObject({ status: 'READY_FOR_USER_BOOK', message: 'IRCTC par saari details fill ho gayi hain. Final Book/Continue action aap khud tap karein.' });
    expect(E({ type: 'PAGE_DETECTED', page: 'REVIEW_CAPTCHA' }).status).toBe('CAPTCHA_REQUIRED');
    expect(E({ type: 'PAGE_DETECTED', page: 'OTP' })).toMatchObject({ status: 'OTP_REQUIRED', message: 'OTP required. Please enter it on the IRCTC/payment page.' });
    expect(E({ type: 'PAGE_DETECTED', page: 'PAYMENT' }).status).toBe('PAYMENT_PAGE');
    expect(E({ type: 'FLOW_ENDED_WITHOUT_CONFIRMATION' }).status).toBe('BOOKING_STATUS_UNKNOWN');
    expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);          // never COMPLETE
    // UNKNOWN is terminal for everything except IRCTC's own outcome evidence seen later
    expect(M().applyEvent(a.view.handoffId, a.bridgeToken, { type: 'PAGE_DETECTED', page: 'PASSENGER' }, S(sid), Date.now())).toMatchObject({ ok: false, code: 'HANDOFF_TERMINAL' });
    expect(M().applyEvent(a.view.handoffId, a.bridgeToken, { type: 'RESUMED' }, S(sid), Date.now())).toMatchObject({ ok: false, code: 'HANDOFF_TERMINAL' });
    expect(E({ type: 'PAGE_DETECTED', page: 'CONFIRMATION' }).status).toBe('COMPLETED');
    expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);          // still never COMPLETE
    expect(JSON.stringify(M().eventsOf(a.view.handoffId))).not.toMatch(/Rahul|Neha|Sharma/);
    expect(M().eventsOf(a.view.handoffId).every(e => Object.keys(e).every(k => ['type', 'page', 'field', 'at'].includes(k)))).toBe(true);
  });

  it('[7] COMPLETED only from the IRCTC confirmation page; failure page → BOOKING_FAILED; BookingSession never COMPLETE', async () => {
    const { sid } = await toHandoff();
    const a = M().ownerAccess(S(sid), Date.now())!;
    M().applyEvent(a.view.handoffId, a.bridgeToken, { type: 'PAGE_DETECTED', page: 'PAYMENT' }, S(sid), Date.now());
    const r = M().applyEvent(a.view.handoffId, a.bridgeToken, { type: 'PAGE_DETECTED', page: 'CONFIRMATION' }, S(sid), Date.now());
    expect(r.ok && r.value.status).toBe('COMPLETED');
    expect(S(sid).bookingState).not.toBe('COMPLETED');
    expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    const { sid: sid2 } = await toHandoff();
    const b = M().ownerAccess(S(sid2), Date.now())!;
    const f = M().applyEvent(b.view.handoffId, b.bridgeToken, { type: 'PAGE_DETECTED', page: 'FAILURE' }, S(sid2), Date.now());
    expect(f.ok && f.value.status).toBe('BOOKING_FAILED');
  });

  it('[8] user override pauses (never overwritten); Resume restores; Stop before the final step = STOPPED, after = UNKNOWN', async () => {
    const { sid } = await toHandoff();
    const a = M().ownerAccess(S(sid), Date.now())!;
    const E = (e: any) => { const r = M().applyEvent(a.view.handoffId, a.bridgeToken, e, S(sid), Date.now()); if (!r.ok) throw new Error(r.code); return r.value; };
    E({ type: 'PAGE_DETECTED', page: 'PASSENGER' });
    const p = E({ type: 'USER_OVERRIDE', field: 'passengerAge' });
    expect(p.status).toBe('PAUSED'); expect(p.userOverrides).toEqual(['passengerAge']); expect(p.message).toMatch(/overwrite nahi/);
    expect(E({ type: 'FINAL_CONTROL_HIGHLIGHTED', page: 'PASSENGER' }).status).toBe('PAUSED');   // never READY while paused
    expect(E({ type: 'RESUMED' }).status).toBe('PASSENGER_PAGE');
    expect(E({ type: 'STOPPED' }).status).toBe('STOPPED');
  });

  it('[9] unfillable passenger field → IRCTC_FIELD_NOT_CONFIRMED keeps the user in charge (no READY_FOR_USER_BOOK)', async () => {
    const { sid } = await toHandoff();
    const a = M().ownerAccess(S(sid), Date.now())!;
    const E = (e: any) => { const r = M().applyEvent(a.view.handoffId, a.bridgeToken, e, S(sid), Date.now()); if (!r.ok) throw new Error(r.code); return r.value; };
    E({ type: 'PAGE_DETECTED', page: 'PASSENGER' });
    E({ type: 'FIELDS_FILLED', page: 'PASSENGER', filled: ['passengerName'], skipped: [{ field: 'passengerAge', reason: 'VALUE_NOT_CONFIRMED' }] });
    const v = E({ type: 'FINAL_CONTROL_HIGHLIGHTED', page: 'PASSENGER' });
    expect(v.status).toBe('PASSENGER_PAGE');
    expect(v.message).toMatch(/IRCTC_FIELD_NOT_CONFIRMED/);
    expect(v.notConfirmed).toEqual(expect.arrayContaining([{ field: 'passengerAge', reason: 'VALUE_NOT_CONFIRMED' }]));
  });
});

describe('P39 G4 — expiry, passenger limit, language, formatter, logging', () => {
  it('[10] TTL expiry before the final step → EXPIRED; after the final step the outcome is still recorded', async () => {
    const { sid } = await toHandoff();
    const logs: any[] = [];
    const m = new IrctcHandoffManager({ ttlMs: 60_000, log: e => logs.push(e) });
    const t0 = Date.now();
    const c = m.create(S(sid), t0);
    expect(c.ok).toBe(true);
    expect(m.viewFor(S(sid), t0 + 61_000)!.status).toBe('EXPIRED');
    const m2 = new IrctcHandoffManager({ ttlMs: 60_000 });
    m2.create(S(sid), t0);
    const a2 = m2.ownerAccess(S(sid), t0)!;
    m2.applyEvent(a2.view.handoffId, a2.bridgeToken, { type: 'PAGE_DETECTED', page: 'PAYMENT' }, S(sid), t0 + 1000);
    expect(m2.viewFor(S(sid), t0 + 120_000)!.status).toBe('PAYMENT_PAGE');
    expect(JSON.stringify(logs)).not.toMatch(/Rahul|Neha|[0-9a-f]{64}/);
  });

  it('[11] more than 6 passengers → IRCTC_PASSENGER_LIMIT_EXCEEDED', async () => {
    const { sid } = await toHandoff();
    const s = structuredClone(S(sid));
    const p0 = s.handoff.snapshot.validatedPassengers[0];
    s.handoff.snapshot.validatedPassengers = Array.from({ length: IRCTC_MAX_PASSENGERS + 1 }, (_, i) => ({ ...p0, passengerId: `p${i}` }));
    const r = new IrctcHandoffManager().create(s, Date.now());
    expect(r).toMatchObject({ ok: false, code: 'IRCTC_PASSENGER_LIMIT_EXCEEDED' });
    expect(!r.ok && r.message).toBe(IRCTC_TEXT.PASSENGER_LIMIT);
  });

  it('[12] language: chosen in BookKaro, recorded from the page, missing selector reported', async () => {
    const { sid } = await toHandoff();
    const a = M().ownerAccess(S(sid), Date.now())!;
    expect(M().setLanguage(S(sid), 'hi', Date.now())).toMatchObject({ ok: true, value: { language: 'hi' } });
    M().applyEvent(a.view.handoffId, a.bridgeToken, { type: 'PAGE_DETECTED', page: 'LANGUAGE' }, S(sid), Date.now());
    const v = M().applyEvent(a.view.handoffId, a.bridgeToken, { type: 'LANGUAGE_SELECTOR_MISSING' }, S(sid), Date.now());
    expect(v.ok && v.value.message).toBe(IRCTC_TEXT.LANGUAGE_UNAVAILABLE);
    const w = M().applyEvent(a.view.handoffId, a.bridgeToken, { type: 'LANGUAGE_SELECTED', language: 'en' }, S(sid), Date.now());
    expect(w.ok && w.value.language).toBe('en');
  });

  it('[13] IRCTCStationFormatter: exact formats, nothing guessed', () => {
    expect(formatIrctcStation('ndls', 'New Delhi')).toEqual({ code: 'NDLS', display: 'NEW DELHI - NDLS', query: 'NDLS' });
    expect(formatIrctcStation('ASR')).toEqual({ code: 'ASR', display: null, query: 'ASR' });
    expect(formatIrctcStation('New Delhi')).toBeNull();
    expect(formatIrctcDate('2026-10-06')).toBe('06/10/2026');
    expect(formatIrctcDate('2026-02-30')).toBeNull();
    expect(formatIrctcClass('3a')).toEqual({ code: '3A', label: 'AC 3 Tier (3A)' });
    expect(formatIrctcClass('ZZ').label).toBeNull();
    const o = formatIrctcPassenger({ name: 'Alex', age: 30, gender: 'OTHER', berthPreference: 'WINDOW' }, 1);
    expect(o.fill).toMatchObject({ gender: null, berth: 'Window Side' });
    expect(o.notConfirmed).toEqual([{ field: 'passengerGender', reason: 'GENDER_NOT_REPRESENTABLE' }]);
    expect(formatIrctcPassenger({ name: 'Venkataramanan Subramaniam', age: 40, gender: 'MALE' }, 1).notConfirmed).toEqual([{ field: 'passengerName', reason: 'NAME_LENGTH_IRCTC_3_16' }]);
    expect(formatIrctcPassenger({ name: 'Neha', age: 28, gender: 'FEMALE', foodPreference: 'NON_VEG' }, 2).fill).toMatchObject({ gender: 'Female', food: 'Non Veg' });
  });
});
