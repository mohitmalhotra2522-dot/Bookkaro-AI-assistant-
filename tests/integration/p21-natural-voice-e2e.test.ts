/**
 * PROMPT 21 — GROUP 3: natural real-time voice, end to end.
 *   mock streaming STT → VoiceTurnDetector → ConversationalVoiceAgent → SAME ConversationTurnEngine.processTurn
 *   → MockLLM (structured decision + fact-free acknowledgement) → RailwayToolRuntime → labelled mock (non-live)
 *   spy provider → BookingSession → MockLLM natural wording → NaturalResponseComposer grounding → mock streaming TTS.
 * Covers the Part 41 catalogue + Parts 42–44. Booking stays DISABLED: no network, never COMPLETE, never a booked claim.
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
import { createEngineVoiceAgent } from '../../server/voice/server-voice-agent';
import { MockStreamingSTT } from '../../server/voice/stt/stt-provider';
import { MockStreamingTTS } from '../../server/voice/tts/tts-provider';
import { soundsRobotic, containsChainOfThought, splitSentences } from '../../shared/voice/voice-response-policy';

const meta = () => { const now = new Date().toISOString(); return { source: 'mock' as const, providerId: 'p21-spy', requestTimestamp: now, responseTimestamp: now, latencyMs: 1, cache: 'disabled' as const }; };

class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {}; failAvail = 0; delay = 0; omitOn: string | null = null; gate: Promise<void> | null = null;
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> {
    this.b('search');
    if (this.delay) await new Promise(x => setTimeout(x, this.delay));
    const out: any = await super.searchTrains(r);
    if (this.omitOn && r.date === this.omitOn && out.ok) out.data = { ...out.data, trains: out.data.trains.filter((t: any) => t.trainNumber !== '12014') };
    return out;
  }
  async checkAvailability(r: any): Promise<any> {
    this.b('avail');
    if (this.gate) await this.gate;
    if (this.failAvail > 0) { this.failAvail--; return { ok: false, error: { code: 'PROVIDER_UNAVAILABLE', message: 'Mock availability down.' }, meta: meta() }; }
    return super.checkAvailability(r);
  }
  async getFare(r: any): Promise<any> { this.b('fare'); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p21-spy', () => rail);

function mk(o: { llm?: any; longWaitMs?: number } = {}) {
  const state = new ConversationStateManager();
  const llm = o.llm || new MockLLMProvider();
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no real backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: o.longWaitMs ?? 0 });
  const sid = state.createSession().sessionId;
  return {
    state, eng, sid, orch,
    say: (t: string, mode: 'TEXT' | 'VOICE' = 'VOICE', x: any = {}) => eng.processTurn(sid, t, mode, x) as Promise<any>,
    s: () => state.getSession(sid) as any
  };
}
type H = ReturnType<typeof mk>;
const run = async (h: H, turns: string[], mode: 'TEXT' | 'VOICE' = 'VOICE') => { let r: any; for (const t of turns) r = await h.say(t, mode); return r; };
const acks = (r: any) => r.turnEvents.filter((e: any) => e.type === 'TOOL_PROGRESS' && e.data?.speechText && e.data.kind !== 'STATUS').map((e: any) => e.data.speechText);
const segEvents = (r: any) => r.turnEvents.filter((e: any) => e.type === 'SPEECH_SEGMENT');
const BOOK_CLAIM = new RegExp(FORBIDDEN_SUCCESS_CLAIMS.join('|'), 'i');
const IVR = /your request|kindly|as follows|dear customer|please provide the required|request has been processed|we regret/i;
const UPTO_CLASS = ['Amritsar se Delhi kal', '12014 wali kar do', 'CC'];
const REVIEW_2 = [...UPTO_CLASS, '2 passengers. Mohit 31 male, Ravi 28 male.'];
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const nextDay = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };

/** Voice agent bound to the same engine, with scripted microphone + recorded speaker. */
function mkVoice(h: H) {
  let now = 1000;
  const stt = new MockStreamingSTT(); const tts = new MockStreamingTTS();
  const agent = createEngineVoiceAgent({ engine: h.eng, sessionId: h.sid, output: tts, input: stt, now: () => now });
  const utter = (t: string) => { stt.push({ kind: 'speechStart' }, { kind: 'partial', text: t }); now += 300; stt.push({ kind: 'final', text: t }, { kind: 'speechEnd' }); now += 400; return agent.tick(); };
  const drain = async () => { await flush(); while (tts.playing) { tts.finish(); await flush(); } };
  return { agent, stt, tts, utter, drain, advance: (ms: number) => { now += ms; } };
}

let fetchSpy: any, handoffSpy: any;
const envBefore = process.env.REAL_IRCTC_ENABLED;
beforeEach(() => {
  railwayRegistry.setActive('p21-spy');
  Object.assign(rail, { n: {}, failAvail: 0, delay: 0, omitOn: null, gate: null });
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  handoffSpy = vi.spyOn(IrctcHandoffAdapter.prototype, 'executeHandoff').mockImplementation(() => { throw new Error('handoff execution forbidden'); });
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(handoffSpy).not.toHaveBeenCalled();
  expect(process.env.REAL_IRCTC_ENABLED).toBe(envBefore);
  fetchSpy.mockRestore(); handoffSpy.mockRestore();
  railwayRegistry.setActive('mock');
});

describe('P21 G3 — natural conversation (Parts 2, 6, 16–20, 27, 42, 44)', () => {
  it('[1] greeting: friendly, short, one question — no capability menu, no IVR', async () => {
    const h = mk();
    const r = await h.say('Namaste');
    expect(r.speech.source).toBe('LLM');
    expect(r.voice.speechText).toMatch(/^Namaste! .*\?$/);
    expect(r.voice.speechText).not.toMatch(/madad kar sakta|availability aur fare/);
    expect(r.voice.speechText.length).toBeLessThan(r.responseMessage.length);
  });

  it('[2] P42 full natural conversation: LLM-worded, grounded, concise; one ack per tool turn; never a booked claim', async () => {
    const h = mk();
    const script = ['Amritsar se Delhi jaana hai', 'Kal', '12014 wali', 'CC mein availability dekh lo', 'Do passenger hain', 'Mohit 31 male', 'Ravi 28 male', 'Kal nahi parso', 'haan'];
    const out: any[] = [];
    for (const t of script) out.push(await h.say(t));
    const speech = out.map(r => r.voice.speechText as string);
    expect(out.every(r => r.speech?.source === 'LLM')).toBe(true);
    expect(speech[0]).toMatch(/kab|kis din/i);
    expect(speech[1]).toMatch(/^Kal ke liye 3 trainein mili hain\. Sabse pehli 12014 hai, subah 4:55 wali\. Kaunsi chahiye\?$/);
    expect(speech[1]).not.toContain('18238');                         // Part 18 — the card is not read aloud
    expect(speech[2]).toMatch(/12014/); expect(speech[2]).toMatch(/CC.*2S|2S.*CC/);
    expect(acks(out[3])).toEqual(['Ek second, 12014 ki CC availability check kar raha hoon.']);
    expect(speech[3]).toBe('CC mein seats available hain. Kitne passengers hain?');
    expect(speech[4]).toBe('Theek hai, 2 passengers. Pehle passenger ka naam?');
    expect(speech[5]).toMatch(/Doosre passenger ka naam\?$/);
    expect(speech[6]).toMatch(/12014, CC aur 2 passengers, total ₹1040\. Confirm karna hai\?$/);
    expect(speech[7]).toBe('Achha, parso. 12014 parso ki fresh list mein bhi hai — CC, 2 passengers, total ₹1040. Confirm karna hai?');
    expect(out[8].newState).toBe('IRCTC_HANDOFF_READY');
    expect(speech[8]).toMatch(/book nahi hua/i);
    for (const [k, r] of out.entries()) {
      const t = speech[k];
      expect(t).not.toMatch(IVR); expect(soundsRobotic(t)).toBe(false); expect(containsChainOfThought(t)).toBe(false);
      expect(t).not.toMatch(BOOK_CLAIM); expect(r.responseMessage).not.toMatch(BOOK_CLAIM);
      expect(splitSentences(t).length).toBeLessThanOrEqual(4);
      expect((t.match(/\?/g) || []).length).toBeLessThanOrEqual(1);   // one follow-up question at a time
      expect(t.length).toBeLessThanOrEqual(260);
      expect(acks(r).length).toBeLessThanOrEqual(1);
      expect(r.voice).toMatchObject({ shouldSpeak: true, interruptible: true, presentable: true });
    }
    expect(h.s().bookingState).not.toBe('COMPLETE');
  });

  it('[3] Hinglish in → Hinglish out, English in → English out; same authoritative state either way', async () => {
    const hi = mk(), en = mk();
    const a = await hi.say('Amritsar se Delhi kal jaana hai');
    const b = await en.say('I want to go from Amritsar to Delhi tomorrow');
    expect(a.speech.language).toBe('HINGLISH');
    expect(a.voice.speechText).toMatch(/trainein mili hain/);
    expect(b.speech.language).toBe('ENGLISH');
    expect(b.voice.speechText).toBe('I found 3 trains. The earliest is 12014 at 04:55. Which one would you like?');
    expect(en.s().date).toBe(hi.s().date);
    expect(en.s().searchResults.trains.map((t: any) => t.trainNumber)).toEqual(hi.s().searchResults.trains.map((t: any) => t.trainNumber));
  });

  it('[4] STT normalization feeds the shared engine (VOICE only); spoken digits resolve the train', async () => {
    const h = mk();
    await h.say('Amritsar se Delhi kal');
    const r = await h.say('umm ek do zero ek chaar wali');
    expect(h.s().selectedTrain.number).toBe('12014');
    expect(r.turnLog.turnEngine.sttNormalization).toEqual(expect.arrayContaining(['FILLERS', 'SPOKEN_DIGITS']));
    const t = mk();
    const rt = await t.say('Amritsar se Delhi kal', 'TEXT');
    expect(rt.turnLog.turnEngine.sttNormalization).toBeUndefined();
  });

  it('[5] follow-up + context: a bare answer fills the pending question; known info is never re-asked; references resolve', async () => {
    const h = mk();
    const a = await h.say('Amritsar se Delhi jaana hai');
    expect(h.s().bookingState).toBe('COLLECTING_DATE');
    const b = await h.say('Parso');
    expect(b.newState).toBe('SHOWING_TRAINS');
    expect(b.voice.speechText).toMatch(/^Parso ke liye 3 trainein mili hain/);
    expect(b.voice.speechText).not.toMatch(/kahan se|kahan jaana/i);
    const c = await h.say('second wali');
    expect(h.s().selectedTrain.number).toBe('12497');
    expect(c.voice.speechText).toMatch(/12497/);
    expect(a.voice.speechText).not.toMatch(/kahan se/i);
  });
});

describe('P21 G3 — tools, results, interruption, stale protection (Parts 3, 9–15, 33–35, 43)', () => {
  it('[6] tool call: ONE fact-free LLM acknowledgement, spoken before any fact; facts only after the tool result', async () => {
    const h = mk();
    await run(h, ['Amritsar se Delhi kal', '12014 wali']);
    const r = await h.say('CC mein availability dekh lo');
    expect(acks(r)).toHaveLength(1);
    expect(acks(r)[0]).not.toMatch(/available hain|waitlist|rac|₹|\d{1,2}:\d{2}/i);
    expect(r.turnLog.turnEngine.acknowledgementSource).toBe('LLM');
    const ev = r.turnEvents;
    const ackSeq = ev.find((e: any) => e.type === 'TOOL_PROGRESS').seq;
    const doneSeq = ev.find((e: any) => e.type === 'TOOL_COMPLETED').seq;
    const segs = segEvents(r);
    expect(segs.length).toBeGreaterThan(0);
    expect(ackSeq).toBeLessThan(doneSeq);
    expect(segs[0].seq).toBeGreaterThan(doneSeq);                       // no fact is spoken before the tool result
    expect(segs.map((e: any) => e.data.text).join(' ')).toBe(r.voice.speechText);
  });

  it('[7] tool-result response states exactly the authoritative provider result (Available / RAC)', async () => {
    const h = mk();
    await run(h, ['Amritsar se Delhi kal', '12014 wali']);
    const a = await h.say('CC mein availability dekh lo');
    expect(h.s().availability.CC.status).toBe('Available');
    expect(a.voice.speechText).toMatch(/^CC mein seats available hain\./);
    const g = mk();
    await run(g, ['Amritsar se Delhi kal', 'second wali']);
    const b = await g.say('CC ki availability check karo');
    const st = g.s().availability.CC.status;
    expect(b.voice.speechText).toContain(`CC mein abhi ${st} hai.`);
  });

  it('[8] P43 interruption: ack plays → user barges in "Nahi, 14542 check karo" → TTS stops, old turn discarded, 14542 rejected naturally', async () => {
    const h = mk();
    const v = mkVoice(h);
    v.agent.setConversationMode(true); v.agent.listen();
    for (const t of UPTO_CLASS) { await v.utter(t); await v.drain(); }
    let release!: () => void; rail.gate = new Promise<void>(r => { release = r; });
    const p1 = v.utter('12014 ki availability check karo');
    await flush();
    expect(v.tts.playing).toBe('Ek second, 12014 ki CC availability check kar raha hoon.');
    v.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'nahi 14542' });
    expect(v.tts.spoken[v.tts.spoken.length - 1].status).toBe('CANCELLED');
    expect(v.agent.snapshot().state).toBe('USER_SPEAKING');
    v.advance(300); v.stt.push({ kind: 'final', text: 'Nahi, 14542 check karo' }, { kind: 'speechEnd' }); v.advance(400);
    const p2 = v.agent.tick();
    rail.gate = null; release();
    const [o1, o2] = await Promise.all([p1, p2]);
    await v.drain();
    expect(o1).toBeNull();                                              // the interrupted turn never presents
    expect(o2).toMatchObject({ responsePriority: 'INTERRUPT', presentable: true });
    expect(o2!.speechText).toMatch(/^14542 is route ki list mein nahi hai\. 12014 hi selected hai\./);
    expect(h.s().selectedTrain.number).toBe('12014');
    const turns = h.eng.getTurns(h.sid);
    const old = turns[turns.length - 2];
    expect(old).toMatchObject({ status: 'SUPERSEDED', presentation: 'DISCARDED', interrupted: true });
    expect(h.eng.events.forTurn(h.sid, old.turnId).filter(e => e.type === 'SPEECH_SEGMENT')).toHaveLength(0);
    const after = v.tts.spoken.slice(-3).map(x => x.text);
    expect(after[0]).toBe('14542 is route ki list mein nahi hai.');
    const o3 = await v.utter('12497 wali'); await v.drain();
    expect(h.s().selectedTrain.number).toBe('12497');
    expect(o3!.speechText).toMatch(/12497/);
  });

  it('[9] stale protection: a superseded in-flight turn is never presentable / speakable (engine-level, Part 34)', async () => {
    const h = mk();
    await run(h, UPTO_CLASS);
    let release!: () => void; rail.gate = new Promise<void>(r => { release = r; });
    const p1 = h.say('availability check karo');
    await flush();
    const p2 = h.say('Amritsar se Ludhiana kal', 'VOICE', { interruptPrevious: true });
    await flush();
    rail.gate = null; release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.presentable).toBe(false);
    expect(r1.voice).toMatchObject({ presentable: false, shouldSpeak: false, speechText: '', segments: [] });
    expect(segEvents(r1)).toHaveLength(0);
    expect(r2.presentable).toBe(true);
    expect(r2.voice.responsePriority).toBe('INTERRUPT');
    expect(h.s().destination).toBe('LDH');
  });

  it('[10] TTS cancel: one tap stops speech immediately; the presentation is marked INTERRUPTED; state untouched', async () => {
    const h = mk();
    const v = mkVoice(h);
    v.agent.listen();
    await v.utter('Amritsar se Delhi kal');
    await flush();
    expect(v.tts.playing).toBeTruthy();
    const before = JSON.stringify({ st: h.s().bookingState, d: h.s().date });
    v.agent.cancel();
    expect(v.tts.playing).toBeNull();
    expect(v.tts.spoken.some(x => x.status === 'CANCELLED')).toBe(true);
    const last = h.eng.getTurns(h.sid).slice(-1)[0];
    expect(last.presentation).toBe('INTERRUPTED');
    expect(JSON.stringify({ st: h.s().bookingState, d: h.s().date })).toBe(before);
    expect(v.agent.snapshot()).toMatchObject({ state: 'IDLE', listening: false, conversationMode: false });
  });

  it('[11] long tool call: one acknowledgement + at most ONE fact-free status update, then silence', async () => {
    const h = mk({ longWaitMs: 20 });
    rail.delay = 60;
    const r = await h.say('Amritsar se Delhi kal jaana hai');
    const prog = r.turnEvents.filter((e: any) => e.type === 'TOOL_PROGRESS' && e.data?.speechText);
    expect(prog.map((e: any) => e.data.kind)).toEqual(['ACK', 'STATUS']);
    expect(prog[0].data.speechText).toBe('Ek second, trains check kar raha hoon.');   // P18 default kept for plain search
    expect(prog[1].data.speechText).not.toMatch(/\d|available|mili/i);
    expect(r.turnLog.turnEngine.statusUpdate).toBe(true);
  });
});

describe('P21 G3 — date policy, fresh data, re-validation (Parts 7, 37, 38)', () => {
  it('[12] "Kal nahi parso" at review: fresh search + availability + fare, same train kept, review rebuilt, HIGH priority', async () => {
    const h = mk();
    await run(h, REVIEW_2, 'TEXT');
    const d0 = h.s().date, rv0 = h.s().review.reviewVersion, n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso');
    expect(h.s().date).toBe(nextDay(d0));
    expect(rail.n.search).toBe(n0.search + 1);
    expect(rail.n.avail).toBe(n0.avail + 1);
    expect(rail.n.fare).toBe(n0.fare + 1);
    expect(h.s().selectedTrain.number).toBe('12014');
    expect(h.s().selectedClass).toBe('CC');
    expect(h.s().review.valid).toBe(true);
    expect(h.s().review.reviewVersion).toBeGreaterThan(rv0);
    expect(acks(r)[0]).toMatch(/parso/i);
    expect(acks(r)[0]).not.toMatch(/\bkal\b.*kar dete/i);
    expect(r.voice.responsePriority).toBe('HIGH');
    expect(r.voice.speechText).toMatch(/^Achha, parso\. 12014 parso ki fresh list mein bhi hai/);
    expect(r.voice.speechText).toMatch(/Confirm karna hai\?$/);
  });

  it('[13] train carry-over re-validated: a train missing on the new date is NOT carried over (no availability / fare for it)', async () => {
    const h = mk();
    await run(h, REVIEW_2, 'TEXT');
    rail.omitOn = nextDay(h.s().date);
    const n0 = { ...rail.n };
    const r = await h.say('Kal nahi parso');
    expect(h.s().selectedTrain).toBeUndefined();
    expect(h.s().selectedClass).toBeUndefined();
    expect(h.s().review?.valid ?? false).toBe(false);
    expect(rail.n.avail || 0).toBe(n0.avail || 0);
    expect(rail.n.fare || 0).toBe(n0.fare || 0);
    expect(r.newState).toBe('SHOWING_TRAINS');
    expect(r.voice.speechText).toMatch(/12014 parso ki list mein nahi hai/);
    expect(r.voice.speechText).not.toMatch(/12014[^.]*(available|rakhi)/i);
  });

  it('[14] class re-validation on a train change: an unsupported class is dropped and the new options are asked', async () => {
    const h = mk();
    await run(h, UPTO_CLASS);
    const r = await h.say('18238 wali');
    expect(h.s().selectedTrain.number).toBe('18238');
    expect(h.s().selectedClass).toBeUndefined();
    expect(r.newState).toBe('CLASS_OPTIONS');
    expect(r.voice.speechText).toMatch(/3A ya SL/);
    expect(r.voice.speechText).not.toMatch(/\bCC\b/);
  });

  it('[15] fresh availability + fresh fare: every voice request hits the provider (no voice cache)', async () => {
    const h = mk();
    await run(h, ['Amritsar se Delhi kal', '18238 wali', 'SL']);
    const a1 = await h.say('availability dobara check karo');
    const a2 = await h.say('availability dobara check karo');
    expect(rail.n.avail).toBe(2);
    expect(a1.voice.speechText).toMatch(/^SL mein abhi /);
    expect(a2.voice.speechText).toMatch(/^SL mein abhi /);
    const f1 = await h.say('fare kitna hai');
    const f2 = await h.say('fare kitna hai');
    expect(rail.n.fare).toBe(2);
    expect(f1.voice.speechText).toBe(`SL ka fare ₹${h.s().fare.perPassenger} per passenger hai. Kitne passengers hain?`);
    expect(f2.voice.speechText).toBe(f1.voice.speechText);
  });
});

describe('P21 G3 — passengers, review, confirmation (Parts 22–26)', () => {
  it('[16] passengers collected conversationally, one field at a time (no PII in voice provenance logs)', async () => {
    const h = mk();
    await run(h, UPTO_CLASS);
    const steps: Array<[string, RegExp]> = [
      ['Do passenger hain', /^Theek hai, 2 passengers\. Pehle passenger ka naam\?$/],
      ['Mohit', /Mohit ki (age|umar kitni hai)\?$/],
      ['31', /Mohit — male ya female\?$/],
      ['male', /Doosre passenger ka naam\?$/],
      ['Ravi', /Ravi ki (age|umar kitni hai)\?$/]
    ];
    for (const [t, re] of steps) {
      const r = await h.say(t);
      expect(r.voice.speechText).toMatch(re);
      expect((r.voice.speechText.match(/\?/g) || []).length).toBe(1);
      expect(JSON.stringify(r.turnLog.naturalSpeech)).not.toMatch(/Mohit|Ravi/);
    }
    expect(h.s().passengers[0]).toMatchObject({ name: 'Mohit', age: 31, gender: 'MALE' });
  });

  it('[17] review: one natural, grounded summary (train, class, count, verified total) ending with the confirmation question', async () => {
    const h = mk();
    await run(h, UPTO_CLASS);
    const r = await h.say('2 passengers. Mohit 31 male, Ravi 28 male.');
    expect(r.newState).toBe('AWAITING_CONFIRMATION');
    const total = h.s().review.snapshot.fare.total;
    expect(total).toBe(1040);
    expect(r.voice.speechText).toMatch(/12014/);
    expect(r.voice.speechText).toMatch(/\bCC\b/);
    expect(r.voice.speechText).toMatch(/2 passengers/);
    expect(r.voice.speechText).toContain(`₹${total}`);
    expect(r.voice.speechText).toMatch(/Confirm karna hai\?$/);
    expect(r.voice.speechText.length).toBeLessThan(r.responseMessage.length);
  });

  it('[18] confirmation guard: "haan" only confirms at AWAITING_CONFIRMATION with a CURRENT review; never booked / COMPLETE', async () => {
    const h = mk();
    await run(h, UPTO_CLASS);
    const early = await h.say('haan');
    expect(early.newState).not.toBe('IRCTC_HANDOFF_READY');
    expect(early.voice.speechText).not.toMatch(/book|confirm ho/i);
    await h.say('2 passengers. Mohit 31 male, Ravi 28 male.');
    const r = await h.say('haan');
    expect(r.newState).toBe('IRCTC_HANDOFF_READY');
    expect(r.voice.speechText).toMatch(/book nahi hua/i);
    expect(r.voice.speechText).toMatch(/enabled nahi/i);
    expect(r.voice.speechText).not.toMatch(BOOK_CLAIM);
    expect(r.responseMessage).not.toMatch(BOOK_CLAIM);
    expect(h.s().bookingState).not.toBe('COMPLETE');
  });
});

describe('P21 G3 — parity, failures, fallback, recovery, security (Parts 21, 31, 32, 36, 39, 40)', () => {
  it('[19] TEXT/VOICE parity: same engine result shape + same authoritative state; voice metadata on both', async () => {
    const t = mk(), v = mk();
    let rt: any, rv: any;
    for (const x of ['Amritsar se Delhi kal', 'second wali', 'CC', 'Do passenger hain']) { rt = await t.say(x, 'TEXT'); rv = await v.say(x, 'VOICE'); }
    for (const k of ['origin', 'destination', 'date', 'selectedClass', 'passengersCount', 'bookingState']) expect(v.s()[k]).toEqual(t.s()[k]);
    expect(v.s().selectedTrain.number).toBe(t.s().selectedTrain.number);
    expect(Object.keys(rv).filter(k => k !== 'speech').sort()).toEqual(Object.keys(rt).filter(k => k !== 'speech').sort());
    // Prompt 22: assistantText = the grounded LLM wording in BOTH modes (responseMessage = authoritative backend reply)
    expect(rt.voice).toMatchObject({ shouldSpeak: false, presentable: true, assistantText: 'Theek hai, 2 passengers. Pehle passenger ka naam?', state: rt.newState });
    expect(rv.voice).toMatchObject({ shouldSpeak: true, presentable: true, assistantText: rv.voice.speechText, state: rv.newState });
    expect(rt.responseMessage).toBe('2 passengers ke details chahiye. Pehle passenger ka naam bataiye.');   // TEXT reply unchanged by P21
    expect(rv.responseMessage).toBe('Pehle passenger ka naam?');                                           // existing P19 short voice reply
    expect(rv.voice.speechText).toBe('Theek hai, 2 passengers. Pehle passenger ka naam?');                // natural wording → speech only
  });

  it('[20] provider failure: honest natural error + retry offer (read-only); retry is a fresh call with a grounded result', async () => {
    const h = mk();
    await run(h, ['Amritsar se Delhi kal', 'second wali']);
    rail.failAvail = 99;
    const r = await h.say('CC ki availability check karo');
    expect(r.voice.speechText).toBe('Availability abhi verify nahi ho paayi. Dobara check kar doon?');
    expect(r.voice.speechText).not.toMatch(/RAC|WL|Available hai|seats/i);
    rail.failAvail = 0;
    const n0 = rail.n.avail;
    const r2 = await h.say('haan dobara check karo');
    expect(rail.n.avail).toBe(n0 + 1);
    expect(r2.voice.speechText).toContain(`CC mein abhi ${h.s().availability.CC.status} hai.`);
  });

  it('[21] text fallback: provider without natural wording / failing wording → deterministic speech; TTS failure → text', async () => {
    class PlainLLM extends MockLLMProvider { }
    (PlainLLM.prototype as any).generateSpokenResponse = undefined;
    class BrokenLLM extends MockLLMProvider { async generateSpokenResponse(): Promise<any> { throw new Error('LLM down'); } }
    class InventingLLM extends MockLLMProvider { async generateSpokenResponse(): Promise<any> { return { text: '99999 sabse achhi hai. Fare ₹1 hai. Kaunsi chahiye?' }; } }
    for (const [L, reason] of [[PlainLLM, 'PROVIDER_NO_SPOKEN_RESPONSE'], [BrokenLLM, 'PROVIDER_ERROR']] as const) {
      const h = mk({ llm: new (L as any)() });
      const r = await h.say('Amritsar se Delhi kal');
      expect(r.speech).toMatchObject({ source: 'FALLBACK', fallbackReason: reason });
      expect(r.voice.speechText).toBe(r.responseMessage);
      expect(h.s().bookingState).toBe('SHOWING_TRAINS');
    }
    const g = mk({ llm: new InventingLLM() });
    const gi = await g.say('Amritsar se Delhi kal');
    expect(gi.voice.speechText).toBe('Kaunsi chahiye?');
    expect(gi.turnLog.naturalSpeech.rejected).toEqual(['UNGROUNDED_NUMBER:99999', 'UNGROUNDED_FARE']);   // invented train + fare dropped
    const h = mk();
    const v = mkVoice(h);
    v.tts.failNext = 5;
    v.agent.listen();
    const o = await v.utter('Amritsar se Delhi kal');
    await v.drain();
    expect(o!.assistantText).toBe(h.eng.getTurns(h.sid).slice(-1)[0].assistantResponse!.speechText);   // reply kept although TTS failed
    expect(v.agent.snapshot().textFallback).toBe(true);
  });

  it('[22] session recovery: a new voice agent (reload) continues the SAME session; text ↔ voice switches keep state', async () => {
    const h = mk();
    const v1 = mkVoice(h);
    v1.agent.listen(); await v1.utter('Amritsar se Delhi kal'); await v1.drain();
    v1.agent.listen(); await v1.utter('12014 wali'); await v1.drain();
    v1.agent.cancel();
    const snap = h.eng.resume(h.sid)!;
    expect(snap).toMatchObject({ sessionId: h.sid, bookingState: 'CLASS_OPTIONS' });
    const v2 = mkVoice(h);
    v2.agent.listen();
    const o = await v2.utter('CC');
    expect(o!.speechText).toBe('CC theek hai. Kitne passengers hain?');
    const t = await h.say('2 passengers', 'TEXT');
    expect(t.newState).toBe('COLLECTING_PASSENGER_DETAILS');
    expect(h.s().selectedTrain.number).toBe('12014');
    expect(h.s().selectedClass).toBe('CC');
  });

  it('[23] security: sensitive voice input bypasses LLM wording, nothing is asked back; no voice-only memory store', async () => {
    const h = mk();
    const r = await h.say('mera OTP 123456 hai');
    expect(r.speech).toBeUndefined();
    expect(r.voice.speechText).not.toMatch(/123456/);
    expect(r.voice.speechText).not.toMatch(/(batao|bataiye|share karein|enter|bhejiye)\s*(apna)?\s*(otp|password|pin)/i);
    expect(r.turnLog.userInput).not.toMatch(/123456/);
    const v = mkVoice(h);
    expect(Object.keys(v.agent.snapshot()).sort()).toEqual(['activeSequence', 'activeTurnId', 'conversationMode', 'lastError', 'listening', 'partialTranscript', 'state', 'sttAvailable', 'textFallback', 'toolActivity', 'ttsAvailable']);
  });
});
