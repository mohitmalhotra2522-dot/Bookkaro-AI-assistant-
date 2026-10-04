import React from 'react';
import { IconCalendar, IconInfo, IconRoute, IconTicket, IconTrain, IconUsers, IconWallet } from '../icons/Icons';
import { bookingStateLabel, formatDate, genderLabel, inr } from '../../lib/format';

/**
 * Compact trip summary — a read-only VIEW of the backend session context (no state is decided
 * here). Shows only what the session actually holds; empty sections are omitted.
 */
export function tripHasContent(c: any): boolean {
  return !!(c && (c.origin || c.destination || c.date || c.selectedTrain || c.passengersCount || (c.passengers || []).length));
}

const Item: React.FC<{ icon: React.ReactNode; k: string; v: React.ReactNode; s?: React.ReactNode }> = ({ icon, k, v, s }) => (
  <div className="bk-trip__item">
    <span className="bk-trip__icon">{icon}</span>
    <span style={{ minWidth: 0 }}>
      <span className="bk-trip__k">{k}</span><br />
      <span className="bk-trip__v">{v}</span>
      {s && <><br /><span className="bk-trip__s">{s}</span></>}
    </span>
  </div>
);

export const TripSummary: React.FC<{ ctx: any }> = ({ ctx }) => {
  const c = ctx || {};
  if (!tripHasContent(c)) return <p className="bk-trip__empty">Your journey details will appear here as you talk to BookKaro.</p>;
  const named = (c.passengers || []).filter((p: any) => p?.name);
  const avail = c.selectedClass && c.availability ? c.availability[c.selectedClass] : undefined;
  return (
    <div className="bk-trip">
      {(c.origin || c.destination) && (
        <Item icon={<IconRoute size={16} />} k="Journey" v={`${c.originName || c.origin || '—'} → ${c.destinationName || c.destination || '—'}`} />
      )}
      {c.date && <Item icon={<IconCalendar size={16} />} k="Date" v={formatDate(c.date)} />}
      {c.selectedTrain && (
        <Item icon={<IconTrain size={16} />} k="Train" v={`${c.selectedTrain.number} · ${c.selectedTrain.name}`}
          s={[c.selectedTrain.departure && c.selectedTrain.arrival ? `${c.selectedTrain.departure} → ${c.selectedTrain.arrival}` : '', c.selectedClass ? `Class ${c.selectedClass}` : ''].filter(Boolean).join(' · ') || undefined} />
      )}
      {!c.selectedTrain && c.selectedClass && <Item icon={<IconTicket size={16} />} k="Class" v={c.selectedClass} />}
      {(c.passengersCount || named.length > 0) && (
        <Item icon={<IconUsers size={16} />} k="Passengers" v={c.passengersCount ? `${c.passengersCount} ${c.passengersCount === 1 ? 'passenger' : 'passengers'}` : `${named.length}`}
          s={named.length ? named.map((p: any) => [p.name, p.age, genderLabel(p.gender)].filter(Boolean).join(', ')).join(' · ') : undefined} />
      )}
      {avail?.status && <Item icon={<IconInfo size={16} />} k="Availability" v={avail.status} />}
      {c.fare?.total != null && <Item icon={<IconWallet size={16} />} k="Fare" v={inr(c.fare.total)} s={c.fare.perPassenger != null && c.fare.passengersCount ? `${inr(c.fare.perPassenger)} × ${c.fare.passengersCount}` : undefined} />}
      {c.bookingState && <Item icon={<IconTicket size={16} />} k="Status" v={bookingStateLabel(c.bookingState)} />}
    </div>
  );
};

export const TripPanel: React.FC<{ ctx: any }> = ({ ctx }) => (
  <aside className={`bk-panel${tripHasContent(ctx) ? ' has-content' : ''}`} aria-label="Trip summary">
    <div className="bk-panel__title">Your trip</div>
    <TripSummary ctx={ctx} />
  </aside>
);
