/**
 * PROMPT 15 — GROUP 3 (end-to-end): cancellation / modification / refund lifecycle actions through the
 * real conversation pipeline (LLM → applier → BookingLifecycleActionService → provider → record).
 * MockBookingProvider is TEST-ONLY; the railway provider is a labelled mock (non-live) test double.
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
import type { NormalizedBookingResult } from '../../shared/booking-record';
/** P42.1: the backend states that the explicit confirmation is REQUIRED (it verifies it itself); no backend question. */
const CONFIRM_REQUIRED = /(bolne|karne) par hi request provider ko jayegi/;

const enabledCfg = (provider: string): BookingProviderConfig => ({ provider, enabled: true, timeoutMs: 2000, configErrors: [] });
const ACTION_EVENTS = ['BOOKING_ACTION_REQUESTED', 'BOOKING_ACTION_CONFIRMATION_REQUIRED', 'BOOKING_ACTION_CONFIRMED_BY_USER', 'BOOKING_ACTION_SUBMITTED', 'BOOKING_ACTION_RESULT', 'BOOKING_CANCELLATION_CONFIRMED'];

const liveMeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p15-live', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
class P15LiveProvider extends MockRailwayProvider {
  pnrCalls: string[] = []; trackCalls: string[] = [];
  async checkPNR(r: any): Promise<any> { this.pnrCalls.push(r.pnr); return { ok: true, data: { pnr: r.pnr, status: 'CNF', chartStatus: 'Chart not prepared', passengers: [{ number: 1, bookingStatus: 'CNF', currentStatus: 'CNF' }] }, meta: liveMeta() }; }
  async trackTrain(r: any): Promise<any> { this.trackCalls.push(r.trainNumber); return { ok: true, data: { trainNumber: r.trainNumber, currentStatus: 'Running', currentStationCode: 'UMB', currentStationName: 'Ambala Cantt', delayMinutes: 5 }, meta: liveMeta() }; }
}
let live = new P15LiveProvider();
railwayRegistry.register('p15-live', () => live);

class SpyLLM extends MockLLMProvider {
  toolNames: string[][] = []; proposed: string[] = []; evil: false | 'tools' | 'claim' = false;
  async generateStructuredDecision(input: any): Promise<any> {
    this.toolNames.push((input.tools || []).map((t: any) => t.name));
    const r: any = await super.generateStructuredDecision(input);
    if (this.evil === 'tools' && !(input.currentTurnToolResults || []).length) {
      r.decision = { ...r.decision, intent: 'CANCEL_BOOKING', action: 'NO_ACTION', lifecycleAction: 'REQUEST_CANCELLATION', finalMessage: 'Aapki booking cancel ho gayi hai aur refund mil gaya.', toolCalls: [
        { callId: 'x1', name: 'CANCEL_BOOKING', arguments: { bookingId: 'any' } },
        { callId: 'x2', name: 'MODIFY_BOOKING', arguments: { travelClass: '1A' } },
        { callId: 'x3', name: 'REFUND', arguments: {} }] };
    }
    if (this.evil === 'claim' && !(input.currentTurnToolResults || []).length) {
      r.decision = { ...r.decision, intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', lifecycleAction: 'DELETE_ALL_BOOKINGS', toolCalls: [], finalMessage: 'Booking cancel ho gayi hai. Date change ho gayi, ₹500 extra lagega.' };
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
const rec = (sid: string) => orch.postBooking.store.getBookingsForSession(sid)[0];
function withMock(o: Partial<MockBookingProviderOptions>, llm: MockLLMProvider = new MockLLMProvider(), extra: OrchestratorOptions = {}) {
  const p = new MockBookingProvider({ execute: 'CONFIRMED', ...o });
  const r = new BookingProviderRegistry({ allowTestProviders: true }); r.register(p);
  state = new ConversationStateManager();
  orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService(), {
    bookingReconciliation: { config: { attemptTimeoutMs: 100 }, sleep: async () => {} },
    bookingProviderRegistry: r, bookingProviderConfig: enabledCfg(p.name),
    lifecycleActions: { timeoutMs: 60, sleep: async () => {}, reconcile: { attempts: 1, delayMs: 0 } }, ...extra
  });
  return p;
}
async function confirm(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female']) await say(sid, t, mode);
  expect(S(sid).bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
  const r = await say(sid, 'haan book karo', mode);
  expect(r.newState).toBe(BookingState.BOOKING_CONFIRMED);
  return r;
}
function seedSecond(sid: string, providerName: string) {
  const r0 = rec(sid);
  const n: NormalizedBookingResult = {
    executionId: 'exe_seed_2', sessionId: sid, handoffId: 'ho_seed_2', idempotencyKey: 'idem_seed_2', providerName, bookingStatus: 'CONFIRMED', statusSource: 'PROVIDER_EXECUTION',
    providerReference: 'TEST-ONLY-REF-0002', pnr: null, failureCode: null, journey: { origin: 'NDLS', destination: 'ASR', originName: 'New Delhi', destinationName: 'Amritsar' },
    train: { trainNumber: '12014', trainName: 'Shatabdi Express' }, passengersSummary: { count: 1 }, travelClass: 'CC', fareSummary: { total: 510, currency: 'INR', passengersCount: 1 },
    journeyDate: r0.journeyDate, providerStatus: 'CONFIRMED', at: new Date().toISOString()
  };
  const c = orch.postBooking.store.createBooking(n);
  if (!c.ok) throw new Error(c.code);
  return c.record;
}

let executeSpy: any, fetchSpy: any, disabledSpy: any;
beforeEach(() => {
  live = new P15LiveProvider();
  railwayRegistry.setActive('p15-live');
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

describe('G3 — cancellation flow end-to-end', () => {
  it('[1–8] identify → request → resolve → confirmation → user confirms → provider executes → normalized → history updated', async () => {
    const p = withMock({ cancel: 'CONFIRMED' });
    const sid = newSid();
    await confirm(sid);
    const original = rec(sid);
    const second = seedSecond(sid, p.name);
    // [1][3] user identifies a booking; two Delhi bookings → backend asks, never guesses
    const amb = await say(sid, 'Delhi wali booking cancel kar do');
    expect(amb.error?.code).toBe('MULTIPLE_BOOKINGS_MATCHED');
    expect(amb.responseMessage).toMatch(/12497/);
    expect(amb.responseMessage).toMatch(/12014/);
    // [2][4] cancellation requested for the resolved booking → confirmation question, NO provider call
    const ask = await say(sid, '12497 wali');
    expect(ask.responseMessage).toContain('Main 12497 ki booking cancel karne ki request prepare kar raha hoon');
    expect(ask.responseMessage).toMatch(CONFIRM_REQUIRED); expect(ask.responseMessage).not.toMatch(/\?/);   // P42.1: confirmation-required fact; the LLM words the question
    expect(ask.cards.find((c: any) => c.type === 'booking_action')?.data).toMatchObject({ actionType: 'REQUEST_CANCELLATION', status: 'AWAITING_ACTION_CONFIRMATION', bookingId: original.bookingId });
    expect(p.cancelCalls).toBe(0);
    expect(rec(sid).bookingStatus).toBe('CONFIRMED');
    // [5][6] explicit confirmation → exactly one provider call
    const done = await say(sid, 'haan');
    expect(p.cancelCalls).toBe(1);
    expect(p.cancelRequests[0]).toMatchObject({ bookingId: original.bookingId, providerReference: original.providerReference });
    // [7] normalized result
    expect(done.responseMessage).toContain('Booking provider ne cancellation confirm kar di hai.');
    expect(done.responseMessage).toMatch(/Refund ka status alag hai/);
    expect(done.cards.find((c: any) => c.type === 'booking_action')?.data).toMatchObject({ status: 'ACTION_CONFIRMED', resultStatus: 'CANCELLED' });
    // [8] history updated + preserved; the other booking untouched; session state machine not bypassed
    const after = orch.postBooking.store.getBookingById(sid, original.bookingId);
    expect(after.ok && after.record).toMatchObject({ bookingStatus: 'CANCELLED', cancellationStatus: 'CANCELLED', statusSource: 'PROVIDER_ACTION', refundStatus: 'NOT_AVAILABLE', pnr: original.pnr, providerReference: original.providerReference, bookingCreatedAt: original.bookingCreatedAt, journeyDate: original.journeyDate });
    const other = orch.postBooking.store.getBookingById(sid, second.bookingId);
    expect(other.ok && other.record.bookingStatus).toBe('CONFIRMED');
    expect(done.newState).toBe(BookingState.BOOKING_CONFIRMED);
    const types = (S(sid).eventLog || []).map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(ACTION_EVENTS));
    expect(orch.lifecycleActions.listActions(sid)[0]).toMatchObject({ actionType: 'REQUEST_CANCELLATION', status: 'ACTION_CONFIRMED' });
    const st = await say(sid, '12497 wali booking ka status batao');
    expect(st.responseMessage).toMatch(/cancelled/i);
    expect(p.executeCalls).toBe(1);
  });

  it('[9] unsupported cancellation → exact message, no provider method, no action', async () => {
    const p = withMock({});
    const sid = newSid();
    await confirm(sid);
    const r = await say(sid, 'ticket cancel kar do');
    expect(r.error?.code).toBe('ACTION_NOT_SUPPORTED');
    expect(r.responseMessage).toContain('Is booking ke liye cancellation provider ke through available nahi hai.');
    expect((p as any).cancelBooking).toBeUndefined();
    expect(rec(sid).bookingStatus).toBe('CONFIRMED');
    expect(orch.lifecycleActions.listActions(sid)).toEqual([]);
  });

  it('[10] provider timeout → never CANCELLED; manual verification; duplicate not sent', async () => {
    const p = withMock({ cancel: 'TIMEOUT' });
    const sid = newSid();
    await confirm(sid);
    await say(sid, 'booking cancel kar do');
    const r = await say(sid, 'haan');
    expect(r.responseMessage).toContain('Cancellation request ka final status abhi verify nahi hua hai. Duplicate cancellation avoid karne ke liye main dobara request nahi bhej raha.');
    expect(r.error?.code).toBe('MANUAL_VERIFICATION_REQUIRED');
    expect(rec(sid)).toMatchObject({ bookingStatus: 'CONFIRMED', cancellationStatus: 'MANUAL_VERIFICATION_REQUIRED' });
    expect(r.responseMessage).not.toMatch(/cancellation confirm kar di/);
    expect(p.cancelCalls).toBe(1);
  });

  it('[11][12] UNKNOWN → status check only; "phir se cancel karo" blocked (UNSAFE_RETRY); repeated "haan" never resends; "ruk jao" is not a cancellation', async () => {
    const p = withMock({ cancel: 'UNKNOWN', cancelStatus: ['UNKNOWN'] });
    const sid = newSid();
    await confirm(sid);
    await say(sid, 'booking cancel kar do');
    const r = await say(sid, 'haan');
    expect(r.error?.code).toBe('CANCELLATION_UNKNOWN');
    expect(rec(sid)).toMatchObject({ bookingStatus: 'CONFIRMED', cancellationStatus: 'UNKNOWN' });
    const q = await say(sid, 'cancellation ka status kya hai?');
    expect(q.responseMessage).toMatch(/verify nahi hua hai/);
    const retry = await say(sid, 'phir se cancel karo');
    expect(retry.error?.code).toBe('UNSAFE_RETRY');
    expect(retry.responseMessage).toMatch(/result abhi establish nahi hua hai/);
    const dup = await say(sid, 'haan');
    expect(dup.responseMessage).not.toMatch(/cancellation confirm kar di/);
    const stop = await say(sid, 'ruk jao', 'VOICE');
    expect(stop.responseMessage).not.toMatch(/cancel karne ki request prepare/);
    expect(p.cancelCalls).toBe(1);                                         // exactly one destructive call, ever
    expect(p.cancelStatusCalls).toBeGreaterThanOrEqual(2);
    expect(orch.lifecycleActions.listActions(sid).filter(a => a.actionType === 'REQUEST_CANCELLATION')).toHaveLength(1);
  });
});

describe('G3 — modification', () => {
  it('[13] class change: provider fare → confirmation → provider MODIFIED → current view; original preserved; date change too', async () => {
    const p = withMock({ modify: 'MODIFIED', modifyEligibility: 'ELIGIBLE', fareDifference: 500 });
    const sid = newSid();
    await confirm(sid);
    const before = rec(sid);
    const a = await say(sid, 'CC se 2A kar do');
    expect(a.responseMessage).toMatch(/class 2A karne ki request prepare/);
    expect(a.responseMessage).toContain('₹500 extra');
    expect(p.modifyCalls).toBe(0);
    const b = await say(sid, 'haan');
    expect(b.responseMessage).toMatch(/class change confirm kar diya hai — nayi class: 2A/);
    expect(rec(sid)).toMatchObject({ travelClass: 'CC', modificationStatus: 'MODIFIED', current: { travelClass: '2A', journeyDate: before.journeyDate } });
    const c = await say(sid, 'journey date parso kar do');
    expect(c.responseMessage).toMatch(/journey date .* karne ki request prepare/);
    await say(sid, 'haan');
    expect(p.modifyCalls).toBe(2);
    expect(rec(sid).journeyDate).toBe(before.journeyDate);                // historical record never rewritten
    expect(rec(sid).current!.journeyDate).not.toBe(before.journeyDate);
  });

  it('[14] unsupported modification → exact messages, nothing sent', async () => {
    const p = withMock({});
    const sid = newSid();
    await confirm(sid);
    expect((await say(sid, 'booking change karni hai')).responseMessage).toContain('Is booking ke liye modification provider ke through available nahi hai.');
    expect((await say(sid, 'journey date parso kar do')).responseMessage).toContain('Is booking ke liye date modification available nahi hai.');
    expect((await say(sid, 'CC se 2A kar do')).error?.code).toBe('ACTION_NOT_SUPPORTED');
    expect(rec(sid)).toMatchObject({ travelClass: 'CC', current: null, modificationStatus: 'NOT_REQUESTED' });
    expect((p as any).modifyBooking).toBeUndefined();
  });
});

describe('G3 — info tools preserved, LLM boundary, voice, privacy, isolation', () => {
  it('[15][16] after cancellation CHECK_PNR + TRACK_TRAIN stay LLM-callable (fresh provider calls; PNR status not assumed from CANCELLED)', async () => {
    const llm = new SpyLLM();
    withMock({ cancel: 'CONFIRMED' }, llm);
    const sid = newSid();
    await confirm(sid);
    await say(sid, 'booking cancel kar do'); await say(sid, 'haan');
    expect(rec(sid).bookingStatus).toBe('CANCELLED');
    const pnr = await say(sid, 'PNR status check karo');
    expect(live.pnrCalls).toEqual([MOCK_TEST_ONLY_PNR]);
    expect(pnr.responseMessage).toMatch(/CNF/);
    const tr = await say(sid, 'meri train abhi kaha hai?');
    expect(live.trackCalls).toEqual(['12497']);
    expect(tr.responseMessage).toMatch(/Ambala/);
    expect(llm.proposed).toEqual(expect.arrayContaining(['CHECK_PNR', 'TRACK_TRAIN']));
    expect(llm.toolNames.at(-1)).toEqual(expect.arrayContaining(['CHECK_PNR', 'TRACK_TRAIN']));
  });

  it('[17] LLM cannot execute cancellation / modification / refund: unknown tools rejected, labels never act, fake claims stripped', async () => {
    const llm = new SpyLLM();
    const p = withMock({ cancel: 'CONFIRMED', modify: 'MODIFIED', modifyEligibility: 'ELIGIBLE', refund: 'PROCESSED' }, llm);
    const sid = newSid();
    await confirm(sid);
    llm.evil = 'tools';
    const r1 = await say(sid, 'mera plan thoda badal gaya hai');
    llm.evil = 'claim';
    const r2 = await say(sid, 'theek hai');
    llm.evil = false;
    for (const r of [r1, r2]) {
      expect(r.responseMessage).not.toMatch(/cancel ho gayi|refund mil gaya|change ho gayi|₹500/i);
      expect(r.responseMessage).not.toMatch(CONFIRM_REQUIRED);
    }
    expect(p.cancelCalls + p.modifyCalls + p.refundCalls).toBe(0);
    expect(rec(sid)).toMatchObject({ bookingStatus: 'CONFIRMED', cancellationStatus: 'NOT_REQUESTED', modificationStatus: 'NOT_REQUESTED', refundStatus: 'NOT_AVAILABLE' });
    expect(REGISTERED_TOOLS.map((t: any) => t.name).filter((n: string) => /CANCEL|MODIF|REFUND|CHANGE|EXECUTE|BOOK|PAY/i.test(n))).toEqual([]);
    expect(REGISTERED_TOOLS).toHaveLength(7);
    const log = orch.lifecycleActions.actionLog(sid);
    expect(log.some(l => l.actionType === 'REQUEST_CANCELLATION' && l.rejectionReason === 'ACTION_NOT_ALLOWED')).toBe(true);
    expect(log.some(l => l.actionType === 'UNSUPPORTED_ACTION' && l.rejectionReason === 'ACTION_NOT_SUPPORTED')).toBe(true);
    expect(orch.lifecycleActions.listActions(sid)).toEqual([]);
  });

  it('[18] voice = text: identical pipeline, records, action lifecycle and provider calls; voice phrasing short', async () => {
    const run = async (mode: 'TEXT' | 'VOICE') => {
      const p = withMock({ cancel: 'CONFIRMED' });
      const sid = newSid();
      await confirm(sid, mode);
      const ask = await say(sid, 'ticket cancel kar do', mode);
      const done = await say(sid, 'haan', mode);
      return { p, ask, done, rec: rec(sid), actions: orch.lifecycleActions.listActions(sid).map(a => ({ t: a.actionType, s: a.status, r: a.resultStatus })) };
    };
    const t = await run('TEXT');
    const v = await run('VOICE');
    expect(v.actions).toEqual(t.actions);
    expect(v.p.cancelCalls).toBe(1);
    expect(t.p.cancelCalls).toBe(1);
    expect({ b: v.rec.bookingStatus, c: v.rec.cancellationStatus }).toEqual({ b: t.rec.bookingStatus, c: t.rec.cancellationStatus });
    expect(v.ask.responseMessage).toMatch(CONFIRM_REQUIRED); expect(v.ask.responseMessage).not.toMatch(/\?/);   // P42.1: confirmation-required fact; the LLM words the question
    expect(v.ask.responseMessage.length).toBeLessThan(t.ask.responseMessage.length);
    expect(v.done.responseMessage).toContain('Booking provider ne cancellation confirm kar di hai.');
  });

  it('[19] no secrets logged: action log / events / action records / turn log carry no PNR, credentials or passenger values', async () => {
    const p = withMock({ cancel: 'CONFIRMED', modify: 'MODIFIED', refund: 'PENDING' });
    const sid = newSid();
    await confirm(sid);
    await say(sid, 'passenger 2 ka naam Priyanka Verma kar do');
    await say(sid, 'haan');
    expect(p.modifyRequests[0].changes.passenger).toMatchObject({ field: 'name', value: 'Priyanka Verma' });   // only the provider sees it
    await say(sid, 'refund status batao');
    await say(sid, 'booking cancel kar do'); await say(sid, 'haan');
    const blobs = [orch.lifecycleActions.actionLog(sid), (S(sid).eventLog || []).filter((e: any) => /ACTION|REFUND|CANCELLATION|MODIFICATION/.test(e.type)), orch.lifecycleActions.listActions(sid), orch.lifecycleActions.actions.forSession(sid)];
    for (const b of blobs) {
      const j = JSON.stringify(b);
      expect(j).not.toContain(MOCK_TEST_ONLY_PNR);
      expect(j).not.toMatch(/Priyanka|Rahul|Neha/);
      expect(findSensitiveFields(b)).toEqual([]);
    }
    expect(JSON.stringify(orch.getTurnHistory(sid))).not.toContain(MOCK_TEST_ONLY_PNR);
    expect(JSON.stringify(orch.getTurnHistory(sid))).not.toMatch(/password|otp|cvv|upi pin/i);
  });

  it('[20] RailBook / IRCTC untouched: lifecycle code has no network / IRCTC / REAL_IRCTC_ENABLED / randomness; mock never wired in server; no execute endpoint', () => {
    const files = [
      ...readdirSync(join(__dirname, '../../server/booking/lifecycle-actions')).map(f => join(__dirname, '../../server/booking/lifecycle-actions', f)),
      join(__dirname, '../../shared/booking-lifecycle-action.ts')
    ];
    for (const fp of files) {
      if (!statSync(fp).isFile()) continue;
      const src = readFileSync(fp, 'utf8');
      expect(src).not.toMatch(/irctc\.co\.in|railbook|onrender\.com/i);
      expect(src).not.toMatch(/env\.REAL_IRCTC_ENABLED|env\[['"]REAL_IRCTC_ENABLED|process\.env/);
      expect(src).not.toMatch(/\bfetch\(|axios|https?:\/\//);
      expect(src).not.toMatch(/Math\.random/);
    }
    const shared = readFileSync(join(__dirname, '../../shared/booking-lifecycle-action.ts'), 'utf8');
    expect(shared).not.toMatch(/^\s+\w*(password|otp|captcha|cvv|cookie|token|credential|upi)\w*\??:/im);
    const main = readFileSync(join(__dirname, '../../server/main.ts'), 'utf8');
    expect(main).not.toMatch(/mock-booking-provider|MockBookingProvider/);
    expect(main).not.toMatch(/post\(['"]\/api\/session\/:id\/booking-actions/);    // read-only API only
    expect(main).toMatch(/get\('\/api\/session\/:id\/booking-actions'/);
    const disabled = new DisabledBookingProvider() as any;
    for (const m of ['cancelBooking', 'modifyBooking', 'getRefundStatus', 'checkCancellationEligibility']) expect(disabled[m]).toBeUndefined();
  });
});
