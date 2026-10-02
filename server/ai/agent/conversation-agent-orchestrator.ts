/**
 * ConversationAgentOrchestrator (Prompt 8) — stateful multi-turn booking engine.
 *
 * One pipeline for TEXT and VOICE:
 *   normalized input → LLM (context: BookingSession view + pendingInteraction +
 *   versioned results) → [ContextualTurnApplier per decision] → REAL tool calls
 *   (validated) → RailwayProvider → normalized results → session sync → LLM …
 *   → deterministic flow advance → pendingInteraction → response (fact-guarded)
 *
 * Authority split:
 *   LLM      : interprets language, proposes entities/references/tool calls.
 *   Backend  : session state, railway facts, train/class identity, dates, routes,
 *              availability, fare, booking & confirmation state.
 *
 * Interruption safety: every turn is a request (sessionId, turnId, requestId,
 * requestVersion). Writes from an obsolete request are rejected
 * (STALE_TOOL_RESULT) and the obsolete loop stops.
 */
import type { LLMProvider } from '../providers/llm-provider';
import type { AgentDecision, OrchestratorError, TurnRecord, TurnToolRecord } from '../decisions/agent-decision';
import { ConversationStateManager } from '../state/conversation-state';
import { RailwayToolService } from '../../railway/tools/railway-tool-service';
import { LLMToolCallingRuntime, type ToolRuntimeResult, type ToolCallStep } from '../runtime/llm-tool-runtime';
import { BookingState } from '@shared/states';
import type { BookingSession, BookingEvent, PendingInteraction } from '@shared/entities';
import { redactSensitive as redact } from '../../observability/tool-logger';
import { NON_RAILWAY_PATTERNS, containsSensitiveRequest } from '../../security/validators/intent-validator';
import { v4 as uuid } from '../orchestrator/utils';
import { ContextualTurnApplier, type ApplyCtx, type ApplyOutcome } from '../context/turn-applier';
import { RequestGuard } from '../context/request-guard';
import { buildLLMContext, type HistoryMsg } from '../context/context-builder';
import { derivePendingInteraction, questionFor } from '../context/pending-interaction';
import { searchSummary, factFromTool } from '../context/response-formatter';
import { currentResults } from '../context/train-reference-resolver';
import { BookingPreparationService, type PrepOutcome } from '../../booking/booking-preparation-service';
import type { PreparationPolicy } from '../../booking/booking-readiness';
import type { ExecutionLogRecord } from '@shared/booking-execution';
import { BookingExecutionGateway } from '../../booking/execution/booking-execution-gateway';
import type { BookingExecutorRegistry } from '../../booking/execution/booking-executor-registry';
import type { ExecutionConfig } from '../../booking/execution/execution-config';

export interface ProcessTurnOptions {
  /** Optimistic concurrency: if supplied and different from the current
   *  sessionVersion, the turn is rejected with SESSION_VERSION_CONFLICT. */
  expectedSessionVersion?: number;
  /** For UI taps on a result card: the searchResultsVersion the card was
   *  rendered from. A tap on an outdated list → STALE_SEARCH_REFERENCE. */
  searchResultsVersion?: number;
  /** For a confirmation tap on a review card: the reviewVersion it was rendered
   *  from. Confirming an obsolete review → CONFIRMATION_VERSION_MISMATCH. */
  reviewVersion?: number;
}

export interface OrchestratorOptions {
  /** Booking preparation contract (fare/availability mandatory or not, freshness limits). */
  preparationPolicy?: Partial<PreparationPolicy>;
  /** Injectable clock for freshness evaluation (tests). */
  clock?: () => number;
  /** Prompt 10 — execution boundary. Defaults: production registry (Disabled only), fail-closed config. */
  executionConfig?: ExecutionConfig;
  executorRegistry?: BookingExecutorRegistry;
  executionGateway?: BookingExecutionGateway;
}

export interface AgentTurnResult {
  responseMessage: string;
  newState: BookingState;
  context: BookingSession;
  cards?: Array<{ type: string; data: any }>;
  toolActivity?: string;
  pendingInteraction?: PendingInteraction;
  /** True when this turn became obsolete (a newer turn started) — callers should ignore it. */
  stale?: boolean;
  error?: OrchestratorError;
  events: string[];
  turnLog: TurnRecord;
}

const SENSITIVE_REPLY = 'Main kabhi password, OTP, CAPTCHA, CVV, card, UPI PIN ya IRCTC credentials nahi maangta. Kripya aisi jaankari share na karein.';
const NON_RAILWAY_REPLY = 'Main railway booking aur train jaankari mein hi madad kar sakta hoon.';
const MAX_INPUT_CHARS = 500;
const MAX_TURN_HISTORY = 100;

export class ConversationAgentOrchestrator {
  private history: Map<string, HistoryMsg[]> = new Map();
  private turns: Map<string, TurnRecord[]> = new Map();
  private runtime: LLMToolCallingRuntime;
  private applier: ContextualTurnApplier;
  /** In-memory only (never logged): names at turn start, for log redaction. */
  private turnStartNames = new Map<string, string[]>();
  readonly preparation: BookingPreparationService;
  /** BookingExecutionGateway — reachable only from the backend confirmation path (never from the LLM). */
  readonly gateway: BookingExecutionGateway;

  constructor(
    private readonly llm: LLMProvider,
    private readonly state: ConversationStateManager,
    private readonly tools: RailwayToolService,
    options: OrchestratorOptions = {}
  ) {
    this.runtime = new LLMToolCallingRuntime(llm, tools);
    this.applier = new ContextualTurnApplier(state);
    this.gateway = options.executionGateway || new BookingExecutionGateway(state, { registry: options.executorRegistry, config: options.executionConfig, clock: options.clock });
    this.preparation = new BookingPreparationService(state, { policy: options.preparationPolicy, clock: options.clock, gateway: this.gateway });
  }

  getTurnHistory(sessionId: string): TurnRecord[] { return [...(this.turns.get(sessionId) || [])]; }
  getConversationHistory(sessionId: string): HistoryMsg[] { return [...(this.history.get(sessionId) || [])]; }

  async processTurn(sessionId: string, userText: string, mode: 'TEXT' | 'VOICE', opts: ProcessTurnOptions = {}): Promise<AgentTurnResult> {
    const startedAt = Date.now();
    const turnId = uuid();
    const requestId = uuid();
    const s0 = this.state.getSession(sessionId);
    // names present at turn start (a passenger removed this turn is still redacted in its log)
    this.turnStartNames.set(sessionId, (s0.passengers || []).map(p => p.name).filter((n): n is string => !!n));
    const stateBefore = s0.bookingState;
    const pendingBefore = s0.pendingInteraction?.type || 'NONE';
    const normalizedInput = normalizeInput(userText);
    // Sensitive input is never persisted verbatim (history / turn log).
    const sensitiveInput = containsSensitiveRequest(normalizedInput);
    const safeInput = sensitiveInput ? '[REDACTED SENSITIVE INPUT]' : normalizedInput;
    const cards: Array<{ type: string; data: any }> = [];
    const events: string[] = [];

    // ---- Session-version conflict (optimistic concurrency) ----
    if (typeof opts.expectedSessionVersion === 'number' && opts.expectedSessionVersion !== s0.sessionVersion) {
      const err: OrchestratorError = { code: 'SESSION_VERSION_CONFLICT', message: 'Session pehle hi update ho chuka hai. Latest details ke saath dobara bhejiye.' };
      return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
        message: err.message, error: err, rt: null, decision: null, changes: [] });
    }

    // ---- Stale UI reference (tap on a card from an older result list) ----
    if (typeof opts.searchResultsVersion === 'number' && opts.searchResultsVersion !== s0.searchResultsVersion) {
      const ts = currentResults(s0);
      const err: OrchestratorError = { code: 'STALE_SEARCH_REFERENCE', message: ts.length
        ? `Wo option purani list ka tha. Current results mein se chuniye: ${ts.map(t => t.trainNumber).join(', ')}.`
        : 'Wo option purani search ka tha. Nayi search ke results ka intezaar karein.' };
      return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
        message: err.message, error: err, rt: null, decision: null, changes: [] });
    }

    const requestVersion = this.state.beginRequest(sessionId, requestId);
    const guard = new RequestGuard(this.state, { sessionId, turnId, requestId, requestVersion });
    this.state.setMode(sessionId, mode); // same session across text/voice switches
    // ---- Handoff integrity (expiry / critical change) — before anything else this turn ----
    const preChanges: string[] = [];
    const handoffSync = this.preparation.syncHandoff(sessionId, { turnId, mode, cards, events, changes: preChanges });
    this.pushHistory(sessionId, { role: 'user', content: redact(safeInput) });

    // ---- Safety pre-filter (no LLM call) ----
    if (sensitiveInput) {
      // Nothing from this input is stored, logged or sent to the LLM. Continue with safe booking info.
      const q = questionFor(s0.pendingInteraction, s0, mode);
      const msg = q ? `${SENSITIVE_REPLY} ${q}` : SENSITIVE_REPLY;
      const err: OrchestratorError = { code: 'SENSITIVE_REQUEST_REJECTED', message: SENSITIVE_REPLY };
      return this.finish({ sessionId, turnId, requestId, startedAt, userText: safeInput, normalizedInput: safeInput, mode, stateBefore, pendingBefore, cards, events,
        message: msg, error: err, rejection: 'SENSITIVE_REQUEST_REJECTED', rt: null, decision: null, changes: [] });
    }
    if (NON_RAILWAY_PATTERNS.some(re => re.test(normalizedInput)) && !/(train|railway|pnr|ticket|kiraya|fare|ट्रेन|रेल)/i.test(normalizedInput)) {
      return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
        message: NON_RAILWAY_REPLY, rejection: 'UNKNOWN_INTENT', rt: null, decision: null, changes: [] });
    }

    // ---- Tool-calling loop with per-decision deterministic application ----
    const ctx: ApplyCtx = { turnId, mode, cards, events, changes: preChanges };
    let pendingOverride: PendingInteraction | undefined;
    const bound = this.runtime.bind(guard.getSession, guard.commit, {
      requestId,
      isStale: () => guard.isStale(),
      buildContext: () => buildLLMContext(this.state.getSession(sessionId), this.getHistory(sessionId)),
      emit: (type, data) => { if (!guard.isStale()) { this.state.emit(sessionId, type, turnId, data); events.push(type); } },
      applyDecision: (d: AgentDecision): ApplyOutcome => {
        if (guard.isStale()) return { notes: [], blockTools: true, applied: [], error: { code: 'STALE_TOOL_RESULT', message: '' } };
        const o = this.applier.apply(sessionId, d, ctx);
        if (o.pendingOverride) pendingOverride = o.pendingOverride;
        return o;
      }
    });
    let rt: ToolRuntimeResult;
    try {
      rt = await bound.run(normalizedInput, mode, this.getHistory(sessionId));
    } catch (e: any) {
      const err: OrchestratorError = { code: e?.code === 'INVALID_STATE_TRANSITION' ? 'INVALID_STATE_TRANSITION' : 'TOOL_FAILED', message: 'Maaf kijiye, ye step abhi complete nahi ho paaya. Kripya dobara try karein.' };
      return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
        message: err.message, error: { ...err, details: String(e?.message || e) }, rt: null, decision: null, changes: ctx.changes });
    }

    // ---- Obsolete request: never mutate further, never answer ----
    if (rt.stopReason === 'stale' || guard.stale) {
      return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards: [], events,
        message: '', stale: true, error: { code: 'STALE_TOOL_RESULT', message: 'Late result from an obsolete request was ignored.' }, rt, decision: rt.finalDecision, changes: ctx.changes });
    }

    for (const st of rt.steps) {
      this.pushHistory(sessionId, { role: 'tool', content: JSON.stringify({ ok: st.result.success, error: st.result.error?.code }), toolCallId: st.toolCall.callId, toolName: st.toolCall.name });
    }

    // ---- Deterministic booking preparation (readiness, fresh data, review, confirmation) ----
    const blockErr = rt.stopReason === 'blocked' ? rt.error : undefined;
    const progress: string[] = [];
    let prep: PrepOutcome | undefined;
    let dupExecution: ExecutionLogRecord | undefined;
    progress.push(...handoffSync.notes);
    if (!blockErr) {
      const searchOk = rt.steps.some(st => st.result.toolName === 'SEARCH_TRAINS' && st.status === 'ok');
      if (searchOk) progress.push(...this.applier.applyCarryOver(sessionId, ctx));
      else this.state.getSession(sessionId).carryOverSelection = undefined;
      const confirm = rt.applyOutcomes.some(o => o.confirmRequested);
      try {
        prep = await this.preparation.advance(sessionId, ctx, calls => bound.runTools(calls), { confirm, reviewVersion: opts.reviewVersion, approveReview: rt.applyOutcomes.some(o => o.applied.includes('REVIEW_APPROVED')) });
      } catch (e: any) {
        const err: OrchestratorError = { code: e?.code === 'INVALID_STATE_TRANSITION' ? 'INVALID_STATE_TRANSITION' : 'TOOL_FAILED', message: 'Maaf kijiye, ye step abhi complete nahi ho paaya. Kripya dobara try karein.' };
        return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
          message: err.message, error: { ...err, details: String(e?.message || e) }, rt, decision: rt.finalDecision, changes: ctx.changes });
      }
      if (prep.stale || guard.isStale()) {
        return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards: [], events,
          message: '', stale: true, error: { code: 'STALE_TOOL_RESULT', message: 'Late result from an obsolete request was ignored.' }, rt, decision: rt.finalDecision, changes: ctx.changes, prepSteps: prep.steps });
      }
      progress.push(...prep.notes);
      for (const st of prep.steps) {
        if (st.status !== 'ok') continue;
        if (st.result.toolName === 'CHECK_AVAILABILITY') cards.push({ type: 'availability', data: { ...st.result.data, refreshedForReview: true } });
        if (st.result.toolName === 'GET_FARE') cards.push({ type: 'fare', data: { ...st.result.data, refreshedForReview: true } });
      }
    } else {
      if (blockErr.code === 'BOOKING_EXECUTION_DISABLED' && rt.applyOutcomes.some(o => o.duplicateConfirmation)) {
        // repeated "haan" after the handoff → gateway idempotency (same handoff, executor not re-invoked)
        dupExecution = await this.preparation.duplicateConfirmation(sessionId, ctx);
      }
      this.preparation.evaluate(sessionId);
    }
    const sess = this.state.getSession(sessionId);
    const override = pendingOverride ?? prep?.pendingOverride;
    // A pending override from a turn that then moved the flow elsewhere must not stick.
    const overrideValid = !override || !prep || prep.pendingOverride === override || sess.bookingState !== BookingState.AWAITING_CONFIRMATION || override.type === 'PASSENGER_DETAILS_REQUIRED' || override.type === 'CLARIFICATION_REQUIRED' || !!override.data?.correction;
    sess.pendingInteraction = { ...((overrideValid && override) || derivePendingInteraction(sess)), setAtTurnId: turnId };

    const message = this.compose(sess, rt, blockErr, progress, cards, mode, handoffSync.notes);
    const softError = rt.applyOutcomes.find(o => o.softError)?.softError;
    return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
      message, error: blockErr || prep?.error || handoffSync.error || softError || (rt.stopReason === 'tool_limit' || rt.stopReason === 'error' ? rt.error : undefined), rt, decision: rt.finalDecision, changes: ctx.changes, prepSteps: prep?.steps,
      execution: prep?.execution || dupExecution });
  }

  // ---------------------------------------------------------------- composition

  private compose(s: BookingSession, rt: ToolRuntimeResult, blockErr: OrchestratorError | undefined, progress: string[], cards: any[], mode: 'TEXT' | 'VOICE', preNotes: string[] = []): string {
    const parts: string[] = [];
    const q = questionFor(s.pendingInteraction, s, mode);
    if (blockErr) {
      parts.push(...preNotes);
      parts.push(blockErr.message);
      if (q && !/\?\s*$/.test(blockErr.message) && !blockErr.message.includes(q)) parts.push(q);
      return joinParts(parts);
    }
    for (const o of rt.applyOutcomes) parts.push(...o.notes);
    for (const o of rt.applyOutcomes) if (o.directAnswer) parts.push(o.directAnswer);

    const searchOk = rt.steps.some(st => st.result.toolName === 'SEARCH_TRAINS' && st.status === 'ok');
    if (searchOk) {
      parts.push(searchSummary(s, mode));
      cards.push({ type: 'trains', data: { trains: currentResults(s), searchResultsVersion: s.searchResultsVersion, source: s.providerSource || 'mock', retrievedAt: s.searchMeta?.retrievedAt } });
    }
    const nonSearch = rt.steps.filter(st => st.result.toolName !== 'SEARCH_TRAINS');
    const searchFailed = rt.steps.some(st => st.result.toolName === 'SEARCH_TRAINS' && st.status !== 'ok');
    const llmFinalUseful = !!rt.finalMessage && (nonSearch.length > 0 || searchFailed || (rt.steps.length === 0 && !!rt.finalDecision.finalMessage));
    if (llmFinalUseful) parts.push(factGuard(rt.finalMessage, rt.steps, mode));
    for (const st of nonSearch) {
      if (st.status !== 'ok') continue;
      if (st.result.toolName === 'CHECK_AVAILABILITY') cards.push({ type: 'availability', data: st.result.data });
      if (st.result.toolName === 'GET_FARE') cards.push({ type: 'fare', data: st.result.data });
      if (st.result.toolName === 'GET_TRAIN_INFO') cards.push({ type: 'train_info', data: st.result.data });
      if (st.result.toolName === 'GET_TIMETABLE') cards.push({ type: 'timetable', data: st.result.data });
    }
    parts.push(...progress);
    if (rt.stopReason === 'tool_limit' && rt.error) parts.push(rt.error.message);
    const joined = parts.join(' ');
    if (q && !joined.includes(q)) parts.push(q);
    if (!parts.length) parts.push(rt.finalDecision.clarification || 'Main train search, selection, availability aur fare mein madad kar sakta hoon.');
    return joinParts(parts);
  }

  // ---------------------------------------------------------------- turn record

  private finish(a: {
    sessionId: string; turnId: string; requestId: string; startedAt: number; userText: string; normalizedInput: string;
    mode: 'TEXT' | 'VOICE'; stateBefore: BookingState; pendingBefore: string; cards: any[]; events: string[];
    message: string; error?: OrchestratorError; rejection?: string; stale?: boolean;
    rt: ToolRuntimeResult | null; decision: AgentDecision | null; changes: string[]; prepSteps?: ToolCallStep[];
    execution?: ExecutionLogRecord;
  }): AgentTurnResult {
    const s = this.state.getSession(a.sessionId);
    if (!a.stale && a.message) this.pushHistory(a.sessionId, { role: 'assistant', content: a.message });
    const steps: ToolCallStep[] = [...(a.rt?.steps || []), ...(a.prepSteps || [])];
    // Observability privacy: passenger names are masked in the turn record.
    const pii = (t: string) => containsSensitiveRequest(t) ? '[REDACTED SENSITIVE INPUT]' : redactPassengerNames(redact(t), s, this.turnStartNames.get(a.sessionId) || []);
    const toolResults: TurnToolRecord[] = steps.map(st => ({
      toolCallId: st.toolCall.callId, toolName: st.toolCall.name,
      validatedArguments: st.validatedArguments ? redact(st.validatedArguments) : undefined,
      resultStatus: st.status, errorCode: st.result.error?.code, provider: st.result.provider, latencyMs: st.result.latencyMs
    }));
    const turnLog: TurnRecord = {
      sessionId: a.sessionId, turnId: a.turnId, requestId: a.requestId, sessionVersion: s.sessionVersion,
      timestamp: new Date().toISOString(), stateBefore: a.stateBefore, stateAfter: s.bookingState,
      userInput: pii(a.userText), normalizedInput: pii(a.normalizedInput), inputMode: a.mode,
      intent: a.decision?.intent, action: a.decision?.action, confidence: a.decision?.confidence,
      detectedChanges: a.changes,
      toolCalls: steps.map(st => ({ name: st.toolCall.name, arguments: redact(st.toolCall.arguments) })),
      toolExecuted: steps.map(st => ({ name: st.result.toolName, ok: st.result.success, latencyMs: st.result.latencyMs, provider: st.result.provider })),
      toolResults,
      toolResultStatus: steps.length === 0 ? 'none' : steps.every(st => st.result.success) ? 'ok' : 'error',
      pendingInteractionBefore: a.pendingBefore, pendingInteractionAfter: a.stale ? a.pendingBefore : (s.pendingInteraction?.type || 'NONE'),
      events: a.events, staleResultRejected: !!a.stale,
      rejectionReason: a.rejection || (a.error?.message ? pii(a.error.message) : undefined), errorCode: a.error?.code,
      assistantResponse: a.stale ? '' : pii(a.message),
      llmProvider: this.llm.providerId, llmLatencyMs: a.rt?.llmLatencyMs,
      bookingReadiness: s.readiness ? { ready: s.readiness.ready, blockers: s.readiness.blockers, warnings: s.readiness.warnings } : undefined,
      missingFields: s.readiness?.missingFields,
      reviewVersion: s.review?.valid ? s.review.reviewVersion : undefined,
      confirmationVersion: s.confirmedReviewVersion,
      execution: a.execution,
      handoffId: s.handoff?.snapshot.handoffId,
      handoffStatus: s.handoff?.status,
      bookingLifecycle: s.bookingLifecycle?.status,
      latencyMs: Date.now() - a.startedAt
    };
    const th = this.turns.get(a.sessionId) || [];
    th.push(turnLog);
    if (th.length > MAX_TURN_HISTORY) th.splice(0, th.length - MAX_TURN_HISTORY);
    this.turns.set(a.sessionId, th);
    if (process.env.LOG_TURNS === '1') console.log(JSON.stringify({ kind: 'turn', ...turnLog }));

    return {
      responseMessage: a.stale ? '' : a.message,
      newState: s.bookingState,
      context: s,
      cards: a.cards,
      toolActivity: steps.map(st => `${st.toolCall.name}:${st.status}`).join(', ') || undefined,
      pendingInteraction: s.pendingInteraction,
      stale: a.stale,
      error: a.error,
      events: a.events,
      turnLog
    };
  }

  private pushHistory(sid: string, m: HistoryMsg) {
    const h = this.history.get(sid) || [];
    h.push(m);
    if (h.length > 60) h.splice(0, h.length - 60);
    this.history.set(sid, h);
  }
  private getHistory(sid: string): HistoryMsg[] { return this.history.get(sid) || []; }
}

// ------------------------------------------------------------------ helpers

export function normalizeInput(text: string): string {
  return String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_INPUT_CHARS);
}

/** Mask stored passenger names (full + individual tokens) in observability text. */
export function redactPassengerNames(text: string, s: BookingSession, extraNames: Iterable<string> = []): string {
  let out = String(text || '');
  const toks = new Set<string>();
  for (const name of [...(s.passengers || []).map(p => p.name), ...extraNames]) {
    if (!name) continue;
    toks.add(name);
    for (const w of name.split(/\s+/)) if (w.length >= 3) toks.add(w);
  }
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const t of [...toks].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(^|[^\\p{L}])${esc(t)}(?=$|[^\\p{L}])`, 'giu'), '$1[PASSENGER_NAME]');
  }
  return out;
}

function joinParts(parts: string[]): string {
  const ps = parts.map(p => p.trim()).filter(Boolean);
  return ps.some(p => p.includes('\n')) ? ps.join('\n') : ps.join(' ');
}

/**
 * Fact guard — the final LLM message may only restate facts present in this
 * turn's tool results. If it upgrades availability (e.g. "confirmed seat" when
 * the provider said RAC/Waitlist) or mentions a ₹ amount absent from the fare
 * result, it is replaced by deterministic phrasing of the actual results.
 */
export function factGuard(message: string, steps: ToolCallStep[], mode: 'TEXT' | 'VOICE'): string {
  const ok = steps.filter(st => st.status === 'ok' && st.result.toolName !== 'SEARCH_TRAINS');
  if (!ok.length) return message;
  const deterministic = () => ok.map(st => factFromTool(st.result.toolName, st.result.data, mode)).filter(Boolean).join(' ');
  const avail = ok.filter(st => st.result.toolName === 'CHECK_AVAILABILITY').map(st => String(st.result.data?.status || ''));
  if (avail.length && avail.every(a => !/^available/i.test(a)) && /(confirm(ed)?\s*seat|seat\s*confirm|confirmed|pakki seat)/i.test(message)) return deterministic();
  const amounts = [...message.matchAll(/₹\s?(\d+)/g)].map(m => Number(m[1]));
  if (amounts.length) {
    const known = new Set<number>();
    for (const st of ok) if (st.result.toolName === 'GET_FARE') { known.add(Number(st.result.data?.perPassenger)); known.add(Number(st.result.data?.total)); }
    if (amounts.some(a => !known.has(a))) return deterministic();
  }
  return message;
}
