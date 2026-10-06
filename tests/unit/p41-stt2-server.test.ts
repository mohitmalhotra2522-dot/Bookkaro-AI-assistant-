/**
 * P41-STT2 — server STT accuracy options + observability (focused, additive).
 *  - ELEVENLABS_STT_LANGUAGE=auto → language_code omitted (Scribe predicts it); default stays the P36-C "hin" lock
 *  - ELEVENLABS_STT_KEYTERMS=extended → railway words + common stations (≤ 100, frozen, superset of the P36-B.6 set)
 *  - auto mode: a transcript in another script (Gurmukhi / Perso-Arabic …) is re-transcribed ONCE with "hin"
 *  - route log: audio length vs wall time (dropped capture buffers) + signal level — numbers only, never audio / text
 * Fake fetch only — NO real ElevenLabs call, no credits, no network, no real key.
 */
import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import {
  ElevenLabsBatchSTT, createElevenLabsBatchSTT, validateSttAudio, needsHindiRetry, pcmSignalStats,
  ELEVENLABS_STT_KEYTERMS, ELEVENLABS_STT_KEYTERMS_EXTENDED
} from '../../server/voice/stt/elevenlabs-batch-stt';
import { registerVoiceRoutes } from '../../server/voice/live/voice-routes';

const FAKE_KEY = 'xi-FAKE-P41-STT2-KEY-0000';
function pcm(ms = 1000, amp = 8000): Uint8Array {
  const n = Math.round(16 * ms), out = new Uint8Array(n * 2), v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000)), true);
  return out;
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const audio = (ms = 1000) => validateSttAudio({ audioBase64: b64(pcm(ms)), mimeType: 'audio/pcm', sampleRate: 16000 });
const json = (body: any) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
function fakeFetch(responses: Array<() => Response>) {
  const forms: FormData[] = [];
  let i = 0;
  const f = vi.fn(async (_u: any, init: any) => { forms.push(init.body as FormData); return responses[Math.min(i++, responses.length - 1)](); }) as unknown as typeof fetch;
  return { f, forms };
}
const stt = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof ElevenLabsBatchSTT>[0]> = {}) =>
  new ElevenLabsBatchSTT({ apiKey: FAKE_KEY, fetchImpl: f, retryDelayMs: 0, sleep: async () => undefined, ...extra });

describe('P41-STT2 — language mode + keyterm set', () => {
  it('[A1] default (no env) keeps the P36-C lock: language_code=hin + the 6 base keyterms', async () => {
    const { f, forms } = fakeFetch([json({ text: 'कल दिल्ली', language_code: 'hin' })]);
    const s = createElevenLabsBatchSTT({ ELEVENLABS_API_KEY: FAKE_KEY } as any, f);
    expect(s.languageMode).toBe('hin'); expect(s.keytermSet).toBe('base');
    await s.transcribe(audio());
    expect(forms[0].get('language_code')).toBe('hin');
    expect(forms[0].getAll('keyterms')).toEqual([...ELEVENLABS_STT_KEYTERMS]);
  });

  it('[A2] ELEVENLABS_STT_LANGUAGE=auto omits language_code; =extended sends the extended set; other values fall back safely', async () => {
    const { f, forms } = fakeFetch([json({ text: 'Amritsar se Delhi kal', language_code: 'eng' })]);
    const s = createElevenLabsBatchSTT({ ELEVENLABS_API_KEY: FAKE_KEY, ELEVENLABS_STT_LANGUAGE: ' AUTO ', ELEVENLABS_STT_KEYTERMS: 'extended' } as any, f);
    const r = await s.transcribe(audio());
    expect(forms[0].has('language_code')).toBe(false);
    expect(forms[0].getAll('keyterms')).toEqual([...ELEVENLABS_STT_KEYTERMS_EXTENDED]);
    expect(r.transcript).toBe('Amritsar se Delhi kal');
    expect(r.language).toBe('eng');
    expect(r.languageRetry).toBeUndefined();
    const odd = createElevenLabsBatchSTT({ ELEVENLABS_API_KEY: FAKE_KEY, ELEVENLABS_STT_LANGUAGE: 'pan', ELEVENLABS_STT_KEYTERMS: 'all' } as any);
    expect(odd.languageMode).toBe('hin'); expect(odd.keytermSet).toBe('base');   // no arbitrary language / list from env
  });

  it('[A3] extended keyterms: superset of the base set, ≤ 100 (no 20 s minimum billing), frozen, provider limits respected', () => {
    const ext = [...ELEVENLABS_STT_KEYTERMS_EXTENDED];
    for (const k of ELEVENLABS_STT_KEYTERMS) expect(ext).toContain(k);
    expect(ext.length).toBeLessThanOrEqual(100);
    expect(new Set(ext).size).toBe(ext.length);
    for (const k of ext) {
      expect(k.length).toBeLessThan(50);
      expect(k.trim().split(/\s+/).length).toBeLessThanOrEqual(5);
      expect(/[<>{}\[\]\\]/.test(k)).toBe(false);
    }
    expect(Object.isFrozen(ELEVENLABS_STT_KEYTERMS_EXTENDED)).toBe(true);
    for (const st of ['Amritsar', 'Ludhiana', 'Jalandhar', 'New Delhi', 'Tatkal', 'Shatabdi', 'Vande Bharat', 'passenger', 'fare']) expect(ext).toContain(st);
  });
});

describe('P41-STT2 — auto mode script guard (one bounded re-transcription)', () => {
  it('[B1] needsHindiRetry: only letters outside Latin + Devanagari trigger it (digits, ₹, punctuation never do)', () => {
    expect(needsHindiRetry('Amritsar se Delhi kal jaana hai')).toBe(false);
    expect(needsHindiRetry('कल अमृतसर से दिल्ली, 12014 में ₹1125 — AC 3A?')).toBe(false);
    expect(needsHindiRetry('ਅੰਮ੍ਰਿਤਸਰ ਤੋਂ ਦਿੱਲੀ')).toBe(true);           // Gurmukhi
    expect(needsHindiRetry('امرتسر سے دہلی')).toBe(true);                // Perso-Arabic
    expect(needsHindiRetry('Delhi ਜਾਣਾ hai')).toBe(true);                 // mixed
  });

  it('[B2] auto + Gurmukhi answer → exactly ONE retry with language_code=hin; the Hindi result is returned', async () => {
    const { f, forms } = fakeFetch([json({ text: 'ਇੱਕ ਯਾਤਰੀ', language_code: 'pan' }), json({ text: 'एक पैसेंजर', language_code: 'hin' })]);
    const r = await stt(f, { languageMode: 'auto' }).transcribe(audio());
    expect(forms).toHaveLength(2);
    expect(forms[0].has('language_code')).toBe(false);
    expect(forms[1].get('language_code')).toBe('hin');
    expect(r).toMatchObject({ transcript: 'एक पैसेंजर', language: 'hin', languageRetry: true, attempts: 2 });
  });

  it('[B3] retry failure keeps the first successful result; "hin" mode never retries; Roman/Devanagari answers never retry', async () => {
    const bad = () => new Response('x', { status: 500 });
    const a = fakeFetch([json({ text: 'ਇੱਕ ਯਾਤਰੀ', language_code: 'pan' }), bad]);
    const r1 = await stt(a.f, { languageMode: 'auto' }).transcribe(audio());
    expect(a.forms).toHaveLength(2);
    expect(r1.transcript).toBe('ਇੱਕ ਯਾਤਰੀ');
    const h = fakeFetch([json({ text: 'ਇੱਕ ਯਾਤਰੀ', language_code: 'pan' })]);
    await stt(h.f).transcribe(audio());
    expect(h.forms).toHaveLength(1);
    const ro = fakeFetch([json({ text: 'ek passenger', language_code: 'eng' })]);
    await stt(ro.f, { languageMode: 'auto' }).transcribe(audio());
    expect(ro.forms).toHaveLength(1);
  });
});

describe('P41-STT2 — route observability (numbers only)', () => {
  function app(env: any, f: typeof fetch, logs: any[], diags: any[] = []) {
    const server = Fastify();
    const batch = createElevenLabsBatchSTT({ ELEVENLABS_API_KEY: FAKE_KEY, ...env }, f);
    (batch as any).cfg.retryDelayMs = 0; (batch as any).cfg.sleep = async () => undefined;
    registerVoiceRoutes(server, { stt: null, tts: null, latestSpeech: () => null, batchStt: batch, sessionExists: (s) => s === 's1', log: (e) => logs.push(e), diag: (e) => diags.push(e) });
    return server;
  }
  const payload = (x: any = {}) => ({ sessionId: 's1', voiceTurnId: 'vt_0000000001', mimeType: 'audio/pcm', sampleRate: 16000, audioBase64: b64(pcm(1000)), durationMs: 2000, ...x });

  it('[C1] diag event carries audioMs / wallMs / captureRatio / level / language metadata — never transcript, audio or session; the P36-C log is unchanged', async () => {
    const logs: any[] = [], diags: any[] = [];
    const TEXT = 'ek passenger Amritsar se Delhi';
    const { f } = fakeFetch([json({ text: TEXT, language_code: 'eng' })]);
    const server = app({ ELEVENLABS_STT_LANGUAGE: 'auto', ELEVENLABS_STT_KEYTERMS: 'extended' }, f, logs, diags);
    const res = await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: payload() });
    expect(res.statusCode).toBe(200);
    expect(res.json().transcript).toBe(TEXT);
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]).sort()).toEqual(['event', 'latencyMs', 'model', 'provider', 'sessionId', 'success', 'transcriptChars', 'voiceTurnId']);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ event: 'voice_stt_audio', success: true, audioMs: 1000, wallMs: 2000, captureRatio: 0.5,
      languageMode: 'auto', keytermSet: 'extended', detectedLanguage: 'eng', languageRetry: false, transcriptChars: TEXT.length });
    expect(diags[0].sessionId).toBeUndefined();
    expect(diags[0].peakDbfs).toBeGreaterThan(-13); expect(diags[0].peakDbfs).toBeLessThan(-11);   // 8000/32768 ≈ -12.2 dBFS
    expect(diags[0].rmsDbfs).toBeLessThan(diags[0].peakDbfs);
    const flat = JSON.stringify([...logs, ...diags]);
    expect(flat).not.toContain('passenger'); expect(flat).not.toContain(FAKE_KEY); expect(flat).not.toContain(payload().audioBase64.slice(0, 40));
    await server.close();
  });

  it('[C2] failures also emit the audio metadata (quiet audio → NO_SPEECH from the provider); no wall time → null ratio; no diag sink → nothing breaks', async () => {
    const logs: any[] = [], diags: any[] = [];
    const { f } = fakeFetch([json({ text: '   ', language_code: 'hin' })]);
    const server = app({}, f, logs, diags);
    const res = await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: payload({ durationMs: undefined, audioBase64: b64(pcm(800, 300)) }) });
    expect(res.statusCode).toBe(422);
    expect(logs[0]).toMatchObject({ event: 'voice_stt_batch', success: false, errorCategory: 'STT_NO_SPEECH' });
    expect(diags[0]).toMatchObject({ event: 'voice_stt_audio', success: false, errorCategory: 'STT_NO_SPEECH', audioMs: 800, wallMs: null, captureRatio: null, languageMode: 'hin', keytermSet: 'base' });
    expect(diags[0].peakDbfs).toBeLessThan(-35);
    await server.close();
  });

  it('[C3] pcmSignalStats: silence → -120 dBFS, full scale → 0 dBFS, empty → null', () => {
    expect(pcmSignalStats(new Uint8Array(3200))).toEqual({ peakDbfs: -120, rmsDbfs: -120 });
    const fs = new Uint8Array(4); new DataView(fs.buffer).setInt16(0, -32768, true); new DataView(fs.buffer).setInt16(2, -32768, true);
    expect(pcmSignalStats(fs)).toEqual({ peakDbfs: 0, rmsDbfs: 0 });
    expect(pcmSignalStats(new Uint8Array(0))).toEqual({ peakDbfs: null, rmsDbfs: null });
  });
});
