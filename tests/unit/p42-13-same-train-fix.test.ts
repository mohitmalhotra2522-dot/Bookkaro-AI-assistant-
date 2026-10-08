/**
 * P42-13 Part 1 — same-train fix (F1 + F2).
 * F1: a same-train search without a class (chip / fallback text, voice or text) resolves the class from the train's
 *     authoritative search row — the first class whose own status is a meaningful shortage for the party (the same rule
 *     as background discovery). Tool-execution only: selectedClass / requestedClass / preferences never change; no
 *     shortage class → the class is still asked (NOT_READY).
 * F2: a route failure keeps its real reason — rate limit (provider 429 or the local pacer refusing before any request)
 *     → RATE_LIMITED, outage → PROVIDER_UNAVAILABLE, timeout → ALTERNATIVE_SEARCH_TIMEOUT; INVALID_TRAIN_ROUTE only for
 *     a genuine route verdict (NOT_FOUND / TRAIN_NOT_FOUND / NO_RESULTS / PROVIDER_DATA_INVALID).
 * Test data only; no network, no credits.
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import { ToolCallValidator, firstShortageClass } from '../../server/ai/tools/tool-call-validator';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { runSameTrainSearch, type SameTrainDeps, type ProviderRef, type SameTrainSearchRequest } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS, SAME_TRAIN_ALL_FAILED_MESSAGE, SAME_TRAIN_PROVIDER_BUSY_MESSAGE, SameTrainErrorCode } from '../../shared/same-train-alternatives';
import { sameTrainFallbackText } from '../../server/railway/same-train/same-train-view';

const DATE = '2026-10-09';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
const ROUTE = [['ASR', 'Amritsar Jn'], ['JUC', 'Jalandhar City'], ['LDH', 'Ludhiana Jn'], ['UMB', 'Ambala Cant Jn'], ['NDLS', 'New Delhi']]
  .map(([station, stationName]) => ({ station, stationName }));

function sessionWith(classes: Array<[string, string]>, opts: { requestedClass?: string; selectedClass?: string; pax?: number } = {}) {
  const state = new ConversationStateManager();
  const s: any = state.createSession();
  Object.assign(s, { origin: 'ASR', destination: 'NDLS', date: DATE, passengersCount: opts.pax ?? 2, requestedClass: opts.requestedClass, searchResultsVersion: 1, journeyVersion: 1,
    searchResults: { version: 1, journey: { origin: 'ASR', destination: 'NDLS', date: DATE },
      trains: [{ trainNumber: '12414', trainName: 'Pooja SF Express', classes: classes.map(([code, availability]) => ({ code, availability })) }] } });
  if (opts.selectedClass) {
    s.selectedTrain = { number: '12414', name: 'Pooja SF Express', classes: s.searchResults.trains[0].classes, searchResultsVersion: 1 };
    s.selectedClass = opts.selectedClass;
  }
  return s;
}
const v = new ToolCallValidator();
const validate = (s: any, args: any = {}) => v.validate({ callId: 'c1', name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', arguments: { trainNumber: '12414', ...args } } as any, s, { userText: 'same train alternative dikhao' } as any);

describe('P42-13 F1 — missing class resolves from the authoritative row (tool-only)', () => {
  it('[1] no class anywhere → the first shortage class of the row seeds the search; the matrix keeps every row class', () => {
    const s = sessionWith([['2A', 'AVAILABLE-0009'], ['SL', 'WL 4'], ['3A', 'WL 2']]);
    expect(validate(s)).toMatchObject({ ok: true, v: { arguments: { travelClass: 'SL', classes: 'SL,2A,3A' } } });
  });
  it('[2] RAC, enough seats and UNKNOWN never seed; too few seats for the party does (pax-aware)', () => {
    expect(firstShortageClass({ classes: [{ code: '2A', availability: 'RAC 3' }, { code: '1A', availability: 'AVAILABLE-0005' }, { code: 'CC', availability: '???' }, { code: '3A', availability: 'AVAILABLE-0001' }] }, 2)).toBe('3A');
    expect(firstShortageClass({ classes: [{ code: '3A', availability: 'AVAILABLE-0002' }] }, 2)).toBe('');
    expect(firstShortageClass({ classes: [{ code: '3A', availability: 'AVAILABLE-0002' }] }, 3)).toBe('3A');
  });
  it('[3] REGRET / NOT AVAILABLE seed; TRAIN CANCELLED never does; malformed codes are skipped', () => {
    expect(firstShortageClass({ classes: [{ code: 'SL', availability: 'TRAIN CANCELLED' }, { code: 'bad code', availability: 'WL 1' }, { code: 'CC', availability: 'REGRET' }] }, 1)).toBe('CC');
    expect(firstShortageClass({ classes: [{ code: 'EC', availability: 'NOT AVAILABLE' }] }, 1)).toBe('EC');
    expect(firstShortageClass({ classes: [{ code: 'SL', availability: 'TRAIN CANCELLED' }] }, 1)).toBe('');
    expect(firstShortageClass(undefined, 1)).toBe('');
  });
  it('[4] no shortage class on the row → still NOT_READY (the class is asked, never guessed)', () => {
    const s = sessionWith([['2A', 'AVAILABLE-0009'], ['SL', 'RAC 2']]);
    expect(validate(s)).toMatchObject({ ok: false, error: { code: SameTrainErrorCode.NOT_READY, details: { missing: 'travelClass' } } });
  });
  it('[5] the inferred class is NEVER written: selectedClass / requestedClass / preferences / selection unchanged', () => {
    const s = sessionWith([['SL', 'WL 4'], ['3A', 'WL 2']]);
    s.preferences = { berth: 'LOWER' };
    const before = JSON.stringify({ sc: s.selectedClass, rc: s.requestedClass, st: s.selectedTrain, p: s.preferences, v: s.sessionVersion, sr: s.searchResultsVersion });
    expect(validate(s)).toMatchObject({ ok: true, v: { arguments: { travelClass: 'SL' } } });
    expect(JSON.stringify({ sc: s.selectedClass, rc: s.requestedClass, st: s.selectedTrain, p: s.preferences, v: s.sessionVersion, sr: s.searchResultsVersion })).toBe(before);
    expect(s.selectedClass).toBeUndefined(); expect(s.requestedClass).toBeUndefined();
  });
  it('[6] precedence unchanged: argument → selected class → requested class → (only then) the row shortage class', () => {
    expect(validate(sessionWith([['SL', 'WL 4'], ['3A', 'WL 2']]), { travelClass: '3A' })).toMatchObject({ ok: true, v: { arguments: { travelClass: '3A' } } });
    expect(validate(sessionWith([['SL', 'WL 4'], ['3A', 'WL 2']], { selectedClass: '3A' }))).toMatchObject({ ok: true, v: { arguments: { travelClass: '3A' } } });
    expect(validate(sessionWith([['SL', 'WL 4'], ['3A', 'WL 2']], { requestedClass: '3A' }))).toMatchObject({ ok: true, v: { arguments: { travelClass: '3A' } } });
  });
  it('[7] the party size from the call (or the session) decides the shortage; the requested-pair gate (NOT_NEEDED) is unchanged', () => {
    const s = sessionWith([['3A', 'AVAILABLE-0002'], ['SL', 'AVAILABLE-0009']], { pax: 2 });
    expect(validate(s)).toMatchObject({ ok: false, error: { code: SameTrainErrorCode.NOT_READY } });
    expect(validate(s, { passengersCount: 3 })).toMatchObject({ ok: true, v: { arguments: { travelClass: '3A', passengersCount: 3 } } });
  });
});

// ------------------------------------------------------------------------------------------------ F2
const LIMITS = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 150, totalTimeoutMs: 2000 };
function deps(route: (p: ProviderRef) => any) {
  const calls: string[] = []; const routeCalls: string[] = [];
  const d: SameTrainDeps = {
    limits: LIMITS,
    getRoute: async p => { routeCalls.push(p.id); return route(p); },
    checkAvailability: async (_p, q) => { calls.push(`${q.origin}-${q.destination}`); return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: 'GNWL 4' } }; }
  };
  return { d, calls, routeCalls };
}
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 1, trainNumber: '12414', date: DATE, travelClass: 'SL', passengersCount: 1,
  origin: 'JUC', destination: 'UMB', originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false,
  providers: [RC], routeProvider: RC, webProviders: [], ...over
} as any);
const fail = (code: string, extra: any = {}) => ({ ok: false, error: { code, ...extra } });

describe('P42-13 F2 — route failures keep their real reason', () => {
  it('[8] provider 429 on the route → RATE_LIMITED (not INVALID_TRAIN_ROUTE); no availability call is spent', async () => {
    const m = deps(() => fail('RATE_LIMITED', { httpStatus: 429 }));
    const r = await runSameTrainSearch(REQ(), m.d);
    expect(r).toMatchObject({ ok: false, code: 'RATE_LIMITED', errorClass: 'PROVIDER_UNAVAILABLE' });
    expect(m.calls).toHaveLength(0);
  });
  it('[9] the local pacer refusing BEFORE any request (localThrottle, 0 ms) → RATE_LIMITED, never an invalid route', async () => {
    const m = deps(() => ({ ...fail('RATE_LIMITED', { retryable: true }), latencyMs: 0, localThrottle: true }));
    const r = await runSameTrainSearch(REQ(), m.d);
    expect(r).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    if (!r.ok) expect(r.code).not.toBe('INVALID_TRAIN_ROUTE');
  });
  it('[10] provider outage → PROVIDER_UNAVAILABLE; route timeout (code or hang) → ALTERNATIVE_SEARCH_TIMEOUT', async () => {
    expect(await runSameTrainSearch(REQ(), deps(() => fail('PROVIDER_UNAVAILABLE')).d)).toMatchObject({ ok: false, code: 'PROVIDER_UNAVAILABLE', errorClass: 'PROVIDER_UNAVAILABLE' });
    expect(await runSameTrainSearch(REQ(), deps(() => fail('TIMEOUT')).d)).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_TIMEOUT', errorClass: 'TOOL_TIMEOUT' });
    expect(await runSameTrainSearch(REQ(), deps(() => new Promise(() => { /* hang */ })).d)).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_TIMEOUT' });
  });
  it('[11] only a genuine route verdict is INVALID_TRAIN_ROUTE; any other fault is ALTERNATIVE_SEARCH_FAILED (no generic route fallback)', async () => {
    for (const c of ['NOT_FOUND', 'TRAIN_NOT_FOUND', 'NO_RESULTS', 'PROVIDER_DATA_INVALID']) {
      expect(await runSameTrainSearch(REQ(), deps(() => fail(c)).d)).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE' });
    }
    for (const c of ['AUTH_ERROR', 'NOT_CONFIGURED', 'TOOL_NOT_IMPLEMENTED', '']) {
      expect(await runSameTrainSearch(REQ(), deps(() => fail(c)).d)).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_FAILED' });
    }
    // a route that the provider returned but is unusable (< 2 stations) stays INVALID_TRAIN_ROUTE
    expect(await runSameTrainSearch(REQ(), deps(() => ({ ok: true, data: [{ station: 'JUC' }] })).d)).toMatchObject({ ok: false, code: 'INVALID_TRAIN_ROUTE' });
  });
  it('[12] backend route fallback unchanged: RailCore RATE_LIMITED → RailRadar route used; both limited → RATE_LIMITED (true reason)', async () => {
    const ok = deps(p => (p.id === 'railcore' ? fail('RATE_LIMITED') : { ok: true, data: ROUTE }));
    const r1 = await runSameTrainSearch(REQ({ routeFallback: RR } as any), ok.d);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.result.route).toMatchObject({ provider: 'railradar', fallbackUsed: true, fallbackReason: 'RATE_LIMITED' });
    const both = deps(() => fail('RATE_LIMITED'));
    expect(await runSameTrainSearch(REQ({ routeFallback: RR } as any), both.d)).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(both.routeCalls).toEqual(['railcore', 'railradar']);
  });
  it('[13] user-facing fallback text: busy message for RATE_LIMITED / PROVIDER_UNAVAILABLE; route message only for INVALID_TRAIN_ROUTE', () => {
    expect(sameTrainFallbackText(null, 'RATE_LIMITED')).toBe(SAME_TRAIN_PROVIDER_BUSY_MESSAGE);
    expect(sameTrainFallbackText(null, 'PROVIDER_UNAVAILABLE')).toBe(SAME_TRAIN_PROVIDER_BUSY_MESSAGE);
    expect(SAME_TRAIN_PROVIDER_BUSY_MESSAGE).not.toMatch(/route/i);
    expect(sameTrainFallbackText(null, 'INVALID_TRAIN_ROUTE')).toMatch(/route verify nahi/);
    expect(sameTrainFallbackText(null, 'ALTERNATIVE_SEARCH_FAILED')).toBe(SAME_TRAIN_ALL_FAILED_MESSAGE);
    expect(sameTrainFallbackText(null, 'ALTERNATIVE_SEARCH_TIMEOUT')).toBe(SAME_TRAIN_ALL_FAILED_MESSAGE);
  });
});
