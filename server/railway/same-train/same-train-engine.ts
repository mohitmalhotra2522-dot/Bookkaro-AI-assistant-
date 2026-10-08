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
  sameTrainJourneyKeyString
} from '@shared/same-train-alternatives';
import {
  type ShortageTriggerReason, evaluateSeatShortage, normalizeAvailabilityState, isVerifiedSameTrainAlternative, SameTrainOutcome, SameTrainErrorClass
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
    maxAvailabilityChecks: envNum(env, 'SAME_TRAIN_MAX_AVAILABILITY_CHECKS', D.maxAvailabilityChecks ?? 120, 1, MAX_AVAILABILITY_CHECKS)
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
    const n = Number.isFinite(raw) && raw > 0 ? Math.min(DESTINATION_EXTENSION_MAX, Math.max(DESTINATION_EXTENSION_MIN, Math.round(raw))) : Math.min(DESTINATION_EXTENSION_MAX, limits.maxDestinationSweep);
    destinationExtension = stations.slice(di + 1, Math.min(terminal, di + n) + 1).filter(s => !duplicates.has(s.code));
  }

  const nearestOrigins = [...originAlternatives].sort((a, b) => b.index - a.index);       // closest to the requested origin first
  const nearestDests = [...destinationExtension].sort((a, b) => a.index - b.index);       // closest to the requested destination first
  const all: CandidatePair[] = [pairOf(stations, oi, di, 'P0')];
  for (const s of nearestOrigins) all.push(pairOf(stations, s.index, di, 'P1'));
  for (const s of nearestDests) all.push(pairOf(stations, oi, s.index, 'P2'));
  const combined: CandidatePair[] = [];
  if (input.combinedPairs !== 'NEVER') {
    for (const so of nearestOrigins) for (const sd of nearestDests) combined.push(pairOf(stations, so.index, sd.index, 'P3'));
    combined.sort((a, b) => ((oi - a.originIndex) + (a.destinationIndex - di)) - ((oi - b.originIndex) + (b.destinationIndex - di)) || b.originIndex - a.originIndex);
  }
  const cap = limits.maxCandidatePairs;
  const seen = new Set<string>();
  const phase1 = all.filter(p => !seen.has(p.pairId) && (seen.add(p.pairId), true)).slice(0, cap);
  const phase2 = combined.filter(p => !seen.has(p.pairId) && (seen.add(p.pairId), true)).slice(0, Math.max(0, cap - phase1.length));
  const truncated = all.length > phase1.length || combined.length > phase2.length;
  return { ok: true, plan: { route: stations, originIndex: oi, destinationIndex: di, originAlternatives, destinationExtension, destinationSweep, phase1, phase2, truncated } };
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
  checkAvailability: (provider: ProviderRef, q: AvailabilityQuery) => Promise<any>;
  getFare?: (provider: ProviderRef, q: AvailabilityQuery) => Promise<any>;
  /** public-web listing check (UNVERIFIED_WEB) — does the same train run between this pair? */
  webListsTrain?: (provider: ProviderRef, q: { trainNumber: string; origin: string; destination: string; date: string }) => Promise<{ ok: true; listed: boolean } | { ok: false; code: string }>;
  /** optional boarding / alighting rule evidence source; absent → UNVERIFIED */
  ruleEvidence?: (q: { kind: 'BOARDING' | 'ALIGHTING'; trainNumber: string; ticketStation: string; travelStation: string; travelClass: string }) => Promise<'VERIFIED' | 'UNVERIFIED'>;
  /** false once the journey / turn this search belongs to is superseded → remaining calls are skipped */
  isCurrent?: () => boolean;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
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

/** Validate one provider availability answer against the request binding (no silent substitution). */
export function evaluateAvailabilityAnswer(resp: any, q: AvailabilityQuery): Pick<ProviderEvidence, 'outcome' | 'availability' | 'errorCode' | 'rejectedReason'> {
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
  return { outcome: 'SUCCESS', availability: { category: availabilityCategory(status), status,
    ...(d.statusText ? { statusText: String(d.statusText).slice(0, 80) } : {}), ...(d.quota ? { quota: String(d.quota).slice(0, 8) } : {}),
    ...(d.providerUpdatedAt ? { providerUpdatedAt: String(d.providerUpdatedAt).slice(0, 40) } : {}) } };
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
    evidence, webEvidence: web, warnings,
    ...(conflicting ? { conflict: { providers: ok.map(e => e.provider), values: ok.map(e => ({ provider: e.provider, status: e.availability!.status })) } } : {}),
    extensionStations: 0,   // set by the runner (route index distance past the requested destination)
    fetchedAt
  };
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
  | { ok: false; code: SameTrainErrorCode; message: string; partial?: Partial<SameTrainAlternativesResult>; errorClass?: SameTrainErrorClass };

const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12);

export async function runSameTrainSearch(req: SameTrainSearchRequest, deps: SameTrainDeps): Promise<SameTrainRunOutcome> {
  const now = deps.now || Date.now;
  const L = deps.limits;
  const t0 = now();
  const startedAt = new Date(t0).toISOString();
  const deadline = t0 + L.totalTimeoutMs;
  const alternativeSearchId = `sta_${shortId()}`;
  const current = () => (deps.isCurrent ? deps.isCurrent() : true);
  const isMock = [req.routeProvider, ...req.providers, ...Object.values(req.fallbackProviders || {}), ...(req.routeFallback ? [req.routeFallback] : [])].some(p => p.isMock);
  const eligible = (code: string | null | undefined) => !!code && SAME_TRAIN_FALLBACK_ELIGIBLE.has(code);
  // P42.9 observability: per-recovery call counters (no keys / headers / bodies)
  const stats = { requested: 0, executed: 0, successful: 0, rateLimited: 0, rateLimitedAttempts: 0, timeout: 0, providerUnavailable: 0, fallback: 0, fallbackSucceeded: 0, deduped: 0, skipped: 0 };

  // 1) route — from the route provider; P42.9: an eligible fault (rate limit / unavailable / timeout) → the backend
  // fallback route provider (visible in result.route.provider / routeFallbackReason)
  let routeProvider = req.routeProvider;
  let routeFallbackReason: string | undefined;
  let routeResp = await withTimeout(Promise.resolve().then(() => deps.getRoute(req.routeProvider, req.trainNumber)), L.perCallTimeoutMs);
  stats.executed++;
  {
    const c0 = routeResp.timedOut ? 'PROVIDER_TIMEOUT' : ((routeResp.value as any)?.ok === true ? null : String((routeResp.value as any)?.error?.code || ''));
    if (c0 && eligible(c0) && req.routeFallback && req.routeFallback.id !== req.routeProvider.id && current()) {
      routeFallbackReason = c0; routeProvider = req.routeFallback; stats.fallback++; stats.executed++;
      routeResp = await withTimeout(Promise.resolve().then(() => deps.getRoute(req.routeFallback!, req.trainNumber)), L.perCallTimeoutMs);
      if (!routeResp.timedOut && (routeResp.value as any)?.ok === true) stats.fallbackSucceeded++;
    }
  }
  if (routeResp.timedOut) return { ok: false, code: E.SEARCH_TIMEOUT, errorClass: SameTrainErrorClass.TOOL_TIMEOUT, message: `${routeProvider.label || routeProvider.id} se route time par nahi aaya.` };
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
  const planned = planCandidates(route.stations, route.duplicates, req, L);
  // P42-13: INVALID_STATION_PAIR is kept as the deterministic code; its class marks it as a route-DATA limitation
  // (distinct from INVALID_TRAIN_ROUTE, which stays a genuine unusable-route verdict)
  if (!planned.ok) return { ok: false, code: planned.code, message: planned.message, ...(planned.code === E.INVALID_STATION_PAIR ? { errorClass: SameTrainErrorClass.ROUTE_DATA_UNVERIFIED } : {}) };
  const plan = planned.plan;
  const routeFetchedAt = new Date(now()).toISOString();

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
    await Promise.all(req.providers.map(provider => mapLimit(run.map((u, i) => ({ ...u, i })), L.maxParallel, async ({ pair, cls, i }) => {
      const q: AvailabilityQuery = { trainNumber: req.trainNumber, travelClass: cls, date: req.date, origin: pair.ticketOrigin, destination: pair.ticketDestination, passengersCount: req.passengersCount };
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
        else { pr = withTimeout(Promise.resolve().then(() => deps.checkAvailability(prov, q)), Math.min(L.perCallTimeoutMs, Math.max(1, deadline - s1))); inflight.set(dk, pr); stats.executed++; }
        const r = await pr;
        const at = now();
        const evald = r.timedOut ? { outcome: 'TIMEOUT' as const, errorCode: 'PROVIDER_TIMEOUT' } : evaluateAvailabilityAnswer(r.value, q);
        if (evald.errorCode === 'RATE_LIMITED') stats.rateLimitedAttempts++;
        return { evald, at, latencyMs: at - s1, rateLimitLocal: r.timedOut ? undefined : (r.value as any)?.meta?.rateLimit?.local };
      };
      const s = now();
      let ev: ProviderEvidence;
      if (!current()) { skippedStale = true; stats.skipped++; ev = { ...baseFor(provider), fetchedAt: new Date(s).toISOString(), latencyMs: 0, outcome: 'SKIPPED', errorCode: E.RESULT_STALE }; }
      else if (s >= deadline) { stats.skipped++; ev = { ...baseFor(provider), fetchedAt: new Date(s).toISOString(), latencyMs: 0, outcome: 'SKIPPED', errorCode: E.SEARCH_TIMEOUT }; }
      else {
        let served = provider;
        let a = await attempt(provider);
        let fb: { reason: string; primary: string; primaryLatencyMs: number } | undefined;
        const fbProv = req.fallbackProviders?.[provider.id];
        // P42.9: per-request fallback ONLY for an eligible fault; never for a REJECTED / identity-mismatch / not-found answer
        if (fbProv && fbProv.id !== provider.id && !req.providers.some(p => p.id === fbProv.id) && a.evald.outcome !== 'SUCCESS'
          && eligible(a.evald.errorCode) && current() && now() < deadline) {
          fb = { reason: String(a.evald.errorCode), primary: provider.id, primaryLatencyMs: a.latencyMs };
          stats.fallback++;
          a = await attempt(fbProv);
          served = fbProv;
          if (a.evald.outcome === 'SUCCESS') stats.fallbackSucceeded++;
        }
        ev = { ...baseFor(served), fetchedAt: new Date(a.at).toISOString(), latencyMs: now() - s, ...a.evald,
          ...(a.evald.errorCode === 'RATE_LIMITED' ? { rateLimited: true, ...(a.rateLimitLocal !== undefined ? { rateLimitLocal: !!a.rateLimitLocal } : {}) } : {}),
          retryCount: 0,
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
  const pairs = [...plan.phase1, ...(runCombined ? plan.phase2 : [])];

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
          const r = await withTimeout(Promise.resolve().then(() => deps.webListsTrain!(wp, { trainNumber: req.trainNumber, origin: p.ticketOrigin, destination: p.ticketDestination, date: req.date })), L.perCallTimeoutMs);
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
    const key = [req.trainNumber, p.ticketOrigin, p.ticketDestination, cls, req.date].join('|');
    const prev = merged.get(key);
    const ev = [...(prev?.evidence || []), ...(evidenceByPair.get(ek(p.pairId, cls)) || [])];
    const rules = { boarding: await ruleOf('BOARDING', p.ticketOrigin, ctx.requestedOrigin, cls), alighting: await ruleOf('ALIGHTING', p.ticketDestination, ctx.requestedDestination, cls) };
    const m = mergeCandidate(p, ev, webByPair.get(p.pairId) || [], rules, { ...ctx, travelClass: cls }, fetchedAt);
    m.extensionStations = Math.max(0, p.destinationIndex - destIdx);
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
  const anySuccess = apiEv.some(e => e.outcome === 'SUCCESS');
  const completedAt = new Date(now()).toISOString();
  const latencyMs = now() - t0;
  const earlierStationsChecked = plan.originAlternatives.length;
  const downstreamStationsChecked = plan.destinationExtension.length;
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
      partial: { callStats } as any };
  }
  const anyFailure = apiEv.some(e => e.outcome !== 'SUCCESS');
  if (anyFailure && apiEv.some(e => e.outcome === 'TIMEOUT' || (e.outcome === 'SKIPPED' && e.errorCode === E.SEARCH_TIMEOUT))) errors.push(E.SEARCH_TIMEOUT);
  if (alternatives.some(a => a.verificationStatus === 'CONFLICTING')) errors.push(E.PROVIDER_DATA_CONFLICT);
  // P42.2: a verified alternative needs seats for the WHOLE party (AVAILABLE count ≥ passengers) or RAC
  const verifiedAlternativeCount = alternatives.filter(isVerifiedSameTrainAlternative).length;
  const foundAlternative = verifiedAlternativeCount > 0;
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
      stations: plan.route.slice(Math.max(0, (plan.originAlternatives[0]?.index ?? plan.originIndex)), (plan.destinationExtension[plan.destinationExtension.length - 1]?.index ?? plan.destinationIndex) + 1) },
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
    searchComplete: !plan.truncated && !anyFailure && !checksTruncated,
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
