/**
 * PROMPT 21 — GROUP 2: voice infrastructure.
 *   STT normalization · VoiceTurnDetector · response policy (ack / speakable / priority / echo / segments)
 *   ConversationalVoiceAgent state machine (tap + conversation mode, one ack, streaming, barge-in, stale, fallbacks)
 *   mock streaming STT/TTS · NaturalResponseComposer grounding · OpenAI-compatible provider + env factory.
 * Offline + deterministic: fetch is injected or forbidden; no microphone, no audio, no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { normalizeTranscript } from '../../shared/voice/stt-normalizer';
import { VoiceTurnDetector } from '../../shared/voice/voice-turn-detector';
import {
  preempts, isSpeakable, validateAcknowledgement, containsChainOfThought, soundsRobotic, segmentForSpeech, isLikelyEcho
} from '../../shared/voice/voice-response-policy';
import { detectLanguageStyle } from '../../shared/voice/language-style';
import { turnEventToVoiceEvent } from '../../shared/voice/voice-events';
import { ConversationalVoiceAgent, type TurnProcessor, type VoiceTurnOutcome, type VoiceTurnEvent } from '../../shared/voice/conversational-voice-agent';
import { MockStreamingSTT } from '../../server/voice/stt/stt-provider';
import { MockStreamingTTS } from '../../server/voice/tts/tts-provider';
import { NaturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { OpenAICompatibleLLMProvider } from '../../server/ai/providers/openai-compatible-llm';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { BookingState } from '../../shared/states';

const flush = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

let fetchSpy: any;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { fetchSpy.mockRestore(); });

// ---------------------------------------------------------------- agent harness
interface Scripted { events?: Array<Omit<VoiceTurnEvent, 'turnId' | 'sequence'>>; outcome?: Partial<VoiceTurnOutcome>; hold?: boolean }
function mkAgent(script: Scripted[] = []) {
  let now = 1000;
  const stt = new MockStreamingSTT();
  const tts = new MockStreamingTTS();
  const remote: string[] = [];
  const calls: Array<{ text: string; bargeIn: boolean; priority: string }> = [];
  const pending: Array<() => void> = [];
  let n = 0;
  const proc: TurnProcessor = async (text, o) => {
    const k = n++;
    calls.push({ text, bargeIn: o.bargeIn, priority: o.priority });
    const sc = script[k] || {};
    const turnId = `t${k + 1}`, sequence = k + 1;
    o.onEvent({ type: 'TURN_STARTED', turnId, sequence });
    for (const e of sc.events || []) o.onEvent({ ...(e as any), turnId, sequence });
    if (sc.hold) await new Promise<void>(r => pending.push(r));
    const speech = sc.outcome?.speechText ?? `Reply ${k + 1}.`;
    return { sessionId: 's1', turnId, sequence, presentable: true, assistantText: speech, speechText: speech, segments: [], shouldSpeak: true, interruptible: true, responsePriority: o.priority, ...(sc.outcome || {}) } as VoiceTurnOutcome;
  };
  const agent = new ConversationalVoiceAgent({ sessionId: 's1', processTurn: proc, output: tts, input: stt, now: () => now, interruptRemote: (r) => { remote.push(r); } });
  const events: string[] = [];
  agent.on(e => { if (e.type !== 'PARTIAL' && e.type !== 'STATE') events.push(e.type + ((e as any).reason ? `:${(e as any).reason}` : '')); });
  const say = async (text: string, o: { partial?: string } = {}) => {
    stt.push({ kind: 'speechStart' }, { kind: 'partial', text: o.partial ?? text.split(' ')[0] });
    now += 300; stt.push({ kind: 'final', text }, { kind: 'speechEnd' });
    now += 400;
    const p = agent.tick();
    return p ? await p : null;
  };
  return { agent, stt, tts, remote, calls, pending, events, say, advance: (ms: number) => { now += ms; } };
}

describe('P21 G2 — STT normalization + turn detection', () => {
  it('[1] normalizes noisy STT (fillers, spoken digits, Devanagari digits, class names, repeats) — never touches "haan"', () => {
    expect(normalizeTranscript('umm ek do zero ek chaar ki availability').text).toBe('12014 ki availability');
    expect(normalizeTranscript('१२०१४ wali').text).toBe('12014 wali');
    expect(normalizeTranscript('see see mein dikhao').text).toBe('CC mein dikhao');
    expect(normalizeTranscript('chair car').text).toBe('CC');
    expect(normalizeTranscript('three a mein').text).toBe('3A mein');
    expect(normalizeTranscript('two s class').text).toBe('2S class');
    expect(normalizeTranscript('sleeper class chahiye').text).toBe('SL chahiye');
    expect(normalizeTranscript('kal kal jaana hai').text).toBe('kal jaana hai');
    for (const t of ['haan', 'aaj ki train', 'Do passenger hain']) expect(normalizeTranscript(t)).toEqual({ text: t, applied: [] });
  });

  it('[2] end-of-turn uses STT final + silence + activity (adaptive), not a long fixed timeout', () => {
    const d = new VoiceTurnDetector();
    d.speechStart(0); d.finalTranscript('Amritsar se Delhi', 100);
    expect(d.evaluate(1500).status).toBe('USER_SPEAKING');            // still speaking → not cut off
    d.speechEnd(1600);
    expect(d.evaluate(1800).status).toBe('USER_PAUSED');
    const fin = d.evaluate(1960);                                      // final + 350ms silence
    expect(fin).toMatchObject({ status: 'USER_FINISHED', finalTranscript: 'Amritsar se Delhi', reason: 'FINAL_AND_SILENT' });
    const p = new VoiceTurnDetector();
    p.partialTranscript('kal jaana', 0);
    expect(p.evaluate(500).status).toBe('USER_PAUSED');               // partial only → longer wait
    // Prompt 34 (§3) supersedes the P21 pin "partial-only → USER_FINISHED at 710": interim speech is NEVER submitted;
    // the detector waits for the final and gives up honestly (INCOMPLETE, nothing submitted) at the 2000ms ceiling
    expect(p.evaluate(710)).toMatchObject({ status: 'USER_PAUSED', reason: 'WAITING_FOR_FINAL' });
    expect(p.evaluate(2000)).toMatchObject({ status: 'INCOMPLETE', finalTranscript: null });
    const c = new VoiceTurnDetector();
    c.finalTranscript('Kal nahi', 0);                                  // trailing "nahi" → user is mid-correction
    expect(c.evaluate(900).status).toBe('USER_PAUSED');
    c.finalTranscript('parso', 1000);
    const cf = c.evaluate(1400);
    expect(cf.finalTranscript).toBe('Kal nahi parso');
    const w = new VoiceTurnDetector();
    w.finalTranscript('12014 wali', 0);                                // a complete reference is not a continuation
    expect(w.evaluate(400).status).toBe('USER_FINISHED');
    const b = new VoiceTurnDetector(); b.markBargeIn(); b.finalTranscript('ruko', 0);
    expect(b.evaluate(2000)).toMatchObject({ status: 'USER_FINISHED', bargeIn: true });
  });
});

describe('P21 G2 — response policy', () => {
  it('[3] acknowledgements are fact-free; chain-of-thought / IVR phrasing detected; echo + segmentation', () => {
    expect(validateAcknowledgement('Haan, ek second, 12014 ki CC availability check karta hoon.', { trainNumbers: ['12014'] }).ok).toBe(true);
    expect(validateAcknowledgement('Ek second, 12014 mein seats available hain.', { trainNumbers: ['12014'] })).toMatchObject({ ok: false, reason: 'RESULT_WORD' });
    expect(validateAcknowledgement('Fare ₹520 hai, check karta hoon', { trainNumbers: [] })).toMatchObject({ ok: false, reason: 'FARE' });
    expect(validateAcknowledgement('Ek second, 99999 check karta hoon', { trainNumbers: ['12014'] })).toMatchObject({ ok: false, reason: 'NUMBER' });
    expect(validateAcknowledgement('12014 subah 04:55 pe hai', { trainNumbers: ['12014'] })).toMatchObject({ ok: false, reason: 'TIME' });
    expect(containsChainOfThought('Let me think step by step about this.')).toBe(true);
    expect(containsChainOfThought('Pehle mujhe tool call karna hoga, phir batata hoon.')).toBe(true);
    expect(containsChainOfThought('Kal ke liye 3 trainein mili hain.')).toBe(false);
    expect(soundsRobotic('Your request has been processed.')).toBe(true);
    expect(soundsRobotic('Kindly provide passenger details.')).toBe(true);
    expect(soundsRobotic('Theek hai, 2 passengers. Pehle passenger ka naam?')).toBe(false);
    expect(segmentForSpeech('Sabse pehli 12014 hai, subah 4:55 wali. Total ₹1040. Confirm karna hai?')).toEqual(['Sabse pehli 12014 hai, subah 4:55 wali.', 'Total ₹1040.', 'Confirm karna hai?']);
    expect(isLikelyEcho('kal ke liye teen trainein', 'Kal ke liye 3 trainein mili hain.')).toBe(true);
    expect(isLikelyEcho('nahi ruko 12497', 'Kal ke liye 3 trainein mili hain.')).toBe(false);
  });

  it('[4] sequencing: newer turn always wins; stale / interrupted / other-session responses are not speakable', () => {
    expect(preempts({ priority: 'NORMAL', sequence: 3 }, { priority: 'HIGH', sequence: 2 })).toBe(true);
    expect(preempts({ priority: 'INTERRUPT', sequence: 2 }, { priority: 'NORMAL', sequence: 3 })).toBe(false);
    expect(preempts({ priority: 'HIGH', sequence: 2 }, { priority: 'NORMAL', sequence: 2 })).toBe(true);
    const ctx = { sessionId: 's', latestSequence: 5, interruptedTurnIds: new Set(['t4']), journeyVersion: 3 };
    expect(isSpeakable({ sessionId: 's', turnId: 't5', sequence: 5, journeyVersion: 3 }, ctx)).toEqual({ ok: true });
    expect(isSpeakable({ sessionId: 'x', turnId: 't5', sequence: 5 }, ctx)).toMatchObject({ reason: 'OTHER_SESSION' });
    expect(isSpeakable({ sessionId: 's', turnId: 't4', sequence: 4 }, ctx)).toMatchObject({ reason: 'INTERRUPTED' });
    expect(isSpeakable({ sessionId: 's', turnId: 't3', sequence: 3 }, ctx)).toMatchObject({ reason: 'SUPERSEDED' });
    expect(isSpeakable({ sessionId: 's', turnId: 't5', sequence: 5, journeyVersion: 2 }, ctx)).toMatchObject({ reason: 'JOURNEY_CHANGED' });
  });

  it('[5] language style follows the user; name-only replies keep the earlier style; engine events map 1:1', () => {
    expect(detectLanguageStyle('Kal Delhi jaana hai')).toBe('HINGLISH');
    expect(detectLanguageStyle('I want to go to Delhi tomorrow')).toBe('ENGLISH');
    expect(detectLanguageStyle('कल दिल्ली जाना है')).toBe('HINDI');
    expect(detectLanguageStyle('Mohit 31 male', ['Amritsar se Delhi jaana hai'])).toBe('HINGLISH');
    expect(detectLanguageStyle('Mohit 31 male', ['I want to go to Delhi'])).toBe('ENGLISH');
    const ev = (type: any, data?: any) => ({ seq: 1, sessionId: 's', turnId: 't', turnSequence: 2, type, at: '', ...(data ? { data } : {}) }) as any;
    expect(turnEventToVoiceEvent(ev('TOOL_PROGRESS', { text: 'x', speechText: 'Ek second.', kind: 'ACK' }))).toEqual({ type: 'ACKNOWLEDGEMENT', turnId: 't', sequence: 2, text: 'Ek second.' });
    expect(turnEventToVoiceEvent(ev('TOOL_PROGRESS', { text: 'x', speechText: 'Bas ek moment.', kind: 'STATUS' }))?.type).toBe('STATUS_UPDATE');
    expect(turnEventToVoiceEvent(ev('TOOL_PROGRESS', { text: 'x' }))).toBeNull();
    expect(turnEventToVoiceEvent(ev('SPEECH_SEGMENT', { index: 1, text: 'Kaunsi chahiye?' }))).toEqual({ type: 'SPEECH_SEGMENT', turnId: 't', sequence: 2, index: 1, text: 'Kaunsi chahiye?' });
    expect(turnEventToVoiceEvent(ev('TOOL_COMPLETED', { tool: 'GET_FARE', status: 'SUCCEEDED' }))).toMatchObject({ type: 'TOOL_RESULT', ok: true });
  });
});

describe('P21 G2 — ConversationalVoiceAgent', () => {
  it('[6] no hidden recording; tap-to-talk opens the mic once, closes it after the utterance, normalizes, one ack only', async () => {
    const h = mkAgent([{ events: [
      { type: 'TOOL_REQUESTED', tool: 'CHECK_AVAILABILITY' } as any,
      { type: 'ACKNOWLEDGEMENT', text: 'Haan, ek second, availability check karta hoon.' } as any,
      { type: 'ACKNOWLEDGEMENT', text: 'Second ack must not be spoken.' } as any,
      { type: 'TOOL_RESULT', tool: 'CHECK_AVAILABILITY', ok: true } as any
    ], outcome: { speechText: 'CC mein seats available hain. Kitne passengers hain?' } }]);
    h.stt.push({ kind: 'final', text: 'hidden speech' });
    expect(h.stt.startCount).toBe(0);
    expect(h.agent.tick()).toBeNull();
    expect(h.calls).toHaveLength(0);                                   // nothing heard without a user tap
    h.agent.listen();
    expect(h.stt.startCount).toBe(1);
    expect(h.stt.continuous).toBe(false);                               // tap-to-talk default
    const o = await h.say('umm see see ki availability');
    expect(h.calls[0]).toMatchObject({ text: 'CC ki availability', bargeIn: false });
    expect(o?.presentable).toBe(true);
    expect(h.stt.active).toBe(false);                                   // mic closed after one utterance
    expect(h.agent.snapshot().toolActivity).toEqual([{ tool: 'CHECK_AVAILABILITY', status: 'OK' }]);
    while (h.tts.playing) { h.tts.finish(); await flush(); }
    expect(h.tts.spoken.map(x => x.text)).toEqual(['Haan, ek second, availability check karta hoon.', 'CC mein seats available hain.', 'Kitne passengers hain?']);
    expect(h.tts.spoken.every(x => x.status === 'DONE')).toBe(true);
    expect(h.agent.snapshot().state).toBe('IDLE');
  });

  it('[7] streamed segments play before the turn finishes; the final outcome does not repeat them', async () => {
    const h = mkAgent([{ hold: true, events: [
      { type: 'SPEECH_SEGMENT', index: 0, text: 'Kal ke liye 3 trainein mili hain.' } as any
    ], outcome: { speechText: 'Kal ke liye 3 trainein mili hain. Kaunsi chahiye?', segments: ['Kal ke liye 3 trainein mili hain.', 'Kaunsi chahiye?'] } }]);
    h.agent.listen();
    const p = h.say('Kal');
    await flush();
    expect(h.tts.playing).toBe('Kal ke liye 3 trainein mili hain.');   // speaking while the turn is still running
    expect(h.agent.snapshot().state).toBe('SPEAKING');
    h.pending.shift()!();
    await p;
    while (h.tts.playing) { h.tts.finish(); await flush(); }
    expect(h.tts.spoken.map(x => x.text)).toEqual(['Kal ke liye 3 trainein mili hain.', 'Kaunsi chahiye?']);
  });

  it('[8] conversation-mode barge-in: TTS stops immediately, queue dropped, old turn never resumes, new turn is INTERRUPT priority', async () => {
    const h = mkAgent([
      { outcome: { speechText: '12014 ki CC availability Available hai. Kitne passengers hain? Aur kuch?' } },
      { outcome: { speechText: '12497 check kar liya.' } }
    ]);
    h.agent.setConversationMode(true);
    h.agent.listen();
    expect(h.stt.continuous).toBe(true);
    await h.say('availability check karo');
    await flush();
    expect(h.tts.playing).toBe('12014 ki CC availability Available hai.');
    h.stt.push({ kind: 'partial', text: '12014 ki CC availability' });   // echo of our own TTS → ignored
    expect(h.tts.playing).toBe('12014 ki CC availability Available hai.');
    h.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'nahi ruko 12497' });
    expect(h.tts.spoken[0].status).toBe('CANCELLED');                   // stopped mid-sentence
    expect(h.tts.playing).toBeNull();
    expect(h.remote).toEqual(['BARGE_IN']);
    expect(h.agent.snapshot().state).toBe('USER_SPEAKING');
    h.advance(300); h.stt.push({ kind: 'final', text: 'Nahi ruko, 12497 check karo' }, { kind: 'speechEnd' });
    h.advance(400);
    const o2 = await h.agent.tick();
    expect(h.calls[1]).toMatchObject({ text: 'Nahi ruko, 12497 check karo', bargeIn: true, priority: 'INTERRUPT' });
    expect(o2?.responsePriority).toBe('INTERRUPT');
    await flush();
    while (h.tts.playing) { h.tts.finish(); await flush(); }
    const texts = h.tts.spoken.map(x => x.text);
    expect(texts).not.toContain('Kitne passengers hain?');              // the old reply never resumed
    expect(texts[texts.length - 1]).toBe('12497 check kar liya.');
    expect(h.stt.active).toBe(true);                                   // still listening (user-started session)
    h.agent.cancel();                                                  // one tap off
    expect(h.stt.active).toBe(false);
    expect(h.agent.snapshot()).toMatchObject({ conversationMode: false, state: 'IDLE' });
  });

  it('[9] stale protection: a late outcome of an interrupted turn and a non-presentable outcome are never spoken', async () => {
    const h = mkAgent([
      { hold: true, events: [{ type: 'ACKNOWLEDGEMENT', text: 'Ek second, check karta hoon.' } as any], outcome: { speechText: 'OLD answer must not play.' } },
      { outcome: { speechText: 'New answer.' } },
      { events: [{ type: 'SPEECH_SEGMENT', index: 0, text: 'Streamed but stale.' } as any], outcome: { presentable: false, speechText: 'Streamed but stale.' } }
    ]);
    h.agent.listen();
    const p1 = h.say('pehla sawaal');
    await flush();
    expect(h.tts.playing).toBe('Ek second, check karta hoon.');
    h.agent.listen();                                                  // tap while the agent speaks = barge-in
    expect(h.tts.spoken[0].status).toBe('CANCELLED');
    const o2 = await h.say('doosra sawaal');
    expect(o2?.speechText).toBe('New answer.');
    h.pending.shift()!();
    expect(await p1).toBeNull();                                       // discarded locally (superseded)
    while (h.tts.playing) { h.tts.finish(); await flush(); }
    h.agent.listen();
    await h.say('teesra');
    await flush();
    const texts = h.tts.spoken.map(x => x.text);
    expect(texts).not.toContain('OLD answer must not play.');
    expect(h.tts.spoken.find(x => x.text === 'Streamed but stale.')?.status ?? 'CANCELLED').toBe('CANCELLED');
    expect(h.events).toContain('DISCARDED:NOT_PRESENTABLE');
  });

  it('[10] TTS failure → text fallback (reply still delivered); STT failure → typing fallback; mock TTS cancel', async () => {
    const h = mkAgent([{ outcome: { speechText: 'Pehle passenger ka naam?' } }]);
    h.tts.failNext = 1;
    h.agent.listen();
    const o = await h.say('do passenger');
    await flush();
    expect(o?.assistantText).toBe('Pehle passenger ka naam?');
    expect(h.agent.snapshot().textFallback).toBe(true);
    expect(h.events).toContain('TEXT_FALLBACK:TTS_FAILED');
    const h2 = mkAgent();
    h2.agent.listen();
    h2.stt.push({ kind: 'error', code: 'MIC_PERMISSION_DENIED' });
    expect(h2.agent.snapshot()).toMatchObject({ state: 'IDLE', lastError: 'MIC_PERMISSION_DENIED' });
    expect(h2.events).toContain('TEXT_FALLBACK:MIC_PERMISSION_DENIED');
    const noStt = new ConversationalVoiceAgent({ sessionId: 's', processTurn: async () => { throw new Error('x'); }, output: new MockStreamingTTS() });
    noStt.listen();
    expect(noStt.snapshot()).toMatchObject({ sttAvailable: false, lastError: 'STT_UNAVAILABLE' });
    const tts = new MockStreamingTTS();
    const a = tts.speak('one', { lang: 'hi-IN', turnId: 't' }); tts.speak('two', { lang: 'hi-IN', turnId: 't' });
    a.cancel(); tts.finish();
    expect(tts.spoken.map(x => x.status)).toEqual(['CANCELLED', 'DONE']);
  });
});

// ---------------------------------------------------------------- composer
function composerFixture() {
  const state = new ConversationStateManager();
  const s: any = state.createSession();
  Object.assign(s, {
    origin: 'ASR', originName: 'Amritsar Junction', destination: 'NDLS', destinationName: 'New Delhi', date: '2030-01-10',
    bookingState: BookingState.CLASS_OPTIONS,
    selectedTrain: { number: '12014', name: 'Amritsar Shatabdi Express', departure: '04:55', availableClasses: ['CC', '2S'], classes: [{ code: 'CC' }, { code: '2S' }] },
    searchResults: { trains: [{ trainNumber: '12014', departure: '04:55', classes: [{ code: 'CC' }, { code: '2S' }] }, { trainNumber: '12497', departure: '06:35', classes: [{ code: 'SL' }] }] }
  });
  const llm = (text: string | null, o: { stream?: boolean; never?: boolean } = {}) => ({
    providerId: 'stub', generateStructuredDecision: async () => ({ decision: {} as any }),
    generateSpokenResponse: async (i: any) => {
      if (o.never) return new Promise<any>(() => undefined);
      if (text && o.stream) for (const w of text.match(/\S+\s*/g) || []) i.onDelta?.(w);
      return text === null ? null : { text };
    }
  }) as any;
  const base = (over: any = {}) => ({
    session: s, userText: '12014 wali', backendReply: '12014 Amritsar Shatabdi Express select ho gayi. Classes: CC aur 2S. Kaunsi class chahiye?',
    deterministicSpeech: '12014 Amritsar Shatabdi Express select ho gayi. Classes: CC aur 2S. Kaunsi class chahiye?',
    stateBefore: BookingState.SHOWING_TRAINS, reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null,
    steps: [], appliedActions: ['TRAIN_SELECTED'], changes: [], error: null, pendingQuestionCode: 'CLASS', pendingQuestion: 'Kaunsi class chahiye?', history: [], ...over
  });
  return { s, llm, base, c: new NaturalResponseComposer() };
}

describe('P21 G2 — NaturalResponseComposer (LLM wording, backend grounding)', () => {
  it('[11] grounded LLM sentences are spoken (streamed); invented facts / CoT / IVR / booking claims are dropped', async () => {
    const { llm, base, c } = composerFixture();
    const segs: string[] = [];
    const ok = await c.compose({ llm: llm('Haan, 12014 rakh li. CC ya 2S — kaunsi class chahiye?', { stream: true }), ...base(), onSegment: (_i: number, t: string) => segs.push(t) } as any);
    expect(ok).toMatchObject({ source: 'LLM', text: 'Haan, 12014 rakh li. CC ya 2S — kaunsi class chahiye?' });
    expect(segs).toEqual(['Haan, 12014 rakh li.', 'CC ya 2S — kaunsi class chahiye?']);
    const bad = await c.compose({ llm: llm('Haan, 12014 rakh li. 99999 bhi achhi hai. Fare ₹777 hoga. 3A bhi le sakte ho. Seats available hain. Ticket book ho gaya. Let me think step by step. Your request has been processed.'), ...base() } as any);
    expect(bad.source).toBe('LLM');
    expect(bad.text).toBe('Haan, 12014 rakh li. Kaunsi class chahiye?');      // pending question guaranteed
    const why = bad.rejected.map(r => r.reason.split(':')[0]);
    for (const r of ['UNGROUNDED_NUMBER', 'UNGROUNDED_CLASS', 'UNVERIFIED_AVAILABILITY', 'BOOKING_SUCCESS_CLAIM', 'CHAIN_OF_THOUGHT', 'ROBOTIC_PHRASING']) expect(why).toContain(r);
    expect(bad.text).not.toMatch(/99999|777|3A|book ho gaya/);
  });

  it('[12] deterministic fallback: no capability, timeout, nothing grounded, sensitive turn, missing not-booked disclaimer', async () => {
    const { s, llm, base, c } = composerFixture();
    const det = base().deterministicSpeech;
    expect(await c.compose({ llm: { providerId: 'x', generateStructuredDecision: async () => ({}) } as any, ...base() } as any)).toMatchObject({ source: 'FALLBACK', fallbackReason: 'PROVIDER_NO_SPOKEN_RESPONSE', text: det });
    expect(await c.compose({ llm: llm('x', { never: true }), ...base(), timeoutMs: 20 } as any)).toMatchObject({ source: 'FALLBACK', fallbackReason: 'TIMEOUT', text: det });
    expect(await c.compose({ llm: llm('55555 select ho gayi.'), ...base() } as any)).toMatchObject({ source: 'FALLBACK', fallbackReason: 'NOTHING_GROUNDED' });
    expect(await c.compose({ llm: llm('Haan, 12014.'), ...base(), sensitive: true } as any)).toMatchObject({ source: 'FALLBACK', fallbackReason: 'SENSITIVE_TURN' });
    s.bookingState = BookingState.IRCTC_HANDOFF_READY;
    const conf = await c.compose({ llm: llm('Sab ho gaya, details confirm.'), ...base({ backendReply: 'Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.', deterministicSpeech: 'Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.', stateBefore: BookingState.AWAITING_CONFIRMATION, pendingQuestion: null, pendingQuestionCode: null }) } as any);
    expect(conf).toMatchObject({ source: 'FALLBACK', fallbackReason: 'MISSING_NOT_BOOKED_DISCLAIMER' });
  });
});

// ---------------------------------------------------------------- real provider adapter (offline: injected fetch)
function sseBody(chunks: string[]) {
  const enc = new TextEncoder();
  let i = 0;
  return { getReader: () => ({ read: async () => (i < chunks.length ? { value: enc.encode(chunks[i++]), done: false } : { value: undefined, done: true }) }) };
}

describe('P21 G2 — OpenAI-compatible provider + env factory', () => {
  it('[13] streams spoken deltas (SSE); decision JSON → approved tools only; HTTP failure → normalized error (no hidden fallback); key never leaks', async () => {
    const KEY = 'sk-test-SECRET-123';
    const seen: any[] = [];
    let mode: 'sse' | 'json' | 'fail' = 'sse';
    const f = async (url: string, init: any) => {
      seen.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      if (mode === 'fail') return { ok: false, status: 503, json: async () => ({}), text: async () => `upstream down ${KEY}` };
      if (mode === 'json') return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: JSON.stringify({ intent: 'SEARCH_TRAINS', action: 'SEARCH_TRAINS', entities: { dateRaw: 'kal' }, confidence: 0.9, acknowledgement: 'Ek second, trains dekh raha hoon.', toolCalls: [{ name: 'SEARCH_TRAINS', arguments: { origin: 'ASR' } }, { name: 'BOOK_TICKET_NOW', arguments: {} }] }) } }] }) };
      return { ok: true, status: 200, text: async () => '', json: async () => ({}), body: sseBody(['data: {"choices":[{"delta":{"content":"Kal ke liye "}}]}\n', 'data: {"choices":[{"delta":{"content":"3 trainein mili hain."}}]}\n\ndata: [DONE]\n']) };
    };
    const p = new OpenAICompatibleLLMProvider({ toolMode: 'json', apiKey: KEY, baseUrl: 'https://llm.example.test/v1/', model: 'test-model', timeoutMs: 2000, fetch: f as any });
    const state = new ConversationStateManager();
    const s: any = state.createSession();
    const deltas: string[] = [];
    const out = await p.generateSpokenResponse({ userText: 'kal', inputMode: 'VOICE', language: 'HINGLISH', session: s, stateBefore: s.bookingState, reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null, pendingQuestion: null, pendingQuestionCode: null, backendReply: 'x', toolResults: [], appliedActions: [], changes: [], error: null, history: [], onDelta: d => deltas.push(d) });
    expect(deltas).toEqual(['Kal ke liye ', '3 trainein mili hain.']);
    expect(out?.text).toBe('Kal ke liye 3 trainein mili hain.');
    expect(seen[0]).toMatchObject({ url: 'https://llm.example.test/v1/chat/completions', auth: `Bearer ${KEY}` });
    expect(seen[0].body).toMatchObject({ model: 'test-model', stream: true });
    mode = 'json';
    const input: any = { userText: 'kal', history: [], state: s.bookingState, session: s, missingFields: [], inputMode: 'VOICE', tools: REGISTERED_TOOLS };
    const d = (await p.generateStructuredDecision(input)).decision;
    expect(d.toolCalls.map(t => t.name)).toEqual(['SEARCH_TRAINS']);  // unknown tool dropped (validators run downstream)
    expect(d.acknowledgement).toBe('Ek second, trains dekh raha hoon.');
    mode = 'fail';
    const fb = await p.generateStructuredDecision(input).catch((e: any) => e);
    expect(fb).toMatchObject({ name: 'LLMProviderError', code: 'LLM_HTTP_ERROR', status: 503 });   // Prompt 22: never a silent mock decision
    expect(p.failedDecisions).toBe(1);
    const err = await p.generateSpokenResponse({ ...(input as any), language: 'HINGLISH', backendReply: 'x', toolResults: [], appliedActions: [], changes: [], error: null, pendingQuestion: null, pendingQuestionCode: null, stateBefore: s.bookingState, reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null }).catch((e: any) => e);
    expect(String(err?.message)).toBe('LLM_HTTP_ERROR:503');
    expect(String(err?.message)).not.toContain(KEY);
    expect(fetchSpy).not.toHaveBeenCalled();                            // only the injected fetch was used
  });

  it('[14] factory: mock by default; incomplete / unknown config fails closed (Prompt 23: never a silent mock); info never contains the key', () => {
    expect(createLLMProvider({}).info).toMatchObject({ providerId: 'mock-llm', reason: 'DEFAULT_MOCK' });
    expect(createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_MODEL: 'm' }).info).toMatchObject({ providerId: 'llm-unavailable', configured: false, reason: 'MISSING_LLM_API_KEY' });
    expect(createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'k' }).info.reason).toBe('MISSING_LLM_MODEL');
    expect(createLLMProvider({ LLM_PROVIDER: 'something-else' }).info.reason).toBe('UNKNOWN_LLM_PROVIDER');
    expect(createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'k', LLM_MODEL: 'm', LLM_BASE_URL: 'ftp://x' }).info.reason).toBe('INVALID_LLM_BASE_URL');
    const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-live-VERYSECRET', LLM_MODEL: 'gpt-x', LLM_TIMEOUT_MS: '5000' });
    expect(sel.info).toEqual({ providerId: 'openai-compatible', model: 'gpt-x', configured: true, reason: 'ENV_CONFIGURED' });
    expect(JSON.stringify(sel.info)).not.toContain('VERYSECRET');
    expect(typeof sel.provider.generateSpokenResponse).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();                            // construction never calls the network
  });
});
