/**
 * Prompt 16 — deterministic grounding helpers.
 *
 *  - resolveStationDetailed(): RESOLVED | AMBIGUOUS (several real stations) | UNKNOWN — wraps the existing
 *    RouteResolver dictionary; the LLM never picks a station code.
 *  - stationCodesMentioned(): which stations the USER's own words name (for conflict detection).
 *  - extractDateExpression(): the raw date expression in the user's words ("kal nahi parso" → "parso").
 *    DateResolver turns it into a canonical date; the LLM never does date arithmetic.
 *  - countMentioned(): passenger counts named in the user's words.
 */
import { parsePassengerCount } from '../../booking/preparation/passenger-count';
import { STATION_ALIASES, AMBIGUOUS_STATION_NAMES } from '@shared/constants';
import { resolveStationToken, resolveStationArgumentDetailed } from '../../railway/resolvers/route-resolver';
import { stationCodesNamedInText } from '../../railway/resolvers/station-catalog';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { normalizeDevanagariNumbers } from '@shared/devanagari-numbers';

export type StationResolution =
  | { kind: 'RESOLVED'; code: string; name: string }
  | { kind: 'AMBIGUOUS'; raw: string; candidates: ReadonlyArray<{ code: string; name: string }> }
  | { kind: 'UNKNOWN'; raw: string };

const lc = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9\u0900-\u097f ]/g, ' ').replace(/\s+/g, ' ').trim();

export function resolveStationDetailed(raw: string): StationResolution {
  const key = lc(raw);
  if (!key) return { kind: 'UNKNOWN', raw };
  if (AMBIGUOUS_STATION_NAMES[key]) return { kind: 'AMBIGUOUS', raw, candidates: AMBIGUOUS_STATION_NAMES[key] };
  // 2026-10-09: every station — dictionary alias, then the station catalog (official code in any case / full official
  // name; a name several stations share is AMBIGUOUS), then the existing rules below
  const cat = resolveStationArgumentDetailed(String(raw || '').trim());
  if (cat.kind === 'RESOLVED') return { kind: 'RESOLVED', code: cat.code, name: cat.name };
  if (cat.kind === 'AMBIGUOUS') return { kind: 'AMBIGUOUS', raw, candidates: cat.candidates };
  const one = resolveStationToken(key);
  if (one) return { kind: 'RESOLVED', code: one.code, name: one.name };
  // several dictionary entries share this name → ambiguous (deduplicated by station code)
  const byCode = new Map<string, { code: string; name: string }>();
  for (const [k, v] of Object.entries(STATION_ALIASES)) if (k.includes(key) || key.includes(k)) byCode.set(v.code, v);
  if (byCode.size > 1) return { kind: 'AMBIGUOUS', raw, candidates: [...byCode.values()] };
  return { kind: 'UNKNOWN', raw };
}

/** Station codes the user's own text names (aliases matched on word boundaries; ambiguous names give every candidate). */
export function stationCodesMentioned(text: string): Set<string> {
  const t = ` ${lc(text)} `;
  const out = new Set<string>();
  for (const [k, v] of Object.entries(STATION_ALIASES)) if (t.includes(` ${k} `)) out.add(v.code);
  for (const [k, cands] of Object.entries(AMBIGUOUS_STATION_NAMES)) if (t.includes(` ${k} `)) for (const c of cands) out.add(c.code);
  // 2026-10-09: full official station names / capitalised official codes in the user's words (catalog, all stations)
  for (const c of stationCodesNamedInText(text)) out.add(c);
  return out;
}

const MONTHS = 'jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december';
const WEEKDAY = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar|ravivar';
const DATE_EXPRS: RegExp[] = [
  /\b(day after tomorrow|aane wala kal|parso|parson|kal|tomorrow|aaj|today)\b/g,
  new RegExp(`\\b((?:next|this|agle|agla|is|coming)\\s+)?(${WEEKDAY})\\b`, 'g'),
  new RegExp(`\\b\\d{1,2}\\s+(?:${MONTHS})\\b(?:\\s+20\\d{2})?`, 'g'),
  new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2}\\b`, 'g'),
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b/g,
  /\b20\d{2}-\d{1,2}-\d{1,2}\b/g
];
const NEG = /\b(nahi|nahin|nai|not|instead of)\b/;

/** The (last, post-negation) date expression in the user's words that DateResolver accepts — or null. */
export function extractDateExpression(text: string): { expression: string; date: string } | null {
  const t = lc(text).replace(/(\d)\s*[/.-]\s*(\d)/g, '$1/$2');
  const raw = String(text || '').toLowerCase();
  const found: Array<{ v: string; i: number }> = [];
  for (const re of DATE_EXPRS) {
    for (const src of [t, raw]) for (const m of src.matchAll(re)) found.push({ v: m[0].trim(), i: m.index! });
  }
  if (!found.length) return null;
  const negIdx = t.search(NEG);
  const after = negIdx >= 0 ? found.filter(f => f.i > negIdx) : [];
  const pool = (after.length ? after : found).sort((a, b) => a.i - b.i || b.v.length - a.v.length);
  for (let k = pool.length - 1; k >= 0; k--) {
    const r = resolveDate(pool[k].v);
    if (r.ok) return { expression: pool[k].v, date: r.date };
  }
  return null;
}

const NUM_WORDS: Record<string, number> = { ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4, paanch: 5, panch: 5, five: 5, chhe: 6, chheh: 6, six: 6 };
/** Passenger counts the user's own words name (digits 1–9 or number words). */
export function countMentioned(text: string): Set<number> {
  const out = new Set<number>();
  for (const w of lc(normalizeDevanagariNumbers(text)).split(' ')) {
    if (/^\d$/.test(w)) out.add(Number(w));
    else if (NUM_WORDS[w]) out.add(NUM_WORDS[w]);
  }
  // Prompt 19: counts the deterministic parser derives from the user's words ("one adult and one child" → 2)
  const pc = parsePassengerCount(text, { expectingCount: false });
  if (pc?.kind === 'COUNT') out.add(pc.count);
  return out;
}
