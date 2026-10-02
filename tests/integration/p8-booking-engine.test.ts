/**
 * PROMPT 8 — GROUP 3
 * ConversationAgentOrchestrator + LLM tool runtime + BookingSession + state
 * transitions + stale-result protection + railway-tool integration.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import type { LLMProvider, LLMTurnInput, LLMTurnResult } from '../../server/ai/providers/llm-provider';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator, factGuard } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { StateTransitionValidator, InvalidStateTransitionError } from '../../server/ai/state/state-transition-validator';
import { RequestGuard } from '../../server/ai/context/request-guard';
import { buildLLMContext } from '../../server/ai/context/context-builder';
import { buildReview } from '../../server/ai/context/review-builder';
import { BookingState } from '../../shared/states';

// ---- instrumented providers ----
class CountingProvider extends MockRailwayProvider {
  static calls: string[] = [];
  async searchTrains(r: any) { CountingProvider.calls.push('search'); return super.searchTrains(r); }
  async getFare(r: any) { CountingProvider.calls.push('fare'); return super.getFare(r); }
  async checkAvailability(r: any) { CountingProvider.calls.push('availability'); return super.checkAvailability(r); }
  async getTimetable(r: any) { CountingProvider.calls.push('timetable'); return super.getTimetable(r); }
  async getTrainInfo(r: any) { CountingProvider.calls.push('info'); return super.getTrainInfo(r); }
}
class SlowDelhiProvider extends MockRailwayProvider {
  async searchTrains(r: any) { if (r.destination === 'NDLS') await new Promise(res => setTimeout(res, 60)); return super.searchTrains(r); }
}
class DownProvider extends MockRailwayProvider {
  async searchTrains(_r: any): Promise<any> {
    const now = new Date().toISOString();
    return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Provider abhi uplabdh nahi hai.' }, meta: { source: 'mock', providerId: 'down', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' } };
  }
}
railwayRegistry.register('p8-counting', () => new CountingProvider());
railwayRegistry.register('p8-slow-delhi', () => new SlowDelhiProvider());
railwayRegistry.register('p8-down', () => new DownProvider());

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const mk = (llm: LLMProvider = new MockLLMProvider()) => { state = new ConversationStateManager(); orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService()); };
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT', opts?: any) => orch.processTurn(sid, text, mode, opts);
const tools = (r: any) => (r.turnLog.toolResults || []).map((t: any) => `${t.toolName}:${t.resultStatus}`);

async function toReview(sid: string) {
  await say(sid, 'Amritsar se Delhi kal 2 log');
  await say(sid, '12014 wali');
  await say(sid, 'CC');
  for (const t of ['Rahul Sharma', '34', 'male', 'Priya Verma, 31, female']) await say(sid, t);
}

beforeEach(() => { railwayRegistry.setActive('p8-counting'); CountingProvider.calls = []; mk(); });
afterEach(() => railwayRegistry.setActive('mock'));

describe('Group 3 — confirmation guard', () => {
  it('[14][F] "haan" in SHOWING_TRAINS is NOT confirmation → contextual clarification, nothing changes', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal');
    const before = state.getSession(sid).sessionVersion;
    const r = await say(sid, 'haan');
    expect(r.error?.code).toBe('CONFIRMATION_NOT_PENDING');
    expect(r.newState).toBe(BookingState.SHOWING_TRAINS);
    expect(r.responseMessage).toMatch(/kaunsi train select karni hai\?/);
    expect(r.events).not.toContain('BOOKING_CONFIRMATION_REQUESTED');
    expect(state.getSession(sid).sessionVersion).toBe(before);   // no hidden mutation
  });

  it('[13][G] (P9 flow) passengers complete → fresh data → review → AWAITING_CONFIRMATION → "haan" → handoff-ready only; no real booking', async () => {
    const sid = state.createSession().sessionId;
    await toReview(sid);
    let s = state.getSession(sid);
    expect(s.bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(s.pendingInteraction?.type).toBe('CONFIRMATION_REQUIRED');
    expect(s.irctcHandoffReady).toBe(false);                     // review is not confirmation
    expect(s.review?.valid).toBe(true);
    expect(s.confirmedReviewVersion).toBe(s.review?.reviewVersion);
    const r = await say(sid, 'haan');
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(r.events).toContain('BOOKING_CONFIRMATION_REQUESTED');
    const ev = r.context.eventLog!.find(e => e.type === 'BOOKING_CONFIRMATION_REQUESTED')!;
    expect(ev.data).toMatchObject({ origin: 'ASR', destination: 'NDLS', trainNumber: '12014', selectedClass: 'CC', passengersCount: 2 });
    expect(r.responseMessage).toMatch(/Actual railway booking abhi enabled nahi hai/);
    expect(JSON.stringify(r)).not.toMatch(/\bPNR\s*[:#]?\s*\d{10}\b/);   // no fake PNR
    expect(r.cards?.find(c => c.type === 'handoff')?.data.realBooking).toBe(false);
  });

  it('"nahi" at AWAITING_CONFIRMATION returns to REVIEW without booking', async () => {
    const sid = state.createSession().sessionId;
    await toReview(sid);
    const r = await say(sid, 'nahi');
    expect(r.newState).toBe(BookingState.REVIEW);
    expect(r.context.irctcHandoffReady).toBe(false);
  });
});

describe('Group 3 — follow-up tool calls use session context (no repetition)', () => {
  it('[15][16][17] "12014 batao" → "Iski CC availability?" → "Fare?" → "Timetable?"', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log');
    let r = await say(sid, '12014 batao');
    expect(tools(r)).toEqual(['GET_TRAIN_INFO:ok']);
    r = await say(sid, 'Iski CC availability?');
    expect(tools(r)).toEqual(['CHECK_AVAILABILITY:ok']);
    expect(r.context.selectedTrain.number).toBe('12014');
    expect(r.context.selectedClass).toBe('CC');
    expect(r.turnLog.toolResults![0].validatedArguments).toMatchObject({ trainNumber: '12014', travelClass: 'CC', date: r.context.date });
    r = await say(sid, 'Fare?');
    expect(tools(r)).toEqual(['GET_FARE:ok']);
    expect(r.turnLog.toolResults![0].validatedArguments).toMatchObject({ trainNumber: '12014', travelClass: 'CC', passengersCount: 2 });
    expect(r.responseMessage).toContain(`₹${r.context.fare!.total}`);
    r = await say(sid, 'Timetable?');
    expect(tools(r)).toEqual(['GET_TIMETABLE:ok']);
    expect(r.responseMessage).toMatch(/ASR 04:55 → .*NDLS 10:50/);
  });

  it('provider availability is relayed verbatim (RAC 4), never upgraded to "confirmed"', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log');
    await say(sid, '12497 wali');
    await say(sid, 'CC');
    const r = await say(sid, 'availability bhi check karo');
    expect(r.responseMessage).toContain('RAC 4');
    expect(r.responseMessage).not.toMatch(/confirm(ed)? seat|seat confirm/i);
  });

  it('[26] multi-tool chain "12014 ki CC availability aur fare batao" → CHECK_AVAILABILITY then GET_FARE (separate iterations)', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log');
    CountingProvider.calls = [];
    const r = await say(sid, '12014 ki CC availability aur fare batao');
    expect(tools(r)).toEqual(['CHECK_AVAILABILITY:ok', 'GET_FARE:ok']);
    expect(CountingProvider.calls).toEqual(['availability', 'fare']);   // fresh calls, in order
    expect(r.context.selectedTrain.number).toBe('12014');
    expect(r.responseMessage).toContain('Available');
    expect(r.responseMessage).toContain(`₹${r.context.fare!.total}`);
  });

  it('[24] "Fare batao" with no selected train → GET_FARE rejected, provider NOT called, asks to select', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal');
    CountingProvider.calls = [];
    const r = await say(sid, 'Fare batao');
    expect(tools(r)).toEqual(['GET_FARE:rejected']);
    expect(r.turnLog.toolResults![0].errorCode).toBe('INVALID_ACTION_FOR_STATE');
    expect(CountingProvider.calls).toEqual([]);
    expect(r.responseMessage).toContain('Pehle train select kar lete hain, phir fare check kar deta hoon.');
    expect(r.context.fare).toBeUndefined();
  });

  it('memory model: LLM history claiming "12014 selected" never overrides BookingSession', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal');
    (orch as any).history.get(sid).push({ role: 'assistant', content: '12014 select ho gayi hai, CC class bhi.' });
    const r = await say(sid, 'Fare?');
    expect(tools(r)).toEqual(['GET_FARE:rejected']);
    expect(r.context.selectedTrain).toBeUndefined();
  });
});

describe('Group 3 — stale protection & versioning', () => {
  it('[19][H] late result from an obsolete request is rejected (STALE_TOOL_RESULT) and never overwrites newer state', async () => {
    railwayRegistry.setActive('p8-slow-delhi');
    mk();
    const sid = state.createSession().sessionId;
    const pOld = say(sid, 'Amritsar se Delhi kal');
    await new Promise(r => setTimeout(r, 10));
    const pNew = say(sid, 'Actually Delhi nahi Ludhiana jaana hai');
    const [oldR, newR] = await Promise.all([pOld, pNew]);
    expect(oldR.stale).toBe(true);
    expect(oldR.error?.code).toBe('STALE_TOOL_RESULT');
    expect(oldR.responseMessage).toBe('');
    expect(oldR.turnLog.staleResultRejected).toBe(true);
    expect(oldR.turnLog.toolResults![0].resultStatus).toBe('stale');
    expect(newR.stale).toBeFalsy();
    const s = state.getSession(sid);
    expect(s.destination).toBe('LDH');
    expect(s.searchResults.journey.destination).toBe('LDH');
    expect(s.searchResults.trains.map((t: any) => t.trainNumber)).toEqual(['12014', '04672']);
    expect(s.eventLog!.map(e => e.type)).toContain('STALE_RESULT_REJECTED');
  });

  it('[18] stale search reference: UI tap from an older list and LLM ref with old version are both rejected', async () => {
    const sid = state.createSession().sessionId;
    const r1 = await say(sid, 'Amritsar se Delhi kal');
    const oldVersion = r1.context.searchResultsVersion;
    await say(sid, 'Kal nahi parso');                      // new search → new version
    const tap = await say(sid, '12497 wali', 'TEXT', { searchResultsVersion: oldVersion });
    expect(tap.error?.code).toBe('STALE_SEARCH_REFERENCE');
    expect(tap.context.selectedTrain).toBeUndefined();

    // LLM that (wrongly) proposes displayIndex 2 from the OLD list
    const staleLLM: LLMProvider = {
      providerId: 'stale-llm', init: async () => {},
      generateStructuredDecision: async (_i: LLMTurnInput): Promise<LLMTurnResult> => ({ decision: {
        intent: 'SELECT_TRAIN', action: 'SELECT_TRAIN', entities: { trainRef: { kind: 'DISPLAY_INDEX', value: 2, searchResultsVersion: oldVersion } },
        missingFields: [], clarification: null, confidence: 0.9, toolCalls: [] } })
    };
    const orch2 = new ConversationAgentOrchestrator(staleLLM, state, new RailwayToolService());
    const r = await orch2.processTurn(sid, 'second wali', 'TEXT');
    expect(r.error?.code).toBe('STALE_SEARCH_REFERENCE');
    expect(state.getSession(sid).selectedTrain).toBeUndefined();
  });

  it('[29] session-version conflict → SESSION_VERSION_CONFLICT, no mutation', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal');
    const s = state.getSession(sid);
    const v = s.sessionVersion;
    const r = await say(sid, 'pehli wali', 'TEXT', { expectedSessionVersion: v - 1 });
    expect(r.error?.code).toBe('SESSION_VERSION_CONFLICT');
    expect(state.getSession(sid).selectedTrain).toBeUndefined();
    expect(state.getSession(sid).sessionVersion).toBe(v);
    const ok = await say(sid, 'pehli wali', 'TEXT', { expectedSessionVersion: v });
    expect(ok.context.selectedTrain).toBeTruthy();
  });

  it('every new search bumps searchResultsVersion and assigns deterministic displayIndex/resultId/provider/retrievedAt', async () => {
    const sid = state.createSession().sessionId;
    const a = await say(sid, 'Amritsar se Delhi kal');
    const va = a.context.searchResultsVersion;
    const t0 = a.context.searchResults.trains[0];
    expect(t0).toMatchObject({ displayIndex: 1, provider: 'mock' });
    expect(t0.resultId).toBeTruthy();
    expect(t0.retrievedAt).toBeTruthy();
    const b = await say(sid, 'morning wali trains dikhao');   // refinement → FRESH provider call
    expect(tools(b)).toEqual(['SEARCH_TRAINS:ok']);
    expect(b.context.searchResultsVersion).toBeGreaterThan(va);
    expect(b.context.searchResults.trains.every((t: any) => parseInt(t.departure, 10) < 12)).toBe(true);
  });
});

describe('Group 3 — state transitions', () => {
  it('[30] StateTransitionValidator rejects invalid transitions and allows validated ones', () => {
    const v = new StateTransitionValidator();
    expect(v.canTransition(BookingState.SHOWING_TRAINS, BookingState.TRAIN_SELECTED)).toBe(true);
    expect(v.canTransition(BookingState.SHOWING_TRAINS, BookingState.COMPLETE)).toBe(false);
    expect(v.canTransition(BookingState.REVIEW, BookingState.COMPLETE)).toBe(false);
    expect(v.canTransition(BookingState.TRAIN_SELECTED, BookingState.CLASS_SELECTED)).toBe(true);
    expect(v.canTransition(BookingState.REVIEW, BookingState.IRCTC_HANDOFF_READY)).toBe(false);
    expect(v.canTransition(BookingState.SHOWING_TRAINS, BookingState.AWAITING_CONFIRMATION)).toBe(false);
    expect(v.check(BookingState.IDLE, BookingState.SEARCHING_TRAINS)).toMatchObject({ ok: true, path: [BookingState.COLLECTING_JOURNEY, BookingState.SEARCHING_TRAINS] });
    expect(v.check(BookingState.COLLECTING_PASSENGER_DETAILS, BookingState.COLLECTING_JOURNEY)).toMatchObject({ ok: true, kind: 'REWIND' });
    const sid = state.createSession().sessionId;
    expect(() => state.transitionState(sid, BookingState.COMPLETE)).toThrow(InvalidStateTransitionError);
  });

  it('RequestGuard drops an invalid bookingState in a tool patch (validated) and rejects writes after a newer request', () => {
    const s = state.createSession();
    const v1 = state.beginRequest(s.sessionId, 'req-1');
    const g = new RequestGuard(state, { sessionId: s.sessionId, turnId: 't1', requestId: 'req-1', requestVersion: v1 });
    g.commit({ bookingState: BookingState.COMPLETE } as any);
    expect(state.getSession(s.sessionId).bookingState).toBe(BookingState.IDLE);
    expect(g.rejectedTransitions.length).toBe(1);
    state.beginRequest(s.sessionId, 'req-2');
    expect(g.commit({ origin: 'XXX' } as any)).toBe(false);
    expect(state.getSession(s.sessionId).origin).toBeUndefined();
  });
});

describe('Group 3 — review, tool failure, voice/text, observability', () => {
  it('review is built only from authoritative data; unverified fare/availability are labelled, never estimated', async () => {
    const sid = state.createSession().sessionId;
    await toReview(sid);
    // P9 refreshes fare/availability before the review; simulate "not verified" data:
    const s = { ...state.getSession(sid), fare: undefined, availability: undefined } as any;
    const rv = buildReview(s);
    expect(rv.data.fare.verified).toBe(false);
    expect(rv.text).toContain('Fare abhi verify nahi hua hai.');
    expect(rv.text).toContain('Availability abhi verify nahi hui hai.');
    expect(rv.text).not.toMatch(/₹/);
    expect(rv.text).toContain('12014');
    expect(rv.text).toContain('2 passengers');
  });

  it('[25] tool failure (provider down) → no success claim, no trains, state not SHOWING_TRAINS', async () => {
    railwayRegistry.setActive('p8-down');
    mk();
    const sid = state.createSession().sessionId;
    const r = await say(sid, 'Amritsar se Delhi kal');
    expect(tools(r)).toEqual(['SEARCH_TRAINS:error']);
    expect(r.responseMessage).toContain('Train search abhi complete nahi ho paayi');
    expect(r.responseMessage).not.toMatch(/trains mili/);
    expect(r.context.searchResults).toBeUndefined();
    expect(r.newState).not.toBe(BookingState.SHOWING_TRAINS);
    expect(r.events).toContain('TOOL_FAILED');
  });

  it('[28] voice and text share one pipeline/session: same tools & state, voice reply concise', async () => {
    const sid = state.createSession().sessionId;
    const t = await say(sid, 'Amritsar se Delhi kal 2 log', 'TEXT');
    const v = await say(sid, 'pehli wali', 'VOICE');
    expect(v.context.sessionId).toBe(t.context.sessionId);
    expect(v.context.mode).toBe('VOICE');
    expect(v.context.selectedTrain.number).toBe(t.context.searchResults.trains[0].trainNumber);
    const sid2 = state.createSession().sessionId;
    const voiceSearch = await say(sid2, 'Amritsar se Delhi kal 2 log', 'VOICE');
    expect(tools(voiceSearch)).toEqual(tools(t));                  // identical tool path
    expect(voiceSearch.responseMessage.length).toBeLessThan(t.responseMessage.length);
    expect(voiceSearch.responseMessage).not.toContain('\n');      // no tables in voice
    expect(voiceSearch.turnLog.inputMode).toBe('VOICE');
  });

  it('turn record has full observability fields and never contains secrets', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal');
    const r = await say(sid, 'mera IRCTC password abc123 hai aur OTP 482913');
    expect(r.responseMessage).toMatch(/kabhi password, OTP/);
    const r2 = await say(sid, 'pehli wali');
    const log = r2.turnLog;
    for (const k of ['sessionId', 'turnId', 'requestId', 'sessionVersion', 'stateBefore', 'stateAfter', 'pendingInteractionBefore', 'pendingInteractionAfter', 'intent', 'detectedChanges', 'events', 'assistantResponse', 'llmProvider']) {
      expect(log).toHaveProperty(k);
    }
    expect(log.pendingInteractionBefore).toBe('TRAIN_SELECTION_REQUIRED');
    expect(log.pendingInteractionAfter).toBe('CLASS_SELECTION_REQUIRED');
    const all = JSON.stringify(orch.getTurnHistory(sid)) + JSON.stringify(orch.getConversationHistory(sid));
    expect(all).not.toContain('abc123');
    expect(all).not.toContain('482913');
  });

  it('context compression: long history → deterministic summary from BookingSession; sessionView is authoritative', async () => {
    const sid = state.createSession().sessionId;
    await say(sid, 'Amritsar se Delhi kal 2 log');
    await say(sid, '12014 wali');
    const history = Array.from({ length: 30 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as any, content: i === 29 ? '12497 selected' : `msg ${i}` }));
    const ctx = buildLLMContext(state.getSession(sid), history, 10);
    expect(ctx.recentMessages).toHaveLength(10);
    expect(ctx.summary).toContain('selectedTrain=12014');           // from session, not LLM text
    expect(ctx.sessionView.selectedTrain?.number).toBe('12014');
    expect(ctx.searchResults.version).toBe(state.getSession(sid).searchResultsVersion);
  });

  it('fact guard replaces an LLM message that upgrades RAC to "confirmed" or invents a fare', () => {
    const steps: any[] = [
      { status: 'ok', result: { toolName: 'CHECK_AVAILABILITY', data: { trainNumber: '12497', travelClass: 'CC', status: 'RAC 4' } } },
      { status: 'ok', result: { toolName: 'GET_FARE', data: { trainNumber: '12497', travelClass: 'CC', perPassenger: 490, total: 980, passengersCount: 2 } } }
    ];
    expect(factGuard('Confirmed seat mil jayegi, fare ₹980.', steps, 'TEXT')).toContain('RAC 4');
    expect(factGuard('Fare ₹750 hai.', steps, 'TEXT')).toContain('₹980');
    expect(factGuard('Availability RAC 4 hai, total ₹980.', steps, 'TEXT')).toBe('Availability RAC 4 hai, total ₹980.');
  });

  it('closed tool set: no booking/payment/OTP tools ever execute; TRACK/PNR declined without fake data', async () => {
    const sid = state.createSession().sessionId;
    const r = await say(sid, 'PNR 1234567890 ka status batao');
    expect(r.responseMessage).toMatch(/PNR status check abhi available nahi hai/);
    expect(tools(r)).toEqual([]);
    const evil: LLMProvider = { providerId: 'evil', init: async () => {}, generateStructuredDecision: async () => ({ decision: {
      intent: 'BOOK_TRAIN', action: 'NO_ACTION', entities: {}, missingFields: [], clarification: null, confidence: 1,
      toolCalls: [{ callId: 'x', name: 'BOOK_TICKET' as any, arguments: {} }, { callId: 'y', name: 'SUBMIT_PAYMENT' as any, arguments: {} }] } }) };
    const o = new ConversationAgentOrchestrator(evil, state, new RailwayToolService());
    CountingProvider.calls = [];
    const r2 = await o.processTurn(sid, 'book karo', 'TEXT');
    expect((r2.turnLog.toolResults || []).every(t => t.resultStatus === 'rejected' && t.errorCode === 'UNKNOWN_TOOL')).toBe(true);
    expect(CountingProvider.calls).toEqual([]);
  });
});
