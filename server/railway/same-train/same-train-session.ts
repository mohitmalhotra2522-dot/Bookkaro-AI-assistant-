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
import type { SameTrainAlternativesResult, SameTrainStaleCheck } from '@shared/same-train-alternatives';
import { sameTrainAlternativesEnabledFromEnv } from '../../ai/tools/tool-registry';
import type { RailwayToolService } from '../tools/railway-tool-service';
import type { SameTrainDeps, SameTrainProgress } from './same-train-engine';
import { scheduledSameTrainDeps, sameTrainPacedQueueEnabled } from './same-train-service';
import { liveSameTrainDeps, searchSameTrainAlternatives, resolveSameTrainProviders, findSameTrainResult, sameTrainResultsOf, isSameTrainResultStale, type RevalidationOutcome } from './same-train-service';

// ------------------------------------------------------------------ 1) auto display discovery

// F3: every eligible (waitlisted) train of a list gets its search — the paced queue (not a small budget) protects the
// provider quota, so the per-list budget / stored-set cap cover a full result list (hard max 40 as before)
export const SAME_TRAIN_AUTO_SET_CAP = 40;

export function sameTrainAutoBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SAME_TRAIN_AUTO_MAX_PER_RESULTS);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 40) : 40;
}

export type DiscoverCode = 'OK' | 'RUNNING' | 'NOT_ENABLED' | 'INVALID_REQUEST' | 'RESULTS_STALE' | 'TRAIN_NOT_DISPLAYED' | 'CLASS_NOT_LISTED'
  | 'NOT_NEEDED' | 'BUDGET_EXCEEDED' | 'LOCKED' | 'SEARCH_FAILED';

export interface DiscoverOutcome {
  ok: boolean;
  code: DiscoverCode;
  result?: SameTrainAlternativesResult;
  errorCode?: string;
  budget?: { used: number; max: number };
  /** F3: RUNNING → genuine progress of the queued search (counts + interim seats; not a final verdict) */
  progress?: DiscoverProgress | null;
  /** 2026-10-09: a failed search whose checks came back with too-old provider snapshots (never a verdict) */
  staleChecks?: SameTrainStaleCheck[];
}

/** F3 progress view of one automatic search (QUEUED = waiting for its first provider slot). */
export interface DiscoverProgress extends Omit<SameTrainProgress, 'stage'> { state: 'QUEUED' | 'RUNNING' | 'FINALIZING'; startedAt: string; updatedAt: string }

const inflight = new Map<string, Promise<DiscoverOutcome>>();
const progressByKey = new Map<string, DiscoverProgress>();
// F3: the FINAL failure of a finished automatic search, so a polling client gets that outcome instead of starting a new
// search (successes are stored on the session as before). Bounded + short-lived; outcome codes only, no railway data.
const finishedFailures = new Map<string, { outcome: DiscoverOutcome; at: number }>();
const FAILURE_TTL_MS = 15 * 60_000;
function rememberFailure(key: string, outcome: DiscoverOutcome) {
  finishedFailures.set(key, { outcome, at: Date.now() });
  if (finishedFailures.size > 500) { const first = finishedFailures.keys().next().value; if (first !== undefined) finishedFailures.delete(first); }
}
function recentFailure(key: string): DiscoverOutcome | null {
  const f = finishedFailures.get(key);
  if (!f) return null;
  if (Date.now() - f.at > FAILURE_TTL_MS) { finishedFailures.delete(key); return null; }
  return f.outcome;
}

export async function discoverSameTrainForDisplay(state: ConversationStateManager, sessionId: string,
  body: { trainNumber?: unknown; travelClass?: unknown; searchResultsVersion?: unknown },
  opts: { tools?: RailwayToolService; deps?: SameTrainDeps; env?: NodeJS.ProcessEnv; log?: (f: Record<string, unknown>) => void;
    /** F3 (async polling): reports the job key; returns a finished search's failure instead of re-running it */
    onKey?: (key: string) => void; reuseFailure?: boolean } = {}): Promise<DiscoverOutcome> {
  const env = opts.env || process.env;
  if (!sameTrainAlternativesEnabledFromEnv(env)) return { ok: false, code: 'NOT_ENABLED' };
  const trainNumber = String(body.trainNumber ?? '').trim();
  // P42.7: one discovery per TRAIN — travelClass is optional (legacy per-class callers still work)
  const askedClass = String(body.travelClass ?? '').trim().toUpperCase();
  const version = Number(body.searchResultsVersion);
  if (!/^\d{5}$/.test(trainNumber) || (askedClass && !/^[A-Z0-9]{1,4}$/.test(askedClass)) || !Number.isFinite(version)) return { ok: false, code: 'INVALID_REQUEST' };
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
  const rowClasses = ((row.classes || []) as any[]).map(c => ({ code: String(c?.code ?? c).toUpperCase(), availability: c?.availability ?? null }))
    .filter(c => /^[A-Z0-9]{1,4}$/.test(c.code));
  const pax = Number(s.passengersCount) > 0 ? Number(s.passengersCount) : 1;
  // only a MEANINGFUL shortage shown by the provider's own search status (RAC / UNKNOWN / sufficient → no search)
  const meaningful = (c: { availability: unknown }) => {
    const a = evaluateSeatShortage({ status: c.availability ?? null, requestedPassengerCount: pax });
    return a.shortage && a.triggerReason && a.triggerReason !== 'TRAIN_CANCELLED' ? a : null;
  };
  // P42.7 per-train eligibility on the REQUESTED class (selected class → the class the user named at search). Another class
  // being available never suppresses it; requested-class seats sufficient → no automatic recovery. Requested class unknown
  // → P42.4 behaviour: the train's first class (provider order) with a shortage seeds the all-class search.
  const requested = String(s.selectedClass || s.requestedClass || '').toUpperCase() || null;
  const seedCode = requested || askedClass || null;
  let cls: { code: string; availability: unknown } | undefined;
  if (seedCode) {
    cls = rowClasses.find(c => c.code === seedCode);
    if (!cls) return { ok: false, code: 'CLASS_NOT_LISTED' };
  } else cls = rowClasses.find(c => meaningful(c));
  const shortage = cls ? meaningful(cls) : null;
  if (!cls || !shortage) return { ok: false, code: 'NOT_NEEDED' };
  const travelClass = cls.code;
  // P42-14 (user decision 2026-10-09): search ONLY the classes that show a shortage (waiting) on this train's search row —
  // seed / requested class first; a class that is already available on the row is not re-searched
  const classes = [travelClass, ...rowClasses.filter(c => c.code !== travelClass && meaningful(c)).map(c => c.code)];

  const key = `${sessionId}|${version}|${trainNumber}|${travelClass}|${pax}`;
  opts.onKey?.(key);
  const running = inflight.get(key);
  if (running) return running;
  // already discovered for THIS list → return it (same result set; not a cache across lists — a new search = new version)
  const prior = ((s.sameTrainAutoSets || []) as any[]).find(r => r?.autoKey === key);
  if (prior) return { ok: true, code: 'OK', result: prior };
  if (opts.reuseFailure) { const f = recentFailure(key); if (f) return f; }
  // P42.5: Muse (or the BFE safety-net) already searched exactly this train / class / party for THIS list in the current
  // journey → show that same fresh result (no second provider fan-out for one list). Never an older list's result.
  const listAt = Date.parse(String(sr.retrievedAt || sr.searchMeta?.retrievedAt || ''));
  // P42.7: only a result whose matrix covered every class of this train row (all-class) can stand in for the auto search
  const museResult = Number.isFinite(listAt) ? sameTrainResultsOf(s).find((r: any) => r && String(r.trainNumber) === trainNumber
    && String(r.travelClass).toUpperCase() === travelClass && classes.every(c => (Array.isArray(r.classesChecked) ? r.classesChecked : [r.travelClass]).includes(c)) && Number(r.requestedPassengerCount ?? r.passengersCount) === pax
    && (!s.date || r.date === s.date) && (!s.origin || r.requestedOrigin === s.origin) && (!s.destination || r.requestedDestination === s.destination)
    && (r.contextSnapshot?.journeyVersion ?? null) === (s.journeyVersion ?? null) && Date.parse(String(r.completedAt || '')) >= listAt
    && !isSameTrainResultStale(s, r)) : undefined;
  if (museResult) return { ok: true, code: 'OK', result: museResult };

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
    // F3: genuine progress for the polling UI (QUEUED until the first provider outcome arrives)
    const startedAt = new Date(t0).toISOString();
    progressByKey.set(key, { state: 'QUEUED', total: 0, done: 0, succeeded: 0, failed: 0, retried: 0, found: [], startedAt, updatedAt: startedAt });
    const onProgress = (p: SameTrainProgress) => {
      const { stage, ...counts } = p;
      progressByKey.set(key, { ...counts, state: stage === 'FINALIZING' ? 'FINALIZING' : p.done > 0 ? 'RUNNING' : 'QUEUED', startedAt, updatedAt: new Date().toISOString() });
    };
    const deps: SameTrainDeps = opts.deps
      ? { ...opts.deps, onProgress: (p: SameTrainProgress) => { onProgress(p); opts.deps!.onProgress?.(p); } }
      : sameTrainPacedQueueEnabled(env) ? scheduledSameTrainDeps(opts.tools as any, { isCurrent, onProgress })
      : liveSameTrainDeps(opts.tools as any, { isCurrent, onProgress });
    const out = await searchSameTrainAlternatives({
      sessionId, turnId: null, requestId: null, journeyVersion,
      trainNumber, trainName: row.trainName || row.name, date: String(s.date || j.date), travelClass, classes, passengersCount: pax,
      origin: String(s.origin || j.origin), destination: String(s.destination || j.destination), originName: s.originName, destinationName: s.destinationName,
      originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false,
      // P42-14: no seat inside ≤15 earlier stations / destination + 5..7 → continue the destination up to the train's terminal
      terminalSweep: 'AUTO',
      // primary availability provider only (bounded cost); route from the resolved route provider — never a hidden failover
      providers: pr.providers.slice(0, 1), routeProvider: pr.routeProvider, webProviders: [], fallbackProviders: pr.fallbacks, routeFallback: pr.routeFallback,
      triggerReason: shortage.triggerReason, triggerSource: 'AUTO_DISPLAY',
      contextSnapshot: { selectedTrain: sel ? String(sel.number || sel.trainNumber || '') || null : null, selectedClass: s.selectedClass ? String(s.selectedClass).toUpperCase() : null, journeyVersion,
        requestedClass: s.requestedClass ? String(s.requestedClass).toUpperCase() : null }
    } as any, deps);
    if (!isCurrent()) return { ok: false, code: 'RESULTS_STALE' };
    if (!out.ok) {
      opts.log?.({ event: 'same_train_auto', ok: false, code: out.code, trainNumber, travelClass, pax, paced: !!deps.scheduled, latencyMs: Date.now() - t0 });
      const stale = (out as any).partial?.staleChecks as SameTrainStaleCheck[] | undefined;
      const failed: DiscoverOutcome = { ok: false, code: 'SEARCH_FAILED', errorCode: out.code, ...(stale?.length ? { staleChecks: stale } : {}) };
      rememberFailure(key, failed);
      return failed;
    }
    const result: any = { ...out.result, autoKey: key, searchResultsVersion: version };
    const cur: any = state.getSession(sessionId);
    cur.sameTrainAutoSets = [result, ...((cur.sameTrainAutoSets || []) as any[]).filter(x => x?.autoKey !== key)].slice(0, SAME_TRAIN_AUTO_SET_CAP);
    opts.log?.({ event: 'same_train_auto', ok: true, trainNumber, travelClass, pax, trigger: shortage.triggerReason, status: result.status,
      requestedClassKnown: !!requested, recoveryEligible: true, recoveryReason: shortage.triggerReason, classesChecked: (result.classesChecked || []).join(','),
      earlierStationsChecked: result.earlierStationsChecked ?? null, downstreamStationsChecked: result.downstreamStationsChecked ?? null,
      candidates: result.candidateCount ?? null, verified: (result.alternatives || []).filter((a: any) => !a.isRequestedPair && (a.availability === 'RAC' || a.availability === 'AVAILABLE') && (a.verificationStatus === 'VERIFIED' || a.verificationStatus === 'PARTIALLY_VERIFIED')).length,
      budgetUsed: b.used + 1, budgetMax: max, paced: !!deps.scheduled, searchComplete: result.searchComplete ?? null,
      checks: result.checkSummary ?? null, latencyMs: Date.now() - t0 });
    return { ok: true, code: 'OK', result };
  })().finally(() => { inflight.delete(key); progressByKey.delete(key); });
  inflight.set(key, run);
  return run;
}

/**
 * F3 — asynchronous automatic discovery for a POLLING client: starts (or joins) the queued search and returns at once
 * with RUNNING + genuine progress while it is still running; a finished search returns its final outcome (OK card /
 * failure). Repeated polls never start a second search for the same list / train / class / party (in-flight dedupe,
 * stored result, remembered failure) and never spend budget.
 */
export async function discoverSameTrainForDisplayAsync(state: ConversationStateManager, sessionId: string,
  body: { trainNumber?: unknown; travelClass?: unknown; searchResultsVersion?: unknown },
  opts: Parameters<typeof discoverSameTrainForDisplay>[3] & { waitMs?: number } = {}): Promise<DiscoverOutcome> {
  let key: string | undefined;
  const job = discoverSameTrainForDisplay(state, sessionId, body, { ...opts, reuseFailure: true, onKey: k => { key = k; } })
    .catch((): DiscoverOutcome => ({ ok: false, code: 'SEARCH_FAILED', errorCode: 'INTERNAL' }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = await Promise.race([job, new Promise<null>(r => { timer = setTimeout(() => r(null), Math.max(0, opts.waitMs ?? 300)); })]);
  if (timer) clearTimeout(timer);
  if (waited) return waited;
  return { ok: true, code: 'RUNNING', progress: key ? progressByKey.get(key) ?? null : null };
}

/** F3 observability: number of automatic searches currently running (counts only). */
export function sameTrainAutoJobsRunning(): number { return inflight.size; }

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
