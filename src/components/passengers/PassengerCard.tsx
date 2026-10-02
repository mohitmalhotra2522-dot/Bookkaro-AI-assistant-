import React from 'react';
import type { Passenger } from '@shared/entities';

interface Props {
  passenger: Passenger;
  index: number;
}

export const PassengerCard: React.FC<Props> = ({ passenger, index }) => {
  return (
    <div
      style={{
        margin: '8px 16px',
        padding: 14,
        background: '#fff',
        borderRadius: 12,
        boxShadow: '0 2px 6px rgba(0,0,0,0.06)'
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, color: '#424242', marginBottom: 6 }}>
        Passenger {index + 1}
      </div>
      <div style={{ fontSize: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
          <span style={{ color: '#757575' }}>Name</span>
          <span>{passenger.name || '—'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
          <span style={{ color: '#757575' }}>Age</span>
          <span>{passenger.age || '—'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
          <span style={{ color: '#757575' }}>Gender</span>
          <span>{passenger.gender || '—'}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
          <span style={{ color: '#757575' }}>Berth</span>
          <span>{passenger.berthPreference || 'No preference'}</span>
        </div>
      </div>
    </div>
  );
};
