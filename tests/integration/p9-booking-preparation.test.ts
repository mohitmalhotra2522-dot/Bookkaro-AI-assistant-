/**
 * PROMPT 9 — GROUP 3
 * Full booking preparation integration: readiness → fresh railway data →
 * deterministic review (versioned) → AWAITING_CONFIRMATION → handoff-READY
 * guard. Freshness, review regeneration/invalidation, confirmation versioning,
 * late-result rejection, voice/text parity, observability and security.
 *
 * NO real booking / IRCTC / payment / OTP is ever executed — asserted via spies.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import type { LLMProvider, LLMTurnInput } from '../../server/ai/providers/llm-provider';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator, type OrchestratorOptions } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { BookingState } from '../../shared/states';

// ---- instrumented providers (mock, non-live data) ----
class CountingProvider extends MockRailwayProvider {
  static calls: string[] = [];
  async searchTrains(r: any) { CountingProvider.calls.push('search'); return super.searchTrains(r); }
  async getFare(r: any) { CountingProvider.calls.push(`fare:${r.travelClass}`); return super.getFare(r); }
  async checkAvailability(r: any) { CountingProvider.calls.push(`availability:${r.travelClass}`); return super.checkAvailability(r); }
}
const failMeta = () => { const now = new Date().toISOString(); return { source: 'mock', providerId: 'p9-nofare', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' }; };
class NoFareProvider extends MockRailwayProvider {
  async getFare(_r: any): Promise<any> { return { ok: false, error: { code: 'FARE_UNAVAILABLE', message: 'Fare abhi uplabdh nahi hai.' }, meta: failMeta() }; }
}
class SlowCCAvailabilityProvider extends MockRailwayProvider {
  async checkAvailability(r: any) { if (r.travelClass === 'CC') await new Promise(res => setTimeout(res, 80)); return super.checkAvailability(r); }
}
railwayRegistry.register('p9-counting', () => new CountingProvider());
railwayRegistry.register('p9-nofare', () => new NoFareProvider());
railwayRegistry.register('p9-slow-cc', () => new SlowCCAvailabilityProvider());

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const mk = (llm: LLMProvider = new MockLLMProvider(), opts: OrchestratorOptions = {}) => { state = new ConversationStateManager(); orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService(), opts); };
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT', opts?: any): Promise<any> => orch.processTurn(sid, text, mode, opts);
const tools = (r: any) => (r.turnLog.toolResults || []).map((t: any) => `${t.toolName}:${t.resultStatus}`);
const advanceClock = (ms: number) => vi.setSystemTime(new Date(Date.now() + ms));

async function toAwaiting(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  await say(sid, 'Amritsar se Delhi kal 2 log', mode);
  await say(sid, '12014', mode);
  await say(sid, 'CC', mode);
  return say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female', mode);
}

let executeSpy: any;
let fetchSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p9-counting'); CountingProvider.calls = []; mk();
  executeSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  // never any real execution / network in ANY scenario
  expect(executeSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  railwayRegistry.setActive('mock');
});

// ------------------------------------------------------------------------------------------
describe('G3 — preparation → fresh data → review → confirmation', () => {
  it('[21] passengers complete → CHECK_AVAILABILITY + GET_FARE refreshed → REVIEW v1 → AWAITING_CONFIRMATION (stores confirmed version)', async () => {
    const sid = state.createSession().sessionId;
    const r = await toAwaiting(sid);
    expect(CountingProvider.calls).toEqual(['search', 'availability:CC', 'fare:CC']);
    expect(r.events).toEqual(expect.arrayContaining(['PASSENGER_DETAILS_VALIDATED', 'AVAILABILITY_REFRESHED', 'FARE_REFRESHED', 'REVIEW_CREATED', 'CONFIRMATION_REQUESTED']));
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(r.pendingInteraction).toMatchObject({ type: 'CONFIRMATION_REQUIRED', data: { reviewVersion: 1 } });
    expect(r.responseMessage).toMatch(/Confirm karna hai\? Haan ya nahi boliye\.$/);
    const card = r.cards!.find((c: any) => c.type === 'review')!.data;
    expect(card).toMatchObject({ reviewVersion: 1, selectedClass: 'CC', passengersCount: 2, realBooking: false, confirmationRequired: true });
    expect(card.fare).toMatchObject({ verified: true, perPassenger: 520, total: 1040 });
    expect(card.availability).toMatchObject({ verified: true, status: 'Available' });
    const s = state.getSession(sid);
    expect(s.review).toMatchObject({ reviewVersion: 1, valid: true });
    expect(s.confirmedReviewVersion).toBe(1);
    expect(s.irctcHandoffReady).toBe(false);
  });

  it('[22] stale availability/fare (clock +11 min) are re-fetched before the review — conversation memory is not a cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log');
    await say(sid, '12014');
    await say(sid, 'CC');
    await say(sid, 'availability bhi check karo');
    await say(sid, 'fare bhi batao');
    expect(CountingProvider.calls.filter(c => c !== 'search')).toEqual(['availability:CC', 'fare:CC']);
    advanceClock(11 * 60_000);
    CountingProvider.calls = [];
    const r = await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
    expect(CountingProvider.calls).toEqual(['availability:CC', 'fare:CC']);      // both refreshed
    expect(r.events).toEqual(expect.arrayContaining(['AVAILABILITY_REFRESHED', 'FARE_REFRESHED', 'REVIEW_CREATED']));
    const rv = state.getSession(sid).review!.data as any;
    expect(Date.parse(rv.fare.retrievedAt)).toBeGreaterThan(Date.now() - 60_000);
    // fresh data is NOT re-fetched needlessly
    CountingProvider.calls = [];
    await say(sid, 'Rahul ki age 32 hai');
    expect(CountingProvider.calls).toEqual([]);
  });

  it('[23] fare REQUIRED by policy but unavailable → REQUIRED_TOOL_DATA_MISSING / BOOKING_NOT_READY; no review, no handoff', async () => {
    railwayRegistry.setActive('p9-nofare');
    mk(new MockLLMProvider(), { preparationPolicy: { requireFare: true } });
    const sid = state.createSession().sessionId;
    let r = await toAwaiting(sid);
    expect(r.error?.code).toBe('BOOKING_NOT_READY');
    expect((r.error as any).details?.blockers ?? state.getSession(sid).readiness?.blockers).toContain('REQUIRED_TOOL_DATA_MISSING');
    expect(r.newState).toBe(BookingState.PASSENGERS_READY);
    expect(r.context.review).toBeUndefined();
    expect(r.responseMessage).toMatch(/fare verify hona zaroori hai/);
    expect(r.responseMessage).not.toMatch(/₹/);
    r = await say(sid, 'haan');                                          // retry: still unavailable
    expect(r.error?.code).toBe('BOOKING_NOT_READY');
    expect(r.newState).not.toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[24] fare optional & unavailable → review labels it "Fare abhi verify nahi hua hai." (never estimated)', async () => {
    railwayRegistry.setActive('p9-nofare');
    mk();
    const sid = state.createSession().sessionId;
    const r = await toAwaiting(sid);
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(r.responseMessage).toContain('Fare abhi verify nahi hua hai.');
    expect(r.cards!.find((c: any) => c.type === 'review')!.data.fare.verified).toBe(false);
    expect(r.responseMessage).not.toMatch(/₹/);
  });

  it('[25] "haan" for the CURRENT review → BOOKING_CONFIRMATION_REQUESTED → IRCTC_HANDOFF_READY only; nothing executed', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const r = await say(sid, 'haan', 'TEXT', { reviewVersion: 1 });
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    // Prompt 10: confirmation now flows through BookingExecutionGateway → DisabledBookingExecutor
    expect(r.events).toEqual(['BOOKING_CONFIRMATION_REQUESTED', 'BOOKING_CONFIRMATION_CREATED', 'BOOKING_EXECUTION_REQUESTED', 'BOOKING_HANDOFF_CREATED', 'BOOKING_LIFECYCLE_UPDATED', 'BOOKING_EXECUTION_DISABLED', 'BOOKING_HANDOFF_SESSION_CREATED', 'IRCTC_HANDOFF_READY', 'BOOKING_PROVIDER_SELECTED', 'BOOKING_PROVIDER_UNAVAILABLE']);
    expect(r.responseMessage).toContain('Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.');
    expect(r.responseMessage).not.toMatch(/ticket (book ho gaya|booked)|booking (successful|confirmed)|PNR/i);
    expect(r.cards!.find((c: any) => c.type === 'handoff')!.data).toMatchObject({ realBooking: false, executionEnabled: false, reviewVersion: 1 });
    expect(r.context.reviewConfirmed).toBe(true);
    expect(r.turnLog).toMatchObject({ reviewVersion: 1, confirmationVersion: 1, stateAfter: 'IRCTC_HANDOFF_READY' });
  });
});

// ------------------------------------------------------------------------------------------
describe('G3 — confirmation versioning & guard', () => {
  it('[26] confirming an OLD review version (stale card tap) → CONFIRMATION_VERSION_MISMATCH; no handoff', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    let r = await say(sid, 'Rahul ki age 32 hai');                       // critical change → v2
    expect(r.events).toEqual(expect.arrayContaining(['REVIEW_INVALIDATED', 'REVIEW_CREATED']));
    expect(r.context.review.reviewVersion).toBe(2);
    expect(r.context.confirmedReviewVersion).toBe(2);
    r = await say(sid, 'haan', 'TEXT', { reviewVersion: 1 });
    expect(r.error?.code).toBe('CONFIRMATION_VERSION_MISMATCH');
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(r.events).not.toContain('BOOKING_CONFIRMATION_REQUESTED');
    r = await say(sid, 'haan', 'TEXT', { reviewVersion: 2 });
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[27] data went stale while awaiting confirmation (clock +11 min) → refresh → review regenerated (STALE_REVIEW) → must re-confirm', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    advanceClock(11 * 60_000);
    CountingProvider.calls = [];
    let r = await say(sid, 'haan');
    expect(CountingProvider.calls).toEqual(['availability:CC', 'fare:CC']);
    expect(r.error?.code).toBe('STALE_REVIEW');
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(r.context.review.reviewVersion).toBe(2);
    expect(r.events).toEqual(expect.arrayContaining(['REVIEW_INVALIDATED', 'REVIEW_CREATED', 'CONFIRMATION_REQUESTED']));
    expect(r.events).not.toContain('IRCTC_HANDOFF_READY');
    r = await say(sid, 'haan');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(r.turnLog.confirmationVersion).toBe(2);
  });

  it('[28] confirm words outside AWAITING_CONFIRMATION never confirm; execution requests are disabled everywhere', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log');
    for (const w of ['haan', 'confirm', 'book it', 'continue']) {
      const r = await say(sid, w);
      expect(r.error?.code).toBe('CONFIRMATION_NOT_PENDING');
      expect(r.events).not.toContain('BOOKING_CONFIRMATION_REQUESTED');
    }
    await say(sid, '12014'); await say(sid, 'CC');
    let r = await say(sid, 'haan');                                        // in COLLECTING_PASSENGER_DETAILS
    expect(r.error?.code).toBe('CONFIRMATION_NOT_PENDING');
    r = await say(sid, 'payment kar do');
    expect(r.error?.code).toBe('BOOKING_EXECUTION_DISABLED');
    await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
    r = await say(sid, 'nahi');                                            // declined → REVIEW, not confirmed
    expect(r.newState).toBe(BookingState.REVIEW);
    r = await say(sid, 'haan');                                            // approval → confirmation asked again
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(r.events).not.toContain('BOOKING_CONFIRMATION_REQUESTED');
    await say(sid, 'haan');
    for (const w of ['haan', 'submit karo', 'payment kar do']) {             // after handoff-ready
      r = await say(sid, w);
      expect(r.error?.code).toBe('BOOKING_EXECUTION_DISABLED');
      expect(r.responseMessage).toMatch(/enabled nahi hai/);
    }
    expect(state.getSession(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });
});

// ------------------------------------------------------------------------------------------
describe('G3 — review stays mutable: change → invalidate → refresh → regenerate (same session)', () => {
  it('[29] class change, date change and destination change after review; versions increase; confirmation invalidated each time', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const sessionId0 = state.getSession(sid).sessionId;

    // class
    CountingProvider.calls = [];
    let r = await say(sid, 'Class 2S kar do');
    expect(CountingProvider.calls).toEqual(['availability:2S', 'fare:2S']);
    expect(r.context.review).toMatchObject({ reviewVersion: 2, valid: true });
    expect(r.context.review.data.fare.total).toBe(240);
    expect(r.context.confirmedReviewVersion).toBe(2);

    // date (same train/class carried over and re-verified on the new date)
    r = await say(sid, 'Date parso kar do');
    expect(r.context.selectedTrain.number).toBe('12014');
    expect(r.context.selectedClass).toBe('2S');
    expect(r.context.review.reviewVersion).toBe(3);
    expect(r.context.review.data.date).toBe(r.context.date);

    // destination → old train no longer valid: review invalid, NO confirmation possible
    r = await say(sid, 'Delhi nahi Chandigarh');
    expect(r.context.destination).toBe('CDG');
    expect(r.context.review.valid).toBe(false);
    expect(r.context.confirmedReviewVersion).toBeUndefined();
    expect(r.newState).toBe(BookingState.SHOWING_TRAINS);
    r = await say(sid, 'haan');
    expect(r.error?.code).toBe('CONFIRMATION_NOT_PENDING');
    expect(r.context.passengers.map((p: any) => p.name)).toEqual(['Rahul Sharma', 'Neha Sharma']);   // passengers kept
    await say(sid, '12412');
    r = await say(sid, 'CC');
    expect(r.context.review).toMatchObject({ reviewVersion: 4, valid: true });
    expect(r.context.review.data.fare.total).toBe(820);
    expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(state.getSession(sid).sessionId).toBe(sessionId0);             // no new session
    r = await say(sid, 'haan');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[30] passenger correction / count change after review → REVIEW_INVALIDATED, regenerated with new version', async () => {
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    let r = await say(sid, 'Passenger 2 ka naam change karo');
    expect(r.context.review.valid).toBe(true);                            // nothing changed yet
    r = await say(sid, 'Neha Verma');
    expect(r.context.review.reviewVersion).toBe(2);
    expect(r.context.review.data.passengers[1].name).toBe('Neha Verma');
    r = await say(sid, 'ek aur add kar do');
    expect(r.context.review.valid).toBe(false);
    expect(r.newState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
    r = await say(sid, 'haan');
    expect(r.error?.code).toBe('CONFIRMATION_NOT_PENDING');
    r = await say(sid, 'Amit 40 male');
    expect(r.context.review).toMatchObject({ reviewVersion: 3, valid: true });
    expect(r.context.review.data.fare.total).toBe(1560);
  });
});

// ------------------------------------------------------------------------------------------
describe('G3 — late results, voice/text parity, observability', () => {
  it('[31] late availability result from an obsolete request is rejected (provenance/version mismatch)', async () => {
    railwayRegistry.setActive('p9-slow-cc');
    mk();
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log');
    await say(sid, '12014');
    await say(sid, 'CC');
    const pA = say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');   // triggers slow CC refresh
    await new Promise(res => setTimeout(res, 10));
    const pB = say(sid, 'Class 2S kar do');
    const [a, b] = await Promise.all([pA, pB]);
    expect(a.stale).toBe(true);
    expect(a.responseMessage).toBe('');
    expect(b.stale).toBeFalsy();
    const s = state.getSession(sid);
    expect(s.selectedClass).toBe('2S');
    expect(s.review?.data.selectedClass).toBe('2S');
    expect(Object.keys(s.availability || {})).toEqual(['2S']);             // late CC result never landed
  });

  it('[32] voice and text share one pipeline: same tools, states, review version; voice review is short', async () => {
    const t = state.createSession().sessionId;
    const v = state.createSession().sessionId;
    const rt = await toAwaiting(t, 'TEXT');
    const rv = await toAwaiting(v, 'VOICE');
    expect(tools(rv)).toEqual(tools(rt));
    expect(rv.newState).toBe(rt.newState);
    expect(rv.context.review.reviewVersion).toBe(rt.context.review.reviewVersion);
    expect(rv.responseMessage).not.toContain('\n');
    expect(rv.responseMessage.length).toBeLessThan(rt.responseMessage.length);
    const h = await say(v, 'haan', 'VOICE');
    expect(h.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[33] turn records carry readiness/version fields; passenger names redacted; events carry no names', async () => {
    const sid = state.createSession().sessionId;
    const r = await toAwaiting(sid);
    const log = r.turnLog as any;
    for (const k of ['sessionId', 'turnId', 'requestId', 'sessionVersion', 'stateBefore', 'stateAfter', 'bookingReadiness', 'missingFields', 'reviewVersion', 'confirmationVersion', 'toolCalls', 'toolResults', 'latencyMs']) {
      expect(log).toHaveProperty(k);
    }
    expect(log.bookingReadiness.ready).toBe(true);
    expect(log.reviewVersion).toBe(1);
    await say(sid, 'Actually second passenger nahi aa raha');
    const all = JSON.stringify(orch.getTurnHistory(sid));
    expect(all).not.toMatch(/Rahul|Neha|Sharma/);
    expect(all).toContain('[PASSENGER_NAME]');
    const events = JSON.stringify(state.getSession(sid).eventLog);
    expect(events).not.toMatch(/Rahul|Neha/);
  });
});

// ------------------------------------------------------------------------------------------
describe('G3 — security: secrets are rejected, never stored / logged / sent to the LLM', () => {
  it('[S1] password / OTP / CAPTCHA / IRCTC password / card / CVV / UPI PIN / bank password / token / cookie', async () => {
    const seen: string[] = [];
    const base = new MockLLMProvider();
    const spyLLM: LLMProvider = { providerId: 'spy', init: async () => {}, generateStructuredDecision: async (i: LLMTurnInput) => { seen.push(JSON.stringify({ u: i.userText, h: i.history })); return base.generateStructuredDecision(i); } };
    mk(spyLLM);
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    const secrets = [
      ['mera password Secr3tPass hai', 'Secr3tPass'], ['OTP 482913 hai', 'OTP 482913'], ['captcha XK7QZ hai', 'XK7QZ'],
      ['IRCTC password RailPw99', 'RailPw99'], ['card 4111 1111 1111 1111', '4111 1111 1111 1111'], ['cvv 737', 'cvv 737'],
      ['UPI PIN 9081', 'UPI PIN 9081'], ['bank password BankPw77', 'BankPw77'], ['auth token eyJhbGciOiJIUzI1', 'eyJhbGciOiJIUzI1'],
      ['cookie JSESSIONID=abc123xyz', 'JSESSIONID=abc123xyz'], ['4111111111111111', '4111111111111111']
    ];
    const versionBefore = state.getSession(sid).sessionVersion;
    for (const [text] of secrets) {
      const r = await say(sid, text);
      expect(r.error?.code).toBe('SENSITIVE_REQUEST_REJECTED');
      expect(r.responseMessage).toMatch(/kabhi password, OTP/);
      expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
    }
    expect(state.getSession(sid).sessionVersion).toBe(versionBefore);     // nothing stored
    const everything = JSON.stringify(state.getSession(sid)) + JSON.stringify(orch.getTurnHistory(sid)) + JSON.stringify(orch.getConversationHistory(sid)) + seen.join('');
    for (const [, needle] of secrets) expect(everything).not.toContain(needle);
    // the flow is unaffected
    const r = await say(sid, 'haan');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[S2] the assistant never asks for credentials anywhere in the flow', async () => {
    const sid = state.createSession().sessionId;
    const replies: string[] = [];
    for (const t of ['Amritsar se Delhi kal 2 log', '12014', 'CC', 'Rahul Sharma 31 male', 'Neha Sharma 28 female', 'haan']) replies.push((await say(sid, t)).responseMessage);
    expect(replies.join(' ')).not.toMatch(/password|otp|captcha|cvv|upi pin|card number|login karein/i);
  });
});
