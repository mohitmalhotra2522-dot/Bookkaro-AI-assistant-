/**
 * PROMPT 14 — GROUP 3 (end-to-end)
 * confirm → (test-only) booking provider → P13 lifecycle → BookingRecord → conversation:
 * "latest ticket", "PNR kya hai?", "PNR status check karo" (LLM → CHECK_PNR → fresh provider call),
 * "meri train abhi kaha hai?" (booking train → TRACK_TRAIN → fresh provider call).
 * MockBookingProvider is TEST-ONLY. The railway provider here is a test double (labelled mock / non-live).
 * afterEach: no fetch, IrctcHandoffAdapter.executeHandoff never called, DisabledBookingProvider never invoked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator, type OrchestratorOptions } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { BookingState } from '../../shared/states';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { findSensitiveFields } from '../../server/booking/handoff/sensitive-data-guard';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { BookingProviderRegistry } from '../../server/booking/provider/booking-provider-registry';
import type { BookingProviderConfig } from '../../server/booking/provider/booking-provider-config';
import { MockBookingProvider, MOCK_TEST_ONLY_PNR, type MockBookingProviderOptions } from '../../server/booking/testing/mock-booking-provider';
import { InMemoryBookingHistoryStore } from '../../server/booking/post-booking/booking-history-store';
import type { NormalizedBookingResult } from '../../shared/booking-record';

const FAKE_SUCCESS = /ticket (book ho gaya|booked)|booking (successful|confirmed|ho gayi)|PNR generated/i;
const P14_EVENTS = ['BOOKING_RECORD_CREATED', 'BOOKING_CONFIRMED', 'BOOKING_FAILED', 'BOOKING_STATUS_UPDATED', 'PNR_ATTACHED', 'PNR_STATUS_CHECKED', 'BOOKING_HISTORY_QUERIED', 'BOOKING_LIVE_STATUS_REQUESTED'];
const enabledCfg = (provider: string): BookingProviderConfig => ({ provider, enabled: true, timeoutMs: 2000, configErrors: [] });

// ---- railway provider test double: answers PNR / live status (labelled mock), counts every call ----
const liveMeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p14-live', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
class P14LiveProvider extends MockRailwayProvider {
  pnrCalls: string[] = []; trackCalls: string[] = [];
  async checkPNR(r: any): Promise<any> {
    this.pnrCalls.push(r.pnr);
    return { ok: true, data: { pnr: r.pnr, status: this.pnrCalls.length === 1 ? 'CNF' : 'CNF/C2', chartStatus: 'Chart not prepared', passengers: [{ number: 1, bookingStatus: 'WL 4', currentStatus: 'CNF' }] }, meta: liveMeta() };
  }
  async trackTrain(r: any): Promise<any> {
    this.trackCalls.push(r.trainNumber);
    return { ok: true, data: { trainNumber: r.trainNumber, currentStatus: 'Running', currentStationCode: 'UMB', currentStationName: 'Ambala Cantt', delayMinutes: 5 }, meta: liveMeta() };
  }
}
let live = new P14LiveProvider();
railwayRegistry.register('p14-live', () => live);

class SpyLLM extends MockLLMProvider {
  toolNames: string[][] = []; proposed: string[] = []; evil = false;
  async generateStructuredDecision(input: any): Promise<any> {
    this.toolNames.push((input.tools || []).map((t: any) => t.name));
    const r: any = await super.generateStructuredDecision(input);
    if (this.evil && !(input.currentTurnToolResults || []).length) {
      r.decision = { ...r.decision, finalMessage: 'Aapka PNR 9876543210 hai, booking confirmed, seat B2-34.', toolCalls: [
        { callId: 'e1', name: 'CHECK_PNR', arguments: { pnr: '9876543210' } },
        { callId: 'e2', name: 'EXECUTE_BOOKING', arguments: {} },
        { callId: 'e3', name: 'UPDATE_BOOKING_HISTORY', arguments: { pnr: '9876543210', status: 'CONFIRMED' } },
        { callId: 'e4', name: 'TRACK_TRAIN', arguments: { trainNumber: '22439' } }] };
    }
    for (const c of r.decision?.toolCalls || []) this.proposed.push(c.name);
    return r;
  }
}

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const S = (sid: string): any => state.getSession(sid);
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT'): Promise<any> => orch.processTurn(sid, text, mode);
const newSid = () => state.createSession().sessionId;
const evts = (sid: string, type?: string) => (S(sid).eventLog || []).filter((e: any) => (type ? e.type === type : P14_EVENTS.includes(e.type)));
function mk(opts: OrchestratorOptions = {}, llm: MockLLMProvider = new MockLLMProvider()) {
  state = new ConversationStateManager();
  orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService(), { bookingReconciliation: { config: { attemptTimeoutMs: 100 }, sleep: async () => {} }, ...opts });
}
function withMock(o: MockBookingProviderOptions, llm?: MockLLMProvider, extra: OrchestratorOptions = {}) {
  const p = new MockBookingProvider(o);
  const r = new BookingProviderRegistry({ allowTestProviders: true }); r.register(p);
  mk({ bookingProviderRegistry: r, bookingProviderConfig: enabledCfg(p.name), ...extra }, llm);
  return p;
}
async function confirm(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female']) await say(sid, t, mode);
  expect(S(sid).bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
  return say(sid, 'haan book karo', mode);
}

let executeSpy: any, fetchSpy: any, disabledSpy: any;
beforeEach(() => {
  live = new P14LiveProvider();
  railwayRegistry.setActive('p14-live');
  mk();
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

describe('G3 — confirmed booking → BookingRecord → history / PNR answers', () => {
  it('[1] provider CONFIRMED → exactly one BookingRecord (PNR from provider), events masked; latest booking → resolved → authoritative PNR', async () => {
    const p = withMock({ execute: 'CONFIRMED' });
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_CONFIRMED);
    const recs = orch.postBooking.store.getBookingsForSession(sid);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ bookingStatus: 'CONFIRMED', pnr: MOCK_TEST_ONLY_PNR, travelClass: 'CC', passengersSummary: { count: 2 }, statusSource: 'PROVIDER_EXECUTION' });
    expect(recs[0].train.trainNumber).toBe('12497');
    expect(findSensitiveFields(recs[0])).toEqual([]);
    expect(JSON.stringify(recs[0])).not.toMatch(/Rahul|Neha/);                       // counts only, no passenger names
    expect(S(sid).activeBookingId).toBe(recs[0].bookingId);
    expect(evts(sid).map((e: any) => e.type)).toEqual(expect.arrayContaining(['BOOKING_RECORD_CREATED', 'BOOKING_CONFIRMED', 'PNR_ATTACHED']));
    expect(JSON.stringify(evts(sid))).not.toContain(MOCK_TEST_ONLY_PNR);

    const r2 = await say(sid, 'latest ticket dikhao');
    expect(r2.cards.find((c: any) => c.type === 'booking_details')?.data).toMatchObject({ bookingId: recs[0].bookingId, status: 'CONFIRMED', pnr: '00******00', source: 'BACKEND_BOOKING_RECORD' });
    expect(r2.responseMessage).toContain('12497');
    expect(r2.responseMessage).not.toContain(MOCK_TEST_ONLY_PNR);                     // details view: masked
    const r3 = await say(sid, 'latest booking ka PNR kya hai?');
    expect(r3.responseMessage).toContain(`PNR: ${MOCK_TEST_ONLY_PNR}`);               // operation needs the full PNR
    expect(r3.newState).toBe(BookingState.BOOKING_CONFIRMED);
    const r4 = await say(sid, 'Ticket book ho gayi?');
    expect(r4.responseMessage).toMatch(/booking provider ne yeh booking confirm ki hai/);
    expect(evts(sid, 'BOOKING_HISTORY_QUERIED').length).toBeGreaterThanOrEqual(3);
    expect(p.executeCalls).toBe(1);
    expect(live.pnrCalls).toEqual([]);                                                // stored answers need no provider call
    // logs / history masked
    expect(JSON.stringify(orch.getTurnHistory(sid).slice(-3))).not.toContain(MOCK_TEST_ONLY_PNR);
    // API DTO: masked list, full PNR only via the owner's detail call; another session → denied
    expect(orch.postBooking.listDetails(sid)[0].pnr).toBe('00******00');
    expect(orch.postBooking.getBookingDetails(newSid(), recs[0].bookingId)).toMatchObject({ ok: false, code: 'BOOKING_ACCESS_DENIED' });
  });

  it('[2] "PNR status check karo" → LLM invokes CHECK_PNR → backend resolves the PNR → FRESH provider call every time (labelled mock)', async () => {
    const llm = new SpyLLM();
    withMock({ execute: 'CONFIRMED' }, llm);
    const sid = newSid();
    await confirm(sid);
    const r = await say(sid, 'PNR status check karo');
    expect(llm.proposed).toContain('CHECK_PNR');
    expect(llm.toolNames.at(-1)).toEqual(expect.arrayContaining(['CHECK_PNR', 'TRACK_TRAIN']));
    expect(live.pnrCalls).toEqual([MOCK_TEST_ONLY_PNR]);
    expect(r.responseMessage).toContain('PNR 00******00 ka current status (mock / non-live development data): CNF');
    expect(r.cards.find((c: any) => c.type === 'pnr_status')?.data).toMatchObject({ pnrMasked: '00******00', pnrStatus: 'CNF', dataSource: 'MOCK', fresh: true });
    expect(r.cards.find((c: any) => c.type === 'pnr_status')?.data.pnr).toBeUndefined();
    const r2 = await say(sid, 'PNR status dobara check karo');
    expect(live.pnrCalls).toHaveLength(2);                                            // no stale cache served as current
    expect(r2.responseMessage).toContain('CNF/C2');
    const checked = evts(sid, 'PNR_STATUS_CHECKED');
    expect(checked).toHaveLength(2);
    expect(JSON.stringify(checked)).not.toContain(MOCK_TEST_ONLY_PNR);
    expect(checked[0].data).toMatchObject({ pnrMasked: '00******00', ok: true });
    // booking status stays separate from PNR status
    expect(orch.postBooking.store.getBookingsForSession(sid)[0].bookingStatus).toBe('CONFIRMED');
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_CONFIRMED);
  });

  it('[3] "Meri train abhi kaha hai?" → train number from the booking record → TRACK_TRAIN → fresh live data', async () => {
    const llm = new SpyLLM();
    withMock({ execute: 'CONFIRMED' }, llm);
    const sid = newSid();
    await confirm(sid);
    const r = await say(sid, 'Meri train abhi kaha hai?');
    expect(llm.proposed).toContain('TRACK_TRAIN');
    expect(live.trackCalls).toEqual(['12497']);
    expect(r.responseMessage).toContain('12497');
    expect(r.responseMessage).toContain('mock / non-live development data');
    expect(r.responseMessage).toContain('Ambala Cantt');
    expect(r.cards.find((c: any) => c.type === 'live_status')?.data).toMatchObject({ trainNumber: '12497', currentStatus: 'Running', fresh: true });
    await say(sid, 'meri train abhi kaha hai');
    expect(live.trackCalls).toEqual(['12497', '12497']);
    expect(evts(sid, 'BOOKING_LIVE_STATUS_REQUESTED')).toHaveLength(2);
    expect(S(sid).selectedTrain?.number || S(sid).selectedTrain?.trainNumber).toBe('12497');   // nothing re-selected / changed
    // no booking + no context → asks for the train number (never guesses)
    const fresh = newSid();
    const r3 = await say(fresh, 'meri train abhi kaha hai?');
    expect(r3.responseMessage).toMatch(/Train number batayein/);
    expect(live.trackCalls).toHaveLength(2);
  });
});

describe('G3 — UNKNOWN / FAILED / duplicates / ambiguity / access', () => {
  it('[4] UNKNOWN never becomes confirmed without provider evidence; no PNR; reconciliation CONFIRMED then updates the record + attaches PNR', async () => {
    const p = withMock({ execute: 'NETWORK_ERROR', status: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'CONFIRMED'], supportsIdempotency: true });
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_STATUS_UNKNOWN);
    let rec = orch.postBooking.store.getBookingsForSession(sid)[0];
    expect(rec).toMatchObject({ bookingStatus: 'UNKNOWN', pnr: null });
    const a = await say(sid, 'PNR kya hai?');
    expect(a.responseMessage).toMatch(/confirmed nahi, isliye PNR available nahi hai/);
    expect(a.responseMessage).not.toMatch(/\d{10}/);
    const b = await say(sid, 'PNR status check karo');
    expect(b.responseMessage).toMatch(/PNR available nahi hai/);
    expect(live.pnrCalls).toEqual([]);
    for (const x of [r, a, b]) expect(x.responseMessage).not.toMatch(FAKE_SUCCESS);
    expect(p.executeCalls).toBe(1);                                                   // no auto-retry
    rec = orch.postBooking.store.getBookingsForSession(sid)[0];
    expect(rec.bookingStatus).toBe('UNKNOWN');
    // authoritative reconciliation (status lookup only)
    const c = await say(sid, 'booking ka status kya hai');
    expect(c.newState).toBe(BookingState.BOOKING_CONFIRMED);
    const recs = orch.postBooking.store.getBookingsForSession(sid);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ bookingId: rec.bookingId, bookingStatus: 'CONFIRMED', pnr: MOCK_TEST_ONLY_PNR, statusSource: 'PROVIDER_RECONCILIATION' });
    expect(evts(sid).map((e: any) => e.type)).toEqual(expect.arrayContaining(['BOOKING_STATUS_UPDATED', 'BOOKING_CONFIRMED', 'PNR_ATTACHED']));
    expect([p.executeCalls, p.statusCalls]).toEqual([1, 4]);
    const d = await say(sid, 'PNR kya hai?');
    expect(d.responseMessage).toContain(`PNR: ${MOCK_TEST_ONLY_PNR}`);
  });

  it('[5] UNKNOWN → FAILED is stored; history preserved; FAILED never shows a PNR', async () => {
    withMock({ execute: 'NETWORK_ERROR', status: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'FAILED'], supportsIdempotency: true });
    const sid = newSid();
    await confirm(sid);
    await say(sid, 'booking ka status kya hai');
    const recs = orch.postBooking.store.getBookingsForSession(sid);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ bookingStatus: 'FAILED', pnr: null });
    expect(evts(sid, 'BOOKING_FAILED')).toHaveLength(1);
    const r = await say(sid, 'Ticket book ho gayi?');
    expect(r.responseMessage).toMatch(/^Nahi/);
    expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
  });

  it('[6] duplicate confirmation → no duplicate record (lifecycle re-sync + "haan book karo" again)', async () => {
    const p = withMock({ execute: 'CONFIRMED' });
    const sid = newSid();
    await confirm(sid);
    await say(sid, 'haan book karo');
    await say(sid, 'phir se book karo', 'VOICE');
    const s = S(sid);
    expect(s.bookingExecution?.status).toBe('CONFIRMED');
    orch.postBooking.syncFromExecution(s, s.bookingExecution, 'CONFIRMED');           // re-delivered confirmation
    expect(orch.postBooking.store.getBookingsForSession(sid)).toHaveLength(1);
    expect(evts(sid, 'BOOKING_RECORD_CREATED')).toHaveLength(1);
    expect(p.executeCalls).toBe(1);
    expect(s.bookingRecordIds).toHaveLength(1);
  });

  it('[7] ambiguity → clarification (never a guess); follow-up resolves; other session\'s PNR → BOOKING_ACCESS_DENIED; malformed → INVALID_PNR (no provider call)', async () => {
    const store = new InMemoryBookingHistoryStore();
    mk({ bookingHistoryStore: store });
    const sid = newSid(), other = newSid();
    const seed = (train: string, pnr: string, i: number): NormalizedBookingResult => ({
      executionId: `exec_seed_${i}`, sessionId: sid, handoffId: `ho_seed_${i}`, idempotencyKey: `idem_seed_${i}`, providerName: 'test-mock-booking',
      bookingStatus: 'CONFIRMED', statusSource: 'PROVIDER_EXECUTION', providerReference: `TEST-REF-${i}`, pnr, failureCode: null,
      journey: { origin: 'ASR', destination: 'NDLS', originName: 'Amritsar Junction', destinationName: 'New Delhi' }, train: { trainNumber: train },
      passengersSummary: { count: 1 }, travelClass: 'CC', fareSummary: null, journeyDate: '2026-10-05', providerStatus: 'CONFIRMED', at: new Date().toISOString()
    });
    expect(store.createBooking(seed('12014', '1111111111', 1)).ok).toBe(true);
    expect(store.createBooking(seed('14542', '2222222222', 2)).ok).toBe(true);
    const r = await say(sid, 'Delhi wali booking ka PNR status check karo');
    expect(r.error?.code).toBe('MULTIPLE_BOOKINGS_MATCHED');
    expect(r.responseMessage).toContain('Do Delhi bookings mil rahi hain. Aap 14542 wali dekhna chahte ho ya 12014 wali?');
    expect(live.pnrCalls).toEqual([]);
    const r2 = await say(sid, '12014 wali');
    expect(live.pnrCalls).toEqual(['1111111111']);
    expect(r2.responseMessage).toContain('11******11');
    expect(S(sid).selectedTrain).toBeFalsy();                                         // "12014" was a booking reference, not a train selection
    const r3 = await say(other, 'PNR 1111111111 ka status check karo');
    expect(r3.responseMessage).toMatch(/is session ki kisi booking ka nahi/);
    const r4 = await say(sid, 'PNR 12345 check karo');
    // malformed PNR: the LLM's CHECK_PNR is rejected by the deterministic validator → INVALID_PNR, provider never called
    expect(r4.turnLog.toolResults).toEqual([expect.objectContaining({ toolName: 'CHECK_PNR', resultStatus: 'rejected', errorCode: 'INVALID_PNR' })]);
    expect(r4.responseMessage).toContain('PNR number 10 digits ka hona chahiye');
    expect(live.pnrCalls).toEqual(['1111111111']);
    const r5 = await say(sid, '12014 wali booking ka PNR check karo');
    expect(live.pnrCalls).toEqual(['1111111111', '1111111111']);
    expect(r5.responseMessage).toContain('11******11');
  });
});

describe('G3 — safety: LLM cannot invent / mutate / execute; voice = text; RailBook untouched', () => {
  it('[8] evil LLM: invented PNR, EXECUTE_BOOKING, history mutation, invented train → all rejected; deterministic answers only', async () => {
    const llm = new SpyLLM();
    const p = withMock({ execute: 'CONFIRMED' }, llm);
    const sid = newSid();
    await confirm(sid);
    const before = JSON.stringify(orch.postBooking.store.getBookingsForSession(sid));
    llm.evil = true;
    const rs = [await say(sid, 'PNR kya hai?'), await say(sid, 'PNR status check karo'), await say(sid, 'meri train abhi kaha hai'), await say(sid, 'Ticket book ho gayi?')];
    llm.evil = false;
    for (const r of rs) {
      expect(r.responseMessage).not.toContain('9876543210');
      expect(r.responseMessage).not.toMatch(/B2-34|booking confirmed/i);
    }
    expect(rs[0].responseMessage).toContain(`PNR: ${MOCK_TEST_ONLY_PNR}`);
    expect(live.pnrCalls).toEqual([]);                                                // invented PNR never reached the provider
    expect(live.trackCalls).toEqual([]);                                              // invented train never tracked
    expect(JSON.stringify(orch.postBooking.store.getBookingsForSession(sid))).toBe(before);
    expect(p.executeCalls).toBe(1);
    expect(REGISTERED_TOOLS.some((t: any) => /BOOK|EXECUTE|PAY|CANCEL|HISTORY|UPDATE/i.test(t.name))).toBe(false);
    const ctx = JSON.stringify((orch as any).postBooking.contextFor(sid));
    expect(ctx).toContain('AUTHORITATIVE_BACKEND_CONTEXT');
    expect(ctx).not.toContain(MOCK_TEST_ONLY_PNR);
  });

  it('[9] voice = text: same pipeline, same record / state / cards; voice phrasing shorter', async () => {
    // separate orchestrators: the TEST-ONLY mock returns one constant providerReference, and a reference reused
    // across sessions is (correctly) a BOOKING_RECORD_CONFLICT — never a second record.
    const run = async (mode: 'TEXT' | 'VOICE') => {
      withMock({ execute: 'CONFIRMED' });
      const sid = newSid();
      await confirm(sid, mode);
      const a = await say(sid, 'PNR kya hai?', mode);
      const b = await say(sid, 'PNR status check karo', mode);
      return { a, b, recs: orch.postBooking.store.getBookingsForSession(sid) };
    };
    const t = await run('TEXT');
    const v = await run('VOICE');
    for (const x of [t, v]) { expect(x.a.responseMessage).toContain(`PNR: ${MOCK_TEST_ONLY_PNR}`); expect(x.a.newState).toBe(BookingState.BOOKING_CONFIRMED); expect(x.recs).toHaveLength(1); }
    expect(t.a.cards.map((c: any) => c.type)).toEqual(v.a.cards.map((c: any) => c.type));
    expect(v.a.responseMessage.length).toBeLessThan(t.a.responseMessage.length);
    expect(t.b.cards.map((c: any) => c.type)).toEqual(v.b.cards.map((c: any) => c.type));
    expect(t.b.turnLog.toolResults.map((r: any) => r.toolName)).toEqual(v.b.turnLog.toolResults.map((r: any) => r.toolName));
  });

  it('[10] production default: disabled provider → no BookingRecord, "PNR kya hai?" honest; dev mock railway never fakes PNR / live status', async () => {
    railwayRegistry.setActive('mock');
    mk();
    const sid = newSid();
    for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female', 'haan book karo']) await say(sid, t);
    expect(orch.postBooking.store.getBookingsForSession(sid)).toHaveLength(0);
    const r = await say(sid, 'PNR kya hai?');
    expect(r.responseMessage).toMatch(/koi booking record nahi hai/);
    expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
    const r2 = await say(newSid(), 'PNR 1234567890 ka status check karo');
    expect(r2.responseMessage).toMatch(/PNR status check abhi available nahi hai/);
    const r3 = await say(newSid(), '12014 track karo');
    expect(r3.responseMessage).toMatch(/Live train status abhi available nahi hai/);
  });

  it('[11] RailBook / IRCTC untouched: post-booking code has no IRCTC URL, no REAL_IRCTC_ENABLED read, no network; no credentials; mock never wired in server', () => {
    const dir = join(__dirname, '../../server/booking/post-booking');
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f);
      if (!statSync(fp).isFile()) continue;
      const src = readFileSync(fp, 'utf8');
      expect(src).not.toMatch(/irctc\.co\.in|railbook|onrender\.com/i);
      expect(src).not.toMatch(/env\.REAL_IRCTC_ENABLED|env\[['"]REAL_IRCTC_ENABLED/);
      expect(src).not.toMatch(/\bfetch\(|axios|https?:\/\//);
      expect(src).not.toMatch(/Math\.random/);                                         // no generated PNRs / bookings
    }
    const rec = readFileSync(join(__dirname, '../../shared/booking-record.ts'), 'utf8');
    expect(rec).not.toMatch(/^\s+\w*(password|otp|captcha|cvv|cookie|token|credential)\w*\??:/im);   // no such field in any type
    const main = readFileSync(join(__dirname, '../../server/main.ts'), 'utf8');
    expect(main).not.toMatch(/mock-booking-provider|MockBookingProvider/);
  });
});
