/**
 * PROMPT 21 — browser adapters for the shared ConversationalVoiceAgent.
 *  - BrowserSpeechInput: Web Speech recognition (interim partials + finals + speech activity). Started ONLY by an
 *    explicit user action. Continuous only in the opt-in conversation mode (auto-restarts while that mode is on,
 *    because browsers end recognition after silence); one tap stops it.
 *  - BrowserSpeechOutput: speechSynthesis, one utterance per streamed sentence, cancellable immediately (barge-in).
 * TTS is text → audio only. Failures surface as errors → the agent falls back to text (typing always works).
 */
import type { SpeechInput, SpeechInputHandlers, SpeechOutput, SpeechPlayback } from '@shared/voice/conversational-voice-agent';
import { renderForSpeech } from '@shared/voice/speech-renderer';

export class BrowserSpeechInput implements SpeechInput {
  private rec: any = null;
  private active = false;
  private continuous = false;
  get available(): boolean {
    return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }
  start(h: SpeechInputHandlers, o: { continuous: boolean; lang: string }): void {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { h.onError('STT_UNAVAILABLE'); return; }
    this.stop();
    const rec = new SR();
    rec.continuous = o.continuous;
    rec.interimResults = true;
    rec.lang = o.lang || 'hi-IN';
    this.continuous = o.continuous;
    this.active = true;
    rec.onspeechstart = () => h.onSpeechStart();
    rec.onspeechend = () => h.onSpeechEnd();
    rec.onresult = (event: any) => {
      for (let i = event.resultIndex ?? 0; i < event.results.length; i++) {
        const r = event.results[i];
        const t = String(r[0]?.transcript || '').trim();
        if (!t) continue;
        // Prompt 34 (§2): recogniser metadata — confidence (0 = not reported) + language of this recognition session
        const meta = { confidence: typeof r[0]?.confidence === 'number' ? r[0].confidence : undefined, language: rec.lang };
        if (r.isFinal) h.onFinal(t, meta); else h.onPartial(t, meta);
      }
    };
    rec.onerror = (e: any) => {
      const code = String(e?.error || 'STT_ERROR');
      if (code === 'no-speech' || code === 'aborted') return;     // silence / our own stop — not a failure
      this.active = false;
      h.onError(code === 'not-allowed' ? 'MIC_PERMISSION_DENIED' : 'STT_ERROR');
    };
    rec.onend = () => {
      // conversation mode: keep the user-started session open (browsers stop after a pause)
      if (this.active && this.continuous) { try { rec.start(); return; } catch { /* fall through */ } }
      this.active = false;
    };
    this.rec = rec;
    try { rec.start(); } catch { this.active = false; h.onError('STT_START_FAILED'); }
  }
  stop(): void {
    this.active = false;
    const r = this.rec;
    this.rec = null;
    if (r) { try { r.onend = null; r.stop(); } catch { /* ignore */ } }
  }
}

export class BrowserSpeechOutput implements SpeechOutput {
  get available(): boolean { return typeof window !== 'undefined' && 'speechSynthesis' in window; }
  /** P36-C.1.1: the exact text last handed to the speech engine (after pronunciation rendering) — for tests/inspection. */
  lastSpoken: string | null = null;
  speak(text: string, o: { lang: string }): SpeechPlayback {
    // P36-C.1.1: pronunciation-only rendering of the validated text (same facts; never speaks ids / URLs / JSON /
    // stack traces / provider names / credentials). Nothing speakable → nothing is spoken.
    const spoken = renderForSpeech(text);
    this.lastSpoken = spoken;
    if (!spoken) return { done: Promise.resolve(), started: Promise.resolve(), cancel: () => undefined };
    let settle: { res: () => void; rej: (e: any) => void } | null = null;
    const done = new Promise<void>((res, rej) => { settle = { res, rej }; });
    done.catch(() => undefined);
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((res) => { markStarted = res; });
    let cancelled = false;
    try {
      const u = new SpeechSynthesisUtterance(spoken);
      u.lang = o.lang || 'hi-IN';
      u.rate = 1.05;
      u.onstart = () => markStarted();
      u.onend = () => { markStarted(); settle?.res(); };
      u.onerror = (e: any) => { if (cancelled || e?.error === 'interrupted' || e?.error === 'canceled') settle?.res(); else settle?.rej(new Error('TTS_FAILED')); };
      window.speechSynthesis.speak(u);
    } catch { settle!.rej(new Error('TTS_FAILED')); }
    return { done, started, cancel: () => { cancelled = true; try { window.speechSynthesis.cancel(); } catch { /* ignore */ } settle?.res(); } };
  }
}
