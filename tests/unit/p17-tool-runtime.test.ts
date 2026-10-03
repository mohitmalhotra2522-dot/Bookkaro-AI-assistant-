/**
 * PROMPT 17 — GROUP 2: RailwayToolRuntime tests (registry, enum, schemas, normalization, date/route
 * resolution, validation, unknown / forbidden / not-implemented tools, argument security, freshness,
 * duplicates, timeout, empty results, provider failure, loop + limits, parallel execution, partial
 * failure, stale results, provider conflict, error normalization, grounding, observability, mock runtime).
 * Railway data = deterministic labelled mock (non-live). No network.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RAILWAY_TOOL_REGISTRY, resolveToolName, llmCallableTools } from '../../server/ai/tool-runtime/railway-tool-registry';
import { RailwayToolName, RAILWAY_TOOL_NAMES, FORBIDDEN_LLM_ACTIONS } from '../../shared/railway-tool-runtime';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { normalizeToolArguments, scanArgumentSecurity } from '../../server/ai/tool-runtime/tool-argument-normalizer';
import { normalizeToolErrorCode, safeErrorMessage } from '../../server/ai/tool-runtime/tool-error-normalizer';
import { RailwayToolRuntime, ToolTurn, hashArguments, MAX_TOOL_CALLS_PER_TURN, MAX_TOOL_ROUNDS_PER_TURN } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { MockRailwayToolRuntime, MOCK_TOOL_SCENARIOS, ScriptedRailwayExecutor, mockToolSession } from '../../server/ai/tool-runtime/mock-railway-tool-runtime';
import { syncJourneyVersion } from '../../server/ai/tool-runtime/journey-version';
import { isExplicitFreshRequest, RAILWAY_RESULT_CACHE_TTL_MS, RAILWAY_FRESHNESS_POLICY } from '../../server/ai/tool-runtime/freshness';
import { reconcileProviderAnswers } from '../../server/ai/tool-runtime/provider-conflict';
import { railwayResponseGrounding, UNVERIFIED_FALLBACK } from '../../server/ai/tool-runtime/railway-response-grounding';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';

const iso = (e: string) => (resolveDate(e) as any).date as string;
const KAL = iso('kal'), PARSO = iso('parso');
const mock = new MockRailwayToolRuntime({ timeoutMs: 40 });
const validator = new ToolCallValidator();
const ground = (userText: string) => ({ userText, bookings: [], pnrOwner: () => 'NONE' as const, bookingOwner: () => 'NONE' as const });
function turnFor(s: any, userText: string, opts: any = {}) {
  const rt = new RailwayToolRuntime({ timeoutMs: 40, ...opts });
  return rt.beginTurn({ sessionId: s.sessionId, turnId: 't', requestId: 'r', userText, getSession: () => s, validate: (tc, ss) => validator.validate(tc, ss, ground(userText)) as any });
}
const call = (name: string, args: any = {}, callId = `${name}-${Math.random()}`) => ({ callId, name: name as any, arguments: args });

afterEach(() => vi.restoreAllMocks());

describe('P17 G2 — registry, enum, schemas', () => {
  it('[1] registry: exactly the 9 approved tools with full metadata; ALWAYS_FRESH; schemas derived from the LLM tool list', () => {
    expect([...RAILWAY_TOOL_REGISTRY.keys()].sort()).toEqual([...RAILWAY_TOOL_NAMES].sort());
    expect(RAILWAY_TOOL_NAMES).toHaveLength(9);
    for (const m of RAILWAY_TOOL_REGISTRY.values()) {
      expect(m).toMatchObject({ name: expect.any(String), capability: expect.any(String), providerRoute: expect.any(String) });
      expect(m.inputSchema.additionalProperties).toBe(false);
      if (m.name !== 'GENERAL_RAILWAY_ANSWER') expect(m.freshnessPolicy).toBe('ALWAYS_FRESH');
      expect(Object.isFrozen(m)).toBe(true);
    }
    const llm = llmCallableTools().map(t => t.name).sort();
    expect(llm).toEqual(REGISTERED_TOOLS.map(t => t.name).sort());
    expect(RAILWAY_TOOL_REGISTRY.get('SEARCH_TRAINS')!.inputSchema.required.sort()).toEqual(['date', 'destination', 'origin']);
    expect(Object.keys(RAILWAY_TOOL_REGISTRY.get('CHECK_AVAILABILITY')!.inputSchema.fields)).toEqual(expect.arrayContaining(['trainNumber', 'date', 'origin', 'destination', 'travelClass', 'passengersCount']));
    expect(Object.keys(RAILWAY_TOOL_REGISTRY.get('TRACK_TRAIN')!.inputSchema.fields)).toEqual(expect.arrayContaining(['trainNumber', 'date']));
    expect(RAILWAY_TOOL_REGISTRY.get('GET_CANCELLED_TRAINS')).toMatchObject({ implemented: false, llmCallable: false });
    expect(RAILWAY_TOOL_REGISTRY.get('GENERAL_RAILWAY_ANSWER')).toMatchObject({ implemented: false, llmCallable: false });
    expect(RAILWAY_FRESHNESS_POLICY).toBe('ALWAYS_FRESH');
    expect(RAILWAY_TOOL_REGISTRY.get('CHECK_AVAILABILITY')!.dependsOnSelection).toBe(true);
  });

  it('[2] strict enum: exact names only; case / fuzzy / arbitrary strings are UNKNOWN; booking actions are FORBIDDEN', () => {
    expect(Object.isFrozen(RailwayToolName)).toBe(true);
    expect(resolveToolName('SEARCH_TRAINS').kind).toBe('TOOL');
    for (const n of ['search_trains', 'SEARCH_TRAIN', 'SEARCH_TRAINS ', 'gateway.execute', 'eval', '', null, 42, { name: 'SEARCH_TRAINS' }]) expect(resolveToolName(n).kind).toBe('UNKNOWN');
    for (const f of FORBIDDEN_LLM_ACTIONS) expect(resolveToolName(f).kind).toBe('FORBIDDEN');
    expect(FORBIDDEN_LLM_ACTIONS).toEqual(expect.arrayContaining(['EXECUTE_BOOKING', 'CANCEL_BOOKING', 'MODIFY_BOOKING', 'PROCESS_REFUND', 'PAYMENT', 'IRCTC_LOGIN', 'OTP', 'CAPTCHA', 'SUBMIT_BOOKING']));
    for (const f of FORBIDDEN_LLM_ACTIONS) expect(RAILWAY_TOOL_REGISTRY.has(f as any)).toBe(false);
  });

  it('[3] schema: extra fields rejected by the existing validator; missing required → no provider call', async () => {
    const s = mockToolSession();
    const t = turnFor(s, 'search');
    const p = t.prepare(call('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: KAL, priority: 'vip' }), true);
    expect(p.ok).toBe(false);
    const ex = new ScriptedRailwayExecutor();
    const m = await mock.run('MISSING_ARGS');
    expect(m.providerCalls).toBe(0);
    expect(m.results.map(r => r.status)).toEqual(['REJECTED', 'REJECTED']);
    expect(ex.calls).toHaveLength(0);
  });
});

describe('P17 G2 — normalization, date / route resolution, argument security', () => {
  const s: any = mockToolSession();
  it('[4] dates: dateExpression → DateResolver; an LLM ISO date contradicting the user\'s words is corrected', () => {
    const a: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', dateExpression: 'parso' }, s, 'parso jaana hai');
    expect(a.ok && a.arguments.date).toBe(PARSO);
    expect(a.arguments.dateExpression).toBeUndefined();
    const b: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: '2026-12-25' }, s, 'Amritsar se Delhi kal');
    expect(b.arguments.date).toBe(KAL);
    expect(b.corrections.join()).toMatch(/user said "kal"/);
    const c: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', date: 'kal' }, s, 'chalo');
    expect(c.arguments.date).toBe(KAL);
    const d: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'ASR', destination: 'NDLS', dateExpression: 'kabhi bhi' }, s, '');
    expect(d.ok).toBe(false); expect(['AMBIGUOUS_DATE', 'INVALID_DATE']).toContain(d.code);
  });

  it('[5] stations: RouteResolver names → codes; ambiguous / unknown → AMBIGUOUS_STATION (no call)', () => {
    const a: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'Amritsar', destination: 'Delhi', date: KAL }, s, '');
    expect([a.arguments.origin, a.arguments.destination]).toEqual(['ASR', 'NDLS']);
    const b: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'ambala', destination: 'NDLS', date: KAL }, s, '');
    expect(b).toMatchObject({ ok: false, code: 'AMBIGUOUS_STATION' });
    const c: any = normalizeToolArguments('SEARCH_TRAINS', { origin: 'Xyzpur', destination: 'NDLS', date: KAL }, s, '');
    expect(c.ok).toBe(false);
  });

  it('[6] quotes: journey args must match the session; LLM train ≠ selected (not typed) → ask; typed → allowed', () => {
    const a: any = normalizeToolArguments('GET_FARE', { origin: 'ASR', destination: 'LDH' }, s, 'fare');
    expect(a).toMatchObject({ ok: false, code: 'CONTEXT_CONFLICT' });
    const ok: any = normalizeToolArguments('GET_FARE', { origin: 'ASR', destination: 'NDLS' }, s, 'fare');
    expect(ok.ok).toBe(true); expect(ok.arguments.origin).toBeUndefined();
    const c: any = normalizeToolArguments('CHECK_AVAILABILITY', { trainNumber: '14542' }, s, 'availability batao');
    expect(c).toMatchObject({ ok: false, code: 'CONTEXT_CONFLICT', message: '12497 selected hai. 14542 check karna hai?' });
    const typed: any = normalizeToolArguments('CHECK_AVAILABILITY', { trainNumber: '14542' }, s, '14542 ki availability');
    expect(typed.ok).toBe(true);
  });

  it('[7] argument security: credential keys / values rejected (never forwarded); legit fields untouched', () => {
    for (const args of [{ password: 'x' }, { otp: '123456' }, { captcha: 'ab12' }, { upiPin: '1234' }, { cardNumber: '4111111111111111' }, { irctcUsername: 'u' }, { authToken: 'abc' }, { note: 'Bearer abcdefghijkl' }, { note: '4111 1111 1111 1111' }, { nested: { cvv: '123' } }]) {
      expect(scanArgumentSecurity(args as any)).toMatchObject({ ok: false, code: 'FORBIDDEN_ARGUMENT' });
    }
    for (const args of [{ passengersCount: 2 }, { pnr: '4512345678' }, { trainNumber: '12014', travelClass: 'CC', date: KAL }, { bookingId: 'bk_1' }]) expect(scanArgumentSecurity(args as any)).toBeNull();
  });

  it('[8] TRACK: run date window enforced (live data only, never a timetable substitute)', () => {
    expect(normalizeToolArguments('TRACK_TRAIN', { trainNumber: '12497', dateExpression: 'aaj' }, s, '').ok).toBe(true);
    expect(normalizeToolArguments('TRACK_TRAIN', { trainNumber: '12497', date: '2026-12-25' }, s, '')).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
  });
});

describe('P17 G2 — runtime gates and executions', () => {
  it('[9] unknown / forbidden / not-implemented / LLM-fabricated PNR → REJECTED, provider never called', async () => {
    const u = await mock.run('UNKNOWN_TOOL');
    expect(u.providerCalls).toBe(0);
    expect(u.results.map(r => r.error?.code)).toEqual(['UNKNOWN_TOOL', 'FORBIDDEN_ACTION']);
    expect(u.records.map(r => r.rejectionReason)).toEqual(['UNKNOWN_TOOL', 'FORBIDDEN_ACTION']);
    const c = await mock.run('CANCELLED_TRAINS');
    expect(c.results[0]).toMatchObject({ status: 'REJECTED', error: { code: 'TOOL_NOT_IMPLEMENTED' }, fresh: false });
    expect(c.providerCalls).toBe(0);
    const inv = await mock.run('INVALID_ARGS');
    expect(inv.results.map(r => r.error?.detail)).toEqual(['FORBIDDEN_ARGUMENT', 'AUTHORITATIVE_DATA_REQUIRED']);
    expect(inv.providerCalls).toBe(0);
  });

  it('[10] successful executions carry freshness metadata (toolExecutionId / provider / fetchedAt / fresh / requestId / journeyVersion)', async () => {
    for (const sc of ['SEARCH_SUCCESS', 'TRAIN_INFO', 'TIMETABLE', 'AVAILABILITY', 'FARE', 'TRACK', 'PNR'] as const) {
      const o = await mock.run(sc);
      expect(o.providerCalls).toBe(1);
      const r = o.results[0];
      expect(r).toMatchObject({ status: 'SUCCEEDED', fresh: true, meta: { source: 'RAILWAY_PROVIDER', provider: 'mock-tool-runtime', fresh: true, requestId: 'req-t1' } });
      expect(r.toolExecutionId).toMatch(/^tx_/);
      expect(r.meta.toolExecutionId).toBe(r.toolExecutionId);
      expect(Date.parse(r.meta.fetchedAt)).not.toBeNaN();
      expect(r.meta.journeyVersion).toBeGreaterThan(0);
      expect(o.records[0]).toMatchObject({ status: 'SUCCEEDED', fresh: true, sessionId: 'mock-tool-session', turnId: 't1' });
      expect(o.records[0].latencyMs).not.toBeNull();
    }
    const pnr = await mock.run('PNR');
    expect(JSON.stringify(pnr.results)).not.toContain('4512345678');
    expect(JSON.stringify(pnr.records)).not.toContain('4512345678');
    expect(pnr.records[0].argumentsSummary.pnr).toBe('45******78');
  });

  it('[11] SUCCESS + [] is an empty RESULT (SUCCEEDED, empty, count 0) — not a failure', async () => {
    const o = await mock.run('SEARCH_EMPTY');
    expect(o.results[0]).toMatchObject({ status: 'SUCCEEDED', empty: true, fresh: true });
    expect((o.results[0].result as any).trains).toEqual([]);
    expect(o.records[0].resultCount).toBe(0);
  });

  it('[12] timeout → TIMEOUT (never SUCCEEDED, never empty, never zero availability)', async () => {
    const o = await mock.run('TIMEOUT');
    expect(o.results[0]).toMatchObject({ status: 'TIMEOUT', fresh: false, error: { code: 'TOOL_TIMEOUT' } });
    expect(o.results[0].result).toBeUndefined();
    expect(o.results[0].empty).toBeUndefined();
  });

  it('[13] provider failure → FAILED with a normalized, safe error', async () => {
    const o = await mock.run('PROVIDER_FAILURE');
    expect(o.results[0]).toMatchObject({ status: 'FAILED', error: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(o.results[0].error!.message).not.toMatch(/stack|Error:/);
  });

  it('[14] parallel: independent calls run concurrently (one parallel group); results kept in call order', async () => {
    const t0 = Date.now();
    const o = await mock.run('PARALLEL_SUCCESS');
    const took = Date.now() - t0;
    expect(o.providerCalls).toBe(3);
    expect(o.results.map(r => r.tool)).toEqual(['GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE']);
    expect(o.results.every(r => r.status === 'SUCCEEDED')).toBe(true);
    expect(new Set(o.records.map(r => r.parallelGroup)).size).toBe(1);
    expect(o.records[0].parallelGroup).not.toBeNull();
    expect(took).toBeLessThan(55);   // 3 × 20 ms sequential would be ≥ 60 ms
  });

  it('[15] dependencies: SEARCH_TRAINS is a barrier — calls after it form a separate (later) segment', () => {
    const seg = ToolTurn.segments([call('GET_TIMETABLE'), call('SEARCH_TRAINS'), call('CHECK_AVAILABILITY'), call('GET_FARE')] as any);
    expect(seg.map(g => g.map(c => c.name))).toEqual([['GET_TIMETABLE'], ['SEARCH_TRAINS'], ['CHECK_AVAILABILITY', 'GET_FARE']]);
  });

  it('[16] partial failure keeps the successful result', async () => {
    const o = await mock.run('PARTIAL_FAILURE');
    expect(o.results.map(r => r.status)).toEqual(['SUCCEEDED', 'FAILED']);
    expect(o.results[0].result).toBeTruthy();
  });

  it('[17] loop: the 3rd identical request in a turn → TOOL_LOOP_DETECTED, turn stops', async () => {
    const o = await mock.run('LOOP');
    expect(o.providerCalls).toBe(2);
    expect(o.stopped).toBe(true);
    expect(o.results.slice(-1)[0].error?.code).toBe('TOOL_LOOP_DETECTED');
  });

  it('[18] limits: MAX_TOOL_CALLS_PER_TURN=8 (9th rejected, stop) and MAX_TOOL_ROUNDS_PER_TURN=5', async () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(8); expect(MAX_TOOL_ROUNDS_PER_TURN).toBe(5);
    const s = mockToolSession();
    const t = turnFor(s, 'info');
    const ex = new ScriptedRailwayExecutor();
    const calls = Array.from({ length: 9 }, (_, i) => call('GET_TRAIN_INFO', { trainNumber: String(12000 + i) }));
    const rej: any[] = [];
    const r = await t.runRound(calls as any, ex, { fromLLM: true, onRejected: p => rej.push(p), onExecuted: () => true });
    expect(r).toBe('stop');
    expect(ex.calls).toHaveLength(8);
    expect(rej.map(p => p.error.code)).toEqual(['TOOL_CALL_LIMIT_EXCEEDED']);
    const t2 = turnFor(s, 'x');
    expect([1, 2, 3, 4, 5, 6].map(() => t2.startRound())).toEqual([true, true, true, true, true, false]);
    // deterministic backend prep calls are exempt from the LLM budget
    const t3 = turnFor(s, 'x');
    const ex3 = new ScriptedRailwayExecutor();
    await t3.runRound(calls as any, ex3, { fromLLM: false, onRejected: () => {}, onExecuted: () => true });
    expect(ex3.calls).toHaveLength(9);
  });

  it('[19] duplicates: identical calls in one parallel segment → ONE provider call (accidental duplicate only)', async () => {
    const s = mockToolSession();
    const t = turnFor(s, 'tt');
    const ex = new ScriptedRailwayExecutor();
    const dups: string[] = [];
    await t.runRound([call('GET_TIMETABLE', { trainNumber: '12497' }, 'a'), call('GET_TIMETABLE', { trainNumber: '12497' }, 'b')] as any, ex,
      { fromLLM: true, onRejected: () => {}, onExecuted: () => true, onDuplicate: (tc) => dups.push(tc.callId) });
    expect(ex.calls).toHaveLength(1);
    expect(dups).toEqual(['b']);
  });

  it('[20] freshness: no application cache — a repeated request on a new turn ("abhi dobara check karo") hits the provider again', async () => {
    expect(RAILWAY_RESULT_CACHE_TTL_MS).toBe(0);
    const o = await mock.run('FRESH_REPEAT');
    expect(o.providerCalls).toBe(2);
    expect(o.results.map(r => r.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(o.results[0].toolExecutionId).not.toBe(o.results[1].toolExecutionId);
    for (const t of ['abhi dobara check karo', 'latest availability batao', 'PNR phir se check karo', 'fresh status', 'current fare']) expect(isExplicitFreshRequest(t)).toBe(true);
    expect(isExplicitFreshRequest('fare batao')).toBe(false);
  });

  it('[21] stale: journey changes while a quote is in flight → CANCELLED (STALE_TOOL_RESULT), never applied', async () => {
    const o = await mock.run('STALE_RESULT');
    expect(o.results[0]).toMatchObject({ status: 'CANCELLED', error: { code: 'STALE_TOOL_RESULT' } });
    expect(o.records[0].status).toBe('CANCELLED');
  });

  it('[22] journeyVersion increments only on material journey change (origin / destination / date)', () => {
    const st = new ConversationStateManager();
    const s: any = st.createSession();
    const v0 = syncJourneyVersion(s);
    s.origin = 'ASR'; s.destination = 'NDLS'; s.date = KAL; st.bump(s.sessionId);
    const v1 = s.journeyVersion;
    expect(v1).toBeGreaterThan(v0);
    s.passengersCount = 3; s.selectedClass = 'CC'; st.bump(s.sessionId);
    expect(s.journeyVersion).toBe(v1);
    s.date = PARSO; st.bump(s.sessionId);
    expect(s.journeyVersion).toBe(v1 + 1);
  });

  it('[23] provider conflict → PROVIDER_DATA_CONFLICT (never merged); agreeing answers pass', async () => {
    const o = await mock.run('PROVIDER_CONFLICT');
    expect(o.conflict).toEqual({ code: 'PROVIDER_DATA_CONFLICT', providers: ['mock-tool-runtime', 'mock-secondary'] });
    const same = reconcileProviderAnswers([{ provider: 'a', ok: true, data: { status: 'RAC 4' } }, { provider: 'b', ok: true, data: { status: 'RAC 4' } }]);
    expect(same.ok).toBe(true);
  });

  it('[24] error normalization maps provider codes onto the stable vocabulary; unsafe messages replaced', () => {
    const m: Record<string, string> = {
      TIMEOUT: 'TOOL_TIMEOUT', PNR_PROVIDER_TIMEOUT: 'TOOL_TIMEOUT', NO_TRAINS_FOUND: 'NO_RESULTS', PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
      RATE_LIMITED: 'RATE_LIMITED', AUTH_FAILED: 'AUTH_ERROR', AVAILABILITY_UNAVAILABLE: 'DATA_UNAVAILABLE', INVALID_DATE: 'INVALID_REQUEST',
      MISSING_REQUIRED_FIELD: 'INVALID_REQUEST', WEIRD: 'TOOL_FAILED', '': 'UNKNOWN', TOOL_UNAVAILABLE: 'TOOL_NOT_IMPLEMENTED'
    };
    for (const [k, v] of Object.entries(m)) expect(normalizeToolErrorCode(k)).toBe(v);
    expect(safeErrorMessage('TOOL_FAILED', 'TypeError: x\n    at foo (/srv/a.js:1)')).not.toMatch(/TypeError|at foo/);
    expect(safeErrorMessage('TOOL_FAILED', 'Provider down, try later.')).toBe('Provider down, try later.');
  });

  it('[25] observability: arguments hashed (stable, non-reversible); no raw sensitive values in records', async () => {
    expect(hashArguments('GET_FARE', { a: 1, b: 2 })).toBe(hashArguments('GET_FARE', { b: 2, a: 1 }));
    expect(hashArguments('GET_FARE', { a: 1 })).toMatch(/^[0-9a-f]{8}$/);
    const o = await mock.run('INVALID_ARGS');
    const js = JSON.stringify(o.records);
    expect(js).not.toContain('"password"');
    expect(js).not.toContain('9876543210');
    for (const r of o.records) expect(Object.keys(r)).toEqual(expect.arrayContaining(['sessionId', 'turnId', 'toolExecutionId', 'journeyVersion', 'tool', 'argumentsHash', 'provider', 'requestedAt', 'completedAt', 'status', 'fresh', 'latencyMs', 'resultCount', 'rejectionReason']));
  });

  it('[26] grounding validator: invented timings / punctuality / PNR status / availability codes removed; fallback when nothing verified', () => {
    const s: any = mockToolSession();
    const g = railwayResponseGrounding.validate('12497 05:10 par chalti hai. Ye usually on time chalti hai. PNR 4512345678 confirm hai. Abhi WL 12 hai.', { session: s, steps: [] });
    expect(g.text).toBe('12497 05:10 par chalti hai.');
    expect(g.rejected).toEqual(expect.arrayContaining(['PUNCTUALITY_CLAIM', 'AVAILABILITY_CODE']));
    expect(g.rejected.some(r => r.startsWith('PNR'))).toBe(true);
    const none = railwayResponseGrounding.validate('Ye train 07:45 par Ludhiana pahunchti hai.', { session: s, steps: [] });
    expect(none).toMatchObject({ text: '', replaced: true });
    expect(UNVERIFIED_FALLBACK).toBe('Is information ka verified result available nahi hai.');
    const live = railwayResponseGrounding.validate('12497 abhi 12 min late chal rahi hai.', { session: s, steps: [{ status: 'ok', result: { toolName: 'TRACK_TRAIN', data: { delayMinutes: 12 } } }] });
    expect(live.rejected).toEqual([]);
  });

  it('[27] all 20 mock scenarios are deterministic (same statuses on repeat runs)', async () => {
    expect(MOCK_TOOL_SCENARIOS).toHaveLength(20);
    for (const sc of MOCK_TOOL_SCENARIOS) {
      const a = await mock.run(sc); const b = await mock.run(sc);
      expect(a.results.map(r => `${r.tool}:${r.status}:${r.error?.code || ''}`)).toEqual(b.results.map(r => `${r.tool}:${r.status}:${r.error?.code || ''}`));
      expect(a.providerCalls).toBe(b.providerCalls);
    }
  });
});
