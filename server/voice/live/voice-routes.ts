/**
 * Prompt 35 — server STT / TTS transport routes. They add NO conversation logic:
 *  - POST /api/voice/turn : audio → STT → the SAME /api/chat handler (fastify.inject, mode=VOICE, FINAL transcript
 *    metadata) → identical agent / tools / guards / session as typed text. Returns the chat response + transcript.
 *  - POST /api/voice/speak: { sessionId } → TTS of that session's LATEST VALIDATED assistant response (server-side
 *    lookup; the client cannot supply text, so TTS can never speak unchecked words).
 * Failure is graceful and honest (503 / 422 / 504 with a short Hinglish message); the text path keeps working.
 *
 * P36-C (additive):
 *  - POST /api/voice/transcribe: ONE tap-to-talk recording → ElevenLabs Scribe v2 BATCH → { transcript } ONLY.
 *    It does NOT call /api/chat: the browser hands the FINAL transcript to its existing ConversationalVoiceAgent →
 *    VoiceTurnDetector → /api/chat, exactly like a Web Speech final. Stale recordings (a newer voiceTurnId for the
 *    session, or the client went away) return STT_STALE_TURN and no transcript.
 *  - GET /api/voice/config: safe STT capability fields only (no key, no paid call).
 */
import type { FastifyInstance } from 'fastify';
import { VoiceProviderError, decodeAudioBase64, type OpenAICompatibleSTT, type OpenAICompatibleTTS } from './openai-compatible-voice';
import { SttError, STT_HTTP_STATUS, batchSttConfigView, validateSttAudio, pcmSignalStats, type ElevenLabsBatchSTT } from '../stt/elevenlabs-batch-stt';

export interface VoiceRouteDeps {
  stt: OpenAICompatibleSTT | null;
  tts: OpenAICompatibleTTS | null;
  /** Latest validated assistant response for the session (speechText preferred) — null when none / unknown session. */
  latestSpeech(sessionId: string): { text: string; turnId?: string | null } | null;
  log?: (e: Record<string, unknown>) => void;
  /**
   * P41-STT2: separate metadata-only diagnostics sink (event `voice_stt_audio`): recorded audio vs wall time, signal
   * level, language mode / detected language. Numbers + codes only — never audio, transcript, session id or key.
   * Kept apart from `log`, whose P36-C key allowlist stays unchanged.
   */
  diag?: (e: Record<string, unknown>) => void;
  /** P36-C: ElevenLabs Scribe v2 batch STT (absent / unconfigured → STT_CONFIG_MISSING, browser fallback). */
  batchStt?: ElevenLabsBatchSTT | null;
  /** P36-C: the recording must belong to a session this server created (no session is created by STT). */
  sessionExists?: (sessionId: string) => boolean;
}

const VOICE_TURN_RE = /^[A-Za-z0-9_-]{8,64}$/;

const STATUS: Record<VoiceProviderError['code'], number> = { VOICE_NOT_CONFIGURED: 503, VOICE_TIMEOUT: 504, VOICE_PROVIDER_FAILURE: 502, VOICE_BAD_AUDIO: 400, VOICE_EMPTY_TRANSCRIPT: 422 };
const MIME_RE = /^audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,-]+)?$/i;

export function registerVoiceRoutes(server: FastifyInstance, deps: VoiceRouteDeps): void {
  // P36-C — latest recording per session (in memory, ids only). A newer recording supersedes an in-flight one.
  const latestVoiceTurn = new Map<string, string>();
  // logs: session / turn id, provider, model, latency, success, transcript length, error category — never audio / text
  const sttFail = (reply: any, code: SttError['code'], meta: Record<string, unknown>) => {
    deps.log?.({ event: 'voice_stt_batch', ...meta, success: false, errorCategory: code });
    return reply.status(STT_HTTP_STATUS[code]).send({ error: code, message: new SttError(code).message, fallback: 'TEXT' });
  };

  server.get('/api/voice/config', async (_request, reply) => reply.header('Cache-Control', 'no-store').send({ stt: batchSttConfigView(deps.batchStt), browserFallback: true }));

  server.post('/api/voice/transcribe', { bodyLimit: 3 * 1024 * 1024 }, async (request, reply) => {
    const b = (request.body as any) || {};
    const stt = deps.batchStt;
    const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
    const voiceTurnId = typeof b.voiceTurnId === 'string' && VOICE_TURN_RE.test(b.voiceTurnId) ? b.voiceTurnId : '';
    const meta: Record<string, unknown> = { sessionId: sessionId.slice(0, 64) || null, voiceTurnId: voiceTurnId || null, provider: 'elevenlabs', model: stt?.model ?? 'scribe_v2' };
    if (!stt?.configured()) return sttFail(reply, 'STT_CONFIG_MISSING', meta);
    if (!sessionId || !deps.sessionExists || !deps.sessionExists(sessionId)) return sttFail(reply, 'STT_SESSION_INVALID', meta);
    if (!voiceTurnId) return sttFail(reply, 'STT_AUDIO_INVALID', meta);
    let audio;
    try { audio = validateSttAudio({ audioBase64: b.audioBase64, mimeType: b.mimeType, durationMs: b.durationMs, sampleRate: b.sampleRate }); }
    catch (e) { return sttFail(reply, e instanceof SttError ? e.code : 'STT_AUDIO_INVALID', meta); }
    // P41-STT2 observability (numbers only — never audio / transcript): recorded audio vs wall-clock time reveals
    // dropped capture buffers on a busy device; the level reveals a muted / far-away mic.
    const dmeta: Record<string, unknown> = { event: 'voice_stt_audio', voiceTurnId, languageMode: (stt as any).languageMode ?? 'hin', keytermSet: (stt as any).keytermSet ?? 'base' };
    if (audio.fileFormat === 'pcm_s16le_16') {
      const wallMs = typeof b.durationMs === 'number' && Number.isFinite(b.durationMs) && b.durationMs > 0 ? Math.round(b.durationMs) : null;
      Object.assign(dmeta, { audioMs: audio.durationMs, wallMs, captureRatio: wallMs ? Math.round((audio.durationMs / wallMs) * 100) / 100 : null, ...pcmSignalStats(audio.bytes) });
    }
    const diag = (x: Record<string, unknown>) => { try { deps.diag?.({ ...dmeta, ...x }); } catch { /* observability never breaks a turn */ } };
    latestVoiceTurn.set(sessionId, voiceTurnId);
    // the client cancelled / went away → abort the provider call (no retry, no transcript)
    const ctl = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) ctl.abort(); };
    reply.raw.on('close', onClose);
    const t0 = Date.now();
    try {
      const r = await stt.transcribe(audio, undefined, { signal: ctl.signal });
      if (latestVoiceTurn.get(sessionId) !== voiceTurnId || ctl.signal.aborted) { diag({ success: false, errorCategory: 'STT_STALE_TURN' }); return sttFail(reply, 'STT_STALE_TURN', { ...meta, latencyMs: Date.now() - t0 }); }
      deps.log?.({ event: 'voice_stt_batch', ...meta, latencyMs: r.latencyMs, success: true, transcriptChars: r.transcript.length });
      diag({ success: true, latencyMs: r.latencyMs, transcriptChars: r.transcript.length, detectedLanguage: r.language ?? null, languageRetry: !!r.languageRetry, attempts: r.attempts });
      return reply.header('Cache-Control', 'no-store').send({
        sessionId, voiceTurnId, status: 'FINAL', transcript: r.transcript, language: r.language ?? 'hin',
        stt: { provider: 'elevenlabs', model: stt.model, mode: stt.mode, latencyMs: r.latencyMs }
      });
    } catch (e) {
      const err = e instanceof SttError ? e : new SttError('STT_PROVIDER_UNAVAILABLE');
      const code = latestVoiceTurn.get(sessionId) !== voiceTurnId ? 'STT_STALE_TURN' : err.code;
      diag({ success: false, errorCategory: code, latencyMs: Date.now() - t0 });
      return sttFail(reply, code, { ...meta, latencyMs: Date.now() - t0 });
    } finally {
      reply.raw.off('close', onClose);
      if (latestVoiceTurn.get(sessionId) === voiceTurnId) latestVoiceTurn.delete(sessionId);
    }
  });

  const fail = (reply: any, e: unknown, stage: 'STT' | 'TTS') => {
    const err = e instanceof VoiceProviderError ? e : new VoiceProviderError('VOICE_PROVIDER_FAILURE', stage === 'STT' ? 'Speech recognition abhi uplabdh nahi hai.' : 'Voice playback abhi uplabdh nahi hai.');
    deps.log?.({ event: 'voice_provider_error', stage, code: err.code, httpStatus: err.httpStatus ?? null });
    return reply.status(STATUS[err.code]).send({ error: err.code, message: err.message, fallback: 'TEXT' });
  };

  server.post('/api/voice/turn', { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    const b = (request.body as any) || {};
    if (!deps.stt?.configured()) return fail(reply, new VoiceProviderError('VOICE_NOT_CONFIGURED', 'Server STT configured nahi hai — browser mic ya text use karein.'), 'STT');
    const mimeType = typeof b.mimeType === 'string' && MIME_RE.test(b.mimeType) ? b.mimeType : 'audio/webm';
    const language = typeof b.language === 'string' ? b.language.slice(0, 12) : 'hi-IN';
    const t0 = Date.now();
    let transcript: string, detected: string | undefined;
    try {
      const audio = decodeAudioBase64(b.audioBase64);
      const r = await deps.stt.transcribe(new Blob([audio], { type: mimeType }), language, mimeType);
      transcript = r.transcript.slice(0, 2000); detected = r.language;
    } catch (e) { return fail(reply, e, 'STT'); }
    const sttMs = Date.now() - t0;
    deps.log?.({ event: 'voice_stt', provider: deps.stt.providerId, latencyMs: sttMs, chars: transcript.length });
    // The SAME conversation endpoint as typed text — no voice brain, no voice-only state.
    const chat = await server.inject({ method: 'POST', url: '/api/chat', payload: {
      sessionId: b.sessionId, text: transcript, mode: 'VOICE', bargeIn: b.bargeIn === true,
      ...(typeof b.clientMessageId === 'string' ? { clientMessageId: b.clientMessageId } : {}),
      ...(typeof b.expectedSessionVersion === 'number' ? { expectedSessionVersion: b.expectedSessionVersion } : {}),
      ...(typeof b.reviewVersion === 'number' ? { reviewVersion: b.reviewVersion } : {}),
      transcript: { status: 'FINAL', confidence: null, languageHint: detected || language, sttDurationMs: Math.min(sttMs, 120000) }
    } });
    let body: any; try { body = chat.json(); } catch { body = { error: 'chat failed' }; }
    return reply.status(chat.statusCode).send({ ...body, stt: { provider: 'OPENAI_COMPATIBLE', transcript, latencyMs: sttMs } });
  });

  server.post('/api/voice/speak', async (request, reply) => {
    const b = (request.body as any) || {};
    if (!deps.tts?.configured()) return fail(reply, new VoiceProviderError('VOICE_NOT_CONFIGURED', 'Server TTS configured nahi hai — browser voice use hogi.'), 'TTS');
    if (typeof b.sessionId !== 'string') return reply.status(400).send({ error: 'sessionId required' });
    const latest = deps.latestSpeech(b.sessionId);
    if (!latest?.text) return reply.status(404).send({ error: 'NO_RESPONSE_TO_SPEAK' });
    if (typeof b.turnId === 'string' && latest.turnId && b.turnId !== latest.turnId) return reply.status(409).send({ error: 'STALE_TURN', message: 'Yeh jawab ab latest nahi hai.' });
    const t0 = Date.now();
    try {
      const audio = await deps.tts.synthesize(latest.text, typeof b.language === 'string' ? b.language : 'hi-IN');
      if (!audio) return reply.status(404).send({ error: 'NO_RESPONSE_TO_SPEAK' });
      deps.log?.({ event: 'voice_tts', provider: deps.tts.providerId, latencyMs: Date.now() - t0, chars: latest.text.length, bytes: audio.byteLength });
      return reply.header('Content-Type', deps.tts.mimeType).header('Cache-Control', 'no-store').send(Buffer.from(audio));
    } catch (e) { return fail(reply, e, 'TTS'); }
  });
}
