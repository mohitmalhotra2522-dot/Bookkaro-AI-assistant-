/**
 * PROMPT 13 — GROUP 2
 * Execution lifecycle, transitions, timeout → UNKNOWN, bounded reconciliation, manual
 * verification, retry protection, idempotency, immutability, observability.
 * Providers: MockBookingProvider (TEST-ONLY, deterministic) via an allowTestProviders registry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { BookingState, EXECUTION_TRANSITIONS, EXECUTION_LOCKED_STATES } from '../../shared/states';
import { BookingExecutionLifecycleStatus as L, EXECUTION_STATUS_TRANSITIONS, canTransitionExecution } from '../../shared/booking-execution-lifecycle';
import { BookingProviderRegistry, createProductionBookingProviderRegistry } from '../../server/booking/provider/booking-provider-registry';
import type { BookingProviderConfig } from '../../server/booking/provider/booking-provider-config';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { BookingProviderExecutionService, UNSAFE_RETRY_MESSAGE, MANUAL_VERIFICATION_MESSAGE, STATUS_UNKNOWN_MESSAGE, IN_PROGRESS_MESSAGE, PROVIDER_FAILED_MESSAGE, PROVIDER_CONFIRMED_MESSAGE, messageForRecord } from '../../server/booking/provider/booking-provider-execution-service';
import { MockBookingProvider, MOCK_TEST_ONLY_PNR, MOCK_TEST_ONLY_REFERENCE, type MockBookingProviderOptions } from '../../server/booking/testing/mock-booking-provider';
import { DEFAULT_RECONCILIATION_CONFIG, normalizeReconciliationConfig, parseReconciliationConfig, backoffDelay } from '../../server/booking/lifecycle/reconciliation-config';
import { sessionStateFor } from '../../server/booking/lifecycle/booking-execution-lifecycle-manager';
import { classifyLockedIntent } from '../../server/ai/context/turn-applier';

const enabledCfg = (provider: string, timeoutMs = 2000): BookingProviderConfig => ({ provider, enabled: true, timeoutMs, configErrors: [] });
const reg = (p: MockBookingProvider) => { const r = new BookingProviderRegistry({ allowTestProviders: true }); r.register(p); return r; };

let state: ConversationStateManager;
const S = (sid: string): any => state.getSession(sid);
let disabledSpy: any, fetchSpy: any;

async function freshHandoff(): Promise<string> {
  state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
  const sid = state.createSession().sessionId;
  for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female', 'haan book karo']) await orch.processTurn(sid, t, 'TEXT');
  expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  S(sid).bookingExecution = undefined;          // fresh, never-executed handoff for a TEST-registry service
  return sid;
}
function svcFor(opts: MockBookingProviderOptions, extra: { timeoutMs?: number; clock?: () => number; reconciliation?: any } = {}) {
  const p = new MockBookingProvider(opts);
  const sleeps: number[] = [];
  const svc = new BookingProviderExecutionService(state, {
    registry: reg(p), config: enabledCfg(p.name, extra.timeoutMs ?? 2000), clock: extra.clock,
    reconciliation: { attemptTimeoutMs: 100, ...(extra.reconciliation || {}) }, sleep: async ms => { sleeps.push(ms); }
  });
  return { p, svc, sleeps };
}
const ctx = (requestId = 'rq-p13') => ({ requestId, turnId: 't-p13', source: 'API' as const, emit: vi.fn() });
const types = (sid: string) => S(sid).bookingExecution.events.map((e: any) => e.type);

beforeEach(() => {
  railwayRegistry.setActive('mock');
  disabledSpy = vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  expect(disabledSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('P13 G2 — status model & transitions', () => {
  it('[T1] lifecycle transition table: required paths allowed, forbidden ones rejected', () => {
    for (const [a, b] of [[L.NOT_STARTED, L.REQUESTED], [L.REQUESTED, L.IN_PROGRESS], [L.REQUESTED, L.FAILED], [L.REQUESTED, L.REQUIRES_EXTERNAL_HANDOFF],
      [L.IN_PROGRESS, L.CONFIRMED], [L.IN_PROGRESS, L.FAILED], [L.IN_PROGRESS, L.UNKNOWN],
      [L.UNKNOWN, L.CONFIRMED], [L.UNKNOWN, L.FAILED], [L.UNKNOWN, L.MANUAL_VERIFICATION_REQUIRED]] as const) expect(canTransitionExecution(a, b)).toBe(true);
    for (const [a, b] of [[L.CONFIRMED, L.IN_PROGRESS], [L.CONFIRMED, L.REQUESTED], [L.FAILED, L.CONFIRMED], [L.UNKNOWN, L.NOT_STARTED],
      [L.NOT_STARTED, L.CONFIRMED], [L.REQUESTED, L.CONFIRMED], [L.CANCELLED, L.CONFIRMED], [L.IN_PROGRESS, L.REQUESTED]] as const) expect(canTransitionExecution(a, b)).toBe(false);
    for (const t of [L.CONFIRMED, L.FAILED, L.CANCELLED, L.REQUIRES_EXTERNAL_HANDOFF]) expect(EXECUTION_STATUS_TRANSITIONS[t]).toEqual([]);
    expect(Object.keys(L).sort()).toEqual(['CANCELLED', 'CONFIRMED', 'FAILED', 'IN_PROGRESS', 'MANUAL_VERIFICATION_REQUIRED', 'NOT_STARTED', 'REQUESTED', 'REQUIRES_EXTERNAL_HANDOFF', 'UNKNOWN']);
  });
  it('[T2] session state mapping + BOOKING_STATUS_UNKNOWN is a locked execution state (no duplicate states)', () => {
    expect(sessionStateFor(L.REQUESTED)).toBe(BookingState.BOOKING_EXECUTION_REQUESTED);
    expect(sessionStateFor(L.IN_PROGRESS)).toBe(BookingState.BOOKING_IN_PROGRESS);
    expect(sessionStateFor(L.CONFIRMED)).toBe(BookingState.BOOKING_CONFIRMED);
    expect(sessionStateFor(L.FAILED)).toBe(BookingState.BOOKING_FAILED);
    expect(sessionStateFor(L.UNKNOWN)).toBe(BookingState.BOOKING_STATUS_UNKNOWN);
    expect(sessionStateFor(L.MANUAL_VERIFICATION_REQUIRED)).toBe(BookingState.BOOKING_STATUS_UNKNOWN);
    expect(sessionStateFor(L.NOT_STARTED)).toBeNull();
    expect(EXECUTION_LOCKED_STATES.has(BookingState.BOOKING_STATUS_UNKNOWN)).toBe(true);
    expect(EXECUTION_TRANSITIONS[BookingState.BOOKING_CONFIRMED]).toBeUndefined();
    expect(EXECUTION_TRANSITIONS[BookingState.BOOKING_STATUS_UNKNOWN]).not.toContain(BookingState.IRCTC_HANDOFF_READY);
    expect(EXECUTION_TRANSITIONS[BookingState.BOOKING_IN_PROGRESS]).toContain(BookingState.BOOKING_STATUS_UNKNOWN);
    expect(Object.values(BookingState).filter(v => /UNKNOWN/.test(v))).toEqual(['BOOKING_STATUS_UNKNOWN']);
  });
  it('[T3] invalid transition → INVALID_EXECUTION_TRANSITION, record unchanged; records frozen + append-only events', async () => {
    const sid = await freshHandoff();
    const { svc } = svcFor({ execute: 'CONFIRMED' });
    const o = await svc.execute(sid, ctx());
    expect(o.code).toBe('BOOKING_CONFIRMED');
    const rec = S(sid).bookingExecution;
    expect(Object.isFrozen(rec)).toBe(true);
    expect(Object.isFrozen(rec.events)).toBe(true);
    expect(() => { rec.status = 'FAILED'; }).toThrow();
    const r = svc.lifecycle.transition(S(sid), L.IN_PROGRESS, 'BOOKING_EXECUTION_STARTED', ctx());
    expect(r).toMatchObject({ ok: false, code: 'INVALID_EXECUTION_TRANSITION' });
    expect(S(sid).bookingExecution).toBe(rec);
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(types(sid)).toEqual(['BOOKING_EXECUTION_REQUESTED', 'BOOKING_EXECUTION_STARTED', 'BOOKING_PROVIDER_CONFIRMED']);
    expect(rec.events.map((e: any) => `${e.previousStatus}>${e.newStatus}`)).toEqual(['NOT_STARTED>REQUESTED', 'REQUESTED>IN_PROGRESS', 'IN_PROGRESS>CONFIRMED']);
    expect(svc.lifecycleLog(sid).some(l => l.failureCode === 'INVALID_EXECUTION_TRANSITION')).toBe(true);
  });
});

describe('P13 G2 — provider results through the lifecycle', () => {
  it('[1][2][18] valid request → REQUESTED → IN_PROGRESS → CONFIRMED with the provider PNR (test-only) and reference', async () => {
    const sid = await freshHandoff();
    const { p, svc } = svcFor({ execute: 'CONFIRMED' });
    const o = await svc.execute(sid, ctx());
    expect(o).toMatchObject({ code: 'BOOKING_CONFIRMED', providerCalled: true });
    expect(S(sid).bookingExecution).toMatchObject({ status: 'CONFIRMED', pnr: MOCK_TEST_ONLY_PNR, providerReference: MOCK_TEST_ONLY_REFERENCE, attemptCount: 1, submitted: true });
    expect(S(sid).bookingExecution.startedAt).toBeTruthy();
    expect(S(sid).bookingExecution.completedAt).toBeTruthy();
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(o.message).toBe(`${PROVIDER_CONFIRMED_MESSAGE} PNR: ${MOCK_TEST_ONLY_PNR}.`);
    expect(p.executeCalls).toBe(1);
  });
  it('[19] CONFIRMED without a PNR → pnr null, no reference invented when none returned', async () => {
    const sid = await freshHandoff();
    const { svc } = svcFor({ execute: 'CONFIRMED_WITHOUT_PNR' });
    const o = await svc.execute(sid, ctx());
    expect(o.detail).toBe('PNR_NOT_AVAILABLE');
    expect(S(sid).bookingExecution).toMatchObject({ status: 'CONFIRMED', pnr: null, providerReference: MOCK_TEST_ONLY_REFERENCE });
    const sid2 = await freshHandoff();
    const { svc: s2 } = svcFor({ execute: 'ACCEPTED_WITHOUT_REFERENCE' });
    await s2.execute(sid2, ctx());
    expect(S(sid2).bookingExecution).toMatchObject({ status: 'IN_PROGRESS', providerReference: null, pnr: null });
  });
  it('[3] FAILED → BOOKING_FAILED, failure code, no PNR', async () => {
    const sid = await freshHandoff();
    const { svc } = svcFor({ execute: 'FAILED' });
    const o = await svc.execute(sid, ctx());
    expect(o.code).toBe('BOOKING_PROVIDER_REJECTED');
    expect(S(sid).bookingExecution).toMatchObject({ status: 'FAILED', failureCode: 'TEST_PROVIDER_REJECTED', pnr: null });
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_FAILED);
    expect(o.message).toBe(PROVIDER_FAILED_MESSAGE);
  });
  it('[4] IN_PROGRESS → BOOKING_IN_PROGRESS with the ACCEPTED event, honest message', async () => {
    const sid = await freshHandoff();
    const { svc } = svcFor({ execute: 'IN_PROGRESS' });
    const o = await svc.execute(sid, ctx());
    expect(S(sid).bookingExecution.status).toBe('IN_PROGRESS');
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_IN_PROGRESS);
    expect(types(sid)).toContain('BOOKING_PROVIDER_ACCEPTED');
    expect(o.message).toBe(IN_PROGRESS_MESSAGE);
  });
  it('[5][7][22] timeout → BOOKING_PROVIDER_TIMEOUT → UNKNOWN (never FAILED) → reconciliation', async () => {
    const sid = await freshHandoff();
    const { p, svc } = svcFor({ execute: 'TIMEOUT', status: ['UNKNOWN'], supportsIdempotency: true }, { timeoutMs: 30 });
    const o = await svc.execute(sid, ctx());
    const rec = S(sid).bookingExecution;
    expect(rec.status).not.toBe('FAILED');
    expect(rec).toMatchObject({ status: 'UNKNOWN', failureCode: 'PROVIDER_TIMEOUT', retryBlocked: true, reconciliationAttempts: 3 });
    expect(types(sid).slice(0, 4)).toEqual(['BOOKING_EXECUTION_REQUESTED', 'BOOKING_EXECUTION_STARTED', 'BOOKING_PROVIDER_TIMEOUT', 'BOOKING_EXECUTION_UNKNOWN']);
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_STATUS_UNKNOWN);
    expect(o.message).toBe(STATUS_UNKNOWN_MESSAGE);
    expect(o.message).not.toMatch(/fail ho gayi|reject|fail ki/i);
    expect(p.executeCalls).toBe(1);
  });
  it('[6] network error after a possible send → UNKNOWN; 5xx (UNKNOWN_STATUS) too; not-sent → FAILED (nothing reached)', async () => {
    for (const execute of ['NETWORK_ERROR', 'UNKNOWN_STATUS'] as const) {
      const sid = await freshHandoff();
      const { p, svc } = svcFor({ execute });
      const o = await svc.execute(sid, ctx());
      expect(S(sid).bookingExecution.status).toBe('MANUAL_VERIFICATION_REQUIRED');   // no status API → manual
      expect(types(sid)).toContain('BOOKING_EXECUTION_UNKNOWN');
      expect(o.message).toBe(MANUAL_VERIFICATION_MESSAGE);
      expect(o.message).not.toMatch(/fail ho gayi|reject|fail ki/i);
      expect(p.executeCalls).toBe(1);
    }
    const sid = await freshHandoff();
    const { svc } = svcFor({ execute: 'NOT_SENT_UNAVAILABLE' });
    await svc.execute(sid, ctx());
    expect(S(sid).bookingExecution).toMatchObject({ status: 'FAILED', code: 'BOOKING_PROVIDER_UNAVAILABLE', failureCode: 'PROVIDER_UNAVAILABLE' });
  });
  it('[M] INVALID_RESPONSE → UNKNOWN; REQUIRES_EXTERNAL_HANDOFF → IRCTC_HANDOFF_READY', async () => {
    const sid = await freshHandoff();
    const { svc } = svcFor({ execute: 'INVALID_RESPONSE' });
    const o = await svc.execute(sid, ctx());
    expect(o.code).toBe('INVALID_PROVIDER_RESPONSE');
    expect(S(sid).bookingExecution).toMatchObject({ status: 'MANUAL_VERIFICATION_REQUIRED', pnr: null });
    const sid2 = await freshHandoff();
    const { svc: s2 } = svcFor({ execute: 'REQUIRES_EXTERNAL_HANDOFF' });
    await s2.execute(sid2, ctx());
    expect(S(sid2).bookingExecution.status).toBe('REQUIRES_EXTERNAL_HANDOFF');
    expect(S(sid2).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });
});

describe('P13 G2 — reconciliation', () => {
  it('[8][9] UNKNOWN → reconcile → CONFIRMED (STATUS_CHECK_REQUESTED → STATUS_RECONCILED → PROVIDER_CONFIRMED)', async () => {
    const sid = await freshHandoff();
    const { p, svc, sleeps } = svcFor({ execute: 'TIMEOUT', status: ['UNKNOWN', 'CONFIRMED'], supportsIdempotency: true }, { timeoutMs: 30 });
    const o = await svc.execute(sid, ctx());
    expect(o.code).toBe('BOOKING_CONFIRMED');
    expect(S(sid).bookingExecution).toMatchObject({ status: 'CONFIRMED', pnr: MOCK_TEST_ONLY_PNR, reconciliationAttempts: 2 });
    expect(types(sid).slice(-4)).toEqual(['BOOKING_STATUS_CHECK_REQUESTED', 'BOOKING_STATUS_CHECK_REQUESTED', 'BOOKING_STATUS_RECONCILED', 'BOOKING_PROVIDER_CONFIRMED']);
    expect(sleeps).toEqual([1000]);
    expect([p.executeCalls, p.statusCalls]).toEqual([1, 2]);
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_CONFIRMED);
  });
  it('[10] reconcile → FAILED / CANCELLED (authoritative provider status only)', async () => {
    for (const [st, status] of [['FAILED', 'FAILED'], ['CANCELLED', 'CANCELLED']] as const) {
      const sid = await freshHandoff();
      const { svc } = svcFor({ execute: 'NETWORK_ERROR', status: [st], supportsIdempotency: true });
      await svc.execute(sid, ctx());
      expect(S(sid).bookingExecution).toMatchObject({ status, pnr: null });
      expect(S(sid).bookingState).toBe(BookingState.BOOKING_FAILED);
    }
  });
  it('[11][24] reconcile stays unknown → bounded (3 attempts, backoff 1000/2000, timeouts count) → stays UNKNOWN; total cap → MANUAL', async () => {
    const sid = await freshHandoff();
    const { p, svc, sleeps } = svcFor({ execute: 'TIMEOUT', status: ['UNKNOWN', 'TIMEOUT', 'ERROR'], supportsIdempotency: true }, { timeoutMs: 30, reconciliation: { maxTotalAttempts: 5 } });
    const o = await svc.execute(sid, ctx());
    expect(o.detail).toBe('RECONCILIATION_FAILED');
    expect(S(sid).bookingExecution).toMatchObject({ status: 'UNKNOWN', reconciliationAttempts: 3 });
    expect(sleeps).toEqual([1000, 2000]);
    expect(p.statusCalls).toBe(3);
    // explicit check: 2 more allowed (cap 5) → then MANUAL; never more status calls than the cap
    const o2 = await svc.reconcile(sid, ctx());
    expect(p.statusCalls).toBe(5);
    expect(o2).toMatchObject({ code: 'MANUAL_VERIFICATION_REQUIRED', manualVerificationRequired: true });
    expect(S(sid).bookingExecution.status).toBe('MANUAL_VERIFICATION_REQUIRED');
    await svc.reconcile(sid, ctx());
    expect(p.statusCalls).toBe(5);
    expect(p.executeCalls).toBe(1);
  });
  it('[23] no status API → MANUAL_VERIFICATION_REQUIRED immediately, no retries / sleeps; no reference → manual too', async () => {
    const sid = await freshHandoff();
    const { svc, sleeps } = svcFor({ execute: 'TIMEOUT' }, { timeoutMs: 30 });
    const o = await svc.execute(sid, ctx());
    expect(o).toMatchObject({ code: 'BOOKING_STATUS_UNKNOWN', manualVerificationRequired: true, detail: 'MANUAL_PROVIDER_VERIFICATION_REQUIRED' });
    expect(types(sid)).toContain('BOOKING_MANUAL_VERIFICATION_REQUIRED');
    expect(sleeps).toEqual([]);
    expect((await svc.reconcile(sid, ctx())).code).toBe('RECONCILIATION_UNAVAILABLE');
    const sid2 = await freshHandoff();
    const { p: p2, svc: s2 } = svcFor({ execute: 'TIMEOUT', status: ['CONFIRMED'], supportsIdempotency: false }, { timeoutMs: 30 });
    await s2.execute(sid2, ctx());
    expect(p2.statusCalls).toBe(0);                                    // no reference & no idempotency → cannot look up
    expect(S(sid2).bookingExecution.status).toBe('MANUAL_VERIFICATION_REQUIRED');
  });
  it('[25] TTL: unresolved longer than unresolvedTtlMs → MANUAL_VERIFICATION_REQUIRED (lazy, no polling); explicit check can still resolve', async () => {
    const sid = await freshHandoff();
    let now = Date.now();
    const { p, svc } = svcFor({ execute: 'IN_PROGRESS', status: ['IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS', 'CONFIRMED'] }, { clock: () => now, reconciliation: { unresolvedTtlMs: 60_000, maxAttempts: 1 } });
    await svc.execute(sid, ctx());
    expect(S(sid).bookingExecution.status).toBe('IN_PROGRESS');
    now += 61_000;
    expect(svc.refreshStaleness(sid, ctx())).toBe(true);
    expect(S(sid).bookingExecution.status).toBe('MANUAL_VERIFICATION_REQUIRED');
    expect(types(sid).slice(-2)).toEqual(['BOOKING_EXECUTION_UNKNOWN', 'BOOKING_MANUAL_VERIFICATION_REQUIRED']);
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_STATUS_UNKNOWN);
    expect((await svc.execute(sid, ctx())).code).toBe('MANUAL_VERIFICATION_REQUIRED');   // execute never auto-checks MANUAL
    expect(p.statusCalls).toBe(0);
    const o = await svc.reconcile(sid, ctx());                                            // explicit → allowed
    expect(o.record!.status).toBe('IN_PROGRESS');
    expect(p.executeCalls).toBe(1);
  });
  it('[R] config: deterministic defaults, env parsing, clamping, backoff schedule', () => {
    expect(DEFAULT_RECONCILIATION_CONFIG).toEqual({ maxAttempts: 3, backoffMs: 1000, attemptTimeoutMs: 10000, maxTotalAttempts: 9, unresolvedTtlMs: 900000 });
    expect(parseReconciliationConfig({ BOOKING_RECONCILIATION_MAX_ATTEMPTS: '2', BOOKING_RECONCILIATION_BACKOFF_MS: '500' })).toMatchObject({ maxAttempts: 2, backoffMs: 500 });
    expect(normalizeReconciliationConfig({ maxAttempts: 1e9, attemptTimeoutMs: -5, unresolvedTtlMs: NaN })).toMatchObject({ maxAttempts: 5, attemptTimeoutMs: 100, unresolvedTtlMs: 900000 });
    expect([0, 1, 2].map(i => backoffDelay(DEFAULT_RECONCILIATION_CONFIG, i))).toEqual([0, 1000, 2000]);
  });
});

describe('P13 G2 — retry protection, idempotency, locking, observability', () => {
  it('[12][13][14] no auto-duplicate: UNKNOWN → UNSAFE_RETRY; CONFIRMED → ALREADY_CONFIRMED; FAILED → ALREADY_FAILED', async () => {
    const sid = await freshHandoff();
    const { p, svc } = svcFor({ execute: 'TIMEOUT', status: ['UNKNOWN'], supportsIdempotency: true }, { timeoutMs: 30, reconciliation: { maxAttempts: 1 } });
    await svc.execute(sid, ctx());
    const again = await svc.execute(sid, ctx('rq-2'));
    expect(again).toMatchObject({ code: 'UNSAFE_RETRY', duplicate: true, message: UNSAFE_RETRY_MESSAGE });
    expect(p.executeCalls).toBe(1);
    const sid2 = await freshHandoff();
    const c = svcFor({ execute: 'CONFIRMED' });
    await c.svc.execute(sid2, ctx());
    expect((await c.svc.execute(sid2, ctx())).code).toBe('EXECUTION_ALREADY_CONFIRMED');
    expect(c.p.executeCalls).toBe(1);
    const sid3 = await freshHandoff();
    const f = svcFor({ execute: 'FAILED' });
    await f.svc.execute(sid3, ctx());
    expect((await f.svc.execute(sid3, ctx())).code).toBe('EXECUTION_ALREADY_FAILED');
    expect(f.p.executeCalls).toBe(1);
  });
  it('[15][16] concurrent execute → one submission, others EXECUTION_LOCKED; IN_PROGRESS re-execute → ALREADY_ACTIVE', async () => {
    const sid = await freshHandoff();
    const { p, svc } = svcFor({ execute: 'IN_PROGRESS' });
    const [a, b, c] = await Promise.all([svc.execute(sid, ctx('a')), svc.execute(sid, ctx('b')), svc.execute(sid, ctx('c'))]);
    expect([a.code, b.code, c.code].filter(x => x === 'EXECUTION_LOCKED').length).toBe(2);
    expect(p.executeCalls).toBe(1);
    expect((await svc.execute(sid, ctx('d'))).code).toBe('EXECUTION_ALREADY_ACTIVE');
    expect(p.executeCalls).toBe(1);
  });
  it('[17] idempotency key preserved handoff → execution → reconciliation (same key, never regenerated)', async () => {
    const sid = await freshHandoff();
    const key = S(sid).handoffSession.idempotencyKey;
    const { p, svc } = svcFor({ execute: 'TIMEOUT', status: ['UNKNOWN', 'CONFIRMED'], supportsIdempotency: true, returnsReference: false }, { timeoutMs: 30 });
    await svc.execute(sid, ctx());
    expect(p.requests[0].idempotencyKey).toBe(key);
    expect(S(sid).bookingExecution.idempotencyKey).toBe(key);
    expect(p.statusRefs).toEqual([key, key]);
    expect(S(sid).handoffSession.idempotencyKey).toBe(key);
  });
  it('[20][21] no fake PNR / fake success: only a schema-valid CONFIRMED sets CONFIRMED; messages per status are honest', () => {
    for (const st of ['NOT_STARTED', 'REQUESTED', 'IN_PROGRESS', 'FAILED', 'UNKNOWN', 'MANUAL_VERIFICATION_REQUIRED', 'CANCELLED', 'REQUIRES_EXTERNAL_HANDOFF']) {
      const m = messageForRecord({ status: st as any, pnr: '1234567890', code: 'X' as any });
      expect(m).not.toMatch(/PNR:\s*\d|ticket book ho gaya|confirm ki hai/i);
    }
    for (const st of ['UNKNOWN', 'MANUAL_VERIFICATION_REQUIRED', 'IN_PROGRESS', 'REQUESTED']) expect(messageForRecord({ status: st as any, pnr: null, code: 'X' as any })).not.toMatch(/fail ho gayi|reject|fail ki/i);
  });
  it('[29] lifecycle log: required fields, no secrets / PII / idempotency key', async () => {
    const sid = await freshHandoff();
    const { svc } = svcFor({ execute: 'TIMEOUT', status: ['CONFIRMED'], supportsIdempotency: true }, { timeoutMs: 30 });
    await svc.execute(sid, ctx());
    const logs = svc.lifecycleLog(sid);
    expect(Object.keys(logs[0]).sort()).toEqual(['at', 'event', 'executionId', 'failureCode', 'handoffId', 'latencyMs', 'newStatus', 'previousStatus', 'providerName', 'reconciliationAttempt', 'requestId', 'sessionId']);
    expect(logs.some(l => l.reconciliationAttempt === 1)).toBe(true);
    const dump = JSON.stringify({ logs, events: S(sid).bookingExecution.events, history: svc.history(sid) });
    expect(dump).not.toContain(S(sid).handoffSession.idempotencyKey);
    expect(dump).not.toMatch(/Rahul|Neha|password|otp|token|secret/i);
  });
  it('[H] history abstraction: newest first, safe fields, authoritative PNR only, reconciliation status', async () => {
    const sid = await freshHandoff();
    const { svc } = svcFor({ execute: 'TIMEOUT', status: ['CONFIRMED'], supportsIdempotency: true }, { timeoutMs: 30 });
    await svc.execute(sid, ctx());
    const [h] = svc.history(sid);
    expect(h).toMatchObject({ status: 'CONFIRMED', pnr: MOCK_TEST_ONLY_PNR, providerName: 'test-mock-booking', attemptCount: 1, reconciliation: { status: 'RESOLVED', attempts: 1 } });
    expect(Object.keys(h)).not.toContain('idempotencyKey');
  });
  it('[V][26] deterministic locked intents: cancel ≠ provider cancellation; status; retry', () => {
    expect(classifyLockedIntent('cancel karo')).toBe('CANCEL');
    expect(classifyLockedIntent('ruko ruko band karo')).toBe('CANCEL');
    expect(classifyLockedIntent('status kya hua')).toBe('STATUS');
    expect(classifyLockedIntent('phir se book karo')).toBe('RETRY');
    expect(classifyLockedIntent('dobara try karo')).toBe('RETRY');
    expect(classifyLockedIntent('Neha ki age 29 kar do')).toBe('OTHER');
  });
  it('[P] MockBookingProvider is test-only: refused in production env and by the production registry', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { expect(() => new MockBookingProvider({ execute: 'CONFIRMED' })).toThrow(/test-only/); } finally { process.env.NODE_ENV = prev; }
    expect(() => createProductionBookingProviderRegistry().register(new MockBookingProvider({ execute: 'CONFIRMED' }))).toThrow(/not allowed/);
    expect(() => new MockBookingProvider({ execute: 'CONFIRMED', name: 'real-x' })).toThrow(/start with "test"/);
  });
});
