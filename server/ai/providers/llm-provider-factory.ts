/**
 * PROMPT 21/23 — LLM provider selection from SERVER env vars (keys never reach the browser, never logged).
 *   LLM_PROVIDER=openai-compatible  LLM_API_KEY=…  LLM_MODEL=…  [LLM_BASE_URL=https://api.openai.com/v1]
 *   [LLM_TIMEOUT_MS=8000]  [LLM_TOOL_MODE=native|json]
 * No LLM_PROVIDER (or "mock") → MockLLMProvider (offline development / tests).
 * Prompt 23: a real provider that was REQUESTED but is misconfigured (unknown provider, missing key/model, bad URL)
 * fails CLOSED — every turn gets the safe LLM_UNAVAILABLE reply with the session untouched. It is never silently
 * swapped for the mock, another model or a rule-based engine. A configured provider is never replaced at runtime.
 */
import { LLMProviderError, type LLMProvider, type LLMTurnInput, type LLMTurnResult } from './llm-provider';
import { MockLLMProvider } from './mock-llm';
import { OpenAICompatibleLLMProvider, type FetchLike } from './openai-compatible-llm';
import { FallbackLLMProvider, type LLMFallbackState } from './fallback-llm';

export interface LLMProviderSelection {
  provider: LLMProvider;
  /** Safe description for logs / health (never the key). */
  info: { providerId: string; model: string | null; configured: boolean; reason: string; fallback?: LLMFallbackState };
}

/** Prompt 23: stands in for a requested-but-misconfigured real LLM — always unavailable, never answers by itself. */
export class UnavailableLLMProvider implements LLMProvider {
  readonly providerId = 'llm-unavailable';
  readonly modelName: string | null = null;
  constructor(readonly reason: string) {}
  async init(): Promise<void> { /* nothing to initialise */ }
  async generateStructuredDecision(_input: LLMTurnInput): Promise<LLMTurnResult> { throw new LLMProviderError('LLM_NOT_CONFIGURED'); }
  async generateSpokenResponse(): Promise<null> { return null; }
}

export function createLLMProvider(env: Record<string, string | undefined> = {}, o: { fetch?: FetchLike; log?: (e: unknown) => void; now?: () => number } = {}): LLMProviderSelection {
  const kind = String(env.LLM_PROVIDER || 'mock').trim().toLowerCase();
  if (kind === 'mock' || kind === '') {
    const mock = new MockLLMProvider();
    return { provider: mock, info: { providerId: mock.providerId, model: mock.modelName, configured: true, reason: 'DEFAULT_MOCK' } };
  }
  const unavailable = (reason: string): LLMProviderSelection => {
    const p = new UnavailableLLMProvider(reason);
    return { provider: p, info: { providerId: p.providerId, model: null, configured: false, reason } };
  };
  if (kind !== 'openai-compatible' && kind !== 'openai') return unavailable('UNKNOWN_LLM_PROVIDER');
  const apiKey = String(env.LLM_API_KEY || '').trim();
  const model = String(env.LLM_MODEL || '').trim();
  const baseUrl = String(env.LLM_BASE_URL || 'https://api.openai.com/v1').trim();
  if (!apiKey) return unavailable('MISSING_LLM_API_KEY');
  if (!model) return unavailable('MISSING_LLM_MODEL');
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) return unavailable('INVALID_LLM_BASE_URL');
  const t = Number(env.LLM_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(t) && t >= 1000 && t <= 120000 ? t : 8000;   // per-call cap 120 s (slow hosted models, e.g. Muse)
  const toolMode = String(env.LLM_TOOL_MODE || 'native').trim().toLowerCase() === 'json' ? 'json' : 'native';
  // Prompt 22: no hidden rule-based fallback at runtime — a failed remote call yields the safe LLM_UNAVAILABLE reply
  const provider = new OpenAICompatibleLLMProvider({ apiKey, model, baseUrl, timeoutMs, fetch: o.fetch, toolMode });
  // Explicit, user-configured fallback model (same endpoint + key). Unset → the plain provider above, unchanged.
  const fbModel = String(env.LLM_FALLBACK_MODEL || '').trim();
  if (fbModel && fbModel !== model) {
    const ft = Number(env.LLM_FALLBACK_TIMEOUT_MS);
    const fbTimeoutMs = Number.isFinite(ft) && ft >= 1000 && ft <= 120000 ? ft : 60000;
    const cd = Number(env.LLM_FALLBACK_COOLDOWN_MS);
    const cooldownMs = Number.isFinite(cd) && cd >= 0 && cd <= 3600000 ? cd : 300000;
    const fb = new OpenAICompatibleLLMProvider({ apiKey, model: fbModel, baseUrl, timeoutMs: fbTimeoutMs, fetch: o.fetch, toolMode });
    const wrapped = new FallbackLLMProvider(provider, fb, { cooldownMs, log: o.log, now: o.now });
    const info: LLMProviderSelection['info'] = { providerId: provider.providerId, model, configured: true, reason: 'ENV_CONFIGURED' };
    Object.defineProperty(info, 'fallback', { enumerable: true, get: () => wrapped.state });
    return { provider: wrapped, info };
  }
  return { provider, info: { providerId: provider.providerId, model, configured: true, reason: 'ENV_CONFIGURED' } };
}
