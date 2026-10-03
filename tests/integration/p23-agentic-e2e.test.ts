/**
 * PROMPT 23 — GROUP 3 (e2e): the real-LLM agent loop, end to end, against a FAKE OpenAI-compatible model.
 *   user text / voice → ConversationTurnEngine → ConversationAgentOrchestrator → OpenAICompatibleLLMProvider (native
 *   function calling) ⇄ BoundToolRuntime / RailwayToolRuntime / TurnApplier → labelled mock (non-live) spy railway
 *   provider → BookingSession → NaturalResponseComposer (validates the agent's own answer) → text / TTS.
 * The fake model is scripted per user message + step: it decides which tools to call and what to say; the backend only
 * validates, executes and guards. Offline: no external network, no credits, no booking execution, never COMPLETE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
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
import { LLM_UNAVAILABLE_MESSAGE } from '../../server/ai/providers/llm-provider';
import { createEngineVoiceAgent } from '../../server/voice/server-voice-agent';
import { MockStreamingSTT } from '../../server/voice/stt/stt-provider';
import { MockStreamingTTS } from '../../server/voice/tts/tts-provider';
import { FakeOpenAI, type FakeReply, type TurnView } from '../helpers/fake-openai-server';

const KEY = 'sk-live-P23-E2E-SECRET-55555';
const ENV = { LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-glm', LLM_BASE_URL: 'https://llm.fake.test/v1' };

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {};
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> { this.b('search'); return super.searchTrains(r); }
  async getTrainInfo(r: any): Promise<any> { this.b('info'); return super.getTrainInfo(r); }
  async getTimetable(r: any): Promise<any> { this.b('timetable'); return super.getTimetable(r); }
  async checkAvailability(r: any): Promise<any> { this.b('avail'); return super.checkAvailability(r); }
  async getFare(r: any): Promise<any> { this.b('fare'); return super.getFare(r); }
  async trackTrain(r: any): Promise<any> { this.b('track'); return super.trackTrain(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p23-spy', () => rail);

type Step = FakeReply | ((v: TurnView) => FakeReply);
type Plan = Record<string, Step[] | ((v: TurnView) => FakeReply)>;
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = (date = 'kal') => ({ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date } });
const BASE: Plan = {
  'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH()] }, v => ({ content: `Kal ke liye ${v.results[0].content.data.trains.length} trainein mili hain. 12014 Shatabdi subah 04:55 pe nikalti hai. Kaunsi chahiye?` })],
  '12014 wali CC mein': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12014' } })] }, { calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: 'CC' })] }, { content: '12014 mein CC le liya. Kitne log travel karenge?' }],
  '2 passengers. Mohit 31 male, Ravi 28 male.': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGERS', { passengersCountRaw: '2', passengerChanges: [{ passengerIndex: 1, changes: { name: 'Mohit', age: 31, gender: 'male' } }, { passengerIndex: 2, changes: { name: 'Ravi', age: 28, gender: 'male' } }] })] }, { content: 'Dono passengers add ho gaye.' }]
};
const REVIEW = ['Kal Amritsar se Delhi jaana hai', '12014 wali CC mein', '2 passengers. Mohit 31 male, Ravi 28 male.'];

const outputs: string[] = [];
function mk(plan: Plan = {}, o: { env?: Record<string, string>; fetch?: boolean } = {}) {
  const all: Plan = { ...BASE, ...plan };
  const fake = new FakeOpenAI(v => {
    const p = all[v.user];
    if (typeof p === 'function') return p(v);
    if (Array.isArray(p) && v.step < p.length) { const s = p[v.step]; return typeof s === 'function' ? s(v) : s; }
    return { content: 'Theek hai, aur kya madad karun?' };
  });
  const sel = createLLMProvider(o.env ?? ENV, o.fetch === false ? {} : { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const say = async (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => {
    const r: any = await eng.processTurn(sid, t, mode);
    outputs.push(JSON.stringify({ r, s: state.getSession(sid) }));
    return r;
  };
  const run = async (ts: string[], mode: 'TEXT' | 'VOICE' = 'TEXT') => { let r: any; for (const t of ts) r = await say(t, mode); return r; };
  return { fake, sel, state, eng, sid, say, run, s: () => state.getSession(sid) as any };
}
const execs = (r: any) => r.turnLog.toolExecutions.map((e: any) => [e.tool, e.status, e.rejectionReason ?? null]);
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any, execSpies: any[] = [], mockDecide: any, mockSpeak: any;
const envBefore = process.env.REAL_IRCTC_ENABLED;
beforeEach(() => {
  railwayRegistry.setActive('p23-spy');
  rail.n = {};
  outputs.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(((url: any, init: any) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);   // the local fake server only
    throw new Error('network forbidden in tests');
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff execution forbidden'); });
  execSpies = [vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking'), vi.spyOn(MockBookingProvider.prototype, 'executeBooking')];
  mockDecide = vi.spyOn(MockLLMProvider.prototype, 'generateStructuredDecision');
  mockSpeak = vi.spyOn(MockLLMProvider.prototype, 'generateSpokenResponse');
});
afterEach(() => {
  for (const c of fetchSpy.mock.calls) expect(String(c[0])).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(handoffSpy).not.toHaveBeenCalled();
  for (const s of execSpies) expect(s).not.toHaveBeenCalled();            // no booking provider is ever executed
  expect(process.env.REAL_IRCTC_ENABLED).toBe(envBefore);
  for (const out of outputs) {
    expect(out).not.toContain(KEY);                                         // key never in replies, logs or the session
    expect(out).not.toMatch(/HIDDEN-REASONING|<think>/);                    // private reasoning never surfaced
    expect(out).not.toMatch(/"bookingState":"COMPLETE"/);
  }
  fetchSpy.mockRestore(); handoffSpy.mockRestore(); for (const s of execSpies) s.mockRestore(); mockDecide.mockRestore(); mockSpeak.mockRestore();
  railwayRegistry.setActive('mock');
});

describe('P23 G3 — real LLM as the agentic brain (native tool calling, fake OpenAI-compatible model)', () => {
  it('[A] LLM tool call → backend executes → result goes back to the LLM → the LLM answers (no second wording call, no MockLLM)', async () => {
    const h = mk({ 'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH()], reasoning: 'HIDDEN-REASONING' }, v => ({ content: `Kal ke liye ${v.results[0].content.data.trains.length} trainein mili hain. 12014 Shatabdi subah 04:55 pe nikalti hai. Kaunsi chahiye?`, reasoning: 'HIDDEN-REASONING' })] });
    const r = await h.say('Kal Amritsar se Delhi jaana hai');
    expect(r.newState).toBe('SHOWING_TRAINS');
    expect(execs(r)).toEqual([['SEARCH_TRAINS', 'SUCCEEDED', null]]);
    expect(rail.n).toEqual({ search: 1 });
    const [q1, q2] = h.fake.decisionRequests.map(x => x.body);
    expect(h.fake.requests).toHaveLength(2);                                // 2 agent steps, no extra wording request
    expect(q1.messages.at(-1)).toEqual({ role: 'user', content: 'Kal Amritsar se Delhi jaana hai' });
    const call = q2.messages.at(-2);
    expect(call.role).toBe('assistant');
    expect(call.tool_calls[0].function.name).toBe('SEARCH_TRAINS');
    const res = q2.messages.at(-1);
    expect(res).toMatchObject({ role: 'tool', tool_call_id: call.tool_calls[0].id });
    expect(JSON.parse(res.content)).toMatchObject({ ok: true, data: { trains: [{ trainNumber: '12014' }, { trainNumber: '12497' }, { trainNumber: '18238' }] } });
    expect(r.assistantText).toBe('Kal ke liye 3 trainein mili hain. 12014 Shatabdi subah 04:55 pe nikalti hai. Kaunsi chahiye?');
    expect(r.turnLog.naturalSpeech).toMatchObject({ source: 'LLM', authoredBy: 'AGENT' });
    expect(r.cards.some((c: any) => c.type === 'trains')).toBe(true);
    expect(r.turnLog.llmProvider).toBe('openai-compatible');
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('[B] multi-step agent chain in ONE user turn: select (reference) → class → availability + fare in parallel → grounded answer', async () => {
    const h = mk({
      'beech wali, 3A mein — seat aur fare bata do': [
        { content: 'Ek second, dekhta hoon.', calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'DISPLAY_INDEX', value: 2 } })] },
        v => ({ calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: '3A' })], content: v.results[0].content.applied.join(',') === 'TRAIN_SELECTED' ? '' : 'BAD' }),
        { calls: [{ name: 'CHECK_AVAILABILITY', args: {} }, { name: 'GET_FARE', args: {} }] },
        v => ({ content: `12497 Shan-e-Punjab mein 3A ${v.results[2].content.data.status} hai aur fare ₹${v.results[3].content.data.perPassenger} per passenger hai. Kitne log jaayenge?` })
      ]
    });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n = h.fake.requests.length;
    const r = await h.say('beech wali, 3A mein — seat aur fare bata do');
    expect(h.fake.requests.length - n).toBe(4);
    expect(h.s().selectedTrain.number).toBe('12497');
    expect(h.s().selectedClass).toBe('3A');
    expect(execs(r)).toEqual([['CHECK_AVAILABILITY', 'SUCCEEDED', null], ['GET_FARE', 'SUCCEEDED', null]]);
    expect(rail.n).toMatchObject({ search: 1, avail: 1, fare: 1 });
    expect(r.turnLog.backendActions).toEqual(expect.arrayContaining(['TRAIN_SELECTED', 'CLASS_SELECTED']));
    expect(r.assistantText).toMatch(/^12497 Shan-e-Punjab mein 3A Available hai aur fare ₹650 per passenger hai\. Kitne log jaayenge\?$/);
    const last = h.fake.decisionRequests.at(-1)!.body.messages;
    expect(last.filter((m: any) => m.role === 'tool').slice(-4).map((m: any) => JSON.parse(m.content).ok)).toEqual([true, true, true, true]);
    expect(r.cards.map((c: any) => c.type)).toEqual(expect.arrayContaining(['availability', 'fare']));
  });

  it('[C] general railway knowledge needs no tool: answered by the LLM in one call, nothing executed, no state change (TEXT and VOICE, also mid-booking)', async () => {
    const h = mk({
      'Shatabdi aur Vande Bharat mein kya fark hai?': [{ content: 'Vande Bharat semi high speed train hai, 160 km/h tak design ki gayi hai. Shatabdi purani day-time chair car service hai. Dono mein CC aur EC class hoti hai.' }],
      'RAC ka matlab kya hota hai?': [{ content: 'RAC matlab Reservation Against Cancellation — aapko side lower berth share karni padti hai. Chart banne tak confirm ho sakti hai.' }],
      'Tatkal kya hai?': [{ content: 'Tatkal last-minute booking quota hai, jo yatra se ek din pehle khulta hai aur thoda mehenga hota hai.' }]
    });
    for (const [q, mode] of [['Shatabdi aur Vande Bharat mein kya fark hai?', 'TEXT'], ['RAC ka matlab kya hota hai?', 'VOICE'], ['Tatkal kya hai?', 'TEXT']] as const) {
      const n = h.fake.requests.length;
      const r = await h.say(q, mode);
      expect(h.fake.requests.length - n).toBe(1);
      expect(r.turnLog.toolExecutions).toEqual([]);
      expect(r.newState).toBe('IDLE');
      expect(r.error ?? null).toBeNull();
      expect(r.turnLog.naturalSpeech).toMatchObject({ source: 'LLM', authoredBy: 'AGENT', general: true });
    }
    expect(rail.n).toEqual({});
    // mid-booking: the question is answered, the booking stays exactly where it was (pending question kept)
    await h.say('Kal Amritsar se Delhi jaana hai');
    const before = { st: h.s().bookingState, v: h.s().searchResultsVersion, sel: h.s().selectedTrain };
    const r = await h.say('RAC ka matlab kya hota hai?', 'VOICE');
    expect({ st: h.s().bookingState, v: h.s().searchResultsVersion, sel: h.s().selectedTrain }).toEqual(before);
    expect(r.assistantText).toMatch(/^RAC matlab Reservation Against Cancellation/);
    expect(h.s().pendingInteraction.type).toBe('TRAIN_SELECTION_REQUIRED');
    expect(rail.n).toEqual({ search: 1 });
  });

  it('[D] dynamic next action: the LLM picks tools for arbitrary questions and info in any order — no fixed route→date→train→class path', async () => {
    const h = mk({
      '12014 kitne baje Delhi pahunchti hai, kaun se stations?': [{ calls: [{ name: 'GET_TIMETABLE', args: { trainNumber: '12014' } }] }, { content: '12014 ka timetable upar card mein hai.' }],
      'Shan-e-Punjab abhi kahan hai?': [{ calls: [{ name: 'TRACK_TRAIN', args: { trainNumber: '12497' } }] }, { content: 'Train Ludhiana cross kar chuki hai.' }]
    });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r1 = await h.say('12014 kitne baje Delhi pahunchti hai, kaun se stations?');
    expect(execs(r1)).toEqual([['GET_TIMETABLE', 'SUCCEEDED', null]]);
    expect(h.s().bookingState).toBe('SHOWING_TRAINS');                      // information ≠ selection
    expect(h.s().selectedTrain).toBeFalsy();
    expect(r1.cards.some((c: any) => c.type === 'timetable')).toBe(true);
    const r2 = await h.say('Shan-e-Punjab abhi kahan hai?');
    expect(execs(r2)[0][0]).toBe('TRACK_TRAIN');
    expect(JSON.parse(h.fake.decisionRequests.at(-1)!.body.messages.at(-1).content)).toMatchObject({ ok: false, error: { code: 'LIVE_STATUS_UNAVAILABLE' } });
    expect(r2.assistantText).not.toMatch(/Ludhiana cross/);                  // live status: authoritative wording only
    // a different session gives everything at once, in its own order → the LLM batches proposal + search
    const h2 = mk({ 'Do log hain, AC chahiye, kal Amritsar se Delhi': [{ calls: [U('UPDATE_PASSENGERS', 'UPDATE_PASSENGERS', { passengersCountRaw: '2', preferredClassRaw: 'AC' }), SEARCH()] }, { content: 'Do logon ke liye kal ki trainein dikha raha hoon. Kaunsi chahiye?' }] });
    const r3 = await h2.say('Do log hain, AC chahiye, kal Amritsar se Delhi');
    expect(h2.s().passengersCount).toBe(2);
    expect(r3.newState).toBe('SHOWING_TRAINS');
    expect(execs(r3)).toEqual([['SEARCH_TRAINS', 'SUCCEEDED', null]]);
  });

  it('[E] references are LLM proposals the backend resolves; unresolved → the rejection goes back to the LLM, which asks (no second deterministic reading)', async () => {
    const table: Array<[string, any, string]> = [
      ['doosri wali', { kind: 'DISPLAY_INDEX', value: 2 }, '12497'],
      ['last wali', { kind: 'DISPLAY_INDEX', value: 3 }, '18238'],
      ['12014 wali', { kind: 'TRAIN_NUMBER', value: '12014' }, '12014'],
      ['shaam wali', { kind: 'TIME_PREFERENCE', value: 'EVENING' }, '18238']
    ];
    for (const [words, ref, expected] of table) {
      const h = mk({ [words]: [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: ref })] }, { content: 'Theek hai, ye train le li. Kaunsi class chahiye?' }] });
      await h.say('Kal Amritsar se Delhi jaana hai');
      const r = await h.say(words);
      expect(h.s().selectedTrain.number).toBe(expected);
      expect(r.newState).toBe('CLASS_OPTIONS');
    }
    const h = mk({ 'nauvi wali': [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'DISPLAY_INDEX', value: 9 } })] }, v => ({ content: v.results[0].content.error?.code === 'INVALID_TRAIN_REFERENCE' ? 'List mein sirf 3 trainein hain — kaunsi chahiye?' : 'WRONG' })] });
    await h.say('Kal Amritsar se Delhi jaana hai');
    const r = await h.say('nauvi wali');
    expect(h.s().selectedTrain).toBeFalsy();
    expect(r.newState).toBe('SHOWING_TRAINS');
    expect(r.error?.code).toBe('INVALID_TRAIN_REFERENCE');
    expect(r.assistantText).toMatch(/^List mein sirf 3 trainein hain — kaunsi chahiye\?/);
    // "kal nahi parso": correction proposal + fresh search in one step; selection re-validated on the new date
    const h3 = mk({ 'kal nahi parso': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso', correctionTarget: 'date', correctionValueRaw: 'parso' }), SEARCH('parso')] }, { content: 'Parso ki trainein dekh li.' }] });
    await h3.run(['Kal Amritsar se Delhi jaana hai', '12014 wali CC mein']);
    const d1 = h3.s().date;
    const searchesBefore = rail.n.search;
    const r3 = await h3.say('kal nahi parso');
    expect(h3.s().date > d1).toBe(true);
    expect(execs(r3)).toEqual([['SEARCH_TRAINS', 'SUCCEEDED', null]]);
    expect(rail.n.search - searchesBefore).toBe(1);                           // fresh data, never cached
    expect([h3.s().selectedTrain?.number, h3.s().selectedClass]).toEqual(['12014', 'CC']);
  });

  it('[F] booking / payment tools requested by the LLM are rejected by the runtime; the LLM hears it; a false success / PNR claim never reaches the user', async () => {
    const h = mk({
      'book karke payment bhi kar do': [
        { calls: [{ name: 'BOOK_TICKET', args: { train: '12014' } }, { name: 'MAKE_PAYMENT', args: { amount: 1040, upi: 'x@y' } }, { name: 'executeBooking', args: {} }, { name: 'FINAL_SUBMISSION', args: {} }] },
        v => ({ content: v.results.every(r => r.content.ok === false) ? 'Ho gaya! Aapki ticket book ho gayi, PNR 4512345678 hai.' : 'WRONG' })
      ]
    });
    await h.run(REVIEW);
    const before = JSON.stringify({ st: h.s().bookingState, rv: h.s().review?.version, p: h.s().passengers });
    const r = await h.say('book karke payment bhi kar do');
    expect(execs(r)).toEqual([['BOOK_TICKET', 'REJECTED', 'FORBIDDEN_ACTION'], ['MAKE_PAYMENT', 'REJECTED', 'FORBIDDEN_ACTION'], ['executeBooking', 'REJECTED', 'FORBIDDEN_ACTION'], ['FINAL_SUBMISSION', 'REJECTED', 'FORBIDDEN_ACTION']]);
    expect(JSON.stringify({ st: h.s().bookingState, rv: h.s().review?.version, p: h.s().passengers })).toBe(before);
    expect(r.assistantText).not.toMatch(/book ho gayi|4512345678/);
    expect(r.responseMessage).not.toMatch(/book ho gayi|4512345678/);
    expect(r.assistantText).toMatch(/seedha nahi kar sakta/);               // the backend states the boundary itself
    expect(r.assistantText).not.toMatch(/^Ho gaya/);
    expect(h.s().bookingState).not.toBe('IRCTC_HANDOFF_READY');
  });

  it('[G] sensitive input never reaches the LLM (pre-filter); the agent never gets OTP / PIN / passwords', async () => {
    const h = mk();
    await h.say('Kal Amritsar se Delhi jaana hai');
    const n = h.fake.requests.length;
    for (const t of ['mera OTP 482913 hai, jaldi book karo', 'UPI PIN 4321 le lo', 'IRCTC password Mohit@123 hai']) {
      const r = await h.say(t);
      expect(r.error?.code).toBe('SENSITIVE_REQUEST_REJECTED');
      expect(r.turnLog.toolExecutions).toEqual([]);
    }
    expect(h.fake.requests.length).toBe(n);                                   // not a single LLM request
    await h.say('Kal Amritsar se Delhi jaana hai');
    for (const q of h.fake.requests) expect(JSON.stringify(q.body)).not.toMatch(/482913|4321|Mohit@123/);
  });

  it('[H] confirmation needs the user’s real "haan": an LLM-invented confirm is rejected; a real one reaches handoff-ready only — never booked', async () => {
    const h = mk({
      'train kab chalti hai?': [{ calls: [U('CONFIRM_BOOKING', 'PREPARE_IRCTC_HANDOFF', { affirmation: true })] }, v => ({ content: v.results[0].content.ok ? 'WRONG' : '12014 subah 04:55 pe chalti hai. Confirm karna ho to haan boliye.' })],
      'haan, confirm': [{ calls: [U('CONFIRM_BOOKING', 'PREPARE_IRCTC_HANDOFF', { affirmation: true })] }, { content: 'Ho gaya! Ticket book ho gayi, PNR 4512345678.' }]
    });
    await h.run(REVIEW);
    expect(h.s().bookingState).toBe('AWAITING_CONFIRMATION');
    const r1 = await h.say('train kab chalti hai?');
    expect(r1.error?.code).toBe('INVALID_CONFIRMATION');
    expect(h.s().bookingState).toBe('AWAITING_CONFIRMATION');
    expect(r1.assistantText).toMatch(/04:55/);
    const r2 = await h.say('haan, confirm');
    expect(r2.newState).toBe('IRCTC_HANDOFF_READY');
    expect(r2.turnLog.backendActions).toContain('CONFIRMATION_ACCEPTED_BY_GUARD');
    expect(r2.assistantText).toMatch(/book nahi hua/i);
    expect(r2.assistantText).not.toMatch(/4512345678|book ho gayi/);
  });

  it('[I] fact validation keeps the agent honest after tools: wrong time / count / fare sentences are removed, correct ones stay', async () => {
    const h = mk({ 'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH()] }, { content: '3 trainein mili hain. 12497 subah 06:35 pe chalti hai. 12014 raat 11:45 pe chalti hai. Kul 7 trainein hain. Sabse sasta ticket ₹99 ka hai. Kaunsi chahiye?' }] });
    const r = await h.say('Kal Amritsar se Delhi jaana hai');
    expect(r.assistantText).toBe('3 trainein mili hain. 12497 subah 06:35 pe chalti hai. Kaunsi chahiye?');
    expect(r.turnLog.naturalSpeech.rejected.length).toBe(3);
  });

  it('[J] LLM failure: before tools → safe unavailable reply, session untouched; mid-chain → verified results kept, no guess; never MockLLM', async () => {
    const h = mk({ 'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH()] }, { status: 500 }], '12014 wali CC mein': [{ status: 503 }] });
    const r1 = await h.say('Kal Amritsar se Delhi jaana hai');
    expect(r1.error?.code).toBe('LLM_UNAVAILABLE');
    expect(rail.n).toEqual({ search: 1 });
    expect(r1.cards.some((c: any) => c.type === 'trains')).toBe(true);        // the verified search stays visible
    const snap = JSON.stringify({ st: h.s().bookingState, sel: h.s().selectedTrain, c: h.s().selectedClass, v: h.s().searchResultsVersion });
    const r2 = await h.say('12014 wali CC mein');
    expect(r2.error?.code).toBe('LLM_UNAVAILABLE');
    expect(r2.responseMessage).toContain(LLM_UNAVAILABLE_MESSAGE);
    expect(JSON.stringify({ st: h.s().bookingState, sel: h.s().selectedTrain, c: h.s().selectedClass, v: h.s().searchResultsVersion })).toBe(snap);
    expect(r2.turnLog.toolExecutions).toEqual([]);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('[K] no hidden fallback: a misconfigured real LLM fails closed every turn (no MockLLM, no railway calls); a failing configured model is never swapped', async () => {
    const h = mk({}, { env: { LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'fake-glm' } });   // key missing
    expect(h.sel.info).toMatchObject({ providerId: 'llm-unavailable', reason: 'MISSING_LLM_API_KEY' });
    for (const t of ['Kal Amritsar se Delhi jaana hai', 'Shatabdi kya hai?']) {
      const r = await h.say(t);
      expect(r.error?.code).toBe('LLM_UNAVAILABLE');
      expect(r.responseMessage).toContain(LLM_UNAVAILABLE_MESSAGE);
      expect(r.newState).toBe('IDLE');
    }
    expect(rail.n).toEqual({});
    expect(h.fake.requests).toHaveLength(0);
    const h2 = mk({ 'Kal Amritsar se Delhi jaana hai': () => ({ status: 429 }) });
    for (let k = 0; k < 3; k++) expect((await h2.say('Kal Amritsar se Delhi jaana hai')).error?.code).toBe('LLM_UNAVAILABLE');
    expect(h2.fake.requests.map(q => q.body.model)).toEqual(['fake-glm', 'fake-glm', 'fake-glm']);
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('[L] MockLLM compatibility: with no LLM config the offline MockLLM still runs the same backend flow (no fake-server traffic)', async () => {
    const h = mk({}, { env: {} });
    expect(h.sel.info).toMatchObject({ providerId: 'mock-llm', reason: 'DEFAULT_MOCK' });
    const r = await h.run(['Amritsar se Delhi kal', '12014 wali kar do', 'CC']);
    expect([h.s().selectedTrain?.number, h.s().selectedClass]).toEqual(['12014', 'CC']);
    expect(r.turnLog.llmProvider).toBe('mock-llm');
    expect(h.fake.requests).toHaveLength(0);
    expect(mockDecide).toHaveBeenCalled();
  });

  it('[M] text / voice parity: same agent engine, same tools and state; voice is concise; the voice pipeline speaks the agent’s validated reply', async () => {
    const plan: Plan = { 'Kal Amritsar se Delhi jaana hai': [{ calls: [SEARCH()] }, { content: 'Kal ke liye 3 trainein mili hain. 12014 Shatabdi subah 04:55 pe nikalti hai, 12497 06:35 pe aur 18238 shaam 19:35 pe. Sabse jaldi 12014 hai. Kaunsi chahiye?' }] };
    const t = mk(plan); const v = mk(plan);
    const rt = await t.say('Kal Amritsar se Delhi jaana hai', 'TEXT');
    const rv = await v.say('Kal Amritsar se Delhi jaana hai', 'VOICE');
    expect(execs(rv)).toEqual(execs(rt));
    expect([v.s().bookingState, v.s().searchResults.trains.length]).toEqual([t.s().bookingState, t.s().searchResults.trains.length]);
    expect(v.fake.decisionRequests.length).toBe(t.fake.decisionRequests.length);
    expect(v.fake.decisionRequests[0].body.tools).toEqual(t.fake.decisionRequests[0].body.tools);
    expect(JSON.parse(v.fake.decisionRequests[0].body.messages[1].content.split('\n').slice(1).join('\n')).inputMode).toBe('VOICE');
    const voiceText = rv.assistantResponse.speechText;
    expect(voiceText.length).toBeLessThanOrEqual(260);
    expect(voiceText.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(3);
    expect(rt.assistantText.length).toBeGreaterThanOrEqual(voiceText.length);
    // the real voice pipeline (mock STT/TTS) over the same engine
    const w = mk(plan);
    let now = 1000;
    const stt = new MockStreamingSTT(); const tts = new MockStreamingTTS();
    const agent = createEngineVoiceAgent({ engine: w.eng, sessionId: w.sid, output: tts, input: stt, now: () => now });
    agent.listen();                                                          // explicit tap-to-talk
    stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'Kal Amritsar se Delhi jaana hai' }); now += 300;
    stt.push({ kind: 'final', text: 'Kal Amritsar se Delhi jaana hai' }, { kind: 'speechEnd' }); now += 400;
    await agent.tick();
    await flush(); while (tts.playing) { tts.finish(); await flush(); }
    const spoken = tts.spoken.map(x => x.text).join(' ');
    expect(spoken).toMatch(/Kal ke liye 3 trainein mili hain/);
    expect(w.s().bookingState).toBe('SHOWING_TRAINS');
  });

  it('[N] real HTTP: the agent talks to a local OpenAI-compatible server through real fetch; the key is only an auth header', async () => {
    const fake = new FakeOpenAI(v => v.step === 0 ? { calls: [SEARCH()] } : { content: `Kal ki ${v.results[0].content.data.trains.length} trainein mili hain. Kaunsi chahiye?` });
    const base = await fake.listen();
    try {
      const h = mk({}, { env: { ...ENV, LLM_BASE_URL: base }, fetch: false });
      const r = await h.say('Kal Amritsar se Delhi jaana hai');
      expect(r.newState).toBe('SHOWING_TRAINS');
      expect(r.assistantText).toBe('Kal ki 3 trainein mili hain. Kaunsi chahiye?');
      expect(fake.requests).toHaveLength(2);
      expect(fake.requests.every(q => q.headers.authorization === `Bearer ${KEY}`)).toBe(true);
      expect(fake.requests.some(q => JSON.stringify(q.body).includes(KEY))).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally { await fake.close(); }
  });
});
