/**
 * PROMPT 21 — real, pluggable OpenAI-compatible LLM provider (Chat Completions API: OpenAI, Azure-compatible
 * gateways, OpenRouter, Groq, Together, local vLLM / Ollama …). OFF by default; configured ONLY by server env vars.
 *
 *  - generateStructuredDecision: JSON AgentDecision (+ optional fact-free acknowledgement). The output is untrusted:
 *    the existing decision validators / RailwayToolRuntime / state actions check everything before execution.
 *    Prompt 22: any transport / parse failure throws a normalized LLMProviderError (code + HTTP status only). The
 *    runtime answers with the safe LLM_UNAVAILABLE reply and changes nothing — a deterministic parser NEVER silently
 *    takes over the conversation.
 *  - generateSpokenResponse: natural spoken wording, STREAMED (SSE deltas) — grounded sentence-by-sentence by
 *    NaturalResponseComposer before any of it is spoken.
 * The API key stays server-side, is never logged and is never sent to the browser. `fetch` is injectable (tests).
 */
import { LLMProviderError, isLLMProviderError, type LLMProvider, type LLMTurnInput, type LLMTurnResult, type SpokenResponseInput, type SpokenResponseResult } from './llm-provider';
import type { AgentDecision } from '../decisions/agent-decision';
import { BOOKING_AGENT_SYSTEM_PROMPT, MULTI_TURN_CONTEXT_PROMPT, ACKNOWLEDGEMENT_PROMPT, VOICE_RESPONSE_STYLE_PROMPT } from '../prompts/system-prompt';
import { v4 as uuid } from '../orchestrator/utils';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>; body?: any;
}>;

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetch?: FetchLike;
  temperature?: number;
}

const MAX_TOKENS_DECISION = 700;
const MAX_TOKENS_SPEECH = 180;

export class OpenAICompatibleLLMProvider implements LLMProvider {
  readonly providerId = 'openai-compatible';
  readonly modelName: string;
  private readonly f: FetchLike;
  /** Count of failed remote decision calls (observability only; no content). */
  failedDecisions = 0;

  constructor(private readonly cfg: OpenAICompatibleConfig) {
    this.modelName = cfg.model;
    this.f = cfg.fetch || ((globalThis as any).fetch?.bind(globalThis) as FetchLike);
  }

  async init(): Promise<void> {}

  private endpoint(): string { return `${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`; }
  private headers(): Record<string, string> { return { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` }; }

  private async post(body: any, signal?: AbortSignal) {
    if (!this.f) throw new LLMProviderError('LLM_NETWORK_ERROR');
    const ctrl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort);
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, this.cfg.timeoutMs);
    try {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await this.f(this.endpoint(), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: ctrl.signal });
      } catch {
        throw new LLMProviderError(timedOut ? 'LLM_TIMEOUT' : signal?.aborted ? 'LLM_ABORTED' : 'LLM_NETWORK_ERROR');
      }
      // status only — never the response body, the prompt or the key
      if (!res.ok) throw new LLMProviderError(res.status === 401 || res.status === 403 ? 'LLM_AUTH_ERROR' : res.status === 429 ? 'LLM_RATE_LIMITED' : 'LLM_HTTP_ERROR', res.status);
      return res;
    } finally { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); }
  }

  async generateStructuredDecision(input: LLMTurnInput): Promise<LLMTurnResult> {
    try {
      const tools = input.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }));
      const user = {
        userText: input.userText, inputMode: input.inputMode, state: input.state, missingFields: input.missingFields,
        context: input.context ?? null, currentTurnToolResults: input.currentTurnToolResults ?? [],
        recentMessages: input.history.slice(-8).map(h => ({ role: h.role, content: String(h.content).slice(0, 400) })),
        approvedTools: tools,
        toolCallFormat: 'To request railway data add "toolCalls": [{"name": "<approved tool>", "arguments": {...}}]; omit it otherwise.'
      };
      const res = await this.post({
        model: this.cfg.model, temperature: this.cfg.temperature ?? 0.2, max_tokens: MAX_TOKENS_DECISION,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${BOOKING_AGENT_SYSTEM_PROMPT}\n${MULTI_TURN_CONTEXT_PROMPT}\n${ACKNOWLEDGEMENT_PROMPT}` },
          { role: 'user', content: JSON.stringify(user) }
        ]
      });
      let raw: any;
      try {
        const j = await res.json();
        raw = JSON.parse(String(j?.choices?.[0]?.message?.content ?? ''));
      } catch { throw new LLMProviderError('LLM_BAD_RESPONSE'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new LLMProviderError('LLM_BAD_RESPONSE');
      return { decision: toDecision(raw, input) };
    } catch (e) {
      this.failedDecisions++;
      throw isLLMProviderError(e) ? e : new LLMProviderError('LLM_BAD_RESPONSE');
    }
  }

  async generateSpokenResponse(input: SpokenResponseInput): Promise<SpokenResponseResult | null> {
    const facts = {
      userText: input.userText, outputMode: input.inputMode, language: input.language, backendReply: input.backendReply, pendingQuestion: input.pendingQuestion,
      state: input.session.bookingState, stateBefore: input.stateBefore, error: input.error,
      session: {
        origin: input.session.originName || input.session.origin, destination: input.session.destinationName || input.session.destination,
        date: input.session.date, selectedTrain: (input.session.selectedTrain as any)?.number ?? null, selectedClass: input.session.selectedClass ?? null,
        passengersCount: input.session.passengersCount ?? null
      },
      toolResults: input.toolResults.map(r => ({ tool: r.toolName, ok: r.ok, status: r.status, data: trim(r.data), error: r.error?.code })),
      changes: input.changes, appliedActions: input.appliedActions
    };
    const body = {
      model: this.cfg.model, temperature: this.cfg.temperature ?? 0.6, max_tokens: MAX_TOKENS_SPEECH, stream: !!input.onDelta,
      messages: [{ role: 'system', content: VOICE_RESPONSE_STYLE_PROMPT }, { role: 'user', content: JSON.stringify(facts) }]
    };
    const res = await this.post(body, input.signal);
    try {
    if (body.stream && res.body && typeof res.body.getReader === 'function') {
      // Part 14 — Server-Sent Events: forward content deltas as they arrive
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try { const d = JSON.parse(data)?.choices?.[0]?.delta?.content; if (d) { text += d; input.onDelta!(d); } } catch { /* partial line */ }
        }
      }
      return text.trim() ? { text: text.trim() } : null;
    }
    const j = await res.json();
    const text = String(j?.choices?.[0]?.message?.content || '').trim();
    if (text && input.onDelta) input.onDelta(text);
    return text ? { text } : null;
    } catch (e) { throw isLLMProviderError(e) ? e : new LLMProviderError('LLM_BAD_RESPONSE'); }
  }
}

function trim(v: any, depth = 0): any {
  if (v === null || v === undefined || depth > 4) return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 5).map(x => trim(x, depth + 1));
  if (typeof v === 'object') {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) if (!/(Id$|^id$|At$|requestId|sessionId|version)/i.test(k)) o[k] = trim(x, depth + 1);
    return o;
  }
  return typeof v === 'string' ? v.slice(0, 200) : v;
}

/** Shape-normalise untrusted JSON into an AgentDecision (unknown tools dropped; validators run downstream). */
export function toDecision(raw: any, input: LLMTurnInput): AgentDecision {
  const allowed = new Set(input.tools.map(t => t.name));
  const calls = Array.isArray(raw?.toolCalls) ? raw.toolCalls : [];
  return {
    intent: typeof raw?.intent === 'string' ? raw.intent : 'UNKNOWN',
    action: typeof raw?.action === 'string' ? raw.action : 'NO_ACTION',
    entities: raw?.entities && typeof raw.entities === 'object' ? raw.entities : {},
    missingFields: Array.isArray(raw?.missingFields) ? raw.missingFields.map(String) : [],
    clarification: typeof raw?.clarification === 'string' ? raw.clarification : null,
    confidence: typeof raw?.confidence === 'number' ? raw.confidence : 0.5,
    toolCalls: calls.filter((c: any) => c && allowed.has(c.name)).slice(0, 4)
      .map((c: any) => ({ callId: uuid(), name: c.name, arguments: c.arguments && typeof c.arguments === 'object' ? c.arguments : {} })),
    ...(typeof raw?.finalMessage === 'string' ? { finalMessage: raw.finalMessage } : {}),
    ...(typeof raw?.acknowledgement === 'string' ? { acknowledgement: raw.acknowledgement.slice(0, 160) } : {})
  } as AgentDecision;
}
