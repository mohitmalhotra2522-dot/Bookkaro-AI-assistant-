/**
 * PROMPT 42 — Same Train Alternative views (no new facts — projections of the validated result only).
 *
 *   - sameTrainLLMView: compact result for Muse. Alternatives are an OBJECT keyed by alternativeId (the native tool
 *     transcript trims arrays to 12 items and the JSON mode drops `…Id` keys — an object keyed "A1".."An" survives
 *     both, so Muse always sees every checked pair). No secrets, no provider bodies.
 *   - sameTrainCardData: the screen payload (evidence summarised, never raw).
 *   - sameTrainFallbackText: deterministic one-liner used ONLY when no grounded Muse wording survives.
 */
import type { SameTrainAlternative, SameTrainAlternativesResult } from '@shared/same-train-alternatives';
import { SAME_TRAIN_ALL_FAILED_MESSAGE } from '@shared/same-train-alternatives';

const evidenceLine = (a: SameTrainAlternative) => a.evidence
  .map(e => `${e.provider}:${e.outcome === 'SUCCESS' ? e.availability?.status : e.outcome === 'REJECTED' ? `REJECTED(${e.rejectedReason})` : e.outcome}`)
  .join(', ');

export function sameTrainLLMView(r: SameTrainAlternativesResult): Record<string, unknown> {
  // compact per-option entries (the transcript has a size budget): station names once at the top, rule status only
  // when a rule matters, travel stations only when they differ from the ticket (VERIFIED rule)
  const alternatives: Record<string, unknown> = {};
  for (const a of r.alternatives) {
    const travel = `${a.boardingStation}→${a.alightingStation}`;
    const ticket = `${a.ticketOrigin}→${a.ticketDestination}`;
    alternatives[a.alternativeId] = {
      kind: a.kind, ticket,
      availability: a.availability, ...(a.availabilityStatusText ? { status: a.availabilityStatusText } : {}),
      verificationStatus: a.verificationStatus,
      ...(a.boardingRuleStatus !== 'NOT_REQUIRED' ? { boardingRuleStatus: a.boardingRuleStatus } : {}),
      ...(a.alightingRuleStatus !== 'NOT_REQUIRED' ? { alightingRuleStatus: a.alightingRuleStatus } : {}),
      ...(travel !== ticket ? { travelOn: travel } : {}),
      ...(a.fare.status === 'PROVIDER' ? { fare: { ...(a.fare.total !== undefined ? { total: a.fare.total } : {}), ...(a.fare.perPassenger !== undefined ? { perPassenger: a.fare.perPassenger } : {}), provider: a.fare.provider } } : a.fare.status !== 'NOT_REQUESTED' ? { fare: a.fare.status } : {}),
      providers: evidenceLine(a),
      ...(a.extensionStations ? { extensionStations: a.extensionStations } : {}),
      ...(a.webEvidence.length ? { web: a.webEvidence.map(w => `${w.provider}:${w.listed === null ? 'n/a' : w.listed ? 'listed' : 'not listed'} (UNVERIFIED_WEB)`).join(', ') } : {})
    };
  }
  const stationNames: Record<string, string> = {};
  for (const st of r.route.stations) if (st.name) stationNames[st.code] = st.name;
  return {
    alternativeSearchId: r.alternativeSearchId, searchRef: r.alternativeSearchId,
    status: r.status, errors: r.errors, isMock: r.isMock,
    trainNumber: r.trainNumber, ...(r.trainName ? { trainName: r.trainName } : {}), date: r.date, travelClass: r.travelClass, passengersCount: r.passengersCount,
    requested: `${r.requestedOrigin}→${r.requestedDestination}`,
    route: { provider: r.route.provider, trainOrigin: r.route.trainOrigin, trainTerminal: r.route.trainTerminal,
      originSweep: r.route.originSweep.join(','), destinationExtension: r.route.destinationExtension.join(','), destinationSweep: r.route.destinationSweep },
    providerCoverage: r.providers.map(p => `${p.provider}: ${p.succeeded}/${p.requested} ok${p.timeouts ? `, ${p.timeouts} timeout` : ''}${p.failed ? `, ${p.failed} failed` : ''}`).join(' · '),
    candidateCount: r.candidateCount, shownCount: r.alternatives.length, invalidHidden: r.invalidCount, webEvidence: r.webEvidence,
    stationNames,
    alternatives,
    rules: 'Ticket stations ≠ travel stations (travel = ticket unless travelOn is given). boardingRuleStatus/alightingRuleStatus UNVERIFIED → never say the user can board/deboard at the requested station; say it must be verified. UNKNOWN/TIMEOUT is not "no seats". CONFLICTING = providers disagree, state no value. You rank; PRESENT_SAME_TRAIN_ALTERNATIVES records your best match for the screen.'
  };
}

/** Screen payload: the result with evidence summarised (provider / outcome / status / time) — never raw bodies. */
export function sameTrainCardData(r: SameTrainAlternativesResult, opts: { stale?: boolean } = {}): Record<string, unknown> {
  return {
    ...r,
    alternatives: r.alternatives.map(a => ({
      ...a,
      evidence: a.evidence.map(e => ({ provider: e.provider, providerLabel: e.providerLabel, level: e.level, outcome: e.outcome, fetchedAt: e.fetchedAt,
        ...(e.availability ? { status: e.availability.status, category: e.availability.category } : {}), ...(e.errorCode ? { errorCode: e.errorCode } : {}),
        ...(e.fare ? { fare: e.fare } : {}) }))
    })),
    route: { ...r.route },
    stale: !!opts.stale
  };
}

const label = (a: SameTrainAlternative) => `${a.ticketOriginName || a.ticketOrigin} se ${a.ticketDestinationName || a.ticketDestination}`;

/** Deterministic, fact-only one-liner (Hinglish) — used only when Muse's wording is missing / rejected. */
export function sameTrainFallbackText(r: SameTrainAlternativesResult | null, errorCode?: string): string {
  if (!r) return errorCode === 'INVALID_TRAIN_ROUTE' ? 'Is train ka route verify nahi ho paaya, isliye same train alternative check nahi hua.' : SAME_TRAIN_ALL_FAILED_MESSAGE;
  const good = r.alternatives.filter(a => !a.isRequestedPair && (a.availability === 'AVAILABLE' || a.availability === 'RAC') && (a.verificationStatus === 'VERIFIED' || a.verificationStatus === 'PARTIALLY_VERIFIED'));
  const checked = `${r.trainNumber} ${r.travelClass} ke ${r.candidateCount} station pairs check kiye.`;
  if (!good.length) return `${checked} Koi behtar same train option nahi mila — details screen par hain.`;
  const first = good[0];
  const rule = first.boardingRuleStatus === 'UNVERIFIED' ? ` ${r.requestedOriginName || r.requestedOrigin} se boarding ka rule verify karna zaroori hai.`
    : first.alightingRuleStatus === 'UNVERIFIED' ? ` ${r.requestedDestinationName || r.requestedDestination} par utarne ka rule verify karna zaroori hai.` : '';
  return `${checked} ${good.length} option${good.length > 1 ? 's' : ''} mein availability mili, jaise ${label(first)}: ${first.availabilityStatusText || first.availability}.${rule} Details screen par hain.`;
}
