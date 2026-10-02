import React, { useState } from 'react';

/**
 * Minimal verification panel (NOT the final premium UI). Shows authoritative
 * session state so multi-turn behaviour can be verified: pending question,
 * journey, selection, availability/fare, versions, confirmation state, tool
 * activity, events and errors.
 */
export interface InspectorMeta {
  state?: string;
  pendingType?: string;
  pendingQuestion?: string;
  sessionVersion?: number;
  searchResultsVersion?: number;
  toolActivity?: string;
  events?: string[];
  error?: { code: string; message: string } | null;
}

export const SessionInspector: React.FC<{ ctx: any; meta: InspectorMeta }> = ({ ctx, meta }) => {
  const [open, setOpen] = useState(true);
  const c = ctx || {};
  const avail = c.selectedClass && c.availability ? c.availability[c.selectedClass] : undefined;
  const cell = (k: string, v: any, warn = false) => (
    <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
      <span style={{ color: '#78909c' }}>{k}</span>
      <span style={{ color: warn ? '#c62828' : '#263238', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v ?? '—'}</span>
    </div>
  );
  return (
    <div style={{ background: '#eceff1', borderBottom: '1px solid #cfd8dc', fontSize: 11.5, fontFamily: 'ui-monospace, Menlo, monospace' }}>
      <div onClick={() => setOpen(!open)} style={{ padding: '6px 12px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', color: '#37474f' }}>
        <span>🔎 {meta.state || c.bookingState || 'IDLE'} · pending: {meta.pendingType || 'NONE'}</span>
        <span>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={{ padding: '0 12px 8px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px' }}>
          {cell('journey', c.origin || c.destination ? `${c.origin || '?'}→${c.destination || '?'}` : undefined)}
          {cell('date', c.date)}
          {cell('pax', c.passengersCount)}
          {cell('train', c.selectedTrain?.number)}
          {cell('class', c.selectedClass)}
          {cell('avail', avail ? avail.status : c.selectedClass ? 'not verified' : undefined)}
          {cell('fare', c.fare ? `₹${c.fare.total}` : c.selectedClass ? 'not verified' : undefined)}
          {cell('confirm', c.irctcHandoffReady ? 'REQUESTED (handoff ready)' : c.bookingState === 'AWAITING_CONFIRMATION' ? 'AWAITING' : 'no')}
          {cell('ready', c.readiness ? (c.readiness.ready ? 'YES' : 'no') : undefined, c.readiness && !c.readiness.ready)}
          {cell('next', c.readiness?.nextRequiredField ? `${c.readiness.nextRequiredField.field}${c.readiness.nextRequiredField.passengerId ? ` (${c.readiness.nextRequiredField.passengerId})` : ''}` : undefined)}
          <div style={{ gridColumn: '1 / -1' }}>{cell('blockers', c.readiness?.blockers?.length ? c.readiness.blockers.join(', ') : undefined, !!c.readiness?.blockers?.length)}</div>
          <div style={{ gridColumn: '1 / -1' }}>{cell('passengers', (c.passengers || []).length ? c.passengers.map((p: any) => `${p.id}:${p.name ? 'name' : '·'}/${p.age ?? '·'}/${p.gender ? p.gender[0] : '·'}${p.missingFields && !p.missingFields.length ? '✓' : ''}`).join('  ') : undefined)}</div>
          {cell('review', c.review ? `v${c.review.reviewVersion} ${c.review.valid ? 'valid' : `invalid (${c.review.invalidatedReason || '?'})`}` : undefined, c.review && !c.review.valid)}
          {cell('confirmedV', c.confirmedReviewVersion)}
          {cell('handoff', c.bookingState === 'IRCTC_HANDOFF_READY' ? 'READY (execution disabled)' : undefined)}
          {cell('sessionV', meta.sessionVersion ?? c.sessionVersion)}
          {cell('searchV', meta.searchResultsVersion ?? c.searchResultsVersion)}
          <div style={{ gridColumn: '1 / -1' }}>{cell('ask', meta.pendingQuestion)}</div>
          <div style={{ gridColumn: '1 / -1' }}>{cell('tools', meta.toolActivity)}</div>
          <div style={{ gridColumn: '1 / -1' }}>{cell('events', meta.events?.length ? meta.events.join(', ') : undefined)}</div>
          {meta.error && <div style={{ gridColumn: '1 / -1' }}>{cell('error', `${meta.error.code}`, true)}</div>}
        </div>
      )}
    </div>
  );
};
