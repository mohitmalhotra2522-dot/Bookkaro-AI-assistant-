import React, { useEffect, useRef } from 'react';
import { BrandMark, IconClose, IconCompose, IconHome, IconMenu, IconRoute, IconSettings } from '../icons/Icons';

export type StatusTone = 'good' | 'live' | 'warn' | 'bad' | 'busy' | 'idle';

export const StatusPill: React.FC<{ tone: StatusTone; label: string }> = ({ tone, label }) => (
  <span className="bk-status" role="status" aria-live="polite">
    <span className={`bk-dot${tone !== 'idle' ? ` bk-dot--${tone}` : ''}`} aria-hidden="true" />
    {label}
  </span>
);

interface TopBarProps {
  isChat: boolean;
  status: { tone: StatusTone; label: string };
  onHome: () => void;
  onNewChat: () => void;
  newChatDisabled?: boolean;
  onTrip?: () => void;
  onSettings: () => void;
  onMenu: () => void;
}

/** Compact top bar: brand on the left; New chat / Trip / status / settings on the right (menu on mobile). */
export const TopBar: React.FC<TopBarProps> = ({ isChat, status, onHome, onNewChat, newChatDisabled, onTrip, onSettings, onMenu }) => (
  <header className={`bk-topbar${isChat ? ' is-chat' : ''}`}>
    <div className="bk-topbar__inner">
      <button type="button" className="bk-brand" onClick={onHome} aria-label="BookKaro home">
        <span className="bk-brand__mark"><BrandMark size={18} /></span>
        <span className="bk-brand__text">
          <span className="bk-brand__name">BookKaro</span>
          <span className="bk-brand__sub">AI Railway Assistant</span>
        </span>
      </button>
      <span className="bk-topbar__spacer" />
      <nav className="bk-topbar__nav" aria-label="Main">
        <button type="button" className="bk-navbtn bk-only-desktop" onClick={onNewChat} disabled={newChatDisabled}><IconCompose size={18} /> New chat</button>
        {onTrip && <button type="button" className="bk-navbtn bk-only-desktop bk-trip-btn" onClick={onTrip}><IconRoute size={18} /> Trip</button>}
        <StatusPill tone={status.tone} label={status.label} />
        <button type="button" className="bk-iconbtn bk-only-desktop" onClick={onSettings} aria-label="Settings"><IconSettings size={20} /></button>
        <button type="button" className="bk-iconbtn bk-only-mobile" onClick={onMenu} aria-label="Open menu"><IconMenu size={22} /></button>
      </nav>
    </div>
  </header>
);

/** Bottom sheet on phones, side sheet on larger screens. Esc closes; focus moves into the sheet. */
export const Sheet: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [onClose]);
  return (
    <>
      <div className="bk-scrim" onClick={onClose} aria-hidden="true" />
      <div className="bk-sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="bk-sheet__grip" aria-hidden="true" />
        <div className="bk-sheet__head">
          <h2>{title}</h2>
          <button type="button" className="bk-iconbtn" onClick={onClose} aria-label="Close"><IconClose size={20} /></button>
        </div>
        <div className="bk-sheet__body">{children}</div>
      </div>
    </>
  );
};

export const MobileMenu: React.FC<{ onHome: () => void; onNewChat: () => void; newChatDisabled?: boolean; onTrip?: () => void; onSettings: () => void }> = ({ onHome, onNewChat, newChatDisabled, onTrip, onSettings }) => (
  <div className="bk-menu">
    <button type="button" className="bk-menu__item" onClick={onNewChat} disabled={newChatDisabled}><IconCompose size={20} /> New chat</button>
    {onTrip && <button type="button" className="bk-menu__item" onClick={onTrip}><IconRoute size={20} /> Trip details</button>}
    <button type="button" className="bk-menu__item" onClick={onHome}><IconHome size={20} /> Home</button>
    <button type="button" className="bk-menu__item" onClick={onSettings}><IconSettings size={20} /> Settings</button>
  </div>
);

const Switch: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }> = ({ checked, onChange, label, disabled }) => (
  <button type="button" role="switch" aria-checked={checked} aria-label={label} className="bk-switch" disabled={disabled} onClick={() => onChange(!checked)} />
);

export const SettingsPanel: React.FC<{
  conversationMode: boolean; onConversationMode: (on: boolean) => void; voiceSupported: boolean;
  sttLabel: string; ttsAvailable: boolean; dataLabel: string; showInspector: boolean; onInspector: (on: boolean) => void;
  /** P36-C.1.1: try device speech recognition first (enhanced recognition is the backup). */
  deviceSttSupported?: boolean; deviceSttFirst?: boolean; onDeviceSttFirst?: (on: boolean) => void;
}> = ({ conversationMode, onConversationMode, voiceSupported, sttLabel, ttsAvailable, dataLabel, showInspector, onInspector, deviceSttSupported, deviceSttFirst, onDeviceSttFirst }) => (
  <div>
    <div className="bk-setting">
      <div>
        <div className="bk-setting__label">Hands-free conversation</div>
        <div className="bk-setting__desc">Keeps the mic on so you can talk and interrupt anytime. Off by default — tap-to-talk otherwise.</div>
      </div>
      <Switch checked={conversationMode} onChange={onConversationMode} label="Hands-free conversation" disabled={!voiceSupported} />
    </div>
    <div className="bk-setting">
      <div>
        <div className="bk-setting__label">Voice</div>
        <div className="bk-setting__desc">Speech recognition: {sttLabel}<br />Spoken replies: {ttsAvailable ? 'available' : 'unavailable — replies shown as text'}</div>
      </div>
    </div>
    {onDeviceSttFirst && (
      <div className="bk-setting">
        <div>
          <div className="bk-setting__label">Use device speech recognition</div>
          <div className="bk-setting__desc">{deviceSttSupported ? 'Tries your browser’s own recognition first for tap-to-talk; switches to enhanced recognition if it fails.' : 'Not available in this browser — enhanced recognition is used.'}</div>
        </div>
        <Switch checked={!!deviceSttFirst && !!deviceSttSupported} onChange={onDeviceSttFirst} label="Use device speech recognition" disabled={!deviceSttSupported} />
      </div>
    )}
    <div className="bk-setting">
      <div>
        <div className="bk-setting__label">Railway data</div>
        <div className="bk-setting__desc">{dataLabel}</div>
      </div>
    </div>
    <div className="bk-setting">
      <div>
        <div className="bk-setting__label">Developer inspector</div>
        <div className="bk-setting__desc">Shows the raw session state for debugging.</div>
      </div>
      <Switch checked={showInspector} onChange={onInspector} label="Developer inspector" />
    </div>
  </div>
);
