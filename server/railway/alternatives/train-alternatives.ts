/**
 * P42-13 — inline train alternatives (read-only builder).
 *
 * Under a qualifying (waitlisted / short) train card the UI lists the OTHER trains of the SAME current search result set.
 * Everything here is a pure projection of data the session already holds:
 *  - candidates = the current SEARCH_TRAINS rows, in the provider's (authoritative) order — NO ranking, NO scoring,
 *    NO "best / faster / recommended" rule; deduplicated by train number (first occurrence wins); the main train excluded;
 *  - per-class status = the existing availability authority, unmodified (CHECK > preserved CHECK > the row's own status) —
 *    a class with no evidence carries `status: null` (the UI shows no label; UNKNOWN is never a status);
 *  - no provider / RailCore call, no per-alternative CHECK, no fare, no LLM, no session mutation.
 * Bound to the search result version + journey: a different version, or a result set of another journey, is stale.
 */
import { collectAvailabilityEvidence, searchRowAvailability, type AvailabilityEvidence } from '../../ai/response/availability-authority';
import { evaluateSeatShortage, normalizeAvailabilityState } from '@shared/same-train-shortage';

export type TrainAlternativesCode =
  | 'OK'
  | 'INVALID_REQUEST'      // malformed train number / version
  | 'NO_RESULTS'           // no current search result set
  | 'RESULTS_STALE'        // version differs, or the result set belongs to another journey
  | 'TRAIN_NOT_FOUND'      // the main train is not a row of the current result set
  | 'NOT_NEEDED'           // the main train has no meaningful shortage → nothing is shown
  | 'NOT_APPLICABLE';      // unverified (web) result set → alternatives are never built from it

export type TrainAlternativeSource = 'CHECK' | 'PRESERVED_CHECK' | 'SEARCH_RESULT';

export interface TrainAlternativeClass {
  code: string;
  /** Authoritative status text (e.g. "AVAILABLE 12", "WL 5", "RAC 3", "REGRET") — null when there is no evidence */
  status: string | null;
  available: boolean | null;
  source: TrainAlternativeSource | null;
}

export interface TrainAlternative {
  trainNumber: string;
  trainName: string;
  origin: string;
  destination: string;
  departure: string;
  arrival: string;
  duration: string;
  /** 1-based position in the current search result list (the authoritative order) */
  searchPosition: number;
  classes: TrainAlternativeClass[];
}

export interface TrainAlternativesResponse {
  ok: boolean;
  code: TrainAlternativesCode;
  trainNumber: string;
  alternatives: TrainAlternative[];
  /** deduplicated alternative count (the "View all (N)" number) */
  total: number;
  searchResultsVersion: number | null;
  journeyVersion: number | null;
  /** fingerprint of the availability evidence used — changes when a CHECK changes any shown label */
  evidenceKey: string;
}

const TRAIN_RE = /^\d{4,5}$/;
const CLASS_RE = /^[A-Z0-9]{1,4}$/;
const WEB_PROVIDERS = new Set(['erail', 'railyatri']);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);
const up = (v: unknown) => String(v ?? '').trim().toUpperCase();
/** both sides present and different → mismatch (an absent side proves nothing either way — same rule as the authority) */
const differs = (a: unknown, b: unknown) => !!str(a) && !!str(b) && up(a) !== up(b);

function fail(code: TrainAlternativesCode, trainNumber: string, s: any): TrainAlternativesResponse {
  return { ok: code === 'NOT_NEEDED', code, trainNumber, alternatives: [], total: 0,
    searchResultsVersion: typeof s?.searchResultsVersion === 'number' ? s.searchResultsVersion : null,
    journeyVersion: typeof s?.journeyVersion === 'number' ? s.journeyVersion : null, evidenceKey: '' };
}

/** The main train qualifies only when one of its listed classes shows a meaningful shortage for this party
 *  (the same rule as the card's recovery gate / same-train discovery; RAC, UNKNOWN, enough seats, TRAIN_CANCELLED never). */
export function rowHasShortage(row: any, passengers: number, requestedClass?: string | null): boolean {
  const classes = ((row?.classes || []) as any[]).filter(c => CLASS_RE.test(up(c?.code)));
  const meaningful = (c: any) => {
    const a = evaluateSeatShortage({ status: c?.availability ?? null, requestedPassengerCount: passengers });
    return a.shortage && !!a.triggerReason && a.triggerReason !== 'TRAIN_CANCELLED';
  };
  const req = up(requestedClass);
  const listed = req ? classes.find(c => up(c.code) === req) : undefined;
  return listed ? meaningful(listed) : classes.some(meaningful);
}

const fullyCancelled = (row: any) => {
  const cs = (row?.classes || []) as any[];
  return cs.length > 0 && cs.every(c => normalizeAvailabilityState(String(c?.availability ?? '')) === 'TRAIN_CANCELLED');
};

const sourceOf = (e: AvailabilityEvidence): TrainAlternativeSource =>
  e.origin === 'PRESERVED_CHECK' ? 'PRESERVED_CHECK' : e.origin === 'SEARCH_RESULT' ? 'SEARCH_RESULT' : 'CHECK';
const RANK: Record<TrainAlternativeSource, number> = { CHECK: 3, PRESERVED_CHECK: 2, SEARCH_RESULT: 1 };

export function buildTrainAlternatives(session: any, req: { trainNumber?: unknown; searchResultsVersion?: unknown }): TrainAlternativesResponse {
  const s = session || {};
  const train = String(req?.trainNumber ?? '').trim();
  const version = Number(req?.searchResultsVersion);
  if (!TRAIN_RE.test(train) || !Number.isInteger(version)) return fail('INVALID_REQUEST', train, s);
  const sr = s.searchResults;
  const rows: any[] = Array.isArray(sr?.trains) ? sr.trains : [];
  if (!rows.length) return fail('NO_RESULTS', train, s);
  // bound to the current result set + journey: a newer search, or a date / route change since, makes the request stale
  if (version !== s.searchResultsVersion || (typeof sr.version === 'number' && sr.version !== version)) return fail('RESULTS_STALE', train, s);
  if (differs(sr.date ?? sr.journey?.date, s.date) || differs(sr.origin ?? sr.journey?.origin, s.origin)
    || differs(sr.destination ?? sr.journey?.destination, s.destination)) return fail('RESULTS_STALE', train, s);
  const numOf = (r: any) => String(r?.trainNumber ?? r?.number ?? '').trim();
  const main = rows.find(r => numOf(r) === train);
  if (!main) return fail('TRAIN_NOT_FOUND', train, s);
  if (rows.some(r => WEB_PROVIDERS.has(String(r?.provider ?? '').toLowerCase()))) return fail('NOT_APPLICABLE', train, s);
  const pax = Number.isInteger(Number(s.passengersCount)) && Number(s.passengersCount) > 0 ? Number(s.passengersCount) : 1;
  const sel = String(s.selectedTrain?.number ?? s.selectedTrain?.trainNumber ?? '');
  const requestedClass = (sel === train ? s.selectedClass : undefined) || s.requestedClass;
  if (!rowHasShortage(main, pax, requestedClass)) return fail('NOT_NEEDED', train, s);

  // availability: the existing authority, read-only, no user text / steps (nothing ran). CHECK / preserved CHECK
  // evidence comes from collectAvailabilityEvidence; a search-row label is the authority's searchRowAvailability() of the
  // DISPLAYED row itself (so a later duplicate row of the same train can never lend its status to the first one)
  const date = str(sr.date ?? sr.journey?.date) ?? str(s.date);
  const best = new Map<string, AvailabilityEvidence>();
  for (const e of collectAvailabilityEvidence(s, [])) {
    if (e.origin === 'SEARCH_RESULT' || e.alternativePair || !e.trainNumber || !CLASS_RE.test(up(e.travelClass))) continue;
    if (date && e.date && e.date !== date) continue;   // evidence of another date never labels this journey
    const k = `${e.trainNumber}|${up(e.travelClass)}`;
    const cur = best.get(k);
    if (!cur || RANK[sourceOf(e)] > RANK[sourceOf(cur)]) best.set(k, e);
  }

  const seen = new Set<string>([train]);
  const alternatives: TrainAlternative[] = [];
  rows.forEach((r, i) => {
    const n = numOf(r);
    if (!TRAIN_RE.test(n) || seen.has(n)) return;
    seen.add(n);
    if (fullyCancelled(r)) return;   // a train the provider lists as cancelled on this date is never offered
    const classes: TrainAlternativeClass[] = [];
    const codes = new Set<string>();
    for (const c of (r.classes || []) as any[]) {
      const code = up(c?.code);
      if (!CLASS_RE.test(code) || codes.has(code)) continue;
      codes.add(code);
      const e = best.get(`${n}|${code}`);
      const own = e ? undefined : searchRowAvailability(c?.availability, c?.availabilityStatus);
      classes.push(e ? { code, status: e.status, available: typeof e.available === 'boolean' ? e.available : null, source: sourceOf(e) }
        : own ? { code, status: own.status, available: own.available, source: 'SEARCH_RESULT' }
        : { code, status: null, available: null, source: null });
    }
    alternatives.push({ trainNumber: n, trainName: String(r.trainName ?? r.name ?? ''), origin: String(r.origin ?? ''), destination: String(r.destination ?? ''),
      departure: String(r.departure ?? ''), arrival: String(r.arrival ?? ''), duration: String(r.duration ?? ''), searchPosition: i + 1, classes });
  });
  const evidenceKey = alternatives.map(a => `${a.trainNumber}:${a.classes.map(c => `${c.code}=${c.status ?? '-'}`).join(',')}`).join(';');
  return { ok: true, code: 'OK', trainNumber: train, alternatives, total: alternatives.length,
    searchResultsVersion: version, journeyVersion: typeof s.journeyVersion === 'number' ? s.journeyVersion : null, evidenceKey: hash(evidenceKey) };
}

/** small stable FNV-1a fingerprint (not security relevant) */
function hash(t: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
