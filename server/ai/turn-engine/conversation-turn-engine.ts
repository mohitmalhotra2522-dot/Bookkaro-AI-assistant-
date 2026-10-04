/**
 * PROMPT 18 — ConversationTurnEngine: the production conversation loop around the P17 runtime.
 *
 *   TEXT ─┐                                   ┌─ TEXT
 *   STT ──┴► ConversationTurnEngine.processTurn ► ConversationAgentOrchestrator ► LLM ⇄ RailwayToolRuntime
 *                                                 ► RailwaySearchOrchestrator ► RailwayProvider ► grounding ┴─ TTS
 *
 * Responsibilities (the orchestrator keeps all booking / railway logic — nothing is duplicated here):
 *  - exactly ONE logical turn per user message (sessionId, turnId, sequence, …) however many tool calls;
 *  - TurnStatus lifecycle with validated forward-only transitions (terminal statuses never change);
 *  - ordered streaming events (session-monotonic seq) incl. honest tool progress + voice acknowledgement;
 *  - interruption (barge-in) + superseded-turn protection + response relevance check before display;
 *  - typed AssistantTurnResponse (TEXT / TOOL_PROGRESS / CLARIFICATION / ERROR / CONFIRMATION_REQUEST / FINAL);
 *  - conversation history (Part 55) + observability (Part 56) + reconnect snapshot (Part 58/59).
 * It never mutates BookingSession, never cancels a provider request (no safe cancellation exists), and
 * never repeats a booking action on reconnect.
 */
import { bookingPreparationSummary } from '../../booking/preparation/booking-preparation';
import type { ConversationAgentOrchestrator, AgentTurnResult, ProcessTurnOptions } from '../agent/conversation-agent-orchestrator';
import { normalizeInput } from '../agent/conversation-agent-orchestrator';
import type { ConversationStateManager } from '../state/conversation-state';
import {
  canTransitionTurn, TERMINAL_TURN_STATUSES,
  type AssistantResponseType, type AssistantTurnResponse, type ConversationTurn, type TurnEvent, type TurnEventType,
  type TurnResumeSnapshot, type TurnStatus
} from '@shared/turn-engine';
import type { ToolExecutionRecord } from '@shared/railway-tool-runtime';
import { TurnEventBus } from './turn-event-bus';
import { toolProgressText, voiceAcknowledgement } from './progress-messages';
import { actionExecutionOfRecord, acknowledgementMatchesDispatch, stripStaleActionClaims } from '../response/action-claims';
import { normalizeTranscript } from '@shared/voice/stt-normalizer';
import { validateAcknowledgement, type ResponsePriority } from '@shared/voice/voice-response-policy';
import { checkTranscriptForTurn, VoiceTranscriptRejectedError, type VoiceTranscriptInfo } from '@shared/voice/transcript';
import type { VoiceTurnOutcome } from '@shared/voice/conversational-voice-agent';
import { pendingQuestionCode } from './pending-question';
import { syncJourneyVersion } from '../tool-runtime/journey-version';
import { maskPnrsInText } from '../../booking/post-booking/pnr-validator';
import { currentResults } from '../context/train-reference-resolver';
import { containsSensitiveRequest } from '../../security/validators/intent-validator';
import { v4 as uuid } from '../orchestrator/utils';

export const MAX_TURNS_PER_SESSION = 100;
const ERROR_CODES_AS_ERROR = new Set(['TOOL_FAILED', 'INVALID_STATE_TRANSITION', 'SESSION_VERSION_CONFLICT', 'STALE_SEARCH_REFERENCE', 'SENSITIVE_REQUEST_REJECTED']);

export interface EngineTurnResult extends AgentTurnResult {
  /** The logical turn (public, safe view). */
  turn: ConversationTurn;
  /** null when the presentation was discarded (superseded / no longer relevant). */
  assistantTurnResponse: AssistantTurnResponse | null;
  /** TOOL_PROGRESS responses emitted during this turn (voice acknowledgement included). */
  progress: AssistantTurnResponse[];
  /** Ordered events of THIS turn. */
  turnEvents: TurnEvent[];
  /** false → the client must not display / speak this response (Part 31). */
  presentable: boolean;
  /** Prompt 21 (Parts 31/32): the voice view of the SAME logical result (TEXT and VOICE share it). */
  voice: VoiceTurnOutcome;
}

export interface TurnEngineOptions {
  /** Prompt 21 (Part 35): one fact-free status update if a tool runs longer than this (VOICE). Default 5000ms. */
  longWaitMs?: number;
}

const LONG_WAIT_STATUS = 'Thoda time lag raha hai, bas ek moment.';

export interface EngineTurnOptions extends Omit<ProcessTurnOptions, 'turnId' | 'observer'> {
  /** Voice barge-in: the user started speaking while TTS was playing (stop + mark INTERRUPTED). */
  interruptPrevious?: boolean;
  /** Prompt 34 (§2): structured STT metadata of a spoken turn (status / confidence / language / timing — no text). */
  transcript?: VoiceTranscriptInfo;
}

/** Prompt 34 (§17): provider outcomes that are failures (DATA / NO_RESULTS are real answers). */
const VOICE_FAILURE_OUTCOMES = new Set(['TIMEOUT', 'PROVIDER_FAILURE', 'MALFORMED_DATA', 'UNSUPPORTED', 'STALE', 'REJECTED']);

export class ConversationTurnEngine {
  readonly events = new TurnEventBus();
  private turns = new Map<string, ConversationTurn[]>();
  private seq = new Map<string, number>();
  private deliveries = new Map<string, Map<string, Promise<EngineTurnResult>>>();

  constructor(readonly orchestrator: ConversationAgentOrchestrator, private readonly state: ConversationStateManager, private readonly options: TurnEngineOptions = {}) {}

  // ------------------------------------------------------------------ public API

  /** Part 3 / 27 — the ONE entry point for TEXT and (normalized) STT input. */
  async processTurn(sessionId: string, userText: string, mode: 'TEXT' | 'VOICE', opts: EngineTurnOptions = {}): Promise<EngineTurnResult> {
    // Prompt 34 (§2/§3): STT boundary — an interim / empty transcript never becomes a turn (no LLM, no tool, no state).
    // Checked BEFORE a turn exists, so it cannot interrupt / supersede the current turn either.
    if (mode === 'VOICE' && opts.transcript) {
      const chk = checkTranscriptForTurn(userText, opts.transcript);
      if (!chk.ok) throw new VoiceTranscriptRejectedError(chk.code);
    }
    // duplicate DELIVERY of the same client message → same logical turn (no second turn, no re-execution)
    if (opts.clientMessageId) {
      const id = String(opts.clientMessageId).slice(0, 100);
      const m = this.deliveries.get(sessionId) || new Map<string, Promise<EngineTurnResult>>();
      this.deliveries.set(sessionId, m);
      const prior = m.get(id);
      if (prior) { const r = await prior; return { ...r, duplicateDelivery: true }; }
      const p = this.run(sessionId, userText, mode, opts);
      m.set(id, p);
      while (m.size > 50) m.delete(m.keys().next().value as string);
      return p;
    }
    return this.run(sessionId, userText, mode, opts);
  }

  /**
   * Part 28 / 29 — user interrupted (barge-in / stop tap). In-flight turn → INTERRUPTED (its provider
   * request is NOT cancelled — no safe cancellation — and its result is applied only if still current);
   * a completed turn being spoken → presentation INTERRUPTED. BookingSession is never touched.
   */
  interrupt(sessionId: string, reason: 'BARGE_IN' | 'USER_STOP' | 'NEW_INPUT' = 'USER_STOP'): { turnId: string | null; kind: 'IN_FLIGHT' | 'PRESENTATION' | null; providerCancellation: 'NOT_SUPPORTED' } {
    const list = this.turns.get(sessionId) || [];
    const t = list[list.length - 1];
    if (!t) return { turnId: null, kind: null, providerCancellation: 'NOT_SUPPORTED' };
    // Prompt 29: every progress statement of the interrupted turn is STALE — never resumed, never re-spoken
    for (const p of t.progress || []) p.stale = true;
    if (!TERMINAL_TURN_STATUSES.has(t.status)) {
      t.interrupted = true;
      this.setStatus(t, 'INTERRUPTED');
      this.emit(t, 'TURN_INTERRUPTED', { reason });
      return { turnId: t.turnId, kind: 'IN_FLIGHT', providerCancellation: 'NOT_SUPPORTED' };
    }
    if (t.presentation === 'PRESENTED') {
      t.presentation = 'INTERRUPTED';
      t.interrupted = true;
      this.emit(t, 'PRESENTATION_INTERRUPTED', { reason });
      return { turnId: t.turnId, kind: 'PRESENTATION', providerCancellation: 'NOT_SUPPORTED' };
    }
    return { turnId: null, kind: null, providerCancellation: 'NOT_SUPPORTED' };
  }

  /**
   * Prompt 30 — a DISCARDED turn (stale / superseded / no longer relevant) never leaves the conversational focus it set.
   * Only a focus stamped by THIS turn's info tool (and not since overwritten / cleared) is rolled back; an explicit
   * selection stays (it is the user's choice and is reflected in the selected train). The restored focus must still
   * point at the current results or the selected train — otherwise there is no focus (never a guess).
   */
  private rollbackDiscardedFocus(sid: string, orchestratorTurnId: string | undefined, focusBefore: string | undefined): void {
    const s = this.state.getSession(sid);
    if (!orchestratorTurnId || !s.focusTurnId || s.focusTurnId !== orchestratorTurnId) return;
    const selected = (s.selectedTrain as any)?.number || (s.selectedTrain as any)?.trainNumber;
    if (selected && s.focusTrainNumber === selected) { s.focusTurnId = undefined; return; }
    const valid = !!focusBefore && (focusBefore === selected || currentResults(s).some(t => t.trainNumber === focusBefore));
    s.focusTrainNumber = valid ? focusBefore : (selected || undefined);
    s.focusTurnId = undefined;
  }

  /** Part 55 — conversation history (safe; no secrets). */
  getTurns(sessionId: string): ConversationTurn[] { return (this.turns.get(sessionId) || []).map(t => this.publicTurn(t)); }

  /** Part 58 / 59 — reconnect: recover the SAME conversation (never creates a session, never re-runs actions). */
  resume(sessionId: string): TurnResumeSnapshot | null {
    if (!this.state.hasSession(sessionId)) return null;
    const s = this.state.getSession(sessionId);
    const list = this.turns.get(sessionId) || [];
    const cur = list[list.length - 1] || null;
    const latest = [...list].reverse().find(t => t.assistantResponse && t.presentation !== 'DISCARDED') || null;
    const active = cur && !TERMINAL_TURN_STATUSES.has(cur.status)
      ? (cur as any)._records?.filter((r: ToolExecutionRecord) => r.status === 'RUNNING' || r.status === 'REQUESTED' || r.status === 'VALIDATING')
          .map((r: ToolExecutionRecord) => ({ tool: r.tool, toolExecutionId: r.toolExecutionId, status: r.status })) || []
      : [];
    return {
      sessionId,
      bookingState: s.bookingState,
      pendingQuestion: pendingQuestionCode(s.pendingInteraction),
      journeyVersion: syncJourneyVersion(s),
      currentTurn: cur ? { turnId: cur.turnId, sequence: cur.sequence, status: cur.status, presentation: cur.presentation } : null,
      latestAssistantResponse: latest?.assistantResponse ?? null,
      activeToolExecutions: active,
      lastEventSeq: this.events.lastSeq(sessionId),
      // Prompt 19 (Part 54): preparation / collection / reviewVersion / confirmation survive reload (no PII)
      bookingPreparation: bookingPreparationSummary(s)
    };
  }

  // ------------------------------------------------------------------ the turn

  private async run(sessionId: string, userText: string, mode: 'TEXT' | 'VOICE', opts: EngineTurnOptions): Promise<EngineTurnResult> {
    const t0 = Date.now();
    const s0 = this.state.getSession(sessionId);
    const sid = s0.sessionId;   // an unknown id is created by the state manager exactly once (same as /api/chat)
    // a new user turn interrupts the previous presentation / in-flight turn (voice barge-in or new input)
    const prev = (this.turns.get(sid) || []).slice(-1)[0];
    if (prev && (opts.interruptPrevious || !TERMINAL_TURN_STATUSES.has(prev.status))) {
      this.interrupt(sid, opts.interruptPrevious ? 'BARGE_IN' : 'NEW_INPUT');
    }
    const sequence = (this.seq.get(sid) || 0) + 1;
    this.seq.set(sid, sequence);
    // Prompt 30: focus before this turn — restored if the turn is discarded after its info tool moved the focus
    const focusBefore = this.state.getSession(sid).focusTrainNumber;
    const sensitive = containsSensitiveRequest(userText);
    // Prompt 21 (Part 4): STT cleanup for VOICE only (fillers, spoken digits, class names, repeated words)
    const stt = mode === 'VOICE' && !sensitive ? normalizeTranscript(userText) : null;
    const inputText = stt && stt.text ? stt.text : userText;
    const safeText = sensitive ? '[REDACTED SENSITIVE INPUT]' : maskPnrsInText(String(userText || '').slice(0, 500));
    const turn: ConversationTurn = {
      sessionId: sid, turnId: `turn_${uuid()}`, sequence, userInput: safeText, normalizedInput: '', inputMode: mode,
      receivedAt: new Date().toISOString(), completedAt: null,
      stateBefore: s0.bookingState, stateAfter: null, journeyVersion: syncJourneyVersion(s0), journeyVersionAfter: null,
      status: 'RECEIVED', statusHistory: [{ status: 'RECEIVED', at: new Date().toISOString() }], presentation: 'PENDING',
      intent: null, toolCalls: [], toolResults: [], assistantResponse: null, progress: [],
      llmLatencyMs: null, toolCount: 0, toolExecutionIds: [], totalTurnLatencyMs: null, finalResponseType: null,
      groundingStatus: 'NOT_APPLICABLE', superseded: false, interrupted: false, errorCode: null, illegalTransitions: []
    };
    const list = this.turns.get(sid) || [];
    list.push(turn);
    if (list.length > MAX_TURNS_PER_SESSION) list.splice(0, list.length - MAX_TURNS_PER_SESSION);
    this.turns.set(sid, list);
    this.emit(turn, 'TURN_STARTED', { mode });

    this.setStatus(turn, 'NORMALIZING');
    turn.normalizedInput = sensitive ? safeText : maskPnrsInText(normalizeInput(inputText));

    // ---- observer: LLM rounds + tool lifecycle → status + streaming events (never mutates state) ----
    const running = new Map<string, string>();      // toolExecutionId → tool
    const records: ToolExecutionRecord[] = [];
    (turn as any)._records = records;
    let ackSpoken = false;
    let llmAck: string | null = null;
    let ackSource: 'LLM' | 'DEFAULT' | null = null;
    let longTimer: ReturnType<typeof setTimeout> | undefined;
    let statusSent = false;
    const progress = (text: string, speechText?: string, kind: 'ACK' | 'STATUS' = 'ACK') => {
      // Prompt 29: an interrupted / superseded turn emits no further progress (its pending statements are stale)
      if (!isCurrentTurn()) return;
      const r: AssistantTurnResponse = { type: 'TOOL_PROGRESS', text, ...(speechText ? { speechText } : {}), turnId: turn.turnId, sequence: turn.sequence };
      turn.progress.push(r);
      this.emit(turn, 'TOOL_PROGRESS', { text, ...(speechText ? { speechText, kind } : {}) });
    };
    // Part 3 — the LLM's acknowledgement is spoken only if it is fact-free (no result / fare / time / unknown number)
    const knownTrains = (): string[] => {
      const sx: any = this.state.getSession(sid);
      return [sx.selectedTrain?.number, ...((sx.searchResults?.trains || []) as any[]).map((t: any) => t.trainNumber), ...(String(inputText).match(/\b\d{5}\b/g) || [])].filter(Boolean).map(String);
    };
    const isCurrentTurn = () => (this.seq.get(sid) || 0) === turn.sequence && !turn.interrupted;
    const observer: NonNullable<ProcessTurnOptions['observer']> = {
      onLLM: (phase, round, info) => {
        if (phase === 'start') {
          this.setStatus(turn, 'THINKING');
          this.emit(turn, round === 0 ? 'LLM_THINKING' : 'LLM_CONTINUING', { round });
        } else {
          this.emit(turn, 'LLM_RESPONSE', { round, toolCalls: info?.toolCalls ?? 0, final: !!info?.final });
          if (mode === 'VOICE' && !llmAck && info?.toolCalls && info.acknowledgement && validateAcknowledgement(info.acknowledgement, { trainNumbers: knownTrains() }).ok) llmAck = info.acknowledgement;
          if (info?.toolCalls) this.setStatus(turn, 'TOOL_CALLING');
        }
      },
      onRecord: (rec, phase) => {
        if (!records.includes(rec)) records.push(rec);
        const base = { tool: rec.tool, toolExecutionId: rec.toolExecutionId };
        switch (phase) {
          case 'REQUESTED': this.emit(turn, 'TOOL_REQUESTED', { ...base, attempt: rec.attempt ?? 1 }); break;
          case 'STARTED': {
            running.set(rec.toolExecutionId, rec.tool);
            this.setStatus(turn, 'WAITING_FOR_TOOL');
            this.emit(turn, 'TOOL_STARTED', base);
            const text = toolProgressText([...running.values()]);
            if (mode === 'VOICE' && !ackSpoken) {
              // Part 35 — ONE acknowledgement, then silence (an optional single status update if it runs long)
              ackSpoken = true;
              // Prompt 29: the LLM's acknowledgement was written at PROPOSAL time — it is spoken only if what it says is
              // being checked genuinely entered execution now (same tool / train / class / date; validated calls of this
              // dispatch batch included). Otherwise the neutral acknowledgement of the tool actually dispatched is used.
              const dispatched = records.filter(x => x.status === 'RUNNING' || x.status === 'VALIDATING').map(actionExecutionOfRecord);
              const ack = llmAck && acknowledgementMatchesDispatch(llmAck, dispatched) ? llmAck : null;
              ackSource = ack ? 'LLM' : 'DEFAULT';
              progress(text, ack || voiceAcknowledgement(rec.tool));
              const wait = this.options.longWaitMs ?? 5000;
              if (wait > 0) longTimer = setTimeout(() => {
                if (!statusSent && running.size && isCurrentTurn()) { statusSent = true; progress(toolProgressText([...running.values()]), LONG_WAIT_STATUS, 'STATUS'); }
              }, wait);
            }
            else progress(text);
            break;
          }
          case 'COMPLETED':
            running.delete(rec.toolExecutionId);
            this.emit(turn, 'TOOL_COMPLETED', { ...base, status: rec.status, fresh: rec.fresh, resultCount: rec.resultCount });
            this.setStatus(turn, 'PROCESSING_TOOL_RESULT');
            break;
          case 'FAILED':
            running.delete(rec.toolExecutionId);
            this.emit(turn, 'TOOL_FAILED', { ...base, status: rec.status, code: rec.rejectionReason });
            if (rec.startedAt) this.setStatus(turn, 'PROCESSING_TOOL_RESULT');
            break;
          case 'RETRY':
            this.emit(turn, 'TOOL_RETRY', { ...base, attempt: (rec.attempt ?? 1) + 1 });
            break;
        }
      },
      onStatus: (st) => this.setStatus(turn, st)
    };

    let r: AgentTurnResult;
    try {
      r = await this.orchestrator.processTurn(sid, inputText, mode, {
        ...opts, turnId: turn.turnId, observer,
        // Part 14 — grounded sentences stream out as SPEECH_SEGMENT events (current turn only)
        onSpeechSegment: (index, text) => {
          if (mode !== 'VOICE' || !isCurrentTurn()) return;
          this.emit(turn, 'SPEECH_SEGMENT', { index, text: maskPnrsInText(text) });
          try { opts.onSpeechSegment?.(index, text); } catch { /* observer only */ }
        }
      });
    } catch (e) {
      if (longTimer) clearTimeout(longTimer);
      turn.errorCode = 'TURN_FAILED';
      this.finalize(turn, 'FAILED', t0);
      this.emit(turn, 'TURN_COMPLETED', { status: 'FAILED' });
      throw e;
    }

    if (longTimer) clearTimeout(longTimer);
    // ---- superseded / relevance check (Parts 30, 31) ----
    const sNow = this.state.getSession(sid);
    const jvNow = syncJourneyVersion(sNow);
    const newer = (this.turns.get(sid) || []).some(t => t.sequence > turn.sequence);
    // the journey this answer was composed for vs the CURRENT journey (a newer turn may have changed it)
    const irrelevant = !r.stale && newer && typeof r.turnLog.journeyVersion === 'number' && jvNow !== r.turnLog.journeyVersion;
    turn.intent = r.turnLog.intent ?? null;
    turn.llmLatencyMs = r.turnLog.llmLatencyMs ?? null;
    const recs = (r.turnLog.toolExecutions || []) as ToolExecutionRecord[];
    turn.toolCalls = recs.map(x => ({ tool: x.tool, toolExecutionId: x.toolExecutionId, status: x.status, retryOf: x.retryOf ?? null }));
    turn.toolResults = recs.filter(x => x.startedAt).map(x => ({ tool: x.tool, ok: x.status === 'SUCCEEDED', fresh: x.fresh, errorCode: x.status === 'SUCCEEDED' ? null : x.rejectionReason }));
    turn.toolCount = recs.length;
    turn.toolExecutionIds = recs.map(x => x.toolExecutionId);
    turn.errorCode = r.error?.code ?? null;
    turn.groundingStatus = r.stale || r.turnLog.llmLatencyMs === undefined ? 'NOT_APPLICABLE'
      : (r.turnLog.rejectedClaims || []).length ? 'RESPONSE_GROUNDING_FAILED' : 'PASSED';
    if (r.turnLog.interruption) {
      // "Ruko, …" barge-in phrase: the previous presentation was interrupted by this utterance
      const p = (this.turns.get(sid) || []).find(t => t.sequence === turn.sequence - 1);
      if (p && p.presentation === 'PRESENTED') { p.presentation = 'INTERRUPTED'; p.interrupted = true; this.emit(p, 'PRESENTATION_INTERRUPTED', { reason: 'BARGE_IN' }); }
    }

    // Prompt 29: a turn the user interrupted (barge-in / new input) that still finishes: its pending action / progress
    // statements are STALE — removed from the text AND the speech; nothing else left → not presented at all
    let staleOnly = false;
    if (turn.interrupted && newer && !r.stale && !irrelevant && r.responseMessage) {
      const g = stripStaleActionClaims(r.responseMessage, turn.turnId);
      if (g.removed.length) {
        const clean = (x: any) => typeof x === 'string' && x ? stripStaleActionClaims(x, turn.turnId).text : x;
        (r as any).responseMessage = g.text;
        if ((r as any).assistantText) (r as any).assistantText = clean((r as any).assistantText);
        if (r.assistantResponse?.speechText) (r.assistantResponse as any).speechText = clean(r.assistantResponse.speechText) || g.text;
        if (r.speech?.segments?.length) (r.speech as any).segments = r.speech.segments.map(clean).filter(Boolean);
        const d: any = r.turnLog.diagnostics;
        if (d) d.actionClaims = [...(d.actionClaims || []), ...g.diagnostics];
        staleOnly = !g.text;
      }
    }
    let response: AssistantTurnResponse | null = null;
    if (r.stale || irrelevant || staleOnly) {
      this.rollbackDiscardedFocus(sid, r.turnLog.turnId, focusBefore);
      turn.superseded = true;
      turn.presentation = 'DISCARDED';
      this.finalize(turn, 'SUPERSEDED', t0);
      this.emit(turn, 'TURN_SUPERSEDED', { status: 'SUPERSEDED' });
    } else {
      const type = this.responseType(r);
      response = { type, text: r.responseMessage, ...(r.assistantResponse?.speechText ? { speechText: r.assistantResponse.speechText } : {}), turnId: turn.turnId, sequence: turn.sequence };
      turn.assistantResponse = { ...response, text: maskPnrsInText(response.text), ...(response.speechText ? { speechText: maskPnrsInText(response.speechText) } : {}) };
      turn.finalResponseType = type;
      turn.presentation = 'PRESENTED';
      this.emit(turn, 'ASSISTANT_RESPONSE', { type });
      const end: TurnStatus = type === 'ERROR' && !r.responseMessage ? 'FAILED'
        : pendingQuestionCode(sNow.pendingInteraction) ? 'WAITING_FOR_USER' : 'COMPLETED';
      this.finalize(turn, end, t0);
      this.emit(turn, 'TURN_COMPLETED', { status: turn.status });
    }
    turn.stateAfter = sNow.bookingState;
    turn.journeyVersionAfter = jvNow;

    // ---- Part 56 observability (attached to the orchestrator turn log; no secrets) ----
    r.turnLog.turnEngine = {
      sequence: turn.sequence, turnStatus: turn.status, llmLatencyMs: turn.llmLatencyMs, toolCount: turn.toolCount,
      toolExecutionIds: turn.toolExecutionIds, totalTurnLatencyMs: turn.totalTurnLatencyMs, finalResponseType: turn.finalResponseType,
      groundingStatus: turn.groundingStatus, superseded: turn.superseded, interrupted: turn.interrupted, errorCode: turn.errorCode,
      journeyVersion: turn.journeyVersion, journeyVersionAfter: turn.journeyVersionAfter, presentation: turn.presentation,
      // Prompt 21: voice observability (no transcript text)
      ...(mode === 'VOICE' ? { sttNormalization: stt?.applied || [], acknowledgementSource: ackSource, statusUpdate: statusSent, speechSource: r.speech?.source ?? null } : {})
    };
    // Part 33 — priority of THIS response: barge-in > correction / "ruko" > normal
    const priority: ResponsePriority = opts.interruptPrevious ? 'INTERRUPT'
      : (r.turnLog.interruption || (r.turnLog.contextChanges || []).some(c => c.kind === 'CORRECTION')) ? 'HIGH' : 'NORMAL';
    const speechText = response ? (response.speechText || response.text) : '';
    const voice: VoiceTurnOutcome = {
      sessionId: sid, turnId: turn.turnId, sequence: turn.sequence, journeyVersion: jvNow, presentable: !!response,
      // Prompt 22: the text the user reads = grounded LLM wording (TEXT + VOICE); responseMessage when unavailable
      assistantText: response ? maskPnrsInText((r as any).assistantText || response.text) : '', speechText,
      segments: response && mode === 'VOICE' ? (r.speech?.segments?.length ? r.speech.segments.map(maskPnrsInText) : []) : [],
      shouldSpeak: mode === 'VOICE' && !!response && !!speechText, interruptible: true, responsePriority: priority,
      state: sNow.bookingState, requiresTool: recs.length > 0, error: r.error ? { code: r.error.code, message: r.error.message } : null
    };
    // Prompt 34 (§17): one safe observability record per VOICE turn — same turn identity as text; no transcript /
    // response text, no passenger data, no secrets. TTS timings are measured by the voice layer (voiceMetrics()).
    if (mode === 'VOICE') {
      const diag: any = r.turnLog.diagnostics || {};
      const toolFailure = ((diag.tools || []) as Array<{ outcome?: string }>).map(t => String(t.outcome || '')).find(o => VOICE_FAILURE_OUTCOMES.has(o)) || null;
      r.turnLog.voiceTurn = {
        turnId: turn.turnId, sessionId: sid, mode: 'VOICE', inputSource: opts.transcript ? 'STT' : 'VOICE_CLIENT',
        transcriptStatus: opts.transcript?.status ?? null, transcriptConfidence: opts.transcript?.confidence ?? null,
        languageHint: opts.transcript?.languageHint ?? null, sttDurationMs: opts.transcript?.sttDurationMs ?? null,
        llmLatencyMs: turn.llmLatencyMs, llmCallCount: typeof diag.llmCalls === 'number' ? diag.llmCalls : null,
        toolCount: turn.toolCount, providerCalls: turn.toolResults.length,
        bargeIn: !!opts.interruptPrevious, interrupted: turn.interrupted, stale: turn.superseded, presentation: turn.presentation,
        finalStatus: turn.status, failureCategory: toolFailure ?? (turn.superseded ? 'SUPERSEDED' : null) ?? (r.error?.code ?? null),
        speechSegments: voice.segments.length, speechSource: r.speech?.source ?? null, totalTurnLatencyMs: turn.totalTurnLatencyMs
      };
    }
    const publicTurn = this.publicTurn(turn);
    return {
      ...r,
      responseMessage: response ? r.responseMessage : '',
      turn: publicTurn,
      assistantTurnResponse: response,
      progress: [...turn.progress],
      turnEvents: this.events.forTurn(sid, turn.turnId),
      presentable: !!response,
      voice
    };
  }

  // ------------------------------------------------------------------ helpers

  /** Part 22 — response type from authoritative outcome (never from LLM self-description). */
  private responseType(r: AgentTurnResult): AssistantResponseType {
    const pi = r.context.pendingInteraction;
    const recs = (r.turnLog.toolExecutions || []) as ToolExecutionRecord[];
    const okTool = recs.some(x => x.status === 'SUCCEEDED');
    const executed = recs.filter(x => x.startedAt);
    if (pi?.type === 'CONFIRMATION_REQUIRED' || pi?.type === 'REVIEW_APPROVAL_REQUIRED') return 'CONFIRMATION_REQUEST';
    if (r.error && ERROR_CODES_AS_ERROR.has(r.error.code) && !okTool) return 'ERROR';
    // every provider call of this turn failed / timed out (after backend retries) → honest ERROR response
    if (executed.length && !okTool) return 'ERROR';
    // unsupported (non-railway) request → plain text, not a clarification
    if (r.turnLog.rejectionReason === 'UNKNOWN_INTENT') return 'TEXT';
    if (okTool) return 'FINAL';
    if (pi && pi.type !== 'NONE') return 'CLARIFICATION';
    return 'TEXT';
  }

  private setStatus(t: ConversationTurn, to: TurnStatus) {
    if (t.status === to) return;
    if (!canTransitionTurn(t.status, to)) {
      // terminal turns (COMPLETED …) never move again; illegal moves are recorded, not applied
      t.illegalTransitions.push(`${t.status}->${to}`);
      return;
    }
    t.status = to;
    t.statusHistory.push({ status: to, at: new Date().toISOString() });
    this.emit(t, 'TURN_STATUS', { status: to });
  }

  private finalize(t: ConversationTurn, to: TurnStatus, t0: number) {
    this.setStatus(t, to);
    t.completedAt = new Date().toISOString();
    t.totalTurnLatencyMs = Date.now() - t0;
  }

  private emit(t: ConversationTurn, type: TurnEventType, data?: Record<string, any>) {
    this.events.emit(t.sessionId, t.turnId, t.sequence, type, data);
  }

  private publicTurn(t: ConversationTurn): ConversationTurn {
    const { _records, ...rest } = t as any;
    return { ...rest, statusHistory: [...t.statusHistory], toolCalls: [...t.toolCalls], toolResults: [...t.toolResults], progress: [...t.progress], illegalTransitions: [...t.illegalTransitions] };
  }
}
