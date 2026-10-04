/**
 * PROMPT 19 — GROUP 3 (integration): booking preparation + passenger collection + review + confirmation request.
 *   search → train → class → availability / fare (RailwayToolRuntime) → count → details → review → confirmation REQUEST.
 * 24 Part-56 scenarios through the real ConversationTurnEngine → orchestrator → MockLLM → applier → preparation
 * service. Railway provider = labelled mock (non-live) spy. Booking stays DISABLED: no handoff execution, no network,
 * never COMPLETE, never a booked / PNR claim.
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
import { BookingState } from '../../shared/states';

const meta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p19-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; failFare = 0;
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> { this.b('search'); return super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> { this.b('avail'); return super.checkAvailability(r); }
  async getFare(r: any): Promise<any> {
    this.b('fare');
    if (this.failFare > 0) { this.failFare--; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock fare down.' }, meta: meta() }; }
    return super.getFare(r);
  }
}
const rail = new SpyRailway();
railwayRegistry.register('p19-spy', () => rail);

/** Real MockLLM + optional injected structured proposal (Part 13: { passengerIndex, changes }). */
class SpyLLM extends MockLLMProvider {
  inject: any[] | null = null; seen: any[] = [];
  async generateStructuredDecision(input: any): Promise<any> {
    this.seen.push(input);
    const r: any = await super.generateStructuredDecision(input);
    if (this.inject && !(input.currentTurnToolResults || []).length) {
      r.decision = { ...r.decision, intent: 'COLLECT_PASSENGER_DETAILS', action: 'COLLECT_PASSENGER_DETAILS', entities: { ...(r.decision.entities || {}), passengerChanges: this.inject }, toolCalls: [] };
      this.inject = null;
    }
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
const run = async (h: H, turns: string[], mode: 'TEXT' | 'VOICE' = 'TEXT') => { let r: any; for (const t of turns) r = await h.say(t, mode); return r; };
const UPTO_CLASS = ['Amritsar se Delhi kal', '12014 wali kar do', 'CC'];
const toReview = (h: H, mode: 'TEXT' | 'VOICE' = 'TEXT') => run(h, [...UPTO_CLASS, '2 passengers. Mohit 31 male, Ravi 28 male.'], mode);
const recs = (r: any) => (r.turnLog.toolExecutions || []).filter((x: any) => x.turnId === r.turn.turnId);
const ran = (r: any) => recs(r).filter((x: any) => x.startedAt).map((x: any) => x.tool);
const prep = (r: any) => r.turnLog.bookingPreparation;
const pax = (h: H) => (h.s().passengers || []).map((p: any) => `${p.name || '_'}/${p.age ?? '_'}/${p.gender || '_'}`);
const BOOK_CLAIM = new RegExp(FORBIDDEN_SUCCESS_CLAIMS.join('|'), 'i');
const NAMES = /Mohit|Ravi|Riya|Rohit|Amit/;

let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p19-spy');
  Object.assign(rail, { n: {}, failFare: 0 });
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype as any, 'executeHandoff');
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('P19 G3 — booking preparation pipeline (Part 56)', () => {
  it('[01 count] "12014 wali kar do" → "CC" → "2 passengers" → "2 passengers ke details chahiye"', async () => {
    const h = mk();
    let r = await run(h, UPTO_CLASS);
    expect(r.responseMessage).toMatch(/Kitne passengers hain\?/);
    expect(prep(r).bookingPreparationState).toBe('COLLECTING_PASSENGERS');
    expect(prep(r).preparationPath).toEqual(['CLASS_SELECTED', 'BOOKING_PREPARE', 'COLLECTING_PASSENGERS']);
    r = await h.say('2 passengers');
    expect(h.s().passengersCount).toBe(2);
    expect(r.responseMessage).toMatch(/2 passengers ke details chahiye\. Pehle passenger ka naam bataiye\./);
    expect(prep(r)).toMatchObject({ bookingPreparationState: 'COLLECTING_PASSENGER_DETAILS', passengerCount: 2, passengersComplete: 0 });
    expect(ran(r)).toEqual([]);                                                       // no provider call for a count
  });

  it('[02 invalid count] zero / minus / 100 → INVALID_PASSENGER_COUNT, nothing applied, question kept', async () => {
    const h = mk();
    await run(h, UPTO_CLASS);
    const before = { ...rail.n };
    for (const t of ['zero passengers', 'minus two', '100 passengers']) {
      const r = await h.say(t);
      expect(r.error?.code, t).toBe('INVALID_PASSENGER_COUNT');
      expect(h.s().passengersCount ?? null, t).toBeNull();
      expect(h.s().pendingInteraction?.type).toBe('PASSENGERS_REQUIRED');
      expect(r.responseMessage).toMatch(/kitne passengers hain\?/i);
      expect(r.turnLog.events).toContain('PASSENGER_COUNT_REJECTED');
    }
    expect(rail.n).toEqual(before);
    const ok = await h.say('hum 3 hain');
    expect(h.s().passengersCount).toBe(3);
    expect(ok.error).toBeFalsy();
  });

  it('[03 extraction] count + all details in one turn → REVIEW directly (fresh availability + fare via runtime)', async () => {
    const h = mk();
    const r = await toReview(h);
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Ravi/28/MALE']);
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(ran(r)).toEqual(expect.arrayContaining(['CHECK_AVAILABILITY', 'GET_FARE']));
    expect(prep(r)).toMatchObject({ reviewVersion: 1, reviewStatus: 'CURRENT', availabilityStatus: 'AVAILABLE', fareStatus: 'AVAILABLE' });
  });

  it('[04 partial] name only → asks ONLY for age; punctuation never becomes part of the name', async () => {
    const h = mk();
    await run(h, [...UPTO_CLASS, '2 passengers']);
    let r = await h.say('First passenger ka naam Mohit hai.');
    expect(pax(h)[0]).toBe('Mohit/_/_');
    expect(r.responseMessage).toMatch(/umar/i);
    expect(r.responseMessage).not.toMatch(/gender|naam bataiye/i);
    r = await h.say('Age 31.');
    expect(pax(h)[0]).toBe('Mohit/31/_');
    expect(r.responseMessage).toMatch(/gender/i);
    await h.say('Male.');
    expect(pax(h)[0]).toBe('Mohit/31/MALE');
  });

  it('[05 multi-field] "First passenger Mohit, 31 male" fills name + age + gender', async () => {
    const h = mk();
    await run(h, [...UPTO_CLASS, '2 passengers']);
    const r = await h.say('First passenger Mohit, 31 male.');
    expect(pax(h)).toEqual(['Mohit/31/MALE', '_/_/_']);
    expect(r.responseMessage).toMatch(/Doosre passenger ka naam/);
    expect(prep(r).passengersComplete).toBe(1);
  });

  it('[06 correction] "Age 32 kar do" / "Second passenger female hai." / "Naam galat hai." change only that field', async () => {
    const h = mk();
    await toReview(h);
    let r = await h.say('Age 32 kar do');
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Ravi/32/MALE']);
    expect(prep(r).reviewVersion).toBe(2);
    r = await h.say('Second passenger female hai.');
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Ravi/32/FEMALE']);
    expect(r.responseMessage).not.toMatch(/Kis passenger/);
    r = await h.say('Naam galat hai.');
    expect(r.responseMessage).toMatch(/naya naam kya hai\?/);
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Ravi/32/FEMALE']);                       // nothing renamed to "Hai"
    r = await h.say('Rohit');
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Rohit/32/FEMALE']);
    expect(prep(r)).toMatchObject({ reviewVersion: 4, reviewStatus: 'CURRENT' });
  });

  it('[07 index] "doosre wale ka naam Riya hai" → passenger 2; LLM index 5 → INVALID_PASSENGER_INDEX', async () => {
    const h = mk();
    await toReview(h);
    await h.say('doosre wale ka naam Riya hai');
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Riya/28/MALE']);
    h.llm.inject = [{ passengerIndex: 5, changes: { age: 30 } }];
    const r = await h.say('Paanchve passenger ki age 30');
    expect(r.error?.code).toBe('INVALID_PASSENGER_INDEX');
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Riya/28/MALE']);
  });

  it('[08 prep guard] selected train no longer in the CURRENT results → BOOKING_PREPARATION_NOT_READY + ask, no fetch, no review', async () => {
    const h = mk();
    await run(h, [...UPTO_CLASS, '2 passengers']);
    const s = h.s();
    s.searchResults.trains = s.searchResults.trains.filter((t: any) => t.trainNumber !== '12014');
    const before = { ...rail.n };
    const r = await h.say('Mohit 31 male, Ravi 28 male');
    expect(r.error?.code).toBe('BOOKING_PREPARATION_NOT_READY');
    expect(r.responseMessage).toMatch(/current search results mein nahi hai/);
    expect(r.responseMessage).toMatch(/\?/);
    expect(h.s().review?.valid).toBeFalsy();
    expect(rail.n.avail || 0).toBe(before.avail || 0);
    expect(rail.n.fare || 0).toBe(before.fare || 0);
    expect(prep(r).missingPrerequisites).toEqual(['TRAIN_NOT_IN_CURRENT_RESULTS']);
  });

  it('[09 train] a train number that is not in the results is never trusted', async () => {
    const h = mk();
    await run(h, ['Amritsar se Delhi kal']);
    const r = await h.say('99999 wali kar do');
    expect(r.error?.code).toBe('INVALID_TRAIN_REFERENCE');
    expect(h.s().selectedTrain).toBeFalsy();
    expect(prep(r).bookingPreparationState).toBe('NOT_STARTED');
  });

  it('[10 class] "CC nahi 3A kar do" on a CC/2S train → rejected, class + review kept, asks', async () => {
    const h = mk();
    await toReview(h);
    const r = await h.say('CC nahi 3A kar do');
    expect(r.error?.code).toBe('INVALID_CLASS_SELECTION');
    expect(h.s().selectedClass).toBe('CC');
    expect(r.responseMessage).toMatch(/available nahi hai.*\?/);
    expect(prep(r)).toMatchObject({ reviewVersion: 1, reviewStatus: 'CURRENT' });
  });

  it('[11 availability dependency] explicit "availability confirm kar do" → fresh provider call; class change re-fetches', async () => {
    const h = mk();
    await toReview(h);
    const a0 = rail.n.avail;
    let r = await h.say('Review se pehle availability confirm kar do.');
    expect(rail.n.avail).toBe(a0 + 1);                                                   // no cache
    expect(ran(r)).toContain('CHECK_AVAILABILITY');
    r = await h.say('CC nahi 2S kar do');
    expect(h.s().availability['2S'].travelClass ?? '2S').toBe('2S');
    expect(ran(r)).toEqual(expect.arrayContaining(['CHECK_AVAILABILITY', 'GET_FARE']));
    expect(prep(r)).toMatchObject({ availabilityStatus: 'AVAILABLE', fareStatus: 'AVAILABLE', reviewStatus: 'CURRENT' });
  });

  it('[12 fare dependency] provider fare failure → NO valid review (Prompt 33 §34), real reason, fareStatus UNAVAILABLE, no invented amount', async () => {
    const h = mk();
    rail.failFare = 5;
    const r = await toReview(h);
    // Prompt 33 supersedes the Prompt 8/19 "review with unverified fare": an unverifiable fare leaves no review
    expect(r.error?.code).toBe('BOOKING_NOT_READY');
    expect(r.responseMessage).toMatch(/fare verify hona zaroori hai/);
    expect(r.responseMessage).toMatch(/railway provider abhi uplabdh nahi hai/);
    expect(r.responseMessage).not.toMatch(/₹/);
    expect(prep(r).fareStatus).toBe('UNAVAILABLE');
    expect(h.s().preparationDependencies.fare).toMatchObject({ status: 'UNAVAILABLE', errorCode: 'PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(h.s().preparationDependencies)).not.toMatch(/total|amount/);
    expect(r.cards.find((c: any) => c.type === 'review')).toBeUndefined();
    expect(h.s().review?.valid ?? false).toBe(false);
    expect(h.s().bookingState).not.toBe('AWAITING_CONFIRMATION');
  });

  it('[13 review create] minimal review: route / date / train / class / pax / Fare ₹X / "Confirm karna hai?"', async () => {
    const h = mk();
    const r = await toReview(h);
    const m = r.responseMessage;
    for (const re of [/Review \(v1\)/, /Amritsar → New Delhi/, /4 Oct/, /12014/, /CC/, /2 passengers/, /Fare: ₹1040 \(₹520 × 2\)/, /Confirm karna hai\?/]) expect(m).toMatch(re);
    expect(m).not.toMatch(/coach|berth no|seat no|PNR/i);
    expect(r.cards.some((c: any) => c.type === 'review')).toBe(true);
    expect(h.s().bookingPreparationState).toBe('AWAITING_CONFIRMATION');
  });

  it('[14 invalidation] date change after review → fresh search / availability / fare and a new review version', async () => {
    const h = mk();
    await toReview(h);
    const r = await h.say('kal nahi parso');
    expect(h.s().date).toBe('2026-10-05');
    expect(ran(r)).toEqual(expect.arrayContaining(['SEARCH_TRAINS', 'CHECK_AVAILABILITY', 'GET_FARE']));
    expect(prep(r)).toMatchObject({ reviewVersion: 2, reviewStatus: 'CURRENT' });
    expect(h.s().selectedTrain).toBeTruthy();
    expect(h.s().selectedClass).toBe('CC');
  });

  it('[15 stale] confirming an OLD review version is refused; the current one is required', async () => {
    const h = mk();
    await toReview(h);
    await h.say('Age 32 kar do');                                                        // → v2
    const r = await h.say('haan', 'TEXT', { reviewVersion: 1 });
    expect(r.error?.code).toBe('CONFIRMATION_VERSION_MISMATCH');
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(prep(r).confirmationStatus).toBe('AWAITING_CONFIRMATION');
  });

  it('[16 confirmation safety] "haan" on the CURRENT review → BOOKING_CONFIRMATION_REQUESTED, then STOP (never COMPLETE / booked)', async () => {
    const h = mk();
    await toReview(h);
    const r = await h.say('haan');
    expect(prep(r)).toMatchObject({ bookingPreparationState: 'BOOKING_CONFIRMATION_REQUESTED', confirmationStatus: 'CONFIRMATION_REQUESTED', reviewVersion: 1 });
    expect(h.s().bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(h.s().bookingState).not.toBe(BookingState.COMPLETE);
    expect(r.responseMessage).toMatch(/Ticket abhi book nahi hua hai/);
    expect(r.responseMessage).not.toMatch(BOOK_CLAIM);
    expect(r.responseMessage).not.toMatch(/PNR/);
    expect(r.turnLog.events).toContain('BOOKING_CONFIRMATION_REQUESTED');
  });

  it('[17 confirm without review] "confirm" / "book it" / "haan" mid-collection is NOT a booking', async () => {
    const h = mk();
    await run(h, [...UPTO_CLASS, '2 passengers']);
    for (const t of ['confirm', 'book it', 'haan']) {
      const r = await h.say(t);
      expect(r.error?.code, t).toBe('CONFIRMATION_NOT_PENDING');
      expect(h.s().bookingState).toBe(BookingState.COLLECTING_PASSENGER_DETAILS);
      expect(prep(r).confirmationStatus).toBe('NOT_REQUESTED');
    }
  });

  it('[18 class change after review] "CC nahi 2S kar do" → fresh availability + fare, review v2 (₹240)', async () => {
    const h = mk();
    await toReview(h);
    const r = await h.say('CC nahi 2S kar do');
    expect(h.s().selectedClass).toBe('2S');
    expect(r.responseMessage).toMatch(/Fare: ₹240 \(₹120 × 2\)/);
    expect(prep(r)).toMatchObject({ reviewVersion: 2, reviewStatus: 'CURRENT' });
  });

  it('[19 train change after review] "12497 wali kar do" → class / availability / fare / review invalidated, asks class', async () => {
    const h = mk();
    await toReview(h);
    const r = await h.say('12497 wali kar do');
    expect(h.s().selectedTrain.trainNumber || h.s().selectedTrain.number).toBe('12497');
    expect(h.s().selectedClass).toBeFalsy();
    expect(h.s().review.valid).toBe(false);
    expect(prep(r)).toMatchObject({ reviewStatus: 'STALE', fareStatus: 'NOT_REQUESTED', availabilityStatus: 'NOT_REQUESTED', bookingPreparationState: 'NOT_STARTED' });
    expect(r.responseMessage).toMatch(/Kaunsi class chahiye\?/);
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Ravi/28/MALE']);                           // passengers survive
  });

  it('[20 count change after review] "Actually 3 passengers" → resize, keep route/date/train/class, fresh fare on completion', async () => {
    const h = mk();
    await toReview(h);
    let r = await h.say('Actually 3 passengers.');
    expect(h.s().passengersCount).toBe(3);
    expect(pax(h)).toEqual(['Mohit/31/MALE', 'Ravi/28/MALE', '_/_/_']);
    expect([h.s().origin, h.s().destination, h.s().date, h.s().selectedClass]).toEqual(['ASR', 'NDLS', '2026-10-04', 'CC']);
    expect(prep(r)).toMatchObject({ reviewStatus: 'STALE', fareStatus: 'NOT_REQUESTED', bookingPreparationState: 'COLLECTING_PASSENGER_DETAILS' });
    expect(r.responseMessage).toMatch(/Teesre passenger ka naam/);
    const f0 = rail.n.fare;
    r = await h.say('Teesra Amit 40 male');
    expect(rail.n.fare).toBe(f0 + 1);
    expect(r.responseMessage).toMatch(/Fare: ₹1560 \(₹520 × 3\)/);
    expect(prep(r)).toMatchObject({ reviewVersion: 2, reviewStatus: 'CURRENT' });
  });

  it('[21 voice / text parity] same pipeline + states in VOICE; prompts short, one question at a time', async () => {
    const t = mk(); const v = mk();
    const turns = [...UPTO_CLASS, 'do passengers', 'Mohit 31 male', 'Ravi 28 male', 'haan'];
    for (const x of turns) {
      const a = await t.say(x, 'TEXT'); const b = await v.say(x, 'VOICE');
      expect(prep(b).bookingPreparationState, x).toBe(prep(a).bookingPreparationState);
      expect(v.s().bookingState).toBe(t.s().bookingState);
      expect((b.responseMessage.match(/\?/g) || []).length, x).toBeLessThanOrEqual(1);
      if (x === 'do passengers') expect(b.responseMessage).toBe('Pehle passenger ka naam?');
    }
    expect(prep(await v.say('haan', 'VOICE')).confirmationStatus).toBe('CONFIRMATION_REQUESTED');
  });

  it('[22 interruption] mid-collection resize keeps collected details and continues with the next missing field', async () => {
    const h = mk();
    await run(h, [...UPTO_CLASS, '2 passengers', 'Mohit 31 male']);
    const r = await h.say('Actually 3 passengers.');
    expect(pax(h)).toEqual(['Mohit/31/MALE', '_/_/_', '_/_/_']);
    expect(r.responseMessage).toMatch(/Doosre passenger ka naam/);
    expect(prep(r)).toMatchObject({ passengerCount: 3, passengersComplete: 1 });
  });

  it('[23 recovery] reload / resume restores preparation, collection, reviewVersion and confirmation (no PII)', async () => {
    const h = mk();
    await toReview(h);
    await h.say('Age 32 kar do');
    let snap: any = h.eng.resume(h.sid);
    expect(snap.bookingPreparation).toMatchObject({ bookingPreparationState: 'AWAITING_CONFIRMATION', passengerCollectionState: 'PASSENGERS_COMPLETE', reviewVersion: 2, reviewStatus: 'CURRENT', confirmationStatus: 'AWAITING_CONFIRMATION' });
    expect(JSON.stringify(snap.bookingPreparation)).not.toMatch(NAMES);
    await h.say('haan');
    snap = h.eng.resume(h.sid);
    expect(snap.bookingPreparation.confirmationStatus).toBe('CONFIRMATION_REQUESTED');
    expect(h.eng.resume('missing-session')).toBeNull();
  });

  it('[24 sensitive] OTP / password with passenger data → safe refusal, nothing stored; LLM proposal with a credential rejected', async () => {
    const h = mk();
    await run(h, [...UPTO_CLASS, '2 passengers']);
    let r = await h.say('Mohit 31 male, OTP 123456');
    expect(r.error?.code).toBe('SENSITIVE_REQUEST_REJECTED');
    expect(pax(h)).toEqual(['_/_/_', '_/_/_']);
    r = await h.say('Passenger ka password abc123 hai');
    expect(r.error?.code).toBe('SENSITIVE_REQUEST_REJECTED');
    h.llm.inject = [{ passengerIndex: 1, changes: { name: 'Mohit', cvv: '998' } }];
    r = await h.say('Pehla passenger Mohit');
    expect(r.error?.code).toBe('SENSITIVE_DATA_REJECTED');
    expect(pax(h)).toEqual(['_/_/_', '_/_/_']);
    expect(JSON.stringify(h.s())).not.toMatch(/123456|abc123|"998"/);
    expect(JSON.stringify(r.turnLog)).not.toMatch(/123456|abc123|"998"/);
  });
});

describe('P19 G3 — LLM proposals, provider boundaries and observability (Parts 12–14, 33–34, 46)', () => {
  it('valid LLM { passengerIndex, changes } proposal is applied only after validation; bad field / value rejected', async () => {
    const h = mk();
    await run(h, [...UPTO_CLASS, '2 passengers']);
    h.llm.inject = [{ passengerIndex: 1, changes: { name: 'Mohit', age: 31, gender: 'MALE' } }];
    await h.say('Pehla passenger Mohit 31 male');
    expect(pax(h)[0]).toBe('Mohit/31/MALE');
    h.llm.inject = [{ passengerIndex: 1, changes: { category: 'CHILD' } }];
    expect((await h.say('Mohit child hai')).error?.code).toBe('INVALID_PASSENGER_FIELD');
    h.llm.inject = [{ passengerIndex: 1, changes: { age: 300 } }];
    expect((await h.say('Mohit ki age 300')).error?.code).toBe('INVALID_PASSENGER_VALUE');
    expect(pax(h)[0]).toBe('Mohit/31/MALE');
  });

  it('passenger / review / confirmation operations are state actions: no search, only the review boundary refreshes availability + fare', async () => {
    // P33: a new review version is built only from current-turn availability + fare (the P11–P13 review boundary);
    // a passenger edit itself never searches, and confirmation ("haan") makes no provider call at all.
    const h = mk();
    await toReview(h);
    const before = { ...rail.n };
    for (const t of ['Age 32 kar do', 'Second passenger female hai.', 'doosre wale ka naam Riya hai']) {
      const r = await h.say(t);
      for (const tool of ran(r)) expect(['CHECK_AVAILABILITY', 'GET_FARE'], t).toContain(tool);
    }
    expect(rail.n.search || 0).toBe(before.search || 0);
    const atConfirm = { ...rail.n };
    expect(ran(await h.say('haan')), 'haan').toEqual([]);
    expect(rail.n).toEqual(atConfirm);
  });

  it('observability carries statuses / counts only — no passenger names in turnLog, events or the preparation summary', async () => {
    const h = mk();
    const r = await toReview(h);
    expect(prep(r)).toMatchObject({ bookingPreparationState: 'AWAITING_CONFIRMATION', passengerCollectionState: 'PASSENGERS_COMPLETE', passengerCount: 2, reviewVersion: 1, reviewStatus: 'CURRENT', confirmationStatus: 'AWAITING_CONFIRMATION' });
    expect(JSON.stringify(r.turnLog)).not.toMatch(NAMES);
    const s = h.s();
    expect(JSON.stringify((s.eventLog || []).map((e: any) => e.payload ?? e.data ?? null))).not.toMatch(NAMES);
    expect(s.bookingPreparationState).toBe('AWAITING_CONFIRMATION');
    expect(JSON.stringify(s.preparationTrace)).not.toMatch(NAMES);
  });
});
