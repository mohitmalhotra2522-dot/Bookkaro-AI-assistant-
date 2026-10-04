/**
 * PROMPT 17 — LLM Tool Runtime contracts (shared, provider-independent).
 *
 * The LLM chooses WHAT railway information it needs (an LLMToolCall). The RailwayToolRuntime decides
 * WHETHER that call is allowed, the RailwaySearchOrchestrator / RailwayToolService decide HOW it runs,
 * and the RailwayProvider decides WHERE the data comes from. The normalized result is authoritative.
 */

/** Strict, closed tool enum (Part 2). Never resolved dynamically from an arbitrary LLM string. */
export const RailwayToolName = Object.freeze({
  SEARCH_TRAINS: 'SEARCH_TRAINS',
  GET_TRAIN_INFO: 'GET_TRAIN_INFO',
  GET_TIMETABLE: 'GET_TIMETABLE',
  CHECK_AVAILABILITY: 'CHECK_AVAILABILITY',
  GET_FARE: 'GET_FARE',
  TRACK_TRAIN: 'TRACK_TRAIN',
  CHECK_PNR: 'CHECK_PNR',
  GET_CANCELLED_TRAINS: 'GET_CANCELLED_TRAINS',
  GENERAL_RAILWAY_ANSWER: 'GENERAL_RAILWAY_ANSWER',
  /** Prompt 35: WEB_EXTERNAL research — LLM-chosen, disabled unless configured, never authoritative. */
  WEB_RAILWAY_RESEARCH: 'WEB_RAILWAY_RESEARCH'
} as const);
export type RailwayToolName = typeof RailwayToolName[keyof typeof RailwayToolName];
export const RAILWAY_TOOL_NAMES: readonly RailwayToolName[] = Object.freeze(Object.values(RailwayToolName));

/** Backend-controlled actions — NEVER executable through the LLM tool runtime (Part "NON-LLM-DIRECT"). */
export const FORBIDDEN_LLM_ACTIONS = Object.freeze([
  'EXECUTE_BOOKING', 'CANCEL_BOOKING', 'MODIFY_BOOKING', 'CHANGE_JOURNEY', 'CHANGE_CLASS', 'CHANGE_PASSENGER',
  'PROCESS_REFUND', 'PAYMENT', 'IRCTC_LOGIN', 'OTP', 'CAPTCHA', 'SUBMIT_BOOKING',
  // Prompt 22 Part 3: explicit names (matched case-insensitively, e.g. "executeBooking")
  'BOOK_TICKET', 'EXECUTEBOOKING', 'BOOKINGPROVIDERADAPTER.EXECUTE', 'MAKE_PAYMENT', 'UPI_PAYMENT', 'CARD_PAYMENT', 'FINAL_SUBMISSION'
] as const);
export type ForbiddenLlmAction = typeof FORBIDDEN_LLM_ACTIONS[number];

export type FreshnessPolicy = 'ALWAYS_FRESH' | 'NOT_APPLICABLE';

/** Part 12 — execution lifecycle. TIMEOUT is never reported as SUCCEEDED. */
export const ToolExecutionStatus = Object.freeze({
  REQUESTED: 'REQUESTED', VALIDATING: 'VALIDATING', RUNNING: 'RUNNING', SUCCEEDED: 'SUCCEEDED', FAILED: 'FAILED',
  TIMEOUT: 'TIMEOUT', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED', UNKNOWN: 'UNKNOWN'
} as const);
export type ToolExecutionStatus = typeof ToolExecutionStatus[keyof typeof ToolExecutionStatus];

/** Part 47 — normalized provider error vocabulary (+ runtime rejection codes). */
export type ToolErrorCode =
  | 'TOOL_FAILED' | 'TOOL_TIMEOUT' | 'INVALID_REQUEST' | 'NO_RESULTS' | 'PROVIDER_UNAVAILABLE' | 'RATE_LIMITED'
  | 'AUTH_ERROR' | 'DATA_UNAVAILABLE' | 'UNKNOWN'
  // runtime-level (provider NOT called)
  | 'UNKNOWN_TOOL' | 'TOOL_NOT_IMPLEMENTED' | 'TOOL_CALL_REJECTED' | 'FORBIDDEN_ACTION' | 'FORBIDDEN_ARGUMENT'
  | 'TOOL_CALL_LIMIT_EXCEEDED' | 'TOOL_LOOP_DETECTED' | 'STALE_TOOL_RESULT' | 'PROVIDER_DATA_CONFLICT' | 'PROVIDER_DATA_INVALID'
  // Prompt 18: a dependent call whose dependency (e.g. SEARCH_TRAINS) did not succeed
  | 'DEPENDENCY_NOT_SATISFIED'
  // Prompt 25: argument schema validation before execution (provider NOT called)
  | 'INVALID_ARGUMENT' | 'INVALID_REPEATED_CALL'
  // Prompt 27: the same VALIDATED call already failed at the provider this turn — one retry for a transient failure, then no more
  | 'REPEATED_FAILED_CALL';

/** Prompt 27 — why a multi-step LLM ↔ tool chain ended (deterministic, one per turn). */
export type ToolChainStopReason =
  | 'FINAL_RESPONSE' | 'CLARIFICATION' | 'TOOL_BUDGET_EXHAUSTED' | 'TOOL_LOOP_DETECTED' | 'SAFETY_BLOCKED' | 'VALIDATION_BLOCKED'
  | 'TOOL_UNAVAILABLE' | 'TOOL_FAILED' | 'LLM_UNAVAILABLE' | 'INVALID_DECISION' | 'STALE';

/** Prompt 27 — one tool step of a chain (sanitized: whitelisted argument summary only, never text / secrets). */
export interface ToolChainStep {
  stepNumber: number;
  /** 1-based LLM decision call that requested this step. */
  llmCall: number;
  toolName: string;
  toolArgumentsSanitized: Record<string, string | number>;
  toolResultStatus: string;
  /** toolExecutionId of the authoritative result (provenance id). */
  toolResultId: string;
  /** LLM_TOOL_CALL | LLM_RETRY | BACKEND_RETRY | DEDUPLICATED | REJECTED:<code> */
  decisionReason: string;
  retryCount: number;
  latencyMs: number | null;
  parallelGroup: number | null;
  /** Prompt 28: the entity this result is about ({ trainNumber, date, class, … }) — from the result identity */
  toolEntity?: Record<string, string | number>;
  /** Prompt 28: BOUND / MISMATCH / NO_ENTITY (MISMATCH = provider answered for another entity; result unused) */
  entityBindingStatus?: string;
}

/** Prompt 27 — observability of one multi-step chain (one user turn). */
export interface ToolChainTrace {
  chainId: string;
  llmCallCount: number;
  toolCallCount: number;
  providerCallCount: number;
  redundantCallCount: number;
  retryCount: number;
  chainLength: number;
  chainStopReason: ToolChainStopReason;
  /** the LLM answered from the results already obtained after the budget / loop stop (one tools-disabled call) */
  answeredAfterStop: boolean;
  budget: { maxToolSteps: number; maxRounds: number; maxLlmIterations: number };
  latencyMs: number;
  steps: ToolChainStep[];
  /** Prompt 28: a same-turn duplicate (same tool + validated args + entity + date, no new info) reused the result */
  duplicateCallPrevented?: boolean;
  /** Prompt 28: the step budget / loop guard stopped execution (results preserved) */
  stepLimitReached?: boolean;
  stepLimitReason?: string | null;
}

/** Part 4 — what the LLM may emit. Raw expressions ("kal", "Delhi") are allowed; the backend resolves them. */
export interface LLMToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  callId?: string;
}

/** Part 41 — freshness / provenance metadata attached to every result (no credentials). */
export interface ToolResultMeta {
  toolExecutionId: string;
  requestId: string | null;
  provider: string | null;
  fetchedAt: string;
  fresh: boolean;
  source: 'RAILWAY_PROVIDER' | 'NONE';
  journeyVersion: number;
}

/** Part 14 — what goes back to the LLM: structured, normalized, provider-independent. */
export interface LLMToolResult {
  toolExecutionId: string;
  tool: string;
  status: ToolExecutionStatus;
  fresh: boolean;
  result?: unknown;
  /** SUCCEEDED with zero items (Part 46) — "no trains returned", never "tool failed". */
  empty?: boolean;
  error?: { code: ToolErrorCode; message: string; detail?: string };
  meta: ToolResultMeta;
}

/** Parts 11 + 56 — observability record (arguments hashed, PNR masked; never raw sensitive values). */
export interface ToolExecutionRecord {
  toolExecutionId: string;
  sessionId: string;
  turnId: string;
  requestId: string | null;
  tool: string;
  journeyVersion: number;
  argumentsHash: string;
  /** Safe summary of arguments (PNR masked; no free text). */
  argumentsSummary: Record<string, string | number>;
  provider: string | null;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  status: ToolExecutionStatus;
  fresh: boolean;
  latencyMs: number | null;
  resultCount: number | null;
  rejectionReason: string | null;
  parallelGroup: number | null;
  /** Prompt 18: 1 = first attempt; a backend retry is a NEW record (new id) with retryOf → previous id. */
  attempt?: number;
  retryOf?: string | null;
  /** Prompt 27: the LLM re-requested an identical call after a transient provider failure (its one bounded retry). */
  llmRetry?: boolean;
  /** Prompt 18: ToolExecutionPlan node (dependency graph) this execution belongs to. */
  planNodeId?: string | null;
  /** Prompt 35 (observability, additive): MOCK | LIVE of the answering provider, honest outcome, failover chain. */
  dataSource?: 'MOCK' | 'LIVE' | 'WEB_EXTERNAL' | null;
  outcome?: string | null;
  fallbackUsed?: boolean;
  providerAttempts?: Array<{ provider: string; attempt: number; outcome: string; errorCode: string | null; httpStatus: number | null; latencyMs: number; retryable: boolean }>;
  freshness?: { mode?: string; retrievedAt?: string } | null;
}
