/**
 * PROMPT 16 — GROUP 3 (end-to-end, multi-turn): advanced conversation context, corrections, reference
 * resolution, pending questions, conflicts, topic switches, barge-in, dedup, new-journey isolation,
 * history references and the AssistantResponse — through the real pipeline
 * (normalizer → context → LLM → applier/validator → runtime → provider → session → response).
 * Railway provider = labelled mock (non-live) test double; MockBookingProvider is TEST-ONLY.
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
import { BookingState } from '../../shared/states';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

const iso = (e: string) => { const r: any = resolveDate(e); return r.date as string; };
const KAL = iso('kal'), PARSO = iso('parso');
const liveMeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p16-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };

/** Counts provider calls (proves "no search happened" / "fresh call" / "deduplicated"). */
class SpyRailway extends MockRailwayProvider {
  searches: Array<{ origin: string; destination: string; date: string }> = []; avail = 0; track = 0; pnr = 0;
  async searchTrains(r: any): Promise<any> { this.searches.push({ origin: r.origin, destination: r.destination, date: r.date }); return super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> { this.avail++; return super.checkAvailability(r); }
  async trackTrain(r: any): Promise<any> { this.track++; return { ok: true, data: { trainNumber: r.trainNumber, currentStatus: 'Running', currentStationCode: 'LDH', currentStationName: 'Ludhiana Junction', delayMinutes: 7 }, meta: liveMeta() }; }
  async checkPNR(r: any): Promise<any> { this.pnr++; return { ok: true, data: { pnr: r.pnr, status: 'CNF', chartStatus: 'Chart not prepared', passengers: [{ number: 1, bookingStatus: 'CNF', currentStatus: 'CNF' }] }, meta: liveMeta() }; }
}
let rail = new SpyRailway();
railwayRegistry.register('p16-spy', () => rail);

type Evil = null | 'injectDest' | 'argsOnly' | 'fake' | 'dup' | 'llmDate' | 'malformed' | 'mutation';
class SpyLLM extends MockLLMProvider {
  evil: Evil = null; histories: string[][] = []; contexts: any[] = [];
  async generateStructuredDecision(input: any): Promise<any> {
    this.histories.push((input.history || []).map((h: any) => String(h.content)));
    this.contexts.push(input.context?.conversationContext);
    const r: any = await super.generateStructuredDecision(input);
    const first = !(input.currentTurnToolResults || []).length;
    if (!first || !this.evil) return r;
    const s = input.session;
    switch (this.evil) {
      case 'injectDest': // LLM "remembers" an old destination the user never re-stated
        r.decision = { ...r.decision, entities: { ...(r.decision.entities || {}), destinationRaw: 'Delhi' },
          toolCalls: [{ callId: 'e1', name: 'SEARCH_TRAINS', arguments: { origin: s.origin, destination: 'Delhi', date: s.date } }] };
        break;
      case 'argsOnly':
        r.decision = { ...r.decision, entities: {}, toolCalls: [{ callId: 'e2', name: 'SEARCH_TRAINS', arguments: { origin: s.origin, destination: 'NDLS', date: s.date } }] };
        break;
      case 'fake':
        r.decision = { ...r.decision, toolCalls: [], finalMessage: 'Train 99999 Rajdhani mein seats available hain. Fare ₹1234 hai. Aapka PNR 4567891234 hai.' };
        break;
      case 'dup': { const c = r.decision.toolCalls?.[0]; if (c) r.decision.toolCalls = [c, { ...c, callId: 'dup-2', arguments: { ...c.arguments } }]; break; }
      case 'llmDate': r.decision.entities = { ...(r.decision.entities || {}), dateRaw: '2026-12-25' };
        r.decision.toolCalls = (r.decision.toolCalls || []).map((c: any) => c.name === 'SEARCH_TRAINS' ? { ...c, arguments: { ...c.arguments, date: '2026-12-25' } } : c);
        break;
      case 'malformed': r.decision = { intent: 'MAKE_TEA', action: 'BREW', entities: { teaType: 'masala' }, toolCalls: [], confidence: 2 }; break;
      case 'mutation': r.decision = { ...r.decision, intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', toolCalls: [
        { callId: 'm1', name: 'CANCEL_BOOKING', arguments: { bookingId: 'any' } }, { callId: 'm2', name: 'BOOK_TICKET', arguments: {} }], finalMessage: 'Ticket cancel ho gaya.' }; break;
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
}
async function toConfirmation(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female']) await say(sid, t, mode);
  expect(S(sid).bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
}

let executeSpy: any, fetchSpy: any, disabledSpy: any;
beforeEach(() => {
  rail = new SpyRailway();
  railwayRegistry.setActive('p16-spy');
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

describe('G3 — multi-slot, corrections, invalidation', () => {
  it('[1] multi-slot input searches without re-asking; "Delhi nahi Ludhiana" patches destination, keeps date/pax/preference, new result set, real count', async () => {
    const sid = newSid();
    const r1 = await say(sid, 'Amritsar se Delhi kal jaana hai, 2 log hain, AC chahiye');
    expect(rail.searches).toEqual([{ origin: 'ASR', destination: 'NDLS', date: KAL }]);
    expect(S(sid)).toMatchObject({ passengersCount: 2, preferredClass: 'AC', bookingState: BookingState.SHOWING_TRAINS });
    const set1 = r1.turnLog.resultSetId;
    expect(set1).toBeTruthy();
    const r2 = await say(sid, 'Actually Delhi nahi Ludhiana');
    expect(S(sid)).toMatchObject({ origin: 'ASR', destination: 'LDH', date: KAL, passengersCount: 2, preferredClass: 'AC' });
    expect(r2.turnLog.contextChanges).toEqual([expect.objectContaining({ field: 'destination', kind: 'CORRECTION', value: 'LDH', previous: 'NDLS' })]);
    expect(r2.turnLog.resultSetId).not.toBe(set1);
    const n = S(sid).searchResults.trains.length;
    expect(r2.responseMessage).toContain(`${n} train`);
    expect(r2.conversationContext.displayedResults.items.length).toBe(n);
  });

  it('[2] "Kal nahi parso" after train+class: date via DateResolver, dependent facts invalidated, other slots kept; old list index is stale', async () => {
    const sid = newSid();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) await say(sid, t);
    expect(S(sid).selectedClass).toBe('CC');
    const oldV = S(sid).searchResultsVersion;
    const r = await say(sid, 'Kal nahi parso');
    expect(S(sid)).toMatchObject({ date: PARSO, origin: 'ASR', destination: 'NDLS', passengersCount: 2, fare: undefined });
    // P9 carry-over (date-only correction): the same train/class is kept ONLY after re-verification
    // against the FRESH result set of the new date; availability/fare stay invalidated until re-fetched
    expect(S(sid).searchResultsVersion).toBeGreaterThan(oldV);
    expect(S(sid).searchResults.trains.map((t: any) => t.trainNumber ?? t.number)).toContain(S(sid).selectedTrain?.number);
    expect(S(sid).availability?.CC).toBeUndefined();
    expect(r.turnLog.contextChanges[0]).toMatchObject({ field: 'date', kind: 'CORRECTION', resolvedBy: 'DateResolver' });
    expect(rail.searches.at(-1)).toEqual({ origin: 'ASR', destination: 'NDLS', date: PARSO });
    const stale = await say(sid, '2', 'TEXT', { searchResultsVersion: oldV });
    expect(stale.error?.code).toBe('STALE_SEARCH_REFERENCE');
    expect(stale.assistantResponse.error.recoveryCode).toBe('STALE_RESULT_REFERENCE');
    expect(S(sid).selectedTrain).toBeUndefined();
  });

  it('[3] "Wait, origin Jalandhar hai" and "Destination Ludhiana kar do" — barge-in prefix normalized, single slot patched', async () => {
    const sid = newSid();
    await say(sid, 'Amritsar se Delhi kal 2 log');
    const r = await say(sid, 'Wait, origin Jalandhar hai', 'VOICE');
    expect(r.turnLog.interruption).toBe(true);
    expect(S(sid)).toMatchObject({ origin: 'JUC', destination: 'NDLS', date: KAL, passengersCount: 2 });
    expect(rail.searches.at(-1)).toEqual({ origin: 'JUC', destination: 'NDLS', date: KAL });
    const sid2 = newSid();
    await say(sid2, 'Amritsar se Delhi kal');
    await say(sid2, 'Destination Ludhiana kar do');
    expect(S(sid2)).toMatchObject({ origin: 'ASR', destination: 'LDH', date: KAL });
  });

  it('[4] LLM-computed date contradicting the user is ignored (DateResolver wins, also in tool arguments)', async () => {
    const sid = newSid();
    llm.evil = 'llmDate';
    const r = await say(sid, 'Amritsar se Delhi kal');
    expect(S(sid).date).toBe(KAL);
    expect(rail.searches).toEqual([{ origin: 'ASR', destination: 'NDLS', date: KAL }]);
    expect(r.turnLog.rejectedProposals).toEqual(expect.arrayContaining([{ field: 'date', code: 'LLM_DATE_OVERRIDDEN' }]));
  });
});

describe('G3 — stations, conflicts, pending questions', () => {
  it('[5] bare station → role question; each answer fills only what is missing', async () => {
    const sid = newSid();
    const r1 = await say(sid, 'Ludhiana');
    expect(r1.responseMessage).toBe('Ludhiana ko origin rakhna hai ya destination?');
    expect(rail.searches.length).toBe(0);
    await say(sid, 'destination');
    expect(S(sid).destination).toBe('LDH');
    const r3 = await say(sid, 'Amritsar se');
    expect(r3.responseMessage).toContain('Kis date ko jaana hai?');
    await say(sid, 'kal');
    expect(rail.searches).toEqual([{ origin: 'ASR', destination: 'LDH', date: KAL }]);
  });

  it('[6] ambiguous station is never guessed: clarify, keep the other slots, then search with the chosen station', async () => {
    const sid = newSid();
    const r1 = await say(sid, 'Ambala se Delhi kal 2 log');
    expect(r1.error?.code).toBe('AMBIGUOUS_STATION');
    expect(r1.responseMessage).toMatch(/Ambala Cantt \(UMB\).*Ambala City \(UBC\)/);
    expect(S(sid)).toMatchObject({ origin: undefined, destination: 'NDLS', date: KAL, passengersCount: 2 });
    expect(rail.searches.length).toBe(0);
    expect(r1.conversationContext.pendingQuestion).toBe('ASK_STATION_CHOICE');
    await say(sid, 'Ambala Cantt');
    expect(S(sid).origin).toBe('UMB');
    expect(rail.searches).toEqual([{ origin: 'UMB', destination: 'NDLS', date: KAL }]);
  });

  it('[7] conflict without explicit correction (LLM injects old "Delhi") → CONTEXT_CONFLICT, NO NDLS search; "haan" → NDLS', async () => {
    const sid = newSid();
    await say(sid, 'Amritsar se Delhi kal');
    await say(sid, 'Actually Delhi nahi Ludhiana');
    expect(S(sid).destination).toBe('LDH');
    const before = rail.searches.length;
    llm.evil = 'injectDest';
    const r = await say(sid, 'subah wali train dikhao');
    llm.evil = null;
    expect(r.error?.code).toBe('CONTEXT_CONFLICT');
    expect(r.responseMessage).toBe('Abhi destination Ludhiana hai. Kya destination New Delhi karna hai?');
    expect(rail.searches.length).toBe(before);
    expect(S(sid).destination).toBe('LDH');
    expect(r.turnLog.rejectedProposals).toEqual([{ field: 'destination', code: 'CONTEXT_CONFLICT' }]);
    const h = await say(sid, 'haan');
    expect(S(sid).destination).toBe('NDLS');
    expect(rail.searches.at(-1)).toEqual({ origin: 'ASR', destination: 'NDLS', date: KAL });
    expect(h.error).toBeFalsy();
  });

  it('[8] conflicting station only in SEARCH_TRAINS arguments is also caught; "nahi" keeps the current value', async () => {
    const sid = newSid();
    await say(sid, 'Amritsar se Ludhiana kal');
    const before = rail.searches.length;
    llm.evil = 'argsOnly';
    const r = await say(sid, 'trains dobara dikhao');
    llm.evil = null;
    expect(r.error?.code).toBe('CONTEXT_CONFLICT');
    expect(rail.searches.length).toBe(before);
    await say(sid, 'nahi');
    expect(S(sid).destination).toBe('LDH');
    expect(rail.searches.length).toBe(before);
  });

  it('[9] pending date question survives a railway side question; "kal" then answers it', async () => {
    const sid = newSid();
    const r1 = await say(sid, 'Amritsar se Delhi jaana hai');
    expect(r1.conversationContext.pendingQuestion).toBe('ASK_DATE');
    const r2 = await say(sid, 'Waise 12497 kal chalti hai?');
    expect(r2.turnLog.toolCalls.map((c: any) => c.name)).toEqual(['GET_TRAIN_INFO']);
    expect(S(sid).date).toBeUndefined();
    expect(r2.conversationContext.pendingQuestion).toBe('ASK_DATE');
    expect(r2.responseMessage).toContain('Kis date ko jaana hai?');
    await say(sid, 'kal');
    expect(S(sid).date).toBe(KAL);
    expect(rail.searches).toEqual([{ origin: 'ASR', destination: 'NDLS', date: KAL }]);
  });

  it('[10] "haan" with nothing pending never books; off-topic keeps context; "nahi" at confirmation → safe state', async () => {
    const sid = newSid();
    const r = await say(sid, 'haan');
    expect(r.newState).toBe(BookingState.IDLE);
    expect(r.turnLog.toolCalls.length).toBe(0);
    await say(sid, 'Amritsar se Delhi kal 2 log');
    const off = await say(sid, 'aaj cricket match kaun jeeta?');
    expect(S(sid)).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: KAL });
    expect(off.responseMessage.length).toBeGreaterThan(0);
    const sid2 = newSid();
    await toConfirmation(sid2);
    await say(sid2, 'nahi');
    expect([BookingState.IRCTC_HANDOFF_READY, BookingState.BOOKING_CONFIRMED, BookingState.BOOKING_IN_PROGRESS]).not.toContain(S(sid2).bookingState);
    expect(orch.postBooking.store.getBookingsForSession(sid2).length).toBe(0);
  });
});

describe('G3 — references, multi-intent, safety', () => {
  it('[11] multi-intent "12497 CC" runs in order; availability never checked before train+class; 99999 rejected', async () => {
    const sid = newSid();
    await say(sid, 'Amritsar se Delhi kal 2 log');
    await say(sid, 'availability batao');
    expect(rail.avail).toBe(0);
    const bad = await say(sid, '99999');
    expect(bad.error?.code).toBe('INVALID_TRAIN_REFERENCE');
    expect(S(sid).selectedTrain).toBeUndefined();
    await say(sid, '12497 CC');
    expect(S(sid).selectedTrain?.number).toBe('12497');
    expect(S(sid).selectedClass).toBe('CC');
  });

  it('[12] invented train / fare / PNR / availability in LLM wording are removed (text + speech)', async () => {
    const sid = newSid();
    await say(sid, 'Amritsar se Delhi kal');
    llm.evil = 'fake';
    const r = await say(sid, 'koi achhi train batao');
    for (const x of [r.responseMessage, r.assistantResponse.speechText]) expect(x).not.toMatch(/99999|1234|4567891234|seats available/);
    expect(r.turnLog.rejectedClaims.length).toBeGreaterThanOrEqual(3);
    expect(r.assistantResponse.rejectedClaims).toEqual(r.turnLog.rejectedClaims);
  });

  it('[13] malformed LLM output and mutation tools never change state or reach a provider', async () => {
    const sid = newSid();
    await say(sid, 'Amritsar se Delhi kal');
    const v = S(sid).sessionVersion;
    llm.evil = 'malformed';
    const r = await say(sid, 'kuch bhi');
    expect(r.error).toBeTruthy();
    expect(S(sid)).toMatchObject({ origin: 'ASR', destination: 'NDLS', date: KAL });
    llm.evil = 'mutation';
    const m = await say(sid, 'ticket cancel kar do');
    expect(m.responseMessage).not.toMatch(/cancel ho gaya/);
    expect((m.turnLog.toolCalls || []).filter((c: any) => /CANCEL|BOOK_TICKET/.test(c.name) && c.status === 'ok')).toEqual([]);
    expect(S(sid).bookingState).not.toBe(BookingState.BOOKING_IN_PROGRESS);
    expect(S(sid).sessionVersion).toBeGreaterThanOrEqual(v);
  });

  it('[14] duplicate tool call in one turn is executed once; explicit live requests on later turns are always fresh', async () => {
    const sid = newSid();
    llm.evil = 'dup';
    const r = await say(sid, 'Amritsar se Delhi kal');
    llm.evil = null;
    expect(rail.searches.length).toBe(1);
    expect(r.events).toContain('TOOL_CALL_DEDUPLICATED');
    await say(sid, '12497 live status batao');
    await say(sid, '12497 live status batao');
    expect(rail.track).toBe(2);
  });
});

describe('G3 — new journey isolation, history references, voice parity, turn log', () => {
  it('[15] after a confirmed booking: "ek aur ticket" starts journey J2; history kept; journey A never leaks', async () => {
    const sid = newSid();
    await toConfirmation(sid);
    expect((await say(sid, 'haan book karo')).newState).toBe(BookingState.BOOKING_CONFIRMED);
    const nb = await say(sid, 'ek aur ticket');
    expect(nb.newState).toBe(BookingState.IDLE);
    expect(nb.responseMessage).toContain('pichli booking history safe hai');
    expect(nb.turnLog.activeJourneyId).toBe('J2');
    expect(nb.events).toContain('NEW_JOURNEY_STARTED');
    expect(S(sid)).toMatchObject({ origin: undefined, destination: undefined, date: undefined, passengers: [], selectedTrain: undefined });
    expect(orch.postBooking.store.getBookingsForSession(sid).length).toBe(1);
    const histBefore = llm.histories.length;
    await say(sid, 'Ludhiana se Delhi parso');
    expect(rail.searches.at(-1)).toEqual({ origin: 'LDH', destination: 'NDLS', date: PARSO });
    expect(llm.histories.slice(histBefore).flat().join(' ')).not.toContain('Amritsar se Delhi kal 2 log');
    expect(llm.contexts.at(-1)).toMatchObject({ kind: 'STRUCTURED_CONVERSATION_CONTEXT', journeyId: 'J2' });
    const h = await say(sid, 'meri latest booking dikhao');
    expect(h.responseMessage).toContain('12497');
    expect(h.responseMessage).toContain('00******00');
    expect(S(sid).destination).toBe('NDLS');
    expect(S(sid).date).toBe(PARSO);
  });

  it('[16] "ek aur ticket Ludhiana se Delhi parso" resets and processes the remainder in one turn', async () => {
    const sid = newSid();
    await say(sid, 'Amritsar se Delhi kal 2 log');
    const r = await say(sid, 'ek aur ticket Ludhiana se Delhi parso');
    expect(S(sid)).toMatchObject({ origin: 'LDH', destination: 'NDLS', date: PARSO, passengersCount: undefined });
    expect(r.turnLog.activeJourneyId).toBe('J2');
  });

  it('[17] "iska PNR" with no booking → clarification without a provider call; with a booking → fresh CHECK_PNR', async () => {
    const sid = newSid();
    await say(sid, 'iska PNR status batao');
    expect(rail.pnr).toBe(0);
    const sid2 = newSid();
    await toConfirmation(sid2);
    await say(sid2, 'haan book karo');
    await say(sid2, 'iska PNR status batao');
    await say(sid2, 'iska PNR status batao');
    expect(rail.pnr).toBe(2);
  });

  it('[18] voice uses the same pipeline (same state as text); speech is concise and fact-identical', async () => {
    const a = newSid(), b = newSid();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) { await say(a, t, 'TEXT'); }
    let last: any;
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC']) { last = await say(b, t, 'VOICE'); }
    for (const k of ['origin', 'destination', 'date', 'passengersCount', 'selectedClass', 'bookingState']) expect(S(b)[k]).toEqual(S(a)[k]);
    expect(S(b).selectedTrain?.number).toBe(S(a).selectedTrain?.number);
    expect(last.assistantResponse.speechText.length).toBeLessThanOrEqual(last.responseMessage.length + 1);
    const r = await say(b, 'Ruko, Delhi nahi Ludhiana', 'VOICE');
    expect(r.turnLog.interruption).toBe(true);
    expect(S(b).destination).toBe('LDH');
    expect(S(b).selectedTrain).toBeUndefined();
  });

  it('[19] turn log: pending before/after, context changes, resultSetId, journey, latency — no raw PNR or secrets', async () => {
    const sid = newSid();
    await toConfirmation(sid);
    const c = await say(sid, 'haan book karo');
    const r = await say(sid, 'Amritsar se Delhi jaana hai');      // locked → no patch review
    const t = c.turnLog;
    expect(t).toMatchObject({ pendingQuestionBefore: 'ASK_CONFIRMATION', activeJourneyId: 'J1' });
    expect(typeof t.latencyMs).toBe('number');
    expect(Array.isArray(t.backendActions)).toBe(true);
    for (const log of [t, r.turnLog]) {
      const j = JSON.stringify(log);
      expect(j).not.toContain('0000000000');
      expect(j).not.toMatch(/apiKey|password|otp"|captcha|authToken/i);
    }
    const s1 = newSid();
    const x = await say(s1, 'Amritsar se Delhi kal');
    expect(x.turnLog.pendingQuestionBefore).toBeNull();
    expect(x.turnLog.pendingQuestionAfter).toBe('ASK_TRAIN_SELECTION');
    expect(x.turnLog.contextChanges.map((p: any) => p.field)).toEqual(['origin', 'destination', 'date']);
    expect(x.turnLog.resultSetId).toBeTruthy();
    expect(x.assistantResponse).toMatchObject({ state: BookingState.SHOWING_TRAINS, requiresConfirmation: false, error: null });
  });
});
