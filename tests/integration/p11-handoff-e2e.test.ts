/**
 * PROMPT 11 — GROUP 3
 * End-to-end: User → Orchestrator → LLM → Railway tools → BookingSession → Review →
 * Confirmation (backend policy) → BookingExecutionGateway → BookingHandoff →
 * BookingHandoffSession → DisabledBookingExecutorAdapter.  Verifies NO real booking.
 *
 * afterEach: IrctcHandoffAdapter.executeHandoff never called, fetch never called,
 * DisabledBookingExecutorAdapter.execute never invoked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import type { LLMProvider } from '../../server/ai/providers/llm-provider';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator, type OrchestratorOptions } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { BookingState } from '../../shared/states';
import { DisabledBookingExecutorAdapter } from '../../server/booking/handoff/disabled-booking-executor-adapter';
import { HANDOFF_READY_MESSAGE } from '../../server/booking/booking-preparation-service';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { findSensitiveFields } from '../../server/booking/handoff/sensitive-data-guard';

const errMeta = (id: string) => { const now = new Date().toISOString(); return { source: 'mock', providerId: id, requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' }; };
class P11Provider extends MockRailwayProvider {
  static fareBump = 0; static availOverride: string | null = null; static failAvail = false; static failFare = false; static calls: string[] = [];
  async getFare(r: any): Promise<any> {
    P11Provider.calls.push(`fare:${r.travelClass}`);
    if (P11Provider.failFare) return { ok: false, error: { code: 'FARE_UNAVAILABLE', message: 'Fare abhi uplabdh nahi hai.' }, meta: errMeta('p11') };
    const res: any = await super.getFare(r);
    if (res.ok && P11Provider.fareBump) { const per = res.data.perPassenger + P11Provider.fareBump; res.data = { ...res.data, perPassenger: per, total: per * res.data.passengersCount, breakdown: { baseFare: per * res.data.passengersCount } }; }
    return res;
  }
  async checkAvailability(r: any): Promise<any> {
    P11Provider.calls.push(`availability:${r.travelClass}`);
    if (P11Provider.failAvail) return { ok: false, error: { code: 'AVAILABILITY_UNAVAILABLE', message: 'Availability abhi uplabdh nahi hai.' }, meta: errMeta('p11') };
    const res: any = await super.checkAvailability(r);
    if (res.ok && P11Provider.availOverride) res.data = { ...res.data, status: P11Provider.availOverride, available: false };
    return res;
  }
}
railwayRegistry.register('p11-provider', () => new P11Provider());

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const mk = (llm: LLMProvider = new MockLLMProvider(), opts: OrchestratorOptions = {}) => { state = new ConversationStateManager(); orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService(), opts); };
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT', opts?: any): Promise<any> => orch.processTurn(sid, text, mode, opts);
const S = (sid: string): any => state.getSession(sid);
const count = (sid: string, type: string) => (S(sid).eventLog || []).filter((e: any) => e.type === type).length;
const pctx = (): any => ({ turnId: 't-g3', mode: 'TEXT', cards: [], events: [], changes: [], requestId: 'rq-g3' });
const FAKE_SUCCESS = /ticket (book ho gaya|booked)|booking (successful|confirmed|ho gayi)|PNR\s*[:#]?\s*\d{6,}|PNR generated|seat (no|number)\s*\d/i;

async function toAwaiting(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  await say(sid, 'Amritsar se Delhi kal 2 log', mode);
  await say(sid, '12497', mode);
  await say(sid, 'CC', mode);
  const r = await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female', mode);
  expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
  return r;
}
async function toHandoff(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  await toAwaiting(sid, mode);
  const r = await say(sid, 'haan book karo', mode);
  expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  expect(S(sid).handoffSession.status).toBe('READY');
  return r;
}

let executeSpy: any, fetchSpy: any, adapterSpy: any;
beforeEach(() => {
  P11Provider.fareBump = 0; P11Provider.availOverride = null; P11Provider.failAvail = false; P11Provider.failFare = false; P11Provider.calls = [];
  railwayRegistry.setActive('p11-provider'); mk();
  executeSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  adapterSpy = vi.spyOn(DisabledBookingExecutorAdapter.prototype, 'execute');
});
afterEach(() => {
  expect(executeSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(adapterSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  railwayRegistry.setActive('mock');
});

// ------------------------------------------------------------------------------------------
describe('G3 — confirmation → handoff → handoff session → disabled adapter', () => {
  it('[1] valid confirmation → BookingConfirmation → handoff → authoritative snapshot → READY session (no credentials) → execution disabled', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const r = await say(sid, 'haan book karo');
    expect(r.events).toEqual(['BOOKING_CONFIRMATION_REQUESTED', 'BOOKING_CONFIRMATION_CREATED', 'BOOKING_EXECUTION_REQUESTED', 'BOOKING_HANDOFF_CREATED',
      'BOOKING_LIFECYCLE_UPDATED', 'BOOKING_EXECUTION_DISABLED', 'BOOKING_HANDOFF_SESSION_CREATED', 'IRCTC_HANDOFF_READY', 'BOOKING_PROVIDER_SELECTED', 'BOOKING_PROVIDER_UNAVAILABLE']);
    expect(r.responseMessage).toContain('Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.');
    expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
    expect(r.responseMessage).not.toMatch(/Ticket booked|PNR generated|Booking confirmed/i);
    const s = S(sid), hs = s.handoffSession;
    expect(hs).toMatchObject({ status: 'READY', reviewVersion: 1, bookingHandoffId: s.handoff.snapshot.handoffId, sessionVersion: s.sessionVersion,
      executorCapability: { enabled: false, executorName: 'disabled', supportsRealBooking: false } });
    expect(hs.bookingSnapshot).toMatchObject({ journey: { origin: 'ASR', destination: 'NDLS' }, date: s.date, selectedClass: 'CC',
      selectedTrain: { trainNumber: '12497', resultId: s.selectedTrain.resultId }, fareSnapshot: { total: 980 }, availabilitySnapshot: { status: s.availability.CC.status } });
    expect(s.confirmation).toMatchObject({ status: 'VALID', reviewVersion: 1, confirmationId: hs.confirmationId });
    for (const o of [s.handoffSession, s.handoff, s.confirmation]) expect(findSensitiveFields(o)).toEqual([]);
    const card = r.cards.find((c: any) => c.type === 'handoff').data;
    expect(card).toMatchObject({ handoffSessionId: hs.handoffSessionId, handoffSessionStatus: 'READY', handoffSessionExpiresAt: hs.expiresAt,
      executorCapability: { enabled: false, executorName: 'disabled', supportsRealBooking: false }, confirmationStatus: 'VALID', realBooking: false, executionEnabled: false });
    expect(r.turnLog).toMatchObject({ handoffSessionStatus: 'READY', confirmationStatus: 'VALID' });
    // creation did NOT execute anything; explicit consume → BOOKING_EXECUTION_DISABLED, never CONSUMED
    const c = await orch.preparation.consumeHandoff(sid, hs.handoffSessionId, pctx());
    expect(c).toMatchObject({ code: 'BOOKING_EXECUTION_DISABLED', executorAttempted: false });
    expect(S(sid).handoffSession.status).toBe('READY');
    expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[29] requestId correlates confirmation, handoff session and audit events (no secrets in audit data)', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const r = await say(sid, 'haan');
    const rid = r.turnLog.requestId;
    expect(rid).toBeTruthy();
    expect(S(sid).confirmation.requestId).toBe(rid);
    expect(S(sid).handoffSession.requestId).toBe(rid);
    const ev = S(sid).eventLog.find((e: any) => e.type === 'BOOKING_HANDOFF_SESSION_CREATED');
    expect(ev.data).toMatchObject({ sessionId: sid, requestId: rid, handoffId: S(sid).handoff.snapshot.handoffId, handoffSessionId: S(sid).handoffSession.handoffSessionId, reviewVersion: 1, status: 'READY' });
    expect(S(sid).eventLog.find((e: any) => e.type === 'BOOKING_CONFIRMATION_CREATED').data).toMatchObject({ requestId: rid, reviewVersion: 1, status: 'VALID' });
    expect(JSON.stringify(S(sid).eventLog)).not.toMatch(/Rahul|Neha|password|otp|captcha|cvv/i);
  });

  it('[17] negative replies (nahi / no / cancel / ruk jao) → no handoff, back to REVIEW, journey kept', async () => {
    for (const t of ['nahi', 'no', 'cancel', 'ruk jao']) {
      const sid = state.createSession().sessionId;
      await toAwaiting(sid);
      const r = await say(sid, t);
      expect([t, r.newState]).toEqual([t, BookingState.REVIEW]);
      expect(S(sid).handoffSession).toBeUndefined();
      expect(S(sid).handoff).toBeUndefined();
      expect(S(sid).confirmation).toBeUndefined();
      expect(S(sid)).toMatchObject({ origin: 'ASR', destination: 'NDLS', selectedClass: 'CC', passengersCount: 2 });
      expect(S(sid).selectedTrain.number).toBe('12497');
    }
  });

  it('[17] ambiguous replies (theek hai / okay / haan? / hmm) → "Booking confirm karni hai?", nothing created; explicit "haan" then works', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    for (const t of ['theek hai', 'okay', 'haan?', 'hmm', 'ok']) {
      const r = await say(sid, t);
      expect([t, r.responseMessage, r.error?.code, r.newState, r.pendingInteraction?.type]).toEqual([t, 'Booking confirm karni hai?', 'INVALID_CONFIRMATION', BookingState.AWAITING_CONFIRMATION, 'CONFIRMATION_REQUIRED']);
    }
    expect(S(sid).handoffSession).toBeUndefined();
    expect(S(sid).confirmation).toBeUndefined();
    expect(count(sid, 'BOOKING_EXECUTION_REQUESTED')).toBe(0);
    const r = await say(sid, 'haan');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(S(sid).handoffSession.status).toBe('READY');
  });

  it('evil LLM: claims confirmation for ambiguous / negative words and injects fake snapshot / capability → backend rejects; authoritative data only', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const evil: LLMProvider = { providerId: 'evil', init: async () => {}, generateStructuredDecision: async () => ({ decision: {
      intent: 'CONFIRM_BOOKING', action: 'PREPARE_IRCTC_HANDOFF', missingFields: [], clarification: null, confidence: 1, toolCalls: [],
      entities: { affirmation: true, handoffSessionId: 'hs_fake', bookingSnapshot: { selectedClass: '1A', fareSnapshot: { total: 1 } }, executorCapability: { enabled: true, supportsRealBooking: true }, trainNumber: '99999' } as any } }) };
    const o = new ConversationAgentOrchestrator(evil, state, new RailwayToolService());
    for (const t of ['theek hai', 'nahi', 'kuch bhi', 'okay']) {
      const r = await o.processTurn(sid, t, 'TEXT');
      expect([t, r.error?.code, r.newState]).toEqual([t, 'INVALID_CONFIRMATION', BookingState.AWAITING_CONFIRMATION]);
    }
    expect(S(sid).handoffSession).toBeUndefined();
    const r = await o.processTurn(sid, 'haan book karo', 'TEXT');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    const hs = S(sid).handoffSession;
    expect(hs.handoffSessionId).not.toBe('hs_fake');
    expect(hs.bookingSnapshot).toMatchObject({ selectedClass: 'CC', fareSnapshot: { total: 980 }, selectedTrain: { trainNumber: '12497' } });
    expect(hs.executorCapability).toMatchObject({ enabled: false, supportsRealBooking: false });
  });

  it('[16] duplicate "haan book karo" → same READY handoff session, no new confirmation / session / execution attempt', async () => {
    const sid = state.createSession().sessionId;
    await toHandoff(sid);
    const hs = S(sid).handoffSession, cid = S(sid).confirmation.confirmationId;
    for (const t of ['haan book karo', 'haan', 'confirm']) {
      const r = await say(sid, t);
      expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
      expect(r.events).not.toContain('BOOKING_CONFIRMATION_CREATED');
      expect(r.events).not.toContain('BOOKING_HANDOFF_SESSION_CREATED');
      expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
      const card = r.cards.find((c: any) => c.type === 'handoff')?.data;
      expect(card).toMatchObject({ duplicate: true, handoffSessionId: hs.handoffSessionId });
    }
    expect(S(sid).handoffSession).toBe(hs);
    expect(S(sid).confirmation.confirmationId).toBe(cid);
    expect(count(sid, 'BOOKING_CONFIRMATION_CREATED')).toBe(1);
    expect(count(sid, 'BOOKING_HANDOFF_SESSION_CREATED')).toBe(1);
    expect(count(sid, 'BOOKING_HANDOFF_CREATED')).toBe(1);
    expect(S(sid).handoffSessionHistory).toHaveLength(1);
    expect(hs.executionAttempts).toBe(0);
  });
});

describe('G3 — changes after handoff invalidate the handoff session', () => {
  it('[9] route change → handoff / session / confirmation INVALIDATED; train, class, availability, fare, review cleared → SHOWING_TRAINS', async () => {
    const sid = state.createSession().sessionId;
    await toHandoff(sid);
    const id = S(sid).handoffSession.handoffSessionId;
    const r = await say(sid, 'Delhi nahi Chandigarh');
    const s = S(sid);
    expect(r.newState).toBe(BookingState.SHOWING_TRAINS);
    expect(s.destination).toBe('CDG');
    expect([s.handoff.status, s.handoffSession.status, s.confirmation.status]).toEqual(['INVALIDATED', 'INVALIDATED', 'INVALIDATED']);
    expect(s.selectedTrain).toBeUndefined();
    expect(s.selectedClass).toBeUndefined();
    expect(s.fare).toBeUndefined();
    expect(s.availability?.CC).toBeUndefined();
    expect(s.review?.valid ?? false).toBe(false);
    expect(r.events).toEqual(expect.arrayContaining(['BOOKING_HANDOFF_INVALIDATED', 'BOOKING_CONFIRMATION_INVALIDATED']));
    expect(await orch.preparation.consumeHandoff(sid, id, pctx())).toMatchObject({ code: 'HANDOFF_INVALIDATED', executorAttempted: false });
  });

  it('[10] date change → INVALIDATED → fresh data → new review → new confirmation → NEW session', async () => {
    const sid = state.createSession().sessionId;
    await toHandoff(sid);
    const old = S(sid).handoffSession, oldConf = S(sid).confirmation;
    P11Provider.calls = [];
    const r = await say(sid, 'Kal nahi parso');
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(old.status).toBe('INVALIDATED');
    expect(oldConf.status).toBe('INVALIDATED');
    expect(P11Provider.calls).toEqual(expect.arrayContaining(['availability:CC', 'fare:CC']));
    expect(S(sid).review).toMatchObject({ valid: true, reviewVersion: 2 });
    const r2 = await say(sid, 'haan');
    expect(r2.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    const hs = S(sid).handoffSession;
    expect(hs.handoffSessionId).not.toBe(old.handoffSessionId);
    expect(hs).toMatchObject({ status: 'READY', reviewVersion: 2 });
    expect(hs.bookingSnapshot.date).toBe(S(sid).date);
    expect(hs.bookingSnapshot.date).not.toBe(old.bookingSnapshot.date);
    expect(S(sid).confirmation.confirmationId).not.toBe(oldConf.confirmationId);
    expect(old.bookingSnapshot.date).not.toBe(S(sid).date);                          // the old snapshot was never mutated
    expect(S(sid).handoffSessionHistory.map((h: any) => h.status)).toEqual(['READY', 'INVALIDATED', 'READY']);
  });

  it('[11][12][13] train → class options; class → refresh + new review; passenger change → validator + new review — session invalidated each time', async () => {
    const cases: Array<[string, BookingState]> = [
      ['Train 12014 kar do', BookingState.CLASS_OPTIONS],
      ['Actually 3A kar do', BookingState.AWAITING_CONFIRMATION],
      ['Passenger 2 ki age 29 kar do', BookingState.AWAITING_CONFIRMATION],
      ['3 log kar do', BookingState.COLLECTING_PASSENGER_DETAILS]
    ];
    for (const [t, expected] of cases) {
      mk();
      const sid = state.createSession().sessionId;
      await toHandoff(sid);
      const hs = S(sid).handoffSession;
      const r = await say(sid, t);
      expect([t, r.newState]).toEqual([t, expected]);
      expect([t, hs.status, S(sid).confirmation.status, S(sid).handoff.status]).toEqual([t, 'INVALIDATED', 'INVALIDATED', 'INVALIDATED']);
      expect(await orch.preparation.consumeHandoff(sid, hs.handoffSessionId, pctx())).toMatchObject({ code: 'HANDOFF_INVALIDATED' });
    }
  });
});

describe('G3 — freshness at confirmation (fake clock)', () => {
  it('[14] fare changed on refresh → review + confirmation invalidated, "Fare ₹980 se ₹1180 ho gaya hai", new review, re-ask; no session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));                 // fare window is 10 min (availability 2 min)
    P11Provider.fareBump = 100;
    const r = await say(sid, 'haan book karo');
    expect(r.error).toMatchObject({ code: 'STALE_REVIEW', details: { changed: ['fare'], previousFare: 980, currentFare: 1180 } });
    expect(r.responseMessage).toContain('Fare ₹980 se ₹1180 ho gaya hai.');
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(S(sid).review).toMatchObject({ valid: true, reviewVersion: 2 });
    expect(S(sid).handoffSession).toBeUndefined();
    expect(S(sid).handoff).toBeUndefined();
    expect(count(sid, 'BOOKING_CONFIRMATION_CREATED')).toBe(0);
    const r2 = await say(sid, 'haan');
    expect(r2.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(S(sid).handoffSession.bookingSnapshot.fareSnapshot.total).toBe(1180);
  });

  it('[15] material availability change on refresh → review invalidated, message, new review; no session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const before = S(sid).availability.CC.status;
    vi.setSystemTime(new Date(Date.now() + 3 * 60_000));
    P11Provider.availOverride = 'WL3';
    const r = await say(sid, 'haan');
    expect(r.error).toMatchObject({ code: 'STALE_REVIEW', details: { changed: ['availability'], previousAvailability: before, currentAvailability: 'WL3' } });
    expect(r.responseMessage).toContain(`Availability ${before} se WL3 ho gayi hai.`);
    expect(S(sid).review).toMatchObject({ valid: true, reviewVersion: 2 });
    expect(S(sid).handoffSession).toBeUndefined();
  });

  it('[12][13] availability / fare cannot be refreshed → handoff blocked, no confirmation, no session', async () => {
    for (const which of ['avail', 'fare'] as const) {
      vi.useFakeTimers({ toFake: ['Date'] });
      mk();
      P11Provider.failAvail = false; P11Provider.failFare = false;
      const sid = state.createSession().sessionId;
      await toAwaiting(sid);
      vi.setSystemTime(new Date(Date.now() + (which === 'fare' ? 11 : 3) * 60_000));   // fare window 10 min, availability 2 min
      if (which === 'avail') P11Provider.failAvail = true; else P11Provider.failFare = true;
      const r = await say(sid, 'haan book karo');
      expect([which, r.newState]).toEqual([which, BookingState.PASSENGERS_READY]);
      expect(['BOOKING_NOT_READY', 'STALE_AVAILABILITY', 'STALE_FARE']).toContain(r.error?.code);
      expect(S(sid).handoffSession).toBeUndefined();
      expect(S(sid).handoff).toBeUndefined();
      expect(S(sid).confirmation).toBeUndefined();
      expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
      vi.useRealTimers();
    }
  });

  it('[2][3] handoff session expires (fake clock) → EXPIRED at next turn → fresh data → new review → new confirmation → new session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sid = state.createSession().sessionId;
    await toHandoff(sid);
    const old = S(sid).handoffSession;
    vi.setSystemTime(new Date(Date.now() + 3 * 60_000));
    P11Provider.calls = [];
    const r = await say(sid, 'haan');
    expect(old.status).toBe('EXPIRED');
    expect(S(sid).handoff.status).toBe('EXPIRED');
    expect(r.error?.code).toBe('HANDOFF_EXPIRED');
    expect(P11Provider.calls).toEqual(expect.arrayContaining(['availability:CC', 'fare:CC']));
    expect(await orch.preparation.consumeHandoff(sid, old.handoffSessionId, pctx())).toMatchObject({ code: 'HANDOFF_SESSION_EXPIRED' });
    const r2 = await say(sid, 'haan');
    expect(r2.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(S(sid).handoffSession.handoffSessionId).not.toBe(old.handoffSessionId);
    expect(S(sid).handoffSession.reviewVersion).toBe(2);
  });
});

describe('G3 — safety: no credentials / OTP / CAPTCHA / payment / PNR / fake success; voice same pipeline', () => {
  it('[23]–[27] sensitive input, payment / OTP / PNR requests after the handoff → nothing executed, nothing stored, no fake success', async () => {
    expect(REGISTERED_TOOLS.map((t: any) => t.name).sort()).toEqual(['CHECK_AVAILABILITY', 'CHECK_PNR', 'GET_FARE', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'SEARCH_TRAINS', 'TRACK_TRAIN']);   // P14: + 2 read-only lookups; still no booking tool
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const rs: any[] = [];
    rs.push(await say(sid, 'mera IRCTC password hunter2xyz hai aur OTP 482913'));
    rs.push(await say(sid, 'haan book karo'));
    for (const t of ['payment kar do', 'OTP bhej do', 'captcha bhar do', 'PNR batao', 'ticket book ho gaya?', 'execute karo']) rs.push(await say(sid, t));
    for (const r of rs) {
      expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
      expect(r.responseMessage).not.toMatch(/Ticket booked|PNR generated|Booking confirmed/i);
    }
    const s = S(sid);
    expect(s.bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(s.handoffSession.status).toBe('READY');
    expect(s.handoffSession.executionAttempts).toBe(0);
    const all = JSON.stringify(s) + JSON.stringify(orch.getTurnHistory(sid));
    expect(all).not.toMatch(/hunter2xyz|482913|bookingReference|"status":"SUCCESS"|"CONSUMED"/);
    for (const o of [s.handoffSession, s.handoff, s.confirmation]) expect(findSensitiveFields(o)).toEqual([]);
    expect(count(sid, 'BOOKING_HANDOFF_SESSION_CREATED')).toBe(1);
  });

  it('[28] voice (STT transcript, mode VOICE) uses the same pipeline → same events, same session, short spoken message', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid, 'VOICE');
    const r = await say(sid, 'haan book karo', 'VOICE');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(r.events).toEqual(['BOOKING_CONFIRMATION_REQUESTED', 'BOOKING_CONFIRMATION_CREATED', 'BOOKING_EXECUTION_REQUESTED', 'BOOKING_HANDOFF_CREATED',
      'BOOKING_LIFECYCLE_UPDATED', 'BOOKING_EXECUTION_DISABLED', 'BOOKING_HANDOFF_SESSION_CREATED', 'IRCTC_HANDOFF_READY', 'BOOKING_PROVIDER_SELECTED', 'BOOKING_PROVIDER_UNAVAILABLE']);
    expect(r.responseMessage).toContain(HANDOFF_READY_MESSAGE);
    expect(r.responseMessage.length).toBeLessThan(160);
    expect(S(sid).handoffSession).toMatchObject({ status: 'READY', executorCapability: { enabled: false } });
    // switch voice → text mid-flow: ambiguous text still asks, nothing duplicated
    const sid2 = state.createSession().sessionId;
    await toAwaiting(sid2, 'VOICE');
    const a = await say(sid2, 'theek hai', 'VOICE');
    expect(a.responseMessage).toBe('Booking confirm karni hai?');
    const b = await say(sid2, 'haan', 'TEXT');
    expect(b.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(count(sid2, 'BOOKING_HANDOFF_SESSION_CREATED')).toBe(1);
  });
});
