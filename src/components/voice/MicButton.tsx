import React from 'react';

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
}

const STATE_LABEL: Record<string, string> = {
  LISTENING: 'Sun raha hoon…', USER_SPEAKING: 'Sun raha hoon…', PROCESSING: 'Soch raha hoon…', SPEAKING: 'Bol raha hoon — beech mein bol sakte hain', INTERRUPTED: 'Ruk gaya — boliye'
};

export const MicButton: React.FC<Props> = ({ isRecording, isSupported, onStart, onStop, transcript, conversationMode, onToggleConversationMode, agentState, textFallback }) => {
  if (!isSupported) {
    return (
      <div style={{ padding: '12px 16px', color: '#9e9e9e', fontSize: 12, textAlign: 'center' }}>
        Voice input is not supported in your browser. Please type your message.
      </div>
    );
  }
  return (
    <div style={{ padding: '8px 16px' }}>
      <button
        onClick={isRecording ? onStop : onStart}
        style={{
          width: '100%',
          padding: '14px',
          borderRadius: 24,
          border: 'none',
          background: isRecording ? '#d32f2f' : '#1976d2',
          color: '#fff',
          fontWeight: 600,
          fontSize: 15,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          transition: 'background 0.2s'
        }}
      >
        <span style={{ fontSize: 20 }}>{isRecording ? '⏹️' : '🎙️'}</span>
        {isRecording ? (conversationMode ? 'Stop conversation' : 'Stop Recording') : 'Talk to AI'}
      </button>
      {onToggleConversationMode && (
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12, color: '#616161' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!conversationMode} onChange={(e) => onToggleConversationMode(e.target.checked)} />
            Conversation mode {conversationMode ? '(mic on — interrupt anytime)' : '(off — tap to talk)'}
          </label>
          {agentState && STATE_LABEL[agentState] && <span style={{ fontStyle: 'italic' }}>{STATE_LABEL[agentState]}</span>}
        </div>
      )}
      {textFallback && <div style={{ marginTop: 4, fontSize: 11, color: '#9e9e9e' }}>Voice output unavailable — replies are shown as text.</div>}
      {isRecording && transcript && (
        <div
          style={{
            marginTop: 8,
            padding: '8px 12px',
            background: '#f5f5f5',
            borderRadius: 8,
            fontSize: 13,
            color: '#616161',
            fontStyle: 'italic'
          }}
        >
          {transcript}
        </div>
      )}
    </div>
  );
};
