/**
 * P36-C — tap-to-talk microphone capture → 16 kHz mono 16-bit little-endian PCM (the format validated in the
 * P36-B.5 / P36-B.6 ElevenLabs benchmarks; sent with file_format=pcm_s16le_16).
 *
 * Opened ONLY from an explicit user tap (BatchSttSpeechInput.start). Audio stays in memory: it is never written to
 * storage, never logged, and the microphone track is released as soon as recording stops or is aborted.
 * A hard duration ceiling auto-stops the recording (the turn is then submitted once, like a release).
 */
import type { PcmRecorder, PcmRecording } from './batch-speech-input';

export const TARGET_SAMPLE_RATE = 16000;
export const MAX_RECORDING_MS = 60_000;
/** P41-STT: start() resolves only once the mic actually delivers audio (or after this ceiling). */
export const MIC_READY_TIMEOUT_MS = 1500;
/** P41-STT: on release, wait for the audio still buffered in the graph (≤ 2 callbacks or this ceiling). */
export const TAIL_DRAIN_MS = 300;

export function pcmRecorderSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  return !!(AC && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
}

/**
 * Float32 [-1, 1] at `fromRate` → Int16 LE at 16 kHz, mono.
 * P41-STT2: band-limited (windowed-sinc, Blackman) resampling instead of block averaging — block averaging let
 * 8–16 kHz content alias into the speech band (≈ 33 % at 12 kHz for 48 kHz input), which smears consonants and
 * digits for the recogniser. Output length is unchanged: floor(total / (fromRate / 16000)).
 */
const SINC_ZERO_CROSSINGS = 8;
const SINC_PHASES = 32;
const kernelCache = new Map<number, { tab: Float32Array; half: number }>();
function sincKernel(ratio: number) {
  const hit = kernelCache.get(ratio);
  if (hit) return hit;
  const s = 0.9 * Math.min(1, 1 / ratio);              // cutoff = 90 % of the lower Nyquist, in input-sample units
  const half = Math.ceil(SINC_ZERO_CROSSINGS / s);
  const tab = new Float32Array(half * SINC_PHASES + 1);
  for (let k = 0; k < tab.length; k++) {
    const x = k / SINC_PHASES;
    const u = s * x;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    const w = 0.42 + 0.5 * Math.cos(Math.PI * x / half) + 0.08 * Math.cos(2 * Math.PI * x / half);
    tab[k] = s * sinc * Math.max(0, w);
  }
  const v = { tab, half };
  kernelCache.set(ratio, v);
  return v;
}

export function toPcm16(chunks: Float32Array[], fromRate: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { input.set(c, o); o += c.length; }
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const outLen = Math.floor(total / ratio);
  const out = new Uint8Array(outLen * 2);
  const view = new DataView(out.buffer);
  const put = (i: number, v: number) => { const x = Math.max(-1, Math.min(1, v)); view.setInt16(i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); };
  if (Math.abs(ratio - 1) < 1e-9) { for (let i = 0; i < outLen; i++) put(i, input[i]); return out; }
  const { tab, half } = sincKernel(ratio);
  const maxK = tab.length - 1;
  for (let i = 0; i < outLen; i++) {
    const t = i * ratio, c = Math.floor(t);
    let acc = 0, ws = 0;
    for (let j = Math.max(0, c - half + 1), e = Math.min(total - 1, c + half); j <= e; j++) {
      const k = Math.round(Math.abs(j - t) * SINC_PHASES);
      if (k > maxK) continue;
      const h = tab[k];
      acc += input[j] * h; ws += h;
    }
    put(i, ws > 0 ? acc / ws : 0);
  }
  return out;
}

/**
 * P41-STT2 — AudioWorklet capture (runs on the audio thread). ScriptProcessorNode runs on the main thread: in an
 * Android WebView a busy page (React renders, TTS events) makes it skip callbacks → chunks of speech are lost and
 * the recogniser hears fragments ("ek passenger" → "16"). Worklet messages queue instead of being dropped.
 * Loaded from a Blob URL (no extra file). Falls back to ScriptProcessorNode when unavailable.
 */
const WORKLET_NAME = 'bk-pcm-capture';
const WORKLET_SRC = `class BkPcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf, [this.buf.buffer]); this.buf = new Float32Array(1024); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('${WORKLET_NAME}', BkPcmCapture);`;
/** Tail to keep after release, in input samples (= the old "2 ScriptProcessor buffers of 4096"). */
const TAIL_SAMPLES = 2 * 4096;

async function createWorkletNode(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  const AWN = (globalThis as any).AudioWorkletNode;
  if (!AWN || !(ctx as any).audioWorklet || typeof (ctx as any).audioWorklet.addModule !== 'function') return null;
  let url: string | null = null;
  try {
    url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    await (ctx as any).audioWorklet.addModule(url);
    return new AWN(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1 }) as AudioWorkletNode;
  } catch {
    return null;                                         // CSP / old WebView → ScriptProcessorNode
  } finally {
    if (url) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
  }
}

export function createPcmRecorder(): PcmRecorder | null {
  if (!pcmRecorderSupported()) return null;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: ScriptProcessorNode | null = null;
  let worklet: AudioWorkletNode | null = null;
  let firstAudioAt = 0;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];
  let startedAt = 0;
  let limit: number | null = null;
  let closed = false;
  // P41-STT: resolved by the audio callback — first real audio (mic ready) / tail buffers after release
  let onFirstAudio: (() => void) | null = null;
  let drain: { left: number; done: () => void } | null = null;
  // one sink for both capture paths; `left` counts input samples still wanted after release
  const onChunk = (data: Float32Array) => {
    if (closed) return;
    chunks.push(data);
    if (onFirstAudio) { firstAudioAt = Date.now(); const f = onFirstAudio; onFirstAudio = null; f(); }
    if (drain) { drain.left -= data.length; if (drain.left <= 0) drain.done(); }
  };

  const release = () => {
    closed = true;
    if (limit !== null) { clearTimeout(limit); limit = null; }
    try { node?.disconnect(); worklet?.disconnect(); source?.disconnect(); } catch { /* ignore */ }
    if (node) node.onaudioprocess = null;
    if (worklet) { try { worklet.port.onmessage = null; worklet.port.close(); } catch { /* ignore */ } }
    stream?.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
    void ctx?.close().catch(() => undefined);
    node = null; worklet = null; source = null; stream = null; ctx = null;
  };

  return {
    async start(onAutoStop: () => void) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (closed) { release(); throw new Error('ABORTED'); }
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      ctx = new AC() as AudioContext;
      // P41-STT: an AudioContext created after an await (no direct user gesture any more — Android WebView, Safari)
      // can start 'suspended' → no audio callbacks → the first words are lost. Resume explicitly.
      if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* best effort */ } }
      if (closed) { release(); throw new Error('ABORTED'); }
      source = ctx.createMediaStreamSource(stream);
      const firstAudio = new Promise<void>(r => { onFirstAudio = r; });
      // P41-STT2: audio-thread capture first; ScriptProcessorNode (universally available) as the fallback
      const w = await createWorkletNode(ctx);
      if (closed) { release(); throw new Error('ABORTED'); }
      if (w) {
        worklet = w;
        w.port.onmessage = (e: MessageEvent) => { if (e.data instanceof Float32Array) onChunk(e.data); };
        source.connect(w);
        w.connect(ctx.destination);                      // outputs silence; keeps the node pulled by the graph
      } else {
        node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
        source.connect(node);
        node.connect(ctx.destination);
      }
      startedAt = Date.now();
      limit = window.setTimeout(() => onAutoStop(), MAX_RECORDING_MS);
      // P41-STT: "Listening" is shown only when audio is really flowing (WebView mic start is slower than desktop)
      let t: number | undefined;
      await Promise.race([firstAudio, new Promise<void>(r => { t = window.setTimeout(r, MIC_READY_TIMEOUT_MS); })]);
      if (t !== undefined) clearTimeout(t);
      if (closed) throw new Error('ABORTED');
    },
    async stop(): Promise<PcmRecording> {
      // P41-STT: the last ~100–200 ms are still inside the audio graph when the user taps "send" — drain them
      // (≤ 2 more callbacks, max TAIL_DRAIN_MS) so the end of the sentence is not clipped
      if (!closed && (node || worklet) && ctx && ctx.state === 'running') {
        await new Promise<void>(res => {
          const t = window.setTimeout(() => { drain = null; res(); }, TAIL_DRAIN_MS);
          drain = { left: TAIL_SAMPLES, done: () => { clearTimeout(t); drain = null; res(); } };
        });
      }
      const rate = ctx?.sampleRate || 48000;
      const data = chunks;
      chunks = [];
      // P41-STT2: measured from the first real audio (the server compares it with the recorded length → dropped buffers)
      const from = firstAudioAt || startedAt;
      const durationMs = from ? Date.now() - from : 0;
      release();
      return { audio: toPcm16(data, rate), durationMs };
    },
    abort() { chunks = []; release(); }
  };
}
