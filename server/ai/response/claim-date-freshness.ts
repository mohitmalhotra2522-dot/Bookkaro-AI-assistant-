/**
 * PROMPT 42.9 (D2) — date-bound railway fact claims.
 *
 * A railway fact is only true FOR THE DATE its tool result was fetched for. A train-count / availability / fare /
 * train-status claim is accepted only when the date it is about (stated in the clause or, when unstated, the single
 * date the user asked about) equals the canonical date of the result that supports that kind of fact. Otherwise:
 *
 *   DATE_MISMATCH:<date>            — a result of that kind exists, but for another date (e.g. 8 Oct results, "parso 9 Oct" claim)
 *   NO_FRESH_RESULT_FOR_DATE:<date> — no result of that kind exists for the date the claim is about
 *
 * The date is resolved ONLY by the backend DateResolver (never by LLM arithmetic). This is a fail-closed VALIDATION of
 * Muse's wording: it removes an unverifiable claim; it never routes, never calls a tool and never changes state. A turn
 * classified as "general knowledge" does not exempt a dated railway fact (P42.8 D2: the turn-level `general` flag let
 * "parso 9 Oct ko 3A mein 29 trainein mili hain" through against the 8 Oct result set).
 */
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { explicitDates } from './claim-dates';

export type DateBoundKind = 'COUNT' | 'FARE' | 'AVAILABILITY' | 'TRAIN_STATUS';

const DAY_WORD = /\b(aaj|today|kal|tomorrow|parso|parson|day after tomorrow)\b/gi;
const NEG_AFTER = /^\s*(?:ke\s+liye\s+|ka\s+|ki\s+|ko\s+)?(?:nahi|nahin|nhi|not|na)\b/i;
const COUNT_RE = /\b(\d+|ek|one|do|two|teen|three|char|chaar|four|paanch|five|chhe|six)\s+(trains?|trainein|gaadiyan|gaadiyaan)\b/i;
const FARE_RE = /(?:₹\s?\d|\brs\.?\s?\d|\binr\s?\d|\b(?:fare|kiraya|kiraaya)\b[^.]{0,30}\d)/i;
const AVAIL_RE = /\b(?:AVAILABLE|AVBL|AVL|CURR_AVBL)\b|\b(?:RAC|WL|RLWL|PQWL|GNWL)\s*\d|\bwaiting\s*list\s*\d|\bseats?\s+(?:available|khali|hain)\b|\b\d+\s+seats?\b/i;
const STATUS_RE = /\b(?:late|delay(?:ed)?|running\s+(?:late|on\s*time)|chal\s+rahi|departed|cancel(?:led|ed)?|rad(?:d)?\s+ho)\b/i;

export function dateBoundKind(t: string): DateBoundKind | null {
  const s = String(t || '');
  if (COUNT_RE.test(s)) return 'COUNT';
  if (FARE_RE.test(s)) return 'FARE';
  if (AVAIL_RE.test(s)) return 'AVAILABILITY';
  if (STATUS_RE.test(s)) return 'TRAIN_STATUS';
  return null;
}

/** Dates a text is about: relative day words (unless negated: "kal nahi") via the DateResolver + explicit calendar dates. */
export function statedDates(t: string): string[] {
  const s = String(t || '');
  const out: string[] = [];
  for (const m of s.matchAll(DAY_WORD)) {
    const after = s.slice((m.index ?? 0) + m[0].length);
    if (NEG_AFTER.test(after)) continue;
    const r: any = resolveDate(m[1].toLowerCase());
    if (r?.ok && r.date && !out.includes(r.date)) out.push(r.date);
  }
  for (const d of explicitDates(s)) if (!out.includes(d)) out.push(d);
  return out;
}

export interface DateSources {
  /** canonical date of the current search result set (train list / counts / class rows) */
  searchDate: string | null;
  availabilityDates: string[];
  fareDates: string[];
  statusDates: string[];
  /** dates any SUCCESSFUL tool of THIS turn was executed for */
  freshThisTurn: string[];
}

const iso = (x: unknown): string | null => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(0, 10) : null);

/** Canonical dates of the date-bound results available to the reply (session results + this turn's tool results). */
export function dateSourcesOf(s: any, views: Array<{ toolName?: string; ok: boolean; data?: any }>): DateSources {
  const sr = s?.searchResults || s?.lastSearch;
  // a result without its own date was fetched for the session date (a date change invalidates session results)
  const sd = iso(s?.date);
  const src: DateSources = { searchDate: sr ? (iso(sr?.journey?.date) ?? iso(sr?.date) ?? sd) : null, availabilityDates: [], fareDates: [], statusDates: [], freshThisTurn: [] };
  const add = (arr: string[], d: string | null) => { if (d && !arr.includes(d)) arr.push(d); };
  if (s?.availability) add(src.availabilityDates, iso(s.availability.date) ?? sd);
  if (s?.fare) add(src.fareDates, iso(s.fare.date) ?? sd);
  for (const v of views || []) {
    if (!v?.ok || !v.data) continue;
    const d = iso(v.data?.journey?.date) ?? iso(v.data?.date);
    add(src.freshThisTurn, d);
    if (v.toolName === 'SEARCH_TRAINS' && d) src.searchDate = d;
    if (v.toolName === 'CHECK_AVAILABILITY' || v.toolName === 'SEARCH_SAME_TRAIN_ALTERNATIVES') add(src.availabilityDates, d);
    if (v.toolName === 'GET_FARE') add(src.fareDates, d);
    if (v.toolName === 'TRACK_TRAIN') add(src.statusDates, d ?? iso(new Date(Date.now() + 5.5 * 3600_000).toISOString()));
  }
  return src;
}

function datesFor(kind: DateBoundKind, src: DateSources): string[] {
  const out = new Set<string>();
  if (kind === 'COUNT') { if (src.searchDate) out.add(src.searchDate); }
  else if (kind === 'FARE') { src.fareDates.forEach(d => out.add(d)); if (src.searchDate) out.add(src.searchDate); }
  else if (kind === 'AVAILABILITY') { src.availabilityDates.forEach(d => out.add(d)); if (src.searchDate) out.add(src.searchDate); }
  else src.statusDates.forEach(d => out.add(d));
  return [...out];
}

/**
 * Judge one sentence. Clause-wise ("Kal ke liye 29 trains mili thi; parso ke liye fresh check karna hoga" is fine);
 * a fact clause without its own date inherits the sentence's single stated date, else the single date the user asked
 * about this turn (only when no fresh tool result for that date exists).
 */
export function judgeDateBoundClaim(sentence: string, src: DateSources, userText?: string): { reason: string; date: string; kind: DateBoundKind } | null {
  const t = String(sentence || '');
  if (!dateBoundKind(t)) return null;
  const sentenceDates = statedDates(t);
  const clauses = t.split(/[;,]|\s+(?:lekin|par|but|aur|and)\s+/i).map(x => x.trim()).filter(Boolean);
  for (const c of clauses.length ? clauses : [t]) {
    const kind = dateBoundKind(c);
    if (!kind) continue;
    let dates = statedDates(c);
    if (!dates.length && sentenceDates.length === 1) dates = sentenceDates;
    const have = datesFor(kind, src);
    if (dates.length) {
      for (const d of dates) if (!have.includes(d)) return { reason: `${have.length ? 'DATE_MISMATCH' : 'NO_FRESH_RESULT_FOR_DATE'}:${d}`, date: d, kind };
      continue;
    }
    // implicit: the claim states no date — it is about the date the user just asked about (single, non-negated)
    if (userText && kind !== 'TRAIN_STATUS') {
      const ud = statedDates(userText);
      if (ud.length === 1 && have.length && !have.includes(ud[0]) && !src.freshThisTurn.includes(ud[0])) return { reason: `NO_FRESH_RESULT_FOR_DATE:${ud[0]}`, date: ud[0], kind };
    }
  }
  return null;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Parso ke liye fresh railway data abhi verify nahi hua." — relative word when it resolves to that date, else "9 Oct". */
export function dateFreshFallbackText(date: string): string {
  let label = '';
  for (const [w, L] of [['aaj', 'Aaj'], ['kal', 'Kal'], ['parso', 'Parso']] as const) { const r: any = resolveDate(w); if (r?.ok && r.date === date) { label = L; break; } }
  if (!label) { const [, m, d] = date.split('-').map(Number); label = m && d ? `${d} ${MON[m - 1]}` : 'Is date'; }
  return `${label} ke liye fresh railway data abhi verify nahi hua.`;
}
export const isDateBoundRejection = (reason: string): boolean => /^(?:DATE_MISMATCH|NO_FRESH_RESULT_FOR_DATE):/.test(String(reason || ''));
