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
  PROVIDER_DATA_CONFLICT: 'PROVIDER_DATA_CONFLICT',
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
  fare?: { total?: number; perPassenger?: number; currency?: string; fetchedAt: string };
  fareOutcome?: EvidenceOutcome;
  /** typed reason when not SUCCESS (never a provider secret / raw body) */
  errorCode?: string;
  rejectedReason?: 'WRONG_TRAIN' | 'WRONG_DATE' | 'WRONG_CLASS' | 'MALFORMED';
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
    fetchedAt: string;
    trainOrigin: string;
    trainTerminal: string;
    stationCount: number;
    /** stations used as alternative ticket origins (route order, requested origin excluded) */
    originSweep: string[];
    /** downstream stations used as alternative ticket destinations (route order) */
    destinationExtension: string[];
    destinationSweep: 'NONE_TERMINAL' | 'EXTENSION' | 'DISABLED';
    stations: RouteStation[];
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
}

/** Bounded search limits (spec "SEARCH LIMITS") — configurable via env, clamped to safe ranges. */
export interface SameTrainLimits {
  maxCandidatePairs: number;
  maxOriginSweepStations: number;
  maxDestinationSweep: number;
  maxParallel: number;
  perCallTimeoutMs: number;
  totalTimeoutMs: number;
  maxWebChecks: number;
}

export const SAME_TRAIN_DEFAULT_LIMITS: Readonly<SameTrainLimits> = Object.freeze({
  maxCandidatePairs: 40,
  maxOriginSweepStations: 12,
  maxDestinationSweep: 6,
  maxParallel: 6,
  perCallTimeoutMs: 9000,
  totalTimeoutMs: 45000,
  maxWebChecks: 8
});
export const DESTINATION_EXTENSION_MIN = 5;
export const DESTINATION_EXTENSION_MAX = 7;
