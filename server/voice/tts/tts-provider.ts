/**
 * Pluggable Text-to-Speech provider interface.
 * Implementations: BrowserTTSProvider (initial), ElevenLabs, Azure TTS, Google TTS (future).
 */
export interface TTSProvider {
  readonly providerId: string;
  init?(): Promise<void>;
  synthesize?(text: string, language: string): Promise<ArrayBuffer | null>;
}

export class BrowserTTSProvider implements TTSProvider {
  readonly providerId = 'browser-web-speech-tts';
}
