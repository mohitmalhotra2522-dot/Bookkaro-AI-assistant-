/**
 * PROMPT 42 — Same Train Alternative (shared contracts, provider-independent).
 *
 * A bounded, LLM-chosen search for OTHER TICKET STATION PAIRS on the SAME train number (same date, class, passengers):
 * an upstream ticket origin (train origin … requested origin) and/or a downstream ticket destination (a few stations
 * after the requested destination, never past the terminal). Every candidate is checked with FRESH provider calls.
 *
 * Authority split:
 *   - Muse (the LLM) decides IF / WHEN to search, which providers, how to interpret, rank and phrase the results.
 *   - The backend only executes, validates hard constraints (same train / date / class / route order / provider
 *     evidence), detects conflicts and refuses stale or unsafe output. It NEVER ranks, never picks a best match by
 *     itself, never books and never changes the BookingSession without an explicit user selection + fresh revalidation.
 *
 * Ticket ≠ boarding: ticketOrigin is the station printed on the ticket; boardingStation is where the passenger gets
 * on. A "book X, board Y" instruction is only VERIFIED when a rule-evidence source verified it — otherwise the rule
 * status is UNVERIFIED and the UI / reply must say so.
 */

import type { NormalizedAvailabilityState, SeatSufficiency, ShortageTriggerReason, SeatShortageAssessment, SameTrainOutcome } from './same-train-shortage';
import { isVerifiedSameTrainAlternative } from './same-train-shortage';

export const SAME_TRAIN_ALTERNATIVES_TOOL = 'SEARCH_SAME_TRAIN_ALTERNATIVES' as const;
export const PRESENT_SAME_TRAIN_ALTERNATIVES_TOOL = 'PRESENT_SAME_TRAIN_ALTERNATIVES' as const;
export const SAME_TRAIN_TOOL_NAMES = Object.freeze([SAME_TRAIN_ALTERNATIVES_TOOL, PRESENT_SAME_TRAIN_ALTERNATIVES_TOOL] as const);
export type SameTrainToolName = typeof SAME_TRAIN_TOOL_NAMES[number];

/** Typed error codes (spec Part "ERROR HANDLING"). */
export const SameTrainErrorCode = Object.freeze({
  NOT_READY: 'SAME_TRAIN_ALTERNATIVE_NOT_READY',
  INVALID_TRAIN_ROUTE: 'INVALID_TRAIN_ROUTE',
  INVALID_STATION_PAIR: 'INVALID_STATION_PAIR',
  SEARCH_FAILED: 'ALTERNATIVE_SEARCH_FAILED',
  SEARCH_TIMEOUT: 'ALTERNATIVE_SEARCH_TIMEOUT',
  /** F2: the route / search could not be fetched because the provider (or the local pacer) refused — never a route verdict */
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_DATA_CONFLICT: 'PROVIDER_DATA_CONFLICT',
  /** 2026-10-09: the provider answered with an availability snapshot older than the freshness limit — never a verdict */
  STALE_PROVIDER_DATA: 'STALE_PROVIDER_DATA',
  /** 2026-10-09: the timetable has no day for an earlier station → the ticket date of that run is unknown (never guessed) */
  TICKET_DATE_UNVERIFIED: 'TICKET_DATE_UNVERIFIED',
  RESULT_STALE: 'ALTERNATIVE_RESULT_STALE',
  STALE_RESULT: 'STALE_ALTERNATIVE_RESULT',
  NOT_FOUND: 'ALTERNATIVE_NOT_FOUND',
  WEB_EVIDENCE_UNAVAILABLE: 'WEB_EVIDENCE_UNAVAILABLE',
  BOARDING_RULE_UNVERIFIED: 'BOARDING_RULE_UNVERIFIED',
  ALIGHTING_RULE_UNVERIFIED: 'ALIGHTING_RULE_UNVERIFIED'
} as const);
export type SameTrainErrorCode = typeof SameTrainErrorCode[keyof typeof SameTrainErrorCode];

/** Pinned user-facing line when every provider failed (spec). */
export const SAME_TRAIN_ALL_FAILED_MESSAGE = 'Same train alternative abhi verify nahi ho paayi.';
/** F2: provider busy / unavailable (rate limit, local pacer, outage) — the route itself was NOT judged invalid. */
/** P42-13: the provider's route data could not verify the requested station pair — never "the station is not on the route". */
export const SAME_TRAIN_ROUTE_DATA_UNVERIFIED_MESSAGE = 'Is train ka current route data is station pair ko verify nahi kar pa raha, isliye main is station pair ke liye same train alternative confirm nahi kar sakta.';
export const SAME_TRAIN_PROVIDER_BUSY_MESSAGE = 'Railway provider abhi busy hai, isliye same train alternative check nahi ho paaya. Thodi der baad dobara try karein.';

export type CandidatePriority = 'P0' | 'P1' | 'P2' | 'P3';
/** P0 requested pair · P1 upstream origin → requested destination · P2 requested origin → downstream destination · P3 both. */
export type CandidateKind = 'REQUESTED' | 'ORIGIN_ALTERNATIVE' | 'DESTINATION_EXTENSION' | 'ORIGIN_AND_DESTINATION';

/** Canonical availability category — UNKNOWN / TIMEOUT never become NOT_AVAILABLE. */
export type AvailabilityCategory = 'AVAILABLE' | 'RAC' | 'WAITLIST' | 'NOT_AVAILABLE' | 'UNKNOWN';
export type CombinedAvailability = AvailabilityCategory | 'CONFLICTING';

export type VerificationStatus = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'CONFLICTING' | 'INVALID';
/** NOT_REQUIRED = ticket station == travel station (nothing to verify). */
export type RuleStatus = 'NOT_REQUIRED' | 'VERIFIED' | 'UNVERIFIED';
export type EvidenceLevel = 'PROVIDER_API' | 'UNVERIFIED_WEB';
export type EvidenceOutcome = 'SUCCESS' | 'TIMEOUT' | 'FAILED' | 'REJECTED' | 'SKIPPED';

export interface RouteStation { code: string; name?: string; index: number; arrival?: string; departure?: string; day?: number }

export interface CandidatePair {
  pairId: string;
  priority: CandidatePriority;
  kind: CandidateKind;
  ticketOrigin: string;
  ticketDestination: string;
  originIndex: number;
  destinationIndex: number;
}

export interface ProviderEvidence {
  provider: string;
  providerLabel?: string;
  level: EvidenceLevel;
  requestId: string;
  toolExecutionId: string;
  fetchedAt: string;
  latencyMs: number;
  outcome: EvidenceOutcome;
  /** request binding (what was asked) */
  trainNumber: string;
  ticketOrigin: string;
  ticketDestination: string;
  travelClass: string;
  date: string;
  passengersCount: number;
  /** provider answer (only when outcome SUCCESS) */
  availability?: { category: AvailabilityCategory; status: string; statusText?: string; quota?: string; providerUpdatedAt?: string };
  /** 2026-10-09: outcome FAILED / STALE_PROVIDER_DATA — the provider's old snapshot (kept for honesty, never a verdict) */
  staleSnapshot?: { status: string; providerUpdatedAt: string; ageMinutes: number };
  fare?: { total?: number; perPassenger?: number; currency?: string; fetchedAt: string };
  fareOutcome?: EvidenceOutcome;
  /** typed reason when not SUCCESS (never a provider secret / raw body) */
  errorCode?: string;
  rejectedReason?: 'WRONG_TRAIN' | 'WRONG_DATE' | 'WRONG_CLASS' | 'MALFORMED';
  /** P42.9 observability (additive): backend fallback for THIS request (provider = the provider that served it) */
  fallbackUsed?: boolean;
  fallbackReason?: string;
  primaryProvider?: string;
  primaryErrorCode?: string;
  rateLimited?: boolean;
  /** RATE_LIMITED by the local pacer (no provider request spent) vs by the provider (429) */
  rateLimitLocal?: boolean;
  retryCount?: number;
  /** F3: local refusal reason of the paced queue (e.g. DAILY_RESERVE — provider quota kept for interactive use) */
  rateLimitReason?: string;
  /** dispatch wave inside the bounded-concurrency matrix (1-based) */
  batchNumber?: number;
}

/** P42.9: per-recovery provider call counters (observability only — never keys / headers / bodies). */
export interface SameTrainCallStats {
  requested: number; executed: number; successful: number; rateLimited: number; rateLimitedAttempts: number; timeout: number;
  providerUnavailable: number; fallback: number; fallbackSucceeded: number; deduped: number; skipped: number; partial: boolean;
}

export interface WebRouteEvidence {
  provider: string;
  level: 'UNVERIFIED_WEB';
  ticketOrigin: string;
  ticketDestination: string;
  /** the same train number was listed between this pair on the public page */
  listed: boolean | null;
  fetchedAt: string;
  errorCode?: string;
}

export interface SameTrainAlternative {
  alternativeId: string;
  /** 2026-10-09: `date` is the TICKET date. For a ticket from an earlier station the train leaves on another calendar day,
   *  ticketDateShiftDays = date − journeyDate (e.g. −1) and journeyDate = the requested boarding date */
  ticketDateShiftDays?: number;
  journeyDate?: string;
  /** departure time at the ticket origin from the provider timetable (display only) */
  ticketOriginDeparture?: string;
  /** the provider timetable had no day field → the ticket date could not be derived (journey date used, shown as unverified) */
  ticketDateUnverified?: boolean;
  pairId: string;
  priority: CandidatePriority;
  kind: CandidateKind;
  isRequestedPair: boolean;
  trainNumber: string;
  trainName?: string;
  date: string;
  travelClass: string;
  passengersCount: number;
  requestedOrigin: string;
  requestedDestination: string;
  ticketOrigin: string;
  ticketOriginName?: string;
  ticketDestination: string;
  ticketDestinationName?: string;
  /** where the passenger actually travels — the ticket stations unless a VERIFIED rule allows otherwise */
  boardingStation: string;
  alightingStation: string;
  /** what the user WANTS (requested stations) — shown only together with the rule status */
  intendedBoardingStation: string;
  intendedAlightingStation: string;
  boardingRuleStatus: RuleStatus;
  alightingRuleStatus: RuleStatus;
  availability: CombinedAvailability;
  availabilityStatusText?: string;
  /** P42.2: normalized 7-state status (REGRET / TRAIN_CANCELLED kept distinct; CONFLICTING / no answer → UNKNOWN) */
  availabilityStatus?: NormalizedAvailabilityState;
  /** P42.2: provider's exact seat count (AVAILABLE only, never inferred) */
  availableSeatCount?: number;
  /** P42.2: the party size this pair was checked for */
  requestedPassengerCount?: number;
  /** P42.2: SUFFICIENT only when availableSeatCount ≥ requestedPassengerCount (or bare AVAILABLE for 1 passenger) */
  seatSufficiency?: SeatSufficiency;
  fare: { status: 'PROVIDER' | 'UNAVAILABLE' | 'NOT_REQUESTED' | 'CONFLICTING'; total?: number; perPassenger?: number; currency?: string; provider?: string };
  verificationStatus: VerificationStatus;
  /** true only for VERIFIED (availability + any boarding/alighting rule verified) */
  actionable: boolean;
  evidence: ProviderEvidence[];
  webEvidence: WebRouteEvidence[];
  warnings: SameTrainErrorCode[];
  conflict?: { providers: string[]; values: Array<{ provider: string; status: string }> };
  /** extra stations beyond the requested destination (destination extension) */
  extensionStations: number;
  /** findBoardFromEarlier (2026-10-09 Phase 2): ticket from (= ticketOrigin), travel from (= requested origin) and the
   *  route distance of the ticket pair from the requested pair (earlier stops before the origin / stops past the destination) */
  bookFrom?: string;
  boardAt?: string;
  stopsBefore?: number;
  stopsAfter?: number;
  /** Phase 2: the provider answered only with a too-old snapshot (no verdict). Shown with ⚠ + age; Select = fresh re-check
   *  first (the re-check decides; a stale snapshot is never applied) */
  staleSnapshot?: { provider: string; status: string; category: AvailabilityCategory; providerUpdatedAt: string; ageMinutes: number };
  /** Phase 2 "better WL": a FRESH waitlist from an earlier station lower than the train's direct waitlist (still WL — not confirmed) */
  betterWaitlist?: { waitlist: number; directWaitlist: number };
  fetchedAt: string;
}

/** Inputs that make a result stale when they change (spec "STALE RESULT PROTECTION"). */
export interface SameTrainJourneyKey { trainNumber: string; date: string; travelClass: string; origin: string; destination: string; passengersCount: number }

export function sameTrainJourneyKeyString(k: SameTrainJourneyKey): string {
  return [k.trainNumber, k.date, k.travelClass, k.origin, k.destination, k.passengersCount].join('|');
}

export interface SameTrainPresentation {
  /** set ONLY by Muse through PRESENT_SAME_TRAIN_ALTERNATIVES — the backend never picks */
  bestMatchId: string | null;
  order: string[];
  decidedBy: 'MUSE' | 'NONE';
  at?: string;
}

export interface SameTrainAlternativesResult {
  kind: 'SAME_TRAIN_ALTERNATIVES';
  alternativeSearchId: string;
  resultSetId: string;
  sessionId: string;
  turnId: string | null;
  requestId: string | null;
  journeyVersion: number | null;
  journeyKey: string;
  trainNumber: string;
  trainName?: string;
  date: string;
  travelClass: string;
  passengersCount: number;
  requestedOrigin: string;
  requestedOriginName?: string;
  requestedDestination: string;
  requestedDestinationName?: string;
  route: {
    provider: string;
    /** P42.9: the route came from the backend fallback provider (primary route call hit an eligible fault) */
    fallbackUsed?: boolean;
    fallbackReason?: string;
    fetchedAt: string;
    trainOrigin: string;
    trainTerminal: string;
    stationCount: number;
    /** stations used as alternative ticket origins (route order, requested origin excluded) */
    originSweep: string[];
    /** downstream stations used as alternative ticket destinations (route order) */
    destinationExtension: string[];
    destinationSweep: 'NONE_TERMINAL' | 'EXTENSION' | 'DISABLED';
    /** P42-14: further ticket destinations checked after the 5..7 window up to the train's terminal (only when the window found no seat) */
    terminalSweep?: string[];
    stations: RouteStation[];
    /** RailRadar Phase 1: which route data verified the requested pair in order (a statement about provider DATA only) */
    verification?: SameTrainRouteVerification;
    /** provider whose route data verified the pair */
    verifiedBy?: string;
    /** cross-check only: the primary route provider whose data could not verify the pair, and why */
    primaryRouteProvider?: string;
    primaryRouteResult?: 'STATION_MISSING' | 'ORDER_NOT_VERIFIED';
  };
  providers: Array<{ provider: string; label?: string; level: EvidenceLevel; requested: number; succeeded: number; failed: number; timeouts: number }>;
  candidateCount: number;
  candidatesTruncated: boolean;
  /** visible alternatives (INVALID ones are excluded) — neutral route order (requested pair first) */
  alternatives: SameTrainAlternative[];
  invalidCount: number;
  status: 'OK' | 'PARTIAL' | 'ALL_PROVIDERS_FAILED' | 'NOT_FOUND';
  errors: SameTrainErrorCode[];
  webEvidence: 'NOT_REQUESTED' | 'COLLECTED' | 'UNAVAILABLE';
  presentation: SameTrainPresentation;
  fresh: true;
  cached: false;
  startedAt: string;
  completedAt: string;
  latencyMs: number;
  isMock: boolean;
  /** P42.2 (additive): party size, trigger, requested-pair assessment, outcome, completeness, creation context */
  requestedPassengerCount?: number;
  triggerReason?: ShortageTriggerReason | null;
  triggerSource?: 'SESSION_EVIDENCE' | 'MUSE' | 'AUTO_DISPLAY' | 'SAFETY_NET' | 'NONE';
  requestedPairAssessment?: SeatShortageAssessment | null;
  outcome?: SameTrainOutcome;
  verifiedAlternativeCount?: number;
  /** Phase 2: count of better-WL options (only when no bookable option was found) */
  betterWaitlistCount?: number;
  /** false when the candidate list was truncated or some provider calls failed / timed out — never claim exhaustive */
  searchComplete?: boolean;
  /** F3: counts of real provider outcomes of this search (skipped = never sent, e.g. deadline); paced = fair queue used */
  checkSummary?: { total: number; succeeded: number; failed: number; skipped: number; retried: number; paced: boolean; stale?: number };
  /** 2026-10-09: checks whose provider snapshot was older than maxSnapshotAgeMs — shown as "not confirmed", never as a
   *  verdict or an option (status = the stale provider text, providerUpdatedAt = the provider's own snapshot time) */
  staleChecks?: SameTrainStaleCheck[];
  toolExecutionId?: string | null;
  /** P42.9: provider call counters for this recovery execution (observability) */
  callStats?: SameTrainCallStats;
  /** session selection at creation: a result is stale only when train / class changed AFTER it was produced */
  contextSnapshot?: { selectedTrain: string | null; selectedClass: string | null; journeyVersion: number | null; requestedClass?: string | null };
  /** P42.7 all-class route matrix coverage (metadata; route / provider order, never a ranking) */
  classesChecked?: string[];
  earlierStationsChecked?: number;
  downstreamStationsChecked?: number;
  availabilityChecks?: number;
  checksTruncated?: boolean;
  /** P42.7: the user explicitly asked for more options even though the requested class had enough seats */
  explicitUserRequest?: boolean;
}

/**
 * P42.7 Part 28 — SameTrainRecoveryResult: the flat, per-(ticket pair × class) view of one verified recovery option.
 * A pure projection of the stored SAME_TRAIN_ALTERNATIVES result (no new fact, no ranking — route / class order kept).
 */
export interface SameTrainRecoveryResult {
  resultId: string;               // `${alternativeSearchId}:${alternativeId}`
  alternativeSearchId: string;
  alternativeId: string;
  trainNumber: string;
  trainName?: string;
  date: string;
  requestedOrigin: string;
  requestedDestination: string;
  ticketOrigin: string;           // bookFrom
  ticketDestination: string;      // bookUpto
  boardAt: string;                // boarding station (ticket origin unless a VERIFIED rule allows otherwise)
  boardingRuleStatus: RuleStatus;
  classCode: string;
  availability: 'AVAILABLE' | 'RAC';
  confirmedSeats: number | null;  // exact provider AVAILABLE count; RAC → null (an RAC position is never a seat)
  passengers: number;
  status: string;                 // provider status text, e.g. "AVAILABLE-0003" / "RAC 4"
  provider: string | null;
  asOf: string;
  stale: boolean;
  sourceResultId: string;         // resultSetId of the result it came from
  journeyVersion: number | null;
}

/** Verified, selectable recovery options (whole party AVAILABLE or RAC), excluding the requested pair itself. */
export function toSameTrainRecoveryResults(r: SameTrainAlternativesResult | null | undefined, stale = false): SameTrainRecoveryResult[] {
  if (!r || !Array.isArray(r.alternatives)) return [];
  return r.alternatives.filter(a => !a.isRequestedPair && isVerifiedSameTrainAlternative(a)).map(a => ({
    resultId: `${r.alternativeSearchId}:${a.alternativeId}`, alternativeSearchId: r.alternativeSearchId, alternativeId: a.alternativeId,
    trainNumber: a.trainNumber, ...(a.trainName ? { trainName: a.trainName } : {}), date: a.date,
    requestedOrigin: a.requestedOrigin, requestedDestination: a.requestedDestination,
    ticketOrigin: a.ticketOrigin, ticketDestination: a.ticketDestination, boardAt: a.boardingStation, boardingRuleStatus: a.boardingRuleStatus,
    classCode: a.travelClass, availability: a.availability === 'RAC' ? 'RAC' as const : 'AVAILABLE' as const,
    confirmedSeats: a.availability === 'AVAILABLE' && typeof a.availableSeatCount === 'number' ? a.availableSeatCount : null,
    passengers: a.passengersCount, status: a.availabilityStatusText || a.availability,
    provider: (a.evidence || []).find(e => e.level === 'PROVIDER_API' && e.outcome === 'SUCCESS')?.provider ?? null,
    asOf: a.fetchedAt, stale, sourceResultId: r.resultSetId, journeyVersion: r.journeyVersion ?? null
  }));
}

/** Bounded search limits (spec "SEARCH LIMITS") — configurable via env, clamped to safe ranges. */
/** 2026-10-09: one availability check answered with a provider snapshot older than the freshness limit. */
export interface SameTrainStaleCheck {
  provider: string; ticketOrigin: string; ticketDestination: string; travelClass: string;
  status: string; providerUpdatedAt: string; ageMinutes: number;
}

export interface SameTrainLimits {
  maxCandidatePairs: number;
  maxOriginSweepStations: number;
  maxDestinationSweep: number;
  maxParallel: number;
  perCallTimeoutMs: number;
  totalTimeoutMs: number;
  maxWebChecks: number;
  /** P42.7: total availability calls per provider across the (pair × class) matrix — bounded, never an unbounded crawl */
  maxAvailabilityChecks?: number;
  /** RailRadar Phase 1: cross-check the route on the secondary route provider when the primary route data cannot verify
   *  the requested pair (default on; SAME_TRAIN_ROUTE_CROSS_CHECK=off disables) */
  routeCrossCheck?: boolean;
  /** 2026-10-09: max age (ms) of a provider availability snapshot (providerUpdatedAt). An older snapshot is never a
   *  verdict: outcome FAILED / STALE_PROVIDER_DATA, the search is not complete (SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN, 0 = off) */
  maxSnapshotAgeMs?: number;
}

/**
 * RailRadar Phase 1 — route verification outcome for the requested station pair (deterministic, provider-data relative):
 *   VERIFIED_BY_RAILCORE        primary route data contains origin before destination (no secondary call)
 *   ROUTE_VERIFIED_BY_RAILRADAR primary data could not verify; the secondary route data contains the pair in order AND
 *                               agrees with the primary on the order of every station both routes share
 *   ROUTE_UNVERIFIED            neither route data verifies the pair (or the secondary was unavailable)
 *   ROUTE_DATA_CONFLICT         the two route data make incompatible claims (order disagreement) — never resolved by choice
 */
export type SameTrainRouteVerification = 'VERIFIED_BY_RAILCORE' | 'ROUTE_VERIFIED_BY_RAILRADAR';
export type SameTrainRouteCheckVerdict = SameTrainRouteVerification | 'ROUTE_UNVERIFIED' | 'ROUTE_DATA_CONFLICT';
export interface SameTrainRouteCheck {
  verdict: SameTrainRouteCheckVerdict;
  primaryProvider: string;
  primaryResult?: 'STATION_MISSING' | 'ORDER_NOT_VERIFIED';
  crossCheckProvider?: string;
  /** VERIFIED | NOT_IN_ROUTE | ORDER | NO_OVERLAP | ORDER_DISAGREEMENT | DUPLICATE | ROUTE_INVALID | <provider error code> | TIMEOUT | NOT_CONFIGURED | DISABLED */
  crossCheckResult?: string;
}

/** P42.7 hard caps of the recovery route matrix (env may lower, never raise). */
export const MAX_EARLIER_STATIONS = 15;
/** findBoardFromEarlier config (Phase 2): staged depth — first `boardEarlierStops` stops before the origin and
 *  `bookUptoStops` past the destination; only when nothing bookable is found → up to the origin (≤ MAX_EARLIER_STATIONS)
 *  and the terminus. Probes per train and trains in parallel are bounded (still through the F3 limiter / queue). */
export const BOARD_EARLIER_STOPS = 2;
export const BOOK_UPTO_STOPS = 3;
export const EARLIER_PROBE_CONCURRENCY = 3;
/** Phase 2: the label of a lower-WL option from an earlier station (Muse's view) — still a waitlist, never a confirmed seat. */
export const BETTER_WAITLIST_LABEL = 'Waiting List — not confirmed';
export const SAME_TRAIN_TRAIN_CONCURRENCY = 3;
export const MAX_DOWNSTREAM_STATIONS = 7;
export const MAX_AVAILABILITY_CHECKS = 160;

export const SAME_TRAIN_DEFAULT_LIMITS: Readonly<SameTrainLimits> = Object.freeze({
  maxCandidatePairs: 40,
  maxOriginSweepStations: MAX_EARLIER_STATIONS,
  maxDestinationSweep: 6,                    // default 6 of the allowed 5..MAX_DOWNSTREAM_STATIONS (7)
  maxAvailabilityChecks: 120,
  maxParallel: 6,
  perCallTimeoutMs: 9000,
  totalTimeoutMs: 45000,
  maxWebChecks: 8,
  // 120 min (SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN): live 2026-10-09 RailCore re-serves a pair's cached snapshot for > 60 min
  // before refreshing it, so 60 would flag normal data; a 4.7 h snapshot (refresh failed upstream) is still rejected
  maxSnapshotAgeMs: 120 * 60 * 1000
});
export const DESTINATION_EXTENSION_MIN = 5;
export const DESTINATION_EXTENSION_MAX = 7;

/** P42.2 — per-turn budget of SEARCH_SAME_TRAIN_ALTERNATIVES calls (SAME_TRAIN_MAX_SEARCHES_PER_TURN, clamped 1–8, default 4). */
export function sameTrainSearchesPerTurn(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {}) as any): number {
  const n = Number(env.SAME_TRAIN_MAX_SEARCHES_PER_TURN);
  return Number.isInteger(n) && n >= 1 ? Math.min(8, n) : 4;
}
