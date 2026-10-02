/**
 * PROMPT 12 — GROUP 2
 * BookingProvider interface, registry, disabled provider, config, response schema,
 * error normalization, request building, idempotency, execution lock, state guards.
 * No real provider exists; TEST providers only via an explicit allowTestProviders registry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { BookingState, EXECUTION_TRANSITIONS } from '../../shared/states';
import { stateTransitionValidator } from '../../server/ai/state/state-transition-validator';
import { canTransitionLifecycle } from '../../server/booking/execution/booking-lifecycle';
import type { BookingProvider, ProviderCallOptions } from '../../server/booking/provider/booking-provider';
import { BookingProviderError, ProviderTimeoutError } from '../../server/booking/provider/booking-provider';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { BookingProviderRegistry, createProductionBookingProviderRegistry } from '../../server/booking/provider/booking-provider-registry';
import { parseBookingProviderConfig, type BookingProviderConfig } from '../../server/booking/provider/booking-provider-config';
import { validateProviderResult, validateStatusResult, validateCapabilities } from '../../server/booking/provider/provider-response-schema';
import { normalizeProviderError } from '../../server/booking/provider/provider-error-normalizer';
import { buildBookingProviderRequest } from '../../server/booking/provider/booking-provider-request';
import { BookingProviderExecutionService } from '../../server/booking/provider/booking-provider-execution-service';
import { markHandoffSessionSubmitted, BookingHandoffSessionService, HANDOFF_SESSION_TRANSITIONS } from '../../server/booking/handoff/booking-handoff-session-service';
import { findSensitiveFields } from '../../server/booking/handoff/sensitive-data-guard';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';

type Caps = ReturnType<BookingProvider['getCapabilities']>;
class TestBookingProvider implements BookingProvider {
  readonly kind = 'TEST' as const;
  calls = 0; statusCalls = 0; lastRequest: any;
  getBookingStatus?: (ref: string, o: ProviderCallOptions) => Promise<any>;
  constructor(readonly name: string, private caps: Partial<Caps>, private exec: (req: any) => Promise<any>, status?: (ref: string) => Promise<any>) {
    if (status) this.getBookingStatus = async (ref) => { this.statusCalls++; return status(ref); };
  }
  getCapabilities(): Caps {
    return { providerName: this.name, available: true, supportsBooking: true, supportsStatus: !!this.getBookingStatus, supportsCancellation: false, requiresExternalHandoff: false, supportsIdempotency: false, health: 'AVAILABLE', ...this.caps };
  }
  async executeBooking(req: any): Promise<any> { this.calls++; this.lastRequest = req; return this.exec(req); }
}
const enabledCfg = (provider: string, timeoutMs = 2000): BookingProviderConfig => ({ provider, enabled: true, timeoutMs, configErrors: [] });
const testRegistry = (...ps: BookingProvider[]) => { const r = new BookingProviderRegistry({ allowTestProviders: true }); ps.forEach(p => r.register(p)); return r; };

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const S = (sid: string): any => state.getSession(sid);
/** Production orchestrator (disabled provider) → READY handoff; the DISABLED record is then cleared so a
 *  separate service with a TEST registry sees a fresh, never-executed handoff. */
async function freshHandoff(): Promise<string> {
  state = new ConversationStateManager();
  orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
  const sid = state.createSession().sessionId;
  for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female', 'haan book karo']) await orch.processTurn(sid, t, 'TEXT');
  expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  expect(S(sid).bookingExecution).toMatchObject({ status: 'DISABLED', code: 'BOOKING_EXECUTION_DISABLED', submitted: false });
  S(sid).bookingExecution = undefined;
  return sid;
}
const ctx = (requestId = 'rq-g2') => ({ requestId, turnId: 't-g2', source: 'API' as const, emit: vi.fn() });

let disabledSpy: any, fetchSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('mock');
  disabledSpy = vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  expect(disabledSpy).not.toHaveBeenCalled();     // the disabled provider is never even invoked
  expect(fetchSpy).not.toHaveBeenCalled();        // no network in any test
  vi.restoreAllMocks();
});

describe('P12 G2 — interface, disabled provider, config', () => {
  it('[1] BookingProvider interface: disabled provider exposes only getCapabilities/executeBooking; honest capabilities', () => {
    const d = new DisabledBookingProvider();
    expect(d.name).toBe('disabled');
    expect(d.kind).toBe('DISABLED');
    expect((d as any).getBookingStatus).toBeUndefined();
    expect((d as any).checkHealth).toBeUndefined();
    expect(d.getCapabilities()).toEqual({ providerName: 'disabled', available: false, supportsBooking: false, supportsStatus: false, supportsCancellation: false, requiresExternalHandoff: false, supportsIdempotency: false, health: 'UNAVAILABLE', reason: 'BOOKING_PROVIDER_DISABLED' });
  });
  it('[2] config: default disabled; malformed → disabled; only "true" enables; no credential fields', () => {
    expect(parseBookingProviderConfig({})).toEqual({ provider: 'disabled', enabled: false, baseUrl: undefined, timeoutMs: 15000, configErrors: [] });
    expect(parseBookingProviderConfig({ BOOKING_PROVIDER: '  ' }).provider).toBe('disabled');
    const bad = parseBookingProviderConfig({ BOOKING_PROVIDER: 'IRCTC!!;rm', REAL_BOOKING_ENABLED: 'true' });
    expect(bad.provider).toBe('disabled'); expect(bad.configErrors).toContain('BOOKING_PROVIDER_INVALID');
    expect(parseBookingProviderConfig({ BOOKING_PROVIDER: 'Partner-X' }).provider).toBe('partner-x');
    for (const v of ['TRUE', '1', 'yes', ' true', '']) expect(parseBookingProviderConfig({ REAL_BOOKING_ENABLED: v }).enabled).toBe(false);
    expect(parseBookingProviderConfig({ REAL_BOOKING_ENABLED: 'true' }).enabled).toBe(true);
    expect(parseBookingProviderConfig({ BOOKING_PROVIDER_TIMEOUT_MS: '5' }).configErrors).toContain('BOOKING_PROVIDER_TIMEOUT_MS_INVALID');
    expect(parseBookingProviderConfig({ BOOKING_PROVIDER_TIMEOUT_MS: '8000' }).timeoutMs).toBe(8000);
    expect(parseBookingProviderConfig({ NODE_ENV: 'production', BOOKING_PROVIDER_BASE_URL: 'http://provider.example.invalid' }).configErrors).toContain('BOOKING_PROVIDER_BASE_URL_NOT_HTTPS');
    expect(parseBookingProviderConfig({ NODE_ENV: 'production', BOOKING_PROVIDER_BASE_URL: 'http://localhost:9000' }).configErrors).toContain('BOOKING_PROVIDER_BASE_URL_NOT_HTTPS');
    expect(parseBookingProviderConfig({ BOOKING_PROVIDER_BASE_URL: 'https://u:p@provider.example.invalid' }).configErrors).toContain('BOOKING_PROVIDER_BASE_URL_HAS_CREDENTIALS');
    expect(parseBookingProviderConfig({ BOOKING_PROVIDER_BASE_URL: 'https://provider.example.invalid/v1/' }).baseUrl).toBe('https://provider.example.invalid/v1');
    const keys = Object.keys(parseBookingProviderConfig({ IRCTC_USERNAME: 'x', IRCTC_PASSWORD: 'y', BOOKING_PROVIDER_API_KEY: 'z' } as any));
    expect(keys.sort()).toEqual(['baseUrl', 'configErrors', 'enabled', 'provider', 'timeoutMs']);
  });
});

describe('P12 G2 — registry & selection', () => {
  it('[3] production registry: only "disabled"; TEST providers rejected; DISABLED may not claim capabilities', () => {
    const prod = createProductionBookingProviderRegistry();
    expect(prod.names()).toEqual(['disabled']);
    expect(() => prod.register(new TestBookingProvider('test-a', {}, async () => ({ status: 'CONFIRMED', pnr: '1234567890' })))).toThrow(/not allowed/);
    const r = new BookingProviderRegistry({ allowTestProviders: true });
    expect(() => r.register(new TestBookingProvider('fake-a', {}, async () => ({})))).toThrow(/start with "test"/);
    expect(() => r.register(new DisabledBookingProvider())).toThrow(/already registered/);
    const liar: any = { name: 'liar', kind: 'DISABLED', getCapabilities: () => ({ ...new DisabledBookingProvider().getCapabilities(), providerName: 'liar', available: true }), executeBooking: async () => ({}) };
    expect(() => r.register(liar)).toThrow(/must not claim/);
    expect(() => r.register({ ...liar, kind: 'MAGIC' } as any)).toThrow();
  });
  it('[4] resolve: master switch off / config errors → disabled; unknown name → BOOKING_PROVIDER_UNKNOWN (no fallback)', () => {
    const prod = createProductionBookingProviderRegistry();
    const off = prod.resolve(parseBookingProviderConfig({ BOOKING_PROVIDER: 'irctc' }));
    expect(off).toMatchObject({ ok: true, effective: 'disabled', configured: 'irctc', masterSwitchOff: true });
    const errs = prod.resolve({ ...enabledCfg('irctc'), configErrors: ['BOOKING_PROVIDER_TIMEOUT_MS_INVALID'] });
    expect(errs).toMatchObject({ ok: true, effective: 'disabled', masterSwitchOff: true });
    const unk = prod.resolve(enabledCfg('irctc'));
    expect(unk).toMatchObject({ ok: false, code: 'BOOKING_PROVIDER_UNKNOWN', effective: 'irctc' });
    expect((unk as any).provider).toBeUndefined();                       // never falls back to another provider
    expect(unk.capabilities).toMatchObject({ available: false, supportsBooking: false, health: 'UNKNOWN' });
    const dis = prod.resolve(enabledCfg('disabled'));
    expect(dis).toMatchObject({ ok: true, effective: 'disabled', masterSwitchOff: false });
    expect((dis as any).provider.kind).toBe('DISABLED');
  });
  it('[5] capability validation: malformed / throwing / name-mismatched capabilities → UNAVAILABLE', () => {
    const bad1: any = new TestBookingProvider('test-bad1', {}, async () => ({})); bad1.getCapabilities = () => ({ providerName: 'test-bad1', available: true });
    const bad2: any = new TestBookingProvider('test-bad2', {}, async () => ({})); bad2.getCapabilities = () => { throw new Error('boom'); };
    const bad3: any = new TestBookingProvider('test-bad3', { providerName: 'someone-else' } as any, async () => ({}));
    const bad4: any = new TestBookingProvider('test-bad4', { health: 'GREAT' } as any, async () => ({}));
    const r = testRegistry(bad1, bad2, bad3, bad4);
    for (const n of ['test-bad1', 'test-bad2', 'test-bad3', 'test-bad4']) expect(r.resolve(enabledCfg(n))).toMatchObject({ ok: false, code: 'BOOKING_PROVIDER_UNAVAILABLE' });
    expect(validateCapabilities(new DisabledBookingProvider().getCapabilities(), 'disabled').ok).toBe(true);
  });
});

describe('P12 G2 — response schema & error normalization', () => {
  it('[6] strict provider result schema: PNR only with CONFIRMED + 10 digits; no unknown keys; no HTTP-200 success', () => {
    expect(validateProviderResult({ status: 'CONFIRMED', pnr: '1234567890', providerReference: 'REF-1' })).toEqual({ ok: true, value: { status: 'CONFIRMED', pnr: '1234567890', providerReference: 'REF-1' } });
    expect(validateProviderResult({ status: 'CONFIRMED', providerReference: 'REF-1', message: 'ok' })).toEqual({ ok: true, value: { status: 'CONFIRMED', providerReference: 'REF-1' } }); // message dropped
    const invalid: any[] = [
      null, undefined, 'CONFIRMED', 200, [], { status: 200 }, { status: 'OK' }, { status: 'SUCCESS', pnr: '1234567890' }, { ok: true },
      { status: 'CONFIRMED' }, { status: 'CONFIRMED', pnr: 'ABC1234567' }, { status: 'CONFIRMED', pnr: '123456789' }, { status: 'CONFIRMED', pnr: 1234567890 },
      { status: 'ACCEPTED', pnr: '1234567890' }, { status: 'IN_PROGRESS', pnr: '1234567890' }, { status: 'FAILED', pnr: '1234567890' },
      { status: 'CONFIRMED', pnr: '1234567890', seat: 'S1-23' }, { status: 'CONFIRMED', pnr: '1234567890', token: 'abc' },
      { status: 'CONFIRMED', providerReference: 'has space' }, { status: 'FAILED', failureCode: 'lower case' }, { status: 'CONFIRMED', providerReference: 'x'.repeat(80) }
    ];
    for (const raw of invalid) expect(validateProviderResult(raw)).toMatchObject({ ok: false, code: 'INVALID_PROVIDER_RESPONSE' });
    expect(validateStatusResult({ status: 'CANCELLED', providerReference: 'REF-1' }).ok).toBe(true);
    expect(validateStatusResult({ status: 'CONFIRMED', pnr: '1234567890' }).ok).toBe(true);
    expect(validateStatusResult({ status: 'PENDING', pnr: '1234567890' }).ok).toBe(false);
    expect(validateStatusResult({ status: 'DONE' }).ok).toBe(false);
  });
  it('[7] error normalization: categories only, uncertain vs definitely-not-submitted, no raw message', () => {
    const cases: Array<[unknown, string, string, boolean]> = [
      [new ProviderTimeoutError(), 'PROVIDER_TIMEOUT', 'BOOKING_PROVIDER_TIMEOUT', false],
      [Object.assign(new Error('x'), { name: 'AbortError' }), 'PROVIDER_TIMEOUT', 'BOOKING_PROVIDER_TIMEOUT', false],
      [new BookingProviderError('PROVIDER_UNKNOWN_ERROR', 401), 'PROVIDER_AUTH_FAILED', 'BOOKING_PROVIDER_AUTH_FAILED', true],
      [new BookingProviderError('PROVIDER_UNKNOWN_ERROR', 403), 'PROVIDER_AUTH_FAILED', 'BOOKING_PROVIDER_AUTH_FAILED', true],
      [new BookingProviderError('PROVIDER_UNKNOWN_ERROR', 429), 'PROVIDER_RATE_LIMITED', 'BOOKING_PROVIDER_UNAVAILABLE', true],
      [new BookingProviderError('PROVIDER_UNKNOWN_ERROR', 422), 'PROVIDER_VALIDATION_FAILED', 'BOOKING_PROVIDER_VALIDATION_FAILED', true],
      [new BookingProviderError('PROVIDER_UNKNOWN_ERROR', 409), 'PROVIDER_REJECTED', 'BOOKING_PROVIDER_REJECTED', true],
      [new BookingProviderError('PROVIDER_UNKNOWN_ERROR', 503), 'PROVIDER_UNAVAILABLE', 'BOOKING_PROVIDER_UNAVAILABLE', false],
      [new BookingProviderError('PROVIDER_UNKNOWN_ERROR', 504), 'PROVIDER_TIMEOUT', 'BOOKING_PROVIDER_TIMEOUT', false],
      [new BookingProviderError('NETWORK_NOT_SENT'), 'PROVIDER_UNAVAILABLE', 'BOOKING_PROVIDER_UNAVAILABLE', true],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'PROVIDER_UNAVAILABLE', 'BOOKING_PROVIDER_UNAVAILABLE', true],
      [new Error('Authorization: Bearer sk-live-SECRET'), 'PROVIDER_UNKNOWN_ERROR', 'BOOKING_STATUS_UNKNOWN', false],
      ['weird', 'PROVIDER_UNKNOWN_ERROR', 'BOOKING_STATUS_UNKNOWN', false]
    ];
    for (const [e, fc, code, notSent] of cases) {
      const n = normalizeProviderError(e);
      expect(n).toEqual({ failureCode: fc, code, definitelyNotSubmitted: notSent });
      expect(JSON.stringify(n)).not.toMatch(/SECRET|Bearer|fetch failed/);
    }
  });
});

describe('P12 G2 — request, idempotency, lock, execution service', () => {
  it('[8] request is built only from the handoff snapshot; idempotency key only when supported; frozen; credential-free', async () => {
    const sid = await freshHandoff();
    const s = S(sid), snap = s.handoffSession.bookingSnapshot;
    const without = buildBookingProviderRequest(s, 'rq-1', { includeIdempotencyKey: false })!;
    expect(Object.keys(without).sort()).toEqual(['availabilitySnapshot', 'date', 'fareSnapshot', 'handoffId', 'journey', 'passengers', 'requestId', 'train', 'travelClass']);
    expect(without).toMatchObject({ requestId: 'rq-1', handoffId: s.handoff.snapshot.handoffId, journey: snap.journey, date: snap.date, travelClass: 'CC', passengers: snap.passengers, fareSnapshot: snap.fareSnapshot });
    const withKey = buildBookingProviderRequest(s, 'rq-1', { includeIdempotencyKey: true })!;
    expect(withKey.idempotencyKey).toBe(s.handoffSession.idempotencyKey);
    expect(Object.isFrozen(withKey) && Object.isFrozen(withKey.passengers[0])).toBe(true);
    expect(findSensitiveFields(withKey)).toEqual([]);
    expect(buildBookingProviderRequest({ ...s, handoffSession: undefined }, 'rq', { includeIdempotencyKey: true })).toBeNull();
  });
  it('[9] disabled (default service) → BOOKING_EXECUTION_DISABLED; enabled+"disabled" → BOOKING_PROVIDER_DISABLED; state unchanged', async () => {
    const sid = await freshHandoff();
    const v0 = S(sid).sessionVersion;
    const svc = new BookingProviderExecutionService(state);
    const c = ctx();
    const o = await svc.execute(sid, c);
    expect(o).toMatchObject({ code: 'BOOKING_EXECUTION_DISABLED', providerCalled: false, duplicate: false });
    expect(o.record).toMatchObject({ status: 'DISABLED', providerName: 'disabled', submitted: false });
    expect(c.emit.mock.calls.map((x: any) => x[0])).toEqual(['BOOKING_PROVIDER_SELECTED', 'BOOKING_PROVIDER_UNAVAILABLE']);
    expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(S(sid).handoffSession.status).toBe('READY');
    expect(S(sid).sessionVersion).toBe(v0);
    expect((await svc.execute(sid, ctx())).code).toBe('BOOKING_EXECUTION_DUPLICATE');
    S(sid).bookingExecution = undefined;
    const svc2 = new BookingProviderExecutionService(state, { config: enabledCfg('disabled') });
    expect((await svc2.execute(sid, ctx())).code).toBe('BOOKING_PROVIDER_DISABLED');
  });
  it('[10] idempotency: key sent only if supported; same handoff never submitted twice', async () => {
    const sid = await freshHandoff();
    const p = new TestBookingProvider('test-idem', { supportsIdempotency: true }, async () => ({ status: 'CONFIRMED', providerReference: 'REF-77', pnr: '4512345678' }));
    const svc = new BookingProviderExecutionService(state, { registry: testRegistry(p), config: enabledCfg('test-idem') });
    const o1 = await svc.execute(sid, ctx('rq-a'));
    expect(o1.code).toBe('BOOKING_CONFIRMED');
    expect(p.lastRequest.idempotencyKey).toBe(S(sid).handoffSession.idempotencyKey);
    const o2 = await svc.execute(sid, ctx('rq-b'));
    expect(o2).toMatchObject({ code: 'BOOKING_EXECUTION_DUPLICATE', duplicate: true, providerCalled: false });
    expect(o2.record!.bookingExecutionId).toBe(o1.record!.bookingExecutionId);
    expect(p.calls).toBe(1);
    const sid2 = await freshHandoff();
    const q = new TestBookingProvider('test-noidem', { supportsIdempotency: false }, async () => ({ status: 'IN_PROGRESS', providerReference: 'REF-8' }));
    await new BookingProviderExecutionService(state, { registry: testRegistry(q), config: enabledCfg('test-noidem') }).execute(sid2, ctx());
    expect('idempotencyKey' in q.lastRequest).toBe(false);                 // never pretends idempotency
  });
  it('[11] execution lock: concurrent requests for the same session+handoff → one submission, others LOCKED', async () => {
    const sid = await freshHandoff();
    let release!: (v: any) => void;
    const p = new TestBookingProvider('test-slow', {}, () => new Promise(r => { release = r; }));
    const svc = new BookingProviderExecutionService(state, { registry: testRegistry(p), config: enabledCfg('test-slow') });
    const first = svc.execute(sid, ctx('rq-1'));
    await new Promise(r => setTimeout(r, 5));
    expect(svc.isLocked(sid, S(sid).handoff.snapshot.handoffId)).toBe(true);
    const [b, c] = await Promise.all([svc.execute(sid, ctx('rq-2')), svc.execute(sid, ctx('rq-3'))]);
    expect(b).toMatchObject({ code: 'BOOKING_EXECUTION_LOCKED', providerCalled: false });
    expect(c).toMatchObject({ code: 'BOOKING_EXECUTION_LOCKED', providerCalled: false });
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_EXECUTION_REQUESTED);
    release({ status: 'CONFIRMED', providerReference: 'REF-9', pnr: '2212345678' });
    expect((await first).code).toBe('BOOKING_CONFIRMED');
    expect((await svc.execute(sid, ctx('rq-4'))).code).toBe('BOOKING_EXECUTION_DUPLICATE');
    expect(p.calls).toBe(1);
    expect(svc.executionLog(sid).map(l => l.code)).toEqual(['BOOKING_EXECUTION_LOCKED', 'BOOKING_EXECUTION_LOCKED', 'BOOKING_CONFIRMED', 'BOOKING_EXECUTION_DUPLICATE']);
  });
  it('[12] execution states: generic path still locked; provider path needs a matching record and CONFIRMED evidence', async () => {
    for (const to of [BookingState.BOOKING_EXECUTION_REQUESTED, BookingState.BOOKING_IN_PROGRESS, BookingState.BOOKING_CONFIRMED, BookingState.BOOKING_FAILED]) {
      expect(stateTransitionValidator.check(BookingState.IRCTC_HANDOFF_READY, to).ok).toBe(false);
    }
    expect(stateTransitionValidator.checkExecution(BookingState.IRCTC_HANDOFF_READY, BookingState.BOOKING_CONFIRMED).ok).toBe(false);
    expect(stateTransitionValidator.checkExecution(BookingState.AWAITING_CONFIRMATION, BookingState.BOOKING_EXECUTION_REQUESTED).ok).toBe(false);
    expect(EXECUTION_TRANSITIONS[BookingState.BOOKING_CONFIRMED]).toBeUndefined();          // terminal
    const sid = await freshHandoff();
    expect(state.applyProviderExecutionState(sid, BookingState.BOOKING_EXECUTION_REQUESTED, { bookingExecutionId: 'bx_forged', providerName: 'x' }).ok).toBe(false);
    S(sid).bookingExecution = { bookingExecutionId: 'bx_1', providerName: 'test', status: 'SUBMITTING' };
    expect(state.applyProviderExecutionState(sid, BookingState.BOOKING_EXECUTION_REQUESTED, { bookingExecutionId: 'bx_1', providerName: 'test' }).ok).toBe(true);
    expect(state.applyProviderExecutionState(sid, BookingState.BOOKING_CONFIRMED, { bookingExecutionId: 'bx_1', providerName: 'test', providerStatus: 'ACCEPTED' }).ok).toBe(false);
    expect(state.tryTransition(sid, BookingState.REVIEW).ok).toBe(false);                    // no rewind out of execution
    expect(canTransitionLifecycle('EXECUTION_DISABLED', 'EXECUTION_STARTED')).toBe(false);
    expect(canTransitionLifecycle('EXECUTION_DISABLED', 'EXECUTION_STARTED', { providerAuthorized: true })).toBe(true);
  });
  it('[13] handoff session consumption only via the provider path; LLM has no booking tool', async () => {
    const sid = await freshHandoff();
    expect(HANDOFF_SESSION_TRANSITIONS.READY).not.toContain('CONSUMED');
    expect(new BookingHandoffSessionService().setStatus(S(sid), 'CONSUMED' as any, 'x', Date.now())).toBe(false);
    expect(markHandoffSessionSubmitted(S(sid), '', Date.now())).toBe(false);
    expect(markHandoffSessionSubmitted(S(sid), 'bx_1', Date.now())).toBe(true);
    expect(S(sid).handoffSession).toMatchObject({ status: 'CONSUMED', executionAttempts: 1 });
    expect(markHandoffSessionSubmitted(S(sid), 'bx_2', Date.now())).toBe(false);
    expect(REGISTERED_TOOLS.map((t: any) => t.name).sort()).toEqual(['CHECK_AVAILABILITY', 'GET_FARE', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'SEARCH_TRAINS']);
  });
});
