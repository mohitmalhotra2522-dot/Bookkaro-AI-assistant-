import React from 'react';
import { BrandMark, IconMic, IconSparkle, IconTrain } from '../icons/Icons';
import { QUICK_PROMPTS } from '../chat/ChatStates';
import type { AppStatus } from '../../hooks/useAppStatus';

interface Props {
  composer: React.ReactNode;
  voicePanel?: React.ReactNode;
  onPrompt: (text: string) => void;
  promptsDisabled?: boolean;
  status: AppStatus;
  voiceAvailable: boolean;
  hasConversation: boolean;
  onResume: () => void;
}

/** Landing — one clear action: talk to BookKaro. Trust row reflects real capability only. */
export const HomeView: React.FC<Props> = ({ composer, voicePanel, onPrompt, promptsDisabled, status, voiceAvailable, hasConversation, onResume }) => {
  const trust: Array<{ tone: string; text: string }> = [];
  if (status.state === 'ok') {
    if (status.railwayKind === 'REAL') trust.push({ tone: 'live', text: 'Live railway data' });
    else if (status.railwayKind === 'MOCK') trust.push({ tone: 'warn', text: 'Development data — not live' });
    if (status.llmConfigured) trust.push({ tone: 'good', text: status.llmMock ? 'AI assistant (development mode)' : 'AI-powered search' });
  } else if (status.state === 'unavailable') {
    trust.push({ tone: 'bad', text: 'Railway service unreachable right now' });
  }
  trust.push(voiceAvailable ? { tone: 'good', text: 'Voice enabled' } : { tone: 'idle', text: 'Voice unavailable — typing works' });

  return (
    <div className="bk-home">
      <div className="bk-home__inner">
        <section className="bk-hero" aria-labelledby="bk-hero-title">
          <span className="bk-eyebrow"><IconSparkle size={14} /> AI Railway Assistant</span>
          <h1 id="bk-hero-title" className="bk-hero__title">Your journey starts with a conversation.</h1>
          <p className="bk-hero__lead">Tell BookKaro where you want to go, when you’re travelling, and what you need. I’ll find the right trains for you.</p>
        </section>

        <section className="bk-hero-card" aria-label="Talk to BookKaro">
          <div className="bk-hero-card__greet">
            <span className="bk-msg__avatar" aria-hidden="true" style={{ width: 36, height: 36, borderRadius: 12 }}><BrandMark size={18} /></span>
            <p>Hi! Where would you like to go?</p>
          </div>
          {voicePanel && <div style={{ marginBottom: 12 }}>{voicePanel}</div>}
          {composer}
          <div className="bk-try">
            <span className="bk-try__label">Try asking</span>
            {QUICK_PROMPTS.map(p => (
              <button key={p.text} type="button" className="bk-chip" onClick={() => onPrompt(p.text)} disabled={promptsDisabled}>{p.text}</button>
            ))}
          </div>
        </section>

        <div className="bk-trust" aria-label="Service status">
          {trust.map(t => <span key={t.text}><span className={`bk-dot${t.tone !== 'idle' ? ` bk-dot--${t.tone}` : ''}`} aria-hidden="true" />{t.text}</span>)}
        </div>

        {hasConversation && (
          <div className="bk-home__resume">
            <button type="button" className="bk-btn bk-btn--ghost" onClick={onResume}>Continue your conversation</button>
          </div>
        )}

        <section className="bk-features" aria-label="What BookKaro does">
          <div className="bk-feature">
            <span className="bk-feature__icon"><IconSparkle size={18} /></span>
            <h3>AI Booking Assistant</h3>
            <p>Just tell me your journey naturally. No complicated railway forms.</p>
          </div>
          <div className="bk-feature">
            <span className="bk-feature__icon"><IconTrain size={18} /></span>
            <h3>Live Train Information</h3>
            <p>Search trains, availability and fares using railway data.</p>
          </div>
          <div className="bk-feature">
            <span className="bk-feature__icon"><IconMic size={18} /></span>
            <h3>Voice First</h3>
            <p>Speak naturally in Hindi, Hinglish or English.</p>
          </div>
        </section>
      </div>
    </div>
  );
};
