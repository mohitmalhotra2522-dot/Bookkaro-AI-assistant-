/**
 * PROMPT 18 — GROUP 3 (end-to-end): full conversational agent loop
 *   user → ConversationTurnEngine → orchestrator → LLM → tool calls → RailwayToolRuntime (validate / plan /
 *   retry / timeout) → provider → results back to the LLM → grounded final → typed AssistantTurnResponse.
 * Covers the 10 Part-62 scenarios + multi / parallel / dependent tools, fresh, timeout, failure, retry,
 * stale / superseded, correction, voice / text parity, barge-in and confirmation safety.
 * Railway provider = labelled mock (non-live) spy. Backoff sleep injected (no real waiting).
 * afterEach: no fetch, IrctcHandoffAdapter.executeHandoff never called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { MOCK_CONVERSATION_SCENARIOS, FORBIDDEN_SUCCESS_CLAIMS } from '../../server/ai/turn-engine/mock-conversation-scenarios';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { reduceTurnEvent, EMPTY_TURN_VIEW } from '../../shared/turn-engine';

const meta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p18-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; failAvail = 0; hangAvail = false; slowSearchMs = 0; ttDelay = 0; fareDelay = 0;
  spans: Record<string, [number, number]> = {};
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> { this.b('search'); if (this.slowSearchMs) await new Promise(x => setTimeout(x, this.slowSearchMs)); return super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> {
    this.b('avail');
    if (this.hangAvail) return new Promise(() => {});
    if (this.failAvail > 0) { this.failAvail--; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock availability down.' }, meta: meta() }; }
    return super.checkAvailability(r);
  }
  async getFare(r: any): Promise<any> { this.b('fare'); const a = Date.now(); if (this.fareDelay) await new Promise(x => setTimeout(x, this.fareDelay)); const o = await super.getFare(r); this.spans.fare = [a, Date.now()]; return o; }
  async getTimetable(r: any): Promise<any> { this.b('tt'); const a = Date.now(); if (this.ttDelay) await new Promise(x => setTimeout(x, this.ttDelay)); const o = await super.getTimetable(r); this.spans.tt = [a, Date.now()]; return o; }
}
const rail = new SpyRailway();
railwayRegistry.register('p18-spy', () => rail);

type Evil = null | 'chain' | 'fakeFacts';
class SpyLLM extends MockLLMProvider {
  evil: Evil = null; rounds = 0;
  async generateStructuredDecision(input: any): Promise<any> {
    const r: any = await super.generateStructuredDecision(input);
    const n = (input.currentTurnToolResults || []).length;
    this.rounds++;
    if (this.evil === 'chain') {
      if (n === 0) r.decision = { ...r.decision, toolCalls: [{ callId: 'ch1', name: 'SEARCH_TRAINS', arguments: { origin: 'ASR', destination: 'NDLS', date: '2026-10-04' } }], finalMessage: undefined };
      else if (n === 1) r.decision = { ...r.decision, toolCalls: [{ callId: 'ch2', name: 'GET_TIMETABLE', arguments: { trainNumber: '12497' } }], finalMessage: undefined };
    }
    if (this.evil === 'fakeFacts' && n === 0) r.decision = { ...r.decision, toolCalls: [], finalMessage: '12497 usually on time chalti hai aur 07:45 par Ludhiana pahunchti hai. Abhi WL 3 hai.' };
    return r;
  }
}

function mk() {
  const state = new ConversationStateManager();
  const llm = new SpyLLM();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 150, sleep: async () => { /* injected: no real backoff */ } });
  const eng = new ConversationTurnEngine(orch, state);
  const sid = state.createSession().sessionId;
  return {
    state, llm, eng, sid,
    say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT', o: any = {}) => eng.processTurn(sid, t, mode, o) as Promise<any>,
    s: () => state.getSession(sid) as any
  };
}
const turnRecords = (r: any) => (r.turnLog.toolExecutions || []).filter((x: any) => x.turnId === r.turn.turnId);
const succeeded = (r: any) => turnRecords(r).filter((x: any) => x.status === 'SUCCEEDED').map((x: any) => x.tool);
const BOOK_CLAIM = new RegExp(FORBIDDEN_SUCCESS_CLAIMS.join('|'), 'i');
const tick = (ms: number) => new Promise(x => setTimeout(x, ms));

let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p18-spy');
  Object.assign(rail, { n: {}, failAvail: 0, hangAvail: false, slowSearchMs: 0, ttDelay: 0, fareDelay: 0, spans: {} });
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype as any, 'executeHandoff');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('P18 G3 — Part 62 scenarios (deterministic MockLLM catalog)', () => {
  for (const sc of MOCK_CONVERSATION_SCENARIOS.filter(x => !x.id.startsWith('S9') && !x.id.startsWith('S10'))) {
    it(`[${sc.id}] ${sc.title}`, async () => {
      const h = mk();
      for (const t of sc.turns) {
        const r = await h.say(t.text, t.mode || 'TEXT');
        expect(r.presentable).toBe(true);
        expect(r.turn.illegalTransitions).toEqual([]);
        const e = t.expect; if (!e) continue;
        for (const tool of e.toolsSucceeded || []) expect(succeeded(r)).toContain(tool);
        for (const tool of e.toolsNotExecuted || []) expect(turnRecords(r).some((x: any) => x.tool === tool && x.startedAt)).toBe(false);
        if ('pendingQuestion' in e) expect(h.s().pendingQuestion ?? null).toBe(e.pendingQuestion);
        if (e.bookingState) expect(h.s().bookingState).toBe(e.bookingState);
        if (e.responseType) expect(r.assistantTurnResponse.type).toBe(e.responseType);
        for (const x of e.responseIncludes || []) expect(r.responseMessage.toLowerCase()).toContain(x.toLowerCase());
        for (const x of e.responseExcludes || []) expect(r.responseMessage.toLowerCase()).not.toContain(x.toLowerCase());
      }
    });
  }

  it('[S9] route change during an in-flight search → old turn SUPERSEDED, its result never presented', async () => {
    const h = mk();
    rail.slowSearchMs = 60;
    const p1 = h.say('Amritsar se Delhi kal');
    await tick(5); rail.slowSearchMs = 0;
    const r2 = await h.say('nahi Amritsar se Ludhiana kal');
    const r1 = await p1;
    expect(r1.turn.status).toBe('SUPERSEDED');
    expect(r1.presentable).toBe(false);
    expect(r1.responseMessage).toBe('');
    expect(r1.turn.statusHistory.map((x: any) => x.status)).toContain('INTERRUPTED');
    expect(r2.presentable).toBe(true);
    expect(h.s().destination).toBe('LDH');
    expect(r2.responseMessage).toMatch(/Ludhiana/);
    expect(h.eng.getTurns(h.sid).map(t => t.presentation)).toEqual(['DISCARDED', 'PRESENTED']);
  });

  it('[S10] voice interrupts TTS → presentation INTERRUPTED, new turn in the SAME session', async () => {
    const h = mk();
    const r1 = await h.say('Amritsar se Delhi kal 2 log', 'VOICE');
    expect(r1.assistantTurnResponse.speechText).toBeTruthy();
    const out = h.eng.interrupt(h.sid, 'BARGE_IN');
    expect(out.kind).toBe('PRESENTATION');
    const r2 = await h.say('second wali', 'VOICE', { interruptPrevious: true });
    expect(r2.turn.sequence).toBe(2);
    expect(h.s().sessionId).toBe(h.sid);
    expect(h.s().selectedTrain.number).toBe('12497');
    const turns = h.eng.getTurns(h.sid);
    expect(turns[0].presentation).toBe('INTERRUPTED');
    expect(turns[0].status).toBe('WAITING_FOR_USER'); // completed turns never revert
    expect(turns[1].presentation).toBe('PRESENTED');
  });
});

describe('P18 G3 — tool loop behaviour', () => {
  it('[11] dependent multi-round tools: SEARCH → results back to LLM → GET_TIMETABLE in round 2', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal 2 log'); await h.say('12497');
    h.llm.evil = 'chain';
    const r = await h.say('details batao');
    h.llm.evil = null;
    expect(succeeded(r)).toEqual(['SEARCH_TRAINS', 'GET_TIMETABLE']);
    const plans = r.turnLog.toolPlans.filter((p: any) => p.status === 'SUCCEEDED').map((p: any) => p.planNodeId);
    expect(plans).toEqual(expect.arrayContaining(['r1n1', 'r2n1']));
    expect(r.turn.statusHistory.filter((x: any) => x.status === 'THINKING').length).toBeGreaterThanOrEqual(3);
    expect(r.assistantTurnResponse.type).toBe('FINAL');
  });

  it('[12] parallel independent tools: timetable + fare overlap at the provider, own execution ids', async () => {
    const h = mk();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) await h.say(t);
    rail.ttDelay = 40; rail.fareDelay = 40;
    const r = await h.say('12497 ka timetable aur fare batao');
    expect(succeeded(r)).toEqual(expect.arrayContaining(['GET_TIMETABLE', 'GET_FARE']));
    expect(rail.spans.tt[0]).toBeLessThan(rail.spans.fare[1]);
    expect(rail.spans.fare[0]).toBeLessThan(rail.spans.tt[1]);
    const ids = turnRecords(r).map((x: any) => x.toolExecutionId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.responseMessage).toMatch(/₹980/);
    expect(r.progress.map((p: any) => p.text)).toContain('Railway data check ho raha hai...');
  });

  it('[13] transient failure → ONE backend retry (new execution id) → success', async () => {
    const h = mk();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) await h.say(t);
    rail.failAvail = 1;
    const r = await h.say('availability batao');
    const recs = turnRecords(r).filter((x: any) => x.tool === 'CHECK_AVAILABILITY');
    expect(recs.map((x: any) => x.status)).toEqual(['FAILED', 'SUCCEEDED']);
    expect(recs[1].retryOf).toBe(recs[0].toolExecutionId);
    expect(r.responseMessage).toMatch(/RAC 4/);
    expect(r.assistantTurnResponse.type).toBe('FINAL');
  });

  it('[14] retries exhausted → structured failure, ERROR response, no fabricated availability', async () => {
    const h = mk();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) await h.say(t);
    rail.failAvail = 5;
    const before = rail.n.avail || 0;
    const r = await h.say('availability batao');
    expect((rail.n.avail || 0) - before).toBe(2); // first attempt + exactly one retry
    expect(r.assistantTurnResponse.type).toBe('ERROR');
    expect(r.responseMessage).not.toMatch(/RAC|WL|AVAILABLE \d|CNF/);
    expect(r.responseMessage).toMatch(/verify nahi/);
  });

  it('[15] provider timeout → TIMEOUT record, honest ERROR reply, turn finishes', async () => {
    const h = mk();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) await h.say(t);
    rail.hangAvail = true;
    const r = await h.say('abhi dobara availability check karo');
    rail.hangAvail = false;
    expect(turnRecords(r).some((x: any) => x.status === 'TIMEOUT')).toBe(true);
    expect(r.assistantTurnResponse.type).toBe('ERROR');
    expect(r.turn.status).toBe('WAITING_FOR_USER');
    expect(r.responseMessage).not.toMatch(/RAC 4/);
  });

  it('[16] explicit fresh request always hits the provider (no stale cache)', async () => {
    const h = mk();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) await h.say(t);
    const before = rail.n.avail || 0;
    const a = await h.say('Abhi availability dobara check karo');
    const b = await h.say('Abhi availability dobara check karo');
    expect((rail.n.avail || 0) - before).toBe(2);
    expect(turnRecords(a)[0].toolExecutionId).not.toBe(turnRecords(b)[0].toolExecutionId);
  });

  it('[17] ungrounded LLM claims → RESPONSE_GROUNDING_FAILED + verified fallback', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal 2 log'); await h.say('12497');
    h.llm.evil = 'fakeFacts';
    const r = await h.say('12497 kaisi train hai');
    h.llm.evil = null;
    expect(r.turn.groundingStatus).toBe('RESPONSE_GROUNDING_FAILED');
    expect(r.turnLog.turnEngine.groundingStatus).toBe('RESPONSE_GROUNDING_FAILED');
    expect(r.responseMessage).not.toMatch(/on time|07:45|WL 3/);
    expect(r.responseMessage).toContain('Is information ka verified result available nahi hai.');
  });
});

describe('P18 G3 — voice / text, interruption, safety, observability', () => {
  it('[18] text and voice share processTurn → identical state; voice gets the short ack', async () => {
    const hv = mk(), ht = mk();
    let v: any;
    for (const t of ['Amritsar se Delhi kal 2 log', 'second wali', 'CC']) { const x = await hv.say(t, 'VOICE'); v = v || x; await ht.say(t, 'TEXT'); }
    expect(hv.s().bookingState).toBe(ht.s().bookingState);
    expect(hv.s().selectedTrain.number).toBe(ht.s().selectedTrain.number);
    expect(hv.s().selectedClass).toBe('CC');
    expect(v.progress[0].speechText).toBe('Ek second, trains check kar raha hoon.');
  });

  it('[19] barge-in during an in-flight voice turn → IN_FLIGHT interrupt recorded, legal transitions, same session', async () => {
    const h = mk();
    rail.slowSearchMs = 60;
    const p = h.say('Amritsar se Delhi kal 2 log', 'VOICE');
    await tick(5);
    const out = h.eng.interrupt(h.sid, 'BARGE_IN');
    rail.slowSearchMs = 0;
    const r = await p;
    expect(out).toMatchObject({ kind: 'IN_FLIGHT', providerCancellation: 'NOT_SUPPORTED' });
    expect(r.turn.interrupted).toBe(true);
    expect(r.turn.statusHistory.map((x: any) => x.status)).toContain('INTERRUPTED');
    expect(r.turn.illegalTransitions).toEqual([]);
    expect(h.state.hasSession(h.sid)).toBe(true);
  });

  it('[20] confirmation safety: "haan book karo" = BOOKING_CONFIRMATION_REQUESTED only', async () => {
    const h = mk();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) await h.say(t);
    const review = await h.say('Rahul Sharma 31 male, Neha Sharma 28 female');
    expect(review.assistantTurnResponse.type).toBe('CONFIRMATION_REQUEST');
    const r = await h.say('haan book karo');
    expect(r.events).toContain('BOOKING_CONFIRMATION_REQUESTED');
    expect(r.responseMessage).not.toMatch(BOOK_CLAIM);
    expect(r.responseMessage).toMatch(/book nahi hua/i);
    expect(turnRecords(r).length).toBe(0);
  });

  it('[21] observability: turnLog.turnEngine carries the Part-56 fields', async () => {
    const h = mk();
    const r = await h.say('Amritsar se Delhi kal 2 log');
    expect(r.turnLog.turnEngine).toMatchObject({ sequence: 1, turnStatus: 'WAITING_FOR_USER', toolCount: 1, finalResponseType: 'FINAL',
      groundingStatus: 'PASSED', superseded: false, interrupted: false });
    expect(r.turnLog.turnEngine.toolExecutionIds).toHaveLength(1);
    expect(typeof r.turnLog.turnEngine.totalTurnLatencyMs).toBe('number');
  });

  it('[22] event stream is monotonic across turns; reconnect resumes without a new session', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal 2 log');
    await h.say('second wali');
    const all = h.eng.events.since(h.sid);
    for (let i = 1; i < all.length; i++) expect(all[i].seq).toBe(all[i - 1].seq + 1);
    let v = EMPTY_TURN_VIEW;
    for (const e of [...all].reverse()) v = reduceTurnEvent(v, e); // worst-case order: newest first
    expect(v.turnSequence).toBe(2);
    const sessions = (h.state as any).sessions?.size;
    const snap = h.eng.resume(h.sid)!;
    expect(snap.sessionId).toBe(h.sid);
    expect(snap.bookingState).toBe('CLASS_OPTIONS');
    expect(snap.currentTurn!.sequence).toBe(2);
    expect(snap.lastEventSeq).toBe(all[all.length - 1].seq);
    if (sessions !== undefined) expect((h.state as any).sessions.size).toBe(sessions);
  });
});
