import React, { useEffect, useState } from 'react';
import { IconRoute } from '../icons/Icons';
import { inr } from '../../lib/format';
import { discoverSameTrainAlternative, selectSameTrainAlternative, type SameTrainDiscoverResult, type SameTrainDiscoverProgress } from '../../lib/api';
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
/**
 * F3 — one polling job per (session, list, train, class): the backend's paced fair queue answers RUNNING + genuine
 * progress until the search is finished; every subscriber (card re-mounts) shares the same job and its last progress.
 */
export const SAME_TRAIN_POLL_MS = 2500;
let pollMs = SAME_TRAIN_POLL_MS;
/** tests only: shorter poll interval (real timers) */
export function setSameTrainPollMsForTests(ms: number | null): void { pollMs = ms ?? SAME_TRAIN_POLL_MS; }
const MAX_POLLS = 1000;                    // > the backend's queue deadline (30 min) at 2.5 s — then honest POLL_TIMEOUT
type Job = { promise: Promise<SameTrainDiscoverResult>; progress: SameTrainDiscoverProgress | null; listeners: Set<(p: SameTrainDiscoverProgress | null) => void> };
const discovered = new Map<string, Job>();
function discoverOnce(sessionId: string, trainNumber: string, travelClass: string, searchResultsVersion: number): Job {
  const key = `${sessionId}|${searchResultsVersion}|${trainNumber}|${travelClass}`;
  let job = discovered.get(key);
  if (!job) {
    const j: Job = { progress: null, listeners: new Set(), promise: Promise.resolve(null as any) };
    j.promise = (async () => {
      for (let i = 0; ; i++) {
        const r = await limited(() => discoverSameTrainAlternative(sessionId, { trainNumber, travelClass, searchResultsVersion }, { async: true }));
        if (r.code !== 'RUNNING') return r;
        j.progress = r.progress ?? null;
        j.listeners.forEach(l => l(j.progress));
        if (i >= MAX_POLLS) return { ok: false, code: 'POLL_TIMEOUT' };
        await new Promise(res => setTimeout(res, pollMs));
      }
    })();
    discovered.set(key, j);
    job = j;
  }
  return job;
}

/** A class chip that should get auto discovery (mirrors the backend gate; the backend decides). */
export function needsSameTrainDiscovery(status: unknown, passengers: number): boolean {
  const r = evaluateSeatShortage({ status: status ?? null, requestedPassengerCount: passengers > 0 ? passengers : 1 });
  // Phase 2 (findBoardFromEarlier): only a WAITLISTED class is searched (AVAILABLE / RAC / REGRET / CANCELLED never)
  return r.availabilityStatus === 'WAITLIST';
}

/** Phase 2: an option whose only provider answer was a too-old RAC / AVAILABLE snapshot — shown with ⚠ + age; Select = fresh re-check first. */
export function staleSelectable(a: any): boolean {
  const st = a?.staleSnapshot;
  if (!st || a.isRequestedPair || a.verificationStatus !== 'UNVERIFIED') return false;
  if (st.category === 'RAC') return true;
  if (st.category !== 'AVAILABLE') return false;
  const pax = Number(a.requestedPassengerCount ?? a.passengersCount) || 1;
  return evaluateSeatShortage({ status: st.status, requestedPassengerCount: pax }).sufficiency !== 'INSUFFICIENT';
}
export function staleOptionLine(a: any): string | null {
  const st = a?.staleSnapshot;
  if (!st || !staleSelectable(a)) return null;
  const at = staleTimeIST(st.providerUpdatedAt);
  return `⚠ Provider data ${at ? `${at} ka ` : ''}(${Number(st.ageMinutes) || 0} min purana) — Select par pehle fresh check hoga`;
}
const staleChipLabel = (a: any) => {
  const t = String(a?.staleSnapshot?.status || '');
  const m = t.match(/RAC\s*0*(\d+)/i);
  return `⚠ ${m ? `RAC ${m[1]}` : t || 'purana data'}`;
};

/** Phase 2 "better WL": fresh lower waitlist from an earlier station (backend-marked) — WL, never a confirmed seat; no Select. */
export function betterWaitlistOf(d: any): any[] {
  return ((d?.alternatives || []) as any[]).filter(a => a?.betterWaitlist && a.availability === 'WAITLIST');
}
export const BETTER_WL_HEADING = 'Kam waitlist · pehle station se (confirm seat nahi)';
export function betterWaitlistLine(a: any): string {
  const td = Number(a.ticketDateShiftDays) ? ` · ticket date ${shortDate(a.date)}` : '';
  return `${a.ticketOrigin} → ${a.ticketDestination} · ${a.travelClass} · WL ${a.betterWaitlist.waitlist} (direct WL ${a.betterWaitlist.directWaitlist})${td} — WL hai, confirm nahi`;
}
export const BetterWaitlistLines: React.FC<{ d: any }> = ({ d }) => {
  const list = betterWaitlistOf(d);
  if (!list.length) return null;
  return <div className="bk-sti bk-sti--bwl" role="status" data-testid="same-train-better-wl">
    <div className="bk-sti__head">{BETTER_WL_HEADING}</div>
    {list.map(a => <div key={a.alternativeId} className="bk-sti__meta">{betterWaitlistLine(a)}</div>)}
  </div>;
};

const FALLBACK_CODES = new Set(['BUDGET_EXCEEDED', 'SEARCH_FAILED', 'NETWORK', 'POLL_TIMEOUT']);
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
  const [state, setState] = useState<{ phase: 'idle' | 'loading' | 'done'; res?: SameTrainDiscoverResult; progress?: SameTrainDiscoverProgress | null }>({ phase: 'idle' });
  useEffect(() => {
    if (!visible || !sessionId || typeof searchResultsVersion !== 'number' || state.phase !== 'idle') return;
    let live = true;
    const job = discoverOnce(sessionId, trainNumber, travelClass || '', searchResultsVersion);
    setState({ phase: 'loading', progress: job.progress });
    const onProgress = (progress: SameTrainDiscoverProgress | null) => { if (live) setState(s => (s.phase === 'loading' ? { phase: 'loading', progress } : s)); };
    job.listeners.add(onProgress);
    job.promise.then(res => { if (live) setState({ phase: 'done', res }); });
    return () => { live = false; job.listeners.delete(onProgress); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, sessionId, trainNumber, travelClass, searchResultsVersion]);

  const fallbackBtn = onFallback
    ? <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm bk-sti__fallback" onClick={onFallback} disabled={disabled}
        aria-label={`Same train alternative for ${trainNumber}${travelClass ? ` ${travelClass}` : ''}`}>↗ Same Train Alternative</button>
    : null;
  if (state.phase === 'loading') return <SameTrainProgressView p={state.progress ?? null} />;
  if (state.phase !== 'done' || !state.res) return null;
  const res = state.res;
  if (!res.ok || !res.card) {
    if (!FALLBACK_CODES.has(res.code) || !onFallback) return null;
    // F3: a FAILED search is said as failed (provider error / limit), never as "no seat"
    // 2026-10-09: checks answered with a too-old provider snapshot → "fresh status confirm nahi" (never "no seat")
    const staleFailed = staleChecksOf(res);
    if (res.code === 'SEARCH_FAILED' && staleFailed.length) {
      return <div className="bk-sti bk-sti--failed bk-sti--stale" role="status"><div className="bk-sti__note">{SAME_TRAIN_STALE_NOTE}</div><StaleCheckLines list={staleFailed} />{fallbackBtn}</div>;
    }
    return res.code === 'SEARCH_FAILED' || res.code === 'POLL_TIMEOUT'
      ? <div className="bk-sti bk-sti--failed" role="status"><div className="bk-sti__note">{SAME_TRAIN_FAILED_NOTE}</div>{fallbackBtn}</div>
      : fallbackBtn;
  }
  const sum = checkSummaryOf(res.card);
  const stale = staleChecksOf(res.card);
  // same completeness rule as the server card view (an older card without searchComplete: not truncated and not partial)
  const complete = (res.card.searchComplete ?? (!res.card.candidatesTruncated && res.card.status !== 'PARTIAL')) === true && res.card.status !== 'PARTIAL';
  // P42-14: nothing verified AND the search could not check every station / class (rate limit / timeout) → say so honestly
  // (never "no seats"), with the existing tap action. F3: a COMPLETE search with nothing verified says so explicitly
  // (UNAVAILABLE ≠ pending / failed) — still never an empty option list.
  if (!groupRecoveryByPair(res.card, travelClass || res.card.travelClass).length) {
    if (res.card.status === 'PARTIAL' || !complete) {
      // provider errors / limits → the P42-14 note; no error but the search was bounded (truncated) → "not complete"
      // 2026-10-09: when every unchecked result is a too-old provider snapshot, say THAT (not "provider limit")
      const onlyStale = stale.length > 0 && !!sum && sum.unchecked <= stale.length;
      return <><div className="bk-sti bk-sti--partial" role="status">
          <div className="bk-sti__note">{onlyStale ? SAME_TRAIN_STALE_NOTE : res.card.status === 'PARTIAL' ? SAME_TRAIN_PARTIAL_NOTE : SAME_TRAIN_INCOMPLETE_NOTE}</div>
          {sum && sum.unchecked > 0 && <div className="bk-sti__meta">{partialCountText(sum)}</div>}
          <StaleCheckLines list={stale} />
          {fallbackBtn}
        </div><BetterWaitlistLines d={res.card} /></>;
    }
    return res.card.status === 'NOT_FOUND'
      ? <><div className="bk-sti bk-sti--none" role="status">{unavailableText(sum)}</div><BetterWaitlistLines d={res.card} /></>
      : null;
  }
  // Phase 2: a stale check already shown as a ⚠ option is not listed twice
  const shownStale = new Set(((res.card.alternatives || []) as any[]).filter(staleSelectable).map(a => `${a.ticketOrigin}-${a.ticketDestination}-${a.travelClass}`));
  const staleRest = stale.filter(c => !shownStale.has(`${c.ticketOrigin}-${c.ticketDestination}-${c.travelClass}`));
  return <>
    <SameTrainOptionList d={res.card} sessionId={sessionId} disabled={disabled || !!res.card.stale} onHandoff={onHandoff} heading={BFE_HEADING} requestedClass={travelClass || res.card.travelClass} showTrain />
    {/* F3: completion state under the options — a partial search is never labelled complete */}
    {complete
      ? sum && <div className="bk-sti__meta bk-sti__status" role="status">{completeText(sum)}</div>
      : <div className="bk-sti__note bk-sti__status" role="status">{sum && sum.unchecked > 0 ? partialCountText(sum) : SAME_TRAIN_INCOMPLETE_NOTE}</div>}
    {!complete && <StaleCheckLines list={staleRest} />}
    <BetterWaitlistLines d={res.card} />
  </>;
};

/** P42-14: shown when the same-train search was partial (provider limit / timeout) and nothing could be verified. */
export const SAME_TRAIN_PARTIAL_NOTE = 'Same train: provider limit ki wajah se kuch stations / classes abhi check nahi ho paaye — koi verified seat nahi mili.';
/** F3 state texts (PENDING / RUNNING / COMPLETED / UNAVAILABLE / PARTIAL / FAILED are never mixed up). */
export const SAME_TRAIN_QUEUED_TEXT = 'Same train: queue mein hai — provider limit ke andar baari aane par stations check honge…';
export const SAME_TRAIN_FAILED_NOTE = 'Same train search provider error ki wajah se poora nahi ho paaya — koi result verify nahi hua.';
export const SAME_TRAIN_INCOMPLETE_NOTE = 'Search poora nahi hua — kuch stations / classes check nahi ho paaye.';

/** F3: counts for the state line, from the backend's own check summary (falls back to the provider coverage). */
export function checkSummaryOf(d: any): { total: number; succeeded: number; unchecked: number; stale?: number } | null {
  const c = d?.checkSummary;
  if (c && Number.isFinite(Number(c.total))) {
    const total = Number(c.total), succeeded = Number(c.succeeded) || 0, stale = Number(c.stale) || 0;
    return { total, succeeded, unchecked: Math.max(0, total - succeeded), ...(stale > 0 ? { stale } : {}) };
  }
  const prov: any[] = Array.isArray(d?.providers) ? d.providers : [];
  if (!prov.length) return null;
  const total = prov.reduce((n, p) => n + (Number(p.requested) || 0), 0);
  const succeeded = prov.reduce((n, p) => n + (Number(p.succeeded) || 0), 0);
  return { total, succeeded, unchecked: Math.max(0, total - succeeded) };
}
export const completeText = (s: { total: number }) => `Saare ${s.total} checks complete.`;
export const partialCountText = (s: { total: number; unchecked: number; stale?: number }) => {
  const st = Math.min(Number(s.stale) || 0, s.unchecked);
  if (st <= 0) return `Search adhoora: ${s.unchecked} / ${s.total} checks provider limit / error ki wajah se nahi ho paaye — inke liye koi result nahi.`;
  if (st >= s.unchecked) return `Search adhoora: ${s.unchecked} / ${s.total} checks ka provider data purana tha — inke liye fresh result nahi.`;
  return `Search adhoora: ${s.unchecked} / ${s.total} checks verify nahi ho paaye (${st} purana provider data, ${s.unchecked - st} provider limit / error) — inke liye koi result nahi.`;
};

/** 2026-10-09: some checks came back with a provider snapshot older than the freshness limit — never "no seat". */
export const SAME_TRAIN_STALE_NOTE = 'Same train: kuch checks ka provider data purana hai — fresh status confirm nahi ho paaya, isliye "seat nahi hai" nahi keh sakte.';
export interface StaleCheckView { ticketOrigin: string; ticketDestination: string; travelClass: string; status: string; providerUpdatedAt: string; ageMinutes: number }
export function staleChecksOf(d: any): StaleCheckView[] {
  const l = Array.isArray(d?.staleChecks) ? d.staleChecks : [];
  return l.filter((c: any) => c && c.ticketOrigin && c.ticketDestination && c.travelClass);
}
/** Provider snapshot time in IST (HH:MM), or null when unparsable. */
export function staleTimeIST(iso: string): string | null {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return null;
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(t)); }
  catch { return null; }
}
export const staleLineText = (c: StaleCheckView) => {
  const at = staleTimeIST(c.providerUpdatedAt);
  return `${c.ticketOrigin} → ${c.ticketDestination} ${c.travelClass}: provider data ${at ? `${at} ka` : ''} (${Number(c.ageMinutes) || 0} min purana · ${c.status}) — fresh status confirm nahi ho paaya`.replace(/\s+/g, ' ');
};
export const StaleCheckLines: React.FC<{ list: StaleCheckView[] }> = ({ list }) => !list.length ? null : (
  <div className="bk-sti__stale">
    {list.map(c => <div key={`${c.ticketOrigin}-${c.ticketDestination}-${c.travelClass}`} className="bk-sti__meta">{staleLineText(c)}</div>)}
  </div>
);
export const unavailableText = (s: { total: number } | null) =>
  `Same train: ${s ? `saare ${s.total} checks complete` : 'search complete'} — is train mein waitlisted class ke liye koi verified seat nahi mili.`;

/** F3: PENDING (queued) / RUNNING (n of total, interim seats NOT selectable) — genuine counts from the backend. */
export const SameTrainProgressView: React.FC<{ p: SameTrainDiscoverProgress | null }> = ({ p }) => {
  if (!p || p.total === 0) {
    return <div className="bk-sti bk-sti--loading" role="status">{p ? SAME_TRAIN_QUEUED_TEXT : 'Same train: pehle ke stations aur classes check ho rahe hain…'}</div>;
  }
  if (p.state === 'QUEUED' && p.done === 0) {
    return <div className="bk-sti bk-sti--loading bk-sti--queued" role="status">{SAME_TRAIN_QUEUED_TEXT} <span className="bk-sti__meta">0 / {p.total}</span></div>;
  }
  const pct = Math.min(100, Math.round((p.done / Math.max(1, p.total)) * 100));
  return (
    <div className="bk-sti bk-sti--loading bk-sti--running" role="status" aria-live="polite">
      <div>Same train: {p.done} / {p.total} checks ho gaye — baaki check ho rahe hain…</div>
      <div className="bk-sti__bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}><span style={{ width: `${pct}%` }} /></div>
      {p.failed > 0 && <div className="bk-sti__meta">{p.failed} checks abhi provider error / limit se nahi ho paaye{p.retried > 0 ? ` · ${p.retried} retry` : ''}</div>}
      {p.found.length > 0 && (
        <div className="bk-sti__interim">
          <div className="bk-sti__meta">Ab tak mili (final verification baaki — abhi select nahi kar sakte):</div>
          {p.found.map(f => <div key={`${f.ticketOrigin}-${f.ticketDestination}-${f.travelClass}`} className="bk-sti__meta">{f.ticketOrigin} → {f.ticketDestination} · {f.travelClass} {f.status}</div>)}
        </div>
      )}
    </div>
  );
};

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
  const sameTrain = (a: any) => !train || a.trainNumber === undefined || String(a.trainNumber) === train;
  // Phase 2: fresh bookable options first, then options known only from a too-old snapshot (⚠, fresh re-check on Select)
  const opts = [...verifiedInRouteOrder(d).filter(a => canBookAvail(a) && sameTrain(a)), ...((d?.alternatives || []) as any[]).filter(a => staleSelectable(a) && sameTrain(a))];
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

/** 2026-10-09: an earlier-station ticket of the SAME run can carry another calendar date (12425: NDLS 19 Oct for an LDH 20 Oct boarding) */
export function ticketDateLine(a: any, d?: any): string | null {
  const shift = Number(a?.ticketDateShiftDays) || 0;
  if (a?.ticketDateUnverified && a?.date) return `Ticket date verify nahi hua (timetable mein din ki jaankari nahi) — ${shortDate(a.date)} maan kar check kiya`;
  if (!shift || !a?.date) return null;
  const journey = a.journeyDate || d?.date;
  const dep = a.ticketOriginDeparture ? ` ${String(a.ticketOriginDeparture).slice(0, 5)}` : '';
  return `Ticket date ${shortDate(a.date)} — train ${a.ticketOrigin} se${dep} isi run par chalti hai${journey ? ` (aapki boarding ${shortDate(journey)})` : ''}`;
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
      {ticketDateLine(a, d) && <div className="bk-sti__meta bk-sti__tdate" data-testid="same-train-ticket-date">{ticketDateLine(a, d)}</div>}
      <div className="bk-sti__board"><b>BOARD</b> {stn(boardCode, boardCode === g.ticketOrigin ? g.ticketOriginName : nameOf(d, boardCode))}
        {boardStop?.departure && <span className="bk-sti__time">dep {boardStop.departure}</span>}</div>
      <div className="bk-sti__chips" role="group" aria-label="Classes">
        {g.options.map((o, i) => {
          const rac = o.availability === 'RAC';
          const old = staleSelectable(o);
          const lbl = old ? staleChipLabel(o) : recoveryChipLabel(o);
          return (
            <button key={o.alternativeId} type="button" className={`bk-sti__chip${i === active ? ' is-active' : ''}${old ? ' is-stale' : ''}`} aria-pressed={i === active}
              disabled={disabled || busy} onClick={() => { setActive(i); setConfirm(false); setMsg(null); }}
              aria-label={`${o.travelClass} ${lbl}`}>
              <span className="bk-sti__cls">{o.travelClass}</span><span className={`bk-tag bk-tag--${rac || old ? 'warn' : 'good'}`}>{lbl}</span>
            </button>
          );
        })}
        {extras.map(c => <span key={c.code} className="bk-tag">{c.code} · {c.status}</span>)}
        {!confirm && (canBookAvail(a) || staleSelectable(a)) && (
          <button type="button" className="bk-btn bk-btn--primary bk-btn--sm bk-sti__use" disabled={disabled || busy || !sessionId}
            onClick={() => (a.verificationStatus === 'PARTIALLY_VERIFIED' || (staleSelectable(a) && (!ruleOk(a.boardingRuleStatus) || !ruleOk(a.alightingRuleStatus))) ? setConfirm(true) : use(false))}
            aria-label={`Select ${a.travelClass} ${a.ticketOrigin} to ${a.ticketDestination}`}>{busy ? 'Checking…' : staleSelectable(a) ? 'Fresh check + Select' : 'Select'}</button>
        )}
      </div>
      {staleOptionLine(a) && <div className="bk-sti__note bk-sti__stale" data-testid="same-train-stale-option">{staleOptionLine(a)}</div>}
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
