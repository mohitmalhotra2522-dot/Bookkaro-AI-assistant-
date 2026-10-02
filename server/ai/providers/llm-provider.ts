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
  error?: { code: string; message: string };
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
}
