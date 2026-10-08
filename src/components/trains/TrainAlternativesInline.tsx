import React, { useEffect, useState } from 'react';
import { fetchTrainAlternatives, type TrainAlternativesResult, type TrainAlternativeView } from '../../lib/api';
import { availabilityTone } from '../../lib/format';

/**
 * P42-13 — inline train alternatives under a qualifying (shortage) train card.
 * The list is the OTHER trains of the SAME current search result set, in the search order (no ranking), as returned by
 * the read-only backend builder. Loading / expand / collapse / View all are purely local: no chat message, no LLM turn,
 * no TTS. [Select] hands the train number to the existing selection flow (onSelectTrain). Any failure or an empty list
 * renders nothing. A response for another search result version (late / stale) is discarded.
 */
export const ALT_PREVIEW = 3;

interface Props {
  sessionId: string | null;
  trainNumber: string;
  searchResultsVersion?: number;
  /** lazy: fetch once the card has been on screen */
  visible: boolean;
  disabled?: boolean;
  onSelectTrain: (trainNumber: string) => void;
}

// module cache: one read per session | result version | train (the builder is a local projection — cheap — but the
// list must not refetch on every re-render); a refresh on expand picks up newer CHECK evidence (evidenceKey)
const cache = new Map<string, TrainAlternativesResult>();
const inflight = new Map<string, Promise<TrainAlternativesResult>>();
const keyOf = (sessionId: string, version: number, train: string) => `${sessionId}|${version}|${train}`;
function load(sessionId: string, version: number, train: string, refresh = false): Promise<TrainAlternativesResult> {
  const k = keyOf(sessionId, version, train);
  if (!refresh && cache.has(k)) return Promise.resolve(cache.get(k)!);
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = fetchTrainAlternatives(sessionId, { trainNumber: train, searchResultsVersion: version })
    .then(r => { if (r.ok && r.code === 'OK' && r.searchResultsVersion === version) cache.set(k, r); return r; })
    .finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}
/** test hook */
export function __resetTrainAlternativesCache() { cache.clear(); inflight.clear(); }

export const TrainAlternativesInline: React.FC<Props> = ({ sessionId, trainNumber, searchResultsVersion, visible, disabled, onSelectTrain }) => {
  const [data, setData] = useState<TrainAlternativesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const ready = !!sessionId && typeof searchResultsVersion === 'number' && visible;

  // a new result version (new search / date / route change) resets the section
  useEffect(() => { setData(null); setOpen(false); setAll(false); }, [sessionId, searchResultsVersion, trainNumber]);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const k = keyOf(sessionId!, searchResultsVersion!, trainNumber);
    if (!cache.has(k)) setLoading(true);
    load(sessionId!, searchResultsVersion!, trainNumber).then(r => {
      if (!live) return;
      setLoading(false);
      // late / stale response → discarded (never shown against another result set)
      setData(r.ok && r.code === 'OK' && r.searchResultsVersion === searchResultsVersion ? r : null);
    });
    return () => { live = false; };
  }, [ready, sessionId, searchResultsVersion, trainNumber]);

  // expand → silent background refresh (labels follow a newer CHECK of an alternative); never a chat turn
  useEffect(() => {
    if (!open || !ready) return;
    let live = true;
    load(sessionId!, searchResultsVersion!, trainNumber, true).then(r => {
      if (!live || !(r.ok && r.code === 'OK' && r.searchResultsVersion === searchResultsVersion)) return;
      setData(prev => (prev && prev.evidenceKey === r.evidenceKey && prev.total === r.total ? prev : r));
    });
    return () => { live = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) return null;
  if (loading && !data) return <div className="bk-alt bk-alt--loading" role="status">Finding alternatives…</div>;
  if (!data || !data.total || !data.alternatives.length) return null;

  const n = data.total;
  const shown = all ? data.alternatives : data.alternatives.slice(0, ALT_PREVIEW);
  const label = `${n} alternative${n === 1 ? '' : 's'} available`;
  return (
    <section className="bk-alt" aria-label={`Alternatives to train ${trainNumber}`}>
      <button type="button" className="bk-alt__toggle" aria-expanded={open} onClick={() => { setOpen(o => !o); setAll(false); }}>
        {label} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <>
          <ul className="bk-alt__list">
            {shown.map(a => <AltRow key={a.trainNumber} alt={a} disabled={disabled} onSelect={() => onSelectTrain(a.trainNumber)} />)}
          </ul>
          {n > ALT_PREVIEW && !all && (
            <button type="button" className="bk-btn bk-btn--ghost bk-alt__more" onClick={() => setAll(true)}>
              View all alternatives ({n}) →
            </button>
          )}
          {n > ALT_PREVIEW && all && (
            <button type="button" className="bk-btn bk-btn--ghost bk-alt__more" onClick={() => setAll(false)}>
              Hide alternatives ↑
            </button>
          )}
        </>
      )}
    </section>
  );
};

const AltRow: React.FC<{ alt: TrainAlternativeView; disabled?: boolean; onSelect: () => void }> = ({ alt, disabled, onSelect }) => (
  <li className="bk-alt__item" data-train={alt.trainNumber}>
    <div className="bk-alt__head">
      <b className="bk-alt__num">{alt.trainNumber}</b>
      <span className="bk-alt__name">{alt.trainName}</span>
    </div>
    <div className="bk-alt__time">
      {(alt.departure || '—')} → {(alt.arrival || '—')}{alt.duration ? ` · ${alt.duration}` : ''}
    </div>
    {alt.classes.length > 0 && (
      <div className="bk-alt__classes">
        {alt.classes.map(c => (
          <span key={c.code} className="bk-alt__cls">
            <span className="bk-alt__code">{c.code}</span>
            {c.status && <span className={`bk-class__avail bk-class__avail--${availabilityTone(c.status)}`}>{c.status}</span>}
          </span>
        ))}
      </div>
    )}
    <button type="button" className="bk-btn bk-btn--quiet bk-alt__select" onClick={onSelect} disabled={disabled}
      aria-label={`Select train ${alt.trainNumber}`}>
      Select
    </button>
  </li>
);
