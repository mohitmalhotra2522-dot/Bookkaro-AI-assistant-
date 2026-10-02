import type { AIResponse } from '@shared/intents';
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';

export interface AIProviderConfig {
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  modelName?: string;
}

export interface TurnInput {
  userText: string;
  conversationHistory: Array<{ role: string; content: string }>;
  currentState: BookingState;
  context: BookingSession;
  missingFields: string[];
}

/**
 * Pluggable AI Provider interface.
 * All LLM providers must implement this interface; orchestrator never depends
 * on a specific SDK directly. API keys always remain server-side.
 */
export interface AIProvider {
  readonly providerId: string;
  init(config: AIProviderConfig): Promise<void>;
  generateStructuredAction(input: TurnInput): Promise<AIResponse>;
}
