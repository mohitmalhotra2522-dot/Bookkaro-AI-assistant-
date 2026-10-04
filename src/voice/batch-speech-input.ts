/**
 * P36-C — SpeechInput adapters for ElevenLabs Scribe v2 BATCH STT (tap-to-talk).
 *
 *   tap → BatchSttSpeechInput.start (mic opens, "Recording")
 *   tap again / release → finish(): recording stops and is submitted ONCE to POST /api/voice/transcribe ("Transcribing")
 *   → FINAL transcript → handlers.onFinal(text) → the EXISTING ConversationalVoiceAgent → VoiceTurnDetector →
 *     normalizeTranscript → TurnProcessor (/api/chat, mode VOICE). Nothing else: no partials, no second brain.
 *
 * Stale protection: every recording has a unique voiceTurnId. stop() (cancel, barge-in, a new recording, leaving the
 * session) invalidates it and aborts the upload; a result for an invalidated id is DISCARDED here and never reaches
 * the agent, so it can never reach /api/chat. The server additionally rejects superseded ids (STT_STALE_TURN).
 *
 * Speech-activity signals are deliberately NOT emitted while recording: the turn detector would otherwise treat a
 * long recording without a transcript as INCOMPLETE. The release is the end of the utterance; the detector then
 * finalises the delivered FINAL transcript through its normal path.
 *
 * Pure TypeScript with injected recorder + transport → deterministic node tests (no microphone, no network).
 */
import type { SpeechInput, SpeechInputHandlers } from '@shared/voice/conversational-voice-agent';

export type BatchSttPhase = 'IDLE' | 'RECORDING' | 'TRANSCRIBING';
export interface PcmRecording { audio: Uint8Array; durationMs: number }
export interface PcmRecorder { start(onAutoStop: () => void): Promise<void>; stop(): Promise<PcmRecording>; abort(): void }
export type TranscribeResult = { ok: true; transcript: string; language?: string | null } | { ok: false; code: string; message?: string };
export interface TranscribeRequest { sessionId: string; voiceTurnId: string; audio: Uint8Array; durationMs: number }

export interface BatchSpeechInputDeps {
  sessionId: () => string | null;
  createRecorder: () => PcmRecorder | null;
  transcribe: (req: TranscribeRequest, signal: AbortSignal) => Promise<TranscribeResult>;
  recorderSupported?: () => boolean;
  newId?: () => string;
}

const defaultId = () => {
  const c: any = (globalThis as any).crypto;
  if (c?.randomUUID) return 'vt_' + c.randomUUID().replace(/-/g, '');
  return 'vt_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
};

export class BatchSttSpeechInput implements SpeechInput {
  private enabled = false;
  private phase: BatchSttPhase = 'IDLE';
  private token: string | null = null;
  private rec: PcmRecorder | null = null;
  private h: SpeechInputHandlers | null = null;
  private ctl: AbortController | null = null;
  private listeners = new Set<(p: BatchSttPhase) => void>();
  /** Observability (counts only): uploads made, results discarded as stale. */
  submitted = 0;
  discarded = 0;

  constructor(private readonly deps: BatchSpeechInputDeps) {}

  /** Server STT capability (GET /api/voice/config → stt.enabled). */
  setEnabled(on: boolean): void { this.enabled = !!on; if (!on) this.stop(); }
  get available(): boolean { return this.enabled && (this.deps.recorderSupported ? this.deps.recorderSupported() : true); }
  get currentPhase(): BatchSttPhase { return this.phase; }
  onPhase(cb: (p: BatchSttPhase) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  private setPhase(p: BatchSttPhase) { if (this.phase !== p) { this.phase = p; for (const l of this.listeners) { try { l(p); } catch { /* ui only */ } } } }

  /** Explicit user tap only (called by the agent's listen()). Opens the mic; nothing is uploaded yet. */
  start(h: SpeechInputHandlers, _o: { continuous: boolean; lang: string }): void {
    this.stop();
    if (!this.available) { h.onError('STT_UNAVAILABLE'); return; }
    const rec = this.deps.createRecorder();
    if (!rec) { h.onError('STT_UNAVAILABLE'); return; }
    const token = (this.deps.newId || defaultId)();
    this.token = token; this.h = h; this.rec = rec;
    this.setPhase('RECORDING');
    rec.start(() => { if (this.token === token) void this.finish(); }).catch((e: any) => {
      if (this.token !== token) return;
      this.clear();
      h.onError(e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'MIC_PERMISSION_DENIED' : 'STT_START_FAILED');
    });
  }

  /** Release: stop recording and submit it ONCE. Resolves after the result was delivered or discarded. */
  async finish(): Promise<void> {
    const token = this.token, rec = this.rec, h = this.h;
    if (!token || !rec || !h || this.phase !== 'RECORDING') return;
    this.rec = null;
    this.setPhase('TRANSCRIBING');
    let recording: PcmRecording;
    try { recording = await rec.stop(); }
    catch { if (this.token === token) { this.clear(); h.onError('STT_AUDIO_INVALID'); } return; }
    if (this.token !== token) { this.discarded++; return; }
    const sessionId = this.deps.sessionId();
    if (!sessionId) { this.clear(); h.onError('STT_SESSION_INVALID'); return; }
    if (!recording.audio.length) { this.clear(); h.onError('STT_AUDIO_INVALID'); return; }
    const ctl = new AbortController();
    this.ctl = ctl;
    this.submitted++;
    let r: TranscribeResult;
    try { r = await this.deps.transcribe({ sessionId, voiceTurnId: token, audio: recording.audio, durationMs: recording.durationMs }, ctl.signal); }
    catch { r = { ok: false, code: ctl.signal.aborted ? 'STT_STALE_TURN' : 'STT_PROVIDER_UNAVAILABLE' }; }
    // a superseded / cancelled recording never reaches the agent (→ never reaches /api/chat)
    if (this.token !== token || ctl.signal.aborted) { this.discarded++; return; }
    this.clear();
    if (!r.ok) { h.onError(r.code || 'STT_PROVIDER_UNAVAILABLE'); return; }
    const text = String(r.transcript || '').trim();
    if (!text) { h.onError('STT_NO_SPEECH'); return; }
    h.onFinal(text, { language: typeof r.language === 'string' ? r.language : 'hin' });
  }

  /** Cancel / barge-in / new recording: invalidate the current recording and abort its upload (one tap). */
  stop(): void {
    const rec = this.rec, ctl = this.ctl;
    this.clear();
    try { rec?.abort(); } catch { /* ignore */ }
    try { ctl?.abort(); } catch { /* ignore */ }
  }

  private clear() { this.token = null; this.rec = null; this.h = null; this.ctl = null; this.setPhase('IDLE'); }
}

/**
 * Chooses the transport per listening request, without changing the agent:
 *  - tap-to-talk (continuous=false) → ElevenLabs batch when the server reports it enabled, else the browser recogniser;
 *  - opt-in conversation mode (continuous=true, needs streaming speech activity for voice barge-in) → the existing
 *    browser recogniser; without one, the mode is reported unsupported (tap-to-talk keeps working).
 */
/** P36-C.1.1 — which recogniser a tap-to-talk turn tries first (user setting; default = enhanced). */
export type SttPreference = 'ENHANCED_FIRST' | 'DEVICE_FIRST';
export type SttSource = 'DEVICE' | 'ENHANCED';

/** Browser (Web Speech) STT capability — existence of the API only; it does NOT prove recognition works. */
export function detectBrowserStt(w: any = typeof window !== 'undefined' ? window : undefined): { supported: boolean; api: 'SpeechRecognition' | 'webkitSpeechRecognition' | null; secureContext: boolean } {
  if (!w) return { supported: false, api: null, secureContext: false };
  const api = typeof w.SpeechRecognition === 'function' ? 'SpeechRecognition' : typeof w.webkitSpeechRecognition === 'function' ? 'webkitSpeechRecognition' : null;
  const secureContext = w.isSecureContext !== false;
  return { supported: !!api && secureContext, api, secureContext };
}

/**
 * Pure transport choice. Hands-free (continuous) needs the browser recogniser. Tap-to-talk: enhanced (server) STT is
 * primary unless the user chose device-first; device recognition that failed this session is skipped (→ enhanced).
 */
export function chooseSttTransport(o: { continuous: boolean; preference: SttPreference; batchAvailable: boolean; browserAvailable: boolean; browserHealthy: boolean }): 'BATCH' | 'BROWSER' | null {
  if (o.continuous) return o.browserAvailable ? 'BROWSER' : null;
  if (o.preference === 'DEVICE_FIRST' && o.browserAvailable && (o.browserHealthy || !o.batchAvailable)) return 'BROWSER';
  if (o.batchAvailable) return 'BATCH';
  return o.browserAvailable ? 'BROWSER' : null;
}

/** Errors after which device recognition is treated as unusable for the rest of the session (→ enhanced next turn). */
const DEVICE_STT_BROKEN = new Set(['STT_ERROR', 'STT_START_FAILED', 'STT_UNAVAILABLE']);

export class HybridSpeechInput implements SpeechInput {
  private activeInput: SpeechInput | null = null;
  private pref: SttPreference = 'ENHANCED_FIRST';
  private deviceHealthy = true;
  private sourceListeners = new Set<(s: SttSource | null) => void>();
  constructor(readonly batch: BatchSttSpeechInput, readonly browser: SpeechInput) {}
  get available(): boolean { return this.batch.available || this.browser.available; }
  get usingBatch(): boolean { return this.activeInput === this.batch; }
  get preference(): SttPreference { return this.pref; }
  get browserHealthy(): boolean { return this.deviceHealthy; }
  /** Source of the current / last-started recogniser (for the "Using … speech recognition" label). */
  get source(): SttSource | null { return this.activeInput === this.batch ? 'ENHANCED' : this.activeInput === this.browser ? 'DEVICE' : null; }
  setPreference(p: SttPreference): void { this.pref = p; this.deviceHealthy = true; }
  onSource(cb: (s: SttSource | null) => void): () => void { this.sourceListeners.add(cb); return () => { this.sourceListeners.delete(cb); }; }
  start(h: SpeechInputHandlers, o: { continuous: boolean; lang: string }): void {
    this.stop();
    const pick = chooseSttTransport({ continuous: o.continuous, preference: this.pref, batchAvailable: this.batch.available, browserAvailable: this.browser.available, browserHealthy: this.deviceHealthy });
    if (!pick) { h.onError(o.continuous ? 'CONVERSATION_MODE_UNSUPPORTED' : 'STT_UNAVAILABLE'); return; }
    this.activeInput = pick === 'BATCH' ? this.batch : this.browser;
    for (const cb of this.sourceListeners) cb(this.source);
    if (pick === 'BROWSER') {
      // device recognition failure → remember it so the NEXT tap uses enhanced recognition (no auto-resubmission of
      // anything; the user simply speaks again)
      const self = this;
      this.browser.start({ ...h, onError(code) { if (DEVICE_STT_BROKEN.has(code) && self.batch.available) self.deviceHealthy = false; h.onError(code); } }, o);
      return;
    }
    this.activeInput.start(h, o);
  }
  /** Release in tap-to-talk batch mode → submit; true when a batch recording was submitted. */
  finish(): boolean {
    if (this.activeInput === this.batch && this.batch.currentPhase === 'RECORDING') { void this.batch.finish(); return true; }
    return false;
  }
  stop(): void { const a = this.activeInput; this.activeInput = null; try { a?.stop(); } catch { /* ignore */ } }
}

/** Short user-facing text for an STT / mic failure code (never raw provider errors). */
export function sttErrorMessage(code: string | null | undefined): string | null {
  switch (code) {
    case 'STT_CONFIG_MISSING': return 'Server speech recognition configured nahi hai — kripya type karein.';
    case 'STT_AUDIO_INVALID': return 'Recording sahi nahi mili — dobara boliye ya type karein.';
    case 'STT_AUDIO_TOO_LARGE': return 'Recording bahut lambi hai — chhota bolkar dobara koshish karein.';
    case 'STT_PROVIDER_TIMEOUT': return 'Speech recognition ne time par jawab nahi diya — dobara boliye ya type karein.';
    case 'STT_PROVIDER_RATE_LIMIT': return 'Speech recognition abhi busy hai — thodi der baad boliye ya type karein.';
    case 'STT_PROVIDER_AUTH_ERROR':
    case 'STT_PROVIDER_UNAVAILABLE': return 'Speech recognition abhi uplabdh nahi hai — kripya type karein.';
    case 'STT_PROVIDER_BAD_RESPONSE': return 'Speech recognition ka jawab samajh nahi aaya — dobara boliye ya type karein.';
    case 'STT_STALE_TURN': return 'Purani recording chhod di gayi — dobara boliye.';
    case 'STT_NO_SPEECH': return 'Awaaz samajh nahi aayi — kripya dobara boliye.';
    case 'STT_SESSION_INVALID': return 'Session valid nahi hai — page refresh karein.';
    case 'MIC_PERMISSION_DENIED': return 'Microphone ki permission nahi mili — kripya type karein.';
    case 'CONVERSATION_MODE_UNSUPPORTED': return 'Hands-free mode is browser mein uplabdh nahi — tap karke boliye ya type karein.';
    case 'STT_UNAVAILABLE': case 'STT_START_FAILED': case 'STT_ERROR': return 'Voice input abhi uplabdh nahi — kripya type karein.';
    default: return null;
  }
}
