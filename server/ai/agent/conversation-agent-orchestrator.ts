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
import type { ReconciliationConfig } from '../../booking/lifecycle/reconciliation-config';
import type { BookingProviderRegistry } from '../../booking/provider/booking-provider-registry';
import type { BookingProviderConfig } from '../../booking/provider/booking-provider-config';
import type { LLMProvider } from '../providers/llm-provider';
import type { AgentDecision, OrchestratorError, TurnRecord, TurnToolRecord } from '../decisions/agent-decision';
import { ConversationStateManager } from '../state/conversation-state';
import { RailwayToolService } from '../../railway/tools/railway-tool-service';
import { LLMToolCallingRuntime, type ToolRuntimeResult, type ToolCallStep } from '../runtime/llm-tool-runtime';
import { BookingState } from '@shared/states';
import type { BookingSession, BookingEvent, PendingInteraction } from '@shared/entities';
import { bindAndVerifyClaims } from '../response/claim-entity-binding';
import { redactSensitive as redact } from '../../observability/tool-logger';
import { NON_RAILWAY_PATTERNS, containsSensitiveRequest } from '../../security/validators/intent-validator';
import { v4 as uuid } from '../orchestrator/utils';
import { ContextualTurnApplier, type ApplyCtx, type ApplyOutcome } from '../context/turn-applier';
import { RequestGuard } from '../context/request-guard';
import { buildLLMContext, type HistoryMsg } from '../context/context-builder';
import { ConversationContextManager, pendingQuestionOf, summarizeContext } from '../conversation/conversation-context';
import { normalizeUtterance } from '../conversation/input-normalizer';
import { railwayResponseGrounding, UNVERIFIED_FALLBACK } from '../tool-runtime/railway-response-grounding';
import { isExplicitFreshRequest } from '../tool-runtime/freshness';
import { syncJourneyVersion } from '../tool-runtime/journey-version';
import { buildAssistantResponse } from '../conversation/assistant-response';
import type { AssistantResponse, ConversationContext, ContextPatch, RejectedPatch } from '@shared/conversation-context';
import { derivePendingInteraction, questionFor } from '../context/pending-interaction';
import { searchSummary, factFromTool, liveToolMessage, LIVE_TOOLS, humanDate, shortName } from '../context/response-formatter';
import { PostBookingService } from '../../booking/post-booking/post-booking-service';
import type { BookingHistoryStore } from '../../booking/post-booking/booking-history-store';
import { BookingLifecycleActionService, type LifecycleActionServiceOptions } from '../../booking/lifecycle-actions/booking-lifecycle-action-service';
import type { LifecycleActionErrorCode } from '@shared/booking-lifecycle-action';
import { maskPnrsInText, maskPnrDeep } from '../../booking/post-booking/pnr-validator';
import { currentResults } from '../context/train-reference-resolver';
import { BookingPreparationService, type PrepOutcome } from '../../booking/booking-preparation-service';
import type { PreparationPolicy } from '../../booking/booking-readiness';
import type { ExecutionLogRecord } from '@shared/booking-execution';
import { BookingHandoffSessionService } from '../../booking/handoff/booking-handoff-session-service';
import type { BookingExecutorAdapterRegistry } from '../../booking/handoff/booking-executor-adapter-registry';
import { BookingExecutionGateway } from '../../booking/execution/booking-execution-gateway';
import type { BookingExecutorRegistry } from '../../booking/execution/booking-executor-registry';
import type { ExecutionConfig } from '../../booking/execution/execution-config';
import type { TurnLoopObserver } from '../runtime/llm-tool-runtime';
import { ConversationContextBuilder, ToolResultContextStore } from '../turn-engine/conversation-context-builder';
import { pendingQuestionCode } from '../turn-engine/pending-question';
import { detectBareDay, resolveMonthAnswer } from '../turn-engine/ambiguous-date-clarifier';
import { parsePassengerCount } from '../../booking/preparation/passenger-count';
import { syncPreparationState, recordDependencyOutcome, bookingPreparationSummary } from '../../booking/preparation/booking-preparation';
import { classifyAgentTurn } from '../decisions/state-actions';
import { preparationErrorTypeOf } from '@shared/booking-preparation';
import { SAFE_ERROR_MESSAGE } from '../tool-runtime/tool-error-normalizer';
import { naturalResponseComposer, type NaturalComposeResult } from '../response/natural-response-composer';
import { speechOf } from '../conversation/assistant-response';
import { actionLedgerFromSteps, guardActionClaims, type ActionExecution, type ActionClaimDiagnostic } from '../response/action-claims';

export interface ProcessTurnOptions {
  /** Prompt 17: client-generated id of ONE user message. A duplicate DELIVERY (retry, reconnect,
   *  double submit, duplicate STT/TTS event) replays the original turn instead of re-executing tools.
   *  A NEW message (new id) — including "abhi dobara check karo" — always runs fresh. */
  clientMessageId?: string;
  /** Optimistic concurrency: if supplied and different from the current
   *  sessionVersion, the turn is rejected with SESSION_VERSION_CONFLICT. */
  expectedSessionVersion?: number;
  /** For UI taps on a result card: the searchResultsVersion the card was
   *  rendered from. A tap on an outdated list → STALE_SEARCH_REFERENCE. */
  searchResultsVersion?: number;
  /** For a confirmation tap on a review card: the reviewVersion it was rendered
   *  from. Confirming an obsolete review → CONFIRMATION_VERSION_MISMATCH. */
  reviewVersion?: number;
  /** Prompt 18: the ConversationTurnEngine owns the logical turn id (one user message = one turn). */
  turnId?: string;
  /** Prompt 18: turn lifecycle / streaming observer (status + events only — never mutates the session). */
  observer?: TurnLoopObserver & { onStatus?: (status: 'GENERATING_RESPONSE') => void };
  /** Prompt 21: a grounded natural-speech sentence is ready (VOICE; streamed before the turn completes). */
  onSpeechSegment?: (index: number, text: string) => void;
  /** Prompt 21: disable the LLM-worded natural speech for this turn (deterministic speech only). */
  naturalSpeech?: boolean;
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
  /** Prompt 12: booking PROVIDER registry (production: disabled provider only) + server-side config. */
  bookingProviderRegistry?: BookingProviderRegistry;
  bookingProviderConfig?: BookingProviderConfig;
  /** Prompt 13: bounded status reconciliation (deterministic config, injectable sleep for tests). */
  bookingReconciliation?: { config?: Partial<ReconciliationConfig>; sleep?: (ms: number) => Promise<void> };
  /** Prompt 11: executor ADAPTER registry (production: disabled adapter only). */
  adapterRegistry?: BookingExecutorAdapterRegistry;
  /** Prompt 21: timeout for the LLM-worded natural spoken reply (falls back to deterministic speech). */
  naturalSpeechTimeoutMs?: number;
  /** Prompt 11: handoff session service override (tests). */
  handoffSessionService?: BookingHandoffSessionService;
  /** Prompt 14: post-booking history store (default: in-memory, session-scoped). */
  bookingHistoryStore?: BookingHistoryStore;
  /** Prompt 15: lifecycle-action tuning (timeouts, reconciliation, confirmation TTL) — tests only. */
  lifecycleActions?: Partial<Pick<LifecycleActionServiceOptions, 'timeoutMs' | 'confirmationTtlMs' | 'reconcile' | 'sleep' | 'today'>>;
}

export interface AgentTurnResult {
  /** Prompt 17: true when this is a replay of an already-processed client message (no tool re-execution). */
  duplicateDelivery?: boolean;
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
  /** Prompt 16: structured response (text + concise validated speechText) and derived context. */
  assistantResponse: AssistantResponse;
  conversationContext: ConversationContext;
  /** Prompt 21: VOICE speech plan (LLM-worded + grounded, or deterministic fallback). */
  speech?: { segments: string[]; source: 'LLM' | 'FALLBACK'; language: string; fallbackReason?: string };
  /** Prompt 22: the text shown to the user (grounded LLM wording in TEXT and VOICE; backend reply as fallback). */
  assistantText?: string;
}

/** Prompt 16: per-turn observability extras carried to finish(). */
interface TurnExtras {
  /** Prompt 25 Part 10/17: why a second (wording) LLM call was allowed this turn (null = none needed). */
  secondCallReason?: string | null;
  interruption?: boolean;
  contextBefore?: ReturnType<typeof summarizeContext>;
  pqBefore?: ReturnType<typeof pendingQuestionOf>;
  patches?: ContextPatch[];
  rejectedPatches?: RejectedPatch[];
  rejectedClaims?: string[];
  backendActions?: string[];
  naturalSpeech?: NaturalComposeResult;
  /** Prompt 28: backend-reply sentences removed by claim ↔ entity binding (reasons only). */
  entityRejections?: Array<{ sentence: string; reason: string; binding: string }>;
  /** Prompt 29: action / progress statements checked against this turn's actual executions (codes + ids only). */
  actionClaims?: ActionClaimDiagnostic[];
}

const SENSITIVE_REPLY = 'Main kabhi password, OTP, CAPTCHA, CVV, card, UPI PIN ya IRCTC credentials nahi maangta. Kripya aisi jaankari share na karein.';
const NON_RAILWAY_REPLY = 'Main railway booking aur train information mein help kar sakta hoon.';
const MAX_INPUT_CHARS = 500;
const MAX_TURN_HISTORY = 100;

/** Prompt 19: the bare-day month answer rewrote the input ("October" → "22 October") — not a count statement. */
function llmInputChanged(llmInput: string, normalized: string): boolean { return llmInput !== normalized; }

/** Prompt 27: decisions that mean the user wants to BOOK (ends an information-only selection). */
const BOOKING_SIGNAL_INTENTS = new Set(['BOOK_TRAIN', 'UPDATE_PASSENGERS', 'COLLECT_PASSENGER_DETAILS', 'SHOW_REVIEW', 'CONFIRM_BOOKING']);
/** Prompt 27: states before booking preparation (an informational selection may only be made from these). */
const ORDER_BEFORE_PREP = new Set<string>([BookingState.IDLE, BookingState.COLLECTING_JOURNEY, BookingState.COLLECTING_DATE, BookingState.COLLECTING_PASSENGERS,
  BookingState.SEARCHING_TRAINS, BookingState.SHOWING_TRAINS, BookingState.TRAIN_SELECTED, BookingState.CLASS_OPTIONS, BookingState.CLASS_SELECTED]);

export class ConversationAgentOrchestrator {
  private history: Map<string, HistoryMsg[]> = new Map();
  /** Prompt 29: the previous turn's executions per session — only to label a leaked progress claim STALE (never authority). */
  private lastActions: Map<string, ActionExecution[]> = new Map();
  private turns: Map<string, TurnRecord[]> = new Map();
  private runtime: LLMToolCallingRuntime;
  private applier: ContextualTurnApplier;
  /** In-memory only (never logged): names at turn start, for log redaction. */
  private turnStartNames = new Map<string, string[]>();
  readonly preparation: BookingPreparationService;
  /** BookingExecutionGateway — reachable only from the backend confirmation path (never from the LLM). */
  readonly gateway: BookingExecutionGateway;
  /** Prompt 14: post-booking read model + controlled history queries (backend only — never an LLM tool). */
  readonly postBooking: PostBookingService;
  /** Prompt 15: cancellation / modification / refund status — backend-controlled (never an LLM tool). */
  readonly lifecycleActions: BookingLifecycleActionService;
  /** Prompt 16: derived conversation context + tiny conversational memory (never authoritative). */
  readonly context = new ConversationContextManager();
  /** Prompt 18: structured tool-result memory (bounded; HISTORICAL across turns — never a data cache). */
  readonly toolResultMemory = new ToolResultContextStore();
  readonly contextBuilder = new ConversationContextBuilder(this.toolResultMemory);

  constructor(
    private readonly llm: LLMProvider,
    private readonly state: ConversationStateManager,
    private readonly tools: RailwayToolService,
    options: OrchestratorOptions = {}
  ) {
    this.runtime = new LLMToolCallingRuntime(llm, tools);
    this.naturalSpeechTimeoutMs = options.naturalSpeechTimeoutMs;
    this.gateway = options.executionGateway || new BookingExecutionGateway(state, { registry: options.executorRegistry, config: options.executionConfig, clock: options.clock, providerRegistry: options.bookingProviderRegistry, providerConfig: options.bookingProviderConfig, reconciliation: options.bookingReconciliation?.config, sleep: options.bookingReconciliation?.sleep });
    // Prompt 14: BookingRecords are derived ONLY from the P13 lifecycle (single writer of execution status)
    this.postBooking = new PostBookingService(state, { store: options.bookingHistoryStore, clock: options.clock });
    this.postBooking.attach(this.gateway.bookingProviders.lifecycle);
    this.lifecycleActions = new BookingLifecycleActionService(state, {
      store: this.postBooking.store, providers: { registry: this.gateway.bookingProviders.registry, config: this.gateway.bookingProviders.config },
      clock: options.clock, ...(options.lifecycleActions || {})
    });
    this.applier = new ContextualTurnApplier(state, this.postBooking, this.lifecycleActions);
    this.preparation = new BookingPreparationService(state, {
      policy: options.preparationPolicy, clock: options.clock, gateway: this.gateway,
      handoffSessions: options.handoffSessionService || new BookingHandoffSessionService({ registry: options.adapterRegistry, config: this.gateway.config, clock: options.clock })
    });
  }

  private readonly naturalSpeechTimeoutMs?: number;

  getTurnHistory(sessionId: string): TurnRecord[] { return [...(this.turns.get(sessionId) || [])]; }
  getConversationHistory(sessionId: string): HistoryMsg[] { return [...(this.history.get(sessionId) || [])]; }

  /** Prompt 17: per-session duplicate-delivery map (bounded; NOT a railway data cache). */
  private deliveries = new Map<string, Map<string, Promise<AgentTurnResult>>>();

  async processTurn(sessionId: string, userText: string, mode: 'TEXT' | 'VOICE', opts: ProcessTurnOptions = {}): Promise<AgentTurnResult> {
    if (opts.clientMessageId) {
      const id = String(opts.clientMessageId).slice(0, 100);
      const m = this.deliveries.get(sessionId) || new Map<string, Promise<AgentTurnResult>>();
      this.deliveries.set(sessionId, m);
      const prior = m.get(id);
      if (prior) { const r = await prior; return { ...r, duplicateDelivery: true }; }
      const p = this.processTurn(sessionId, userText, mode, { ...opts, clientMessageId: undefined });
      m.set(id, p);
      while (m.size > 50) m.delete(m.keys().next().value as string);
      return p;
    }
    const startedAt = Date.now();
    const turnId = opts.turnId || uuid();
    const requestId = uuid();
    const s0 = this.state.getSession(sessionId);
    // names present at turn start (a passenger removed this turn is still redacted in its log)
    this.turnStartNames.set(sessionId, (s0.passengers || []).map(p => p.name).filter((n): n is string => !!n));
    const stateBefore = s0.bookingState;
    // Prompt 21: primitives captured before the turn (the session object itself is live)
    const voiceBefore = { reviewVersion: s0.review?.valid ? s0.review.reviewVersion : null, train: (s0.selectedTrain as any)?.number ?? null, cls: s0.selectedClass ?? null, count: s0.passengersCount ?? null };
    const pendingBefore = s0.pendingInteraction?.type || 'NONE';
    // Prompt 16: Input Normalizer — barge-in prefix ("Ruko, …") + explicit new-booking phrase
    const utter = normalizeUtterance(normalizeInput(userText));
    const normalizedInput = utter.text;
    const contextBefore = summarizeContext(this.context.snapshot(s0, this.activeBookingOf(sessionId)), s0);
    const pqBefore = pendingQuestionOf(s0.pendingInteraction);
    const extra = { interruption: utter.interruption, contextBefore, pqBefore } as TurnExtras;
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
    const handoffSync = this.preparation.syncHandoff(sessionId, { turnId, mode, cards, events, changes: preChanges, requestId });
    this.pushHistory(sessionId, { role: 'user', content: maskPnrsInText(redact(safeInput)) });

    // ---- Safety pre-filter (no LLM call) ----
    if (sensitiveInput) {
      // Nothing from this input is stored, logged or sent to the LLM. Continue with safe booking info.
      const q = questionFor(s0.pendingInteraction, s0, mode);
      const msg = q ? `${SENSITIVE_REPLY} ${q}` : SENSITIVE_REPLY;
      const err: OrchestratorError = { code: 'SENSITIVE_REQUEST_REJECTED', message: SENSITIVE_REPLY };
      return this.finish({ sessionId, turnId, requestId, startedAt, userText: safeInput, normalizedInput: safeInput, mode, stateBefore, pendingBefore, cards, events,
        message: msg, error: err, rejection: 'SENSITIVE_REQUEST_REJECTED', rt: null, decision: null, changes: [] });
    }
    // Prompt 22: off-topic input is no longer short-circuited before the LLM — the LLM interprets every
    // non-sensitive turn first; the scope guard below only validates its outcome (safety refusal).

    // ---- Prompt 18 (Part 52): bare day number ("22") → ask which month; never assume ----
    let llmInput = normalizedInput;
    const pi0 = s0.pendingInteraction;
    if (pi0?.type === 'CLARIFICATION_REQUIRED' && pi0.data?.kind === 'DATE_MONTH') {
      const expr = resolveMonthAnswer(normalizedInput, pi0.data as any);
      if (expr) llmInput = expr;   // "October" → "22 October" — DateResolver stays authoritative
    } else if (!utter.newBooking) {
      const amb = detectBareDay(normalizedInput, s0);
      if (amb) {
        const sA = this.state.getSession(sessionId);
        sA.pendingInteraction = { type: 'CLARIFICATION_REQUIRED', hint: amb.message, setAtTurnId: turnId,
          data: { kind: 'DATE_MONTH', day: amb.day, candidates: amb.candidates, labels: amb.labels } } as any;
        (sA as any).pendingQuestion = pendingQuestionCode(sA.pendingInteraction);
        return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
          message: amb.message, error: { code: 'AMBIGUOUS_DATE', message: amb.message }, rt: null, decision: null, changes: [], extra });
      }
    }

    // ---- Prompt 19 (Part 3): invalid passenger count ("zero" / "minus two" / "100 passengers") → deterministic
    //      INVALID_PASSENGER_COUNT from the user's OWN words; an LLM can never silently "correct" it ----
    if (!utter.newBooking && !llmInputChanged(llmInput, normalizedInput)) {
      const pc = parsePassengerCount(normalizedInput, { expectingCount: s0.pendingInteraction?.type === 'PASSENGERS_REQUIRED' });
      if (pc?.kind === 'INVALID') {
        const sP = this.state.getSession(sessionId);
        if (!sP.pendingInteraction || sP.pendingInteraction.type !== 'PASSENGERS_REQUIRED') {
          sP.pendingInteraction = { type: 'PASSENGERS_REQUIRED', setAtTurnId: turnId } as any;
        }
        (sP as any).pendingQuestion = pendingQuestionCode(sP.pendingInteraction);
        events.push('PASSENGER_COUNT_REJECTED');
        return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
          message: pc.message, error: { code: 'INVALID_PASSENGER_COUNT', message: pc.message, details: { reason: pc.reason } }, rt: null, decision: null, changes: [], extra });
      }
    }

    // ---- Prompt 22: an explicit NEW BOOKING is interpreted by the LLM (entities.newJourney) — never by a pre-LLM
    //      regex. The backend only GROUNDS that proposal in the user's own words (Prompt 16 phrase set) and performs
    //      the validated journey reset (history store untouched); the LLM then decides again on the fresh journey.
    let newJourneyDone = false;
    // ---- Prompt 27: the LLM's own interpretation of WHY it selects (information vs booking) — honoured, never inferred ----
    let infoSelection = false, bookingSignal = false;

    // ---- Tool-calling loop with per-decision deterministic application ----
    const ctx: ApplyCtx = { turnId, mode, cards, events, changes: preChanges, rawText: llmInput, requestId, contextPatches: [], rejectedPatches: [] };
    extra.patches = ctx.contextPatches; extra.rejectedPatches = ctx.rejectedPatches;
    let pendingOverride: PendingInteraction | undefined;
    const bound = this.runtime.bind(guard.getSession, guard.commit, {
      requestId,
      // Prompt 17: correlation ids for tool execution records + explicit fresh request (never cached anyway)
      sessionId, turnId, forceFresh: isExplicitFreshRequest(llmInput), observer: opts.observer,
      isStale: () => guard.isStale(),
      buildContext: () => {
        // Prompt 16: structured context package — authoritative session view + structured conversation
        // context + journey-scoped recent turns (never the unlimited transcript)
        // Prompt 18: ConversationContextBuilder — bounded recent turns + authoritative turn context
        // (pending question code, journeyVersion, structured tool results; earlier turns HISTORICAL)
        const sc = this.state.getSession(sessionId);
        const cc = this.context.snapshot(sc, this.activeBookingOf(sessionId));
        return { ...this.contextBuilder.build({ session: sc, history: this.getHistory(sessionId), turnId, postBooking: this.postBooking.contextFor(sessionId),
            intents: { lastUserIntent: cc.lastUserIntent, lastAssistantIntent: cc.lastAssistantIntent } }),
          conversationContext: summarizeContext(cc, sc) };
      },
      emit: (type, data) => { if (!guard.isStale()) { this.state.emit(sessionId, type, turnId, data); events.push(type); } },
      grounding: (text: string) => this.postBooking.grounding(sessionId, text),
      onLiveTool: (phase, name, args, result) => {
        if (guard.isStale()) return;
        this.postBooking.onLiveTool(sessionId, phase, name, args, result, (type, data) => { this.state.emit(sessionId, type, turnId, data); events.push(type); });
      },
      applyDecision: (dIn: AgentDecision): ApplyOutcome => {
        if (guard.isStale()) return { notes: [], blockTools: true, applied: [], error: { code: 'STALE_TOOL_RESULT', message: '' } };
        let d = dIn;
        if ((d as any)?.entities?.newJourney) {
          d = { ...d, entities: { ...(d.entities || {}) } };
          delete (d.entities as any).newJourney;
          if (!newJourneyDone) {
            if (!utter.newBooking) {
              // ungrounded proposal (the user never asked for a new booking) → ignored; the journey is untouched
              events.push('NEW_JOURNEY_PROPOSAL_REJECTED');
            } else {
              newJourneyDone = true;
              const nj = this.startNewJourney(sessionId, turnId, events);
              if (!nj.ok) return { notes: [], blockTools: true, applied: ['NEW_JOURNEY_REJECTED'], error: { code: 'ACTION_NOT_ALLOWED', message: nj.message } };
              ctx.changes.push('newJourney');   // NEW_JOURNEY_STARTED is logged via the outcome's `applied`
              ctx.rawText = utter.remainder;   // grounding / classifiers see only the new journey's own words
              if (!utter.remainder) {
                const prev = this.postBooking.store.getBookingsForSession(sessionId).length;
                pendingOverride = { type: 'ORIGIN_REQUIRED', data: { route: true }, setAtTurnId: turnId };
                this.state.getSession(sessionId).pendingInteraction = pendingOverride;
                return { notes: [], blockTools: true, applied: ['NEW_JOURNEY_STARTED'],
                  directAnswer: `Theek hai, nayi booking shuru karte hain${prev ? ' — pichli booking history safe hai' : ''}. Kahan se kahan jaana hai?` };
              }
              return { notes: [], blockTools: false, applied: ['NEW_JOURNEY_STARTED'], replan: true };
            }
          }
        }
        const purpose = (d as any)?.entities?.selectionPurpose;
        if (purpose === 'INFORMATION') infoSelection = true;
        if (purpose === 'BOOKING' || BOOKING_SIGNAL_INTENTS.has(String(d?.intent))) bookingSignal = true;
        const o = this.applier.apply(sessionId, d, ctx);
        if (o.pendingOverride) pendingOverride = o.pendingOverride;
        return o;
      }
    });
    let rt: ToolRuntimeResult;
    let sigAfterLoop = '';
    let stateAfterLoop: BookingState | null = null;
    try {
      rt = await bound.run(llmInput, mode, this.getHistory(sessionId));
      sigAfterLoop = agentSessionSig(this.state.getSession(sessionId));
      stateAfterLoop = this.state.getSession(sessionId).bookingState;
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

    // ---- Prompt 22: the conversational LLM failed before any verified result → the safe LLM_UNAVAILABLE reply only.
    //      No deterministic parser takes over, no tool runs, the session is unchanged.
    if (rt.stopReason === 'error' && rt.error?.code === 'LLM_UNAVAILABLE' && !rt.steps.length && !ctx.changes.length) {
      const q = questionFor(s0.pendingInteraction, this.state.getSession(sessionId), mode);
      return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
        message: q ? `${rt.error.message} ${q}` : rt.error.message, error: rt.error, rt, decision: null, changes: [], extra });
    }
    // ---- Prompt 22: scope guard AFTER the LLM — an off-topic turn the LLM did not turn into railway work gets the
    //      fixed scope refusal (a real LLM must not answer weather / news / jokes from its own knowledge).
    if (!rt.steps.length && !ctx.changes.length && !rt.applyOutcomes.some(o => o.applied.length || o.directAnswer)
      && NON_RAILWAY_PATTERNS.some(re => re.test(normalizedInput)) && !/(train|railway|pnr|ticket|kiraya|fare|ट्रेन|रेल)/i.test(normalizedInput)) {
      return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
        message: NON_RAILWAY_REPLY, rejection: 'UNKNOWN_INTENT', rt, decision: rt.finalDecision, changes: [] });
    }

    for (const st of rt.steps) {
      this.pushHistory(sessionId, { role: 'tool', content: JSON.stringify({ ok: st.result.success, error: st.result.error?.code }), toolCallId: st.toolCall.callId, toolName: st.toolCall.name });
    }

    // ---- Deterministic booking preparation (readiness, fresh data, review, confirmation) ----
    const blockErr = rt.stopReason === 'blocked' ? rt.error : undefined;
    const progress: string[] = [];
    let prep: PrepOutcome | undefined;
    let dupExecution: ExecutionLogRecord | undefined;
    const postNotes: string[] = [];
    progress.push(...handoffSync.notes);
    // Prompt 14: a post-booking answer / read-only lookup never progresses the booking flow
    const postBookingTurn = rt.applyOutcomes.some(o => o.postBooking);
    // Prompt 15: lifecycle action plan (validated by the applier) → provider work, backend only
    let lifecycleErr: OrchestratorError | undefined;
    const lcPlan = !blockErr ? rt.applyOutcomes.find(o => o.lifecyclePlan)?.lifecyclePlan : undefined;
    if (lcPlan) {
      const lr = await this.lifecycleActions.run(sessionId, lcPlan, { turnId, mode, emit: (type, data) => { this.state.emit(sessionId, type, turnId, data); events.push(type); } });
      progress.push(lr.message);
      if (lr.card) cards.push(lr.card);
      if (lr.error) lifecycleErr = { code: lr.error.code as LifecycleActionErrorCode, message: lr.error.message };
    }
    if (postBookingTurn && !blockErr) {
      this.preparation.evaluate(sessionId);
    } else if (!blockErr) {
      const searchOk = rt.steps.some(st => st.result.toolName === 'SEARCH_TRAINS' && st.status === 'ok');
      if (searchOk) progress.push(...this.applier.applyCarryOver(sessionId, ctx));
      else this.state.getSession(sessionId).carryOverSelection = undefined;
      const confirm = rt.applyOutcomes.some(o => o.confirmRequested);
      // Prompt 27: an information-only selection stays at CLASS_SELECTED until the user shows booking intent
      const sp = this.state.getSession(sessionId);
      if (bookingSignal || !sp.selectedTrain || confirm) sp.selectionPurpose = undefined;
      else if (infoSelection && ORDER_BEFORE_PREP.has(stateBefore)) sp.selectionPurpose = 'INFORMATION';
      const holdAtSelection = sp.selectionPurpose === 'INFORMATION';
      try {
        prep = await this.preparation.advance(sessionId, ctx, calls => bound.runTools(calls), { confirm, reviewVersion: opts.reviewVersion, approveReview: rt.applyOutcomes.some(o => o.applied.includes('REVIEW_APPROVED')), holdAtSelection });
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
      if ((blockErr.code === 'BOOKING_EXECUTION_DISABLED' || blockErr.code === 'BOOKING_EXECUTION_DUPLICATE') && rt.applyOutcomes.some(o => o.duplicateConfirmation)) {
        // repeated "haan" after the handoff → gateway idempotency (same handoff, executor not re-invoked)
        dupExecution = await this.preparation.duplicateConfirmation(sessionId, ctx);
      }
      // Prompt 13: status question / unsafe retry → bounded provider status check ONLY (never resubmits)
      if (rt.applyOutcomes.some(o => o.reconcileRequested)) {
        const px = await this.preparation.reconcileExecution(sessionId, ctx);
        postNotes.push(px.message);
      }
      // Prompt 13: explicit retry after an authoritative failure → fresh data + new review/confirmation/handoff
      if (rt.applyOutcomes.some(o => o.retryAfterFailure)) {
        prep = await this.preparation.retryAfterFailure(sessionId, ctx, calls => bound.runTools(calls));
        if (prep) {
          postNotes.push(...prep.notes);
          for (const st of prep.steps) {
            if (st.status !== 'ok') continue;
            if (st.result.toolName === 'CHECK_AVAILABILITY') cards.push({ type: 'availability', data: { ...st.result.data, refreshedForReview: true } });
            if (st.result.toolName === 'GET_FARE') cards.push({ type: 'fare', data: { ...st.result.data, refreshedForReview: true } });
          }
        }
      }
      if (!prep) this.preparation.evaluate(sessionId);
    }
    // Prompt 17 (Part 39): the LLM asked about a different train than the selected one and the user did
    // not name it → no provider call; ask "12014 selected hai. 14542 check karna hai?" (haan → select + check)
    const trainConflict = rt.steps.find(st => st.status === 'rejected' && st.result.error?.code === 'CONTEXT_CONFLICT' && (st.result.error as any)?.details?.field === 'selectedTrain');
    if (trainConflict && !pendingOverride) {
      const d = (trainConflict.result.error as any).details;
      pendingOverride = { type: 'CLARIFICATION_REQUIRED', hint: trainConflict.result.error!.message,
        data: { kind: 'CONTEXT_CONFLICT', field: 'selectedTrain', proposedCode: d.proposed, current: d.current, tool: trainConflict.toolCall.name } } as any;
    }
    const sess = this.state.getSession(sessionId);
    const override = pendingOverride ?? prep?.pendingOverride;
    // A pending override from a turn that then moved the flow elsewhere must not stick.
    const overrideValid = !override || !prep || prep.pendingOverride === override || sess.bookingState !== BookingState.AWAITING_CONFIRMATION || override.type === 'PASSENGER_DETAILS_REQUIRED' || override.type === 'CLARIFICATION_REQUIRED' || !!override.data?.correction;
    sess.pendingInteraction = { ...((overrideValid && override) || derivePendingInteraction(sess)), setAtTurnId: turnId };

    extra.rejectedClaims = [];
    extra.entityRejections = [];
    try { opts.observer?.onStatus?.('GENERATING_RESPONSE'); } catch { /* observer only */ }
    const composed = this.compose(sess, rt, blockErr, progress, cards, mode, handoffSync.notes, postNotes, extra.rejectedClaims, extra.entityRejections);
    // ---- Prompt 29: final action-claim guard — "availability check kar raha hoon" / "fare check ho gaya" survive only
    //      when THIS turn's execution records (LLM tool calls + backend preparation refreshes) support them. Runs on the
    //      final backend reply, so the screen text, the composer's fallback and the TTS speech all derive from the same
    //      validated text. It never calls a tool — it only removes the false clause.
    const actionLedger = actionLedgerFromSteps([...rt.steps, ...(prep?.steps || [])], { turnId, session: sess, previous: this.lastActions.get(sessionId) });
    const actionGuard = guardActionClaims(composed, actionLedger);
    extra.actionClaims = actionGuard.diagnostics;
    this.lastActions.set(sessionId, actionLedger.current);
    const message = actionGuard.text || (actionGuard.removed.length ? joinParts([questionFor(sess.pendingInteraction, sess, mode) || UNVERIFIED_FALLBACK]) : composed);
    extra.backendActions = [...(extra.backendActions || []), ...rt.applyOutcomes.flatMap(o => o.applied), ...(prep?.steps || []).map(st => `PREPARATION:${st.toolCall.name}`), ...(lcPlan ? [`LIFECYCLE:${(lcPlan as any).kind || 'PLAN'}`] : [])];
    const softError = rt.applyOutcomes.find(o => o.softError)?.softError;
    // Prompt 23: a native agent may have answered after a rejected proposal — the rejection stays the turn's error
    // unless a later proposal in the same turn was applied
    const lastEffect = [...rt.applyOutcomes].reverse().find(o => (o.applied || []).length || o.error);
    const nativeRejected = rt.stopReason === 'final' && this.llm.agentAuthoredReplies && lastEffect?.error ? lastEffect.error : undefined;
    const turnError = blockErr || lifecycleErr || prep?.error || handoffSync.error || softError || (rt.stopReason === 'tool_limit' || rt.stopReason === 'error' ? rt.error : undefined) || nativeRejected;
    // ---- Prompt 21/22: natural wording by the LLM for TEXT and VOICE — every sentence grounded against authoritative
    //      data; the backend reply (responseMessage) stays the authoritative fact base + safe fallback ----
    // Prompt 23: a native agent's own final answer is the reply when it was written from the CURRENT session (nothing
    // moved after the agent loop: no backend preparation / lifecycle / duplicate execution, same key session fields)
    const agentFresh = !!this.llm.agentAuthoredReplies && rt.stopReason === 'final' && !!rt.finalMessage && !blockErr
      && !rt.applyOutcomes.some(o => o.lifecycle) && !forbiddenAttempted(rt) && !lcPlan && !(prep?.steps?.length) && !dupExecution && agentSessionSig(sess) === sigAfterLoop
      // the backend moving on to the next step is fine; entering review / confirmation after the agent spoke is not
      && !(sess.bookingState !== stateAfterLoop && (sess.bookingState === BookingState.AWAITING_CONFIRMATION || sess.bookingState === BookingState.IRCTC_HANDOFF_READY));
    // Prompt 25 Part 10: a second (wording) LLM call only for NEW material information after the agent spoke —
    // never for formatting, polishing, a refusal / limit / lifecycle answer the backend already phrased, or a state
    // move without user-visible meaning. MockLLM (no agent-authored replies) keeps its separate wording step.
    const secondCallReason: string | null = agentFresh ? null
      : !this.llm.agentAuthoredReplies ? 'PROVIDER_WORDING_STEP'
      : (rt.stopReason !== 'final' || !rt.finalMessage || !!blockErr || forbiddenAttempted(rt) || !!dupExecution || !!lcPlan || rt.applyOutcomes.some(o => o.lifecycle)) ? null
      : prep?.steps?.length ? 'NEW_TOOL_RESULT'
      : (sess.bookingState !== stateAfterLoop && (sess.bookingState === BookingState.AWAITING_CONFIRMATION || sess.bookingState === BookingState.IRCTC_HANDOFF_READY)) ? 'BOOKING_STATE_CHANGED'
      : agentSessionSig(sess) !== sigAfterLoop ? 'SESSION_CHANGED_AFTER_AGENT'
      : null;
    extra.secondCallReason = secondCallReason;
    const generalTurn = agentFresh && rt.steps.length === 0 && !(extra.backendActions || []).length && !ctx.changes.length
      && !turnError && sess.bookingState === stateBefore;
    if (opts.naturalSpeech !== false && message && !(turnError?.code === 'LLM_UNAVAILABLE')) {
      try {
        extra.naturalSpeech = await naturalResponseComposer.compose({
          agentText: agentFresh ? rt.finalMessage : null, general: generalTurn, allowWordingCall: agentFresh || !!secondCallReason, actionLedger,
          llm: this.llm, session: sess, userText: normalizedInput, backendReply: message, mode,
          deterministicSpeech: mode === 'VOICE' ? speechOf(message, 'VOICE', questionFor(sess.pendingInteraction, sess, 'VOICE')) : message,
          stateBefore, reviewVersionBefore: voiceBefore.reviewVersion, selectedTrainBefore: voiceBefore.train,
          selectedClassBefore: voiceBefore.cls, passengersCountBefore: voiceBefore.count,
          steps: [...rt.steps, ...(prep?.steps || [])], appliedActions: extra.backendActions || [],
          changes: (extra.patches || []).map(p => ({ field: String(p.field), corrected: p.kind === 'CORRECTION' })),
          error: turnError ? { code: turnError.code, message: turnError.message }
            : forbiddenAttempted(rt) ? { code: 'FORBIDDEN_ACTION', message: SAFE_ERROR_MESSAGE.FORBIDDEN_ACTION } : null,
          pendingQuestionCode: pendingQuestionCode(sess.pendingInteraction),
          pendingQuestion: pendingQuestionCode(sess.pendingInteraction) ? questionFor(sess.pendingInteraction, sess, 'VOICE') || null : null,
          history: (this.history.get(sessionId) || []).slice(-8) as any, records: this.postBooking.store.getBookingsForSession(sessionId) as any,
          sensitive: sensitiveInput, timeoutMs: this.naturalSpeechTimeoutMs,
          onSegment: mode === 'VOICE' ? opts.onSpeechSegment : undefined
        });
      } catch { /* composition never breaks a turn: deterministic speech is used */ }
    }
    return this.finish({ sessionId, turnId, requestId, startedAt, userText, normalizedInput, mode, stateBefore, pendingBefore, cards, events,
      message, error: turnError, rt, decision: rt.finalDecision, changes: ctx.changes, prepSteps: prep?.steps,
      execution: prep?.execution || dupExecution, extra });
  }

  // ---------------------------------------------------------------- composition

  private compose(s: BookingSession, rt: ToolRuntimeResult, blockErr: OrchestratorError | undefined, progress: string[], cards: any[], mode: 'TEXT' | 'VOICE', preNotes: string[] = [], postNotes: string[] = [], rejectedClaims: string[] = [], entityRejections: Array<{ sentence: string; reason: string; binding: string }> = []): string {
    // Prompt 16: LLM wording may phrase authoritative facts only (invented train / fare / PNR / availability removed)
    const factCheck = (text: string): string => {
      // Prompt 17: RailwayResponseGroundingValidator — every fact needs RAILWAY_PROVIDER / BOOKING_RECORD / BOOKING_SESSION
      const g = railwayResponseGrounding.validate(text, { session: s, steps: rt.steps, records: this.postBooking.store.getBookingsForSession(s.sessionId) as any });
      rejectedClaims.push(...g.rejected);
      return g.text;
    };
    const parts: string[] = [];
    const q = questionFor(s.pendingInteraction, s, mode);
    if (blockErr) {
      parts.push(...preNotes);
      parts.push(blockErr.message);
      parts.push(...postNotes.filter(n => n && !blockErr.message.includes(n)));
      if (q && !/\?\s*$/.test(blockErr.message) && !blockErr.message.includes(q)) parts.push(q);
      return joinParts(parts);
    }
    for (const o of rt.applyOutcomes) parts.push(...o.notes);
    for (const o of rt.applyOutcomes) if (o.directAnswer) parts.push(o.directAnswer);

    const searchOk = rt.steps.some(st => st.result.toolName === 'SEARCH_TRAINS' && st.status === 'ok');
    // Prompt 17 (Part 46): SUCCESS with zero trains → honest empty result (not a failure, no card)
    const searchEmpty = searchOk && rt.steps.filter(st => st.result.toolName === 'SEARCH_TRAINS' && st.status === 'ok').slice(-1)[0]?.result.empty === true;
    if (searchEmpty) {
      const sx = rt.steps.filter(st => st.result.toolName === 'SEARCH_TRAINS' && st.status === 'ok').slice(-1)[0].validatedArguments || {};
      const o = sx.origin || s.origin, d = sx.destination || s.destination;
      parts.push(`${shortName(o === s.origin ? s.originName : undefined, o)} → ${shortName(d === s.destination ? s.destinationName : undefined, d)}, ${humanDate(sx.date || s.date)}: provider ne koi train nahi di (koi train nahi mili). Koi aur date ya route try karna hai?`);
    } else if (searchOk) {
      parts.push(searchSummary(s, mode));
      cards.push({ type: 'trains', data: { trains: currentResults(s), searchResultsVersion: s.searchResultsVersion, source: s.providerSource || 'mock', retrievedAt: s.searchMeta?.retrievedAt } });
    }
    const nonSearch = rt.steps.filter(st => st.result.toolName !== 'SEARCH_TRAINS');
    const searchFailed = rt.steps.some(st => st.result.toolName === 'SEARCH_TRAINS' && st.status !== 'ok');
    // Prompt 15: lifecycle turns are phrased ONLY by the backend service (never LLM wording)
    const lifecycleTurn = rt.applyOutcomes.some(o => o.lifecycle);
    // Prompt 23: after an attempted booking / payment / submission tool the agent's wording is never used — the
    // backend states the boundary itself (a fragment like "Ho gaya!" must not survive claim removal)
    const forbiddenAttempt = forbiddenAttempted(rt);
    if (forbiddenAttempt) parts.push(SAFE_ERROR_MESSAGE.FORBIDDEN_ACTION);
    // Prompt 27: a mixed turn ("difference kya hai … aur trains dikhao") — the LLM labelled its final answer a general
    // railway answer, so its (fact-guarded) general part is kept next to the authoritative search summary. Only a purely
    // general text qualifies (no digits: no time / count / fare / train number) — a narration of the search results is
    // never promoted into the backend reply (the search summary + cards stay the only authority for those facts)
    const mixedGeneral = searchOk && !searchEmpty && rt.stopReason === 'final' && rt.finalDecision.intent === 'GENERAL_RAILWAY_QUERY'
      && !!rt.finalDecision.finalMessage && !/\d/.test(String(rt.finalDecision.finalMessage));
    const llmFinalUseful = !forbiddenAttempt && !lifecycleTurn && !!rt.finalMessage && (nonSearch.length > 0 || searchFailed || mixedGeneral || (rt.steps.length === 0 && !!rt.finalDecision.finalMessage));
    // Prompt 14: PNR / live status answers are ALWAYS deterministic phrasing of the provider result
    // (or its validated error) — LLM wording can never add or upgrade a status.
    if (nonSearch.some(st => LIVE_TOOLS.has(st.result.toolName))) parts.push(liveToolMessage(nonSearch, mode));
    else if (llmFinalUseful) {
      const guarded = factCheck(lifecycleClaimGuard(factGuard(rt.finalMessage, rt.steps, mode, s, (r) => entityRejections.push(...r))));
      if (guarded) parts.push(guarded);
      else if (rejectedClaims.length || entityRejections.length) parts.push(UNVERIFIED_FALLBACK);
    }
    for (const st of nonSearch) {
      if (st.status !== 'ok') continue;
      if (st.result.toolName === 'CHECK_AVAILABILITY') cards.push({ type: 'availability', data: st.result.data });
      if (st.result.toolName === 'GET_FARE') cards.push({ type: 'fare', data: st.result.data });
      if (st.result.toolName === 'GET_TRAIN_INFO') cards.push({ type: 'train_info', data: st.result.data });
      if (st.result.toolName === 'GET_TIMETABLE') cards.push({ type: 'timetable', data: st.result.data });
      if (st.result.toolName === 'CHECK_PNR') cards.push({ type: 'pnr_status', data: { ...st.result.data, pnr: undefined } });
      if (st.result.toolName === 'TRACK_TRAIN') cards.push({ type: 'live_status', data: st.result.data });
    }
    parts.push(...progress);
    const llmLost = rt.stopReason === 'error' && rt.error?.code === 'LLM_UNAVAILABLE';
    if ((rt.stopReason === 'tool_limit' && rt.error) || llmLost) {
      // Prompt 17: limit / loop stop keeps the VERIFIED results of this turn (deterministic phrasing) + one notice
      // Prompt 22: same when the LLM failed AFTER verified tool results (facts only — never a guess)
      const facts = [...new Set(nonSearch.filter(st => st.status === 'ok' && !LIVE_TOOLS.has(st.result.toolName)).map(st => factFromTool(st.result.toolName, st.result.data, mode)).filter(Boolean))];
      for (const f of facts) if (!parts.join(' ').includes(f)) parts.push(f);
      if (!llmLost && rt.error && !parts.join(' ').includes(rt.error.message)) parts.push(rt.error.message);
    }
    const joined = parts.join(' ');
    if (q && !joined.includes(q)) parts.push(q);
    if (!parts.length) parts.push((rt.finalDecision.clarification && factCheck(rt.finalDecision.clarification)) || 'Main train search, selection, availability aur fare mein madad kar sakta hoon.');
    return joinParts(parts);
  }

  // ---------------------------------------------------------------- turn record

  private diagnosticsOf(a: { rt: ToolRuntimeResult | null; startedAt: number; prepSteps?: ToolCallStep[]; sessionId: string; turnId: string; stateBefore: BookingState }, x: TurnExtras): NonNullable<TurnRecord['diagnostics']> {
    const ns = x.naturalSpeech;
    const recs = a.rt?.toolExecutions || [];
    const claimTypes: Record<string, number> = {};
    for (const p of ns?.provenance || []) claimTypes[p.claimType] = (claimTypes[p.claimType] || 0) + 1;
    const wording = !!ns && ns.wordingCall === true && ns.fallbackReason !== 'NO_MATERIAL_CHANGE' && ns.fallbackReason !== 'PROVIDER_NO_SPOKEN_RESPONSE'
      && ns.fallbackReason !== 'SENSITIVE_TURN' && ns.fallbackReason !== 'SAFETY_ERROR' && ns.fallbackReason !== 'LLM_UNAVAILABLE' && ns.fallbackReason !== 'LIVE_STATUS_AUTHORITATIVE' && ns.fallbackReason !== 'EMPTY';
    const tv = a.rt?.toolValidation;
    return {
      provider: this.llm.providerId, model: (this.llm as any).modelName ?? (this.llm as any).cfg?.model ?? null,
      llmCalls: (a.rt?.llmCalls ?? 0) + (wording ? 1 : 0),
      agentLlmCalls: a.rt?.llmCalls ?? 0,
      secondLlmCall: wording, secondLlmCallReason: wording ? (x.secondCallReason ?? null) : null,
      toolCalls: recs.length, toolNames: [...new Set(recs.map(r => r.tool))],
      toolValidationFailures: tv?.failures ?? 0, repeatedInvalidCalls: tv?.repeatedInvalid ?? 0, retryCount: tv?.correctedRetries ?? 0,
      latencyMs: Date.now() - a.startedAt, llmLatencyMs: a.rt?.llmLatencyMs ?? 0,
      validation: { accepted: ns?.segments.length ?? 0, rejected: (ns?.rejected || []).map(r => r.reason), repaired: ns?.repaired ?? 0, claimTypes, source: ns?.source ?? null },
      ...(a.rt?.chain ? { chain: { ...a.rt.chain, sessionId: a.sessionId, turnId: a.turnId, stateBefore: String(a.stateBefore), stateAfter: String(this.state.getSession(a.sessionId).bookingState) } } : {}),
      binding: this.bindingDiagnostics(a, x, wording),
      actionClaims: [...(x.actionClaims || []), ...(ns?.actionClaims || [])]
    };
  }

  /** Prompt 28: identity / binding / chain log fields (ids + codes only — never sentence text, PII or secrets). */
  private bindingDiagnostics(a: { rt: ToolRuntimeResult | null; startedAt: number; sessionId: string; turnId: string }, x: TurnExtras, wording: boolean)
    : NonNullable<NonNullable<TurnRecord['diagnostics']>['binding']> {
    const ch = a.rt?.chain;
    const ids = (a.rt?.steps || []).map(st => (st.result as any)?.identity).filter(Boolean);
    const ns = x.naturalSpeech?.claimBinding;
    const er = x.entityRejections || [];
    const cross = [...(ns?.crossEntity || []).map(c => c.reason), ...er.map(r => r.reason)];
    const agentCalls = a.rt?.llmCalls ?? 0;
    const rejectedStep = (ch?.steps || []).some(st => st.decisionReason.startsWith('REJECTED'));
    return {
      sessionId: a.sessionId, turnId: a.turnId, llmCallCount: agentCalls + (wording ? 1 : 0), toolCallCount: (a.rt?.toolExecutions || []).length,
      toolSequence: (ch?.steps || []).map(st => st.toolName), toolRequested: [...new Set((a.rt?.toolExecutions || []).map(r => r.tool))],
      toolArgumentsValidated: (a.rt?.toolExecutions || []).filter(r => r.status !== 'REJECTED').length,
      toolResultIds: (ch?.steps || []).map(st => st.toolResultId),
      toolEntity: (ch?.steps || []).map(st => st.toolEntity || null),
      entityBindingStatus: ids.some((i: any) => i.binding === 'MISMATCH') ? 'MISMATCH' : ids.some((i: any) => i.binding === 'BOUND') ? 'BOUND' : 'NONE',
      claimBindingStatus: er.length ? (er.some(r => r.reason !== 'AMBIGUOUS_REFERENCE') ? 'CROSS_ENTITY_REMOVED' : 'AMBIGUOUS_REMOVED') : (ns?.status ?? 'NONE'),
      claimBindingCounts: { ...(ns?.counts || {}) } as Record<string, number>, crossEntityRejections: cross,
      validationFailures: a.rt?.toolValidation?.failures ?? 0, duplicateCallPrevented: !!ch?.duplicateCallPrevented,
      retryCount: ch?.retryCount ?? 0, stepLimitReached: !!ch?.stepLimitReached, stepLimitReason: ch?.stepLimitReason ?? null,
      secondCallReason: wording ? (x.secondCallReason ?? 'WORDING') : agentCalls > 1 ? (ch?.answeredAfterStop ? 'STEP_LIMIT_WRAP_UP' : rejectedStep ? 'TOOL_REJECTION_FEEDBACK' : 'TOOL_RESULTS') : null,
      latencyMs: Date.now() - a.startedAt
    };
  }

  private finish(a: {
    sessionId: string; turnId: string; requestId: string; startedAt: number; userText: string; normalizedInput: string;
    mode: 'TEXT' | 'VOICE'; stateBefore: BookingState; pendingBefore: string; cards: any[]; events: string[];
    message: string; error?: OrchestratorError; rejection?: string; stale?: boolean;
    rt: ToolRuntimeResult | null; decision: AgentDecision | null; changes: string[]; prepSteps?: ToolCallStep[];
    execution?: ExecutionLogRecord;
    extra?: TurnExtras;
  }): AgentTurnResult {
    const s = this.state.getSession(a.sessionId);
    const x: TurnExtras = a.extra || {};
    if (!a.stale && a.message) this.pushHistory(a.sessionId, { role: 'assistant', content: maskPnrsInText(a.message) });
    const steps: ToolCallStep[] = [...(a.rt?.steps || []), ...(a.prepSteps || [])];
    // Observability privacy: passenger names are masked in the turn record.
    // Prompt 14: PNRs are masked in every log line (12******90)
    const pii = (t: string) => containsSensitiveRequest(t) ? '[REDACTED SENSITIVE INPUT]' : maskPnrsInText(redactPassengerNames(redact(t), s, this.turnStartNames.get(a.sessionId) || []));
    const toolResults: TurnToolRecord[] = steps.map(st => ({
      toolCallId: st.toolCall.callId, toolName: st.toolCall.name,
      validatedArguments: st.validatedArguments ? maskPnrDeep(redact(st.validatedArguments)) : undefined,
      resultStatus: st.status, errorCode: st.result.error?.code, provider: st.result.provider, latencyMs: st.result.latencyMs,
      toolExecutionId: st.execution?.toolExecutionId, executionStatus: st.execution?.status, fresh: st.execution?.fresh
    }));
    // ---- Prompt 19: provider outcome of fare / availability for the CURRENT basis (UNAVAILABLE ≠ an amount),
    //      then move the preparation sub-state along legal transitions only (never COMPLETE) ----
    let prepTrace: { from: string; to: string; path: string[] } | null = null;
    if (!a.stale) {
      for (const st of steps) {
        const nm = st.toolCall.name;
        if (nm !== 'GET_FARE' && nm !== 'CHECK_AVAILABILITY') continue;
        if (st.result.success) recordDependencyOutcome(s, nm, true);
        else if (st.execution && (st.execution.status === 'FAILED' || st.execution.status === 'TIMEOUT')) recordDependencyOutcome(s, nm, false, st.result.error?.code);
      }
      prepTrace = syncPreparationState(s);
    }
    const turnLog: TurnRecord = {
      sessionId: a.sessionId, turnId: a.turnId, requestId: a.requestId, sessionVersion: s.sessionVersion,
      timestamp: new Date().toISOString(), stateBefore: a.stateBefore, stateAfter: s.bookingState,
      userInput: pii(a.userText), normalizedInput: pii(a.normalizedInput), inputMode: a.mode,
      intent: a.decision?.intent, action: a.decision?.action, confidence: a.decision?.confidence,
      detectedChanges: a.changes,
      toolCalls: steps.map(st => ({ name: st.toolCall.name, arguments: maskPnrDeep(redact(st.toolCall.arguments)) })),
      toolExecuted: steps.map(st => ({ name: st.result.toolName, ok: st.result.success, latencyMs: st.result.latencyMs, provider: st.result.provider })),
      toolResults,
      toolResultStatus: steps.length === 0 ? 'none' : steps.every(st => st.result.success) ? 'ok' : 'error',
      pendingInteractionBefore: a.pendingBefore, pendingInteractionAfter: a.stale ? a.pendingBefore : (s.pendingInteraction?.type || 'NONE'),
      events: a.events, staleResultRejected: !!a.stale,
      rejectionReason: a.rejection || (a.error?.message ? pii(a.error.message) : undefined), errorCode: a.error?.code,
      assistantResponse: a.stale ? '' : pii(a.message),
      llmProvider: this.llm.providerId, llmLatencyMs: a.rt?.llmLatencyMs,
      // ---- Prompt 25 Part 17: one structured diagnostics block (counts / codes only — never text, args or secrets) ----
      diagnostics: this.diagnosticsOf(a, x),
      bookingReadiness: s.readiness ? { ready: s.readiness.ready, blockers: s.readiness.blockers, warnings: s.readiness.warnings } : undefined,
      missingFields: s.readiness?.missingFields,
      reviewVersion: s.review?.valid ? s.review.reviewVersion : undefined,
      confirmationVersion: s.confirmedReviewVersion,
      execution: a.execution,
      handoffId: s.handoff?.snapshot.handoffId,
      handoffStatus: s.handoff?.status,
      handoffSessionStatus: s.handoffSession?.status,
      confirmationStatus: s.confirmation?.status,
      bookingLifecycle: s.bookingLifecycle?.status,
      latencyMs: Date.now() - a.startedAt,
      // ---- Prompt 16 observability (structured; no names / PNR values / secrets) ----
      pendingQuestionBefore: x.pqBefore ?? pendingQuestionOf({ type: a.pendingBefore as any }),
      pendingQuestionAfter: a.stale ? (x.pqBefore ?? null) : pendingQuestionOf(s.pendingInteraction),
      contextChanges: (x.patches || []).map(p => ({ field: p.field, kind: p.kind, value: p.value, previous: p.previous, invalidates: [...p.invalidates], resolvedBy: p.resolvedBy })),
      rejectedProposals: (x.rejectedPatches || []).map(r => ({ field: r.field, code: r.code })),
      rejectedClaims: x.rejectedClaims || [],
      backendActions: x.backendActions || [],
      // Prompt 21: speech provenance (reasons only — never the rejected sentence text / names)
      ...(x.naturalSpeech ? { naturalSpeech: { source: x.naturalSpeech.source, language: x.naturalSpeech.language, segments: x.naturalSpeech.segments.length, rejected: x.naturalSpeech.rejected.map(r => r.reason), fallbackReason: x.naturalSpeech.fallbackReason ?? null, ...(x.naturalSpeech.authoredBy ? { authoredBy: x.naturalSpeech.authoredBy } : {}), ...(x.naturalSpeech.general ? { general: true } : {}), ...(x.naturalSpeech.repaired ? { repaired: x.naturalSpeech.repaired } : {}) } } : {}),
      resultSetId: (s.searchResults as any)?.resultId ?? s.searchMeta?.resultId ?? null,
      activeJourneyId: this.context.activeJourneyId(a.sessionId),
      interruption: !!x.interruption,
      contextBefore: x.contextBefore,
      contextAfter: undefined,
      // ---- Prompt 17 observability: tool execution records (arguments hashed, PNR masked) ----
      journeyVersion: syncJourneyVersion(s),
      toolExecutions: (a.rt?.toolExecutions || []).map(r => ({ ...r, argumentsSummary: maskPnrDeep(r.argumentsSummary) })),
      toolRounds: a.rt?.toolRounds ?? 0,
      toolPlans: (a.rt?.toolPlans || []).map(n => ({ ...n, arguments: maskPnrDeep(n.arguments) })),
      freshRequested: isExplicitFreshRequest(a.normalizedInput),
      // ---- Prompt 19 observability: counts / statuses only (no passenger names / ages) ----
      bookingPreparation: {
        ...bookingPreparationSummary(s), preparationPath: prepTrace?.path || [],
        // Prompt 20 (Part 45/50/51): tool vs state action, requested vs executed tools, typed error (no PII)
        ...(() => {
          const cls = classifyAgentTurn(a.decision as any, steps.map(st => st.toolCall.name));
          const toolErrors = steps.filter(st => !st.result.success && st.result.error?.code)
            .map(st => ({ tool: st.toolCall.name, code: st.result.error!.code, type: preparationErrorTypeOf(st.result.error!.code, st.toolCall.name) }));
          return {
            actionKind: cls.kind, stateAction: cls.stateAction,
            toolRequested: steps.map(st => st.toolCall.name),
            toolExecuted: steps.filter(st => !!st.execution && st.execution.status !== 'REJECTED').map(st => st.toolCall.name),
            errorType: preparationErrorTypeOf(a.error?.code) ?? toolErrors.find(t => t.type)?.type ?? null,
            toolErrors
          };
        })()
      }
    };
    if (!a.stale) {
      // Prompt 18: BookingSession tracks the Part 19 pending-question code (derived, authoritative)
      (s as any).pendingQuestion = pendingQuestionCode(s.pendingInteraction);
      this.toolResultMemory.record(a.sessionId, a.turnId, steps as any, s);
      this.context.noteTools(a.sessionId, steps, s);
      this.context.noteIntents(a.sessionId, a.decision?.intent, pendingQuestionOf(s.pendingInteraction) || (a.error ? 'ERROR' : 'ANSWER'));
    }
    const conversationContext = this.context.snapshot(s, this.activeBookingOf(a.sessionId));
    turnLog.contextAfter = summarizeContext(conversationContext, s);
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
      turnLog,
      assistantResponse: (() => {
        const ar = buildAssistantResponse({
          text: a.stale ? '' : a.message, mode: a.mode, state: s.bookingState, pendingQuestion: conversationContext.pendingQuestion,
          question: questionFor(s.pendingInteraction, s, a.mode), cards: a.cards, steps, error: a.error ? { code: a.error.code, message: a.error.message } : null,
          rejectedClaims: x.rejectedClaims || []
        });
        // Prompt 21: VOICE speech = LLM-worded, grounded sentences (TEXT reply + facts unchanged)
        return !a.stale && a.mode === 'VOICE' && x.naturalSpeech?.text ? { ...ar, speechText: x.naturalSpeech.text } : ar;
      })(),
      // Prompt 22: what the user reads — the grounded LLM wording (both modes); the backend reply when the LLM wording
      // was unavailable / rejected. responseMessage keeps the authoritative backend reply.
      assistantText: a.stale ? '' : (x.naturalSpeech?.source === 'LLM' && x.naturalSpeech.text ? x.naturalSpeech.text : a.message),
      conversationContext,
      ...(!a.stale && x.naturalSpeech ? { speech: { segments: x.naturalSpeech.segments, source: x.naturalSpeech.source, language: x.naturalSpeech.language, ...(x.naturalSpeech.authoredBy ? { authoredBy: x.naturalSpeech.authoredBy } : {}), ...(x.naturalSpeech.fallbackReason ? { fallbackReason: x.naturalSpeech.fallbackReason } : {}) } } : {})
    };
  }

  /** Prompt 16: explicit new journey — validated reset; BookingHistoryStore records are preserved. */
  private startNewJourney(sessionId: string, turnId: string, events: string[]): { ok: true; journeyId: string } | { ok: false; message: string } {
    const r = this.state.resetForNewJourney(sessionId);
    if (!r.ok) return { ok: false, message: 'Pichli booking ka status abhi verify ho raha hai — uske final hone ke baad nayi booking shuru karenge.' };
    const journeyId = this.context.startNewJourney(sessionId);
    this.toolResultMemory.clear(sessionId);
    this.state.emit(sessionId, 'NEW_JOURNEY_STARTED', turnId, { journeyId, cleared: r.cleared || [] });
    events.push('NEW_JOURNEY_STARTED');
    return { ok: true, journeyId };
  }

  /** Active booking (for "iska" / masked PNR in context) — from the authoritative history store only. */
  private activeBookingOf(sessionId: string): { bookingId: string; pnr: string | null } | null {
    const s = this.state.getSession(sessionId);
    const recs = this.postBooking.store.getBookingsForSession(sessionId);
    const r = (s.activeBookingId && recs.find(x => x.bookingId === s.activeBookingId)) || null;
    return r ? { bookingId: r.bookingId, pnr: r.pnr ?? null } : null;
  }

  private pushHistory(sid: string, m: HistoryMsg) {
    const h = this.history.get(sid) || [];
    h.push({ ...m, journeyId: this.context.activeJourneyId(sid) });
    if (h.length > 60) h.splice(0, h.length - 60);
    this.history.set(sid, h);
  }
  /** Prompt 16: LLM history is scoped to the ACTIVE journey (journey A turns never leak into journey B). */
  private getHistory(sid: string): HistoryMsg[] {
    const j = this.context.activeJourneyId(sid);
    return (this.history.get(sid) || []).filter(m => !m.journeyId || m.journeyId === j);
  }
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
/**
 * Prompt 15: the LLM can never claim a lifecycle outcome. Sentences claiming a cancellation,
 * modification (date / class / passenger change) or refund are removed from LLM wording —
 * those facts are phrased only by BookingLifecycleActionService from provider results.
 */
const LIFECYCLE_CLAIM_RE = /(cancel(?:led)?\s+(?:ho\s+(?:gay[ai]|chuk[ai])|kar\s+di(?:ya)?|kar\s+diya\s+gaya|confirm)|cancellation\s+(?:confirm|complete|successful|ho\s+gay)|booking\s+(?:is\s+)?cancelled|(?:date|class|passenger|naam|age|booking)\s+(?:change|update|modify|modified|upgrade)\s*(?:ho\s+(?:gay[ai]|chuk[ai])|kar\s+di(?:ya)?|successful|confirm)|refund\s+(?:mil\s+gaya|processed|credited|aa\s+gaya|ho\s+gaya|received|initiate\s+ho\s+gaya)|₹\s?\d+\s+(?:extra|refund))/i;
export function lifecycleClaimGuard(text: string): string {
  if (!text || !LIFECYCLE_CLAIM_RE.test(text)) return text;
  const kept = text.split(/(?<=[.!?।])\s+/).filter(sn => !LIFECYCLE_CLAIM_RE.test(sn));
  kept.push('Cancellation, modification ya refund ka status sirf booking provider confirm karta hai — main ise assume nahi karta.');
  return kept.join(' ');
}

export function factGuard(message: string, steps: ToolCallStep[], mode: 'TEXT' | 'VOICE', session?: BookingSession,
  onRejected?: (r: Array<{ sentence: string; reason: string; binding: string }>) => void): string {
  const ok = steps.filter(st => st.status === 'ok' && st.result.toolName !== 'SEARCH_TRAINS');
  // Prompt 28: claim ↔ entity binding — a fare / seat claim about the wrong train / class / date (or an unresolvable
  // "is train") is removed sentence by sentence — also when the LLM answered WITHOUT a tool this turn (checked against
  // the session's committed results); nothing left → the deterministic tool facts (or nothing → the caller's fallback)
  if (session) {
    const b = bindAndVerifyClaims(message, session, steps);
    if (b.rejected.length) {
      onRejected?.(b.rejected);
      const kept = b.kept.join(' ').trim();
      message = kept && /[A-Za-zऀ-ॿ]{3,}/.test(kept) ? kept : ok.map(st => factFromTool(st.result.toolName, st.result.data, mode)).filter(Boolean).join(' ');
    }
  }
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


/** Prompt 23: key session fields an agent reply depends on (no PII) — used to detect a reply that went stale. */
function agentSessionSig(s: any): string {
  // the pending QUESTION is re-derived by the backend after every loop (the composer appends it when missing) — not a fact
  return JSON.stringify([s?.review?.version ?? s?.review?.reviewVersion ?? null,
    s?.selectedTrain?.number ?? null, s?.selectedClass ?? null, s?.passengersCount ?? null, s?.date ?? null, s?.searchResultsVersion ?? null]);
}

/** Prompt 23: the runtime refused a tool call of this turn as a backend-controlled / forbidden action (booking, payment, …). */
function forbiddenAttempted(rt: ToolRuntimeResult): boolean {
  return (rt.toolExecutions || []).some(r => r.status === 'REJECTED' && r.rejectionReason === 'FORBIDDEN_ACTION');
}
