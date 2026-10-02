import React from 'react';

/**
 * Booking review — renders ONLY the deterministic BookingReview built on the
 * server (server/booking/review-builder.ts). Unverified fare/availability are
 * shown as "not verified" — never as ₹0 or "confirmed". The Confirm button
 * sends the reviewVersion it was rendered from; the server rejects it if the
 * review changed since (CONFIRMATION_VERSION_MISMATCH). Nothing is booked.
 */
interface ReviewData {
  reviewVersion?: number;
  journey?: { origin?: string; originName?: string; destination?: string; destinationName?: string };
  route?: { origin?: string; originName?: string; destination?: string; destinationName?: string };
  date?: string;
  selectedTrain?: { number: string; name: string; departure?: string; arrival?: string } | null;
  train?: { number: string; name: string; departure?: string; arrival?: string } | null;
  selectedClass?: string;
  passengersCount: number;
  passengers: Array<{ passengerId?: string; name?: string; age?: number; gender?: string }>;
  fare: { verified: boolean; perPassenger?: number; total?: number };
  availability: { verified: boolean; status?: string };
  warnings?: string[];
  dataSource?: string;
}

interface Props {
  data: ReviewData;
  /** True only for the latest review while the session is AWAITING_CONFIRMATION with that version. */
  confirmable: boolean;
  onChange: () => void;
  onConfirm: (reviewVersion?: number) => void;
}

const Row: React.FC<{ k: string; v: React.ReactNode; muted?: boolean }> = ({ k, v, muted }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
    <span style={{ color: '#757575' }}>{k}</span>
    <span style={{ textAlign: 'right', color: muted ? '#b26a00' : undefined }}>{v}</span>
  </div>
);
const G: Record<string, string> = { MALE: 'M', FEMALE: 'F', OTHER: 'O' };

export const BookingReviewCard: React.FC<Props> = ({ data, confirmable, onChange, onConfirm }) => {
  const r = data.journey || data.route || {};
  const t = data.selectedTrain || data.train;
  return (
    <div style={{ margin: '8px 16px', padding: 16, background: '#fff', borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.08)', opacity: confirmable ? 1 : 0.7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 16, color: '#212121' }}>📋 Booking Review</span>
        <span style={{ fontSize: 11, color: '#757575' }}>v{data.reviewVersion ?? '?'}{confirmable ? '' : ' · purana'}</span>
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.8 }}>
        <Row k="From → To" v={`${r.originName || r.origin || '—'} → ${r.destinationName || r.destination || '—'}`} />
        <Row k="Date" v={data.date || '—'} />
        <Row k="Train" v={t ? `${t.number} · ${t.name}` : '—'} />
        <Row k="Class" v={data.selectedClass || '—'} />
        <Row k="Passengers" v={String(data.passengersCount)} />
        {(data.passengers || []).map((p, i) => (
          <Row key={p.passengerId || i} k={`  ${p.passengerId || `P${i + 1}`}`} v={`${p.name || '—'}${p.age ? `, ${p.age}` : ''}${p.gender ? `, ${G[p.gender] || p.gender}` : ''}`} />
        ))}
        <Row k="Availability" v={data.availability?.verified ? data.availability.status : 'Abhi verify nahi hui'} muted={!data.availability?.verified} />
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #eee', fontWeight: 600 }}>
          <Row k="Total Fare" v={data.fare?.verified ? `₹${data.fare.total}` : 'Abhi verify nahi hua'} muted={!data.fare?.verified} />
        </div>
        {!!data.warnings?.length && (
          <div style={{ marginTop: 8, padding: 8, background: '#fff8e1', borderRadius: 6, fontSize: 12, color: '#8d6e00' }}>
            {data.warnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
          </div>
        )}
        {data.dataSource && <div style={{ fontSize: 11, color: '#9e9e9e', marginTop: 6 }}>{data.dataSource}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button onClick={onChange} style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: '1px solid #1976d2', background: '#fff', color: '#1976d2', fontWeight: 600, cursor: 'pointer' }}>
          Change
        </button>
        <button disabled={!confirmable} onClick={() => onConfirm(data.reviewVersion)} style={{ flex: 1, padding: '10px 0', borderRadius: 8, border: 'none', background: confirmable ? '#1976d2' : '#b0bec5', color: '#fff', fontWeight: 600, cursor: confirmable ? 'pointer' : 'not-allowed' }}>
          Confirm (v{data.reviewVersion ?? '?'})
        </button>
      </div>
      <div style={{ fontSize: 11, color: '#757575', marginTop: 8, textAlign: 'center' }}>
        Confirm sirf booking details tayyar karta hai — asli booking, IRCTC login ya payment is milestone mein nahi hai.
      </div>
    </div>
  );
};
