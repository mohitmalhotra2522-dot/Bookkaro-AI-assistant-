/**
 * PROMPT 23 — GROUP 2 (unit): real OpenAI-compatible LLM adapter + agentic tool / security boundaries.
 * Native function calling against a FAKE OpenAI-compatible server (injected fetch and a real 127.0.0.1 HTTP server):
 * config, server-side key, tool definitions sent, tool calls parsed, tool results replayed, failure normalization,
 * fail-closed misconfiguration (no hidden mock / model fallback), agent-reply grounding. No credits, no external network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { FORBIDDEN_LLM_ACTIONS } from '../../shared/railway-tool-runtime';
import { OpenAICompatibleLLMProvider, nativeToolDefs, buildNativeMessages, decisionFromNative, cleanReply, SESSION_UPDATE_TOOL } from '../../server/ai/providers/openai-compatible-llm';
import { createLLMProvider, UnavailableLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { isLLMProviderError } from '../../server/ai/providers/llm-provider';
import { naturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import { parseEnvFile, loadEnvFile } from '../../server/config/env-file';
import { NATIVE_AGENT_SYSTEM_PROMPT } from '../../server/ai/prompts/system-prompt';
import { FakeOpenAI, turnView } from '../helpers/fake-openai-server';

const ROOT = path.resolve(__dirname, '../..');
const KEY = 'sk-live-P23-SECRET-9876543210';
const ENV = { LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'z-ai/glm-test', LLM_BASE_URL: 'https://llm.fake.test/v1', LLM_TIMEOUT_MS: '3000' };

const input = (o: any = {}) => ({
  userText: 'Kal Amritsar se Delhi jaana hai', history: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'Namaste! Kahan jaana hai?' }, { role: 'user', content: 'Kal Amritsar se Delhi jaana hai' }],
  state: 'IDLE', session: {}, missingFields: ['origin'], inputMode: 'TEXT', tools: REGISTERED_TOOLS, context: { sessionView: { bookingState: 'IDLE' } }, ...o
}) as any;

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any;
beforeEach(() => {
  // only the local fake server may be reached over real HTTP — everything else is forbidden
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(((url: any, init: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    throw new Error(`network forbidden in tests: ${String(url)}`);
  }) as any);
});
afterEach(() => {
  for (const c of fetchSpy.mock.calls) expect(String(c[0])).toMatch(/^http:\/\/127\.0\.0\.1:/);
  fetchSpy.mockRestore();
});

describe('P23 G2 — real OpenAI-compatible adapter (native tool calling)', () => {
  it('[1] adapter config: env-only, native tool calling by default, JSON mode opt-in; mock when absent; misconfiguration fails CLOSED (no hidden mock)', async () => {
    expect(createLLMProvider({}).info).toMatchObject({ providerId: 'mock-llm', reason: 'DEFAULT_MOCK' });
    const sel = createLLMProvider(ENV);
    expect(sel.info).toEqual({ providerId: 'openai-compatible', model: 'z-ai/glm-test', configured: true, reason: 'ENV_CONFIGURED' });
    const p: any = sel.provider;
    expect(p.toolMode).toBe('native');
    expect(p.agentAuthoredReplies).toBe(true);
    expect(p.cfg.timeoutMs).toBe(3000);
    expect(p.cfg.baseUrl).toBe('https://llm.fake.test/v1');
    expect((createLLMProvider({ ...ENV, LLM_TOOL_MODE: 'json' }).provider as any).agentAuthoredReplies).toBe(false);
    expect((createLLMProvider({ ...ENV, LLM_TIMEOUT_MS: '999999' }).provider as any).cfg.timeoutMs).toBe(8000);   // clamped default
    expect(new MockLLMProvider() as any).not.toHaveProperty('agentAuthoredReplies');
    // requested but misconfigured → an always-unavailable provider (never MockLLM, never another model)
    const cases: Array<[Record<string, string>, string]> = [
      [{ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm' }, 'MISSING_LLM_API_KEY'],
      [{ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY }, 'MISSING_LLM_MODEL'],
      [{ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'm', LLM_BASE_URL: 'ftp://x' }, 'INVALID_LLM_BASE_URL'],
      [{ LLM_PROVIDER: 'anthropic-ish', LLM_API_KEY: KEY, LLM_MODEL: 'm' }, 'UNKNOWN_LLM_PROVIDER']
    ];
    for (const [env, reason] of cases) {
      const s = createLLMProvider(env);
      expect(s.info).toEqual({ providerId: 'llm-unavailable', model: null, configured: false, reason });
      expect(s.provider).toBeInstanceOf(UnavailableLLMProvider);
      expect(s.provider).not.toBeInstanceOf(MockLLMProvider);
      const err = await s.provider.generateStructuredDecision(input()).catch(e => e);
      expect(isLLMProviderError(err) && err.code).toBe('LLM_NOT_CONFIGURED');
      expect(JSON.stringify(s.info)).not.toContain(KEY);
    }
  });

  it('[2] server-side key handling: .env loader never overrides real env; .env gitignored + untracked; example has no key; frontend never reads env', () => {
    expect(parseEnvFile('# c\nexport A=1\nB="two words"\nC=x # trailing\n\nbad line\nD=\'q\'')).toEqual({ A: '1', B: 'two words', C: 'x', D: 'q' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p23env-'));
    fs.writeFileSync(path.join(dir, '.env'), 'LLM_MODEL=from-file\nLLM_API_KEY=file-key\n');
    const env: Record<string, string | undefined> = { LLM_MODEL: 'from-real-env' };
    expect(loadEnvFile(path.join(dir, '.env'), env)).toEqual(['LLM_API_KEY']);
    expect(env).toEqual({ LLM_MODEL: 'from-real-env', LLM_API_KEY: 'file-key' });
    expect(loadEnvFile(path.join(dir, 'missing.env'), env)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
    // the server loads .env before anything reads process.env (first import), keys stay server-side
    const main = fs.readFileSync(path.join(ROOT, 'server/main.ts'), 'utf8');
    expect(main.split('\n').find(l => l.startsWith('import '))).toBe("import './config/load-dotenv';");
    expect(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/)).toContain('.env');
    expect(() => execSync('git ls-files --error-unmatch .env', { cwd: ROOT, stdio: 'pipe' })).toThrow();   // never tracked
    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    expect(example).toMatch(/LLM_PROVIDER/);
    expect(example).not.toMatch(/nvapi-|sk-[A-Za-z0-9]{10,}/);
    const src = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true } as any).filter((f: any) => /\.(ts|tsx)$/.test(String(f)));
    for (const f of src) expect(fs.readFileSync(path.join(ROOT, 'src', String(f)), 'utf8')).not.toMatch(/LLM_API_KEY|LLM_BASE_URL|process\.env|nvapi-/);
  });

  it('[3] tool definitions reach the LLM: the 7 implemented railway tools + the session proposal, as JSON schema — never booking / payment / unimplemented tools', async () => {
    const fake = new FakeOpenAI(() => ({ content: 'Namaste!' }));
    const p = createLLMProvider(ENV, { fetch: fake.fetch }).provider;
    await p.generateStructuredDecision(input());
    const req = fake.requests[0];
    expect(req.url).toBe('https://llm.fake.test/v1/chat/completions');
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);                 // the key travels ONLY as the auth header
    expect(JSON.stringify(req.body)).not.toContain(KEY);
    expect(req.body.model).toBe('z-ai/glm-test');
    expect(req.body.tool_choice).toBe('auto');
    expect(req.body).not.toHaveProperty('response_format');
    const names = req.body.tools.map((t: any) => t.function.name);
    expect(names).toEqual([...REGISTERED_TOOLS.map(t => t.name), SESSION_UPDATE_TOOL]);
    expect(names).toEqual(['SEARCH_TRAINS', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE', 'TRACK_TRAIN', 'CHECK_PNR', 'update_booking_session']);
    for (const bad of [...FORBIDDEN_LLM_ACTIONS, 'BOOK_TICKET', 'MAKE_PAYMENT', 'executeBooking', 'GET_CANCELLED_TRAINS', 'GENERAL_RAILWAY_ANSWER']) expect(names).not.toContain(bad);
    for (const t of req.body.tools) { expect(t.type).toBe('function'); expect(t.function.parameters.type).toBe('object'); }
    const search = req.body.tools[0].function.parameters;
    expect(search.required).toEqual(['origin', 'destination', 'date']);
    expect(search.properties.date.description).toMatch(/never compute dates/i);   // DateResolver stays authoritative
    // messages: agent instructions, authoritative context, bounded history (no duplicate current message), the user
    const m = req.body.messages;
    expect(m[0]).toEqual({ role: 'system', content: NATIVE_AGENT_SYSTEM_PROMPT });
    expect(m[1].content).toMatch(/^AUTHORITATIVE SESSION CONTEXT/);
    expect(m.slice(2).map((x: any) => x.role)).toEqual(['user', 'assistant', 'user']);
    expect(m.filter((x: any) => x.content === 'Kal Amritsar se Delhi jaana hai')).toHaveLength(1);
    expect(nativeToolDefs({ tools: REGISTERED_TOOLS }).length).toBe(8);
  });

  it('[4] LLM tool calls are parsed as-is (ids, args, session proposal, final text); hidden reasoning is never surfaced; forbidden names reach the runtime for rejection', () => {
    const tc = (id: string, name: string, args: any) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
    const d1: any = decisionFromNative({ content: '', tool_calls: [tc('c1', 'SEARCH_TRAINS', { origin: 'Amritsar', destination: 'Delhi', date: 'kal' })], reasoning_content: 'SECRET THOUGHTS' }, input());
    expect(d1).toMatchObject({ intent: 'SEARCH_TRAINS', action: 'SEARCH_TRAINS', entities: { originRaw: 'Amritsar', destinationRaw: 'Delhi', dateRaw: 'kal' } });
    expect(d1.toolCalls).toEqual([{ callId: 'c1', name: 'SEARCH_TRAINS', arguments: { origin: 'Amritsar', destination: 'Delhi', date: 'kal' } }]);
    expect(JSON.stringify(d1)).not.toContain('SECRET THOUGHTS');
    const d2: any = decisionFromNative({ content: 'Ek second.', tool_calls: [tc('u1', SESSION_UPDATE_TOOL, { intent: 'SELECT_TRAIN', action: 'SELECT_TRAIN', entities: { trainRef: { kind: 'DISPLAY_INDEX', value: 2 } } }), tc('c2', 'CHECK_AVAILABILITY', '{bad json')] }, input());
    expect(d2).toMatchObject({ intent: 'SELECT_TRAIN', action: 'SELECT_TRAIN', entities: { trainRef: { kind: 'DISPLAY_INDEX', value: 2 } }, continueAfterApply: true, acknowledgement: 'Ek second.' });
    expect(d2.native).toMatchObject({ sessionUpdateCallId: 'u1' });
    expect(d2.toolCalls).toEqual([{ callId: 'c2', name: 'CHECK_AVAILABILITY', arguments: {} }]);   // bad args → {} (validator rejects)
    const d3: any = decisionFromNative({ content: '<think>plan: answer</think>RAC ka matlab Reservation Against Cancellation hai.' }, input());
    expect(d3).toMatchObject({ intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', entities: {}, toolCalls: [], finalMessage: 'RAC ka matlab Reservation Against Cancellation hai.' });
    const d4: any = decisionFromNative({ tool_calls: [tc('x', 'BOOK_TICKET', { train: '12014' }), tc('x', 'MAKE_PAYMENT', {})] }, input());
    expect(d4.toolCalls.map((c: any) => c.name)).toEqual(['BOOK_TICKET', 'MAKE_PAYMENT']);   // kept → runtime rejects visibly
    expect(new Set(d4.toolCalls.map((c: any) => c.callId)).size).toBe(2);                   // duplicate ids made unique
    expect(decisionFromNative({ content: '   ' }, input())).toBeNull();                        // empty → bad response
    expect(cleanReply('**Haan** 12014 hai\n- pehla\n<think>x')).toBe('Haan 12014 hai\npehla');
  });

  it('[5] tool results go back to the LLM: each step replayed as assistant tool_calls + role:"tool" messages with matching ids (bounded, unexecuted marked)', () => {
    const msgs = buildNativeMessages(input({
      agentTranscript: [
        { toolCalls: [{ callId: 's1', name: 'SEARCH_TRAINS', arguments: { origin: 'ASR' } }], results: [{ callId: 's1', toolName: 'SEARCH_TRAINS', ok: true, status: 'SUCCEEDED', data: { trains: Array.from({ length: 30 }, (_, k) => ({ trainNumber: String(12000 + k), requestId: 'rq', name: 'x'.repeat(500) })) } }] },
        { sessionUpdate: { callId: 'u1', arguments: { intent: 'SELECT_TRAIN', action: 'SELECT_TRAIN' } }, sessionUpdateOutcome: { applied: [], notes: [], error: { code: 'INVALID_TRAIN_REFERENCE', message: 'Ye train list mein nahi hai.' } },
          toolCalls: [{ callId: 'a1', name: 'CHECK_AVAILABILITY', arguments: {} }], results: [] }
      ]
    }));
    const tail = msgs.slice(5);
    expect(tail.map((m: any) => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool', 'tool']);
    expect(tail[0].tool_calls[0]).toMatchObject({ id: 's1', type: 'function', function: { name: 'SEARCH_TRAINS' } });
    expect(tail[1].tool_call_id).toBe('s1');
    const r1 = JSON.parse(tail[1].content.endsWith('…') ? '{}' : tail[1].content);
    expect(tail[1].content.length).toBeLessThanOrEqual(3501);
    expect(tail[1].content).not.toContain('requestId');
    if (r1.data) expect(r1.data.trains.length).toBeLessThanOrEqual(12);
    expect(tail[2].tool_calls.map((c: any) => c.id)).toEqual(['u1', 'a1']);
    expect(JSON.parse(tail[3].content)).toMatchObject({ ok: false, error: { code: 'INVALID_TRAIN_REFERENCE' } });
    expect(JSON.parse(tail[4].content)).toMatchObject({ ok: false, error: { code: 'NOT_EXECUTED' } });
    // every tool_call id has exactly one tool message (OpenAI wire contract)
    const ids = msgs.flatMap((m: any) => (m.tool_calls || []).map((c: any) => c.id));
    expect(msgs.filter((m: any) => m.role === 'tool').map((m: any) => m.tool_call_id)).toEqual(ids);
    const v = turnView({ messages: msgs });
    expect(v.step).toBe(2);
    expect(v.results.map(r => r.name)).toEqual(['SEARCH_TRAINS', SESSION_UPDATE_TOOL, 'CHECK_AVAILABILITY']);
  });

  it('[6] LLM failure is normalized (code + status only): auth, rate limit, HTTP, network, timeout, malformed — one request, same model, no body / key leak', async () => {
    const cases: Array<[any, string]> = [
      [{ status: 401 }, 'LLM_AUTH_ERROR'], [{ status: 429 }, 'LLM_RATE_LIMITED'], [{ status: 503 }, 'LLM_HTTP_ERROR'],
      [{ networkError: true }, 'LLM_NETWORK_ERROR']
    ];
    for (const [reply, code] of cases) {
      const fake = new FakeOpenAI(() => reply);
      const p = createLLMProvider(ENV, { fetch: fake.fetch }).provider;
      const e: any = await p.generateStructuredDecision(input()).catch(x => x);
      expect(isLLMProviderError(e) && e.code).toBe(code);
      expect(`${e.message} ${JSON.stringify(e)}`).not.toMatch(/upstream exploded|internal trace|SECRET/);
      expect(fake.requests).toHaveLength(1);                                  // no retry loop, no second model
      expect(fake.requests[0].body.model).toBe('z-ai/glm-test');
    }
    const bad = async (body: any) => {
      const p = new OpenAICompatibleLLMProvider({ apiKey: KEY, model: 'm', baseUrl: 'https://llm.fake.test/v1', timeoutMs: 1000, fetch: async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' }) });
      return (await p.generateStructuredDecision(input()).catch(x => x)).code;
    };
    expect(await bad({ choices: [] })).toBe('LLM_BAD_RESPONSE');
    expect(await bad({ choices: [{ message: { content: '' } }] })).toBe('LLM_BAD_RESPONSE');
    const slow = new OpenAICompatibleLLMProvider({ apiKey: KEY, model: 'm', baseUrl: 'https://llm.fake.test/v1', timeoutMs: 30,
      fetch: (_u, init) => new Promise((_, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted')))) });
    expect((await slow.generateStructuredDecision(input()).catch(x => x)).code).toBe('LLM_TIMEOUT');
  });

  it('[7] real HTTP round trip against a local fake OpenAI-compatible server (global fetch): tool call out, tool result back, final text', async () => {
    const fake = new FakeOpenAI(v => v.step === 0 ? { calls: [{ name: 'GET_TRAIN_INFO', args: { trainNumber: '12014' }, id: 'call_http_1' }] } : { content: `Mila: ${v.results[0].content.data.trainName}` });
    const base = await fake.listen();
    try {
      const p = createLLMProvider({ ...ENV, LLM_BASE_URL: base }).provider;         // no injected fetch → real fetch
      const d1: any = (await p.generateStructuredDecision(input({ userText: '12014 ke baare mein batao' }))).decision;
      expect(d1.toolCalls).toEqual([{ callId: 'call_http_1', name: 'GET_TRAIN_INFO', arguments: { trainNumber: '12014' } }]);
      const d2: any = (await p.generateStructuredDecision(input({ userText: '12014 ke baare mein batao', agentTranscript: [{ toolCalls: d1.toolCalls, results: [{ callId: 'call_http_1', toolName: 'GET_TRAIN_INFO', ok: true, status: 'SUCCEEDED', data: { trainNumber: '12014', trainName: 'Amritsar Shatabdi' } }] }] }))).decision;
      expect(d2.finalMessage).toBe('Mila: Amritsar Shatabdi');
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests[0].url).toBe('/v1/chat/completions');
      expect(fake.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
      expect(fake.requests[1].body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_http_1' });
    } finally { await fake.close(); }
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('[8] agent-authored general answers are validated, not rewritten: general facts pass; invented train numbers, PNRs, fares, availability, timings, booking claims are removed — no second LLM call', async () => {
    const st = new ConversationStateManager();
    const session = st.getSession(st.createSession().sessionId);
    const spoken = vi.fn(async () => ({ text: 'SHOULD NOT BE CALLED' }));
    const llm = { providerId: 'native', agentAuthoredReplies: true, generateStructuredDecision: async () => ({}) as any, generateSpokenResponse: spoken } as any;
    const run = (agentText: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => naturalResponseComposer.compose({
      llm, session, userText: 'Shatabdi aur Vande Bharat mein kya fark hai?', backendReply: 'Main railway sawaalon mein madad kar sakta hoon.', deterministicSpeech: 'DETERMINISTIC', stateBefore: session.bookingState,
      reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null, steps: [], appliedActions: [], changes: [], error: null,
      pendingQuestionCode: null, pendingQuestion: null, history: [], mode, agentText, general: true
    } as any);
    const ok = await run('Vande Bharat semi high speed train hai, 160 km/h tak design ki gayi hai. Shatabdi Mumbai aur Delhi jaise shehron ko jodne wali purani day-time chair car service hai. Kal ya parso kisi bhi din aap dono mein CC ya EC chun sakte hain. RAC mein berth share hoti hai aur WL ka matlab waiting list hai.');
    expect(ok.source).toBe('LLM');
    expect(ok.authoredBy).toBe('AGENT');
    expect(ok.rejected).toEqual([]);
    expect(ok.text).toMatch(/160 km\/h.*Mumbai.*CC ya EC.*waiting list/s);
    const bad = await run('Tatkal booking ek din pehle khulti hai. 12951 Rajdhani sabse tez hai. Aapka PNR 4512345678 hai. Fare ₹1500 hai. 12014 mein kal seats available hain. Vande Bharat 06:00 baje chalti hai. Aapki ticket book ho gayi.');
    expect(bad.text).toBe('Tatkal booking ek din pehle khulti hai.');
    expect(bad.rejected.map(r => r.reason)).toEqual(['UNGROUNDED_TRAIN_NUMBER:12951', 'UNGROUNDED_NUMBER:PNR_LIKE', 'UNGROUNDED_FARE', 'UNGROUNDED_TRAIN_NUMBER:12014', 'UNGROUNDED_TIME', 'BOOKING_SUCCESS_CLAIM']);
    const voice = await run('Ek. Do. Teen. Chaar. Paanch. Chhe.', 'VOICE');
    expect(voice.segments.length).toBeLessThanOrEqual(4);                  // voice stays concise
    const allBad = await run('12951 Rajdhani kal 06:00 baje chalti hai.');
    expect(allBad).toMatchObject({ source: 'FALLBACK', text: 'DETERMINISTIC', fallbackReason: 'NOTHING_GROUNDED' });
    expect(spoken).not.toHaveBeenCalled();
  });

  it('[9] fact validation of agent replies about tool results stays strict (non-general): wrong time / fare / count / train removed; MockLLM keeps the separate wording step', async () => {
    const st = new ConversationStateManager();
    const sid = st.createSession().sessionId;
    const session: any = st.getSession(sid);
    Object.assign(session, { origin: 'ASR', destination: 'NDLS', originName: 'Amritsar', destinationName: 'New Delhi', date: new Date(Date.now() + 86400000).toISOString().slice(0, 10), bookingState: 'SHOWING_TRAINS' });
    session.searchResults = { trains: [{ trainNumber: '12014', trainName: 'Amritsar Shatabdi Express', origin: 'ASR', destination: 'NDLS', departureTime: '04:55', arrivalTime: '10:50', classes: [{ code: 'CC' }, { code: '2S' }] }, { trainNumber: '12497', trainName: 'Shan-e-Punjab Express', origin: 'ASR', destination: 'NDLS', departureTime: '06:35', arrivalTime: '13:30', classes: [{ code: '3A' }, { code: 'CC' }] }] };
    const backendReply = '2 trainein mili hain: 12014 (04:55) aur 12497 (06:35). Kaunsi train select karni hai?';
    const llm = { providerId: 'native', agentAuthoredReplies: true, generateStructuredDecision: async () => ({}) as any, generateSpokenResponse: vi.fn() } as any;
    const r = await naturalResponseComposer.compose({
      llm, session, userText: 'Amritsar se Delhi kal', backendReply, deterministicSpeech: backendReply, stateBefore: 'IDLE', reviewVersionBefore: null, selectedTrainBefore: null,
      selectedClassBefore: null, passengersCountBefore: null, steps: [], appliedActions: [], changes: [], error: null, pendingQuestionCode: null, pendingQuestion: null, history: [], mode: 'TEXT',
      agentText: '2 trainein mili hain. 12014 Shatabdi subah 04:55 pe nikalti hai. 12497 sirf 05:10 pe chalti hai. 5 trainein aur hain. 12014 ka fare ₹999 hai. Kaunsi chahiye?', general: false
    } as any);
    expect(r.text).toBe('2 trainein mili hain. 12014 Shatabdi subah 04:55 pe nikalti hai. Kaunsi chahiye?');
    expect(r.rejected.length).toBe(3);
    expect(llm.generateSpokenResponse).not.toHaveBeenCalled();
    // MockLLM (no agent-authored replies): the separate wording call still runs
    const mock = new MockLLMProvider();
    const spy = vi.spyOn(mock, 'generateSpokenResponse');
    const m = await naturalResponseComposer.compose({
      llm: mock, session, userText: 'Amritsar se Delhi kal', backendReply, deterministicSpeech: backendReply, stateBefore: 'IDLE', reviewVersionBefore: null, selectedTrainBefore: null,
      selectedClassBefore: null, passengersCountBefore: null, steps: [], appliedActions: [], changes: [], error: null, pendingQuestionCode: null, pendingQuestion: null, history: [], mode: 'TEXT'
    } as any);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(m.authoredBy ?? 'WORDING').not.toBe('AGENT');
  });

  it('[10] the agent prompt is dynamic (no fixed path / keyword router), keeps facts tool-grounded and forbids booking, payment, credentials and chain-of-thought', () => {
    const P = NATIVE_AGENT_SYSTEM_PROMPT;
    expect(P).toMatch(/You decide/);
    expect(P).toMatch(/There is no fixed order/);
    expect(P).toMatch(/NO tool needed/);
    expect(P).toMatch(/ONLY from tool results or the session context/);
    expect(P).toMatch(/never map "second wali" to a number yourself/);
    expect(P).toMatch(/ONLY when the session context shows\s+pendingInteraction CONFIRMATION_REQUIRED/);
    expect(P).toMatch(/OTP, CAPTCHA, passwords, UPI PIN, CVV/);
    expect(P).toMatch(/NOT booked yet/);
    expect(P).toMatch(/private reasoning/);
    expect(P).not.toMatch(/\{\{|\$\{/);                                       // no template placeholders / secrets
    expect(P).not.toContain(KEY);
  });
});
