/**
 * PROMPT 34 — G2: voice production hardening (unit + security).
 *   structured STT transcript boundary · turn detection never submits interim speech · Conversation Mode opt-in ·
 *   barge-in (stop now, stale never resumed) · TTS failure recovery without a new turn · per-turn voice metrics ·
 *   composer emits ONLY final validated segments (§7) · engine transcript gate + voiceTurn observability · secrets.
 * Offline + deterministic: no microphone, no audio, no network, no real LLM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeTranscriptEvent, sanitizeTranscriptInfo, checkTranscriptForTurn, isUncertainConfidence, MIN_FINAL_CONFIDENCE, VoiceTranscriptRejectedError
} from '../../shared/voice/transcript';
import { VoiceTurnDetector } from '../../shared/voice/voice-turn-detector';
import { redactForSpeech, segmentForSpeech } from '../../shared/voice/voice-response-policy';
import { ConversationalVoiceAgent, type TurnProcessor, type VoiceTurnOutcome, type VoiceAgentEvent } from '../../shared/voice/conversational-voice-agent';
import { MockStreamingSTT } from '../../server/voice/stt/stt-provider';
import { MockStreamingTTS } from '../../server/voice/tts/tts-provider';
import { NaturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { MAX_TOOL_STEPS_PER_TURN } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { BookingState } from '../../shared/states';

const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const SECRET = 'sk-live-P34-UNIT-SECRET-343434';

let fetchSpy: any;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { vi.restoreAllMocks(); });

// ---------------------------------------------------------------- agent harness (scripted turn processor)
function mkAgent(o: { hold?: boolean; speech?: (k: number) => string; segments?: (k: number) => string[] } = {}) {
  let now = 1000;
  const stt = new MockStreamingSTT();
  const tts = new MockStreamingTTS();
  const calls: Array<{ text: string; bargeIn: boolean; transcript: any }> = [];
  const pending: Array<() => void> = [];
  let n = 0;
  const proc: TurnProcessor = async (text, x) => {
    const k = n++;
    calls.push({ text, bargeIn: x.bargeIn, transcript: x.transcript });
    const turnId = `t${k + 1}`, sequence = k + 1;
    x.onEvent({ type: 'TURN_STARTED', turnId, sequence });
    if (o.hold) await new Promise<void>(r => pending.push(r));
    const speech = o.speech?.(k) ?? `Reply ${k + 1}. Aur kuch chahiye?`;
    return { sessionId: 's1', turnId, sequence, presentable: true, assistantText: speech, speechText: speech, segments: o.segments?.(k) ?? segmentForSpeech(speech), shouldSpeak: true, interruptible: true, responsePriority: x.priority } as VoiceTurnOutcome;
  };
  const agent = new ConversationalVoiceAgent({ sessionId: 's1', processTurn: proc, output: tts, input: stt, now: () => now });
  const events: VoiceAgentEvent[] = [];
  agent.on(e => events.push(e));
  return { agent, stt, tts, calls, pending, events, advance: (ms: number) => { now += ms; }, at: () => now };
}

describe('P34 G2 — STT transcript boundary (§2) + turn detection (§3)', () => {
  it('[1] structured transcript: text / interim-final / confidence / language / identity; untrusted metadata sanitized; no free text', () => {
    const ev = makeTranscriptEvent({ utteranceId: 'u1-abc', sessionId: 's1', text: ' 12014 ki CC ', isFinal: true, meta: { confidence: 0.913, language: 'hi-IN' }, now: 5 });
    expect(ev).toEqual({ utteranceId: 'u1-abc', sessionId: 's1', text: '12014 ki CC', status: 'FINAL', confidence: 0.91, languageHint: 'hi-IN', receivedAt: 5 });
    expect(makeTranscriptEvent({ utteranceId: 'u', sessionId: 's', text: 'kal', isFinal: false, meta: { confidence: 0, language: '<script>' }, now: 1 }))
      .toMatchObject({ status: 'INTERIM', confidence: null, languageHint: null });       // 0 = unknown, junk language dropped
    expect(isUncertainConfidence(0.2)).toBe(true);
    expect(isUncertainConfidence(0)).toBe(false);                                        // unknown ≠ uncertain
    expect(isUncertainConfidence(MIN_FINAL_CONFIDENCE)).toBe(false);
    const clean = sanitizeTranscriptInfo({ status: 'FINAL', confidence: 0.876, languageHint: 'en-IN', sttDurationMs: 812.4, utteranceId: 'u3-x', text: 'IGNORED', password: 'x' });
    expect(clean).toEqual({ status: 'FINAL', confidence: 0.88, languageHint: 'en-IN', sttDurationMs: 812, utteranceId: 'u3-x' });
    expect(sanitizeTranscriptInfo({ status: 'MAYBE' })).toBeUndefined();
    expect(sanitizeTranscriptInfo({ status: 'FINAL', confidence: 7, languageHint: 'x'.repeat(40), sttDurationMs: -1, utteranceId: 'a b' }))
      .toEqual({ status: 'FINAL', confidence: null, languageHint: null, sttDurationMs: null, utteranceId: null });
    expect(checkTranscriptForTurn('kal jaana', { status: 'INTERIM' })).toEqual({ ok: false, code: 'TRANSCRIPT_NOT_FINAL' });
    expect(checkTranscriptForTurn('   ', { status: 'FINAL' })).toEqual({ ok: false, code: 'TRANSCRIPT_EMPTY' });
    expect(checkTranscriptForTurn('kal jaana', { status: 'FINAL' })).toEqual({ ok: true });
  });

  it('[2] detector: interim-only speech is never USER_FINISHED — it waits, then gives up honestly (INCOMPLETE, nothing submitted)', () => {
    const d = new VoiceTurnDetector();
    d.speechStart(0); d.partialTranscript('kal amritsar se', 100); d.speechEnd(200);
    for (const t of [500, 900, 1400, 2100]) expect(d.evaluate(t).status).toBe('USER_PAUSED');
    expect(d.evaluate(2200)).toMatchObject({ status: 'INCOMPLETE', reason: 'NO_FINAL_TRANSCRIPT', finalTranscript: null });
    const f = new VoiceTurnDetector();                                    // final + an unfinalized interim tail → wait
    f.speechStart(0); f.finalTranscript('Kal Amritsar se', 100); f.partialTranscript('Delhi', 300); f.speechEnd(400);
    expect(f.evaluate(1000)).toMatchObject({ status: 'USER_PAUSED', reason: 'WAITING_FOR_FINAL' });
    f.finalTranscript('Delhi', 1100);
    expect(f.evaluate(1500)).toMatchObject({ status: 'USER_FINISHED', finalTranscript: 'Kal Amritsar se Delhi' });
    const g = new VoiceTurnDetector();                                    // adaptive: complete final + short silence
    g.speechStart(0); g.finalTranscript('12014 ki CC availability', 100); g.speechEnd(150);
    expect(g.evaluate(520).status).toBe('USER_FINISHED');                // no long fixed timeout
  });

  it('[3] agent: interim never reaches the agent; the FINAL is handed over verbatim with structured transcript metadata', async () => {
    const h = mkAgent();
    h.agent.listen();
    h.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'कल अमृतसर से', confidence: 0.6, language: 'hi-IN' });
    h.advance(5000);
    expect(h.agent.tick()).toBeNull();                                    // INCOMPLETE → dropped, never submitted
    expect(h.calls).toHaveLength(0);
    expect(h.events.some(e => e.type === 'TRANSCRIPT_INCOMPLETE')).toBe(true);
    expect(h.agent.snapshot().lastError).toBe('TRANSCRIPT_INCOMPLETE');
    expect(h.agent.snapshot().listening).toBe(false);                    // tap mode: mic closed, nothing in background
    h.agent.listen();
    h.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'कल अमृतसर', confidence: 0.5, language: 'hi-IN' });
    h.advance(300);
    h.stt.push({ kind: 'final', text: 'कल अमृतसर से दिल्ली जाना है', confidence: 0.82, language: 'hi-IN' }, { kind: 'speechEnd' });
    h.advance(400);
    const p = h.agent.tick();
    expect(p).not.toBeNull();
    await p;
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].text).toBe('कल अमृतसर से दिल्ली जाना है');           // words preserved (no translation / invention)
    expect(h.calls[0].transcript).toMatchObject({ status: 'FINAL', confidence: 0.82, languageHint: 'hi-IN', sttDurationMs: 700 });
    expect(h.calls[0].transcript.utteranceId).toMatch(/^[A-Za-z0-9_-]+$/);
    const tx = h.events.filter(e => e.type === 'TRANSCRIPT').map((e: any) => e.transcript.status);
    expect(tx).toEqual(['INTERIM', 'INTERIM', 'FINAL']);
  });

  it('[4] a low-confidence final is UNCERTAIN → the agent waits; it never submits or completes guessed words', async () => {
    const h = mkAgent();
    h.agent.listen();
    h.stt.push({ kind: 'speechStart' }, { kind: 'final', text: 'barah zero', confidence: 0.12 }, { kind: 'speechEnd' });
    h.advance(1000);
    expect(h.agent.tick()).toBeNull();
    expect(h.events.some(e => e.type === 'TRANSCRIPT_UNCERTAIN')).toBe(true);
    h.stt.push({ kind: 'speechStart' }, { kind: 'final', text: '12014 ki CC', confidence: 0.9 }, { kind: 'speechEnd' });
    h.advance(500);
    await h.agent.tick();
    expect(h.calls.map(c => c.text)).toEqual(['12014 ki CC']);           // only the confident words, nothing added
  });

  it('[5] numbers / stations / classes / dates survive STT normalization unchanged in meaning (Hinglish + English)', async () => {
    const h = mkAgent();
    for (const [said, expected] of [['ek do zero ek chaar ki three a availability kal', '12014 ki 3A availability kal'], ['12497 sleeper class on 5 October', '12497 SL on 5 October']]) {
      h.agent.listen();
      h.stt.push({ kind: 'speechStart' }, { kind: 'final', text: said }, { kind: 'speechEnd' });
      h.advance(2100);
      await h.agent.tick();
      expect(h.calls[h.calls.length - 1].text).toBe(expected);
      h.tts.finish(); await flush();
    }
  });
});

describe('P34 G2 — Conversation Mode opt-in (§4), STT failure (§15)', () => {
  it('[6] default is tap-to-talk; mic is off until the user acts; no background listening; one tap stops conversation mode', () => {
    const h = mkAgent();
    expect(h.agent.snapshot()).toMatchObject({ conversationMode: false, listening: false });
    expect(h.stt.startCount).toBe(0);
    h.stt.push({ kind: 'speechStart' }, { kind: 'final', text: 'kal delhi' }, { kind: 'speechEnd' });   // mic closed → ignored
    h.advance(3000);
    expect(h.agent.tick()).toBeNull();
    expect(h.calls).toHaveLength(0);
    h.agent.listen();
    expect(h.stt.continuous).toBe(false);                                // tap: one utterance
    h.agent.cancel();
    h.agent.setConversationMode(true);
    expect(h.agent.snapshot().listening).toBe(false);                    // enabling the mode does not open the mic by itself
    h.agent.listen();
    expect(h.stt.continuous).toBe(true);
    h.agent.setConversationMode(false);                                  // one tap → off, mic closed
    expect(h.agent.snapshot()).toMatchObject({ conversationMode: false, listening: false });
  });

  it('[7] STT failure → text fallback; no invented transcript, no agent turn, typing still available', async () => {
    const h = mkAgent();
    h.agent.listen();
    h.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'kal' }, { kind: 'error', code: 'network' });
    h.advance(3000);
    h.agent.tick();
    expect(h.calls).toHaveLength(0);
    expect(h.events.some(e => e.type === 'TEXT_FALLBACK')).toBe(true);    // STT fallback signal (snapshot.textFallback = TTS)
    expect(h.agent.snapshot()).toMatchObject({ lastError: 'network', listening: false, partialTranscript: '' });
    await h.agent.processTurn('Kal Amritsar se Delhi', { normalize: false });   // typed input still works in the same session
    expect(h.calls.map(c => c.text)).toEqual(['Kal Amritsar se Delhi']);
    expect(h.calls[0].transcript).toBeUndefined();                       // typed ≠ STT
    expect(h.agent.voiceMetrics().slice(-1)[0]).toMatchObject({ inputSource: 'TYPED', transcriptStatus: null });
  });
});

describe('P34 G2 — barge-in / stale (§5, §6), TTS boundary (§7, §15), metrics (§17)', () => {
  it('[8] barge-in stops TTS immediately; the old response is stale (never resumed / re-spoken); the new speech is a new turn', async () => {
    const h = mkAgent();
    h.agent.setConversationMode(true); h.agent.listen();
    h.stt.push({ kind: 'speechStart' }, { kind: 'final', text: '12014 ki CC availability' }, { kind: 'speechEnd' });
    h.advance(500); await h.agent.tick();
    expect(h.tts.playing).toMatch(/Reply 1/);
    h.stt.push({ kind: 'speechStart' }, { kind: 'partial', text: 'ruko ruko' });
    expect(h.tts.playing).toBeNull();                                    // cancelled on the partial, before any final
    expect(h.tts.spoken.filter(x => x.turnId === 't1').map(x => x.status)).toEqual(['CANCELLED']);
    expect(h.agent.retrySpeech()).toBe(false);                           // stale → cannot be resumed
    h.tts.finish(); await flush();
    expect(h.tts.spoken.filter(x => x.turnId === 't1').map(x => x.text)).toEqual(['Reply 1.']);   // remaining old segment never spoken
    h.stt.push({ kind: 'final', text: 'parso ka dekho' }, { kind: 'speechEnd' });
    h.advance(500); await h.agent.tick();
    expect(h.calls.map(c => [c.text, c.bargeIn])).toEqual([['12014 ki CC availability', false], ['parso ka dekho', true]]);
    const m = h.agent.voiceMetrics();
    expect(m[0]).toMatchObject({ turnId: 't1', interrupted: true, stale: true, tts: 'CANCELLED' });
    expect(m[1]).toMatchObject({ turnId: 't2', interrupted: false, stale: false });
  });

  it('[9] TTS failure: text stays, no new turn / LLM / tool; retrySpeech re-speaks the SAME validated text once', async () => {
    const h = mkAgent();
    h.tts.failNext = 1;
    await h.agent.processTurn('12014 ki CC', { normalize: false });
    await flush();
    expect(h.agent.snapshot()).toMatchObject({ textFallback: true });
    expect(h.calls).toHaveLength(1);
    expect(h.agent.voiceMetrics()[0].tts).toBe('FAILED');
    expect(h.agent.retrySpeech()).toBe(true);
    expect(h.calls).toHaveLength(1);                                     // no new agent turn (no LLM / tool call)
    expect(h.tts.playing).toBe('Reply 1.');
    h.tts.finish(); await flush(); h.tts.finish(); await flush();
    expect(h.tts.spoken.filter(x => x.status === 'DONE').map(x => x.text)).toEqual(['Reply 1.', 'Aur kuch chahiye?']);
    expect(h.agent.voiceMetrics()[0]).toMatchObject({ tts: 'SPOKEN', speechRetries: 1, segmentsSpoken: 2 });
    expect(h.agent.snapshot().textFallback).toBe(false);
  });

  it('[10] TTS receives exactly the final validated segments (identical text); credential-shaped tokens are masked at the boundary', async () => {
    const segs = ['12497 mein 3A ka fare ₹650 hai.', 'Book karna hai?'];
    const h = mkAgent({ speech: () => segs.join(' '), segments: () => segs });
    await h.agent.processTurn('fare', { normalize: false });
    h.tts.finish(); await flush(); h.tts.finish(); await flush();
    expect(h.tts.spoken.map(x => x.text)).toEqual(segs);
    expect(h.tts.spoken.map(x => x.text).join(' ')).toBe(segs.join(' '));
    expect(redactForSpeech('12497 ka fare ₹650 hai.')).toBe('12497 ka fare ₹650 hai.');
    expect(redactForSpeech(`key ${SECRET} and nvapi-abcdefghijklmnop and Bearer abc.def.ghi-jkl0123`)).toBe('key [redacted] and [redacted] and [redacted]');
    const leak = mkAgent({ speech: () => `Token ${SECRET} hai.`, segments: () => [`Token ${SECRET} hai.`] });
    await leak.agent.processTurn('x', { normalize: false });
    expect(leak.tts.playing).toBe('Token [redacted] hai.');
  });

  it('[11] voice metrics: STT duration / transcript status / latency / TTS latency / interruption — statuses and timings only, no text, bounded', async () => {
    const h = mkAgent();
    h.agent.listen();
    h.stt.push({ kind: 'speechStart' }, { kind: 'final', text: `12014 ki CC ${SECRET}`, confidence: 0.77, language: 'en-IN' }, { kind: 'speechEnd' });
    h.advance(450); await h.agent.tick(); await flush();
    const m = h.agent.voiceMetrics()[0];
    expect(m).toMatchObject({ inputSource: 'SPEECH', transcriptStatus: 'FINAL', transcriptConfidence: 0.77, languageHint: 'en-IN', sttDurationMs: 450, turnId: 't1', tts: 'PENDING', segmentsQueued: 2, interrupted: false, stale: false });
    expect(m.turnLatencyMs).toBeGreaterThanOrEqual(0);
    expect(m.ttsLatencyMs).toBeGreaterThanOrEqual(0);
    const blob = JSON.stringify(h.agent.voiceMetrics());
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toMatch(/12014|Reply/);                             // no transcript / response text
    for (let i = 0; i < 30; i++) { await h.agent.processTurn(`q${i}`, { normalize: false }); h.tts.finish(); }
    expect(h.agent.voiceMetrics().length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------- §7: the composer never streams a sentence the final guard later drops
function composerFixture() {
  const state = new ConversationStateManager();
  const s: any = state.createSession();
  Object.assign(s, {
    origin: 'ASR', originName: 'Amritsar Junction', destination: 'NDLS', destinationName: 'New Delhi', date: '2030-01-10',
    bookingState: BookingState.CLASS_OPTIONS,
    selectedTrain: { number: '12014', name: 'Amritsar Shatabdi Express', departure: '04:55', availableClasses: ['CC', '2S'], classes: [{ code: 'CC' }, { code: '2S' }] },
    searchResults: { trains: [{ trainNumber: '12014', departure: '04:55', classes: [{ code: 'CC' }, { code: '2S' }] }, { trainNumber: '12497', departure: '06:35', classes: [{ code: 'SL' }] }] }
  });
  const llm = (text: string) => ({
    providerId: 'stub', generateStructuredDecision: async () => ({ decision: {} as any }),
    generateSpokenResponse: async (i: any) => { for (const w of text.match(/\S+\s*/g) || []) i.onDelta?.(w); return { text }; }
  }) as any;
  const base = (over: any = {}) => ({
    session: s, userText: '12014 wali', backendReply: '12014 Amritsar Shatabdi Express select ho gayi. Classes: CC aur 2S. Kaunsi class chahiye?',
    deterministicSpeech: '12014 Amritsar Shatabdi Express select ho gayi. Classes: CC aur 2S. Kaunsi class chahiye?',
    stateBefore: BookingState.SHOWING_TRAINS, reviewVersionBefore: null, selectedTrainBefore: null, selectedClassBefore: null, passengersCountBefore: null,
    steps: [], appliedActions: ['TRAIN_SELECTED'], changes: [], error: null, pendingQuestionCode: 'CLASS', pendingQuestion: 'Kaunsi class chahiye?', history: [], ...over
  });
  return { s, llm, base, c: new NaturalResponseComposer() };
}

describe('P34 G2 — composer emits only the FINAL validated segments (§7)', () => {
  it('[12] a streamed LLM sentence that the final guard rejects is never handed to TTS; success → segments emitted once', async () => {
    const { s, llm, base, c } = composerFixture();
    s.bookingState = BookingState.IRCTC_HANDOFF_READY;                    // final guard: not-booked disclaimer required
    const segs: string[] = [];
    const r = await c.compose({ llm: llm('Sab ho gaya, details confirm. Kuch aur?'), ...base({ backendReply: 'Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.', deterministicSpeech: 'Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.' }), onSegment: (_i: number, t: string) => segs.push(t) } as any);
    expect(r).toMatchObject({ source: 'FALLBACK', fallbackReason: 'MISSING_NOT_BOOKED_DISCLAIMER' });
    expect(segs.join(' ')).not.toMatch(/Sab ho gaya/);                   // pre-P34 this sentence was streamed to TTS first
    expect(segs).toEqual(r.segments);
    s.bookingState = BookingState.CLASS_OPTIONS;
    const ok: string[] = [];
    const g = await c.compose({ llm: llm('Haan, 12014 rakh li. CC ya 2S — kaunsi class chahiye?'), ...base(), onSegment: (_i: number, t: string) => ok.push(t) } as any);
    expect(g.source).toBe('LLM');
    expect(ok).toEqual(g.segments);
    expect(ok.join(' ')).toBe(g.text);
  });
});

// ---------------------------------------------------------------- engine boundary
function engine() {
  const state = new ConversationStateManager();
  const llm = new MockLLMProvider({});
  const decide = vi.spyOn(llm as any, 'generateStructuredDecision');
  const orch = new ConversationAgentOrchestrator(llm, state, new RailwayToolService());
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { state, eng, sid, decide, turns: () => ((eng as any).turns.get(sid) || []).length };
}

describe('P34 G2 — engine transcript gate + voiceTurn observability (§3, §17, §16)', () => {
  it('[13] an interim / empty STT transcript is refused BEFORE a turn exists: no LLM, no tool, no state change, no interruption', async () => {
    const e = engine();
    const v0 = (e.state.getSession(e.sid) as any).sessionVersion;
    await expect(e.eng.processTurn(e.sid, 'kal amritsar se', 'VOICE', { transcript: { status: 'INTERIM' } })).rejects.toBeInstanceOf(VoiceTranscriptRejectedError);
    await expect(e.eng.processTurn(e.sid, '  ', 'VOICE', { transcript: { status: 'FINAL' } })).rejects.toMatchObject({ code: 'TRANSCRIPT_EMPTY' });
    expect(e.turns()).toBe(0);
    expect(e.decide).not.toHaveBeenCalled();
    expect((e.state.getSession(e.sid) as any).sessionVersion).toBe(v0);
  });

  it('[14] a FINAL voice turn = one normal agent turn + a safe voiceTurn record (no text, no secrets); TEXT turns get none', async () => {
    const e = engine();
    const r: any = await e.eng.processTurn(e.sid, `Kal Amritsar se Delhi jaana hai ${SECRET}`, 'VOICE', { transcript: { status: 'FINAL', confidence: 0.9, languageHint: 'hi-IN', sttDurationMs: 640, utteranceId: 'u1-z' } });
    expect(e.turns()).toBe(1);
    expect(r.turnLog.voiceTurn).toMatchObject({ turnId: r.turn.turnId, sessionId: e.sid, mode: 'VOICE', inputSource: 'STT', transcriptStatus: 'FINAL', transcriptConfidence: 0.9, languageHint: 'hi-IN', sttDurationMs: 640, bargeIn: false, stale: false, interrupted: false });
    for (const k of ['llmLatencyMs', 'llmCallCount', 'toolCount', 'providerCalls', 'finalStatus', 'failureCategory', 'speechSegments', 'totalTurnLatencyMs']) expect(r.turnLog.voiceTurn).toHaveProperty(k);
    const blob = JSON.stringify(r.turnLog.voiceTurn);
    expect(blob).not.toContain(SECRET);
    expect(blob).not.toMatch(/Amritsar|Delhi/);
    const t: any = await e.eng.processTurn(e.sid, 'Kal Amritsar se Delhi jaana hai', 'TEXT');
    expect(t.turnLog.voiceTurn).toBeUndefined();
  });

  it('[15] efficiency constants unchanged: MAX_TOOL_STEPS_PER_TURN = 8; one voice turn = one engine turn', () => {
    expect(MAX_TOOL_STEPS_PER_TURN).toBe(8);
  });
});
