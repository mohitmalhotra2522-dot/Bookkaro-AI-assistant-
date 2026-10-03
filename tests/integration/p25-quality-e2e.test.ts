/**
 * PROMPT 25 — G3: response quality / fact validation / tool-retry hardening through the FULL agent stack
 * (native OpenAI-compatible tool calling against a fake server → RailwayToolRuntime → MockRailwayProvider →
 * NaturalResponseComposer). No network, no credits, no booking provider, no handoff execution.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { MockBookingProvider } from '../../server/booking/testing/mock-booking-provider';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type FakeReply, type TurnView } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P25-E2E-SECRET-77777';
const ENV = { LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' };

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {};
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> { this.b('search'); return super.searchTrains(r); }
  async getTrainInfo(r: any): Promise<any> { this.b('info'); return super.getTrainInfo(r); }
  async checkAvailability(r: any): Promise<any> { this.b('avail'); return super.checkAvailability(r); }
  async getFare(r: any): Promise<any> { this.b('fare'); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p25-spy', () => rail);

type Step = FakeReply | ((v: TurnView) => FakeReply);
type Plan = Record<string, Step[]>;
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = { name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: 'kal' } };
const INFO = (n: any) => ({ calls: [{ name: 'GET_TRAIN_INFO', args: { trainNumber: n } }] });
const FARE_TURN: Step[] = [
  { calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' } })] }, { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: '3A' })] },
  { calls: [{ name: 'GET_FARE', args: { trainNumber: 12497 } }] },                                // numeric id → lossless normalization, no bounce
  v => ({ content: `12497 Shan-e-Punjab 3A ka fare ₹${v.results.at(-1)!.content.data.perPassenger} per passenger hai. Yeh 1 passenger ke liye hai.` })
];
const BASE: Plan = {
  'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH] }, v => ({ content: `Kal ke liye ${v.results[0].content.data.trains.length} trainein mili hain. 12014 Shatabdi subah 04:55 pe nikalti hai. Kaunsi chahiye?` })],
  '12014 wali CC mein': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12014' } })] }, { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: 'CC' })] }, { content: '12014 mein CC le liya. Kitne log travel karenge?' }],
  '2 passengers. Mohit 31 male, Ravi 28 male.': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGERS', { passengersCountRaw: '2', passengerChanges: [{ passengerIndex: 1, changes: { name: 'Mohit', age: 31, gender: 'male' } }, { passengerIndex: 2, changes: { name: 'Ravi', age: 28, gender: 'male' } }] })] }, { content: 'Dono passengers add ho gaye.' }],
  '12497 3A ka fare batao': FARE_TURN
};
const SEARCH_T = 'Kal Amritsar se Delhi jaana hai';

const outputs: string[] = [];
function mk(plan: Plan = {}) {
  const all: Plan = { ...BASE, ...plan };
  const fake = new FakeOpenAI(v => {
    const p = all[v.user];
    if (Array.isArray(p) && v.step < p.length) { const s = p[v.step]; return typeof s === 'function' ? s(v) : s; }
    return { content: 'Theek hai, aur kya madad karun?' };
  });
  const sel = createLLMProvider(ENV, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = async (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => {
    const d0 = fake.decisionRequests.length, w0 = fake.wordingRequests.length;
    const r: any = await eng.processTurn(sid, t, mode);
    r.__decisions = fake.decisionRequests.length - d0; r.__wording = fake.wordingRequests.length - w0;
    outputs.push(JSON.stringify({ r, s: state.getSession(sid) }));
    return r;
  };
  const run = async (ts: string[], mode: 'TEXT' | 'VOICE' = 'TEXT') => { let r: any; for (const t of ts) r = await say(t, mode); return r; };
  return { fake, say, run, s: () => state.getSession(sid) as any };
}
const execs = (r: any) => r.turnLog.toolExecutions.map((e: any) => [e.tool, e.status, e.rejectionReason ?? null]);
const text = (r: any) => String(r.voice?.assistantText ?? r.assistantText ?? '');
const ORPHAN = /(^|\s)\d{1,2}[.)](\s|$)|(^|\s)[-*•](\s|$)/;

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any, execSpies: any[] = [];
const envBefore = process.env.REAL_IRCTC_ENABLED;
beforeEach(() => {
  railwayRegistry.setActive('p25-spy');
  rail.n = {};
  outputs.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(((url: any, init: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
    throw new Error('network forbidden in tests');
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff execution forbidden'); });
  execSpies = [vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking'), vi.spyOn(MockBookingProvider.prototype, 'executeBooking')];
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();                                  // the fake LLM is an injected fetch: zero network
  expect(handoffSpy).not.toHaveBeenCalled();
  for (const s of execSpies) expect(s).not.toHaveBeenCalled();              // no booking provider is ever executed
  expect(process.env.REAL_IRCTC_ENABLED).toBe(envBefore);
  for (const out of outputs) {
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/"bookingState":"COMPLETE"/);
    expect(out).not.toMatch(/"sourceResultId"/);                            // provenance ids are internal, never in the turn result
  }
  fetchSpy.mockRestore(); handoffSpy.mockRestore(); for (const s of execSpies) s.mockRestore();
  railwayRegistry.setActive('mock');
});

describe('P25 G3 — facts survive when they are true (A–E)', () => {
  it('[A] RAC general knowledge: no tool, the count in the explanation is kept, one LLM call', async () => {
    const h = mk({ 'RAC kya hota hai?': [{ content: 'RAC ka matlab hai Reservation Against Cancellation. RAC mein do passengers ek berth share karte hain, aur chart ke baad poori berth mil sakti hai. Cancellation hone par seat confirm ho jaati hai.' }] });
    const r = await h.say('RAC kya hota hai?');
    expect(execs(r)).toEqual([]);
    expect(rail.n).toEqual({});
    expect(r.turnLog.naturalSpeech).toMatchObject({ source: 'LLM', authoredBy: 'AGENT', general: true, rejected: [] });
    expect(text(r)).toMatch(/do passengers ek berth share karte hain/);
    expect(r.turnLog.diagnostics).toMatchObject({ llmCalls: 1, secondLlmCall: false, toolCalls: 0 });
    expect(text(r)).toMatch(/seat confirm ho jaati hai/);
    expect(r.turnLog.diagnostics.validation.claimTypes).toEqual({ GENERAL_KNOWLEDGE: 3 });
  });

  it('[B] "12014 sabse pehle 10:50 par pahunchti hai." survives the no-tool follow-up; a wrong comparison does not', async () => {
    const h = mk({
      'Inme se sabse pehle kaunsi pahunchti hai?': [{ content: '12014 Amritsar Shatabdi sabse pehle 10:50 par pahunchti hai.' }],
      'Aur sabse late kaunsi?': [{ content: '12497 sabse pehle pahunchti hai. 18238 raat 19:35 par nikalti hai.' }]
    });
    await h.say(SEARCH_T);
    const r = await h.say('Inme se sabse pehle kaunsi pahunchti hai?');
    expect(execs(r)).toEqual([]);
    expect(r.turnLog.naturalSpeech).toMatchObject({ source: 'LLM', authoredBy: 'AGENT', rejected: [] });
    expect(text(r)).toMatch(/^12014 Amritsar Shatabdi sabse pehle 10:50 par pahunchti hai\./);
    const w = await h.say('Aur sabse late kaunsi?');
    expect(w.turnLog.naturalSpeech.rejected).toEqual(['COMPARISON_MISMATCH:12497']);
    expect(text(w)).toMatch(/18238 raat 19:35 par nikalti hai\./);
    expect(text(w)).not.toMatch(/12497 sabse pehle/);
  });

  it('[C] class list CC / 2S survives as a class list (not availability); markdown list leaves no orphan numbering', async () => {
    const h = mk({ 'Kal Amritsar se Delhi ki trains dikhao': [{ calls: [SEARCH] }, { content: 'Kal ke liye 3 trainein mili hain:\n1. 12014 Amritsar Shatabdi – 04:55 se 10:50, CC aur 2S available.\n2. 12497 Shan-e-Punjab – 06:35 se 13:50, fare ₹9999.\n3. 18238 – 19:35 par nikalti hai.\nKaunsi chahiye?' }] });
    const r = await h.say('Kal Amritsar se Delhi ki trains dikhao');
    expect(execs(r)).toEqual([['SEARCH_TRAINS', 'SUCCEEDED', null]]);
    expect(text(r)).toContain('12014 Amritsar Shatabdi – 04:55 se 10:50, CC aur 2S classes listed.');
    expect(text(r)).not.toMatch(/available/);
    expect(text(r)).not.toMatch(ORPHAN);
    expect(text(r)).not.toMatch(/9999/);
    expect(r.turnLog.naturalSpeech).toMatchObject({ source: 'LLM', repaired: 1 });
    expect(rail.n.avail).toBeUndefined();                                   // no availability was fetched or claimed
    expect(h.s().availability || {}).toEqual({});
  });

  it('[D] a "2 passengers" session fact survives; a general mention of two passengers is not a live availability claim', async () => {
    const h = mk({ 'RAC mein kitne log ek berth share karte hain?': [{ content: 'RAC mein do passengers ek berth share karte hain. Aapke 2 passengers ki details review mein hain.' }] });
    await h.run(['Kal Amritsar se Delhi jaana hai', '12014 wali CC mein', '2 passengers. Mohit 31 male, Ravi 28 male.']);
    expect(h.s().passengersCount).toBe(2);
    const availBefore = JSON.stringify(h.s().availability || null);
    const n0 = { ...rail.n };
    const r = await h.say('RAC mein kitne log ek berth share karte hain?');
    expect(execs(r)).toEqual([]);
    expect(rail.n).toEqual(n0);
    expect(r.turnLog.naturalSpeech.rejected).toEqual([]);
    expect(text(r)).toMatch(/^RAC mein do passengers ek berth share karte hain\. Aapke 2 passengers ki details review mein hain\./);
    expect(JSON.stringify(h.s().availability || null)).toBe(availBefore);
    expect(r.turnLog.diagnostics.validation.claimTypes).toMatchObject({ GENERAL_KNOWLEDGE: 1, SESSION_FACT: 1 });
  });

  it('[E] GET_FARE 12497 / 3A / ₹650 sentence survives (numeric trainNumber normalized losslessly, one provider call)', async () => {
    const h = mk();
    await h.say(SEARCH_T);
    const r = await h.say('12497 3A ka fare batao');
    expect(execs(r)).toEqual([['GET_FARE', 'SUCCEEDED', null]]);
    expect(rail.n.fare).toBe(1);
    expect(r.turnLog.naturalSpeech).toMatchObject({ source: 'LLM', authoredBy: 'AGENT', rejected: [] });
    expect(text(r)).toMatch(/^12497 Shan-e-Punjab 3A ka fare ₹650 per passenger hai\. Yeh 1 passenger ke liye hai\./);
    expect(h.s()).toMatchObject({ selectedClass: '3A', fare: { trainNumber: '12497', travelClass: '3A', perPassenger: 650 } });
  });
});

describe('P25 G3 — language, tool validation, retries, LLM calls (F–J)', () => {
  it('[F] English question → English reply; the backend\'s own question is English too; the agent sees replyLanguage', async () => {
    const h = mk({ 'Which of these trains reaches Delhi earliest?': [v => ({ content: v.context?.replyLanguage === 'ENGLISH' ? '12014 Amritsar Shatabdi reaches New Delhi first, at 10:50.' : '12014 sabse pehle 10:50 par pahunchti hai.' })] });
    await h.say(SEARCH_T);
    const r = await h.say('Which of these trains reaches Delhi earliest?');
    expect(r.turnLog.naturalSpeech).toMatchObject({ source: 'LLM', language: 'ENGLISH', rejected: [] });
    expect(text(r)).toBe('12014 Amritsar Shatabdi reaches New Delhi first, at 10:50. Which train would you like?');
    expect(text(r)).not.toMatch(/\b(hai|hain|chahiye|kaunsi)\b/i);
  });

  it('[G] malformed train number → deterministic INVALID_ARGUMENT before execution; the LLM gets argument / expected / received', async () => {
    const h = mk({ '1201A train ki info do': [INFO('1201A'), v => ({ content: v.results[0].content.error?.argument === 'trainNumber' ? 'Ye train number sahi format mein nahi laga — poora train number bata dijiye.' : 'x' })] });
    const r = await h.say('1201A train ki info do');
    expect(execs(r)).toEqual([['GET_TRAIN_INFO', 'REJECTED', 'INVALID_ARGUMENT']]);
    expect(rail.n.info).toBeUndefined();
    const toolMsg = JSON.parse(h.fake.decisionRequests.at(-1)!.body.messages.at(-1).content);
    expect(toolMsg).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', argument: 'trainNumber', expected: expect.stringMatching(/4-5 digit/), received: '"1201A"' } });
    expect(text(r)).toMatch(/train number/i);
    expect(text(r)).not.toMatch(/^x$/);
    expect(r.turnLog.diagnostics).toMatchObject({ toolValidationFailures: 1, retryCount: 0, llmCalls: 2 });
  });

  it('[H] the corrected retry continues to a verified result', async () => {
    const h = mk({ '12014 ki info do': [INFO('12O14'), INFO('12014'), { content: '12014 Amritsar Shatabdi 04:55 par nikalti hai aur 10:50 par pahunchti hai.' }] });
    const r = await h.say('12014 ki info do');
    expect(execs(r)).toEqual([['GET_TRAIN_INFO', 'REJECTED', 'INVALID_ARGUMENT'], ['GET_TRAIN_INFO', 'SUCCEEDED', null]]);
    expect(rail.n.info).toBe(1);
    expect(r.turnLog.naturalSpeech.rejected).toEqual([]);
    expect(text(r)).toMatch(/^12014 Amritsar Shatabdi 04:55 par nikalti hai aur 10:50 par pahunchti hai\./);
    expect(r.turnLog.diagnostics).toMatchObject({ toolValidationFailures: 1, retryCount: 1, repeatedInvalidCalls: 0, llmCalls: 3 });
  });

  it('[I] identical invalid calls are capped: repeat → INVALID_REPEATED_CALL, third → stop with a clarification; nothing executed or invented', async () => {
    const h = mk({ '99 number train ki info do': [INFO('99'), INFO('99'), INFO('99'), INFO('99'), { content: 'never reached' }] });
    const r = await h.say('99 number train ki info do');
    expect(execs(r)).toEqual([['GET_TRAIN_INFO', 'REJECTED', 'INVALID_ARGUMENT'], ['GET_TRAIN_INFO', 'REJECTED', 'INVALID_REPEATED_CALL'], ['GET_TRAIN_INFO', 'REJECTED', 'TOOL_LOOP_DETECTED']]);
    expect(rail.n.info).toBeUndefined();
    expect(r.__decisions).toBe(3);
    expect(text(r)).toMatch(/train number/i);
    expect(text(r)).not.toMatch(/never reached|verified result hi current/);
    expect(r.turnLog.diagnostics).toMatchObject({ toolValidationFailures: 1, repeatedInvalidCalls: 1, llmCalls: 3, secondLlmCall: false });
  });

  it('[J] one final response per turn: no second LLM call after an agent answer, a refusal, a limit stop or a forbidden attempt; allowed reasons only', async () => {
    const h = mk({ 'Inme se sabse pehle kaunsi pahunchti hai?': [{ content: '12014 sabse pehle 10:50 par pahunchti hai.' }] });
    const turns = [await h.say(SEARCH_T), await h.say('Inme se sabse pehle kaunsi pahunchti hai?'), await h.say('12014 wali CC mein')];
    for (const r of turns) {
      expect(r.__wording, r.userInput).toBe(0);
      expect(r.turnLog.diagnostics).toMatchObject({ secondLlmCall: false, secondLlmCallReason: null });
      expect(r.turnLog.diagnostics.llmCalls).toBe(r.__decisions);
    }
    // a turn where the backend fetched NEW data after the agent spoke (review preparation) may word it once, with a reason
    const rv = await h.say('2 passengers. Mohit 31 male, Ravi 28 male.');
    expect(rv.__wording).toBeLessThanOrEqual(1);
    expect(rv.turnLog.diagnostics.llmCalls).toBe(rv.__decisions + rv.__wording);
    if (rv.__wording) expect(['NEW_TOOL_RESULT', 'BOOKING_STATE_CHANGED', 'SESSION_CHANGED_AFTER_AGENT']).toContain(rv.turnLog.diagnostics.secondLlmCallReason);
    else expect(rv.turnLog.diagnostics.secondLlmCall).toBe(false);
  });
});

describe('P25 G3 — safety and parity (K–L)', () => {
  it('[K] "book karke payment bhi kar do" → honest refusal, no fake booking / PNR, no duplicated question; a forbidden tool gets the backend refusal without a wording call', async () => {
    const h = mk({
      'book karke payment bhi kar do': [{ content: 'Main ticket book ya payment nahi kar sakta — real booking abhi band hai. Train select karke bata dijiye.' }],
      'ab payment kar do': [{ calls: [{ name: 'MAKE_PAYMENT', args: {} }, { name: 'BOOK_TICKET', args: {} }] }, { content: 'Payment ho gaya, PNR 4512345678.' }]
    });
    await h.say(SEARCH_T);
    const r = await h.say('book karke payment bhi kar do');
    expect(text(r)).toBe('Main ticket book ya payment nahi kar sakta — real booking abhi band hai. Train select karke bata dijiye.');
    expect(text(r)).not.toMatch(/\b\d{10}\b|booked|confirm ho gaya/i);
    expect(h.s().bookingState).toBe('SHOWING_TRAINS');
    const f = await h.say('ab payment kar do');
    expect(execs(f)).toEqual([['MAKE_PAYMENT', 'REJECTED', 'FORBIDDEN_ACTION'], ['BOOK_TICKET', 'REJECTED', 'FORBIDDEN_ACTION']]);
    expect(text(f)).toMatch(/seedha nahi kar sakta/);                     // the backend states the boundary itself
    expect(text(f)).not.toMatch(/Payment ho gaya|4512345678/);
    expect(f.__wording).toBe(0);
    expect(f.turnLog.diagnostics.secondLlmCall).toBe(false);
  });

  it('[L] text and voice (STT) follow the same validation path: same tools, same session facts, same accepted facts', async () => {
    const res: Record<string, any> = {};
    for (const mode of ['TEXT', 'VOICE'] as const) {
      const h = mk({ 'Inme se sabse pehle kaunsi pahunchti hai?': [{ content: '12014 sabse pehle 10:50 par pahunchti hai. 12497 sabse pehle pahunchti hai.' }] });
      await h.say(SEARCH_T, mode);
      const b = await h.say('Inme se sabse pehle kaunsi pahunchti hai?', mode);
      const e = await h.say('12497 3A ka fare batao', mode);
      const s = h.s();
      res[mode] = { b, e, execs: execs(e), facts: { train: s.selectedTrain?.number, cls: s.selectedClass, fare: s.fare?.perPassenger, state: s.bookingState } };
    }
    expect(res.VOICE.execs).toEqual(res.TEXT.execs);
    expect(res.VOICE.facts).toEqual(res.TEXT.facts);
    expect(res.TEXT.facts).toMatchObject({ train: '12497', cls: '3A', fare: 650 });
    expect(res.VOICE.b.turnLog.naturalSpeech.rejected).toEqual(res.TEXT.b.turnLog.naturalSpeech.rejected);
    expect(res.TEXT.b.turnLog.naturalSpeech.rejected).toEqual(['COMPARISON_MISMATCH:12497']);
    for (const mode of ['TEXT', 'VOICE']) {
      expect(text(res[mode].b)).toMatch(/12014 sabse pehle 10:50/);
      expect(text(res[mode].e)).toMatch(/₹650/);
      expect(res[mode].e.turnLog.naturalSpeech.source).toBe('LLM');
    }
    expect(text(res.VOICE.e).length).toBeLessThanOrEqual(text(res.TEXT.e).length);
  });
});
