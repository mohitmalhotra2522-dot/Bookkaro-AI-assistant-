import { getWebResearchService } from '../../research/web-research-service';
/**
 * LLMToolCallingRuntime — the real multi-step tool-calling loop.
 *
 * Pipeline:
 *   user message + history + session snapshot
 *     ↓
 *   LLM.generateStructuredDecision (with registered tools in prompt)
 *     ↓
 *   for each emitted tool call:
 *     - ToolCallValidator validates (types/required/route/date/state)
 *     - Executes via RailwayToolService / RailwaySearchOrchestrator (fresh data, no cache)
 *     - Normalizes result → NormalizedToolResult
 *     - Appends 'tool' message to history
 *   repeat (bounded by MAX_TOOL_CALL_ITERATIONS) until LLM emits no more tool calls
 *     ↓
 *   Returns: final LLM message + list of tool execution records
 *
 * The runtime NEVER lets the LLM directly mutate BookingSession and NEVER
 * invents railway facts. All railway data comes from RailwayProvider via
 * normalized tool results.
 */
import { toolOutcomeOf } from '../tool-runtime/tool-outcome';
import type { LLMProvider } from '../providers/llm-provider';
import { isLLMProviderError, LLM_UNAVAILABLE_MESSAGE, type AgentTranscriptStep, type SessionUpdateOutcomeView } from '../providers/llm-provider';
import type { AgentDecision, OrchestratorError, TurnRecord } from '../decisions/agent-decision';
import type { ToolCall, ToolDefinition } from '../tools/tool-registry';
import { REGISTERED_TOOLS } from '../tools/tool-registry';
import { providerToolCatalog } from '../tools/provider-tools';

/** P37: the tool list the LLM sees — provider-level tools when connectors are registered, else the canonical set. */
export function exposedTools(): ToolDefinition[] {
  return providerToolCatalog.enabled() ? providerToolCatalog.definitions(REGISTERED_TOOLS) : REGISTERED_TOOLS;
}

/**
 * P37: provider tool call (`railcore_search`) → the canonical validated contract (SEARCH_TRAINS) + the provider the LLM
 * chose. Pure name mapping — the provider decision stays exactly as the LLM made it. Not-implemented providers are
 * marked so the gateway answers PROVIDER_NOT_IMPLEMENTED (never a fabricated result).
 */
export function mapProviderToolCall(tc: ToolCall): ToolCall {
  if (!tc || !providerToolCatalog.enabled()) return tc;
  const r = providerToolCatalog.resolve(tc.name);
  if (!r) return tc;
  if (r.kind === 'PROVIDER_TOOL') return { ...tc, name: r.canonical, provider: r.provider, toolName: String(tc.name) };
  return { ...tc, toolName: String(tc.name), providerNotImplemented: r.provider };
}
import { ToolCallValidator, type ValidatedToolCall } from '../tools/tool-call-validator';
import { RailwayToolService } from '../../railway/tools/railway-tool-service';
import { RailwaySearchOrchestrator } from '../../railway/orchestrator/search-orchestrator';
import type { BookingSession, BookingEventType } from '@shared/entities';
import { BookingState } from '@shared/states';
import type { TurnToolResultView } from '../providers/llm-provider';
import type { LLMContext } from '../context/context-builder';
import type { ApplyOutcome } from '../context/turn-applier';
import { v4 as uuidv4 } from '../orchestrator/utils';
import type { ToolGrounding } from '../../booking/post-booking/post-booking-service';
import { PnrStatusService, LiveTrainStatusService } from '../../booking/post-booking/pnr-status-service';
import { maskPnr } from '../../booking/post-booking/pnr-validator';
import { RailwayToolRuntime, ToolTurn, type ExecutedCall, type PreparedCall, type RailwayToolExecutor, type ToolObserver } from '../tool-runtime/railway-tool-runtime';
import type { ToolExecutionPlanNode } from '@shared/turn-engine';
import type { ToolExecutionRecord, LLMToolResult, ToolExecutionStatus, ToolChainTrace, ToolChainStopReason } from '@shared/railway-tool-runtime';
import { MAX_TOOL_STEPS_PER_TURN, MAX_TOOL_ROUNDS_PER_TURN } from '../tool-runtime/railway-tool-runtime';
import { buildToolResultIdentity, resultRef, structuredToolError, type ToolResultIdentity } from '../tool-runtime/tool-result-identity';

export const MAX_TOOL_CALL_ITERATIONS = 8; // deterministic hard cap (configurable via constructor)
/** Prompt 23: rejected session-update proposals a native agent may react to within one turn. */
const MAX_NATIVE_RECOVERIES = 2;
/** Prompt 23: rejections that always end the turn with the backend's own wording (never agent recovery). */
/** Prompt 27: rejections that are safety boundaries (chain stop reason SAFETY_BLOCKED). */
const SAFETY_STOP_CODES = new Set(['FORBIDDEN_ACTION', 'SENSITIVE_DATA_REJECTED', 'SENSITIVE_REQUEST_REJECTED', 'BOOKING_ACCESS_DENIED',
  'BOOKING_EXECUTION_DISABLED', 'BOOKING_EXECUTION_DUPLICATE', 'CONFIRMATION_REQUIRED', 'UNSUPPORTED_ACTION']);
/** Prompt 27: the one tools-disabled call after a budget / loop stop. */
const CHAIN_STOP_INSTRUCTION = 'The backend stopped the tool chain (step budget or repeated-call guard). Tools are disabled now. '
  + 'Answer the user ONLY from the authoritative tool results already in this turn. If something the user asked for could not be checked, say so plainly. '
  + 'Never guess or invent railway data. Do not request any tool.';
const NATIVE_FINAL_ERRORS = new Set(['SENSITIVE_DATA_REJECTED', 'SENSITIVE_REQUEST_REJECTED', 'BOOKING_ACCESS_DENIED', 'SESSION_VERSION_CONFLICT', 'STALE_TOOL_RESULT', 'INVALID_LLM_OUTPUT']);

export interface NormalizedToolResult {
  toolName: string;
  callId: string;
  success: boolean;
  data?: any;
  error?: { code: string; message: string; details?: any };
  provider?: string;
  timestamp: string;
  latencyMs: number;
  /** sessionId / requestId / sessionVersion (at call time) / retrievedAt. */
  provenance?: { sessionId: string; requestId?: string; sessionVersion: number; retrievedAt: string; journeyVersion?: number; toolExecutionId?: string };
  /** Prompt 17: execution id / lifecycle status / freshness / SUCCESS-with-zero-items. */
  toolExecutionId?: string;
  status?: ToolExecutionStatus;
  fresh?: boolean;
  empty?: boolean;
  normalizedErrorCode?: string;
  /** Prompt 28: authoritative identity (train / date / class / route / provider) — built from validated args + result. */
  identity?: ToolResultIdentity;
  /** Prompt 28: per-turn result reference the LLM sees (`fare-2`) — never user-facing. */
  resultRef?: string;
}

export interface ToolCallStep {
  toolCall: ToolCall;
  result: NormalizedToolResult;
  iteration: number;
  /** Canonical arguments after ToolCallValidator (absent if rejected). */
  validatedArguments?: Record<string, any>;
  /** 'rejected' = validator blocked it (provider NOT called); 'stale' = result dropped. */
  status: 'ok' | 'error' | 'rejected' | 'stale';
  /** Correlation ids for interruption safety. */
  requestId?: string;
  /** Prompt 17: execution record (observability) + the exact LLMToolResult returned to the LLM. */
  execution?: ToolExecutionRecord;
  llmResult?: LLMToolResult;
  /** Prompt 32: provider identity from the provider's own meta ('MOCK' | 'LIVE'; null = no provider response). */
  dataSource?: 'MOCK' | 'LIVE' | 'WEB_EXTERNAL' | null;
}

/**
 * Per-turn hooks supplied by the orchestrator. They keep the runtime free of
 * session-mutation policy while letting it:
 *   - apply each LLM decision deterministically BEFORE its tool calls,
 *   - stop when the request became obsolete (newer turn started),
 *   - rebuild authoritative LLM context each iteration,
 *   - emit typed events.
 */
export interface RuntimeHooks {
  applyDecision?: (d: AgentDecision) => ApplyOutcome;
  isStale?: () => boolean;
  buildContext?: () => LLMContext;
  emit?: (type: BookingEventType, data?: Record<string, any>) => void;
  requestId?: string;
  /** Prompt 14: grounding for CHECK_PNR / TRACK_TRAIN (user's words + this session's booking records). */
  grounding?: (userText: string) => ToolGrounding;
  /** Prompt 14: audit callback for the read-only live tools (no session / booking mutation). */
  onLiveTool?: (phase: 'REQUESTED' | 'RESULT', name: string, args: Record<string, any>, result?: { success: boolean; error?: { code: string } }) => void;
  /** Prompt 17: correlation ids for execution records. */
  sessionId?: string;
  turnId?: string;
  /** Prompt 17: the user explicitly asked for fresh / re-checked data this turn (recorded; never cached anyway). */
  forceFresh?: boolean;
  /** Prompt 18: turn-engine observer (LLM rounds + tool execution lifecycle → streaming events). */
  observer?: TurnLoopObserver;
}

/** Prompt 18: loop observer — status / streaming only; it can never change the loop or the session. */
export interface TurnLoopObserver extends ToolObserver {
  onLLM?: (phase: 'start' | 'end', round: number, info?: { toolCalls: number; final: boolean; acknowledgement?: string }) => void;
}

function stableJson(v: any): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

export interface ToolRuntimeResult {
  /** Final assistant message produced by the LLM after the loop. */
  finalMessage: string;
  /** The final AgentDecision (intent/action/entities for session synchronization). */
  finalDecision: AgentDecision;
  /** Ordered list of all executed tool calls and their results. */
  steps: ToolCallStep[];
  /** Reason the loop ended. 'blocked' = decision context could not be applied; 'stale' = obsolete request. */
  stopReason: 'final' | 'tool_limit' | 'error' | 'blocked' | 'stale';
  /** Outcome of applying each LLM decision to the session (in order). */
  applyOutcomes: ApplyOutcome[];
  /** Total time spent inside LLM calls. */
  llmLatencyMs: number;
  /** If stopReason='error' or tool_limit, a structured error. */
  error?: OrchestratorError;
  /** Prompt 16: identical tool calls skipped within this turn (result already attached). */
  deduplicated?: number;
  /** Total loop latency (ms). */
  latencyMs: number;
  /** Prompt 17: every tool execution record of this turn (LLM + deterministic prep). */
  toolExecutions?: ToolExecutionRecord[];
  /** Prompt 17: LLM rounds that requested tools. */
  toolRounds?: number;
  /** Prompt 18: ToolExecutionPlan nodes (dependency graph) of every round in this turn. */
  toolPlans?: ToolExecutionPlanNode[];
  /** Prompt 27: chain observability (chainId, ordered tool steps with provenance ids, counts, stop reason). */
  chain?: ToolChainTrace;
  /** Prompt 25 Part 17: agent decision calls made in this turn (each one is an LLM request). */
  llmCalls?: number;
  /** Prompt 25 Part 17: tool-argument validation failures / identical invalid repeats / corrected retries. */
  toolValidation?: { failures: number; repeatedInvalid: number; correctedRetries: number; coerced: number };
}

export interface RuntimeInput {
  sessionId: string;
  userText: string;
  mode: 'TEXT' | 'VOICE';
  /** Getter for current BookingSession (mutable; runtime may commit patches). */
  getSession: () => BookingSession;
  /** Commits a patch to BookingSession. */
  commitSession: (patch: Partial<BookingSession>) => void;
}

/**
 * History message type used internally by the runtime. Matches LLMProvider's
 * role union: user | assistant | tool.
 */
type HistoryMsg = { role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolName?: string };

/** Prompt 28: chain-step view of a result identity (entity summary + binding status; no ids). */
function identityStep(id?: ToolResultIdentity): { toolEntity?: Record<string, string | number>; entityBindingStatus?: string } {
  if (!id) return {};
  const e: Record<string, string | number> = {};
  for (const k of ['trainNumber', 'origin', 'destination', 'date', 'travelClass'] as const) if (id[k]) e[k === 'travelClass' ? 'class' : k] = id[k] as string;
  return { ...(Object.keys(e).length ? { toolEntity: e } : {}), entityBindingStatus: id.binding };
}

export class LLMToolCallingRuntime {
  private validator = new ToolCallValidator();
  private searchOrch: RailwaySearchOrchestrator;

  constructor(
    private readonly llm: LLMProvider,
    private readonly tools: RailwayToolService,
    private readonly maxIterations: number = MAX_TOOL_CALL_ITERATIONS,
    sessionGetter?: () => BookingSession,
    sessionCommitter?: (p: Partial<BookingSession>) => void,
    /** Prompt 17: the RailwayToolRuntime every LLM tool call goes through (configurable for tests). */
    public toolRuntime: RailwayToolRuntime = new RailwayToolRuntime()
  ) {
    const getter = sessionGetter || (() => { throw new Error('No session getter bound'); });
    const committer = sessionCommitter || (() => {});
    this.searchOrch = new RailwaySearchOrchestrator(getter, committer);
  }

  /**
   * Bind this runtime instance to a specific session getter/committer for the
   * duration of a turn. Returns a bound runner you can call .run() on.
   */
  bind(getSession: () => BookingSession, commitSession: (p: Partial<BookingSession>) => void, hooks: RuntimeHooks = {}): BoundToolRuntime {
    return new BoundToolRuntime(this.llm, this.tools, this.validator, this.searchOrch, this.maxIterations, getSession, commitSession, hooks, this.toolRuntime);
  }
}

export class BoundToolRuntime {
  private searchOrch: RailwaySearchOrchestrator;
  private readonly pnr: PnrStatusService;
  private readonly live: LiveTrainStatusService;
  /** The user's own words this turn (grounding for PNR / train values). */
  private userText = '';
  /** P37: provider the LLM chose most recently in this turn (backend booking re-validation reuses it — no failover). */
  private lastProvider?: string;
  /** Prompt 28: per-turn result sequence → `fare-2` style references for the LLM */
  private resultSeq = 0;
  /** Prompt 14: tools permitted by the latest applied decision (undefined = no restriction). */
  private allowedTools?: readonly string[];
  /** Prompt 17: per-turn RailwayToolRuntime state (budget, loop detector, execution records). */
  readonly turn: ToolTurn;
  private readonly turnCtx: { userText: string };
  private readonly executor: RailwayToolExecutor;
  constructor(
    private readonly llm: LLMProvider,
    private readonly tools: RailwayToolService,
    private readonly validator: ToolCallValidator,
    baseSearchOrch: RailwaySearchOrchestrator,
    private readonly maxIterations: number,
    private readonly getSession: () => BookingSession,
    private readonly commitSession: (p: Partial<BookingSession>) => void,
    private readonly hooks: RuntimeHooks = {},
    toolRuntime: RailwayToolRuntime = new RailwayToolRuntime()
  ) {
    // Reuse the same class but bound to this turn's getter/committer so
    // RailwaySearchOrchestrator.invalidateDependentResults() & commits work.
    this.searchOrch = new RailwaySearchOrchestrator(getSession, commitSession);
    this.pnr = new PnrStatusService(tools);
    this.live = new LiveTrainStatusService(tools);
    const self = this;
    this.turnCtx = { userText: '' };
    const ctx = this.turnCtx;
    this.turn = toolRuntime.beginTurn({
      get sessionId() { return hooks.sessionId || self.getSession().sessionId; },
      turnId: hooks.turnId || 'turn',
      requestId: hooks.requestId,
      get userText() { return ctx.userText; },
      getSession: () => self.getSession(),
      validate: (tc: ToolCall, s: BookingSession) => self.validator.validate(tc, s, self.hooks.grounding?.(ctx.userText)) as any,
      allowedTools: () => self.allowedTools,
      isStale: () => !!self.hooks.isStale?.(),
      forceFresh: !!hooks.forceFresh,
      observer: hooks.observer
    } as any);
    this.executor = { providerLabel: tools.providerLabel, execute: (vt, guard) => this.executeTool(vt, guard) };
  }

  async run(userText: string, mode: 'TEXT'|'VOICE', history: HistoryMsg[]): Promise<ToolRuntimeResult> {
    const startedAt = Date.now();
    const steps: ToolCallStep[] = [];
    const applyOutcomes: ApplyOutcome[] = [];
    const turnResults: TurnToolResultView[] = [];
    const localHistory: HistoryMsg[] = [...history];
    // Prompt 23: the agent's own steps this turn (replayed natively as assistant tool_calls + tool results)
    const transcript: AgentTranscriptStep[] = [];
    const outcomeView = (o: ApplyOutcome): SessionUpdateOutcomeView => ({
      applied: [...(o.applied || [])], notes: [...(o.notes || []), ...(o.directAnswer ? [o.directAnswer] : [])].map(n => String(n).slice(0, 400)),
      ...(o.error ? { error: { code: String(o.error.code), message: String(o.error.message || '').slice(0, 300) } } : {}),
      ...(o.replan ? { replan: true } : {}), ...(o.blockTools ? { blocked: true } : {})
    });
    let lastDecision: AgentDecision | null = null;
    let nativeRecoveries = 0;
    let lastError: OrchestratorError | undefined;
    let llmLatencyMs = 0;
    let llmCalls = 0;
    const H = this.hooks;
    this.userText = userText;
    this.turnCtx.userText = userText;
    // Prompt 16: in-turn dedup — an identical call (same tool + args + session context) whose valid
    // result is already attached to THIS turn is not sent again. Each new turn always calls the provider
    // fresh (no cross-turn cache), so explicit live requests ("abhi availability", "latest PNR") stay fresh.
    const doneCalls = new Map<string, TurnToolResultView>();
    this.resultSeq = 0;
    let deduplicated = 0;
    const sigOf = (tc: ToolCall) => {
      // Prompt 17: a search is fully determined by its arguments (and SEARCH_TRAINS is a parallel barrier,
      // so the session changes between the original and its duplicate) → args-only signature
      const pv = tc?.provider ? `${tc.provider}:` : '';   // P37: same request on another provider is a different call
      if (tc?.name === 'SEARCH_TRAINS') return `${pv}SEARCH_TRAINS|${stableJson(tc?.arguments || {})}`;
      const sx: any = this.getSession();
      const t: any = sx.selectedTrain;
      return `${pv}${tc?.name}|${stableJson(tc?.arguments || {})}|${t?.number || t?.trainNumber || ''}|${sx.selectedClass || ''}|${sx.origin || ''}|${sx.destination || ''}|${sx.date || ''}|${sx.passengersCount || ''}`;
    };
    // Prompt 25 Part 9: same VALIDATED request (e.g. trainNumber 12497 vs "12497" + the selected class) → not re-fetched
    const doneValidated = new Map<string, TurnToolResultView>();
    const vSig = (vt: { name: string; arguments: Record<string, any> }, provider?: string) => {
      const sx: any = this.getSession(); const t: any = sx.selectedTrain;
      return `${provider || ''}:${vt.name}|${stableJson(vt.arguments || {})}|${t?.number || t?.trainNumber || ''}|${sx.selectedClass || ''}|${sx.origin || ''}|${sx.destination || ''}|${sx.date || ''}|${sx.passengersCount || ''}`;
    };
    // ---- Prompt 27: chain observability — every tool step keeps its own provenance id (toolExecutionId) ----
    const chainId = `ch_${uuidv4()}`;
    const recLlmCall = new Map<string, number>();
    const markRecords = (from: number) => { for (const r of this.turn.records.slice(from)) if (!recLlmCall.has(r.toolExecutionId)) recLlmCall.set(r.toolExecutionId, llmCalls); };
    let stopOverride: ToolChainStopReason | null = null;
    let answeredAfterStop = false;
    const stopReasonOf = (stopReason: ToolRuntimeResult['stopReason'], error: OrchestratorError | undefined, finalMessage: string): ToolChainStopReason => {
      if (stopOverride) return stopOverride;
      const code = String(error?.code || '');
      if (stopReason === 'stale') return 'STALE';
      if (stopReason === 'tool_limit') return code === 'TOOL_LOOP_DETECTED' ? 'TOOL_LOOP_DETECTED' : 'TOOL_BUDGET_EXHAUSTED';
      if (stopReason === 'blocked') return SAFETY_STOP_CODES.has(code) ? 'SAFETY_BLOCKED' : 'VALIDATION_BLOCKED';
      if (stopReason === 'error') return code === 'LLM_UNAVAILABLE' ? ((error as any)?.details?.reason === 'LLM_BAD_RESPONSE' ? 'INVALID_DECISION' : 'LLM_UNAVAILABLE') : 'TOOL_FAILED';
      const recs = this.turn.records.filter(r => recLlmCall.has(r.toolExecutionId));
      if (recs.some(r => r.rejectionReason === 'FORBIDDEN_ACTION' || (r.rejectionReason === 'UNKNOWN_TOOL' && /forbid/i.test(String((r as any).normalizedError || ''))))) return 'SAFETY_BLOCKED';
      const last = turnResults[turnResults.length - 1];
      if (last && !last.ok && (last.error as any)?.code === 'TOOL_NOT_IMPLEMENTED') return 'TOOL_UNAVAILABLE';
      if (!finalMessage && lastDecision?.clarification) return 'CLARIFICATION';
      if (lastDecision?.clarification && !lastDecision.finalMessage) return 'CLARIFICATION';
      return 'FINAL_RESPONSE';
    };
    const chainOf = (stopReason: ToolRuntimeResult['stopReason'], error: OrchestratorError | undefined, finalMessage: string): ToolChainTrace => {
      const recs = this.turn.records.filter(r => recLlmCall.has(r.toolExecutionId));
      const chainSteps = recs.map((r, i) => ({
        stepNumber: i + 1, llmCall: recLlmCall.get(r.toolExecutionId) || 0, toolName: r.tool, toolArgumentsSanitized: { ...(r.argumentsSummary || {}) },
        toolResultStatus: String(r.status), toolResultId: r.toolExecutionId,
        decisionReason: r.rejectionReason === 'DUPLICATE_CALL' ? 'DEDUPLICATED' : r.retryOf ? 'BACKEND_RETRY' : r.llmRetry ? 'LLM_RETRY'
          : r.status === 'REJECTED' ? `REJECTED:${r.rejectionReason || 'INVALID'}` : 'LLM_TOOL_CALL',
        retryCount: r.retryOf || r.llmRetry ? 1 : 0, latencyMs: r.latencyMs ?? null, parallelGroup: r.parallelGroup ?? null,
        ...identityStep(steps.find(st => st.result?.toolExecutionId === r.toolExecutionId)?.result?.identity)
      }));
      const stop = stopReasonOf(stopReason, error, finalMessage);
      const limited = stop === 'TOOL_BUDGET_EXHAUSTED' || stop === 'TOOL_LOOP_DETECTED';
      return {
        chainId, llmCallCount: llmCalls, toolCallCount: this.turn.callsUsed, providerCallCount: recs.filter(r => !!r.startedAt).length,
        redundantCallCount: deduplicated, retryCount: chainSteps.filter(s => s.retryCount > 0).length, chainLength: this.turn.roundsUsed,
        chainStopReason: stop, answeredAfterStop,
        duplicateCallPrevented: deduplicated > 0, stepLimitReached: limited, stepLimitReason: limited ? String(error?.code || stop) : null,
        budget: { maxToolSteps: MAX_TOOL_STEPS_PER_TURN, maxRounds: MAX_TOOL_ROUNDS_PER_TURN, maxLlmIterations: this.maxIterations },
        latencyMs: Date.now() - startedAt, steps: chainSteps
      };
    };
    const done = (finalMessage: string, stopReason: ToolRuntimeResult['stopReason'], error?: OrchestratorError): ToolRuntimeResult => ({
      finalMessage, finalDecision: lastDecision || dummyDecision(), steps, stopReason, error,
      latencyMs: Date.now() - startedAt, applyOutcomes, llmLatencyMs, deduplicated,
      toolExecutions: this.turn.records, toolRounds: this.turn.roundsUsed, toolPlans: this.turn.plans,
      llmCalls, toolValidation: { ...this.turn.validation }, chain: chainOf(stopReason, error, finalMessage)
    });
    /**
     * Prompt 27: the step budget / loop guard stopped the chain. No more tools run. When this turn already holds verified
     * results, the LLM gets ONE tools-disabled call with the structured stop reason and answers from those results only
     * (its text is still grounded by the P25/P26 validators). Otherwise — or if it still asks for tools / fails — the
     * existing deterministic path (verified facts + one limit notice) is kept. Never a fabricated answer.
     */
    const wrapUp = async (err: OrchestratorError, fallbackMsg: string, fallbackReason: ToolRuntimeResult['stopReason'] = 'tool_limit'): Promise<ToolRuntimeResult> => {
      const reason = err.code === 'TOOL_LOOP_DETECTED' ? 'TOOL_LOOP_DETECTED' as const : 'TOOL_BUDGET_EXHAUSTED' as const;
      stopOverride = reason;
      H.emit?.('TOOL_CHAIN_STOPPED', { chainId, reason, code: err.code, toolCalls: this.turn.callsUsed, rounds: this.turn.roundsUsed });
      if (!turnResults.some(r => r.ok) || H.isStale?.()) return done(fallbackMsg, fallbackReason, err);
      const sess = this.getSession();
      const t0 = Date.now();
      llmCalls++;
      let d: AgentDecision | undefined;
      try {
        d = (await this.llm.generateStructuredDecision({
          userText, history: localHistory, state: sess.bookingState, session: sess, missingFields: computeMissing(sess), inputMode: mode,
          tools: exposedTools(), context: H.buildContext?.(), currentTurnToolResults: [...turnResults],
          agentTranscript: transcript.map(st => ({ ...st, toolCalls: [...st.toolCalls], results: [...st.results] })),
          chainStop: { reason, code: String(err.code), instruction: CHAIN_STOP_INSTRUCTION }
        })).decision;
      } catch { d = undefined; }
      llmLatencyMs += Date.now() - t0;
      if (H.isStale?.()) return done('', 'stale', { code: 'STALE_TOOL_RESULT', message: 'Obsolete request stopped.' });
      const msg = d && typeof d === 'object' && !(d.toolCalls || []).length ? String(d.finalMessage || d.clarification || '').trim() : '';
      if (!msg) return done(fallbackMsg, fallbackReason, err);
      answeredAfterStop = true;
      return done(msg, 'final');
    };

    for (let iter = 0; iter < this.maxIterations; iter++) {
      if (H.isStale?.()) return done('', 'stale', { code: 'STALE_TOOL_RESULT', message: 'Obsolete request stopped.' });
      const sess = this.getSession();
      const missing = computeMissing(sess);
      const t0 = Date.now();
      safeObs(() => H.observer?.onLLM?.('start', iter));
      // Prompt 22: an LLM failure never hands the turn to a deterministic parser — the turn ends with the safe
      // LLM_UNAVAILABLE reply; results already verified in this turn (if any) are kept, nothing else changes.
      let decision: AgentDecision;
      llmCalls++;
      try {
      decision = (await this.llm.generateStructuredDecision({
        userText,
        history: localHistory,
        state: sess.bookingState,
        session: sess,
        missingFields: missing,
        inputMode: mode,
        tools: exposedTools(),
        context: H.buildContext?.(),
        currentTurnToolResults: [...turnResults],
        agentTranscript: transcript.map(st => ({ ...st, toolCalls: [...st.toolCalls], results: [...st.results] }))
      })).decision;
      } catch (e: any) {
        llmLatencyMs += Date.now() - t0;
        safeObs(() => H.observer?.onLLM?.('end', iter, { toolCalls: 0, final: true }));
        return done('', 'error', { code: 'LLM_UNAVAILABLE', message: LLM_UNAVAILABLE_MESSAGE, details: { reason: isLLMProviderError(e) ? e.code : 'LLM_ERROR', iteration: iter } } as any);
      }
      if (!decision || typeof decision !== 'object') {
        return done('', 'error', { code: 'LLM_UNAVAILABLE', message: LLM_UNAVAILABLE_MESSAGE, details: { reason: 'LLM_BAD_RESPONSE', iteration: iter } } as any);
      }
      llmLatencyMs += Date.now() - t0;
      lastDecision = decision;
      safeObs(() => H.observer?.onLLM?.('end', iter, { toolCalls: (decision.toolCalls || []).length, final: !(decision.toolCalls || []).length,
        ...(typeof decision.acknowledgement === 'string' && decision.acknowledgement ? { acknowledgement: decision.acknowledgement.slice(0, 160) } : {}) }));
      if (H.isStale?.()) return done('', 'stale', { code: 'STALE_TOOL_RESULT', message: 'Obsolete request stopped.' });

      const step: AgentTranscriptStep = {
        ...(decision.native?.assistantContent ? { assistantContent: decision.native.assistantContent } : {}),
        toolCalls: (decision.toolCalls || []).map(c => ({ callId: c.callId, name: String(c.name), arguments: c.arguments || {} })),
        ...(decision.native?.sessionUpdateCallId ? { sessionUpdate: { callId: decision.native.sessionUpdateCallId, arguments: decision.native.sessionUpdateArgs || {} } } : {}),
        results: []
      };
      transcript.push(step);
      // P37: provider tool names → canonical contract + LLM-chosen provider (the transcript keeps the names the LLM used)
      if (Array.isArray(decision.toolCalls) && decision.toolCalls.length) {
        decision = { ...decision, toolCalls: decision.toolCalls.map(mapProviderToolCall) };
        const pc = decision.toolCalls.find(c => c.provider);
        if (pc) this.lastProvider = pc.provider;
      }

      // Deterministically apply this decision's entities/references BEFORE its tool calls.
      if (H.applyDecision) {
        const outcome = H.applyDecision(decision);
        if (step.sessionUpdate) step.sessionUpdateOutcome = outcomeView(outcome);
        applyOutcomes.push(outcome);
        this.allowedTools = outcome.allowedTools;
        // Prompt 22: the backend applied a journey-level change the LLM proposed (new journey) — this decision was made
        // against the OLD journey, so its tool calls are dropped and the LLM decides again on the fresh session.
        if (outcome.replan && !outcome.blockTools) continue;
        // Prompt 23: a native agent hears WHY its proposal was rejected (nothing was applied, its tools were not run)
        // and answers / asks / tries a valid alternative itself — validated again. Safety rejections stay final.
        if (outcome.blockTools && outcome.error && decision.continueAfterApply && !outcome.lifecycle && !outcome.directAnswer
          && !NATIVE_FINAL_ERRORS.has(String(outcome.error.code)) && nativeRecoveries < MAX_NATIVE_RECOVERIES) { nativeRecoveries++; continue; }
        if (outcome.blockTools) {
          // a deterministic backend answer (post-booking record) is never mixed with LLM wording
          return done(outcome.error?.message || (outcome.directAnswer || outcome.lifecycle ? '' : (decision.finalMessage || decision.clarification || '')), 'blocked', outcome.error);
        }
      }

      const toolCalls = decision.toolCalls || [];
      if (toolCalls.length === 0) {
        // Prompt 23: a native agent that proposed a session update waits for its validated outcome → ask it again
        if (decision.continueAfterApply) continue;
        const msg = decision.finalMessage || decision.clarification || '';
        return done(msg, 'final');
      }

      // Prompt 17: MAX_TOOL_ROUNDS_PER_TURN — a round that would exceed it runs no calls.
      if (!this.turn.startRound()) {
        const lim: OrchestratorError = { code: 'TOOL_CALL_LIMIT_EXCEEDED', message: 'Request bahut lambi ho gayi — thoda simple karke poochiye.' };
        H.emit?.('TOOL_FAILED', { code: 'TOOL_CALL_LIMIT_EXCEEDED', stage: 'rounds', rounds: this.turn.roundsUsed - 1 });
        return wrapUp(lim, '');
      }
      const recordsBefore = this.turn.records.length;
      // Prompt 17: independent calls run in PARALLEL; SEARCH_TRAINS is a barrier (dependent calls are
      // validated only after its results are synced). Results are recorded in the original order.
      const sigs = new Map<string, string>();
      let staleHit = false;
      let stopErr: OrchestratorError | undefined;
      await this.turn.runRound(toolCalls, this.executor, {
        fromLLM: true,
        skip: (tc) => {
          const sig = sigOf(tc);
          sigs.set(tc.callId, sig);
          const prior = doneCalls.get(sig);
          if (!prior) return false;
          // accidental duplicate inside ONE turn (LLM repeat) — the fresh result is already attached
          deduplicated++;
          turnResults.push({ ...prior, callId: tc.callId });
          localHistory.push({ role: 'tool', content: JSON.stringify({ ok: true, deduplicated: true, sameAs: prior.callId }), toolCallId: tc.callId, toolName: tc.name });
          H.emit?.('TOOL_CALL_DEDUPLICATED', { toolName: tc.name });
          return true;
        },
        skipPrepared: (p) => {
          const prior = doneValidated.get(vSig(p.vt, p.tc?.provider));
          if (!prior) return false;
          deduplicated++;
          turnResults.push({ ...prior, callId: p.tc.callId });
          localHistory.push({ role: 'tool', content: JSON.stringify({ ok: true, deduplicated: true, sameAs: prior.callId }), toolCallId: p.tc.callId, toolName: p.tc.name });
          H.emit?.('TOOL_CALL_DEDUPLICATED', { toolName: p.tc.name });
          return true;
        },
        onRejected: (p) => {
          this.recordRejected(p, iter, turnResults, localHistory, steps);
          lastError = { code: p.error.code as any, message: p.error.message };
          if (p.stop) stopErr = { code: (p.error.code === 'TOOL_LOOP_DETECTED' ? 'TOOL_LOOP_DETECTED' : 'TOOL_CALL_LIMIT_EXCEEDED') as any, message: p.error.message };
        },
        onDuplicate: (tc, orig) => {
          deduplicated++;
          const prior = turnResults.find(r => r.callId === orig.prepared.tc.callId);
          if (prior) turnResults.push({ ...prior, callId: tc.callId });
          localHistory.push({ role: 'tool', content: JSON.stringify({ ok: orig.success, deduplicated: true, sameAs: orig.prepared.tc.callId }), toolCallId: tc.callId, toolName: tc.name });
          H.emit?.('TOOL_CALL_DEDUPLICATED', { toolName: tc.name });
        },
        onExecuted: (x) => {
          const r = this.recordExecuted(x, iter, turnResults, localHistory, steps);
          if (r.stale) { staleHit = true; return false; }
          if (r.error) lastError = r.error;
          if (x.success) { doneCalls.set(sigs.get(x.prepared.tc.callId) || sigOf(x.prepared.tc), turnResults[turnResults.length - 1]); doneValidated.set(vSig(x.prepared.vt, x.prepared.tc?.provider), turnResults[turnResults.length - 1]); }
          return true;
        }
      });
      markRecords(recordsBefore);
      { const ids = new Set(step.toolCalls.map(c => c.callId)); step.results = turnResults.filter(r => ids.has(String(r.callId))); }
      if (staleHit) return done('', 'stale', { code: 'STALE_TOOL_RESULT', message: 'Late result from an obsolete request was ignored.' });
      if (stopErr) return wrapUp(stopErr, '');   // Prompt 27: answer from verified results (else: verified facts + the limit message once)
    }

    const limError: OrchestratorError = { code: 'TOOL_CALL_LIMIT_EXCEEDED', message: 'Request bahut lambi ho gayi — thoda simple karke poochiye.' };
    return wrapUp(limError, limError.message, lastError ? 'error' : 'tool_limit');
  }

  /**
   * Deterministic required-tool flow (Prompt 9): BookingPreparationService asks
   * for fresh CHECK_AVAILABILITY / GET_FARE before review/confirmation. The calls
   * go through the SAME validator → provider → normalizer → stale guard →
   * session sync path as LLM-issued calls (no shortcut, no cache).
   */
  async runTools(calls: ToolCall[]): Promise<{ steps: ToolCallStep[]; stale: boolean }> {
    const steps: ToolCallStep[] = [];
    if (this.hooks.isStale?.()) return { steps, stale: true };
    let stale = false;
    // P37: booking re-validation (fresh availability / fare before review) runs on ONE named provider — the one the LLM
    // used in this turn, else the first configured connector — never on a hidden failover chain. A failure is reported.
    if (providerToolCatalog.enabled()) {
      const pv = this.lastProvider || providerToolCatalog.defaultProvider() || undefined;
      calls = calls.map(c => (c.provider ? c : { ...c, provider: pv }));
    }
    await this.turn.runRound(calls, this.executor, {
      fromLLM: false,
      onRejected: (p) => { this.recordRejected(p, -1, [], [], steps); },
      onExecuted: (x) => { const r = this.recordExecuted(x, -1, [], [], steps); if (r.stale) { stale = true; return false; } return true; }
    });
    return { steps, stale };
  }

  /** Prompt 17: a call the runtime rejected BEFORE any provider call (validation / security / limits). */
  private recordRejected(p: Extract<PreparedCall, { ok: false }>, iter: number, turnResults: TurnToolResultView[], localHistory: HistoryMsg[], steps: ToolCallStep[]): void {
    const H = this.hooks;
    const tc = p.tc;
    const error = { code: p.error.code, message: p.error.message };
    const errRes: NormalizedToolResult = {
      toolName: String(tc?.name), callId: tc?.callId, success: false, error: { ...error, ...(p.error.details ? { details: p.error.details } : {}) }, timestamp: new Date().toISOString(), latencyMs: 0,
      toolExecutionId: p.record.toolExecutionId, status: 'REJECTED', fresh: false, normalizedErrorCode: p.error.normalized
    };
    steps.push({ toolCall: tc, result: errRes, iteration: iter, status: 'rejected', requestId: H.requestId, execution: p.record, llmResult: p.result });
    turnResults.push({ toolName: tc?.name as any, callId: tc?.callId, ok: false, error: { ...error, details: p.error.details } as any, status: 'REJECTED', outcome: 'REJECTED' });
    // Prompt 25 Part 8: the structured reason (argument / expected / received) reaches the LLM so it can correct itself
    // Prompt 28: …as { errorType, tool, argument, reason, retryable } (a validation rejection is never retryable as-is)
    localHistory.push({ role: 'tool', content: JSON.stringify({ ...p.result, ok: false, error: { ...error, ...(p.error.details ? { details: p.error.details } : {}), ...structuredToolError(String(tc?.name), { ...error, details: p.error.details }, 1) }, toolName: tc?.name }), toolCallId: tc?.callId, toolName: tc?.name });
    H.emit?.('TOOL_FAILED', { toolName: tc?.name, code: p.error.code, stage: 'validation', toolExecutionId: p.record.toolExecutionId });
  }

  /** Prompt 17: result guard → record → sync for one executed call. */
  private recordExecuted(x: ExecutedCall, iter: number, turnResults: TurnToolResultView[], localHistory: HistoryMsg[], steps: ToolCallStep[])
    : { stale: boolean; error?: OrchestratorError } {
    const H = this.hooks;
    const vt = x.prepared.vt;
    const tc = x.prepared.tc;
    const s = this.getSession();
    const at = x.record.completedAt || new Date().toISOString();
    const norm: NormalizedToolResult = {
      toolName: vt.name, callId: tc.callId, success: x.success, data: x.success ? x.data : undefined,
      error: x.error ? { code: x.error.code, message: x.error.message } : undefined,
      provider: x.provider || undefined, timestamp: at, latencyMs: x.latencyMs,
      provenance: { sessionId: s.sessionId, requestId: H.requestId, sessionVersion: s.sessionVersion, retrievedAt: at, journeyVersion: x.prepared.journeyVersion, toolExecutionId: x.record.toolExecutionId },
      toolExecutionId: x.record.toolExecutionId, status: x.record.status, fresh: x.record.fresh, empty: x.empty, normalizedErrorCode: x.error?.normalized
    };
    // Prompt 28: identity from the VALIDATED request + the provider's own result fields (never from LLM text)
    norm.identity = buildToolResultIdentity({ toolName: vt.name, resultId: x.record.toolExecutionId, args: vt.arguments, data: norm.data,
      provider: norm.provider, receivedAt: at, status: String(x.record.status || ''), sessionDate: s.date });
    norm.resultRef = resultRef(vt.name, ++this.resultSeq);
    // …a provider result about a DIFFERENT train / class / date than requested is never used (no silent substitution)
    if (norm.success && norm.identity.binding === 'MISMATCH') {
      const fields = (norm.identity.mismatch || []).join(',');
      norm.success = false; norm.data = undefined; (x as any).success = false; (x as any).data = undefined;
      norm.error = { code: 'RESULT_IDENTITY_MISMATCH', message: `Provider result did not match the requested ${fields}; it was not used.`, details: { argument: norm.identity.mismatch?.[0] || 'trainNumber' } };
      x.record.status = 'FAILED'; x.record.fresh = false;
      (x.record as any).rejectionReason = 'RESULT_IDENTITY_MISMATCH';
      H.emit?.('TOOL_FAILED', { toolName: vt.name, code: 'RESULT_IDENTITY_MISMATCH', stage: 'identity', mismatch: fields, toolExecutionId: x.record.toolExecutionId });
    }
    // Part 53/55 result guard: newer turn, superseded journeyVersion / selection, or a search whose
    // commit was refused inside the orchestrator → STALE_TOOL_RESULT, nothing applied.
    const stale = x.stale || !!H.isStale?.() || (vt.name !== 'SEARCH_TRAINS' && !this.turn.isCurrent(x.prepared));
    if (stale) {
      x.record.status = 'CANCELLED'; x.record.fresh = false; x.record.rejectionReason = 'STALE_TOOL_RESULT';
      steps.push({ toolCall: tc, result: { ...norm, success: false, status: 'CANCELLED', error: { code: 'STALE_TOOL_RESULT', message: 'Result belongs to an obsolete request/journey version.' } }, iteration: iter, status: 'stale', dataSource: x.dataSource ?? null, validatedArguments: vt.arguments, requestId: H.requestId, execution: x.record, llmResult: x.result });
      H.emit?.('STALE_RESULT_REJECTED', { toolName: vt.name, requestId: H.requestId, toolExecutionId: x.record.toolExecutionId, journeyVersionAtCall: x.prepared.journeyVersion, journeyVersionNow: s.journeyVersion });
      return { stale: true };
    }
    steps.push({ toolCall: tc, result: norm, iteration: iter, status: norm.success ? 'ok' : 'error', dataSource: x.dataSource ?? null, validatedArguments: vt.arguments, requestId: H.requestId, execution: x.record, llmResult: x.result });
    turnResults.push({ toolName: vt.name, callId: tc.callId, ok: norm.success, data: norm.success ? norm.data : undefined, error: norm.error, empty: x.empty || undefined, status: x.record.status,
      outcome: toolOutcomeOf({ ok: norm.success, empty: x.empty, status: x.record.status, code: norm.error?.code, normalizedCode: x.error?.normalized }), dataSource: x.dataSource ?? null, attempts: x.record.attempt || 1,
      ...providerViewOf(x),
      identity: norm.identity, resultRef: norm.resultRef, ...(norm.success ? this.followUpOf(vt, norm) : {}) });
    localHistory.push({ role: 'tool', content: JSON.stringify({ ...this.serializeForLLM(norm, x.result, x.record.attempt || 1, x.dataSource ?? null), ...providerViewOf(x) }), toolCallId: tc.callId, toolName: tc.name });
    this.syncToSession(vt, norm);
    if (!norm.success) {
      H.emit?.('TOOL_FAILED', { toolName: vt.name, code: norm.error?.code, stage: 'provider', status: x.record.status, toolExecutionId: x.record.toolExecutionId });
      return { stale: false, error: { code: 'TOOL_FAILED', message: norm.error?.message || 'Tool failed.' } };
    }
    return { stale: false };
  }

  private async executeTool(vt: ValidatedToolCall, guard?: { canApply: () => boolean }): Promise<any> {
    const H = this.hooks;
    if (vt.name === 'SEARCH_TRAINS') H.emit?.('SEARCH_STARTED', { origin: vt.arguments.origin, destination: vt.arguments.destination, date: vt.arguments.date });
    if (vt.name === 'TRACK_TRAIN' || vt.name === 'CHECK_PNR') H.onLiveTool?.('REQUESTED', vt.name, vt.arguments);
    switch (vt.name) {
      case 'SEARCH_TRAINS': {
        // Always run a FRESH search (no cache, no stale-reuse). RailwaySearchOrchestrator
        // will also invalidate dependent state if route/date changed.
        return this.searchOrch.trySearch('', {
          origin: vt.arguments.origin, destination: vt.arguments.destination, date: vt.arguments.date,
          passengerCount: vt.arguments.passengersCount,
          preferredClass: vt.arguments.preferredClass, preferredTime: vt.arguments.preferredTime
        }, { canApply: guard?.canApply });
      }
      case 'GET_TRAIN_INFO':
        return this.tools.GET_TRAIN_INFO(vt.arguments.trainNumber);
      case 'GET_TIMETABLE':
        return this.tools.GET_TIMETABLE(vt.arguments.trainNumber);
      case 'CHECK_AVAILABILITY':
        return this.tools.CHECK_AVAILABILITY({
          trainNumber: vt.arguments.trainNumber, travelClass: vt.arguments.travelClass, date: vt.arguments.date,
          // Prompt 35: live availability APIs need the segment — authoritative session journey (never an LLM argument)
          origin: this.getSession().origin, destination: this.getSession().destination
        });
      case 'GET_FARE':
        return this.tools.GET_FARE({
          trainNumber: vt.arguments.trainNumber, travelClass: vt.arguments.travelClass, passengersCount: vt.arguments.passengersCount,
          // Prompt 35: live fares are date-specific (dynamic pricing) — fall back to the AUTHORITATIVE session journey
          // date (the review-boundary refresh sends no date argument); never an LLM-invented value
          date: vt.arguments.date ?? this.getSession().date ?? undefined,
          // authoritative journey from BookingSession (never an LLM argument)
          origin: this.getSession().origin, destination: this.getSession().destination
        } as any);
      // Prompt 14: always FRESH (no cache), bounded by a timeout, provider output validated
      case 'TRACK_TRAIN':
        return this.live.track(vt.arguments.trainNumber);
      case 'CHECK_PNR':
        return this.pnr.check(vt.arguments.pnr);
      // Prompt 35: LLM-chosen WEB_EXTERNAL research (never auto-launched by the backend; never authoritative)
      case 'WEB_RAILWAY_RESEARCH':
        return getWebResearchService().search(vt.arguments.query);
      default:
        return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `"${vt.name}" अज्ञात tool है।` } };
    }
  }

  private normalizeResult(vt: ValidatedToolCall, execRes: any, latency: number): NormalizedToolResult {
    const ts = new Date().toISOString();
    const isRailwayResponse = execRes && typeof execRes === 'object' && 'ok' in execRes;
    const isSearchOrchResult = execRes && typeof execRes === 'object' && ('ok' in execRes) && ('data' in execRes || 'error' in execRes) && !execRes.meta;
    if (isRailwayResponse) {
      return {
        toolName: vt.name, callId: vt.callId,
        success: !!execRes.ok,
        data: execRes.ok ? execRes.data : undefined,
        error: !execRes.ok ? { code: execRes.error?.code || 'TOOL_FAILED', message: execRes.error?.message || 'Tool failed.' } : undefined,
        provider: execRes.meta?.providerId,
        timestamp: ts, latencyMs: latency || execRes.meta?.latencyMs || 0
      };
    }
    if (isSearchOrchResult) {
      return {
        toolName: vt.name, callId: vt.callId,
        success: !!execRes.ok,
        data: execRes.ok ? execRes.data : undefined,
        error: !execRes.ok ? { code: execRes.error?.code || 'TOOL_FAILED', message: execRes.error?.message || 'Search failed.' } : undefined,
        provider: this.tools.providerLabel,
        timestamp: ts, latencyMs: latency
      };
    }
    return {
      toolName: vt.name, callId: vt.callId, success: false,
      error: { code: 'TOOL_FAILED', message: 'Invalid tool result shape.' },
      timestamp: ts, latencyMs: latency
    };
  }

  /**
   * Send a trimmed, provider-independent view of the result back to the LLM.
   * We deliberately do NOT forward internal metadata (source timestamps,
   * raw provider fields) — only facts + success/error.
   */
  private serializeForLLM(r: NormalizedToolResult, llm?: LLMToolResult, attempts = 1, dataSource: 'MOCK' | 'LIVE' | 'WEB_EXTERNAL' | null = null): any {
    // Prompt 32: explicit honest outcome + provider identity (additive keys; the LLM words the answer from them)
    const oc = { outcome: toolOutcomeOf({ ok: r.success, empty: r.empty, status: r.status, code: r.error?.code, normalizedCode: r.normalizedErrorCode }), dataSource };
    // Prompt 17: freshness / provenance metadata (no credentials, no raw provider payload)
    const meta = llm ? { toolExecutionId: llm.toolExecutionId, status: llm.status, fresh: llm.fresh, meta: llm.meta, ...(llm.empty ? { empty: true } : {}) } : {};
    // Prompt 14: the full PNR never goes back into LLM context
    if (r.success && r.toolName === 'CHECK_PNR') return { ok: true, data: { ...r.data, pnr: maskPnr(r.data?.pnr) }, toolName: r.toolName, ...meta, ...oc };
    const ref = r.resultRef ? { toolResultId: r.resultRef } : {};
    const entity = r.identity && r.identity.binding !== 'NO_ENTITY' ? { entity: { trainNumber: r.identity.trainNumber, date: r.identity.date, class: r.identity.travelClass } } : {};
    if (r.success) return { ok: true, ...ref, ...entity, data: r.data, toolName: r.toolName, ...meta, ...oc };
    return { ok: false, ...ref, error: { ...r.error, normalizedCode: r.normalizedErrorCode, ...structuredToolError(r.toolName, r.error, attempts) }, toolName: r.toolName, ...meta, ...oc };
  }

  /**
   * Prompt 28: an actionable follow-up on a FRESH search after a date-only change. The previous train / class are NOT
   * kept automatically (the LLM decides); the result only states whether they exist in the fresh results, so the LLM
   * can re-select in one step instead of probing. Facts only — no instruction which tool to call.
   */
  private followUpOf(vt: ValidatedToolCall, r: NormalizedToolResult): Pick<TurnToolResultView, 'followUp'> {
    if (vt.name !== 'SEARCH_TRAINS') return {};
    const co: any = (this.getSession() as any).carryOverSelection;
    if (!co?.trainNumber) return {};
    const t = ((r.data?.trains || []) as any[]).find(x => String(x?.trainNumber) === String(co.trainNumber));
    const classes: string[] = t ? ((t.classes || []) as any[]).map((c: any) => String(c?.code ?? c).toUpperCase()) : [];
    return { followUp: { previousSelection: { trainNumber: String(co.trainNumber), ...(co.classCode ? { travelClass: String(co.classCode) } : {}) },
      inFreshResults: !!t, ...(t && co.classCode ? { classListed: classes.includes(String(co.classCode).toUpperCase()) } : {}),
      selectionKept: false, ...(t ? { displayIndex: ((r.data?.trains || []) as any[]).indexOf(t) + 1 } : {}) } };
  }

  /**
   * After a successful tool result, synchronize authoritative information into
   * BookingSession. The LLM never directly mutates session; this function owns
   * all writes, and only writes data that was produced by the tool.
   */
  private syncToSession(vt: ValidatedToolCall, r: NormalizedToolResult): void {
    const H = this.hooks;
    // Prompt 14: live lookups never mutate BookingSession / BookingRecord facts — audit only
    if (vt.name === 'CHECK_PNR' || vt.name === 'TRACK_TRAIN') { H.onLiveTool?.('RESULT', vt.name, vt.arguments, { success: r.success, error: r.error }); return; }
    if (!r.success) {
      // A failed search must not leave the session stuck in SEARCHING_TRAINS.
      if (vt.name === 'SEARCH_TRAINS' && this.getSession().bookingState === BookingState.SEARCHING_TRAINS) {
        this.commitSession({ bookingState: BookingState.COLLECTING_JOURNEY } as any);
      }
      return;
    }
    // Part 46: SUCCESS with zero trains — the fresh truth is "no trains"; old results/selection are dropped
    if (vt.name === 'SEARCH_TRAINS' && r.empty) {
      this.commitSession({
        availableTrains: [], lastSearch: undefined, searchResults: undefined, selectedTrain: undefined, selectedClass: undefined,
        fare: undefined, availability: undefined, bookingState: BookingState.COLLECTING_JOURNEY,
        searchMeta: { resultId: r.toolExecutionId, retrievedAt: r.timestamp, totalCount: 0 }
      } as any);
      H.emit?.('SEARCH_COMPLETED', { origin: vt.arguments.origin, destination: vt.arguments.destination, date: vt.arguments.date, count: 0, empty: true });
      return;
    }
    const source = this.tools.providerLabel && /mock/i.test(String(r.provider || this.tools.providerLabel)) ? 'MOCK' : 'LIVE';
    switch (vt.name) {
      case 'SEARCH_TRAINS': {
        // Version the new result list; assign deterministic displayIndex → resultId.
        const s = this.getSession();
        const version = (s.searchResultsVersion || 0) + 1;
        const resultId = uuidv4();
        const retrievedAt = r.timestamp;
        const sr = s.searchResults || r.data;
        const trains = (sr?.trains || []).map((t: any, i: number) => ({
          ...t, displayIndex: i + 1, resultId: `${resultId}:${i + 1}`, provider: r.provider, retrievedAt
        }));
        const patch: any = {
          // Prompt 30: result-set provenance (journey the set belongs to + the turn / tool result that produced it) —
          // display indexes are addressable only while this set matches the session journey
          searchResults: { ...sr, trains, version, resultId, retrievedAt,
            date: sr?.journey?.date ?? vt.arguments.date, origin: sr?.journey?.origin ?? vt.arguments.origin, destination: sr?.journey?.destination ?? vt.arguments.destination,
            sourceTurnId: H.turnId ?? null, sourceToolResultId: r.toolExecutionId ?? null },
          searchResultsVersion: version,
          searchMeta: { resultId, retrievedAt, totalCount: trains.length }
        };
        if (typeof vt.arguments.passengersCount === 'number') patch.passengersCount = vt.arguments.passengersCount;
        if (vt.arguments.preferredClass) patch.preferredClass = vt.arguments.preferredClass;
        if (vt.arguments.preferredTime) patch.preferredTime = vt.arguments.preferredTime;
        this.commitSession(patch);
        H.emit?.('SEARCH_COMPLETED', { origin: vt.arguments.origin, destination: vt.arguments.destination, date: vt.arguments.date, count: trains.length, searchResultsVersion: version, resultId });
        break;
      }
      case 'GET_TRAIN_INFO': {
        // Prompt 30: only a SUCCESSFUL, non-stale result reaches here (failures returned above; the guarded commit rejects
        // stale turns); the focus is stamped with its turn so a discarded turn's focus can be rolled back
        this.commitSession({ lastTrainInfo: r.data, focusTrainNumber: r.data?.trainNumber || vt.arguments.trainNumber, focusTurnId: H.turnId } as any);
        break;
      }
      case 'GET_TIMETABLE': {
        this.commitSession({ lastTimetable: r.data, focusTrainNumber: vt.arguments.trainNumber, focusTurnId: H.turnId } as any);
        break;
      }
      case 'CHECK_AVAILABILITY': {
        const s = this.getSession();
        this.commitSession({ availability: { ...(s.availability || {}), [vt.arguments.travelClass]: { ...r.data, dataSource: source, ...r.provenance,
          fetchedAt: r.provenance?.retrievedAt || r.timestamp, toolExecutionId: r.toolExecutionId,
          trainNumber: vt.arguments.trainNumber, travelClass: vt.arguments.travelClass, date: vt.arguments.date || s.date, origin: s.origin, destination: s.destination } } } as any);
        H.emit?.('AVAILABILITY_CHECKED', { trainNumber: r.data?.trainNumber, travelClass: r.data?.travelClass, status: r.data?.status, date: r.data?.date });
        break;
      }
      case 'GET_FARE': {
        const s = this.getSession();
        // Route the fare was computed for (authoritative session journey) → freshness check can detect route changes.
        this.commitSession({ fare: { ...r.data, dataSource: source, origin: s.origin, destination: s.destination, date: vt.arguments.date || s.date, ...r.provenance,
          fetchedAt: r.provenance?.retrievedAt || r.timestamp, toolExecutionId: r.toolExecutionId,
          fareBasis: { trainNumber: vt.arguments.trainNumber, travelClass: vt.arguments.travelClass, passengersCount: r.data?.passengersCount ?? s.passengersCount, origin: s.origin, destination: s.destination, date: vt.arguments.date || s.date } } } as any);
        H.emit?.('FARE_CHECKED', { trainNumber: r.data?.trainNumber, travelClass: r.data?.travelClass, total: r.data?.total, passengersCount: r.data?.passengersCount });
        break;
      }
    }
  }
}

function safeObs(f: () => void) { try { f(); } catch { /* observers never break the loop */ } }

/**
 * Prompt 35: provider provenance the LLM may read (additive keys, outside the pinned P26 `provenance` object):
 * which provider answered, whether a fallback provider served it, and the compact attempt chain. Never keys / bodies.
 */
export function providerViewOf(x: Pick<ExecutedCall, 'provider' | 'providerAttempts' | 'fallbackUsed'>): { provider?: string; fallbackUsed?: boolean; providerAttempts?: Array<{ provider: string; outcome: string; errorCode: string | null }> } {
  if (!x.providerAttempts?.length) return {};
  return { provider: String(x.provider || '').toUpperCase(), fallbackUsed: !!x.fallbackUsed,
    providerAttempts: x.providerAttempts.map(a => ({ provider: a.provider.toUpperCase(), outcome: a.outcome, errorCode: a.errorCode })) };
}

function computeMissing(s: BookingSession): string[] {
  const m: string[] = [];
  if (!s.origin) m.push('origin');
  if (!s.destination) m.push('destination');
  if (!s.date) m.push('date');
  if (!s.passengersCount) m.push('passengers');
  return m;
}

function dummyDecision(): AgentDecision {
  return { intent:'UNKNOWN', action:'NO_ACTION', entities:{}, missingFields:[], clarification:null, confidence:0, toolCalls:[] };
}
