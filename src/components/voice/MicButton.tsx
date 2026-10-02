import React from 'react';

interface Props {
  isRecording: boolean;
  isSupported: boolean;
  onStart: () => void;
  onStop: () => void;
  transcript: string;
}

export const MicButton: React.FC<Props> = ({ isRecording, isSupported, onStart, onStop, transcript }) => {
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
        {isRecording ? 'Stop Recording' : 'Talk to AI'}
      </button>
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
