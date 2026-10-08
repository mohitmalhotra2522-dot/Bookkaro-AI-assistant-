/**
 * PROMPT 34 — G3: production voice through the FULL stack (§22 A–AN).
 *   mic (MockStreamingSTT) → ConversationalVoiceAgent (turn detection, barge-in) → engineTurnProcessor →
 *   ConversationTurnEngine → orchestrator → LLM decides (native tool calls, injected fake server) → validator →
 *   RailwayToolRuntime → spy railway → fact / action / booking guards → final validated text → TTS (MockStreamingTTS).
 * The voice path has no brain of its own: the SAME agent, tools, state and guards as text. Deterministic mocks only —
 * no microphone, no audio, no network, no credits, no booking / payment / IRCTC.
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
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';
import { currentResults } from '../../server/ai/context/train-reference-resolver';
import { createEngineVoiceAgent } from '../../server/voice/server-voice-agent';
import { MockStreamingSTT } from '../../server/voice/stt/stt-provider';
import { MockStreamingTTS } from '../../server/voice/tts/tts-provider';
import { normalizeTranscript } from '../../shared/voice/stt-normalizer';
import { VoiceTranscriptRejectedError } from '../../shared/voice/transcript';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';
import { BookingState } from '../../shared/states';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const pmeta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p34-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };
type Mode = 'ok' | 'timeout' | 'fail' | 'malformed';
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; mode: Record<string, Mode> = {}; calls: Array<[string, string, string, string]> = [];
  gate: Promise<void> | null = null;
  private async b(k: string, r: any) { this.n[k] = (this.n[k] || 0) + 1; this.calls.push([k, String(r?.trainNumber ?? ''), String(r?.travelClass ?? ''), String(r?.date ?? '')]); if (this.gate) await this.gate; }
  private fault(k: string): any {
    const m = this.mode[k] || 'ok';
    if (m === 'timeout') return new Promise(() => { /* never answers → runtime TIMEOUT */ });
    if (m === 'fail') return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'upstream down' }, meta: pmeta() };
    if (m === 'malformed') return { ok: true, data: { weird: true }, meta: pmeta() };
    return null;
  }
  /** P42.12: search rows WITHOUT per-class availability (live RailCore shape: availability null, UNKNOWN). */
  listedOnly = false;
  async searchTrains(r: any): Promise<any> {
    await this.b('search', r);
    const res: any = this.fault('search') ?? await super.searchTrains(r);
    if (this.listedOnly && res?.data?.trains) res.data.trains = res.data.trains.map((t: any) => ({ ...t, classes: (t.classes || []).map((c: any) => ({ ...c, availability: null, availabilityStatus: 'UNKNOWN' })) }));
    return res;
  }
  async checkAvailability(r: any): Promise<any> { await this.b('avail', r); return this.fault('avail') ?? super.checkAvailability(r); }
  async getFare(r: any): Promise<any> { await this.b('fare', r); return this.fault('fare') ?? super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p34-spy', () => rail);

const KEY = 'sk-live-P34-E2E-SECRET-34343';
const KAL = (resolveDate('kal') as any).date as string;
const PARSO = (resolveDate('parso') as any).date as string;
const outputs: string[] = [];
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SRCH = (date: string, origin = 'Amritsar') => ({ name: 'SEARCH_TRAINS', args: { origin, destination: 'Delhi', date } });
const REF = (trainRef: any, extra: any = {}) => U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef, selectionPurpose: 'INFORMATION', ...extra });
const SEL = (num: string, cls?: string) => REF({ kind: 'TRAIN_NUMBER', value: num }, cls ? { classRaw: cls } : {});
const CAV = (num: string, cls: string) => ({ name: 'CHECK_AVAILABILITY', args: { trainNumber: num, travelClass: cls } });
const CFARE = (num: string, cls: string) => ({ name: 'GET_FARE', args: { trainNumber: num, travelClass: cls } });
const PAX = (...p: Array<[number, any]>) => p.map(([passengerIndex, changes]) => ({ passengerIndex, changes }));
const CONFIRM = U('CONFIRM_BOOKING', 'PREPARE_IRCTC_HANDOFF', { affirmation: true });
const START = 'Kal Amritsar se Delhi jaana hai';
const ALL_IN_ONE = 'Doosri wali 3A, do log: Rahul 31 male, Neha 28 female';
const BASE: Record<string, any[]> = {
  [START]: [{ calls: [SRCH('kal')] }, { content: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?' }],
  'कल अमृतसर से दिल्ली जाना है': [{ calls: [SRCH('kal')] }, { content: 'कल के लिए ट्रेनें मिल गई हैं। कौन सी ट्रेन चाहिए?' }],
  'I want to go from Amritsar to Delhi tomorrow': [{ calls: [SRCH('kal')] }, { content: 'I found 3 trains for tomorrow. Which one would you like?' }],
  'Doosri wali ka 3A fare batao': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 2 }, { classRaw: '3A' })] }, { calls: [CFARE('12497', '3A')] }, { content: '12497 mein 3A ka fare ₹650 per passenger hai.' }],
  'Iski availability bhi batao': [{ calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }],
  'Doosri wali': [{ calls: [REF({ kind: 'DISPLAY_INDEX', value: 2 })] }, { content: 'Doosri wali 12497 Shan-e-Punjab hai.' }],
  'Iska 3A fare': [{ calls: [U('SELECT_CLASS', 'SELECT_CLASS', { classRaw: '3A', selectionPurpose: 'INFORMATION' })] }, { calls: [CFARE('12497', '3A')] }, { content: '12497 mein 3A ka fare ₹650 per passenger hai.' }],
  'Woh wali': [{ content: 'Kaunsi train — 12014, 12497 ya 18238?' }],
  '12497 3A availability': [{ calls: [SEL('12497', '3A')] }, { calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A mein seat nahi hai.' }],
  '12497 3A ki availability batao': [{ calls: [SEL('12497', '3A')] }, { content: 'Ek second, 12497 ki 3A availability dekhta hoon.', calls: [CAV('12497', '3A')] }, { content: '12497 mein 3A available hai.' }],
  'Kal nahi, parso': [{ calls: [U('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: 'parso' }), SRCH('parso')] }, { content: 'Parso ki trainein dekh li. 12497 mein 3A available hai.' }],
  '12497 3A mein seat hai?': [{ content: '12497 mein 3A available hai, fare ₹999 hai.' }],
  '12497 3A ka status': [{ calls: [CAV('12014', 'CC')] }, { content: '12497 mein 3A available hai.' }],
  '12497 3A ka fare kitna hai': [{ content: '12497 mein 3A ka fare ₹650 hai.' }],
  '12497 3A fare': [{ calls: [SEL('12497', '3A')] }, { calls: [CFARE('12497', '3A')] }, { content: '12497 mein 3A ka fare ₹650 hai.' }],
  'Fare dobara dekho': [{ calls: [CFARE('12497', '3A'), CFARE('12497', '3A')] }, { content: '12497 mein 3A ka fare ₹650 hai.' }],
  'Sab classes ki availability': [{ calls: [CAV('12014', 'CC'), CAV('12014', '2S'), CAV('12497', '3A'), CAV('12497', 'CC'), CAV('12497', 'SL'), CAV('12497', '2S'), CAV('18238', '3A'), CAV('18238', 'SL'), CAV('12014', '3A'), CAV('18238', 'CC')] }, { content: 'Theek hai.' }],
  'RAC kya hota hai?': [{ content: 'RAC matlab Reservation Against Cancellation — aadhi berth share karni padti hai.' }],
  '12014 CC': [{ calls: [SEL('12014', 'CC')] }, { content: '12014 CC theek hai.' }],
  '12497 3A': [{ calls: [SEL('12497', '3A')] }, { content: '12497 3A theek hai.' }],
  [ALL_IN_ONE]: [{ calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, classRaw: '3A', passengersCountRaw: '2', selectionPurpose: 'BOOKING',
    passengerChanges: PAX([1, { name: 'Rahul', age: 31, gender: 'male' }], [2, { name: 'Neha', age: 28, gender: 'female' }]) })] }, { content: 'Review ready.' }],
  'theek hai': [{ calls: [CONFIRM] }, { content: 'Confirm?' }],
  'haan confirm': [{ calls: [CONFIRM] }, { content: 'Details confirmed hain; booking handoff ready hai. Ticket abhi book nahi hua hai.' }],
  'seedha book kar do': [{ calls: [{ name: 'BOOK_TICKET', args: { trainNumber: '12497' } }, { name: 'MAKE_PAYMENT', args: { amount: 1300 } }] }, { content: 'Booked! Payment ho gaya.' }],
  'Ticket book ho gayi?': [{ content: 'Haan, ticket book ho gayi! PNR 4512345678.' }]
};
const norm = (t: string) => normalizeTranscript(t).text.trim().toLowerCase();

function native(extra: Record<string, any[]> = {}) {
  const plan = { ...BASE, ...extra };
  const byNorm = new Map(Object.entries(plan).map(([k, v]) => [norm(k), v]));
  const fake = new FakeOpenAI((v: TurnView) => { const p = plan[v.user] ?? byNorm.get(norm(v.user)); return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  // LLM gate (stale tests): hold the FIRST decision request of a given user text until released
  const llmGate: { user: string | null; p: Promise<void> | null } = { user: null, p: null };
  const gated: typeof fake.fetch = async (u, init) => {
    const b = JSON.parse(init.body);
    const msgs: any[] = b.messages || [];
    const ui = msgs.map(m => m.role).lastIndexOf('user');
    if (llmGate.p && Array.isArray(b.tools) && ui >= 0 && norm(String(msgs[ui].content)) === norm(llmGate.user || '') && !msgs.slice(ui + 1).length) await llmGate.p;
    return fake.fetch(u, init);
  };
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: gated });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 150, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  const results: any[] = [];
  const orig = eng.processTurn.bind(eng);
  (eng as any).processTurn = async (...a: Parameters<typeof eng.processTurn>) => {
    const r: any = await orig(...a);
    results.push(r); outputs.push(JSON.stringify({ r, s: state.getSession(a[0]) }));
    return r;
  };
  const say = (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT', o: any = {}) => eng.processTurn(sid, t, mode, o) as Promise<any>;
  return { eng, orch, sid, say, fake, llmGate, results, last: () => results[results.length - 1], s: () => state.getSession(sid) as any, state };
}
type H = ReturnType<typeof native>;

/** The production voice coordinator wired to the SAME engine (tap-to-talk by default). */
function voiceOf(h: H) {
  let now = 50_000;
  const stt = new MockStreamingSTT();
  const tts = new MockStreamingTTS();
  const agent = createEngineVoiceAgent({ engine: h.eng, sessionId: h.sid, output: tts, input: stt, now: () => now });
  const events: any[] = [];
  agent.on(e => events.push(e));
  const utter = async (text: string, meta: { confidence?: number; language?: string } = {}) => {
    if (!agent.snapshot().listening) agent.listen();
    stt.push({ kind: 'speechStart' }, { kind: 'partial', text: text.split(' ')[0], ...meta });
    now += 300;
    stt.push({ kind: 'final', text, ...meta }, { kind: 'speechEnd' });
    now += 400;
    const p = agent.tick();
    const o = p ? await p : null;
    await flush();
    return o;
  };
  const drain = async () => { for (let i = 0; i < 30 && tts.playing; i++) { tts.finish(); await flush(); } };
  const spokenFor = (turnId: string) => tts.spoken.filter(x => x.turnId === turnId && x.status === 'DONE').map(x => x.text);
  /** What TTS spoke as the RESPONSE of a turn — i.e. without the P29 acknowledgement ("Ek second, … check kar raha hoon"). */
  const spokenResponse = (r: any) => { const ack = new Set((r.progress || []).map((p: any) => String(p.speechText || p.text))); return spokenFor(r.turn.turnId).filter(t => !ack.has(t)); };
  const record = () => outputs.push(JSON.stringify({ m: agent.voiceMetrics(), e: events, t: tts.spoken, snap: agent.snapshot() }));
  return { agent, stt, tts, events, utter, drain, spokenFor, spokenResponse, record, advance: (ms: number) => { now += ms; } };
}
const shown = (r: any) => [r.voice?.assistantText, r.responseMessage, r.voice?.speechText, ...(r.voice?.segments || [])].map(x => String(x ?? '')).join(' | ');
const delta = (n0: Record<string, number>) => Object.fromEntries(['search', 'avail', 'fare'].map(k => [k, (rail.n[k] || 0) - (n0[k] || 0)]));
const userMsgs = (h: H) => h.fake.decisionRequests.map(r => { const m = r.body.messages; return String(m[m.map((x: any) => x.role).lastIndexOf('user')].content); });
const NO_SUCCESS = /book ho gayi|booking confirmed|booked successfully|PNR\s*\d{6,}|payment ho gaya|transaction id/i;
const REASK = /doosre passenger|passenger\s*2\b|neha ki details|details bataiye|details batayein|naam, age/i;
const nums = (t: string) => (String(t).match(/\d[\d,]*/g) || []).map(x => x.replace(/,/g, ''));

const realFetch = globalThis.fetch.bind(globalThis);
let fetchSpy: any, handoffSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p34-spy');
  rail.n = {}; rail.mode = {}; rail.calls = []; rail.gate = null; rail.listedOnly = false;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(((u: any, i: any) => {
    if (String(u).startsWith('http://127.0.0.1:')) return realFetch(u, i);
    throw new Error(`NO NETWORK IN TESTS: ${u}`);
  }) as any);
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff forbidden'); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); railwayRegistry.setActive('mock'); });

describe('P34 G3 — one agent for text and voice (A–D, parity + languages)', () => {
  it('[A] voice uses the SAME agent pipeline as text: same tool schemas, same tool calls, same state, one turn; voice observability attached', async () => {
    const t = native(); const v = native(); const vo = voiceOf(v);
    await t.say(START, 'TEXT');
    await vo.utter(START, { confidence: 0.92, language: 'hi-IN' });
    expect(v.fake.decisionRequests.length).toBe(t.fake.decisionRequests.length);
    expect(JSON.stringify(v.fake.decisionRequests[0].body.tools)).toBe(JSON.stringify(t.fake.decisionRequests[0].body.tools));
    expect(userMsgs(v)).toEqual(userMsgs(t));
    expect(currentResults(v.s()).map(x => x.trainNumber)).toEqual(currentResults(t.s()).map(x => x.trainNumber));
    expect(rail.calls.filter(c => c[0] === 'search').map(c => c[3])).toEqual([KAL, KAL]);
    const vr = v.last(), tr = t.last();
    expect(vr.turnLog.diagnostics.toolNames).toEqual(tr.turnLog.diagnostics.toolNames);
    expect(v.eng.getTurns(v.sid)).toHaveLength(1);                           // one voice turn = one agent turn
    expect(vr.turnLog.voiceTurn).toMatchObject({ mode: 'VOICE', inputSource: 'STT', transcriptStatus: 'FINAL', transcriptConfidence: 0.92, languageHint: 'hi-IN', providerCalls: 1, stale: false, failureCategory: null });
    expect(vr.turnLog.voiceTurn.llmCallCount).toBe(tr.turnLog.diagnostics.llmCalls);
    expect(tr.turnLog.voiceTurn).toBeUndefined();
    await vo.drain();
    expect(vo.spokenResponse(vr).join(' ')).toBe(vr.voice.speechText);
    const acks = (vr.progress || []).map((p: any) => String(p.speechText || p.text));
    expect(vo.spokenFor(vr.turn.turnId)).toEqual([...acks, ...vo.spokenResponse(vr)]);   // ack (after tool start) first, then the validated reply
    vo.record();
  });

  it('[B/C/D] Hindi / Hinglish / English speech → the transcript reaches the LLM verbatim; same tool; reply in the user\'s language; numbers kept', async () => {
    for (const [said, lang, script] of [['कल अमृतसर से दिल्ली जाना है', 'hi-IN', /[\u0900-\u097F]/], [START, 'en-IN', /trainein/], ['I want to go from Amritsar to Delhi tomorrow', 'en-IN', /trains for tomorrow/]] as const) {
      const h = native(); const vo = voiceOf(h);
      const n0 = { ...rail.n };
      await vo.utter(said, { language: lang });
      expect(userMsgs(h)[0]).toBe(normalizeTranscript(said).text);           // nothing invented / translated by the voice layer
      expect(delta(n0)).toEqual({ search: 1, avail: 0, fare: 0 });
      expect(rail.calls.slice(-1)[0][3]).toBe(KAL);
      const r = h.last();
      expect(r.voice.speechText).toMatch(script);
      expect(r.turnLog.voiceTurn.languageHint).toBe(lang);
      await vo.drain();
      expect(vo.spokenResponse(r).join(' ')).toBe(r.voice.speechText);
    }
  });
});

describe('P34 G3 — STT boundary + turn detection (E, F)', () => {
  it('[E] interim speech never acts: no LLM call, no tool, no state change (agent AND HTTP/engine boundary)', async () => {
    const h = native(); const vo = voiceOf(h);
    const v0 = h.s().sessionVersion;
    vo.agent.listen();
    vo.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'Kal Amritsar se Delhi' }, { kind: 'speechEnd' });
    for (const ms of [400, 800, 2500]) { vo.advance(ms); expect(vo.agent.tick()).toBeNull(); }
    await expect(h.say('Kal Amritsar se Delhi', 'VOICE', { transcript: { status: 'INTERIM' } })).rejects.toBeInstanceOf(VoiceTranscriptRejectedError);
    expect(h.fake.requests).toHaveLength(0);
    expect(rail.n).toEqual({});
    expect(h.eng.getTurns(h.sid)).toHaveLength(0);
    expect(h.s().sessionVersion).toBe(v0);
    expect(vo.events.some(e => e.type === 'TRANSCRIPT_INCOMPLETE')).toBe(true);
  });

  it('[F] the FINAL transcript triggers exactly one agent turn with that text', async () => {
    const h = native(); const vo = voiceOf(h);
    await vo.utter(START);
    expect(userMsgs(h)).toEqual([START, START]);                               // decision + continuation of ONE turn
    expect(h.eng.getTurns(h.sid)).toHaveLength(1);
    expect(rail.n.search).toBe(1);
  });
});

describe('P34 G3 — mode switching, references, corrections (G–M)', () => {
  it('[G/I/J] TEXT → VOICE → TEXT keeps context: "doosri wali" by voice = 12497 of the current list; "iski" follows the focus', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START, 'TEXT');
    const second = currentResults(h.s())[1].trainNumber;
    await vo.utter('Doosri wali ka 3A fare batao');
    expect(h.s().selectedTrain.number).toBe(second);
    expect(rail.calls.filter(c => c[0] === 'fare').slice(-1)[0].slice(1, 3)).toEqual(['12497', '3A']);
    expect(h.last().voice.speechText).toMatch(/650/);
    await vo.drain();
    const r = await h.say('Iski availability bhi batao', 'TEXT');
    expect(rail.calls.filter(c => c[0] === 'avail').slice(-1)[0].slice(1, 3)).toEqual(['12497', '3A']);
    expect(shown(r)).toMatch(/12497/);
    expect(h.results.map(x => (x.turnLog.voiceTurn ? 'VOICE' : 'TEXT'))).toEqual(['TEXT', 'VOICE', 'TEXT']);
    expect(h.eng.getTurns(h.sid)).toHaveLength(3);                             // one shared session / turn sequence
  });

  it('[H] VOICE → TEXT → VOICE keeps context (same session, same focus, same tool authority)', async () => {
    const h = native(); const vo = voiceOf(h);
    await vo.utter(START); await vo.drain();
    await h.say('Doosri wali', 'TEXT');
    expect(h.s().selectedTrain.number).toBe('12497');
    const n0 = { ...rail.n };
    await vo.utter('Iska 3A fare');
    expect(delta(n0)).toEqual({ search: 0, avail: 0, fare: 1 });
    expect(h.last().voice.speechText).toMatch(/12497.*650/);
  });

  it('[K] an ambiguous spoken reference → the agent asks; nothing is selected or checked', async () => {
    const h = native(); const vo = voiceOf(h);
    await vo.utter(START); await vo.drain();
    const n0 = { ...rail.n };
    await vo.utter('Woh wali');
    expect(delta(n0)).toEqual({ search: 0, avail: 0, fare: 0 });
    expect(h.s().selectedTrain).toBeFalsy();
    expect(h.last().voice.speechText).toMatch(/\?$/);
  });

  it('[L/M] spoken date correction: the LLM searches the NEW date; old availability is invalidated and never spoken as current', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START);
    await h.say('12497 3A ki availability batao');
    expect(h.s().availability).toBeTruthy();
    await vo.utter('Kal nahi, parso');
    const r = h.last();
    expect(rail.calls.filter(c => c[0] === 'search').slice(-1)[0][3]).toBe(PARSO);
    expect(h.s().date).toBe(PARSO);
    expect(h.s().availability).toBeFalsy();
    expect(shown(r)).not.toMatch(/available hai/i);                           // previous-date fact removed (text + voice)
    expect(r.responseMessage).toMatch(/\b\d{1,2} Oct\b|parso/i);              // the new date is what the agent reports
  });
});

describe('P34 G3 — fact authority + truthful failures (N–T)', () => {
  it('[N/O] no spoken railway fact without its tool: no-tool and wrong-train availability claims are removed; GET_FARE facts may be spoken', async () => {
    const h = native();
    rail.listedOnly = true;                                                       // P42.12: rows list classes only (no availability value)
    await h.say(START);
    const a = await h.say('12497 3A mein seat hai?', 'VOICE');
    expect(shown(a)).not.toMatch(/999|available hai/);
    const b = await h.say('12497 3A ka status', 'VOICE');                         // CHECK_AVAILABILITY ran for 12014 CC, not 12497 3A
    expect(shown(b)).not.toMatch(/12497 mein 3A available/);
    const d = await h.say('12497 3A fare', 'VOICE');                              // GET_FARE ran → the fact may be spoken
    expect(d.voice.speechText).toMatch(/650/);
  });

  it('[P] fare authority (TEXT = VOICE): no GET_FARE / malformed GET_FARE → the LLM amount is removed; correct GET_FARE → the real fare survives; UI text = TTS; no second wording call', async () => {
    for (const mode of ['TEXT', 'VOICE'] as const) {
      for (const [label, user, fault] of [['NO_GET_FARE', '12497 3A ka fare kitna hai', null], ['MALFORMED', '12497 3A fare', 'malformed'], ['CORRECT', '12497 3A fare', null]] as const) {
        const h = native(); const vo = voiceOf(h);
        await h.say(START);
        rail.mode = fault ? { fare: fault } : {};
        const w0 = h.fake.wordingRequests.length;
        if (mode === 'VOICE') await vo.utter(user); else await h.say(user, 'TEXT');
        const r = h.last();
        await vo.drain();
        const tag = `${mode} ${label}`;
        if (label === 'CORRECT') {
          expect(h.s().fare, tag).toBeTruthy();
          for (const t of [r.voice.assistantText, r.responseMessage]) expect(t, tag).toMatch(/12497[^.]*3A[^.]*₹650/);
        } else {
          expect(h.s().fare, tag).toBeFalsy();
          expect(shown(r), tag).not.toMatch(/650|₹/);                                     // UI text, responseMessage, speech
          expect(r.turnLog.diagnostics.binding.crossEntityRejections, tag).toContain('UNVERIFIED_FARE:650');
          expect(r.turnLog.rejectedClaims, tag).toContain('FARE:650');                     // P16 invented-fact contract
          expect(r.voice.assistantText, tag).toMatch(label === 'MALFORMED' ? /sahi format mein nahi tha/ : /verified result available nahi/);
        }
        if (mode === 'VOICE') {
          expect(vo.spokenResponse(r).join(' '), tag).toBe(r.voice.speechText);           // TTS = the final validated text
          if (label !== 'CORRECT') expect(vo.tts.spoken.map(x => x.text).join(' '), tag).not.toMatch(/₹/);
          else expect(r.voice.speechText, tag).toMatch(/₹650/);
        }
        expect(h.fake.wordingRequests.length - w0, tag).toBe(0);                          // no second (wording) LLM call
        expect(r.turnLog.diagnostics.secondLlmCall, tag).toBe(false);
        rail.mode = {};
      }
    }
  });

  it('[Q/R/S] timeout / provider failure / malformed data are SPOKEN truthfully — never as "no seats" or a fare', async () => {
    const cases: Array<[string, Mode, RegExp]> = [['avail', 'timeout', /time par jawab nahi|verify nahi/i], ['avail', 'fail', /uplabdh nahi|verify nahi/i], ['fare', 'malformed', /sahi format|verify nahi/i]];
    for (const [k, mode, honest] of cases) {
      const h = native(); const vo = voiceOf(h);
      await h.say(START);
      rail.mode = { [k]: mode };
      await vo.utter(k === 'fare' ? '12497 3A fare' : '12497 3A availability');
      const r = h.last();
      expect(shown(r)).not.toMatch(/seat nahi hai|₹\s?\d/);
      expect(r.voice.speechText).toMatch(honest);
      expect(r.turnLog.voiceTurn.failureCategory).toMatch(/TIMEOUT|PROVIDER_FAILURE|MALFORMED_DATA/);
      await vo.drain();
      expect(vo.spokenResponse(r).join(' ')).toBe(r.voice.speechText);
      rail.mode = {};
    }
  });

  it('[T] the spoken acknowledgement comes only after a tool really started; no ack when no tool runs', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START);
    let release!: () => void; rail.gate = new Promise<void>(r => { release = r; });
    const p = vo.utter('12497 3A ki availability batao');
    for (let i = 0; i < 20 && !rail.n.avail; i++) await flush();
    expect(rail.n.avail).toBe(1);
    const tid = h.eng.getTurns(h.sid).slice(-1)[0].turnId;
    const types = h.eng.events.forTurn(h.sid, tid).map((e: any) => e.type);
    expect(types.indexOf('TOOL_PROGRESS')).toBeGreaterThan(types.indexOf('TOOL_STARTED'));
    expect(types.indexOf('TOOL_STARTED')).toBeGreaterThanOrEqual(0);
    expect(vo.tts.playing).toBeTruthy();                                       // the ack is audible while the tool runs
    rail.gate = null; release(); await p; await vo.drain();
    await vo.utter('RAC kya hota hai?');
    const gk = h.eng.getTurns(h.sid).slice(-1)[0].turnId;
    expect(h.eng.events.forTurn(h.sid, gk).map((e: any) => e.type)).not.toContain('TOOL_PROGRESS');
  });
});

describe('P34 G3 — barge-in, TTS / STT boundaries, Conversation Mode (U–AD)', () => {
  it('[U/V/W] barge-in stops TTS at once; the old response is never resumed; the new speech is a new turn', async () => {
    const h = native(); const vo = voiceOf(h);
    vo.agent.setConversationMode(true); vo.agent.listen();
    await vo.utter(START);
    const t1 = h.last().turn.turnId;
    expect(vo.tts.playing).toBeTruthy();
    vo.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'ruko ruko' });
    expect(vo.tts.playing).toBeNull();                                         // stopped on the partial (§5)
    const spoken1 = vo.tts.spoken.filter(x => x.turnId === t1).length;
    vo.advance(300); vo.stt.push({ kind: 'final', text: 'Doosri wali' }, { kind: 'speechEnd' }); vo.advance(400);
    await vo.agent.tick(); await flush(); await vo.drain();
    expect(vo.tts.spoken.filter(x => x.turnId === t1).length).toBe(spoken1);  // nothing of the old turn after the barge-in
    const turns = h.eng.getTurns(h.sid);
    expect(turns).toHaveLength(2);
    expect(h.last().turnLog.voiceTurn).toMatchObject({ bargeIn: true });
    expect(h.s().selectedTrain.number).toBe('12497');
    expect(vo.agent.voiceMetrics()[0]).toMatchObject({ turnId: t1, interrupted: true, stale: true });
    vo.record();
  });

  it('[X] barge-in during the review is NOT a booking cancellation: review / state unchanged; confirmation still works', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START);
    vo.agent.setConversationMode(true); vo.agent.listen();
    await vo.utter(ALL_IN_ONE);
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    vo.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'ek minute' });
    expect(vo.tts.playing).toBeNull();
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(h.s().review).toMatchObject({ reviewVersion: 1, valid: true });
    vo.agent.cancel(); await flush();
    await vo.utter('haan confirm');
    expect(h.s().bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
  });

  it('[Y/AM] TTS speaks exactly the final validated text — same facts as the UI, no separate wording call', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START);
    const w0 = h.fake.wordingRequests.length;
    await vo.utter('12497 3A fare');
    const r = h.last();
    await vo.drain();
    expect(vo.spokenResponse(r)).toEqual(r.voice.segments);
    expect(vo.spokenResponse(r).join(' ')).toBe(r.voice.speechText);
    for (const n of nums(r.voice.speechText)) expect(nums(r.voice.assistantText)).toContain(n);
    expect(h.fake.wordingRequests.length).toBe(w0);
  });

  it('[Z] TTS failure: no state change, no repeated tool / LLM call; text stays; retry re-speaks the same validated text', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START);
    vo.tts.failNext = 1;
    await vo.utter('12497 3A fare');
    const r = h.last();
    const n0 = { ...rail.n }, q0 = h.fake.requests.length, v0 = h.s().sessionVersion;
    expect(vo.agent.snapshot().textFallback).toBe(true);
    expect(r.voice.assistantText).toMatch(/650/);
    expect(vo.agent.retrySpeech()).toBe(true);
    await vo.drain();
    expect(vo.spokenResponse(r).join(' ')).toBe(r.voice.speechText);
    expect(delta(n0)).toEqual({ search: 0, avail: 0, fare: 0 });
    expect(h.fake.requests.length).toBe(q0);
    expect(h.s().sessionVersion).toBe(v0);
    expect(h.eng.getTurns(h.sid)).toHaveLength(2);
    expect(vo.agent.voiceMetrics().slice(-1)[0]).toMatchObject({ tts: 'SPOKEN', speechRetries: 1 });
  });

  it('[AA] STT failure: no invented transcript, no tool, no LLM call; typed input keeps working', async () => {
    const h = native(); const vo = voiceOf(h);
    vo.agent.listen();
    vo.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'kal amritsar' }, { kind: 'error', code: 'network' });
    vo.advance(5000); vo.agent.tick(); await flush();
    expect(h.fake.requests).toHaveLength(0);
    expect(rail.n).toEqual({});
    expect(vo.events.some(e => e.type === 'TEXT_FALLBACK')).toBe(true);
    expect(vo.agent.snapshot()).toMatchObject({ lastError: 'network', listening: false, partialTranscript: '' });
    await h.say(START, 'TEXT');
    expect(rail.n.search).toBe(1);
  });

  it('[AB/AC/AD] Conversation Mode is opt-in: mic off until the user acts, no background listening after a turn, one tap stops it', async () => {
    const h = native(); const vo = voiceOf(h);
    expect(vo.agent.snapshot()).toMatchObject({ conversationMode: false, listening: false });
    expect(vo.stt.startCount).toBe(0);
    vo.stt.push({ kind: 'speechStart' }, { kind: 'final', text: START }, { kind: 'speechEnd' });
    vo.advance(3000); expect(vo.agent.tick()).toBeNull();
    expect(h.fake.requests).toHaveLength(0);
    await vo.utter(START);                                                     // tap-to-talk: one utterance
    expect(vo.agent.snapshot().listening).toBe(false);                         // mic closed after the turn
    const starts = vo.stt.startCount;
    await vo.drain();
    expect(vo.stt.startCount).toBe(starts);                                    // never re-opened by itself
    vo.agent.setConversationMode(true); vo.agent.listen();
    expect(vo.stt.continuous).toBe(true);
    vo.agent.setConversationMode(false);
    expect(vo.agent.snapshot()).toMatchObject({ conversationMode: false, listening: false });
  });
});

describe('P34 G3 — P33 booking preparation by voice + boundary (AE–AI)', () => {
  it('[AE/AF] spoken passenger details are kept (never re-asked); the voice review speaks the P33 review facts', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START);
    await vo.utter(ALL_IN_ONE);
    const r = h.last();
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect((h.s().passengers || []).map((p: any) => p.name)).toEqual(['Rahul', 'Neha']);
    for (const re of [/12497/, /3A/, /1300/]) expect(r.voice.speechText).toMatch(re);
    expect(r.voice.speechText).not.toMatch(REASK);
    expect(shown(r)).not.toMatch(/password|otp\b|captcha|cvv|upi pin/i);
  });

  it('[AG/AH] voice "theek hai" does not confirm; voice "haan confirm" → handoff ready, booking still disabled, never "book ho gayi"', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START);
    await vo.utter(ALL_IN_ONE); await vo.drain();
    await vo.utter('theek hai'); await vo.drain();
    expect(h.s().bookingState).toBe(BookingState.AWAITING_CONFIRMATION);
    expect(h.s().handoffSession).toBeUndefined();
    await vo.utter('haan confirm');
    const r = h.last();
    expect(h.s().bookingState).toBe(BookingState.IRCTC_HANDOFF_READY);
    expect(r.voice.speechText).toMatch(/enabled nahi/i);
    expect(shown(r)).not.toMatch(NO_SUCCESS);
    const t = await h.say('Ticket book ho gayi?', 'VOICE');
    expect(shown(t)).not.toMatch(NO_SUCCESS);
    expect(handoffSpy).not.toHaveBeenCalled();
  });

  it('[AI] booking / payment tools proposed during a voice turn are rejected; nothing executes; no success is spoken', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START); await h.say(ALL_IN_ONE);
    await vo.utter('seedha book kar do');
    const r = h.last();
    expect(r.turnLog.toolExecutions.map((e: any) => e.status)).not.toContain('SUCCEEDED');
    expect(h.s().handoffSession).toBeUndefined();
    expect(shown(r)).not.toMatch(NO_SUCCESS);
    expect(shown(r)).not.toMatch(/Booked!/);
    expect(handoffSpy).not.toHaveBeenCalled();
  });
});

describe('P34 G3 — efficiency, stale protection, security (AJ–AN)', () => {
  it('[AK/AL] same-turn duplicate tool call → one provider call; more than MAX_TOOL_STEPS_PER_TURN (8) calls are never executed', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START); await h.say('12497 3A');
    const n0 = { ...rail.n };
    await vo.utter('Fare dobara dekho'); await vo.drain();
    expect(delta(n0).fare).toBe(1);
    const n1 = { ...rail.n };
    await vo.utter('Sab classes ki availability');
    expect(delta(n1).avail).toBeLessThanOrEqual(8);
    expect(h.last().turnLog.voiceTurn.providerCalls).toBeLessThanOrEqual(8);
  });

  it('[AN] a stale (superseded) voice response can never overwrite newer state or be spoken', async () => {
    const h = native(); const vo = voiceOf(h);
    await h.say(START);
    vo.agent.setConversationMode(true); vo.agent.listen();
    let release!: () => void; h.llmGate.user = '12014 CC'; h.llmGate.p = new Promise<void>(r => { release = r; });
    const p1 = vo.utter('12014 CC');
    await flush();
    expect(vo.agent.snapshot().state).toBe('PROCESSING');
    vo.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: '12497' }); vo.advance(300);
    vo.stt.push({ kind: 'final', text: '12497 3A' }, { kind: 'speechEnd' }); vo.advance(400);
    const p2 = vo.agent.tick();
    await flush(); h.llmGate.p = null; release();
    const [o1] = await Promise.all([p1, p2]); await flush(); await vo.drain();
    expect(o1).toBeNull();
    expect(h.s().selectedTrain.number).toBe('12497');
    expect(h.s().selectedClass).toBe('3A');
    const turns = h.eng.getTurns(h.sid).slice(-2);
    expect(turns[0]).toMatchObject({ status: 'SUPERSEDED', presentation: 'DISCARDED' });
    expect(vo.tts.spoken.map(x => x.text).join(' ')).not.toMatch(/12014/);
    const old = h.results.find(r => r.turn.turnId === turns[0].turnId);
    expect(old?.turnLog?.voiceTurn).toMatchObject({ stale: true, failureCategory: 'SUPERSEDED' });
    vo.record();
  });

  it('[AJ] secrets: the API key never appears in any result, session, voice log, metric, voice event or spoken text; no network', () => {
    const all = outputs.join('\n');
    expect(all.length).toBeGreaterThan(1000);
    expect(all).not.toContain(KEY);
    expect(all).not.toMatch(/Bearer\s+sk-/);
    expect(all).not.toContain('"sourceResultId"');
    for (const c of fetchSpy.mock.calls) expect(String(c[0])).toMatch(/^https:\/\/llm\.fake\.test|^http:\/\/127\.0\.0\.1:/);
  });
});
