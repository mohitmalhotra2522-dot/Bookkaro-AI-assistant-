import React from 'react';
import { IconCheck, IconChevronRight, IconLock } from '../icons/Icons';
import { formatClock } from '../../lib/format';

/**
 * IRCTC handoff boundary. The headline reflects the backend execution status verbatim:
 * "confirmed" appears ONLY when the booking provider reported CONFIRMED (never in this build,
 * where real booking is disabled). Technical identifiers stay behind a disclosure.
 */
export const HandoffCard: React.FC<{ d: any; onProviderStatus: () => void }> = ({ d, onProviderStatus }) => {
  const bx: any = d.bookingExecution;
  const ex: any = bx?.execution;
  const confirmed = ex?.status === 'CONFIRMED';
  const title = confirmed ? 'Booking provider ne confirm kiya' : ex?.submitted ? `Booking provider: ${ex.status}` : 'Booking details verified';
  const disabled = !confirmed && !ex?.submitted;
  return (
    <section className="bk-card bk-handoff" aria-label="Booking status">
      <div className="bk-handoff__icon">{confirmed ? <IconCheck size={22} /> : <IconLock size={22} />}</div>
      <h3>{title}</h3>
      {d.message && <p>{d.message}</p>}
      {disabled && <p><strong>No ticket has been booked.</strong> Real booking is not enabled in this version of BookKaro.</p>}
      {confirmed && ex?.pnr && <p><strong>PNR {ex.pnr}</strong></p>}

      {d.handoffSessionId && !ex?.submitted && (
        <div style={{ marginTop: 14 }}>
          <button type="button" className="bk-btn bk-btn--ghost bk-btn--sm" onClick={onProviderStatus}>Booking provider status</button>
        </div>
      )}

      {(d.handoffId || d.handoffSessionId || bx) && (
        <details className="bk-disclose">
          <summary><IconChevronRight size={14} /> Technical details</summary>
          <div className="bk-disclose__body">
            {d.reviewVersion != null && <span>review v{d.reviewVersion}</span>}
            {d.handoffId && <span>handoff {d.handoffId} · {d.handoffStatus} · executor {d.executorName} → {d.executionStatus}{d.expiresAt ? ` · valid till ${formatClock(d.expiresAt)}` : ''}{d.duplicate ? ' · duplicate (no new handoff)' : ''}</span>}
            {d.handoffSessionId && <span>session {String(d.handoffSessionId).slice(0, 11)}… · {d.handoffSessionStatus}{d.handoffSessionExpiresAt ? ` · expires ${formatClock(d.handoffSessionExpiresAt)}` : ''} · executor {d.executorCapability?.executorName} ({d.executorCapability?.enabled ? 'enabled' : 'disabled'}, real booking: {d.executorCapability?.supportsRealBooking ? 'yes' : 'no'})</span>}
            {bx && <span>provider {bx.provider?.providerName} ({bx.provider?.available ? 'available' : 'unavailable'}, health {bx.provider?.health}) · {bx.code}{ex?.providerReference ? ` · ref ${ex.providerReference}` : ''}</span>}
          </div>
        </details>
      )}
    </section>
  );
};
