// @vitest-environment happy-dom
/**
 * P41-STT2 — capture quality (same web STT pipeline for desktop + Android WebView):
 *  - band-limited resampling to 16 kHz (block averaging aliased 8–16 kHz content into the speech band)
 *  - AudioWorklet capture on the audio thread (a busy WebView main thread made ScriptProcessorNode skip buffers →
 *    fragments of speech were lost); ScriptProcessorNode stays the fallback
 * SIMULATED: fake AudioContext / AudioWorklet / getUserMedia. Real-device result: USER VERIFICATION REQUIRED.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPcmRecorder, toPcm16, TARGET_SAMPLE_RATE } from '../../src/voice/pcm-recorder';

const sine = (hz: number, rate: number, n: number, amp = 0.5) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * hz * i / rate); return a; };
const samples = (u: Uint8Array) => { const v = new DataView(u.buffer, u.byteOffset, u.byteLength); const o: number[] = []; for (let i = 0; i + 1 < u.length; i += 2) o.push(v.getInt16(i, true) / 32768); return o; };
const midPeak = (x: number[]) => { const s = x.slice(Math.floor(x.length * 0.2), Math.floor(x.length * 0.8)); return Math.max(...s.map(Math.abs)); };

describe('P41-STT2 — 16 kHz resampling quality', () => {
  it('[D1] speech-band tone (1 kHz @ 48 kHz) keeps its level and frequency', () => {
    const out = samples(toPcm16([sine(1000, 48000, 48000)], 48000));
    expect(out.length).toBe(16000);
    expect(midPeak(out)).toBeGreaterThan(0.47); expect(midPeak(out)).toBeLessThan(0.53);
    let zc = 0; for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) zc++;
    expect(Math.abs(zc - 2000)).toBeLessThanOrEqual(4);                 // 1 kHz → 2000 zero crossings per second
  });

  it('[D2] out-of-band tone (12 kHz @ 48 kHz, above the 8 kHz Nyquist) is suppressed instead of aliasing into speech', () => {
    const input = sine(12000, 48000, 48000);
    const out = samples(toPcm16([input], 48000));
    expect(midPeak(out)).toBeLessThan(0.02);
    // the previous block average (3 samples) let ≈ 1/3 of it through as a 4 kHz alias
    const boxcar: number[] = []; for (let i = 0; i + 2 < input.length; i += 3) boxcar.push((input[i] + input[i + 1] + input[i + 2]) / 3);
    expect(midPeak(boxcar)).toBeGreaterThan(0.15);
  });

  it('[D3] 16 kHz input passes through exactly; 44.1 kHz keeps the output-length contract; 10 s @ 48 kHz is fast', () => {
    const x = sine(440, 16000, 1600);
    const out = samples(toPcm16([x], 16000));
    expect(out.length).toBe(1600);
    for (let i = 0; i < 1600; i += 97) expect(Math.abs(out[i] - x[i])).toBeLessThan(1e-4);
    const n44 = 44100;
    expect(toPcm16([sine(500, 44100, n44)], 44100).length).toBe(Math.floor(n44 / (44100 / TARGET_SAMPLE_RATE)) * 2);
    const t0 = Date.now();
    toPcm16([sine(300, 48000, 480000)], 48000);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

class FakeCtx {
  static last: FakeCtx | null = null;
  static worklet: 'ok' | 'reject' | 'none' = 'ok';
  state: 'suspended' | 'running' | 'closed' = 'running';
  sampleRate = 48000;
  node: any = null;
  modules: string[] = [];
  destination = {};
  audioWorklet: any;
  constructor() {
    FakeCtx.last = this;
    if (FakeCtx.worklet !== 'none') this.audioWorklet = { addModule: async (u: string) => { this.modules.push(u); if (FakeCtx.worklet === 'reject') throw new Error('CSP'); } };
  }
  async resume() { this.state = 'running'; }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createScriptProcessor() { this.node = { onaudioprocess: null, connect() {}, disconnect() {} }; return this.node; }
  async close() { this.state = 'closed'; }
}
class FakeWorkletNode {
  static last: FakeWorkletNode | null = null;
  port: any = { onmessage: null, close: vi.fn() };
  name: string;
  constructor(_ctx: any, name: string) { this.name = name; FakeWorkletNode.last = this; }
  connect() {}
  disconnect() {}
}
const post = (n = 1, v = 0.1) => { for (let k = 0; k < n; k++) FakeWorkletNode.last!.port.onmessage?.({ data: new Float32Array(1024).fill(v) }); };
const flush = async (n = 12) => { for (let k = 0; k < n; k++) await Promise.resolve(); };
let stopped = 0;

beforeEach(() => {
  FakeCtx.last = null; FakeWorkletNode.last = null; FakeCtx.worklet = 'ok'; stopped = 0;
  (window as any).AudioContext = FakeCtx;
  (globalThis as any).AudioWorkletNode = FakeWorkletNode;
  if (!URL.createObjectURL) (URL as any).createObjectURL = () => 'blob:fake';
  if (!URL.revokeObjectURL) (URL as any).revokeObjectURL = () => undefined;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) } });
});
afterEach(() => { vi.useRealTimers(); delete (globalThis as any).AudioWorkletNode; });

describe('P41-STT2 — AudioWorklet capture (ScriptProcessorNode fallback)', () => {
  it('[E1] worklet path: module loaded from a Blob URL, no ScriptProcessorNode, "ready" on the first worklet chunk, tail drained, all chunks kept', async () => {
    const rec = createPcmRecorder()!;
    let started = false;
    const p = rec.start(() => undefined).then(() => { started = true; });
    await flush();
    expect(FakeCtx.last!.modules).toHaveLength(1);
    expect(FakeWorkletNode.last!.name).toBe('bk-pcm-capture');
    expect(FakeCtx.last!.node).toBeNull();                 // ScriptProcessorNode not used
    expect(started).toBe(false);
    post(1); await p;
    expect(started).toBe(true);
    post(20);                                              // speech while recording (main thread may be busy — messages queue)
    let done = false;
    const s = rec.stop().then(r => { done = true; return r; });
    await flush(4);
    expect(done).toBe(false); expect(stopped).toBe(0);     // waiting for the tail (8192 input samples ≈ 170 ms)
    post(8);
    const r = await s;
    expect(stopped).toBe(1);
    expect(FakeWorkletNode.last!.port.close).toHaveBeenCalled();
    expect(r.audio.length).toBe(Math.floor(29 * 1024 / 3) * 2);
  });

  it('[E2] addModule rejected (CSP / old WebView) → ScriptProcessorNode fallback records normally', async () => {
    FakeCtx.worklet = 'reject';
    const rec = createPcmRecorder()!;
    const p = rec.start(() => undefined); await flush();
    expect(FakeCtx.last!.node).not.toBeNull();
    const pump = (n: number) => { for (let k = 0; k < n; k++) FakeCtx.last!.node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } }); };
    pump(1); await p;
    pump(2);
    const s = rec.stop(); await flush(4); pump(2);
    const r = await s;
    expect(r.audio.length).toBe(Math.floor(5 * 4096 / 3) * 2);
  });

  it('[E3] no AudioWorklet support at all → ScriptProcessorNode; durationMs is measured from the first real audio', async () => {
    FakeCtx.worklet = 'none';
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const rec = createPcmRecorder()!;
    const p = rec.start(() => undefined); await flush();
    expect(FakeCtx.last!.node).not.toBeNull();
    vi.advanceTimersByTime(400);                          // mic opening, no audio yet
    FakeCtx.last!.node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } });
    await p;
    vi.advanceTimersByTime(1000);
    const s = rec.stop(); await flush(4);
    FakeCtx.last!.node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(8192).fill(0.1) } });
    const r = await s;
    expect(r.durationMs).toBe(1000);                       // not 1400: the opening time is not counted as recorded audio
  });
});
