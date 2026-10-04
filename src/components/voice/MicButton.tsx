import React from 'react';
import { IconClose, IconMic, IconStop } from '../icons/Icons';

/**
 * Voice status panel. Purely presentational: every label and animation is driven by the
 * EXISTING voice agent snapshot (state / listening / partialTranscript / textFallback) and the
 * P36-C batch STT phase. Rings animate only while the agent is really listening or speaking —
 * there is no fake audio level. Tap semantics are unchanged: tap = start, tap again = send
 * (batch STT) / stop, and a tap while BookKaro speaks is the barge-in handled by the agent.
 */
interface Props {
  isRecording: boolean;
  isSupported: boolean;
  onStart: () => void;
  onStop: () => void;
  transcript: string;
  /** Prompt 21: opt-in hands-free conversation mode (visible; one tap turns it off). */
  conversationMode?: boolean;
  onToggleConversationMode?: (on: boolean) => void;
  agentState?: string;
  /** TTS unavailable / failed → replies are shown as text only. */
  textFallback?: boolean;
  /** P36-C: batch tap-to-talk phase — RECORDING (tap again to send) / TRANSCRIBING (tap to cancel). */
  sttPhase?: 'IDLE' | 'RECORDING' | 'TRANSCRIBING';
  /** P36-C: short, safe voice-input failure message (typing stays available). */
  inputError?: string | null;
  /** Contextual progress label from real turn events (tool STARTED), when available. */
  progressLabel?: string | null;
  /** P36-C.1.1: which recogniser is listening (never a provider name). */
  sttSource?: 'DEVICE' | 'ENHANCED' | null;
  /** P36-C.1.1: replay the same last reply after a playback failure (no new turn). */
  onRetrySpeech?: () => void;
}

export const STT_SOURCE_LABEL = { DEVICE: 'Using device speech recognition', ENHANCED: 'Using enhanced speech recognition' } as const;

export type VoiceVisual = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'interrupted';

/** Maps the real agent state + STT phase to one visual state (batch STT phases take precedence). */
export function voiceVisual(p: { isRecording: boolean; agentState?: string; sttPhase?: string }): VoiceVisual {
  if (p.sttPhase === 'TRANSCRIBING') return 'transcribing';
  if (p.sttPhase === 'RECORDING') return 'listening';
  switch (p.agentState) {
    case 'LISTENING': case 'USER_SPEAKING': return 'listening';
    case 'PROCESSING': return 'thinking';
    case 'SPEAKING': return 'speaking';
    case 'INTERRUPTED': return 'interrupted';
    default: return p.isRecording ? 'listening' : 'idle';
  }
}

const COPY: Record<VoiceVisual, { title: string; sub: string }> = {
  idle: { title: 'Tap to speak', sub: 'Hindi, Hinglish or English' },
  listening: { title: 'Listening…', sub: 'Tap again when you’re done' },
  transcribing: { title: 'Understanding…', sub: 'Turning your voice into text' },
  thinking: { title: 'Finding the best option…', sub: 'Tap to interrupt' },
  speaking: { title: 'BookKaro is speaking…', sub: 'Tap to interrupt' },
  interrupted: { title: 'Stopped — go ahead', sub: 'Tap to speak' }
};

export const MicButton: React.FC<Props> = ({
  isRecording, isSupported, onStart, onStop, transcript, conversationMode, onToggleConversationMode,
  agentState, textFallback, sttPhase, inputError, progressLabel, sttSource, onRetrySpeech
}) => {
  const v = voiceVisual({ isRecording, agentState, sttPhase });
  const copy = COPY[v];
  const title = v === 'thinking' && progressLabel ? `${progressLabel.replace(/[.…]+$/, '')}…` : copy.title;
  const orbClass = v === 'idle' || v === 'interrupted' ? 'is-idle' : v === 'listening' ? 'is-listening' : v === 'speaking' ? 'is-speaking' : 'is-busy';
  const orbLabel =
    sttPhase === 'RECORDING' ? 'Send recording' :
    sttPhase === 'TRANSCRIBING' ? 'Cancel transcription' :
    isRecording ? (conversationMode ? 'Stop conversation' : 'Stop listening') :
    v === 'speaking' || v === 'thinking' ? 'Interrupt BookKaro and speak' : 'Start speaking';

  if (!isSupported) return null;

  return (
    <div className="bk-voice" role="region" aria-label="Voice conversation">
      <button type="button" className={`bk-voice__orb ${orbClass}`} onClick={isRecording ? onStop : onStart} aria-label={orbLabel}>
        <span className="bk-voice__ring" /><span className="bk-voice__ring" />
        {isRecording ? <IconStop size={22} /> : <IconMic size={24} />}
      </button>
      <div className="bk-voice__text" aria-live="polite">
        <div className="bk-voice__title">
          {title}
          {conversationMode && <span className="bk-hands-free">Hands-free on</span>}
        </div>
        {isRecording && transcript
          ? <div className="bk-voice__transcript">“{transcript}”</div>
          : <div className="bk-voice__sub">{sttPhase === 'RECORDING' ? 'Tap again to send' : conversationMode && (v === 'listening' || v === 'speaking') ? (v === 'speaking' ? 'Speak anytime to interrupt' : 'Mic is on — speak naturally') : copy.sub}</div>}
        {inputError && <div className="bk-voice__error" role="status">{inputError}</div>}
        {sttSource && (v === 'listening' || v === 'transcribing') && <div className="bk-voice__source">{STT_SOURCE_LABEL[sttSource]}</div>}
        {textFallback && (onRetrySpeech
          ? <div className="bk-voice__sub bk-voice__sub--wrap">Couldn’t play the reply — it’s shown as text. <button type="button" className="bk-link" onClick={onRetrySpeech}>Play again</button></div>
          : <div className="bk-voice__sub">Voice replies unavailable — showing text</div>)}
      </div>
      <div className="bk-voice__actions">
        {conversationMode && onToggleConversationMode ? (
          <button type="button" className="bk-btn bk-btn--ghost bk-btn--sm" onClick={() => onToggleConversationMode(false)}>Turn off</button>
        ) : (isRecording || sttPhase === 'TRANSCRIBING') ? null : (
          v !== 'idle' && <button type="button" className="bk-iconbtn" onClick={onStop} aria-label="Close voice panel"><IconClose size={18} /></button>
        )}
      </div>
    </div>
  );
};
