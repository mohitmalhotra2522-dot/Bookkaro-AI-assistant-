/**
 * Phase 2 shared policy — Muse's SEARCH_SAME_TRAIN_ALTERNATIVES tool follows EXACTLY the automatic display's rules
 * (same-train-policy is the single implementation). MOCK only — no network, no credits, no booking.
 *
 *   [MP1]  WL-only eligibility: automatic display ≡ Muse validator ≡ UI gate (AVAILABLE / RAC / REGRET / NOT AVAILABLE /
 *          CANCELLED / unknown never searched; explicitUserRequest does not override)
 *   [MP2]  class matrix: same waitlisted classes on both paths; Muse's explicit list narrows, never widens
 *   [MP3]  same search: identical provider queries, staged order and results on both paths (stage A → B → terminus)
 *   [MP4]  staged expansion on Muse's path: a stage-A seat stops the search; nothing → origin, then terminus
 *   [MP5]  rate limits: ≤ 3 probes in flight on Muse's path; train slots shared (Muse at the front; busy → honest error)
 *   [MP6]  stale result on Muse's path: ⚠ not a verdict, never VERIFIED; Select = fresh re-check
 *   [MP7]  lower WL: labelled "Waiting List — not confirmed", never VERIFIED
 *   [MP8]  no drift: date / passengers / train / class preserved; a provider answer for another date is rejected
 *   [MP9]  BFE safety-net eligibility follows WL-only
 *   [MP10] rollback: SAME_TRAIN_MUSE_SHARED_POLICY=off → pre-Phase-2 tool behaviour
 * Routes / statuses are TEST DATA (the app always takes them from the provider).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { LLMToolCallingRuntime } from '../../server/ai/runtime/llm-tool-runtime';
import { discoverSameTrainForDisplay } from '../../server/railway/same-train/same-train-session';
import { revalidateSameTrainAlternative, scheduledSameTrainDeps } from '../../server/railway/same-train/same-train-service';
import { resetSameTrainSchedulers } from '../../server/railway/same-train/same-train-scheduler';
import { sameTrainLLMView } from '../../server/railway/same-train/same-train-view';
import {
  acquireTrainSlot, sameTrainTrainSlotsForTests, applySameTrainPolicyToBfe, boardFromEarlierConfigFromEnv, musePolicyFromEnv,
  sharedSameTrainDeps, eligibleClassMatrix, rowClassesOf
} from '../../server/railway/same-train/same-train-policy';
import { evaluateBfeEligibility } from '../../shared/bfe-eligibility';
import { isVerifiedSameTrainAlternative, SAME_TRAIN_NOT_NEEDED } from '../../shared/same-train-shortage';
import { BETTER_WAITLIST_LABEL, SameTrainErrorCode, type SameTrainAlternativesResult } from '../../shared/same-train-alternatives';
import { needsSameTrainDiscovery } from '../../src/components/trains/SameTrainInline';

const DATE = '2026-10-12';
const TRAIN = '11906';
const L = (i: number) => `ZX${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`;
/** 40 stations ZXAA … ZXBN (index 0 … 39): requested origin index 20, requested destination index 25, terminal 39 */
const CODES = Array.from({ length: 40 }, (_, i) => L(i));
const O = CODES[20], D = CODES[25];
const ix = (c: string) => CODES.indexOf(c);
const MIN = 60_000;

type Q = { trainNumber: string; travelClass: string; date: string; origin: string; destination: string };
type Answer = string | { status: string; updated?: string; date?: string };
/** fake RailwayToolService (the one both paths hand to the shared deps builder) */
function fakeTools(fn: (q: Q) => Answer, o: { delayMs?: number; routeDay?: (i: number) => number } = {}) {
  const calls: Q[] = [];
  let inflight = 0, maxInflight = 0;
  const tools: any = {
    providerLabel: 'mock',
    GET_TIMETABLE: async () => ({ ok: true, data: CODES.map((c, i) => ({ station: c, stationName: `Stop ${i}`, departure: `${String(i % 24).padStart(2, '0')}:10`, day: o.routeDay ? o.routeDay(i) : 1 })) }),
    CHECK_AVAILABILITY: async (q: Q) => {
      calls.push({ trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, origin: q.origin, destination: q.destination });
      inflight++; maxInflight = Math.max(maxInflight, inflight);
      if (o.delayMs) await new Promise(r => setTimeout(r, o.delayMs));
      inflight--;
      const a = fn(q); const st = typeof a === 'string' ? { status: a } : a;
      return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: st.date ?? q.date, status: st.status, ...(st.updated ? { providerUpdatedAt: st.updated } : {}) } };
    }
  };
  return { tools, calls, max: () => maxInflight };
}

function session(classes: Array<[string, string | null]>, o: { pax?: number; requestedClass?: string } = {}) {
  const state = new ConversationStateManager();
  const s: any = state.createSession();
  Object.assign(s, { origin: O, destination: D, date: DATE, passengersCount: o.pax ?? 1, requestedClass: o.requestedClass, searchResultsVersion: 1, journeyVersion: 1,
    searchResults: { version: 1, date: DATE, origin: O, destination: D, retrievedAt: new Date(Date.now() - 1000).toISOString(), journey: { origin: O, destination: D, date: DATE },
      trains: [{ trainNumber: TRAIN, trainName: 'HSX AGC EXP', classes: classes.map(([code, availability]) => ({ code, availability })) }] } });
  return { state, s, sid: s.sessionId as string };
}

const validator = new ToolCallValidator();
const museValidate = (s: any, args: Record<string, unknown> = {}) =>
  validator.validate({ callId: 'c1', name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', arguments: { trainNumber: TRAIN, ...args } } as any, s, { userText: `${TRAIN} same train alternative dikhao` } as any) as any;

/** Muse's tool path: validator → BoundToolRuntime.runSameTrainSearch (its real deps / policy wiring) → shared engine */
async function museRun(s: any, tools: any, args: Record<string, unknown> = {}) {
  const v = museValidate(s, args);
  if (!v.ok) return { validated: v, out: null as any };
  const rt = new LLMToolCallingRuntime({ providerId: 'mock' } as any, tools).bind(() => s, () => {}, { turnId: `t-${Math.random()}`, requestId: 'r1' } as any);
  const out = await (rt as any).runSameTrainSearch(v.v, undefined);
  return { validated: v, out };
}
const autoRun = (st: { state: ConversationStateManager; sid: string }, tools: any, travelClass?: string) =>
  discoverSameTrainForDisplay(st.state, st.sid, { trainNumber: TRAIN, ...(travelClass ? { travelClass } : {}), searchResultsVersion: 1 }, { tools, env: process.env });

const sig = (r: SameTrainAlternativesResult) => r.alternatives.map(a => [a.ticketOrigin, a.ticketDestination, a.travelClass, a.date, a.availability, a.availabilityStatusText ?? null, a.bookFrom, a.boardAt].join('|')).sort();
const qsig = (calls: Q[]) => calls.map(q => [q.origin, q.destination, q.travelClass, q.date].join('|')).sort();

const ENV_KEYS = ['SAME_TRAIN_MUSE_SHARED_POLICY', 'SAME_TRAIN_WL_ONLY', 'SAME_TRAIN_STAGED_DEPTH', 'SAME_TRAIN_TOTAL_TIMEOUT_MS', 'SAME_TRAIN_PACED_QUEUE'];
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

// ================================================================= eligibility + class matrix
describe('Phase 2 shared policy — eligibility (Muse ≡ automatic display ≡ UI gate)', () => {
  const CASES: Array<[string | null, number, boolean]> = [
    ['GNWL 5', 1, true], ['RLWL1/WL1', 2, true], ['WL 17', 3, true], ['GNWL51/WL17', 1, true],
    ['RAC 4', 1, false], ['AVAILABLE-0001', 3, false], ['AVAILABLE-0010', 3, false], ['REGRET', 1, false],
    ['NOT AVAILABLE', 1, false], ['TRAIN CANCELLED', 1, false], [null, 1, false]
  ];
  it('[MP1] WL-only: the same verdict on every path for every status (no provider call when not eligible)', async () => {
    for (const [status, pax, eligible] of CASES) {
      const st = session([['SL', status]], { pax });
      const ft = fakeTools(() => 'GNWL 9');
      const auto = await autoRun(st, ft.tools, 'SL');
      const muse = museValidate(session([['SL', status]], { pax }).s, { travelClass: 'SL' });
      const ui = needsSameTrainDiscovery(status, pax);
      const label = `${status} / ${pax} pax`;
      expect(auto.code !== 'NOT_NEEDED', label).toBe(eligible);
      expect(muse.ok, label).toBe(eligible);
      expect(ui, label).toBe(eligible);
      if (!eligible) {
        expect(ft.calls, label).toHaveLength(0);
        // known status that is not a waitlist → NOT_NEEDED; no status at all → availability must be checked first
        expect(muse.error.code, label).toBe(status ? SAME_TRAIN_NOT_NEEDED : SameTrainErrorCode.NOT_READY);
        expect(muse.error.details.reason, label).toBe(status ? 'NOT_WAITLIST' : 'WAITLIST_NOT_VERIFIED');
      }
    }
  });
  it('[MP1b] the user\'s explicit "aur options" does not override WL-only (Muse cannot search an AVAILABLE / RAC / REGRET class)', () => {
    for (const status of ['AVAILABLE-0001', 'RAC 2', 'REGRET']) {
      const r = museValidate(session([['3A', status]], { pax: 2 }).s, { travelClass: '3A', explicitUserRequest: true });
      expect(r).toMatchObject({ ok: false, error: { code: SAME_TRAIN_NOT_NEEDED, details: { reason: 'NOT_WAITLIST' } } });
    }
  });
  it('[MP2] class matrix: both paths search exactly the row\'s waitlisted classes (seed first); Muse\'s list narrows, never widens', async () => {
    const row: Array<[string, string]> = [['2A', 'AVAILABLE-0009'], ['SL', 'WL 4'], ['3A', 'GNWL 2'], ['1A', 'REGRET'], ['CC', 'RAC 3']];
    const st = session(row);
    const auto = await autoRun(st, fakeTools(q => (q.origin === CODES[19] ? 'AVAILABLE-0004' : 'GNWL 9')).tools);
    expect(auto.ok).toBe(true);
    expect(auto.result!.classesChecked).toEqual(['SL', '3A']);
    expect(museValidate(session(row).s).v.arguments).toMatchObject({ travelClass: 'SL', classes: 'SL,3A' });
    expect(museValidate(session(row).s, { classes: 'ALL' }).v.arguments.classes).toBe('SL,3A');
    expect(museValidate(session(row).s, { classes: 'SL,2A,1A' }).v.arguments.classes).toBe('SL');
    expect(museValidate(session(row).s, { travelClass: '3A', classes: 'REQUESTED' }).v.arguments.classes).toBe('3A');
    // a class the train does not list is still refused (never invented)
    expect(museValidate(session(row).s, { travelClass: 'EC' })).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });
    // the pure helper both paths use
    expect(eligibleClassMatrix('SL', rowClassesOf({ classes: row.map(([code, availability]) => ({ code, availability })) }), 1, boardFromEarlierConfigFromEnv({} as any))).toEqual(['SL', '3A']);
  });
});

// ================================================================= the search itself
describe('Phase 2 shared policy — identical search on both paths (staged depth, queue, results)', () => {
  it('[MP3] nothing in stage A or the earlier stops → identical provider queries, order (A → origin → terminus) and results', async () => {
    const answer = (q: Q) => (q.origin === O && q.destination === CODES[36] && q.travelClass === '3A' ? 'AVAILABLE-0004' : 'GNWL 9');
    const row: Array<[string, string]> = [['SL', 'GNWL 74/WL 16'], ['3A', 'GNWL 14/WL 6'], ['2A', 'AVAILABLE-0003']];
    const a = fakeTools(answer); const m = fakeTools(answer);
    const auto = await autoRun(session(row), a.tools);
    const { out } = await museRun(session(row).s, m.tools);
    expect(auto.ok).toBe(true); expect(out.ok).toBe(true);
    const ar = auto.result!, mr: SameTrainAlternativesResult = out.data;
    expect(qsig(m.calls)).toEqual(qsig(a.calls));
    expect(sig(mr)).toEqual(sig(ar));
    expect(mr.classesChecked).toEqual(ar.classesChecked);
    expect(mr.route.terminalSweep).toEqual(ar.route.terminalSweep);
    expect(mr.route.terminalSweep).toEqual(CODES.slice(29));               // terminus phase = after stage A's 3 ahead
    expect([mr.status, mr.searchComplete, mr.verifiedAlternativeCount]).toEqual([ar.status, ar.searchComplete, ar.verifiedAlternativeCount]);
    // staged order on both paths: every stage-A query before any earlier-stop (B) query, every B query before the terminus
    for (const calls of [a.calls, m.calls]) {
      const stage = (q: Q) => (ix(q.origin) >= 18 && ix(q.destination) <= 28 ? 0 : ix(q.origin) < 18 ? 1 : 2);
      const st = calls.map(stage);
      expect(st.slice().sort((x, y) => x - y)).toEqual(st);
    }
    // single-ended pairs only (no combined earlier-origin + later-destination pair) — same as the display
    expect(m.calls.every(q => q.origin === O || q.destination === D)).toBe(true);
    expect(mr.alternatives.find(x => x.ticketDestination === CODES[36] && x.travelClass === '3A')).toMatchObject({ availability: 'AVAILABLE', bookFrom: O, boardAt: O, stopsBefore: 0, stopsAfter: 11 });
  });
  it('[MP4] staged on Muse\'s path: a seat inside stage A (2 back / 3 ahead) → nothing else is checked', async () => {
    const m = fakeTools(q => (q.origin === CODES[18] && q.destination === D ? 'RAC 6' : 'GNWL 9'));
    const { out } = await museRun(session([['SL', 'WL 4']]).s, m.tools);
    expect(out.ok).toBe(true);
    expect(qsig(m.calls)).toEqual(qsig([[20, 25], [19, 25], [18, 25], [20, 26], [20, 27], [20, 28]].map(([o, d]) => ({ trainNumber: TRAIN, travelClass: 'SL', date: DATE, origin: CODES[o], destination: CODES[d] }))));
    expect(out.data.route.terminalSweep).toBeUndefined();
    expect(out.data.alternatives.find((x: any) => x.ticketOrigin === CODES[18])).toMatchObject({ availability: 'RAC', bookFrom: CODES[18], boardAt: O, stopsBefore: 2, stopsAfter: 0 });
  });
  it('[MP4b] SAME_TRAIN_STAGED_DEPTH=off → both paths use the previous full window (still identical)', async () => {
    process.env.SAME_TRAIN_STAGED_DEPTH = 'off';
    const a = fakeTools(() => 'GNWL 9'); const m = fakeTools(() => 'GNWL 9');
    await autoRun(session([['SL', 'WL 4']]), a.tools);
    await museRun(session([['SL', 'WL 4']]).s, m.tools);
    expect(qsig(m.calls)).toEqual(qsig(a.calls));
    expect(m.calls.some(q => q.origin === O && ix(q.destination) === 31)).toBe(true);     // 6 ahead (pre-staged window)
  });
  it('[MP5] rate limits: Muse\'s search keeps ≤ 3 probes in flight (EARLIER_PROBE_CONCURRENCY) and uses the paced queue deps', async () => {
    const m = fakeTools(() => 'GNWL 9', { delayMs: 15 });
    const { out } = await museRun(session([['SL', 'WL 4'], ['3A', 'WL 2']]).s, m.tools);
    expect(out.ok).toBe(true);
    expect(m.calls.length).toBeGreaterThan(20);
    expect(m.max()).toBeLessThanOrEqual(3);
    expect(sharedSameTrainDeps(m.tools, {} as any).scheduled).toBe(true);
    expect(sharedSameTrainDeps(m.tools, { SAME_TRAIN_PACED_QUEUE: 'off' } as any).scheduled).toBeFalsy();
    expect(sharedSameTrainDeps(m.tools, {} as any, { totalTimeoutMs: 45_000 }).limits.totalTimeoutMs).toBe(45_000);
  });
  it('[MP5b] train slots are shared: a Muse call waits at the FRONT; slots busy past its budget → honest RATE_LIMITED, no provider call', async () => {
    const held = await Promise.all([acquireTrainSlot(3), acquireTrainSlot(3), acquireTrainSlot(3)]);
    try {
      const order: string[] = [];
      const auto = acquireTrainSlot(3).then(r => { order.push('auto'); return r; });
      const muse = acquireTrainSlot(3, { priority: true }).then(r => { order.push('muse'); return r; });
      expect(sameTrainTrainSlotsForTests()).toEqual({ used: 3, waiting: 2 });
      held[0]!();
      const first = await muse;
      expect(order).toEqual(['muse']);
      first!(); (await auto)!();
      // all 3 busy again → Muse's tool waits ≤ budget/3, then reports busy (never a verdict, no provider traffic)
      expect(sameTrainTrainSlotsForTests()).toEqual({ used: 2, waiting: 0 });
      const third = await acquireTrainSlot(3);
      expect(await acquireTrainSlot(3, { waitMs: 0 })).toBeNull();      // bounded wait → null, and the waiter is removed
      expect(sameTrainTrainSlotsForTests()).toEqual({ used: 3, waiting: 0 });
      process.env.SAME_TRAIN_TOTAL_TIMEOUT_MS = '1500';                  // Muse budget 1.5 s → waits ≤ 0.5 s for a slot
      const m = fakeTools(() => 'GNWL 9');
      const { out } = await museRun(session([['SL', 'WL 4']]).s, m.tools);
      expect(out).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', details: { reason: 'TRAIN_SLOTS_BUSY' } } });
      expect(m.calls).toHaveLength(0);
      third!();
    } finally { held[1]!(); held[2]!(); }
    expect(sameTrainTrainSlotsForTests()).toEqual({ used: 0, waiting: 0 });
  });
  it('[MP5c] queue units end at the search deadline: a provider error waiting for a retry stays that error (RATE_LIMITED), no answer → TIMEOUT', async () => {
    const P = { id: 'zz-queue-mock', label: 'ZZ (MOCK)', isMock: true } as any;
    resetSameTrainSchedulers();
    try {
      // the provider answers RATE_LIMITED → the queue backs off (2 s) → the 1.2 s deadline returns the REAL answer
      const t0 = Date.now();
      const rl: any = await scheduledSameTrainDeps({ GET_TIMETABLE: async () => ({ ok: false, error: { code: 'RATE_LIMITED', message: 'mock' } }) } as any, { totalTimeoutMs: 1200 }).getRoute(P, TRAIN);
      expect(Date.now() - t0).toBeLessThan(1900);
      expect(rl).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' }, meta: { scheduler: { deadlineReached: true } } });
      expect(rl.meta.scheduler.timedOut).toBeUndefined();
      // the provider never answers → an honest TIMEOUT at the deadline (never a verdict)
      resetSameTrainSchedulers();
      const hang: any = await scheduledSameTrainDeps({ GET_TIMETABLE: () => new Promise(() => { /* never */ }) } as any, { totalTimeoutMs: 600 }).getRoute(P, TRAIN);
      expect(hang).toMatchObject({ ok: false, error: { code: 'PROVIDER_TIMEOUT' }, meta: { scheduler: { timedOut: true } } });
    } finally { resetSameTrainSchedulers(); }
  });
});

// ================================================================= freshness, lower WL, no drift
describe('Phase 2 shared policy — freshness, lower WL, exact segment, no drift (Muse path)', () => {
  const old = () => new Date(Date.now() - 200 * MIN).toISOString();
  it('[MP6] a too-old RAC snapshot → ⚠ (status + age), not a verdict, never VERIFIED; Select = one FRESH re-check', async () => {
    let phase: 'search' | 'recheck' = 'search';
    const m = fakeTools(q => (q.origin === CODES[19] ? (phase === 'search' ? { status: 'RAC 7', updated: old() } : 'RAC 6') : 'GNWL 9'));
    const { out } = await museRun(session([['SL', 'WL 4']]).s, m.tools);
    expect(out.ok).toBe(true);
    const r: SameTrainAlternativesResult = out.data;
    const a = r.alternatives.find(x => x.ticketOrigin === CODES[19])!;
    expect(a).toMatchObject({ availability: 'UNKNOWN', verificationStatus: 'UNVERIFIED', staleSnapshot: { status: 'RAC 7', category: 'RAC' } });
    expect(a.staleSnapshot!.ageMinutes).toBeGreaterThanOrEqual(199);
    expect(isVerifiedSameTrainAlternative(a)).toBe(false);
    expect(r.searchComplete).toBe(false);
    const view: any = sameTrainLLMView(r);
    expect(view.staleChecksNotVerdict.join(' ')).toMatch(new RegExp(`${CODES[19]}→${D} SL: provider snapshot \\d+ min old \\(RAC 7\\) — fresh status not confirmed`));
    expect(view.alternatives[a.alternativeId].availability).toBe('UNKNOWN');
    // Select: exactly one fresh provider call; the fresh answer (not the stale one) decides
    phase = 'recheck'; m.calls.length = 0;
    const tools = m.tools;
    const deps = sharedSameTrainDeps(tools, process.env);
    const sel = await revalidateSameTrainAlternative(r, r.alternativeSearchId, a.alternativeId, r.journeyKey, { acknowledgeUnverifiedRules: true, deps } as any);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]).toMatchObject({ origin: CODES[19], destination: D, travelClass: 'SL', date: DATE });
    expect(sel.ok).toBe(true);
    expect(sel.fresh![0].status).toBe('RAC 6');
  });
  it('[MP7] lower WL from an earlier station (nothing bookable) → "Waiting List — not confirmed", still WAITLIST, never VERIFIED', async () => {
    const m = fakeTools(q => (q.origin === CODES[18] && q.destination === D ? 'GNWL 20/WL 4' : 'GNWL 40/WL 17'));
    const { out } = await museRun(session([['SL', 'GNWL 40/WL 17']]).s, m.tools);
    expect(out.ok).toBe(true);
    const r: SameTrainAlternativesResult = out.data;
    expect(r.betterWaitlistCount).toBe(1);
    const a = r.alternatives.find(x => x.betterWaitlist)!;
    expect(a).toMatchObject({ ticketOrigin: CODES[18], availability: 'WAITLIST', betterWaitlist: { waitlist: 4, directWaitlist: 17 } });
    expect(isVerifiedSameTrainAlternative(a)).toBe(false);
    const view: any = sameTrainLLMView(r);
    expect(view.betterWaitlistNotConfirmed).toEqual([`${CODES[18]}→${D} SL WL 4 (direct WL 17) — ${BETTER_WAITLIST_LABEL}`]);
    expect(BETTER_WAITLIST_LABEL).toBe('Waiting List — not confirmed');
    expect(view.verifiedAlternativeCount).toBe(0);
  });
  it('[MP8] exact segment preserved: train / class / requested date / pair / pax; an earlier-day station is shown with its own ticket date', async () => {
    // stations before index 19 leave on the previous calendar day (same run) → ticket date = DATE − 1, explicitly flagged
    const m = fakeTools(q => (q.origin === CODES[18] ? 'RAC 3' : 'GNWL 9'), { routeDay: i => (i < 19 ? 1 : 2) });
    const { validated, out } = await museRun(session([['SL', 'WL 4']], { pax: 2 }).s, m.tools);
    expect(validated.v.arguments).toMatchObject({ trainNumber: TRAIN, travelClass: 'SL', date: DATE, origin: O, destination: D, passengersCount: 2 });
    const r: SameTrainAlternativesResult = out.data;
    expect(r).toMatchObject({ trainNumber: TRAIN, travelClass: 'SL', date: DATE, requestedOrigin: O, requestedDestination: D, passengersCount: 2 });
    const a = r.alternatives.find(x => x.ticketOrigin === CODES[18])!;
    expect(a).toMatchObject({ date: '2026-10-11', ticketDateShiftDays: -1, journeyDate: DATE, availabilityStatusText: 'RAC 3', bookFrom: CODES[18], boardAt: O, ticketDestination: D, trainNumber: TRAIN, travelClass: 'SL' });
    expect((sameTrainLLMView(r) as any).alternatives[a.alternativeId]).toMatchObject({ ticket: `${CODES[18]}→${D}`, ticketDate: '2026-10-11', status: 'RAC 3' });
    // same-day stations keep the requested date
    expect(r.alternatives.filter(x => ix(x.ticketOrigin) >= 19).every(x => x.date === DATE && !x.ticketDateShiftDays)).toBe(true);
  });
  it('[MP8b] a provider answer for ANOTHER date is rejected (WRONG_DATE) — never shown as availability for the requested date', async () => {
    const m = fakeTools(q => (q.origin === CODES[19] ? { status: 'AVAILABLE-0010', date: '2026-10-13' } : 'GNWL 9'));
    const { out } = await museRun(session([['SL', 'WL 4']]).s, m.tools);
    const r: SameTrainAlternativesResult = out.data;
    expect(m.calls.some(q => q.origin === CODES[19] && q.date === DATE)).toBe(true);     // asked for the requested date
    // the other-date answer is an identity mismatch → hidden as invalid, never listed / counted / shown to Muse as a seat
    expect(r.alternatives.find(x => x.ticketOrigin === CODES[19])).toBeUndefined();
    expect(r.invalidCount).toBeGreaterThanOrEqual(1);
    expect(r.alternatives.some(x => x.availability === 'AVAILABLE')).toBe(false);
    expect(r.verifiedAlternativeCount).toBe(0);
    expect((sameTrainLLMView(r) as any).invalidHidden).toBeGreaterThanOrEqual(1);
  });
  it('[MP8c] no silent switch: another date without a current WL status → NOT_READY; another passenger count → refused', () => {
    expect(museValidate(session([['SL', 'WL 4']]).s, { date: '2026-10-13' })).toMatchObject({ ok: false, error: { code: SameTrainErrorCode.NOT_READY, details: { reason: 'WAITLIST_NOT_VERIFIED' } } });
    expect(museValidate(session([['SL', 'WL 4']], { pax: 2 }).s, { passengersCount: 4 })).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL', details: { argument: 'passengersCount', expected: 2, received: 4 } } });
    expect(museValidate(session([['SL', 'WL 4']], { pax: 2 }).s, { passengersCount: 2 })).toMatchObject({ ok: true });
    // a CHECK_AVAILABILITY WL fact for exactly the other date → allowed, and searched on THAT date (explicit, not drift)
    const s = session([['SL', 'WL 4']]).s;
    s.availability = { SL: { trainNumber: TRAIN, travelClass: 'SL', date: '2026-10-13', origin: O, destination: D, status: 'GNWL 30/WL 9', toolExecutionId: 'x' } };
    expect(museValidate(s, { date: '2026-10-13' })).toMatchObject({ ok: true, v: { arguments: { date: '2026-10-13', triggerReason: 'WAITLIST' } } });
  });
});

// ================================================================= safety-net + rollback
describe('Phase 2 shared policy — BFE safety-net + rollback switch', () => {
  const bind = { sessionId: 's', turnId: 't', journeyVersion: 1 };
  const bfe = (status: string, passengers = 1) => evaluateBfeEligibility({ ok: true, status, trainNumber: TRAIN, classCode: 'SL', date: DATE, passengers, binding: bind });
  it('[MP9] BFE eligibility (Muse fact + safety-net trigger) follows WL-only: REGRET / NOT AVAILABLE / too few seats → not eligible', () => {
    const cfg = musePolicyFromEnv();
    expect(applySameTrainPolicyToBfe(bfe('GNWL 5'), cfg)).toMatchObject({ eligible: true, reason: 'WAITLIST' });
    for (const st of ['REGRET', 'NOT AVAILABLE']) expect(applySameTrainPolicyToBfe(bfe(st), cfg)).toMatchObject({ eligible: false, reason: null, notEligibleReason: 'NOT_WAITLIST' });
    expect(applySameTrainPolicyToBfe(bfe('AVAILABLE-0001', 3), cfg)).toMatchObject({ eligible: false, notEligibleReason: 'NOT_WAITLIST' });
    expect(applySameTrainPolicyToBfe(bfe('RAC 3'), cfg)).toMatchObject({ eligible: false, notEligibleReason: 'RAC_AVAILABLE' });
    // switches: WL-only off or the Muse rollback → the raw P42.5 verdict
    expect(applySameTrainPolicyToBfe(bfe('REGRET'), { ...cfg!, wlOnly: false })).toMatchObject({ eligible: true, reason: 'REGRET' });
    expect(applySameTrainPolicyToBfe(bfe('REGRET'), null)).toMatchObject({ eligible: true, reason: 'REGRET' });
  });
  it('[MP10] SAME_TRAIN_MUSE_SHARED_POLICY=off → the pre-Phase-2 tool (shortage trigger, Muse depth knobs, combined pairs AUTO)', () => {
    process.env.SAME_TRAIN_MUSE_SHARED_POLICY = 'off';
    expect(musePolicyFromEnv()).toBeNull();
    const r = museValidate(session([['3A', 'AVAILABLE-0001'], ['SL', 'AVAILABLE-0009']], { pax: 2 }).s, { travelClass: '3A' });
    expect(r).toMatchObject({ ok: true, v: { arguments: { travelClass: '3A', classes: '3A,SL', combinedPairs: 'AUTO', triggerReason: 'INSUFFICIENT_SEATS' } } });
    expect(r.v.arguments.sharedPolicy).toBeUndefined();
    delete process.env.SAME_TRAIN_MUSE_SHARED_POLICY;
    expect(museValidate(session([['3A', 'AVAILABLE-0001']], { pax: 2 }).s, { travelClass: '3A' })).toMatchObject({ ok: false, error: { code: SAME_TRAIN_NOT_NEEDED } });
  });
});
