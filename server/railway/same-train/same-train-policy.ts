/**
 * Phase 2 (findBoardFromEarlier) — ONE same-train availability policy for every caller.
 *
 * The automatic display discovery (same-train-session) and Muse's SEARCH_SAME_TRAIN_ALTERNATIVES tool (validator →
 * runtime, incl. the BFE safety-net) both read their rules from here — eligibility (WL-only), the class matrix, the staged
 * search depth, probe / train concurrency and the paced provider queue. Neither caller keeps its own copy, so the two
 * paths cannot drift. Freshness, stale snapshots, better-WL marking, date-identity checks and the fresh re-check before a
 * selection live in the shared engine / service (same-train-engine, same-train-service) that both callers already run.
 *
 * Rollback switches (env): SAME_TRAIN_WL_ONLY=off, SAME_TRAIN_STAGED_DEPTH=off (both callers), and
 * SAME_TRAIN_MUSE_SHARED_POLICY=off (Muse's tool only → pre-Phase-2 tool behaviour).
 */
import { evaluateSeatShortage, type SeatShortageAssessment } from '@shared/same-train-shortage';
import type { BfeEligibility } from '@shared/bfe-eligibility';
import { BOARD_EARLIER_STOPS, BOOK_UPTO_STOPS, EARLIER_PROBE_CONCURRENCY, SAME_TRAIN_TRAIN_CONCURRENCY } from '@shared/same-train-alternatives';
import type { RailwayToolService } from '../tools/railway-tool-service';
import type { SameTrainDeps, SameTrainProgress, SameTrainSearchRequest } from './same-train-engine';
import { sameTrainLimitsFromEnv } from './same-train-engine';
import { liveSameTrainDeps, scheduledSameTrainDeps, sameTrainPacedQueueEnabled } from './same-train-service';

// ------------------------------------------------------------------ config

export interface BoardFromEarlierConfig {
  /** only trains whose DIRECT status is a waitlist, waitlisted classes only (SAME_TRAIN_WL_ONLY, default on) */
  wlOnly: boolean;
  /** staged depth (SAME_TRAIN_STAGED_DEPTH, default on): first earlier / ahead stops, then origin / terminus if nothing found */
  staged: { earlier: number; ahead: number } | null;
  probeConcurrency: number;
  trainConcurrency: number;
}
const flagOn = (v: unknown) => !/^(0|off|false|no)$/i.test(String(v ?? '').trim());
const intIn = (v: unknown, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.min(hi, Math.max(lo, Math.floor(n))) : d; };

export function boardFromEarlierConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BoardFromEarlierConfig {
  return {
    wlOnly: flagOn(env.SAME_TRAIN_WL_ONLY),
    staged: flagOn(env.SAME_TRAIN_STAGED_DEPTH)
      ? { earlier: intIn(env.SAME_TRAIN_BOARD_EARLIER_STOPS, BOARD_EARLIER_STOPS, 0, 15), ahead: intIn(env.SAME_TRAIN_BOOK_UPTO_STOPS, BOOK_UPTO_STOPS, 0, 7) } : null,
    probeConcurrency: intIn(env.SAME_TRAIN_PROBE_CONCURRENCY, EARLIER_PROBE_CONCURRENCY, 1, 12),
    trainConcurrency: intIn(env.SAME_TRAIN_TRAIN_CONCURRENCY, SAME_TRAIN_TRAIN_CONCURRENCY, 1, 40)
  };
}

/** Muse's tool follows the shared policy (default on). off → the pre-Phase-2 tool behaviour (rollback only). */
export function museSharedPolicyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env.SAME_TRAIN_MUSE_SHARED_POLICY);
}

/** The policy Muse's tool must follow right now, or null when the Muse rollback switch is off. */
export function musePolicyFromEnv(env: NodeJS.ProcessEnv = process.env): BoardFromEarlierConfig | null {
  return museSharedPolicyEnabled(env) ? boardFromEarlierConfigFromEnv(env) : null;
}

// ------------------------------------------------------------------ eligibility (WL-only)

/**
 * Does the provider's own status for one class justify a same-train search for this party? wlOnly → WAITLIST only
 * (AVAILABLE / RAC / REGRET / NOT AVAILABLE / CANCELLED / UNKNOWN never); otherwise the pre-Phase-2 shortage rule.
 * Returns the assessment when eligible, else null. Pure.
 */
export function sameTrainClassEligibility(status: unknown, passengers: number, cfg: BoardFromEarlierConfig): SeatShortageAssessment | null {
  const a = evaluateSeatShortage({ status: status ?? null, requestedPassengerCount: Number.isInteger(passengers) && passengers > 0 ? passengers : 1 });
  if (cfg.wlOnly) return a.availabilityStatus === 'WAITLIST' ? a : null;
  return a.shortage && a.triggerReason && a.triggerReason !== 'TRAIN_CANCELLED' ? a : null;
}

export interface RowClass { code: string; availability: unknown }

/** The authoritative row's classes (codes upper-cased, invalid codes dropped; provider order kept). */
export function rowClassesOf(row: any): RowClass[] {
  return ((row?.classes || []) as any[]).map(c => ({ code: String(c?.code ?? c).toUpperCase(), availability: c?.availability ?? null }))
    .filter(c => /^[A-Z0-9]{1,4}$/.test(c.code));
}

/** First eligible class of the row (provider order), '' when none — the seed when no class was requested. */
export function firstEligibleClass(row: any, passengers: number, cfg: BoardFromEarlierConfig): string {
  return rowClassesOf(row).find(c => sameTrainClassEligibility(c.availability, passengers, cfg))?.code ?? '';
}

/**
 * The class matrix of one search: the seed class first, then every OTHER eligible class of the row (an available /
 * RAC / REGRET class is never searched under wlOnly). `limitTo` (Muse's explicit list) narrows the others, never widens.
 */
export function eligibleClassMatrix(seed: string, rowClasses: RowClass[], passengers: number, cfg: BoardFromEarlierConfig, limitTo?: string[]): string[] {
  const s = String(seed || '').toUpperCase();
  const allow = limitTo ? new Set(limitTo.map(c => String(c).toUpperCase())) : null;
  return [s, ...rowClasses.filter(c => c.code !== s && (!allow || allow.has(c.code)) && sameTrainClassEligibility(c.availability, passengers, cfg)).map(c => c.code)];
}

/** The direct status per searched class (for "better WL"), from the authoritative row only. */
export function directStatusOf(rowClasses: RowClass[], classes: string[]): Record<string, string> {
  return Object.fromEntries(rowClasses.filter(c => classes.includes(c.code) && c.availability != null).map(c => [c.code, String(c.availability)]));
}

/** BFE eligibility (Muse fact + safety-net trigger) under the same WL-only rule: a non-waitlist shortage is not eligible. */
export function applySameTrainPolicyToBfe(e: BfeEligibility, cfg: BoardFromEarlierConfig | null): BfeEligibility {
  if (!cfg || !cfg.wlOnly || !e.eligible || e.reason === 'WAITLIST') return e;
  const { confirmedSeats: _c, ...rest } = e;
  return { ...rest, eligible: false, reason: null, notEligibleReason: 'NOT_WAITLIST' };
}

// ------------------------------------------------------------------ search shape (depth / pairs / concurrency)

export type SharedSearchShape = Pick<SameTrainSearchRequest, 'originSweep' | 'destinationSweep' | 'destinationExtensionStations' | 'combinedPairs' | 'terminalSweep' | 'staged' | 'probeConcurrency' | 'directStatus'>;

/**
 * The search depth every caller uses: requested pair + earlier stops + stops past the destination, single-ended pairs
 * only (no combined pairs), staged (2 back / 3 ahead first; origin, then terminus only when nothing bookable was found).
 */
export function sharedSearchShape(cfg: BoardFromEarlierConfig, directStatus: Record<string, string>): SharedSearchShape {
  return {
    originSweep: true, destinationSweep: true, destinationExtensionStations: undefined, combinedPairs: 'NEVER', terminalSweep: 'AUTO',
    ...(cfg.staged ? { staged: cfg.staged } : {}), probeConcurrency: cfg.probeConcurrency, directStatus
  };
}

// ------------------------------------------------------------------ train slots (≤ trainConcurrency searches at once)

let trainSlotsUsed = 0;
const trainSlotWaiters: Array<() => void> = [];

/**
 * At most `max` same-train searches run at once (the rest wait FIFO). `priority` (a user-facing Muse tool call) waits at
 * the FRONT of the queue; `waitMs` bounds the wait → null (no slot; the caller reports an honest "busy", never a verdict).
 */
export async function acquireTrainSlot(max: number, opts: { priority?: boolean; waitMs?: number } = {}): Promise<(() => void) | null> {
  if (trainSlotsUsed >= max) {
    let wake!: () => void;
    let granted = false;
    const got = new Promise<boolean>(res => { wake = () => { granted = true; res(true); }; });
    if (opts.priority) trainSlotWaiters.unshift(wake); else trainSlotWaiters.push(wake);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ok = opts.waitMs === undefined ? await got
      : await Promise.race([got, new Promise<boolean>(res => { timer = setTimeout(() => res(false), Math.max(0, opts.waitMs!)); })]);
    if (timer) clearTimeout(timer);
    if (!ok && !granted) { const i = trainSlotWaiters.indexOf(wake); if (i >= 0) trainSlotWaiters.splice(i, 1); return null; }
  } else trainSlotsUsed++;
  let released = false;
  return () => {
    if (released) return; released = true;
    const next = trainSlotWaiters.shift();
    if (next) next();            // the slot passes straight to the next waiting search
    else trainSlotsUsed--;
  };
}
export function sameTrainTrainSlotsForTests(): { used: number; waiting: number } { return { used: trainSlotsUsed, waiting: trainSlotWaiters.length }; }

// ------------------------------------------------------------------ provider queue

/**
 * Provider deps of one search: the F3 paced fair queue (per-provider rate limit, fairness across searches, retries,
 * cancellation) unless SAME_TRAIN_PACED_QUEUE=off. `totalTimeoutMs` caps the search deadline (Muse's tool budget).
 */
export function sharedSameTrainDeps(tools: RailwayToolService | undefined, env: NodeJS.ProcessEnv,
  extra: { isCurrent?: () => boolean; onProgress?: (p: SameTrainProgress) => void; log?: SameTrainDeps['log']; totalTimeoutMs?: number } = {}): SameTrainDeps {
  const { totalTimeoutMs, ...hooks } = extra;
  const clean = Object.fromEntries(Object.entries(hooks).filter(([, v]) => v !== undefined)) as Partial<SameTrainDeps> & { isCurrent?: () => boolean };
  // the paced queue honours the budget itself (route + every unit end by the deadline); the P42.9 path via its limits
  const deps = sameTrainPacedQueueEnabled(env) ? scheduledSameTrainDeps(tools as any, { ...clean, ...(totalTimeoutMs ? { totalTimeoutMs } : {}) }) : liveSameTrainDeps(tools as any, clean);
  return totalTimeoutMs ? { ...deps, limits: { ...deps.limits, totalTimeoutMs: Math.min(deps.limits.totalTimeoutMs, totalTimeoutMs) } } : deps;
}

/** Muse's tool budget for one search (engine deadline) — the runtime's tool timeout is this + one call + 3 s. */
export function museSearchBudgetMs(env: NodeJS.ProcessEnv = process.env): number { return sameTrainLimitsFromEnv(env).totalTimeoutMs; }
