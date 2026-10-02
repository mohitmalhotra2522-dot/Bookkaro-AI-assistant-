export interface STTResult {
  transcript: string;
  confidence?: number;
  isFinal: boolean;
  error?: string;
}

/**
 * Pluggable Speech-to-Text provider interface.
 * Implementations: BrowserSTTProvider (initial), Whisper, Google STT, Azure STT (future).
 */
export interface STTProvider {
  readonly providerId: string;
  init?(): Promise<void>;
  transcribe?(audioData: ArrayBuffer | Blob, language: string): Promise<STTResult>;
}

export class BrowserSTTProvider implements STTProvider {
  readonly providerId = 'browser-web-speech-stt';
}
