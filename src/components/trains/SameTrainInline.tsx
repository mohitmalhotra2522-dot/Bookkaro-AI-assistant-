import React, { useEffect, useState } from 'react';
import { IconRoute } from '../icons/Icons';
import { inr } from '../../lib/format';
import { discoverSameTrainAlternative, selectSameTrainAlternative, type SameTrainDiscoverResult } from '../../lib/api';
import { evaluateSeatShortage, isVerifiedSameTrainAlternative } from '@shared/same-train-shortage';

/**
 * P42.7 — ONE automatic same-train recovery section per train card ("Same train · pehle station se board karo"):
 *   the backend searches all classes of the train over the bounded route matrix when the REQUESTED class (selected /
 *   named; unknown → any class) shows a shortage; verified options are grouped by ticket pair with class chips
 *   (AVL green, RAC amber; requested class first). Select = fresh recheck of that chip's own class, then apply.
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
  sessionId: string | null; trainNumber: string; travelClass?: string; searchResultsVersion?: number; visible: boolean;
  disabled?: boolean; onHandoff: (text: string) => void; onFallback?: () => void;
}> = ({ sessionId, trainNumber, travelClass, searchResultsVersion, visible, disabled, onHandoff, onFallback }) => {
  const [state, setState] = useState<{ phase: 'idle' | 'loading' | 'done'; res?: SameTrainDiscoverResult }>({ phase: 'idle' });
  useEffect(() => {
    if (!visible || !sessionId || typeof searchResultsVersion !== 'number' || state.phase !== 'idle') return;
    let live = true;
    setState({ phase: 'loading' });
    discoverOnce(sessionId, trainNumber, travelClass || '', searchResultsVersion).then(res => { if (live) setState({ phase: 'done', res }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId, trainNumber, travelClass, searchResultsVersion]);

  if (state.phase === 'loading') return <div className="bk-sti bk-sti--loading" role="status">Same train: pehle ke stations aur classes check ho rahe hain…</div>;
  if (state.phase !== 'done' || !state.res) return null;
  const res = state.res;
  if (!res.ok || !res.card) {
    return FALLBACK_CODES.has(res.code) && onFallback
      ? <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm bk-sti__fallback" onClick={onFallback} disabled={disabled}
          aria-label={`Same train alternative for ${trainNumber}${travelClass ? ` ${travelClass}` : ''}`}>↗ Same Train Alternative</button>
      : null;
  }
  // P42-14: nothing verified AND the search could not check every station / class (rate limit / timeout) → say so honestly
  // (never "no seats"), with the existing tap action; a COMPLETE search with nothing verified still shows nothing
  if (!groupRecoveryByPair(res.card, travelClass || res.card.travelClass).length) {
    return res.card.status === 'PARTIAL'
      ? <div className="bk-sti bk-sti--partial" role="status">
          <div className="bk-sti__note">{SAME_TRAIN_PARTIAL_NOTE}</div>
          {onFallback && <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm bk-sti__fallback" onClick={onFallback} disabled={disabled}
            aria-label={`Same train alternative for ${trainNumber}${travelClass ? ` ${travelClass}` : ''}`}>↗ Same Train Alternative</button>}
        </div>
      : null;
  }
  return <SameTrainOptionList d={res.card} sessionId={sessionId} disabled={disabled || !!res.card.stale} onHandoff={onHandoff} heading={BFE_HEADING} requestedClass={travelClass || res.card.travelClass} showTrain />;
};

/** P42-14: shown when the same-train search was partial (provider limit / timeout) and nothing could be verified. */
export const SAME_TRAIN_PARTIAL_NOTE = 'Same train: provider limit ki wajah se kuch stations / classes abhi check nahi ho paaye — koi verified seat nahi mili.';

/** P42.5 headings (Part 29): the earlier-boarding group is the BFE section; destination-only extensions are listed after it. */
export const BFE_HEADING = 'Same train · pehle station se board karo';
export const EXTENSION_HEADING = 'Same train · aage ke station tak ticket';
/** P42-14 (user decision 2026-10-09): nothing is cut — every verified option is listed (no cap). */
export const MAX_SAME_TRAIN_OPTIONS = Number.POSITIVE_INFINITY;
/** P42-14: options (ticket pairs) shown before "See other alternatives" */
export const SAME_TRAIN_PREVIEW = 3;

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

/** P42.7 — chip label from authoritative fields only: AVL n (exact provider count) / RAC n (position, never a seat). */
export function recoveryChipLabel(a: any): string {
  if (a?.availability === 'RAC') {
    const m = String(a.availabilityStatusText || '').match(/RAC\s*0*(\d+)/i);
    return m ? `RAC ${m[1]}` : 'RAC';
  }
  if (typeof a?.availableSeatCount === 'number') return `AVL ${a.availableSeatCount}`;
  return a?.availabilityStatusText || 'AVL';
}

export interface RecoveryPairGroup {
  key: string; earlier: boolean; ticketOrigin: string; ticketDestination: string; ticketOriginName?: string; ticketDestinationName?: string;
  /** verified class options of this ticket pair — requested class first, then the backend's class order */
  options: any[];
}

/**
 * P42.7 Parts 18/20/34 — verified options of THIS train grouped by ticket pair with class chips. Earlier-boarding pairs
 * (ticket origin ≠ requested origin) first, then destination-only extensions, in the backend's route order (no ranking).
 * Dedup: earlier pairs by bookFrom, extension pairs by bookUpto (first pair kept — P42.5 rule); at most 15 class options.
 */
export function groupRecoveryByPair(d: any, requestedClass?: string | null): RecoveryPairGroup[] {
  const train = String(d?.trainNumber || '');
  const req = String(requestedClass || d?.travelClass || '').toUpperCase();
  const opts = verifiedInRouteOrder(d).filter(a => canBookAvail(a) && (!train || a.trainNumber === undefined || String(a.trainNumber) === train));
  const groups = new Map<string, RecoveryPairGroup>();
  const pairOfStation = new Map<string, string>();
  for (const a of opts) {
    const earlier = a.ticketOrigin !== (a.requestedOrigin || d?.requestedOrigin);
    const dedup = earlier ? `E|${a.ticketOrigin}` : `X|${a.ticketDestination}`;
    const key = `${a.ticketOrigin}-${a.ticketDestination}`;
    const owner = pairOfStation.get(dedup);
    if (owner && owner !== key) continue;            // another pair already holds this bookFrom / bookUpto
    pairOfStation.set(dedup, key);
    let g = groups.get(key);
    if (!g) { g = { key, earlier, ticketOrigin: a.ticketOrigin, ticketDestination: a.ticketDestination, ticketOriginName: a.ticketOriginName, ticketDestinationName: a.ticketDestinationName, options: [] }; groups.set(key, g); }
    if (!g.options.some(o => String(o.travelClass) === String(a.travelClass))) g.options.push(a);
  }
  const all = [...groups.values()];
  for (const g of all) g.options.sort((x, y) => Number(String(y.travelClass).toUpperCase() === req) - Number(String(x.travelClass).toUpperCase() === req));
  const ordered = [...all.filter(g => g.earlier), ...all.filter(g => !g.earlier)];
  let left = MAX_SAME_TRAIN_OPTIONS;
  const out: RecoveryPairGroup[] = [];
  for (const g of ordered) { if (left <= 0) break; const options = g.options.slice(0, left); left -= options.length; out.push({ ...g, options }); }
  return out;
}

const shortDate = (iso?: string) => {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] || ''}`.trim();
};

/**
 * Same-train recovery section (shared by the automatic section under a train card and the expanded chat card).
 * Renders nothing when no verified option exists — never an empty section.
 */
export const SameTrainOptionList: React.FC<{ d: any; sessionId: string | null; disabled?: boolean; onHandoff: (text: string) => void; heading?: string; classTag?: string; requestedClass?: string | null; showTrain?: boolean }>
  = ({ d, sessionId, disabled, onHandoff, heading, classTag, requestedClass, showTrain }) => {
  const [all, setAll] = useState(false);
  const groupsAll = groupRecoveryByPair(d, requestedClass || classTag || d?.travelClass);
  if (!groupsAll.length) return null;
  // P42-14: first SAME_TRAIN_PREVIEW options (backend route order: earlier boarding, then further destination), then
  // "See other alternatives" reveals ALL the remaining verified options — purely local, no chat turn, nothing dropped
  const groups = all ? groupsAll : groupsAll.slice(0, SAME_TRAIN_PREVIEW);
  const hidden = groupsAll.length - groups.length;
  const earlier = groups.filter(g => g.earlier);
  const further = groups.filter(g => !g.earlier);
  const pax = Number(d?.requestedPassengerCount ?? d?.passengersCount) || null;
  const head = (text: string) => (
    <div className="bk-sti__head"><IconRoute size={13} /> {text}{d.isMock && <span className="bk-tag bk-tag--warn">Development data — not live</span>}</div>
  );
  return (
    <section className="bk-sti" aria-label={heading || BFE_HEADING}>
      {head(earlier.length > 0 ? BFE_HEADING : EXTENSION_HEADING)}
      {showTrain !== false && (d.trainNumber || d.trainName) && (
        <div className="bk-sti__train"><b>{d.trainNumber}</b>{d.trainName && <span> · {d.trainName}</span>}
          {(d.date || pax) && <span className="bk-sti__meta">{[shortDate(d.date), pax ? `${pax} passenger${pax > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ')}</span>}</div>
      )}
      {earlier.map(g => <PairOption key={g.key} d={d} g={g} sessionId={sessionId} disabled={disabled} onHandoff={onHandoff} />)}
      {earlier.length > 0 && further.length > 0 && head(EXTENSION_HEADING)}
      {further.map(g => <PairOption key={g.key} d={d} g={g} sessionId={sessionId} disabled={disabled} onHandoff={onHandoff} />)}
      {hidden > 0 && (
        <button type="button" className="bk-btn bk-btn--ghost bk-sti__more" onClick={() => setAll(true)} aria-expanded={false}>
          See other alternatives ({hidden}) →
        </button>
      )}
      {all && groupsAll.length > SAME_TRAIN_PREVIEW && (
        <button type="button" className="bk-btn bk-btn--ghost bk-sti__more" onClick={() => setAll(false)} aria-expanded={true}>
          Hide other alternatives ↑
        </button>
      )}
    </section>
  );
};

const PairOption: React.FC<{ d: any; g: RecoveryPairGroup; sessionId: string | null; disabled?: boolean; onHandoff: (t: string) => void }> = ({ d, g, sessionId, disabled, onHandoff }) => {
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const a = g.options[Math.min(active, g.options.length - 1)];
  const reqO = stn(d.requestedOrigin, d.requestedOriginName || nameOf(d, d.requestedOrigin));
  const reqD = stn(d.requestedDestination, d.requestedDestinationName || nameOf(d, d.requestedDestination));
  const boardCode = a.boardingStation || a.ticketOrigin;
  const boardStop = ((d?.route?.stations || []) as any[]).find(s => s.code === boardCode);
  const use = async (ack: boolean) => {
    if (!sessionId) return;
    setBusy(true); setMsg(null);
    // the chosen chip's OWN class is what the backend rechecks and applies (alternativeId binds train / pair / class)
    const r = await selectSameTrainAlternative(sessionId, { alternativeSearchId: d.alternativeSearchId, alternativeId: a.alternativeId, acknowledgeUnverifiedRules: ack });
    setBusy(false); setConfirm(false);
    if (r.ok && r.handoffText) { setMsg({ ok: true, text: r.message }); onHandoff(r.handoffText); } else setMsg({ ok: false, text: r.message });
  };
  const extras = extraClassChips(a).filter(c => !g.options.some(o => String(o.travelClass).toUpperCase() === c.code));
  return (
    <div className="bk-sti__opt">
      <div className="bk-sti__row">
        <span className="bk-sti__pair"><b>BOOK</b> {stn(g.ticketOrigin, g.ticketOriginName)} → {stn(g.ticketDestination, g.ticketDestinationName)}</span>
        {a.fare?.status === 'PROVIDER' && (a.fare.total ?? a.fare.perPassenger) != null && <span className="bk-sti__fare">{inr(a.fare.total ?? a.fare.perPassenger)}</span>}
      </div>
      <div className="bk-sti__board"><b>BOARD</b> {stn(boardCode, boardCode === g.ticketOrigin ? g.ticketOriginName : nameOf(d, boardCode))}
        {boardStop?.departure && <span className="bk-sti__time">dep {boardStop.departure}</span>}</div>
      <div className="bk-sti__chips" role="group" aria-label="Classes">
        {g.options.map((o, i) => {
          const rac = o.availability === 'RAC';
          return (
            <button key={o.alternativeId} type="button" className={`bk-sti__chip${i === active ? ' is-active' : ''}`} aria-pressed={i === active}
              disabled={disabled || busy} onClick={() => { setActive(i); setConfirm(false); setMsg(null); }}
              aria-label={`${o.travelClass} ${recoveryChipLabel(o)}`}>
              <span className="bk-sti__cls">{o.travelClass}</span><span className={`bk-tag bk-tag--${rac ? 'warn' : 'good'}`}>{recoveryChipLabel(o)}</span>
            </button>
          );
        })}
        {extras.map(c => <span key={c.code} className="bk-tag">{c.code} · {c.status}</span>)}
        {!confirm && canBookAvail(a) && (
          <button type="button" className="bk-btn bk-btn--primary bk-btn--sm bk-sti__use" disabled={disabled || busy || !sessionId}
            onClick={() => (a.verificationStatus === 'PARTIALLY_VERIFIED' ? setConfirm(true) : use(false))}
            aria-label={`Select ${a.travelClass} ${a.ticketOrigin} to ${a.ticketDestination}`}>{busy ? 'Checking…' : 'Select'}</button>
        )}
      </div>
      {!ruleOk(a.boardingRuleStatus) && <div className="bk-sti__note">{reqO} se boarding ka rule verify nahi hua</div>}
      {!ruleOk(a.alightingRuleStatus) && <div className="bk-sti__note">{reqD} par utarne ka rule verify nahi hua</div>}
      {confirm && (
        <div className="bk-sta-confirm" role="group" aria-label="Confirm unverified rule">
          <p>Boarding / deboarding rule verify nahi hua. Ticket stations ({stn(a.ticketOrigin, a.ticketOriginName)} → {stn(a.ticketDestination, a.ticketDestinationName)}, {a.travelClass}) se hi travel maan kar aage badhein?</p>
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
