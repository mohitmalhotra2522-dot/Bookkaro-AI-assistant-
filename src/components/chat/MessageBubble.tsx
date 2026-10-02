import React from 'react';
import type { ChatMessage } from '@shared/entities';

interface Props {
  message: ChatMessage;
}

export const MessageBubble: React.FC<Props> = ({ message }) => {
  const isUser = message.role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 12,
        padding: '0 16px'
      }}
    >
      <div
        style={{
          maxWidth: '80%',
          padding: '12px 16px',
          borderRadius: isUser ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
          background: isUser ? '#1976d2' : '#ffffff',
          color: isUser ? '#ffffff' : '#212121',
          boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
          fontSize: 15,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {message.content}
      </div>
    </div>
  );
};
