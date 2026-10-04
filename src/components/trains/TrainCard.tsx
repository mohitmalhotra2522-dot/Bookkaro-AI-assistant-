import React, { useState } from 'react';
import type { NormalizedTrain, ClassOption } from '../../../server/railway/types/railway-types';
import { IconAlert, IconCheck, IconChevronDown, IconClock, IconInfo } from '../icons/Icons';
import { availabilityTone, formatClock, inr } from '../../lib/format';

interface Props {
  train: NormalizedTrain & { runsOn?: string[]; provider?: string; retrievedAt?: string };
  isSelected?: boolean;
  onSelectTrain: (trainNumber: string) => void;
  onSelectClass?: (trainNumber: string, classCode: string) => void;
  highlightedClass?: string;
  originLabel?: string;
  destinationLabel?: string;
  disabled?: boolean;
}

/**
 * TrainCard — one train, time-first. Renders ONLY normalized fields the backend returned:
 * a class shows availability / fare only when the provider supplied them (never invented).
 * Selecting a train or class sends the same message as before, carrying the list version.
 */
export const TrainCard: React.FC<Props> = ({ train, isSelected, onSelectTrain, onSelectClass, highlightedClass, originLabel, destinationLabel, disabled }) => {
  const [open, setOpen] = useState(false);
  const detailsId = `td-${train.trainNumber}`;
  return (
    <article className={`bk-card bk-train${isSelected ? ' is-selected' : ''}`} aria-label={`Train ${train.trainNumber} ${train.trainName}`}>
      <div className="bk-train__top">
        <div className="bk-train__id">
          <div className="bk-train__num">{train.trainNumber}</div>
          <div className="bk-train__name">{train.trainName}</div>
        </div>
        {isSelected && <span className="bk-tag bk-tag--navy"><IconCheck size={14} /> Selected</span>}
      </div>

      <div className="bk-timeline">
        <div className="bk-timeline__end">
          <div className="bk-timeline__time">{train.departure || '—'}</div>
          <div className="bk-timeline__stn" title={originLabel || train.origin}>{originLabel || train.origin}</div>
        </div>
        <div className="bk-timeline__track" aria-hidden={!train.duration}>
          {train.duration && <span className="bk-timeline__dur"><IconClock size={13} />{train.duration}</span>}
          <span className="bk-timeline__line" />
        </div>
        <div className="bk-timeline__end bk-timeline__end--right">
          <div className="bk-timeline__time">{train.arrival || '—'}</div>
          <div className="bk-timeline__stn" title={destinationLabel || train.destination}>{destinationLabel || train.destination}</div>
        </div>
      </div>

      {train.classes?.length > 0 && (
        <div className="bk-classes" role="group" aria-label="Classes">
          {train.classes.map(c => (
            <ClassChip key={c.code} cls={c} active={highlightedClass === c.code} disabled={disabled}
              onClick={() => onSelectClass?.(train.trainNumber, c.code)} />
          ))}
        </div>
      )}

      <div className="bk-train__actions">
        <button type="button" className="bk-btn bk-btn--primary" onClick={() => onSelectTrain(train.trainNumber)} disabled={disabled}>
          Select train
        </button>
        <button type="button" className="bk-btn bk-btn--quiet" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls={detailsId}>
          Details <IconChevronDown size={16} className={open ? 'bk-rot' : undefined} />
        </button>
      </div>

      {open && (
        <div className="bk-train__details" id={detailsId}>
          {train.duration && <KV k="Duration" v={train.duration} />}
          {!!train.runsOn?.length && <KV k="Runs on" v={train.runsOn.join(', ')} />}
          <KV k="Route" v={`${train.origin} → ${train.destination}`} />
          {train.retrievedAt && <KV k="Fetched" v={formatClock(train.retrievedAt)} />}
        </div>
      )}
    </article>
  );
};

const KV: React.FC<{ k: string; v: React.ReactNode }> = ({ k, v }) => (
  <div className="bk-kv"><span className="bk-kv__k">{k}</span><span className="bk-kv__v">{v}</span></div>
);

const ClassChip: React.FC<{ cls: ClassOption; active: boolean; disabled?: boolean; onClick: () => void }> = ({ cls, active, disabled, onClick }) => {
  const tone = availabilityTone(cls.availability, cls.availability ? cls.availabilityStatus : null);
  const label = [cls.code, cls.availability || '', cls.fare != null ? inr(cls.fare) : ''].filter(Boolean).join(', ');
  return (
    <button type="button" className={`bk-class${active ? ' is-active' : ''}`} onClick={onClick} disabled={disabled} aria-label={`Select class ${label}`}>
      <span className="bk-class__code">{cls.code}</span>
      {cls.availability && <span className={`bk-class__avail bk-class__avail--${tone}`}>{cls.availability}</span>}
      {cls.fare != null && <span className="bk-class__fare">{inr(cls.fare)}</span>}
    </button>
  );
};

/** Search results list: header with real count / source / freshness, then cards (first few, then "show all"). */
export const TrainResults: React.FC<{
  trains: Array<Props['train']>;
  source?: string;
  retrievedAt?: string;
  routeLabel?: string;
  selectedTrainNumber?: string;
  selectedClass?: string;
  originLabel: (code: string) => string;
  onSelectTrain: (n: string) => void;
  onSelectClass: (n: string, c: string) => void;
  disabled?: boolean;
}> = ({ trains, source, retrievedAt, routeLabel, selectedTrainNumber, selectedClass, originLabel, onSelectTrain, onSelectClass, disabled }) => {
  const INITIAL = 4;
  const [all, setAll] = useState(trains.length <= INITIAL + 1);
  const shown = all ? trains : trains.slice(0, INITIAL);
  const isMock = String(source || '').toLowerCase() === 'mock';
  return (
    <section className="bk-results" aria-label="Train results">
      <div className="bk-section-head">
        <h3>{trains.length} {trains.length === 1 ? 'train' : 'trains'}{routeLabel ? ` · ${routeLabel}` : ''}</h3>
        <span className="bk-meta">
          {isMock ? <span className="bk-tag bk-tag--warn">Development data — not live</span>
            : retrievedAt ? <>Fetched {formatClock(retrievedAt)}</> : null}
        </span>
      </div>
      {shown.map(t => (
        <TrainCard key={t.trainNumber} train={t}
          isSelected={!!selectedTrainNumber && selectedTrainNumber === t.trainNumber}
          highlightedClass={selectedTrainNumber === t.trainNumber ? selectedClass : undefined}
          originLabel={originLabel(t.origin)} destinationLabel={originLabel(t.destination)}
          onSelectTrain={onSelectTrain} onSelectClass={onSelectClass} disabled={disabled} />
      ))}
      {!all && trains.length > INITIAL && (
        <button type="button" className="bk-btn bk-btn--ghost bk-results__more" onClick={() => setAll(true)}>
          Show all {trains.length} trains
        </button>
      )}
    </section>
  );
};

// SearchStatus / ProviderError — kept as reusable exports
export const SearchStatus: React.FC<{ label: string }> = ({ label }) => (
  <div className="bk-meta" role="status"><IconInfo size={14} /> {label}</div>
);

export const ProviderErrorCard: React.FC<{ message: string }> = ({ message }) => (
  <div className="bk-error" role="alert">
    <span className="bk-error__icon"><IconAlert size={18} /></span>
    <span className="bk-error__text">{message}</span>
  </div>
);
