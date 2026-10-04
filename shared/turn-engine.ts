/**
 * PROMPT 18 — Conversation turn engine contracts (shared by server + minimal UI).
 *
 * One user message = exactly ONE logical turn, however many LLM rounds / tool calls it needs.
 * Turn status only moves forward; terminal statuses never change again (a COMPLETED turn can never
 * become RUNNING / THINKING again). Every streamed event carries a session-monotonic sequence number
 * so out-of-order / duplicated delivery can never corrupt client state (see reduceTurnEvent).
 */

// ------------------------------------------------------------------ Part 2 — TurnStatus
export const TurnStatus = {
  RECEIVED: 'RECEIVED',
  NORMALIZING: 'NORMALIZING',
  THINKING: 'THINKING',
  TOOL_CALLING: 'TOOL_CALLING',
  WAITING_FOR_TOOL: 'WAITING_FOR_TOOL',
  PROCESSING_TOOL_RESULT: 'PROCESSING_TOOL_RESULT',
  GENERATING_RESPONSE: 'GENERATING_RESPONSE',
  COMPLETED: 'COMPLETED',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  INTERRUPTED: 'INTERRUPTED',
  FAILED: 'FAILED',
  SUPERSEDED: 'SUPERSEDED'
} as const;
export type TurnStatus = typeof TurnStatus[keyof typeof TurnStatus];

/** Terminal: the turn is finished — no further status change is ever accepted. */
export const TERMINAL_TURN_STATUSES: ReadonlySet<TurnStatus> = new Set<TurnStatus>(['COMPLETED', 'WAITING_FOR_USER', 'FAILED', 'SUPERSEDED']);

const ACTIVE: TurnStatus[] = ['THINKING', 'TOOL_CALLING', 'WAITING_FOR_TOOL', 'PROCESSING_TOOL_RESULT', 'GENERATING_RESPONSE'];
const ENDINGS: TurnStatus[] = ['COMPLETED', 'WAITING_FOR_USER', 'FAILED', 'SUPERSEDED', 'INTERRUPTED'];

/**
 * Allowed transitions. The in-turn loop THINKING → TOOL_CALLING → WAITING_FOR_TOOL →
 * PROCESSING_TOOL_RESULT → THINKING (LLM continuation) may repeat; INTERRUPTED (user barged in while
 * the turn was in flight) can still end as SUPERSEDED / COMPLETED / WAITING_FOR_USER / FAILED.
 */
export const TURN_TRANSITIONS: Readonly<Record<TurnStatus, readonly TurnStatus[]>> = Object.freeze({
  RECEIVED: ['NORMALIZING', 'FAILED', 'SUPERSEDED', 'INTERRUPTED'],
  NORMALIZING: ['THINKING', 'GENERATING_RESPONSE', ...ENDINGS],
  THINKING: ['TOOL_CALLING', 'GENERATING_RESPONSE', ...ENDINGS],
  TOOL_CALLING: ['WAITING_FOR_TOOL', 'PROCESSING_TOOL_RESULT', 'GENERATING_RESPONSE', ...ENDINGS],
  WAITING_FOR_TOOL: ['PROCESSING_TOOL_RESULT', 'WAITING_FOR_TOOL', ...ENDINGS],
  PROCESSING_TOOL_RESULT: ['THINKING', 'WAITING_FOR_TOOL', 'TOOL_CALLING', 'GENERATING_RESPONSE', ...ENDINGS],
  GENERATING_RESPONSE: ['COMPLETED', 'WAITING_FOR_USER', 'FAILED', 'SUPERSEDED', 'INTERRUPTED'],
  INTERRUPTED: ['COMPLETED', 'WAITING_FOR_USER', 'FAILED', 'SUPERSEDED', ...ACTIVE],
  COMPLETED: [], WAITING_FOR_USER: [], FAILED: [], SUPERSEDED: []
});

export function canTransitionTurn(from: TurnStatus, to: TurnStatus): boolean {
  return (TURN_TRANSITIONS[from] || []).includes(to);
}

// ------------------------------------------------------------------ Part 19 — pending question codes
export type PendingQuestionCode =
  | 'MISSING_ROUTE' | 'MISSING_DATE' | 'MISSING_PASSENGERS' | 'MISSING_CLASS'
  | 'SELECT_TRAIN' | 'SELECT_CLASS' | 'PASSENGER_DETAILS' | 'REVIEW_APPROVAL' | 'CONFIRM_REVIEW'
  | 'CLARIFICATION';

// ------------------------------------------------------------------ Part 22 — response types
export type AssistantResponseType = 'TEXT' | 'TOOL_PROGRESS' | 'CLARIFICATION' | 'ERROR' | 'CONFIRMATION_REQUEST' | 'FINAL';

export interface AssistantTurnResponse {
  type: AssistantResponseType;
  /** User-facing text only — never tool ids, argument hashes or provider metadata. */
  text: string;
  /** Short spoken variant (VOICE). */
  speechText?: string;
  turnId: string;
  sequence: number;
  /** Prompt 29: progress of an interrupted / superseded turn — stale, never resumed or re-spoken. */
  stale?: boolean;
}

// ------------------------------------------------------------------ Part 23 / 57 — streaming events
export const TURN_EVENT_TYPES = [
  'TURN_STARTED', 'LLM_THINKING', 'LLM_RESPONSE', 'TOOL_REQUESTED', 'TOOL_STARTED', 'TOOL_PROGRESS',
  'TOOL_COMPLETED', 'TOOL_FAILED', 'TOOL_RETRY', 'LLM_CONTINUING', 'ASSISTANT_RESPONSE', 'TURN_COMPLETED',
  'TURN_STATUS', 'TURN_INTERRUPTED', 'TURN_SUPERSEDED', 'PRESENTATION_INTERRUPTED',
  // Prompt 21: grounded natural-response sentence ready for streaming TTS (index-ordered, current turn only)
  'SPEECH_SEGMENT'
] as const;
export type TurnEventType = typeof TURN_EVENT_TYPES[number];

export interface TurnEvent {
  /** Session-monotonic sequence (1, 2, 3 …) — the ordering key for clients. */
  seq: number;
  sessionId: string;
  turnId: string;
  /** Logical turn number within the session. */
  turnSequence: number;
  type: TurnEventType;
  at: string;
  /** Safe, user-presentable data only (tool name, status, progress text) — no arguments / secrets. */
  data?: Record<string, any>;
}

// ------------------------------------------------------------------ Part 1 / 55 — the turn
export type PresentationStatus = 'PENDING' | 'PRESENTED' | 'INTERRUPTED' | 'DISCARDED';
export type GroundingStatus = 'PASSED' | 'RESPONSE_GROUNDING_FAILED' | 'NOT_APPLICABLE';

export interface ConversationTurn {
  sessionId: string;
  turnId: string;
  sequence: number;
  /** Masked (PNR) / redacted (sensitive) — never raw secrets. */
  userInput: string;
  normalizedInput: string;
  inputMode: 'TEXT' | 'VOICE';
  receivedAt: string;
  completedAt: string | null;
  stateBefore: string;
  stateAfter: string | null;
  journeyVersion: number;
  journeyVersionAfter: number | null;
  status: TurnStatus;
  statusHistory: Array<{ status: TurnStatus; at: string }>;
  presentation: PresentationStatus;
  intent: string | null;
  toolCalls: Array<{ tool: string; toolExecutionId: string; status: string; retryOf?: string | null }>;
  toolResults: Array<{ tool: string; ok: boolean; fresh: boolean; errorCode: string | null }>;
  assistantResponse: AssistantTurnResponse | null;
  progress: AssistantTurnResponse[];
  // ---- Part 56 observability ----
  llmLatencyMs: number | null;
  toolCount: number;
  toolExecutionIds: string[];
  totalTurnLatencyMs: number | null;
  finalResponseType: AssistantResponseType | null;
  groundingStatus: GroundingStatus;
  superseded: boolean;
  interrupted: boolean;
  errorCode: string | null;
  /** Rejected (illegal) status transitions — must stay empty; recorded instead of applied. */
  illegalTransitions: string[];
}

/** Part 6 — one node of the per-round dependency graph. */
export interface ToolExecutionPlanNode {
  planNodeId: string;
  callId: string;
  tool: string;
  toolExecutionId: string | null;
  /** planNodeIds this call waits for (e.g. CHECK_AVAILABILITY after SEARCH_TRAINS). */
  dependencies: string[];
  status: 'PLANNED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'REJECTED' | 'BLOCKED' | 'SKIPPED_DUPLICATE' | 'CANCELLED';
  /** Safe summary (PNR masked) — never raw sensitive arguments. */
  arguments: Record<string, string | number>;
  createdAt: string;
  round: number;
}

/** Part 58 / 59 — what a reconnecting client (text or voice) needs to resume the SAME conversation. */
export interface TurnResumeSnapshot {
  sessionId: string;
  bookingState: string;
  pendingQuestion: PendingQuestionCode | null;
  journeyVersion: number;
  currentTurn: { turnId: string; sequence: number; status: TurnStatus; presentation: PresentationStatus } | null;
  latestAssistantResponse: AssistantTurnResponse | null;
  activeToolExecutions: Array<{ tool: string; toolExecutionId: string; status: string }>;
  lastEventSeq: number;
  /** Prompt 19 — booking preparation summary (no PII). */
  bookingPreparation?: import("./booking-preparation").BookingPreparationSummary;
}

// ------------------------------------------------------------------ client-side ordering (Part 57)
export interface TurnStreamView {
  lastSeq: number;
  turnId: string | null;
  turnSequence: number;
  status: TurnStatus | null;
  progressText: string | null;
  activeTools: string[];
}
export const EMPTY_TURN_VIEW: TurnStreamView = Object.freeze({ lastSeq: 0, turnId: null, turnSequence: 0, status: null, progressText: null, activeTools: [] }) as TurnStreamView;

/**
 * Pure reducer for streamed events. Duplicates / out-of-order events (seq ≤ lastSeq) and events from an
 * OLDER turn than the one already shown are ignored, so a late event can never roll the UI back.
 */
export function reduceTurnEvent(view: TurnStreamView, ev: TurnEvent): TurnStreamView {
  if (!ev || ev.seq <= view.lastSeq) return view;
  if (ev.turnSequence < view.turnSequence) return { ...view, lastSeq: ev.seq };
  const sameTurn = ev.turnId === view.turnId;
  const base: TurnStreamView = sameTurn ? { ...view } : { lastSeq: view.lastSeq, turnId: ev.turnId, turnSequence: ev.turnSequence, status: 'RECEIVED', progressText: null, activeTools: [] };
  base.lastSeq = ev.seq;
  const terminal = base.status && TERMINAL_TURN_STATUSES.has(base.status);
  switch (ev.type) {
    case 'TURN_STATUS':
      if (!terminal && ev.data?.status) base.status = ev.data.status as TurnStatus;
      break;
    case 'TOOL_STARTED':
      if (!terminal) base.activeTools = [...base.activeTools.filter(t => t !== ev.data?.tool), String(ev.data?.tool || '')];
      break;
    case 'TOOL_COMPLETED': case 'TOOL_FAILED':
      base.activeTools = base.activeTools.filter(t => t !== ev.data?.tool);
      break;
    case 'TOOL_PROGRESS':
      if (!terminal) base.progressText = String(ev.data?.text || '') || null;
      break;
    case 'TURN_COMPLETED': case 'TURN_SUPERSEDED':
      base.status = (ev.data?.status as TurnStatus) || (ev.type === 'TURN_SUPERSEDED' ? 'SUPERSEDED' : 'COMPLETED');
      base.progressText = null; base.activeTools = [];
      break;
    default: break;
  }
  return base;
}
