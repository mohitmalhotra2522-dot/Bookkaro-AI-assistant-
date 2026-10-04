/**
 * P36-C.1.1 — G2: focused voice-layer checks (offline, deterministic: no network, no microphone, no audio).
 *   A. STT capability detection + transport choice + device→enhanced fallback + final transcript + stale protection
 *   B. Voice response layer: VOICE speech concise (sentence SELECTION) while TEXT is unchanged; facts never altered
 *   C. TTS boundary: the speech engine receives only the checked, rendered text; credentials / ids / JSON never spoken
 *   D. Barge-in never resumes; TTS failure → text stays, no new turn, retrySpeech replays the SAME reply
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationalVoiceAgent, type TurnProcessor, type VoiceTurnOutcome } from '../../shared/voice/conversational-voice-agent';
import { redactForSpeech, segmentForSpeech } from '../../shared/voice/voice-response-policy';
import { conciseForVoice, renderForSpeech, digitFacts, maskCredentials } from '../../shared/voice/speech-renderer';
import { speechOf } from '../../server/ai/conversation/assistant-response';
import { MockStreamingSTT } from '../../server/voice/stt/stt-provider';
import { BrowserSpeechOutput } from '../../src/voice/browser-voice-adapters';
import {
  BatchSttSpeechInput, HybridSpeechInput, chooseSttTransport, detectBrowserStt, type PcmRecorder, type TranscribeResult
} from '../../src/voice/batch-speech-input';

const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

let fetchSpy: any;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { fetchSpy.mockRestore(); });

// ---------------------------------------------------------------- STT fakes
class FakeRecorder implements PcmRecorder {
  async start() { /* mic open */ }
  async stop() { return { audio: new Uint8Array(3200), durationMs: 100 }; }
  abort() { /* mic released */ }
}
function mkBatch(transcribe: (signal: AbortSignal) => Promise<TranscribeResult>) {
  const b = new BatchSttSpeechInput({ sessionId: () => 's1', createRecorder: () => new FakeRecorder(), recorderSupported: () => true, transcribe: (_r, s) => transcribe(s) });
  b.setEnabled(true);
  return b;
}
const handlers = () => {
  const got = { finals: [] as string[], errors: [] as string[] };
  return { got, h: { onSpeechStart() {}, onSpeechEnd() {}, onPartial() {}, onFinal(t: string) { got.finals.push(t); }, onError(c: string) { got.errors.push(c); } } };
};

describe('P36-C.1.1 A — STT capability, choice, fallback, final transcript, stale protection', () => {
  it('[1] browser STT capability detection: API presence + secure context (existence only)', () => {
    expect(detectBrowserStt(null)).toEqual({ supported: false, api: null, secureContext: false });
    expect(detectBrowserStt({ isSecureContext: true })).toMatchObject({ supported: false, api: null });
    expect(detectBrowserStt({ isSecureContext: true, webkitSpeechRecognition: function () {} })).toEqual({ supported: true, api: 'webkitSpeechRecognition', secureContext: true });
    expect(detectBrowserStt({ isSecureContext: true, SpeechRecognition: function () {}, webkitSpeechRecognition: function () {} }).api).toBe('SpeechRecognition');
    expect(detectBrowserStt({ isSecureContext: false, SpeechRecognition: function () {} }).supported).toBe(false);
  });

  it('[2] transport choice: enhanced primary by default; device-first opt-in; unhealthy device → enhanced; hands-free → device', () => {
    const base = { continuous: false, preference: 'ENHANCED_FIRST' as const, batchAvailable: true, browserAvailable: true, browserHealthy: true };
    expect(chooseSttTransport(base)).toBe('BATCH');
    expect(chooseSttTransport({ ...base, batchAvailable: false })).toBe('BROWSER');
    expect(chooseSttTransport({ ...base, batchAvailable: false, browserAvailable: false })).toBeNull();
    expect(chooseSttTransport({ ...base, preference: 'DEVICE_FIRST' })).toBe('BROWSER');
    expect(chooseSttTransport({ ...base, preference: 'DEVICE_FIRST', browserHealthy: false })).toBe('BATCH');
    expect(chooseSttTransport({ ...base, preference: 'DEVICE_FIRST', browserAvailable: false })).toBe('BATCH');
    expect(chooseSttTransport({ ...base, preference: 'DEVICE_FIRST', browserHealthy: false, batchAvailable: false })).toBe('BROWSER');
    expect(chooseSttTransport({ ...base, continuous: true })).toBe('BROWSER');
    expect(chooseSttTransport({ ...base, continuous: true, browserAvailable: false })).toBeNull();
  });

  it('[3] device recognition error → error surfaced once, next tap uses enhanced; permission denial does not flip it', () => {
    const browser = new MockStreamingSTT();
    const hy = new HybridSpeechInput(mkBatch(async () => ({ ok: true, transcript: 'x' })), browser);
    const sources: Array<string | null> = [];
    hy.onSource(s => sources.push(s));
    hy.setPreference('DEVICE_FIRST');
    const a = handlers();
    hy.start(a.h, { continuous: false, lang: 'hi-IN' });
    expect(hy.source).toBe('DEVICE');
    browser.push({ kind: 'error', code: 'MIC_PERMISSION_DENIED' } as any);
    expect(hy.browserHealthy).toBe(true);                                 // user-level; not a device-recogniser fault
    hy.start(a.h, { continuous: false, lang: 'hi-IN' });
    browser.push({ kind: 'error', code: 'STT_ERROR' } as any);
    expect(a.got.errors).toEqual(['MIC_PERMISSION_DENIED', 'STT_ERROR']);  // surfaced (short UI message), no resubmission
    expect(hy.browserHealthy).toBe(false);
    hy.start(a.h, { continuous: false, lang: 'hi-IN' });
    expect(hy.source).toBe('ENHANCED');                                   // fallback on the next turn
    expect(hy.batch.currentPhase).toBe('RECORDING');
    expect(sources).toEqual(['DEVICE', 'DEVICE', 'ENHANCED']);
    hy.setPreference('DEVICE_FIRST');                                     // re-selecting resets health
    expect(hy.browserHealthy).toBe(true);
    hy.stop();
  });

  it('[4] device-first final transcript goes to the SAME agent → processTurn once (same /api/chat pipeline)', async () => {
    let now = 1000;
    const browser = new MockStreamingSTT();
    const hy = new HybridSpeechInput(mkBatch(async () => ({ ok: true, transcript: 'unused' })), browser);
    hy.setPreference('DEVICE_FIRST');
    const calls: string[] = [];
    const proc: TurnProcessor = async (text, o) => {
      calls.push(text);
      o.onEvent({ type: 'TURN_STARTED', turnId: 't1', sequence: 1 });
      return { sessionId: 's1', turnId: 't1', sequence: 1, presentable: true, assistantText: 'Theek hai.', speechText: 'Theek hai.', segments: [], shouldSpeak: false, interruptible: true, responsePriority: o.priority } as VoiceTurnOutcome;
    };
    const agent = new ConversationalVoiceAgent({ sessionId: 's1', processTurn: proc, output: { available: false, speak: () => { throw new Error('no'); } }, input: hy, now: () => now });
    agent.listen();
    expect(hy.source).toBe('DEVICE');
    browser.push({ kind: 'speechStart' }, { kind: 'partial', text: 'Amritsar se' });
    now += 300; browser.push({ kind: 'final', text: 'Amritsar se Delhi jaana hai' }, { kind: 'speechEnd' });
    now += 500;
    await agent.tick();
    expect(calls).toEqual(['Amritsar se Delhi jaana hai']);
    expect(browser.active).toBe(false);                                   // mic closed after one utterance
  });

  it('[5] stale protection: a superseded enhanced recording never reaches the agent', async () => {
    let release!: (r: TranscribeResult) => void;
    const batch = mkBatch(() => new Promise<TranscribeResult>(r => { release = r; }));
    const a = handlers();
    batch.start(a.h, { continuous: false, lang: 'hi-IN' });
    const p = batch.finish();
    await flush();
    expect(batch.currentPhase).toBe('TRANSCRIBING');
    batch.stop();                                                         // new tap / barge-in supersedes it
    release({ ok: true, transcript: 'purani recording' });
    await p;
    expect(a.got.finals).toEqual([]);
    expect(batch.discarded).toBe(1);
  });
});

// ---------------------------------------------------------------- B. voice response layer
/** The pre-P36-C.1.1 TEXT branch of speechOf, verbatim — TEXT mode must stay byte-identical. */
function legacyTextSpeech(text: string, question?: string): string {
  const flat = String(text || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= 160) return flat;
  const sentences = flat.split(/(?<=[.!?।])\s+/);
  let out = sentences[0];
  if (question && flat.includes(question) && !out.includes(question)) out = `${out} ${question}`;
  return out.trim();
}
const REVIEW = 'Review (v1):\nTrain 12014 Shatabdi, 5 Oct, CC.\nPassengers: Mohit (32, M), Riya (29, F).\nTotal fare ₹1,040.\nBooking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.\nKya main aage badhoon?';
const LIST = 'Kal ke liye 4 trains mili hain:\n12014 Shatabdi 04:55 CC ₹520\n12497 Shan-e-Punjab 06:35 3A ₹650\n18238 Chhattisgarh Exp 19:35 SL ₹395\n22126 3A WL 42 ₹795\nKaunsi train dekhni hai?';

describe('P36-C.1.1 B — VOICE concise vs TEXT unchanged; facts never altered', () => {
  it('[6] TEXT speech is unchanged (identical to the previous implementation)', () => {
    for (const [t, q] of [[REVIEW, 'Kya main aage badhoon?'], [LIST, 'Kaunsi train dekhni hai?'], ['12014 mein CC available hai.', undefined], ['x'.repeat(200) + '. Next?', 'Next?']] as Array<[string, string | undefined]>) {
      expect(speechOf(t, 'TEXT', q)).toBe(legacyTextSpeech(t, q));
    }
  });

  it('[7] VOICE speech: ≤3 selected sentences + fact-free note; verbatim sentences; boundary sentence + final question kept', () => {
    const v = speechOf(REVIEW, 'VOICE', 'Kya main aage badhoon?');
    // fact-weighted selection: train/class/date + total fare + the booking boundary, then the question
    expect(v).toBe('Train 12014 Shatabdi, 5 Oct, CC. Total fare ₹1,040. Actual railway booking abhi enabled nahi hai. Baaki details screen par hain. Kya main aage badhoon?');
    expect(v.endsWith('Kya main aage badhoon?')).toBe(true);
    expect(v).not.toMatch(/Review \(v1\)|Mohit|Riya/);                     // label + long details stay on screen only
    for (const s of v.split(/(?<=[.?])\s+/).filter(s => s !== 'Baaki details screen par hain.')) expect(REVIEW).toContain(s);
    // a list of trains is screen-only (cards); speech = summary + pointer + question (summary's ':' → spoken pause)
    expect(speechOf(LIST, 'VOICE')).toBe('Kal ke liye 4 trains mili hain. Baaki details screen par hain. Kaunsi train dekhni hai?');
    // short replies are spoken as-is
    expect(speechOf('12014 mein CC available hai. Kitne passengers?', 'VOICE')).toBe('12014 mein CC available hai. Kitne passengers?');
    // the booking boundary is never dropped, even when it is not first
    const b = conciseForVoice('Ek. Do. Teen. Chaar. Ticket abhi book nahi hua hai. Aage?', { detailsNote: true }).text;
    expect(b).toContain('Ticket abhi book nahi hua hai.');
    expect(conciseForVoice('The train is ready. The coach is clean. The station is near. The weather is good. Shall I continue?', { detailsNote: true }).text)
      .toBe('The train is ready. The coach is clean. The station is near. The rest is on your screen. Shall I continue?');
    expect(conciseForVoice('एक। दो। तीन। चार। पाँच। ठीक है?', { detailsNote: true }).text).toContain('बाकी जानकारी स्क्रीन पर है।');
  });

  it('[8] speakable rendering keeps every train number, time, amount, count, date and waitlist number', () => {
    const cases: Array<[string, string]> = [
      ['Kal 5 Oct ko Amritsar Junction ASR se New Delhi NDLS ke liye subah ki 9 trains hain. Kaunsi train dekhni hai?',
        'Kal 5 October ko Amritsar Junction se New Delhi ke liye subah ki 9 trains hain. Kaunsi train dekhni hai?'],
      ['22126 mein 3A WL 42 hai, fare ₹795 hai. Kya aage badhein?', '2 2 1 2 6 mein 3 A waiting list 42 hai, fare 795 rupaye hai. Kya aage badhein?'],
      ['22126 3A WL 42 ₹795', '2 2 1 2 6, 3 A waiting list 42, 795 rupaye'],
      ['12014 departs at 04:55, CC fare ₹1,040 for 2 × ₹520.', '1 2 0 1 4 departs at 04:55, C C fare 1,040 rupees for 2 into 520 rupees.'],
      ['दिल्ली के लिए 12014 में CC ₹520 है। क्या बुक करें?', 'दिल्ली के लिए 1 2 0 1 4 में C C 520 रुपये है। क्या बुक करें?'],
      ['Amritsar (ASR) → New Delhi (NDLS), 12497 RAC 5.', 'Amritsar se New Delhi, 1 2 4 9 7 R A C 5.']
    ];
    for (const [input, expected] of cases) {
      const out = renderForSpeech(input);
      expect(out).toBe(expected);
      expect(digitFacts(out)).toEqual(digitFacts(input));                // facts identical, same order
    }
    // "(v1)" is a screen-only review-version marker (not a railway fact) and is not spoken
    expect(digitFacts(renderForSpeech(REVIEW))).toEqual(digitFacts(REVIEW.replace(' (v1)', '')));
    expect(digitFacts(renderForSpeech(LIST))).toEqual(digitFacts(LIST));
    expect(renderForSpeech('Fare ₹12500 hai.')).toBe('Fare 12500 rupaye hai.');   // money is never spelled as a train number
  });

  it('[9] never spoken: credentials, session ids, URLs, raw JSON, stack traces, provider names, markdown, emoji', () => {
    const bad = [
      'Theek hai. Error: ECONNRESET while calling upstream.',
      'Theek hai. {"trainNumber": "12014", "fare": 520}',
      'Theek hai. Session sess_8f3a9c2b1d is active. Docs https://example.com/x',
      'Theek hai. Data RailCore se aaya, voice ElevenLabs aur model Muse NVIDIA.',
      'Theek hai. Key sk-ABCDEFGHIJKLMNOP1234 and ghp_ABCDEFGHIJKLMNOPQRSTUVWX12 and github_pat_11ABCDEFG0123456789_abcdefghij and rnd_AbCdEfGhIjKlMnOp and xi-0123456789abcdef.',
      '**Theek hai** ✅'
    ];
    for (const b of bad) {
      const out = renderForSpeech(redactForSpeech(b));
      expect(out.startsWith('Theek hai')).toBe(true);
      expect(out).not.toMatch(/ECONN|Error:|[{}"]|sess_|https?:|RailCore|ElevenLabs|Muse|NVIDIA|sk-|ghp_|github_pat|rnd_|xi-|redacted|\*\*|✅/);
    }
    for (const k of ['sk-ABCDEFGHIJKLMNOP1234', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX12', 'github_pat_11ABCDEFG0123456789_abcdefghij', 'rnd_AbCdEfGhIjKlMnOp', 'xi-0123456789abcdef', 'Bearer abcdefghijklmnop']) {
      expect(redactForSpeech(`token ${k} end`)).toBe('token [redacted] end');
      expect(maskCredentials(`token ${k} end`)).not.toContain(k.slice(4, 14));
    }
    expect(renderForSpeech('{"a": 1}')).toBe('');                         // nothing speakable → nothing spoken
  });
});

// ---------------------------------------------------------------- C/D. TTS boundary with the real browser adapter
class FakeUtterance { lang = ''; rate = 1; onstart: any; onend: any; onerror: any; constructor(readonly text: string) {} }
class FakeSynth {
  said: string[] = []; cancels = 0; failNext = 0; current: FakeUtterance | null = null;
  speak(u: FakeUtterance) {
    this.said.push(u.text);
    if (this.failNext > 0) { this.failNext--; queueMicrotask(() => u.onerror?.({ error: 'synthesis-failed' })); return; }
    this.current = u; queueMicrotask(() => u.onstart?.());
  }
  cancel() { this.cancels++; const u = this.current; this.current = null; u?.onerror?.({ error: 'interrupted' }); }
  finish() { const u = this.current; this.current = null; u?.onend?.(); }
}
let synth: FakeSynth;
beforeEach(() => { synth = new FakeSynth(); (globalThis as any).window = { speechSynthesis: synth }; (globalThis as any).SpeechSynthesisUtterance = FakeUtterance; });
afterEach(() => { delete (globalThis as any).window; delete (globalThis as any).SpeechSynthesisUtterance; });

function mkAgent(outcomes: Array<{ text: string; segments?: string[] }>) {
  let now = 1000, n = 0;
  const stt = new MockStreamingSTT();
  const calls: string[] = [];
  const remote: string[] = [];
  const proc: TurnProcessor = async (text, o) => {
    const k = n++; calls.push(text);
    const turnId = `t${k + 1}`;
    o.onEvent({ type: 'TURN_STARTED', turnId, sequence: k + 1 });
    const oc = outcomes[k] || { text: 'Theek hai.' };
    return { sessionId: 's1', turnId, sequence: k + 1, presentable: true, assistantText: oc.text, speechText: oc.text, segments: oc.segments || segmentForSpeech(oc.text), shouldSpeak: true, interruptible: true, responsePriority: o.priority } as VoiceTurnOutcome;
  };
  const agent = new ConversationalVoiceAgent({ sessionId: 's1', processTurn: proc, output: new BrowserSpeechOutput(), input: stt, now: () => now, interruptRemote: (r) => { remote.push(r); } });
  const playAll = async () => { for (let i = 0; i < 20 && synth.current; i++) { synth.finish(); await flush(); } };
  return { agent, stt, calls, remote, playAll, advance: (ms: number) => { now += ms; } };
}

describe('P36-C.1.1 C/D — TTS receives only checked text; barge-in; TTS failure + retry', () => {
  it('[10] the speech engine receives exactly the rendered validated segments (credentials masked, facts identical)', async () => {
    const segs = ['22126 mein 3A WL 42 hai, fare ₹795 hai.', 'Debug key sk-ABCDEFGHIJKLMNOP1234 ignore.', 'Book karna hai?'];
    const h = mkAgent([{ text: segs.join(' '), segments: segs }]);
    await h.agent.processTurn('22126 ki availability', { normalize: false });
    await flush(); await h.playAll();
    expect(synth.said).toEqual(segs.map(s => renderForSpeech(redactForSpeech(s))));
    expect(synth.said.join(' ')).not.toMatch(/sk-|redacted/);
    expect(digitFacts(synth.said[0])).toEqual(digitFacts(segs[0]));
  });

  it('[11] barge-in stops speech immediately; the old reply is stale and never resumes; the new turn is spoken', async () => {
    const h = mkAgent([
      { text: '12014 Shatabdi 04:55 par hai. 12497 06:35 par hai. Kaunsi chahiye?' },
      { text: '12497 select kar li.' }
    ]);
    h.agent.listen();
    h.stt.push({ kind: 'speechStart' }, { kind: 'final', text: 'trains dikhao' }, { kind: 'speechEnd' });
    h.advance(500); await h.agent.tick(); await flush();
    expect(synth.said).toEqual(['1 2 0 1 4 Shatabdi 04:55 par hai.']);
    h.agent.listen();                                                     // tap while speaking = barge-in
    expect(synth.cancels).toBeGreaterThan(0);
    expect(h.remote).toEqual(['BARGE_IN']);
    expect(h.agent.retrySpeech()).toBe(false);                            // stale → cannot resume
    h.stt.push({ kind: 'speechStart' }, { kind: 'final', text: 'doosri wali' }, { kind: 'speechEnd' });
    h.advance(500); await h.agent.tick(); await flush(); await h.playAll();
    expect(synth.said).not.toContain('Kaunsi chahiye?');
    expect(synth.said).not.toContain('1 2 4 9 7 06:35 par hai.');
    expect(synth.said[synth.said.length - 1]).toBe('1 2 4 9 7 select kar li.');
    expect(h.calls).toEqual(['trains dikhao', 'doosri wali']);
  });

  it('[12] TTS failure → text stays, no new turn; retrySpeech replays the SAME rendered segments once', async () => {
    const reply = 'Review taiyaar hai. Actual railway booking abhi enabled nahi hai. Aage badhein?';
    const h = mkAgent([{ text: reply }]);
    synth.failNext = 1;
    const o = await h.agent.processTurn('review dikhao', { normalize: false });
    await flush();
    expect(o?.assistantText).toBe(reply);                                 // the screen text is untouched
    expect(h.agent.snapshot()).toMatchObject({ textFallback: true, ttsAvailable: true });
    expect(h.calls).toHaveLength(1);
    synth.said = [];
    expect(h.agent.retrySpeech()).toBe(true);
    await flush(); await h.playAll();
    expect(h.calls).toHaveLength(1);                                      // no new LLM / tool turn
    expect(synth.said).toEqual(segmentForSpeech(reply).map(s => renderForSpeech(s)));
    expect(h.agent.snapshot().textFallback).toBe(false);
  });
});
