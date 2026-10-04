/**
 * PROMPT 35 — G3 [MOCK-CONTROLLED]: the FULL agent stack on top of the LIVE provider chain
 *   user → ConversationTurnEngine → orchestrator → native OpenAI-compatible adapter (FakeOpenAI: the "LLM" makes every
 *   decision) → validator → RailwayToolRuntime → FailoverRailwayProvider → RailCore / RailKit / RailRadar adapters.
 * Provider HTTP is a controlled transport replaying REAL captured samples (tests/fixtures/p35). No network, no
 * credits, no real booking. These are MOCK-controlled results — never reported as LIVE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { createFailoverProvider } from '../../server/railway/providers/live/live-config';
import { setWebResearchService } from '../../server/research/web-research-service';
import { registerVoiceRoutes } from '../../server/voice/live/voice-routes';
import { createServerSTT, createServerTTS } from '../../server/voice/live/openai-compatible-voice';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { fixtureTransport, P35_TEST_ENV } from '../helpers/p35-fixture-fetch';
import { BookingState } from '../../shared/states';

const T = fixtureTransport();
railwayRegistry.register('p35-live-controlled', () => createFailoverProvider(P35_TEST_ENV(), T.fetch));
const KEY = 'sk-live-P35-E2E-SECRET-35353';
const SECRETS = [KEY, 'rc-TEST-SECRET-35a', 'rr-TEST-SECRET-35b'];
const webSpy = { name: 'MOCK-WEB', configured: () => true, search: vi.fn(async () => ({ ok: false, error: { code: 'TOOL_NOT_IMPLEMENTED', message: 'x' }, meta: {} as any })) };

const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SRCH = (date: string) => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const AVL = (date = 'kal') => ({ name: 'CHECK_AVAILABILITY', args: { trainNumber: '12014', travelClass: 'CC', date } });
const FARE = (date = 'kal') => ({ name: 'GET_FARE', args: { trainNumber: '12014', travelClass: 'CC', date, passengersCount: 1 } });
const BOOK = 'Doosri wali CC, do log: Rahul 31 male, Neha 28 female';
const CONFIRM = U('CONFIRM_BOOKING', 'PREPARE_IRCTC_HANDOFF', { affirmation: true });
const PLAN: Record<string, any[]> = {
  'RAC kya hota hai?': [{ content: 'RAC matlab Reservation Against Cancellation — aadhi berth share karke safar.' }],
  'Kal Amritsar se Delhi jaana hai': [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye trainein mil gayi hain. Kaunsi dekhni hai?' }],
  // the LLM resolves "doosri wali" and selects (validated by the backend), then checks availability for that selection
  'Doosri wali ka CC availability batao': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, classRaw: 'CC' })] }, { calls: [AVL()] }, { content: 'Availability dekh li.' }],
  'Uska fare batao': [{ calls: [FARE()] }, { content: 'Fare dekh liya.' }],
  'Abhi dobara availability check karo': [{ calls: [AVL()] }, { content: 'Dobara check kiya.' }],
  'Kal nahi, parso': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso' }), SRCH('parso')] }, { content: 'Parso ki trainein dekh li.' }],
  'web pe dekho': [{ calls: [{ name: 'WEB_RAILWAY_RESEARCH', args: { query: 'tatkal rules' } }] }, { content: 'Web research abhi uplabdh nahi hai.' }],
  'Doosri wali CC, do log: Rahul 31 male, Neha 28 female': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, classRaw: 'CC', passengersCountRaw: '2', selectionPurpose: 'BOOKING',
    passengerChanges: [{ passengerIndex: 1, changes: { name: 'Rahul', age: 31, gender: 'male' } }, { passengerIndex: 2, changes: { name: 'Neha', age: 28, gender: 'female' } }] })] }, { content: 'Review ready.' }],
  'haan confirm': [{ calls: [CONFIRM] }, { content: 'Details confirmed; handoff ready. Ticket abhi book nahi hua hai.' }],
  'ab book kar do': [{ calls: [U('CONFIRM_BOOKING', 'PREPARE_IRCTC_HANDOFF', { affirmation: true, executionRequested: true })] }, { content: 'Theek hai.' }],
  'EC kar do': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12014' }, classRaw: 'EC', selectionPurpose: 'BOOKING' })] }, { content: 'EC kar diya.' }]
};

const outputs: string[] = [];
function stack() {
  const fake = new FakeOpenAI((v: TurnView) => { const p = PLAN[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 2500, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = async (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => { const r: any = await eng.processTurn(sid, t, mode); outputs.push(JSON.stringify({ r, s: state.getSession(sid) })); return r; };
  return { eng, orch, sid, say, fake, state, s: () => state.getSession(sid) as any };
}
/** Tool messages the LLM received in its LAST decision request (exact wire content). */
const toolMsgs = (fake: FakeOpenAI) => {
  const req = fake.decisionRequests[fake.decisionRequests.length - 1];
  return (req.body.messages as any[]).filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
};
const recs = (r: any) => (r.turnLog?.toolExecutions || r.turnLog?.diagnostics?.toolExecutions || []) as any[];
const toolsOf = (r: any) => (r.turnLog.diagnostics.tools || []) as any[];
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage, r.voice?.speechText].map(x => String(x ?? '')).join(' | ');
const NO_SUCCESS = /book ho gayi|booking confirmed|booked successfully|PNR\s*\d{6,}|transaction id/i;
const AVAILABLE = (b: any) => ({ ...b, data: { ...b.data, classes: b.data.classes.map((c: any) => ({ ...c, status: 'AVAILABLE', availability_text: 'AVAILABLE-0040', available_count: 40, waitlist_count: 0, wl_pool: null, wl_pool_position: null })) } });

let fetchSpy: any, handoffSpy: any;
const realFetch = globalThis.fetch.bind(globalThis);
beforeEach(() => {
  railwayRegistry.setActive('p35-live-controlled');
  T.reset(); webSpy.search.mockClear(); setWebResearchService(webSpy as any);
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => {
    if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i);
    throw new Error(`NO NETWORK IN TESTS: ${u}`);
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); setWebResearchService(null); railwayRegistry.setActive('mock'); });

describe('P35 G3 — LLM-driven conversation on the live provider chain [MOCK-controlled]', () => {
  it('[A] "RAC kya hota hai?" → no tool, no provider call', async () => {
    const h = stack();
    const r = await h.say('RAC kya hota hai?');
    expect(toolsOf(r)).toHaveLength(0);
    expect(T.calls).toHaveLength(0);
  });

  it('[B] search → RailCore answers; provenance LIVE/railcore; LLM sees provider + attempts; session origin/destination are station codes', async () => {
    const h = stack();
    const r = await h.say('Kal Amritsar se Delhi jaana hai');
    expect(T.calls.map(c => c.provider)).toEqual(['railcore']);
    expect(h.s().searchResults.trains.map((t: any) => t.trainNumber)).toEqual(expect.arrayContaining(['12014', '22126']));
    const tm = toolMsgs(h.fake).find(m => m.outcome);
    expect(tm).toMatchObject({ outcome: 'DATA', dataSource: 'LIVE', provider: 'RAILCORE', fallbackUsed: false });
    expect(tm.providerAttempts).toEqual([{ provider: 'RAILCORE', outcome: 'DATA', errorCode: null }]);
    const t = toolsOf(r).find((x: any) => x.tool === 'SEARCH_TRAINS');
    expect(t).toBeTruthy();
    expect(JSON.stringify(r.turnLog)).not.toMatch(/"provider":"unknown"/);
  });

  it('[C] availability uses the SESSION segment (ASR→NDLS), not an LLM argument; observability record has provider/outcome/dataSource/freshness', async () => {
    const h = stack();
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('Doosri wali ka CC availability batao');
    const call = T.calls.find(c => c.path.endsWith('/availability/seats'))!;
    expect(call.query).toMatch(/from=ASR/); expect(call.query).toMatch(/to=NDLS/); expect(call.query).toMatch(/class=CC/);
    const tm = toolMsgs(h.fake).find(m => m.outcome);
    expect(tm).toMatchObject({ outcome: 'DATA', dataSource: 'LIVE', provider: 'RAILCORE' });
    const log = JSON.stringify(r.turnLog);
    expect(log).toMatch(/"dataSource":"LIVE"/);
    for (const k of SECRETS) expect(log).not.toContain(k);
  });

  it('[D] fare → RailCore seat fare ₹1125 (authorized by GET_FARE only)', async () => {
    const h = stack();
    await h.say('Kal Amritsar se Delhi jaana hai');
    await h.say('Doosri wali ka CC availability batao');
    await h.say('Uska fare batao');
    const tm = toolMsgs(h.fake).find(m => m.outcome);
    expect(tm).toMatchObject({ outcome: 'DATA', provider: 'RAILCORE' });
    expect(JSON.stringify(tm)).toMatch(/1125/);
  });

  it('[F] "Kal nahi, parso" → fresh search for the new date (LLM-decided), provider called again with the new date', async () => {
    const h = stack();
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n = T.calls.length;
    await h.say('Kal nahi, parso');
    const later = T.calls.slice(n).filter(c => c.path.endsWith('/routes/trains'));
    expect(later).toHaveLength(1);
    expect(later[0].query).toContain(`date=${h.s().date}`);
  });

  it('[G] "Abhi dobara availability check karo" → a NEW provider call (no cache)', async () => {
    const h = stack();
    await h.say('Kal Amritsar se Delhi jaana hai');
    await h.say('Doosri wali ka CC availability batao');
    await h.say('Abhi dobara availability check karo');
    expect(T.calls.filter(c => c.path.endsWith('/availability/seats'))).toHaveLength(2);
  });
});

describe('P35 G3 — failover visible to the agent, never an agent decision [MOCK-controlled H/I/J]', () => {
  it('[H] primary 5xx → RailRadar serves; LLM told provider RAILRADAR + fallbackUsed; NO extra LLM call', async () => {
    const h = stack();
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n0 = h.fake.requests.length;
    T.fault.railcore = 'http500';
    await h.say('Doosri wali ka CC availability batao');
    const tm = toolMsgs(h.fake).find(m => m.outcome);
    expect(tm).toMatchObject({ outcome: 'DATA', dataSource: 'LIVE', provider: 'RAILRADAR', fallbackUsed: true });
    expect(tm.providerAttempts.map((a: any) => `${a.provider}:${a.outcome}`)).toEqual(['RAILCORE:PROVIDER_FAILURE', 'RAILKIT:NOT_CONFIGURED', 'RAILRADAR:DATA']);
    expect(h.fake.requests.length - n0).toBe(PLAN['Doosri wali ka CC availability batao'].length);   // fallback never triggers an LLM call
    expect(h.fake.wordingRequests).toHaveLength(0);
  });

  it('[I] every provider fails → honest failure outcome (never NO_RESULTS / "no seats"); backend never auto-launches web research', async () => {
    const h = stack();
    await h.say('Kal Amritsar se Delhi jaana hai');
    T.fault.railcore = 'timeout'; T.fault.railradar = 'http500';
    const r = await h.say('Doosri wali ka CC availability batao');
    const tm = toolMsgs(h.fake).find(m => m.outcome || m.errorType);
    expect(['TIMEOUT', 'PROVIDER_FAILURE']).toContain(tm.outcome);
    expect(tm.outcome).not.toBe('NO_RESULTS');
    expect(webSpy.search).not.toHaveBeenCalled();
    expect(shown(r)).not.toMatch(/seat(s)? nahi|full hai|koi seat/i);
  });

  it('[J] NO_RESULTS from the primary is final (no fallback call)', async () => {
    const h = stack();
    T.fault.railcore = 'emptySearch';
    await h.say('Kal Amritsar se Delhi jaana hai');
    expect(T.calls.map(c => c.provider)).toEqual(['railcore']);
    const tm = toolMsgs(h.fake).find(m => m.outcome);
    expect(tm.outcome).toBe('NO_RESULTS');
  });

  it('[W] WEB_RAILWAY_RESEARCH while disabled → rejected before execution (no web call, no fake web data)', async () => {
    const h = stack();
    await h.say('web pe dekho');
    expect(webSpy.search).not.toHaveBeenCalled();
    expect(T.calls).toHaveLength(0);
  });
});

describe('P35 G3 — booking up to the IRCTC handoff on live data [MOCK-controlled L, steps 1–12]', () => {
  it('[L] select → class → passenger → fresh availability → fresh fare → review → explicit confirm (review-bound) → handoff; not reusable; change invalidates; expiry', async () => {
    const h = stack();
    T.patch['railcore-availability'] = AVAILABLE;
    await h.say('Kal Amritsar se Delhi jaana hai');                                         // (1) trains from RailCore
    const n0 = T.calls.length;
    const rv = await h.say(BOOK);                                                           // (1)(2)(3) train, class, passengers
    const fresh = T.calls.slice(n0).map(c => c.path);
    expect(fresh.filter(p => p.endsWith('/availability/seats')).length).toBeGreaterThanOrEqual(1);   // (4)(5) fresh availability + fare at the review boundary
    expect(h.s().review?.snapshot).toMatchObject({ reviewVersion: 1, travelClass: 'CC', train: { number: '12014' } });   // (6)
    expect(h.s().review.snapshot.fare.total).toBe(2250);                                     // 2 × ₹1125 from the provider fare
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(shown(rv)).not.toMatch(NO_SUCCESS);

    const c = await h.say('haan confirm');                                                   // (7) explicit confirmation tied to review v1
    expect(h.s().confirmation).toMatchObject({ reviewVersion: 1, status: 'VALID' });
    expect(h.s().bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);                    // (8) handoff created
    expect(h.s().handoffSession.status).toBe('READY');
    expect(shown(c)).not.toMatch(NO_SUCCESS);

    const ex = await h.say('ab book kar do');                                                // execution request → disabled, said verbatim
    expect(ex.error?.code).toBe('BOOKING_EXECUTION_DISABLED');
    expect(shown(ex)).toMatch(/Booking execution abhi enabled nahi hai/);
    expect(shown(ex)).not.toMatch(NO_SUCCESS);

    const id = h.s().handoffSession.handoffSessionId;
    const pctx = () => ({ turnId: 't', mode: 'TEXT' as const, cards: [], events: [] as string[], changes: [] as string[] });
    const first: any = await h.orch.preparation.consumeHandoff(h.sid, id, pctx() as any);
    expect(first).toMatchObject({ ok: false, code: 'BOOKING_EXECUTION_DISABLED' });
    const second: any = await h.orch.preparation.consumeHandoff(h.sid, id, pctx() as any);   // (9) not reusable
    expect(second.ok).toBe(false);
    expect(second.duplicate === true || second.executorAttempted === false).toBe(true);
    expect(h.s().bookingExecution?.pnr ?? null).toBeNull();                                  // never a fabricated PNR

    await h.say('EC kar do');                                                                // (10) change invalidates
    expect(h.s().handoffSession.status).toBe('INVALIDATED');
    expect(h.s().confirmation.status).toBe('INVALIDATED');
    expect((await h.orch.preparation.consumeHandoff(h.sid, id, pctx() as any) as any).ok).toBe(false);
    expect(handoffSpy).not.toHaveBeenCalled();
  });

  it('[L-exp] (11)(12) an expired handoff is never reusable', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = stack();
    T.patch['railcore-availability'] = AVAILABLE;
    await h.say('Kal Amritsar se Delhi jaana hai');
    await h.say(BOOK);
    await h.say('haan confirm');
    const id = h.s().handoffSession.handoffSessionId;
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(h.orch.preparation.handoffSessions.check(h.s(), Date.now())).toMatchObject({ status: 'EXPIRED' });
    expect(await h.orch.preparation.consumeHandoff(h.sid, id, { turnId: 't', mode: 'TEXT', cards: [], events: [], changes: [] } as any)).toMatchObject({ ok: false, code: 'HANDOFF_SESSION_EXPIRED', executorAttempted: false });
  });
});

describe('P35 G3 — voice parity + server STT/TTS transport [MOCK-controlled K]', () => {
  it('[K1] same transcript in TEXT and VOICE → same tool decision, same provider, same outcome', async () => {
    const a = stack(); await a.say('Kal Amritsar se Delhi jaana hai', 'TEXT');
    const ta = toolMsgs(a.fake).find(m => m.outcome);
    const b = stack(); await b.say('Kal Amritsar se Delhi jaana hai', 'VOICE');
    const tb = toolMsgs(b.fake).find(m => m.outcome);
    expect({ o: tb.outcome, p: tb.provider, d: tb.dataSource }).toEqual({ o: ta.outcome, p: ta.provider, d: ta.dataSource });
    expect(a.s().searchResults.trains.map((t: any) => t.trainNumber)).toEqual(b.s().searchResults.trains.map((t: any) => t.trainNumber));
  });

  it('[K2] /api/voice/turn: STT → the SAME /api/chat (mode VOICE, FINAL transcript) → /api/voice/speak speaks only the latest validated reply', async () => {
    const app = Fastify();
    const seenChat: any[] = [];
    app.post('/api/chat', async (req) => { seenChat.push(req.body); return { sessionId: 's1', responseMessage: 'Kal ke liye trainein mil gayi hain.' }; });
    const VENV: any = { VOICE_STT_PROVIDER: 'openai_compatible', VOICE_STT_BASE_URL: 'https://stt.fake/v1', VOICE_STT_MODEL: 'm', VOICE_STT_API_KEY: 'stt-SECRET',
      VOICE_TTS_PROVIDER: 'openai_compatible', VOICE_TTS_BASE_URL: 'https://tts.fake/v1', VOICE_TTS_MODEL: 'm', VOICE_TTS_API_KEY: 'tts-SECRET' };
    let spoken = '';
    const stt = createServerSTT(VENV, (async () => new Response(JSON.stringify({ text: 'Kal Amritsar se Delhi jaana hai' }), { status: 200 })) as any);
    const tts = createServerTTS(VENV, (async (_u: any, i: any) => { spoken = JSON.parse(i.body).input; return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }); }) as any);
    registerVoiceRoutes(app, { stt, tts, latestSpeech: (sid) => (sid === 's1' ? { text: 'Kal ke liye trainein mil gayi hain.', turnId: 't1' } : null) });
    const turn = await app.inject({ method: 'POST', url: '/api/voice/turn', payload: { sessionId: 's1', audioBase64: Buffer.from([1, 2, 3]).toString('base64'), mimeType: 'audio/webm', language: 'hi-IN' } });
    expect(turn.statusCode).toBe(200);
    expect(seenChat[0]).toMatchObject({ text: 'Kal Amritsar se Delhi jaana hai', mode: 'VOICE', transcript: { status: 'FINAL' } });
    expect(turn.json()).toMatchObject({ responseMessage: expect.any(String), stt: { transcript: 'Kal Amritsar se Delhi jaana hai' } });
    const sp = await app.inject({ method: 'POST', url: '/api/voice/speak', payload: { sessionId: 's1', text: 'INJECTED TEXT MUST BE IGNORED' } });
    expect(sp.statusCode).toBe(200);
    expect(sp.headers['content-type']).toMatch(/audio\/mpeg/);
    expect(spoken).toBe('Kal ke liye trainein mil gayi hain.');
    expect((await app.inject({ method: 'POST', url: '/api/voice/speak', payload: { sessionId: 's1', turnId: 'old' } })).statusCode).toBe(409);
    const off = Fastify(); registerVoiceRoutes(off, { stt: null, tts: null, latestSpeech: () => null });
    const na = await off.inject({ method: 'POST', url: '/api/voice/turn', payload: { audioBase64: 'AAAA' } });
    expect(na.statusCode).toBe(503);
    expect(na.json()).toMatchObject({ error: 'VOICE_NOT_CONFIGURED', fallback: 'TEXT' });
    expect(JSON.stringify([turn.json(), na.json()])).not.toMatch(/SECRET/);
  });

  it('[S] secrets: provider + LLM keys never appear in any output, session or turn log', () => {
    const all = outputs.join('\n');
    expect(all.length).toBeGreaterThan(100);
    for (const k of SECRETS) expect(all).not.toContain(k);
  });
});
