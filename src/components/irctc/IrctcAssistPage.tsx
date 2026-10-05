import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getIrctcHandoff, irctcHandoffAction, postIrctcEvent, type IrctcOwnerAccess } from '../../lib/api';
import { IconAlert, IconCheck, IconClose, IconLock, IconShield, IconTrain } from '../icons/Icons';
import { formatClock } from '../../lib/format';

/**
 * P39 — IRCTC Assist page (works with OR without the BookKaro extension).
 * Shows the validated handoff values with copy buttons, the user-only boundary checklist, a language toggle, and
 * "Send to extension" (same-window postMessage — the bridge token never leaves this page otherwise).
 * BookKaro never asks for an IRCTC password, OTP, CAPTCHA or payment detail.
 */
const IRCTC_URL = 'https://www.irctc.co.in/nget/train-search';
const TERMINAL = new Set(['COMPLETED', 'BOOKING_FAILED', 'BOOKING_STATUS_UNKNOWN', 'EXPIRED', 'STALE_HANDOFF', 'STOPPED']);

interface Props { sessionId: string; onClose: () => void }

export const IrctcAssistPage: React.FC<Props> = ({ sessionId, onClose }) => {
  const [access, setAccess] = useState<IrctcOwnerAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [ext, setExt] = useState<{ ready: boolean; sent?: 'ok' | 'fail'; code?: string }>({ ready: false });
  const alive = useRef(true);

  const load = useCallback(async () => {
    const r = await getIrctcHandoff(sessionId);
    if (!alive.current) return;
    if (r.ok) { setAccess(r.access); setError(null); } else setError(r.message || r.code);
  }, [sessionId]);

  useEffect(() => {
    alive.current = true;
    load();
    const t = window.setInterval(load, 4000);
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin) return;
      const d: any = e.data || {};
      if (d.source !== 'bookkaro-extension') return;
      if (d.type === 'BK_EXTENSION_READY') setExt(x => ({ ...x, ready: true }));
      if (d.type === 'BK_IRCTC_HANDOFF_ACK') setExt(x => ({ ...x, ready: true, sent: d.ok ? 'ok' : 'fail', code: d.code }));
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ source: 'bookkaro-app', type: 'BK_PING' }, window.location.origin);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { alive.current = false; window.clearInterval(t); window.removeEventListener('message', onMsg); window.removeEventListener('keydown', onKey); };
  }, [load, onClose]);

  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); window.setTimeout(() => setCopied(c => (c === label ? null : c)), 1500); } catch { setCopied(null); }
  };
  const sendToExtension = () => {
    if (!access) return;
    window.postMessage({ source: 'bookkaro-app', type: 'BK_IRCTC_HANDOFF', handoffId: access.view.handoffId, bridgeToken: access.bridgeToken }, window.location.origin);
  };
  const setLanguage = async (language: 'en' | 'hi') => { await irctcHandoffAction(sessionId, { action: 'language', language }); load(); };
  const endedWithoutConfirmation = async () => {
    if (!access) return;
    await postIrctcEvent(access.view.handoffId, access.bridgeToken, { type: 'FLOW_ENDED_WITHOUT_CONFIRMATION' });
    load();
  };

  const v = access?.view; const s = access?.snapshot;
  const terminal = !!v && TERMINAL.has(v.status);
  const Row: React.FC<{ label: string; value: string | null | undefined; copyValue?: string; note?: string }> = ({ label, value, copyValue, note }) => (
    <div className="bk-irctc__row">
      <div><div className="bk-meta">{label}</div><div className="bk-irctc__val">{value || '—'}</div>{note && <div className="bk-meta">{note}</div>}</div>
      {value && <button type="button" className="bk-btn bk-btn--ghost bk-btn--sm" onClick={() => copy(label, copyValue ?? value)}>{copied === label ? 'Copied' : 'Copy'}</button>}
    </div>
  );

  return (
    <div className="bk-pform" role="dialog" aria-modal="true" aria-labelledby="bk-irctc-title">
      <header className="bk-pform__bar">
        <button type="button" className="bk-iconbtn" onClick={onClose} aria-label="Close IRCTC Assist"><IconClose size={20} /></button>
        <h2 id="bk-irctc-title">IRCTC Assist</h2>
        <span className="bk-pform__step">{v ? v.status.replace(/_/g, ' ') : '…'}</span>
      </header>
      <div className="bk-pform__body">
        {!access && !error && <div className="bk-meta" role="status">IRCTC handoff load ho raha hai…</div>}
        {error && <div className="bk-error" role="alert"><span className="bk-error__icon"><IconAlert size={18} /></span><span>{error}</span></div>}
        {v && s && (
          <>
            <section className="bk-card" aria-label="Status" style={{ padding: 14 }}>
              <p style={{ margin: 0 }}><strong>{v.message}</strong></p>
              <p className="bk-meta" style={{ margin: '6px 0 0' }}>Handoff valid till {formatClock(v.expiresAt)} · review v{v.reviewVersion}{v.lastPage ? ` · IRCTC page: ${v.lastPage}` : ''}</p>
              {v.mockData && <p className="bk-error" role="alert" style={{ marginTop: 8 }}>Ye handoff MOCK railway data se bana hai — real IRCTC par use mat kijiye.</p>}
              {v.notConfirmed.length > 0 && <p className="bk-meta" style={{ marginTop: 8 }}>Aap khud bhariye (IRCTC_FIELD_NOT_CONFIRMED): {[...new Set(v.notConfirmed.map(n => n.passengerIndex ? `${n.field} #${n.passengerIndex}` : n.field))].join(', ')}</p>}
              {v.userOverrides.length > 0 && <p className="bk-meta">Aapke apne edits (overwrite nahi kiye): {v.userOverrides.join(', ')}</p>}
            </section>

            <section className="bk-card" aria-label="You do these yourself" style={{ padding: 14 }}>
              <h3 style={{ marginTop: 0, display: 'flex', gap: 8, alignItems: 'center' }}><IconShield size={18} /> Ye aap khud karenge</h3>
              <ul className="bk-irctc__checklist">
                {s.userActions.map(a => <li key={a}><IconLock size={14} /> {a}</li>)}
              </ul>
              <p className="bk-meta">BookKaro kabhi password, OTP, CAPTCHA, card / UPI PIN nahi maangta. Final Book / Continue button sirf highlight hota hai — click aap karte hain.</p>
            </section>

            {!terminal && (
              <section className="bk-card" aria-label="Open IRCTC" style={{ padding: 14 }}>
                <div className="bk-irctc__lang" role="group" aria-label="IRCTC language">
                  <span className="bk-meta">IRCTC language:</span>
                  <button type="button" className={`bk-btn bk-btn--sm ${v.language === 'en' ? 'bk-btn--primary' : 'bk-btn--ghost'}`} onClick={() => setLanguage('en')}>English</button>
                  <button type="button" className={`bk-btn bk-btn--sm ${v.language === 'hi' ? 'bk-btn--primary' : 'bk-btn--ghost'}`} onClick={() => setLanguage('hi')}>हिंदी</button>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  <button type="button" className="bk-btn bk-btn--ghost" onClick={sendToExtension} disabled={!ext.ready}>
                    {ext.sent === 'ok' ? <><IconCheck size={14} /> Extension ko bhej diya</> : 'Send to extension'}
                  </button>
                  <a className="bk-btn bk-btn--primary" href={IRCTC_URL} target="_blank" rel="noopener noreferrer">Open IRCTC</a>
                </div>
                <p className="bk-meta" style={{ marginTop: 8 }}>
                  {ext.ready ? (ext.sent === 'fail' ? `Extension ne handoff accept nahi kiya (${ext.code || 'error'}).` : 'BookKaro extension mila — bhejne ke baad IRCTC kholiye, details fill ho jaayengi.')
                    : 'BookKaro extension nahi mila — neeche ki details copy karke IRCTC par bhariye (extension/README.md mein install steps).'}
                </p>
              </section>
            )}

            <section className="bk-card" aria-label="Journey" style={{ padding: 14 }}>
              <h3 style={{ marginTop: 0, display: 'flex', gap: 8, alignItems: 'center' }}><IconTrain size={18} /> Journey</h3>
              <Row label="From" value={s.journey.from.display || s.journey.from.code} copyValue={s.journey.from.code} note={`IRCTC box mein “${s.journey.from.code}” type karke “- ${s.journey.from.code}” wala station chuniye`} />
              <Row label="To" value={s.journey.to.display || s.journey.to.code} copyValue={s.journey.to.code} note={`“- ${s.journey.to.code}” wala station chuniye`} />
              <Row label="Journey date" value={s.journey.dateIrctc} />
              <Row label="Train" value={`${s.train.number}${s.train.name ? ` ${s.train.name}` : ''}`} copyValue={s.train.number} />
              <Row label="Class" value={s.travelClass.label || s.travelClass.code} copyValue={s.travelClass.code} />
              <Row label="Quota" value={s.quota.label} />
            </section>

            <section className="bk-card" aria-label="Passengers" style={{ padding: 14 }}>
              <h3 style={{ marginTop: 0 }}>Passengers ({s.passengers.length})</h3>
              {s.passengers.map(p => (
                <div key={p.index} className="bk-irctc__pax">
                  <Row label={`Passenger ${p.index} — name`} value={p.name} />
                  <div className="bk-meta">Age {p.age} · {p.gender ?? 'gender IRCTC par chuniye'}{p.berth ? ` · ${p.berth}` : ''}{p.food ? ` · ${p.food}` : ''}</div>
                </div>
              ))}
            </section>

            {!terminal && ['READY_FOR_USER_BOOK', 'CAPTCHA_REQUIRED', 'OTP_REQUIRED', 'PAYMENT_PAGE'].includes(v.status) && (
              <button type="button" className="bk-btn bk-btn--ghost" onClick={endedWithoutConfirmation}>IRCTC flow khatam — confirmation page nahi dikha</button>
            )}
          </>
        )}
      </div>
    </div>
  );
};

/** Inline chat card for the IRCTC handoff (status only — values live on the Assist page). */
export const IrctcHandoffCard: React.FC<{ d: any; onOpen: () => void }> = ({ d, onOpen }) => {
  if (d.status === 'UNAVAILABLE') {
    return (
      <section className="bk-card bk-handoff" aria-label="IRCTC handoff">
        <div className="bk-handoff__icon"><IconAlert size={22} /></div>
        <h3>IRCTC handoff nahi bana</h3>
        <p>{d.message}</p>
      </section>
    );
  }
  const terminal = TERMINAL.has(d.status);
  return (
    <section className="bk-card bk-handoff" aria-label="IRCTC handoff">
      <div className="bk-handoff__icon"><IconTrain size={22} /></div>
      <h3>{terminal ? `IRCTC handoff: ${String(d.status).replace(/_/g, ' ').toLowerCase()}` : 'IRCTC par continue karein'}</h3>
      <p>{d.message}</p>
      <p className="bk-meta">{d.trainNumber} · {d.travelClass} · {d.passengersCount} passenger{d.passengersCount === 1 ? '' : 's'} · valid till {formatClock(d.expiresAt)}</p>
      {d.mockData && <p className="bk-meta"><strong>MOCK data</strong> — real IRCTC par use mat kijiye.</p>}
      {!terminal && (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="bk-btn bk-btn--primary bk-btn--sm" onClick={onOpen}>Open IRCTC Assist</button>
        </div>
      )}
    </section>
  );
};
