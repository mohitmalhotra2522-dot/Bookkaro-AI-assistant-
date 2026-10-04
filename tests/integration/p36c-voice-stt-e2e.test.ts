/**
 * P36-C — G3: focused voice E2E with ElevenLabs Scribe v2 BATCH STT [MOCK-controlled — fake provider, never LIVE].
 *
 *   PCM recording (fake recorder) → BatchSttSpeechInput (tap → release, submitted once)
 *   → POST /api/voice/transcribe (real route) → ElevenLabsBatchSTT (real provider code, FAKE fetch — no network, no credits)
 *   → FINAL transcript → the EXISTING ConversationalVoiceAgent → VoiceTurnDetector → normalizeTranscript
 *   → engineTurnProcessor → ConversationTurnEngine.processTurn(…,'VOICE') (the engine /api/chat calls)
 *   → MockLLM agent → RailwayToolRuntime → spy railway → validated reply → TTS (MockStreamingTTS).
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import Fastify from 'fastify';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { engineTurnProcessor } from '../../server/voice/server-voice-agent';
import { MockStreamingSTT } from '../../server/voice/stt/stt-provider';
import { MockStreamingTTS } from '../../server/voice/tts/tts-provider';
import { registerVoiceRoutes } from '../../server/voice/live/voice-routes';
import { createElevenLabsBatchSTT } from '../../server/voice/stt/elevenlabs-batch-stt';
import { ConversationalVoiceAgent, type TurnProcessor } from '../../shared/voice/conversational-voice-agent';
import { BatchSttSpeechInput, HybridSpeechInput, type PcmRecorder, type TranscribeResult } from '../../src/voice/batch-speech-input';

const FAKE_KEY = 'xi-FAKE-P36C-E2E-KEY-1111';
class SpyRailway extends MockRailwayProvider {
  n: Record<string, number> = {};
  private b(k: string) { this.n[k] = (this.n[k] || 0) + 1; }
  async searchTrains(r: any): Promise<any> { this.b('search'); return super.searchTrains(r); }
  async checkAvailability(r: any): Promise<any> { this.b('avail'); return super.checkAvailability(r); }
  async getFare(r: any): Promise<any> { this.b('fare'); return super.getFare(r); }
}
const rail = new SpyRailway();
railwayRegistry.register('p36c-spy', () => rail);
const toolCalls = () => Object.values(rail.n).reduce((a, b) => a + b, 0);
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };

function pcm(ms = 1200): Uint8Array {
  const n = 16 * ms, out = new Uint8Array(n * 2), v = new DataView(out.buffer);
  for (let i = 0; i < n; i++) v.setInt16(i * 2, Math.round(7000 * Math.sin((2 * Math.PI * 180 * i) / 16000)), true);
  return out;
}
class FakeRecorder implements PcmRecorder {
  static opened = 0;
  constructor(private readonly audio: Uint8Array) {}
  async start() { FakeRecorder.opened++; }
  async stop() { return { audio: this.audio, durationMs: (this.audio.length / 32000) * 1000 }; }
  abort() { /* mic released */ }
}

type FakeResp = { status: number; body: any } | { hang: Promise<void>; then: { status: number; body: any } };
async function harness(o: { key?: string | null; responses?: FakeResp[] } = {}) {
  railwayRegistry.setActive('p36c-spy');
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => undefined });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;

  // ---- server: real /api/voice/transcribe + real ElevenLabs provider code over a FAKE fetch
  const providerCalls: Array<{ url: string; form: FormData }> = [];
  const responses = [...(o.responses ?? [{ status: 200, body: { language_code: 'hin', text: 'Kal Amritsar se Delhi jaana hai', words: [] } }])];
  let ri = 0;
  const fakeFetch = vi.fn(async (url: any, init: any) => {
    providerCalls.push({ url: String(url), form: init.body });
    const r = responses[Math.min(ri++, responses.length - 1)];
    if ('hang' in r) { await r.hang; return new Response(JSON.stringify(r.then.body), { status: r.then.status }); }
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  const app = Fastify();
  const batchStt = createElevenLabsBatchSTT(o.key === null ? {} as any : { ELEVENLABS_API_KEY: o.key ?? FAKE_KEY } as any, fakeFetch);
  (batchStt as any).cfg.retryDelayMs = 0; (batchStt as any).cfg.sleep = async () => undefined;
  const logs: any[] = [];
  registerVoiceRoutes(app, { stt: null, tts: null, latestSpeech: () => null, batchStt, sessionExists: (s) => state.hasSession(s), log: (e) => logs.push(e) });

  // ---- browser side: the batch SpeechInput over HTTP (inject) + the EXISTING agent
  const transcribe = async (req: { sessionId: string; voiceTurnId: string; audio: Uint8Array; durationMs: number }): Promise<TranscribeResult> => {
    const r = await app.inject({ method: 'POST', url: '/api/voice/transcribe', payload: { sessionId: req.sessionId, voiceTurnId: req.voiceTurnId, mimeType: 'audio/pcm', sampleRate: 16000, durationMs: req.durationMs, audioBase64: Buffer.from(req.audio).toString('base64') } });
    const b = r.json();
    return r.statusCode === 200 ? { ok: true, transcript: b.transcript, language: b.language } : { ok: false, code: b.error };
  };
  let nextAudio = pcm();
  const batch = new BatchSttSpeechInput({ sessionId: () => sid, createRecorder: () => new FakeRecorder(nextAudio), transcribe });
  const browser = new MockStreamingSTT();
  browser.available = false;
  // like useConversationalVoice: enable batch STT from the REAL GET /api/voice/config (safe fields only)
  const cfg = (await app.inject({ method: 'GET', url: '/api/voice/config' })).json();
  batch.setEnabled(!!cfg.stt.enabled);
  const input = new HybridSpeechInput(batch, browser);
  const tts = new MockStreamingTTS();
  // the agent's TurnProcessor = the SAME engine /api/chat runs (spied: proves what reaches the agent turn)
  const realProc = engineTurnProcessor(eng, sid);
  const agentTurns: Array<{ text: string; transcript: any }> = [];
  const processTurn: TurnProcessor = async (text, x) => { agentTurns.push({ text, transcript: x.transcript }); return realProc(text, x); };
  let clock = 1_000_000;
  const agent = new ConversationalVoiceAgent({ sessionId: sid, processTurn, output: tts, input, now: () => clock, interruptRemote: (r) => { eng.interrupt(sid, r === 'BARGE_IN' ? 'BARGE_IN' : 'USER_STOP' as any); } });
  const events: any[] = [];
  agent.on(e => events.push(e));
  /** Drive end-of-turn detection like the browser interval does. */
  const settle = async () => { clock += 2500; const p = agent.tick(); const r = p ? await p : null; await flush(); return r; };
  return { state, eng, sid, app, batch, input, browser, tts, agent, events, agentTurns, providerCalls, logs, settle, setAudio: (a: Uint8Array) => { nextAudio = a; }, session: () => state.getSession(sid) as any };
}

describe('P36-C G3 — speech → Scribe v2 batch → existing voice pipeline → agent', () => {
  afterAll(() => railwayRegistry.setActive('mock'));
  it('[9] transcript reaches the EXISTING pipeline: tap → release → ONE upload → agent → detector → engine (VOICE) → tools → TTS', async () => {
    const h = await harness();
    rail.n = {};
    h.agent.listen();                                          // explicit tap
    await flush();
    expect(h.input.usingBatch).toBe(true);
    expect(h.batch.currentPhase).toBe('RECORDING');
    expect(h.providerCalls).toHaveLength(0);                   // nothing uploaded while recording (no streaming)
    expect(h.agentTurns).toHaveLength(0);
    await h.batch.finish();                                    // release → submitted once
    expect(h.providerCalls).toHaveLength(1);
    expect(h.providerCalls[0].url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(h.providerCalls[0].form.get('model_id')).toBe('scribe_v2');
    expect(h.providerCalls[0].form.getAll('keyterms')).toEqual(['AC', '3A', 'CC', 'SL', 'RAC', 'WL']);
    expect(h.events.some(e => e.type === 'TRANSCRIPT' && e.transcript.status === 'FINAL')).toBe(true);
    const outcome = await h.settle();                          // the existing turn detector finalises the utterance
    expect(h.agentTurns).toHaveLength(1);
    expect(h.agentTurns[0].text).toContain('Amritsar');
    expect(h.agentTurns[0].transcript).toMatchObject({ status: 'FINAL', languageHint: 'hin' });
    expect(outcome?.presentable).toBe(true);
    expect(rail.n.search).toBe(1);                             // the LLM agent (MockLLM) chose the search tool
    expect(h.tts.spoken.length).toBeGreaterThan(0);            // validated reply → TTS
    expect(h.batch.submitted).toBe(1);
    expect(h.logs.filter(l => l.event === 'voice_stt_batch' && l.success)).toHaveLength(1);
  });

  it('[8] stale turn: a cancelled / superseded recording never reaches the agent or /api/chat engine', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const h = await harness({ responses: [{ hang: gate, then: { status: 200, body: { text: 'Kal Amritsar se Delhi jaana hai' } } }, { status: 200, body: { text: 'Mumbai se Pune parso' } }] });
    rail.n = {};
    h.agent.listen(); await flush();
    const pending = h.batch.finish();                          // upload in flight (provider held)
    await flush();
    expect(h.batch.currentPhase).toBe('TRANSCRIBING');
    h.agent.cancel();                                          // one tap: cancel while transcribing
    release();
    await pending;
    await h.settle();
    expect(h.batch.discarded).toBe(1);
    expect(h.agentTurns).toHaveLength(0);                      // never reached the agent turn
    expect(toolCalls()).toBe(0);
    // superseded by a NEW recording (barge-in style): only the new one becomes a turn
    let rel2!: () => void;
    const gate2 = new Promise<void>(r => { rel2 = r; });
    const h2 = await harness({ responses: [{ hang: gate2, then: { status: 200, body: { text: 'Kal Amritsar se Delhi jaana hai' } } }, { status: 200, body: { text: 'Kal Amritsar se Delhi jaana hai' } }] });
    h2.agent.listen(); await flush();
    const old = h2.batch.finish(); await flush();
    h2.agent.cancel(); h2.agent.listen(); await flush();       // user re-taps and records again
    const fresh = h2.batch.finish();
    await fresh; rel2(); await old;
    await h2.settle();
    expect(h2.agentTurns).toHaveLength(1);
    expect(h2.batch.discarded).toBe(1);
  });

  it('[10] STT failure triggers no agent turn and no tools; honest fallback; state untouched; typing still works', async () => {
    let before = toolCalls();
    for (const [resp, code] of [
      [{ status: 503, body: { detail: 'down' } }, 'STT_PROVIDER_UNAVAILABLE'],
      [{ status: 401, body: { detail: 'bad key' } }, 'STT_PROVIDER_AUTH_ERROR'],
      [{ status: 200, body: { nope: true } }, 'STT_PROVIDER_BAD_RESPONSE'],
      [{ status: 200, body: { text: '' } }, 'STT_NO_SPEECH']
    ] as const) {
      const h = await harness({ responses: [resp, resp] });
      const v0 = h.session().sessionVersion;
      h.agent.listen(); await flush();
      await h.batch.finish();
      await h.settle();
      expect(h.agentTurns, code).toHaveLength(0);
      expect(h.events.some(e => e.type === 'TEXT_FALLBACK' && e.reason === code), code).toBe(true);
      expect(h.agent.snapshot().listening).toBe(false);
      expect(h.session().sessionVersion).toBe(v0);
      expect(toolCalls(), code).toBe(before);                  // no railway tool from a failed STT
      // typing remains available: a typed turn goes through the same agent normally
      const typed = await h.agent.processTurn('RAC kya hota hai?');
      expect(typed?.presentable).toBe(true);
      before = toolCalls();
    }
    // missing key → config disabled → batch unavailable; no upload; browser fallback used when present
    const m = await harness({ key: null });
    expect(m.batch.available).toBe(false);
    m.browser.available = true;
    m.agent.listen(); await flush();
    expect(m.input.usingBatch).toBe(false);
    expect(m.browser.active).toBe(true);
    expect(m.providerCalls).toHaveLength(0);
  });

  it('[11] a retried STT call does not duplicate the agent turn (503 then 200 → one upload response, one turn)', async () => {
    const h = await harness({ responses: [{ status: 503, body: {} }, { status: 200, body: { text: 'Kal Amritsar se Delhi jaana hai' } }] });
    rail.n = {};
    h.agent.listen(); await flush();
    await h.batch.finish();
    await h.settle();
    await h.settle();
    expect(h.providerCalls).toHaveLength(2);                   // one retry
    expect(h.batch.submitted).toBe(1);                         // one upload from the browser
    expect(h.agentTurns).toHaveLength(1);                      // one agent turn
    expect(rail.n.search).toBe(1);
  });

  it('barge-in preserved: tapping while the agent speaks stops TTS, marks it stale, and the new recording is a new turn', async () => {
    const h = await harness({ responses: [{ status: 200, body: { text: 'Kal Amritsar se Delhi jaana hai' } }, { status: 200, body: { text: 'RAC kya hota hai?' } }] });
    h.agent.listen(); await flush();
    await h.batch.finish();
    await h.settle();
    expect(h.agent.snapshot().state).toBe('SPEAKING');
    const firstTurn = h.agent.snapshot().activeTurnId;
    h.agent.listen(); await flush();                           // tap barge-in
    expect(h.tts.spoken.some(s => s.status === 'CANCELLED')).toBe(true);
    expect(h.events.some(e => e.type === 'SPEECH_CANCELLED')).toBe(true);
    expect(h.batch.currentPhase).toBe('RECORDING');
    await h.batch.finish();
    await h.settle();
    expect(h.agentTurns).toHaveLength(2);
    expect(h.agentTurns[1].text).toMatch(/RAC/);
    const spokenAfter = h.tts.spoken.filter(s => s.turnId === firstTurn && s.status === 'PLAYING');
    expect(spokenAfter).toHaveLength(0);                       // the old reply never resumes
  });
});
