import React from 'react';
import type { NormalizedTrain, ClassOption } from '../../../server/railway/types/railway-types';

interface Props {
  train: NormalizedTrain;
  isSelected?: boolean;
  onSelectTrain: (trainNumber: string) => void;
  onSelectClass?: (trainNumber: string, classCode: string) => void;
  highlightedClass?: string;
}

/**
 * TrainCard — renders a single train with its classes grouped underneath.
 * Provider-independent; UI consumes ONLY normalized NormalizedTrain results.
 */
export const TrainCard: React.FC<Props> = ({ train, isSelected, onSelectTrain, onSelectClass, highlightedClass }) => {
  return (
    <div
      style={{
        margin: '8px 16px',
        padding: 14,
        background: '#fff',
        borderRadius: 12,
        boxShadow: isSelected ? '0 0 0 2px #1976d2, 0 2px 8px rgba(0,0,0,0.1)' : '0 2px 8px rgba(0,0,0,0.08)',
        border: isSelected ? '2px solid #1976d2' : 'none'
      }}
    >
      <div onClick={() => onSelectTrain(train.trainNumber)} style={{ cursor: 'pointer' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#1976d2' }}>{train.trainNumber}</div>
            <div style={{ fontSize: 13, color: '#616161' }}>{train.trainName}</div>
          </div>
          <div style={{ fontSize: 11, color: '#9e9e9e' }}>MOCK</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 600, fontSize: 17 }}>{train.departure}</div>
            <div style={{ fontSize: 11, color: '#757575' }}>{train.origin}</div>
          </div>
          <div style={{ flex: 1, textAlign: 'center', fontSize: 11, color: '#9e9e9e' }}>— {train.duration} —</div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontWeight: 600, fontSize: 17 }}>{train.arrival}</div>
            <div style={{ fontSize: 11, color: '#757575' }}>{train.destination}</div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {train.classes.map(c => (
          <ClassRow
            key={c.code}
            cls={c}
            highlighted={highlightedClass === c.code}
            onClick={() => onSelectClass?.(train.trainNumber, c.code)}
          />
        ))}
      </div>
    </div>
  );
};

const ClassRow: React.FC<{ cls: ClassOption; highlighted: boolean; onClick: () => void }> = ({ cls, highlighted, onClick }) => {
  const availColor =
    cls.availabilityStatus === 'AVAILABLE' ? '#2e7d32' :
    cls.availabilityStatus === 'NOT_AVAILABLE' ? '#c62828' :
    cls.availabilityStatus === 'UNKNOWN' ? '#9e9e9e' : '#ef6c00';
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 12px', borderRadius: 8,
        border: highlighted ? '2px solid #43a047' : '1px solid #e0e0e0',
        background: highlighted ? '#e8f5e9' : '#fafafa', cursor: 'pointer'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontWeight: 700, color: '#1565c0', fontSize: 14, minWidth: 36 }}>{cls.code}</span>
        <span style={{ fontSize: 12, color: '#616161' }}>{cls.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 11, color: availColor }}>{cls.availability ?? '—'}</span>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#212121' }}>
          {cls.fare != null ? `₹${cls.fare}` : '₹—'}
        </span>
      </div>
    </button>
  );
};

// SearchStatus / ProviderError minimal reusable components
export const SearchStatus: React.FC<{ label: string }> = ({ label }) => (
  <div style={{ padding: '8px 16px', fontSize: 13, color: '#ef6c00', fontWeight: 500 }}>{label}</div>
);

export const ProviderErrorCard: React.FC<{ message: string }> = ({ message }) => (
  <div style={{ margin: '8px 16px', padding: 14, background: '#ffebee', borderRadius: 12, color: '#c62828', fontSize: 13, border: '1px solid #ef9a9a' }}>
    ⚠️ {message}
  </div>
);
