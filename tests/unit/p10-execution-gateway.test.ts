/**
 * PROMPT 10 — GROUP 2
 * BookingExecutionGateway (independent re-validation), fail-closed execution
 * configuration, executor registry, immutable BookingHandoff, lifecycle,
 * session-version protection, idempotency, result normalization.
 *
 * NO real booking / IRCTC / network is ever executed — asserted via spies.
 * TestBookingExecutor* classes below are test doubles and are never wired to production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { BookingState, EXECUTION_LOCKED_STATES, VALID_BOOKING_TRANSITIONS } from '../../shared/states';
import { stateTransitionValidator } from '../../server/ai/state/state-transition-validator';
import { BookingExecutionGateway } from '../../server/booking/execution/booking-execution-gateway';
import { BookingExecutorRegistry, createProductionExecutorRegistry } from '../../server/booking/execution/booking-executor-registry';
import { DisabledBookingExecutor } from '../../server/booking/execution/disabled-booking-executor';
import { parseExecutionConfig, DEFAULT_HANDOFF_TTL_MS } from '../../server/booking/execution/execution-config';
import { buildExecutionRequest, findSensitiveKeys } from '../../server/booking/execution/execution-request';
import { BookingHandoffService } from '../../server/booking/execution/booking-handoff';
import { canTransitionLifecycle, LIFECYCLE_TRANSITIONS } from '../../server/booking/execution/booking-lifecycle';
import { reviewFingerprint } from '../../server/booking/review-builder';
import type { BookingExecutor } from '../../server/booking/execution/booking-executor';
import type { BookingExecutionRequest, BookingExecutionResult } from '../../shared/booking-execution';

// ---- test doubles (NON-production) ----
class TestBookingExecutorSuccess implements BookingExecutor {
  readonly name = 'test-success'; readonly kind = 'TEST' as const; calls = 0;
  isAvailable() { return true; }
  async execute(r: BookingExecutionRequest): Promise<BookingExecutionResult> {
    this.calls++;
    return { status: 'SUCCESS', reason: 'BOOKED', executorName: this.name, idempotencyKey: r.idempotencyKey, completedAt: new Date().toISOString(), bookingReference: 'PNR8812345678' as any };
  }
}
class TestBookingExecutorUnavailable implements BookingExecutor {
  readonly name = 'test-down'; readonly kind = 'TEST' as const; calls = 0;
  isAvailable() { return false; }
  async execute(r: BookingExecutionRequest): Promise<BookingExecutionResult> { this.calls++; return { status: 'DISABLED', reason: 'x', executorName: this.name, idempotencyKey: r.idempotencyKey, completedAt: '' }; }
}
class TestBookingExecutorSlow implements BookingExecutor {
  readonly name = 'test-slow'; readonly kind = 'TEST' as const; calls = 0;
  isAvailable() { return true; }
  async execute(r: BookingExecutionRequest): Promise<BookingExecutionResult> {
    this.calls++; await new Promise(res => setTimeout(res, 40));
    return { status: 'REQUIRES_HANDOFF', reason: 'USER_HANDOFF', executorName: this.name, idempotencyKey: r.idempotencyKey, completedAt: new Date().toISOString() };
  }
}

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
let disabledSpy: any, executeSpy: any, fetchSpy: any;
const ctx = (): any => ({ turnId: 't-test', emit: vi.fn() });

async function awaiting(): Promise<string> {
  const sid = state.createSession().sessionId;
  for (const l of ['Amritsar se Delhi kal 2 log', '12014', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female']) await orch.processTurn(sid, l, 'TEXT');
  expect(state.getSession(sid).bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
  return sid;
}
const req = (sid: string): BookingExecutionRequest => buildExecutionRequest(state.getSession(sid), { requestId: 'req-1', confirmedAt: new Date().toISOString() })!;
const testRegistry = (...ex: BookingExecutor[]) => { const r = new BookingExecutorRegistry({ allowTestExecutors: true }); ex.forEach(e => r.register(e)); return r; };
const gw = (opts: any = {}) => new BookingExecutionGateway(state, opts);
/** Simulate a corrupted-but-consistent review (fingerprint rebuilt from bad data) to prove the gateway does not trust earlier validation. */
const reseal = (sid: string) => { const s = state.getSession(sid); s.review!.fingerprint = reviewFingerprint(s); };

beforeEach(() => {
  railwayRegistry.setActive('mock');
  state = new ConversationStateManager();
  orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
  disabledSpy = vi.spyOn(DisabledBookingExecutor.prototype, 'execute');
  executeSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  expect(executeSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------------------------------
describe('G2 — gateway happy path, Disabled executor, normalization', () => {
  it('[4] DisabledBookingExecutor returns DISABLED / REAL_BOOKING_DISABLED; gateway syncs handoff READY + lifecycle; never SUCCESS', async () => {
    const d = new DisabledBookingExecutor();
    const r0 = await d.execute({ idempotencyKey: 'k' } as any);
    expect(r0).toMatchObject({ status: 'DISABLED', reason: 'REAL_BOOKING_DISABLED', executorName: 'disabled' });
    expect(r0.bookingReference).toBeUndefined();
    disabledSpy.mockClear();                                                   // the direct call above is not a gateway invocation

    const sid = await awaiting();
    const g = gw();
    const o: any = await g.execute(req(sid), ctx());
    expect(o.ok).toBe(true);
    expect(o.execution).toMatchObject({ status: 'DISABLED', reason: 'REAL_BOOKING_DISABLED', executorName: 'disabled' });
    expect(o.capability).toMatchObject({ realBookingEnabled: false, effectiveExecutor: 'disabled', executionPossible: false });
    const s = state.getSession(sid);
    expect(s.bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(s.handoff!.status).toBe('READY');
    expect(s.bookingLifecycle!.history.map(h => h.to)).toEqual(['PREPARING', 'READY_FOR_CONFIRMATION', 'CONFIRMED_BY_USER', 'HANDOFF_CREATED', 'EXECUTION_DISABLED']);
    expect(disabledSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(s)).not.toMatch(/"status":"SUCCESS"|bookingReference|PNR\d/);
  });

  it('[23] a TestBookingExecutor returning SUCCESS + reference is NOT trusted → FAILED (UNTRUSTED_EXECUTOR_RESULT), no reference stored, never BOOKING_CONFIRMED', async () => {
    const sid = await awaiting();
    const ex = new TestBookingExecutorSuccess();
    const g = gw({ registry: testRegistry(ex), config: parseExecutionConfig({ REAL_BOOKING_ENABLED: 'true', BOOKING_EXECUTOR: 'test-success' }) });
    const o: any = await g.execute(req(sid), ctx());
    expect(ex.calls).toBe(1);
    expect(o.execution).toMatchObject({ status: 'FAILED', reason: 'UNTRUSTED_EXECUTOR_RESULT' });
    expect(o.execution.bookingReference).toBeUndefined();
    const s = state.getSession(sid);
    expect(s.bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);          // never BOOKING_CONFIRMED
    expect(s.bookingLifecycle!.status).toBe('EXECUTION_FAILED');
    expect(JSON.stringify(s)).not.toContain('PNR8812345678');
    expect(JSON.stringify(g.executionLog())).not.toContain('PNR8812345678');
  });

  it('registry: production registry holds ONLY disabled; REAL executors refused; TEST executors refused in production', () => {
    const prod = createProductionExecutorRegistry();
    expect(prod.names()).toEqual(['disabled']);
    expect(() => prod.register(new TestBookingExecutorSuccess())).toThrow(/not allowed in the production registry/);
    expect(() => prod.register({ name: 'irctc', kind: 'REAL', isAvailable: () => true, execute: async () => ({}) as any })).toThrow(/REAL booking executors cannot be registered/);
    const t = new BookingExecutorRegistry({ allowTestExecutors: true });
    expect(() => t.register({ name: 'mock-exec', kind: 'TEST', isAvailable: () => true, execute: async () => ({}) as any })).toThrow(/must start with "test"/);
  });
});

describe('G2 — fail-closed configuration', () => {
  it('[20][21] REAL_BOOKING_ENABLED: missing / false / malformed → false; only exact "true" enables the flag', () => {
    expect(parseExecutionConfig({}).realBookingEnabled).toBe(false);
    expect(parseExecutionConfig({ REAL_BOOKING_ENABLED: 'false' })).toMatchObject({ realBookingEnabled: false, configErrors: [] });
    for (const v of ['TRUE', 'True', '1', 'yes', ' true', 'true ', 'on', '']) {
      expect(parseExecutionConfig({ REAL_BOOKING_ENABLED: v }).realBookingEnabled).toBe(false);
    }
    expect(parseExecutionConfig({ REAL_BOOKING_ENABLED: 'yes' }).configErrors).toContain('REAL_BOOKING_ENABLED_MALFORMED');
    expect(parseExecutionConfig({ REAL_BOOKING_ENABLED: 'true' }).realBookingEnabled).toBe(true);
    // flag false → Disabled regardless of BOOKING_EXECUTOR
    const r = createProductionExecutorRegistry().resolve(parseExecutionConfig({ REAL_BOOKING_ENABLED: 'false', BOOKING_EXECUTOR: 'irctc' }));
    expect(r.executor!.name).toBe('disabled');
    expect(r.capability.reason).toBe('REAL_BOOKING_DISABLED');
    // flag true + any config error → Disabled
    const r2 = createProductionExecutorRegistry().resolve(parseExecutionConfig({ REAL_BOOKING_ENABLED: 'true', BOOKING_EXECUTOR: 'disabled', BOOKING_HANDOFF_TTL_MS: 'abc' }));
    expect(r2.executor!.name).toBe('disabled');
    expect(r2.capability.reason).toBe('BOOKING_EXECUTION_DISABLED');
    // TTL: default derived from availability freshness; invalid / huge values fall back
    expect(parseExecutionConfig({}).handoffTtlMs).toBe(DEFAULT_HANDOFF_TTL_MS);
    expect(parseExecutionConfig({ BOOKING_HANDOFF_TTL_MS: '60000' }).handoffTtlMs).toBe(60000);
    for (const v of ['-5', '0', '99999999', '1e5', 'x']) expect(parseExecutionConfig({ BOOKING_HANDOFF_TTL_MS: v }).handoffTtlMs).toBe(DEFAULT_HANDOFF_TTL_MS);
  });

  it('[19] unknown executor → UNKNOWN_BOOKING_EXECUTOR, nothing invoked; unavailable executor → BOOKING_EXECUTOR_UNAVAILABLE', async () => {
    const sid = await awaiting();
    const g = gw({ config: parseExecutionConfig({ REAL_BOOKING_ENABLED: 'true', BOOKING_EXECUTOR: 'irctc' }) });
    expect(g.capability()).toMatchObject({ realBookingEnabled: true, configuredExecutor: 'irctc', effectiveExecutor: 'none', reason: 'UNKNOWN_BOOKING_EXECUTOR' });
    const o: any = await g.execute(req(sid), ctx());
    expect(o.execution).toMatchObject({ status: 'DISABLED', reason: 'UNKNOWN_BOOKING_EXECUTOR', executorName: 'none' });
    expect(disabledSpy).not.toHaveBeenCalled();
    expect(o.log).toMatchObject({ executionCapability: 'UNKNOWN_BOOKING_EXECUTOR', executionStatus: 'DISABLED' });

    const down = new TestBookingExecutorUnavailable();
    const reg = testRegistry(down);
    const res = reg.resolve(parseExecutionConfig({ REAL_BOOKING_ENABLED: 'true', BOOKING_EXECUTOR: 'test-down' }));
    expect(res.executor).toBeNull();
    expect(res.capability.reason).toBe('BOOKING_EXECUTOR_UNAVAILABLE');
    expect(down.calls).toBe(0);
  });
});

describe('G2 — confirmation, review version, session version', () => {
  it('[5] missing explicit confirmation / not AWAITING_CONFIRMATION → CONFIRMATION_REQUIRED; executor never invoked', async () => {
    const sid = await awaiting();
    const g = gw();
    const r1 = { ...req(sid), explicitConfirmation: false } as any;
    expect(await g.execute(r1, ctx())).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    const s = state.getSession(sid);
    state.transitionState(sid, BookingState.REVIEW);                          // e.g. after "nahi"
    expect(await g.execute(buildExecutionRequest(s, { requestId: 'r', confirmedAt: '' })!, ctx())).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(disabledSpy).not.toHaveBeenCalled();
    expect(s.handoff).toBeUndefined();
  });

  it('[6][7] wrong / obsolete review version → CONFIRMATION_VERSION_MISMATCH; forged idempotency key → INVALID_BOOKING_HANDOFF', async () => {
    const sid = await awaiting();
    const g = gw();
    expect(await g.execute({ ...req(sid), reviewVersion: 99 }, ctx())).toMatchObject({ ok: false, code: 'CONFIRMATION_VERSION_MISMATCH' });
    expect(await g.execute({ ...req(sid), idempotencyKey: 'bk_forged' }, ctx())).toMatchObject({ ok: false, code: 'INVALID_BOOKING_HANDOFF' });
    // obsolete: request built for v1, then the review is regenerated (v2)
    const old = req(sid);
    await orch.processTurn(sid, 'Rahul ki age 32 hai', 'TEXT');
    expect(state.getSession(sid).review!.reviewVersion).toBe(2);
    const o: any = await g.execute(old, ctx());
    expect(o.ok).toBe(false);
    expect(['CONFIRMATION_VERSION_MISMATCH', 'SESSION_VERSION_CONFLICT']).toContain(o.code);
    expect(disabledSpy).not.toHaveBeenCalled();
  });

  it('session-version protection: request built, session then changes → SESSION_VERSION_CONFLICT (old request rejected)', async () => {
    const sid = await awaiting();
    const r = req(sid);
    state.bump(sid);                                                            // any mutation after confirmation
    expect(await gw().execute(r, ctx())).toMatchObject({ ok: false, code: 'SESSION_VERSION_CONFLICT' });
    expect(state.getSession(sid).handoff).toBeUndefined();
  });

  it('concurrent change while a (slow, test) executor runs → result discarded, nothing synced', async () => {
    const sid = await awaiting();
    const slow = new TestBookingExecutorSlow();
    const g = gw({ registry: testRegistry(slow), config: parseExecutionConfig({ REAL_BOOKING_ENABLED: 'true', BOOKING_EXECUTOR: 'test-slow' }) });
    const p = g.execute(req(sid), ctx());
    await new Promise(res => setTimeout(res, 5));
    state.bump(sid);
    const o: any = await p;
    expect(slow.calls).toBe(1);
    expect(o).toMatchObject({ ok: false, code: 'SESSION_VERSION_CONFLICT' });
    const s = state.getSession(sid);
    expect(s.handoff).toBeUndefined();
    expect(s.bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
  });
});

describe('G2 — independent re-validation of booking data', () => {
  it('[13][14] stale availability / stale fare → STALE_AVAILABILITY / STALE_FARE; no handoff', async () => {
    const sid = await awaiting();
    const later = gw({ clock: () => Date.now() + 3 * 60_000 });                // availability older than 2 min
    expect(await later.execute(req(sid), ctx())).toMatchObject({ ok: false, code: 'STALE_AVAILABILITY' });
    const s = state.getSession(sid);
    (s.fare as any).travelClass = '2S';                                         // fare no longer belongs to selection
    expect(await gw().execute(req(sid), ctx())).toMatchObject({ ok: false, code: 'STALE_FARE' });
    expect(s.handoff).toBeUndefined();
    expect(disabledSpy).not.toHaveBeenCalled();
  });

  it('[15] invalid passenger details → INVALID_PASSENGER_DETAILS (validator re-run, request must equal session)', async () => {
    const sid = await awaiting();
    const g = gw();
    const forged = req(sid); forged.passengers[0] = { ...forged.passengers[0], name: 'Someone Else' };
    expect(await g.execute(forged, ctx())).toMatchObject({ ok: false, code: 'INVALID_PASSENGER_DETAILS' });
    state.getSession(sid).passengers[0].age = 0; reseal(sid);                  // earlier validation is NOT trusted
    expect(await g.execute(req(sid), ctx())).toMatchObject({ ok: false, code: 'INVALID_PASSENGER_DETAILS' });
  });

  it('[16] invalid train (number / resultId / date / route not matching current results) → INVALID_TRAIN', async () => {
    const sid = await awaiting();
    const g = gw();
    const a = req(sid); a.selectedTrain = { ...a.selectedTrain, trainNumber: '99999' };
    expect(await g.execute(a, ctx())).toMatchObject({ ok: false, code: 'INVALID_TRAIN' });
    const b = req(sid); b.selectedTrain = { ...b.selectedTrain, date: '2026-12-25' };
    expect(await g.execute(b, ctx())).toMatchObject({ ok: false, code: 'INVALID_TRAIN' });
    const s: any = state.getSession(sid);
    s.selectedTrain.resultId = 'old-search-id:1'; reseal(sid);                 // stale reference from an older search
    expect(await g.execute(req(sid), ctx())).toMatchObject({ ok: false, code: 'INVALID_TRAIN' });
  });

  it('[17] invalid class for the train → INVALID_CLASS', async () => {
    const sid = await awaiting();
    const g = gw();
    expect(await g.execute({ ...req(sid), selectedClass: 'SL' }, ctx())).toMatchObject({ ok: false, code: 'INVALID_CLASS' });
    state.getSession(sid).selectedClass = '1A'; reseal(sid);
    expect(await g.execute(req(sid), ctx())).toMatchObject({ ok: false, code: 'INVALID_CLASS' });
  });

  it('[24] request carries no credential fields; credential-like fields are rejected', async () => {
    const sid = await awaiting();
    const r = req(sid);
    expect(findSensitiveKeys(r)).toEqual([]);
    expect(Object.keys(r).sort()).toEqual(['confirmedAt', 'date', 'explicitConfirmation', 'idempotencyKey', 'journey', 'passengers', 'requestId', 'reviewVersion', 'selectedClass', 'selectedTrain', 'sessionId', 'sessionVersion']);
    for (const bad of [{ otp: '1' }, { irctcPassword: 'x' }, { payment: { cardNumber: '4111' } }, { upiPin: '1' }, { captcha: 'x' }]) {
      expect(await gw().execute({ ...r, ...bad } as any, ctx())).toMatchObject({ ok: false, code: 'INVALID_BOOKING_HANDOFF' });
    }
    expect(disabledSpy).not.toHaveBeenCalled();
  });
});

describe('G2 — handoff, idempotency, lifecycle, locked states, observability', () => {
  it('handoff snapshot is deep-frozen, built from authoritative data, expires with its railway data; [18] expired → EXPIRED', async () => {
    const sid = await awaiting();
    const g = gw();
    const o: any = await g.execute(req(sid), ctx());
    const s: any = state.getSession(sid);
    const h = s.handoff.snapshot;
    expect(Object.isFrozen(h) && Object.isFrozen(h.validatedPassengers[0]) && Object.isFrozen(h.selectedTrain)).toBe(true);
    expect(() => { h.selectedClass = '3A'; }).toThrow();
    expect(h).toMatchObject({ reviewVersion: 1, selectedClass: 'CC', date: s.date, realBooking: false,
      selectedTrain: { trainNumber: '12014', resultId: s.selectedTrain.resultId }, fareSnapshot: { total: s.fare.total, passengersCount: 2 },
      availabilitySnapshot: { status: s.availability.CC.status } });
    expect(h.validatedPassengers.map((p: any) => p.name)).toEqual(['Rahul Sharma', 'Neha Sharma']);
    expect(Date.parse(h.expiresAt)).toBeLessThanOrEqual(Date.parse(s.availability.CC.retrievedAt) + 2 * 60_000);
    const svc = new BookingHandoffService();
    expect(svc.check(s, Date.now())).toEqual({ status: 'READY' });
    expect(svc.check(s, Date.parse(h.expiresAt) + 1)).toMatchObject({ status: 'EXPIRED' });
    s.passengers[1].age = 29;                                                  // critical change
    expect(svc.check(s, Date.now())).toMatchObject({ status: 'INVALIDATED' });
    expect(o.handoff.status).toBe('READY');
    expect((svc as any).setStatus(s, 'CONSUMED', 'x', Date.now())).toBe(false);   // never CONSUMED in this milestone
    expect(s.handoff.status).toBe('READY');
  });

  it('[28] duplicate / concurrent confirmation → ONE handoff, executor invoked once', async () => {
    const sid = await awaiting();
    const g = gw();
    const r = req(sid);
    const [a, b]: any[] = await Promise.all([g.execute(r, ctx()), g.execute(r, ctx())]);
    const c: any = await g.execute({ ...r, requestId: 'req-2' }, ctx());
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(disabledSpy).toHaveBeenCalledTimes(1);
    expect(new Set([a.handoff.snapshot.handoffId, b.handoff.snapshot.handoffId, c.handoff.snapshot.handoffId]).size).toBe(1);
    expect([a.duplicate, b.duplicate, c.duplicate]).toEqual([false, true, true]);
    expect(state.getSession(sid).handoffHistory!.filter(x => x.status === 'READY')).toHaveLength(1);
  });

  it('lifecycle table + locked execution states (disabled executor never enters IN_PROGRESS / CONFIRMED)', () => {
    expect(canTransitionLifecycle('HANDOFF_CREATED', 'EXECUTION_DISABLED')).toBe(true);
    expect(canTransitionLifecycle('HANDOFF_CREATED', 'EXECUTION_STARTED')).toBe(false);          // locked in this milestone
    expect(canTransitionLifecycle('EXECUTION_STARTED', 'EXECUTION_SUCCESS')).toBe(false);
    expect(canTransitionLifecycle('PREPARING', 'HANDOFF_CREATED')).toBe(false);                  // no skipping
    expect(canTransitionLifecycle('EXECUTION_DISABLED', 'INVALIDATED')).toBe(true);
    expect(LIFECYCLE_TRANSITIONS.EXECUTION_SUCCESS).toEqual([]);
    for (const locked of EXECUTION_LOCKED_STATES) {
      expect(VALID_BOOKING_TRANSITIONS[locked]).toEqual([]);
      for (const from of [BookingState.AWAITING_CONFIRMATION, BookingState.IRCTC_HANDOFF_READY, BookingState.REVIEW]) {
        expect(stateTransitionValidator.canTransition(from, locked)).toBe(false);
      }
    }
  });

  it('observability: structured log with ids/capability/executor/status/latency/rejection — no passenger names', async () => {
    const sid = await awaiting();
    const g = gw();
    await g.execute({ ...req(sid), reviewVersion: 7 }, ctx());
    await g.execute(req(sid), ctx());
    const logs = g.executionLog(sid);
    expect(logs[0]).toMatchObject({ sessionId: sid, requestId: 'req-1', reviewVersion: 7, executionCapability: 'REAL_BOOKING_DISABLED', rejectionReason: 'CONFIRMATION_VERSION_MISMATCH' });
    expect(logs[1]).toMatchObject({ sessionId: sid, reviewVersion: 1, handoffStatus: 'READY', executorName: 'disabled', executionStatus: 'DISABLED', executionCapability: 'REAL_BOOKING_DISABLED' });
    expect(typeof logs[1].latencyMs).toBe('number');
    expect(logs[1].handoffId).toMatch(/^HO-/);
    expect(JSON.stringify(logs)).not.toMatch(/Rahul|Neha/);
  });
});
