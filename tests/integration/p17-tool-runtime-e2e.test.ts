/**
 * PROMPT 17 — GROUP 3 (end-to-end): LLM tool runtime through the real pipeline
 *   user → orchestrator → LLM → tool call → RailwayToolRuntime → validator → normalizer
 *   → RailwaySearchOrchestrator / RailwayToolService → RailwayProvider → LLMToolResult → grounded answer.
 * Railway provider = labelled mock (non-live) spy; MockBookingProvider is TEST-ONLY.
 * afterEach: no fetch, IrctcHandoffAdapter.executeHandoff never called, DisabledBookingProvider never invoked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { BookingProviderRegistry } from '../../server/booking/provider/booking-provider-registry';
import type { BookingProviderConfig } from '../../server/booking/provider/booking-provider-config';
import { MockBookingProvider } from '../../server/booking/testing/mock-booking-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { BookingState } from '../../shared/states';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

const iso = (e: string) => (resolveDate(e) as any).date as string;
const KAL = iso('kal'), PARSO = iso('parso');
const liveMeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p17-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; slowSearchMs = 0; failAvail = false; hangAvail = false; ttDelay = 0; fareDelay = 0;
  spans: Record<string, [number, number]> = {};
  private bump(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> { this.bump('search'); if (this.slowSearchMs) await new Promise(x => setTimeout(x, this.slowSearchMs)); return super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> {
    this.bump('avail');
    if (this.hangAvail) return new Promise(() => {});
    if (this.failAvail) return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock availability down.' }, meta: liveMeta() };
    return super.checkAvailability(r);
  }
  async getFare(r: any): Promise<any> { this.bump('fare'); const a = Date.now(); if (this.fareDelay) await new Promise(x => setTimeout(x, this.fareDelay)); const out = await super.getFare(r); this.spans.fare = [a, Date.now()]; return out; }
  async getTimetable(r: any): Promise<any> { this.bump('tt'); const a = Date.now(); if (this.ttDelay) await new Promise(x => setTimeout(x, this.ttDelay)); const out = await super.getTimetable(r); this.spans.tt = [a, Date.now()]; return out; }
  async trackTrain(r: any): Promise<any> { this.bump('track'); return { ok: true, data: { trainNumber: r.trainNumber, currentStatus: 'Running', currentStationCode: 'LDH', currentStationName: 'Ludhiana Junction', delayMinutes: 7 }, meta: liveMeta() }; }
  async checkPNR(r: any): Promise<any> { this.bump('pnr'); return { ok: true, data: { pnr: r.pnr, status: 'CNF', chartStatus: 'Chart not prepared', passengers: [{ number: 1, bookingStatus: 'CNF', currentStatus: 'CNF' }] }, meta: liveMeta() }; }
}
let rail = new SpyRailway();
railwayRegistry.register('p17-spy', () => rail);

type Evil = null | 'otherTrain' | 'fakePnr' | 'fakeFacts' | 'loop' | 'mutation' | 'credential' | 'llmDate';
class SpyLLM extends MockLLMProvider {
  evil: Evil = null; toolLists: string[][] = [];
  async generateStructuredDecision(input: any): Promise<any> {
    this.toolLists.push((input.tools || []).map((t: any) => t.name));
    const r: any = await super.generateStructuredDecision(input);
    const first = !(input.currentTurnToolResults || []).length;
    if (!this.evil) return r;
    if (this.evil === 'loop') { r.decision = { ...r.decision, toolCalls: [{ callId: `l${Math.random()}`, name: 'GET_TIMETABLE', arguments: { trainNumber: '12497' } }], finalMessage: undefined }; return r; }
    if (!first) return r;
    switch (this.evil) {
      case 'otherTrain': r.decision = { ...r.decision, toolCalls: [{ callId: 'o1', name: 'CHECK_AVAILABILITY', arguments: { trainNumber: '12014' } }] }; break;
      case 'fakePnr': r.decision = { ...r.decision, intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', toolCalls: [{ callId: 'p1', name: 'CHECK_PNR', arguments: { pnr: '8123456789' } }] }; break;
      case 'fakeFacts': r.decision = { ...r.decision, toolCalls: [], finalMessage: '12497 usually on time chalti hai aur 07:45 par Ludhiana pahunchti hai. Abhi WL 3 hai.' }; break;
      case 'mutation': r.decision = { ...r.decision, intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', finalMessage: 'Booking cancel ho gayi.', toolCalls: [
        { callId: 'm1', name: 'CANCEL_BOOKING', arguments: {} }, { callId: 'm2', name: 'EXECUTE_BOOKING', arguments: {} }, { callId: 'm3', name: 'PROCESS_REFUND', arguments: {} }] }; break;
      case 'credential': r.decision = { ...r.decision, toolCalls: [{ callId: 'c1', name: 'GET_FARE', arguments: { password: 'hunter2' } }] }; break;
      case 'llmDate': r.decision.toolCalls = (r.decision.toolCalls || []).map((c: any) => c.name === 'SEARCH_TRAINS' ? { ...c, arguments: { ...c.arguments, date: '2026-12-25' } } : c); break;
    }
    return r;
  }
}

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
let llm: SpyLLM;
const S = (sid: string): any => state.getSession(sid);
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT', o: any = undefined): Promise<any> => orch.processTurn(sid, text, mode, o);
const newSid = () => state.createSession().sessionId;
const ex = (r: any) => (r.turnLog.toolExecutions || []) as any[];
const enabledCfg = (provider: string): BookingProviderConfig => ({ provider, enabled: true, timeoutMs: 2000, configErrors: [] });
function setup() {
  llm = new SpyLLM();
  const p = new MockBookingProvider({ execute: 'CONFIRMED' });
  const reg = new BookingProviderRegistry({ allowTestProviders: true }); reg.register(p);
  state = new ConversationStateManager();
  orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService(), {
    bookingReconciliation: { config: { attemptTimeoutMs: 100 }, sleep: async () => {} },
    bookingProviderRegistry: reg, bookingProviderConfig: enabledCfg(p.name)
  } as any);
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 80 });
}
async function toClass(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) await say(sid, t, mode);
  expect(S(sid).selectedClass).toBe('CC');
}

let executeSpy: any, fetchSpy: any, disabledSpy: any;
beforeEach(() => {
  rail = new SpyRailway();
  railwayRegistry.setActive('p17-spy');
  setup();
  executeSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  disabledSpy = vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking');
});
afterEach(() => {
  expect(executeSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(disabledSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  railwayRegistry.setActive('mock');
});

describe('P17 G3 — LLM tool runtime end-to-end', () => {
  it('[1] full booking flow still works; review prep quotes run in parallel through the runtime', async () => {
    const sid = newSid();
    await toClass(sid);
    const rv = await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
    expect(rv.responseMessage).toContain('Fare: ₹980 (₹490 × 2)');
    const prep = ex(rv).filter(t => ['CHECK_AVAILABILITY', 'GET_FARE'].includes(t.tool));
    expect(prep.map(t => t.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(prep[0].parallelGroup).not.toBeNull();
    expect(prep[0].parallelGroup).toBe(prep[1].parallelGroup);
    const c = await say(sid, 'haan book karo');
    expect(c.responseMessage).toContain('Booking provider ne booking confirm ki hai.');
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_CONFIRMED);
  });

  it('[2] SEARCH_TRAINS via the runtime: fresh provider call, execution record, session results + displayed context updated', async () => {
    const sid = newSid();
    const r = await say(sid, 'Amritsar se Delhi kal 2 log');
    expect(rail.n.search).toBe(1);
    const e = ex(r)[0];
    expect(e).toMatchObject({ tool: 'SEARCH_TRAINS', status: 'SUCCEEDED', fresh: true, provider: expect.any(String), turnId: r.turnLog.turnId, sessionId: sid });
    expect(e.argumentsSummary).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: KAL });
    expect(e.argumentsHash).toMatch(/^[0-9a-f]{8}$/);
    expect(e.resultCount).toBe(3);
    expect(S(sid).searchResults.trains.map((t: any) => t.trainNumber)).toEqual(['12014', '12497', '18238']);
    expect(r.conversationContext.displayedResults.resultSetId).toBe(S(sid).searchResults.resultId);
    expect(r.turnLog.journeyVersion).toBeGreaterThan(0);
    // the LLM only ever sees the 7 implemented railway tools — never booking / cancel / payment
    expect(llm.toolLists[0].sort()).toEqual(['CHECK_AVAILABILITY', 'CHECK_PNR', 'GET_FARE', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'SEARCH_TRAINS', 'TRACK_TRAIN']);
  });

  it('[3] multiple independent tools in one turn run in parallel (timetable ∥ fare); "fare batao" reuses session values', async () => {
    const sid = newSid();
    await toClass(sid);
    rail.ttDelay = 30; rail.fareDelay = 30;
    const r = await say(sid, '12497 ka timetable aur fare batao');
    const e = ex(r);
    expect(e.map(x => x.tool)).toEqual(['GET_TIMETABLE', 'GET_FARE']);
    expect(e.every(x => x.status === 'SUCCEEDED')).toBe(true);
    expect(e[0].parallelGroup).toBe(e[1].parallelGroup);
    // the two provider calls overlapped in time (sequential execution would start fare after timetable ended)
    expect(rail.spans.fare[0]).toBeLessThan(rail.spans.tt[1]);
    expect(rail.spans.tt[0]).toBeLessThan(rail.spans.fare[1]);
    expect(r.responseMessage).toMatch(/Timetable:/);
    expect(r.responseMessage).toContain('₹980');
    rail.ttDelay = 0; rail.fareDelay = 0;
    const f = await say(sid, 'fare batao');
    expect(ex(f)[0]).toMatchObject({ tool: 'GET_FARE', status: 'SUCCEEDED' });
    expect(ex(f)[0].argumentsSummary).toMatchObject({ trainNumber: '12497', travelClass: 'CC', passengersCount: 2 });
    expect(f.responseMessage).not.toMatch(/Kis train|Kaunsi train/);
  });

  it('[4] TRACK_TRAIN uses the live provider (not the timetable); CHECK_PNR uses the provider for a user-typed PNR', async () => {
    const sid = newSid();
    await toClass(sid);
    const t = await say(sid, '12497 live status batao');
    expect(rail.n.track).toBe(1);
    expect(rail.n.tt || 0).toBe(0);
    expect(ex(t)[0]).toMatchObject({ tool: 'TRACK_TRAIN', status: 'SUCCEEDED' });
    expect(t.responseMessage).toMatch(/live status/);
    const p = await say(sid, 'PNR 4512345678 ka status batao');
    expect(rail.n.pnr).toBe(1);
    expect(ex(p)[0]).toMatchObject({ tool: 'CHECK_PNR', status: 'SUCCEEDED' });
    expect(JSON.stringify(p.turnLog)).not.toContain('4512345678');
    expect(ex(p)[0].argumentsSummary.pnr).toBe('45******78');
  });

  it('[5] LLM-fabricated PNR is rejected before the provider; credentials in arguments are rejected', async () => {
    const sid = newSid();
    await toClass(sid);
    llm.evil = 'fakePnr';
    const r = await say(sid, '12497 ke baare mein batao');
    llm.evil = null;
    expect(rail.n.pnr || 0).toBe(0);
    expect(ex(r)[0]).toMatchObject({ tool: 'CHECK_PNR', status: 'REJECTED', rejectionReason: 'AUTHORITATIVE_DATA_REQUIRED' });
    llm.evil = 'credential';
    const c = await say(sid, 'fare batao');
    llm.evil = null;
    expect(ex(c)[0]).toMatchObject({ status: 'REJECTED', rejectionReason: 'FORBIDDEN_ARGUMENT' });
    expect(JSON.stringify(c.turnLog)).not.toContain('hunter2');
    expect(c.responseMessage).toMatch(/kabhi nahi leta/);
  });

  it('[6] train / class references resolve against CURRENT results; invalid class → no provider call', async () => {
    const sid = newSid();
    await say(sid, 'Amritsar se Delhi kal 2 log');
    const r = await say(sid, 'doosri wali');
    expect(S(sid).selectedTrain.number).toBe('12497');
    const bad = await say(sid, '1A');
    expect(S(sid).selectedClass).toBeUndefined();
    expect(bad.responseMessage).toMatch(/3A|CC|SL|2S/);
    await say(sid, 'CC');
    expect(S(sid).selectedClass).toBe('CC');
    expect(r.error?.code).toBeUndefined();
  });

  it('[7] explicit fresh repeat ("abhi dobara check karo") always calls the provider again — no cache', async () => {
    const sid = newSid();
    await toClass(sid);
    const a = await say(sid, 'abhi dobara check karo');
    const b = await say(sid, 'abhi dobara check karo');
    expect(rail.n.avail).toBe(2);
    expect(ex(a)[0].toolExecutionId).not.toBe(ex(b)[0].toolExecutionId);
    expect(b.turnLog.freshRequested).toBe(true);
    expect(b.responseMessage).toMatch(/availability/);
  });

  it('[8] duplicate DELIVERY (same clientMessageId) is replayed, never re-executed; a new message runs fresh', async () => {
    const sid = newSid();
    const a = await say(sid, 'Amritsar se Delhi kal', 'TEXT', { clientMessageId: 'cm_dup_0001' });
    const b = await say(sid, 'Amritsar se Delhi kal', 'TEXT', { clientMessageId: 'cm_dup_0001' });
    expect(rail.n.search).toBe(1);
    expect(b.duplicateDelivery).toBe(true);
    expect(b.responseMessage).toBe(a.responseMessage);
    await say(sid, 'Amritsar se Delhi kal', 'TEXT', { clientMessageId: 'cm_dup_0002' });
    expect(rail.n.search).toBe(2);
  });

  it('[9] journey correction → journeyVersion increments; LLM date contradicting the user\'s words is corrected', async () => {
    const sid = newSid();
    const r1 = await say(sid, 'Amritsar se Delhi kal 2 log');
    const r2 = await say(sid, 'nahi parso');
    expect(S(sid).date).toBe(PARSO);
    expect(r2.turnLog.journeyVersion).toBeGreaterThan(r1.turnLog.journeyVersion);
    const s2 = newSid();
    llm.evil = 'llmDate';
    await say(s2, 'Amritsar se Delhi kal');
    llm.evil = null;
    expect(S(s2).date).toBe(KAL);
    expect(rail.n.search).toBeGreaterThanOrEqual(3);
  });

  it('[10] stale async: a slow search superseded by a correction is never applied (STALE_TOOL_RESULT)', async () => {
    const sid = newSid();
    rail.slowSearchMs = 40;
    const p1 = say(sid, 'Amritsar se Delhi kal');
    await new Promise(x => setTimeout(x, 5));
    rail.slowSearchMs = 0;
    const r2 = await say(sid, 'nahi Amritsar se Ludhiana kal');
    const r1 = await p1;
    expect(r1.stale).toBe(true);
    expect(r1.responseMessage).toBe('');
    expect(ex(r1)[0]).toMatchObject({ tool: 'SEARCH_TRAINS', status: 'CANCELLED', rejectionReason: 'STALE_TOOL_RESULT' });
    expect(S(sid).destination).toBe('LDH');
    expect(S(sid).searchResults.trains.map((t: any) => t.trainNumber)).toEqual(['12014', '04672']);
    expect(r2.error?.code).toBeUndefined();
  });

  it('[11] voice uses the same runtime (records, validation, grounding) with a short speechText', async () => {
    const sid = newSid();
    const r = await say(sid, 'Amritsar se Delhi kal 2 log', 'VOICE');
    expect(ex(r)[0]).toMatchObject({ tool: 'SEARCH_TRAINS', status: 'SUCCEEDED' });
    expect(r.assistantResponse.mode).toBe('VOICE');
    expect(r.assistantResponse.speechText.length).toBeLessThan(r.assistantResponse.text.length + 1);
    await say(sid, '12497', 'VOICE'); await say(sid, 'CC', 'VOICE');
    const t = await say(sid, '12497 ka timetable aur fare batao', 'TEXT');
    expect(ex(t).map(x => x.tool)).toEqual(['GET_TIMETABLE', 'GET_FARE']);
  });

  it('[12] booking mutations through LLM tool calls are blocked (FORBIDDEN_ACTION), nothing changes', async () => {
    const sid = newSid();
    await toClass(sid);
    const before = S(sid).bookingState;
    llm.evil = 'mutation';
    const r = await say(sid, '12497 ke baare mein batao');
    llm.evil = null;
    const recs = ex(r);
    expect(recs.length).toBe(3);
    expect(recs.every(x => x.status === 'REJECTED' && x.rejectionReason === 'FORBIDDEN_ACTION')).toBe(true);
    expect(r.responseMessage).not.toMatch(/cancel ho gayi/);
    expect(S(sid).bookingState).toBe(before);
    expect(S(sid).bookingExecution).toBeFalsy();
  });

  it('[13] SUCCESS + [] → honest empty result (not "search failed"); stale results cleared', async () => {
    const sid = newSid();
    const r = await say(sid, 'Ludhiana se Chandigarh kal');
    expect(ex(r)[0]).toMatchObject({ tool: 'SEARCH_TRAINS', status: 'SUCCEEDED', resultCount: 0 });
    expect(r.responseMessage).toMatch(/koi train nahi mili/);
    expect(r.responseMessage).not.toMatch(/complete nahi ho paayi|failed/i);
    expect(S(sid).searchResults).toBeUndefined();
    expect(S(sid).bookingState).toBe(BookingState.COLLECTING_JOURNEY);
    expect((r.cards || []).some((c: any) => c.type === 'trains')).toBe(false);
  });

  it('[14] partial failure keeps the successful part; timeout is not "no availability"', async () => {
    const sid = newSid();
    await toClass(sid);
    rail.failAvail = true;
    const r = await say(sid, '12497 ka timetable aur availability batao');
    rail.failAvail = false;
    expect(ex(r).map(x => x.status)).toEqual(['SUCCEEDED', 'FAILED']);
    expect(r.responseMessage).toContain('Timetable mil gaya, lekin availability abhi verify nahi ho paayi.');
    expect(r.responseMessage).toMatch(/Timetable:/);
    rail.hangAvail = true;
    const t = await say(sid, 'availability batao');
    rail.hangAvail = false;
    expect(ex(t)[0]).toMatchObject({ status: 'TIMEOUT', fresh: false });
    expect(t.responseMessage).toMatch(/verify nahi ho paayi/);
    expect(t.responseMessage).not.toMatch(/nahi mili|0 seat|no seats|WL|RAC/);
    expect(S(sid).availability?.CC).toBeUndefined();
  });

  it('[15] LLM picks a different train than the selected one → asks; "haan" selects it; explicit change resolves directly', async () => {
    const sid = newSid();
    await toClass(sid);
    llm.evil = 'otherTrain';
    const r = await say(sid, 'availability batao');
    llm.evil = null;
    expect(rail.n.avail || 0).toBe(0);
    expect(r.responseMessage).toContain('12497 selected hai. 12014 check karna hai?');
    expect(S(sid).pendingInteraction).toMatchObject({ type: 'CLARIFICATION_REQUIRED', data: { kind: 'CONTEXT_CONFLICT', field: 'selectedTrain', proposedCode: '12014' } });
    await say(sid, 'haan');
    expect(S(sid).selectedTrain.number).toBe('12014');
    await say(sid, '12014 nahi 12497 wali');
    expect(S(sid).selectedTrain.number).toBe('12497');
  });

  it('[16] grounding: invented punctuality / timing / availability → removed; verified fallback shown', async () => {
    const sid = newSid();
    await toClass(sid);
    llm.evil = 'fakeFacts';
    const r = await say(sid, '12497 kaisi train hai');
    llm.evil = null;
    expect(r.responseMessage).not.toMatch(/on time|07:45|WL 3/);
    expect(r.responseMessage).toContain('Is information ka verified result available nahi hai.');
    expect(r.turnLog.rejectedClaims).toEqual(expect.arrayContaining(['PUNCTUALITY_CLAIM']));
  });

  it('[17] identical-call loop → TOOL_LOOP_DETECTED, safe stop that keeps the verified result', async () => {
    const sid = newSid();
    await toClass(sid);
    llm.evil = 'loop';
    const r = await say(sid, 'timetable batao');
    llm.evil = null;
    expect(rail.n.tt).toBe(1);
    expect(ex(r).map(x => x.rejectionReason || x.status)).toEqual(['SUCCEEDED', 'TOOL_LOOP_DETECTED']);
    expect(r.responseMessage).toMatch(/Timetable:/);
    expect(r.responseMessage.match(/dobara nahi mangwa raha/g)?.length).toBe(1);
  });

  it('[18] cancelled trains → TOOL_NOT_IMPLEMENTED (honest, no fabricated list)', async () => {
    const sid = newSid();
    const r = await say(sid, 'aaj ki cancelled trains batao');
    expect(ex(r)[0]).toMatchObject({ tool: 'GET_CANCELLED_TRAINS', status: 'REJECTED', rejectionReason: 'TOOL_NOT_IMPLEMENTED' });
    expect(r.responseMessage).toMatch(/verified list abhi provider se uplabdh nahi/);
    expect(S(sid).bookingLifecycle?.status ?? null).not.toBe('CANCELLED');
  });
});
