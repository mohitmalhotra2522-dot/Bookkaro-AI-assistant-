/**
 * PROMPT 11 — GROUP 2
 * BookingHandoffSession · BookingSnapshot · BookingConfirmation · BookingHandoffValidator
 * · expiry · invalidation · review/session version protection · executor adapter registry
 * · sensitive-data boundary · consumeHandoff idempotency.
 *
 * Sessions are prepared through the real orchestrator (MockLLM + MockRailwayProvider);
 * the handoff layer is then exercised directly. No real booking anywhere:
 * executeHandoff / fetch are asserted never called (afterEach).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator, type OrchestratorOptions } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { BookingState } from '../../shared/states';
import { classifyConfirmation, AMBIGUOUS_CONFIRMATION_PROMPT } from '../../server/booking/handoff/confirmation-policy';
import { findSensitiveFields, checkNoSensitiveData, isSensitiveKey } from '../../server/booking/handoff/sensitive-data-guard';
import { BookingConfirmationService } from '../../server/booking/handoff/booking-confirmation';
import { buildBookingSnapshot } from '../../server/booking/handoff/booking-snapshot';
import { BookingHandoffValidator } from '../../server/booking/handoff/booking-handoff-validator';
import { BookingHandoffSessionService, HANDOFF_SESSION_TRANSITIONS } from '../../server/booking/handoff/booking-handoff-session-service';
import { BookingExecutorAdapterRegistry, createProductionAdapterRegistry } from '../../server/booking/handoff/booking-executor-adapter-registry';
import { DisabledBookingExecutorAdapter } from '../../server/booking/handoff/disabled-booking-executor-adapter';
import type { BookingExecutorAdapter } from '../../server/booking/handoff/booking-executor-adapter';
import { DEFAULT_EXECUTION_CONFIG, parseExecutionConfig } from '../../server/booking/execution/execution-config';
import { deepFreeze } from '../../server/booking/execution/booking-handoff';
import { reviewFingerprint } from '../../server/booking/review-builder';
import { currentResults } from '../../server/ai/context/train-reference-resolver';
import { buildLLMContext } from '../../server/ai/context/context-builder';

const CREDENTIAL_KEYS = /irctcUsername|irctcPassword|password|otp|captcha|cardNumber|cvv|upiPin|bankPassword|authorizationToken|sessionCookie|cookie|token/i;

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const mk = (opts: OrchestratorOptions = {}) => { state = new ConversationStateManager(); orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService(), opts); };
const say = (sid: string, t: string): Promise<any> => orch.processTurn(sid, t, 'TEXT');
const S = (sid: string): any => state.getSession(sid);
const pctx = (): any => ({ turnId: 't-p11', mode: 'TEXT', cards: [], events: [], changes: [], requestId: 'rq-p11' });

async function toAwaiting(): Promise<string> {
  const sid = state.createSession().sessionId;
  await say(sid, 'Amritsar se Delhi kal 2 log'); await say(sid, '12497'); await say(sid, 'CC');
  const r = await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
  expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
  return sid;
}
async function toHandoff(): Promise<string> {
  const sid = await toAwaiting();
  const r = await say(sid, 'haan book karo');
  expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
  expect(S(sid).handoffSession?.status).toBe('READY');
  return sid;
}
/** Deep copy with far-future expiry so checks 7–12 can be reached in isolation (pure validator tests). */
function farExpiry(sid: string) {
  const s: any = structuredClone(S(sid));
  const far = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();
  s.handoff.snapshot = { ...s.handoff.snapshot, expiresAt: far };
  s.handoffSession = { ...s.handoffSession, expiresAt: far, bookingSnapshot: deepFreeze(structuredClone(S(sid).handoffSession.bookingSnapshot)) };
  return s;
}

class TestAdapterSuccess implements BookingExecutorAdapter {
  readonly name = 'test-success'; readonly kind = 'TEST' as const; calls = 0;
  capability() { return { enabled: true, executorName: this.name, supportsRealBooking: false }; }
  async execute(hs: any): Promise<any> { this.calls++; return { status: 'SUCCESS', executorName: this.name, idempotencyKey: hs.idempotencyKey, completedAt: new Date().toISOString(), bookingReference: 'PNR1234567890' }; }
}

let executeSpy: any, fetchSpy: any, adapterSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('mock'); mk();
  executeSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff');
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  adapterSpy = vi.spyOn(DisabledBookingExecutorAdapter.prototype, 'execute');
});
afterEach(() => {
  expect(executeSpy).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(adapterSpy).not.toHaveBeenCalled();         // the disabled adapter is NEVER invoked
  vi.restoreAllMocks();
  vi.useRealTimers();
  railwayRegistry.setActive('mock');
});

// ------------------------------------------------------------------------------------------
describe('G2 — ConfirmationPolicy (backend decides, not the LLM)', () => {
  it('explicit / negative / ambiguous / none table', () => {
    const table: Record<string, string> = {
      'haan': 'EXPLICIT', 'haan book karo': 'EXPLICIT', 'Haan, book kar do': 'EXPLICIT', 'yes': 'EXPLICIT', 'confirm': 'EXPLICIT', 'book it': 'EXPLICIT',
      'continue': 'EXPLICIT', 'haan continue karo': 'EXPLICIT', 'bilkul': 'EXPLICIT', 'हाँ': 'EXPLICIT',
      'nahi': 'NEGATIVE', 'no': 'NEGATIVE', 'cancel': 'NEGATIVE', 'ruk jao': 'NEGATIVE', 'abhi nahi': 'NEGATIVE', 'mat karo': 'NEGATIVE',
      'theek hai': 'AMBIGUOUS', 'thik hai': 'AMBIGUOUS', 'okay': 'AMBIGUOUS', 'ok': 'AMBIGUOUS', 'haan?': 'AMBIGUOUS', 'hmm': 'AMBIGUOUS',
      'achha': 'AMBIGUOUS', 'chalo': 'AMBIGUOUS', 'theek hai?': 'AMBIGUOUS', 'shayad': 'AMBIGUOUS',
      '': 'NONE', 'Delhi nahi Ludhiana': 'NONE', '3A kar do': 'NONE', 'fare kitna hai?': 'NONE'
    };
    for (const [text, cls] of Object.entries(table)) expect([text, classifyConfirmation(text)]).toEqual([text, cls]);
    expect(AMBIGUOUS_CONFIRMATION_PROMPT).toBe('Booking confirm karni hai?');
  });
});

describe('G2 — SensitiveDataGuard', () => {
  it('[21] rejects every credential-like key (deep, case/format-insensitive) and reports paths only', () => {
    const bad = { password: 'x', otp: '1', captcha: 'c', cvv: '1', upiPin: '1', bankPassword: 'b', authorizationToken: 't', sessionCookie: 'k',
      nested: { IRCTC_USERNAME: 'u', irctcPassword: 'p', captchaAnswer: 'a', card_number: '4111', otpCode: '9' } };
    const f = findSensitiveFields(bad);
    expect(f).toEqual(expect.arrayContaining(['password', 'otp', 'captcha', 'cvv', 'upiPin', 'bankPassword', 'authorizationToken', 'sessionCookie',
      'nested.IRCTC_USERNAME', 'nested.irctcPassword', 'nested.captchaAnswer', 'nested.card_number', 'nested.otpCode']));
    expect(JSON.stringify(f)).not.toMatch(/4111|"x"/);
    const r = checkNoSensitiveData({ ok: 1 }, bad);
    expect(r).toMatchObject({ ok: false, code: 'SENSITIVE_DATA_REJECTED' });
  });
  it('no false positives on booking-domain keys', () => {
    for (const k of ['passengers', 'passengerId', 'fingerprint', 'idempotencyKey', 'expiresAt', 'reviewVersion', 'footprint', 'handoffSessionId', 'executorCapability', 'availabilitySnapshot'])
      expect([k, isSensitiveKey(k)]).toEqual([k, false]);
    expect(checkNoSensitiveData({ journey: { origin: 'ASR' } }, undefined, null)).toEqual({ ok: true });
  });
});

describe('G2 — BookingConfirmation', () => {
  it('created ONLY in AWAITING_CONFIRMATION for the current review; records review + session version', async () => {
    const svc = new BookingConfirmationService();
    const sid = state.createSession().sessionId;
    expect(svc.create(S(sid), { requestId: 'r', now: Date.now() })).toMatchObject({ ok: false, code: 'INVALID_CONFIRMATION' });
    const sid2 = await toAwaiting();
    expect(svc.create(S(sid2), { requestId: 'r', now: Date.now(), reviewVersion: 99 })).toMatchObject({ ok: false, code: 'CONFIRMATION_VERSION_MISMATCH' });
    const c = svc.create(S(sid2), { requestId: 'r1', now: Date.now() });
    expect(c.ok).toBe(true);
    const conf = (c as any).confirmation;
    expect(conf).toMatchObject({ sessionId: sid2, requestId: 'r1', reviewVersion: 1, sessionVersion: S(sid2).sessionVersion, status: 'VALID', reviewFingerprint: S(sid2).review.fingerprint });
    expect(conf.confirmationId).toMatch(/^cf_[0-9a-f]{24}$/);
    // a new confirmation supersedes (invalidates) the previous one
    const old = S(sid2).confirmation;
    svc.create(S(sid2), { requestId: 'r2', now: Date.now() });
    expect(old.status).toBe('INVALIDATED');
    expect(S(sid2).confirmation.status).toBe('VALID');
  });
  it('booking data changed after review → BOOKING_DATA_CHANGED (no confirmation)', async () => {
    const sid = await toAwaiting();
    S(sid).passengers[1].age = 29;
    expect(new BookingConfirmationService().create(S(sid), { requestId: 'r', now: Date.now() })).toMatchObject({ ok: false, code: 'BOOKING_DATA_CHANGED' });
    expect(S(sid).confirmation).toBeUndefined();
  });
});

describe('G2 — BookingSnapshot + BookingHandoffSession creation', () => {
  it('[1] snapshot = authoritative, deep-frozen, fingerprint-bound, credential-free; session READY with opaque ids', async () => {
    const sid = await toHandoff();
    const s = S(sid);
    const hs = s.handoffSession;
    const snap = hs.bookingSnapshot;
    expect(Object.isFrozen(snap) && Object.isFrozen(snap.passengers) && Object.isFrozen(snap.passengers[0]) && Object.isFrozen(snap.fareSnapshot)).toBe(true);
    expect(() => { (snap as any).selectedClass = '1A'; }).toThrow();
    expect(() => { (snap.passengers[0] as any).name = 'X'; }).toThrow();
    expect(snap).toMatchObject({ sessionId: sid, reviewVersion: 1, journey: { origin: 'ASR', destination: 'NDLS' }, date: s.date, selectedClass: 'CC',
      selectedTrain: { trainNumber: '12497', resultId: s.selectedTrain.resultId }, fareSnapshot: { total: 980, passengersCount: 2, retrievedAt: s.fare.retrievedAt },
      availabilitySnapshot: { status: s.availability.CC.status, retrievedAt: s.availability.CC.retrievedAt } });
    expect(snap.passengers.map((p: any) => [p.passengerId, p.name, p.age, p.gender])).toEqual([['P1', 'Rahul Sharma', 31, 'MALE'], ['P2', 'Neha Sharma', 28, 'FEMALE']]);
    expect(snap.fingerprint).toBe(reviewFingerprint(s));
    expect(snap.fingerprint).toBe(s.review.fingerprint);
    expect(snap.fingerprint).toBe(s.handoff.snapshot.fingerprint);
    // session record
    expect(hs).toMatchObject({ sessionId: sid, bookingHandoffId: s.handoff.snapshot.handoffId, reviewVersion: 1, sessionVersion: s.sessionVersion, status: 'READY',
      confirmationId: s.confirmation.confirmationId, executionAttempts: 0, executorCapability: { enabled: false, executorName: 'disabled', supportsRealBooking: false } });
    expect(hs.handoffSessionId).toMatch(/^hs_[0-9a-f]{24}$/);
    expect(s.handoff.snapshot.handoffId).toMatch(/^HO-[0-9A-F]{16}$/);
    expect(hs.idempotencyKey).toMatch(/^hx_[0-9a-f]{32}$/);
    expect(hs.handoffSessionId).not.toContain(sid);
    expect(Object.isFrozen(hs.executorCapability)).toBe(true);
    expect(Date.parse(hs.expiresAt)).toBeGreaterThan(Date.parse(hs.createdAt));
    expect(Date.parse(hs.expiresAt)).toBeLessThanOrEqual(Date.parse(s.handoff.snapshot.expiresAt));
    expect(s.confirmation).toMatchObject({ status: 'VALID', reviewVersion: 1, sessionVersion: s.handoff.snapshot.sessionVersion });
    // [22] no credential field anywhere
    for (const o of [snap, hs, s.handoff, s.confirmation]) expect(findSensitiveFields(o)).toEqual([]);
    expect(JSON.stringify(Object.keys(hs))).not.toMatch(CREDENTIAL_KEYS);
    // [1] LLM context never contains ids / snapshot
    const ctxJson = JSON.stringify(buildLLMContext(s, []));
    for (const secretish of [hs.handoffSessionId, s.handoff.snapshot.handoffId, s.confirmation.confirmationId, hs.idempotencyKey, snap.snapshotId]) expect(ctxJson).not.toContain(secretish);
  });
  it('a rebuilt snapshot is a NEW object (never mutated), with the same authoritative fingerprint', async () => {
    const sid = await toHandoff();
    const a = S(sid).handoffSession.bookingSnapshot;
    const b = buildBookingSnapshot(S(sid), Date.now());
    expect(b.ok).toBe(true);
    expect((b as any).snapshot).not.toBe(a);
    expect((b as any).snapshot.snapshotId).not.toBe(a.snapshotId);
    expect((b as any).snapshot.fingerprint).toBe(a.fingerprint);
  });
  it('create() is fail-closed: no confirmation / wrong review / sensitive extra → rejected, nothing persisted', async () => {
    const sid = await toHandoff();
    const svc = new BookingHandoffSessionService();
    const s = structuredClone(S(sid));
    s.handoffSession = undefined;
    const noConf = { ...s, confirmation: undefined };
    expect(svc.create(noConf as any)).toMatchObject({ ok: false, code: 'INVALID_CONFIRMATION' });
    const wrongRv = { ...s, confirmation: { ...s.confirmation, reviewVersion: 7 } };
    expect(svc.create(wrongRv as any)).toMatchObject({ ok: false, code: 'CONFIRMATION_VERSION_MISMATCH' });
    const wrongSv = { ...s, confirmation: { ...s.confirmation, sessionVersion: 3 } };
    expect(svc.create(wrongSv as any)).toMatchObject({ ok: false, code: 'SESSION_VERSION_CONFLICT' });
    const sens = structuredClone(s);
    expect(svc.create(sens as any, {}, { otp: '123456', upiPin: '0000' })).toMatchObject({ ok: false, code: 'SENSITIVE_DATA_REJECTED' });
    expect((sens as any).handoffSession).toBeUndefined();
    expect(JSON.stringify(sens)).not.toContain('123456');
  });
});

describe('G2 — BookingHandoffValidator (14 checks)', () => {
  it('[3][4][5][6] exists · READY · not expired · review version · session version', async () => {
    const v = new BookingHandoffValidator();
    const sid = await toHandoff();
    const s = S(sid), hs = s.handoffSession, now = Date.now();
    expect(v.validate(s, hs, now)).toEqual({ ok: true });
    expect(v.validate(s, undefined, now)).toMatchObject({ code: 'HANDOFF_NOT_FOUND' });
    expect(v.validate(s, { ...hs, sessionId: 'other' }, now)).toMatchObject({ code: 'HANDOFF_NOT_FOUND' });
    expect(v.validate(s, { ...hs, status: 'EXPIRED' }, now)).toMatchObject({ code: 'HANDOFF_SESSION_EXPIRED' });
    expect(v.validate(s, { ...hs, status: 'INVALIDATED' }, now)).toMatchObject({ code: 'HANDOFF_INVALIDATED' });
    expect(v.validate(s, { ...hs, status: 'FAILED' }, now)).toMatchObject({ code: 'HANDOFF_INVALIDATED' });
    expect(v.validate(s, { ...hs, status: 'CONSUMED' }, now)).toMatchObject({ code: 'HANDOFF_ALREADY_CONSUMED' });
    expect(v.validate(s, hs, Date.parse(hs.expiresAt))).toMatchObject({ code: 'HANDOFF_SESSION_EXPIRED' });
    expect(v.validate(s, { ...hs, reviewVersion: 2 }, now)).toMatchObject({ code: 'CONFIRMATION_VERSION_MISMATCH' });
    expect(v.validate({ ...s, review: { ...s.review, reviewVersion: 2 } }, hs, now)).toMatchObject({ code: 'CONFIRMATION_VERSION_MISMATCH' });
    expect(v.validate({ ...s, sessionVersion: s.sessionVersion + 1 }, hs, now)).toMatchObject({ code: 'SESSION_VERSION_CONFLICT' });
  });
  it('[6]–[12] snapshot · journey/date/train/class/passengers · availability/fare', async () => {
    const v = new BookingHandoffValidator();
    const sid = await toHandoff();
    const s = S(sid), hs = s.handoffSession, now = Date.now();
    expect(v.validate(s, { ...hs, bookingSnapshot: undefined }, now)).toMatchObject({ code: 'INVALID_BOOKING_SNAPSHOT' });
    expect(v.validate(s, { ...hs, bookingSnapshot: { ...hs.bookingSnapshot } }, now)).toMatchObject({ code: 'INVALID_BOOKING_SNAPSHOT' });   // not frozen
    expect(v.validate({ ...s, destination: 'CDG' }, hs, now)).toMatchObject({ code: 'BOOKING_DATA_CHANGED' });
    expect(v.validate({ ...s, date: '2099-01-01' }, hs, now)).toMatchObject({ code: 'BOOKING_DATA_CHANGED' });
    expect(v.validate({ ...s, selectedClass: '3A' }, hs, now)).toMatchObject({ code: 'BOOKING_DATA_CHANGED' });
    expect(v.validate({ ...s, passengers: [s.passengers[0], { ...s.passengers[1], age: 29 }] }, hs, now)).toMatchObject({ code: 'BOOKING_DATA_CHANGED' });
    expect(v.validate({ ...s, fare: { ...s.fare, total: 1100 } }, hs, now)).toMatchObject({ code: 'BOOKING_DATA_CHANGED' });
    expect(v.validate({ ...s, availability: { ...s.availability, CC: { ...s.availability.CC, status: 'WL5' } } }, hs, now)).toMatchObject({ code: 'BOOKING_DATA_CHANGED' });
    // train / class validity vs CURRENT authoritative results (fingerprint unchanged)
    const t1 = structuredClone(s); t1.searchResults.resultId = 'sr-other';
    expect(v.validate(t1, hs, now)).toMatchObject({ code: 'INVALID_BOOKING_SNAPSHOT', detail: expect.stringContaining('INVALID_TRAIN') });
    const c1 = structuredClone(s);
    const row: any = (c1.searchResults.trains as any[]).find((r: any) => r.resultId === c1.selectedTrain.resultId);   // mutate the session's own row (currentResults() returns copies)
    for (const k of Object.keys(row)) if (Array.isArray(row[k]) && row[k].some((x: any) => (x?.classCode ?? x?.code ?? x) === 'CC')) row[k] = row[k].filter((x: any) => (x?.classCode ?? x?.code ?? x) !== 'CC');
    expect(v.validate(c1, hs, now)).toMatchObject({ code: 'INVALID_BOOKING_SNAPSHOT', detail: expect.stringContaining('INVALID_CLASS') });
    // freshness — reached in isolation with a far-future expiry
    const f = farExpiry(sid);
    const late = Date.parse(f.availability.CC.retrievedAt) + 3 * 60_000;
    expect(v.validate(f, f.handoffSession, late)).toMatchObject({ code: 'STALE_AVAILABILITY' });
    const past = Date.parse(f.date) + 4 * 24 * 3600_000;
    expect(v.validate(f, f.handoffSession, past)).toMatchObject({ code: 'INVALID_BOOKING_SNAPSHOT', detail: expect.stringContaining('date') });
  });
  it('[13][14] confirmation exists, VALID, belongs to the handed-off review + session version', async () => {
    const v = new BookingHandoffValidator();
    const sid = await toHandoff();
    const s = S(sid), hs = s.handoffSession, now = Date.now();
    expect(v.validate({ ...s, confirmation: undefined }, hs, now)).toMatchObject({ code: 'INVALID_CONFIRMATION' });
    expect(v.validate({ ...s, confirmation: { ...s.confirmation, status: 'INVALIDATED' } }, hs, now)).toMatchObject({ code: 'INVALID_CONFIRMATION' });
    expect(v.validate({ ...s, confirmation: { ...s.confirmation, status: 'EXPIRED' } }, hs, now)).toMatchObject({ code: 'INVALID_CONFIRMATION' });
    expect(v.validate({ ...s, confirmation: { ...s.confirmation, confirmationId: 'cf_old' } }, hs, now)).toMatchObject({ code: 'INVALID_CONFIRMATION' });
    expect(v.validate({ ...s, confirmation: { ...s.confirmation, reviewVersion: 0 } }, hs, now)).toMatchObject({ code: 'CONFIRMATION_VERSION_MISMATCH' });
    expect(v.validate({ ...s, confirmation: { ...s.confirmation, reviewFingerprint: '[]' } }, hs, now)).toMatchObject({ code: 'CONFIRMATION_VERSION_MISMATCH' });
    expect(v.validate({ ...s, confirmation: { ...s.confirmation, sessionVersion: 1 } }, hs, now)).toMatchObject({ code: 'SESSION_VERSION_CONFLICT' });
  });
});

describe('G2 — lifecycle · expiry · invalidation', () => {
  it('transitions: CONSUMED unreachable; terminal states final; status history recorded', async () => {
    expect(HANDOFF_SESSION_TRANSITIONS.READY).not.toContain('CONSUMED');
    for (const st of ['EXPIRED', 'INVALIDATED', 'FAILED', 'CONSUMED'] as const) expect(HANDOFF_SESSION_TRANSITIONS[st]).toEqual([]);
    const sid = await toHandoff();
    const svc = orch.preparation.handoffSessions;
    expect(svc.setStatus(S(sid), 'CONSUMED' as any, 'x', Date.now())).toBe(false);
    expect(svc.setStatus(S(sid), 'INVALIDATED', 'TEST', Date.now())).toBe(true);
    expect(svc.setStatus(S(sid), 'EXPIRED', 'TEST', Date.now())).toBe(false);
    expect(S(sid).handoffSessionHistory.map((h: any) => h.status)).toEqual(['READY', 'INVALIDATED']);
  });
  it('[2] configurable expiry (BOOKING_HANDOFF_SESSION_TTL_MS), capped by the handoff, never unlimited', async () => {
    expect(parseExecutionConfig({ BOOKING_HANDOFF_SESSION_TTL_MS: '30000' }).handoffSessionTtlMs).toBe(30000);
    const bad = parseExecutionConfig({ BOOKING_HANDOFF_SESSION_TTL_MS: '0' });
    expect(bad.handoffSessionTtlMs).toBe(DEFAULT_EXECUTION_CONFIG.handoffSessionTtlMs);
    expect(bad.configErrors).toContain('BOOKING_HANDOFF_SESSION_TTL_MS_INVALID');
    expect(parseExecutionConfig({ BOOKING_HANDOFF_SESSION_TTL_MS: '99999999' }).configErrors).toContain('BOOKING_HANDOFF_SESSION_TTL_MS_INVALID');
    mk({ handoffSessionService: new BookingHandoffSessionService({ config: { ...DEFAULT_EXECUTION_CONFIG, handoffSessionTtlMs: 30_000 } }) });
    const sid = await toHandoff();
    const hs = S(sid).handoffSession;
    expect(Date.parse(hs.expiresAt) - Date.parse(hs.createdAt)).toBe(30_000);
    mk({ handoffSessionService: new BookingHandoffSessionService({ config: { ...DEFAULT_EXECUTION_CONFIG, handoffSessionTtlMs: 900_000 } }) });
    const sid2 = await toHandoff();
    expect(S(sid2).handoffSession.expiresAt).toBe(S(sid2).handoff.snapshot.expiresAt);   // capped by the handoff
  });
  it('[2][3] expired session → EXPIRED; consume → HANDOFF_SESSION_EXPIRED; next turn expires handoff + confirmation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mk({ handoffSessionService: new BookingHandoffSessionService({ config: { ...DEFAULT_EXECUTION_CONFIG, handoffSessionTtlMs: 30_000 } }) });
    const sid = await toHandoff();
    const id = S(sid).handoffSession.handoffSessionId;
    vi.setSystemTime(Date.now() + 31_000);
    expect(orch.preparation.handoffSessions.check(S(sid), Date.now())).toMatchObject({ status: 'EXPIRED' });
    const ctx = pctx();
    const c = await orch.preparation.consumeHandoff(sid, id, ctx);
    expect(c).toMatchObject({ ok: false, code: 'HANDOFF_SESSION_EXPIRED', executorAttempted: false });
    expect(S(sid).handoffSessionHistory.map((h: any) => h.status)).toContain('EXPIRED');
    expect(S(sid).handoff.status).toBe('EXPIRED');
    expect(S(sid).confirmation.status).toBe('EXPIRED');
    expect(ctx.events).toContain('BOOKING_HANDOFF_EXPIRED');
    expect(S(sid).bookingState).not.toBe(BookingState.IRCTC_HANDOFF_READY);
    // expired session can never execute again
    expect(await orch.preparation.consumeHandoff(sid, id, pctx())).toMatchObject({ ok: false, code: 'HANDOFF_SESSION_EXPIRED' });
  });
  it('[4] invalidated session cannot execute; INVALIDATED is final', async () => {
    const sid = await toHandoff();
    const id = S(sid).handoffSession.handoffSessionId;
    orch.preparation.invalidateHandoff(sid, pctx(), 'INVALIDATED', 'TEST_CHANGE');
    expect(S(sid).handoffSession.status).toBe('INVALIDATED');
    expect(S(sid).confirmation.status).toBe('INVALIDATED');
    expect(await orch.preparation.consumeHandoff(sid, id, pctx())).toMatchObject({ ok: false, code: 'HANDOFF_INVALIDATED', executorAttempted: false });
  });
  it('[5][6] review-version and session-version mismatches are rejected at consume time', async () => {
    const sid = await toHandoff();
    const id = S(sid).handoffSession.handoffSessionId;
    const s = S(sid);
    s.review = { ...s.review, reviewVersion: 2 };
    expect(await orch.preparation.consumeHandoff(sid, id, pctx())).toMatchObject({ code: 'CONFIRMATION_VERSION_MISMATCH', executorAttempted: false });
    s.review = { ...s.review, reviewVersion: 1 };
    state.bump(sid);
    expect(await orch.preparation.consumeHandoff(sid, id, pctx())).toMatchObject({ code: 'SESSION_VERSION_CONFLICT', executorAttempted: false });
    // the next turn notices the session-version drift and invalidates handoff + session + confirmation
    await say(sid, 'fare kitna hai?');
    expect(S(sid).handoffSession.status).toBe('INVALIDATED');
    expect(S(sid).confirmation.status).toBe('INVALIDATED');
  });
});

describe('G2 — consumeHandoff · adapter registry (fail closed)', () => {
  it('[19] disabled executor → BOOKING_EXECUTION_DISABLED, adapter never invoked, status stays READY (never CONSUMED); idempotent', async () => {
    const sid = await toHandoff();
    const id = S(sid).handoffSession.handoffSessionId;
    const ctx = pctx();
    const r1 = await orch.preparation.consumeHandoff(sid, id, ctx);
    expect(r1).toMatchObject({ ok: false, code: 'BOOKING_EXECUTION_DISABLED', detail: 'EXECUTOR_DISABLED', executionStatus: 'DISABLED', executorAttempted: false,
      capability: { enabled: false, executorName: 'disabled', supportsRealBooking: false } });
    expect(ctx.events).toEqual(['BOOKING_HANDOFF_EXECUTION_REQUESTED', 'BOOKING_EXECUTION_DISABLED']);
    expect(S(sid).handoffSession.status).toBe('READY');
    expect(S(sid).handoffSession.executionAttempts).toBe(0);
    const ev = S(sid).eventLog.filter((e: any) => e.type === 'BOOKING_HANDOFF_EXECUTION_REQUESTED').pop();
    expect(ev.data).toMatchObject({ sessionId: sid, handoffSessionId: id, handoffId: S(sid).handoff.snapshot.handoffId, reviewVersion: 1, sessionVersion: S(sid).sessionVersion, status: 'READY' });
    expect(ev.timestamp).toBeTruthy();
    expect(JSON.stringify(ev)).not.toMatch(/Rahul|Neha/);
    const ctx2 = pctx();
    const r2 = await orch.preparation.consumeHandoff(sid, id, ctx2);
    expect(r2).toMatchObject({ code: 'BOOKING_EXECUTION_DISABLED', duplicate: true, executorAttempted: false });
    expect(ctx2.events).toEqual([]);                          // repeated key → no second execution request
    // concurrent requests → one outcome
    const [a, b] = await Promise.all([orch.preparation.consumeHandoff(sid, id, pctx()), orch.preparation.consumeHandoff(sid, id, pctx())]);
    expect([a.code, b.code]).toEqual(['BOOKING_EXECUTION_DISABLED', 'BOOKING_EXECUTION_DISABLED']);
    expect(S(sid).handoffSession.status).toBe('READY');
  });
  it('[21] sensitive consume options rejected and not persisted; unknown id → HANDOFF_NOT_FOUND', async () => {
    const sid = await toHandoff();
    const id = S(sid).handoffSession.handoffSessionId;
    const r = await orch.preparation.consumeHandoff(sid, id, pctx(), { irctcPassword: 'hunter2xyz', otp: '482913', captchaAnswer: 'AB12', cardNumber: '4111111111111111', cvv: '123', upiPin: '9999' });
    expect(r).toMatchObject({ ok: false, code: 'SENSITIVE_DATA_REJECTED', executorAttempted: false });
    expect(JSON.stringify(S(sid))).not.toMatch(/hunter2xyz|482913|4111111111111111|AB12/);
    expect(await orch.preparation.consumeHandoff(sid, 'hs_doesnotexist', pctx())).toMatchObject({ ok: false, code: 'HANDOFF_NOT_FOUND' });
  });
  it('[18][20] unknown / missing executor and missing / malformed capability fail closed', async () => {
    // unknown configured executor
    mk({ handoffSessionService: new BookingHandoffSessionService({ config: { ...DEFAULT_EXECUTION_CONFIG, realBookingEnabled: true, executorName: 'irctc-real' } }) });
    let sid = await toHandoff();
    expect(S(sid).handoffSession.executorCapability).toMatchObject({ enabled: false, executorName: 'none', reason: 'EXECUTOR_NOT_FOUND' });
    expect(await orch.preparation.consumeHandoff(sid, S(sid).handoffSession.handoffSessionId, pctx())).toMatchObject({ code: 'EXECUTOR_NOT_FOUND', executorAttempted: false });
    // registry with NO adapter at all (missing executor)
    mk({ handoffSessionService: new BookingHandoffSessionService({ registry: new BookingExecutorAdapterRegistry({ includeDisabled: false }) }) });
    sid = await toHandoff();
    expect(await orch.preparation.consumeHandoff(sid, S(sid).handoffSession.handoffSessionId, pctx())).toMatchObject({ code: 'EXECUTOR_NOT_FOUND' });
    // capability missing on the session
    mk(); sid = await toHandoff();
    S(sid).handoffSession.executorCapability = undefined;
    expect(await orch.preparation.consumeHandoff(sid, S(sid).handoffSession.handoffSessionId, pctx())).toMatchObject({ code: 'EXECUTOR_UNAVAILABLE', executorAttempted: false });
    // adapter whose capability() is malformed / throws
    const reg = new BookingExecutorAdapterRegistry({ allowTestAdapters: true, includeDisabled: false });
    reg.register({ name: 'test-broken', kind: 'TEST', capability: () => ({ enabled: 'yes' } as any), execute: async () => ({}) as any });
    expect(reg.resolve({ ...DEFAULT_EXECUTION_CONFIG, realBookingEnabled: true, executorName: 'test-broken' })).toMatchObject({ ok: false, code: 'EXECUTOR_UNAVAILABLE', capability: { enabled: false } });
    reg.register({ name: 'test-throws', kind: 'TEST', capability: () => { throw new Error('x'); }, execute: async () => ({}) as any });
    expect(reg.resolve({ ...DEFAULT_EXECUTION_CONFIG, realBookingEnabled: true, executorName: 'test-throws' })).toMatchObject({ ok: false, code: 'EXECUTOR_UNAVAILABLE' });
  });
  it('production registry: ONLY the disabled adapter; enabled / real / non-test adapters cannot be registered', () => {
    const prod = createProductionAdapterRegistry();
    expect(prod.names()).toEqual(['disabled']);
    expect(prod.resolve(DEFAULT_EXECUTION_CONFIG)).toMatchObject({ ok: true, capability: { enabled: false, executorName: 'disabled', supportsRealBooking: false } });
    expect(prod.resolve(parseExecutionConfig({ REAL_BOOKING_ENABLED: 'true', BOOKING_EXECUTOR: 'disabled' }))).toMatchObject({ ok: true, capability: { enabled: false } });
    expect(() => prod.register(new TestAdapterSuccess())).toThrow(/not allowed/);
    expect(() => prod.register({ name: 'irctc', kind: 'REAL', capability: () => ({ enabled: true, executorName: 'irctc', supportsRealBooking: true }), execute: async () => ({}) as any })).toThrow(/REAL/);
    expect(() => prod.register({ name: 'sneaky', kind: 'DISABLED', capability: () => ({ enabled: true, executorName: 'sneaky', supportsRealBooking: false }), execute: async () => ({}) as any })).toThrow(/Only disabled/);
    const t = new BookingExecutorAdapterRegistry({ allowTestAdapters: true });
    expect(() => t.register({ ...new TestAdapterSuccess(), name: 'evil', kind: 'TEST' } as any)).toThrow(/start with "test"/);
    expect(new DisabledBookingExecutorAdapter().capability()).toEqual({ enabled: false, executorName: 'disabled', supportsRealBooking: false, reason: 'REAL_BOOKING_DISABLED' });
  });
  it('test-enabled adapter: invoked exactly once; SUCCESS is untrusted → FAILED (never CONSUMED, no PNR); repeat → no second attempt', async () => {
    const adapter = new TestAdapterSuccess();
    const reg = new BookingExecutorAdapterRegistry({ allowTestAdapters: true });
    reg.register(adapter);
    mk({ handoffSessionService: new BookingHandoffSessionService({ registry: reg, config: { ...DEFAULT_EXECUTION_CONFIG, realBookingEnabled: true, executorName: 'test-success' } }) });
    const sid = await toHandoff();
    const id = S(sid).handoffSession.handoffSessionId;
    expect(S(sid).handoffSession.executorCapability).toMatchObject({ enabled: true, executorName: 'test-success', supportsRealBooking: false });
    const r1 = await orch.preparation.consumeHandoff(sid, id, pctx());
    expect(r1).toMatchObject({ executionStatus: 'FAILED', detail: 'UNTRUSTED_EXECUTOR_RESULT', executorAttempted: true });
    expect(S(sid).handoffSession.status).toBe('FAILED');
    expect(JSON.stringify(S(sid))).not.toContain('PNR1234567890');
    const r2 = await orch.preparation.consumeHandoff(sid, id, pctx());
    expect(r2).toMatchObject({ duplicate: true, executorAttempted: true });
    expect(adapter.calls).toBe(1);
    expect(S(sid).handoffSession.executionAttempts).toBe(1);
  });
});
