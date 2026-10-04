import React from 'react';
import type { ChatMessage } from '@shared/entities';
import { BrandMark, IconMic } from '../icons/Icons';

interface Props {
  message: ChatMessage;
}

/**
 * Assistant turns read like a document (avatar + name + text, no bubble);
 * user turns are compact, right-aligned and visually lighter. The text shown is
 * exactly the text the backend returned (the same text TTS speaks).
 */
export const MessageBubble: React.FC<Props> = ({ message }) => {
  if (message.role === 'user') {
    return (
      <div className="bk-msg bk-msg--user">
        <div>
          <div className="bk-msg__bubble">{message.content}</div>
          {message.inputMode === 'VOICE' && (
            <div className="bk-msg__via"><IconMic size={12} /> Spoken</div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="bk-msg">
      <div className="bk-msg__avatar" aria-hidden="true"><BrandMark size={16} /></div>
      <div className="bk-msg__body">
        <div className="bk-msg__name">BookKaro</div>
        <div className="bk-msg__text">{message.content}</div>
      </div>
    </div>
  );
};
