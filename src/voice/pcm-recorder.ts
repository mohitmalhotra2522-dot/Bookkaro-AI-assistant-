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

export function pcmRecorderSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
  return !!(AC && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
}

/** Float32 [-1, 1] at `fromRate` → Int16 LE at 16 kHz (block-average downsampling; mono). */
export function toPcm16(chunks: Float32Array[], fromRate: number): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let o = 0;
  for (const c of chunks) { input.set(c, o); o += c.length; }
  const ratio = fromRate / TARGET_SAMPLE_RATE;
  const outLen = Math.floor(total / ratio);
  const out = new Uint8Array(outLen * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio), end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0, n = 0;
    for (let j = start; j < end && j < total; j++) { sum += input[j]; n++; }
    const s = Math.max(-1, Math.min(1, n ? sum / n : 0));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

export function createPcmRecorder(): PcmRecorder | null {
  if (!pcmRecorderSupported()) return null;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let node: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];
  let startedAt = 0;
  let limit: number | null = null;
  let closed = false;

  const release = () => {
    closed = true;
    if (limit !== null) { clearTimeout(limit); limit = null; }
    try { node?.disconnect(); source?.disconnect(); } catch { /* ignore */ }
    if (node) node.onaudioprocess = null;
    stream?.getTracks().forEach(t => { try { t.stop(); } catch { /* ignore */ } });
    void ctx?.close().catch(() => undefined);
    node = null; source = null; stream = null; ctx = null;
  };

  return {
    async start(onAutoStop: () => void) {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (closed) { release(); throw new Error('ABORTED'); }
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      ctx = new AC() as AudioContext;
      source = ctx.createMediaStreamSource(stream);
      // ScriptProcessorNode: universally available (incl. Safari) and needs no extra module file
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => { if (!closed) chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      source.connect(node);
      node.connect(ctx.destination);
      startedAt = Date.now();
      limit = window.setTimeout(() => onAutoStop(), MAX_RECORDING_MS);
    },
    async stop(): Promise<PcmRecording> {
      const rate = ctx?.sampleRate || 48000;
      const data = chunks;
      chunks = [];
      const durationMs = startedAt ? Date.now() - startedAt : 0;
      release();
      return { audio: toPcm16(data, rate), durationMs };
    },
    abort() { chunks = []; release(); }
  };
}
