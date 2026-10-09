/**
 * 2026-10-09 — Station catalog lookup (reference data, all stations): resolves a station the user / LLM named
 * by its official code in any letter case ("Svdk", "svdk" → SVDK) or by its full official name
 * ("Shri Mata Vaishno Devi Katra" → SVDK). Deterministic; the LLM never picks a code from here.
 *
 * Rules (never guessed):
 *  - exact name match (case / punctuation / trailing "Jn" / "Junction" insensitive) is RESOLVED only when it is the only
 *    station with that name AND no other passenger station's name contains it as whole words — otherwise AMBIGUOUS
 *    ("Katra" → Katra (KEA) · Miranpur Katra (MK) · Shri Mata Vaishno Devi Katra (SVDK)) and the user is asked;
 *  - a partial name alone never resolves ("Jammu" ≠ "Vijiypur Jammu");
 *  - an official code resolves in any case when no station name matched (an UPPERCASE code is tried first);
 *  - infrastructure entries (cabins, sidings, yards, goods, sheds, depots …) never make a name ambiguous.
 * Used ONLY where a whole value is a station argument (tool / entity slot) — never to scan free text word by word
 * (many Hinglish words are also station codes: se, ko, do, kal, to …).
 */
import { STATION_CATALOG_TSV } from './station-catalog.data';

export type StationCatalogMatch =
  | { kind: 'RESOLVED'; code: string; name: string; via: 'CODE' | 'NAME' }
  | { kind: 'AMBIGUOUS'; candidates: ReadonlyArray<{ code: string; name: string }> };

export const STATION_CATALOG_MAX_CANDIDATES = 6;
const CODE_ARG = /^[A-Za-z][A-Za-z0-9]{1,5}$/;
const INFRA = /\b(cabin|cabins|siding|sidings|sdg|yard|goods|carshed|shed|crew|lobby|military|militry|ramp|depot|outer|bypass|block hut|loco|workshop|colliery|collery|assisted|asstt)\b/i;

/** lowercase, punctuation → space, single spaces, trailing "jn" / "junction" dropped */
export function normStationName(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\s+(jn|junction)$/, '');
}

interface Catalog { byCode: Map<string, string>; byName: Map<string, string[]>; names: Array<{ code: string; norm: string; infra: boolean }> }
let catalog: Catalog | null = null;
function load(): Catalog {
  if (catalog) return catalog;
  const byCode = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const names: Catalog['names'] = [];
  for (const line of STATION_CATALOG_TSV.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const code = line.slice(0, tab).trim(), name = line.slice(tab + 1).trim();
    if (!code || !name || byCode.has(code)) continue;
    byCode.set(code, name);
    const n = normStationName(name);
    if (!n) continue;
    const infra = INFRA.test(name);
    names.push({ code, norm: n, infra });
    if (!infra) { const l = byName.get(n) || []; l.push(code); byName.set(n, l); }
  }
  catalog = { byCode, byName, names };
  return catalog;
}

export function stationCatalogSize(): number { return load().byCode.size; }
export function stationCatalogName(code: string): string | undefined { return load().byCode.get(String(code || '').trim().toUpperCase()); }

function byCode(raw: string): StationCatalogMatch | null {
  const t = raw.trim();
  if (!CODE_ARG.test(t)) return null;
  const code = t.toUpperCase();
  const name = load().byCode.get(code);
  return name ? { kind: 'RESOLVED', code, name, via: 'CODE' } : null;
}

function byName(raw: string): StationCatalogMatch | null {
  const c = load();
  const key = normStationName(raw);
  if (!key || key.length < 3) return null;
  const exact = c.byName.get(key) || [];
  if (!exact.length) return null;
  const re = new RegExp(`(^| )${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`);
  const containing = c.names.filter(n => !n.infra && n.norm !== key && re.test(n.norm)).map(n => n.code);
  const codes = [...new Set([...exact, ...containing])];
  if (codes.length === 1) return { kind: 'RESOLVED', code: codes[0], name: c.byCode.get(codes[0])!, via: 'NAME' };
  return { kind: 'AMBIGUOUS', candidates: codes.slice(0, STATION_CATALOG_MAX_CANDIDATES).map(code => ({ code, name: c.byCode.get(code)! })) };
}

/** Catalog lookup of ONE whole station value; null = not in the catalog (caller keeps its existing behaviour). */
export function lookupStationCatalog(raw: unknown): StationCatalogMatch | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = raw.trim();
  if (/^[A-Z][A-Z0-9]{1,5}$/.test(t)) { const r = byCode(t); if (r) return r; }   // an official UPPERCASE code first
  return byName(t) || byCode(t);
}

/**
 * Codes the user's OWN words name by a full official station name (word-bounded, ≥ 2 words or ≥ 6 letters) or by an
 * official code written in capitals (e.g. "SVDK") — used only to check that an LLM-proposed station is grounded.
 */
export function stationCodesNamedInText(text: string): Set<string> {
  const c = load();
  const out = new Set<string>();
  const raw = String(text || '');
  const t = ` ${raw.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  if (t.trim()) {
    for (const n of c.names) {
      if (n.infra || (n.norm.length < 6 && !n.norm.includes(' '))) continue;
      if (t.includes(` ${n.norm} `)) out.add(n.code);
    }
  }
  for (const m of raw.matchAll(/\b[A-Z][A-Z0-9]{2,5}\b/g)) if (c.byCode.has(m[0])) out.add(m[0]);
  return out;
}
