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
import type { PostBookingErrorCode } from '@shared/booking-record';
import type { LifecycleActionErrorCode } from '@shared/booking-lifecycle-action';

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
  // Prompt 15: lifecycle INTENTS only — the LLM identifies, the backend validates + executes
  | 'CANCEL_BOOKING'
  | 'MODIFY_BOOKING'
  | 'CHECK_REFUND_STATUS'
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
  // Prompt 19 (Part 35): proposal only — the backend decides whether the preparation transition is valid
  | 'COLLECT_PASSENGERS'
  // Prompt 20 (Part 44): accepted aliases — normalized by normalizeStateAction() before validation
  | 'SET_PASSENGER_COUNT'
  | 'UPDATE_PASSENGER'
  | 'START_PASSENGER_COLLECTION'
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
  /** MIDDLE (Prompt 27, "beech wali") — only when the list has ONE middle train (odd count); otherwise ambiguous */
  | { kind: 'DEMONSTRATIVE'; value: 'FIRST' | 'LAST' | 'THIS' | 'MIDDLE' }
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
  /** Prompt 22: the LLM's interpretation that the user explicitly asked for a NEW / another booking.
   *  A proposal only — the backend grounds it in the user's own words before resetting the journey. */
  newJourney?: boolean;
  /**
   * Prompt 27: WHY a train/class is being selected — INFORMATION (answer an availability / fare question; no booking
   * state is created) or BOOKING (the user wants to book). The LLM's interpretation; the backend only honours it.
   */
  selectionPurpose?: 'INFORMATION' | 'BOOKING';
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
  /** Prompt 19 (Part 13): structured proposal — { passengerIndex (1-based), changes: { name, age, gender, berthPreference } }.
   *  UNTRUSTED: PassengerChangeValidator checks index / field / value before anything reaches BookingSession. */
  passengerChanges?: Array<{ passengerIndex: number; changes: Record<string, unknown> }>;
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
  /**
   * Prompt 21 (Part 3): short conversational acknowledgement spoken while the requested tool runs
   * ("Haan, ek second, 12014 ki availability check karta hoon."). Validated: it may never contain a railway result.
   */
  acknowledgement?: string;
  /**
   * Prompt 23 (native tool calling): the model asked for a booking-session update and expects its outcome before it
   * answers — the runtime applies the proposal and calls the LLM again even when no railway tool was requested.
   */
  continueAfterApply?: boolean;
  /** Prompt 23: provider bookkeeping to replay this step natively (tool_call id of the session update, raw args). */
  native?: { sessionUpdateCallId?: string; sessionUpdateArgs?: Record<string, any>; assistantContent?: string };
  /**
   * Prompt 15: OPTIONAL lifecycle-action label (BookingLifecycleAction enum). Untrusted hint only —
   * parsed against the closed enum (unknown → UNSUPPORTED_ACTION) and never executed on its own.
   */
  lifecycleAction?: string;
  /** Prompt 15: optional natural booking reference ("12014 wali") — resolved by the backend only. */
  bookingReference?: string;
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
  /** Prompt 16 */
  | 'CONTEXT_CONFLICT'
  | 'MISSING_CONTEXT'
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
  // ---- Prompt 17: RailwayToolRuntime ----
  | 'TOOL_LOOP_DETECTED'
  | 'TOOL_NOT_IMPLEMENTED'
  // ---- Prompt 22: the conversational LLM could not be reached / returned unusable output ----
  | 'LLM_UNAVAILABLE'
  | 'FORBIDDEN_ACTION'
  | 'FORBIDDEN_ARGUMENT'
  | 'TOOL_TIMEOUT'
  | 'PROVIDER_DATA_CONFLICT'
  // ---- Prompt 9 ----
  | 'BOOKING_NOT_READY'
  // ---- Prompt 19: booking preparation ----
  | import('@shared/booking-preparation').BookingPreparationErrorCode
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
  | 'BOOKING_DATA_CHANGED'
  // ---- Prompt 14: post-booking / PNR ----
  | PostBookingErrorCode
  | LifecycleActionErrorCode
  | 'LIVE_STATUS_UNAVAILABLE'
  | 'LIVE_STATUS_TIMEOUT'
  | 'LIVE_STATUS_PROVIDER_ERROR';

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
  /** Prompt 17 */
  toolExecutionId?: string;
  executionStatus?: string;
  fresh?: boolean;
}

export interface TurnRecord {
  /** Prompt 17 — RailwayToolRuntime observability. */
  journeyVersion?: number;
  toolExecutions?: import('@shared/railway-tool-runtime').ToolExecutionRecord[];
  toolRounds?: number;
  /** Prompt 18: ToolExecutionPlan nodes (dependency graph; arguments safe/masked). */
  toolPlans?: import('@shared/turn-engine').ToolExecutionPlanNode[];
  /** Prompt 18: ConversationTurnEngine observability (attached by the engine). */
  /** Prompt 19 — booking preparation summary (no PII). */
  bookingPreparation?: import('@shared/booking-preparation').BookingPreparationSummary & {
    preparationPath: string[];
    actionKind?: import('@shared/booking-preparation').AgentActionKind; stateAction?: string | null;
    toolRequested?: string[]; toolExecuted?: string[]; errorType?: string | null;
    toolErrors?: Array<{ tool: string; code: string; type: string | null }>;
  };
  turnEngine?: Record<string, any>;
  freshRequested?: boolean;
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
  /** Prompt 25 Part 17: per-turn diagnostics (counts / codes only). */
  diagnostics?: {
    provider: string; model: string | null; llmCalls: number; agentLlmCalls: number; secondLlmCall: boolean; secondLlmCallReason: string | null;
    toolCalls: number; toolNames: string[]; toolValidationFailures: number; repeatedInvalidCalls: number; retryCount: number;
    latencyMs: number; llmLatencyMs: number;
    validation: { accepted: number; rejected: string[]; repaired: number; claimTypes: Record<string, number>; source: 'LLM' | 'FALLBACK' | null };
    /** Prompt 27: multi-step chain observability (ids / counts / sanitized argument summaries only). */
    chain?: import('@shared/railway-tool-runtime').ToolChainTrace & { sessionId: string; turnId: string; stateBefore: string; stateAfter: string };
    /** Prompt 28: tool-result identity + claim binding observability (no ids shown to users, no text, no secrets). */
    binding?: {
      sessionId: string; turnId: string; llmCallCount: number; toolCallCount: number;
      toolSequence: string[]; toolRequested: string[]; toolArgumentsValidated: number; toolResultIds: string[];
      toolEntity: Array<Record<string, string | number> | null>; entityBindingStatus: 'BOUND' | 'MISMATCH' | 'NONE';
      claimBindingStatus: string; claimBindingCounts: Record<string, number>; crossEntityRejections: string[];
      validationFailures: number; duplicateCallPrevented: boolean; retryCount: number;
      stepLimitReached: boolean; stepLimitReason: string | null; secondCallReason: string | null; latencyMs: number;
    };
    /** Prompt 29: action / progress claim validation (actionType, actionStatus, toolCallId, validationStatus, removalReason). */
    actionClaims?: import('../response/action-claims').ActionClaimDiagnostic[];
  };
  // ---- Prompt 9 observability ----
  bookingReadiness?: { ready: boolean; blockers: string[]; warnings: string[] };
  missingFields?: string[];
  reviewVersion?: number;
  confirmationVersion?: number;
  stateAfter: string;
  // ---- Prompt 16 observability ----
  pendingQuestionBefore?: string | null;
  pendingQuestionAfter?: string | null;
  contextChanges?: Array<{ field: string; kind: string; value: string | number | null; previous: string | number | null; invalidates: string[]; resolvedBy?: string }>;
  rejectedProposals?: Array<{ field: string; code: string }>;
  rejectedClaims?: string[];
  backendActions?: string[];
  /** Prompt 21: VOICE speech provenance (no sentence text). */
  naturalSpeech?: { source: 'LLM' | 'FALLBACK'; language: string; segments: number; rejected: string[]; fallbackReason: string | null };
  resultSetId?: string | null;
  activeJourneyId?: string;
  interruption?: boolean;
  contextBefore?: Readonly<Record<string, any>>;
  contextAfter?: Readonly<Record<string, any>>;
  latencyMs: number;
}
