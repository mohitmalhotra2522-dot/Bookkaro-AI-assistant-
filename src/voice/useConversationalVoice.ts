/**
 * PROMPT 21 — React binding of the shared ConversationalVoiceAgent (browser adapters + HTTP turn processor).
 * The agent holds no booking state: every utterance goes through the same /api/chat pipeline as typed text.
 *
 * P36-C: tap-to-talk uses ElevenLabs Scribe v2 BATCH STT (server-side key) when GET /api/voice/config reports it
 * enabled: tap = record, tap again = submit ONCE → FINAL transcript → this SAME agent → turn detector → /api/chat.
 * Otherwise (and for the opt-in hands-free conversation mode) the existing browser recogniser is used.
 *
 * P36-C.1.1: enhanced (server) recognition stays primary; a user setting can try device (browser) recognition first,
 * automatically falling back to enhanced after a device-recognition failure. retrySpeech replays the SAME reply.
 */
const STT_PREF_KEY = 'bookkaro.sttPreference';
function loadSttPreference(): SttPreference {
  try { return window.localStorage.getItem(STT_PREF_KEY) === 'DEVICE_FIRST' ? 'DEVICE_FIRST' : 'ENHANCED_FIRST'; } catch { return 'ENHANCED_FIRST'; }
}
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConversationalVoiceAgent, type TurnProcessor, type VoiceAgentSnapshot } from '@shared/voice/conversational-voice-agent';
import { BrowserSpeechInput, BrowserSpeechOutput } from './browser-voice-adapters';
import { BatchSttSpeechInput, HybridSpeechInput, detectBrowserStt, sttErrorMessage, type BatchSttPhase, type SttPreference, type SttSource } from './batch-speech-input';
import { createPcmRecorder, pcmRecorderSupported } from './pcm-recorder';
import { fetchVoiceConfig, transcribeSpeech } from '../lib/api';

export function useConversationalVoice(o: { sessionId: string | null; processTurn: TurnProcessor; interruptRemote: (reason: 'BARGE_IN' | 'USER_STOP') => void }) {
  const procRef = useRef(o.processTurn);
  procRef.current = o.processTurn;
  const intRef = useRef(o.interruptRemote);
  intRef.current = o.interruptRemote;
  const [batchEnabled, setBatchEnabled] = useState(false);
  const { agent, input } = useMemo(() => {
    const sid = o.sessionId;
    const batch = new BatchSttSpeechInput({
      sessionId: () => sid, createRecorder: createPcmRecorder, recorderSupported: pcmRecorderSupported,
      transcribe: (req, signal) => transcribeSpeech(req, signal)
    });
    const input = new HybridSpeechInput(batch, new BrowserSpeechInput());
    const agent = new ConversationalVoiceAgent({
      sessionId: sid || 'pending',
      processTurn: (text, x) => procRef.current(text, x),
      output: new BrowserSpeechOutput(),
      input,
      interruptRemote: (r) => intRef.current(r)
    });
    return { agent, input };
  }, [o.sessionId]);
  const [snap, setSnap] = useState<VoiceAgentSnapshot>(() => agent.snapshot());
  const [sttPhase, setSttPhase] = useState<BatchSttPhase>('IDLE');
  const [inputError, setInputError] = useState<string | null>(null);
  const [sttPreference, setSttPreferenceState] = useState<SttPreference>(loadSttPreference);
  const [sttSource, setSttSource] = useState<SttSource | null>(null);
  const deviceSttSupported = useMemo(() => detectBrowserStt().supported, []);
  useEffect(() => { input.setPreference(sttPreference); }, [input, sttPreference]);
  // server STT capability (safe fields only — the key never reaches the browser)
  useEffect(() => {
    let live = true;
    fetchVoiceConfig().then(c => { if (live) setBatchEnabled(!!c?.stt?.enabled); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  useEffect(() => { input.batch.setEnabled(batchEnabled); setSnap(agent.snapshot()); }, [input, agent, batchEnabled]);
  useEffect(() => {
    setSnap(agent.snapshot());
    const off = agent.on((e) => {
      // a voice-input failure shows a short message; typing stays available. Cleared by the next utterance / turn.
      if (e.type === 'TEXT_FALLBACK' && e.reason !== 'TTS_FAILED') setInputError(e.reason);
      else if (e.type === 'TURN_SUBMITTED' || (e.type === 'STATE' && e.state === 'LISTENING')) setInputError(null);
      setSnap(agent.snapshot());
    });
    const offPhase = input.batch.onPhase(p => { setSttPhase(p); setSnap(agent.snapshot()); });
    const offSource = input.onSource(setSttSource);
    // end-of-turn detection runs only while the user-started mic session is open
    const iv = window.setInterval(() => { const st = agent.snapshot(); if (st.listening || st.state === 'USER_SPEAKING') { const p = agent.tick(); if (p) p.catch(() => undefined); } }, 100);
    return () => { off(); offPhase(); offSource(); window.clearInterval(iv); agent.cancel(); };
  }, [agent, input]);
  return {
    agent, snapshot: snap,
    /** P36-C: tap-to-talk batch STT phase (RECORDING → TRANSCRIBING), IDLE otherwise. */
    sttPhase,
    /** Short, safe message for the last voice-input failure (never a raw provider error). */
    inputErrorMessage: sttErrorMessage(inputError),
    batchSttEnabled: batchEnabled,
    /** P36-C.1.1: recogniser used for the current / last voice turn (never a provider name). */
    sttSource,
    sttPreference,
    deviceSttSupported,
    setSttPreference: useCallback((p: SttPreference) => {
      try { window.localStorage.setItem(STT_PREF_KEY, p); } catch { /* ignore */ }
      setSttPreferenceState(p);
    }, []),
    /** Replays the SAME last reply (no new turn, no LLM / tool call). */
    retrySpeech: useCallback(() => agent.retrySpeech(), [agent]),
    listen: useCallback(() => agent.listen(), [agent]),
    stop: useCallback(() => agent.cancel(), [agent]),
    /** Mic button "stop": in batch tap-to-talk this is the release (submit once); otherwise the one-tap stop. */
    release: useCallback(() => { if (!input.finish()) agent.cancel(); }, [agent, input]),
    setConversationMode: useCallback((on: boolean) => { agent.setConversationMode(on); if (on) agent.listen(); else agent.cancel(); setSnap(agent.snapshot()); }, [agent])
  };
}
