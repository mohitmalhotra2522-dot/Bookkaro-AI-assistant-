import React, { useEffect, useRef } from 'react';
import { IconArrowUp, IconMic, IconMicOff, IconPlus, IconStop } from '../icons/Icons';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** Disables typing (same conditions as before: a turn in flight, or tap-to-talk recording). */
  inputDisabled?: boolean;
  sendDisabled?: boolean;
  placeholder?: string;
  variant?: 'hero' | 'dock';
  /** Voice input is supported/available in this browser/session. */
  micSupported: boolean;
  /** True while the mic session is open (recording / listening). */
  micLive: boolean;
  onMic: () => void;
  micLabel: string;
  onPlus?: () => void;
  autoFocus?: boolean;
  inputId?: string;
}

/** Persistent composer: [ + ] [ Type your journey… ] [ mic ] [ send ]. Enter sends, Shift+Enter adds a line. */
export const Composer: React.FC<Props> = ({
  value, onChange, onSubmit, inputDisabled, sendDisabled, placeholder, variant = 'dock',
  micSupported, micLive, onMic, micLabel, onPlus, autoFocus, inputId
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  // auto-grow (bounded by CSS max-height)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  return (
    <form
      className={`bk-composer${variant === 'hero' ? ' bk-composer--hero' : ''}`}
      onSubmit={(e) => { e.preventDefault(); if (!sendDisabled) onSubmit(); }}
    >
      {onPlus && (
        <button type="button" className="bk-composer__btn" onClick={onPlus} aria-label="Show suggestions">
          <IconPlus size={20} />
        </button>
      )}
      <label htmlFor={inputId} className="sr-only">Message BookKaro</label>
      <textarea
        id={inputId}
        ref={ref}
        rows={1}
        className="bk-composer__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!sendDisabled) onSubmit();
          }
        }}
        placeholder={placeholder || 'Type your journey…'}
        disabled={inputDisabled}
        autoFocus={autoFocus}
        enterKeyHint="send"
        autoComplete="off"
      />
      <button
        type="button"
        className={`bk-composer__btn bk-composer__mic${micLive ? ' is-live' : ''}`}
        onClick={onMic}
        disabled={!micSupported}
        aria-label={micSupported ? micLabel : 'Voice input is not available — you can type instead'}
        aria-pressed={micLive}
        title={micSupported ? micLabel : 'Voice input is not available in this browser'}
      >
        {!micSupported ? <IconMicOff size={20} /> : micLive ? <IconStop size={18} /> : <IconMic size={20} />}
      </button>
      <button type="submit" className="bk-composer__btn bk-composer__send" disabled={sendDisabled} aria-label="Send message">
        <IconArrowUp size={20} strokeWidth={2.2} />
      </button>
    </form>
  );
};
