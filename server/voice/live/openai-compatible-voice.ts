/**
 * Prompt 35 — server-side live STT / TTS behind the EXISTING STTProvider / TTSProvider contracts.
 *
 * Pipeline (unchanged, no second brain):  audio → STT.transcribe → /api/chat mode=VOICE (same ConversationTurnEngine,
 * same agent / tools / guards / session) → final validated response → TTS.synthesize(that text).
 * TTS never chooses words: /api/voice/speak reads the session's latest validated assistant response server-side.
 *
 * Wire format: OpenAI-compatible audio API (documented, widely implemented):
 *   STT  POST {VOICE_STT_BASE_URL}/audio/transcriptions   multipart: file, model, language?, response_format=json → { text }
 *   TTS  POST {VOICE_TTS_BASE_URL}/audio/speech           json: { model, input, voice, response_format } → audio bytes
 *
 * Env (keys never logged / returned / sent to the LLM / to the browser):
 *   VOICE_STT_PROVIDER=openai_compatible  VOICE_STT_BASE_URL  VOICE_STT_MODEL  VOICE_STT_API_KEY  VOICE_STT_TIMEOUT_MS
 *   VOICE_TTS_PROVIDER=openai_compatible  VOICE_TTS_BASE_URL  VOICE_TTS_MODEL  VOICE_TTS_VOICE  VOICE_TTS_API_KEY  VOICE_TTS_TIMEOUT_MS
 * Default: not configured → the browser Web Speech path (P21/P34) stays the voice transport; endpoints answer 503.
 */
import type { STTProvider, STTResult } from '../stt/stt-provider';
import type { TTSProvider } from '../tts/tts-provider';
import { batchSttConfigView, type ElevenLabsBatchSTT } from '../stt/elevenlabs-batch-stt';

type Env = NodeJS.ProcessEnv;
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_TTS_CHARS = 1200;

export class VoiceProviderError extends Error {
  constructor(readonly code: 'VOICE_NOT_CONFIGURED' | 'VOICE_TIMEOUT' | 'VOICE_PROVIDER_FAILURE' | 'VOICE_BAD_AUDIO' | 'VOICE_EMPTY_TRANSCRIPT', message: string, readonly httpStatus?: number) { super(message); }
}

interface Cfg { baseUrl?: string; model?: string; apiKey?: string; timeoutMs?: number; fetchImpl?: typeof fetch }

async function timed<T>(ms: number, f: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await f(ctl.signal); }
  catch (e: any) { if (e?.name === 'AbortError') throw new VoiceProviderError('VOICE_TIMEOUT', 'Voice provider ne time par jawab nahi diya.'); throw e; }
  finally { clearTimeout(t); }
}

export class OpenAICompatibleSTT implements STTProvider {
  readonly providerId = 'openai-compatible-stt';
  constructor(private readonly cfg: Cfg) {}
  configured(): boolean { return !!(this.cfg.baseUrl && this.cfg.model && this.cfg.apiKey); }
  async transcribe(audio: ArrayBuffer | Blob, language: string, mimeType = 'audio/webm'): Promise<STTResult> {
    if (!this.configured()) throw new VoiceProviderError('VOICE_NOT_CONFIGURED', 'Server STT configured nahi hai.');
    const blob = audio instanceof Blob ? audio : new Blob([audio], { type: mimeType });
    if (!blob.size || blob.size > MAX_AUDIO_BYTES) throw new VoiceProviderError('VOICE_BAD_AUDIO', 'Audio khaali hai ya bahut bada hai.');
    const form = new FormData();
    form.append('file', blob, `speech.${(mimeType.split('/')[1] || 'webm').split(';')[0]}`);
    form.append('model', String(this.cfg.model));
    form.append('response_format', 'json');
    const lang = (language || '').slice(0, 2).toLowerCase();
    if (/^[a-z]{2}$/.test(lang)) form.append('language', lang);
    const res = await timed(this.cfg.timeoutMs ?? 15000, signal => (this.cfg.fetchImpl || fetch)(`${String(this.cfg.baseUrl).replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST', signal, headers: { Authorization: `Bearer ${this.cfg.apiKey}` }, body: form
    }));
    if (!res.ok) throw new VoiceProviderError('VOICE_PROVIDER_FAILURE', 'Speech recognition abhi uplabdh nahi hai.', res.status);
    let body: any; try { body = await res.json(); } catch { throw new VoiceProviderError('VOICE_PROVIDER_FAILURE', 'Speech recognition ka jawab sahi format mein nahi tha.', res.status); }
    const transcript = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
    if (!transcript) throw new VoiceProviderError('VOICE_EMPTY_TRANSCRIPT', 'Awaaz samajh nahi aayi — kripya dobara boliye.');
    return { transcript, isFinal: true, ...(typeof body?.language === 'string' ? { language: body.language } : lang ? { language: lang } : {}) };
  }
}

export class OpenAICompatibleTTS implements TTSProvider {
  readonly providerId = 'openai-compatible-tts';
  constructor(private readonly cfg: Cfg & { voice?: string; format?: 'mp3' | 'wav' | 'opus' }) {}
  configured(): boolean { return !!(this.cfg.baseUrl && this.cfg.model && this.cfg.apiKey); }
  get mimeType(): string { return this.cfg.format === 'wav' ? 'audio/wav' : this.cfg.format === 'opus' ? 'audio/ogg' : 'audio/mpeg'; }
  async synthesize(text: string, _language: string): Promise<ArrayBuffer | null> {
    if (!this.configured()) throw new VoiceProviderError('VOICE_NOT_CONFIGURED', 'Server TTS configured nahi hai.');
    const input = String(text || '').trim().slice(0, MAX_TTS_CHARS);
    if (!input) return null;
    const res = await timed(this.cfg.timeoutMs ?? 15000, signal => (this.cfg.fetchImpl || fetch)(`${String(this.cfg.baseUrl).replace(/\/$/, '')}/audio/speech`, {
      method: 'POST', signal, headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.cfg.model, input, voice: this.cfg.voice || 'alloy', response_format: this.cfg.format || 'mp3' })
    }));
    if (!res.ok) throw new VoiceProviderError('VOICE_PROVIDER_FAILURE', 'Voice playback abhi uplabdh nahi hai.', res.status);
    const buf = await res.arrayBuffer();
    if (!buf.byteLength) throw new VoiceProviderError('VOICE_PROVIDER_FAILURE', 'Voice playback ka jawab khaali tha.', res.status);
    return buf;
  }
}

const isOAI = (v: string | undefined) => ['openai_compatible', 'openai-compatible', 'openai'].includes(String(v || '').toLowerCase());
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

export function createServerSTT(env: Env = process.env, fetchImpl?: typeof fetch): OpenAICompatibleSTT | null {
  if (!isOAI(env.VOICE_STT_PROVIDER)) return null;
  return new OpenAICompatibleSTT({ baseUrl: env.VOICE_STT_BASE_URL, model: env.VOICE_STT_MODEL, apiKey: env.VOICE_STT_API_KEY, timeoutMs: num(env.VOICE_STT_TIMEOUT_MS, 15000), fetchImpl });
}
export function createServerTTS(env: Env = process.env, fetchImpl?: typeof fetch): OpenAICompatibleTTS | null {
  if (!isOAI(env.VOICE_TTS_PROVIDER)) return null;
  const f = String(env.VOICE_TTS_FORMAT || 'mp3').toLowerCase();
  return new OpenAICompatibleTTS({ baseUrl: env.VOICE_TTS_BASE_URL, model: env.VOICE_TTS_MODEL, apiKey: env.VOICE_TTS_API_KEY, voice: env.VOICE_TTS_VOICE, format: f === 'wav' || f === 'opus' ? f : 'mp3', timeoutMs: num(env.VOICE_TTS_TIMEOUT_MS, 15000), fetchImpl });
}

/** Health view — provider / model / configured only (never keys, never base URLs with credentials). */
export function voiceProviderStatus(env: Env = process.env, batchStt?: ElevenLabsBatchSTT | null) {
  const stt = createServerSTT(env), tts = createServerTTS(env);
  return {
    transport: 'browser-web-speech (default) + optional server STT/TTS',
    // P36-C: tap-to-talk batch STT — config presence only (no provider call, never the key)
    batchStt: (({ enabled, provider, model, mode, keytermsEnabled }) => ({ configured: enabled, provider, model, mode, keytermsEnabled }))(batchSttConfigView(batchStt)),
    stt: { provider: stt ? 'OPENAI_COMPATIBLE' : 'BROWSER', model: stt ? env.VOICE_STT_MODEL || null : null, configured: !!stt?.configured() },
    tts: { provider: tts ? 'OPENAI_COMPATIBLE' : 'BROWSER', model: tts ? env.VOICE_TTS_MODEL || null : null, voice: tts ? env.VOICE_TTS_VOICE || 'alloy' : null, configured: !!tts?.configured() }
  };
}

/** Decode a bounded base64 audio payload (JSON transport; no multipart parser dependency). */
export function decodeAudioBase64(b64: unknown): Uint8Array<ArrayBuffer> {
  if (typeof b64 !== 'string' || !b64) throw new VoiceProviderError('VOICE_BAD_AUDIO', 'Audio missing hai.');
  const clean = b64.replace(/^data:[^;,]+;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(clean) || clean.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 + 8) throw new VoiceProviderError('VOICE_BAD_AUDIO', 'Audio khaali hai ya bahut bada hai.');
  const buf = Buffer.from(clean, 'base64');
  if (!buf.length) throw new VoiceProviderError('VOICE_BAD_AUDIO', 'Audio khaali hai.');
  const out = new Uint8Array(new ArrayBuffer(buf.length)); out.set(buf); return out;
}
