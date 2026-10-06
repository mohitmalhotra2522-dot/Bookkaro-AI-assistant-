/**
 * PROMPT 21 — Part 30: ConversationalVoiceAgent.
 *
 *   listen ─► speech activity / partial + final transcripts ─► VoiceTurnDetector (end-of-turn)
 *         ─► normalizeTranscript ─► processTurn  (the SAME ConversationTurnEngine.processTurn as text — injected)
 *         ─► turn events: tool requested → ONE short acknowledgement (LLM-worded, fact-free) ─► tool result
 *         ─► grounded natural response, streamed sentence-by-sentence ─► TTS (cancellable)
 *         ─► barge-in at any time: stop TTS, mark the old turn interrupted, the new utterance is a new turn.
 *
 * Transport-agnostic orchestration only. It holds NO booking / railway / passenger state and NO conversation memory —
 * BookingSession + the turn engine stay the single source of truth (Parts 31, 39). TTS only converts text to audio
 * (Part 29); it never decides anything. The same class runs in the browser (HTTP turn processor + Web Speech
 * adapters) and on the server / in tests (engine turn processor + mock adapters).
 *
 * Microphone policy (user decision for Prompt 21): tap-to-talk by default (the mic closes after one utterance).
 * Barge-in by VOICE requires the user to switch on the visible, opt-in conversation mode; the mic is then open only
 * during that user-started voice session and one tap (`cancel()`) turns it off. In tap mode, tapping the mic while
 * the agent speaks is the barge-in.
 */
import { VoiceTurnDetector, type TurnDetectorConfig } from './voice-turn-detector';
import { normalizeTranscript } from './stt-normalizer';
import { isLikelyEcho, isSpeakable, preempts, redactForSpeech, segmentForSpeech, type ResponsePriority } from './voice-response-policy';
import { isUncertainConfidence, makeTranscriptEvent, type TranscriptEvent, type TranscriptMeta, type TranscriptStatus, type VoiceTranscriptInfo } from './transcript';

export type VoiceAgentState = 'IDLE' | 'LISTENING' | 'USER_SPEAKING' | 'PROCESSING' | 'SPEAKING' | 'INTERRUPTED';

/** Streamed during a turn by the turn processor (engine events / HTTP polling). */
export type VoiceTurnEvent =
  | { type: 'TURN_STARTED'; turnId: string; sequence: number }
  | { type: 'TOOL_REQUESTED'; turnId: string; sequence: number; tool: string }
  | { type: 'TOOL_RESULT'; turnId: string; sequence: number; tool: string; ok: boolean }
  | { type: 'ACKNOWLEDGEMENT'; turnId: string; sequence: number; text: string }
  | { type: 'STATUS_UPDATE'; turnId: string; sequence: number; text: string }
  | { type: 'SPEECH_SEGMENT'; turnId: string; sequence: number; index: number; text: string };

/** Part 32 — the logical turn result as the voice layer sees it (same for TEXT and VOICE). */
export interface VoiceTurnOutcome {
  sessionId: string;
  turnId: string;
  sequence: number;
  journeyVersion?: number | null;
  presentable: boolean;
  assistantText: string;
  speechText: string;
  segments: string[];
  shouldSpeak: boolean;
  interruptible: boolean;
  responsePriority: ResponsePriority;
  state?: string;
  requiresTool?: boolean;
  error?: { code: string; message?: string } | null;
  /** Prompt 41: VoiceResponse metadata (purpose / factsUsed / question / speechLength / path). Play Again replays `segments`. */
  voiceResponse?: { purpose: string; factsUsed: Array<{ type: string; value: string }>; question: string | null; speechLength: number; turnId: string | null; path: string; [k: string]: unknown };
}

/** Prompt 34: `transcript` = structured STT metadata of a spoken turn (absent for typed text in the voice UI). */
export type TurnProcessor = (text: string, o: { bargeIn: boolean; priority: ResponsePriority; onEvent: (e: VoiceTurnEvent) => void; transcript?: VoiceTranscriptInfo }) => Promise<VoiceTurnOutcome>;

/** `started` (optional) resolves when audio actually begins — used for TTS latency (Prompt 34 §17). */
export interface SpeechPlayback { done: Promise<void>; cancel(): void; started?: Promise<void> }
/** TEXT → AUDIO only (Part 29). */
export interface SpeechOutput { readonly available: boolean; speak(text: string, o: { lang: string; turnId: string }): SpeechPlayback }
/** Prompt 34 (§2): partial / final results may carry recogniser metadata (confidence, language). */
export interface SpeechInputHandlers {
  onSpeechStart(): void; onSpeechEnd(): void; onPartial(text: string, meta?: TranscriptMeta): void; onFinal(text: string, meta?: TranscriptMeta): void; onError(code: string): void;
}
/** Microphone + STT. `start` is only ever called from an explicit user action (listen / conversation mode). */
export interface SpeechInput { readonly available: boolean; start(h: SpeechInputHandlers, o: { continuous: boolean; lang: string }): void; stop(): void }

export interface VoiceAgentDeps {
  sessionId: string;
  processTurn: TurnProcessor;
  output: SpeechOutput;
  input?: SpeechInput;
  /** Tell the backend the current turn / presentation was interrupted (BookingSession untouched). */
  interruptRemote?: (reason: 'BARGE_IN' | 'USER_STOP') => Promise<void> | void;
  now?: () => number;
  lang?: string;
  detector?: Partial<TurnDetectorConfig>;
  /** Minimum non-echo characters before speech during playback counts as a barge-in. */
  minBargeInChars?: number;
}

export interface VoiceAgentSnapshot {
  state: VoiceAgentState;
  conversationMode: boolean;
  listening: boolean;
  activeTurnId: string | null;
  activeSequence: number;
  partialTranscript: string;
  textFallback: boolean;
  sttAvailable: boolean;
  ttsAvailable: boolean;
  lastError: string | null;
  toolActivity: Array<{ tool: string; status: 'REQUESTED' | 'OK' | 'FAILED' }>;
}

export type VoiceAgentEvent =
  | { type: 'STATE'; state: VoiceAgentState }
  | { type: 'PARTIAL'; text: string }
  | { type: 'TURN_SUBMITTED'; text: string; bargeIn: boolean }
  | { type: 'SPOKEN'; turnId: string; text: string; kind: 'ACK' | 'STATUS' | 'RESPONSE' }
  | { type: 'SPEECH_CANCELLED'; turnId: string | null; reason: string }
  | { type: 'DISCARDED'; turnId: string; reason: string }
  | { type: 'TEXT_FALLBACK'; reason: string }
  | { type: 'OUTCOME'; outcome: VoiceTurnOutcome }
  // Prompt 34 — structured STT results (UI only; never logged), uncertain / incomplete utterances (nothing submitted)
  | { type: 'TRANSCRIPT'; transcript: TranscriptEvent }
  | { type: 'TRANSCRIPT_UNCERTAIN'; confidence: number }
  | { type: 'TRANSCRIPT_INCOMPLETE' };

/**
 * Prompt 34 (§17) — per-turn voice observability kept by the voice layer (no transcript / response text, no
 * passenger data). The server-side counterpart (LLM latency / calls, tools, outcome) is `turnLog.voiceTurn`.
 */
export type VoiceTtsStatus = 'NONE' | 'PENDING' | 'SPOKEN' | 'PARTIAL' | 'CANCELLED' | 'FAILED' | 'TEXT_ONLY';
export interface VoiceTurnMetrics {
  localSeq: number;
  turnId: string | null;
  inputSource: 'SPEECH' | 'TYPED';
  transcriptStatus: TranscriptStatus | null;
  transcriptConfidence: number | null;
  languageHint: string | null;
  sttDurationMs: number | null;
  turnLatencyMs: number | null;
  timeToFirstSpeechMs: number | null;
  ttsLatencyMs: number | null;
  segmentsQueued: number;
  segmentsSpoken: number;
  tts: VoiceTtsStatus;
  interrupted: boolean;
  stale: boolean;
  discardReason: string | null;
  speechRetries: number;
}
interface MetricsRec extends Omit<VoiceTurnMetrics, 'tts'> { submittedAt: number; cancelled: number; failed: number; textOnly: number }
const MAX_METRICS = 20;

interface QueueItem { turnId: string; sequence: number; text: string; kind: 'ACK' | 'STATUS' | 'RESPONSE'; priority: ResponsePriority; index?: number }

export class ConversationalVoiceAgent {
  private state: VoiceAgentState = 'IDLE';
  private conversationMode = false;
  private listening = false;
  private readonly detector: VoiceTurnDetector;
  private readonly now: () => number;
  private readonly lang: string;
  private seq = 0;                       // local turn counter (latest submitted utterance)
  private active: { turnId: string | null; localSeq: number; serverSeq: number; priority: ResponsePriority; acked: boolean; spoken: Set<number>; journeyVersion?: number | null } | null = null;
  private interrupted = new Set<string>();
  private queue: QueueItem[] = [];
  private playing: { item: QueueItem; playback: SpeechPlayback } | null = null;
  private textFallback = false;
  private lastError: string | null = null;
  private partial = '';
  private tools: VoiceAgentSnapshot['toolActivity'] = [];
  private listeners = new Set<(e: VoiceAgentEvent) => void>();
  // Prompt 34 — current utterance (STT metadata), per-turn metrics, the last presentable outcome (speech retry)
  private uttSeq = 0;
  private utt: { id: string; startedAt: number | null; confidences: number[]; language: string | null } = { id: '', startedAt: null, confidences: [], language: null };
  private metrics: MetricsRec[] = [];
  private lastOutcome: VoiceTurnOutcome | null = null;

  constructor(private readonly deps: VoiceAgentDeps) {
    this.detector = new VoiceTurnDetector(deps.detector);
    this.now = deps.now || (() => Date.now());
    this.lang = deps.lang || 'hi-IN';
    if (!deps.output.available) this.textFallback = true;
  }

  // ------------------------------------------------------------------ observation
  on(cb: (e: VoiceAgentEvent) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  private emit(e: VoiceAgentEvent) { for (const l of this.listeners) { try { l(e); } catch { /* listener only */ } } }
  private setState(s: VoiceAgentState) { if (this.state !== s) { this.state = s; this.emit({ type: 'STATE', state: s }); } }

  snapshot(): VoiceAgentSnapshot {
    return {
      state: this.state, conversationMode: this.conversationMode, listening: this.listening,
      activeTurnId: this.active?.turnId ?? null, activeSequence: this.active?.serverSeq ?? 0, partialTranscript: this.partial,
      textFallback: this.textFallback, sttAvailable: !!this.deps.input?.available, ttsAvailable: this.deps.output.available,
      lastError: this.lastError, toolActivity: [...this.tools]
    };
  }

  // ------------------------------------------------------------------ listening (explicit user actions only)

  /** Opt-in conversation mode (visible in the UI). Off → tap-to-talk. Turning it off stops the mic immediately. */
  setConversationMode(on: boolean): void {
    this.conversationMode = !!on;
    if (!on && this.listening && this.state !== 'USER_SPEAKING') this.stopInput();
  }

  /** User tapped the mic. While the agent speaks / processes this is the tap barge-in. */
  listen(): void {
    if (this.playing || this.queue.length || this.state === 'PROCESSING') this.interrupt('BARGE_IN');
    this.detector.reset();
    if (this.lastBarge) this.detector.markBargeIn();
    if (!this.deps.input?.available) {
      this.lastError = 'STT_UNAVAILABLE';
      this.emit({ type: 'TEXT_FALLBACK', reason: 'STT_UNAVAILABLE' });
      this.setState('IDLE');
      return;
    }
    this.startInput();
    this.setState('LISTENING');
  }
  private lastBarge = false;

  private startInput() {
    if (this.listening || !this.deps.input) return;
    this.listening = true;
    try {
      this.deps.input.start({
        onSpeechStart: () => this.onSpeechActivity('start'),
        onSpeechEnd: () => this.onSpeechActivity('end'),
        onPartial: (t, m) => this.receiveTranscript(t, false, m),
        onFinal: (t, m) => this.receiveTranscript(t, true, m),
        onError: (code) => this.onInputError(code)
      }, { continuous: this.conversationMode, lang: this.lang });
    } catch { this.onInputError('STT_START_FAILED'); }
  }
  private stopInput() { if (!this.listening) return; this.listening = false; try { this.deps.input?.stop(); } catch { /* ignore */ } }

  private onInputError(code: string) {
    this.listening = false;
    // Prompt 34 (§15): an STT failure leaves no half-heard transcript behind (nothing is submitted or completed later)
    this.detector.reset();
    this.partial = '';
    this.resetUtterance();
    this.lastError = code;
    this.emit({ type: 'TEXT_FALLBACK', reason: code });   // typing always works (Part 21)
    if (this.state === 'LISTENING' || this.state === 'USER_SPEAKING') this.setState('IDLE');
  }

  /** Speech activity from VAD / the recogniser. During playback (conversation mode) it may be a barge-in. */
  onSpeechActivity(kind: 'start' | 'end'): void {
    const t = this.now();
    if (kind === 'start') { this.beginUtterance(t); this.detector.speechStart(t); if (this.state === 'LISTENING') this.setState('USER_SPEAKING'); }
    else this.detector.speechEnd(t);
  }

  /** Streaming STT. Partials are display-only; only end-of-turn produces a turn (Part 11). */
  receiveTranscript(text: string, isFinal: boolean, meta?: TranscriptMeta): void {
    const t = this.now();
    const clean = String(text || '').trim();
    if (!clean) return;
    // Part 10 — real barge-in (conversation mode): the user talks over the agent → stop speech NOW
    if (this.playing && this.conversationMode) {
      if (isLikelyEcho(clean, this.playing.item.text) || clean.replace(/\s/g, '').length < (this.deps.minBargeInChars ?? 3)) return;
      this.interrupt('BARGE_IN');
      this.detector.reset();
      this.detector.markBargeIn();
      this.detector.speechStart(t);
    }
    // Prompt 34 (§2/§3): structured transcript; an UNCERTAIN final (low reported confidence) is treated as interim —
    // the agent waits for more speech and never fills in missing words
    this.beginUtterance(t);
    const ev = makeTranscriptEvent({ utteranceId: this.utt.id, sessionId: this.deps.sessionId, text: clean, isFinal, meta, now: t });
    if (ev.languageHint) this.utt.language = ev.languageHint;
    this.emit({ type: 'TRANSCRIPT', transcript: ev });
    let final = isFinal;
    if (final && isUncertainConfidence(meta?.confidence)) { final = false; this.emit({ type: 'TRANSCRIPT_UNCERTAIN', confidence: ev.confidence ?? 0 }); }
    else if (final && ev.confidence !== null) this.utt.confidences.push(ev.confidence);
    if (final) this.detector.finalTranscript(clean, t); else this.detector.partialTranscript(clean, t);
    this.partial = this.detector.transcript;
    this.emit({ type: 'PARTIAL', text: this.partial });
    if (this.state === 'LISTENING' || this.state === 'IDLE' || this.state === 'INTERRUPTED') this.setState('USER_SPEAKING');
  }

  /** Drive end-of-turn detection (browser: interval; tests: explicit). Returns the turn promise when one started. */
  tick(): Promise<VoiceTurnOutcome | null> | null {
    const now = this.now();
    const d = this.detector.evaluate(now);
    if (d.status === 'INCOMPLETE') {
      // Prompt 34 (§3): no final transcript arrived — nothing is submitted (no half-heard turn, no guessed words)
      this.detector.reset();
      this.partial = '';
      this.resetUtterance();
      this.lastError = 'TRANSCRIPT_INCOMPLETE';
      this.emit({ type: 'TRANSCRIPT_INCOMPLETE' });
      if (!this.conversationMode) { this.stopInput(); this.setState('IDLE'); } else this.setState('LISTENING');
      return null;
    }
    if (d.status !== 'USER_FINISHED' || !d.finalTranscript) return null;
    const bargeIn = d.bargeIn || this.lastBarge;
    const transcript: VoiceTranscriptInfo = {
      status: 'FINAL', confidence: this.utt.confidences.length ? Math.min(...this.utt.confidences) : null, languageHint: this.utt.language,
      sttDurationMs: this.utt.startedAt !== null ? Math.max(0, now - this.utt.startedAt) : null, utteranceId: this.utt.id || null
    };
    this.detector.reset();
    this.partial = '';
    this.resetUtterance();
    if (!this.conversationMode) this.stopInput();
    return this.processTurn(d.finalTranscript, { bargeIn, transcript });
  }

  private beginUtterance(t: number) {
    if (this.utt.startedAt !== null) return;
    this.utt = { id: `u${++this.uttSeq}-${Math.max(0, Math.floor(t)).toString(36)}`, startedAt: t, confidences: [], language: null };
  }
  private resetUtterance() { this.utt = { id: '', startedAt: null, confidences: [], language: null }; }

  // ------------------------------------------------------------------ the turn

  /** Part 31 — hands the (normalized) transcript to the shared engine. Also used for typed text in voice UI. */
  async processTurn(rawText: string, o: { bargeIn?: boolean; normalize?: boolean; transcript?: VoiceTranscriptInfo } = {}): Promise<VoiceTurnOutcome | null> {
    const text = o.normalize === false ? String(rawText || '').trim() : normalizeTranscript(rawText).text;
    if (!text) return null;
    // a new user turn supersedes everything still pending / playing from the previous one (Part 33)
    if (this.playing || this.queue.length || (this.active && this.state === 'PROCESSING')) this.interrupt('BARGE_IN');
    const bargeIn = !!o.bargeIn || this.lastBarge;
    this.lastBarge = false;
    const localSeq = ++this.seq;
    const priority: ResponsePriority = bargeIn ? 'INTERRUPT' : 'HIGH';
    this.active = { turnId: null, localSeq, serverSeq: 0, priority, acked: false, spoken: new Set() };
    this.tools = [];
    this.lastOutcome = null;
    this.metrics.push({
      localSeq, turnId: null, inputSource: o.transcript ? 'SPEECH' : 'TYPED', transcriptStatus: o.transcript?.status ?? null,
      transcriptConfidence: o.transcript?.confidence ?? null, languageHint: o.transcript?.languageHint ?? null, sttDurationMs: o.transcript?.sttDurationMs ?? null,
      submittedAt: this.now(), turnLatencyMs: null, timeToFirstSpeechMs: null, ttsLatencyMs: null, segmentsQueued: 0, segmentsSpoken: 0,
      interrupted: false, stale: false, discardReason: null, speechRetries: 0, cancelled: 0, failed: 0, textOnly: 0
    });
    if (this.metrics.length > MAX_METRICS) this.metrics.splice(0, this.metrics.length - MAX_METRICS);
    this.setState('PROCESSING');
    this.emit({ type: 'TURN_SUBMITTED', text, bargeIn });
    let outcome: VoiceTurnOutcome;
    try {
      outcome = await this.deps.processTurn(text, { bargeIn, priority, onEvent: (e) => this.onTurnEvent(localSeq, e), ...(o.transcript ? { transcript: o.transcript } : {}) });
    } catch (e: any) {
      this.lastError = 'TURN_FAILED';
      if (this.isCurrent(localSeq)) { this.setState(this.conversationMode ? 'LISTENING' : 'IDLE'); this.afterSpeech(); }
      throw e;
    }
    return this.receiveOutcome(localSeq, outcome);
  }

  private isCurrent(localSeq: number) { return !!this.active && this.active.localSeq === localSeq && localSeq === this.seq; }

  /** Part 30 requestTool / receiveToolResult — observation only (tools run in the backend runtime, never here). */
  requestTool(tool: string): void { this.tools.push({ tool, status: 'REQUESTED' }); }
  receiveToolResult(tool: string, ok: boolean): void {
    const t = [...this.tools].reverse().find(x => x.tool === tool && x.status === 'REQUESTED');
    if (t) t.status = ok ? 'OK' : 'FAILED'; else this.tools.push({ tool, status: ok ? 'OK' : 'FAILED' });
  }

  private onTurnEvent(localSeq: number, e: VoiceTurnEvent) {
    if (!this.isCurrent(localSeq) || !this.active) return;           // events of an abandoned turn are ignored
    if (this.interrupted.has(e.turnId)) return;
    if (!this.active.turnId) { this.active.turnId = e.turnId; this.active.serverSeq = e.sequence; this.bindMetric(localSeq, e.turnId); }
    if (e.turnId !== this.active.turnId) return;
    switch (e.type) {
      case 'TOOL_REQUESTED': this.requestTool(e.tool); break;
      case 'TOOL_RESULT': this.receiveToolResult(e.tool, e.ok); break;
      case 'ACKNOWLEDGEMENT':
        // Part 35 — exactly one short acknowledgement per turn
        if (!this.active.acked) { this.active.acked = true; this.enqueue({ turnId: e.turnId, sequence: e.sequence, text: e.text, kind: 'ACK', priority: this.active.priority }); }
        break;
      case 'STATUS_UPDATE':
        if (!this.queue.length && !this.playing) this.enqueue({ turnId: e.turnId, sequence: e.sequence, text: e.text, kind: 'STATUS', priority: 'NORMAL' });
        break;
      case 'SPEECH_SEGMENT':
        // Part 14 — streamed, already-grounded sentence: start speaking before the turn finishes
        if (!this.active.spoken.has(e.index)) { this.active.spoken.add(e.index); this.enqueue({ turnId: e.turnId, sequence: e.sequence, text: e.text, kind: 'RESPONSE', priority: this.active.priority, index: e.index }); }
        break;
      default: break;
    }
  }

  /** Part 30 generateResponse — the speech plan for a finished turn (segments not streamed yet). */
  generateResponse(o: VoiceTurnOutcome): string[] {
    const segs = o.segments?.length ? o.segments : segmentForSpeech(o.speechText || o.assistantText);
    return segs.filter((_, i) => !this.active?.spoken.has(i));
  }

  private receiveOutcome(localSeq: number, o: VoiceTurnOutcome): VoiceTurnOutcome | null {
    const m = this.metrics.find(x => x.localSeq === localSeq);
    if (m) m.turnLatencyMs = Math.max(0, this.now() - m.submittedAt);
    if (!this.isCurrent(localSeq) || !this.active) {
      if (m) { m.turnId = m.turnId || o.turnId; m.stale = true; m.discardReason = 'SUPERSEDED'; }
      this.emit({ type: 'DISCARDED', turnId: o.turnId, reason: 'SUPERSEDED' }); return null;
    }
    if (!this.active.turnId) { this.active.turnId = o.turnId; this.active.serverSeq = o.sequence; }
    this.bindMetric(localSeq, o.turnId);
    this.active.journeyVersion = o.journeyVersion ?? null;
    this.emit({ type: 'OUTCOME', outcome: o });
    if (!o.presentable || this.interrupted.has(o.turnId)) {
      // segments that already streamed for a turn that turned out stale are cut off immediately (Part 34)
      this.interrupted.add(o.turnId);
      this.queue = this.queue.filter(q => q.turnId !== o.turnId);
      if (this.playing?.item.turnId === o.turnId) this.cancelPlayback('STALE');
      this.emit({ type: 'DISCARDED', turnId: o.turnId, reason: o.presentable ? 'INTERRUPTED' : 'NOT_PRESENTABLE' });
      if (m) { m.stale = true; m.discardReason = o.presentable ? 'INTERRUPTED' : 'NOT_PRESENTABLE'; }
      this.setState(this.conversationMode ? 'LISTENING' : 'IDLE');
      return o;
    }
    this.lastOutcome = o;
    if (o.shouldSpeak) {
      const segs = o.segments?.length ? o.segments : segmentForSpeech(o.speechText || o.assistantText);
      segs.forEach((text, index) => {
        if (this.active!.spoken.has(index)) return;
        this.active!.spoken.add(index);
        this.enqueue({ turnId: o.turnId, sequence: o.sequence, text, kind: 'RESPONSE', priority: o.responsePriority, index });
      });
    }
    if (!this.playing && !this.queue.length) { this.setState(this.conversationMode ? 'LISTENING' : 'IDLE'); this.afterSpeech(); }
    return o;
  }

  // ------------------------------------------------------------------ speech output

  /** Part 30 speak — queue one utterance (only if still speakable). */
  speak(item: QueueItem): void { this.enqueue(item); }

  private enqueue(item: QueueItem) {
    const ok = isSpeakable({ sessionId: this.deps.sessionId, turnId: item.turnId, sequence: item.sequence, journeyVersion: this.active?.journeyVersion },
      { sessionId: this.deps.sessionId, latestSequence: this.active?.serverSeq || item.sequence, interruptedTurnIds: this.interrupted, journeyVersion: this.active?.journeyVersion });
    if (!ok.ok) { this.emit({ type: 'DISCARDED', turnId: item.turnId, reason: ok.reason }); return; }
    if (this.playing && preempts(item, this.playing.item) && item.turnId !== this.playing.item.turnId) this.cancelPlayback('PREEMPTED');
    if (item.kind === 'RESPONSE') { const m = this.metricOf(item.turnId); if (m) m.segmentsQueued++; }
    this.queue.push(item);
    if (!this.playing) this.playNext();
  }

  private playNext() {
    const item = this.queue.shift();
    if (!item) { this.playing = null; if (this.state === 'SPEAKING') this.setState(this.conversationMode ? 'LISTENING' : 'IDLE'); this.afterSpeech(); return; }
    if (this.interrupted.has(item.turnId) || (this.active && this.active.turnId && item.turnId !== this.active.turnId)) { this.playNext(); return; }
    const m = item.kind === 'RESPONSE' ? this.metricOf(item.turnId) : undefined;
    if (this.textFallback || !this.deps.output.available) {
      // TTS unavailable → the text is already on screen; nothing is lost (Part 21)
      if (m) m.textOnly++;
      this.emit({ type: 'SPOKEN', turnId: item.turnId, text: item.text, kind: item.kind });
      this.playNext();
      return;
    }
    // Prompt 34 (§7/§16): TTS gets the validated text unchanged — only credential-shaped tokens are masked (defence in
    // depth; validated text never contains them)
    let playback: SpeechPlayback;
    const t0 = this.now();
    try { playback = this.deps.output.speak(redactForSpeech(item.text), { lang: this.lang, turnId: item.turnId }); }
    catch { if (m) m.failed++; this.ttsFailed('TTS_FAILED'); this.playNext(); return; }
    if (m) {
      if (m.timeToFirstSpeechMs === null) m.timeToFirstSpeechMs = Math.max(0, t0 - m.submittedAt);
      if (m.ttsLatencyMs === null && playback.started) playback.started.then(() => { if (m.ttsLatencyMs === null) m.ttsLatencyMs = Math.max(0, this.now() - t0); }, () => undefined);
    }
    this.playing = { item, playback };
    this.setState('SPEAKING');
    playback.done.then(() => {
      if (this.playing?.playback !== playback) return;       // cancelled / pre-empted meanwhile
      if (m) m.segmentsSpoken++;
      this.emit({ type: 'SPOKEN', turnId: item.turnId, text: item.text, kind: item.kind });
      this.playing = null;
      this.playNext();
    }, () => {
      if (this.playing?.playback !== playback) return;
      if (m) m.failed++;
      this.playing = null;
      this.ttsFailed('TTS_FAILED');
      this.playNext();
    });
  }

  private ttsFailed(reason: string) {
    if (!this.textFallback) { this.textFallback = true; this.lastError = reason; this.emit({ type: 'TEXT_FALLBACK', reason }); }
  }

  private cancelPlayback(reason: string) {
    const p = this.playing;
    this.playing = null;
    if (p) {
      try { p.playback.cancel(); } catch { /* ignore */ }
      const m = reason === 'RETRY' ? undefined : this.metricOf(p.item.turnId);
      if (m) { m.cancelled++; if (reason === 'STALE') m.stale = true; else m.interrupted = true; }
      this.emit({ type: 'SPEECH_CANCELLED', turnId: p.item.turnId, reason });
    }
  }

  // ------------------------------------------------------------------ Prompt 34: audio failure recovery + metrics

  /**
   * §15 — "retry speech" after a TTS / playback failure: re-speaks the SAME validated outcome of the CURRENT turn.
   * No new agent turn, no LLM call, no tool call, no state change. An interrupted / superseded / stale response can
   * never be resumed (false).
   */
  retrySpeech(): boolean {
    const o = this.lastOutcome;
    if (!o || !this.active || this.active.localSeq !== this.seq || this.active.turnId !== o.turnId) return false;
    if (this.interrupted.has(o.turnId) || !o.presentable || !o.shouldSpeak || !this.deps.output.available) return false;
    this.textFallback = false;
    this.lastError = null;
    if (this.playing?.item.turnId === o.turnId) this.cancelPlayback('RETRY');
    this.queue = this.queue.filter(q => q.turnId !== o.turnId);
    const m = this.metricOf(o.turnId);
    if (m) { m.speechRetries++; m.failed = 0; m.textOnly = 0; m.segmentsQueued = 0; m.segmentsSpoken = 0; }
    this.active.spoken = new Set();
    const segs = o.segments?.length ? o.segments : segmentForSpeech(o.speechText || o.assistantText);
    segs.forEach((text, index) => {
      this.active!.spoken.add(index);
      this.enqueue({ turnId: o.turnId, sequence: o.sequence, text, kind: 'RESPONSE', priority: o.responsePriority, index });
    });
    return true;
  }

  /** §17 — per-turn voice metrics (newest last). Statuses / counts / timings only — no text. */
  voiceMetrics(): VoiceTurnMetrics[] {
    return this.metrics.map(({ submittedAt, cancelled, failed, textOnly, ...m }) => ({
      ...m,
      tts: failed ? 'FAILED' : cancelled ? 'CANCELLED' : textOnly ? 'TEXT_ONLY'
        : m.segmentsSpoken && m.segmentsSpoken >= m.segmentsQueued ? 'SPOKEN' : m.segmentsSpoken ? 'PARTIAL' : m.segmentsQueued ? 'PENDING' : 'NONE'
    }));
  }

  private metricOf(turnId: string): MetricsRec | undefined { return [...this.metrics].reverse().find(x => x.turnId === turnId); }
  private bindMetric(localSeq: number, turnId: string) { const m = this.metrics.find(x => x.localSeq === localSeq); if (m && !m.turnId) m.turnId = turnId; }

  /** Conversation mode: re-open the mic after the agent finished speaking (still the same user-started session). */
  resumeListening(): void {
    if (!this.conversationMode) return;
    this.detector.reset();
    this.startInput();
    if (this.state !== 'PROCESSING' && this.state !== 'SPEAKING') this.setState('LISTENING');
  }
  private afterSpeech() { if (this.conversationMode && !this.playing && !this.queue.length && this.state !== 'PROCESSING') this.resumeListening(); }

  // ------------------------------------------------------------------ interruption

  /**
   * Part 10 — stop current TTS immediately, drop queued speech, mark the current turn interrupted (its late
   * response / segments are never spoken), tell the backend. The old response never resumes.
   */
  interrupt(reason: 'BARGE_IN' | 'USER_STOP' = 'BARGE_IN'): void {
    const turnId = this.playing?.item.turnId ?? this.active?.turnId ?? null;
    const hadWork = !!this.playing || this.queue.length > 0 || this.state === 'PROCESSING';
    this.cancelPlayback(reason);
    this.queue = [];
    if (this.active) {
      if (this.active.turnId) this.interrupted.add(this.active.turnId);
      // Prompt 34 (§6): the superseded response is stale — never resumed, never re-spoken (retrySpeech refuses it)
      const m = this.metrics.find(x => x.localSeq === this.active!.localSeq);
      if (m && hadWork) { m.interrupted = true; m.stale = true; }
      this.seq++;                       // any in-flight outcome of the old turn is now superseded locally
      this.active = null;
    }
    if (turnId) this.interrupted.add(turnId);
    if (hadWork) {
      this.lastBarge = reason === 'BARGE_IN';
      try { void this.deps.interruptRemote?.(reason); } catch { /* best effort */ }
      this.emit({ type: 'SPEECH_CANCELLED', turnId, reason });
    }
    this.setState('INTERRUPTED');
  }

  /** One tap: stop speaking, stop listening, leave conversation mode. Session + booking state stay untouched. */
  cancel(): void {
    this.interrupt('USER_STOP');
    this.lastBarge = false;
    this.conversationMode = false;
    this.stopInput();
    this.detector.reset();
    this.partial = '';
    this.setState('IDLE');
  }
}
