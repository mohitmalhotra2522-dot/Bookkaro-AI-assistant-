/**
 * PROMPT 42.5 — BFE (same train, board from an earlier station) ELIGIBILITY.
 *
 * A structured, deterministic FACT for Muse (and the backend safety-net): does fresh authoritative availability for
 * exactly this train + class + date show a shortage for the CURRENT validated party? It is never a decision — Muse
 * decides whether / how to recover; the safety-net may only invoke the existing SEARCH_SAME_TRAIN_ALTERNATIVES tool.
 *
 *   eligible   WAITLIST / NOT_AVAILABLE / REGRET, or INSUFFICIENT_SEATS (confirmedSeats KNOWN and < passengers)
 *   never      RAC (RAC is a usable status, not a shortage), sufficient seats, UNKNOWN / TIMEOUT / PROVIDER_ERROR /
 *              RATE_LIMITED / AUTH_ERROR / DATA_UNAVAILABLE (a failed or unreadable result proves nothing),
 *              TRAIN_CANCELLED (earlier boarding cannot help), a stale result (another journey / turn / party).
 *
 * Seat counts come ONLY from the provider's availability status text via evaluateSeatShortage (AVAILABLE-0003 → 3);
 * a request id, timestamp, train number, PNR or UUID is never read as seats, and WL / RLWL positions are never seats.
 * Nothing is fabricated: unknown fields stay absent.
 */
import { evaluateSeatShortage } from './same-train-shortage';

export type BfeEligibilityReason = 'WAITLIST' | 'NOT_AVAILABLE' | 'REGRET' | 'INSUFFICIENT_SEATS';
export type BfeIneligibleReason =
  | 'SEATS_SUFFICIENT' | 'RAC_AVAILABLE' | 'UNKNOWN_STATUS' | 'PROVIDER_ERROR' | 'TRAIN_CANCELLED'
  | 'MISSING_IDENTITY' | 'STALE_RESULT';

/** Failure codes that are NEVER a shortage (a request that did not produce authoritative availability). */
export const BFE_UNKNOWN_CODES = ['UNKNOWN', 'TIMEOUT', 'PROVIDER_ERROR', 'RATE_LIMITED', 'AUTH_ERROR', 'DATA_UNAVAILABLE'] as const;

export interface BfeBinding {
  sessionId: string | null;
  turnId: string | null;
  journeyVersion: number | null;
  /** the execution that produced the availability fact (never parsed for numbers) */
  toolExecutionId?: string | null;
  /** session selection when the fact was produced — a later change of selection supersedes the fact */
  selectedTrain?: string | null;
  selectedClass?: string | null;
}

export interface BfeEligibility {
  eligible: boolean;
  reason: BfeEligibilityReason | null;
  notEligibleReason?: BfeIneligibleReason;
  trainNumber: string;
  trainName?: string;
  date: string | null;
  classCode: string;
  requestedOrigin?: string;
  requestedDestination?: string;
  /** current validated passenger count (null = not collected yet) */
  passengers: number | null;
  /** confirmed seats the status proves: AVAILABLE-n → n; WL / NA / REGRET → 0; otherwise absent (never guessed) */
  confirmedSeats?: number;
  /** the provider's own status text */
  status: string | null;
  binding: BfeBinding;
}

export interface BfeEligibilityInput {
  /** did the provider call succeed (a failed call is never a shortage) */
  ok: boolean;
  status?: unknown;
  errorCode?: string | null;
  trainNumber: unknown;
  trainName?: unknown;
  date?: unknown;
  classCode: unknown;
  requestedOrigin?: unknown;
  requestedDestination?: unknown;
  passengers?: unknown;
  binding: BfeBinding;
}

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());
const paxOf = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null; };

export function evaluateBfeEligibility(i: BfeEligibilityInput): BfeEligibility {
  const trainNumber = str(i.trainNumber);
  const classCode = str(i.classCode).toUpperCase();
  const passengers = paxOf(i.passengers);
  const status = i.ok && str(i.status) ? str(i.status) : null;
  const base: BfeEligibility = {
    eligible: false, reason: null, trainNumber, date: str(i.date) || null, classCode, passengers, status, binding: { ...i.binding },
    ...(str(i.trainName) ? { trainName: str(i.trainName) } : {}),
    ...(str(i.requestedOrigin) ? { requestedOrigin: str(i.requestedOrigin).toUpperCase() } : {}),
    ...(str(i.requestedDestination) ? { requestedDestination: str(i.requestedDestination).toUpperCase() } : {})
  };
  const no = (r: BfeIneligibleReason, extra: Partial<BfeEligibility> = {}): BfeEligibility => ({ ...base, ...extra, notEligibleReason: r });
  if (!/^\d{5}$/.test(trainNumber) || !classCode) return no('MISSING_IDENTITY');
  if (!i.ok) return no('PROVIDER_ERROR');
  if (!status || (BFE_UNKNOWN_CODES as readonly string[]).includes(status.toUpperCase().replace(/\s+/g, '_'))) return no('UNKNOWN_STATUS');
  const a = evaluateSeatShortage({ status, requestedPassengerCount: passengers ?? 1 });
  const seats = a.availabilityStatus === 'AVAILABLE' && a.availableSeatCount !== undefined ? { confirmedSeats: a.availableSeatCount } : {};
  if (a.availabilityStatus === 'UNKNOWN') return no('UNKNOWN_STATUS');
  if (a.availabilityStatus === 'RAC') return no('RAC_AVAILABLE');
  if (a.availabilityStatus === 'TRAIN_CANCELLED') return no('TRAIN_CANCELLED');
  if (!a.shortage || !a.triggerReason) return no('SEATS_SUFFICIENT', seats);
  if (a.triggerReason === 'INSUFFICIENT_SEATS') {
    // only when the count is KNOWN and the party is KNOWN — "AVAILABLE" without a number is never a shortage
    if (a.availableSeatCount === undefined || passengers === null || a.availableSeatCount >= passengers) return no('SEATS_SUFFICIENT', seats);
    return { ...base, ...seats, eligible: true, reason: 'INSUFFICIENT_SEATS' };
  }
  if (a.triggerReason === 'WAITLIST' || a.triggerReason === 'NOT_AVAILABLE' || a.triggerReason === 'REGRET') {
    return { ...base, eligible: true, reason: a.triggerReason, confirmedSeats: 0 };
  }
  return no('UNKNOWN_STATUS');
}

export interface BfeCurrentState {
  sessionId: string | null;
  turnId: string | null;
  journeyVersion: number | null;
  date: string | null;
  passengers: number | null;
  selectedTrain: string | null;
  selectedClass: string | null;
}

/**
 * Is an eligibility fact still about the CURRENT request? Same session + turn + journeyVersion + date; a selection
 * change after the fact (another train / class) supersedes it. A party-size change is handled by re-evaluating the
 * same fresh status for the new count (evaluateBfeEligibility again), never by reusing the old verdict.
 */
export function bfeEligibilityCurrent(e: BfeEligibility, now: BfeCurrentState): { current: true } | { current: false; why: string } {
  const b = e.binding;
  if ((b.sessionId ?? null) !== (now.sessionId ?? null)) return { current: false, why: 'SESSION' };
  if ((b.turnId ?? null) !== (now.turnId ?? null)) return { current: false, why: 'TURN' };
  if ((b.journeyVersion ?? null) !== (now.journeyVersion ?? null)) return { current: false, why: 'JOURNEY_VERSION' };
  if (e.date && now.date && e.date !== now.date) return { current: false, why: 'DATE' };
  const selChanged = (b.selectedTrain ?? null) !== (now.selectedTrain ?? null) || (b.selectedClass ?? null) !== (now.selectedClass ?? null);
  if (selChanged && now.selectedTrain && now.selectedTrain !== e.trainNumber) return { current: false, why: 'TRAIN' };
  if (selChanged && now.selectedClass && now.selectedClass !== e.classCode) return { current: false, why: 'CLASS' };
  return { current: true };
}

/** Duplicate key for one turn: the same train + class + date + journeyVersion is searched at most once per turn. */
export function bfeKey(turnId: unknown, trainNumber: unknown, classCode: unknown, date: unknown, journeyVersion: unknown): string {
  return [str(turnId), str(trainNumber), str(classCode).toUpperCase(), str(date), str(journeyVersion)].join('|');
}

/**
 * P42.7 Part 12 — per-train recovery context for Muse (structured, facts only): eligibility is judged on the REQUESTED
 * class of each train; another class being available never suppresses it. Muse decides whether to search / what to say.
 */
export interface RecoveryEligibilityView {
  trainNumber: string;
  requestedClass: string;
  requestedOrigin: string | null;
  requestedDestination: string | null;
  passengers: number | null;
  status: string | null;
  confirmedSeats: number | null;
  recoveryEligible: boolean;
  reason: string | null;
}
export function recoveryEligibilityView(e: BfeEligibility): RecoveryEligibilityView {
  return {
    trainNumber: e.trainNumber, requestedClass: e.classCode, requestedOrigin: e.requestedOrigin ?? null, requestedDestination: e.requestedDestination ?? null,
    passengers: e.passengers, status: e.status, confirmedSeats: e.confirmedSeats ?? null,
    recoveryEligible: e.eligible, reason: e.eligible ? e.reason : (e.notEligibleReason ?? null)
  };
}
