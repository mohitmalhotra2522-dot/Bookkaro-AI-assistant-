import React, { useEffect, useState } from 'react';
import { IconRoute } from '../icons/Icons';
import { inr } from '../../lib/format';
import { discoverSameTrainAlternative, selectSameTrainAlternative, type SameTrainDiscoverResult } from '../../lib/api';
import { evaluateSeatShortage, isVerifiedSameTrainAlternative } from '@shared/same-train-shortage';

/**
 * P42.4 — AUTO "Same Train Alternative" under a waitlisted class chip (like an "alternate seat" hint).
 *   - asked only for a class whose OWN search status shows a shortage for this party; the backend re-checks that gate,
 *     enforces a per-list budget and picks the provider — the UI only asks when the card is on screen;
 *   - shows ONLY verified options (whole party AVAILABLE, or RAC — RAC keeps its "RAC n" tag) in route order: no ranking;
 *   - nothing verified → nothing shown; budget / failure → the existing "Same Train Alternative" tap action;
 *   - Select = fresh server recheck; on success the backend applies the ticket pair and the choice goes to chat.
 */

const MAX_CONCURRENT = 2;
let active = 0;
const waiters: Array<() => void> = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>(r => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}
const discovered = new Map<string, Promise<SameTrainDiscoverResult>>();
function discoverOnce(sessionId: string, trainNumber: string, travelClass: string, searchResultsVersion: number): Promise<SameTrainDiscoverResult> {
  const key = `${sessionId}|${searchResultsVersion}|${trainNumber}|${travelClass}`;
  let p = discovered.get(key);
  if (!p) { p = limited(() => discoverSameTrainAlternative(sessionId, { trainNumber, travelClass, searchResultsVersion })); discovered.set(key, p); }
  return p;
}

/** A class chip that should get auto discovery (mirrors the backend gate; the backend decides). */
export function needsSameTrainDiscovery(status: unknown, passengers: number): boolean {
  const r = evaluateSeatShortage({ status: status ?? null, requestedPassengerCount: passengers > 0 ? passengers : 1 });
  return r.shortage && !!r.triggerReason && r.triggerReason !== 'TRAIN_CANCELLED';
}

const FALLBACK_CODES = new Set(['BUDGET_EXCEEDED', 'SEARCH_FAILED', 'NETWORK']);
const stn = (code: string, name?: string) => (name ? String(name).replace(/\s+(Jn|Junction)\.?$/i, ' Jn') : code);
const nameOf = (d: any, code: string) => ((d?.route?.stations || []) as any[]).find(s => s.code === code)?.name;
const ruleOk = (r: string) => r === 'NOT_REQUIRED' || r === 'VERIFIED';

/** Verified options in the backend's route order (Muse's order only when Muse presented the result). */
export function verifiedInRouteOrder(d: any): any[] {
  const alts: any[] = (d?.alternatives || []).filter((a: any) => isVerifiedSameTrainAlternative(a));
  const order: string[] | undefined = d?.presentation?.decidedBy === 'MUSE' && Array.isArray(d.presentation.order) ? d.presentation.order : undefined;
  if (!order?.length) return alts;
  const pos = new Map(order.map((id, i) => [id, i]));
  return [...alts].sort((a, b) => (pos.get(a.alternativeId) ?? 999) - (pos.get(b.alternativeId) ?? 999));
}

export const SameTrainInline: React.FC<{
  sessionId: string | null; trainNumber: string; travelClass: string; searchResultsVersion?: number; visible: boolean;
  disabled?: boolean; onHandoff: (text: string) => void; onFallback?: () => void;
}> = ({ sessionId, trainNumber, travelClass, searchResultsVersion, visible, disabled, onHandoff, onFallback }) => {
  const [state, setState] = useState<{ phase: 'idle' | 'loading' | 'done'; res?: SameTrainDiscoverResult }>({ phase: 'idle' });
  useEffect(() => {
    if (!visible || !sessionId || typeof searchResultsVersion !== 'number' || state.phase !== 'idle') return;
    let live = true;
    setState({ phase: 'loading' });
    discoverOnce(sessionId, trainNumber, travelClass, searchResultsVersion).then(res => { if (live) setState({ phase: 'done', res }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId, trainNumber, travelClass, searchResultsVersion]);

  if (state.phase === 'loading') return <div className="bk-sti bk-sti--loading" role="status">{travelClass}: same train seats check ho rahe hain…</div>;
  if (state.phase !== 'done' || !state.res) return null;
  const res = state.res;
  if (!res.ok || !res.card) {
    return FALLBACK_CODES.has(res.code) && onFallback
      ? <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm bk-sti__fallback" onClick={onFallback} disabled={disabled}
          aria-label={`Same train alternative for ${trainNumber} ${travelClass}`}>↗ {travelClass}: Same Train Alternative</button>
      : null;
  }
  return <SameTrainOptionList d={res.card} sessionId={sessionId} disabled={disabled || !!res.card.stale} onHandoff={onHandoff} heading={BFE_HEADING} classTag={travelClass} />;
};

/** P42.5 headings (Part 29): the earlier-boarding group is the BFE section; destination-only extensions are listed after it. */
export const BFE_HEADING = 'Same train · pehle station se board karo';
export const EXTENSION_HEADING = 'Same train · aage ke station tak ticket';
export const MAX_SAME_TRAIN_OPTIONS = 15;

/**
 * P42.5 Part 32 — BookKaro's canBookAvail for a same-train option: AVAILABLE (whole party) and RAC can be booked;
 * WAITLIST / NOT_AVAILABLE / REGRET / UNKNOWN / unverified cannot (no Select button).
 */
export function canBookAvail(a: any): boolean {
  return isVerifiedSameTrainAlternative(a) && (a.availability === 'AVAILABLE' || a.availability === 'RAC');
}

/**
 * P42.5 Part 31 — extra class chips: only classes the provider actually returned for this option (a.classOptions),
 * never the hero class again, at most 3. BookKaro's same-train search is per class, so today this is usually empty.
 */
export function extraClassChips(a: any): Array<{ code: string; status: string }> {
  const hero = String(a?.travelClass || '').toUpperCase();
  const seen = new Set<string>([hero]);
  const out: Array<{ code: string; status: string }> = [];
  for (const c of (Array.isArray(a?.classOptions) ? a.classOptions : []) as any[]) {
    const code = String(c?.code || '').toUpperCase();
    const status = String(c?.statusText || c?.status || '').trim();
    if (!code || !status || seen.has(code)) continue;
    seen.add(code); out.push({ code, status });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * P42.5 Parts 29/34/40/41 — verified options of THIS train only, grouped: earlier boarding (ticket origin ≠ requested
 * origin) first, then destination-only extensions. Dedup: earlier group by trainNumber + bookFrom (ticketOrigin), the
 * extension group by trainNumber + bookUpto (ticketDestination); at most 15 options overall. Backend / Muse order kept.
 */
export function groupSameTrainOptions(d: any): { earlier: any[]; further: any[] } {
  const train = String(d?.trainNumber || '');
  const opts = verifiedInRouteOrder(d).filter(a => canBookAvail(a) && (!train || a.trainNumber === undefined || String(a.trainNumber) === train));
  const earlier: any[] = []; const further: any[] = [];
  const seen = new Set<string>();
  for (const a of opts) {
    const isEarlier = a.ticketOrigin !== (a.requestedOrigin || d?.requestedOrigin);
    const key = isEarlier ? `E|${a.trainNumber}|${a.ticketOrigin}` : `X|${a.trainNumber}|${a.ticketDestination}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (isEarlier ? earlier : further).push(a);
  }
  const both = [...earlier, ...further].slice(0, MAX_SAME_TRAIN_OPTIONS);
  return { earlier: both.filter(a => earlier.includes(a)), further: both.filter(a => further.includes(a)) };
}

/** Compact list of verified options (shared by the inline hint and the expanded chat card). Renders nothing if none. */
export const SameTrainOptionList: React.FC<{ d: any; sessionId: string | null; disabled?: boolean; onHandoff: (text: string) => void; heading?: string; classTag?: string }> = ({ d, sessionId, disabled, onHandoff, heading, classTag }) => {
  const { earlier, further } = groupSameTrainOptions(d);
  if (!earlier.length && !further.length) return null;
  const head = (text: string) => (
    <div className="bk-sti__head"><IconRoute size={13} /> {text}{classTag && <span className="bk-tag">{classTag}</span>}{d.isMock && <span className="bk-tag bk-tag--warn">Development data — not live</span>}</div>
  );
  return (
    <div className="bk-sti" aria-label={heading || BFE_HEADING}>
      {earlier.length > 0 && head(BFE_HEADING)}
      {earlier.map(a => <InlineOption key={a.alternativeId} d={d} a={a} sessionId={sessionId} disabled={disabled} onHandoff={onHandoff} />)}
      {further.length > 0 && head(EXTENSION_HEADING)}
      {further.map(a => <InlineOption key={a.alternativeId} d={d} a={a} sessionId={sessionId} disabled={disabled} onHandoff={onHandoff} />)}
    </div>
  );
};

const InlineOption: React.FC<{ d: any; a: any; sessionId: string | null; disabled?: boolean; onHandoff: (t: string) => void }> = ({ d, a, sessionId, disabled, onHandoff }) => {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const isRac = a.availability === 'RAC';
  // RAC keeps its own tag (amber, "RAC n" — never called a seat); AVAILABLE is green with the provider's status text
  const tag = a.availabilityStatusText || (isRac ? 'RAC' : 'Available');
  const reqO = stn(d.requestedOrigin, d.requestedOriginName || nameOf(d, d.requestedOrigin));
  const reqD = stn(d.requestedDestination, d.requestedDestinationName || nameOf(d, d.requestedDestination));
  const use = async (ack: boolean) => {
    if (!sessionId) return;
    setBusy(true); setMsg(null);
    const r = await selectSameTrainAlternative(sessionId, { alternativeSearchId: d.alternativeSearchId, alternativeId: a.alternativeId, acknowledgeUnverifiedRules: ack });
    setBusy(false); setConfirm(false);
    if (r.ok && r.handoffText) { setMsg({ ok: true, text: r.message }); onHandoff(r.handoffText); } else setMsg({ ok: false, text: r.message });
  };
  return (
    <div className="bk-sti__opt">
      <div className="bk-sti__row">
        <span className={`bk-tag bk-tag--${isRac ? 'warn' : 'good'}`}>{tag}</span>
        <span className="bk-sti__pair"><b>BOOK</b> {stn(a.ticketOrigin, a.ticketOriginName)} → {stn(a.ticketDestination, a.ticketDestinationName)}</span>
        {a.fare?.status === 'PROVIDER' && (a.fare.total ?? a.fare.perPassenger) != null && <span className="bk-sti__fare">{inr(a.fare.total ?? a.fare.perPassenger)}</span>}
        {extraClassChips(a).map(c => <span key={c.code} className="bk-tag">{c.code} · {c.status}</span>)}
        {!confirm && canBookAvail(a) && (
          <button type="button" className="bk-btn bk-btn--primary bk-btn--sm bk-sti__use" disabled={disabled || busy || !sessionId}
            onClick={() => (a.verificationStatus === 'PARTIALLY_VERIFIED' ? setConfirm(true) : use(false))}
            aria-label={`Select ${a.ticketOrigin} to ${a.ticketDestination}`}>{busy ? 'Checking…' : 'Select'}</button>
        )}
      </div>
      {!ruleOk(a.boardingRuleStatus) && <div className="bk-sti__note">{reqO} se boarding ka rule verify nahi hua</div>}
      {!ruleOk(a.alightingRuleStatus) && <div className="bk-sti__note">{reqD} par utarne ka rule verify nahi hua</div>}
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
