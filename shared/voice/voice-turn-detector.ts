/**
 * PROMPT 21 — Part 11/12: VoiceTurnDetector — "user still speaking" vs "user finished speaking".
 *
 * Signals (whatever the current voice stack provides):
 *   - speech activity (VAD / SpeechRecognition onspeechstart / onspeechend),
 *   - streaming STT partial + final results,
 *   - silence duration since the last speech activity / transcript change,
 *   - interruption state (a barge-in utterance must be complete before it becomes a turn).
 *
 * No single long fixed timeout: the end-of-turn silence threshold ADAPTS to the transcript —
 *   final STT result + complete-sounding utterance → short (≈ 350 ms),
 *   no final yet but complete-sounding               → medium (≈ 700 ms),
 *   trailing continuation ("Actually 12014 nahi…", "aur", "matlab") → longer (≈ 1400 ms),
 *   hard ceiling (maxSilenceMs) so a stuck recogniser can never hang the conversation.
 * Partial speech never produces a turn: only USER_FINISHED does (Part 11 — no irreversible action from partials).
 * Pure + clock-injected → deterministic tests.
 */
export type TurnDetectorStatus = 'IDLE' | 'USER_SPEAKING' | 'USER_PAUSED' | 'USER_FINISHED';

export interface TurnDetectorConfig {
  /** Silence after a FINAL STT result on a complete-sounding utterance. */
  finalSilenceMs: number;
  /** Silence with only partial results on a complete-sounding utterance. */
  partialSilenceMs: number;
  /** Silence when the utterance ends with a continuation word / trailing ellipsis. */
  continuationSilenceMs: number;
  /** Absolute ceiling for any silence wait. */
  maxSilenceMs: number;
  /** Ignore utterances shorter than this (noise / clicks). */
  minChars: number;
}

export const DEFAULT_TURN_DETECTOR_CONFIG: Readonly<TurnDetectorConfig> = Object.freeze({
  finalSilenceMs: 350, partialSilenceMs: 700, continuationSilenceMs: 1400, maxSilenceMs: 2000, minChars: 1
});

/** Trailing words after which a speaker is very likely to continue (Hindi / Hinglish / English). */
const CONTINUATION_TAIL = /(?:\b(?:aur|ya|nahi|nahin|actually|matlab|yaani|ki|ke|ka|se|ko|to|toh|lekin|par|but|and|or|the|uske|phir|um+|uh+)|और|या|नहीं|लेकिन|\.\.\.|…|,)\s*$/i;

export interface TurnDetectorDecision {
  status: TurnDetectorStatus;
  /** Best current transcript (final segments + latest partial). */
  transcript: string;
  /** Final transcript to hand to processTurn — only when status === USER_FINISHED. */
  finalTranscript: string | null;
  /** Silence threshold currently in force (observability). */
  thresholdMs: number;
  reason: 'NO_SPEECH' | 'SPEAKING' | 'WAITING_FOR_SILENCE' | 'FINAL_AND_SILENT' | 'SILENCE' | 'MAX_SILENCE';
  /** The finished utterance interrupted the agent (barge-in). */
  bargeIn: boolean;
}

export class VoiceTurnDetector {
  private readonly cfg: TurnDetectorConfig;
  private finals: string[] = [];
  private partial = '';
  private speaking = false;
  private lastActivity = 0;
  private started = false;
  private finalSeen = false;
  private barge = false;
  private done = false;

  constructor(cfg: Partial<TurnDetectorConfig> = {}) { this.cfg = { ...DEFAULT_TURN_DETECTOR_CONFIG, ...cfg }; }

  /** New listening window (new turn). */
  reset(): void {
    this.finals = []; this.partial = ''; this.speaking = false; this.lastActivity = 0;
    this.started = false; this.finalSeen = false; this.barge = false; this.done = false;
  }

  /** The user started talking while the agent was speaking. */
  markBargeIn(): void { this.barge = true; }

  speechStart(now: number): void { this.started = true; this.speaking = true; this.lastActivity = now; this.done = false; }
  speechEnd(now: number): void { this.speaking = false; this.lastActivity = now; }

  partialTranscript(text: string, now: number): void {
    const t = String(text || '').trim();
    if (!t) return;
    if (t !== this.partial) { this.partial = t; this.lastActivity = now; }
    this.started = true; this.finalSeen = false; this.done = false;
  }

  finalTranscript(text: string, now: number): void {
    const t = String(text || '').trim();
    if (!t) return;
    this.finals.push(t); this.partial = ''; this.started = true; this.finalSeen = true; this.lastActivity = now; this.done = false;
  }

  get transcript(): string { return [...this.finals, this.partial].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim(); }

  /** Silence threshold for the current transcript (adaptive — see header). */
  thresholdFor(text: string, finalSeen: boolean): number {
    const cont = CONTINUATION_TAIL.test(text);
    const ms = cont ? this.cfg.continuationSilenceMs : finalSeen ? this.cfg.finalSilenceMs : this.cfg.partialSilenceMs;
    return Math.min(ms, this.cfg.maxSilenceMs);
  }

  evaluate(now: number): TurnDetectorDecision {
    const transcript = this.transcript;
    const base = { transcript, finalTranscript: null as string | null, bargeIn: this.barge };
    if (!this.started || transcript.length < this.cfg.minChars) return { ...base, status: 'IDLE', thresholdMs: 0, reason: 'NO_SPEECH' };
    const threshold = this.thresholdFor(transcript, this.finalSeen);
    if (this.done) return { ...base, status: 'USER_FINISHED', finalTranscript: transcript, thresholdMs: threshold, reason: 'FINAL_AND_SILENT' };
    if (this.speaking) {
      // a recogniser that never reports speech-end is bounded by the ceiling
      if (now - this.lastActivity >= this.cfg.maxSilenceMs && this.finalSeen) return this.finish(transcript, threshold, 'MAX_SILENCE');
      return { ...base, status: 'USER_SPEAKING', thresholdMs: threshold, reason: 'SPEAKING' };
    }
    const silent = now - this.lastActivity;
    if (silent >= threshold) return this.finish(transcript, threshold, this.finalSeen ? 'FINAL_AND_SILENT' : 'SILENCE');
    return { ...base, status: 'USER_PAUSED', thresholdMs: threshold, reason: 'WAITING_FOR_SILENCE' };
  }

  private finish(transcript: string, threshold: number, reason: TurnDetectorDecision['reason']): TurnDetectorDecision {
    this.done = true;
    return { status: 'USER_FINISHED', transcript, finalTranscript: transcript, thresholdMs: threshold, reason, bargeIn: this.barge };
  }
}
