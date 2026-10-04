import React from 'react';
import { IconArrowRight, IconInfo, IconLock } from '../icons/Icons';
import { formatDate, genderLabel, inr } from '../../lib/format';

/**
 * Booking review — renders ONLY the deterministic BookingReview built on the
 * server (server/booking/review-builder.ts). Unverified fare/availability are
 * shown as "not verified yet" — never as ₹0 or "confirmed". The Confirm button
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
  fare: { verified: boolean; perPassenger?: number; total?: number; breakdown?: Record<string, unknown> };
  availability: { verified: boolean; status?: string };
  warnings?: string[];
  dataSource?: string;
  realBooking?: boolean;
}

interface Props {
  data: ReviewData;
  /** True only for the latest review while the session is AWAITING_CONFIRMATION with that version. */
  confirmable: boolean;
  onChange: () => void;
  onConfirm: (reviewVersion?: number) => void;
  /** From GET /api/health — when false (or the review says realBooking=false) the boundary is stated. */
  realBookingEnabled?: boolean | null;
}

const Line: React.FC<{ k: string; v: React.ReactNode; pending?: boolean }> = ({ k, v, pending }) => (
  <div className="bk-review__line"><span>{k}</span><span className={pending ? 'bk-review__pending' : undefined}>{v}</span></div>
);

export const BookingReviewCard: React.FC<Props> = ({ data, confirmable, onChange, onConfirm, realBookingEnabled }) => {
  const r = data.journey || data.route || {};
  const t = data.selectedTrain || data.train;
  const bookingDisabled = data.realBooking === false || realBookingEnabled === false;
  const fareParts = data.fare?.verified && data.fare.perPassenger != null ? `${inr(data.fare.perPassenger)} × ${data.passengersCount}` : null;
  return (
    <section className={`bk-card bk-review${confirmable ? '' : ' is-stale'}`} aria-label="Booking review">
      <div className="bk-review__head">
        <h3 className="bk-review__title">Review your booking</h3>
        <span className={`bk-tag ${confirmable ? 'bk-tag--navy' : ''}`}>v{data.reviewVersion ?? '?'}{confirmable ? '' : ' · outdated'}</span>
      </div>

      <div className="bk-review__sec">
        <div className="bk-review__label">Journey</div>
        <div className="bk-review__route">
          <span>{r.originName || r.origin || '—'}</span>
          <IconArrowRight size={18} />
          <span>{r.destinationName || r.destination || '—'}</span>
        </div>
        <Line k="Date" v={formatDate(data.date) || '—'} />
      </div>

      <div className="bk-review__sec">
        <div className="bk-review__label">Train</div>
        <Line k="Train" v={t ? `${t.number} · ${t.name}` : '—'} />
        {t?.departure && t?.arrival && <Line k="Timing" v={`${t.departure} → ${t.arrival}`} />}
        <Line k="Class" v={data.selectedClass || '—'} />
        <Line k="Availability" v={data.availability?.verified ? (data.availability.status || '—') : 'Not verified yet'} pending={!data.availability?.verified} />
      </div>

      <div className="bk-review__sec">
        <div className="bk-review__label">Passengers · {data.passengersCount}</div>
        {(data.passengers || []).map((p, i) => (
          <Line key={p.passengerId || i} k={p.name || `Passenger ${i + 1}`} v={[p.age ? String(p.age) : '', genderLabel(p.gender)].filter(Boolean).join(' · ') || '—'} />
        ))}
      </div>

      <div className="bk-review__sec">
        <div className="bk-review__label">Fare</div>
        {fareParts && <Line k="Fare" v={fareParts} />}
        {data.fare?.verified && data.fare.breakdown && Object.entries(data.fare.breakdown).filter(([, v]) => typeof v === 'number').map(([k, v]) => (
          <Line key={k} k={k.replace(/([A-Z])/g, ' $1').replace(/^\w/, c => c.toUpperCase())} v={inr(v)} />
        ))}
        <div className="bk-review__total">
          <span>Total</span>
          {data.fare?.verified && data.fare.total != null ? <b>{inr(data.fare.total)}</b> : <span className="bk-review__pending">Not verified yet</span>}
        </div>
      </div>

      {!!data.warnings?.length && (
        <div className="bk-callout bk-callout--warn" role="note">
          <IconInfo size={16} />
          <span>{data.warnings.join(' ')}</span>
        </div>
      )}

      <div className="bk-review__actions">
        <button type="button" className="bk-btn bk-btn--ghost" onClick={onChange}>Change</button>
        <button type="button" className="bk-btn bk-btn--primary" disabled={!confirmable} onClick={() => onConfirm(data.reviewVersion)}>
          Confirm &amp; Continue
        </button>
      </div>

      {bookingDisabled && (
        <div className="bk-callout" role="note">
          <IconLock size={16} />
          <span>Confirming verifies your booking details only. Real railway booking, IRCTC login and payment are not enabled — no ticket will be booked.</span>
        </div>
      )}
      {data.dataSource && <div className="bk-meta" style={{ marginTop: 10 }}>{data.dataSource}</div>}
    </section>
  );
};
