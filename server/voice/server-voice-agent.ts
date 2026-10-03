/**
 * PROMPT 21 — ConversationalVoiceAgent bound to the SAME ConversationTurnEngine that serves /api/chat (Part 31).
 * Used by tests and by any future server-side streaming voice transport. No second pipeline, no voice-only state:
 * every utterance is engine.processTurn(sessionId, text, 'VOICE'); turn events come from the engine's TurnEventBus.
 */
import { ConversationalVoiceAgent, type SpeechInput, type SpeechOutput, type VoiceAgentDeps, type TurnProcessor } from '@shared/voice/conversational-voice-agent';
import { turnEventToVoiceEvent } from '@shared/voice/voice-events';
import type { ConversationTurnEngine } from '../ai/turn-engine/conversation-turn-engine';

export interface EngineVoiceAgentOptions {
  engine: ConversationTurnEngine;
  sessionId: string;
  output: SpeechOutput;
  input?: SpeechInput;
  now?: () => number;
  detector?: VoiceAgentDeps['detector'];
  lang?: string;
}

/** Turn processor: the shared engine + this turn's events only (filtered by the turn the call started). */
export function engineTurnProcessor(engine: ConversationTurnEngine, sessionId: string): TurnProcessor {
  return async (text, o) => {
    let myTurn: string | null = null;
    const off = engine.events.subscribe(sessionId, ev => {
      if (!myTurn && ev.type === 'TURN_STARTED') myTurn = ev.turnId;
      if (ev.turnId !== myTurn) return;
      const v = turnEventToVoiceEvent(ev);
      if (v) o.onEvent(v);
    });
    try {
      const r = await engine.processTurn(sessionId, text, 'VOICE', { interruptPrevious: o.bargeIn });
      return r.voice;
    } finally { off(); }
  };
}

export function createEngineVoiceAgent(o: EngineVoiceAgentOptions): ConversationalVoiceAgent {
  return new ConversationalVoiceAgent({
    sessionId: o.sessionId,
    processTurn: engineTurnProcessor(o.engine, o.sessionId),
    output: o.output,
    input: o.input,
    now: o.now,
    detector: o.detector,
    lang: o.lang,
    interruptRemote: (reason) => { o.engine.interrupt(o.sessionId, reason === 'BARGE_IN' ? 'BARGE_IN' : 'USER_STOP' as any); }
  });
}
