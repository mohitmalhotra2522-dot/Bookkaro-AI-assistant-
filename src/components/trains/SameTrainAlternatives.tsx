import React, { useMemo, useState } from 'react';
import { Sheet } from '../shell/Shell';
import { IconAlert, IconArrowRight, IconCheck, IconInfo, IconRefresh, IconRoute, IconShield, IconSparkle } from '../icons/Icons';
import { formatClock, formatDate, inr } from '../../lib/format';
import { selectSameTrainAlternative } from '../../lib/api';
import { isVerifiedSameTrainAlternative } from '@shared/same-train-shortage';
import { PROVIDER_TIMESTAMP_UNAVAILABLE_LABEL, isFreshnessUnverifiable } from '@shared/provider-freshness';
import { SameTrainOptionList } from './SameTrainInline';

/**
 * P42 — Same Train Alternative card + panel. Renders ONLY the backend's validated result:
 *   - the BEST MATCH badge appears only when Muse chose one (presentation.decidedBy === 'MUSE'); otherwise the neutral
 *     route order is shown — the UI never ranks;
 *   - BOARD / DEBOARD lines are shown only when the ticket station IS the travel station or a rule was VERIFIED;
 *     otherwise "Verification required" is shown — never "boarding allowed";
 *   - fares only from a provider; availability exactly as the provider said it; UNKNOWN ≠ "no seats";
 *   - "Use this option" runs a FRESH server revalidation, then hands the choice to the normal chat flow. Nothing is
 *     booked or changed in the booking from here.
 */

type Alt = any;

const AV_LABEL: Record<string, string> = { AVAILABLE: 'Available', RAC: 'RAC', WAITLIST: 'Waitlist', NOT_AVAILABLE: 'Not available', UNKNOWN: 'Not verified', CONFLICTING: 'Providers disagree' };
const AV_TONE: Record<string, string> = { AVAILABLE: 'good', RAC: 'warn', WAITLIST: 'warn', NOT_AVAILABLE: 'bad', UNKNOWN: 'navy', CONFLICTING: 'bad' };
const VER_LABEL: Record<string, string> = { VERIFIED: 'Verified', PARTIALLY_VERIFIED: 'Partly verified', UNVERIFIED: 'Unverified', CONFLICTING: 'Conflicting' };
const VER_TONE: Record<string, string> = { VERIFIED: 'good', PARTIALLY_VERIFIED: 'warn', UNVERIFIED: 'navy', CONFLICTING: 'bad' };

const stn = (code: string, name?: string) => (name ? `${String(name).replace(/\s+(Jn|Junction)\.?$/i, ' Jn')}` : code);
const availText = (a: Alt) => (a.availability === 'CONFLICTING' || a.availability === 'UNKNOWN' ? AV_LABEL[a.availability] : (a.availabilityStatusText || AV_LABEL[a.availability] || a.availability));
const nameOf = (d: any, code: string) => ((d.route?.stations || []) as any[]).find(s => s.code === code)?.name;

function orderedAlternatives(d: any): { best: Alt | null; original: Alt | null; others: Alt[] } {
  const alts: Alt[] = d.alternatives || [];
  const byId = new Map(alts.map(a => [a.alternativeId, a]));
  const muse = d.presentation?.decidedBy === 'MUSE';
  const best = muse && d.presentation?.bestMatchId ? byId.get(d.presentation.bestMatchId) || null : null;
  const original = alts.find(a => a.isRequestedPair) || null;
  const order: string[] = muse && Array.isArray(d.presentation?.order) && d.presentation.order.length ? d.presentation.order : alts.map(a => a.alternativeId);
  const others = order.map(id => byId.get(id)).filter((a): a is Alt => !!a && a !== best && a !== original);
  return { best, original, others };
}

export const SameTrainCard: React.FC<{ d: any; sessionId: string | null; disabled?: boolean; onHandoff: (text: string) => void; onCheckAgain?: () => void }> = ({ d, sessionId, disabled, onHandoff, onCheckAgain }) => {
  const [open, setOpen] = useState(false);
  const { best } = useMemo(() => orderedAlternatives(d), [d]);
  // P42.2: verified = another pair with seats for the WHOLE party (count ≥ passengers) or RAC — no verified option, no card
  const found = (d.alternatives || []).filter((a: Alt) => isVerifiedSameTrainAlternative(a)).length;
  if (!found) return null;
  return (
    <article className="bk-card bk-sta" aria-label="Same train alternatives">
      <div className="bk-sta__eyebrow"><IconRoute size={14} /> Same Train Alternative</div>
      <div className="bk-sta__title">
        <span className="bk-train__num">{d.trainNumber}</span>
        {d.trainName && <span className="bk-sta__name">{d.trainName}</span>}
      </div>
      <div className="bk-sta__sub">
        {stn(d.requestedOrigin, d.requestedOriginName)} → {stn(d.requestedDestination, d.requestedDestinationName)} · {d.travelClass} · {formatDate(d.date)} · {d.passengersCount} pax
      </div>
      <div className="bk-sta__tags">
        {d.isMock && <span className="bk-tag bk-tag--warn">Development data — not live</span>}
        {d.stale && <span className="bk-tag bk-tag--bad">Outdated — journey changed</span>}
        {d.status === 'PARTIAL' && <span className="bk-tag bk-tag--warn">Some checks failed</span>}
        <span className="bk-tag bk-tag--navy">{d.candidateCount} pairs checked</span>
        <span className="bk-tag bk-tag--good">{`${found} verified for ${d.passengersCount} pax`}</span>
      </div>
      {best && (
        <div className="bk-sta__preview">
          <span className="bk-sta__best"><IconSparkle size={13} /> Best match</span>
          <span className="bk-sta__line"><b>BOOK</b> {stn(best.ticketOrigin, best.ticketOriginName)} → {stn(best.ticketDestination, best.ticketDestinationName)}</span>
          <span className={`bk-tag bk-tag--${AV_TONE[best.availability] || 'navy'}`}>{availText(best)}</span>
        </div>
      )}
      {/* P42.4: verified options are shown expanded (route order, or Muse's order when Muse presented) — Select on each */}
      <SameTrainOptionList d={d} sessionId={sessionId} disabled={disabled || d.stale} onHandoff={onHandoff} showTrain={false} />
      <div className="bk-train__actions">
        <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm" onClick={() => setOpen(true)}>Full details <IconArrowRight size={15} /></button>
        {d.fetchedAt || d.completedAt ? <span className="bk-meta">Fetched {formatClock(d.completedAt || d.fetchedAt)}</span> : null}
      </div>
      {open && <SameTrainPanel d={d} sessionId={sessionId} disabled={disabled} onClose={() => setOpen(false)}
        onHandoff={t => { setOpen(false); onHandoff(t); }} onCheckAgain={onCheckAgain ? () => { setOpen(false); onCheckAgain(); } : undefined} />}
    </article>
  );
};

export const SameTrainPanel: React.FC<{ d: any; sessionId: string | null; disabled?: boolean; onClose: () => void; onHandoff: (text: string) => void; onCheckAgain?: () => void }> = ({ d, sessionId, disabled, onClose, onHandoff, onCheckAgain }) => {
  const { best, original, others } = useMemo(() => orderedAlternatives(d), [d]);
  const shownOthers = others.filter(a => a.verificationStatus !== 'INVALID');
  return (
    <Sheet title="Same Train Alternative" onClose={onClose}>
      <div className="bk-sta-panel">
        <div className="bk-sta-panel__head">
          <div className="bk-sta__title"><span className="bk-train__num">{d.trainNumber}</span>{d.trainName && <span className="bk-sta__name">{d.trainName}</span>}</div>
          <div className="bk-sta__sub">{d.travelClass} · {formatDate(d.date)} · {d.passengersCount} passenger{d.passengersCount > 1 ? 's' : ''}</div>
          <div className="bk-sta__sub">Your journey: <b>{stn(d.requestedOrigin, d.requestedOriginName)} → {stn(d.requestedDestination, d.requestedDestinationName)}</b></div>
          <div className="bk-sta__tags">
            {d.isMock && <span className="bk-tag bk-tag--warn">Development data — not live</span>}
            <span className="bk-tag bk-tag--navy">Route: {d.route?.provider}</span>
            {(d.providers || []).map((p: any) => (
              <span key={p.provider} className={`bk-tag bk-tag--${p.succeeded === p.requested ? 'good' : p.succeeded ? 'warn' : 'bad'}`}>{p.label || p.provider}: {p.succeeded}/{p.requested}</span>
            ))}
          </div>
        </div>

        {d.stale && (
          <div className="bk-sta-banner bk-sta-banner--bad" role="alert">
            <IconAlert size={16} /> <span>Journey badal gayi — yeh options purane hain. Dobara check karein.</span>
          </div>
        )}
        {d.route?.destinationSweep === 'NONE_TERMINAL' && (
          <div className="bk-sta-banner"><IconInfo size={15} /> <span>{stn(d.requestedDestination, d.requestedDestinationName)} is train ka last station hai — aage ke stations check nahi kiye.</span></div>
        )}

        {best && (
          <section aria-label="Best match">
            <h4 className="bk-sta-panel__h"><IconSparkle size={14} /> Best match</h4>
            <OptionCard d={d} a={best} highlight sessionId={sessionId} disabled={disabled || d.stale} onHandoff={onHandoff} />
          </section>
        )}
        {original && (
          <section aria-label="Your search">
            <h4 className="bk-sta-panel__h">Your search</h4>
            <OptionCard d={d} a={original} sessionId={sessionId} disabled hideUse onHandoff={onHandoff} />
          </section>
        )}
        {shownOthers.length > 0 && (
          <section aria-label="Other options">
            <h4 className="bk-sta-panel__h">{best ? 'Other options' : 'Options on the same train'}</h4>
            {shownOthers.map(a => <OptionCard key={a.alternativeId} d={d} a={a} sessionId={sessionId} disabled={disabled || d.stale} onHandoff={onHandoff} />)}
          </section>
        )}
        {d.invalidCount > 0 && <p className="bk-meta">{d.invalidCount} pair{d.invalidCount > 1 ? 's' : ''} hidden — provider answer did not match the request.</p>}

        <p className="bk-sta-foot"><IconShield size={14} /> Availability tezi se badalti hai — har option aage badhne se pehle dobara fresh check hota hai. Yahan se kuch book nahi hota.</p>
        {onCheckAgain && <button type="button" className="bk-btn bk-btn--ghost bk-btn--block" onClick={onCheckAgain} disabled={disabled}><IconRefresh size={15} /> Check again</button>}
      </div>
    </Sheet>
  );
};

const OptionCard: React.FC<{ d: any; a: Alt; highlight?: boolean; hideUse?: boolean; sessionId: string | null; disabled?: boolean; onHandoff: (t: string) => void }> = ({ d, a, highlight, hideUse, sessionId, disabled, onHandoff }) => {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // P42.2: fewer seats than passengers is never selectable (the fresh server recheck enforces it too)
  const actionable = (a.verificationStatus === 'VERIFIED' || a.verificationStatus === 'PARTIALLY_VERIFIED') && a.seatSufficiency !== 'INSUFFICIENT';
  const pax = Number(a.requestedPassengerCount ?? d.passengersCount);
  const ruleOk = (r: string) => r === 'NOT_REQUIRED' || r === 'VERIFIED';
  const reqO = stn(d.requestedOrigin, d.requestedOriginName || nameOf(d, d.requestedOrigin));
  const reqD = stn(d.requestedDestination, d.requestedDestinationName || nameOf(d, d.requestedDestination));
  const use = async (ack: boolean) => {
    if (!sessionId) return;
    setBusy(true); setMsg(null);
    const r = await selectSameTrainAlternative(sessionId, { alternativeSearchId: d.alternativeSearchId, alternativeId: a.alternativeId, acknowledgeUnverifiedRules: ack });
    setBusy(false); setConfirm(false);
    if (r.ok && r.handoffText) { setMsg({ ok: true, text: r.message }); onHandoff(r.handoffText); }
    else setMsg({ ok: false, text: r.message });
  };
  return (
    <div className={`bk-sta-opt${highlight ? ' is-best' : ''}`}>
      <div className="bk-sta-opt__top">
        <span className={`bk-tag bk-tag--${AV_TONE[a.availability] || 'navy'}`}>{availText(a)}</span>
        {a.verificationStatus && VER_LABEL[a.verificationStatus] && <span className={`bk-tag bk-tag--${VER_TONE[a.verificationStatus]}`}>{a.verificationStatus === 'VERIFIED' && <IconCheck size={12} />} {VER_LABEL[a.verificationStatus]}</span>}
        {a.fare?.status === 'PROVIDER' && (a.fare.total ?? a.fare.perPassenger) != null && (
          <span className="bk-sta-opt__fare">{inr(a.fare.total ?? a.fare.perPassenger)}{a.fare.total == null ? ' /pax' : ''}</span>
        )}
      </div>
      <div className="bk-sta-lines">
        <div className="bk-sta-row"><span className="bk-sta-k">BOOK</span><span className="bk-sta-v">{stn(a.ticketOrigin, a.ticketOriginName)} → {stn(a.ticketDestination, a.ticketDestinationName)}</span></div>
        {ruleOk(a.boardingRuleStatus)
          ? <div className="bk-sta-row"><span className="bk-sta-k">BOARD</span><span className="bk-sta-v">{stn(a.boardingStation, a.boardingStation === a.ticketOrigin ? a.ticketOriginName : nameOf(d, a.boardingStation))}</span></div>
          : <div className="bk-sta-row bk-sta-row--warn"><span className="bk-sta-k">VERIFY</span><span className="bk-sta-v">{reqO} se boarding ka rule verify nahi hua</span></div>}
        {ruleOk(a.alightingRuleStatus)
          ? <div className="bk-sta-row"><span className="bk-sta-k">DEBOARD</span><span className="bk-sta-v">{stn(a.alightingStation, a.alightingStation === a.ticketDestination ? a.ticketDestinationName : nameOf(d, a.alightingStation))}</span></div>
          : <div className="bk-sta-row bk-sta-row--warn"><span className="bk-sta-k">VERIFY</span><span className="bk-sta-v">{reqD} par utarne ka rule verify nahi hua</span></div>}
        {a.extensionStations > 0 && <div className="bk-sta-note">Ticket {reqD} se {a.extensionStations} station{a.extensionStations > 1 ? 's' : ''} aage tak</div>}
      </div>
      {isFreshnessUnverifiable(a.freshness) && <div className="bk-sta-note" data-testid="same-train-freshness-unverified">{PROVIDER_TIMESTAMP_UNAVAILABLE_LABEL}</div>}
      {a.seatSufficiency === 'INSUFFICIENT' && <div className="bk-sta-note bk-sta-note--bad">Sirf {a.availableSeatCount} seat{a.availableSeatCount === 1 ? '' : 's'} — {pax} passengers ke liye kaafi nahi</div>}
      {a.seatSufficiency === 'COUNT_NOT_PROVIDED' && <div className="bk-sta-note">Provider ne seat count nahi diya — {pax} passengers ke liye pakka nahi</div>}
      {a.conflict && <div className="bk-sta-note bk-sta-note--bad">{a.conflict.values.map((v: any) => `${v.provider}: ${v.status}`).join(' · ')} — koi value pakki nahi maani gayi</div>}
      {a.fare?.status === 'CONFLICTING' && <div className="bk-sta-note">Fare providers mein alag hai — fare nahi dikhaya</div>}
      <div className="bk-sta-evidence">
        {(a.evidence || []).map((e: any, i: number) => (
          <span key={i}>{e.providerLabel || e.provider}: {e.outcome === 'SUCCESS' ? e.status : e.outcome === 'TIMEOUT' ? 'timeout' : e.outcome === 'SKIPPED' ? 'skipped' : 'failed'}</span>
        ))}
        {(a.webEvidence || []).filter((w: any) => w.listed !== null).map((w: any, i: number) => (
          <span key={`w${i}`} className="bk-sta-web">{w.provider} (web, unverified): {w.listed ? 'listed' : 'not listed'}</span>
        ))}
      </div>
      {!hideUse && actionable && !confirm && (
        <button type="button" className="bk-btn bk-btn--primary bk-btn--sm bk-btn--block" disabled={disabled || busy || !sessionId}
          onClick={() => (a.verificationStatus === 'PARTIALLY_VERIFIED' ? setConfirm(true) : use(false))}>
          {busy ? 'Checking fresh availability…' : 'Use this option'}
        </button>
      )}
      {confirm && (
        <div className="bk-sta-confirm" role="group" aria-label="Confirm unverified rule">
          <p>Boarding / deboarding rule verify nahi hua. Ticket stations ({stn(a.ticketOrigin, a.ticketOriginName)} → {stn(a.ticketDestination, a.ticketDestinationName)}) se hi travel maan kar aage badhein?</p>
          <div className="bk-train__actions">
            <button type="button" className="bk-btn bk-btn--primary bk-btn--sm" disabled={busy} onClick={() => use(true)}>{busy ? 'Checking…' : 'Haan, aage badhein'}</button>
            <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div className={`bk-sta-note${msg.ok ? '' : ' bk-sta-note--bad'}`} role="status">{msg.text}</div>}
    </div>
  );
};
