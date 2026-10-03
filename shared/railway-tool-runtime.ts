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
  GENERAL_RAILWAY_ANSWER: 'GENERAL_RAILWAY_ANSWER'
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
  | 'TOOL_CALL_LIMIT_EXCEEDED' | 'TOOL_LOOP_DETECTED' | 'STALE_TOOL_RESULT' | 'PROVIDER_DATA_CONFLICT'
  // Prompt 18: a dependent call whose dependency (e.g. SEARCH_TRAINS) did not succeed
  | 'DEPENDENCY_NOT_SATISFIED';

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
  /** Prompt 18: ToolExecutionPlan node (dependency graph) this execution belongs to. */
  planNodeId?: string | null;
}
