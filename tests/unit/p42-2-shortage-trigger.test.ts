/**
 * P42.2 G2 — intelligent Same Train Alternative trigger (focused unit checks, deterministic, no network).
 * Under test: shortage evaluation (pure), seat sufficiency for the party, validator hard constraints (no search when
 * seats suffice, never an invented class), engine metadata / outcomes / error classes, stale protection, fresh
 * recheck before selection, claim binding (train + date + class + ticket pair + seat count), UI visibility.
 * Muse's decisions are NOT under test here — the backend never decides whether to search.
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  normalizeAvailabilityState, parseAvailableSeatCount, evaluateSeatShortage, seatCheckFromSearch, seatCheckView,
  isVerifiedSameTrainAlternative, SAME_TRAIN_NOT_NEEDED
} from '../../shared/same-train-shortage';
import { SAME_TRAIN_DEFAULT_LIMITS, type SameTrainAlternativesResult } from '../../shared/same-train-alternatives';
import { runSameTrainSearch, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery } from '../../server/railway/same-train/same-train-engine';
import { isSameTrainResultStale, sameTrainSelectionKey, revalidateSameTrainAlternative, findSameTrainResult } from '../../server/railway/same-train/same-train-service';
import { sessionShortageEvidence } from '../../server/railway/same-train/shortage-trigger';
import { sameTrainLLMView, sameTrainFallbackText, sameTrainCardData } from '../../server/railway/same-train/same-train-view';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { collectAvailabilityEvidence, judgeAvailabilityClaim } from '../../server/ai/response/availability-authority';
import { SameTrainCard } from '../../src/components/trains/SameTrainAlternatives';

const DATE = '2026-10-09';
const ROUTE = [['ASR', 'Amritsar Jn'], ['BEAS', 'Beas'], ['JUC', 'Jalandhar City'], ['PGW', 'Phagwara Jn'], ['LDH', 'Ludhiana Jn'], ['SIR', 'Sirhind Jn'],
  ['RPJ', 'Rajpura Jn'], ['UMB', 'Ambala Cant Jn'], ['KKDE', 'Kurukshetra Jn'], ['PNP', 'Panipat Jn'], ['NDLS', 'New Delhi']].map(([station, stationName]) => ({ station, stationName }));
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
const LIMITS = { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 150, totalTimeoutMs: 2000 };
type StatusFn = (p: ProviderRef, q: AvailabilityQuery) => string | 'HANG' | { error: string } | 'MALFORMED';
function mkDeps(status: StatusFn) {
  const calls: Array<{ p: string; q: AvailabilityQuery }> = [];
  const deps: SameTrainDeps = {
    limits: LIMITS,
    getRoute: async () => ({ ok: true, data: ROUTE }),
    checkAvailability: async (p, q) => {
      calls.push({ p: p.id, q });
      const s = status(p, q);
      if (s === 'HANG') return new Promise(() => { /* never */ });
      if (s === 'MALFORMED') return { ok: true, data: { trainNumber: q.trainNumber } };
      if (typeof s === 'object') return { ok: false, error: { code: s.error } };
      return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: s } };
    }
  };
  return { deps, calls };
}
const REQ = (o: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 3, trainNumber: '12903', trainName: 'Golden Temple Mail', date: DATE, travelClass: '1A', passengersCount: 3,
  origin: 'LDH', destination: 'UMB', originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false,
  providers: [RC, RR], routeProvider: RC, webProviders: [], ...o
});
async function ok(req: SameTrainSearchRequest, deps: SameTrainDeps): Promise<SameTrainAlternativesResult> {
  const r = await runSameTrainSearch(req, deps);
  if (!r.ok) throw new Error(`search failed: ${r.code}`);
  return r.result;
}
const byPair = (r: SameTrainAlternativesResult, id: string) => r.alternatives.find(a => a.pairId === id)!;

// ================================================================= 1. shortage evaluation (pure)

/** Phase 2 shared policy (user-authorized 2026-10-09, "mixed"): tests that pin the PRE-Phase-2 Muse rules run with the
 *  documented rollback switch SAME_TRAIN_MUSE_SHARED_POLICY=off; the env is restored afterwards. Assertions unchanged. */
async function withMuseSharedPolicyOff(fn: () => unknown): Promise<void> {
  const prev = process.env.SAME_TRAIN_MUSE_SHARED_POLICY;
  process.env.SAME_TRAIN_MUSE_SHARED_POLICY = 'off';
  try { await fn(); } finally { if (prev === undefined) delete process.env.SAME_TRAIN_MUSE_SHARED_POLICY; else process.env.SAME_TRAIN_MUSE_SHARED_POLICY = prev; }
}

describe('P42.2 G2 — shortage evaluation', () => {
  it('[1] sufficient seats → no trigger (AVAILABLE-0005 for 2 passengers)', () => {
    expect(evaluateSeatShortage({ status: 'AVAILABLE-0005', requestedPassengerCount: 2 })).toEqual({
      availabilityStatus: 'AVAILABLE', availableSeatCount: 5, requestedPassengerCount: 2, sufficiency: 'SUFFICIENT', shortage: false, triggerReason: null });
    expect(evaluateSeatShortage({ status: 'Available', requestedPassengerCount: 1 })).toMatchObject({ sufficiency: 'SUFFICIENT', shortage: false });
  });
  it('[2] insufficient seats → INSUFFICIENT_SEATS with the exact provider count (1 seat never becomes 3)', () => {
    expect(evaluateSeatShortage({ status: 'AVAILABLE-0001', requestedPassengerCount: 3 })).toEqual({
      availabilityStatus: 'AVAILABLE', availableSeatCount: 1, requestedPassengerCount: 3, sufficiency: 'INSUFFICIENT', shortage: true, triggerReason: 'INSUFFICIENT_SEATS' });
    for (const st of ['AVAILABLE 2', 'AVL 0002', 'CURR_AVBL-0002', 'AVBL/2']) expect(parseAvailableSeatCount(st)).toBe(2);
    expect(evaluateSeatShortage({ status: 'AVAILABLE 0', requestedPassengerCount: 1 })).toMatchObject({ shortage: true, triggerReason: 'INSUFFICIENT_SEATS' });
  });
  it('[3] WAITLIST → trigger', () => {
    for (const st of ['GNWL 12', 'WL 30', 'Waitlist 8', 'RLWL-4', 'PQWL5', 'GNWL51/WL30']) expect(evaluateSeatShortage({ status: st, requestedPassengerCount: 2 })).toMatchObject({ availabilityStatus: 'WAITLIST', shortage: true, triggerReason: 'WAITLIST' });
  });
  it('[4] NOT_AVAILABLE → trigger; class not on the train → CLASS_UNAVAILABLE', () => {
    expect(evaluateSeatShortage({ status: 'NOT AVAILABLE', requestedPassengerCount: 2 })).toMatchObject({ availabilityStatus: 'NOT_AVAILABLE', shortage: true, triggerReason: 'NOT_AVAILABLE' });
    expect(evaluateSeatShortage({ classListed: false, requestedPassengerCount: 2 })).toMatchObject({ shortage: true, triggerReason: 'CLASS_UNAVAILABLE' });
  });
  it('[5] REGRET and TRAIN CANCELLED stay distinct states and trigger', () => {
    expect(normalizeAvailabilityState('REGRET/WL')).toBe('REGRET');
    expect(evaluateSeatShortage({ status: 'REGRET', requestedPassengerCount: 1 })).toMatchObject({ availabilityStatus: 'REGRET', shortage: true, triggerReason: 'REGRET' });
    expect(evaluateSeatShortage({ status: 'TRAIN CANCELLED', requestedPassengerCount: 1 })).toMatchObject({ availabilityStatus: 'TRAIN_CANCELLED', triggerReason: 'TRAIN_CANCELLED' });
  });
  it('[6] UNKNOWN / missing / unrecognised → never a shortage (absence of data proves nothing); RAC is not a trigger', () => {
    for (const st of [undefined, null, '', 'XYZ', 'PROVIDER_TIMEOUT']) {
      expect(evaluateSeatShortage({ status: st, requestedPassengerCount: 3 })).toMatchObject({ availabilityStatus: 'UNKNOWN', shortage: false, triggerReason: null, sufficiency: 'UNKNOWN' });
    }
    expect(evaluateSeatShortage({ status: 'RAC 4', requestedPassengerCount: 2 })).toMatchObject({ availabilityStatus: 'RAC', shortage: false });
    // bare AVAILABLE for a party: sufficiency not proven either way → no shortage, COUNT_NOT_PROVIDED
    expect(evaluateSeatShortage({ status: 'Available', requestedPassengerCount: 3 })).toMatchObject({ sufficiency: 'COUNT_NOT_PROVIDED', shortage: false });
  });
  it('[6b] seatCheck: multi-train + multi-class structured facts for Muse (no instruction, no ranking)', () => {
    const data = { journey: { date: DATE }, trains: [
      { trainNumber: '12903', classes: [{ code: '1A', availability: 'AVAILABLE-0001' }, { code: '2A', availability: 'AVAILABLE-0010' }, { code: '3A', availability: 'GNWL 12' }] },
      { trainNumber: '12497', classes: [{ code: 'CC', availability: 'REGRET' }, { code: 'EC', availability: null }] }] };
    const e = seatCheckFromSearch(data, 3);
    const v: any = seatCheckView(e, 3, { sameTrainToolAvailable: true });
    expect(v.shortages).toEqual([
      { train: '12903', class: '1A', availabilityStatus: 'AVAILABLE', availableSeatCount: 1, triggerReason: 'INSUFFICIENT_SEATS' },
      { train: '12903', class: '3A', availabilityStatus: 'WAITLIST', triggerReason: 'WAITLIST' },
      { train: '12497', class: 'CC', availabilityStatus: 'REGRET', triggerReason: 'REGRET' }]);
    expect(v).toMatchObject({ requestedPassengerCount: 3, sufficientCount: 1, unknownCount: 1, sameTrainAlternativeEligible: true });
    expect(JSON.stringify(v)).not.toMatch(/best|recommend/i);
  });
});

// ================================================================= 2. validator hard constraints
describe('P42.2 G2 — validator (passenger-count safety, class filter)', () => {
  const v = new ToolCallValidator();
  const call = (args: any) => ({ callId: 'c1', name: 'SEARCH_SAME_TRAIN_ALTERNATIVES', arguments: args });
  const sess = (o: any = {}) => Object.assign(new ConversationStateManager().createSession() as any, {
    origin: 'LDH', destination: 'UMB', date: DATE, passengersCount: 2,
    searchResults: { date: DATE, origin: 'LDH', destination: 'UMB', resultId: 'res1', trains: [
      { trainNumber: '12903', classes: [{ code: '1A', availability: 'AVAILABLE-0005' }, { code: '2A', availability: 'GNWL 4' }, { code: '3A', availability: null }] }] }, ...o });
  const g = { userText: '12903 dekho' } as any;
  const args = (o: any = {}) => ({ trainNumber: '12903', travelClass: '1A', date: DATE, origin: 'LDH', destination: 'UMB', ...o });
  it('[1v] sufficient availability → SAME_TRAIN_ALTERNATIVE_NOT_NEEDED before any provider call (structured details, no wording)', () => withMuseSharedPolicyOff(() => {
    const r: any = v.validate(call(args()) as any, sess(), g);
    expect(r).toMatchObject({ ok: false, error: { code: SAME_TRAIN_NOT_NEEDED, details: { availabilityStatus: 'AVAILABLE', availableSeatCount: 5, requestedPassengerCount: 2 } } });
    // CHECK_AVAILABILITY (newer, same journey) wins over the search row
    const r2: any = v.validate(call(args()) as any, sess({ availability: { '1A': { trainNumber: '12903', travelClass: '1A', date: DATE, origin: 'LDH', destination: 'UMB', status: 'AVAILABLE-0001', toolExecutionId: 'x' } } }), g);
    expect(r2.ok).toBe(true);
    expect(r2.v.arguments).toMatchObject({ triggerReason: 'INSUFFICIENT_SEATS', triggerSource: 'SESSION_EVIDENCE', passengersCount: 2 });
  }));
  it('[2v] pax binding: the same 5 seats are insufficient for 6 passengers → allowed, INSUFFICIENT_SEATS', () => withMuseSharedPolicyOff(() => {
    const r: any = v.validate(call(args({ passengersCount: 6 })) as any, sess(), g);
    expect(r.ok).toBe(true);
    expect(r.v.arguments).toMatchObject({ passengersCount: 6, triggerReason: 'INSUFFICIENT_SEATS', triggerSource: 'SESSION_EVIDENCE' });
  }));
  it('[3v] WL class allowed (evidence reason wins); UNKNOWN class is not blocked and not a shortage (Muse reason only recorded)', () => withMuseSharedPolicyOff(() => {
    expect((v.validate(call(args({ travelClass: '2A' })) as any, sess(), g) as any).v.arguments).toMatchObject({ triggerReason: 'WAITLIST', triggerSource: 'SESSION_EVIDENCE' });
    const u: any = v.validate(call(args({ travelClass: '3A', triggerReason: 'INSUFFICIENT_SEATS' })) as any, sess(), g);
    expect(u.v.arguments).toMatchObject({ triggerReason: 'INSUFFICIENT_SEATS', triggerSource: 'MUSE' });
    expect((v.validate(call(args({ travelClass: '3A' })) as any, sess(), g) as any).v.arguments).toMatchObject({ triggerReason: null, triggerSource: 'NONE' });
    // free text is never a reason (schema enum) — rejected before any provider call
    expect(v.validate(call(args({ travelClass: '3A', triggerReason: 'because I want' })) as any, sess(), g)).toMatchObject({ ok: false });
  }));
  it('[4v] evidence from another date / route never applies (no false "not needed")', () => withMuseSharedPolicyOff(() => {
    expect(v.validate(call(args({ date: '2026-10-10' })) as any, sess(), g)).toMatchObject({ ok: true });
    expect(sessionShortageEvidence(sess(), { trainNumber: '12903', travelClass: '1A', date: DATE, origin: 'JUC', destination: 'UMB', passengersCount: 2 })).toBeNull();
  }));
  it('[15] class filter: a class the train does not list is refused (result row, else the selected train) — never invented', () => {
    expect(v.validate(call(args({ travelClass: 'EC' })) as any, sess(), g)).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });
    // Phase 2 shared policy (user-authorized 2026-10-09, "mixed"): setup only — the 2A fact is a verified waitlist
    const s2 = sess({ searchResults: undefined, selectedTrain: { number: '12903', classes: [{ code: '1A' }, { code: '2A' }] },
      availability: { '2A': { trainNumber: '12903', travelClass: '2A', date: DATE, origin: 'LDH', destination: 'UMB', status: 'GNWL 4', toolExecutionId: 'setup-wl' } } });
    expect(v.validate(call(args({ travelClass: 'CC' })) as any, s2, g)).toMatchObject({ ok: false, error: { code: 'INVALID_TOOL_CALL' } });
    expect(v.validate(call(args({ travelClass: '2A' })) as any, s2, g)).toMatchObject({ ok: true });
  });
});

// ================================================================= 3. engine: sufficiency, metadata, outcomes, errors
describe('P42.2 G2 — engine (pax-bound sufficiency, metadata, typed outcomes)', () => {
  it('[7] timeout on the requested pair → requested pair UNKNOWN (no false shortage); all timeouts → TOOL_TIMEOUT', async () => {
    const r = await ok(REQ(), mkDeps((_p, q) => (q.origin === 'LDH' ? 'HANG' : q.origin === 'JUC' ? 'AVAILABLE 4' : 'GNWL 3')).deps);
    expect(r.requestedPairAssessment).toMatchObject({ availabilityStatus: 'UNKNOWN', shortage: false });
    expect(byPair(r, 'LDH-UMB').availability).toBe('UNKNOWN');
    expect(r.searchComplete).toBe(false);
    const t = await runSameTrainSearch(REQ(), mkDeps(() => 'HANG').deps);
    expect(t).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_TIMEOUT', errorClass: 'TOOL_TIMEOUT' });
  });
  it('[8][9] pax binding + sufficiency: AVAILABLE 2 for 3 passengers is INSUFFICIENT, not a verified alternative', async () => {
    const { deps, calls } = mkDeps((_p, q) => (q.origin === 'JUC' ? 'AVAILABLE 2' : q.origin === 'BEAS' ? 'AVAILABLE-0003' : q.destination === 'KKDE' ? 'Available' : 'AVAILABLE-0001'));
    const r = await ok(REQ(), deps);
    expect(calls.every(c => c.q.passengersCount === 3)).toBe(true);
    expect(byPair(r, 'LDH-UMB')).toMatchObject({ availabilityStatus: 'AVAILABLE', availableSeatCount: 1, requestedPassengerCount: 3, seatSufficiency: 'INSUFFICIENT' });
    expect(byPair(r, 'JUC-UMB')).toMatchObject({ availableSeatCount: 2, seatSufficiency: 'INSUFFICIENT' });
    expect(isVerifiedSameTrainAlternative(byPair(r, 'JUC-UMB'))).toBe(false);
    expect(byPair(r, 'BEAS-UMB')).toMatchObject({ availableSeatCount: 3, seatSufficiency: 'SUFFICIENT' });
    expect(byPair(r, 'LDH-KKDE')).toMatchObject({ seatSufficiency: 'COUNT_NOT_PROVIDED' });              // bare AVAILABLE for 3 → not proven
    expect(isVerifiedSameTrainAlternative(byPair(r, 'LDH-KKDE'))).toBe(false);
    expect(r).toMatchObject({ requestedPassengerCount: 3, outcome: 'VERIFIED_ALTERNATIVE_FOUND', verifiedAlternativeCount: 1,
      requestedPairAssessment: { availableSeatCount: 1, sufficiency: 'INSUFFICIENT', triggerReason: 'INSUFFICIENT_SEATS' } });
    // the LLM view shows the shortage explicitly; sufficient entries stay compact
    const view: any = sameTrainLLMView(r);
    const ldh: any = Object.values(view.alternatives).find((a: any) => a.ticket === 'LDH→UMB');
    expect(ldh).toMatchObject({ status: 'AVAILABLE-0001', availableSeatCount: 1, seatSufficiency: 'INSUFFICIENT' });
    expect(view).toMatchObject({ outcome: 'VERIFIED_ALTERNATIVE_FOUND', verifiedAlternativeCount: 1, passengersCount: 3 });
  });
  it('[10] train identity: an answer for another train / class / date is rejected, never substituted', async () => {
    const deps = mkDeps(() => 'AVAILABLE 9').deps;
    deps.checkAvailability = async (_p, q) => ({ ok: true, data: { trainNumber: q.origin === 'JUC' ? '12014' : q.trainNumber, travelClass: q.travelClass, date: q.date, status: 'AVAILABLE 9' } });
    const r = await ok(REQ(), deps);
    expect(r.alternatives.find(a => a.ticketOrigin === 'JUC')).toBeUndefined();          // INVALID → hidden
    expect(r.invalidCount).toBe(1);
    expect(r.alternatives.every(a => a.trainNumber === '12903' && a.travelClass === '1A' && a.date === DATE)).toBe(true);
  });
  it('[14] existing P42 route sweep preserved (P0 + upstream origins + bounded downstream, no invented stations)', async () => {
    const r = await ok(REQ(), mkDeps(() => 'GNWL 5').deps);
    expect(r.route.originSweep).toEqual(['ASR', 'BEAS', 'JUC', 'PGW']);
    expect(r.route.destinationExtension).toEqual(['KKDE', 'PNP', 'NDLS']);
    expect(r.candidateCount).toBe(1 + 4 + 3);
    const codes = new Set(ROUTE.map(x => x.station));
    expect(r.alternatives.every(a => codes.has(a.ticketOrigin) && codes.has(a.ticketDestination))).toBe(true);
  });
  it('[22] empty → NO_VERIFIED_SAME_TRAIN_ALTERNATIVE (code, no backend ranking); fallback never points to a hidden card', async () => {
    const r = await ok(REQ(), mkDeps(() => 'GNWL 5').deps);
    expect(r).toMatchObject({ outcome: 'NO_VERIFIED_SAME_TRAIN_ALTERNATIVE', verifiedAlternativeCount: 0, status: 'NOT_FOUND' });
    expect(r.presentation).toMatchObject({ bestMatchId: null, decidedBy: 'NONE' });
    expect(sameTrainFallbackText(r)).not.toMatch(/screen/i);
    expect((sameTrainLLMView(r) as any).outcome).toBe('NO_VERIFIED_SAME_TRAIN_ALTERNATIVE');
  });
  it('[23][24] typed failures: TOOL_TIMEOUT · PROVIDER_UNAVAILABLE · INVALID_TOOL_RESULT — never NOT_AVAILABLE', async () => {
    expect(await runSameTrainSearch(REQ(), mkDeps(() => ({ error: 'PROVIDER_UNAVAILABLE' })).deps)).toMatchObject({ ok: false, code: 'ALTERNATIVE_SEARCH_FAILED', errorClass: 'PROVIDER_UNAVAILABLE' });
    expect(await runSameTrainSearch(REQ(), mkDeps(() => 'MALFORMED').deps)).toMatchObject({ ok: false, errorClass: 'INVALID_TOOL_RESULT' });
    const route = mkDeps(() => 'GNWL 1').deps; route.getRoute = async () => ({ ok: false, error: { code: 'TIMEOUT' } });
    expect(await runSameTrainSearch(REQ(), route)).toMatchObject({ ok: false, errorClass: 'TOOL_TIMEOUT' });
  });
  it('[25] independent pair checks run in parallel (bounded) — not one by one', async () => {
    let inFlight = 0, max = 0;
    const deps = mkDeps(() => 'GNWL 1').deps;
    deps.checkAvailability = async (_p, q) => { inFlight++; max = Math.max(max, inFlight); await new Promise(r => setTimeout(r, 10)); inFlight--; return { ok: true, data: { trainNumber: q.trainNumber, status: 'GNWL 1' } }; };
    await ok(REQ(), deps);
    expect(max).toBeGreaterThan(1);
    expect(max).toBeLessThanOrEqual(LIMITS.maxParallel * 2);
  });
  it('[26] result metadata: identity, pair, boarding/alighting, class, pax, count, status, provider, fetchedAt, fresh, ids', async () => {
    const r = await ok(REQ({ triggerReason: 'INSUFFICIENT_SEATS', triggerSource: 'SESSION_EVIDENCE', toolExecutionId: 'te_1',
      contextSnapshot: { selectedTrain: '12903', selectedClass: '1A', journeyVersion: 3 } }), mkDeps((_p, q) => (q.origin === 'BEAS' ? 'AVAILABLE-0004' : 'GNWL 2')).deps);
    const a = byPair(r, 'BEAS-UMB');
    expect(a).toMatchObject({ trainNumber: '12903', trainName: 'Golden Temple Mail', date: DATE, ticketOrigin: 'BEAS', ticketDestination: 'UMB', boardingStation: 'BEAS',
      alightingStation: 'UMB', boardingRuleStatus: 'UNVERIFIED', travelClass: '1A', requestedPassengerCount: 3, availableSeatCount: 4, availabilityStatus: 'AVAILABLE', seatSufficiency: 'SUFFICIENT' });
    expect(a.evidence.map(e => e.provider).sort()).toEqual(['railcore', 'railradar']);
    expect(a.evidence.every(e => !!e.fetchedAt && !!e.toolExecutionId)).toBe(true);
    expect(r).toMatchObject({ fresh: true, cached: false, toolExecutionId: 'te_1', triggerReason: 'INSUFFICIENT_SEATS', triggerSource: 'SESSION_EVIDENCE',
      contextSnapshot: { selectedTrain: '12903', selectedClass: '1A', journeyVersion: 3 } });
    expect(r.alternativeSearchId).toMatch(/^sta_/); expect(r.resultSetId).toMatch(/^sts_/);
    expect(JSON.stringify(r)).not.toMatch(/api[_-]?key|bearer|password|cookie/i);
  });
});

// ================================================================= 4. stale protection + fresh recheck
describe('P42.2 G2 — stale protection + fresh recheck before selection', () => {
  const snapR = async (cls = '2A', snap: any = { selectedTrain: '12903', selectedClass: '1A', journeyVersion: 3 }) =>
    ok(REQ({ travelClass: cls, contextSnapshot: snap }), mkDeps((_p, q) => (q.origin === 'JUC' ? 'AVAILABLE-0003' : 'GNWL 2')).deps);
  const sess = (o: any = {}) => ({ origin: 'LDH', destination: 'UMB', date: DATE, passengersCount: 3, selectedTrain: { number: '12903' }, selectedClass: '1A', ...o });
  it('[17][18][19] multi-class result stays current while the selection is unchanged; new class / date / pax / train → stale', async () => {
    const r = await snapR();
    expect(isSameTrainResultStale(sess(), r)).toBe(false);                                     // 2A searched while 1A selected
    expect(isSameTrainResultStale(sess({ selectedClass: '2A' }), r)).toBe(false);              // user picked the searched class
    expect(isSameTrainResultStale(sess({ selectedClass: '3A' }), r)).toBe(true);               // \"Actually 3A\"
    expect(isSameTrainResultStale(sess({ passengersCount: 2 }), r)).toBe(true);
    expect(isSameTrainResultStale(sess({ date: '2026-10-10' }), r)).toBe(true);
    expect(isSameTrainResultStale(sess({ selectedTrain: { number: '12014' } }), r)).toBe(true); // 12903 → 12014
  });
  it('[18b] multi-train discovery before selection stays current; selecting another train makes it stale', async () => {
    const r = await snapR('1A', { selectedTrain: null, selectedClass: null, journeyVersion: 3 });
    expect(isSameTrainResultStale(sess({ selectedTrain: undefined, selectedClass: undefined }), r)).toBe(false);
    expect(isSameTrainResultStale(sess({ selectedTrain: { number: '12903' }, selectedClass: '1A' }), r)).toBe(false);
    expect(isSameTrainResultStale(sess({ selectedTrain: { number: '12497' }, selectedClass: undefined }), r)).toBe(true);
  });
  it('[20] stale result refused (STALE) before any provider call; selection resolves against its own result set', async () => {
    const r = await snapR();
    const m = mkDeps(() => 'AVAILABLE-0003');
    const s = sess({ selectedClass: '3A', sameTrainAlternatives: undefined, sameTrainAlternativeSets: [r] });
    expect(findSameTrainResult(s, r.alternativeSearchId)).toBe(r);
    const juc = byPair(r, 'JUC-UMB').alternativeId;
    expect(await revalidateSameTrainAlternative(r, r.alternativeSearchId, juc, sameTrainSelectionKey(s, r), { acknowledgeUnverifiedRules: true, deps: m.deps }))
      .toMatchObject({ ok: false, code: 'ALTERNATIVE_RESULT_STALE' });
    expect(m.calls.length).toBe(0);
  });
  it('[21] fresh recheck: still 3 seats → ok (one fresh call per provider); now 1 seat for 3 passengers → ALTERNATIVE_INSUFFICIENT_SEATS', async () => {
    const r = await snapR();
    const s = sess();
    const juc = byPair(r, 'JUC-UMB').alternativeId;
    const good = mkDeps(() => 'AVAILABLE-0003');
    expect(await revalidateSameTrainAlternative(r, r.alternativeSearchId, juc, sameTrainSelectionKey(s, r), { acknowledgeUnverifiedRules: true, deps: good.deps })).toMatchObject({ ok: true });
    expect(good.calls.length).toBe(2);
    const low = mkDeps(() => 'AVAILABLE-0001');
    expect(await revalidateSameTrainAlternative(r, r.alternativeSearchId, juc, sameTrainSelectionKey(s, r), { acknowledgeUnverifiedRules: true, deps: low.deps }))
      .toMatchObject({ ok: false, code: 'ALTERNATIVE_INSUFFICIENT_SEATS' });
  });
});

// ================================================================= 5. claim binding (train + date + class + pair + count)
describe('P42.2 G2 — claim guard binds every seat claim to train + date + class + ticket pair + count', () => {
  const mkCtx = async () => {
    const r = await ok(REQ(), mkDeps((_p, q) => (q.origin === 'JUC' ? 'AVAILABLE-0003' : q.origin === 'LDH' && q.destination === 'UMB' ? 'AVAILABLE-0001' : 'GNWL 6')).deps);
    const session = { date: DATE, origin: 'LDH', destination: 'UMB', passengersCount: 3, selectedTrain: { number: '12903' }, selectedClass: '1A' };
    return { session, evidence: collectAvailabilityEvidence(session, [{ toolName: 'SEARCH_SAME_TRAIN_ALTERNATIVES', ok: true, data: r }]), origin: 'ASSISTANT' as const };
  };
  it('[11] cross-train claim rejected (12903 evidence never proves 12497)', async () => {
    expect(judgeAvailabilityClaim('12497 mein bhi Jalandhar se 3 seats available hain.', await mkCtx()).outcome).toBe('UNVERIFIED_AVAILABILITY');
  });
  it('[12] cross-class claim rejected (1A evidence never proves 2A)', async () => {
    expect(judgeAvailabilityClaim('12903 2A mein Jalandhar se 3 seats available hain.', await mkCtx()).outcome).toBe('UNVERIFIED_AVAILABILITY');
  });
  it('[13] cross-date claim rejected (9 Oct evidence never proves 10 Oct)', async () => {
    expect(judgeAvailabilityClaim('12903 1A mein 10 October ko Jalandhar se 3 seats available hain.', await mkCtx()).outcome).toBe('UNVERIFIED_AVAILABILITY');
  });
  it('[13b] pair binding: Jalandhar\'s 3 seats verify only a Jalandhar sentence; the requested pair has 1 seat', async () => {
    const ctx = await mkCtx();
    expect(judgeAvailabilityClaim('Same train 12903 1A mein Jalandhar se 3 seats available hain.', ctx).outcome).toBe('VERIFIED_AVAILABILITY');
    expect(judgeAvailabilityClaim('12903 1A mein 3 seats available hain.', ctx).outcome).toBe('AVAILABILITY_MISMATCH');          // requested pair = 1
    expect(judgeAvailabilityClaim('Jalandhar se 12903 1A mein sirf 1 seat hai.', ctx).outcome).toBe('AVAILABILITY_MISMATCH');
    expect(judgeAvailabilityClaim('12903 1A mein 3 seats hain.', ctx).reason).toMatch(/AVAILABILITY_MISMATCH/);                  // count claim without "available"
    expect(judgeAvailabilityClaim('12903 1A mein teen seats mil rahi hain.', ctx).reason).toMatch(/AVAILABILITY_MISMATCH/);
  });
  it('[2c] "1A available hai" over 1 seat for 3 passengers hides the shortage → rejected; the exact count passes', async () => {
    const ctx = await mkCtx();
    expect(judgeAvailabilityClaim('12903 1A available hai.', ctx).reason).toBe('AVAILABILITY_INSUFFICIENT_FOR_PARTY');
    expect(judgeAvailabilityClaim('12903 1A mein sirf 1 seat available hai.', ctx).outcome).toBe('VERIFIED_AVAILABILITY');
    // a need stated by the assistant is not a seat claim
    expect(judgeAvailabilityClaim('Aapko 3 seats chahiye.', ctx).outcome).not.toBe('AVAILABILITY_MISMATCH');
  });
});

// ================================================================= 6. UI visibility
describe('P42.2 G2 — UI: card only with a verified alternative for the whole party', () => {
  it('[27] no verified alternative → no card markup at all; verified → card with the party size', async () => {
    const none = await ok(REQ(), mkDeps((_p, q) => (q.origin === 'JUC' ? 'AVAILABLE 2' : 'GNWL 5')).deps);   // 2 seats < 3 pax
    const html0 = renderToStaticMarkup(React.createElement(SameTrainCard, { d: sameTrainCardData(none), sessionId: 's', onHandoff: () => {} }));
    expect(html0).toBe('');
    const some = await ok(REQ(), mkDeps((_p, q) => (q.origin === 'JUC' ? 'AVAILABLE-0003' : 'GNWL 5')).deps);
    const html1 = renderToStaticMarkup(React.createElement(SameTrainCard, { d: sameTrainCardData(some), sessionId: 's', onHandoff: () => {} }));
    expect(html1).toContain('Same Train Alternative');
    expect(html1).toContain('12903');
    expect(html1).toContain('1 verified for 3 pax');
    expect(html1).not.toMatch(/Best match/);                                                       // Muse did not rank → no badge
  });
});
