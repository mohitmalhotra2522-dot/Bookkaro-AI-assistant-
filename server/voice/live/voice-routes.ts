/**
 * Prompt 35 — server STT / TTS transport routes. They add NO conversation logic:
 *  - POST /api/voice/turn : audio → STT → the SAME /api/chat handler (fastify.inject, mode=VOICE, FINAL transcript
 *    metadata) → identical agent / tools / guards / session as typed text. Returns the chat response + transcript.
 *  - POST /api/voice/speak: { sessionId } → TTS of that session's LATEST VALIDATED assistant response (server-side
 *    lookup; the client cannot supply text, so TTS can never speak unchecked words).
 * Failure is graceful and honest (503 / 422 / 504 with a short Hinglish message); the text path keeps working.
 */
import type { FastifyInstance } from 'fastify';
import { VoiceProviderError, decodeAudioBase64, type OpenAICompatibleSTT, type OpenAICompatibleTTS } from './openai-compatible-voice';

export interface VoiceRouteDeps {
  stt: OpenAICompatibleSTT | null;
  tts: OpenAICompatibleTTS | null;
  /** Latest validated assistant response for the session (speechText preferred) — null when none / unknown session. */
  latestSpeech(sessionId: string): { text: string; turnId?: string | null } | null;
  log?: (e: Record<string, unknown>) => void;
}

const STATUS: Record<VoiceProviderError['code'], number> = { VOICE_NOT_CONFIGURED: 503, VOICE_TIMEOUT: 504, VOICE_PROVIDER_FAILURE: 502, VOICE_BAD_AUDIO: 400, VOICE_EMPTY_TRANSCRIPT: 422 };
const MIME_RE = /^audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,-]+)?$/i;

export function registerVoiceRoutes(server: FastifyInstance, deps: VoiceRouteDeps): void {
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
