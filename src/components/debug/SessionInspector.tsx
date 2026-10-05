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
  executionCapability?: { realBookingEnabled: boolean; effectiveExecutor: string; reason: string };
  /** Prompt 16 — derived conversation context (journey / pending question / results / booking ref / masked PNR). */
  conversation?: { activeJourneyId: string; pendingQuestion: string | null; missingFields: string[]; activeBookingId: string | null; activePnrMasked: string | null; resultSetId: string | null; resultCount: number; clarification: string | null; rejectedClaims: number };
  /** Prompt 17 — this turn's railway tool executions (status / freshness / latency; no raw arguments). */
  tools?: Array<{ tool: string; status: string; fresh: boolean; latencyMs: number | null; parallelGroup: number | null; rejectionReason: string | null }>;
  journeyVersion?: number;
  /** Prompt 18 — logical turn (sequence / status / response type / grounding). */
  turn?: { sequence: number; status: string; responseType: string | null; grounding: string | null; superseded: boolean; interrupted: boolean };
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
          {/* Prompt 19 — derived booking-preparation sub-state (legal transitions only; never COMPLETE) */}
          {cell('prep', c.bookingPreparationState)}
          {cell('prepPath', c.preparationTrace?.path?.length ? c.preparationTrace.path.join('→') : undefined)}
          {cell('handoff', c.handoff ? `${c.handoff.snapshot?.handoffId} ${c.handoff.status}${c.handoff.statusReason ? ` (${String(c.handoff.statusReason).split(':')[0]})` : ''}` : undefined, !!c.handoff && c.handoff.status !== 'READY')}
          {cell('irctc', c.irctcHandoff ? `${c.irctcHandoff.status}${c.irctcHandoff.lastPage ? ` @${c.irctcHandoff.lastPage}` : ''} · filled ${c.irctcHandoff.filledFields?.length ?? 0}` : undefined, !!c.irctcHandoff && ['STALE_HANDOFF', 'EXPIRED', 'BOOKING_STATUS_UNKNOWN', 'BOOKING_FAILED'].includes(c.irctcHandoff.status))}
          {cell('expires', c.handoff?.status === 'READY' && c.handoff.snapshot?.expiresAt ? new Date(c.handoff.snapshot.expiresAt).toLocaleTimeString() : undefined)}
          {cell('lifecycle', c.bookingLifecycle?.status)}
          {cell('confirmation', c.confirmation ? `${c.confirmation.status} · review v${c.confirmation.reviewVersion} · sv${c.confirmation.sessionVersion}` : undefined, !!c.confirmation && c.confirmation.status !== 'VALID')}
          {cell('handoffSession', c.handoffSession ? `${String(c.handoffSession.handoffSessionId).slice(0, 11)}… ${c.handoffSession.status}${c.handoffSession.statusReason ? ` (${String(c.handoffSession.statusReason).split(':')[0]})` : ''}${c.handoffSession.status === 'READY' ? ` · till ${new Date(c.handoffSession.expiresAt).toLocaleTimeString()}` : ''}` : undefined, !!c.handoffSession && c.handoffSession.status !== 'READY')}
          {cell('executor', c.handoffSession?.executorCapability ? `${c.handoffSession.executorCapability.executorName} · ${c.handoffSession.executorCapability.enabled ? 'enabled' : 'disabled'} · realBooking ${c.handoffSession.executorCapability.supportsRealBooking ? 'yes' : 'no'}` : undefined)}
          {cell('bookingExecution', c.bookingExecution ? `${c.bookingExecution.providerName} · ${c.bookingExecution.status} · ${c.bookingExecution.code}${c.bookingExecution.status === 'CONFIRMED' && c.bookingExecution.pnr ? ` · PNR ${c.bookingExecution.pnr}` : ''}${c.bookingExecution.retryBlocked ? ' · retry blocked' : ''}` : undefined, !!c.bookingExecution && !['CONFIRMED'].includes(c.bookingExecution.status))}
          {cell('execution', c.execution ? `${c.execution.status} · ${c.execution.reason} · ${c.execution.executorName}` : undefined)}
          {cell('realBooking', meta.executionCapability ? `${meta.executionCapability.realBookingEnabled ? 'flag on' : 'OFF'} → ${meta.executionCapability.effectiveExecutor} (${meta.executionCapability.reason})` : undefined)}
          {cell('sessionV', meta.sessionVersion ?? c.sessionVersion)}
          {cell('searchV', meta.searchResultsVersion ?? c.searchResultsVersion)}
          {meta.turn && <div style={{ gridColumn: '1 / -1' }}>{cell('turn', `#${meta.turn.sequence} · ${meta.turn.status} · ${meta.turn.responseType || '—'} · grounding ${meta.turn.grounding || '—'}${meta.turn.interrupted ? ' · interrupted' : ''}${meta.turn.superseded ? ' · superseded' : ''}`, meta.turn.status === 'FAILED' || meta.turn.grounding === 'RESPONSE_GROUNDING_FAILED')}</div>}
          {meta.tools && meta.tools.length > 0 && <div style={{ gridColumn: '1 / -1' }}>{cell('tools', `J${meta.journeyVersion ?? '—'} · ` + meta.tools.map(t => `${t.tool}:${t.status}${t.fresh ? '·fresh' : ''}${t.parallelGroup ? `·∥${t.parallelGroup}` : ''}${t.latencyMs != null ? `·${t.latencyMs}ms` : ''}${t.rejectionReason ? `(${t.rejectionReason})` : ''}`).join(' | '), meta.tools.some(t => t.status !== 'SUCCEEDED'))}</div>}
          {meta.conversation && <div style={{ gridColumn: '1 / -1' }}>{cell('context', `${meta.conversation.activeJourneyId} · q=${meta.conversation.pendingQuestion || '—'}${meta.conversation.missingFields.length ? ` · missing ${meta.conversation.missingFields.join('/')}` : ''} · results ${meta.conversation.resultSetId ? `${String(meta.conversation.resultSetId).slice(0, 8)}…×${meta.conversation.resultCount}` : '—'}${meta.conversation.activeBookingId ? ` · booking ${String(meta.conversation.activeBookingId).slice(0, 10)}…` : ''}${meta.conversation.activePnrMasked ? ` · PNR ${meta.conversation.activePnrMasked}` : ''}${meta.conversation.rejectedClaims ? ` · ${meta.conversation.rejectedClaims} claim(s) removed` : ''}`, !!meta.conversation.rejectedClaims)}</div>}
          <div style={{ gridColumn: '1 / -1' }}>{cell('ask', meta.pendingQuestion)}</div>
          <div style={{ gridColumn: '1 / -1' }}>{cell('tools', meta.toolActivity)}</div>
          <div style={{ gridColumn: '1 / -1' }}>{cell('events', meta.events?.length ? meta.events.join(', ') : undefined)}</div>
          {meta.error && <div style={{ gridColumn: '1 / -1' }}>{cell('error', `${meta.error.code}`, true)}</div>}
        </div>
      )}
    </div>
  );
};
