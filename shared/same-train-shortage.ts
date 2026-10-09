/**
 * PROMPT 42.2 — Same Train Alternative: shortage evaluation (pure, provider-independent, shared by server + UI).
 *
 * The backend never decides WHETHER to search for a same-train alternative — Muse does. This module only turns an
 * authoritative provider availability string + the requested passenger count into STRUCTURED facts Muse can reason
 * over (and the validator / guards can enforce hard constraints with):
 *
 *   - a normalized availability state: AVAILABLE · RAC · WAITLIST · NOT_AVAILABLE · REGRET · TRAIN_CANCELLED · UNKNOWN
 *   - the provider's exact seat count when it gave one ("AVAILABLE-0001" → 1, "AVAILABLE 24" → 24) — never guessed
 *   - seat sufficiency for the party: SUFFICIENT only when count ≥ passengers (or a bare AVAILABLE for ONE passenger)
 *   - shortage + triggerReason (INSUFFICIENT_SEATS / WAITLIST / NOT_AVAILABLE / REGRET / CLASS_UNAVAILABLE /
 *     TRAIN_CANCELLED). UNKNOWN, a timeout or a provider error is NEVER a shortage (absence of data proves nothing).
 *
 * No user-facing sentence is produced here — only codes. Muse phrases everything.
 */

export type NormalizedAvailabilityState = 'AVAILABLE' | 'RAC' | 'WAITLIST' | 'NOT_AVAILABLE' | 'REGRET' | 'TRAIN_CANCELLED' | 'UNKNOWN';

export const SHORTAGE_TRIGGER_REASONS = Object.freeze([
  'INSUFFICIENT_SEATS', 'WAITLIST', 'NOT_AVAILABLE', 'REGRET', 'CLASS_UNAVAILABLE', 'TRAIN_CANCELLED', 'OTHER_AUTHORIZED_SHORTAGE'
] as const);
export type ShortageTriggerReason = typeof SHORTAGE_TRIGGER_REASONS[number];

/**
 * SUFFICIENT = provider count ≥ passengers (or bare AVAILABLE for 1 passenger) · INSUFFICIENT = count < passengers ·
 * COUNT_NOT_PROVIDED = AVAILABLE without a count for a party > 1 (sufficiency not proven either way) ·
 * NOT_APPLICABLE = RAC / WAITLIST / NOT_AVAILABLE / REGRET / TRAIN_CANCELLED · UNKNOWN = no usable provider answer.
 */
export type SeatSufficiency = 'SUFFICIENT' | 'INSUFFICIENT' | 'COUNT_NOT_PROVIDED' | 'NOT_APPLICABLE' | 'UNKNOWN';

/** Typed outcomes / error classes (spec Parts 25 + 38) — codes only, Muse words them. */
export const SameTrainOutcome = Object.freeze({
  FOUND: 'VERIFIED_ALTERNATIVE_FOUND',
  NONE: 'NO_VERIFIED_SAME_TRAIN_ALTERNATIVE'
} as const);
export type SameTrainOutcome = typeof SameTrainOutcome[keyof typeof SameTrainOutcome];
export const SameTrainErrorClass = Object.freeze({
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  INVALID_TOOL_RESULT: 'INVALID_TOOL_RESULT',
  INVALID_TRAIN_ROUTE: 'INVALID_TRAIN_ROUTE',
  /** P42-13: the provider's route data does not contain / order the requested pair — a data limitation, not a railway fact */
  ROUTE_DATA_UNVERIFIED: 'ROUTE_DATA_UNVERIFIED',
  /** RailRadar Phase 1: primary and secondary route data make INCOMPATIBLE claims about the pair (e.g. opposite order) —
   *  never resolved by picking a provider; treated as unverified (same truthful limitation to the user) */
  ROUTE_DATA_CONFLICT: 'ROUTE_DATA_CONFLICT',
  STALE: 'STALE_SAME_TRAIN_ALTERNATIVE',
  BUDGET: 'TOOL_BUDGET_EXCEEDED'
} as const);
export type SameTrainErrorClass = typeof SameTrainErrorClass[keyof typeof SameTrainErrorClass];
/** Validator rejection: current authoritative data already shows enough seats for this exact train/class/date/pair/pax. */
export const SAME_TRAIN_NOT_NEEDED = 'SAME_TRAIN_ALTERNATIVE_NOT_NEEDED' as const;
/** Runtime rejection: the per-turn same-train search budget is used up (partial results already returned are kept). */
export const SAME_TRAIN_BUDGET_EXCEEDED = 'SAME_TRAIN_SEARCH_BUDGET_EXCEEDED' as const;

const up = (v: unknown) => String(v ?? '').trim().toUpperCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

/** Provider status → normalized state. Anything unrecognised is UNKNOWN (never NOT_AVAILABLE). */
export function normalizeAvailabilityState(status: unknown): NormalizedAvailabilityState {
  const s = up(status);
  if (!s) return 'UNKNOWN';
  // a position may follow directly ("GNWL51/WL30", "PQWL5", "RAC12", "AVAILABLE0004") — but never another letter
  if (/^(CURR\s?)?(AVAILABLE|AVL|AVBL)(?![A-Z])/.test(s)) return 'AVAILABLE';
  if (/^RAC(?![A-Z])/.test(s)) return 'RAC';
  if (/^(GNWL|RLWL|PQWL|TQWL|RSWL|NPWL|CKWL|WL|WAITLIST(ED)?|WAITING)(?![A-Z])/.test(s)) return 'WAITLIST';
  if (/^REGRET\b/.test(s)) return 'REGRET';
  if (/^(TRAIN\s+)?CANCELL?ED\b/.test(s)) return 'TRAIN_CANCELLED';
  if (/^(NOT AVAILABLE|NOT AVBL|NO ROOM|TRAIN DEPARTED)\b/.test(s)) return 'NOT_AVAILABLE';
  return 'UNKNOWN';
}

/** findBoardFromEarlier (Phase 2): only a train whose DIRECT status is a waitlist is searched (AVAILABLE / RAC / REGRET / CANCELLED / NOT AVAILABLE never). */
export function isWaitlistStatus(status: unknown): boolean {
  return normalizeAvailabilityState(status) === 'WAITLIST';
}

/**
 * Current waitlist position of a WAITLIST status ("GNWL84/WL17" → 17 (current after the slash), "RLWL1/WL1" → 1,
 * "WL 84" → 84, "PQWL5" → 5). Not a waitlist / no number → undefined (never inferred).
 */
export function currentWaitlistNumber(status: unknown): number | undefined {
  if (!isWaitlistStatus(status)) return undefined;
  const s = up(status);
  const parts = s.split('/').map(x => x.trim()).filter(Boolean);
  const cur = parts.length > 1 ? parts[parts.length - 1] : parts[0];
  if (parts.length > 1 && normalizeAvailabilityState(cur) !== 'WAITLIST') return undefined;   // "GNWL51/RAC78" → not a waitlist now
  const m = cur.match(/(?:WL|WAITLIST(?:ED)?|WAITING)\s*(\d{1,4})\b/) || cur.match(/(\d{1,4})\b/);
  return m ? Number(m[1]) : undefined;
}

/**
 * The provider's exact available-seat count, ONLY when the status is AVAILABLE and carries a number
 * ("AVAILABLE-0001", "AVAILABLE 24", "AVL 5", "CURR_AVBL-0003"). No number → undefined (never inferred).
 */
export function parseAvailableSeatCount(status: unknown): number | undefined {
  const s = up(status);
  if (normalizeAvailabilityState(s) !== 'AVAILABLE') return undefined;
  const m = s.match(/^(?:CURR\s?)?(?:AVAILABLE|AVL|AVBL)\s*[:#/]?\s*(\d{1,4})(?!\d)/);
  return m ? Number(m[1]) : undefined;
}

const validPax = (n: unknown): number | null => {
  const v = Number(n);
  return Number.isInteger(v) && v >= 1 && v <= 6 ? v : null;
};

export interface SeatShortageAssessment {
  availabilityStatus: NormalizedAvailabilityState;
  availableSeatCount?: number;
  requestedPassengerCount: number | null;
  sufficiency: SeatSufficiency;
  shortage: boolean;
  triggerReason: ShortageTriggerReason | null;
}

/**
 * One train/class/date/pair answer → structured shortage facts. `classListed: false` = the authoritative train data
 * does not list the requested class at all (CLASS_UNAVAILABLE). An unknown passenger count is never assumed for
 * sufficiency (only "0 seats" is a shortage then).
 */
export function evaluateSeatShortage(input: { status?: unknown; requestedPassengerCount?: unknown; classListed?: boolean }): SeatShortageAssessment {
  const pax = validPax(input.requestedPassengerCount);
  if (input.classListed === false) {
    return { availabilityStatus: 'NOT_AVAILABLE', requestedPassengerCount: pax, sufficiency: 'NOT_APPLICABLE', shortage: true, triggerReason: 'CLASS_UNAVAILABLE' };
  }
  const state = normalizeAvailabilityState(input.status);
  const base = { availabilityStatus: state, requestedPassengerCount: pax };
  switch (state) {
    case 'AVAILABLE': {
      const count = parseAvailableSeatCount(input.status);
      if (count !== undefined) {
        const need = pax ?? 1;
        if (count >= need) return { ...base, availableSeatCount: count, sufficiency: pax === null ? 'UNKNOWN' : 'SUFFICIENT', shortage: false, triggerReason: null };
        return { ...base, availableSeatCount: count, sufficiency: 'INSUFFICIENT', shortage: true, triggerReason: 'INSUFFICIENT_SEATS' };
      }
      // AVAILABLE without a count: at least one seat — proves sufficiency only for a single passenger
      return { ...base, sufficiency: pax === 1 ? 'SUFFICIENT' : pax === null ? 'UNKNOWN' : 'COUNT_NOT_PROVIDED', shortage: false, triggerReason: null };
    }
    case 'WAITLIST': return { ...base, sufficiency: 'NOT_APPLICABLE', shortage: true, triggerReason: 'WAITLIST' };
    case 'NOT_AVAILABLE': return { ...base, sufficiency: 'NOT_APPLICABLE', shortage: true, triggerReason: 'NOT_AVAILABLE' };
    case 'REGRET': return { ...base, sufficiency: 'NOT_APPLICABLE', shortage: true, triggerReason: 'REGRET' };
    case 'TRAIN_CANCELLED': return { ...base, sufficiency: 'NOT_APPLICABLE', shortage: true, triggerReason: 'TRAIN_CANCELLED' };
    // RAC is a provider-verified (shared) status — not in the trigger list; Muse may still decide to look further
    case 'RAC': return { ...base, sufficiency: 'NOT_APPLICABLE', shortage: false, triggerReason: null };
    default: return { ...base, sufficiency: 'UNKNOWN', shortage: false, triggerReason: null };
  }
}

export interface SeatCheckEntry extends SeatShortageAssessment { trainNumber: string; travelClass: string; date?: string; status?: string }

/**
 * Compact structured view for Muse (attached to SEARCH_TRAINS / CHECK_AVAILABILITY results): which displayed
 * train/class combinations show a shortage for THIS party. Facts only — no instruction, no ranking, no wording.
 */
export function seatCheckView(entries: SeatCheckEntry[], requestedPassengerCount: number | null, opts: { sameTrainToolAvailable: boolean }): Record<string, unknown> | undefined {
  if (!entries.length) return undefined;
  const shortages = entries.filter(e => e.shortage).slice(0, 16).map(e => ({
    train: e.trainNumber, class: e.travelClass, availabilityStatus: e.availabilityStatus,
    ...(e.availableSeatCount !== undefined ? { availableSeatCount: e.availableSeatCount } : {}), triggerReason: e.triggerReason
  }));
  const countNotProvided = entries.filter(e => e.sufficiency === 'COUNT_NOT_PROVIDED').length;
  return {
    requestedPassengerCount,
    shortages,
    sufficientCount: entries.filter(e => e.sufficiency === 'SUFFICIENT').length,
    ...(countNotProvided ? { countNotProvided } : {}),
    unknownCount: entries.filter(e => e.availabilityStatus === 'UNKNOWN').length,
    sameTrainAlternativeEligible: opts.sameTrainToolAvailable && shortages.length > 0,
    rules: 'availableSeatCount < requestedPassengerCount = INSUFFICIENT_SEATS (say the exact count, never just "available"). UNKNOWN / timeout / error is NOT a shortage. Same train alternatives only for listed shortages — never for sufficient availability.'
  };
}

/** SEARCH_TRAINS data (normalized trains with per-class availability) → seat-check entries. */
export function seatCheckFromSearch(data: any, requestedPassengerCount: unknown): SeatCheckEntry[] {
  const out: SeatCheckEntry[] = [];
  const date = data?.journey?.date;
  for (const t of (Array.isArray(data?.trains) ? data.trains : []) as any[]) {
    const num = String(t?.trainNumber ?? t?.number ?? '');
    if (!/^\d{5}$/.test(num)) continue;
    for (const c of (Array.isArray(t?.classes) ? t.classes : []) as any[]) {
      const code = String(c?.code ?? c ?? '').toUpperCase();
      if (!code) continue;
      const status = c?.availability ?? null;
      out.push({ trainNumber: num, travelClass: code, ...(date ? { date } : {}), ...(status ? { status: String(status) } : {}),
        ...evaluateSeatShortage({ status, requestedPassengerCount }) });
    }
  }
  return out;
}

/** CHECK_AVAILABILITY data → one seat-check entry. */
export function seatCheckFromAvailability(data: any, args: { trainNumber?: string; travelClass?: string; date?: string }, requestedPassengerCount: unknown): SeatCheckEntry[] {
  const status = data?.status;
  if (!status) return [];
  return [{ trainNumber: String(data?.trainNumber ?? args.trainNumber ?? ''), travelClass: String(data?.travelClass ?? args.travelClass ?? '').toUpperCase(),
    ...(data?.date || args.date ? { date: String(data?.date ?? args.date) } : {}), status: String(status), ...evaluateSeatShortage({ status, requestedPassengerCount }) }];
}

/**
 * A same-train option the UI / fallback may present as a verified alternative: another ticket pair, provider-verified
 * (VERIFIED / PARTIALLY_VERIFIED), with AVAILABLE seats sufficient for the party, or RAC. An AVAILABLE pair with
 * fewer seats than passengers (or an unproven count for a party) is NOT a verified alternative.
 */
export function isVerifiedSameTrainAlternative(a: any): boolean {
  if (!a || a.isRequestedPair) return false;
  if (a.verificationStatus !== 'VERIFIED' && a.verificationStatus !== 'PARTIALLY_VERIFIED') return false;
  if (a.availability === 'RAC') return true;
  if (a.availability !== 'AVAILABLE') return false;
  // results stored before P42.2 have no sufficiency → previous rule (AVAILABLE counts)
  return a.seatSufficiency === undefined ? true : a.seatSufficiency === 'SUFFICIENT';
}
