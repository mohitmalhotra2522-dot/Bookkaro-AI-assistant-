/**
 * P42.4 — Same Train Alternative ↔ BookingSession binding (phone-test feedback, user decisions 2026-10-07).
 *
 *   1. discoverSameTrainForDisplay — AUTO display discovery for one displayed train/class whose SEARCH status shows a
 *      shortage for this party (WL / NOT AVAILABLE / REGRET / fewer seats than passengers). Triggered by the UI when the
 *      class chip becomes visible (user choice: under every WL class). Bounded: per-result-set budget, in-flight dedupe,
 *      primary availability provider only, no combined pairs. The result is stored for the card / select endpoint only —
 *      the booking is never touched and nothing is claimed in chat.
 *   2. applySameTrainSelection — after a FRESH revalidation passes on "Use this option", the backend applies the ticket
 *      pair + train + class to the session (user choice "apply"): old fare / review are invalid, the fresh check becomes
 *      session availability evidence, passengers are kept, and the boarding rule stays recorded as it was verified.
 *
 * Metadata-only logs. No railway fact is invented: every value comes from the stored result / fresh provider answer.
 */
import type { ConversationStateManager } from '../../ai/state/conversation-state';
import { BookingState, EXECUTION_LOCKED_STATES } from '@shared/states';
import { evaluateSeatShortage } from '@shared/same-train-shortage';
import type { SameTrainAlternativesResult } from '@shared/same-train-alternatives';
import { sameTrainAlternativesEnabledFromEnv } from '../../ai/tools/tool-registry';
import type { RailwayToolService } from '../tools/railway-tool-service';
import { type SameTrainDeps, runSameTrainSearch } from './same-train-engine';
import { liveSameTrainDeps, resolveSameTrainProviders, findSameTrainResult, type RevalidationOutcome } from './same-train-service';

// ------------------------------------------------------------------ 1) auto display discovery

export const SAME_TRAIN_AUTO_SET_CAP = 24;

export function sameTrainAutoBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SAME_TRAIN_AUTO_MAX_PER_RESULTS);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 40) : 12;
}

export type DiscoverCode = 'OK' | 'NOT_ENABLED' | 'INVALID_REQUEST' | 'RESULTS_STALE' | 'TRAIN_NOT_DISPLAYED' | 'CLASS_NOT_LISTED'
  | 'NOT_NEEDED' | 'BUDGET_EXCEEDED' | 'LOCKED' | 'SEARCH_FAILED';

export interface DiscoverOutcome {
  ok: boolean;
  code: DiscoverCode;
  result?: SameTrainAlternativesResult;
  errorCode?: string;
  budget?: { used: number; max: number };
}

const inflight = new Map<string, Promise<DiscoverOutcome>>();

export async function discoverSameTrainForDisplay(state: ConversationStateManager, sessionId: string,
  body: { trainNumber?: unknown; travelClass?: unknown; searchResultsVersion?: unknown },
  opts: { tools?: RailwayToolService; deps?: SameTrainDeps; env?: NodeJS.ProcessEnv; log?: (f: Record<string, unknown>) => void } = {}): Promise<DiscoverOutcome> {
  const env = opts.env || process.env;
  if (!sameTrainAlternativesEnabledFromEnv(env)) return { ok: false, code: 'NOT_ENABLED' };
  const trainNumber = String(body.trainNumber ?? '').trim();
  const travelClass = String(body.travelClass ?? '').trim().toUpperCase();
  const version = Number(body.searchResultsVersion);
  if (!/^\d{5}$/.test(trainNumber) || !/^[A-Z0-9]{1,4}$/.test(travelClass) || !Number.isFinite(version)) return { ok: false, code: 'INVALID_REQUEST' };
  const s: any = state.getSession(sessionId);
  if (EXECUTION_LOCKED_STATES.has(s.bookingState)) return { ok: false, code: 'LOCKED' };
  // the request must belong to the list on screen AND that list must belong to the current journey
  const sr = s.searchResults;
  const j = sr?.journey || {};
  if (!sr || Number(s.searchResultsVersion) !== version) return { ok: false, code: 'RESULTS_STALE' };
  if ((j.origin && s.origin && j.origin !== s.origin) || (j.destination && s.destination && j.destination !== s.destination) || (j.date && s.date && j.date !== s.date)) {
    return { ok: false, code: 'RESULTS_STALE' };
  }
  const row = ((sr.trains || []) as any[]).find(t => String(t?.trainNumber ?? t?.number) === trainNumber);
  if (!row) return { ok: false, code: 'TRAIN_NOT_DISPLAYED' };
  const cls = ((row.classes || []) as any[]).find(c => String(c?.code ?? c).toUpperCase() === travelClass);
  if (!cls) return { ok: false, code: 'CLASS_NOT_LISTED' };
  const pax = Number(s.passengersCount) > 0 ? Number(s.passengersCount) : 1;
  // only a MEANINGFUL shortage shown by the provider's own search status (RAC / UNKNOWN / sufficient → no search)
  const shortage = evaluateSeatShortage({ status: cls?.availability ?? null, requestedPassengerCount: pax });
  if (!shortage.shortage || !shortage.triggerReason) return { ok: false, code: 'NOT_NEEDED' };
  if (shortage.triggerReason === 'TRAIN_CANCELLED') return { ok: false, code: 'NOT_NEEDED' };

  const key = `${sessionId}|${version}|${trainNumber}|${travelClass}|${pax}`;
  const running = inflight.get(key);
  if (running) return running;
  // already discovered for THIS list → return it (same result set; not a cache across lists — a new search = new version)
  const prior = ((s.sameTrainAutoSets || []) as any[]).find(r => r?.autoKey === key);
  if (prior) return { ok: true, code: 'OK', result: prior };

  const max = sameTrainAutoBudgetFromEnv(env);
  const b = s.sameTrainAutoBudget && s.sameTrainAutoBudget.version === version ? s.sameTrainAutoBudget : { version, used: 0 };
  if (b.used >= max) return { ok: false, code: 'BUDGET_EXCEEDED', budget: { used: b.used, max } };
  s.sameTrainAutoBudget = { version, used: b.used + 1 };

  const run = (async (): Promise<DiscoverOutcome> => {
    const pr = resolveSameTrainProviders(null, null);
    if (!pr.ok) return { ok: false, code: 'SEARCH_FAILED', errorCode: pr.code };
    const journeyVersion = s.journeyVersion ?? null;
    const isCurrent = () => {
      const cur: any = state.getSession(sessionId);
      return Number(cur.searchResultsVersion) === version && (cur.journeyVersion ?? null) === journeyVersion && !EXECUTION_LOCKED_STATES.has(cur.bookingState);
    };
    const t0 = Date.now();
    const sel: any = s.selectedTrain;
    const out = await runSameTrainSearch({
      sessionId, turnId: null, requestId: null, journeyVersion,
      trainNumber, trainName: row.trainName || row.name, date: String(s.date || j.date), travelClass, passengersCount: pax,
      origin: String(s.origin || j.origin), destination: String(s.destination || j.destination), originName: s.originName, destinationName: s.destinationName,
      originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false,
      // primary availability provider only (bounded cost); route from the resolved route provider — never a hidden failover
      providers: pr.providers.slice(0, 1), routeProvider: pr.routeProvider, webProviders: [],
      triggerReason: shortage.triggerReason, triggerSource: 'AUTO_DISPLAY',
      contextSnapshot: { selectedTrain: sel ? String(sel.number || sel.trainNumber || '') || null : null, selectedClass: s.selectedClass ? String(s.selectedClass).toUpperCase() : null, journeyVersion }
    } as any, opts.deps || liveSameTrainDeps(opts.tools as any, { isCurrent }));
    if (!isCurrent()) return { ok: false, code: 'RESULTS_STALE' };
    if (!out.ok) {
      opts.log?.({ event: 'same_train_auto', ok: false, code: out.code, trainNumber, travelClass, pax, latencyMs: Date.now() - t0 });
      return { ok: false, code: 'SEARCH_FAILED', errorCode: out.code };
    }
    const result: any = { ...out.result, autoKey: key, searchResultsVersion: version };
    const cur: any = state.getSession(sessionId);
    cur.sameTrainAutoSets = [result, ...((cur.sameTrainAutoSets || []) as any[]).filter(x => x?.autoKey !== key)].slice(0, SAME_TRAIN_AUTO_SET_CAP);
    opts.log?.({ event: 'same_train_auto', ok: true, trainNumber, travelClass, pax, trigger: shortage.triggerReason, status: result.status,
      candidates: result.candidateCount ?? null, verified: (result.alternatives || []).filter((a: any) => !a.isRequestedPair && (a.availability === 'RAC' || a.availability === 'AVAILABLE') && (a.verificationStatus === 'VERIFIED' || a.verificationStatus === 'PARTIALLY_VERIFIED')).length,
      budgetUsed: b.used + 1, budgetMax: max, latencyMs: Date.now() - t0 });
    return { ok: true, code: 'OK', result };
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

// ------------------------------------------------------------------ 2) apply an explicitly selected, freshly revalidated option

export interface SameTrainSelection {
  alternativeSearchId: string;
  alternativeId: string;
  trainNumber: string;
  travelClass: string;
  date: string;
  ticketOrigin: string;
  ticketDestination: string;
  requestedOrigin: string;
  requestedDestination: string;
  boardingStation: string;
  alightingStation: string;
  boardingRuleStatus: string;
  alightingRuleStatus: string;
  freshStatus: string;
  fetchedAt: string;
  appliedAt: string;
}

const STATE_ORDER = Object.values(BookingState) as string[];
const idx = (st: string) => STATE_ORDER.indexOf(st);

/**
 * Applies a revalidated selection to the BookingSession. Call ONLY with an `ok` RevalidationOutcome. Passengers already
 * entered are kept (the travellers don't change with the ticket pair); train / class / availability / fare / review are
 * rebuilt from the selection; the fresh provider answer becomes the class availability (guard evidence).
 */
export function applySameTrainSelection(state: ConversationStateManager, sessionId: string, stored: SameTrainAlternativesResult, out: RevalidationOutcome)
  : { applied: boolean; reason?: string; selection?: SameTrainSelection } {
  if (!out.ok || !out.alternative || !out.fresh?.length) return { applied: false, reason: 'NOT_REVALIDATED' };
  const s: any = state.getSession(sessionId);
  if (EXECUTION_LOCKED_STATES.has(s.bookingState)) return { applied: false, reason: 'LOCKED' };
  const alt: any = (stored.alternatives || []).find(a => a.alternativeId === out.alternative!.alternativeId) || out.alternative;
  const fresh = out.fresh[0];
  const row = ((s.searchResults?.trains || []) as any[]).find(t => String(t?.trainNumber ?? t?.number) === alt.trainNumber);
  const prevSel: any = s.selectedTrain;
  const trainSrc = row || (prevSel && String(prevSel.number ?? prevSel.trainNumber) === alt.trainNumber ? prevSel : { trainNumber: alt.trainNumber, trainName: stored.trainName });
  const prevState: string = s.bookingState;

  // a) journey = ticket pair (what IRCTC must search); dependent data invalidated; passengers KEPT
  if (idx(prevState) > idx(BookingState.SHOWING_TRAINS)) state.tryTransition(sessionId, BookingState.SHOWING_TRAINS);
  s.origin = alt.ticketOrigin; s.originName = alt.ticketOriginName || (alt.ticketOrigin === stored.requestedOrigin ? stored.requestedOriginName : undefined);
  s.destination = alt.ticketDestination; s.destinationName = alt.ticketDestinationName || (alt.ticketDestination === stored.requestedDestination ? stored.requestedDestinationName : undefined);
  s.selectedClass = undefined; s.fare = undefined; s.availability = undefined;
  s.reviewConfirmed = false; s.irctcHandoffReady = false; s.confirmedReviewVersion = undefined;
  if (s.review && s.review.valid) { s.review.valid = false; s.review.invalidatedReason = 'SAME_TRAIN_ALTERNATIVE_APPLIED'; }
  s.pendingConfirmation = undefined;

  // b) train + class via the existing setters / validated transitions
  state.setSelectedTrain(sessionId, trainSrc);
  state.tryTransition(sessionId, BookingState.TRAIN_SELECTED);
  state.tryTransition(sessionId, BookingState.CLASS_OPTIONS);
  state.setSelectedClass(sessionId, alt.travelClass);
  state.tryTransition(sessionId, BookingState.CLASS_SELECTED);
  // the user was already booking → resume at preparation (readiness is recomputed by the preparation service)
  if (idx(prevState) >= idx(BookingState.BOOKING_PREPARE)) state.tryTransition(sessionId, BookingState.BOOKING_PREPARE);

  // c) the FRESH revalidation is the authoritative availability for this train/class/date/ticket pair
  const cat = fresh.category;
  state.setAvailability(sessionId, alt.travelClass, {
    // RAC counts as available for an alternative (user rule); the status text keeps "RAC n" (never called a seat)
    available: cat === 'AVAILABLE' || cat === 'RAC', status: fresh.status, dataSource: stored.isMock ? 'MOCK' : 'LIVE',
    fetchedAt: fresh.fetchedAt, toolExecutionId: `${stored.alternativeSearchId}:select:${alt.alternativeId}`,
    trainNumber: alt.trainNumber, travelClass: alt.travelClass, date: alt.date, origin: alt.ticketOrigin, destination: alt.ticketDestination
  } as any);

  const selection: SameTrainSelection = {
    alternativeSearchId: stored.alternativeSearchId, alternativeId: alt.alternativeId, trainNumber: alt.trainNumber, travelClass: alt.travelClass, date: alt.date,
    ticketOrigin: alt.ticketOrigin, ticketDestination: alt.ticketDestination, requestedOrigin: stored.requestedOrigin, requestedDestination: stored.requestedDestination,
    boardingStation: alt.boardingStation, alightingStation: alt.alightingStation, boardingRuleStatus: alt.boardingRuleStatus, alightingRuleStatus: alt.alightingRuleStatus,
    freshStatus: fresh.status, fetchedAt: fresh.fetchedAt, appliedAt: new Date().toISOString()
  };
  s.sameTrainSelection = selection;
  state.bump(sessionId);
  return { applied: true, selection };
}

/** Every result the select endpoint may resolve against: Muse's sets + auto display sets. */
export function findAnySameTrainResult(s: any, alternativeSearchId: string): SameTrainAlternativesResult | undefined {
  return findSameTrainResult(s, alternativeSearchId) || ((s?.sameTrainAutoSets || []) as any[]).find(r => r?.alternativeSearchId === alternativeSearchId);
}
