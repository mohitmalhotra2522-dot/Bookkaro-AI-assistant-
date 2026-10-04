import React from 'react';
import type { Passenger } from '@shared/entities';
import { IconEdit, IconPlus, IconUsers } from '../icons/Icons';
import { genderLabel, initials } from '../../lib/format';

interface Props {
  passenger: Passenger;
  index: number;
  /** Optional: prefill the composer with an edit request (sent only when the user presses send). */
  onEdit?: (passenger: Passenger, index: number) => void;
}

/** One compact passenger row — name, age · gender (berth only when provided). */
export const PassengerCard: React.FC<Props> = ({ passenger, index, onEdit }) => {
  const meta = [passenger.age ? String(passenger.age) : '', genderLabel(passenger.gender as any), passenger.berthPreference ? `${passenger.berthPreference} berth` : '']
    .filter(Boolean).join(' · ');
  return (
    <div className="bk-pax__row">
      <span className="bk-avatar" aria-hidden="true">{passenger.name ? initials(passenger.name) : index + 1}</span>
      <span className="bk-pax__info">
        <span className="bk-pax__name">{passenger.name || `Passenger ${index + 1}`}</span><br />
        <span className="bk-pax__meta">{meta || 'Details pending'}</span>
      </span>
      {onEdit && (
        <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm" onClick={() => onEdit(passenger, index)} aria-label={`Edit ${passenger.name || `passenger ${index + 1}`}`}>
          <IconEdit size={16} /> Edit
        </button>
      )}
    </div>
  );
};

export const PassengerList: React.FC<{ passengers: Passenger[]; onEdit?: Props['onEdit']; onAdd?: () => void }> = ({ passengers, onEdit, onAdd }) => (
  <section className="bk-card bk-pax" aria-label="Passengers">
    <div className="bk-section-head">
      <h3 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><IconUsers size={18} /> Passengers</h3>
      <span className="bk-meta">{passengers.length}</span>
    </div>
    <div className="bk-pax__list">
      {passengers.map((p, i) => <PassengerCard key={(p as any).id || i} passenger={p} index={i} onEdit={onEdit} />)}
    </div>
    {onAdd && (
      <div className="bk-pax__foot">
        <button type="button" className="bk-btn bk-btn--quiet bk-btn--sm" onClick={onAdd}><IconPlus size={16} /> Add passenger</button>
      </div>
    )}
  </section>
);
