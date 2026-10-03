/**
 * Speech-to-Text providers (pluggable; Prompt 4 contract kept, Prompt 21 adds streaming).
 * Phase 1: the browser Web Speech API produces the transcript (tap-to-talk / opt-in conversation mode, explicit
 * user activation only). Server-side streaming STT (Whisper / Google / Azure …) plugs in behind StreamingSTTProvider
 * with server-side keys only — none is enabled in this build.
 */
import type { SpeechInput, SpeechInputHandlers } from '@shared/voice/conversational-voice-agent';

export interface STTResult {
  transcript: string;
  confidence?: number;
  isFinal: boolean;
  error?: string;
}

export interface STTProvider {
  readonly providerId: string;
  init?(): Promise<void>;
  transcribe?(audioData: ArrayBuffer | Blob, language: string): Promise<STTResult>;
}

/** Prompt 21 — streaming recogniser: partial + final transcripts and speech-activity signals. */
export interface StreamingSTTProvider extends STTProvider {
  readonly streaming: true;
  createSession(): SpeechInput;
}

export class BrowserSTTProvider implements STTProvider {
  readonly providerId = 'browser-web-speech-stt';
}

/** One scripted STT step for deterministic tests / dev fixtures. */
export type MockSTTStep =
  | { kind: 'speechStart' } | { kind: 'speechEnd' }
  | { kind: 'partial'; text: string } | { kind: 'final'; text: string } | { kind: 'error'; code: string };

/**
 * MockStreamingSTT — deterministic streaming recogniser (no microphone). Tests push steps; the agent receives them
 * exactly like Web Speech callbacks. `startCount` proves the mic is only opened by explicit agent calls.
 */
export class MockStreamingSTT implements StreamingSTTProvider, SpeechInput {
  readonly providerId = 'mock-streaming-stt';
  readonly streaming = true as const;
  available = true;
  active = false;
  continuous = false;
  startCount = 0;
  private h: SpeechInputHandlers | null = null;
  createSession(): SpeechInput { return this; }
  start(h: SpeechInputHandlers, o: { continuous: boolean }): void { this.h = h; this.active = true; this.continuous = o.continuous; this.startCount++; }
  stop(): void { this.active = false; }
  /** Deliver steps (ignored while the mic is closed — no hidden recording). */
  push(...steps: MockSTTStep[]): void {
    for (const st of steps) {
      if (!this.active || !this.h) return;
      if (st.kind === 'speechStart') this.h.onSpeechStart();
      else if (st.kind === 'speechEnd') this.h.onSpeechEnd();
      else if (st.kind === 'partial') this.h.onPartial(st.text);
      else if (st.kind === 'final') this.h.onFinal(st.text);
      else this.h.onError(st.code);
    }
  }
}
