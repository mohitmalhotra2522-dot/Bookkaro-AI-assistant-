/**
 * PROMPT P36-C — ElevenLabs Scribe v2 BATCH speech-to-text, behind the existing STTProvider contract.
 *
 *   tap-to-talk recording (browser) → POST /api/voice/transcribe → ElevenLabsBatchSTT.transcribe (this file)
 *   → FINAL transcript text → back to the browser's EXISTING ConversationalVoiceAgent → VoiceTurnDetector →
 *   normalizeTranscript → /api/chat (mode VOICE) → the SAME LLM agent / tools / validation / TTS as typed text.
 *
 * STT is transcription ONLY: it never decides intent, never calls a railway tool, never touches booking state, never
 * converts terms ("AC" stays whatever Scribe returned — no manual AC→एसी mapping), and its confidence / logprob is
 * never used as authorization. STT output is never railway truth.
 *
 * Request lock (validated by P36-B.5 / P36-B.6 — recommended condition B "railway keyterms"):
 *   POST https://api.elevenlabs.io/v1/speech-to-text   header xi-api-key   multipart/form-data
 *   model_id=scribe_v2 · language_code=hin · keyterms=AC,3A,CC,SL,RAC,WL (repeated multipart fields)
 *   tag_audio_events=false · timestamps_granularity=word · diarize=false · file_format=pcm_s16le_16 (16 kHz mono PCM)
 * No realtime / WebSocket model, no fallback model, no translation, no SDK (plain fetch + FormData).
 * The client can change NONE of these — they are server constants.
 *
 * Secret: ELEVENLABS_API_KEY from the server environment only. It is never logged, returned, put in an error, a URL,
 * the LLM context or the browser bundle. A missing key is not a crash: the provider reports not-configured and the
 * existing browser speech path stays the voice fallback.
 *
 * Audio is processed in memory only (no temp files, no persistence) and never logged.
 */
import type { STTProvider, STTResult } from './stt-provider';

type Env = NodeJS.ProcessEnv;

export const ELEVENLABS_STT_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';
export const ELEVENLABS_STT_MODEL = 'scribe_v2' as const;
export const ELEVENLABS_STT_LANGUAGE = 'hin' as const;
/** P36-B.6 condition B (railway set). Centralized here; the client can never add, remove or replace terms. */
export const ELEVENLABS_STT_KEYTERMS: readonly string[] = Object.freeze(['AC', '3A', 'CC', 'SL', 'RAC', 'WL']);
/** The complete, frozen request (besides `file` / `file_format`). */
export const ELEVENLABS_STT_REQUEST = Object.freeze({
  endpoint: ELEVENLABS_STT_ENDPOINT,
  model_id: ELEVENLABS_STT_MODEL,
  language_code: ELEVENLABS_STT_LANGUAGE,
  keyterms: ELEVENLABS_STT_KEYTERMS,
  tag_audio_events: 'false',
  timestamps_granularity: 'word',
  diarize: 'false'
});

/** Raw 16-bit little-endian PCM, 16 kHz, mono (the validated benchmark format). */
export const PCM_MIME = 'audio/pcm';
export const PCM_SAMPLE_RATE = 16000;
const PCM_BYTES_PER_SEC = PCM_SAMPLE_RATE * 2;
/** Bounded tap-to-talk turn. 60 s of PCM16@16k = 1.92 MB. */
export const MAX_STT_AUDIO_MS = 60_000;
export const MIN_STT_AUDIO_MS = 250;
export const MAX_STT_AUDIO_BYTES = 2 * 1024 * 1024;
/** Encoded containers accepted as a fallback (Scribe auto-detects them; no file_format sent). */
const ENCODED_MIME = /^audio\/(webm|ogg|wav|x-wav|wave|mp4|mpeg|aac)(;\s*codecs=[a-z0-9.,-]+)?$/i;

export type SttErrorCode =
  | 'STT_CONFIG_MISSING' | 'STT_AUDIO_INVALID' | 'STT_AUDIO_TOO_LARGE' | 'STT_PROVIDER_TIMEOUT' | 'STT_PROVIDER_AUTH_ERROR'
  | 'STT_PROVIDER_RATE_LIMIT' | 'STT_PROVIDER_UNAVAILABLE' | 'STT_PROVIDER_BAD_RESPONSE' | 'STT_STALE_TURN'
  // additive (P36-C): silence / nothing intelligible, and a turn for a session this server does not know
  | 'STT_NO_SPEECH' | 'STT_SESSION_INVALID';

/** Short, truthful user-facing messages (Hinglish). Never contain provider bodies, keys or URLs. */
export const STT_ERROR_MESSAGES: Readonly<Record<SttErrorCode, string>> = Object.freeze({
  STT_CONFIG_MISSING: 'Server speech recognition configured nahi hai — browser mic ya typing use karein.',
  STT_AUDIO_INVALID: 'Recording sahi nahi mili — kripya dobara boliye ya type karein.',
  STT_AUDIO_TOO_LARGE: 'Recording bahut lambi hai — chhota bolkar dobara koshish karein.',
  STT_PROVIDER_TIMEOUT: 'Speech recognition ne time par jawab nahi diya — dobara boliye ya type karein.',
  STT_PROVIDER_AUTH_ERROR: 'Speech recognition abhi uplabdh nahi hai — kripya type karein.',
  STT_PROVIDER_RATE_LIMIT: 'Speech recognition abhi busy hai — thodi der baad boliye ya type karein.',
  STT_PROVIDER_UNAVAILABLE: 'Speech recognition abhi uplabdh nahi hai — kripya type karein.',
  STT_PROVIDER_BAD_RESPONSE: 'Speech recognition ka jawab samajh nahi aaya — dobara boliye ya type karein.',
  STT_STALE_TURN: 'Yeh recording ab latest nahi thi — use chhod diya gaya.',
  STT_NO_SPEECH: 'Awaaz samajh nahi aayi — kripya dobara boliye.',
  STT_SESSION_INVALID: 'Session valid nahi hai — page refresh karke dobara koshish karein.'
});

export const STT_HTTP_STATUS: Readonly<Record<SttErrorCode, number>> = Object.freeze({
  STT_CONFIG_MISSING: 503, STT_AUDIO_INVALID: 400, STT_AUDIO_TOO_LARGE: 413, STT_PROVIDER_TIMEOUT: 504,
  STT_PROVIDER_AUTH_ERROR: 502, STT_PROVIDER_RATE_LIMIT: 503, STT_PROVIDER_UNAVAILABLE: 502, STT_PROVIDER_BAD_RESPONSE: 502,
  STT_STALE_TURN: 409, STT_NO_SPEECH: 422, STT_SESSION_INVALID: 403
});

export class SttError extends Error {
  /** Provider HTTP status (observability only — never shown to the user). */
  constructor(readonly code: SttErrorCode, readonly providerStatus?: number) {
    super(STT_ERROR_MESSAGES[code]);
    this.name = 'SttError';
  }
}

export interface ValidatedAudio {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
  /** 'pcm_s16le_16' for raw PCM; null for an encoded container (provider auto-detects). */
  fileFormat: 'pcm_s16le_16' | null;
  durationMs: number;
}

/**
 * Validate + decode a JSON-transported (base64) recording. Checks: present, base64-shaped, non-empty, size bound,
 * allowed content type, duration bounds, PCM framing, and not digital silence. Never logs the audio.
 */
export function validateSttAudio(input: { audioBase64: unknown; mimeType: unknown; durationMs?: unknown; sampleRate?: unknown }): ValidatedAudio {
  const b64 = input.audioBase64;
  if (typeof b64 !== 'string' || !b64) throw new SttError('STT_AUDIO_INVALID');
  const clean = b64.replace(/^data:[^;,]+;base64,/, '');
  if (clean.length > Math.ceil(MAX_STT_AUDIO_BYTES / 3) * 4 + 8) throw new SttError('STT_AUDIO_TOO_LARGE');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(clean)) throw new SttError('STT_AUDIO_INVALID');
  const buf = Buffer.from(clean, 'base64');
  if (!buf.length) throw new SttError('STT_AUDIO_INVALID');
  if (buf.length > MAX_STT_AUDIO_BYTES) throw new SttError('STT_AUDIO_TOO_LARGE');
  const bytes = new Uint8Array(new ArrayBuffer(buf.length)); bytes.set(buf);
  const mime = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';

  if (mime === PCM_MIME || mime === 'audio/l16' || mime.startsWith('audio/pcm;') || mime.startsWith('audio/l16;')) {
    if (input.sampleRate !== undefined && input.sampleRate !== PCM_SAMPLE_RATE) throw new SttError('STT_AUDIO_INVALID');
    if (bytes.length % 2 !== 0) throw new SttError('STT_AUDIO_INVALID');
    const durationMs = Math.round((bytes.length / PCM_BYTES_PER_SEC) * 1000);
    if (durationMs < MIN_STT_AUDIO_MS) throw new SttError('STT_AUDIO_INVALID');
    if (durationMs > MAX_STT_AUDIO_MS) throw new SttError('STT_AUDIO_TOO_LARGE');
    // digital silence (all samples ≈ 0) → nothing to transcribe; no paid call
    const view = new DataView(bytes.buffer);
    let peak = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) { const s = Math.abs(view.getInt16(i, true)); if (s > peak) { peak = s; if (peak >= 64) break; } }
    if (peak < 64) throw new SttError('STT_NO_SPEECH');
    return { bytes, mimeType: PCM_MIME, fileFormat: 'pcm_s16le_16', durationMs };
  }

  if (ENCODED_MIME.test(mime)) {
    if (!hasContainerSignature(bytes, mime)) throw new SttError('STT_AUDIO_INVALID');
    const d = typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : NaN;
    if (!Number.isFinite(d) || d < MIN_STT_AUDIO_MS) throw new SttError('STT_AUDIO_INVALID');
    if (d > MAX_STT_AUDIO_MS) throw new SttError('STT_AUDIO_TOO_LARGE');
    return { bytes, mimeType: mime.split(';')[0], fileFormat: null, durationMs: d };
  }
  throw new SttError('STT_AUDIO_INVALID');
}

function hasContainerSignature(b: Uint8Array, mime: string): boolean {
  const at = (o: number, s: string) => s.split('').every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length < 12) return false;
  if (/webm/.test(mime)) return b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
  if (/ogg/.test(mime)) return at(0, 'OggS');
  if (/wav|wave/.test(mime)) return at(0, 'RIFF') && at(8, 'WAVE');
  if (/mp4|aac/.test(mime)) return at(4, 'ftyp') || (b[0] === 0xff && (b[1] & 0xf0) === 0xf0);
  if (/mpeg/.test(mime)) return at(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  return false;
}

export interface ElevenLabsSttConfig {
  apiKey?: string;
  /** Per-attempt timeout (bounded). */
  timeoutMs?: number;
  /** Delay before the single retry. */
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Explicit kill switch (ELEVENLABS_STT_ENABLED=false). */
  disabled?: boolean;
}

export interface BatchTranscribeOptions {
  /** Caller-side cancellation (client disconnected / turn superseded) → STT_STALE_TURN, never retried. */
  signal?: AbortSignal;
}

export interface BatchSttResult extends STTResult { attempts: number; latencyMs: number; audioDurationSecs: number | null }

export const MAX_STT_ATTEMPTS = 2;           // the first try + at most ONE retry on a transient failure
export const DEFAULT_STT_TIMEOUT_MS = 8000;
const clampTimeout = (n: number) => Math.min(20_000, Math.max(1000, n));

export class ElevenLabsBatchSTT implements STTProvider {
  readonly providerId = 'elevenlabs-scribe-v2-batch';
  readonly provider = 'elevenlabs' as const;
  readonly model = ELEVENLABS_STT_MODEL;
  readonly mode = 'batch' as const;
  readonly keytermsEnabled = ELEVENLABS_STT_KEYTERMS.length > 0;
  readonly timeoutMs: number;
  constructor(private readonly cfg: ElevenLabsSttConfig) {
    this.timeoutMs = clampTimeout(cfg.timeoutMs ?? DEFAULT_STT_TIMEOUT_MS);
  }

  configured(): boolean { return !this.cfg.disabled && typeof this.cfg.apiKey === 'string' && this.cfg.apiKey.trim().length > 0; }

  /** Build the frozen multipart request. `language` / keyterms from callers are ignored by design (server lock). */
  buildForm(audio: ValidatedAudio): FormData {
    const form = new FormData();
    form.append('model_id', ELEVENLABS_STT_REQUEST.model_id);
    form.append('language_code', ELEVENLABS_STT_REQUEST.language_code);
    for (const k of ELEVENLABS_STT_REQUEST.keyterms) form.append('keyterms', k);   // repeated fields (official SDK wire format)
    form.append('tag_audio_events', ELEVENLABS_STT_REQUEST.tag_audio_events);
    form.append('timestamps_granularity', ELEVENLABS_STT_REQUEST.timestamps_granularity);
    form.append('diarize', ELEVENLABS_STT_REQUEST.diarize);
    if (audio.fileFormat) form.append('file_format', audio.fileFormat);
    const ext = audio.fileFormat ? 'pcm' : (audio.mimeType.split('/')[1] || 'bin').replace(/^x-/, '');
    form.append('file', new Blob([audio.bytes], { type: audio.fileFormat ? 'application/octet-stream' : audio.mimeType }), `speech.${ext}`);
    return form;
  }

  /** STTProvider contract. The `language` argument is ignored: language_code is locked to "hin". */
  async transcribe(audio: ValidatedAudio | ArrayBuffer | Blob, _language?: string, opts: BatchTranscribeOptions = {}): Promise<BatchSttResult> {
    if (!this.configured()) throw new SttError('STT_CONFIG_MISSING');
    if (!isValidated(audio)) throw new SttError('STT_AUDIO_INVALID');     // raw buffers must go through validateSttAudio
    const t0 = Date.now();
    const sleep = this.cfg.sleep || ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    let last: SttError = new SttError('STT_PROVIDER_UNAVAILABLE');
    for (let attempt = 1; attempt <= MAX_STT_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) throw new SttError('STT_STALE_TURN');
      try {
        const r = await this.once(audio, opts.signal);
        return { ...r, attempts: attempt, latencyMs: Date.now() - t0 };
      } catch (e) {
        const err = e instanceof SttError ? e : new SttError('STT_PROVIDER_UNAVAILABLE');
        last = err;
        if (!isTransient(err) || attempt === MAX_STT_ATTEMPTS || opts.signal?.aborted) break;
        await sleep(this.cfg.retryDelayMs ?? 300);
      }
    }
    if (opts.signal?.aborted) throw new SttError('STT_STALE_TURN');
    throw last;
  }

  private async once(audio: ValidatedAudio, outer?: AbortSignal): Promise<Omit<BatchSttResult, 'attempts' | 'latencyMs'>> {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, this.timeoutMs);
    const onOuter = () => ctl.abort();
    outer?.addEventListener('abort', onOuter, { once: true });
    let res: Response;
    try {
      res = await (this.cfg.fetchImpl || fetch)(ELEVENLABS_STT_ENDPOINT, {
        method: 'POST', signal: ctl.signal, headers: { 'xi-api-key': String(this.cfg.apiKey) }, body: this.buildForm(audio)
      });
    } catch {
      // never surface the raw error (it may echo request details)
      if (outer?.aborted) throw new SttError('STT_STALE_TURN');
      throw new SttError(timedOut ? 'STT_PROVIDER_TIMEOUT' : 'STT_PROVIDER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuter);
    }
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* body discarded unread — provider error text is never forwarded */ }
      throw new SttError(classifyStatus(res.status), res.status);
    }
    let body: any;
    try { body = await res.json(); } catch { throw new SttError('STT_PROVIDER_BAD_RESPONSE', res.status); }
    return parseScribeResponse(body);
  }
}

/** Strict response check: a single-channel Scribe result with a string `text`. Anything else is rejected. */
export function parseScribeResponse(body: unknown): Omit<BatchSttResult, 'attempts' | 'latencyMs'> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SttError('STT_PROVIDER_BAD_RESPONSE');
  const b = body as Record<string, unknown>;
  if (typeof b.text !== 'string') throw new SttError('STT_PROVIDER_BAD_RESPONSE');
  if (b.language_code !== undefined && b.language_code !== null && typeof b.language_code !== 'string') throw new SttError('STT_PROVIDER_BAD_RESPONSE');
  // whitespace only — the words themselves are passed through unchanged (no term conversion here)
  const transcript = b.text.replace(/\s+/g, ' ').trim();
  if (!transcript) throw new SttError('STT_NO_SPEECH');
  if (transcript.length > 2000) throw new SttError('STT_PROVIDER_BAD_RESPONSE');
  const lang = typeof b.language_code === 'string' && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(b.language_code) ? b.language_code : ELEVENLABS_STT_LANGUAGE;
  const dur = typeof b.audio_duration_secs === 'number' && Number.isFinite(b.audio_duration_secs) ? b.audio_duration_secs : null;
  // NOTE: words[].logprob / language_probability are deliberately ignored — confidence is never authorization.
  return { transcript, isFinal: true, language: lang, audioDurationSecs: dur };
}

function isValidated(a: unknown): a is ValidatedAudio {
  return !!a && typeof a === 'object' && (a as any).bytes instanceof Uint8Array && typeof (a as any).mimeType === 'string' && typeof (a as any).durationMs === 'number';
}

export function classifyStatus(status: number): SttErrorCode {
  if (status === 401 || status === 403) return 'STT_PROVIDER_AUTH_ERROR';
  if (status === 429) return 'STT_PROVIDER_RATE_LIMIT';
  if (status === 408 || status === 504) return 'STT_PROVIDER_TIMEOUT';
  if (status === 413) return 'STT_AUDIO_TOO_LARGE';
  if (status === 400 || status === 415 || status === 422) return 'STT_AUDIO_INVALID';
  return 'STT_PROVIDER_UNAVAILABLE';
}

/** Transient = worth ONE retry: timeout, network / 5xx unavailability, rate limit. */
export function isTransient(e: SttError): boolean {
  if (e.code === 'STT_PROVIDER_TIMEOUT' || e.code === 'STT_PROVIDER_RATE_LIMIT') return true;
  if (e.code === 'STT_PROVIDER_UNAVAILABLE') return e.providerStatus === undefined || e.providerStatus >= 500;
  return false;
}

/** Factory from the server environment. Returns a provider even without a key (configured() = false → 503 + fallback). */
export function createElevenLabsBatchSTT(env: Env = process.env, fetchImpl?: typeof fetch): ElevenLabsBatchSTT {
  const n = Number(env.ELEVENLABS_STT_TIMEOUT_MS);
  return new ElevenLabsBatchSTT({
    apiKey: env.ELEVENLABS_API_KEY,
    timeoutMs: Number.isFinite(n) && n > 0 ? n : DEFAULT_STT_TIMEOUT_MS,
    disabled: String(env.ELEVENLABS_STT_ENABLED || '').toLowerCase() === 'false',
    fetchImpl
  });
}

/** Safe client / health view — config presence only (never the key, never a paid call). */
export function batchSttConfigView(stt: ElevenLabsBatchSTT | null | undefined) {
  return {
    enabled: !!stt?.configured(),
    provider: 'elevenlabs' as const,
    model: ELEVENLABS_STT_MODEL,
    mode: 'batch' as const,
    keytermsEnabled: ELEVENLABS_STT_KEYTERMS.length > 0,
    audio: { mimeType: PCM_MIME, sampleRate: PCM_SAMPLE_RATE, maxDurationMs: MAX_STT_AUDIO_MS }
  };
}
