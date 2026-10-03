import type { AgentDecision } from '../decisions/agent-decision';
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';
import type { ToolDefinition } from '../tools/tool-registry';
import type { LLMContext } from '../context/context-builder';

/** A tool result produced earlier in THIS turn's loop (what the LLM reacts to). */
export interface TurnToolResultView {
  toolName: string;
  callId: string;
  ok: boolean;
  data?: any;
  error?: { code: string; message: string; details?: any };
  /** Prompt 17: SUCCEEDED with zero items (e.g. no trains on the route) — NOT a failure. */
  empty?: boolean;
  /** Prompt 17: tool execution status (SUCCEEDED / FAILED / TIMEOUT / REJECTED …). */
  status?: string;
}

export interface LLMProviderConfig {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
}

export interface LLMTurnInput {
  userText: string;
  history: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolName?: string }>;
  state: BookingState;
  session: Readonly<BookingSession>;
  missingFields: string[];
  inputMode: 'TEXT' | 'VOICE';
  /** Tools that are currently registered and available to be called. */
  tools: ToolDefinition[];
  /** Structured, authoritative context (session view, pending interaction,
   *  versioned search results, compressed summary). Rebuilt every call. */
  context?: LLMContext;
  /** Tool results already produced in the CURRENT turn (multi-step chain). */
  currentTurnToolResults?: TurnToolResultView[];
}

/**
 * PROMPT 21 — natural spoken response (Parts 2, 16, 17). Called AFTER the turn's tools and state actions were applied,
 * so the LLM words the reply from the authoritative post-turn BookingSession + this turn's verified tool results +
 * the backend's own (deterministic, authoritative) reply. The output is never trusted: NaturalResponseComposer
 * grounds every sentence and falls back to the backend reply.
 */
export interface SpokenResponseInput {
  userText: string;
  inputMode: 'TEXT' | 'VOICE';
  /** Detected speaking style of the user (reply in the same style; no forced translation). */
  language: 'HINGLISH' | 'HINDI' | 'ENGLISH';
  /** Authoritative state AFTER this turn. */
  session: Readonly<BookingSession>;
  stateBefore: BookingState;
  reviewVersionBefore: number | null;
  selectedTrainBefore: string | null;
  selectedClassBefore: string | null;
  passengersCountBefore: number | null;
  /** The backend's next question (authoritative), if any. */
  pendingQuestion: string | null;
  pendingQuestionCode: string | null;
  /** The backend's deterministic reply for this turn — the facts that must be conveyed. */
  backendReply: string;
  /** This turn's railway tool results (authoritative provider data / validated errors). */
  toolResults: TurnToolResultView[];
  /** Backend actions applied this turn (e.g. TRAIN_SELECTED, PASSENGER_UPDATED). */
  appliedActions: string[];
  /** Journey fields changed this turn; corrected = it replaced an earlier value (e.g. "kal nahi parso"). */
  changes: Array<{ field: string; corrected: boolean }>;
  error: { code: string; message: string } | null;
  history: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
  /** Streaming: called with text deltas as they arrive (providers that support streaming). */
  onDelta?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface SpokenResponseResult { text: string }

export interface LLMTurnResult {
  /** Either a list of tool calls to execute, OR a final assistant message. */
  decision: AgentDecision;
}

/**
 * LLMProvider — provider-independent abstraction for the conversational
 * decision-maker / tool-calling agent. Implementations are expected to:
 *  - Honour the system prompt (railway facts only from tool results)
 *  - Return a strict AgentDecision (optionally with toolCalls)
 *  - NEVER call RailwayProvider / mutate session
 */
export interface LLMProvider {
  readonly providerId: string;
  init(config: LLMProviderConfig): Promise<void>;
  /** One LLM step: given the current turn input (+ any prior tool results
   *  appended to history), return the next AgentDecision (tool calls or final). */
  generateStructuredDecision(input: LLMTurnInput): Promise<LLMTurnResult>;
  /** Prompt 21 (optional): word the final spoken reply; null → the backend reply is used. */
  generateSpokenResponse?(input: SpokenResponseInput): Promise<SpokenResponseResult | null>;
}

/**
 * PROMPT 22 — normalized LLM provider failure. Carries ONLY a code (+ HTTP status): never the request,
 * the response body, the prompt or the API key. The runtime turns it into the safe LLM_UNAVAILABLE reply;
 * no deterministic parser silently takes over the conversation.
 */
export type LLMProviderErrorCode =
  | 'LLM_TIMEOUT' | 'LLM_NETWORK_ERROR' | 'LLM_AUTH_ERROR' | 'LLM_RATE_LIMITED' | 'LLM_HTTP_ERROR' | 'LLM_BAD_RESPONSE' | 'LLM_ABORTED';
export class LLMProviderError extends Error {
  readonly code: LLMProviderErrorCode;
  readonly status?: number;
  constructor(code: LLMProviderErrorCode, status?: number) {
    super(status ? `${code}:${status}` : code);
    this.name = 'LLMProviderError';
    this.code = code;
    if (status) this.status = status;
  }
}
export const isLLMProviderError = (e: unknown): e is LLMProviderError => !!e && (e as any).name === 'LLMProviderError' && typeof (e as any).code === 'string';

/** Prompt 22: the ONLY reply when the conversational LLM fails (fixed safety text; no state change, no guessing). */
export const LLM_UNAVAILABLE_MESSAGE = 'Maaf kijiye, main abhi jawab nahi de paa raha. Aapki booking details safe hain — thodi der mein dobara boliye.';
