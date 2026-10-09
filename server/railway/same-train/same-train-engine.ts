/**
 * PROMPT 42 — Same Train Alternative engine (execution + hard constraints only).
 *
 * Pure planning / merging functions + a bounded parallel runner with injected provider adapters, so the logic is
 * testable without a network and never depends on a specific provider. The engine:
 *   - takes the route ONLY from a route-capable provider response (never hardcoded, never invented);
 *   - builds candidate pairs in a fixed, documented SEARCH-BUDGET order (P0 requested, P1 upstream origins → requested
 *     destination, P2 requested origin → downstream extension, P3 combined) — this is not a ranking;
 *   - calls each chosen provider FRESH for every candidate (no cache), bounded by concurrency + timeouts;
 *   - validates every provider answer against the request (train / date / class), keeps UNKNOWN / TIMEOUT distinct from
 *     NOT_AVAILABLE, never computes a fare, reports provider disagreement as CONFLICTING (never merged / averaged);
 *   - marks boarding / alighting at a station other than the ticket station UNVERIFIED unless a rule-evidence source
 *     verified it.
 * It never ranks, never chooses a best match and never touches the BookingSession — Muse and the user decide.
 */
import { randomUUID } from 'node:crypto';
import {
  type AvailabilityCategory, type CandidatePair, type CandidatePriority, type CombinedAvailability, type EvidenceLevel,
  type ProviderEvidence, type RouteStation, type RuleStatus, type SameTrainAlternative, type SameTrainAlternativesResult,
  type SameTrainErrorCode, type SameTrainLimits, type VerificationStatus, type WebRouteEvidence,
  SameTrainErrorCode as E, SAME_TRAIN_ALL_FAILED_MESSAGE, SAME_TRAIN_DEFAULT_LIMITS, DESTINATION_EXTENSION_MIN, DESTINATION_EXTENSION_MAX, MAX_EARLIER_STATIONS, MAX_AVAILABILITY_CHECKS,
  sameTrainJourneyKeyString, type SameTrainRouteCheck, type SameTrainRouteVerification
} from '@shared/same-train-alternatives';
import { providerFreshnessOf } from '@shared/provider-freshness';
import {
  type ShortageTriggerReason, evaluateSeatShortage, normalizeAvailabilityState, isVerifiedSameTrainAlternative, SameTrainOutcome, SameTrainErrorClass, currentWaitlistNumber
} from '@shared/same-train-shortage';

// ------------------------------------------------------------------ limits

const envNum = (env: NodeJS.ProcessEnv, k: string, d: number, lo: number, hi: number): number => {
  const n = Number(env[k]);
  return Number.isFinite(n) && env[k] !== undefined && env[k] !== '' ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

/** Env-configurable limits, clamped to safe ranges (never unbounded). */
export function sameTrainLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): SameTrainLimits {
  const D = SAME_TRAIN_DEFAULT_LIMITS;
  return {
    maxCandidatePairs: envNum(env, 'SAME_TRAIN_MAX_CANDIDATE_PAIRS', D.maxCandidatePairs, 1, 60),
    maxOriginSweepStations: envNum(env, 'SAME_TRAIN_MAX_ORIGIN_SWEEP', D.maxOriginSweepStations, 0, MAX_EARLIER_STATIONS),
    maxDestinationSweep: envNum(env, 'SAME_TRAIN_MAX_DESTINATION_SWEEP', D.maxDestinationSweep, DESTINATION_EXTENSION_MIN, DESTINATION_EXTENSION_MAX),
    // P42.9: SAME_TRAIN_MAX_CONCURRENCY (spec name) wins over the older SAME_TRAIN_MAX_PARALLEL; request RATE is paced
    // per provider by the live pacer (RAILCORE_RATE_LIMIT_PER_MIN / RAILCORE_MIN_INTERVAL_MS …), concurrency only bounds bursts
    maxParallel: envNum(env, 'SAME_TRAIN_MAX_CONCURRENCY', envNum(env, 'SAME_TRAIN_MAX_PARALLEL', D.maxParallel, 1, 12), 1, 12),
    perCallTimeoutMs: envNum(env, 'SAME_TRAIN_CALL_TIMEOUT_MS', D.perCallTimeoutMs, 500, 30000),
    totalTimeoutMs: envNum(env, 'SAME_TRAIN_TOTAL_TIMEOUT_MS', D.totalTimeoutMs, 1000, 90000),
    maxWebChecks: envNum(env, 'SAME_TRAIN_MAX_WEB_CHECKS', D.maxWebChecks, 0, 20),
    maxAvailabilityChecks: envNum(env, 'SAME_TRAIN_MAX_AVAILABILITY_CHECKS', D.maxAvailabilityChecks ?? 120, 1, MAX_AVAILABILITY_CHECKS),
    // RailRadar Phase 1: route cross-check on the secondary route provider (default on; off|false|0 disables)
    routeCrossCheck: !/^(off|false|0)$/i.test(String(env.SAME_TRAIN_ROUTE_CROSS_CHECK ?? '').trim()),
    // 2026-10-09: provider snapshot freshness limit in minutes (0 = off); default 120
    maxSnapshotAgeMs: envNum(env, 'SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN', Math.round((D.maxSnapshotAgeMs ?? 3600000) / 60000), 0, 24 * 60) * 60000
  };
}

// ------------------------------------------------------------------ route

const CODE_RE = /^[A-Z][A-Z0-9]{0,5}$/;

/**
 * Provider timetable stops → ordered route stations. Accepts the normalized timetable shapes of the existing providers
 * ({station|stationCode|code, stationName|name, arrival, departure, day}). Returns null codes for unusable rows;
 * a route with fewer than two valid stations is INVALID_TRAIN_ROUTE. A station that appears twice (loop route) is
 * reported in `duplicates` — it can never be used as a ticket station (ambiguous order).
 */
export function normalizeRoute(stops: unknown): { ok: true; stations: RouteStation[]; duplicates: Set<string> } | { ok: false; code: SameTrainErrorCode; message: string } {
  const rows: any[] = Array.isArray(stops) ? stops : Array.isArray((stops as any)?.stops) ? (stops as any).stops : [];
  const stations: RouteStation[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const r of rows) {
    const code = String(r?.station ?? r?.stationCode ?? r?.code ?? '').trim().toUpperCase();
    if (!CODE_RE.test(code)) continue;
    if (seen.has(code)) {
      if (stations[stations.length - 1]?.code !== code) duplicates.add(code);   // consecutive repeat = same halt
      continue;
    }
    seen.add(code);
    const name = r?.stationName ?? r?.name;
    stations.push({ code, index: stations.length, ...(name ? { name: String(name).slice(0, 60) } : {}),
      ...(r?.arrival ? { arrival: String(r.arrival).slice(0, 8) } : {}), ...(r?.departure ? { departure: String(r.departure).slice(0, 8) } : {}),
      ...(Number.isFinite(Number(r?.day)) && r?.day !== undefined && r?.day !== null ? { day: Number(r.day) } : {}) });
  }
  if (stations.length < 2) return { ok: false, code: E.INVALID_TRAIN_ROUTE, message: 'Train ka route provider se verify nahi ho paaya.' };
  return { ok: true, stations, duplicates };
}

// ------------------------------------------------------------------ route cross-check (RailRadar Phase 1)

export type RouteCrossCheckVerdict =
  | { verdict: 'VERIFIED' }
  | { verdict: 'UNVERIFIED'; reason: 'NOT_IN_ROUTE' | 'ORDER' | 'DUPLICATE' | 'NO_OVERLAP' }
  | { verdict: 'CONFLICT'; reason: 'ORDER_DISAGREEMENT' };

/**
 * Deterministic cross-check of the requested pair against a SECONDARY provider's route data, called only after the
 * primary route data could not verify the pair. Absence is not contradiction:
 *   - the secondary route must contain origin BEFORE destination (both present, neither a repeated station);
 *   - every station both routes contain (non-repeated) must appear in the SAME relative order in both — any disagreement
 *     (incl. the primary holding the pair in the opposite order) is a CONFLICT, never resolved by picking a provider;
 *   - fewer than 2 shared stations = no corroboration that both describe the same run → UNVERIFIED.
 * No railway fact is derived: the result only says what the two providers' route DATA show.
 */
export function crossCheckRoute(primary: RouteStation[], primaryDup: Set<string>, secondary: RouteStation[], secondaryDup: Set<string>,
  origin: string, destination: string): RouteCrossCheckVerdict {
  const o = String(origin || '').toUpperCase(), d = String(destination || '').toUpperCase();
  if (secondaryDup.has(o) || secondaryDup.has(d)) return { verdict: 'UNVERIFIED', reason: 'DUPLICATE' };
  const so = secondary.findIndex(s => s.code === o), sd = secondary.findIndex(s => s.code === d);
  if (so < 0 || sd < 0) return { verdict: 'UNVERIFIED', reason: 'NOT_IN_ROUTE' };
  if (so >= sd) return { verdict: 'UNVERIFIED', reason: 'ORDER' };
  const secIndex = new Map(secondary.filter(s => !secondaryDup.has(s.code)).map(s => [s.code, s.index] as const));
  const shared = primary.filter(s => !primaryDup.has(s.code) && secIndex.has(s.code)).map(s => secIndex.get(s.code)!);
  for (let i = 1; i < shared.length; i++) if (shared[i] <= shared[i - 1]) return { verdict: 'CONFLICT', reason: 'ORDER_DISAGREEMENT' };
  if (shared.length < 2) return { verdict: 'UNVERIFIED', reason: 'NO_OVERLAP' };
  return { verdict: 'VERIFIED' };
}

// ------------------------------------------------------------------ planning

export interface PlanInput {
  origin: string;
  destination: string;
  originSweep: boolean;
  destinationSweep: boolean;
  /** Muse-chosen extension length; clamped to 5..7, default limits.maxDestinationSweep */
  destinationExtensionStations?: number;
  /** AUTO = P3 only when P0–P2 found no AVAILABLE / RAC (second phase) · ALWAYS · NEVER */
  combinedPairs?: 'AUTO' | 'ALWAYS' | 'NEVER';
  /**
   * P42-14 terminal sweep: AUTO = when the bounded window (≤15 earlier stations, destination + 5..7) found no AVAILABLE /
   * RAC in any searched class, extend the ticket destination over the REST of the route up to the train's terminal
   * (requested origin → each further station, route order) · NEVER (default — pre-P42-14 behaviour).
   */
  terminalSweep?: 'AUTO' | 'NEVER';
  /**
   * findBoardFromEarlier (Phase 2) staged depth: stage A = requested pair + the `earlier` nearest stops before the origin
   * + `ahead` stops past the destination; stage B (phase3, only when stage A found nothing bookable in any searched class)
   * = the remaining earlier stops up to the train's origin (≤ MAX_EARLIER_STATIONS), then onward up to the terminus.
   */
  staged?: { earlier: number; ahead: number };
}

export interface CandidatePlan {
  route: RouteStation[];
  originIndex: number;
  destinationIndex: number;
  originAlternatives: RouteStation[];      // route order
  destinationExtension: RouteStation[];    // route order
  destinationSweep: 'NONE_TERMINAL' | 'EXTENSION' | 'DISABLED';
  phase1: CandidatePair[];                 // P0, P1, P2
  phase2: CandidatePair[];                 // P3 (combined) — run per combinedPairs policy
  /** P42-14: stations after the destination extension up to the train's terminal (route order) — phase 3 only */
  terminalExtension: RouteStation[];
  phase3: CandidatePair[];                 // P2-kind pairs requested origin → terminalExtension (terminalSweep AUTO)
  /** Phase 2 staged depth, stage B1: the remaining earlier stops (nearest first, up to the origin) → requested destination.
   *  Runs only when stage A found nothing bookable; phase3 (terminus) only when B1 also found nothing. Empty unstaged. */
  stageB: CandidatePair[];
  truncated: boolean;
}

const pairOf = (route: RouteStation[], oi: number, di: number, priority: CandidatePriority): CandidatePair => ({
  pairId: `${route[oi].code}-${route[di].code}`, priority,
  kind: priority === 'P0' ? 'REQUESTED' : priority === 'P1' ? 'ORIGIN_ALTERNATIVE' : priority === 'P2' ? 'DESTINATION_EXTENSION' : 'ORIGIN_AND_DESTINATION',
  ticketOrigin: route[oi].code, ticketDestination: route[di].code, originIndex: oi, destinationIndex: di
});

export function planCandidates(stations: RouteStation[], duplicates: Set<string>, input: PlanInput, limits: SameTrainLimits)
  : { ok: true; plan: CandidatePlan } | { ok: false; code: SameTrainErrorCode; message: string } {
  const o = String(input.origin || '').toUpperCase();
  const d = String(input.destination || '').toUpperCase();
  const oi = stations.findIndex(s => s.code === o);
  const di = stations.findIndex(s => s.code === d);
  // P42-13: the provider's route data may be incomplete — the message states what the DATA shows, never a railway fact
  if (oi < 0 || di < 0) {
    const missing = [oi < 0 ? o : '', di < 0 ? d : ''].filter(Boolean).join(', ');
    return { ok: false, code: E.INVALID_STATION_PAIR, message: `Provider ke current route data mein ${missing} nahi mila — yeh route data adhoora ho sakta hai, isliye ${o} → ${d} ke liye same train alternative verify nahi ho paaya (iska matlab yeh nahi ki train ${missing} se nahi guzarti).` };
  }
  if (duplicates.has(o) || duplicates.has(d)) return { ok: false, code: E.INVALID_TRAIN_ROUTE, message: 'Route mein station do baar aata hai — order verify nahi ho sakta.' };
  if (oi >= di) return { ok: false, code: E.INVALID_STATION_PAIR, message: `Provider ke current route data mein ${o} → ${d} is train ki direction mein nahi dikh raha, isliye yeh station pair verify nahi ho paaya.` };
  const terminal = stations.length - 1;

  // origin sweep: train origin … requested origin (inclusive of the requested origin = P0), bounded, never a duplicate station
  const originAlternatives = input.originSweep
    ? stations.slice(Math.max(0, oi - Math.min(MAX_EARLIER_STATIONS, Math.max(0, limits.maxOriginSweepStations))), oi).filter(s => !duplicates.has(s.code))
    : [];
  // destination: requested destination == terminal → no sweep; else extend downstream 5..7 (never past the terminal)
  let destinationSweep: CandidatePlan['destinationSweep'];
  let destinationExtension: RouteStation[] = [];
  if (di === terminal) destinationSweep = 'NONE_TERMINAL';
  else if (!input.destinationSweep) destinationSweep = 'DISABLED';
  else {
    destinationSweep = 'EXTENSION';
    const raw = Number(input.destinationExtensionStations);
    const n = input.staged ? Math.max(0, Math.min(DESTINATION_EXTENSION_MAX, Math.round(Number(input.staged.ahead) || 0)))
      : Number.isFinite(raw) && raw > 0 ? Math.min(DESTINATION_EXTENSION_MAX, Math.max(DESTINATION_EXTENSION_MIN, Math.round(raw))) : Math.min(DESTINATION_EXTENSION_MAX, limits.maxDestinationSweep);
    destinationExtension = stations.slice(di + 1, Math.min(terminal, di + n) + 1).filter(s => !duplicates.has(s.code));
  }

  const nearestOrigins = [...originAlternatives].sort((a, b) => b.index - a.index);       // closest to the requested origin first
  const nearestDests = [...destinationExtension].sort((a, b) => a.index - b.index);       // closest to the requested destination first
  // Phase 2 staged depth: stage A holds only the nearest `earlier` stops; the rest waits for stage B (phase3)
  const stageAOrigins = input.staged ? nearestOrigins.slice(0, Math.max(0, Math.round(Number(input.staged.earlier) || 0))) : nearestOrigins;
  const stageBOrigins = input.staged ? nearestOrigins.slice(stageAOrigins.length) : [];
  const all: CandidatePair[] = [pairOf(stations, oi, di, 'P0')];
  for (const s of stageAOrigins) all.push(pairOf(stations, s.index, di, 'P1'));
  for (const s of nearestDests) all.push(pairOf(stations, oi, s.index, 'P2'));
  const combined: CandidatePair[] = [];
  if (input.combinedPairs !== 'NEVER') {
    for (const so of stageAOrigins) for (const sd of nearestDests) combined.push(pairOf(stations, so.index, sd.index, 'P3'));
    combined.sort((a, b) => ((oi - a.originIndex) + (a.destinationIndex - di)) - ((oi - b.originIndex) + (b.destinationIndex - di)) || b.originIndex - a.originIndex);
  }
  const cap = limits.maxCandidatePairs;
  const seen = new Set<string>();
  const phase1 = all.filter(p => !seen.has(p.pairId) && (seen.add(p.pairId), true)).slice(0, cap);
  const phase2 = combined.filter(p => !seen.has(p.pairId) && (seen.add(p.pairId), true)).slice(0, Math.max(0, cap - phase1.length));
  // P42-14: the rest of the route after the extension window, up to the terminal (never a duplicate station, never re-checked)
  const lastWindowIndex = destinationExtension.length ? destinationExtension[destinationExtension.length - 1].index : di;
  const terminalExtension = (input.terminalSweep === 'AUTO' || input.staged) && destinationSweep === 'EXTENSION'
    ? stations.slice(lastWindowIndex + 1).filter(s => !duplicates.has(s.code)) : [];
  // stage B1 (F3 order): the remaining earlier stops nearest first, up to the origin; then phase3 beyond the destination
  const stageB = stageBOrigins.map(s => pairOf(stations, s.index, di, 'P1')).filter(p => !seen.has(p.pairId) && (seen.add(p.pairId), true)).slice(0, cap);
  const phase3 = terminalExtension.map(s => pairOf(stations, oi, s.index, 'P2')).filter(p => !seen.has(p.pairId) && (seen.add(p.pairId), true)).slice(0, cap);
  const truncated = all.length > phase1.length || combined.length > phase2.length || terminalExtension.length > phase3.length || stageBOrigins.length > stageB.length;
  return { ok: true, plan: { route: stations, originIndex: oi, destinationIndex: di, originAlternatives, destinationExtension, destinationSweep, phase1, phase2, terminalExtension, phase3, stageB, truncated } };
}

// ------------------------------------------------------------------ provider answers

/** Provider status string → canonical category. Anything unrecognised stays UNKNOWN (never NOT_AVAILABLE). */
export function availabilityCategory(status: unknown): AvailabilityCategory {
  // P42.2: one normalizer (shared) — REGRET / TRAIN_CANCELLED keep their own state there and map to NOT_AVAILABLE here
  const st = normalizeAvailabilityState(status);
  return st === 'REGRET' || st === 'TRAIN_CANCELLED' ? 'NOT_AVAILABLE' : st;
}

/** category + first position number — two providers "agree" only when both match ("WL 12" ≠ "WL 15"). */
export function statusKey(status: string): string {
  const cat = availabilityCategory(status);
  const n = String(status).match(/(\d{1,4})/);
  return `${cat}:${n ? String(Number(n[1])) : ''}`;
}

const TIMEOUT_CODES = new Set(['PROVIDER_TIMEOUT', 'TIMEOUT', 'TOOL_TIMEOUT', 'ALTERNATIVE_SEARCH_TIMEOUT']);
/** F2: the provider ANSWERED and the route is not there / not usable — the only route failures that are INVALID_TRAIN_ROUTE */
const ROUTE_VERDICT_CODES: ReadonlySet<string> = new Set(['NOT_FOUND', 'TRAIN_NOT_FOUND', 'NO_RESULTS', 'PROVIDER_DATA_INVALID']);
/** P42.9: same set as provider-fallback FALLBACK_ELIGIBLE_CODES (kept local — the engine stays free of registry imports). */
export const SAME_TRAIN_FALLBACK_ELIGIBLE = new Set(['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'TOOL_TIMEOUT', 'PROVIDER_TIMEOUT']);
const normDate = (v: unknown) => String(v ?? '').slice(0, 10);

export interface ProviderRef { id: string; label?: string; level: EvidenceLevel; isMock?: boolean }

export interface AvailabilityQuery { trainNumber: string; travelClass: string; date: string; origin: string; destination: string; passengersCount: number }

export interface SameTrainDeps {
  limits: SameTrainLimits;
  getRoute: (provider: ProviderRef, trainNumber: string) => Promise<any>;
  /** `ctx.deadline` (epoch ms): F3 scheduled deps drop a still-queued call once the search deadline has passed */
  checkAvailability: (provider: ProviderRef, q: AvailabilityQuery, ctx?: { deadline: number }) => Promise<any>;
  getFare?: (provider: ProviderRef, q: AvailabilityQuery) => Promise<any>;
  /** public-web listing check (UNVERIFIED_WEB) — does the same train run between this pair? */
  webListsTrain?: (provider: ProviderRef, q: { trainNumber: string; origin: string; destination: string; date: string }) => Promise<{ ok: true; listed: boolean } | { ok: false; code: string }>;
  /** optional boarding / alighting rule evidence source; absent → UNVERIFIED */
  ruleEvidence?: (q: { kind: 'BOARDING' | 'ALIGHTING'; trainNumber: string; ticketStation: string; travelStation: string; travelClass: string }) => Promise<'VERIFIED' | 'UNVERIFIED'>;
  /** false once the journey / turn this search belongs to is superseded → remaining calls are skipped */
  isCurrent?: () => boolean;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /**
   * F3: route / availability calls go through the paced fair queue (same-train-scheduler). The queue owns pacing,
   * the per-call timeout (provider call only), bounded retries and cancellation → the engine must NOT time out the
   * queue wait, and runs every unit of a phase concurrently so the queue (not mapLimit) decides the order.
   */
  scheduled?: boolean;
  /** F3: genuine progress as results arrive (counts + interim seats; never a final verdict) */
  onProgress?: (p: SameTrainProgress) => void;
}

/** F3 progress snapshot (counts of REAL provider outcomes so far; `found` = interim seats, verification still running). */
export interface SameTrainProgress {
  stage: 'ROUTE' | 'CHECKING' | 'FINALIZING';
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  retried: number;
  found: { ticketOrigin: string; ticketDestination: string; travelClass: string; status: string }[];
}

const SCHED_CANCELLED = 'SCHEDULER_CANCELLED';
/** F3: scheduled call → same shape as withTimeout (the queue's own per-call timeout surfaces as `timedOut`). */
function viaQueue<T>(p: Promise<T>): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  return p.then(v => ((v as any)?.meta?.scheduler?.timedOut ? { timedOut: true as const } : { timedOut: false as const, value: v }),
    e => ({ timedOut: false as const, value: { ok: false, error: { code: String(e?.code || 'PROVIDER_ERROR'), message: 'provider call failed' } } as any }));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve({ timedOut: true }), ms);
    p.then(v => { clearTimeout(t); resolve({ timedOut: false, value: v }); },
      e => { clearTimeout(t); resolve({ timedOut: false, value: { ok: false, error: { code: String(e?.code || 'PROVIDER_ERROR'), message: 'provider call failed' } } as any }); });
  });
}

/** Bounded parallel map (each provider gets its own pool of `limit`). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  });
  await Promise.all(workers);
  return out;
}

/** Freshness of a provider snapshot: age in ms from the provider's own timestamp, or null when it has none / unparsable. */
export function snapshotAgeMs(providerUpdatedAt: unknown, nowMs: number = Date.now()): number | null {
  if (providerUpdatedAt === undefined || providerUpdatedAt === null || providerUpdatedAt === '') return null;
  const t = Date.parse(String(providerUpdatedAt));
  if (!Number.isFinite(t)) return null;
  return Math.max(0, nowMs - t);                // a clock-skewed future timestamp counts as fresh (age 0)
}

/**
 * Validate one provider availability answer against the request binding (no silent substitution).
 * 2026-10-09: with `opts.maxSnapshotAgeMs` (> 0), an answer whose provider snapshot (providerUpdatedAt) is older than the
 * limit is NOT a verdict — outcome FAILED / STALE_PROVIDER_DATA; the old status + time are kept as staleSnapshot.
 */
export function evaluateAvailabilityAnswer(resp: any, q: AvailabilityQuery, opts: { maxSnapshotAgeMs?: number; nowMs?: number } = {})
  : Pick<ProviderEvidence, 'outcome' | 'availability' | 'errorCode' | 'rejectedReason' | 'staleSnapshot'> {
  if (!resp || typeof resp !== 'object') return { outcome: 'FAILED', errorCode: 'MALFORMED_PROVIDER_RESPONSE' };
  if (resp.ok !== true) {
    const code = String(resp.error?.code || 'PROVIDER_ERROR');
    return { outcome: TIMEOUT_CODES.has(code) ? 'TIMEOUT' : 'FAILED', errorCode: code };
  }
  const d = resp.data;
  if (!d || typeof d !== 'object' || !String(d.status ?? '').trim()) return { outcome: 'REJECTED', rejectedReason: 'MALFORMED', errorCode: 'MALFORMED_PROVIDER_RESPONSE' };
  if (d.trainNumber !== undefined && String(d.trainNumber).trim() !== q.trainNumber) return { outcome: 'REJECTED', rejectedReason: 'WRONG_TRAIN', errorCode: 'RESULT_IDENTITY_MISMATCH' };
  if (d.date && normDate(d.date) !== q.date) return { outcome: 'REJECTED', rejectedReason: 'WRONG_DATE', errorCode: 'RESULT_IDENTITY_MISMATCH' };
  if (d.travelClass && String(d.travelClass).toUpperCase() !== q.travelClass) return { outcome: 'REJECTED', rejectedReason: 'WRONG_CLASS', errorCode: 'RESULT_IDENTITY_MISMATCH' };
  const status = String(d.status).replace(/\s+/g, ' ').trim().slice(0, 40);
  const maxAge = Number(opts.maxSnapshotAgeMs) || 0;
  if (maxAge > 0) {
    const age = snapshotAgeMs(d.providerUpdatedAt, opts.nowMs ?? Date.now());
    if (age !== null && age > maxAge) {
      return { outcome: 'FAILED', errorCode: E.STALE_PROVIDER_DATA,
        staleSnapshot: { status, providerUpdatedAt: String(d.providerUpdatedAt).slice(0, 40), ageMinutes: Math.round(age / 60000) } };
    }
  }
  return { outcome: 'SUCCESS', availability: { category: availabilityCategory(status), status,
    ...(d.statusText ? { statusText: String(d.statusText).slice(0, 80) } : {}), ...(d.quota ? { quota: String(d.quota).slice(0, 8) } : {}),
    ...(d.providerUpdatedAt ? { providerUpdatedAt: String(d.providerUpdatedAt).slice(0, 40) } : {}),
    // 2026-10-09: freshness label from the provider's own timestamp only (undated → TIMESTAMP_UNAVAILABLE, never "fresh")
    freshness: providerFreshnessOf(d.providerUpdatedAt, { maxAgeMs: maxAge, nowMs: opts.nowMs ?? Date.now() }) } };
}

/** Provider fare (never computed): total / perPassenger must be positive provider numbers for this train + class. */
export function evaluateFareAnswer(resp: any, q: AvailabilityQuery): { ok: true; total?: number; perPassenger?: number; currency?: string } | { ok: false; code: string; timeout: boolean } {
  if (!resp || resp.ok !== true || !resp.data) {
    const code = String(resp?.error?.code || 'FARE_UNAVAILABLE');
    return { ok: false, code, timeout: TIMEOUT_CODES.has(code) };
  }
  const d = resp.data;
  if (d.trainNumber !== undefined && String(d.trainNumber) !== q.trainNumber) return { ok: false, code: 'RESULT_IDENTITY_MISMATCH', timeout: false };
  if (d.travelClass && String(d.travelClass).toUpperCase() !== q.travelClass) return { ok: false, code: 'RESULT_IDENTITY_MISMATCH', timeout: false };
  const pos = (v: any) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const total = pos(d.total); const perPassenger = pos(d.perPassenger);
  if (total === undefined && perPassenger === undefined) return { ok: false, code: 'FARE_UNAVAILABLE', timeout: false };
  return { ok: true, ...(total !== undefined ? { total } : {}), ...(perPassenger !== undefined ? { perPassenger } : {}), currency: String(d.currency || 'INR').slice(0, 3) };
}

// ------------------------------------------------------------------ ticket date (2026-10-09)

/** ISO date + n days (UTC calendar arithmetic, no time zone drift). */
export function addDaysIso(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(t)) return date;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

/**
 * The journey date of a ticket from `ticketOriginIndex` on the SAME run that leaves the requested origin on `journeyDate`:
 * journeyDate + (day(ticket origin) − day(requested origin)) from the provider timetable. A ticket from an earlier
 * station the train leaves on the previous calendar day (12425: NDLS day 1 20:40 → LDH day 2 00:38) is dated one day
 * EARLIER — querying the journey date would check a different run. Unknown timetable day → null (never guessed).
 */
export function ticketDateFor(route: ReadonlyArray<{ day?: number }>, ticketOriginIndex: number, requestedOriginIndex: number, journeyDate: string)
  : { date: string; shiftDays: number; dayUnknown?: true } | null {
  if (ticketOriginIndex === requestedOriginIndex) return { date: journeyDate, shiftDays: 0 };
  const a = route[ticketOriginIndex]?.day, b = route[requestedOriginIndex]?.day;
  // a timetable WITHOUT any day field (none of the stops) → the journey date, flagged dayUnknown (shown as unverified);
  // a timetable that has days but not for these stops is inconsistent → null (the pair is not checked)
  if (!route.some(st => Number.isFinite(st?.day))) return { date: journeyDate, shiftDays: 0, dayUnknown: true };
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const shiftDays = Number(a) - Number(b);
  return { date: addDaysIso(journeyDate, shiftDays), shiftDays };
}

// ------------------------------------------------------------------ merging

export interface MergeContext {
  trainNumber: string; trainName?: string; date: string; travelClass: string; passengersCount: number;
  requestedOrigin: string; requestedDestination: string; names: Map<string, string | undefined>; includeFare: boolean;
}

/**
 * Merge all provider evidence for ONE candidate pair. Disagreeing providers → CONFLICTING (no value shown as fact);
 * no successful provider answer → UNKNOWN (never NOT_AVAILABLE); every answer rejected → INVALID (hidden).
 */
export function mergeCandidate(pair: CandidatePair, evidence: ProviderEvidence[], web: WebRouteEvidence[], rules: { boarding: RuleStatus; alighting: RuleStatus }, ctx: MergeContext, fetchedAt: string)
  : Omit<SameTrainAlternative, 'alternativeId'> {
  const api = evidence.filter(e => e.level === 'PROVIDER_API');
  // an answered call whose status is not recognisable stays UNKNOWN: it neither verifies availability nor "conflicts"
  const ok = api.filter(e => e.outcome === 'SUCCESS' && e.availability && e.availability.category !== 'UNKNOWN');
  const keys = new Set(ok.map(e => statusKey(e.availability!.status)));
  const conflicting = keys.size > 1;
  let availability: CombinedAvailability = 'UNKNOWN';
  let statusText: string | undefined;
  if (conflicting) availability = 'CONFLICTING';
  else if (ok.length) { availability = ok[0].availability!.category; statusText = ok[0].availability!.status; }
  // 2026-10-09: the answer's freshness; with several agreeing providers the LEAST verifiable one is reported
  const freshness = conflicting || !ok.length ? undefined
    : (ok.map(e => e.availability!.freshness).find(f => f && !f.freshnessVerified) ?? ok[0].availability!.freshness);

  // fare: provider numbers only; disagreement → CONFLICTING (no fare shown)
  let fare: SameTrainAlternative['fare'] = { status: ctx.includeFare ? 'UNAVAILABLE' : 'NOT_REQUESTED' };
  const fares = api.filter(e => e.fare && (e.fare.total !== undefined || e.fare.perPassenger !== undefined));
  if (fares.length) {
    const fk = new Set(fares.map(e => `${e.fare!.total ?? ''}|${e.fare!.perPassenger ?? ''}`));
    fare = fk.size > 1 ? { status: 'CONFLICTING' }
      : { status: 'PROVIDER', provider: fares[0].provider, currency: fares[0].fare!.currency || 'INR',
        ...(fares[0].fare!.total !== undefined ? { total: fares[0].fare!.total } : {}), ...(fares[0].fare!.perPassenger !== undefined ? { perPassenger: fares[0].fare!.perPassenger } : {}) };
  }

  const allRejected = api.length > 0 && api.every(e => e.outcome === 'REJECTED');
  const rulesOk = (r: RuleStatus) => r === 'NOT_REQUIRED' || r === 'VERIFIED';
  const verificationStatus: VerificationStatus = allRejected ? 'INVALID'
    : conflicting ? 'CONFLICTING'
    : !ok.length ? 'UNVERIFIED'
    : rulesOk(rules.boarding) && rulesOk(rules.alighting) ? 'VERIFIED' : 'PARTIALLY_VERIFIED';
  const warnings: SameTrainErrorCode[] = [];
  if (conflicting) warnings.push(E.PROVIDER_DATA_CONFLICT);
  if (rules.boarding === 'UNVERIFIED') warnings.push(E.BOARDING_RULE_UNVERIFIED);
  if (rules.alighting === 'UNVERIFIED') warnings.push(E.ALIGHTING_RULE_UNVERIFIED);
  const isRequestedPair = pair.priority === 'P0';
  return {
    pairId: pair.pairId, priority: pair.priority, kind: pair.kind, isRequestedPair,
    trainNumber: ctx.trainNumber, ...(ctx.trainName ? { trainName: ctx.trainName } : {}), date: ctx.date, travelClass: ctx.travelClass, passengersCount: ctx.passengersCount,
    requestedOrigin: ctx.requestedOrigin, requestedDestination: ctx.requestedDestination,
    ticketOrigin: pair.ticketOrigin, ticketOriginName: ctx.names.get(pair.ticketOrigin),
    ticketDestination: pair.ticketDestination, ticketDestinationName: ctx.names.get(pair.ticketDestination),
    // a passenger travels on the ticket stations unless a VERIFIED rule allows boarding / alighting elsewhere
    boardingStation: rules.boarding === 'VERIFIED' ? ctx.requestedOrigin : pair.ticketOrigin,
    alightingStation: rules.alighting === 'VERIFIED' ? ctx.requestedDestination : pair.ticketDestination,
    intendedBoardingStation: ctx.requestedOrigin, intendedAlightingStation: ctx.requestedDestination,
    boardingRuleStatus: rules.boarding, alightingRuleStatus: rules.alighting,
    availability, ...(statusText ? { availabilityStatusText: statusText } : {}),
    // P42.2: party-bound seat facts (exact provider count only; CONFLICTING / no answer → UNKNOWN, never a shortage)
    ...seatFactsOf(conflicting ? undefined : statusText, ctx.passengersCount),
    fare, verificationStatus, actionable: verificationStatus === 'VERIFIED',
    ...(freshness ? { freshness } : {}),
    evidence, webEvidence: web, warnings,
    ...(conflicting ? { conflict: { providers: ok.map(e => e.provider), values: ok.map(e => ({ provider: e.provider, status: e.availability!.status })) } } : {}),
    // Phase 2: no fresh answer, only a too-old provider snapshot → kept for the screen (⚠ + age), never a verdict
    ...(!ok.length && !conflicting ? staleOf(api) : {}),
    extensionStations: 0,   // set by the runner (route index distance past the requested destination)
    fetchedAt
  };
}

/** Phase 2: the newest too-old snapshot among the evidence (status + age) — shown with ⚠, never availability. */
function staleOf(api: ProviderEvidence[]): Pick<SameTrainAlternative, 'staleSnapshot'> {
  const st = api.filter(e => e.errorCode === E.STALE_PROVIDER_DATA && e.staleSnapshot).sort((a, b) => a.staleSnapshot!.ageMinutes - b.staleSnapshot!.ageMinutes)[0];
  if (!st) return {};
  return { staleSnapshot: { provider: st.provider, status: st.staleSnapshot!.status, category: availabilityCategory(st.staleSnapshot!.status),
    providerUpdatedAt: st.staleSnapshot!.providerUpdatedAt, ageMinutes: st.staleSnapshot!.ageMinutes } };
}

/**
 * Phase 2 "better WL": nothing bookable found → a FRESH waitlist from an EARLIER station lower than the train's direct
 * waitlist of that class (fresh requested-pair answer first, else the search row) is marked — still WL, never confirmed.
 */
export function markBetterWaitlist(alternatives: SameTrainAlternative[], directStatus: Record<string, string> | undefined): number {
  const direct = (cls: string): number | undefined => {
    const p0 = alternatives.find(a => a.isRequestedPair && a.travelClass === cls);
    if (p0 && (p0.availability === 'AVAILABLE' || p0.availability === 'RAC')) return undefined;     // direct is not a waitlist now
    const fresh = p0 && p0.availability === 'WAITLIST' ? currentWaitlistNumber(p0.availabilityStatusText) : undefined;
    return fresh ?? currentWaitlistNumber(directStatus?.[cls]);
  };
  let n = 0;
  for (const a of alternatives) {
    if (a.isRequestedPair || a.kind !== 'ORIGIN_ALTERNATIVE' || a.availability !== 'WAITLIST') continue;
    if (a.verificationStatus !== 'VERIFIED' && a.verificationStatus !== 'PARTIALLY_VERIFIED') continue;
    const wl = currentWaitlistNumber(a.availabilityStatusText);
    const d = direct(a.travelClass);
    if (wl === undefined || d === undefined || wl >= d) continue;
    a.betterWaitlist = { waitlist: wl, directWaitlist: d }; n++;
  }
  return n;
}

/** P42.2: normalized state + exact seat count + sufficiency for the party (never inferred from AVAILABLE alone). */
function seatFactsOf(statusText: string | undefined, pax: number): Pick<SameTrainAlternative, 'availabilityStatus' | 'availableSeatCount' | 'requestedPassengerCount' | 'seatSufficiency'> {
  const a = evaluateSeatShortage({ status: statusText, requestedPassengerCount: pax });
  return { availabilityStatus: a.availabilityStatus, ...(a.availableSeatCount !== undefined ? { availableSeatCount: a.availableSeatCount } : {}),
    requestedPassengerCount: pax, seatSufficiency: a.sufficiency };
}

// ------------------------------------------------------------------ runner

export interface SameTrainSearchRequest {
  sessionId: string; turnId: string | null; requestId: string | null; journeyVersion: number | null;
  trainNumber: string; trainName?: string; date: string; travelClass: string; passengersCount: number;
  origin: string; destination: string; originName?: string; destinationName?: string;
  originSweep: boolean; destinationSweep: boolean; destinationExtensionStations?: number; combinedPairs?: 'AUTO' | 'ALWAYS' | 'NEVER';
  /** P42-14: see PlanInput.terminalSweep (default NEVER) */
  terminalSweep?: 'AUTO' | 'NEVER';
  includeFare: boolean; webEvidence: boolean;
  providers: ProviderRef[]; routeProvider: ProviderRef; webProviders: ProviderRef[];
  /** P42.2 (optional, recorded only): why this search ran, the tool execution id and the session selection at call time */
  triggerReason?: ShortageTriggerReason | null; triggerSource?: 'SESSION_EVIDENCE' | 'MUSE' | 'AUTO_DISPLAY' | 'SAFETY_NET' | 'NONE';
  toolExecutionId?: string | null;
  contextSnapshot?: { selectedTrain: string | null; selectedClass: string | null; journeyVersion: number | null; requestedClass?: string | null };
  /**
   * P42.7 all-class matrix: every class to check, from the train's authoritative search row (never invented). The requested
   * class (travelClass) is always checked first; absent → travelClass only (pre-P42.7 behaviour).
   */
  classes?: string[];
  explicitUserRequest?: boolean;
  /**
   * P42.9: backend-controlled per-request fallback (primary provider id → fallback provider), e.g. railcore → railradar.
   * Used ONLY for an eligible fault of that single request (RATE_LIMITED / PROVIDER_UNAVAILABLE / TIMEOUT); never when
   * the fallback provider is already one of `providers` (then it is queried anyway). Muse never chooses it.
   */
  fallbackProviders?: Record<string, ProviderRef>;
  /** P42.9: fallback for the route (timetable) call on an eligible fault of the route provider. */
  routeFallback?: ProviderRef | null;
  /** 2026-10-10 (blocker 5): further route fallbacks after routeFallback, in order (SAME_TRAIN_ROUTE_PROVIDERS); backend-only */
  routeFallbacks?: ProviderRef[];
  /** Phase 2 (findBoardFromEarlier): staged depth — see PlanInput.staged */
  staged?: { earlier: number; ahead: number };
  /** Phase 2: provider probes of THIS search in flight at once (EARLIER_PROBE_CONCURRENCY); still through the F3 queue */
  probeConcurrency?: number;
  /** Phase 2 "better WL": the train's DIRECT status per class from the authoritative search row (class code → status) */
  directStatus?: Record<string, string>;
}

/** P42.7: requested class first, then the other authoritative classes in provider order (deduped, codes only). */
export function matrixClasses(travelClass: string, classes?: string[]): string[] {
  const req = String(travelClass || '').toUpperCase();
  const out = [req];
  for (const c of classes || []) { const k = String(c || '').toUpperCase(); if (/^[A-Z0-9]{1,4}$/.test(k) && !out.includes(k)) out.push(k); }
  return out;
}

export type SameTrainRunOutcome =
  | { ok: true; result: SameTrainAlternativesResult }
  | { ok: false; code: SameTrainErrorCode; message: string; partial?: Partial<SameTrainAlternativesResult>; errorClass?: SameTrainErrorClass;
      /** RailRadar Phase 1: route verification trail for a route-data failure (observability; no railway fact) */
      routeCheck?: SameTrainRouteCheck };

const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12);

export async function runSameTrainSearch(req: SameTrainSearchRequest, deps: SameTrainDeps): Promise<SameTrainRunOutcome> {
  const now = deps.now || Date.now;
  const L = deps.limits;
  const t0 = now();
  const startedAt = new Date(t0).toISOString();
  const deadline = t0 + L.totalTimeoutMs;
  const alternativeSearchId = `sta_${shortId()}`;
  const current = () => (deps.isCurrent ? deps.isCurrent() : true);
  const isMock = [req.routeProvider, ...req.providers, ...Object.values(req.fallbackProviders || {}), ...(req.routeFallback ? [req.routeFallback] : []), ...(req.routeFallbacks || [])].some(p => p.isMock);
  const eligible = (code: string | null | undefined) => !!code && SAME_TRAIN_FALLBACK_ELIGIBLE.has(code);
  // P42.9 observability: per-recovery call counters (no keys / headers / bodies)
  const stats = { requested: 0, executed: 0, successful: 0, rateLimited: 0, rateLimitedAttempts: 0, timeout: 0, providerUnavailable: 0, fallback: 0, fallbackSucceeded: 0, deduped: 0, skipped: 0 };

  // 1) route — from the route provider; P42.9: an eligible fault (rate limit / unavailable / timeout) → the backend
  // fallback route provider (visible in result.route.provider / routeFallbackReason)
  let routeProvider = req.routeProvider;
  let routeFallbackReason: string | undefined;
  const scheduled = !!deps.scheduled;
  const call = <T>(fn: () => Promise<T>, ms: number) => (scheduled ? viaQueue(Promise.resolve().then(fn)) : withTimeout(Promise.resolve().then(fn), ms));
  // F3 progress (counts only — the final verdict is the result below)
  const prog: SameTrainProgress = { stage: 'ROUTE', total: 0, done: 0, succeeded: 0, failed: 0, retried: 0, found: [] };
  const emit = () => { try { deps.onProgress?.({ ...prog, found: [...prog.found] }); } catch { /* progress must never break the search */ } };
  emit();
  let routeResp = await call(() => deps.getRoute(req.routeProvider, req.trainNumber), L.perCallTimeoutMs);
  stats.executed++;
  {
    // 2026-10-10 (blocker 5): routeFallback, then routeFallbacks in order (SAME_TRAIN_ROUTE_PROVIDERS) — each tried only on
    // an eligible fault of the previous one; routeFallbackReason = the PRIMARY's fault. Without routeFallbacks: unchanged.
    const tried = new Set<string>([req.routeProvider.id]);
    for (const fb of [req.routeFallback, ...(req.routeFallbacks || [])]) {
      if (!fb || tried.has(fb.id)) continue;
      const c0 = routeResp.timedOut ? 'PROVIDER_TIMEOUT' : ((routeResp.value as any)?.ok === true ? null : String((routeResp.value as any)?.error?.code || ''));
      if (!(c0 && eligible(c0) && current())) break;
      tried.add(fb.id);
      if (!routeFallbackReason) routeFallbackReason = c0;
      routeProvider = fb; stats.fallback++; stats.executed++;
      routeResp = await call(() => deps.getRoute(fb, req.trainNumber), L.perCallTimeoutMs);
      if (!routeResp.timedOut && (routeResp.value as any)?.ok === true) stats.fallbackSucceeded++;
    }
  }
  if (routeResp.timedOut) return { ok: false, code: E.SEARCH_TIMEOUT, errorClass: SameTrainErrorClass.TOOL_TIMEOUT, message: `${routeProvider.label || routeProvider.id} se route time par nahi aaya.` };
  // F3: the queued route call was dropped before dispatch (journey superseded / search deadline) — never a route verdict
  if ((routeResp.value as any)?.error?.code === SCHED_CANCELLED) {
    return current() ? { ok: false, code: E.SEARCH_TIMEOUT, errorClass: SameTrainErrorClass.TOOL_TIMEOUT, message: `Train ${req.trainNumber} ka route time par check nahi ho paaya.` }
      : { ok: false, code: E.STALE_RESULT, errorClass: SameTrainErrorClass.STALE, message: 'Journey badal gayi — yeh alternative result ab purana hai.' };
  }
  const rv: any = routeResp.value;
  if (!rv || rv.ok !== true) {
    const code = String(rv?.error?.code || '');
    // F2: keep the real failure reason — a rate limit (provider 429 or the local pacer refusing before any request) or a
    // provider outage is NOT a route verdict; INVALID_TRAIN_ROUTE only when the provider answered without a usable route
    if (TIMEOUT_CODES.has(code)) return { ok: false, code: E.SEARCH_TIMEOUT, errorClass: SameTrainErrorClass.TOOL_TIMEOUT, message: `Train ${req.trainNumber} ka route ${routeProvider.label || routeProvider.id} se verify nahi ho paaya.` };
    if (code === 'RATE_LIMITED' || code === 'PROVIDER_UNAVAILABLE') {
      return { ok: false, code: code === 'RATE_LIMITED' ? E.RATE_LIMITED : E.PROVIDER_UNAVAILABLE, errorClass: SameTrainErrorClass.PROVIDER_UNAVAILABLE,
        message: `${routeProvider.label || routeProvider.id} abhi busy / unavailable hai — train ${req.trainNumber} ka route nahi mil paaya.` };
    }
    if (ROUTE_VERDICT_CODES.has(code)) return { ok: false, code: E.INVALID_TRAIN_ROUTE, errorClass: SameTrainErrorClass.INVALID_TRAIN_ROUTE, message: `Train ${req.trainNumber} ka route ${routeProvider.label || routeProvider.id} se verify nahi ho paaya.` };
    // any other fault (auth / not configured / unsupported / unknown) is a failed search — never a route verdict
    return { ok: false, code: E.SEARCH_FAILED, errorClass: SameTrainErrorClass.PROVIDER_UNAVAILABLE, message: `Train ${req.trainNumber} ka route ${routeProvider.label || routeProvider.id} se nahi mil paaya.` };
  }
  const route = normalizeRoute(rv.data);
  if (!route.ok) return { ok: false, code: route.code, message: route.message, errorClass: SameTrainErrorClass.INVALID_TRAIN_ROUTE };
  let planned = planCandidates(route.stations, route.duplicates, req, L);
  // RailRadar Phase 1: verification label (provider DATA only). Primary route verified the pair → no secondary call.
  let verification: SameTrainRouteVerification | undefined = routeProvider.id === req.routeProvider.id ? 'VERIFIED_BY_RAILCORE' : 'ROUTE_VERIFIED_BY_RAILRADAR';
  let primaryRouteResult: SameTrainRouteCheck['primaryResult'];
  if (!planned.ok && planned.code === E.INVALID_STATION_PAIR) {
    // P42-13: INVALID_STATION_PAIR stays the deterministic code; its class marks a route-DATA limitation (never a railway fact)
    const o = String(req.origin || '').toUpperCase(), d = String(req.destination || '').toUpperCase();
    primaryRouteResult = route.stations.some(s => s.code === o) && route.stations.some(s => s.code === d) ? 'ORDER_NOT_VERIFIED' : 'STATION_MISSING';
    const firstFailure = planned;
    const check: SameTrainRouteCheck = { verdict: 'ROUTE_UNVERIFIED', primaryProvider: routeProvider.id, primaryResult: primaryRouteResult };
    const unverified = (result: string, suffix = '') => ({ ok: false as const, code: firstFailure.code, message: firstFailure.message + suffix,
      errorClass: SameTrainErrorClass.ROUTE_DATA_UNVERIFIED, routeCheck: { ...check, crossCheckResult: result } });
    // cross-check ONLY when: enabled, the route came from the PRIMARY route provider (not already the P42.9 fallback),
    // a distinct secondary route provider is configured, and the request is still current. Route data only — no
    // search / availability / fare / live call is made here.
    const cross = req.routeFallback && req.routeFallback.id !== req.routeProvider.id ? req.routeFallback : null;
    if (L.routeCrossCheck === false) return unverified('DISABLED');
    if (!cross) return unverified('NOT_CONFIGURED');
    if (routeFallbackReason) return unverified('ALREADY_SECONDARY');
    if (!current()) return { ok: false, code: E.STALE_RESULT, errorClass: SameTrainErrorClass.STALE, message: 'Journey badal gayi — yeh alternative result ab purana hai.' };
    check.crossCheckProvider = cross.id;
    const crossLabel = cross.label || cross.id;
    stats.executed++;
    const cr = await call(() => deps.getRoute(cross, req.trainNumber), L.perCallTimeoutMs);
    if (cr.timedOut) { stats.timeout++; return unverified('TIMEOUT', ` ${crossLabel} se route cross-check time par nahi aaya.`); }
    const cv: any = cr.value;
    if (!cv || cv.ok !== true) return unverified(String(cv?.error?.code || 'ERROR'), ` ${crossLabel} se route cross-check nahi ho paaya.`);
    const r2 = normalizeRoute(cv.data);
    if (!r2.ok) return unverified('ROUTE_INVALID', ` ${crossLabel} ka route data bhi is pair ko verify nahi kar paaya.`);
    const v = crossCheckRoute(route.stations, route.duplicates, r2.stations, r2.duplicates, o, d);
    if (v.verdict === 'CONFLICT') {
      return { ok: false, code: firstFailure.code, errorClass: SameTrainErrorClass.ROUTE_DATA_CONFLICT,
        message: `${routeProvider.label || routeProvider.id} aur ${crossLabel} ka route data is train ke stations ke order par match nahi karta, isliye ${o} → ${d} verify nahi ho paaya.`,
        routeCheck: { ...check, verdict: 'ROUTE_DATA_CONFLICT', crossCheckResult: v.reason } };
    }
    if (v.verdict === 'UNVERIFIED') return unverified(v.reason, ` ${crossLabel} ka route data bhi is pair ko verify nahi kar paaya.`);
    const planned2 = planCandidates(r2.stations, r2.duplicates, req, L);
    if (!planned2.ok) return unverified(planned2.code, ` ${crossLabel} ka route data bhi is pair ko verify nahi kar paaya.`);
    // ROUTE_VERIFIED_BY_RAILRADAR — the existing same-train logic continues on the secondary route; every availability /
    // fare fact still comes from the unchanged provider calls below (RailCore primary, P42.9 fallback rules untouched)
    planned = planned2; routeProvider = cross; verification = 'ROUTE_VERIFIED_BY_RAILRADAR';
  }
  if (!planned.ok) return { ok: false, code: planned.code, message: planned.message, ...(planned.code === E.INVALID_STATION_PAIR ? { errorClass: SameTrainErrorClass.ROUTE_DATA_UNVERIFIED } : {}) };
  const plan = planned.plan;
  const routeFetchedAt = new Date(now()).toISOString();
  // 2026-10-09: every pair is checked on ITS ticket date (same run as the requested boarding) — never the journey date blindly
  const ticketDate = (p: CandidatePair) => ticketDateFor(plan.route, p.originIndex, plan.originIndex, req.date);

  // 2) fresh provider calls per candidate × provider (bounded per provider)
  // P42.7: evidence is keyed per (pair × class); the requested class is searched over the whole window first, then the other
  // authoritative classes in route order — deterministic SEARCH order bounded by maxAvailabilityChecks (never a ranking)
  const classes = matrixClasses(req.travelClass, req.classes);
  const requestedClass = classes[0];
  const evidenceByPair = new Map<string, ProviderEvidence[]>();
  const ek = (pairId: string, cls: string) => `${pairId}|${cls}`;
  const checkCap = Math.max(1, L.maxAvailabilityChecks ?? Number.MAX_SAFE_INTEGER);
  let checksUsed = 0;
  let checksTruncated = false;
  const checkedUnits: { pair: CandidatePair; cls: string }[] = [];
  let skippedStale = false;
  const inflight = new Map<string, Promise<{ timedOut: true } | { timedOut: false; value: any }>>();
  const runPhase = async (pairs: CandidatePair[]) => {
    const units: { pair: CandidatePair; cls: string }[] = [];
    for (const cls of classes) for (const pair of pairs) {
      // the requested station pair is only meaningful for the requested class (other classes' direct status is the search row)
      if (pair.priority === 'P0' && cls !== requestedClass) continue;
      units.push({ pair, cls });
    }
    const room = Math.max(0, checkCap - checksUsed);
    if (units.length > room) checksTruncated = true;
    const run = units.slice(0, room);
    checksUsed += run.length;
    checkedUnits.push(...run);
    stats.requested += run.length * req.providers.length;
    prog.stage = 'CHECKING'; prog.total += run.length * req.providers.length; emit();
    // F3: scheduled → every unit is handed to the fair queue at once, in station order (the queue paces / orders them)
    const pc = Number(req.probeConcurrency) > 0 ? Math.floor(Number(req.probeConcurrency)) : 0;
    const pool = scheduled ? Math.max(1, pc ? Math.min(pc, run.length) : run.length) : (pc ? Math.min(pc, L.maxParallel) : L.maxParallel);
    await Promise.all(req.providers.map(provider => mapLimit(run.map((u, i) => ({ ...u, i })), pool, async ({ pair, cls, i }) => {
      const td = ticketDate(pair);
      const q: AvailabilityQuery = { trainNumber: req.trainNumber, travelClass: cls, date: td ? td.date : req.date, origin: pair.ticketOrigin, destination: pair.ticketDestination, passengersCount: req.passengersCount };
      const baseFor = (prov: ProviderRef) => ({ provider: prov.id, ...(prov.label ? { providerLabel: prov.label } : {}), level: prov.level,
        requestId: req.requestId || alternativeSearchId, toolExecutionId: `${alternativeSearchId}:${prov.id}:${pair.pairId}`,
        trainNumber: q.trainNumber, ticketOrigin: q.origin, ticketDestination: q.destination, travelClass: q.travelClass, date: q.date, passengersCount: q.passengersCount,
        batchNumber: Math.floor(i / Math.max(1, L.maxParallel)) + 1 });
      // P42.9: one provider attempt; identical requests inside THIS execution share one call (dedupe — never a cache)
      const attempt = async (prov: ProviderRef) => {
        const s1 = now();
        const dk = [prov.id, q.trainNumber, q.travelClass, q.origin, q.destination, q.date].join('|');
        let pr = inflight.get(dk);
        if (pr) stats.deduped++;
        else {
          pr = scheduled ? viaQueue(Promise.resolve().then(() => deps.checkAvailability(prov, q, { deadline })))
            : withTimeout(Promise.resolve().then(() => deps.checkAvailability(prov, q)), Math.min(L.perCallTimeoutMs, Math.max(1, deadline - s1)));
          inflight.set(dk, pr); stats.executed++;
        }
        const r = await pr;
        const at = now();
        const sched: any = r.timedOut ? undefined : (r.value as any)?.meta?.scheduler;
        // F3: a queued call dropped before dispatch spent no provider request → SKIPPED (stale / search deadline), never a verdict
        if (sched?.cancelled) {
          const stale = !current();
          if (stale) skippedStale = true;
          return { evald: { outcome: 'SKIPPED' as const, errorCode: stale ? E.RESULT_STALE : E.SEARCH_TIMEOUT }, at, latencyMs: at - s1, rateLimitLocal: undefined, retries: 0, cancelled: true };
        }
        const evald = r.timedOut ? { outcome: 'TIMEOUT' as const, errorCode: 'PROVIDER_TIMEOUT' } : evaluateAvailabilityAnswer(r.value, q, { maxSnapshotAgeMs: L.maxSnapshotAgeMs, nowMs: Date.now() });
        if (evald.errorCode === 'RATE_LIMITED') stats.rateLimitedAttempts++;
        const retries = Number(sched?.retries) || 0;
        if (retries) { prog.retried += retries; }
        return { evald, at, latencyMs: at - s1, rateLimitLocal: r.timedOut ? undefined : (r.value as any)?.meta?.rateLimit?.local, retries,
          ...(sched?.refused ? { refused: String(sched.refused) } : {}) };
      };
      const s = now();
      let ev: ProviderEvidence;
      if (!current()) { skippedStale = true; stats.skipped++; ev = { ...baseFor(provider), fetchedAt: new Date(s).toISOString(), latencyMs: 0, outcome: 'SKIPPED', errorCode: E.RESULT_STALE }; }
      // 2026-10-09: the timetable has no day for this earlier station → its ticket date is unknown → not checked (never a verdict)
      else if (!td) { stats.skipped++; ev = { ...baseFor(provider), fetchedAt: new Date(s).toISOString(), latencyMs: 0, outcome: 'SKIPPED', errorCode: E.TICKET_DATE_UNVERIFIED }; }
      else if (s >= deadline) { stats.skipped++; ev = { ...baseFor(provider), fetchedAt: new Date(s).toISOString(), latencyMs: 0, outcome: 'SKIPPED', errorCode: E.SEARCH_TIMEOUT }; }
      else {
        let served = provider;
        let a = await attempt(provider);
        let fb: { reason: string; primary: string; primaryLatencyMs: number } | undefined;
        // P42.9: per-request fallback ONLY for an eligible fault; never for a REJECTED / identity-mismatch / not-found answer.
        // 2026-10-09: fallbackProviders may be linked (RailKit → RailCore → RailRadar): each next hop only after the previous
        // provider also failed with an eligible fault; a provider is never visited twice.
        const visited = new Set<string>([provider.id]);
        for (let fbProv = req.fallbackProviders?.[provider.id]; fbProv; fbProv = req.fallbackProviders?.[served.id]) {
          if (visited.has(fbProv.id) || req.providers.some(p => p.id === fbProv!.id) || a.evald.outcome === 'SUCCESS'
            || !eligible(a.evald.errorCode) || (a as any).cancelled || !current() || now() >= deadline) break;
          if (!fb) { fb = { reason: String(a.evald.errorCode), primary: provider.id, primaryLatencyMs: a.latencyMs }; stats.fallback++; }
          visited.add(fbProv.id);
          a = await attempt(fbProv);
          served = fbProv;
          if (a.evald.outcome === 'SUCCESS') stats.fallbackSucceeded++;
        }
        ev = { ...baseFor(served), fetchedAt: new Date(a.at).toISOString(), latencyMs: now() - s, ...a.evald,
          ...(a.evald.errorCode === 'RATE_LIMITED' ? { rateLimited: true, ...(a.rateLimitLocal !== undefined ? { rateLimitLocal: !!a.rateLimitLocal } : {}) } : {}),
          retryCount: (a as any).retries || 0,
          ...((a as any).refused ? { rateLimitReason: (a as any).refused } : {}),
          ...(fb ? { fallbackUsed: true, fallbackReason: fb.reason, primaryProvider: fb.primary, primaryErrorCode: fb.reason } : {}) };
        if (req.includeFare && deps.getFare && ev.outcome === 'SUCCESS' && current() && now() < deadline) {
          stats.executed++;
          const fr = await withTimeout(Promise.resolve().then(() => deps.getFare!(served, q)), Math.min(L.perCallTimeoutMs, Math.max(1, deadline - now())));
          const fa = fr.timedOut ? { ok: false as const, code: 'PROVIDER_TIMEOUT', timeout: true } : evaluateFareAnswer(fr.value, q);
          if (fa.ok) { ev.fare = { ...(fa.total !== undefined ? { total: fa.total } : {}), ...(fa.perPassenger !== undefined ? { perPassenger: fa.perPassenger } : {}), currency: fa.currency, fetchedAt: new Date(now()).toISOString() }; ev.fareOutcome = 'SUCCESS'; }
          else ev.fareOutcome = fa.timeout ? 'TIMEOUT' : 'FAILED';
        }
      }
      if (ev.outcome === 'SUCCESS') stats.successful++;
      else if (ev.errorCode === 'RATE_LIMITED') stats.rateLimited++;
      else if (ev.outcome === 'TIMEOUT') stats.timeout++;
      else if (ev.errorCode === 'PROVIDER_UNAVAILABLE') stats.providerUnavailable++;
      const list = evidenceByPair.get(ek(pair.pairId, cls)) || [];
      list.push(ev);
      evidenceByPair.set(ek(pair.pairId, cls), list);
      // F3 progress: one finished unit; an interim seat (whole party AVAILABLE / RAC, not the requested pair) is listed
      // as FOUND-SO-FAR only — the final verdict (merge + rules) comes with the result
      prog.done++;
      if (ev.outcome === 'SUCCESS') {
        prog.succeeded++;
        const av = ev.availability;
        if (av && pair.priority !== 'P0' && (av.category === 'RAC' || (av.category === 'AVAILABLE' && evaluateSeatShortage({ status: av.status, requestedPassengerCount: req.passengersCount }).sufficiency !== 'INSUFFICIENT'))) {
          prog.found.push({ ticketOrigin: q.origin, ticketDestination: q.destination, travelClass: q.travelClass, status: String(av.status) });
        }
      } else prog.failed++;
      emit();
    })));
  };
  await runPhase(plan.phase1);
  const policy = req.combinedPairs || 'AUTO';
  // P42.2: an AVAILABLE pair with fewer seats than passengers is not "good" (combined pairs may still help the party)
  // P42.7: judged on the REQUESTED class only (another class being available never decides the requested-class search)
  const goodCategory = (pairs: CandidatePair[]) => pairs.some(p => (evidenceByPair.get(ek(p.pairId, requestedClass)) || []).some(e => e.level === 'PROVIDER_API' && e.outcome === 'SUCCESS'
    && (e.availability?.category === 'RAC' || (e.availability?.category === 'AVAILABLE' && evaluateSeatShortage({ status: e.availability.status, requestedPassengerCount: req.passengersCount }).sufficiency !== 'INSUFFICIENT'))));
  const runCombined = plan.phase2.length > 0 && (policy === 'ALWAYS' || (policy === 'AUTO' && !goodCategory(plan.phase1)));
  if (runCombined) await runPhase(plan.phase2);
  // P42-14: nothing bookable (AVAILABLE for the whole party / RAC) in ANY searched class inside the bounded window → continue
  // the destination over the rest of the route up to the train's terminal (same classes, same providers, same check cap)
  const goodAnyClass = (pairs: CandidatePair[]) => classes.some(c => pairs.some(p => (evidenceByPair.get(ek(p.pairId, c)) || []).some(e => e.level === 'PROVIDER_API' && e.outcome === 'SUCCESS'
    && (e.availability?.category === 'RAC' || (e.availability?.category === 'AVAILABLE' && evaluateSeatShortage({ status: e.availability.status, requestedPassengerCount: req.passengersCount }).sufficiency !== 'INSUFFICIENT')))));
  // Phase 2 staged depth: stage A found nothing bookable → B1 (rest of the earlier stops up to the origin)
  const stageAPairs = [...plan.phase1, ...(runCombined ? plan.phase2 : [])];
  const runStageB = plan.stageB.length > 0 && !goodAnyClass(stageAPairs) && current() && now() < deadline;
  if (runStageB) await runPhase(plan.stageB);
  const windowPairs = [...stageAPairs, ...(runStageB ? plan.stageB : [])];
  const runTerminal = plan.phase3.length > 0 && !goodAnyClass(windowPairs) && current() && now() < deadline;
  if (runTerminal) await runPhase(plan.phase3);
  const pairs = [...windowPairs, ...(runTerminal ? plan.phase3 : [])];
  prog.stage = 'FINALIZING'; emit();

  // 3) optional public-web route evidence (UNVERIFIED_WEB — never availability, never authoritative)
  const errors: SameTrainErrorCode[] = [];
  const webByPair = new Map<string, WebRouteEvidence[]>();
  let webEvidence: SameTrainAlternativesResult['webEvidence'] = 'NOT_REQUESTED';
  if (req.webEvidence) {
    if (!req.webProviders.length || !deps.webListsTrain) { webEvidence = 'UNAVAILABLE'; errors.push(E.WEB_EVIDENCE_UNAVAILABLE); }
    else {
      webEvidence = 'COLLECTED';
      const targets = pairs.filter(p => p.priority !== 'P0').slice(0, L.maxWebChecks);
      for (const wp of req.webProviders) {
        await mapLimit(targets, Math.min(3, L.maxParallel), async p => {
          if (!current() || now() >= deadline) return;
          const r = await withTimeout(Promise.resolve().then(() => deps.webListsTrain!(wp, { trainNumber: req.trainNumber, origin: p.ticketOrigin, destination: p.ticketDestination, date: ticketDate(p)?.date ?? req.date })), L.perCallTimeoutMs);
          const at = new Date(now()).toISOString();
          const w: WebRouteEvidence = r.timedOut ? { provider: wp.id, level: 'UNVERIFIED_WEB', ticketOrigin: p.ticketOrigin, ticketDestination: p.ticketDestination, listed: null, fetchedAt: at, errorCode: 'PROVIDER_TIMEOUT' }
            : (r.value as any).ok ? { provider: wp.id, level: 'UNVERIFIED_WEB', ticketOrigin: p.ticketOrigin, ticketDestination: p.ticketDestination, listed: !!(r.value as any).listed, fetchedAt: at }
            : { provider: wp.id, level: 'UNVERIFIED_WEB', ticketOrigin: p.ticketOrigin, ticketDestination: p.ticketDestination, listed: null, fetchedAt: at, errorCode: String((r.value as any).code || 'WEB_ERROR') };
          webByPair.set(p.pairId, [...(webByPair.get(p.pairId) || []), w]);
        });
      }
      if (![...webByPair.values()].flat().some(w => w.listed !== null)) { webEvidence = 'UNAVAILABLE'; errors.push(E.WEB_EVIDENCE_UNAVAILABLE); }
    }
  }

  // 4) rules + merge (dedup by train + origin + destination + class + date)
  const names = new Map<string, string | undefined>(plan.route.map(s => [s.code, s.name]));
  const destIdx = plan.destinationIndex;
  const ctx: MergeContext = { trainNumber: req.trainNumber, trainName: req.trainName, date: req.date, travelClass: requestedClass, passengersCount: req.passengersCount,
    requestedOrigin: plan.route[plan.originIndex].code, requestedDestination: plan.route[destIdx].code, names, includeFare: req.includeFare };
  const ruleOf = async (kind: 'BOARDING' | 'ALIGHTING', ticketStation: string, travelStation: string, travelClass: string): Promise<RuleStatus> => {
    if (ticketStation === travelStation) return 'NOT_REQUIRED';
    if (!deps.ruleEvidence) return 'UNVERIFIED';
    try { return (await deps.ruleEvidence({ kind, trainNumber: req.trainNumber, ticketStation, travelStation, travelClass })) === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED'; }
    catch { return 'UNVERIFIED'; }
  };
  const merged = new Map<string, Omit<SameTrainAlternative, 'alternativeId'>>();
  const fetchedAt = new Date(now()).toISOString();
  // one alternative per (pair × class) that was actually checked — each carries its OWN travelClass (dedup: train + pair + class + date)
  for (const { pair: p, cls } of checkedUnits) {
    const td = ticketDate(p);
    const key = [req.trainNumber, p.ticketOrigin, p.ticketDestination, cls, td?.date ?? req.date].join('|');
    const prev = merged.get(key);
    const ev = [...(prev?.evidence || []), ...(evidenceByPair.get(ek(p.pairId, cls)) || [])];
    const rules = { boarding: await ruleOf('BOARDING', p.ticketOrigin, ctx.requestedOrigin, cls), alighting: await ruleOf('ALIGHTING', p.ticketDestination, ctx.requestedDestination, cls) };
    const m = mergeCandidate(p, ev, webByPair.get(p.pairId) || [], rules, { ...ctx, travelClass: cls, date: td?.date ?? req.date }, fetchedAt);
    m.extensionStations = Math.max(0, p.destinationIndex - destIdx);
    // Phase 2 output fields: ticket from / travel from + route distance from the requested pair
    m.bookFrom = p.ticketOrigin; m.boardAt = ctx.requestedOrigin;
    m.stopsBefore = Math.max(0, plan.originIndex - p.originIndex); m.stopsAfter = Math.max(0, p.destinationIndex - destIdx);
    // 2026-10-09: the ticket is dated for the earlier station's departure on the same run (shown + used for booking)
    if (td?.dayUnknown && !m.warnings.includes(E.TICKET_DATE_UNVERIFIED)) { m.warnings.push(E.TICKET_DATE_UNVERIFIED); m.ticketDateUnverified = true; }
    if (td && td.shiftDays !== 0) {
      m.ticketDateShiftDays = td.shiftDays; m.journeyDate = req.date;
      const dep = plan.route[p.originIndex]?.departure;
      if (dep) m.ticketOriginDeparture = String(dep).slice(0, 8);
    }
    merged.set(key, m);
  }
  const all = [...merged.values()];
  const classPos = (c: string) => { const i = classes.indexOf(c); return i < 0 ? classes.length : i; };
  // neutral order: requested pair, then candidate kind + route order, then the class order of the train row (requested first)
  const visible = all.filter(a => a.verificationStatus !== 'INVALID')
    .sort((a, b) => Number(b.isRequestedPair) - Number(a.isRequestedPair) || a.priority.localeCompare(b.priority) || routePos(plan, a) - routePos(plan, b) || classPos(a.travelClass) - classPos(b.travelClass));
  const alternatives: SameTrainAlternative[] = visible.map((a, i) => ({ alternativeId: `A${i + 1}`, ...a }));

  // 5) provider coverage + overall status
  const allEv = [...evidenceByPair.values()].flat();
  const usedFallbacks = Object.values(req.fallbackProviders || {}).filter((p, i, a) => a.findIndex(x => x.id === p.id) === i && !req.providers.some(x => x.id === p.id) && allEv.some(e => e.provider === p.id));
  const providers = [...req.providers, ...usedFallbacks].map(p => {
    const mine = allEv.filter(e => e.provider === p.id);
    return { provider: p.id, ...(p.label ? { label: p.label } : {}), level: p.level, requested: mine.length,
      succeeded: mine.filter(e => e.outcome === 'SUCCESS').length, failed: mine.filter(e => e.outcome === 'FAILED' || e.outcome === 'REJECTED').length,
      timeouts: mine.filter(e => e.outcome === 'TIMEOUT' || (e.outcome === 'SKIPPED' && e.errorCode === E.SEARCH_TIMEOUT)).length };
  });
  const apiEv = allEv.filter(e => e.level === 'PROVIDER_API');
  // 2026-10-09: checks answered with a too-old provider snapshot — reported as "not confirmed", never as a verdict
  const staleChecks = apiEv.filter(e => e.errorCode === E.STALE_PROVIDER_DATA && e.staleSnapshot).map(e => ({ provider: e.provider,
    ticketOrigin: e.ticketOrigin, ticketDestination: e.ticketDestination, travelClass: e.travelClass,
    status: e.staleSnapshot!.status, providerUpdatedAt: e.staleSnapshot!.providerUpdatedAt, ageMinutes: e.staleSnapshot!.ageMinutes }));
  const anySuccess = apiEv.some(e => e.outcome === 'SUCCESS');
  const completedAt = new Date(now()).toISOString();
  const latencyMs = now() - t0;
  // Phase 2 staged: count what was actually searched (stage B may not have run); unstaged = the pre-Phase-2 numbers
  const earlierStationsChecked = req.staged ? new Set(pairs.filter(p => p.priority === 'P1').map(p => p.ticketOrigin)).size : plan.originAlternatives.length;
  const terminalChecked = runTerminal ? plan.phase3.length : 0;
  const downstreamStationsChecked = plan.destinationExtension.length + terminalChecked;
  const partialRun = apiEv.some(e => e.outcome !== 'SUCCESS');
  const callStats = { ...stats, partial: partialRun };
  deps.log?.('same_train_search', { alternativeSearchId, providers: req.providers.map(p => p.id).join(','), candidateCount: pairs.length,
    resultCount: alternatives.length, succeeded: apiEv.filter(e => e.outcome === 'SUCCESS').length, timeouts: apiEv.filter(e => e.outcome === 'TIMEOUT').length, latencyMs });
  // P42.9: recovery-level counters travel on the result (callStats) and are logged by the service (same_train_recovery)
  if (skippedStale || !current()) return { ok: false, code: E.STALE_RESULT, errorClass: SameTrainErrorClass.STALE, message: 'Journey badal gayi — yeh alternative result ab purana hai.' };
  if (!anySuccess) {
    const allTimeout = apiEv.length > 0 && apiEv.every(e => e.outcome === 'TIMEOUT' || (e.outcome === 'SKIPPED' && e.errorCode === E.SEARCH_TIMEOUT));
    // P42.2: typed error class — a timeout is TOOL_TIMEOUT (never NOT_AVAILABLE); only-malformed answers are INVALID_TOOL_RESULT
    const allInvalid = apiEv.length > 0 && apiEv.every(e => e.outcome === 'REJECTED');
    return { ok: false, code: allTimeout ? E.SEARCH_TIMEOUT : E.SEARCH_FAILED, message: SAME_TRAIN_ALL_FAILED_MESSAGE,
      errorClass: allTimeout ? SameTrainErrorClass.TOOL_TIMEOUT : allInvalid ? SameTrainErrorClass.INVALID_TOOL_RESULT : SameTrainErrorClass.PROVIDER_UNAVAILABLE,
      partial: { callStats, ...(staleChecks.length ? { staleChecks } : {}) } as any };
  }
  const anyFailure = apiEv.some(e => e.outcome !== 'SUCCESS');
  if (anyFailure && apiEv.some(e => e.outcome === 'TIMEOUT' || (e.outcome === 'SKIPPED' && e.errorCode === E.SEARCH_TIMEOUT))) errors.push(E.SEARCH_TIMEOUT);
  if (alternatives.some(a => a.verificationStatus === 'CONFLICTING')) errors.push(E.PROVIDER_DATA_CONFLICT);
  if (staleChecks.length) errors.push(E.STALE_PROVIDER_DATA);
  if (apiEv.some(e => e.outcome === 'SKIPPED' && e.errorCode === E.TICKET_DATE_UNVERIFIED)) errors.push(E.TICKET_DATE_UNVERIFIED);
  // P42.2: a verified alternative needs seats for the WHOLE party (AVAILABLE count ≥ passengers) or RAC
  const verifiedAlternativeCount = alternatives.filter(isVerifiedSameTrainAlternative).length;
  const foundAlternative = verifiedAlternativeCount > 0;
  // Phase 2: better WL only when nothing bookable was found and the request carries the direct status (findBoardFromEarlier)
  const betterWaitlistCount = !foundAlternative && req.directStatus ? markBetterWaitlist(alternatives, req.directStatus) : 0;
  if (!foundAlternative) errors.push(E.NOT_FOUND);
  const p0 = alternatives.find(a => a.isRequestedPair && a.travelClass === requestedClass);
  const requestedPairAssessment = p0 ? evaluateSeatShortage({ status: p0.availability === 'CONFLICTING' ? undefined : p0.availabilityStatusText, requestedPassengerCount: req.passengersCount }) : null;
  const journeyKey = sameTrainJourneyKeyString({ trainNumber: req.trainNumber, date: req.date, travelClass: requestedClass, origin: ctx.requestedOrigin, destination: ctx.requestedDestination, passengersCount: req.passengersCount });
  const result: SameTrainAlternativesResult = {
    kind: 'SAME_TRAIN_ALTERNATIVES', alternativeSearchId, resultSetId: `sts_${shortId()}`,
    sessionId: req.sessionId, turnId: req.turnId, requestId: req.requestId, journeyVersion: req.journeyVersion, journeyKey,
    trainNumber: req.trainNumber, ...(req.trainName ? { trainName: req.trainName } : {}), date: req.date, travelClass: requestedClass, passengersCount: req.passengersCount,
    requestedOrigin: ctx.requestedOrigin, requestedOriginName: req.originName || names.get(ctx.requestedOrigin),
    requestedDestination: ctx.requestedDestination, requestedDestinationName: req.destinationName || names.get(ctx.requestedDestination),
    route: { provider: routeProvider.id, ...(routeFallbackReason ? { fallbackUsed: true, fallbackReason: routeFallbackReason } : {}), fetchedAt: routeFetchedAt, trainOrigin: plan.route[0].code, trainTerminal: plan.route[plan.route.length - 1].code,
      stationCount: plan.route.length, originSweep: plan.originAlternatives.map(s => s.code), destinationExtension: plan.destinationExtension.map(s => s.code),
      destinationSweep: plan.destinationSweep,
      ...(runTerminal ? { terminalSweep: plan.phase3.map(p => p.ticketDestination) } : {}),
      verification, verifiedBy: routeProvider.id,
      ...(primaryRouteResult ? { primaryRouteProvider: req.routeProvider.id, primaryRouteResult } : {}),
      stations: plan.route.slice(Math.max(0, (plan.originAlternatives[0]?.index ?? plan.originIndex)), (runTerminal ? plan.phase3[plan.phase3.length - 1].destinationIndex : plan.destinationExtension[plan.destinationExtension.length - 1]?.index ?? plan.destinationIndex) + 1) },
    providers, candidateCount: pairs.length, candidatesTruncated: plan.truncated,
    alternatives, invalidCount: all.length - visible.length,
    status: anyFailure ? 'PARTIAL' : foundAlternative ? 'OK' : 'NOT_FOUND',
    errors: [...new Set(errors)], webEvidence,
    presentation: { bestMatchId: null, order: alternatives.map(a => a.alternativeId), decidedBy: 'NONE' },
    fresh: true, cached: false, startedAt, completedAt, latencyMs, isMock,
    requestedPassengerCount: req.passengersCount,
    triggerReason: req.triggerReason ?? null, triggerSource: req.triggerSource ?? 'NONE',
    requestedPairAssessment,
    outcome: foundAlternative ? SameTrainOutcome.FOUND : SameTrainOutcome.NONE,
    verifiedAlternativeCount,
    ...(betterWaitlistCount ? { betterWaitlistCount } : {}),
    searchComplete: !plan.truncated && !anyFailure && !checksTruncated,
    // F3: honest check summary for the screen (counts of real outcomes; skipped = never sent, e.g. search deadline)
    checkSummary: { total: apiEv.length, succeeded: apiEv.filter(e => e.outcome === 'SUCCESS').length,
      failed: apiEv.filter(e => e.outcome !== 'SUCCESS' && e.outcome !== 'SKIPPED').length, skipped: apiEv.filter(e => e.outcome === 'SKIPPED').length,
      retried: apiEv.reduce((n, e) => n + (Number((e as any).retryCount) || 0), 0), paced: scheduled, stale: staleChecks.length },
    ...(staleChecks.length ? { staleChecks } : {}),
    classesChecked: classes, earlierStationsChecked, downstreamStationsChecked, availabilityChecks: checksUsed, checksTruncated,
    ...(req.explicitUserRequest ? { explicitUserRequest: true } : {}),
    toolExecutionId: req.toolExecutionId ?? null,
    callStats,
    ...(req.contextSnapshot ? { contextSnapshot: req.contextSnapshot } : {})
  };
  return { ok: true, result };
}

function routePos(plan: CandidatePlan, a: { ticketOrigin: string; ticketDestination: string }): number {
  // neutral route order: earlier ticket origin first, then nearer ticket destination
  const oi = plan.route.findIndex(s => s.code === a.ticketOrigin);
  const di = plan.route.findIndex(s => s.code === a.ticketDestination);
  return oi * 1000 + di;
}
