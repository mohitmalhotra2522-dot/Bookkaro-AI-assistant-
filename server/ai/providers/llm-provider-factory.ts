/**
 * PROMPT 21 — LLM provider selection from SERVER env vars (keys never reach the browser, never logged).
 *   LLM_PROVIDER=openai-compatible  LLM_API_KEY=…  LLM_MODEL=…  [LLM_BASE_URL=https://api.openai.com/v1]  [LLM_TIMEOUT_MS=8000]
 * Default / incomplete config → MockLLMProvider (offline development / tests), with the reason logged at startup.
 * A configured remote provider is NEVER silently replaced by the mock at runtime (Prompt 22).
 */
import type { LLMProvider } from './llm-provider';
import { MockLLMProvider } from './mock-llm';
import { OpenAICompatibleLLMProvider, type FetchLike } from './openai-compatible-llm';

export interface LLMProviderSelection {
  provider: LLMProvider;
  /** Safe description for logs / health (never the key). */
  info: { providerId: string; model: string | null; configured: boolean; reason: string };
}

export function createLLMProvider(env: Record<string, string | undefined> = {}, o: { fetch?: FetchLike } = {}): LLMProviderSelection {
  const mock = new MockLLMProvider();
  const kind = String(env.LLM_PROVIDER || 'mock').trim().toLowerCase();
  if (kind === 'mock' || kind === '') return { provider: mock, info: { providerId: mock.providerId, model: mock.modelName, configured: true, reason: 'DEFAULT_MOCK' } };
  if (kind !== 'openai-compatible' && kind !== 'openai') {
    return { provider: mock, info: { providerId: mock.providerId, model: mock.modelName, configured: false, reason: 'UNKNOWN_PROVIDER_FALLBACK_TO_MOCK' } };
  }
  const apiKey = String(env.LLM_API_KEY || '').trim();
  const model = String(env.LLM_MODEL || '').trim();
  const baseUrl = String(env.LLM_BASE_URL || 'https://api.openai.com/v1').trim();
  if (!apiKey || !model) return { provider: mock, info: { providerId: mock.providerId, model: mock.modelName, configured: false, reason: !apiKey ? 'MISSING_LLM_API_KEY_FALLBACK_TO_MOCK' : 'MISSING_LLM_MODEL_FALLBACK_TO_MOCK' } };
  if (!/^https?:\/\//i.test(baseUrl)) return { provider: mock, info: { providerId: mock.providerId, model: mock.modelName, configured: false, reason: 'INVALID_LLM_BASE_URL_FALLBACK_TO_MOCK' } };
  const t = Number(env.LLM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(t) && t >= 1000 && t <= 60000 ? t : 8000;
  // Prompt 22: no hidden rule-based fallback at runtime — a failed remote call yields the safe LLM_UNAVAILABLE reply
  const provider = new OpenAICompatibleLLMProvider({ apiKey, model, baseUrl, timeoutMs, fetch: o.fetch });
  return { provider, info: { providerId: provider.providerId, model, configured: true, reason: 'ENV_CONFIGURED' } };
}
