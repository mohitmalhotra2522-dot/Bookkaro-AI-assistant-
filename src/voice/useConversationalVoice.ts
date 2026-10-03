/**
 * PROMPT 21 — React binding of the shared ConversationalVoiceAgent (browser adapters + HTTP turn processor).
 * The agent holds no booking state: every utterance goes through the same /api/chat pipeline as typed text.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConversationalVoiceAgent, type TurnProcessor, type VoiceAgentSnapshot } from '@shared/voice/conversational-voice-agent';
import { BrowserSpeechInput, BrowserSpeechOutput } from './browser-voice-adapters';

export function useConversationalVoice(o: { sessionId: string | null; processTurn: TurnProcessor; interruptRemote: (reason: 'BARGE_IN' | 'USER_STOP') => void }) {
  const procRef = useRef(o.processTurn);
  procRef.current = o.processTurn;
  const intRef = useRef(o.interruptRemote);
  intRef.current = o.interruptRemote;
  const agent = useMemo(() => new ConversationalVoiceAgent({
    sessionId: o.sessionId || 'pending',
    processTurn: (text, x) => procRef.current(text, x),
    output: new BrowserSpeechOutput(),
    input: new BrowserSpeechInput(),
    interruptRemote: (r) => intRef.current(r)
  }), [o.sessionId]);
  const [snap, setSnap] = useState<VoiceAgentSnapshot>(() => agent.snapshot());
  useEffect(() => {
    setSnap(agent.snapshot());
    const off = agent.on(() => setSnap(agent.snapshot()));
    // end-of-turn detection runs only while the user-started mic session is open
    const iv = window.setInterval(() => { const st = agent.snapshot(); if (st.listening || st.state === 'USER_SPEAKING') { const p = agent.tick(); if (p) p.catch(() => undefined); } }, 100);
    return () => { off(); window.clearInterval(iv); agent.cancel(); };
  }, [agent]);
  return {
    agent, snapshot: snap,
    listen: useCallback(() => agent.listen(), [agent]),
    stop: useCallback(() => agent.cancel(), [agent]),
    setConversationMode: useCallback((on: boolean) => { agent.setConversationMode(on); if (on) agent.listen(); else agent.cancel(); setSnap(agent.snapshot()); }, [agent])
  };
}
