/**
 * Text-to-Speech providers (pluggable; Prompt 4 contract kept, Prompt 21 adds streaming + cancellation).
 * TTS is ONLY text → audio (Part 29): it never chooses trains, tools, fares or booking outcomes.
 * Phase 1 browser playback uses speechSynthesis (one utterance per streamed sentence, cancellable). Server-side
 * streaming TTS (ElevenLabs / Azure / Google …) plugs in behind StreamingTTSProvider — none enabled in this build.
 */
import type { SpeechOutput, SpeechPlayback } from '@shared/voice/conversational-voice-agent';

export interface TTSProvider {
  readonly providerId: string;
  init?(): Promise<void>;
  synthesize?(text: string, language: string): Promise<ArrayBuffer | null>;
}

/** Prompt 21 — sentence-streamed, cancellable speech output. */
export interface StreamingTTSProvider extends TTSProvider, SpeechOutput {
  readonly streaming: true;
}

export class BrowserTTSProvider implements TTSProvider {
  readonly providerId = 'browser-web-speech-tts';
}

/**
 * MockStreamingTTS — deterministic playback for tests. Each `speak` returns a playback that finishes only when the
 * test calls `finish()` (or immediately with `autoFinish`), so interruption mid-sentence is observable.
 */
export class MockStreamingTTS implements StreamingTTSProvider {
  readonly providerId = 'mock-streaming-tts';
  readonly streaming = true as const;
  available = true;
  autoFinish = false;
  failNext = 0;
  spoken: Array<{ text: string; turnId: string; status: 'PLAYING' | 'DONE' | 'CANCELLED' | 'FAILED' }> = [];
  private pending: Array<{ idx: number; resolve: () => void; reject: (e: any) => void }> = [];

  speak(text: string, o: { lang: string; turnId: string }): SpeechPlayback {
    const idx = this.spoken.push({ text, turnId: o.turnId, status: 'PLAYING' }) - 1;
    if (this.failNext > 0) { this.failNext--; this.spoken[idx].status = 'FAILED'; return { done: Promise.reject(new Error('TTS_FAILED')), cancel() { /* noop */ } }; }
    let resolve!: () => void, reject!: (e: any) => void;
    const done = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    done.catch(() => undefined);
    this.pending.push({ idx, resolve, reject });
    if (this.autoFinish) queueMicrotask(() => this.finish());
    return {
      done,
      started: Promise.resolve(),
      cancel: () => {
        if (this.spoken[idx].status === 'PLAYING') this.spoken[idx].status = 'CANCELLED';
        this.pending = this.pending.filter(p => p.idx !== idx);
      }
    };
  }
  /** Finish the oldest playing utterance. */
  finish(): void {
    const p = this.pending.shift();
    if (!p) return;
    if (this.spoken[p.idx].status === 'PLAYING') this.spoken[p.idx].status = 'DONE';
    p.resolve();
  }
  get playing(): string | null { const p = this.pending[0]; return p ? this.spoken[p.idx].text : null; }
}
