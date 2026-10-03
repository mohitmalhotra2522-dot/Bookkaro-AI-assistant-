/**
 * PROMPT 22 — GROUP 3: final architecture audit, natural-voice end to end (Part 16 A–T).
 *   STT (mock streaming) → VoiceTurnDetector → ConversationalVoiceAgent → ConversationTurnEngine.processTurn
 *   → LLM (MockLLM / ScriptedLLM / real OpenAI-compatible adapter with an injected fake fetch) → RailwayToolRuntime
 *   → labelled mock (non-live) spy provider → BookingSession → LLM wording → NaturalResponseComposer grounding → TTS.
 * Proves: the LLM owns interpretation (swapping the LLM changes behaviour; the backend never re-parses), direct info
 * tool requests, tool-result authority, hallucination removal, barge-in without stale resume, fresh date-change data,
 * shared text/voice state, and booking execution outside LLM control. Offline: no network, no credits, never COMPLETE.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { FORBIDDEN_SUCCESS_CLAIMS } from '../../server/ai/turn-engine/mock-conversation-scenarios';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { IrctcHandoffAdapter } from '../../server/irctc/handoff/irctc-handoff-adapter';
import { DisabledBookingProvider } from '../../server/booking/provider/disabled-booking-provider';
import { MockBookingProvider } from '../../server/booking/testing/mock-booking-provider';
import { DisabledBookingExecutor } from '../../server/booking/execution/disabled-booking-executor';
import { OpenAICompatibleLLMProvider } from '../../server/ai/providers/openai-compatible-llm';
import { LLM_UNAVAILABLE_MESSAGE } from '../../server/ai/providers/llm-provider';
import { createEngineVoiceAgent } from '../../server/voice/server-voice-agent';
import { MockStreamingSTT } from '../../server/voice/stt/stt-provider';
import { MockStreamingTTS } from '../../server/voice/tts/tts-provider';
import { v4 as uuid } from '../../server/ai/orchestrator/utils';

const meta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p22-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; omitOn: string | null = null; dropCls: { date: string; cls: string } | null = null; failAvail = 0;
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> {
    this.b('search');
    const out: any = await super.searchTrains(r);
    if (out.ok && this.omitOn === r.date) out.data = { ...out.data, trains: out.data.trains.filter((t: any) => t.trainNumber !== '12014') };
    if (out.ok && this.dropCls && this.dropCls.date === r.date) out.data = { ...out.data, trains: out.data.trains.map((t: any) => t.trainNumber === '12014' ? { ...t, classes: t.classes.filter((c: any) => c.code !== this.dropCls!.cls) } : t) };
    return out;
  }
  async getTrainInfo(r: any): Promise<any> { this.b('info'); return super.getTrainInfo(r); }
  async getTimetable(r: any): Promise<any> { this.b('timetable'); return super.getTimetable(r); }
  async checkAvailability(r: any): Promise<any> {
    this.b('avail');
    if (this.failAvail > 0) { this.failAvail--; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock availability down.' }, meta: meta() }; }
    return super.checkAvailability(r);
  }
  async getFare(r: any): Promise<any> { this.b('fare'); return super.getFare(r); }
  async trackTrain(r: any): Promise<any> { this.b('track'); return super.trackTrain(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p22-spy', () => rail);

/** A DIFFERENT LLM implementation: per-utterance scripted decisions / wording; MockLLM for set-up turns. */
class ScriptedLLM extends MockLLMProvider {
  script = new Map<string, any>(); spoken: string | null = null; decisions = 0;
  async generateStructuredDecision(input: any): Promise<any> {
    this.decisions++;
    const f = this.script.get(input.userText);
    if (f) {
      const d = typeof f === 'function' ? f(input) : f;
      if (d) return { decision: { missingFields: [], confidence: 0.9, clarification: null, ...d, toolCalls: (d.toolCalls || []).map((c: any) => ({ callId: uuid(), ...c })) } };
    }
    return super.generateStructuredDecision(input);
  }
  async generateSpokenResponse(input: any): Promise<any> { return this.spoken ? { text: this.spoken } : super.generateSpokenResponse(input); }
  /** LLM requests `calls` on its first pass, then finishes (no message — facts come from tool results). */
  tool(text: string, calls: any[]) { this.script.set(text, (i: any) => (i.currentTurnToolResults || []).length ? { intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', entities: {} } : { intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', entities: {}, toolCalls: calls }); }
}

function mk(o: { llm?: any } = {}) {
  const state = new ConversationStateManager();
  const llm = o.llm || new MockLLMProvider();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no real backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { state, eng, sid, llm, say: (t: string, mode: 'TEXT' | 'VOICE' = 'VOICE', x: any = {}) => eng.processTurn(sid, t, mode, x) as Promise<any>, s: () => state.getSession(sid) as any };
}
type H = ReturnType<typeof mk>;
const run = async (h: H, turns: string[], mode: 'TEXT' | 'VOICE' = 'VOICE') => { let r: any; for (const t of turns) r = await h.say(t, mode); return r; };
const BOOK_CLAIM = new RegExp(FORBIDDEN_SUCCESS_CLAIMS.join('|'), 'i');
const UPTO_CLASS = ['Amritsar se Delhi kal', '12014 wali kar do', 'CC'];
const REVIEW_2 = [...UPTO_CLASS, '2 passengers. Mohit 31 male, Ravi 28 male.'];
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const nextDay = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const lastExec = (r: any, k: number) => r.turnLog.toolExecutions.slice(-k).map((e: any) => [e.tool, e.status, e.rejectionReason]);

function mkVoice(h: H) {
  let now = 1000;
  const stt = new MockStreamingSTT(); const tts = new MockStreamingTTS();
  const agent = createEngineVoiceAgent({ engine: h.eng, sessionId: h.sid, output: tts, input: stt, now: () => now });
  const utter = (t: string) => { stt.push({ kind: 'speechStart' }, { kind: 'partial', text: t }); now += 300; stt.push({ kind: 'final', text: t }, { kind: 'speechEnd' }); now += 400; return agent.tick(); };
  const drain = async () => { await flush(); while (tts.playing) { tts.finish(); await flush(); } };
  return { agent, stt, tts, utter, drain, advance: (ms: number) => { now += ms; } };
}

let fetchSpy: any, handoffSpy: any, execSpies: any[] = [];
const envBefore = process.env.REAL_IRCTC_ENABLED;
beforeEach(() => {
  railwayRegistry.setActive('p22-spy');
  Object.assign(rail, { n: {}, omitOn: null, dropCls: null, failAvail: 0 });
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff execution forbidden'); });
  execSpies = [vi.spyOn(DisabledBookingProvider.prototype, 'executeBooking'), vi.spyOn(MockBookingProvider.prototype, 'executeBooking')];
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  for (const s of execSpies) expect(s).not.toHaveBeenCalled();       // no booking provider is ever executed
  expect(process.env.REAL_IRCTC_ENABLED).toBe(envBefore);
  fetchSpy.mockRestore(); handoffSpy.mockRestore(); for (const s of execSpies) s.mockRestore();
  railwayRegistry.setActive('mock');
});

describe('P22 G3 — the LLM is the conversational intelligence', () => {
  it('[A] natural interpretation belongs to the LLM: two LLMs read "woh beech wali" differently and the backend follows each; UNKNOWN is never re-parsed', async () => {
    const L1 = new ScriptedLLM(); const h1 = mk({ llm: L1 });
    await h1.say('Amritsar se Delhi kal');
    L1.script.set('woh beech wali', { intent: 'SELECT_TRAIN', action: 'SELECT_TRAIN', entities: { trainRef: { kind: 'DISPLAY_INDEX', value: 2 } } });
    const r1 = await h1.say('woh beech wali');
    expect(h1.s().selectedTrain.number).toBe('12497');
    expect(r1.newState).toBe('CLASS_OPTIONS');
    const L2 = new ScriptedLLM(); const h2 = mk({ llm: L2 });
    await h2.say('Amritsar se Delhi kal');
    L2.script.set('woh beech wali', { intent: 'SELECT_TRAIN', action: 'SELECT_TRAIN', entities: { trainRef: { kind: 'DISPLAY_INDEX', value: 3 } } });
    await h2.say('woh beech wali');
    expect(h2.s().selectedTrain.number).toBe('18238');                 // same words, different LLM reading → backend follows the LLM
    const L3 = new ScriptedLLM(); const h3 = mk({ llm: L3 });
    await h3.say('Amritsar se Delhi kal');
    L3.script.set('12497 wali', { intent: 'UNKNOWN', action: 'NO_ACTION', entities: {}, clarification: 'Kaunsi train chahiye?' });
    const r3 = await h3.say('12497 wali');
    expect(h3.s().selectedTrain).toBeFalsy();                          // no hidden deterministic parser takes over
    expect(r3.newState).toBe('SHOWING_TRAINS');
    expect(r3.voice.assistantText).toMatch(/\?$/);
    // the backend still validates the LLM's proposal (out-of-range index → nothing selected)
    L3.script.set('nauvi wali', { intent: 'SELECT_TRAIN', action: 'SELECT_TRAIN', entities: { trainRef: { kind: 'DISPLAY_INDEX', value: 9 } } });
    await h3.say('nauvi wali');
    expect(h3.s().selectedTrain).toBeFalsy();
  });

  it('[B] conversational references resolve through the LLM decision + backend validation (doosri / last / ye wali / AC wali / subah wali)', async () => {
    const cases: Array<[string[], string | undefined, string | undefined, RegExp]> = [
      [['Amritsar se Delhi kal', 'doosri train'], '12497', undefined, /12497/],
      [['Amritsar se Delhi kal', 'last wali'], '18238', undefined, /18238.*3A ya SL/],
      [['Amritsar se Delhi kal', '12014 wali', 'ye wali'], '12014', undefined, /12014 hi selected hai/],
      [['Amritsar se Delhi kal', '12014 wali', 'AC wali'], '12014', 'CC', /CC theek hai/],
      [['Amritsar se Delhi kal', '12497 wali', 'AC wali'], '12497', undefined, /3A aur CC.*\?/],          // ambiguous → one question
      [['Amritsar se Delhi kal', 'subah wali'], undefined, undefined, /12014 \(04:55\) ya 12497 \(06:35\)/]
    ];
    for (const [turns, train, cls, speech] of cases) {
      const h = mk(); const r = await run(h, turns);
      expect(h.s().selectedTrain?.number, turns.join(' > ')).toBe(train);
      expect(h.s().selectedClass, turns.join(' > ')).toBe(cls);
      expect(r.voice.speechText, turns.join(' > ')).toMatch(speech);
      expect((r.voice.speechText.match(/\?/g) || []).length).toBeLessThanOrEqual(1);
    }
  });

  it('[C] direct info tool invocation: every approved tool the LLM requests runs through RailwayToolRuntime; dependent quotes only for the selected train', async () => {
    const L = new ScriptedLLM(); const h = mk({ llm: L });
    await h.say('Amritsar se Delhi kal', 'TEXT');
    const table: Array<[string, any[], string, string | null, string, string[]]> = [
      ['12014 ki info', [{ name: 'GET_TRAIN_INFO', arguments: { trainNumber: '12014' } }], 'SUCCEEDED', null, 'info', ['train_info']],
      ['12014 ka timetable', [{ name: 'GET_TIMETABLE', arguments: { trainNumber: '12014' } }], 'SUCCEEDED', null, 'timetable', ['timetable']],
      ['Ludhiana se Delhi parso dikhao', [{ name: 'SEARCH_TRAINS', arguments: { origin: 'Ludhiana', destination: 'Delhi', date: 'parso' } }], 'SUCCEEDED', null, 'search', ['trains']],
      ['12014 kahan hai', [{ name: 'TRACK_TRAIN', arguments: { trainNumber: '12014' } }], 'FAILED', 'LIVE_STATUS_UNAVAILABLE', 'track', []],
      ['cancelled trains', [{ name: 'GET_CANCELLED_TRAINS', arguments: {} }], 'REJECTED', 'TOOL_NOT_IMPLEMENTED', '-', []]
    ];
    for (const [text, calls, status, reason, counter, cards] of table) {
      L.tool(text, calls);
      const before = rail.n[counter] || 0;
      const r = await h.say(text, 'TEXT');
      expect(lastExec(r, 1), text).toEqual([[calls[0].name, status, reason]]);
      if (counter !== '-') expect(rail.n[counter], text).toBe(before + 1);
      expect(r.cards.map((c: any) => c.type), text).toEqual(cards);
      if (status !== 'SUCCEEDED') expect(r.voice.assistantText, text).not.toMatch(/time pe|late|cancel(led)? hai|platform \d/i);
    }
    // dependent quotes: allowed for the backend-selected train/class only
    const Q = new ScriptedLLM(); const q = mk({ llm: Q });
    await run(q, ['Amritsar se Delhi kal', '12497 wali', '3A'], 'TEXT');
    const args = (train: string, cls: string) => ({ trainNumber: train, travelClass: cls, origin: 'ASR', destination: 'NDLS', date: q.s().date });
    Q.tool('3A mein seat hai?', [{ name: 'CHECK_AVAILABILITY', arguments: args('12497', '3A') }]);
    Q.tool('3A ka fare?', [{ name: 'GET_FARE', arguments: args('12497', '3A') }]);
    Q.tool('12014 CC ka fare?', [{ name: 'GET_FARE', arguments: args('12014', 'CC') }]);
    const a = await q.say('3A mein seat hai?', 'TEXT');
    expect(lastExec(a, 1)).toEqual([['CHECK_AVAILABILITY', 'SUCCEEDED', null]]);
    expect(a.voice.assistantText).toMatch(/^3A mein seats available hain\./);
    const f = await q.say('3A ka fare?', 'TEXT');
    expect(lastExec(f, 1)).toEqual([['GET_FARE', 'SUCCEEDED', null]]);
    expect(f.voice.assistantText).toMatch(/₹650/);
    const fareCalls = rail.n.fare;
    const x = await q.say('12014 CC ka fare?', 'TEXT');
    expect(lastExec(x, 1)).toEqual([['GET_FARE', 'REJECTED', 'INVALID_TRAIN_REFERENCE']]);   // LLM train claims are never trusted
    expect(rail.n.fare).toBe(fareCalls);
    expect(x.voice.assistantText).not.toMatch(/₹/);
  });

  it('[D+E] fact validation + hallucination removal in the live pipeline (text AND voice): invented facts are dropped, the safe fallback is used', async () => {
    for (const mode of ['VOICE', 'TEXT'] as const) {
      const L = new ScriptedLLM(); const h = mk({ llm: L });
      await run(h, ['Amritsar se Delhi kal', '12014 wali', 'CC'], mode);
      L.spoken = '12014 Rajdhani hai. Ye Mumbai se aati hai. Parso subah 9:15 baje chalti hai. Fare ₹999 hai. Do trainein hain. CC mein Waitlist 3 hai. Kitne passengers hain?';
      const r = await h.say('theek hai', mode);
      expect(r.turnLog.naturalSpeech.rejected, mode).toEqual(['UNGROUNDED_TRAIN_NAME:Rajdhani', 'UNGROUNDED_STATION:Mumbai', 'UNGROUNDED_NUMBER:9', 'UNGROUNDED_NUMBER:999', 'UNGROUNDED_COUNT:Do trainein', 'AVAILABILITY_MISMATCH:WL 3']);
      expect(r.voice.assistantText, mode).not.toMatch(/Rajdhani|Mumbai|9:15|999|Waitlist 3|Do trainein/);
      expect(r.voice.assistantText, mode).toMatch(/Kitne passengers hain\?/);
    }
    // grounded LLM wording is kept and shown in BOTH modes (normal conversation is LLM-generated)
    const g = mk();
    const t = await g.say('Amritsar se Delhi kal', 'TEXT');
    expect(t.speech.source).toBe('LLM');
    expect(t.voice.assistantText).toMatch(/3 trainein.*12014/);
    expect(t.responseMessage).not.toBe(t.voice.assistantText);       // backend reply stays the authoritative card text
  });

  it('[F] LLM failure: fixed safe reply, no state change, no railway call; verified facts already fetched are kept; the real adapter is drop-in', async () => {
    class Down extends MockLLMProvider { async generateStructuredDecision(): Promise<any> { throw new Error('LLM down'); } }
    const d = mk({ llm: new Down() });
    const r = await d.say('Amritsar se Delhi kal');
    expect(r.error?.code).toBe('LLM_UNAVAILABLE');
    expect(r.voice.speechText).toContain(LLM_UNAVAILABLE_MESSAGE);
    expect(r.newState).toBe('IDLE');
    expect(rail.n.search || 0).toBe(0);
    class MidFail extends MockLLMProvider { async generateStructuredDecision(i: any): Promise<any> { if ((i.currentTurnToolResults || []).length) throw new Error('down'); return super.generateStructuredDecision(i); } }
    const m = mk({ llm: new MidFail() });
    const mr = await m.say('Amritsar se Delhi kal', 'TEXT');
    expect(mr).toMatchObject({ newState: 'SHOWING_TRAINS', error: { code: 'LLM_UNAVAILABLE' } });
    expect(mr.cards.map((c: any) => c.type)).toEqual(['trains']);
    expect(mr.voice.assistantText).toMatch(/3 trains mili hain/);
    // real OpenAI-compatible adapter (injected fake fetch) drives the SAME pipeline — no rewrite
    const calls: string[] = []; let fail = false;
    const fetchImpl = async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const kind = body.messages[0].content.startsWith('You are BookKaro AI speaking') ? 'speech' : 'decision';
      calls.push(kind);
      if (fail) return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
      if (kind === 'speech') return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: 'Kal ke liye 3 trainein mili hain. Sabse pehli 12014 hai, subah 4:55 wali. Kaunsi train chahiye?' } }] }) };
      const u = JSON.parse(body.messages[1].content);
      const dec = u.currentTurnToolResults.length ? { intent: 'SEARCH_TRAINS', action: 'NO_ACTION', entities: {} }
        : { intent: 'SEARCH_TRAINS', action: 'SEARCH_TRAINS', entities: { originRaw: 'Amritsar', destinationRaw: 'Delhi', dateRaw: 'kal' }, acknowledgement: 'Ek second, dekhta hoon.', toolCalls: [{ name: 'SEARCH_TRAINS', arguments: { origin: 'Amritsar', destination: 'Delhi', date: 'kal' } }] };
      return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: JSON.stringify(dec) } }] }) };
    };
    const remote = new OpenAICompatibleLLMProvider({ toolMode: 'json', apiKey: 'sk-test-remote', baseUrl: 'https://llm.test/v1', model: 'm1', timeoutMs: 1000, fetch: fetchImpl as any });
    const rh = mk({ llm: remote });
    const ok = await rh.say('Amritsar se Delhi kal jaana hai');
    expect(calls).toEqual(['decision', 'decision', 'speech']);
    expect(ok.newState).toBe('SHOWING_TRAINS');
    expect(ok.speech.source).toBe('LLM');
    expect(ok.voice.speechText).toBe('Kal ke liye 3 trainein mili hain. Sabse pehli 12014 hai, subah 4:55 wali. Kaunsi train chahiye?');
    expect(ok.turnLog.llmProvider).toBe('openai-compatible');
    fail = true;
    const bad = await rh.say('12014 wali');
    expect(bad.error?.code).toBe('LLM_UNAVAILABLE');
    expect(rh.s()).toMatchObject({ bookingState: 'SHOWING_TRAINS', origin: 'ASR', destination: 'NDLS' });
    expect(rh.s().selectedTrain).toBeFalsy();                          // no rule-based takeover after a remote failure
  });

  it('[newJourney] a new-journey reset needs the user\'s own words: grounded → reset with LLM wording; ungrounded proposal ignored', async () => {
    const L = new ScriptedLLM(); const h = mk({ llm: L });
    await run(h, ['Amritsar se Delhi kal', '12014 wali'], 'TEXT');
    L.script.set('12497 wali', { intent: 'SELECT_TRAIN', action: 'SELECT_TRAIN', entities: { newJourney: true, trainRef: { kind: 'TRAIN_NUMBER', value: '12497' } } });
    const u = await h.say('12497 wali', 'TEXT');
    expect(u.turnLog.backendActions).toEqual(['TRAIN_SELECTED']);
    expect(h.s()).toMatchObject({ origin: 'ASR', destination: 'NDLS', selectedTrain: { number: '12497' } });
    L.script.set('nayi booking karni hai', { intent: 'NEW_BOOKING', action: 'NO_ACTION', entities: { newJourney: true } });
    const g = await h.say('nayi booking karni hai', 'TEXT');
    expect(g.turnLog.backendActions).toEqual(['NEW_JOURNEY_STARTED']);
    expect(g.newState).toBe('IDLE');
    expect(h.s().origin).toBeUndefined();
    expect(g.voice.assistantText).toMatch(/kahan se kahan/i);
    const m = mk();
    await run(m, ['Amritsar se Delhi kal', '12014 wali']);
    const before = rail.n.search;
    const e = await m.say('ek aur ticket Ludhiana se Delhi parso');
    expect(rail.n.search).toBe(before + 1);
    expect(m.s()).toMatchObject({ origin: 'LDH', destination: 'NDLS', bookingState: 'SHOWING_TRAINS' });
    expect(m.s().selectedTrain).toBeFalsy();
    expect(e.voice.speechText).toMatch(/Parso ke liye 2 trainein/);
  });

  it('[scope] off-topic is decided AFTER the LLM: an LLM-invented weather answer never reaches the user; a travel sentence with off-topic words still searches', async () => {
    class Rogue extends MockLLMProvider {
      calls = 0;
      async generateStructuredDecision(i: any): Promise<any> {
        this.calls++;
        if (/mausam/.test(i.userText)) return { decision: { intent: 'GENERAL_RAILWAY_QUERY', action: 'NO_ACTION', entities: {}, missingFields: [], confidence: 0.9, clarification: null, toolCalls: [], finalMessage: 'Aaj Delhi mein 32 degree hai, dhoop rahegi.' } };
        return super.generateStructuredDecision(i);
      }
    }
    const R = new Rogue(); const h = mk({ llm: R });
    for (const mode of ['TEXT', 'VOICE'] as const) {
      const r = await h.say('aaj mausam kaisa hai', mode);
      expect(r.voice.assistantText).toBe('Main railway booking aur train information mein help kar sakta hoon.');
      expect(r.voice.assistantText).not.toMatch(/degree|dhoop/);
    }
    expect(R.calls).toBeGreaterThanOrEqual(2);                        // the LLM saw the turn first
    const T = new ScriptedLLM(); const t = mk({ llm: T });
    T.script.set('movie dekhne Amritsar se Delhi kal jaana hai', (i: any) => (i.currentTurnToolResults || []).length ? null
      : { intent: 'SEARCH_TRAINS', action: 'SEARCH_TRAINS', entities: { originRaw: 'Amritsar', destinationRaw: 'Delhi', dateRaw: 'kal' }, toolCalls: [{ name: 'SEARCH_TRAINS', arguments: { origin: 'Amritsar', destination: 'Delhi', date: 'kal' } }] });
    const tr = await t.say('movie dekhne Amritsar se Delhi kal jaana hai', 'TEXT');
    expect(tr.newState).toBe('SHOWING_TRAINS');
    expect(tr.voice.assistantText).toMatch(/3 trainein/);
  });
});

describe('P22 G3 — voice architecture, barge-in and stale protection', () => {
  it('[V] voice = STT → same engine → LLM → tools → LLM wording → TTS renders exactly the outcome (no voice-only parser or memory)', async () => {
    const L = new ScriptedLLM(); const h = mk({ llm: L }); const v = mkVoice(h);
    const spy = vi.spyOn(h.eng, 'processTurn');
    v.agent.listen();
    const o = await v.utter('Amritsar se Delhi kal');
    await v.drain();
    expect(spy).toHaveBeenCalledWith(h.sid, 'Amritsar se Delhi kal', 'VOICE', expect.anything());
    expect(L.decisions).toBeGreaterThanOrEqual(2);                    // decision + post-tool pass by the LLM
    const turn = h.eng.getTurns(h.sid).slice(-1)[0];
    expect(o!.speechText).toBe(turn.assistantResponse!.speechText);
    const spoken = v.tts.spoken.map(x => x.text);
    expect(spoken[0]).toBe('Ek second, trains check kar raha hoon.');  // LLM acknowledgement, no facts
    expect(spoken.slice(1).join(' ')).toBe(o!.speechText);            // TTS is only the renderer
    expect(h.s().bookingState).toBe('SHOWING_TRAINS');                // shared BookingSession
    spy.mockRestore();
  });

  it('[G] TTS failure keeps the text reply and switches to text fallback; state is unaffected', async () => {
    const h = mk(); const v = mkVoice(h);
    v.tts.failNext = 5;
    v.agent.listen();
    const o = await v.utter('Amritsar se Delhi kal');
    await v.drain();
    expect(o!.assistantText).toBe(h.eng.getTurns(h.sid).slice(-1)[0].assistantResponse!.speechText);
    expect(o!.assistantText).toMatch(/12014/);
    expect(v.agent.snapshot().textFallback).toBe(true);
    expect(h.s().bookingState).toBe('SHOWING_TRAINS');
  });

  it('[H] mic policy: tap-to-talk default never barges in; Conversation Mode is explicit and one tap turns it fully off', async () => {
    const h = mk(); const v = mkVoice(h);
    v.agent.listen();
    await v.utter('Amritsar se Delhi kal');
    await flush();
    expect(v.agent.snapshot()).toMatchObject({ state: 'SPEAKING', conversationMode: false, listening: false });
    const playing = v.tts.playing;
    v.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: '12497 wali' });   // background speech while the agent talks
    expect(v.tts.playing).toBe(playing);
    expect(v.tts.spoken.filter(x => x.status === 'CANCELLED')).toHaveLength(0);
    expect(await v.agent.tick()).toBeNull();
    expect(h.eng.getTurns(h.sid)).toHaveLength(1);
    await v.drain();
    v.agent.setConversationMode(true); v.agent.listen();
    expect(v.agent.snapshot()).toMatchObject({ conversationMode: true, listening: true });
    v.agent.cancel();                                                  // the one visible "off" tap
    expect(v.agent.snapshot()).toMatchObject({ conversationMode: false, listening: false, state: 'IDLE' });
  });

  it('[I] barge-in while "12014" reply is playing → audio stops, never resumes, "12497 wali" is prioritised', async () => {
    const h = mk(); const v = mkVoice(h);
    await h.say('Amritsar se Delhi kal', 'TEXT');
    v.agent.setConversationMode(true); v.agent.listen();
    await v.utter('12014 wali'); await flush();
    expect(v.tts.playing).toMatch(/12014/);
    v.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: '12497 wali' });
    expect(v.tts.playing).toBeNull();
    expect(v.agent.snapshot().state).toBe('USER_SPEAKING');
    v.advance(300); v.stt.push({ kind: 'final', text: '12497 wali' }, { kind: 'speechEnd' }); v.advance(400);
    const o = await v.agent.tick(); await v.drain();
    expect(o).toMatchObject({ responsePriority: 'INTERRUPT', presentable: true });
    expect(o!.speechText).toMatch(/12497/);
    expect(h.s().selectedTrain.number).toBe('12497');
    const turns = h.eng.getTurns(h.sid).slice(-2);
    expect(turns[0]).toMatchObject({ presentation: 'INTERRUPTED', interrupted: true });
    const spoken = v.tts.spoken.map(x => [x.text, x.status]);
    expect(spoken.filter(([t]) => /12014/.test(String(t)))).toEqual([[expect.stringMatching(/12014/), 'CANCELLED']]);   // never resumed
    expect(spoken.slice(-1)[0][1]).toBe('DONE');
  });

  it('[J] stale suppression: "12014 wali" still in flight at the LLM, user says "12497 wali" → old turn SUPERSEDED + DISCARDED, never spoken', async () => {
    class GateLLM extends MockLLMProvider {
      gates = new Map<string, Promise<void>>();
      async generateStructuredDecision(i: any): Promise<any> { const g = this.gates.get(i.userText); if (g && !(i.currentTurnToolResults || []).length) await g; return super.generateStructuredDecision(i); }
    }
    const G = new GateLLM(); const h = mk({ llm: G }); const v = mkVoice(h);
    await h.say('Amritsar se Delhi kal', 'TEXT');
    v.agent.setConversationMode(true); v.agent.listen();
    let release!: () => void; G.gates.set('12014 wali', new Promise<void>(r => { release = r; }));
    const p1 = v.utter('12014 wali'); await flush();
    expect(v.agent.snapshot().state).toBe('PROCESSING');
    v.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: '12497 wali' }); v.advance(300);
    v.stt.push({ kind: 'final', text: '12497 wali' }, { kind: 'speechEnd' }); v.advance(400);
    const p2 = v.agent.tick();
    await flush(); release();
    const [o1, o2] = await Promise.all([p1, p2]); await v.drain();
    expect(o1).toBeNull();
    expect(o2!.responsePriority).toBe('INTERRUPT');
    expect(h.s().selectedTrain.number).toBe('12497');
    const turns = h.eng.getTurns(h.sid).slice(-2);
    expect(turns[0]).toMatchObject({ status: 'SUPERSEDED', presentation: 'DISCARDED', interrupted: true });
    expect(h.eng.events.forTurn(h.sid, turns[0].turnId).filter((e: any) => e.type === 'SPEECH_SEGMENT')).toHaveLength(0);
    expect(v.tts.spoken.map(x => x.text).join(' ')).not.toMatch(/12014/);
  });
});

describe('P22 G3 — fresh data, booking boundary, parity', () => {
  it('[K+L] "kal nahi parso": fresh search + fresh availability/fare + rebuilt review with re-validated carry-over; train missing → told and asked', async () => {
    const h = mk(); await run(h, REVIEW_2);
    const date0 = h.s().date; const rv0 = h.s().review.reviewVersion; const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso');
    expect(h.s().date).toBe(nextDay(date0));
    expect(rail.n.search).toBe(n0.search + 1);
    expect(rail.n.avail).toBeGreaterThan(n0.avail);
    expect(rail.n.fare).toBeGreaterThan(n0.fare);
    expect(h.s()).toMatchObject({ selectedTrain: { number: '12014' }, selectedClass: 'CC', bookingState: 'AWAITING_CONFIRMATION' });
    expect(h.s().review.reviewVersion).toBeGreaterThan(rv0);
    expect(r.voice.speechText).toMatch(/parso/i);
    const m = mk(); await run(m, REVIEW_2);
    rail.omitOn = nextDay(m.s().date);
    const mr = await m.say('Kal nahi parso');
    expect(m.s().selectedTrain).toBeFalsy();
    expect(m.s().review?.valid).not.toBe(true);
    expect(mr.voice.speechText).toMatch(/12014.*nahi hai/);
    expect(mr.voice.speechText).toMatch(/\?$/);
  });

  it('[M] class unavailable on the new date: train kept, class cleared, no stale quote, asks for class', async () => {
    const h = mk(); await run(h, REVIEW_2, 'TEXT');
    rail.dropCls = { date: nextDay(h.s().date), cls: 'CC' };
    const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso');
    expect(h.s().selectedTrain.number).toBe('12014');
    expect(h.s().selectedClass).toBeFalsy();
    expect(r.newState).toBe('CLASS_OPTIONS');
    expect(h.s().review?.valid).not.toBe(true);
    expect([rail.n.search - n0.search, (rail.n.avail || 0) - (n0.avail || 0), (rail.n.fare || 0) - (n0.fare || 0)]).toEqual([1, 0, 0]);
    expect(r.voice.speechText).toMatch(/Kaunsi class chahiye\?$/);
    expect(r.voice.speechText).not.toMatch(/₹|available hain/);
  });

  it('[N] confirmation gating: not pending, LLM-claimed confirmation, stale review version — all refused; only the user\'s "haan" on the current review proceeds', async () => {
    const early = mk(); await early.say('Amritsar se Delhi kal', 'TEXT');
    expect((await early.say('haan', 'TEXT')).error?.code).toBe('CONFIRMATION_NOT_PENDING');
    class ForceConfirm extends MockLLMProvider {
      async generateStructuredDecision(i: any): Promise<any> {
        if (/fare kitna/.test(i.userText)) return { decision: { intent: 'CONFIRM_BOOKING', action: 'PREPARE_IRCTC_HANDOFF', entities: { affirmation: true }, missingFields: [], confidence: 0.99, clarification: null, toolCalls: [] } };
        return super.generateStructuredDecision(i);
      }
    }
    const f = mk({ llm: new ForceConfirm() }); await run(f, REVIEW_2, 'TEXT');
    const fr = await f.say('12014 ka fare kitna hai', 'TEXT');
    expect(fr.error?.code).toBe('INVALID_CONFIRMATION');
    expect(f.s().bookingState).toBe('AWAITING_CONFIRMATION');
    const h = mk(); await run(h, REVIEW_2, 'TEXT');
    const v1 = h.s().review.reviewVersion;
    await h.say('Kal nahi parso', 'TEXT');
    const v2 = h.s().review.reviewVersion;
    const stale = await h.say('haan', 'TEXT', { reviewVersion: v1 });
    expect(stale.error?.code).toBe('CONFIRMATION_VERSION_MISMATCH');
    expect(h.s().bookingState).toBe('AWAITING_CONFIRMATION');
    const ok = await h.say('haan', 'TEXT', { reviewVersion: v2 });
    expect(ok.newState).toBe('IRCTC_HANDOFF_READY');
    expect(h.s().bookingState).not.toBe('COMPLETE');
  });

  it('[O] sensitive data spoken in voice is blocked before the LLM; nothing is stored', async () => {
    const L = new ScriptedLLM(); const h = mk({ llm: L }); const v = mkVoice(h);
    await h.say('Amritsar se Delhi kal', 'TEXT');
    const n = L.decisions;
    v.agent.listen();
    const o = await v.utter('mera OTP 482913 hai'); await v.drain();
    expect(L.decisions).toBe(n);
    expect(o!.speechText).toMatch(/OTP/);
    expect(o!.speechText).not.toContain('482913');
    expect(JSON.stringify(h.s())).not.toContain('482913');
    expect(h.s().bookingState).toBe('SHOWING_TRAINS');
  });

  it('[P+Q+R] execution boundary: forbidden LLM tools rejected; stopping speech ≠ cancelling; repeated "haan" → one handoff, no PNR, never COMPLETE, no success claim', async () => {
    const L = new ScriptedLLM(); const h = mk({ llm: L }); const v = mkVoice(h);
    await run(h, REVIEW_2, 'TEXT');
    L.tool('book kar do abhi', [{ name: 'BOOK_TICKET', arguments: {} }, { name: 'executeBooking', arguments: {} }, { name: 'MAKE_PAYMENT', arguments: { upiPin: '1234' } }, { name: 'IRCTC_LOGIN', arguments: {} }]);
    const fb = await h.say('book kar do abhi', 'TEXT');
    expect(lastExec(fb, 4)).toEqual(['BOOK_TICKET', 'executeBooking', 'MAKE_PAYMENT', 'IRCTC_LOGIN'].map(t => [t, 'REJECTED', 'FORBIDDEN_ACTION']));
    expect(h.s().bookingState).toBe('AWAITING_CONFIRMATION');
    // stopping the agent's speech at review leaves the booking state untouched
    v.agent.listen(); await v.utter('review dikhao'); await flush();
    const rv = h.s().review.reviewVersion;
    v.agent.cancel();
    expect(h.s()).toMatchObject({ bookingState: 'AWAITING_CONFIRMATION', review: { valid: true, reviewVersion: rv } });
    expect(h.s().pendingInteraction?.type).toBe('CONFIRMATION_REQUIRED');
    const execSpy = vi.spyOn(DisabledBookingExecutor.prototype, 'execute');
    const texts: string[] = [];
    for (const t of ['haan', 'haan', 'book kar do']) { const r = await h.say(t, 'TEXT'); texts.push(r.voice.assistantText, r.responseMessage); }
    expect(h.s().bookingState).toBe('IRCTC_HANDOFF_READY');
    expect((h.s().handoffHistory || []).length).toBe(1);               // no automatic duplicate
    expect(execSpy.mock.calls.length).toBeLessThanOrEqual(1);
    const exec = h.s().bookingExecution || h.s().execution;
    expect(exec?.pnr ?? null).toBeNull();
    expect(exec?.status ?? 'NOT_STARTED').toBe('NOT_STARTED');
    expect(JSON.stringify(h.s())).not.toMatch(/"pnr":"\d{10}"/);
    for (const t of texts) { expect(t).not.toMatch(BOOK_CLAIM); expect(t).not.toMatch(/\b\d{10}\b/); }
    expect(texts[0]).toMatch(/book nahi hua/i);
    execSpy.mockRestore();
  });

  it('[S] text/voice parity: same journey in TEXT and VOICE sessions → identical business state; mixing modes in one session keeps it', async () => {
    const turns = [...REVIEW_2, 'Kal nahi parso'];
    const t = mk(); const v = mk();
    for (const x of turns) { await t.say(x, 'TEXT'); await v.say(x, 'VOICE'); }
    const pick = (s: any) => ({ state: s.bookingState, o: s.origin, d: s.destination, date: s.date, train: s.selectedTrain?.number, cls: s.selectedClass, pax: s.passengers?.map((p: any) => [p.name, p.age, p.gender]), fare: s.fare?.total, rv: s.review?.reviewVersion, avail: s.availability?.CC?.status });
    expect(pick(v.s())).toEqual(pick(t.s()));
    const m = mk();
    for (const [i, x] of turns.entries()) await m.say(x, i % 2 ? 'TEXT' : 'VOICE');
    expect(pick(m.s())).toEqual(pick(t.s()));
  });

  it('[T] fresh provider calls: identical enquiries in later turns always hit the provider (no cache, no duplicate suppression)', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal', 'TEXT'); await h.say('Amritsar se Delhi kal', 'TEXT');
    expect(rail.n.search).toBe(2);
    const L = new ScriptedLLM(); const q = mk({ llm: L });
    await run(q, ['Amritsar se Delhi kal', '12497 wali', '3A'], 'TEXT');
    const args = { trainNumber: '12497', travelClass: '3A', origin: 'ASR', destination: 'NDLS', date: q.s().date };
    L.tool('3A mein seat hai?', [{ name: 'CHECK_AVAILABILITY', arguments: args }]);
    L.tool('3A ka fare?', [{ name: 'GET_FARE', arguments: args }]);
    const a0 = rail.n.avail || 0; const f0 = rail.n.fare || 0;
    for (let i = 0; i < 2; i++) {
      const a = await q.say('3A mein seat hai?', 'TEXT');
      expect(a.turnLog.toolExecutions.slice(-1)[0]).toMatchObject({ status: 'SUCCEEDED', fresh: true });
      await q.say('3A ka fare?', 'TEXT');
    }
    expect([rail.n.avail - a0, rail.n.fare - f0]).toEqual([2, 2]);
  });
});
