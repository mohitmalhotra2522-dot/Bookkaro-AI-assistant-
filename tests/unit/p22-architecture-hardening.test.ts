/**
 * PROMPT 22 — GROUP 2: focused domain / provider / security checks for the final architecture audit.
 *   - approved LLM info tools vs forbidden execution names (registry + resolver)
 *   - real OpenAI-compatible adapter: off by default, env-configured, timeout, normalized errors, no key leakage,
 *     NO silent rule-based fallback (failure → LLM_UNAVAILABLE upstream)
 *   - fact authority: every LLM sentence is checked against tool results (station / train name / date / count /
 *     availability / fare / timing / PNR / cancellation / live status) in BOTH text and voice
 *   - sensitive input never reaches the LLM, the session or the turn log
 *   - booking execution config is fail-closed
 * Offline: global fetch is forbidden; the adapter only ever sees an injected fake fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { RAILWAY_TOOL_REGISTRY, llmCallableTools, resolveToolName } from '../../server/ai/tool-runtime/railway-tool-registry';
import { RAILWAY_TOOL_NAMES } from '../../shared/railway-tool-runtime';
import { OpenAICompatibleLLMProvider, toDecision } from '../../server/ai/providers/openai-compatible-llm';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { LLMProviderError, isLLMProviderError, LLM_UNAVAILABLE_MESSAGE } from '../../server/ai/providers/llm-provider';
import { naturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import { containsSensitiveRequest } from '../../server/security/validators/intent-validator';
import { parseExecutionConfig } from '../../server/booking/execution/execution-config';
import { BOOKING_AGENT_SYSTEM_PROMPT, MULTI_TURN_CONTEXT_PROMPT, VOICE_RESPONSE_STYLE_PROMPT } from '../../server/ai/prompts/system-prompt';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';

const ROOT = path.resolve(__dirname, '../..');
const APPROVED = ['SEARCH_TRAINS', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'CHECK_AVAILABILITY', 'GET_FARE', 'TRACK_TRAIN', 'CHECK_PNR', 'GET_CANCELLED_TRAINS', 'GENERAL_RAILWAY_ANSWER',
  // Prompt 35: approved WEB_EXTERNAL research (disabled / not LLM-callable unless configured)
  'WEB_RAILWAY_RESEARCH'];
const FORBIDDEN = ['BOOK_TICKET', 'executeBooking', 'EXECUTE_BOOKING', 'BookingProviderAdapter.execute', 'MAKE_PAYMENT', 'PAYMENT', 'IRCTC_LOGIN', 'OTP', 'CAPTCHA', 'UPI_PAYMENT', 'CARD_PAYMENT', 'SUBMIT_BOOKING', 'FINAL_SUBMISSION'];

function mk(llm: any = new MockLLMProvider()) {
  const state = new ConversationStateManager();
  const eng = new ConversationTurnEngine(new ConversationAgentOrchestrator(llm, state, new RailwayToolService()), state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { eng, sid, say: (t: string, m: 'TEXT' | 'VOICE' = 'VOICE', x: any = {}) => eng.processTurn(sid, t, m, x) as Promise<any>, s: () => state.getSession(sid) as any };
}
const REVIEW_2 = ['Amritsar se Delhi kal', '12014 wali kar do', 'CC', '2 passengers. Mohit 31 male, Ravi 28 male.'];
const turnInput = (o: any = {}) => ({ userText: 'Amritsar se Delhi kal', inputMode: 'TEXT', state: 'IDLE', missingFields: [], history: [], tools: REGISTERED_TOOLS, context: null, ...o }) as any;
const okJson = (content: string) => ({ ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content } }] }) });
const KEY = 'sk-live-SECRET-0123456789';

/** One LLM sentence → composer verdict, against the session's authoritative facts. */
async function verdict(session: any, sentence: string, mode: 'TEXT' | 'VOICE') {
  const llm = { providerId: 'scripted', generateStructuredDecision: async () => ({}) as any, generateSpokenResponse: async () => ({ text: sentence }) } as any;
  return naturalResponseComposer.compose({
    llm, session, userText: 'theek hai', backendReply: '', deterministicSpeech: 'DETERMINISTIC', stateBefore: session.bookingState,
    reviewVersionBefore: null, selectedTrainBefore: '12014', selectedClassBefore: 'CC', passengersCountBefore: 2,
    steps: [], appliedActions: [], changes: [], error: null, pendingQuestionCode: null, pendingQuestion: null, history: [], mode
  } as any);
}

let fetchSpy: any;
const envBefore = { ...process.env };
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(process.env.REAL_IRCTC_ENABLED).toBe(envBefore.REAL_IRCTC_ENABLED);
  expect(process.env.LLM_API_KEY).toBe(envBefore.LLM_API_KEY);
  fetchSpy.mockRestore();
});

describe('P22 G2 — LLM tool surface', () => {
  it('[1] all 9 approved info tools are registered; 7 implemented ones are LLM-callable, the 2 unimplemented answer TOOL_NOT_IMPLEMENTED (never fake data)', () => {
    expect([...RAILWAY_TOOL_NAMES].sort()).toEqual([...APPROVED].sort());
    expect([...RAILWAY_TOOL_REGISTRY.keys()].sort()).toEqual([...APPROVED].sort());
    expect(llmCallableTools().map(t => t.name).sort()).toEqual(REGISTERED_TOOLS.map(t => t.name).sort());
    expect(REGISTERED_TOOLS.map(t => t.name).sort()).toEqual(['CHECK_AVAILABILITY', 'CHECK_PNR', 'GET_FARE', 'GET_TIMETABLE', 'GET_TRAIN_INFO', 'SEARCH_TRAINS', 'TRACK_TRAIN']);
    for (const n of ['GET_CANCELLED_TRAINS', 'GENERAL_RAILWAY_ANSWER']) expect(RAILWAY_TOOL_REGISTRY.get(n as any)).toMatchObject({ implemented: false, providerRoute: 'NONE' });
    // every exposed tool is a read-only information tool
    for (const t of REGISTERED_TOOLS) expect(t.name).not.toMatch(/BOOK_TICKET|EXECUTE|PAY|LOGIN|OTP|CAPTCHA|SUBMIT|CANCEL_BOOKING/);
  });

  it('[2] booking / payment / IRCTC / OTP / CAPTCHA names are FORBIDDEN (case-insensitive), never resolvable, and dropped from remote LLM output', () => {
    for (const f of FORBIDDEN) expect(resolveToolName(f).kind, f).toBe('FORBIDDEN');
    expect(resolveToolName('search_trains').kind).toBe('UNKNOWN');            // exact match only — no fuzzy dispatch
    const d = toDecision({ intent: 'SEARCH_TRAINS', action: 'SEARCH_TRAINS', entities: {}, toolCalls: [
      { name: 'BOOK_TICKET', arguments: {} }, { name: 'executeBooking', arguments: {} }, { name: 'MAKE_PAYMENT', arguments: {} },
      { name: 'SEARCH_TRAINS', arguments: { origin: 'ASR', destination: 'NDLS', date: 'kal' } }] }, turnInput());
    expect((d.toolCalls || []).map(c => c.name)).toEqual(['SEARCH_TRAINS']);
  });

  it('[3] prompts make the LLM the conversational brain with authoritative-fact + no-execution rules (no chain-of-thought)', () => {
    expect(MULTI_TURN_CONTEXT_PROMPT).toMatch(/newJourney/);
    expect(MULTI_TURN_CONTEXT_PROMPT).toMatch(/PROPOSALS/);
    expect(BOOKING_AGENT_SYSTEM_PROMPT).toMatch(/trainRef|DISPLAY_INDEX/);
    expect(BOOKING_AGENT_SYSTEM_PROMPT).toMatch(/never/i);
    expect(VOICE_RESPONSE_STYLE_PROMPT).toMatch(/outputMode/);
    expect(`${BOOKING_AGENT_SYSTEM_PROMPT}${MULTI_TURN_CONTEXT_PROMPT}${VOICE_RESPONSE_STYLE_PROMPT}`).not.toMatch(/think step by step|show your reasoning/i);
  });
});

describe('P22 G2 — real OpenAI-compatible adapter readiness', () => {
  it('[4] off by default; enabled only by server env with key + model; info never contains the key', () => {
    expect(createLLMProvider({}).info).toMatchObject({ providerId: 'mock-llm', reason: 'DEFAULT_MOCK' });
    expect(createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm' }).info.reason).toBe('MISSING_LLM_API_KEY');
    expect(createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY }).info.reason).toBe('MISSING_LLM_MODEL');
    expect(createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'm', LLM_BASE_URL: 'ftp://x' }).info.reason).toBe('INVALID_LLM_BASE_URL');
    const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'gpt-x', LLM_TIMEOUT_MS: '2500' }, { fetch: async () => okJson('{}') as any });
    expect(sel.info).toMatchObject({ providerId: 'openai-compatible', model: 'gpt-x', configured: true, reason: 'ENV_CONFIGURED' });
    expect(JSON.stringify(sel.info)).not.toContain(KEY);
    expect((sel.provider as any).cfg.timeoutMs).toBe(2500);
    // frontend never reads LLM keys
    const src = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true } as any).filter((f: any) => /\.(ts|tsx)$/.test(String(f)));
    for (const f of src) expect(fs.readFileSync(path.join(ROOT, 'src', String(f)), 'utf8')).not.toMatch(/LLM_API_KEY|OPENAI_API_KEY|process\.env/);
  });

  it('[5] sends the key only as a Bearer header to the configured endpoint; a valid JSON decision is parsed', async () => {
    const seen: any[] = [];
    const p = new OpenAICompatibleLLMProvider({ toolMode: 'json', apiKey: KEY, baseUrl: 'https://llm.example/v1/', model: 'm', timeoutMs: 1000, fetch: async (url, init) => { seen.push({ url, init }); return okJson(JSON.stringify({ intent: 'SEARCH_TRAINS', action: 'SEARCH_TRAINS', entities: { originRaw: 'Amritsar' }, toolCalls: [{ name: 'SEARCH_TRAINS', arguments: {} }] })) as any; } });
    const r = await p.generateStructuredDecision(turnInput());
    expect(seen[0].url).toBe('https://llm.example/v1/chat/completions');
    expect(seen[0].init.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0].init.body).not.toContain(KEY);
    expect(r.decision).toMatchObject({ intent: 'SEARCH_TRAINS', action: 'SEARCH_TRAINS' });
    expect(r.decision.toolCalls?.[0].name).toBe('SEARCH_TRAINS');
  });

  it('[6] normalized errors (auth / rate limit / http / network / timeout / bad JSON) — never the body or key, never a silent fallback decision', async () => {
    const cases: Array<[string, any, string, number?]> = [
      ['401', async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => `invalid key ${KEY}` }), 'LLM_AUTH_ERROR', 401],
      ['429', async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'slow down' }), 'LLM_RATE_LIMITED', 429],
      ['500', async () => ({ ok: false, status: 500, json: async () => ({ error: KEY }), text: async () => KEY }), 'LLM_HTTP_ERROR', 500],
      ['network', async () => { throw new Error(`ECONNREFUSED ${KEY}`); }, 'LLM_NETWORK_ERROR'],
      ['timeout', (_u: string, init: any) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))), 'LLM_TIMEOUT'],
      ['bad json', async () => okJson('not json at all'), 'LLM_BAD_RESPONSE'],
      ['array json', async () => okJson('[1,2]'), 'LLM_BAD_RESPONSE']
    ];
    for (const [label, f, code, status] of cases) {
      const p = new OpenAICompatibleLLMProvider({ toolMode: 'json', apiKey: KEY, baseUrl: 'https://llm.example/v1', model: 'm', timeoutMs: 30, fetch: f });
      const err: any = await p.generateStructuredDecision(turnInput()).then(() => null, e => e);
      expect(isLLMProviderError(err), label).toBe(true);
      expect(err.code, label).toBe(code);
      if (status) expect(err.status).toBe(status);
      expect(`${err.message} ${JSON.stringify(err)}`, label).not.toContain(KEY);
      expect(p.failedDecisions, label).toBe(1);
    }
    expect(new LLMProviderError('LLM_HTTP_ERROR', 503).message).toBe('LLM_HTTP_ERROR:503');
  });

  it('[7] a failing remote LLM in the real pipeline → fixed LLM_UNAVAILABLE reply, no state change, no railway call, no mock takeover', async () => {
    const remote = new OpenAICompatibleLLMProvider({ toolMode: 'json', apiKey: KEY, baseUrl: 'https://llm.example/v1', model: 'm', timeoutMs: 1000, fetch: async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }) as any });
    const h = mk(remote);
    const searchSpy = vi.spyOn(MockRailwayProvider.prototype, 'searchTrains');
    for (const mode of ['TEXT', 'VOICE'] as const) {
      const r = await h.say('Amritsar se Delhi kal', mode);
      expect(r.error?.code).toBe('LLM_UNAVAILABLE');
      expect(r.voice.assistantText).toContain(LLM_UNAVAILABLE_MESSAGE);
      expect(r.newState).toBe('IDLE');
      expect(h.s().origin).toBeUndefined();
    }
    expect(searchSpy).not.toHaveBeenCalled();
    searchSpy.mockRestore();
  });
});

describe('P22 G2 — tool results are the only railway fact authority (composer)', () => {
  it('[8] search-stage facts: invented train name / station / time / day / count / live status / cancellation / PNR are rejected; grounded wording kept', async () => {
    const h = mk(); for (const t of ['Amritsar se Delhi kal', '12014 wali', 'CC']) await h.say(t);
    const expectations: Array<[string, string | null]> = [
      ['12014 Shatabdi hai.', null], ['12497 Shan-e-Punjab Express hai.', null], ['Teen trainein mili hain.', null],
      ['Kal subah 4:55 wali hai.', null], ['12014 10:50 par pahunchti hai.', null],
      ['12014 Rajdhani hai.', 'UNGROUNDED_TRAIN_NAME:Rajdhani'], ['Chandigarh se bhi train hai.', 'UNGROUNDED_STATION:CDG'],
      ['Parso subah 4:55 wali hai.', 'UNGROUNDED_DATE:Parso'], ['Do trainein mili hain.', 'UNGROUNDED_COUNT:Do trainein'],
      ['12014 11:30 par pahunchti hai.', 'UNGROUNDED_NUMBER:11'], ['CC mein seats available hain.', 'UNVERIFIED_AVAILABILITY'],
      ['Fare ₹55 hai.', 'UNGROUNDED_FARE'], ['Aapka PNR confirm hai.', 'GROUNDING:PNR_STATUS_CLAIM'],
      ['12014 cancelled hai.', 'GROUNDING:CANCELLATION_CLAIM'], ['12014 time pe chal rahi hai.', 'GROUNDING:PUNCTUALITY_CLAIM']
    ];
    for (const mode of ['VOICE', 'TEXT'] as const) for (const [sentence, reason] of expectations) {
      const o = await verdict(h.s(), sentence, mode);
      if (reason === null) { expect(o.source, `${mode} ${sentence}`).toBe('LLM'); expect(o.text).toBe(sentence); }
      else { expect(o.source, `${mode} ${sentence}`).toBe('FALLBACK'); expect(o.rejected.map(r => r.reason)).toEqual([reason]); expect(o.text).toBe('DETERMINISTIC'); }
    }
  });

  it('[9] review-stage facts: availability, fare amounts and passenger counts must match the authoritative snapshot', async () => {
    const h = mk(); for (const t of REVIEW_2) await h.say(t);
    expect(h.s()).toMatchObject({ bookingState: 'AWAITING_CONFIRMATION', fare: { perPassenger: 520, total: 1040 } });
    const expectations: Array<[string, string | null]> = [
      ['CC mein seats available hain.', null], ['Fare ₹520 per passenger hai, total ₹1040.', null], ['Do passengers hain.', null], ['Confirm karna hai?', null],
      ['CC mein WL 3 hai.', 'AVAILABILITY_MISMATCH:WL 3'], ['Fare ₹55 hai.', 'UNGROUNDED_FARE_AMOUNT:55'], ['Total ₹999 hai.', 'UNGROUNDED_NUMBER:999'],
      ['12014 Rajdhani hai.', 'UNGROUNDED_TRAIN_NAME:Rajdhani'], ['Teen passengers hain.', 'UNGROUNDED_COUNT:Teen passengers'], ['Mumbai tak jaati hai.', 'UNGROUNDED_STATION:Mumbai']
    ];
    for (const mode of ['VOICE', 'TEXT'] as const) for (const [sentence, reason] of expectations) {
      const o = await verdict(h.s(), sentence, mode);
      if (reason === null) expect(o.source, `${mode} ${sentence}`).toBe('LLM');
      else expect(o.rejected.map(r => r.reason), `${mode} ${sentence}`).toEqual([reason]);
    }
  });
});

describe('P22 G2 — security', () => {
  it('[10] OTP / CAPTCHA / password / UPI PIN / card / CVV / IRCTC password never reach the LLM, the session or the turn log', async () => {
    const seen: string[] = [];
    class SpyLLM extends MockLLMProvider {
      async generateStructuredDecision(i: any): Promise<any> { seen.push(JSON.stringify(i)); return super.generateStructuredDecision(i); }
      async generateSpokenResponse(i: any): Promise<any> { seen.push(JSON.stringify(i)); return super.generateSpokenResponse(i); }
    }
    const h = mk(new SpyLLM());
    await h.say('Amritsar se Delhi kal');
    const secrets: Array<[string, string]> = [['mera OTP 482913 hai', '482913'], ['captcha XK7P2Q hai', 'XK7P2Q'], ['password Tiger@123 hai', 'Tiger@123'],
      ['upi pin 4321 hai', '4321'], ['card number 4111 1111 1111 1111', '4111 1111'], ['cvv 987', '987'], ['irctc password Mohit@9', 'Mohit@9']];
    const logs: string[] = [];
    for (const mode of ['VOICE', 'TEXT'] as const) for (const [text] of secrets) {
      expect(containsSensitiveRequest(text), text).toBe(true);
      const r = await h.say(text, mode);
      expect(r.error?.code, text).toBe('SENSITIVE_REQUEST_REJECTED');
      expect(r.newState).toBe('SHOWING_TRAINS');
      logs.push(JSON.stringify(r.turnLog));
    }
    await h.say('12014 wali');   // later turns carry history — still redacted
    // random UUIDs / generated ids can contain a digit run like "4321" by chance — that is not a leak, so ids are stripped first
    const noIds = (x: string) => x.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>');
    const sessionJson = noIds(JSON.stringify(h.s()));
    for (const [, secret] of secrets) {
      expect(noIds(seen.join(' ')), secret).not.toContain(secret);
      expect(sessionJson, secret).not.toContain(secret);
      expect(noIds(logs.join(' ')), secret).not.toContain(secret);
    }
  });

  it('[11] booking execution is fail-closed by configuration; REAL_IRCTC_ENABLED is never read', () => {
    expect(parseExecutionConfig({}).realBookingEnabled).toBe(false);
    expect(parseExecutionConfig({ REAL_BOOKING_ENABLED: 'TRUE ' }).realBookingEnabled).toBe(false);
    expect(parseExecutionConfig({ REAL_IRCTC_ENABLED: 'true' } as any).realBookingEnabled).toBe(false);
    const files = ['server/booking/execution/execution-config.ts', 'server/ai/providers/llm-provider-factory.ts', 'server/ai/providers/openai-compatible-llm.ts'];
    for (const f of files) expect(fs.readFileSync(path.join(ROOT, f), 'utf8')).not.toMatch(/process\.env\.REAL_IRCTC_ENABLED/);
  });
});
