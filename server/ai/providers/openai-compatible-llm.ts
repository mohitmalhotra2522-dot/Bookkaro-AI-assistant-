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
import { BOOKING_AGENT_SYSTEM_PROMPT, MULTI_TURN_CONTEXT_PROMPT, ACKNOWLEDGEMENT_PROMPT, VOICE_RESPONSE_STYLE_PROMPT, NATIVE_AGENT_SYSTEM_PROMPT } from '../prompts/system-prompt';
import type { AgentTranscriptStep } from './llm-provider';
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
  /**
   * Prompt 23: 'native' (default) = OpenAI-style function calling — the model receives tool definitions, returns
   * tool_calls, gets tool results back as role:"tool" messages and writes the final answer itself.
   * 'json' = legacy single-JSON AgentDecision (for endpoints without tool-calling support).
   */
  toolMode?: 'native' | 'json';
}

/** Prompt 23: the one non-railway function the agent gets — a PROPOSAL the backend validates (never an execution). */
export const SESSION_UPDATE_TOOL = 'update_booking_session';

const MAX_TOKENS_DECISION = 700;
/** Native agent steps: reasoning models spend part of the budget on hidden reasoning tokens. */
const MAX_TOKENS_AGENT = 1400;
const MAX_TOKENS_SPEECH = 400;
const MAX_TOOL_RESULT_CHARS = 3500;

export class OpenAICompatibleLLMProvider implements LLMProvider {
  readonly providerId = 'openai-compatible';
  readonly modelName: string;
  private readonly f: FetchLike;
  /** Count of failed remote decision calls (observability only; no content). */
  failedDecisions = 0;

  /** Prompt 23: in native mode the agent's own final answer is the reply (validated by the composer). */
  get agentAuthoredReplies(): boolean { return this.toolMode === 'native'; }
  get toolMode(): 'native' | 'json' { return this.cfg.toolMode === 'json' ? 'json' : 'native'; }

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
    return this.toolMode === 'native' ? this.nativeDecision(input) : this.jsonDecision(input);
  }

  /**
   * Prompt 23 — one step of the native agent loop. Messages = system instructions + authoritative session context +
   * recent conversation + the user's message + THIS turn's earlier steps replayed as assistant tool_calls and
   * role:"tool" results (railway results and the backend's validated outcome of each session-update proposal).
   */
  private async nativeDecision(input: LLMTurnInput): Promise<LLMTurnResult> {
    try {
      const res = await this.post({
        model: this.cfg.model, temperature: this.cfg.temperature ?? 0.3, max_tokens: MAX_TOKENS_AGENT,
        messages: buildNativeMessages(input), tools: nativeToolDefs(input), tool_choice: 'auto'
      });
      let msg: any;
      try { msg = (await res.json())?.choices?.[0]?.message; } catch { throw new LLMProviderError('LLM_BAD_RESPONSE'); }
      if (!msg || typeof msg !== 'object') throw new LLMProviderError('LLM_BAD_RESPONSE');
      const d = decisionFromNative(msg, input);
      if (!d) throw new LLMProviderError('LLM_BAD_RESPONSE');
      return { decision: d };
    } catch (e) {
      this.failedDecisions++;
      throw isLLMProviderError(e) ? e : new LLMProviderError('LLM_BAD_RESPONSE');
    }
  }

  private async jsonDecision(input: LLMTurnInput): Promise<LLMTurnResult> {
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
      return cleanReply(text) ? { text: cleanReply(text) } : null;
    }
    const j = await res.json();
    const text = cleanReply(String(j?.choices?.[0]?.message?.content || ''));
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


// ---------------------------------------------------------------------------------------------- Prompt 23: native mode

const STR = (description: string) => ({ type: 'string', description });

/** Railway tools as OpenAI function definitions (the approved, implemented, LLM-callable set) + the session proposal. */
export function nativeToolDefs(input: Pick<LLMTurnInput, 'tools'>): any[] {
  const railway = input.tools.map(t => {
    const props: Record<string, any> = {};
    const required: string[] = [];
    for (const [k, p] of Object.entries(t.parameters || {})) {
      let description = p.description;
      // the backend resolves stations and dates deterministically — the model passes the user's own words
      if (t.name === 'SEARCH_TRAINS' && (k === 'origin' || k === 'destination')) description = 'Station name or code as the user said it (e.g. "Amritsar", "ASR") — the backend resolves it.';
      if (t.name === 'SEARCH_TRAINS' && k === 'date') description = 'Travel date exactly as the user said it ("kal", "parso", "5 Oct") or YYYY-MM-DD — the backend DateResolver resolves it. Never compute dates.';
      props[k] = { type: p.type, description, ...(p.enum ? { enum: p.enum } : {}) };
      if (p.required && t.name === 'SEARCH_TRAINS') required.push(k);
    }
    return { type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', properties: props, required } } };
  });
  const trainRef = { type: 'object', description: 'How the user referred to a train (a PROPOSAL resolved by the backend).', properties: {
    kind: { type: 'string', enum: ['TRAIN_NUMBER', 'DISPLAY_INDEX', 'TIME_PREFERENCE', 'CLASS_PREFERENCE', 'DEMONSTRATIVE', 'PREVIOUS', 'ALTERNATIVE'] },
    value: { type: ['string', 'number'], description: 'e.g. "12014", 2, "MORNING", "AC", "THIS" | "FIRST" | "LAST"' },
    searchResultsVersion: { type: 'number' } }, required: ['kind'] };
  const session = { type: 'function', function: { name: SESSION_UPDATE_TOOL,
    description: 'Propose a change to the booking session (select train/class, change route/date, passengers, review, confirmation, new booking, cancel flow). The backend validates it and returns the outcome; nothing is booked or paid.',
    parameters: { type: 'object', required: ['intent', 'action'], properties: {
      intent: { type: 'string', enum: ['BOOK_TRAIN', 'SEARCH_TRAINS', 'SELECT_TRAIN', 'SELECT_CLASS', 'UPDATE_JOURNEY', 'UPDATE_DATE', 'UPDATE_PASSENGERS', 'COLLECT_PASSENGER_DETAILS', 'SHOW_REVIEW', 'CONFIRM_BOOKING', 'CANCEL_FLOW', 'CANCEL_BOOKING', 'MODIFY_BOOKING', 'CHECK_REFUND_STATUS', 'GENERAL_RAILWAY_QUERY', 'UNKNOWN'] },
      action: { type: 'string', description: 'SELECT_TRAIN | SELECT_CLASS | UPDATE_JOURNEY | UPDATE_DATE | UPDATE_PASSENGERS | SET_PASSENGER_COUNT | UPDATE_PASSENGER | START_PASSENGER_COLLECTION | COLLECT_PASSENGERS | COLLECT_PASSENGER_DETAILS | SHOW_REVIEW | REQUEST_CONFIRMATION | PREPARE_IRCTC_HANDOFF | REFINE_RESULTS | COMPARE_TRAINS | NO_ACTION' },
      entities: { type: 'object', additionalProperties: true, properties: {
        originRaw: STR('origin as said'), destinationRaw: STR('destination as said'), dateRaw: STR('date words as said'),
        preferredTimeRaw: STR('e.g. subah / morning / raat'), preferredClassRaw: STR('e.g. AC / sleeper / CC'),
        trainRef, classRaw: STR('class as said, e.g. "CC", "AC", "sleeper"'),
        passengersCountRaw: STR('passenger count as said'), passengersDelta: { type: 'number' },
        passengerChanges: { type: 'array', items: { type: 'object', properties: { passengerIndex: { type: 'number' }, changes: { type: 'object', properties: {
          name: { type: 'string' }, age: { type: 'number' }, gender: { type: 'string' }, berthPreference: { type: 'string' } } } } } },
        correctionTarget: STR('origin|destination|date|passengers|train|class'), correctionValueRaw: STR('corrected value as said'),
        affirmation: { type: 'boolean' }, newJourney: { type: 'boolean' },
        lifecycleAction: STR('optional booking lifecycle label'), bookingReference: STR('booking reference from context')
      } },
      clarification: STR('optional short question if you need to ask')
    } } } };
  return [...railway, session];
}

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n)}…` : v);

/** Recent conversation (bounded), without the current user message (sent separately) and without tool chatter. */
function conversationOf(input: LLMTurnInput): Array<{ role: 'user' | 'assistant'; content: string }> {
  const h = input.history.filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role as 'user' | 'assistant', content: clip(String(m.content || ''), 600) }));
  if (h.length && h[h.length - 1].role === 'user') h.pop();
  return h.slice(-10);
}

export function buildNativeMessages(input: LLMTurnInput): any[] {
  const ctx = {
    inputMode: input.inputMode, bookingState: input.state, missingFields: input.missingFields,
    context: input.context ?? null
  };
  const messages: any[] = [
    { role: 'system', content: NATIVE_AGENT_SYSTEM_PROMPT },
    { role: 'system', content: `AUTHORITATIVE SESSION CONTEXT (backend; wins over the conversation):\n${clip(JSON.stringify(ctx), 9000)}` },
    ...conversationOf(input),
    { role: 'user', content: input.userText }
  ];
  for (const st of (input.agentTranscript || []) as AgentTranscriptStep[]) {
    const calls: any[] = [];
    if (st.sessionUpdate) calls.push({ id: st.sessionUpdate.callId, type: 'function', function: { name: SESSION_UPDATE_TOOL, arguments: JSON.stringify(st.sessionUpdate.arguments || {}) } });
    for (const c of st.toolCalls) calls.push({ id: c.callId, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } });
    if (!calls.length) continue;
    messages.push({ role: 'assistant', content: st.assistantContent || '', tool_calls: calls });
    if (st.sessionUpdate) {
      const o = st.sessionUpdateOutcome;
      messages.push({ role: 'tool', tool_call_id: st.sessionUpdate.callId, content: clip(JSON.stringify(o ? { ok: !o.error && !o.blocked, ...o } : { ok: false, error: { code: 'NOT_APPLIED' } }), 1500) });
    }
    for (const c of st.toolCalls) {
      const r = st.results.find(x => String(x.callId) === c.callId);
      const content = r
        ? { ok: r.ok, ...(r.ok ? { data: trimResult(r.data) } : { error: { code: (r.error as any)?.code, message: clip(String((r.error as any)?.message || ''), 300) } }) }
        : { ok: false, error: { code: 'NOT_EXECUTED', message: 'Not executed (the session changed first) — decide again from the current context.' } };
      messages.push({ role: 'tool', tool_call_id: c.callId, content: clip(JSON.stringify(content), MAX_TOOL_RESULT_CHARS) });
    }
  }
  return messages;
}

function trimResult(v: any, depth = 0): any {
  if (v === null || v === undefined || depth > 5) return v ?? null;
  if (Array.isArray(v)) return v.slice(0, 12).map(x => trimResult(x, depth + 1));
  if (typeof v === 'object') {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) if (!/(requestId|sessionId|toolExecutionId|provenance|^raw$)/i.test(k)) o[k] = trimResult(x, depth + 1);
    return o;
  }
  return typeof v === 'string' ? clip(v, 240) : v;
}

/** Remove hidden-reasoning wrappers and markdown noise from a model reply (private reasoning is never shown). */
export function cleanReply(text: string): string {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*]\s+/gm, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

const parseArgs = (raw: any): Record<string, any> => {
  if (raw && typeof raw === 'object') return raw;
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
};

/**
 * Native assistant message → AgentDecision. Pure shape transcoding — no interpretation of the user's words:
 *  - content only → final answer;
 *  - update_booking_session → intent/action/entities proposal (+ continueAfterApply so the model sees the outcome);
 *  - railway tool calls → toolCalls (unknown / forbidden names are KEPT so the runtime rejects them visibly).
 */
export function decisionFromNative(msg: any, input: LLMTurnInput): AgentDecision | null {
  const calls: any[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const content = cleanReply(typeof msg.content === 'string' ? msg.content : '');
  if (!calls.length) {
    if (!content) return null;
    return { intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', entities: {}, missingFields: [], clarification: null, confidence: 0.8, toolCalls: [], finalMessage: content } as any;
  }
  const seen = new Set<string>();
  const idOf = (c: any) => { let id = typeof c?.id === 'string' && c.id ? c.id : uuid(); if (seen.has(id)) id = uuid(); seen.add(id); return id; };
  let update: { id: string; args: Record<string, any> } | null = null;
  const toolCalls: any[] = [];
  for (const c of calls.slice(0, 6)) {
    const name = String(c?.function?.name ?? c?.name ?? '');
    const args = parseArgs(c?.function?.arguments ?? c?.arguments);
    if (name === SESSION_UPDATE_TOOL) { if (!update) update = { id: idOf(c), args }; continue; }
    toolCalls.push({ callId: idOf(c), name, arguments: args });
  }
  const ack = content ? content.slice(0, 160) : undefined;
  if (update) {
    const a = update.args;
    return {
      intent: typeof a.intent === 'string' ? a.intent : 'UNKNOWN', action: typeof a.action === 'string' ? a.action : 'NO_ACTION',
      entities: a.entities && typeof a.entities === 'object' && !Array.isArray(a.entities) ? a.entities : {},
      missingFields: [], clarification: typeof a.clarification === 'string' ? a.clarification : null, confidence: 0.8,
      toolCalls, continueAfterApply: true,
      native: { sessionUpdateCallId: update.id, sessionUpdateArgs: a, ...(content ? { assistantContent: content } : {}) },
      ...(ack && toolCalls.length ? { acknowledgement: ack } : {})
    } as any;
  }
  // railway tools only: a search carries the model's own route/date arguments as the journey entities (same shape
  // MockLLM uses), everything else is an information request with no session change
  const search = toolCalls.find(c => c.name === 'SEARCH_TRAINS');
  const sa = search?.arguments || {};
  return {
    intent: search ? 'SEARCH_TRAINS' : 'GENERAL_RAILWAY_QUERY', action: search ? 'SEARCH_TRAINS' : 'NO_ACTION',
    entities: search ? { ...(sa.origin ? { originRaw: String(sa.origin) } : {}), ...(sa.destination ? { destinationRaw: String(sa.destination) } : {}), ...(sa.date ? { dateRaw: String(sa.date) } : {}) } : {},
    missingFields: [], clarification: null, confidence: 0.8, toolCalls,
    ...(content ? { native: { assistantContent: content } } : {}),
    ...(ack ? { acknowledgement: ack } : {})
  } as any;
}
