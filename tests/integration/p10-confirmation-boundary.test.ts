/**
 * PROMPT 10 — GROUP 3
 * End-to-end: User → Orchestrator → LLM → Railway tools → BookingSession →
 * BookingPreparationService → Review → Confirmation → BookingExecutionGateway →
 * DisabledBookingExecutor → IRCTC_HANDOFF_READY.  No real booking anywhere.
 *
 * Every test asserts (afterEach): IrctcHandoffAdapter.executeHandoff never called,
 * global fetch never called. TestBookingExecutor* are test doubles only.
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
import { DisabledBookingExecutor } from '../../server/booking/execution/disabled-booking-executor';
import { BookingExecutionGateway } from '../../server/booking/execution/booking-execution-gateway';
import { BookingExecutorRegistry } from '../../server/booking/execution/booking-executor-registry';
import { parseExecutionConfig } from '../../server/booking/execution/execution-config';
import { HANDOFF_READY_MESSAGE } from '../../server/booking/booking-preparation-service';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import type { BookingExecutor } from '../../server/booking/execution/booking-executor';
import type { BookingExecutionRequest, BookingExecutionResult } from '../../shared/booking-execution';

class P10CountingProvider extends MockRailwayProvider {
  static calls: string[] = [];
  async searchTrains(r: any) { P10CountingProvider.calls.push('search'); return super.searchTrains(r); }
  async getFare(r: any) { P10CountingProvider.calls.push(`fare:${r.travelClass}`); return super.getFare(r); }
  async checkAvailability(r: any) { P10CountingProvider.calls.push(`availability:${r.travelClass}`); return super.checkAvailability(r); }
}
class P10NoFareProvider extends MockRailwayProvider {
  async getFare(_r: any): Promise<any> { const now = new Date().toISOString(); return { ok: false, error: { code: 'FARE_UNAVAILABLE', message: 'Fare abhi uplabdh nahi hai.' }, meta: { source: 'mock', providerId: 'p10-nofare', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' } }; }
}
railwayRegistry.register('p10-counting', () => new P10CountingProvider());
railwayRegistry.register('p10-nofare', () => new P10NoFareProvider());

class TestBookingExecutorSlow implements BookingExecutor {
  readonly name = 'test-slow'; readonly kind = 'TEST' as const; calls = 0;
  isAvailable() { return true; }
  async execute(r: BookingExecutionRequest): Promise<BookingExecutionResult> {
    this.calls++; await new Promise(res => setTimeout(res, 60));
    return { status: 'REQUIRES_HANDOFF', reason: 'USER_HANDOFF', executorName: this.name, idempotencyKey: r.idempotencyKey, completedAt: new Date().toISOString() };
  }
}

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const mk = (llm: LLMProvider = new MockLLMProvider(), opts: OrchestratorOptions = {}) => { state = new ConversationStateManager(); orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService(), opts); };
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT', opts?: any): Promise<any> => orch.processTurn(sid, text, mode, opts);
const S = (sid: string): any => state.getSession(sid);
const created = (sid: string) => (S(sid).eventLog || []).filter((e: any) => e.type === 'BOOKING_HANDOFF_CREATED').length;
const FAKE_SUCCESS = /ticket (book ho gaya|booked)|booking (successful|confirmed|ho gayi)|PNR\s*[:#]?\s*\d{6,}|seat (no|number)\s*\d/i;

async function toAwaiting(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT', train = '12497') {
  await say(sid, 'Amritsar se Delhi kal 2 log', mode);
  await say(sid, train, mode);
  await say(sid, 'CC', mode);
  return say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female', mode);
}
async function toHandoff(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  await toAwaiting(sid, mode);
  const r = await say(sid, 'haan book karo', mode);
  expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  return r;
}

let executeSpy: any, fetchSpy: any, disabledSpy: any, gatewaySpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p10-counting'); P10CountingProvider.calls = []; mk();
  executeSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  disabledSpy = vi.spyOn(DisabledBookingExecutor.prototype, 'execute');
  gatewaySpy = vi.spyOn(BookingExecutionGateway.prototype, 'execute');
});
afterEach(() => {
  expect(executeSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  railwayRegistry.setActive('mock');
});

// ------------------------------------------------------------------------------------------
describe('G3 — confirmation → gateway → Disabled → IRCTC_HANDOFF_READY', () => {
  it('[1][2] "haan book karo" → validations → immutable handoff from authoritative data → Disabled → IRCTC_HANDOFF_READY', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const r = await say(sid, 'haan book karo');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(r.events).toEqual(['BOOKING_CONFIRMATION_REQUESTED', 'BOOKING_CONFIRMATION_CREATED', 'BOOKING_EXECUTION_REQUESTED', 'BOOKING_HANDOFF_CREATED', 'BOOKING_LIFECYCLE_UPDATED', 'BOOKING_EXECUTION_DISABLED', 'BOOKING_HANDOFF_SESSION_CREATED', 'IRCTC_HANDOFF_READY', 'BOOKING_PROVIDER_SELECTED', 'BOOKING_PROVIDER_UNAVAILABLE']);
    expect(r.responseMessage).toContain('Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.');
    expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
    const s = S(sid);
    const h = s.handoff.snapshot;
    expect(s.handoff.status).toBe('READY');
    expect(h).toMatchObject({ sessionId: sid, reviewVersion: 1, journey: { origin: 'ASR', destination: 'NDLS' }, date: s.date, selectedClass: 'CC', realBooking: false,
      selectedTrain: { trainNumber: '12497', resultId: s.selectedTrain.resultId, date: s.date }, fareSnapshot: { total: 980, passengersCount: 2 }, availabilitySnapshot: { status: s.availability.CC.status } });
    expect(h.validatedPassengers.map((p: any) => [p.passengerId, p.name, p.age, p.gender])).toEqual([['P1', 'Rahul Sharma', 31, 'MALE'], ['P2', 'Neha Sharma', 28, 'FEMALE']]);
    expect(s.execution).toMatchObject({ status: 'DISABLED', reason: 'REAL_BOOKING_DISABLED', executorName: 'disabled' });
    expect(s.bookingLifecycle.history.map((x: any) => x.to)).toEqual(['PREPARING', 'READY_FOR_CONFIRMATION', 'CONFIRMED_BY_USER', 'HANDOFF_CREATED', 'EXECUTION_DISABLED']);
    expect(disabledSpy).toHaveBeenCalledTimes(1);
    const card = r.cards.find((c: any) => c.type === 'handoff').data;
    expect(card).toMatchObject({ handoffId: h.handoffId, handoffStatus: 'READY', executorName: 'disabled', executionStatus: 'DISABLED', realBooking: false, executionEnabled: false, realBookingEnabled: false });
    expect(r.turnLog.execution).toMatchObject({ handoffId: h.handoffId, executionStatus: 'DISABLED', executorName: 'disabled', executionCapability: 'REAL_BOOKING_DISABLED' });
    expect(r.turnLog).toMatchObject({ handoffStatus: 'READY', bookingLifecycle: 'EXECUTION_DISABLED' });
    expect(JSON.stringify(r.turnLog)).not.toMatch(/Rahul|Neha/);
  });

  it('[3] no explicit confirmation → no gateway call, no handoff', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log'); await say(sid, '12014'); await say(sid, 'CC');
    let r = await say(sid, 'haan');                                            // not awaiting confirmation
    expect(r.error?.code).toBe('CONFIRMATION_NOT_PENDING');
    r = await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');         // review shown, not confirmed
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    r = await say(sid, 'Rahul ki age 32 hai');
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(gatewaySpy).not.toHaveBeenCalled();
    expect(S(sid).handoff).toBeUndefined();
  });

  it('[11] "haan book karo" then "Actually 3A kar do" → confirmation + handoff + fare + availability invalidated → refresh → new review → re-confirm → NEW handoff', async () => {
    const sid = state.createSession().sessionId;
    await toHandoff(sid);
    const first = S(sid).handoff.snapshot;
    P10CountingProvider.calls = [];
    let r = await say(sid, 'Actually 3A kar do');
    expect(r.events).toEqual(expect.arrayContaining(['REVIEW_INVALIDATED', 'BOOKING_HANDOFF_INVALIDATED', 'AVAILABILITY_REFRESHED', 'FARE_REFRESHED', 'REVIEW_CREATED']));
    expect(P10CountingProvider.calls).toEqual(['availability:3A', 'fare:3A']);
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(S(sid).review.reviewVersion).toBe(2);
    expect(S(sid).handoff).toMatchObject({ status: 'INVALIDATED' });
    expect(S(sid).reviewConfirmed).toBe(false);
    expect(S(sid).irctcHandoffReady).toBe(false);
    expect(r.cards.find((c: any) => c.type === 'handoff_status').data).toMatchObject({ handoffId: first.handoffId, status: 'INVALIDATED' });
    expect(first.selectedClass).toBe('CC');                                    // old snapshot immutable
    r = await say(sid, 'haan');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    const second = S(sid).handoff.snapshot;
    expect(second.handoffId).not.toBe(first.handoffId);
    expect(second).toMatchObject({ reviewVersion: 2, selectedClass: '3A', fareSnapshot: { total: 1300 } });
    expect(created(sid)).toBe(2);
  });

  it('[8][9][10][12] destination / date / train / passenger-count change after handoff → handoff INVALIDATED, no stale handoff survives', async () => {
    for (const [change, expectState] of [
      ['Delhi nahi Ludhiana', BookingState.SHOWING_TRAINS],
      ['Kal nahi parso', BookingState.AWAITING_CONFIRMATION],
      ['Train 12014 kar do', BookingState.CLASS_OPTIONS],
      ['3 log kar do', BookingState.COLLECTING_PASSENGER_DETAILS]
    ] as const) {
      const sid = state.createSession().sessionId;
      await toHandoff(sid);
      const old = S(sid).handoff.snapshot.handoffId;
      const r = await say(sid, change);
      expect(r.newState).toBe(expectState);
      expect(S(sid).handoff).toMatchObject({ status: 'INVALIDATED', snapshot: { handoffId: old } });
      expect(S(sid).irctcHandoffReady).toBe(false);
      expect(S(sid).bookingLifecycle.status).not.toMatch(/EXECUTION_DISABLED|HANDOFF_CREATED/);
      expect(r.events).toContain('BOOKING_HANDOFF_INVALIDATED');
    }
    // date change: carry-over re-verified on the new date → new review must be confirmed again
    expect(disabledSpy).toHaveBeenCalledTimes(4);
  });

  it('[18] handoff expires (fake clock) → EXPIRED → fresh CHECK_AVAILABILITY / GET_FARE → new review → re-confirm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sid = state.createSession().sessionId;
    await toHandoff(sid);
    const old = S(sid).handoff.snapshot.handoffId;
    vi.setSystemTime(new Date(Date.now() + 3 * 60_000));
    P10CountingProvider.calls = [];
    let r = await say(sid, 'haan');
    expect(r.error?.code).toBe('HANDOFF_EXPIRED');
    expect(r.events).toEqual(expect.arrayContaining(['BOOKING_HANDOFF_EXPIRED', 'REVIEW_INVALIDATED', 'AVAILABILITY_REFRESHED', 'FARE_REFRESHED', 'REVIEW_CREATED']));
    expect(P10CountingProvider.calls).toEqual(['availability:CC', 'fare:CC']);
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(S(sid).handoff).toMatchObject({ status: 'EXPIRED', snapshot: { handoffId: old } });
    expect(r.responseMessage).toMatch(/handoff expire ho gaya/);
    r = await say(sid, 'haan');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(S(sid).handoff.snapshot.handoffId).not.toBe(old);
    expect(S(sid).handoff.snapshot.reviewVersion).toBe(2);
  });

  it('[14] fare cannot be verified at confirmation (refresh fails) → STALE_FARE, no handoff, nothing executed', async () => {
    railwayRegistry.setActive('p10-nofare');
    // P33: the DEFAULT policy never builds a review without a verified fare (BOOKING_NOT_READY, no review). This
    // pins the confirmation gateway's own defence, reachable only under the configurable lenient policy.
    mk(new MockLLMProvider(), { preparationPolicy: { requireFare: false } });
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);                                                     // review: fare "abhi verify nahi hua"
    const r = await say(sid, 'haan');
    expect(r.error?.code).toBe('STALE_FARE');
    expect(r.newState).toBe(BookingState.PASSENGERS_READY);
    expect(r.responseMessage).toMatch(/fresh fare verify nahi ho paaya, isliye booking handoff nahi banaya/);
    expect(S(sid).handoff).toBeUndefined();
    expect(disabledSpy).not.toHaveBeenCalled();
    expect(r.turnLog.execution).toMatchObject({ rejectionReason: 'STALE_FARE' });
  });

  it('[27] duplicate confirmation → same handoff, no duplicate handoff, executor not re-invoked', async () => {
    const sid = state.createSession().sessionId;
    await toHandoff(sid);
    const id = S(sid).handoff.snapshot.handoffId;
    for (const w of ['haan', 'haan book karo', 'confirm']) {
      const r = await say(sid, w);
      expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
      expect(r.error?.code).toBe('BOOKING_EXECUTION_DISABLED');
      expect(r.responseMessage).toMatch(/Actual railway booking abhi enabled nahi hai/);
      expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
    }
    expect(S(sid).handoff.snapshot.handoffId).toBe(id);
    expect(created(sid)).toBe(1);
    expect(disabledSpy).toHaveBeenCalledTimes(1);
    const dups = orch.gateway.executionLog(sid).filter(l => l.duplicate);
    expect(dups.length).toBeGreaterThanOrEqual(1);
    expect(dups.every(l => l.handoffId === id)).toBe(true);
  });

  it('[26] voice uses the same backend flow (same session, same gateway, short spoken message)', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid, 'VOICE');
    const r = await say(sid, 'haan book karo', 'VOICE');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(r.responseMessage).toBe(HANDOFF_READY_MESSAGE);
    expect(S(sid).handoff.status).toBe('READY');
    expect(disabledSpy).toHaveBeenCalledTimes(1);
    expect(r.turnLog.inputMode).toBe('VOICE');
  });
});

describe('G3 — fail closed, LLM isolation, concurrency, no fake success', () => {
  it('[19][20][21] flag missing / false / malformed → Disabled; flag true + unknown executor → fail closed (nothing invoked), still only a handoff', async () => {
    for (const env of [{}, { REAL_BOOKING_ENABLED: 'false' }, { REAL_BOOKING_ENABLED: 'TRUE' }]) {
      mk(new MockLLMProvider(), { executionConfig: parseExecutionConfig(env) });
      const sid = state.createSession().sessionId;
      await toHandoff(sid);
      expect(S(sid).execution).toMatchObject({ status: 'DISABLED', reason: 'REAL_BOOKING_DISABLED' });
    }
    mk(new MockLLMProvider(), { executionConfig: parseExecutionConfig({ REAL_BOOKING_ENABLED: 'true', BOOKING_EXECUTOR: 'irctc' }) });
    disabledSpy.mockClear();
    const sid = state.createSession().sessionId;
    const r = await toHandoff(sid);
    expect(S(sid).execution).toMatchObject({ status: 'DISABLED', reason: 'UNKNOWN_BOOKING_EXECUTOR', executorName: 'none' });
    expect(disabledSpy).not.toHaveBeenCalled();
    expect(r.responseMessage).toContain(HANDOFF_READY_MESSAGE);
    expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
  });

  it('[22] the LLM cannot invoke the executor: no booking tool exists; BOOK_TICKET / EXECUTE_BOOKING calls rejected; LLM confirm outside AWAITING ignored', async () => {
    expect(REGISTERED_TOOLS.map((t: any) => t.name).sort()).toEqual(['CHECK_AVAILABILITY', 'CHECK_PNR', 'GET_FARE', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'SEARCH_TRAINS', 'TRACK_TRAIN']);   // P14: + 2 read-only lookups; still no booking tool
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log'); await say(sid, '12014'); await say(sid, 'CC');
    const evil: LLMProvider = { providerId: 'evil', init: async () => {}, generateStructuredDecision: async () => ({ decision: {
      intent: 'CONFIRM_BOOKING', action: 'PREPARE_IRCTC_HANDOFF', entities: { reviewVersion: 1, trainNumber: '99999' } as any, missingFields: [], clarification: null, confidence: 1,
      toolCalls: [{ callId: 'a', name: 'BOOK_TICKET' as any, arguments: {} }, { callId: 'b', name: 'EXECUTE_BOOKING' as any, arguments: {} }, { callId: 'c', name: 'gateway.execute' as any, arguments: {} }] } }) };
    const o = new ConversationAgentOrchestrator(evil, state, new RailwayToolService());
    const r = await o.processTurn(sid, 'book karo abhi', 'TEXT');
    expect((r.turnLog.toolResults || []).every((t: any) => t.resultStatus === 'rejected' && t.errorCode === 'UNKNOWN_TOOL')).toBe(true);
    expect(r.newState).not.toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(gatewaySpy).not.toHaveBeenCalled();
    expect(disabledSpy).not.toHaveBeenCalled();
    expect(S(sid).handoff).toBeUndefined();
  });

  it('concurrent change while a slow (test) executor runs → old request rejected, result discarded, no handoff for the old data', async () => {
    const reg = new BookingExecutorRegistry({ allowTestExecutors: true });
    const slow = new TestBookingExecutorSlow();
    reg.register(slow);
    mk(new MockLLMProvider(), { executorRegistry: reg, executionConfig: parseExecutionConfig({ REAL_BOOKING_ENABLED: 'true', BOOKING_EXECUTOR: 'test-slow' }) });
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const p1 = say(sid, 'haan book karo');
    await new Promise(res => setTimeout(res, 15));
    const r2 = await say(sid, 'Actually 3A kar do');
    const r1 = await p1;
    expect(slow.calls).toBe(1);
    expect(r1.stale).toBe(true);
    expect(orch.gateway.executionLog(sid).some(l => l.rejectionReason === 'SESSION_VERSION_CONFLICT')).toBe(true);
    expect(S(sid).handoff).toBeUndefined();
    expect(r2.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(S(sid).selectedClass).toBe('3A');
  });

  it('[24][25] no fake PNR / success / credentials anywhere; sensitive input never reaches the handoff', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const rs: any[] = [];
    rs.push(await say(sid, 'mera IRCTC password abc123 hai aur OTP 482913'));
    rs.push(await say(sid, 'haan book karo'));
    rs.push(await say(sid, 'payment kar do'));
    rs.push(await say(sid, 'PNR batao'));
    for (const r of rs) expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
    const all = JSON.stringify(S(sid)) + JSON.stringify(orch.getTurnHistory(sid)) + JSON.stringify(orch.gateway.executionLog());
    expect(all).not.toMatch(/abc123|OTP 482913|bookingReference|"status":"SUCCESS"|BOOKING_CONFIRMED|BOOKING_IN_PROGRESS/);
    expect(JSON.stringify(S(sid).handoff)).not.toMatch(/password|otp|captcha|cvv|upi|card|token|cookie/i);
    expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });
});
