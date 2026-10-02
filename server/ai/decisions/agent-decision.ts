/**
 * AgentDecision — typed structured decision returned by the LLM after
 * possibly issuing tool calls.
 *
 * LLM flow:
 *   1. Receive user message + session context + registered tool schemas.
 *   2. Decide whether to:
 *        a) emit one or more ToolCalls to registered tools, OR
 *        b) produce a final assistant text response (with action/intent).
 *   3. Backend executes approved tool calls, returns tool results.
 *   4. Loop (bounded iterations) until LLM returns a final response.
 */
import type { ToolCall } from '../tools/tool-registry';

export type AgentIntent =
  | 'GENERAL_RAILWAY_QUERY'
  | 'BOOK_TRAIN'
  | 'SEARCH_TRAINS'
  | 'SELECT_TRAIN'
  | 'SELECT_CLASS'
  | 'UPDATE_JOURNEY'
  | 'UPDATE_DATE'
  | 'UPDATE_PASSENGERS'
  | 'COLLECT_PASSENGER_DETAILS'
  | 'SHOW_REVIEW'
  | 'CONFIRM_BOOKING'
  | 'CANCEL_FLOW'
  | 'UNKNOWN';

export type AgentAction =
  | 'ASK_CLARIFICATION'
  | 'SEARCH_TRAINS'
  | 'SELECT_TRAIN'
  | 'SELECT_CLASS'
  | 'UPDATE_JOURNEY'
  | 'UPDATE_DATE'
  | 'UPDATE_PASSENGERS'
  | 'COLLECT_PASSENGER_DETAILS'
  | 'SHOW_REVIEW'
  | 'REQUEST_CONFIRMATION'
  | 'PREPARE_IRCTC_HANDOFF'
  | 'REFINE_RESULTS'
  | 'COMPARE_TRAINS'
  | 'NO_ACTION';

/**
 * A train reference as understood by the LLM. The LLM NEVER resolves these to a
 * train itself — TrainReferenceResolver resolves them against the CURRENT
 * search results (and rejects references tied to an older searchResultsVersion).
 */
export type TrainReference = (
  | { kind: 'TRAIN_NUMBER'; value: string }
  | { kind: 'DISPLAY_INDEX'; value: number }
  | { kind: 'TIME_PREFERENCE'; value: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' }
  | { kind: 'CLASS_PREFERENCE'; value: string }
  | { kind: 'DEMONSTRATIVE'; value: 'FIRST' | 'LAST' | 'THIS' }
  /** "jo pehle batayi thi" — the previously discussed/selected train */
  | { kind: 'PREVIOUS'; value: 'PREVIOUS' }
  /** "nahi, doosri train" — another train than the currently selected one */
  | { kind: 'ALTERNATIVE'; value: 'OTHER' }
) & { searchResultsVersion?: number };

export type InfoRequest = 'TRAIN_INFO' | 'TIMETABLE' | 'AVAILABILITY' | 'FARE';

export interface ResultRefinement {
  kind: 'TIME' | 'AC_ONLY' | 'NON_AC_ONLY' | 'FASTEST' | 'EARLIEST_ARRIVAL' | 'ALTERNATIVES';
  value?: string;
}

/** Natural passenger reference proposed by the LLM; resolved by the backend
 *  (PassengerCollection) to a STABLE passengerId — never to a raw array slot. */
export type PassengerRef =
  | { kind: 'INDEX'; value: number }          // "passenger 2", "second passenger", "pehla"
  | { kind: 'NAME'; value: string }           // "Rahul ki age 32 hai"
  | { kind: 'PRONOUN' }                       // "uska naam Neha hai"
  | { kind: 'ID'; value: string };            // "P2" (UI / pending interaction)

/** Raw passenger details as extracted by the LLM (UNTRUSTED — validated by PassengerValidator). */
export interface PassengerUpdateRaw {
  ref?: PassengerRef;
  fields: Record<string, any>;
  /** True when the user explicitly targeted the field / issued a correction
   *  ("actually naam Rohit hai", "passenger 2 ka age 28 hai"). Only explicit
   *  updates may overwrite an existing value. */
  explicit?: boolean;
}

export interface ExtractedEntities {
  originRaw?: string;
  destinationRaw?: string;
  dateRaw?: string;
  passengersCountRaw?: string;
  preferredTimeRaw?: string;
  preferredClassRaw?: string;
  trainRef?: TrainReference;
  classRaw?: string;
  passengerField?: 'name' | 'age' | 'gender' | 'berthPreference';
  passengerIndex?: number;
  passengerValueRaw?: string;
  correctionTarget?: 'origin' | 'destination' | 'date' | 'passengers' | 'train' | 'class';
  correctionValueRaw?: string;
  /** "ek aur add kar do" → +1 ; "2 aur passengers" → +2 */
  passengersDelta?: number;
  /** User gave a bare affirmation ("haan", "ok", "theek hai"). Meaning is resolved by backend from context. */
  affirmation?: boolean;
  /** User gave a bare negation ("nahi", "ruko"). */
  negation?: boolean;
  /** "date change karo" without a new value. */
  changeRequested?: 'date' | 'route' | 'origin' | 'destination' | 'class' | 'train' | 'passengers' | 'details';
  /** Single station mentioned without role (origin/destination) — backend decides or asks. */
  stationOnlyRaw?: string;
  infoRequests?: InfoRequest[];
  refinement?: ResultRefinement;
  compareTrainNumbers?: string[];
  // ---- Prompt 9: passenger collection ----
  passengerUpdates?: PassengerUpdateRaw[];
  passengerRemove?: PassengerRef;
  /** "passenger 2 ka naam change karo" (no value yet) */
  passengerFieldChange?: { ref?: PassengerRef; field: string };
  /** User asked to actually book / pay / submit (always refused: BOOKING_EXECUTION_DISABLED). */
  executionRequested?: boolean;
}

export interface AgentDecision {
  intent: AgentIntent;
  action: AgentAction;
  entities: ExtractedEntities;
  missingFields: string[];
  /** Natural language clarification/question (Hinglish, short, voice-friendly). */
  clarification: string | null;
  confidence: number;
  /** Tool calls the LLM would like to make this turn. These are validated
   *  and executed by the backend; LLM never invokes RailwayProvider directly. */
  toolCalls: ToolCall[];
  /** Final assistant text (only present when the LLM is done calling tools). */
  finalMessage?: string;
}

export type OrchestratorErrorCode =
  | 'INVALID_LLM_OUTPUT'
  | 'UNKNOWN_INTENT'
  | 'UNSUPPORTED_ACTION'
  | 'INVALID_ACTION_FOR_STATE'
  | 'MISSING_REQUIRED_FIELD'
  | 'AMBIGUOUS_ROUTE'
  | 'AMBIGUOUS_DATE'
  | 'AMBIGUOUS_STATION'
  | 'AMBIGUOUS_REFERENCE'
  | 'INVALID_TRAIN_SELECTION'
  | 'INVALID_TRAIN_REFERENCE'
  | 'INVALID_CLASS_SELECTION'
  | 'TOOL_REJECTED'
  | 'TOOL_FAILED'
  | 'NO_CONFIRMATION_PENDING'
  | 'CONFIRMATION_NOT_PENDING'
  | 'SENSITIVE_REQUEST_REJECTED'
  | 'TOOL_LOOP_LIMIT_REACHED'
  | 'TOOL_CALL_LIMIT_EXCEEDED'
  | 'TOOL_NOT_REGISTERED'
  | 'UNKNOWN_TOOL'
  | 'INVALID_TOOL_CALL'
  | 'TOOL_UNAVAILABLE'
  | 'STALE_SEARCH_REFERENCE'
  | 'STALE_TOOL_RESULT'
  | 'INVALID_CONTEXT'
  | 'INVALID_STATE_TRANSITION'
  | 'SESSION_VERSION_CONFLICT'
  // ---- Prompt 9 ----
  | 'BOOKING_NOT_READY'
  | 'MISSING_PASSENGER_COUNT'
  | 'MISSING_PASSENGER_DETAILS'
  | 'INVALID_PASSENGER_DETAILS'
  | 'INVALID_PASSENGER_INDEX'
  | 'STALE_REVIEW'
  | 'STALE_AVAILABILITY'
  | 'STALE_FARE'
  | 'REVIEW_INVALIDATED'
  | 'CONFIRMATION_VERSION_MISMATCH'
  | 'BOOKING_EXECUTION_DISABLED'
  | 'BOOKING_EXECUTION_DUPLICATE'
  | 'EXECUTION_LOCKED'
  | 'EXECUTION_ALREADY_ACTIVE'
  | 'EXECUTION_ALREADY_CONFIRMED'
  | 'EXECUTION_ALREADY_FAILED'
  | 'EXECUTION_UNKNOWN'
  | 'UNSAFE_RETRY'
  | 'MANUAL_VERIFICATION_REQUIRED'
  | 'PROVIDER_CANCELLATION_UNSUPPORTED'
  // ---- Prompt 10: execution boundary ----
  | 'REAL_BOOKING_DISABLED'
  | 'INVALID_BOOKING_HANDOFF'
  | 'STALE_BOOKING_HANDOFF'
  | 'HANDOFF_EXPIRED'
  | 'CONFIRMATION_REQUIRED'
  | 'INVALID_TRAIN'
  | 'INVALID_CLASS'
  | 'UNKNOWN_BOOKING_EXECUTOR'
  | 'BOOKING_EXECUTOR_UNAVAILABLE'
  | 'BOOKING_EXECUTION_FAILED'
  // ---- Prompt 11: secure handoff session ----
  | 'HANDOFF_NOT_FOUND'
  | 'HANDOFF_SESSION_EXPIRED'
  | 'HANDOFF_INVALIDATED'
  | 'HANDOFF_ALREADY_CONSUMED'
  | 'HANDOFF_SESSION_REJECTED'
  | 'INVALID_BOOKING_SNAPSHOT'
  | 'INVALID_CONFIRMATION'
  | 'EXECUTOR_DISABLED'
  | 'EXECUTOR_NOT_FOUND'
  | 'EXECUTOR_UNAVAILABLE'
  | 'SENSITIVE_DATA_REJECTED'
  | 'BOOKING_DATA_CHANGED';

export interface OrchestratorError {
  code: OrchestratorErrorCode;
  message: string;
  details?: any;
}

export interface ValidatedDecision extends AgentDecision {
  normalized?: {
    origin?: { code: string; name: string };
    destination?: { code: string; name: string };
    date?: string;
    passengersCount?: number;
    preferredTime?: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | 'ANY';
    preferredClass?: 'AC' | 'NON_AC' | 'ANY';
    selectedTrainNumber?: string;
    selectedClassCode?: string;
    passengerUpdate?: { index: number; field: string; value: any };
  };
}

export interface TurnToolRecord {
  toolCallId: string;
  toolName: string;
  validatedArguments?: Record<string, any>;
  resultStatus: 'ok' | 'error' | 'rejected' | 'stale';
  errorCode?: string;
  provider?: string;
  latencyMs: number;
}

export interface TurnRecord {
  /** Prompt 10 — PII-free execution-gateway log line (if the gateway ran this turn). */
  execution?: import('@shared/booking-execution').ExecutionLogRecord;
  handoffId?: string;
  handoffStatus?: string;
  /** Prompt 11 */
  handoffSessionStatus?: string;
  confirmationStatus?: string;
  bookingLifecycle?: string;
  sessionId: string;
  turnId: string;
  requestId?: string;
  sessionVersion?: number;
  timestamp: string;
  stateBefore: string;
  userInput: string;
  normalizedInput: string;
  inputMode: 'TEXT' | 'VOICE';
  intent?: AgentIntent;
  action?: AgentAction;
  confidence?: number;
  detectedChanges: string[];
  toolCalls: Array<{ name: string; arguments: Record<string, any> }>;
  toolExecuted?: Array<{ name: string; ok: boolean; latencyMs: number; provider?: string }>;
  toolResults?: TurnToolRecord[];
  toolResultStatus?: 'ok' | 'error' | 'none';
  pendingInteractionBefore?: string;
  pendingInteractionAfter?: string;
  events?: string[];
  staleResultRejected?: boolean;
  rejectionReason?: string;
  errorCode?: OrchestratorErrorCode;
  assistantResponse?: string;
  llmProvider?: string;
  llmLatencyMs?: number;
  // ---- Prompt 9 observability ----
  bookingReadiness?: { ready: boolean; blockers: string[]; warnings: string[] };
  missingFields?: string[];
  reviewVersion?: number;
  confirmationVersion?: number;
  stateAfter: string;
  latencyMs: number;
}
