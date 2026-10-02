/**
 * PROMPT 12 — GROUP 3
 * End-to-end: User → Orchestrator → LLM → Railway tools → BookingSession → Review →
 * Confirmation → BookingExecutionGateway → BookingHandoff → BookingHandoffSession →
 * BookingProviderRegistry → (disabled provider | TEST providers in an explicit test registry).
 *
 * afterEach: no fetch, IrctcHandoffAdapter.executeHandoff never called,
 * DisabledBookingProvider.executeBooking never called, DisabledBookingExecutorAdapter.execute never called.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator, type OrchestratorOptions } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { BookingState } from '../../shared/states';
import { DisabledBookingExecutorAdapter } from '../../server/booking/handoff/disabled-booking-executor-adapter';
import { HANDOFF_READY_MESSAGE } from '../../server/booking/booking-preparation-service';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { findSensitiveFields } from '../../server/booking/handoff/sensitive-data-guard';
import type { BookingProvider, ProviderCallOptions } from '../../server/booking/provider/booking-provider';
import { BookingProviderError } from '../../server/booking/provider/booking-provider';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { BookingProviderRegistry, createProductionBookingProviderRegistry } from '../../server/booking/provider/booking-provider-registry';
import { parseBookingProviderConfig, type BookingProviderConfig } from '../../server/booking/provider/booking-provider-config';
import { BookingProviderExecutionService, bookingExecutionView, PROVIDER_CONFIRMED_MESSAGE, EXTERNAL_HANDOFF_MESSAGE, PROVIDER_UNAVAILABLE_MESSAGE, STATUS_UNKNOWN_MESSAGE } from '../../server/booking/provider/booking-provider-execution-service';

type Caps = ReturnType<BookingProvider['getCapabilities']>;
class TestBookingProvider implements BookingProvider {
  readonly kind = 'TEST' as const;
  calls = 0; statusCalls = 0; lastRequest: any; started?: () => void;
  getBookingStatus?: (ref: string, o: ProviderCallOptions) => Promise<any>;
  checkHealth?: (o: ProviderCallOptions) => Promise<any>;
  constructor(readonly name: string, private caps: Partial<Caps>, private exec: (req: any) => Promise<any>, opts: { status?: (ref: string) => Promise<any>; health?: () => Promise<any> } = {}) {
    if (opts.status) this.getBookingStatus = async (ref) => { this.statusCalls++; return opts.status!(ref); };
    if (opts.health) this.checkHealth = async () => opts.health!();
  }
  getCapabilities(): Caps {
    return { providerName: this.name, available: true, supportsBooking: true, supportsStatus: !!this.getBookingStatus, supportsCancellation: false, requiresExternalHandoff: false, supportsIdempotency: false, health: 'AVAILABLE', ...this.caps };
  }
  async executeBooking(req: any): Promise<any> { this.calls++; this.lastRequest = req; this.started?.(); return this.exec(req); }
}
const enabledCfg = (provider: string, timeoutMs = 2000): BookingProviderConfig => ({ provider, enabled: true, timeoutMs, configErrors: [] });
const reg = (...ps: BookingProvider[]) => { const r = new BookingProviderRegistry({ allowTestProviders: true }); ps.forEach(p => r.register(p)); return r; };
const withProvider = (p: TestBookingProvider, timeoutMs = 2000): OrchestratorOptions => ({ bookingProviderRegistry: reg(p), bookingProviderConfig: enabledCfg(p.name, timeoutMs) });

class SpyLLM extends MockLLMProvider {
  contexts: string[] = []; toolNames: string[][] = []; evil = false;
  async generateStructuredDecision(input: any): Promise<any> {
    this.contexts.push(JSON.stringify(input.context ?? {}));
    this.toolNames.push((input.tools || []).map((t: any) => t.name));
    const r: any = await super.generateStructuredDecision(input);
    if (this.evil && !(input.currentTurnToolResults || []).length) {
      r.decision = { ...r.decision, toolCalls: [{ callId: 'evil-1', name: 'BOOK_TICKET', arguments: { pnr: '1234567890' } }, { callId: 'evil-2', name: 'EXECUTE_BOOKING', arguments: {} }], finalMessage: undefined };
    }
    return r;
  }
}

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const mk = (opts: OrchestratorOptions = {}, llm: MockLLMProvider = new MockLLMProvider()) => { state = new ConversationStateManager(); orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService(), opts); };
const say = (sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT'): Promise<any> => orch.processTurn(sid, text, mode);
const S = (sid: string): any => state.getSession(sid);
const pctx = (): any => ({ turnId: 't-g3', mode: 'TEXT', cards: [], events: [], changes: [], requestId: 'rq-g3' });
const FAKE_SUCCESS = /ticket (book ho gaya|booked)|booking (successful|confirmed|ho gayi)|PNR generated|seat (no|number)\s*\d/i;
/** An actual REQUEST for a secret (a refusal like "main kabhi OTP nahi maangta" is fine). */
const SENSITIVE_ASK = /(otp|captcha|cvv|upi pin|card number|password)[^.?!]*\b(batayein|bataiye|bhejein|bhejiye|dijiye|enter karein|share karein|type karein)\b/i;

async function toAwaiting(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  await say(sid, 'Amritsar se Delhi kal 2 log', mode);
  await say(sid, '12497', mode);
  await say(sid, 'CC', mode);
  const r = await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female', mode);
  expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
}
async function confirm(sid: string, mode: 'TEXT' | 'VOICE' = 'TEXT') { await toAwaiting(sid, mode); return say(sid, 'haan book karo', mode); }
const newSid = () => state.createSession().sessionId;
/** READY handoff with the production (disabled) path, then a separate service with a TEST registry (fresh record). */
async function freshService(p: TestBookingProvider, clock?: () => number) {
  mk();
  const sid = newSid();
  const r = await confirm(sid);
  expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  S(sid).bookingExecution = undefined;
  return { sid, svc: new BookingProviderExecutionService(state, { registry: reg(p), config: enabledCfg(p.name), clock }) };
}
const xctx = (rq = 'rq-x') => ({ requestId: rq, turnId: 't-x', source: 'API' as const });
const extendExpiry = (sid: string) => {
  const s = S(sid), far = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();
  s.handoff.snapshot = { ...s.handoff.snapshot, expiresAt: far };
  s.handoffSession = { ...s.handoffSession, expiresAt: far };
};

let executeSpy: any, fetchSpy: any, adapterSpy: any, disabledProviderSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('mock');
  mk();
  executeSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  adapterSpy = vi.spyOn(DisabledBookingExecutorAdapter.prototype, 'execute');
  disabledProviderSpy = vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking');
});
afterEach(() => {
  expect(executeSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(adapterSpy).not.toHaveBeenCalled();
  expect(disabledProviderSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('P12 G3 — LLM boundary', () => {
  it('[1] railway INFORMATION tools are called by the LLM directly (via the tool runtime)', async () => {
    const llm = new SpyLLM(); mk({}, llm);
    const sid = newSid();
    const r = await say(sid, 'Amritsar se Delhi kal 2 log');
    expect((r.turnLog.toolExecuted || []).some((t: any) => t.name === 'SEARCH_TRAINS')).toBe(true);
    await say(sid, '12497');
    await say(sid, 'CC');                                              // availability/fare: deterministic prep via the same tool runtime
    expect(S(sid).availability?.CC).toBeTruthy();
    expect(S(sid).fare).toBeTruthy();
    expect(new Set(llm.toolNames.flat())).toEqual(new Set(['SEARCH_TRAINS', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE']));
  });
  it('[2] booking is NOT callable by the LLM: no tool, BOOK_TICKET rejected, provider untouched', async () => {
    const p = new TestBookingProvider('test-ext', {}, async () => ({ status: 'REQUIRES_EXTERNAL_HANDOFF' }));
    const llm = new SpyLLM(); mk(withProvider(p), llm);
    const sid = newSid();
    await confirm(sid);
    expect(p.calls).toBe(1);                                           // backend confirmation path only
    llm.evil = true;
    const before = JSON.stringify(S(sid).bookingExecution);
    const r = await say(sid, 'ticket book kar do abhi');
    llm.evil = false;
    expect(p.calls).toBe(1);
    expect(JSON.stringify(S(sid).bookingExecution)).toBe(before);
    expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(JSON.stringify(r.turnLog)).not.toMatch(/"toolResultStatus":"ok".*BOOK_TICKET/);
    expect(REGISTERED_TOOLS.some((t: any) => /BOOK|EXECUTE|PNR|PAY|CANCEL/i.test(t.name))).toBe(false);
    expect(llm.toolNames.flat().some(n => /BOOK|EXECUTE/i.test(n))).toBe(false);
  });
});

describe('P12 G3 — provider selection (production registry)', () => {
  it('[3] disabled provider (default): handoff stays final, nothing sent, honest message', async () => {
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(r.events.slice(-3)).toEqual(['IRCTC_HANDOFF_READY', 'BOOKING_PROVIDER_SELECTED', 'BOOKING_PROVIDER_UNAVAILABLE']);
    expect(r.events).not.toContain('BOOKING_EXECUTION_STARTED');
    expect(S(sid).bookingExecution).toMatchObject({ providerName: 'disabled', status: 'DISABLED', code: 'BOOKING_EXECUTION_DISABLED', submitted: false });
    expect(S(sid).handoffSession.status).toBe('READY');
    expect(r.responseMessage).toContain(HANDOFF_READY_MESSAGE);
    const card = r.cards.find((c: any) => c.type === 'handoff').data;
    expect(card.bookingExecution).toMatchObject({ code: 'BOOKING_EXECUTION_DISABLED', providerCalled: false, provider: { providerName: 'disabled', available: false, health: 'UNAVAILABLE' } });
    expect(card.realBooking).toBe(false);
    const api = await orch.preparation.executeBookingProvider(sid, pctx());
    expect(api).toMatchObject({ code: 'BOOKING_EXECUTION_DUPLICATE', providerCalled: false });
  });
  it('[4] missing provider config → disabled (never anything else)', async () => {
    mk({ bookingProviderRegistry: createProductionBookingProviderRegistry(), bookingProviderConfig: parseBookingProviderConfig({ REAL_BOOKING_ENABLED: 'true' }) });
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(S(sid).bookingExecution).toMatchObject({ providerName: 'disabled', code: 'BOOKING_PROVIDER_DISABLED', status: 'DISABLED' });
    expect(r.responseMessage).toContain('Automatic booking provider abhi available nahi hai.');
  });
  it('[5] unknown provider → BOOKING_PROVIDER_UNKNOWN, no fallback', async () => {
    mk({ bookingProviderRegistry: createProductionBookingProviderRegistry(), bookingProviderConfig: parseBookingProviderConfig({ REAL_BOOKING_ENABLED: 'true', BOOKING_PROVIDER: 'irctc' }) });
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(S(sid).bookingExecution).toMatchObject({ providerName: 'irctc', code: 'BOOKING_PROVIDER_UNKNOWN', status: 'UNAVAILABLE', submitted: false });
    expect(r.responseMessage).toContain(PROVIDER_UNAVAILABLE_MESSAGE);
    expect(orch.gateway.bookingProviders.providerStatus()).toMatchObject({ configured: 'irctc', resolved: false, code: 'BOOKING_PROVIDER_UNKNOWN' });
  });
  it('[6] capability validation: unsupported / unavailable / health UNKNOWN → provider never called', async () => {
    const variants: Array<[Partial<Caps>, any]> = [
      [{ supportsBooking: false }, undefined], [{ available: false }, undefined], [{ health: 'UNKNOWN' }, undefined], [{ health: 'UNAVAILABLE' }, undefined],
      [{}, async () => 'UNKNOWN'], [{}, async () => { throw new Error('down'); }], [{}, async () => 'healthy']
    ];
    for (const [caps, health] of variants) {
      const p = new TestBookingProvider('test-cap', caps, async () => ({ status: 'CONFIRMED', pnr: '1234567890' }), { health });
      mk(withProvider(p));
      const sid = newSid();
      const r = await confirm(sid);
      expect(p.calls).toBe(0);
      expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
      expect(S(sid).bookingExecution).toMatchObject({ status: 'UNAVAILABLE', code: 'BOOKING_PROVIDER_UNAVAILABLE', submitted: false });
    }
    const ok = new TestBookingProvider('test-cap', { health: 'UNKNOWN' }, async () => ({ status: 'CONFIRMED', providerReference: 'R1', pnr: '1234567890' }), { health: async () => 'AVAILABLE' });
    mk(withProvider(ok));
    const sid = newSid();
    expect((await confirm(sid)).newState).toBe(BookingState.BOOKING_CONFIRMED);   // a REAL health check result only
  });
});

describe('P12 G3 — provider responses', () => {
  it('[7] invalid response → UNKNOWN, no PNR, never CONFIRMED, retry blocked', async () => {
    const p = new TestBookingProvider('test-bad', {}, async () => ({ status: 'SUCCESS', pnr: '1234567890', http: 200 }));
    mk(withProvider(p));
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_EXECUTION_REQUESTED);
    expect(S(sid).bookingExecution).toMatchObject({ status: 'UNKNOWN', code: 'INVALID_PROVIDER_RESPONSE', failureCode: 'INVALID_PROVIDER_RESPONSE', retryBlocked: true });
    expect(S(sid).bookingExecution.pnr).toBeUndefined();
    expect(r.responseMessage).toContain(STATUS_UNKNOWN_MESSAGE);
    const again = await orch.preparation.executeBookingProvider(sid, pctx());
    expect(again).toMatchObject({ code: 'BOOKING_RETRY_BLOCKED', manualVerificationRequired: true, detail: 'MANUAL_PROVIDER_VERIFICATION_REQUIRED' });
    expect(p.calls).toBe(1);
  });
  it('[8] timeout → BOOKING_STATUS_UNKNOWN (no resubmission); with status support → one status check', async () => {
    const p = new TestBookingProvider('test-slow', {}, () => new Promise(() => { /* never resolves */ }));
    mk(withProvider(p, 50));
    const sid = newSid();
    const r = await confirm(sid);
    expect(S(sid).bookingExecution).toMatchObject({ status: 'UNKNOWN', failureCode: 'PROVIDER_TIMEOUT', code: 'BOOKING_STATUS_UNKNOWN', retryBlocked: true });
    expect(r.newState).toBe(BookingState.BOOKING_EXECUTION_REQUESTED);
    expect(r.events).toContain('BOOKING_STATUS_UNKNOWN');
    expect((await orch.preparation.executeBookingProvider(sid, pctx())).code).toBe('BOOKING_RETRY_BLOCKED');
    const locked = await say(sid, 'haan book karo');
    expect(locked.error?.code).toBe('BOOKING_EXECUTION_LOCKED');
    expect(p.calls).toBe(1);
    const q = new TestBookingProvider('test-slow2', { supportsIdempotency: true }, () => new Promise(() => {}), { status: async () => ({ status: 'CONFIRMED', providerReference: 'REF-T', pnr: '8812345678' }) });
    mk(withProvider(q, 50));
    const sid2 = newSid();
    const r2 = await confirm(sid2);
    expect(r2.newState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(S(sid2).bookingExecution).toMatchObject({ status: 'CONFIRMED', pnr: '8812345678' });
    expect([q.calls, q.statusCalls]).toEqual([1, 1]);
  });
  it('[9] rejection → BOOKING_FAILED with failureCode, safe reference and timestamp; auth failure too', async () => {
    const p = new TestBookingProvider('test-rej', {}, async () => ({ status: 'FAILED', failureCode: 'NO_SEATS', providerReference: 'REF-F1' }));
    mk(withProvider(p));
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_FAILED);
    expect(S(sid).bookingExecution).toMatchObject({ status: 'FAILED', code: 'BOOKING_PROVIDER_REJECTED', failureCode: 'NO_SEATS', providerReference: 'REF-F1' });
    expect(Date.parse(S(sid).bookingExecution.updatedAt)).toBeGreaterThan(0);
    expect(S(sid).bookingExecution.pnr).toBeUndefined();
    expect(r.events).toContain('BOOKING_FAILED');
    const a = new TestBookingProvider('test-auth', {}, async () => { throw new BookingProviderError('PROVIDER_UNKNOWN_ERROR', 401, 'invalid api key sk-XYZ'); });
    mk(withProvider(a));
    const sid2 = newSid();
    expect((await confirm(sid2)).newState).toBe(BookingState.BOOKING_FAILED);
    expect(S(sid2).bookingExecution).toMatchObject({ status: 'FAILED', code: 'BOOKING_PROVIDER_AUTH_FAILED', failureCode: 'PROVIDER_AUTH_FAILED' });
  });
  it('[10] provider unavailable → back to IRCTC_HANDOFF_READY, nothing booked', async () => {
    for (const exec of [async () => ({ status: 'UNAVAILABLE' }), async () => { throw new BookingProviderError('NETWORK_NOT_SENT'); }]) {
      const p = new TestBookingProvider('test-unav', {}, exec);
      mk(withProvider(p));
      const sid = newSid();
      const r = await confirm(sid);
      expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
      expect(S(sid).bookingExecution).toMatchObject({ status: 'UNAVAILABLE', code: 'BOOKING_PROVIDER_UNAVAILABLE' });
      expect(r.responseMessage).toContain(PROVIDER_UNAVAILABLE_MESSAGE);
      expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
    }
  });
  it('[11] external handoff → honest message, never claims a ticket', async () => {
    const p = new TestBookingProvider('test-ext', {}, async () => ({ status: 'REQUIRES_EXTERNAL_HANDOFF' }));
    mk(withProvider(p));
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(r.events).toContain('BOOKING_REQUIRES_EXTERNAL_HANDOFF');
    expect(r.responseMessage).toContain(EXTERNAL_HANDOFF_MESSAGE);
    expect(r.responseMessage).not.toMatch(FAKE_SUCCESS);
    const dup = await say(sid, 'haan book karo');
    expect(dup.error?.code).toBe('BOOKING_EXECUTION_DUPLICATE');
    expect(p.calls).toBe(1);
    const capOnly = new TestBookingProvider('test-ext2', { supportsBooking: false, requiresExternalHandoff: true }, async () => ({ status: 'CONFIRMED', pnr: '1234567890' }));
    mk(withProvider(capOnly));
    const sid2 = newSid();
    expect((await confirm(sid2)).newState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(S(sid2).bookingExecution).toMatchObject({ status: 'REQUIRES_EXTERNAL_HANDOFF', submitted: false });
    expect(capOnly.calls).toBe(0);
  });
});

describe('P12 G3 — duplicates, concurrency, idempotency', () => {
  it('[12] duplicate execution (text, API, repeated confirmation) returns the existing state', async () => {
    const p = new TestBookingProvider('test-ok', {}, async () => ({ status: 'CONFIRMED', providerReference: 'REF-OK', pnr: '6612345678' }));
    mk(withProvider(p));
    const sid = newSid();
    await confirm(sid);
    const id = S(sid).bookingExecution.bookingExecutionId;
    const t2 = await say(sid, 'haan book karo');
    expect(t2.error?.code).toBe('BOOKING_EXECUTION_LOCKED');
    expect(t2.newState).toBe(BookingState.BOOKING_CONFIRMED);
    const api = await orch.preparation.executeBookingProvider(sid, pctx());
    expect(api).toMatchObject({ code: 'BOOKING_EXECUTION_DUPLICATE', duplicate: true, providerCalled: false });
    expect(api.record!.bookingExecutionId).toBe(id);
    const edit = await say(sid, 'Neha ki age 29 kar do');
    expect(edit.error?.code).toBe('BOOKING_EXECUTION_LOCKED');
    expect(S(sid).passengers[1].age).toBe(28);
    expect(p.calls).toBe(1);
  });
  it('[13] concurrent execution (turn + API + second turn while in flight) → a single submission', async () => {
    let release!: (v: any) => void; let started!: () => void;
    const startedP = new Promise<void>(r => { started = r; });
    const p = new TestBookingProvider('test-conc', {}, () => new Promise(r => { release = r; }));
    p.started = () => started();
    mk(withProvider(p));
    const sid = newSid();
    await toAwaiting(sid);
    const t1 = say(sid, 'haan book karo');
    await startedP;
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_EXECUTION_REQUESTED);
    const [api, t2] = await Promise.all([orch.preparation.executeBookingProvider(sid, pctx()), say(sid, 'haan book karo', 'VOICE')]);
    expect(api.code).toBe('BOOKING_EXECUTION_LOCKED');
    expect(t2.error?.code).toBe('BOOKING_EXECUTION_LOCKED');
    release({ status: 'CONFIRMED', providerReference: 'REF-C', pnr: '7712345678' });
    await t1;
    expect(S(sid).bookingState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(p.calls).toBe(1);
  });
  it('[14] idempotency key: sent once per handoff; a NEW handoff gets a NEW key', async () => {
    const p = new TestBookingProvider('test-idem', { supportsIdempotency: true }, async () => ({ status: 'REQUIRES_EXTERNAL_HANDOFF' }));
    mk(withProvider(p));
    const sid = newSid();
    await confirm(sid);
    const k1 = p.lastRequest.idempotencyKey;
    expect(k1).toBe(S(sid).handoffSession.idempotencyKey);
    expect(S(sid).handoffSession.status).toBe('CONSUMED');
    await say(sid, 'haan book karo');
    expect(p.calls).toBe(1);
    await say(sid, 'Neha ki age 29 kar do');
    expect(S(sid).handoff.status).not.toBe('READY');
    let st = S(sid).bookingState;
    for (let i = 0; i < 3 && st !== BookingState.AWAITING_CONFIRMATION; i++) { await say(sid, 'haan'); st = S(sid).bookingState; }
    expect(st).toBe(BookingState.AWAITING_CONFIRMATION);
    await say(sid, 'haan book karo');
    expect(p.calls).toBe(2);
    expect(p.lastRequest.idempotencyKey).not.toBe(k1);
    expect(p.lastRequest.passengers[1].age).toBe(29);
  });
});

describe('P12 G3 — fail closed on stale data', () => {
  const okProvider = () => new TestBookingProvider('test-ok', {}, async () => ({ status: 'CONFIRMED', providerReference: 'R', pnr: '1234567890' }));
  it('[15] stale (expired) handoff → rejected, provider not called', async () => {
    const p = okProvider();
    const late = Date.now() + 3 * 60_000;
    const { sid, svc } = await freshService(p, () => late);
    const o = await svc.execute(sid, xctx());
    expect(o.code).toMatch(/HANDOFF_SESSION_EXPIRED|HANDOFF_INVALIDATED|STALE_AVAILABILITY/);
    expect(p.calls).toBe(0);
    expect(S(sid).bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });
  it('[16] stale review / session version → rejected, provider not called', async () => {
    const p = okProvider();
    const { sid, svc } = await freshService(p);
    S(sid).review = { ...S(sid).review, reviewVersion: S(sid).review.reviewVersion + 1 };
    expect((await svc.execute(sid, xctx())).providerCalled).toBe(false);
    const f2 = await freshService(p);
    state.bump(f2.sid);
    const o2 = await f2.svc.execute(f2.sid, xctx());
    expect(o2.providerCalled).toBe(false);
    expect(o2.code).not.toBe('BOOKING_CONFIRMED');
    expect(p.calls).toBe(0);
  });
  it('[17] stale availability → STALE_AVAILABILITY, provider not called', async () => {
    const p = okProvider();
    const { sid } = await freshService(p);
    extendExpiry(sid);
    const late = Date.parse(S(sid).availability.CC.retrievedAt) + 3 * 60_000;
    const svc = new BookingProviderExecutionService(state, { registry: reg(p), config: enabledCfg(p.name), clock: () => late });
    expect((await svc.execute(sid, xctx())).code).toBe('STALE_AVAILABILITY');
    expect(p.calls).toBe(0);
  });
  it('[18] stale fare → STALE_FARE, provider not called', async () => {
    const p = okProvider();
    const { sid } = await freshService(p);
    extendExpiry(sid);
    const s = S(sid);
    const late = Date.parse(s.fare.retrievedAt) + 11 * 60_000;
    const freshAvail = new Date(late - 10_000).toISOString();
    s.availability = { ...s.availability, CC: { ...s.availability.CC, retrievedAt: freshAvail } };
    const snap = structuredClone(s.handoffSession.bookingSnapshot);
    snap.availabilitySnapshot.retrievedAt = freshAvail;
    s.handoffSession = { ...s.handoffSession, bookingSnapshot: snap };
    const svc = new BookingProviderExecutionService(state, { registry: reg(p), config: enabledCfg(p.name), clock: () => late });
    const o = await svc.execute(sid, xctx());
    expect(o.providerCalled).toBe(false);
    expect(['STALE_FARE', 'BOOKING_DATA_CHANGED', 'INVALID_BOOKING_SNAPSHOT']).toContain(o.code);
    expect(p.calls).toBe(0);
  });
});

describe('P12 G3 — authoritative results only', () => {
  it('[19][20] authoritative confirmation + PNR only from a schema-valid provider response', async () => {
    const p = new TestBookingProvider('test-ok', {}, async () => ({ status: 'CONFIRMED', providerReference: 'REF-A1', pnr: '4412345678' }));
    mk(withProvider(p));
    const sid = newSid();
    const r = await confirm(sid);
    expect(r.newState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(r.events).toEqual(expect.arrayContaining(['BOOKING_PROVIDER_SELECTED', 'BOOKING_EXECUTION_STARTED', 'BOOKING_PROVIDER_RESPONSE_RECEIVED', 'BOOKING_CONFIRMED']));
    expect(r.responseMessage).toContain(`${PROVIDER_CONFIRMED_MESSAGE} PNR: 4412345678.`);
    expect(S(sid).bookingExecution).toMatchObject({ status: 'CONFIRMED', providerStatus: 'CONFIRMED', pnr: '4412345678', providerReference: 'REF-A1', submitted: true });
    expect(S(sid).bookingLifecycle.status).toBe('EXECUTION_SUCCESS');
    expect(S(sid).handoffSession.status).toBe('CONSUMED');
    expect(bookingExecutionView(S(sid).bookingExecution)).toMatchObject({ pnr: '4412345678', status: 'CONFIRMED' });
    const q = new TestBookingProvider('test-nopnr', {}, async () => ({ status: 'CONFIRMED', providerReference: 'REF-N' }));
    mk(withProvider(q));
    const sid2 = newSid();
    const r2 = await confirm(sid2);
    expect(r2.newState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(S(sid2).bookingExecution.pnr).toBeUndefined();
    expect(r2.responseMessage).toContain('PNR provider ne abhi nahi diya.');
  });
  it('[21] no local PNR: disabled / pending / invalid flows never carry a PNR', async () => {
    const sid = newSid();
    const r = await confirm(sid);
    const dump = JSON.stringify({ s: S(sid).bookingExecution, cards: r.cards, msg: r.responseMessage });
    expect(dump).not.toMatch(/"pnr"/);
    expect(dump).not.toMatch(/PNR\s*[:#]?\s*\d{6,}/);
    const p = new TestBookingProvider('test-acc', {}, async () => ({ status: 'ACCEPTED', providerReference: 'REF-P', pnr: '1234567890' }));
    mk(withProvider(p));
    const sid2 = newSid();
    await confirm(sid2);
    expect(S(sid2).bookingExecution).toMatchObject({ status: 'UNKNOWN', code: 'INVALID_PROVIDER_RESPONSE' });
    expect(S(sid2).bookingExecution.pnr).toBeUndefined();
    const q = new TestBookingProvider('test-acc2', {}, async () => ({ status: 'ACCEPTED', providerReference: 'REF-Q' }));
    mk(withProvider(q));
    const sid3 = newSid();
    const r3 = await confirm(sid3);
    expect(r3.newState).toBe(BookingState.BOOKING_IN_PROGRESS);
    expect(S(sid3).bookingExecution).toMatchObject({ status: 'ACCEPTED', code: 'BOOKING_ACCEPTED' });
    expect(S(sid3).bookingExecution.pnr).toBeUndefined();
  });
  it('[22] no fake success across disabled / unknown / unavailable / external / timeout / pending', async () => {
    const msgs: string[] = [];
    const sid = newSid(); msgs.push((await confirm(sid)).responseMessage);
    mk({ bookingProviderRegistry: createProductionBookingProviderRegistry(), bookingProviderConfig: enabledCfg('partner-x') });
    const s2 = newSid(); msgs.push((await confirm(s2)).responseMessage);
    for (const exec of [async () => ({ status: 'UNAVAILABLE' }), async () => ({ status: 'REQUIRES_EXTERNAL_HANDOFF' }), async () => ({ status: 'IN_PROGRESS', providerReference: 'R' }), async () => ({ status: 200 }), () => new Promise(() => {})]) {
      const p = new TestBookingProvider('test-x', {}, exec as any);
      mk(withProvider(p, 50));
      const sx = newSid();
      const r = await confirm(sx);
      msgs.push(r.responseMessage);
      expect(r.newState).not.toBe(BookingState.BOOKING_CONFIRMED);
      expect(S(sx).bookingExecution.status).not.toBe('CONFIRMED');
    }
    for (const m of msgs) { expect(m).not.toMatch(FAKE_SUCCESS); expect(m).not.toContain(PROVIDER_CONFIRMED_MESSAGE); }
  });
});

describe('P12 G3 — secrets, credentials, sensitive data', () => {
  it('[23][24][25] no credentials / config / raw provider errors in LLM context, frontend payloads or logs', async () => {
    const llm = new SpyLLM();
    const p = new TestBookingProvider('test-leak', {}, async () => { throw new BookingProviderError('PROVIDER_UNKNOWN_ERROR', undefined, 'Authorization: Bearer sk-live-SECRET-123 cookie=SESSIONID'); });
    mk({ bookingProviderRegistry: reg(p), bookingProviderConfig: { ...enabledCfg('test-leak'), baseUrl: 'https://provider-secret-host.example.invalid' } }, llm);
    const sid = newSid();
    const r = await confirm(sid);
    await say(sid, 'status kya hai');
    const turns = orch.getTurnHistory(sid);
    const everything = JSON.stringify({ ctx: llm.contexts, session: S(sid), cards: r.cards, turns, log: orch.gateway.bookingProviders.executionLog(sid), view: bookingExecutionView(S(sid).bookingExecution), provider: orch.gateway.bookingProviders.providerStatus() });
    expect(everything).not.toMatch(/SECRET|Bearer|SESSIONID|provider-secret-host|baseUrl/);
    expect(findSensitiveFields(S(sid))).toEqual([]);
    expect(findSensitiveFields(r.cards)).toEqual([]);
    const lastCtx = JSON.parse(llm.contexts[llm.contexts.length - 1]);
    expect(Object.keys(lastCtx.bookingExecution).sort()).toEqual(['code', 'failureCode', 'providerName', 'retryBlocked', 'status']);
    const log = orch.gateway.bookingProviders.executionLog(sid)[0];
    expect(Object.keys(log).sort()).toEqual(expect.arrayContaining(['sessionId', 'requestId', 'handoffId', 'executionId', 'providerName', 'executionStatus', 'latencyMs', 'failureCode', 'code']));
  });
  it('[26][27][28] no OTP / CAPTCHA / payment: request is credential-free, assistant never asks for them', async () => {
    const p = new TestBookingProvider('test-ok', { supportsIdempotency: true }, async () => ({ status: 'CONFIRMED', providerReference: 'R', pnr: '1234567890' }));
    mk(withProvider(p));
    const sid = newSid();
    const msgs: string[] = [];
    await toAwaiting(sid);
    msgs.push((await say(sid, 'haan book karo')).responseMessage);
    msgs.push((await say(sid, 'mera OTP 482913 hai aur UPI PIN 1234')).responseMessage);
    expect(findSensitiveFields(p.lastRequest)).toEqual([]);
    expect(JSON.stringify(p.lastRequest)).not.toMatch(/otp|captcha|cvv|upi|password|card/i);
    expect(JSON.stringify(S(sid))).not.toContain('482913');
    for (const m of msgs) expect(m).not.toMatch(SENSITIVE_ASK);
  });
  it('[29] voice and text use the same pipeline and produce the same execution result', async () => {
    const mkP = () => new TestBookingProvider('test-ok', {}, async () => ({ status: 'CONFIRMED', providerReference: 'R', pnr: '5512345678' }));
    const pt = mkP(); mk(withProvider(pt));
    const st = newSid(); const rt = await confirm(st, 'TEXT');
    const textRec = { ...S(st).bookingExecution }, textEvents = rt.events;
    const pv = mkP(); mk(withProvider(pv));
    const sv = newSid(); const rv = await confirm(sv, 'VOICE');
    expect(rv.newState).toBe(BookingState.BOOKING_CONFIRMED);
    expect(rv.events).toEqual(textEvents);
    expect(S(sv).bookingExecution).toMatchObject({ status: textRec.status, code: textRec.code, pnr: textRec.pnr, providerName: textRec.providerName });
    expect([pt.calls, pv.calls]).toEqual([1, 1]);
  });
  it('[30] RailBook / IRCTC untouched: provider layer has no IRCTC URL, no REAL_IRCTC_ENABLED, no network calls', () => {
    const dir = join(__dirname, '../../server/booking/provider');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src).not.toMatch(/irctc\.co\.in|railbook|onrender\.com/i);
      expect(src).not.toMatch(/env\.REAL_IRCTC_ENABLED|env\[['"]REAL_IRCTC_ENABLED/);   // never read (a doc mention is fine)
      expect(src).not.toMatch(/\bfetch\(|axios|https?\.request\(/);
    }
  });
});
