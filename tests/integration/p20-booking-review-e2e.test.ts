/**
 * PROMPT 20 — GROUP 3 (integration): booking preparation + passenger workflow + review engine.
 *   ConversationTurnEngine → orchestrator → MockLLM → applier (state actions) / ToolCallValidator → RailwayToolRuntime
 *   → labelled mock (non-live) spy provider. Runs the 24 Part-53 catalogue scenarios plus Part-54 A–F.
 * Booking stays DISABLED: no handoff execution, no network, never COMPLETE, never a booked / PNR claim.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { FORBIDDEN_SUCCESS_CLAIMS } from '../../server/ai/turn-engine/mock-conversation-scenarios';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { MOCK_BOOKING_SCENARIOS, type MockBookingScenario } from '../../server/booking/preparation/mock-booking-scenarios';

const meta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p20-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; failFare = 0;
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  total() { return Object.values(this.n).reduce((a, b) => a + b, 0); }
  async searchTrains(r: any): Promise<any> { this.b('search'); return super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> { this.b('avail'); return super.checkAvailability(r); }
  async getFare(r: any): Promise<any> {
    this.b('fare');
    if (this.failFare > 0) { this.failFare--; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock fare down.' }, meta: meta() }; }
    return super.getFare(r);
  }
}
const rail = new SpyRailway();
railwayRegistry.register('p20-spy', () => rail);

/** Real MockLLM; optionally overrides the next structured decision (simulates an LLM proposal). */
class SpyLLM extends MockLLMProvider {
  patch: any = null; seen: string[] = [];
  async generateStructuredDecision(input: any): Promise<any> {
    this.seen.push(JSON.stringify(input));
    const r: any = await super.generateStructuredDecision(input);
    if (this.patch && !(input.currentTurnToolResults || []).length) { r.decision = { ...r.decision, ...this.patch, toolCalls: [] }; this.patch = null; }
    return r;
  }
}

function mk() {
  const state = new ConversationStateManager();
  const llm = new SpyLLM();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 200, sleep: async () => { /* no real backoff */ } });
  const eng = new ConversationTurnEngine(orch, state);
  const sid = state.createSession().sessionId;
  return {
    state, llm, eng, sid,
    say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT', o: any = {}) => eng.processTurn(sid, t, mode, o) as Promise<any>,
    s: () => state.getSession(sid) as any
  };
}
type H = ReturnType<typeof mk>;
const run = async (h: H, turns: string[]) => { let r: any; for (const t of turns) r = await h.say(t); return r; };
const UPTO_CLASS = ['Amritsar se Delhi kal', '12014 wali kar do', 'CC'];
const REVIEW_2 = [...UPTO_CLASS, '2 passengers. Mohit 31 male, Ravi 28 male.'];
const ran = (r: any) => (r.turnLog.toolExecutions || []).filter((x: any) => x.turnId === r.turn.turnId && x.startedAt).map((x: any) => x.tool).sort();
const prep = (r: any) => r.turnLog.bookingPreparation;
const pax = (h: H) => (h.s().passengers || []).map((p: any) => `${p.name || '_'}/${p.age ?? '_'}/${p.gender || '_'}`);
const BOOK_CLAIM = new RegExp(FORBIDDEN_SUCCESS_CLAIMS.join('|'), 'i');
const NAMES = /Mohit|Ravi|Amit/;

let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p20-spy');
  Object.assign(rail, { n: {}, failFare: 0 });
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype as any, 'executeHandoff');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

/** Runs one catalogue scenario and returns the list of failed expectations (empty = pass). */
async function runScenario(sc: MockBookingScenario): Promise<string[]> {
  const h = mk();
  let r: any, snap: any;
  for (const st of sc.steps as any[]) {
    if (st.op === 'INTERRUPT') h.eng.interrupt(h.sid, 'USER_STOP');
    else if (st.op === 'RESUME') snap = h.eng.resume(h.sid);
    else if (st.op === 'FARE_PROVIDER_DOWN') rail.failFare = 99;
    else r = await h.say(st.text, st.mode || 'TEXT', st.opts || {});
  }
  rail.failFare = 0;
  const s = h.s(), p = prep(r) || {}, e: any = sc.expect, bad: string[] = [];
  const got: Record<string, unknown> = {
    bookingState: s.bookingState, preparationState: p.bookingPreparationState, passengerCount: s.passengersCount, passengers: pax(h),
    reviewVersion: s.review?.reviewVersion ?? null, reviewStatus: p.reviewStatus, confirmationStatus: p.confirmationStatus,
    availabilityStatus: p.availabilityStatus, fareStatus: p.fareStatus, selectedTrain: s.selectedTrain?.number ?? null,
    selectedClass: s.selectedClass ?? null, errorCode: r.error?.code ?? null, errorType: p.errorType ?? null, toolsExecuted: ran(r)
  };
  for (const k of Object.keys(e)) {
    if (k === 'responseMatches') { for (const x of e[k]) if (!new RegExp(x, 'i').test(r.responseMessage)) bad.push(`reply !~ /${x}/`); continue; }
    if (k === 'responseExcludes') { for (const x of e[k]) if (new RegExp(x, 'i').test(r.responseMessage)) bad.push(`reply ~ /${x}/`); continue; }
    if (k === 'reviewDataSource') { if (!new RegExp(e[k], 'i').test(String(s.review?.snapshot?.dataSource))) bad.push('snapshot.dataSource'); continue; }
    if (k === 'snapshotFareStatus') { if (s.review?.snapshot?.fare?.status !== e[k]) bad.push(`snapshot.fare.status=${s.review?.snapshot?.fare?.status}`); continue; }
    if (k === 'resume') {
      for (const [kk, v] of Object.entries(e.resume)) if (snap?.bookingPreparation?.[kk] !== v) bad.push(`resume.${kk}=${snap?.bookingPreparation?.[kk]}`);
      if (snap?.sessionId !== h.sid) bad.push('resume created a new session');
      if (NAMES.test(JSON.stringify(snap?.bookingPreparation))) bad.push('PII in resume');
      continue;
    }
    const want = k === 'toolsExecuted' ? [...e[k]].sort() : e[k];
    if (JSON.stringify(got[k]) !== JSON.stringify(want)) bad.push(`${k}: got ${JSON.stringify(got[k])} want ${JSON.stringify(want)}`);
  }
  // global invariants on every scenario
  if (s.bookingState === 'COMPLETE' || p.bookingPreparationState === 'COMPLETE') bad.push('reached COMPLETE');
  if (BOOK_CLAIM.test(r.responseMessage)) bad.push('booking success claim');
  if (/\bPNR\b\s*[:#-]?\s*\d{6,}/i.test(r.responseMessage)) bad.push('PNR claim');
  if (/482913/.test(h.llm.seen.join('') + JSON.stringify(s) + JSON.stringify(r.turnLog))) bad.push('OTP leaked');
  if (NAMES.test(JSON.stringify(p))) bad.push('PII in turnLog.bookingPreparation');
  return bad;
}

describe('P20 G3 — Part 53 catalogue (24 deterministic scenarios)', () => {
  for (const sc of MOCK_BOOKING_SCENARIOS) {
    it(`[${sc.id}] ${sc.title}`, async () => { expect(await runScenario(sc)).toEqual([]); });
  }
});

describe('P20 G3 — Part 54 scenarios A–F', () => {
  it('[A] combined input → search filtered by CC, count kept; "second wali" → real train; class → details', async () => {
    const h = mk();
    let r = await h.say('Amritsar se Delhi kal, 2 log, CC.');
    expect(ran(r)).toEqual(['SEARCH_TRAINS']);
    expect(h.s().passengersCount).toBe(2);
    r = await h.say('second wali');
    expect(h.s().selectedTrain.number).toBe(h.s().searchResults.trains[1].trainNumber);
    r = await h.say('CC');
    expect(r.responseMessage).toMatch(/2 passengers ke details chahiye/i);
    expect(prep(r).bookingPreparationState).toBe('COLLECTING_PASSENGER_DETAILS');
  });

  it('[B] "12014 wali kar do" stores the actual train from the current result set (not an LLM claim)', async () => {
    const h = mk();
    await run(h, ['Amritsar se Delhi kal', '12014 wali kar do']);
    const t = h.s().selectedTrain;
    expect(t).toMatchObject({ number: '12014', searchResultId: h.s().searchResults.resultId });
  });

  it('[C] two passengers in one line → both stored, review built with provider fare', async () => {
    const h = mk();
    const r = await run(h, [...UPTO_CLASS, '2 passengers', 'Mohit 31 male, Ravi 28 male']);
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Ravi/28/MALE']);
    expect(prep(r)).toMatchObject({ reviewVersion: 1, reviewStatus: 'CURRENT', fareStatus: 'AVAILABLE' });
    expect(h.s().review.snapshot.fare).toMatchObject({ status: 'VERIFIED', total: 1040 });
  });

  it('[D] "Age 32 kar do" → field-only update (state action), review rebuilt (version++) via READY_FOR_REVIEW from fresh availability + fare', async () => {
    const h = mk();
    await run(h, REVIEW_2);
    const before = rail.total();
    const r = await h.say('First passenger ki age 32 kar do');
    // P33: a NEW review version is built only from THIS turn's availability + fare → the review-boundary refresh
    // (exactly one availability + one fare call); no search, and the LLM itself requested no railway tool.
    expect(rail.total()).toBe(before + 2);
    expect(ran(r)).toEqual(['CHECK_AVAILABILITY', 'GET_FARE']);
    expect(pax(h)[0]).toBe('Mohit/32/MALE');
    expect(prep(r)).toMatchObject({ reviewVersion: 2, reviewStatus: 'CURRENT', preparationPath: ['READY_FOR_REVIEW', 'REVIEW', 'AWAITING_CONFIRMATION'], actionKind: 'BOOKING_SESSION', toolRequested: ['CHECK_AVAILABILITY', 'GET_FARE'] });
    expect(h.s().review.snapshot.reviewVersion).toBe(2);
  });

  it('[E] "Abhi fare dobara check karo" → fresh GET_FARE provider call (no cache), review updated', async () => {
    const h = mk();
    await run(h, REVIEW_2);
    const f0 = rail.n.fare || 0;
    const r = await h.say('Abhi fare dobara check karo');
    expect(rail.n.fare).toBe(f0 + 1);
    // P33: the agent's own GET_FARE is current-turn evidence (not fetched twice); the boundary adds only availability
    expect(ran(r)).toEqual(['CHECK_AVAILABILITY', 'GET_FARE']);
    expect(prep(r)).toMatchObject({ reviewVersion: 2, actionKind: 'RAILWAY_INFORMATION', toolExecuted: ['GET_FARE', 'CHECK_AVAILABILITY'] });
  });

  it('[F] "Confirm." with a CURRENT review → BOOKING_CONFIRMATION_REQUESTED; without one → no confirmation', async () => {
    const a = mk();
    await run(a, REVIEW_2);
    const ok = await a.say('Confirm.');
    expect(prep(ok)).toMatchObject({ bookingPreparationState: 'BOOKING_CONFIRMATION_REQUESTED', confirmationStatus: 'CONFIRMATION_REQUESTED' });
    expect(ok.responseMessage).toMatch(/book nahi hua/i);
    expect(ok.responseMessage).not.toMatch(BOOK_CLAIM);
    const b = mk();
    await run(b, UPTO_CLASS);
    const no = await b.say('Confirm.');
    expect(no.responseMessage).toMatch(/Abhi confirm karne ke liye koi current review nahi hai/i);
    expect(prep(no)).toMatchObject({ errorType: 'INVALID_CONFIRMATION', confirmationStatus: 'NOT_REQUESTED' });
    const c = mk();
    const none = await c.say('haan');
    expect(none.responseMessage).toMatch(/Aap kis option ko continue karna chahte hain\?/i);
  });
});

describe('P20 G3 — state actions, review presentation, observability (Parts 36–50)', () => {
  it('state actions never reach the RailwayProvider; Prompt-20 alias accepted; unknown action → UNSUPPORTED_ACTION', async () => {
    const h = mk();
    await run(h, UPTO_CLASS);
    const n0 = rail.total();
    h.llm.patch = { intent: 'UPDATE_PASSENGERS', action: 'SET_PASSENGER_COUNT', entities: { passengersCountRaw: '2' } };
    let r = await h.say('do');
    expect(h.s().passengersCount).toBe(2);
    expect(prep(r)).toMatchObject({ actionKind: 'BOOKING_SESSION', stateAction: 'UPDATE_PASSENGERS', toolRequested: [] });
    h.llm.patch = { intent: 'COLLECT_PASSENGER_DETAILS', action: 'TELEPORT_TO_PAYMENT', entities: {} };
    r = await h.say('Mohit 31 male');
    expect(r.error?.code).toBe('UNSUPPORTED_ACTION');
    expect(pax(h)).toEqual(['_/_/_', '_/_/_']);
    expect(r.responseMessage).toMatch(/pehle passenger ka naam/i);
    await h.say('Mohit 31 male');
    expect(rail.total()).toBe(n0);
  });

  it('"Review dikhao" re-presents the CURRENT review without a new version; unchanged correction acknowledged', async () => {
    const h = mk();
    await run(h, REVIEW_2);
    let r = await h.say('Review dikhao');
    expect(r.responseMessage).toMatch(/Review \(v1\)/);
    expect((r.responseMessage.match(/Confirm karna hai/g) || []).length).toBe(1);
    expect(h.s().review.reviewVersion).toBe(1);
    r = await h.say('Second passenger ka naam Ravi hai.');
    expect(r.responseMessage).toMatch(/pehle se Ravi hai/i);
    expect(h.s().review.reviewVersion).toBe(1);
  });

  it('stale confirmation → STALE_REVIEW + current review shown; confirming the current version then works (never COMPLETE)', async () => {
    const h = mk();
    await run(h, [...REVIEW_2, 'First passenger ki age 32 kar do']);
    const stale = await h.say('haan', 'TEXT', { reviewVersion: 1 });
    expect(stale.error?.code).toBe('CONFIRMATION_VERSION_MISMATCH');
    expect(prep(stale).errorType).toBe('STALE_REVIEW');
    expect(stale.cards?.some((c: any) => c.type === 'review') || /Review \(v2\)/.test(stale.responseMessage)).toBe(true);
    const ok = await h.say('haan', 'TEXT', { reviewVersion: 2 });
    expect(prep(ok)).toMatchObject({ confirmationStatus: 'CONFIRMATION_REQUESTED', reviewVersion: 2 });
    expect(h.s().bookingState).not.toBe('COMPLETE');
  });

  it('count decrease drops the removed passenger from active data and re-prices with a fresh provider fare', async () => {
    const h = mk();
    await run(h, [...UPTO_CLASS, '3 passengers. Mohit 31 male, Ravi 28 male, Amit 40 male.']);
    const r = await h.say('Actually 2 hi hain.');
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Ravi/28/MALE']);
    expect(JSON.stringify(h.s().passengers)).not.toMatch(/Amit/);
    expect(h.s().fare).toMatchObject({ total: 1040 });
    expect(prep(r)).toMatchObject({ passengerCount: 2, reviewVersion: 2, reviewStatus: 'CURRENT' });
  });

  it('observability: before/after states, prep state, count, review + confirmation status, tools, latency — no PII', async () => {
    const h = mk();
    const r = await run(h, REVIEW_2);
    const log = r.turnLog;
    expect(log).toMatchObject({ stateBefore: expect.any(String), stateAfter: 'AWAITING_CONFIRMATION' });
    expect(typeof log.latencyMs).toBe('number');
    expect(prep(r)).toMatchObject({
      bookingPreparationState: 'AWAITING_CONFIRMATION', passengerCount: 2, reviewVersion: 1, reviewStatus: 'CURRENT', confirmationStatus: 'AWAITING_CONFIRMATION',
      toolRequested: ['CHECK_AVAILABILITY', 'GET_FARE'], toolExecuted: ['CHECK_AVAILABILITY', 'GET_FARE'],
      reviewSnapshot: { reviewVersion: 1, availabilityStatus: 'VERIFIED', fareStatus: 'VERIFIED' }
    });
    expect(JSON.stringify(log)).not.toMatch(NAMES);
  });
});
