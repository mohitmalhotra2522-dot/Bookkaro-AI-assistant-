// @vitest-environment happy-dom
/**
 * P41 (Part A) — tap-to-talk capture timing (same web STT pipeline for desktop + Android WebView):
 *  - "Listening" only once the mic really delivers audio (first words were cut when the UI said Recording too early)
 *  - a suspended AudioContext is resumed (AudioContext created after an await — WebView / Safari)
 *  - the tail still inside the audio graph is drained on release (last words were clipped)
 * SIMULATED: fake AudioContext / getUserMedia. Real-device result: USER VERIFICATION REQUIRED.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPcmRecorder, MIC_READY_TIMEOUT_MS, TAIL_DRAIN_MS } from '../../src/voice/pcm-recorder';
import { BatchSttSpeechInput, type PcmRecorder } from '../../src/voice/batch-speech-input';
import { voiceVisual } from '../../src/components/voice/MicButton';

class FakeCtx {
  static last: FakeCtx | null = null;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  sampleRate = 48000;
  resumed = 0;
  node: any = null;
  destination = {};
  constructor() { FakeCtx.last = this; }
  async resume() { this.resumed++; this.state = 'running'; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { this.node = { onaudioprocess: null, connect() {}, disconnect() {} }; return this.node; }
  async close() { this.state = 'closed'; }
}
const pump = (n = 1, v = 0.1) => { for (let k = 0; k < n; k++) FakeCtx.last!.node?.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(v) } }); };
const flush = async (n = 4) => { for (let k = 0; k < n; k++) await Promise.resolve(); };
let stopped = 0;

beforeEach(() => {
  FakeCtx.last = null; stopped = 0;
  (window as any).AudioContext = FakeCtx;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) } });
});
afterEach(() => { vi.useRealTimers(); });

describe('P41 Part A — PCM recorder capture timing', () => {
  it('[S1] suspended AudioContext is resumed; start() resolves only after the first real audio buffer', async () => {
    const rec = createPcmRecorder()!;
    let started = false;
    const p = rec.start(() => undefined).then(() => { started = true; });
    await flush(10);
    expect(FakeCtx.last!.resumed).toBe(1);
    expect(FakeCtx.last!.state).toBe('running');
    expect(started).toBe(false);                     // mic open but no audio yet → not "Listening"
    pump(1);
    await p;
    expect(started).toBe(true);
    rec.abort();
  });

  it('[S2] release drains the tail (≤ 2 more buffers) before the mic is released — the last words are kept', async () => {
    const rec = createPcmRecorder()!;
    const p = rec.start(() => undefined); await flush(10); pump(1); await p;
    pump(2);                                         // speech while recording
    let done = false;
    const s = rec.stop().then(r => { done = true; return r; });
    await flush(4);
    expect(done).toBe(false);                        // waiting for the buffered tail
    expect(stopped).toBe(0);                         // mic not released yet
    pump(2);                                         // the tail arrives
    const r = await s;
    expect(stopped).toBe(1);
    expect(r.audio.length).toBe(Math.floor(5 * 4096 / 3) * 2); // 5 buffers @48 kHz → 16 kHz PCM16 (start + 2 + tail 2)
  });

  it('[S3] no audio callbacks → start() still resolves after MIC_READY_TIMEOUT_MS; stop() is bounded by TAIL_DRAIN_MS', async () => {
    vi.useFakeTimers();
    const rec = createPcmRecorder()!;
    let started = false;
    const p = rec.start(() => undefined).then(() => { started = true; });
    await vi.advanceTimersByTimeAsync(MIC_READY_TIMEOUT_MS - 50);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await p;
    expect(started).toBe(true);
    let done = false;
    const s = rec.stop().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(TAIL_DRAIN_MS + 10);
    await s;
    expect(done).toBe(true);
    expect(TAIL_DRAIN_MS).toBeLessThanOrEqual(300);
  });
});

describe('P41 Part A — BatchSttSpeechInput micReady + UI state', () => {
  function harness(startImpl: () => Promise<void>) {
    const rec: PcmRecorder = { start: startImpl, stop: async () => ({ audio: new Uint8Array(3200), durationMs: 1000 }), abort: () => undefined };
    const transcribe = vi.fn(async () => ({ ok: true as const, transcript: 'Amritsar se Delhi kal' }));
    const b = new BatchSttSpeechInput({ sessionId: () => 's1', createRecorder: () => rec, transcribe, newId: () => 'vt_1' });
    b.setEnabled(true);
    const got: { finals: string[]; errors: string[] } = { finals: [], errors: [] };
    const h: any = { onFinal: (t: string) => got.finals.push(t), onError: (c: string) => got.errors.push(c), onPartial: () => undefined, onSpeechStart: () => undefined, onSpeechEnd: () => undefined, onEnd: () => undefined };
    return { b, h, got, transcribe };
  }

  it('[S4] RECORDING is immediate (tap feedback) but micReady turns true only when the recorder confirms audio; false again on send', async () => {
    let open!: () => void;
    const { b, h, got, transcribe } = harness(() => new Promise<void>(r => { open = r; }));
    const seen: boolean[] = [];
    b.onMicReady(r => seen.push(r));
    b.start(h, { continuous: false, lang: 'hi-IN' });
    expect(b.currentPhase).toBe('RECORDING');
    expect(b.micReady).toBe(false);
    expect(voiceVisual({ isRecording: false, sttPhase: b.currentPhase, micReady: b.micReady })).toBe('preparing');
    open(); await flush();
    expect(b.micReady).toBe(true);
    expect(voiceVisual({ isRecording: false, sttPhase: b.currentPhase, micReady: b.micReady })).toBe('listening');
    await b.finish();
    expect(b.micReady).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(got.finals).toEqual(['Amritsar se Delhi kal']);
  });

  it('[S5] mic failure keeps micReady false; a cancelled recording never becomes ready later', async () => {
    const denied = harness(() => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })));
    denied.b.start(denied.h, { continuous: false, lang: 'hi-IN' });
    await flush();
    expect(denied.b.micReady).toBe(false);
    expect(denied.got.errors).toEqual(['MIC_PERMISSION_DENIED']);
    let open!: () => void;
    const late = harness(() => new Promise<void>(r => { open = r; }));
    late.b.start(late.h, { continuous: false, lang: 'hi-IN' });
    late.b.stop();
    open(); await flush();
    expect(late.b.micReady).toBe(false);
    expect(late.b.currentPhase).toBe('IDLE');
  });

  it('[S6] legacy callers (no micReady prop) keep the old mapping', () => {
    expect(voiceVisual({ isRecording: false, sttPhase: 'RECORDING' })).toBe('listening');
    expect(voiceVisual({ isRecording: false, sttPhase: 'TRANSCRIBING', micReady: false })).toBe('transcribing');
  });
});
