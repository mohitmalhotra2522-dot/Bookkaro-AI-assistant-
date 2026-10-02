/**
 * PROMPT 13 — GROUP 3 (end-to-end)
 * Orchestrator → confirmation policy → handoff → gateway → (mock | disabled) provider →
 * lifecycle → reconciliation → session state → user response.
 * MockBookingProvider is TEST-ONLY (deterministic, no network).
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
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { BookingState } from '../../shared/states';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { findSensitiveFields } from '../../server/booking/handoff/sensitive-data-guard';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { BookingProviderRegistry, createProductionBookingProviderRegistry } from '../../server/booking/provider/booking-provider-registry';
import type { BookingProviderConfig } from '../../server/booking/provider/booking-provider-config';
import {
  PROVIDER_CONFIRMED_MESSAGE, UNSAFE_RETRY_MESSAGE, VOICE_INTERRUPTION_MESSAGE, STATUS_UNKNOWN_MESSAGE, EXECUTION_DISABLED_MESSAGE,
  IN_PROGRESS_MESSAGE, MANUAL_VERIFICATION_MESSAGE, ALREADY_CONFIRMED_MESSAGE
} from '../../server/booking/provider/booking-provider-execution-service';
import { MockBookingProvider, MOCK_TEST_ONLY_PNR, type MockBookingProviderOptions } from '../../server/booking/testing/mock-booking-provider';

const enabledCfg = (provider: string, timeoutMs = 2000): BookingProviderConfig => ({ provider, enabled: true, timeoutMs, configErrors: [] });
const FAKE_SUCCESS = /ticket (book ho gaya|booked)|booking (successful|confirmed|ho gayi)|PNR generated/i;
const FAKE_FAILURE = /booking fail ho gayi|fail ho gaya|reject(ed)? kar di|reject\/fail ki/i;

class SpyLLM extends MockLLMProvider {
  toolNames: string[][] = []; evil = false;
  async generateStructuredDecision(input: any): Promise<any> {
    this.toolNames.push((input.tools || []).map((t: any) => t.name));
    const r: any = await super.generateStructuredDecision(input);
    if (this.evil && !(input.currentTurnToolResults || []).length) {
      r.decision = { ...r.decision, toolCalls: [{ callId: 'evil-1', name: 'EXECUTE_BOOKING', arguments: {} }, { callId: 'evil-2', name: 'GET_BOOKING_STATUS', arguments: { reference: 'x' } }], finalMessage: undefined };
    }
    return r;
  }
}

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
let sleeps: number[];
const S = (sid: string): any => state.getSession(sid);
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT'): Promise<any> => orch.processTurn(sid, text, mode);
const pctx = (): any => ({ turnId: 't-p13', mode: 'TEXT', cards: [], events: [], changes: [], requestId: 'rq-p13' });
const newSid = () => state.createSession().sessionId;
function mk(opts: OrchestratorOptions = {}, llm: MockLLMProvider = new MockLLMProvider()) {
  state = new ConversationStateManager();
  sleeps = [];
  orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService(), { bookingReconciliation: { config: { attemptTimeoutMs: 100 }, sleep: async ms => { sleeps.push(ms); } }, ...opts });
}
function withMock(o: MockBookingProviderOptions, timeoutMs = 2000, llm?: MockLLMProvider) {
  const p = new MockBookingProvider(o);
  const r = new BookingProviderRegistry({ allowTestProviders: true }); r.register(p);
  mk({ bookingProviderRegistry: r, bookingProviderConfig: enabledCfg(p.name, timeoutMs) }, llm);
  return p;
}
async function toAwaiting(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female']) await say(sid, t, mode);
  expect(S(sid).bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
}
async function confirm(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') { await toAwaiting(sid, mode); return say(sid, 'haan book karo', mode); }

let executeSpy: any, fetchSpy: any, disabledSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('mock');
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
});

describe('P13 G3 — lifecycle through the orchestrator', () => {
  it('[1][2][18] confirmation → provider CONFIRMED → BOOKING_CONFIRMED, authoritative (test-only) PNR in the response', async () => {
    const p = withMock({ execute: 'CONFIRMED' });
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(r.events).toEqual(expect.arrayContaining(['BOOKING_EXECUTION_REQUESTED', 'BOOKING_EXECUTION_STARTED', 'BOOKING_PROVIDER_CONFIRMED']));
    expect(r.responseMessage).toContain(`${PROVIDER_CONFIRMED_MESSAGE} PNR: ${MOCK_TEST_ONLY_PNR}.`);
    expect(S(sid).bookingLifecycle.status).toBe('EXECUTION_SUCCESS');
    expect(p.executeCalls).toBe(1);
  });
  it('[3] provider FAILED → BOOKING_FAILED with an honest failure message (never "booked")', async () => {
    withMock({ execute: 'FAILED' });
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_FAILED);
    expect(r.responseMessage).toContain('Booking provider ne booking reject/fail ki hai.');
    expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
  });
  it('[4] provider IN_PROGRESS → BOOKING_IN_PROGRESS; "status kya hai" → reconciliation (status lookup only) → CONFIRMED', async () => {
    const p = withMock({ execute: 'IN_PROGRESS', status: ['CONFIRMED'] });
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_IN_PROGRESS);
    expect(r.responseMessage).toContain(IN_PROGRESS_MESSAGE);
    const r2 = await say(sid, 'booking ka status kya hai');
    expect(r2.newState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(r2.responseMessage).toContain(PROVIDER_CONFIRMED_MESSAGE);
    expect([p.executeCalls, p.statusCalls]).toEqual([1, 1]);
  });
  it('[5][7][9][22] timeout → UNKNOWN (never "failed") → auto reconciliation confirms', async () => {
    const p = withMock({ execute: 'TIMEOUT', status: ['UNKNOWN', 'CONFIRMED'], supportsIdempotency: true }, 40);
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(r.events).toEqual(expect.arrayContaining(['BOOKING_PROVIDER_TIMEOUT', 'BOOKING_EXECUTION_UNKNOWN', 'BOOKING_STATUS_CHECK_REQUESTED', 'BOOKING_STATUS_RECONCILED', 'BOOKING_PROVIDER_CONFIRMED']));
    expect(r.events).not.toContain('BOOKING_PROVIDER_FAILED');
    expect(sleeps).toEqual([1000]);
    expect([p.executeCalls, p.statusCalls]).toEqual([1, 2]);
  });
  it('[6][8][11][12] network error → UNKNOWN; reconcile stays unknown; "phir se book karo" → exact UNSAFE_RETRY message, no resubmission', async () => {
    const p = withMock({ execute: 'NETWORK_ERROR', status: ['UNKNOWN', 'UNKNOWN', 'UNKNOWN', 'CONFIRMED'], supportsIdempotency: true });
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_STATUS_UNKNOWN);
    expect(S(sid).bookingExecution).toMatchObject({ status: 'UNKNOWN', reconciliationAttempts: 3 });
    expect(r.responseMessage).toContain(STATUS_UNKNOWN_MESSAGE);
    expect(r.responseMessage).not.toMatch(FAKE_FAILURE);
    expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
    const r2 = await say(sid, 'phir se book karo');
    expect(r2.error?.code).toBe('UNSAFE_RETRY');
    expect(r2.responseMessage).toContain(UNSAFE_RETRY_MESSAGE);
    expect(r2.responseMessage).toContain(PROVIDER_CONFIRMED_MESSAGE);          // the status check (not a resubmission) resolved it
    expect(r2.newState).toBe(BookingState.BOOKING_CONFIRMED);
    expect([p.executeCalls, p.statusCalls]).toEqual([1, 4]);
    const r3 = await say(sid, 'phir se book karo', 'VOICE');                   // [13]
    expect(r3.error?.code).toBe('EXECUTION_ALREADY_CONFIRMED');
    expect(r3.responseMessage).toContain(ALREADY_CONFIRMED_MESSAGE);
    expect(p.executeCalls).toBe(1);
  });
  it('[14][17] retry after FAILED: explicit only; fresh data + new review + new confirmation + NEW handoff/key; old confirmation never reused', async () => {
    const p = withMock({ execute: 'FAILED' });
    const sid = newSid();
    await confirm(sid);
    const old = { key: S(sid).handoffSession.idempotencyKey, handoffId: S(sid).handoff.snapshot.handoffId, execId: S(sid).bookingExecution.bookingExecutionId, review: S(sid).reviewVersion };
    const h = await say(sid, 'haan');                                             // not an explicit retry
    expect(h.error?.code).toBe('EXECUTION_LOCKED');
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_FAILED);
    const r = await say(sid, 'phir se book karo');
    expect(r.error?.code).toBe('EXECUTION_ALREADY_FAILED');
    expect(r.events).toEqual(expect.arrayContaining(['BOOKING_RETRY_AFTER_FAILURE', 'AVAILABILITY_REFRESHED', 'FARE_REFRESHED', 'REVIEW_CREATED']));
    expect(S(sid).bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(S(sid).handoff.status).not.toBe('READY');
    expect(S(sid).reviewVersion).toBeGreaterThan(old.review);
    expect(S(sid).confirmedReviewVersion).not.toBe(old.review);
    expect(p.executeCalls).toBe(1);                                                 // nothing sent without a NEW confirmation
    (p as any).opts.execute = 'CONFIRMED';
    const c = await say(sid, 'haan book karo');
    expect(c.newState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(p.executeCalls).toBe(2);
    expect(S(sid).handoff.snapshot.handoffId).not.toBe(old.handoffId);
    expect(p.requests[1].handoffId).not.toBe(old.handoffId);
    expect(S(sid).handoffSession.idempotencyKey).not.toBe(old.key);
    expect(S(sid).bookingExecution.bookingExecutionId).not.toBe(old.execId);
    expect(S(sid).bookingExecutionHistory.map((x: any) => x.status)).toContain('FAILED');
    const hist = orch.preparation.bookingHistory(sid);
    expect(hist.map(x => x.status)).toEqual(['CONFIRMED', 'FAILED']);
  });
  it('[15][16] in-flight turn + API: lock blocks, existing state returned, single submission', async () => {
    const p = withMock({ execute: 'IN_PROGRESS' });
    const sid = newSid();
    await confirm(sid);
    const [api, t2] = await Promise.all([orch.preparation.executeBookingProvider(sid, pctx()), say(sid, 'haan book karo', 'VOICE')]);
    expect(api.code).toBe('EXECUTION_ALREADY_ACTIVE');
    expect(t2.error?.code).toBe('EXECUTION_ALREADY_ACTIVE');
    expect(p.executeCalls).toBe(1);
  });
  it('[23][25] no status API → MANUAL_VERIFICATION_REQUIRED; explicit reconcile API reports unavailable; state stays BOOKING_STATUS_UNKNOWN', async () => {
    const p = withMock({ execute: 'TIMEOUT' }, 40);
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_STATUS_UNKNOWN);
    expect(S(sid).bookingExecution.status).toBe('MANUAL_VERIFICATION_REQUIRED');
    expect(r.responseMessage).toContain('Duplicate booking se bachne ke liye pehle provider se status verify karna zaroori hai.');
    const px = await orch.preparation.reconcileExecution(sid, pctx());
    expect(px.code).toBe('RECONCILIATION_UNAVAILABLE');
    expect(px.message).toBe(MANUAL_VERIFICATION_MESSAGE);
    const again = await say(sid, 'dobara book karo');
    expect(again.error?.code).toBe('UNSAFE_RETRY');
    expect(p.executeCalls).toBe(1);
    expect(sleeps).toEqual([]);
  });
  it('[24] bounded: status checks never exceed maxTotalAttempts across turns', async () => {
    const p = withMock({ execute: 'NETWORK_ERROR', status: ['UNKNOWN'], supportsIdempotency: true });
    const sid = newSid();
    await confirm(sid);
    for (let i = 0; i < 5; i++) await say(sid, 'status check karo');
    expect(p.statusCalls).toBe(9);
    expect(S(sid).bookingExecution.status).toBe('MANUAL_VERIFICATION_REQUIRED');
    expect(p.executeCalls).toBe(1);
  });
  it('[26] voice "cancel" during BOOKING_IN_PROGRESS is NOT a provider cancellation', async () => {
    const p = withMock({ execute: 'IN_PROGRESS' });
    const sid = newSid();
    await confirm(sid, 'VOICE');
    const before = JSON.stringify(S(sid).bookingExecution);
    const r = await say(sid, 'cancel karo ruko', 'VOICE');
    expect(r.error?.code).toBe('PROVIDER_CANCELLATION_UNSUPPORTED');
    expect(r.responseMessage).toContain(VOICE_INTERRUPTION_MESSAGE);
    expect(r.newState).toBe(BookingState.BOOKING_IN_PROGRESS);
    expect(JSON.stringify(S(sid).bookingExecution)).toBe(before);
    expect(p.getCapabilities().supportsCancellation).toBe(false);
    expect(Object.keys(p)).not.toContain('cancelBooking');
  });
  it('[27][28] LLM cannot execute or check booking status; railway info tools stay LLM-callable', async () => {
    const llm = new SpyLLM();
    const p = withMock({ execute: 'IN_PROGRESS', status: ['CONFIRMED'] }, 2000, llm);
    const sid = newSid();
    const s1 = await say(sid, 'Amritsar se Delhi kal 2 log');
    expect((s1.turnLog.toolExecuted || []).some((t: any) => t.name === 'SEARCH_TRAINS')).toBe(true);
    for (const t of ['12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female', 'haan book karo']) await say(sid, t);
    llm.evil = true;
    const before = JSON.stringify(S(sid).bookingExecution);
    await say(sid, 'kuch bhi karo');
    llm.evil = false;
    expect(JSON.stringify(S(sid).bookingExecution)).toBe(before);
    expect([p.executeCalls, p.statusCalls]).toEqual([1, 0]);
    expect(REGISTERED_TOOLS.map((t: any) => t.name).sort()).toEqual(['CHECK_AVAILABILITY', 'CHECK_PNR', 'GET_FARE', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'SEARCH_TRAINS', 'TRACK_TRAIN']);   // P14: + 2 read-only lookups; still no booking tool
    expect(llm.toolNames.flat().filter(n => n !== 'CHECK_PNR').some(n => /BOOK|EXECUTE|STATUS|PNR|CANCEL/i.test(n))).toBe(false);   // CHECK_PNR = read-only lookup (P14)
  });
  it('[D] production (disabled provider) unchanged: NOT_STARTED, handoff stays final, never reaches REQUESTED', async () => {
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(S(sid).bookingExecution).toMatchObject({ status: 'NOT_STARTED', submitted: false, events: [] });
    // (r.events may contain the P10 disabled-EXECUTOR audit event BOOKING_EXECUTION_REQUESTED — the provider LIFECYCLE never starts)
    expect(orch.gateway.bookingProviders.lifecycleLog(sid)).toEqual([]);
    expect(r.responseMessage).toContain(EXECUTION_DISABLED_MESSAGE);
    expect(createProductionBookingProviderRegistry().names()).toEqual(['disabled']);
  });
  it('[20][21][29] no fake PNR / success across scenarios; no secrets in turns, logs, history', async () => {
    for (const execute of ['IN_PROGRESS', 'FAILED', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'REQUIRES_EXTERNAL_HANDOFF', 'UNKNOWN_STATUS'] as const) {
      withMock({ execute });
      const sid = newSid();
      const r = await confirm(sid);
      expect(r.newState).not.toBe(BookingState.BOOKING_CONFIRMED);
      expect(S(sid).bookingExecution.pnr).toBeNull();
      expect(r.responseMessage).not.toMatch(/PNR:\s*\d/);
      expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
      const dump = JSON.stringify({ turns: orch.getTurnHistory(sid), log: orch.gateway.bookingProviders.executionLog(sid), lc: orch.gateway.bookingProviders.lifecycleLog(sid), hist: orch.preparation.bookingHistory(sid) });
      expect(dump).not.toMatch(/socket hang up|password|otp\b|cvv|Bearer|secret/i);
      expect(findSensitiveFields(S(sid))).toEqual([]);
    }
  });
  it('[30] RailBook / IRCTC untouched: lifecycle + test provider code has no IRCTC URL, no REAL_IRCTC_ENABLED read, no network; mock never wired in server', () => {
    const roots = ['../../server/booking/lifecycle', '../../server/booking/testing'];
    for (const r of roots) {
      const dir = join(__dirname, r);
      for (const f of readdirSync(dir)) {
        const fp = join(dir, f);
        if (!statSync(fp).isFile()) continue;
        const src = readFileSync(fp, 'utf8');
        expect(src).not.toMatch(/irctc\.co\.in|railbook|onrender\.com/i);
        expect(src).not.toMatch(/env\.REAL_IRCTC_ENABLED|env\[['"]REAL_IRCTC_ENABLED/);
        expect(src).not.toMatch(/\bfetch\(|axios|https?:\/\//);
      }
    }
    const main = readFileSync(join(__dirname, '../../server/main.ts'), 'utf8');
    expect(main).not.toMatch(/mock-booking-provider|MockBookingProvider/);
  });
});
