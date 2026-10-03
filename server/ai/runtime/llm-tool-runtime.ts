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
import type { LLMProvider } from '../providers/llm-provider';
import type { AgentDecision, OrchestratorError, TurnRecord } from '../decisions/agent-decision';
import type { ToolCall, ToolDefinition } from '../tools/tool-registry';
import { REGISTERED_TOOLS } from '../tools/tool-registry';
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
import type { ToolExecutionRecord, LLMToolResult, ToolExecutionStatus } from '@shared/railway-tool-runtime';

export const MAX_TOOL_CALL_ITERATIONS = 8; // deterministic hard cap (configurable via constructor)

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
    let lastDecision: AgentDecision | null = null;
    let lastError: OrchestratorError | undefined;
    let llmLatencyMs = 0;
    const H = this.hooks;
    this.userText = userText;
    this.turnCtx.userText = userText;
    // Prompt 16: in-turn dedup — an identical call (same tool + args + session context) whose valid
    // result is already attached to THIS turn is not sent again. Each new turn always calls the provider
    // fresh (no cross-turn cache), so explicit live requests ("abhi availability", "latest PNR") stay fresh.
    const doneCalls = new Map<string, TurnToolResultView>();
    let deduplicated = 0;
    const sigOf = (tc: ToolCall) => {
      // Prompt 17: a search is fully determined by its arguments (and SEARCH_TRAINS is a parallel barrier,
      // so the session changes between the original and its duplicate) → args-only signature
      if (tc?.name === 'SEARCH_TRAINS') return `SEARCH_TRAINS|${stableJson(tc?.arguments || {})}`;
      const sx: any = this.getSession();
      const t: any = sx.selectedTrain;
      return `${tc?.name}|${stableJson(tc?.arguments || {})}|${t?.number || t?.trainNumber || ''}|${sx.selectedClass || ''}|${sx.origin || ''}|${sx.destination || ''}|${sx.date || ''}|${sx.passengersCount || ''}`;
    };
    const done = (finalMessage: string, stopReason: ToolRuntimeResult['stopReason'], error?: OrchestratorError): ToolRuntimeResult => ({
      finalMessage, finalDecision: lastDecision || dummyDecision(), steps, stopReason, error,
      latencyMs: Date.now() - startedAt, applyOutcomes, llmLatencyMs, deduplicated,
      toolExecutions: this.turn.records, toolRounds: this.turn.roundsUsed, toolPlans: this.turn.plans
    });

    for (let iter = 0; iter < this.maxIterations; iter++) {
      if (H.isStale?.()) return done('', 'stale', { code: 'STALE_TOOL_RESULT', message: 'Obsolete request stopped.' });
      const sess = this.getSession();
      const missing = computeMissing(sess);
      const t0 = Date.now();
      safeObs(() => H.observer?.onLLM?.('start', iter));
      const decision = (await this.llm.generateStructuredDecision({
        userText,
        history: localHistory,
        state: sess.bookingState,
        session: sess,
        missingFields: missing,
        inputMode: mode,
        tools: REGISTERED_TOOLS,
        context: H.buildContext?.(),
        currentTurnToolResults: [...turnResults]
      })).decision;
      llmLatencyMs += Date.now() - t0;
      lastDecision = decision;
      safeObs(() => H.observer?.onLLM?.('end', iter, { toolCalls: (decision.toolCalls || []).length, final: !(decision.toolCalls || []).length,
        ...(typeof decision.acknowledgement === 'string' && decision.acknowledgement ? { acknowledgement: decision.acknowledgement.slice(0, 160) } : {}) }));
      if (H.isStale?.()) return done('', 'stale', { code: 'STALE_TOOL_RESULT', message: 'Obsolete request stopped.' });

      // Deterministically apply this decision's entities/references BEFORE its tool calls.
      if (H.applyDecision) {
        const outcome = H.applyDecision(decision);
        applyOutcomes.push(outcome);
        this.allowedTools = outcome.allowedTools;
        if (outcome.blockTools) {
          // a deterministic backend answer (post-booking record) is never mixed with LLM wording
          return done(outcome.error?.message || (outcome.directAnswer || outcome.lifecycle ? '' : (decision.finalMessage || decision.clarification || '')), 'blocked', outcome.error);
        }
      }

      const toolCalls = decision.toolCalls || [];
      if (toolCalls.length === 0) {
        const msg = decision.finalMessage || decision.clarification || '';
        return done(msg, 'final');
      }

      // Prompt 17: MAX_TOOL_ROUNDS_PER_TURN — a round that would exceed it runs no calls.
      if (!this.turn.startRound()) {
        const lim: OrchestratorError = { code: 'TOOL_CALL_LIMIT_EXCEEDED', message: 'Request bahut lambi ho gayi — thoda simple karke poochiye.' };
        H.emit?.('TOOL_FAILED', { code: 'TOOL_CALL_LIMIT_EXCEEDED', stage: 'rounds', rounds: this.turn.roundsUsed - 1 });
        return done('', 'tool_limit', lim);
      }
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
          if (x.success) doneCalls.set(sigs.get(x.prepared.tc.callId) || sigOf(x.prepared.tc), turnResults[turnResults.length - 1]);
          return true;
        }
      });
      if (staleHit) return done('', 'stale', { code: 'STALE_TOOL_RESULT', message: 'Late result from an obsolete request was ignored.' });
      if (stopErr) return done('', 'tool_limit', stopErr);   // composer adds verified facts + the limit message once
    }

    const limError: OrchestratorError = { code: 'TOOL_CALL_LIMIT_EXCEEDED', message: 'Request bahut lambi ho gayi — thoda simple karke poochiye.' };
    return done(limError.message, lastError ? 'error' : 'tool_limit', limError);
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
    turnResults.push({ toolName: tc?.name as any, callId: tc?.callId, ok: false, error: { ...error, details: p.error.details } as any });
    localHistory.push({ role: 'tool', content: JSON.stringify({ ...p.result, ok: false, error, toolName: tc?.name }), toolCallId: tc?.callId, toolName: tc?.name });
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
    // Part 53/55 result guard: newer turn, superseded journeyVersion / selection, or a search whose
    // commit was refused inside the orchestrator → STALE_TOOL_RESULT, nothing applied.
    const stale = x.stale || !!H.isStale?.() || (vt.name !== 'SEARCH_TRAINS' && !this.turn.isCurrent(x.prepared));
    if (stale) {
      x.record.status = 'CANCELLED'; x.record.fresh = false; x.record.rejectionReason = 'STALE_TOOL_RESULT';
      steps.push({ toolCall: tc, result: { ...norm, success: false, status: 'CANCELLED', error: { code: 'STALE_TOOL_RESULT', message: 'Result belongs to an obsolete request/journey version.' } }, iteration: iter, status: 'stale', validatedArguments: vt.arguments, requestId: H.requestId, execution: x.record, llmResult: x.result });
      H.emit?.('STALE_RESULT_REJECTED', { toolName: vt.name, requestId: H.requestId, toolExecutionId: x.record.toolExecutionId, journeyVersionAtCall: x.prepared.journeyVersion, journeyVersionNow: s.journeyVersion });
      return { stale: true };
    }
    steps.push({ toolCall: tc, result: norm, iteration: iter, status: norm.success ? 'ok' : 'error', validatedArguments: vt.arguments, requestId: H.requestId, execution: x.record, llmResult: x.result });
    turnResults.push({ toolName: vt.name, callId: tc.callId, ok: norm.success, data: norm.success ? norm.data : undefined, error: norm.error, empty: x.empty || undefined, status: x.record.status });
    localHistory.push({ role: 'tool', content: JSON.stringify(this.serializeForLLM(norm, x.result)), toolCallId: tc.callId, toolName: tc.name });
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
          trainNumber: vt.arguments.trainNumber, travelClass: vt.arguments.travelClass, date: vt.arguments.date
        });
      case 'GET_FARE':
        return this.tools.GET_FARE({
          trainNumber: vt.arguments.trainNumber, travelClass: vt.arguments.travelClass, passengersCount: vt.arguments.passengersCount,
          date: vt.arguments.date,
          // authoritative journey from BookingSession (never an LLM argument)
          origin: this.getSession().origin, destination: this.getSession().destination
        } as any);
      // Prompt 14: always FRESH (no cache), bounded by a timeout, provider output validated
      case 'TRACK_TRAIN':
        return this.live.track(vt.arguments.trainNumber);
      case 'CHECK_PNR':
        return this.pnr.check(vt.arguments.pnr);
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
  private serializeForLLM(r: NormalizedToolResult, llm?: LLMToolResult): any {
    // Prompt 17: freshness / provenance metadata (no credentials, no raw provider payload)
    const meta = llm ? { toolExecutionId: llm.toolExecutionId, status: llm.status, fresh: llm.fresh, meta: llm.meta, ...(llm.empty ? { empty: true } : {}) } : {};
    // Prompt 14: the full PNR never goes back into LLM context
    if (r.success && r.toolName === 'CHECK_PNR') return { ok: true, data: { ...r.data, pnr: maskPnr(r.data?.pnr) }, toolName: r.toolName, ...meta };
    if (r.success) return { ok: true, data: r.data, toolName: r.toolName, ...meta };
    return { ok: false, error: { ...r.error, normalizedCode: r.normalizedErrorCode }, toolName: r.toolName, ...meta };
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
          searchResults: { ...sr, trains, version, resultId, retrievedAt },
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
        this.commitSession({ lastTrainInfo: r.data, focusTrainNumber: r.data?.trainNumber || vt.arguments.trainNumber } as any);
        break;
      }
      case 'GET_TIMETABLE': {
        this.commitSession({ lastTimetable: r.data, focusTrainNumber: vt.arguments.trainNumber } as any);
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
