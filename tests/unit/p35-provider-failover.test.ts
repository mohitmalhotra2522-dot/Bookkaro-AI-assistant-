/**
 * PROMPT 35 — G2 [MOCK-CONTROLLED]: live adapters + failover chain + capability matrix + web authority + voice providers.
 * Real provider SAMPLES (tests/fixtures/p35, captured LIVE by scripts/p35-live-providers.ts) are replayed through the
 * REAL adapters by a controlled transport. No network call is made here — every result is a MOCK-controlled run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fixtureTransport, P35_TEST_ENV } from '../helpers/p35-fixture-fetch';
import { createLiveProvider, createFailoverProvider, liveProviderStatus, liveTimeouts, parseProviderChain } from '../../server/railway/providers/live/live-config';
import { PROVIDER_CAPABILITY_MATRIX, providerSupports } from '../../server/railway/providers/live/provider-capabilities';
import { attemptOutcome } from '../../server/railway/providers/live/failover-provider';
import { RailwayProviderRegistry } from '../../server/railway/registry/provider-registry';
import { dataSourceOf, toolOutcomeOf } from '../../server/ai/tool-runtime/tool-outcome';
import { providerViewOf } from '../../server/ai/runtime/llm-tool-runtime';
import { guardResponseFacts } from '../../server/ai/conversation/response-fact-guard';
import { normalizeWebResults, validateWebQuery, TavilyWebResearchService, webResearchEnabledFromEnv, webResearchStatus, tierOf } from '../../server/research/web-research-service';
import { OpenAICompatibleSTT, OpenAICompatibleTTS, createServerSTT, createServerTTS, voiceProviderStatus, decodeAudioBase64, VoiceProviderError } from '../../server/voice/live/openai-compatible-voice';
import { RAILWAY_TOOL_REGISTRY, llmCallableTools } from '../../server/ai/tool-runtime/railway-tool-registry';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';

const T = fixtureTransport();
const env = (o: Record<string, string | undefined> = {}) => P35_TEST_ENV(o);
const chain = (o: Record<string, string | undefined> = {}) => createFailoverProvider(env(o), T.fetch);
const D = '2026-10-05';
const AV = { trainNumber: '12014', travelClass: 'CC', date: D, origin: 'ASR', destination: 'NDLS' };
const SECRETS = ['rc-TEST-SECRET-35a', 'rr-TEST-SECRET-35b'];
const noSecret = (x: unknown) => { const s = JSON.stringify(x); for (const k of SECRETS) expect(s).not.toContain(k); };

let fetchSpy: any;
beforeEach(() => { T.reset(); fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((u: any) => { throw new Error(`NO NETWORK IN TESTS: ${u}`); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('P35 G2 — adapters normalize REAL provider samples [MOCK-controlled replay]', () => {
  it('[1] RailCore search / availability / fare / schedule / live → normalized shapes, identity echoed, provider + freshness meta', async () => {
    const rc = createLiveProvider('railcore', env(), T.fetch);
    const s: any = await rc.searchTrains({ origin: 'ASR', destination: 'NDLS', date: D });
    expect(s.ok).toBe(true);
    expect(s.data.trains.map((t: any) => t.trainNumber)).toEqual(expect.arrayContaining(['12014', '22126']));
    const t12014 = s.data.trains.find((t: any) => t.trainNumber === '12014');
    expect(t12014).toMatchObject({ departure: '04:55', arrival: '11:02' });
    expect(s.meta).toMatchObject({ source: 'railway-provider', providerId: 'railcore', cache: 'disabled' });
    const a: any = await rc.checkAvailability(AV);
    expect(a.ok).toBe(true);
    expect(a.data).toMatchObject({ trainNumber: '12014', travelClass: 'CC', date: D });
    expect(a.data.status).toMatch(/^WL\s?30$/);
    expect(a.data.statusText).toBe('GNWL51/WL30');
    const f: any = await rc.getFare({ ...AV, passengersCount: 2 });
    expect(f.ok).toBe(true);
    expect(f.data).toMatchObject({ trainNumber: '12014', travelClass: 'CC', perPassenger: 1125, total: 2250 });
    const tt: any = await rc.getTimetable({ trainNumber: '12014' });
    expect(tt.ok).toBe(true);
    const tr: any = await rc.trackTrain({ trainNumber: '12014' });
    expect(tr.ok).toBe(true);
    expect(tr.data.trainNumber).toBe('12014');
    noSecret([s, a, f, tt, tr]);
    expect(T.calls.every(c => c.headers['X-RailCore-Key'] === 'rc-TEST-SECRET-35a')).toBe(true);
  });

  it('[2] RailRadar search / seats calendar / fare / info / live → normalized; WL from the calendar entry of the requested date', async () => {
    const rr = createLiveProvider('railradar', env(), T.fetch);
    const s: any = await rr.searchTrains({ origin: 'ASR', destination: 'NDLS', date: D });
    expect(s.ok && s.data.trains.some((t: any) => t.trainNumber === '12014')).toBe(true);
    const a: any = await rr.checkAvailability(AV);
    expect(a.ok).toBe(true);
    expect(a.data).toMatchObject({ trainNumber: '12014', travelClass: 'CC', date: D });
    expect(a.data.status).toMatch(/^WL\s?32$/);
    const f: any = await rr.getFare({ ...AV, passengersCount: 1 });
    expect(f.ok && f.data.perPassenger).toBe(1125);
    const i: any = await rr.getTrainInfo({ trainNumber: '12014' });
    expect(i.ok && i.data.trainNumber).toBe('12014');
    expect(T.calls.every(c => c.headers.Authorization === 'Bearer rr-TEST-SECRET-35b')).toBe(true);
    noSecret([s, a, f, i]);
  });

  it('[3] capability matrix: RailCore has no PNR, RailKit only search/availability/fare, RailRadar has PNR; nobody claims cancelled trains', () => {
    expect(providerSupports('railcore', 'CHECK_PNR')).toBe(false);
    expect(providerSupports('railradar', 'CHECK_PNR')).toBe(true);
    expect(Object.keys(PROVIDER_CAPABILITY_MATRIX.railkit).sort()).toEqual(['CHECK_AVAILABILITY', 'GET_FARE', 'SEARCH_TRAINS']);
    for (const id of ['railcore', 'railkit', 'railradar'] as const) expect(providerSupports(id, 'GET_CANCELLED_TRAINS')).toBe(false);
  });

  it('[4] invalid request (bad station code) → REJECTED before any network call (no fallback)', async () => {
    const r: any = await chain().searchTrains({ origin: 'asr!!', destination: 'NDLS', date: D });
    expect(r.ok).toBe(false);
    expect(T.calls).toHaveLength(0);
    expect(r.meta.attempts).toHaveLength(1);
    expect(r.meta.attempts[0].outcome).toBe('REJECTED');
  });
});

describe('P35 G2 — failover policy (provider normalization, never an agent decision) [MOCK-controlled]', () => {
  it('[5] primary success → used; no fallback; attempts = [railcore:DATA]', async () => {
    const r: any = await chain().checkAvailability(AV);
    expect(r.ok).toBe(true);
    expect(r.meta).toMatchObject({ providerId: 'railcore', fallbackUsed: false });
    expect(r.meta.attempts.map((a: any) => `${a.provider}:${a.outcome}`)).toEqual(['railcore:DATA']);
  });

  it.each([['timeout', 'TIMEOUT'], ['http500', 'PROVIDER_FAILURE'], ['http429', 'PROVIDER_FAILURE'], ['malformed', 'MALFORMED_DATA'], ['network', 'PROVIDER_FAILURE']] as const)(
    '[6] primary %s → RailKit skipped (NOT_CONFIGURED) → RailRadar serves; fallbackUsed, honest attempt trail', async (fault, outcome) => {
      T.fault.railcore = fault;
      const r: any = await chain().checkAvailability(AV);
      expect(r.ok).toBe(true);
      expect(r.meta).toMatchObject({ providerId: 'railradar', fallbackUsed: true });
      expect(r.meta.attempts.map((a: any) => `${a.provider}:${a.outcome}`)).toEqual([`railcore:${outcome}`, 'railkit:NOT_CONFIGURED', 'railradar:DATA']);
      expect(r.data.status).toMatch(/^WL\s?32$/);           // RailRadar's own snapshot — never merged with RailCore's
      noSecret(r);
    });

  it('[7] unsupported capability on the primary (PNR on RailCore) → skipped without a call; RailRadar answers', async () => {
    T.fault.railradar = 'notFound';
    const r: any = await chain().checkPNR({ pnr: '1234567890' });
    // capability is checked before configuration: RailKit does not declare PNR → UNSUPPORTED (no call either way)
    expect(r.meta.attempts.map((a: any) => `${a.provider}:${a.outcome}`)).toEqual(['railcore:UNSUPPORTED', 'railkit:UNSUPPORTED', 'railradar:NO_RESULTS']);
    expect(T.calls.filter(c => c.provider === 'railcore')).toHaveLength(0);
  });

  it('[8] NO_RESULTS is a valid answer → NO fallback (empty search / 404 NO_TRAINS_FOUND)', async () => {
    T.fault.railcore = 'emptySearch';
    const a: any = await chain().searchTrains({ origin: 'ASR', destination: 'NDLS', date: D });
    expect(a.meta.attempts.map((x: any) => `${x.provider}:${x.outcome}`)).toEqual(['railcore:NO_RESULTS']);
    expect(T.calls.some(c => c.provider === 'railradar')).toBe(false);
    T.reset(); T.fault.railcore = 'notFound';
    const b: any = await chain().searchTrains({ origin: 'ASR', destination: 'NDLS', date: D });
    expect(b.ok).toBe(false);
    expect(b.meta.attempts.map((x: any) => `${x.provider}:${x.outcome}`)).toEqual(['railcore:NO_RESULTS']);
    expect(toolOutcomeOf({ ok: false, code: b.error.code })).toBe('NO_RESULTS');
  });

  it('[9] provider validation error (400) → REJECTED; no fallback; structured error', async () => {
    T.fault.railcore = 'badRequest';
    const r: any = await chain().checkAvailability(AV);
    expect(r.ok).toBe(false);
    expect(r.meta.attempts.map((x: any) => `${x.provider}:${x.outcome}`)).toEqual(['railcore:REJECTED']);
    expect(T.calls.some(c => c.provider === 'railradar')).toBe(false);
  });

  it('[10] every provider fails → the first REAL failure is reported (never NO_RESULTS); retryable', async () => {
    T.fault.railcore = 'http500'; T.fault.railradar = 'timeout';
    const r: any = await chain().checkAvailability(AV);
    expect(r.ok).toBe(false);
    expect(r.meta.attempts.map((x: any) => `${x.provider}:${x.outcome}`)).toEqual(['railcore:PROVIDER_FAILURE', 'railkit:NOT_CONFIGURED', 'railradar:TIMEOUT']);
    expect(['NO_RESULTS', 'NOT_FOUND', 'NO_TRAINS_FOUND']).not.toContain(r.error.code);
    expect(toolOutcomeOf({ ok: false, code: r.error.code })).not.toBe('NO_RESULTS');
    expect(r.error.retryable).toBe(true);
  });

  it('[11] no provider configured → PROVIDER_UNAVAILABLE (not "no trains"); none capable → TOOL_NOT_IMPLEMENTED', async () => {
    const r: any = await chain({ RAILCORE_API_KEY: undefined, RAILRADAR_API_KEY: undefined }).searchTrains({ origin: 'ASR', destination: 'NDLS', date: D });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(T.calls).toHaveLength(0);
    const p: any = await chain({ RAILWAY_FALLBACK_PROVIDERS: 'railkit' }).checkPNR({ pnr: '1234567890' });
    expect(p.error.code).toBe('TOOL_NOT_IMPLEMENTED');
  });

  it('[12] chain budget bounds the turn: a hanging primary leaves time for the fallback; total < tool timeout', async () => {
    T.fault.railcore = 'timeout';
    const t0 = Date.now();
    const r: any = await chain({ RAILWAY_PROVIDER_TIMEOUT_MS: '200', RAILWAY_FAILOVER_BUDGET_MS: '1000' }).getFare({ ...AV, passengersCount: 1 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(r.ok && r.meta.providerId).toBe('railradar');
    expect(liveTimeouts({}).budgetMs).toBeLessThanOrEqual(7500);                 // fits the 8000 ms live-service timeout
    expect(liveTimeouts({ RAILWAY_TOOL_TIMEOUT_MS: '9000' }).budgetMs).toBeLessThan(9000);
  });

  it('[13] freshness: two identical requests → two provider calls (no cross-turn cache; fallback is not a cache)', async () => {
    const c = chain();
    await c.checkAvailability(AV); await c.checkAvailability(AV);
    expect(T.calls.filter(x => x.path.endsWith('/availability/seats'))).toHaveLength(2);
  });

  it('[14] attemptOutcome classification is honest', () => {
    const m = { source: 'railway-provider', providerId: 'x', requestTimestamp: '', responseTimestamp: '', latencyMs: 1, cache: 'disabled' } as any;
    expect(attemptOutcome({ ok: true, data: { trains: [] }, meta: m } as any, 'searchTrains')).toBe('NO_RESULTS');
    expect(attemptOutcome({ ok: false, error: { code: 'TOOL_TIMEOUT', message: '' }, meta: m } as any, 'searchTrains')).toBe('TIMEOUT');
    expect(attemptOutcome({ ok: false, error: { code: 'PROVIDER_DATA_INVALID', message: '' }, meta: m } as any, 'getFare')).toBe('MALFORMED_DATA');
  });
});

describe('P35 G2 — config, registry, observability, secrecy [MOCK-controlled]', () => {
  it('[15] chain parsing, unknown ids rejected, status view never contains keys', () => {
    expect(parseProviderChain({})).toEqual(['railcore', 'railkit', 'railradar']);
    expect(parseProviderChain({ RAILWAY_FALLBACK_PROVIDERS: '' })).toEqual(['railcore']);
    expect(() => parseProviderChain({ RAILWAY_PRIMARY_PROVIDER: 'scraper' })).toThrow();
    const st = liveProviderStatus(env());
    expect(st.find(p => p.provider === 'RAILCORE')).toMatchObject({ priority: 1, configured: true });
    expect(st.find(p => p.provider === 'RAILKIT')).toMatchObject({ priority: 2, configured: false });
    noSecret(st);
    const reg = new RailwayProviderRegistry();
    expect(() => reg.setActive('nope')).toThrow();
  });

  it('[16] LLM view: served provider (uppercase), fallbackUsed, compact attempts; nothing for mock calls', () => {
    const v = providerViewOf({ provider: 'railradar', fallbackUsed: true, providerAttempts: [{ provider: 'railcore', attempt: 1, outcome: 'TIMEOUT', errorCode: 'TOOL_TIMEOUT', httpStatus: null, latencyMs: 300, retryable: true }, { provider: 'railradar', attempt: 2, outcome: 'DATA', errorCode: null, httpStatus: null, latencyMs: 40, retryable: false }] } as any);
    expect(v).toEqual({ provider: 'RAILRADAR', fallbackUsed: true, providerAttempts: [{ provider: 'RAILCORE', outcome: 'TIMEOUT', errorCode: 'TOOL_TIMEOUT' }, { provider: 'RAILRADAR', outcome: 'DATA', errorCode: null }] });
    expect(providerViewOf({ provider: 'mock' } as any)).toEqual({});
    expect(dataSourceOf({ source: 'railway-provider' })).toBe('LIVE');
    expect(dataSourceOf({ source: 'mock' })).toBe('MOCK');
    expect(dataSourceOf({ source: 'web_external' })).toBe('WEB_EXTERNAL');
  });
});

describe('P35 G2 — WEB_EXTERNAL authority boundary [MOCK-controlled]', () => {
  it('[17] web research is disabled by default; not LLM-callable; registry entry honest', () => {
    expect(webResearchEnabledFromEnv({})).toBe(false);
    expect(webResearchEnabledFromEnv({ WEB_RESEARCH_ENABLED: 'true' })).toBe(false);                 // no key → off
    expect(REGISTERED_TOOLS.map(t => t.name)).not.toContain('WEB_RAILWAY_RESEARCH');
    expect(llmCallableTools().map(t => t.name)).not.toContain('WEB_RAILWAY_RESEARCH');
    expect(RAILWAY_TOOL_REGISTRY.get('WEB_RAILWAY_RESEARCH')).toMatchObject({ enabled: false, llmCallable: false, outputSchema: { source: 'WEB_EXTERNAL' } });
    expect(JSON.stringify(webResearchStatus({ WEB_RESEARCH_API_KEY: 'tvly-SECRET-x' }))).not.toContain('tvly-SECRET-x');
  });

  it('[18] trusted sources only, official first, third-party labelled SECONDARY; untrusted / http dropped', () => {
    const r = normalizeWebResults([
      { url: 'https://www.confirmtkt.com/x', title: 'CT', content: 'a' },
      { url: 'https://randomblog.example/x', title: 'blog', content: 'b' },
      { url: 'http://www.irctc.co.in/x', title: 'insecure', content: 'c' },
      { url: 'https://enquiry.indianrail.gov.in/mntes', title: 'NTES', content: 'd' }
    ]);
    expect(r.map(x => [x.domain, x.sourceTier])).toEqual([['enquiry.indianrail.gov.in', 'OFFICIAL'], ['confirmtkt.com', 'SECONDARY']]);
    expect(tierOf('railyatri.in')).toBe('SECONDARY');
    expect(tierOf('evil-irctc.co.in.example')).toBe(null);
  });

  it('[19] queries never carry PNRs or credentials', () => {
    expect(validateWebQuery('PNR 1234567890 status').ok).toBe(false);
    expect(validateWebQuery('irctc otp kaise milega').ok).toBe(false);
    expect(validateWebQuery('tatkal booking timing rules')).toEqual({ ok: true, query: 'tatkal booking timing rules' });
  });

  it('[20] Tavily search (mocked HTTP) → WEB_EXTERNAL + NOT_AUTHORITATIVE + Bearer auth; failures honest', async () => {
    let seen: any;
    const svc = new TavilyWebResearchService({ apiKey: 'tvly-SECRET-x', fetchImpl: (async (u: any, i: any) => { seen = { u, i }; return new Response(JSON.stringify({ results: [{ url: 'https://www.irctc.co.in/rules', title: 'Rules', content: 'Tatkal opens at 10:00' }] }), { status: 200 }); }) as any });
    const r: any = await svc.search('tatkal timing');
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ dataSource: 'WEB_EXTERNAL', authority: 'NOT_AUTHORITATIVE' });
    expect(r.meta.source).toBe('web_external');
    expect(seen.i.headers.Authorization).toBe('Bearer tvly-SECRET-x');
    expect(JSON.parse(seen.i.body).include_domains).toEqual(expect.arrayContaining(['irctc.co.in', 'confirmtkt.com']));
    expect(JSON.stringify(r)).not.toContain('tvly-SECRET-x');
    const down = new TavilyWebResearchService({ apiKey: 'k', fetchImpl: (async () => new Response('x', { status: 503 })) as any });
    expect((await down.search('q q q') as any).error.code).toBe('PROVIDER_UNAVAILABLE');
    expect((await new TavilyWebResearchService({}).search('q q q') as any).error.code).toBe('TOOL_NOT_IMPLEMENTED');
  });

  it('[21] web data never authorizes train numbers or ₹ amounts (P16 fact guard ignores WEB steps)', () => {
    const web = { status: 'ok', result: { toolName: 'WEB_RAILWAY_RESEARCH', data: { results: [{ snippet: 'Train 12345 fare ₹999' }] } } } as any;
    const g = guardResponseFacts('Train 12345 ka fare ₹999 hai.', { session: {} as any, steps: [web], records: [] } as any);
    expect(g.rejected.join(' ')).toMatch(/TRAIN:12345|FARE:999/);
    const rail = { status: 'ok', result: { toolName: 'GET_TRAIN_INFO', data: { trainNumber: '12345' } } } as any;
    expect(guardResponseFacts('Train 12345 chalti hai.', { session: {} as any, steps: [rail], records: [] } as any).rejected).toEqual([]);
  });
});

describe('P35 G2 — live voice providers (OpenAI-compatible; mocked HTTP) [MOCK-controlled]', () => {
  const VENV = { VOICE_STT_PROVIDER: 'openai_compatible', VOICE_STT_BASE_URL: 'https://stt.fake.test/v1', VOICE_STT_MODEL: 'whisper-x', VOICE_STT_API_KEY: 'stt-SECRET-1',
    VOICE_TTS_PROVIDER: 'openai_compatible', VOICE_TTS_BASE_URL: 'https://tts.fake.test/v1', VOICE_TTS_MODEL: 'tts-x', VOICE_TTS_VOICE: 'nova', VOICE_TTS_API_KEY: 'tts-SECRET-2' };

  it('[22] not configured by default → browser transport; status never leaks keys', () => {
    expect(createServerSTT({})).toBeNull();
    expect(createServerTTS({})).toBeNull();
    const st = voiceProviderStatus(VENV as any);
    expect(st.stt).toMatchObject({ provider: 'OPENAI_COMPATIBLE', configured: true, model: 'whisper-x' });
    expect(st.tts).toMatchObject({ provider: 'OPENAI_COMPATIBLE', configured: true, voice: 'nova' });
    expect(JSON.stringify(st)).not.toMatch(/SECRET/);
  });

  it('[23] STT: multipart /audio/transcriptions with model + language; transcript trimmed; errors mapped', async () => {
    let seen: any;
    const stt = createServerSTT(VENV as any, (async (u: any, i: any) => { seen = { u, i }; return new Response(JSON.stringify({ text: '  Kal Amritsar se Delhi jaana hai ' }), { status: 200 }); }) as any)!;
    const r = await stt.transcribe(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }), 'hi-IN', 'audio/webm');
    expect(r).toMatchObject({ transcript: 'Kal Amritsar se Delhi jaana hai', isFinal: true });
    expect(seen.u).toBe('https://stt.fake.test/v1/audio/transcriptions');
    expect(seen.i.headers.Authorization).toBe('Bearer stt-SECRET-1');
    expect((seen.i.body as FormData).get('model')).toBe('whisper-x');
    expect((seen.i.body as FormData).get('language')).toBe('hi');
    const empty = createServerSTT(VENV as any, (async () => new Response(JSON.stringify({ text: ' ' }), { status: 200 })) as any)!;
    await expect(empty.transcribe(new Blob([new Uint8Array([1])]), 'hi')).rejects.toMatchObject({ code: 'VOICE_EMPTY_TRANSCRIPT' });
    const down = createServerSTT(VENV as any, (async () => new Response('x', { status: 500 })) as any)!;
    await expect(down.transcribe(new Blob([new Uint8Array([1])]), 'hi')).rejects.toMatchObject({ code: 'VOICE_PROVIDER_FAILURE' });
    await expect(new OpenAICompatibleSTT({}).transcribe(new Blob([new Uint8Array([1])]), 'hi')).rejects.toBeInstanceOf(VoiceProviderError);
  });

  it('[24] TTS: /audio/speech with model + voice + exact text; audio bytes; bounded input; errors mapped', async () => {
    let body: any;
    const tts = createServerTTS(VENV as any, (async (_u: any, i: any) => { body = JSON.parse(i.body); return new Response(new Uint8Array([9, 9, 9]), { status: 200 }); }) as any)!;
    const a = await tts.synthesize('12014 mein CC ka status WL 30 hai.', 'hi-IN');
    expect(a!.byteLength).toBe(3);
    expect(body).toMatchObject({ model: 'tts-x', voice: 'nova', input: '12014 mein CC ka status WL 30 hai.' });
    const fail = new OpenAICompatibleTTS({ baseUrl: 'https://t', model: 'm', apiKey: 'k', fetchImpl: (async () => new Response('', { status: 401 })) as any });
    await expect(fail.synthesize('hi', 'hi')).rejects.toMatchObject({ code: 'VOICE_PROVIDER_FAILURE' });
    expect(() => decodeAudioBase64('not base64 !!')).toThrow(VoiceProviderError);
    expect(decodeAudioBase64(Buffer.from([1, 2]).toString('base64')).length).toBe(2);
  });
});
