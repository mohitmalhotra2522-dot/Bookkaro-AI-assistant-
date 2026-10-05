/**
 * Explicit, user-configured LLM fallback model (LLM_FALLBACK_MODEL), e.g. primary meta/muse-glimmer-30b →
 * fallback openai/gpt-oss-20b on the same OpenAI-compatible endpoint (same key / base URL).
 *
 * Visible, never hidden:
 *   - only active when LLM_FALLBACK_MODEL is set (otherwise the plain provider is used, unchanged);
 *   - every switch is logged as {"llm":{"event":"LLM_FALLBACK_USED",from,to,reason}} (codes only — never prompts/keys);
 *   - /api/health shows the fallback model and its live state; turn diagnostics record the model actually used.
 *
 * When: the primary fails with LLM_TIMEOUT / LLM_NETWORK_ERROR / LLM_RATE_LIMITED / LLM_HTTP_ERROR.
 * Never on LLM_ABORTED (user barge-in / cancel), LLM_AUTH_ERROR (same key), LLM_BAD_RESPONSE or LLM_NOT_CONFIGURED.
 * After a primary failure the fallback is used directly for a cooldown window (default 5 min), then the primary is
 * tried again. If the fallback also fails, the error propagates → the normal safe LLM_UNAVAILABLE reply.
 * The fallback's output goes through exactly the same backend validation as the primary's (nothing is trusted more).
 */
import { LLMProviderError, type LLMProvider, type LLMProviderConfig, type LLMTurnInput, type LLMTurnResult,
  type SpokenResponseInput, type SpokenResponseResult } from './llm-provider';

export const LLM_FALLBACK_ERROR_CODES = new Set(['LLM_TIMEOUT', 'LLM_NETWORK_ERROR', 'LLM_RATE_LIMITED', 'LLM_HTTP_ERROR']);

export interface LLMFallbackState {
  model: string;
  cooldownMs: number;
  /** true while calls go straight to the fallback (primary failed recently). */
  active: boolean;
  lastReason: string | null;
  lastSwitchAt: string | null;
  fallbackCalls: number;
}

type NamedProvider = LLMProvider & { modelName?: string | null };

export class FallbackLLMProvider implements LLMProvider {
  readonly providerId: string;
  private until = 0;
  private lastUsed: string | null;
  private readonly st: Omit<LLMFallbackState, 'active'>;

  constructor(private readonly primary: NamedProvider, private readonly fallback: NamedProvider, private readonly o: {
    cooldownMs: number; now?: () => number; log?: (e: unknown) => void;
  }) {
    this.providerId = primary.providerId;
    this.lastUsed = primary.modelName ?? null;
    this.st = { model: String(fallback.modelName ?? ''), cooldownMs: o.cooldownMs, lastReason: null, lastSwitchAt: null, fallbackCalls: 0 };
  }

  get agentAuthoredReplies(): boolean | undefined { return this.primary.agentAuthoredReplies; }
  /** Model used by the most recent call (turn diagnostics read this). */
  get modelName(): string | null { return this.lastUsed; }
  get state(): LLMFallbackState { return { ...this.st, active: this.now() < this.until }; }

  private now() { return (this.o.now ?? Date.now)(); }

  async init(config: LLMProviderConfig): Promise<void> {
    await this.primary.init(config);
    await this.fallback.init(config);
  }

  private async run<T>(call: (p: NamedProvider) => Promise<T>): Promise<T> {
    if (this.now() >= this.until) {
      try {
        const r = await call(this.primary);
        this.lastUsed = this.primary.modelName ?? null;
        return r;
      } catch (e) {
        const code = e instanceof LLMProviderError ? e.code : null;
        if (!code || !LLM_FALLBACK_ERROR_CODES.has(code)) throw e;
        this.until = this.now() + this.o.cooldownMs;
        this.st.lastReason = (e as LLMProviderError).status ? `${code}:${(e as LLMProviderError).status}` : code;
        this.st.lastSwitchAt = new Date(this.now()).toISOString();
        this.o.log?.({ llm: { event: 'LLM_FALLBACK_USED', from: this.primary.modelName ?? null, to: this.fallback.modelName ?? null, reason: this.st.lastReason, cooldownMs: this.o.cooldownMs } });
      }
    }
    this.st.fallbackCalls++;
    this.lastUsed = this.fallback.modelName ?? null;
    return call(this.fallback);
  }

  generateStructuredDecision(input: LLMTurnInput): Promise<LLMTurnResult> {
    return this.run(p => p.generateStructuredDecision(input));
  }

  async generateSpokenResponse(input: SpokenResponseInput): Promise<SpokenResponseResult | null> {
    if (typeof this.primary.generateSpokenResponse !== 'function') return null;
    return this.run(p => (p.generateSpokenResponse ? p.generateSpokenResponse(input) : Promise.resolve(null)));
  }
}
