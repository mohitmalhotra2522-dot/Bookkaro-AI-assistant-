/**
 * P36-C — G2: ElevenLabs Scribe v2 BATCH STT integration + security (focused).
 * Fake fetch only — NO real ElevenLabs call, no credits, no network, no real key (a fake marker string is used).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  ElevenLabsBatchSTT, createElevenLabsBatchSTT, validateSttAudio, parseScribeResponse, batchSttConfigView, SttError,
  ELEVENLABS_STT_ENDPOINT, ELEVENLABS_STT_KEYTERMS, ELEVENLABS_STT_REQUEST, MAX_STT_ATTEMPTS, type ValidatedAudio
} from '../../server/voice/stt/elevenlabs-batch-stt';
import { registerVoiceRoutes } from '../../server/voice/live/voice-routes';
import { voiceProviderStatus } from '../../server/voice/live/openai-compatible-voice';

const FAKE_KEY = 'xi-FAKE-P36C-TEST-KEY-0000';          // not a real key — leak detector marker
const TRANSCRIPT = 'कल अमृतसर से दिल्ली AC 3A में टिकट चाहिए';

/** 16 kHz mono PCM16 sine (speech-like level). */
function pcm(ms = 1000, amp = 8000): Uint8Array {
  const n = Math.round(16 * ms), out = new Uint8Array(n * 2), v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / 16000)), true);
  return out;
}
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
const audio = (ms = 1000) => validateSttAudio({ audioBase64: b64(pcm(ms)), mimeType: 'audio/pcm', sampleRate: 16000 });

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<() => Promise<Response> | Response>) {
  const calls: Call[] = [];
  let i = 0;
  const f = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return r();
  }) as unknown as typeof fetch;
  return { f, calls };
}
const ok = (body: any = { language_code: 'hin', language_probability: 0.98, text: TRANSCRIPT, words: [] }) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
const status = (s: number, body = '{"detail":{"status":"x","message":"upstream says: key=' + FAKE_KEY + '"}}') => () => new Response(body, { status: s });
const stt = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof ElevenLabsBatchSTT>[0]> = {}) =>
  new ElevenLabsBatchSTT({ apiKey: FAKE_KEY, fetchImpl: f, retryDelayMs: 0, sleep: async () => undefined, ...extra });

function app(o: { f?: typeof fetch; key?: string | null; sessions?: string[]; logs?: any[]; timeoutMs?: number } = {}) {
  const server = Fastify();
  const env: any = o.key === null ? {} : { ELEVENLABS_API_KEY: o.key ?? FAKE_KEY };
  const batch = createElevenLabsBatchSTT(env, o.f);
  (batch as any).cfg.retryDelayMs = 0; (batch as any).cfg.sleep = async () => undefined;
  const sessions = new Set(o.sessions ?? ['s1']);
  registerVoiceRoutes(server, { stt: null, tts: null, latestSpeech: () => null, batchStt: batch, sessionExists: (s) => sessions.has(s), log: (e) => o.logs?.push(e) });
  return { server, batch };
}
const body = (x: any = {}) => ({ sessionId: 's1', voiceTurnId: 'vt_0000000001', mimeType: 'audio/pcm', sampleRate: 16000, audioBase64: b64(pcm()), durationMs: 1000, ...x });

afterEach(() => { vi.restoreAllMocks(); });

describe('P36-C G2 — request lock (model / batch endpoint / keyterms / language)', () => {
  it('[1] model locked: model_id=scribe_v2 always; caller language and client body fields cannot change it', async () => {
    const { f, calls } = fakeFetch([ok()]);
    await stt(f).transcribe(audio(), 'en-US');
    const form = calls[0].init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.getAll('model_id')).toHaveLength(1);
    expect(form.get('language_code')).toBe('hin');                       // locked, no translation, not "en"
    expect(Object.isFrozen(ELEVENLABS_STT_REQUEST)).toBe(true);
    expect(ELEVENLABS_STT_REQUEST.model_id).toBe('scribe_v2');
    // route: client tries to choose model / language / keyterms → ignored
    const g = fakeFetch([ok()]);
    const { server } = app({ f: g.f });
    const r = await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body({ model_id: 'scribe_v1', model: 'scribe_v2_realtime', language_code: 'eng', keyterms: ['HACK'] }) });
    expect(r.statusCode).toBe(200);
    const fd = g.calls[0].init.body as FormData;
    expect(fd.get('model_id')).toBe('scribe_v2');
    expect(fd.get('language_code')).toBe('hin');
    expect(fd.getAll('keyterms')).not.toContain('HACK');
    // no realtime / v1 / fallback model anywhere in the provider source
    const src = readFileSync(join(__dirname, '../../server/voice/stt/elevenlabs-batch-stt.ts'), 'utf8');
    expect(src).not.toMatch(/scribe_v2_realtime|scribe_v1|wss:\/\//);
  });

  it('[2] batch endpoint: one multipart POST to /v1/speech-to-text with xi-api-key; PCM16 16 kHz format; no WebSocket', async () => {
    const { f, calls } = fakeFetch([ok()]);
    const r = await stt(f).transcribe(audio());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(ELEVENLABS_STT_ENDPOINT).toBe(calls[0].url);
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.body).toBeInstanceOf(FormData);
    expect((calls[0].init.headers as any)['xi-api-key']).toBe(FAKE_KEY);
    const form = calls[0].init.body as FormData;
    expect(form.get('file_format')).toBe('pcm_s16le_16');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('tag_audio_events')).toBe('false');
    expect(r.transcript).toBe(TRANSCRIPT);
    expect(r.isFinal).toBe(true);
  });

  it('[3] exact keyterms: AC,3A,CC,SL,RAC,WL as repeated multipart fields, centralized + frozen', async () => {
    const { f, calls } = fakeFetch([ok()]);
    await stt(f).transcribe(audio());
    const form = calls[0].init.body as FormData;
    expect(form.getAll('keyterms')).toEqual(['AC', '3A', 'CC', 'SL', 'RAC', 'WL']);
    expect([...ELEVENLABS_STT_KEYTERMS]).toEqual(['AC', '3A', 'CC', 'SL', 'RAC', 'WL']);
    expect(Object.isFrozen(ELEVENLABS_STT_KEYTERMS)).toBe(true);
    expect(() => (ELEVENLABS_STT_KEYTERMS as string[]).push('X')).toThrow();
    expect(batchSttConfigView(stt(f)).keytermsEnabled).toBe(true);
  });

  it('transcript is passed through unchanged (no manual AC→एसी conversion; confidence ignored)', () => {
    const r = parseScribeResponse({ text: '  12014  AC  chair car ', language_code: 'hin', words: [{ text: 'AC', logprob: -9 }] });
    expect(r.transcript).toBe('12014 AC chair car');
    expect(r).not.toHaveProperty('confidence');
  });
});

describe('P36-C G2 — secret handling and missing configuration', () => {
  it('[4] the API key never appears in client output: responses, errors, config, health, logs, browser source', async () => {
    const logs: any[] = [];
    const g = fakeFetch([ok(), status(401), status(500), status(500)]);
    const { server, batch } = app({ f: g.f, logs });
    const outs: string[] = [];
    for (let i = 0; i < 3; i++) outs.push((await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body({ voiceTurnId: `vt_000000000${i}` }) })).body);
    outs.push((await server.inject({ method: 'GET', url: '/api/voice/config' })).body);
    outs.push(JSON.stringify(voiceProviderStatus({ ELEVENLABS_API_KEY: FAKE_KEY } as any, batch)));
    outs.push(JSON.stringify(logs));
    outs.push(new SttError('STT_PROVIDER_AUTH_ERROR', 401).message);
    for (const o of outs) { expect(o).not.toContain(FAKE_KEY); expect(o).not.toMatch(/xi-api-key/i); }
    expect(outs[1]).toContain('STT_PROVIDER_AUTH_ERROR');
    expect(outs[1]).not.toContain('upstream says');                     // raw provider error never forwarded
    // browser code never references the server key / header / provider endpoint; no VITE_ exposure
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
    walk(join(__dirname, '../../src'));
    for (const p of files) {
      const s = readFileSync(p, 'utf8');
      expect(s, p).not.toMatch(/ELEVENLABS_API_KEY|xi-api-key|api\.elevenlabs\.io|VITE_ELEVEN/);
    }
  });

  it('[5] missing key: no crash, STT reported unavailable (config + health), 503 STT_CONFIG_MISSING, zero provider calls', async () => {
    const g = fakeFetch([ok()]);
    expect(() => createElevenLabsBatchSTT({} as any, g.f)).not.toThrow();
    const { server, batch } = app({ f: g.f, key: null });
    expect(batch.configured()).toBe(false);
    const cfg = (await server.inject({ method: 'GET', url: '/api/voice/config' })).json();
    expect(cfg.stt).toEqual({ enabled: false, provider: 'elevenlabs', model: 'scribe_v2', mode: 'batch', keytermsEnabled: true, audio: { mimeType: 'audio/pcm', sampleRate: 16000, maxDurationMs: 60000 } });
    expect(cfg.browserFallback).toBe(true);
    expect(voiceProviderStatus({} as any, batch).batchStt).toEqual({ configured: false, provider: 'elevenlabs', model: 'scribe_v2', mode: 'batch', keytermsEnabled: true });
    const r = await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body() });
    expect(r.statusCode).toBe(503);
    expect(r.json()).toMatchObject({ error: 'STT_CONFIG_MISSING', fallback: 'TEXT' });
    expect(r.json()).not.toHaveProperty('transcript');
    await expect(batch.transcribe(audio())).rejects.toMatchObject({ code: 'STT_CONFIG_MISSING' });
    expect(g.calls).toHaveLength(0);
    // kill switch
    expect(createElevenLabsBatchSTT({ ELEVENLABS_API_KEY: FAKE_KEY, ELEVENLABS_STT_ENABLED: 'false' } as any).configured()).toBe(false);
    // health with a key: configured, and STILL no provider call (config presence only)
    const h = fakeFetch([ok()]);
    expect(voiceProviderStatus({} as any, createElevenLabsBatchSTT({ ELEVENLABS_API_KEY: FAKE_KEY } as any, h.f)).batchStt.configured).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});

describe('P36-C G2 — provider failures', () => {
  it('[6] malformed responses are rejected (never a transcript): non-JSON, wrong types, multichannel, empty', async () => {
    const bad: Array<[() => Response, string]> = [
      [() => new Response('<html>oops</html>', { status: 200 }), 'STT_PROVIDER_BAD_RESPONSE'],
      [ok({ text: 123 }), 'STT_PROVIDER_BAD_RESPONSE'],
      [ok({ transcripts: [{ text: 'a' }] }), 'STT_PROVIDER_BAD_RESPONSE'],
      [ok([{ text: 'a' }]), 'STT_PROVIDER_BAD_RESPONSE'],
      [ok({ text: 'ok', language_code: 5 }), 'STT_PROVIDER_BAD_RESPONSE'],
      [ok({ text: '   ' }), 'STT_NO_SPEECH']
    ];
    for (const [resp, code] of bad) {
      const g = fakeFetch([resp]);
      await expect(stt(g.f).transcribe(audio())).rejects.toMatchObject({ code });
      expect(g.calls).toHaveLength(1);                                     // not transient → no retry
    }
    const g = fakeFetch([ok({ text: 42 })]);
    const r = await app({ f: g.f }).server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body() });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toMatchObject({ error: 'STT_PROVIDER_BAD_RESPONSE' });
    expect(r.json()).not.toHaveProperty('transcript');
  });

  it('[7] timeout: bounded per attempt, ONE retry, then STT_PROVIDER_TIMEOUT (504); no transcript', async () => {
    const hang = () => new Promise<Response>(() => undefined);
    const calls: number[] = [];
    const f = vi.fn((_u: any, init: any) => { calls.push(Date.now()); return new Promise<Response>((_res, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); void hang; }); }) as unknown as typeof fetch;
    const p = stt(f, { timeoutMs: 1000 });
    expect(p.timeoutMs).toBe(1000);
    expect(new ElevenLabsBatchSTT({ apiKey: 'x', timeoutMs: 10 ** 9 }).timeoutMs).toBe(20000);   // clamped
    const t0 = Date.now();
    await expect(p.transcribe(audio())).rejects.toMatchObject({ code: 'STT_PROVIDER_TIMEOUT' });
    expect(calls).toHaveLength(MAX_STT_ATTEMPTS);
    expect(Date.now() - t0).toBeLessThan(5000);
    const { server, batch } = app({ f });
    (batch as any).timeoutMs = 1000;
    const r = await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body() });
    expect(r.statusCode).toBe(504);
    expect(r.json()).toMatchObject({ error: 'STT_PROVIDER_TIMEOUT', fallback: 'TEXT' });
    expect(r.json()).not.toHaveProperty('transcript');
  }, 15000);

  it('[11] retry: at most ONE retry, only for transient failures; success after retry yields exactly one result', async () => {
    let g = fakeFetch([status(503), ok()]);
    const r = await stt(g.f).transcribe(audio());
    expect(g.calls).toHaveLength(2);
    expect(r.attempts).toBe(2);
    expect(r.transcript).toBe(TRANSCRIPT);
    g = fakeFetch([status(500), status(502), status(503), ok()]);
    await expect(stt(g.f).transcribe(audio())).rejects.toMatchObject({ code: 'STT_PROVIDER_UNAVAILABLE' });
    expect(g.calls).toHaveLength(2);                                       // never more than one retry
    g = fakeFetch([status(429), status(429)]);
    await expect(stt(g.f).transcribe(audio())).rejects.toMatchObject({ code: 'STT_PROVIDER_RATE_LIMIT' });
    expect(g.calls).toHaveLength(2);
    for (const [s, code] of [[401, 'STT_PROVIDER_AUTH_ERROR'], [403, 'STT_PROVIDER_AUTH_ERROR'], [400, 'STT_AUDIO_INVALID'], [422, 'STT_AUDIO_INVALID'], [413, 'STT_AUDIO_TOO_LARGE']] as const) {
      g = fakeFetch([status(s), ok()]);
      await expect(stt(g.f).transcribe(audio())).rejects.toMatchObject({ code });
      expect(g.calls).toHaveLength(1);                                     // permanent → no retry
    }
    // network error → one retry
    let n = 0;
    const net = vi.fn(async () => { if (n++ === 0) throw new TypeError('fetch failed'); return ok()(); }) as unknown as typeof fetch;
    expect((await stt(net).transcribe(audio())).transcript).toBe(TRANSCRIPT);
    expect(n).toBe(2);
    // a cancelled (stale) turn is never retried
    const ctl = new AbortController();
    g = fakeFetch([() => { ctl.abort(); return status(503)(); }, ok()]);
    await expect(stt(g.f).transcribe(audio(), undefined, { signal: ctl.signal })).rejects.toMatchObject({ code: 'STT_STALE_TURN' });
    expect(g.calls).toHaveLength(1);
    // route: retry success → ONE 200 response with ONE transcript
    g = fakeFetch([status(503), ok()]);
    const res = await app({ f: g.f }).server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ transcript: TRANSCRIPT, status: 'FINAL', voiceTurnId: 'vt_0000000001', stt: { provider: 'elevenlabs', model: 'scribe_v2', mode: 'batch' } });
    expect(g.calls).toHaveLength(2);
  });
});

describe('P36-C G2 — audio validation, session ownership, stale turns, logging', () => {
  it('audio is validated before any paid call: empty, non-base64, type, size, duration, framing, silence, session, turn id', async () => {
    const g = fakeFetch([ok()]);
    const { server } = app({ f: g.f });
    const cases: Array<[any, number, string]> = [
      [{ audioBase64: '' }, 400, 'STT_AUDIO_INVALID'],
      [{ audioBase64: '!!!not base64!!!' }, 400, 'STT_AUDIO_INVALID'],
      [{ mimeType: 'video/mp4' }, 400, 'STT_AUDIO_INVALID'],
      [{ mimeType: 'text/plain' }, 400, 'STT_AUDIO_INVALID'],
      [{ sampleRate: 44100 }, 400, 'STT_AUDIO_INVALID'],
      [{ audioBase64: b64(pcm(100)) }, 400, 'STT_AUDIO_INVALID'],                 // < 250 ms
      [{ audioBase64: b64(pcm(61_000)) }, 413, 'STT_AUDIO_TOO_LARGE'],            // > 60 s
      [{ audioBase64: b64(new Uint8Array(16001).fill(7)) }, 400, 'STT_AUDIO_INVALID'], // odd PCM length
      [{ audioBase64: b64(new Uint8Array(32000)) }, 422, 'STT_NO_SPEECH'],         // digital silence
      [{ mimeType: 'audio/webm', audioBase64: b64(new Uint8Array(4000).fill(1)) }, 400, 'STT_AUDIO_INVALID'], // bad container signature
      [{ sessionId: 'someone-else' }, 403, 'STT_SESSION_INVALID'],
      [{ sessionId: undefined }, 403, 'STT_SESSION_INVALID'],
      [{ voiceTurnId: 'x' }, 400, 'STT_AUDIO_INVALID']
    ];
    for (const [patch, code, err] of cases) {
      const r = await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body(patch) });
      expect(r.statusCode, JSON.stringify(Object.keys(patch))).toBe(code);
      expect(r.json().error).toBe(err);
    }
    expect(g.calls).toHaveLength(0);
    // > 2 MB → too large
    expect(() => validateSttAudio({ audioBase64: b64(new Uint8Array(2 * 1024 * 1024 + 2)), mimeType: 'audio/pcm' })).toThrow(SttError);
    // a valid encoded container (webm EBML header) is accepted without file_format (auto-detect)
    const webm = new Uint8Array(4000).fill(3); webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    const v: ValidatedAudio = validateSttAudio({ audioBase64: b64(webm), mimeType: 'audio/webm;codecs=opus', durationMs: 1200 });
    expect(v.fileFormat).toBeNull();
    const w = fakeFetch([ok()]);
    await stt(w.f).transcribe(v);
    expect((w.calls[0].init.body as FormData).get('file_format')).toBeNull();
  });

  it('[8-server] a superseded recording returns STT_STALE_TURN and NO transcript', async () => {
    let releaseFirst!: () => void;
    const gate = new Promise<void>(r => { releaseFirst = r; });
    let n = 0;
    const f = vi.fn(async () => { if (n++ === 0) await gate; return ok()(); }) as unknown as typeof fetch;
    const { server } = app({ f });
    const first = server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body({ voiceTurnId: 'vt_old_turn_01' }) });
    await new Promise(r => setTimeout(r, 20));
    const second = await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body({ voiceTurnId: 'vt_new_turn_02' }) });
    releaseFirst();
    const old = await first;
    expect(second.statusCode).toBe(200);
    expect(second.json().voiceTurnId).toBe('vt_new_turn_02');
    expect(old.statusCode).toBe(409);
    expect(old.json()).toMatchObject({ error: 'STT_STALE_TURN' });
    expect(old.json()).not.toHaveProperty('transcript');
  });

  it('[12] audio (raw / base64) and transcript text are never logged; logs carry safe metadata only', async () => {
    const logs: any[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => vi.spyOn(console, m).mockImplementation(() => undefined));
    const g = fakeFetch([ok(), status(500), status(500), ok({ text: 5 })]);
    const { server } = app({ f: g.f, logs });
    const a = pcm(800);
    for (let i = 0; i < 3; i++) await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body({ voiceTurnId: `vt_logcheck_${i}`, audioBase64: b64(a) }) });
    await server.inject({ method: 'POST', url: '/api/voice/transcribe', payload: body({ voiceTurnId: 'vt_logcheck_9', audioBase64: b64(new Uint8Array(32000)) }) });
    expect(logs.length).toBe(4);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain(b64(a).slice(0, 64));
    expect(dump).not.toContain(TRANSCRIPT);
    expect(dump).not.toMatch(/कल|अमृतसर/);
    const allowed = new Set(['event', 'sessionId', 'voiceTurnId', 'provider', 'model', 'latencyMs', 'success', 'transcriptChars', 'errorCategory']);
    for (const e of logs) for (const k of Object.keys(e)) expect(allowed.has(k), k).toBe(true);
    expect(logs[0]).toMatchObject({ event: 'voice_stt_batch', provider: 'elevenlabs', model: 'scribe_v2', success: true, transcriptChars: TRANSCRIPT.length });
    expect(logs[1]).toMatchObject({ success: false, errorCategory: 'STT_PROVIDER_UNAVAILABLE' });
    expect(logs[3]).toMatchObject({ success: false, errorCategory: 'STT_NO_SPEECH' });
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
