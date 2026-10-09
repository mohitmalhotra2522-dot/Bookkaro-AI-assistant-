import React from 'react';
import { IconAlert, IconCheck, IconClock, IconInfo, IconLock, IconPin, IconTicket, IconTrain, IconWallet } from '../icons/Icons';
import { availabilityTone, formatDate, inr, type Tone } from '../../lib/format';
import { PROVIDER_TIMESTAMP_UNAVAILABLE_LABEL, isFreshnessUnverifiable } from '@shared/provider-freshness';

/**
 * Compact cards for backend card types. Each renders only the fields present in the card
 * payload. Labels such as "mock / non-live" and "real booking: no" are preserved from the
 * previous UI so the honesty of the data source is never lost.
 */

const Note: React.FC<{ icon: React.ReactNode; tone?: Tone | 'navy'; title: React.ReactNode; sub?: React.ReactNode; end?: React.ReactNode; label?: string }> = ({ icon, tone = 'navy', title, sub, end, label }) => (
  <div className="bk-note" role="group" aria-label={label}>
    <span className={`bk-note__icon${tone !== 'navy' && tone !== 'neutral' ? ` bk-note__icon--${tone}` : ''}`}>{icon}</span>
    <span className="bk-note__body">
      <span className="bk-note__title">{title}</span>
      {sub && <><br /><span className="bk-note__sub">{sub}</span></>}
    </span>
    {end && <span className="bk-note__end">{end}</span>}
  </div>
);

const Src: React.FC<{ d: any }> = ({ d }) => <>{d?.dataSource === 'MOCK' ? ' · mock / non-live' : ' · fetched now'}</>;
const toneIcon = (t: Tone) => (t === 'good' ? <IconCheck size={18} /> : t === 'bad' ? <IconAlert size={18} /> : <IconInfo size={18} />);

export const SelectedTrainNote: React.FC<{ d: any }> = ({ d }) => (
  <Note label="Selected train" icon={<IconTrain size={18} />} title={<>{d.trainNumber} {d.trainName}</>}
    sub={[d.departure && d.arrival ? `${d.departure} → ${d.arrival}` : '', d.duration || ''].filter(Boolean).join(' · ') || 'Train selected'}
    end={<span className="bk-tag bk-tag--navy"><IconCheck size={14} /> Selected</span>} />
);

export const SelectedClassNote: React.FC<{ d: any }> = ({ d }) => (
  <Note label="Selected class" icon={<IconTicket size={18} />} title={<>Class {d.classCode}</>} sub="Class selected"
    end={<span className="bk-tag bk-tag--navy"><IconCheck size={14} /> Selected</span>} />
);

export const AvailabilityNote: React.FC<{ d: any }> = ({ d }) => {
  const tone = availabilityTone(d.status);
  return (
    <Note label="Seat availability" tone={tone} icon={toneIcon(tone)}
      title={<>Availability: {d.status ?? '—'}</>}
      sub={[`${d.trainNumber ?? ''} ${d.travelClass ?? ''}`.trim(), formatDate(d.date), d.passengersCount ? `${d.passengersCount} passengers` : '',
        // 2026-10-09: the provider sent no data timestamp → freshness cannot be verified (exact label)
        isFreshnessUnverifiable(d.freshness) ? PROVIDER_TIMESTAMP_UNAVAILABLE_LABEL : ''].filter(Boolean).join(' · ')}
      end={<span className={`bk-tag bk-tag--${tone === 'neutral' ? 'navy' : tone}`}>{d.status ?? '—'}</span>} />
  );
};

export const FareNote: React.FC<{ d: any }> = ({ d }) => {
  const parts: string[] = [];
  if (d.perPassenger != null && d.passengersCount != null) parts.push(`${inr(d.perPassenger)} × ${d.passengersCount}`);
  else if (d.perPassenger != null) parts.push(`${inr(d.perPassenger)} per passenger`);
  if (d.breakdown && typeof d.breakdown === 'object') {
    for (const [k, v] of Object.entries(d.breakdown)) {
      if (typeof v === 'number') parts.push(`${k.replace(/([A-Z])/g, ' $1').replace(/^\w/, c => c.toUpperCase())} ${inr(v)}`);
    }
  }
  return (
    <Note label="Fare" icon={<IconWallet size={18} />}
      title={<>Fare · {`${d.trainNumber ?? ''} ${d.travelClass ?? ''}`.trim()}</>}
      sub={[...parts, isFreshnessUnverifiable(d.freshness) ? PROVIDER_TIMESTAMP_UNAVAILABLE_LABEL : ''].filter(Boolean).join(' · ') || undefined}
      end={d.total != null ? <span className="bk-note__amount">{inr(d.total)}</span> : undefined} />
  );
};

export const TrainInfoNote: React.FC<{ d: any }> = ({ d }) => (
  <Note label="Train details" icon={<IconInfo size={18} />} title={<>{d.trainNumber} {d.trainName}</>}
    sub={[d.departure && d.arrival ? `${d.departure} → ${d.arrival}` : '', d.duration ? `(${d.duration})` : ''].filter(Boolean).join(' ')} />
);

export const TimetableNote: React.FC<{ d: any }> = ({ d }) => (
  <Note label="Timetable" icon={<IconClock size={18} />} title="Timetable"
    sub={(Array.isArray(d) ? d : []).map((x: any) => `${x.station} ${x.departure || x.arrival || ''}`.trim()).join(' → ')} />
);

export const PnrNote: React.FC<{ d: any }> = ({ d }) => (
  <Note label="PNR status" icon={<IconTicket size={18} />}
    title={<>PNR {d.pnrMasked}: {d.pnrStatus}</>}
    sub={<>{d.chartStatus ? `Chart: ${d.chartStatus}` : ''}{(d.passengers || []).map((p: any) => ` · P${p.number}: ${p.currentStatus}`).join('')}<Src d={d} /></>} />
);

export const LiveStatusNote: React.FC<{ d: any }> = ({ d }) => (
  <Note label="Live train status" icon={<IconPin size={18} />}
    title={<>{d.trainNumber}: {d.currentStatus}</>}
    sub={<>{d.currentStationName || d.currentStationCode || ''}{typeof d.delayMinutes === 'number' ? ` · ${d.delayMinutes} min late` : ''}
      {d.nextStationName ? ` · Next: ${d.nextStationName}` : ''}{d.platformNumber ? ` · PF ${d.platformNumber}` : ''}
      {d.sourceNote ? <><br /><span className="bk-tag bk-tag--web">WEB (RailYatri) — unverified{d.lastUpdated ? ` · as of ${String(d.lastUpdated).slice(11, 16)}` : ''}</span></> : <Src d={d} />}</>} />
);

export const BookingDetailsNote: React.FC<{ d: any }> = ({ d }) => {
  const tone: Tone = d.status === 'CONFIRMED' ? 'good' : d.status === 'FAILED' || d.status === 'CANCELLED' ? 'bad' : 'warn';
  return (
    <Note label="Booking details" tone={tone} icon={<IconTicket size={18} />}
      title={<>{d.train?.trainNumber} {d.journey?.origin} → {d.journey?.destination} · {d.statusLabel}</>}
      sub={<>{formatDate(d.journeyDate)} · {d.travelClass} · {d.passengersCount} pax · PNR {d.pnr ? d.pnr : d.pnrMasked ? d.pnrMasked : 'not available'}</>} />
  );
};

export const BookingActionNote: React.FC<{ d: any }> = ({ d }) => {
  const tone: Tone = d.status === 'ACTION_CONFIRMED' ? 'good' : d.status === 'ACTION_FAILED' ? 'bad' : 'warn';
  const action = String(d.actionType || '').replace(/_/g, ' ').toLowerCase();
  const status = String(d.status || '').replace(/^ACTION_/, '').replace(/_/g, ' ').toLowerCase();
  return <Note label="Booking action" tone={tone} icon={<IconInfo size={18} />} title={<>{action} · {status}</>} sub={d.resultStatus || undefined} />;
};

export const BookingHistoryNote: React.FC<{ d: any }> = ({ d }) => (
  <Note label="Booking history" icon={<IconTicket size={18} />} title="Your bookings"
    sub={(d.bookings || []).map((b: any) => `${b.train?.trainNumber} ${b.journey?.origin}→${b.journey?.destination} ${b.journeyDate} (${b.statusLabel})`).join(' · ') || 'Koi booking nahi'} />
);

export const BookingExecutionNote: React.FC<{ d: any; onReconcile: () => void }> = ({ d, onReconcile }) => {
  const ex = d.execution;
  const tone: Tone = ex?.status === 'CONFIRMED' ? 'good' : ex?.unresolved ? 'warn' : 'neutral';
  return (
    <div className="bk-block" style={{ paddingLeft: 0 }}>
      <Note label="Booking provider" tone={tone} icon={<IconLock size={18} />}
        title={<>Booking provider {ex?.providerName || d.provider?.providerName}: {ex?.status || d.code}</>}
        sub={<>{d.duplicate ? 'Duplicate (no new request)' : ''}{ex?.status === 'CONFIRMED' && ex?.pnr ? ` · PNR ${ex.pnr}` : ''}{d.manualVerificationRequired ? ' · manual provider verification required' : ''}{ex?.reconciliationAttempts ? ` · status checks: ${ex.reconciliationAttempts}` : ''}</>} />
      {ex?.unresolved && (
        <div><button type="button" className="bk-btn bk-btn--ghost bk-btn--sm" onClick={onReconcile}>Status verify karein</button></div>
      )}
    </div>
  );
};

export const HandoffConsumeNote: React.FC<{ d: any }> = ({ d }) => (
  <Note label="Handoff execution" icon={<IconLock size={18} />} title={<>Handoff execution: {d.code}</>}
    sub={<>{d.duplicate ? 'Duplicate (no new attempt) · ' : ''}Executor {d.executorName || 'none'} ({d.executorEnabled ? 'enabled' : 'disabled'}) · real booking: no</>} />
);

export const HandoffStatusNote: React.FC<{ d: any }> = ({ d }) => (
  <Note label="Handoff status" tone="warn" icon={<IconAlert size={18} />} title={<>Handoff {d.status}</>}
    sub={<>{d.reason ? `${d.reason} — ` : ''}naya review confirm karna hoga</>} />
);
