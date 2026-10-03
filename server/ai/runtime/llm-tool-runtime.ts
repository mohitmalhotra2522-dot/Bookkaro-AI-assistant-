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

export const MAX_TOOL_CALL_ITERATIONS = 8; // deterministic hard cap (configurable via constructor)

export interface NormalizedToolResult {
  toolName: string;
  callId: string;
  success: boolean;
  data?: any;
  error?: { code: string; message: string };
  provider?: string;
  timestamp: string;
  latencyMs: number;
  /** sessionId / requestId / sessionVersion (at call time) / retrievedAt. */
  provenance?: { sessionId: string; requestId?: string; sessionVersion: number; retrievedAt: string };
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
    sessionCommitter?: (p: Partial<BookingSession>) => void
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
    return new BoundToolRuntime(this.llm, this.tools, this.validator, this.searchOrch, this.maxIterations, getSession, commitSession, hooks);
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
  constructor(
    private readonly llm: LLMProvider,
    private readonly tools: RailwayToolService,
    private readonly validator: ToolCallValidator,
    baseSearchOrch: RailwaySearchOrchestrator,
    private readonly maxIterations: number,
    private readonly getSession: () => BookingSession,
    private readonly commitSession: (p: Partial<BookingSession>) => void,
    private readonly hooks: RuntimeHooks = {}
  ) {
    // Reuse the same class but bound to this turn's getter/committer so
    // RailwaySearchOrchestrator.invalidateDependentResults() & commits work.
    this.searchOrch = new RailwaySearchOrchestrator(getSession, commitSession);
    this.pnr = new PnrStatusService(tools);
    this.live = new LiveTrainStatusService(tools);
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
    // Prompt 16: in-turn dedup — an identical call (same tool + args + session context) whose valid
    // result is already attached to THIS turn is not sent again. Each new turn always calls the provider
    // fresh (no cross-turn cache), so explicit live requests ("abhi availability", "latest PNR") stay fresh.
    const doneCalls = new Map<string, TurnToolResultView>();
    let deduplicated = 0;
    const sigOf = (tc: ToolCall) => {
      const sx: any = this.getSession();
      const t: any = sx.selectedTrain;
      return `${tc?.name}|${stableJson(tc?.arguments || {})}|${t?.number || t?.trainNumber || ''}|${sx.selectedClass || ''}|${sx.origin || ''}|${sx.destination || ''}|${sx.date || ''}|${sx.passengersCount || ''}`;
    };
    const done = (finalMessage: string, stopReason: ToolRuntimeResult['stopReason'], error?: OrchestratorError): ToolRuntimeResult => ({
      finalMessage, finalDecision: lastDecision || dummyDecision(), steps, stopReason, error,
      latencyMs: Date.now() - startedAt, applyOutcomes, llmLatencyMs, deduplicated
    });

    for (let iter = 0; iter < this.maxIterations; iter++) {
      if (H.isStale?.()) return done('', 'stale', { code: 'STALE_TOOL_RESULT', message: 'Obsolete request stopped.' });
      const sess = this.getSession();
      const missing = computeMissing(sess);
      const t0 = Date.now();
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

      // Execute each tool call sequentially (later tools may depend on earlier results).
      for (const tc of toolCalls) {
        const sig = sigOf(tc);
        const prior = doneCalls.get(sig);
        if (prior) {
          deduplicated++;
          turnResults.push({ ...prior, callId: tc.callId });
          localHistory.push({ role: 'tool', content: JSON.stringify({ ok: true, deduplicated: true, sameAs: prior.callId }), toolCallId: tc.callId, toolName: tc.name });
          H.emit?.('TOOL_CALL_DEDUPLICATED', { toolName: tc.name });
          continue;
        }
        const before = turnResults.length;
        const r = await this.executeCall(tc, iter, turnResults, localHistory, steps);
        if (turnResults.length > before && turnResults[turnResults.length - 1].ok) doneCalls.set(sig, turnResults[turnResults.length - 1]);
        if (r.stale) return done('', 'stale', { code: 'STALE_TOOL_RESULT', message: 'Late result from an obsolete request was ignored.' });
        if (r.error) lastError = r.error;
      }
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
    for (const tc of calls) {
      if (this.hooks.isStale?.()) return { steps, stale: true };
      const r = await this.executeCall(tc, -1, [], [], steps);
      if (r.stale) return { steps, stale: true };
    }
    return { steps, stale: false };
  }

  /** Validate → execute → normalize → (stale check) → sync one tool call. */
  private async executeCall(tc: ToolCall, iter: number, turnResults: TurnToolResultView[], localHistory: HistoryMsg[], steps: ToolCallStep[])
    : Promise<{ stale: boolean; error?: OrchestratorError }> {
    const H = this.hooks;
    const sess0 = this.getSession();
    const ts = Date.now();
    const notAllowed = !!this.allowedTools && !this.allowedTools.includes(String(tc?.name));
    const val = notAllowed
      ? { ok: false as const, error: { code: 'INVALID_ACTION_FOR_STATE' as const, message: 'Is step par sirf read-only railway jaankari (PNR / live status / timetable) available hai.' } }
      : this.validator.validate(tc, sess0, H.grounding?.(this.userText));
    if (!val.ok) {
      const errRes: NormalizedToolResult = {
        toolName: tc.name, callId: tc.callId, success: false,
        error: { code: val.error.code, message: val.error.message },
        timestamp: new Date().toISOString(), latencyMs: Date.now() - ts
      };
      steps.push({ toolCall: tc, result: errRes, iteration: iter, status: 'rejected', requestId: H.requestId });
      turnResults.push({ toolName: tc.name, callId: tc.callId, ok: false, error: errRes.error });
      localHistory.push({ role: 'tool', content: JSON.stringify({ ok: false, error: errRes.error }), toolCallId: tc.callId, toolName: tc.name });
      H.emit?.('TOOL_FAILED', { toolName: tc.name, code: val.error.code, stage: 'validation' });
      return { stale: false, error: val.error }; // LLM reacts to the rejection on the next iteration
    }
    const vt = val.v;
    if (vt.name === 'SEARCH_TRAINS') H.emit?.('SEARCH_STARTED', { origin: vt.arguments.origin, destination: vt.arguments.destination, date: vt.arguments.date });
    if (vt.name === 'TRACK_TRAIN' || vt.name === 'CHECK_PNR') H.onLiveTool?.('REQUESTED', vt.name, vt.arguments);
    // Provenance captured at call time (sessionId / requestId / sessionVersion).
    const versionAtCall = this.getSession().sessionVersion;
    const execRes = await this.executeTool(vt);
    const norm = this.normalizeResult(vt, execRes, Date.now() - ts);
    norm.provenance = { sessionId: this.getSession().sessionId, requestId: H.requestId, sessionVersion: versionAtCall, retrievedAt: norm.timestamp };

    // Interruption safety: a newer turn started while we awaited the provider, OR
    // the session changed underneath a read-only railway lookup (sessionVersion
    // mismatch) → the late result must not overwrite current state.
    const versionMoved = vt.name !== 'SEARCH_TRAINS' && this.getSession().sessionVersion !== versionAtCall;
    if (H.isStale?.() || versionMoved) {
      steps.push({ toolCall: tc, result: { ...norm, success: false, error: { code: 'STALE_TOOL_RESULT', message: 'Result belongs to an obsolete request/session version.' } }, iteration: iter, status: 'stale', validatedArguments: vt.arguments, requestId: H.requestId });
      H.emit?.('STALE_RESULT_REJECTED', { toolName: vt.name, requestId: H.requestId, sessionVersionAtCall: versionAtCall, sessionVersionNow: this.getSession().sessionVersion });
      return { stale: true };
    }

    steps.push({ toolCall: tc, result: norm, iteration: iter, status: norm.success ? 'ok' : 'error', validatedArguments: vt.arguments, requestId: H.requestId });
    turnResults.push({ toolName: vt.name, callId: tc.callId, ok: norm.success, data: norm.success ? norm.data : undefined, error: norm.error });
    localHistory.push({ role: 'tool', content: JSON.stringify(this.serializeForLLM(norm)), toolCallId: tc.callId, toolName: tc.name });
    this.syncToSession(vt, norm);
    if (!norm.success) {
      H.emit?.('TOOL_FAILED', { toolName: vt.name, code: norm.error?.code, stage: 'provider' });
      return { stale: false, error: { code: 'TOOL_FAILED', message: norm.error?.message || 'Tool failed.' } };
    }
    return { stale: false };
  }

  private async executeTool(vt: ValidatedToolCall): Promise<any> {
    switch (vt.name) {
      case 'SEARCH_TRAINS': {
        // Always run a FRESH search (no cache, no stale-reuse). RailwaySearchOrchestrator
        // will also invalidate dependent state if route/date changed.
        return this.searchOrch.trySearch('', {
          origin: vt.arguments.origin, destination: vt.arguments.destination, date: vt.arguments.date,
          passengerCount: vt.arguments.passengersCount,
          preferredClass: vt.arguments.preferredClass, preferredTime: vt.arguments.preferredTime
        });
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
  private serializeForLLM(r: NormalizedToolResult): any {
    // Prompt 14: the full PNR never goes back into LLM context
    if (r.success && r.toolName === 'CHECK_PNR') return { ok: true, data: { ...r.data, pnr: maskPnr(r.data?.pnr) }, toolName: r.toolName };
    if (r.success) return { ok: true, data: r.data, toolName: r.toolName };
    return { ok: false, error: r.error, toolName: r.toolName };
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
        this.commitSession({ availability: { ...(s.availability || {}), [vt.arguments.travelClass]: { ...r.data, dataSource: source, ...r.provenance } } } as any);
        H.emit?.('AVAILABILITY_CHECKED', { trainNumber: r.data?.trainNumber, travelClass: r.data?.travelClass, status: r.data?.status, date: r.data?.date });
        break;
      }
      case 'GET_FARE': {
        const s = this.getSession();
        // Route the fare was computed for (authoritative session journey) → freshness check can detect route changes.
        this.commitSession({ fare: { ...r.data, dataSource: source, origin: s.origin, destination: s.destination, date: vt.arguments.date || s.date, ...r.provenance } } as any);
        H.emit?.('FARE_CHECKED', { trainNumber: r.data?.trainNumber, travelClass: r.data?.travelClass, total: r.data?.total, passengersCount: r.data?.passengersCount });
        break;
      }
    }
  }
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
