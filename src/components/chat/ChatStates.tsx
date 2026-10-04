import React from 'react';
import { BrandMark, IconAlert, IconClock, IconClose, IconRefresh, IconRoute, IconSearch, IconTrain } from '../icons/Icons';

/** Quick prompts — they only start the existing conversation flow (sent as a normal user message). */
export const QUICK_PROMPTS: Array<{ text: string; sub: string; icon: React.ReactNode }> = [
  { text: 'Amritsar se Delhi kal', sub: 'Plan a journey in Hinglish', icon: <IconRoute size={18} /> },
  { text: 'Morning trains to Delhi', sub: 'Find trains by time of day', icon: <IconClock size={18} /> },
  { text: 'Check seat availability', sub: 'For a train, date and class', icon: <IconSearch size={18} /> },
  { text: 'Track my train', sub: 'Live running status', icon: <IconTrain size={18} /> }
];

export const EmptyChat: React.FC<{ onPick: (text: string) => void; disabled?: boolean }> = ({ onPick, disabled }) => (
  <div className="bk-empty">
    <div className="bk-empty__avatar" aria-hidden="true"><BrandMark size={26} /></div>
    <h2>Where are you travelling today?</h2>
    <p className="bk-empty__say">Try saying <q>Amritsar se Delhi kal jaana hai</q></p>
    <div className="bk-suggest">
      {QUICK_PROMPTS.map(p => (
        <button key={p.text} type="button" className="bk-suggest__card" onClick={() => onPick(p.text)} disabled={disabled}>
          <span className="bk-suggest__icon">{p.icon}</span>
          <span>
            <span className="bk-suggest__title">{p.text}</span><br />
            <span className="bk-suggest__sub">{p.sub}</span>
          </span>
        </button>
      ))}
    </div>
  </div>
);

/** Shown while a turn is in flight. The label comes from real turn events (tool STARTED) — never invented. */
export const ThinkingIndicator: React.FC<{ label: string | null }> = ({ label }) => (
  <div className="bk-thinking" role="status" aria-live="polite">
    <div className="bk-msg__avatar" aria-hidden="true"><BrandMark size={16} /></div>
    <span className="bk-thinking__label">
      {label ? `${label.replace(/[.…]+$/, '')}…` : 'BookKaro is thinking…'}
      <span className="bk-dots" aria-hidden="true"><i /><i /><i /></span>
    </span>
  </div>
);

/** Calm, human error — never a status code, stack trace or raw provider message. */
export const ErrorBanner: React.FC<{ onRetry?: () => void; onDismiss: () => void }> = ({ onRetry, onDismiss }) => (
  <div className="bk-error" role="alert">
    <span className="bk-error__icon"><IconAlert size={18} /></span>
    <span className="bk-error__text">Something went wrong while reaching BookKaro. Your journey details are safe.</span>
    <span className="bk-error__actions">
      {onRetry && <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm" onClick={onRetry}><IconRefresh size={16} /> Try again</button>}
      <button type="button" className="bk-iconbtn" onClick={onDismiss} aria-label="Dismiss message"><IconClose size={18} /></button>
    </span>
  </div>
);
