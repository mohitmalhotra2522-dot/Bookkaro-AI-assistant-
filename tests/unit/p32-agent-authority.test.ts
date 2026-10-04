/**
 * PROMPT 32 — G2 (domain / provider / security): honest tool outcomes, malformed provider data, provider identity,
 * outcome-claim guard, freshness (no cross-turn cache), same-turn dedup, timeout/retry bounds, confirmation policy,
 * secrets, booking disabled. Offline: deterministic mock data, no network, no real LLM.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { ScriptedRailwayExecutor, mockToolSession } from '../../server/ai/tool-runtime/mock-railway-tool-runtime';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { toolOutcomeOf, dataSourceOf, isWellFormedToolData } from '../../server/ai/tool-runtime/tool-outcome';
import { normalizeToolErrorCode, statusForError, SAFE_ERROR_MESSAGE } from '../../server/ai/tool-runtime/tool-error-normalizer';
import { NON_RETRYABLE_ERRORS, shouldRetry, DEFAULT_TOOL_RETRY_POLICY } from '../../server/ai/tool-runtime/tool-retry-policy';
import { structuredToolError } from '../../server/ai/tool-runtime/tool-result-identity';
import { verifyOutcomeClaims, guardOutcomeClaims, honestFailureFallback } from '../../server/ai/response/outcome-claims';
import { RAILWAY_RESULT_CACHE_TTL_MS } from '../../server/ai/tool-runtime/freshness';
import { RailwayProviderRegistry, railwayRegistry } from '../../server/railway/registry/provider-registry';
import { isWellFormedSearch } from '../../server/railway/orchestrator/search-orchestrator';
import { classifyConfirmation } from '../../server/booking/handoff/confirmation-policy';
import { MAX_TOOL_CALLS_PER_TURN } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { NATIVE_AGENT_SYSTEM_PROMPT } from '../../server/ai/prompts/system-prompt';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

const KAL = (resolveDate('kal') as any).date as string;
const validator = new ToolCallValidator();
const ground = (userText: string) => ({ userText, bookings: [], pnrOwner: () => 'NONE' as const, bookingOwner: () => 'NONE' as const });
function turnFor(s: any, userText: string, opts: any = {}) {
  const rt = new RailwayToolRuntime({ timeoutMs: 40, sleep: async () => {}, ...opts });
  return rt.beginTurn({ sessionId: s.sessionId, turnId: 't', requestId: 'r', userText, getSession: () => s, validate: (tc, ss) => validator.validate(tc, ss, ground(userText)) as any });
}
const call = (name: string, args: any = {}, callId = `${name}-${Math.random()}`) => ({ callId, name: name as any, arguments: args });
const META = (source = 'mock') => { const n = new Date().toISOString(); return { source, providerId: 'p32-unit', requestTimestamp: n, responseTimestamp: n, latencyMs: 1, cache: 'disabled' }; };

/** Executor that returns a fixed raw provider answer for every call. */
class FixedExecutor extends ScriptedRailwayExecutor {
  n = 0;
  constructor(private readonly raw: any) { super(); }
  async execute(vt: any): Promise<any> { this.n++; this.calls.push({ tool: vt.name, args: { ...vt.arguments } }); return typeof this.raw === 'function' ? this.raw(vt) : this.raw; }
}
async function runOne(name: string, args: any, ex: any, opts: any = {}) {
  const s = mockToolSession();
  const t = turnFor(s, 'q', opts);
  const got: any[] = [];
  await t.runRound([call(name, args)] as any, ex, { fromLLM: true, onRejected: () => {}, onExecuted: (x: any) => { got.push(x); return true; } });
  return got[got.length - 1];
}

afterEach(() => vi.restoreAllMocks());

describe('P32 G2 — honest outcome categories', () => {
  it('[1] eight distinct outcomes — never collapsed', () => {
    expect(toolOutcomeOf({ ok: true })).toBe('DATA');
    expect(toolOutcomeOf({ ok: true, empty: true })).toBe('NO_RESULTS');
    expect(toolOutcomeOf({ ok: false, status: 'FAILED', code: 'TOOL_NOT_IMPLEMENTED' })).toBe('UNSUPPORTED');
    expect(toolOutcomeOf({ ok: false, status: 'TIMEOUT', code: 'SEARCH_TIMEOUT', normalizedCode: 'TOOL_TIMEOUT' })).toBe('TIMEOUT');
    expect(toolOutcomeOf({ ok: false, status: 'FAILED', code: 'PROVIDER_UNAVAILABLE' })).toBe('PROVIDER_FAILURE');
    expect(toolOutcomeOf({ ok: false, status: 'FAILED', code: 'PROVIDER_DATA_INVALID' })).toBe('MALFORMED_DATA');
    expect(toolOutcomeOf({ ok: false, status: 'CANCELLED', code: 'STALE_TOOL_RESULT' })).toBe('STALE');
    expect(toolOutcomeOf({ ok: false, status: 'REJECTED', code: 'INVALID_ARGUMENT' })).toBe('REJECTED');
    // a timeout is never "no results"; a failure is never "no results"
    expect(toolOutcomeOf({ ok: false, status: 'TIMEOUT' })).not.toBe('NO_RESULTS');
    expect(toolOutcomeOf({ ok: false, status: 'FAILED', code: 'RATE_LIMITED' })).toBe('PROVIDER_FAILURE');
    expect(toolOutcomeOf({ ok: false, status: 'FAILED', code: 'RESULT_IDENTITY_MISMATCH' })).toBe('STALE');
  });

  it('[2] provider identity comes from the provider meta (MOCK never LIVE); missing meta → null', () => {
    expect(dataSourceOf({ source: 'mock' })).toBe('MOCK');
    expect(dataSourceOf({ source: 'railway-provider' })).toBe('LIVE');
    expect(dataSourceOf(undefined)).toBeNull();
  });

  it('[3] PROVIDER_DATA_INVALID is a first-class, terminal, non-retryable provider error with a safe message', () => {
    expect(normalizeToolErrorCode('PROVIDER_DATA_INVALID')).toBe('PROVIDER_DATA_INVALID');
    expect(statusForError('PROVIDER_DATA_INVALID' as any)).toBe('FAILED');
    expect(NON_RETRYABLE_ERRORS).toContain('PROVIDER_DATA_INVALID');
    expect(shouldRetry(DEFAULT_TOOL_RETRY_POLICY, 'PROVIDER_DATA_INVALID', 0)).toBe(false);
    expect(SAFE_ERROR_MESSAGE.PROVIDER_DATA_INVALID).toMatch(/format/);
    expect(structuredToolError('SEARCH_TRAINS', { code: 'PROVIDER_DATA_INVALID' })).toMatchObject({ errorType: 'PROVIDER', retryable: false });
  });
});

describe('P32 G2 — provider output validation (malformed ≠ empty ≠ success)', () => {
  it('[4] shape checks per tool', () => {
    expect(isWellFormedToolData('SEARCH_TRAINS', { trains: [] })).toBe(true);
    expect(isWellFormedToolData('SEARCH_TRAINS', { trains: [{ trainNumber: '12014' }] })).toBe(true);
    expect(isWellFormedToolData('SEARCH_TRAINS', { foo: 1 })).toBe(false);
    expect(isWellFormedToolData('SEARCH_TRAINS', null)).toBe(false);
    expect(isWellFormedToolData('SEARCH_TRAINS', { trains: [{ name: 'x' }] })).toBe(false);
    expect(isWellFormedToolData('CHECK_AVAILABILITY', { status: 'RAC 4' })).toBe(true);
    expect(isWellFormedToolData('CHECK_AVAILABILITY', { weird: true })).toBe(false);
    expect(isWellFormedToolData('GET_FARE', { perPassenger: 650 })).toBe(true);
    expect(isWellFormedToolData('GET_FARE', { perPassenger: 'cheap' })).toBe(false);
    expect(isWellFormedToolData('GET_TRAIN_INFO', { trainNumber: '12497' })).toBe(true);
    expect(isWellFormedToolData('GET_TRAIN_INFO', {})).toBe(false);
    expect(isWellFormedToolData('GET_TIMETABLE', [])).toBe(true);
    expect(isWellFormedToolData('GET_TIMETABLE', 'x')).toBe(false);
    expect(isWellFormedSearch({ trains: [{ trainNumber: '12014', classes: [] }] })).toBe(true);
    expect(isWellFormedSearch({ trains: [{ trainNumber: '12014' }] })).toBe(false);
    expect(isWellFormedSearch({ foo: 1 })).toBe(false);
  });

  it('[5] runtime: malformed availability success → FAILED PROVIDER_DATA_INVALID, ONE provider call (not retried), no result', async () => {
    const ex = new FixedExecutor({ ok: true, data: { weird: true }, meta: META() });
    const x = await runOne('CHECK_AVAILABILITY', { trainNumber: '12497', travelClass: 'CC', date: KAL }, ex);
    expect(x.success).toBe(false);
    expect(x.empty).toBe(false);
    expect(x.error).toMatchObject({ code: 'PROVIDER_DATA_INVALID', normalized: 'PROVIDER_DATA_INVALID' });
    expect(x.record.status).toBe('FAILED');
    expect(x.result.result).toBeUndefined();
    expect(ex.n).toBe(1);
    expect(x.dataSource).toBe('MOCK');
  });

  it('[6] runtime: malformed SEARCH ("ok" without a trains array) is NOT an empty result', async () => {
    const ex = new FixedExecutor({ ok: true, data: { foo: 1 }, meta: META() });
    const x = await runOne('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: KAL }, ex);
    expect(x.success).toBe(false);
    expect(x.empty).toBe(false);
    expect(x.error.normalized).toBe('PROVIDER_DATA_INVALID');
    expect(toolOutcomeOf({ ok: x.success, empty: x.empty, status: x.record.status, code: x.error.code })).toBe('MALFORMED_DATA');
  });

  it('[7] runtime: provider NO_TRAINS_FOUND → SUCCEEDED empty (a real zero result); [] → empty', async () => {
    const a = await runOne('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: KAL }, new FixedExecutor({ ok: false, error: { code: 'NO_TRAINS_FOUND', message: 'none' }, meta: META() }));
    expect(a).toMatchObject({ success: true, empty: true });
    const b = await runOne('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: KAL }, new FixedExecutor({ ok: true, data: { trains: [] }, meta: META() }));
    expect(b).toMatchObject({ success: true, empty: true });
  });

  it('[8] runtime: timeout → TIMEOUT, never success/empty; transient failure → bounded retry (max 1)', async () => {
    const slow = new FixedExecutor(() => new Promise(() => {}));
    const t = await runOne('GET_FARE', { trainNumber: '12497', travelClass: 'CC', passengersCount: 1, date: KAL }, slow);
    expect(t.record.status).toBe('TIMEOUT');
    expect(t.success).toBe(false); expect(t.empty).toBe(false);
    const down = new FixedExecutor({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' }, meta: META() });
    const f = await runOne('GET_FARE', { trainNumber: '12497', travelClass: 'CC', passengersCount: 1, date: KAL }, down);
    expect(f.record.status).toBe('FAILED');
    expect(down.n).toBe(2); // original + exactly one retry
    expect(f.record.attempt).toBe(2);
  });
});

describe('P32 G2 — outcome-claim guard', () => {
  const step = (tool: string, o: { status: 'ok' | 'error' | 'stale'; empty?: boolean; code?: string; execStatus?: string; dataSource?: 'MOCK' | 'LIVE' | null }) => ({
    toolCall: { name: tool }, status: o.status, dataSource: o.dataSource ?? 'MOCK',
    result: { toolName: tool, success: o.status === 'ok', empty: o.empty, status: o.execStatus || (o.status === 'ok' ? 'SUCCEEDED' : 'FAILED'), error: o.code ? { code: o.code } : undefined, normalizedErrorCode: o.code }
  });
  const S: any = { sessionId: 's', searchResults: undefined };

  it('[9] "koi train nahi mili" stands only on a real empty search', () => {
    const t = 'Kal Amritsar se Delhi ke liye koi train nahi mili.';
    expect(verifyOutcomeClaims(t, { steps: [step('SEARCH_TRAINS', { status: 'ok', empty: true })], session: S }).reason).toBeNull();
    expect(verifyOutcomeClaims(t, { steps: [step('SEARCH_TRAINS', { status: 'error', code: 'TOOL_TIMEOUT', execStatus: 'TIMEOUT' })], session: S }).reason).toBe('NO_RESULTS_CLAIM_ON_TIMEOUT');
    expect(verifyOutcomeClaims(t, { steps: [step('SEARCH_TRAINS', { status: 'error', code: 'PROVIDER_UNAVAILABLE' })], session: S }).reason).toBe('NO_RESULTS_CLAIM_ON_PROVIDER_FAILURE');
    expect(verifyOutcomeClaims(t, { steps: [step('SEARCH_TRAINS', { status: 'error', code: 'PROVIDER_DATA_INVALID' })], session: S }).reason).toBe('NO_RESULTS_CLAIM_ON_MALFORMED_DATA');
    expect(verifyOutcomeClaims(t, { steps: [step('SEARCH_TRAINS', { status: 'stale', code: 'STALE_TOOL_RESULT' })], session: S }).reason).toBe('NO_RESULTS_CLAIM_ON_STALE');
    expect(verifyOutcomeClaims(t, { steps: [step('SEARCH_TRAINS', { status: 'ok' })], session: S }).reason).toBe('NO_RESULTS_CONTRADICTS_DATA');
    expect(verifyOutcomeClaims(t, { steps: [], session: S }).reason).toBe('NO_RESULTS_CLAIM_WITHOUT_EMPTY_RESULT');
    expect(verifyOutcomeClaims('No trains found on this route.', { steps: [step('SEARCH_TRAINS', { status: 'error', code: 'TOOL_TIMEOUT', execStatus: 'TIMEOUT' })], session: S }).reason).toBe('NO_RESULTS_CLAIM_ON_TIMEOUT');
    // restating the CURRENT empty provider set on a follow-up turn is fine
    expect(verifyOutcomeClaims(t, { steps: [], session: { ...S, searchResults: { trains: [] } } }).reason).toBeNull();
  });

  it('[10] "railway data ke according" needs provider data; "live" is never allowed for MOCK data', () => {
    const src = 'Railway data ke according 12014 subah 04:55 par chalti hai.';
    expect(verifyOutcomeClaims(src, { steps: [step('SEARCH_TRAINS', { status: 'ok' })], session: S }).reason).toBeNull();
    expect(verifyOutcomeClaims(src, { steps: [step('SEARCH_TRAINS', { status: 'error', code: 'TOOL_TIMEOUT', execStatus: 'TIMEOUT' })], session: S }).reason).toBe('SOURCE_CLAIM_ON_TIMEOUT');
    expect(verifyOutcomeClaims(src, { steps: [], session: S }).reason).toBe('SOURCE_CLAIM_WITHOUT_PROVIDER_DATA');
    const live = 'Ye live data hai: 12497 mein 3A available hai.';
    expect(verifyOutcomeClaims(live, { steps: [step('CHECK_AVAILABILITY', { status: 'ok', dataSource: 'MOCK' })], session: S }).reason).toBe('MOCK_DATA_PRESENTED_AS_LIVE');
    expect(verifyOutcomeClaims(live, { steps: [step('CHECK_AVAILABILITY', { status: 'ok', dataSource: 'LIVE' })], session: S }).reason).toBeNull();
    expect(verifyOutcomeClaims('Real-time information abhi available hai.', { steps: [], session: S }).reason).toBe('LIVE_CLAIM_WITHOUT_LIVE_DATA');
    // honest labels are not claims
    expect(verifyOutcomeClaims('Ye mock / non-live development data hai.', { steps: [step('TRACK_TRAIN', { status: 'ok' })], session: S }).reason).toBeNull();
    expect(verifyOutcomeClaims('Ye live data nahi hai.', { steps: [], session: S }).reason).toBeNull();
  });

  it('[11] the guard removes only the false sentence; an emptied reply states the REAL failure category', () => {
    const steps = [step('SEARCH_TRAINS', { status: 'error', code: 'TOOL_TIMEOUT', execStatus: 'TIMEOUT' })];
    const g = guardOutcomeClaims('Maine check kiya. Koi train nahi mili. Aap thodi der baad try karein.', { steps, session: S });
    expect(g.text).toBe('Maine check kiya. Aap thodi der baad try karein.');
    expect(g.removed.map(r => r.reason)).toEqual(['NO_RESULTS_CLAIM_ON_TIMEOUT']);
    expect(honestFailureFallback(steps)).toBe(SAFE_ERROR_MESSAGE.TOOL_TIMEOUT);
    expect(honestFailureFallback([step('CHECK_AVAILABILITY', { status: 'error', code: 'PROVIDER_UNAVAILABLE' })])).toBe(SAFE_ERROR_MESSAGE.PROVIDER_UNAVAILABLE);
    expect(honestFailureFallback([step('GET_FARE', { status: 'error', code: 'PROVIDER_DATA_INVALID' })])).toBe(SAFE_ERROR_MESSAGE.PROVIDER_DATA_INVALID);
    expect(honestFailureFallback([])).toMatch(/verified/);
  });
});

describe('P32 G2 — freshness, provider identity, bounds, policy, security', () => {
  it('[12] no cross-turn cache: TTL 0; a new turn hits the provider again; same-turn duplicate → one call', async () => {
    expect(RAILWAY_RESULT_CACHE_TTL_MS).toBe(0);
    const s = mockToolSession();
    const ex = new ScriptedRailwayExecutor();
    const args = { trainNumber: '12497', travelClass: 'CC', date: KAL };
    const t1 = turnFor(s, 'a');
    await t1.runRound([call('CHECK_AVAILABILITY', args, 'a'), call('CHECK_AVAILABILITY', args, 'b')] as any, ex, { fromLLM: true, onRejected: () => {}, onExecuted: () => true, onDuplicate: () => {} });
    expect(ex.calls).toHaveLength(1);
    const t2 = turnFor(s, 'dobara check karo');
    await t2.runRound([call('CHECK_AVAILABILITY', args, 'c')] as any, ex, { fromLLM: true, onRejected: () => {}, onExecuted: () => true });
    expect(ex.calls).toHaveLength(2);
  });

  it('[13] provider identity is explicit (MOCK); an unknown provider id throws — no silent fallback/switch', () => {
    expect(railwayRegistry.getActiveKind()).toBe('MOCK');
    const reg = new RailwayProviderRegistry();
    expect(() => reg.setActive('irctc-live')).toThrow(/Unknown railway provider/);
    expect(reg.getActiveId()).toBe(process.env.RAILWAY_PROVIDER || 'mock');
    // Prompt 35: real providers are now registered EXPLICITLY (opt-in via RAILWAY_PROVIDER; default stays mock)
    expect(reg.listAvailable()).toEqual(['mock', 'live', 'railcore', 'railkit', 'railradar']);
  });

  it('[14] step budget unchanged (8); the agent prompt tells the LLM the outcome semantics', () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(8);
    for (const k of ['NO_RESULTS', 'TIMEOUT', 'PROVIDER_FAILURE', 'MALFORMED_DATA', 'UNSUPPORTED', 'STALE', 'REJECTED', 'MOCK']) expect(NATIVE_AGENT_SYSTEM_PROMPT).toContain(k);
  });

  it('[15] confirmation: only explicit words confirm (theek hai / hmm / acha → ask again; "do it" → none)', () => {
    expect(classifyConfirmation('haan')).toBe('EXPLICIT');
    expect(classifyConfirmation('confirm')).toBe('EXPLICIT');
    expect(classifyConfirmation('theek hai')).toBe('AMBIGUOUS');
    expect(classifyConfirmation('hmm')).toBe('AMBIGUOUS');
    expect(classifyConfirmation('acha')).toBe('AMBIGUOUS');
    expect(classifyConfirmation('ok')).toBe('AMBIGUOUS');
    expect(classifyConfirmation('do it')).toBe('NONE');
    expect(classifyConfirmation('haan?')).toBe('AMBIGUOUS');
  });

  it('[16] security: the LLM tool payload carries no secrets / credentials; malformed data is never echoed raw', async () => {
    process.env.P32_FAKE_SECRET = 'sk-live-P32-UNIT-SECRET-3232';
    const ex = new FixedExecutor({ ok: true, data: { weird: true, apiKey: process.env.P32_FAKE_SECRET }, meta: META() });
    const x = await runOne('CHECK_AVAILABILITY', { trainNumber: '12497', travelClass: 'CC', date: KAL }, ex);
    expect(JSON.stringify(x.result)).not.toContain('sk-live-P32-UNIT-SECRET-3232');
    expect(JSON.stringify(x.record)).not.toContain('sk-live-P32-UNIT-SECRET-3232');
    delete process.env.P32_FAKE_SECRET;
  });
});
