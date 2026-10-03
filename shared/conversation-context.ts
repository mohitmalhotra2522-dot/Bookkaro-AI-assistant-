/**
 * Prompt 16 — structured conversation context (types only).
 *
 * ConversationContext is a DERIVED, read-only view for conversational resolution. BookingSession
 * stays authoritative for booking state; BookingHistoryStore for booked tickets; RailwayProvider
 * results for railway facts. Nothing here is ever written by the LLM — the LLM only PROPOSES
 * values, which the backend turns into validated ContextPatches.
 */

/** Source-of-truth priority (Part 2) — lower index wins on conflict. */
export const SOURCE_OF_TRUTH_PRIORITY = Object.freeze([
  'RAILWAY_PROVIDER',
  'BOOKING_SESSION',
  'BOOKING_HISTORY_STORE',
  'DETERMINISTIC_RESOLVER',
  'LLM_ENTITIES',
  'RAW_USER_WORDING'
] as const);
export type TruthSource = typeof SOURCE_OF_TRUTH_PRIORITY[number];

/** What the assistant is currently waiting for (question memory, Part 20). */
export type PendingQuestion =
  | 'ASK_ROUTE'
  | 'ASK_ORIGIN'
  | 'ASK_DESTINATION'
  | 'ASK_DATE'
  | 'ASK_PASSENGERS'
  | 'ASK_TRAIN_SELECTION'
  | 'ASK_CLASS'
  | 'ASK_PASSENGER_DETAILS'
  | 'ASK_REVIEW_APPROVAL'
  | 'ASK_CONFIRMATION'
  | 'ASK_STATION_ROLE'
  | 'ASK_STATION_CHOICE'
  | 'ASK_CONTEXT_CONFLICT'
  | 'ASK_CLARIFICATION';

/** Displayed train results (Part 13): display index → actual provider identifiers. */
export interface DisplayedResultsContext {
  resultSetId: string | null;
  version: number;
  createdAt: string | null;
  items: ReadonlyArray<{ displayIndex: number; trainNumber: string; resultId: string | null; departure: string }>;
}

export interface ActiveJourney {
  journeyId: string;
  origin: string | null;
  originName: string | null;
  destination: string | null;
  destinationName: string | null;
  date: string | null;
  passengersCount: number | null;
  preferredClass: string | null;
  preferredTime: string | null;
}

export interface ToolCallMemory { tool: string; at: string }
/** Structured tool memory only (Part 26) — never raw provider payloads, secrets or PNR values. */
export interface ToolResultMemory { tool: string; ok: boolean; resultSetId?: string; count?: number; errorCode?: string; trainNumber?: string }

export interface ConversationContext {
  sessionId: string;
  currentState: string;
  activeJourneyId: string;
  activeJourney: ActiveJourney;
  selectedTrain: string | null;
  selectedClass: string | null;
  displayedResults: DisplayedResultsContext;
  pendingQuestion: PendingQuestion | null;
  pendingConfirmation: boolean;
  pendingAction: string | null;
  missingFields: string[];
  activeBookingId: string | null;
  /** Masked only (12******90) — the raw PNR never enters conversation context. */
  activePnrMasked: string | null;
  lastToolCall: ToolCallMemory | null;
  lastToolResult: ToolResultMemory | null;
  lastUserIntent: string | null;
  lastAssistantIntent: string | null;
}

/** Fields a ContextPatch may target (Part 4/5). Anything else is rejected. */
export type ContextField = 'origin' | 'destination' | 'date' | 'passengersCount' | 'preferredClass' | 'preferredTime' | 'selectedTrain' | 'selectedClass';
export type ContextPatchKind = 'FILL' | 'ANSWER' | 'CORRECTION' | 'NOOP';

export interface ContextPatch {
  patchId: string;
  field: ContextField;
  /** What the LLM proposed (untrusted). */
  proposed: string;
  /** Canonical value after deterministic resolution (station code / ISO date / count). */
  value: string | number | null;
  previous: string | number | null;
  source: 'LLM' | 'RESOLVER';
  kind: ContextPatchKind;
  /** Dependent facts this patch invalidates (DEPENDENCY_RULES). */
  invalidates: readonly string[];
  /** Resolver that produced `value` (StationResolver / DateResolver / …). */
  resolvedBy?: string;
}

export interface RejectedPatch { field: string; proposed: string; code: ConversationErrorCode | 'UNGROUNDED_VALUE' | 'LLM_DATE_OVERRIDDEN'; reason: string }

/** Recovery codes (Part 46). Existing project codes map onto these (see toRecoveryCode). */
export type ConversationErrorCode =
  | 'INVALID_LLM_OUTPUT'
  | 'UNKNOWN_INTENT'
  | 'AMBIGUOUS_ROUTE'
  | 'AMBIGUOUS_STATION'
  | 'AMBIGUOUS_DATE'
  | 'INVALID_TRAIN_REFERENCE'
  | 'INVALID_CLASS_REFERENCE'
  | 'STALE_RESULT_REFERENCE'
  | 'MISSING_CONTEXT'
  | 'CONTEXT_CONFLICT'
  | 'TOOL_REJECTED'
  | 'TOOL_FAILED'
  | 'BOOKING_NOT_FOUND'
  | 'ACTION_NOT_ALLOWED';

/** Structured assistant response (Part 42). speechText contains only validated facts. */
export interface AssistantResponse {
  text: string;
  speechText: string;
  mode: 'TEXT' | 'VOICE';
  state: string;
  pendingQuestion: PendingQuestion | null;
  displayData: Array<{ type: string; data: any }>;
  toolResults: Array<{ tool: string; ok: boolean; errorCode?: string }>;
  clarification: string | null;
  requiresConfirmation: boolean;
  error: { code: string; recoveryCode: ConversationErrorCode | null; message: string } | null;
  /** Facts the backend removed from LLM wording this turn (invented train / fare / PNR …). */
  rejectedClaims: string[];
}
