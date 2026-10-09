/**
 * RouteResolver — deterministic station/route extraction from natural text.
 * LLM does not resolve stations itself; this resolver extracts origin/destination
 * and maps them to canonical station codes via a station dictionary.
 */
import { STATION_ALIASES, AMBIGUOUS_STATION_NAMES } from '@shared/constants';
import { lookupStationCatalog, type StationCatalogMatch } from './station-catalog';
import { providerToolCatalog } from '../../ai/tools/provider-tools';
import type { ResolvedStation, RailwayError } from '../types/railway-types';

export interface RouteResolveResult {
  ok: boolean;
  origin?: ResolvedStation;
  destination?: ResolvedStation;
  error?: RailwayError;
}

/**
 * Attempt to resolve a single station token (word/phrase) to a station code.
 * Returns null if ambiguous / unknown.
 */
export function resolveStationToken(raw: string): ResolvedStation | null {
  if (!raw) return null;
  const key = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  // Exact match
  if (STATION_ALIASES[key]) return { code: STATION_ALIASES[key].code, name: STATION_ALIASES[key].name };
  // Partial key match if unique
  const matches = Object.entries(STATION_ALIASES).filter(([k]) => k.includes(key) || key.includes(k));
  if (matches.length === 1) return { code: matches[0][1].code, name: matches[0][1].name };
  // Check codes
  const codeMatch = Object.entries(STATION_ALIASES).find(([_, v]) => v.code.toLowerCase() === key);
  if (codeMatch) return { code: codeMatch[1].code, name: codeMatch[1].name };
  // P37: in provider-tool mode the LLM interprets the station (any language / script) and passes its official code;
  // a well-formed code is accepted as-is and the selected provider validates it (no language-specific alias table)
  const t = raw.trim();
  if (providerToolCatalog.enabled() && /^[A-Z]{2,5}$/.test(t)) return { code: t, name: t };
  return null;
}

/**
 * 2026-10-09 — resolve ONE whole station value (a tool argument / entity slot the LLM filled from the user's words) for
 * ALL stations: dictionary alias (exact) → station catalog (official code in any case, or the full official name; a
 * name shared by several stations is AMBIGUOUS, never guessed) → the existing resolveStationToken rules.
 * Never used to scan free text word by word.
 */
export function resolveStationArgumentDetailed(raw: string): { kind: 'RESOLVED'; code: string; name: string }
  | { kind: 'AMBIGUOUS'; candidates: ReadonlyArray<{ code: string; name: string }> } | { kind: 'UNKNOWN' } {
  if (typeof raw !== 'string' || !raw.trim()) return { kind: 'UNKNOWN' };
  const key = raw.toLowerCase().trim().replace(/\s+/g, ' ');
  if (STATION_ALIASES[key]) return { kind: 'RESOLVED', code: STATION_ALIASES[key].code, name: STATION_ALIASES[key].name };
  if (AMBIGUOUS_STATION_NAMES[key]) return { kind: 'AMBIGUOUS', candidates: AMBIGUOUS_STATION_NAMES[key] };
  const c: StationCatalogMatch | null = lookupStationCatalog(raw);
  if (c?.kind === 'RESOLVED') return { kind: 'RESOLVED', code: c.code, name: c.name };
  if (c?.kind === 'AMBIGUOUS') return { kind: 'AMBIGUOUS', candidates: c.candidates };
  const r = resolveStationToken(raw);
  return r ? { kind: 'RESOLVED', code: r.code, name: r.name } : { kind: 'UNKNOWN' };
}

/** resolveStationArgumentDetailed → the station, or null when ambiguous / unknown. */
export function resolveStationArgument(raw: string): ResolvedStation | null {
  const r = resolveStationArgumentDetailed(raw);
  return r.kind === 'RESOLVED' ? { code: r.code, name: r.name } : null;
}

/** "Katra (KEA), Miranpur Katra (MK) ya Shri Mata Vaishno Devi Katra (SVDK)" */
export function stationCandidatesText(candidates: ReadonlyArray<{ code: string; name: string }>): string {
  const names = candidates.map(c => `${c.name} (${c.code})`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} ya ${names[names.length - 1]}` : names.join('');
}

/**
 * Extract route from an arbitrary natural text. Handles patterns like:
 *   "Amritsar se Delhi"
 *   "Amritsar to Delhi"
 *   "Delhi jana hai Amritsar se"
 *   "LDH se ASR"
 *   "Delhi jaana hai" (with origin already known upstream)
 * Returns AMBIGUOUS_STATION if any station cannot be resolved confidently.
 */
export function resolveRoute(text: string, alreadyKnown?: { origin?: string; destination?: string }): RouteResolveResult {
  const t = text.toLowerCase().trim();

  let originToken: string | null = null;
  let destToken: string | null = null;

  // "X se Y" / "X to Y"
  const seMatch = t.match(/([a-z0-9\s]+?)\s+(?:se|to|से)\s+([a-z0-9\s]+)/i);
  if (seMatch) {
    originToken = seMatch[1].trim();
    destToken = seMatch[2].split(/\s+(jana|jaana|jana hai|jaana hai|jana chahenge|jana chahta|jana chahti|ke liye)/i)[0].trim();
  } else {
    // Try "Y jana hai X se" (destination before origin)
    const reverseMatch = t.match(/([a-z0-9\s]+?)\s+(jana|jaana|jana hai|jaana hai|jana chahenge|jana chahta|jana chahti|ke liye)\s+(?:[a-z]+\s+)?([a-z0-9\s]+?)\s+(?:se|से)/i);
    if (reverseMatch) {
      destToken = reverseMatch[1].trim();
      originToken = reverseMatch[3].trim();
    } else {
      // Single station mention (e.g. "Ludhiana jana hai" or "Actually Ludhiana jana hai" when changing destination)
      const singleMatch = t.match(/([a-z0-9\s]+?)\s+(jana|jaana|jana hai|jaana hai|jaana hai|jana hai)/i);
      if (singleMatch) {
        let cand = singleMatch[1].trim();
        cand = cand.replace(/^actually\s*,?\s*/i, '').replace(/^delhi\s+nahi\s*,?\s*/i, '').replace(/^nahi\s*,?\s*/i, '').trim();
        // Try to resolve the last word/phrase as station
        const tokens = cand.split(/\s+/);
        for (let i = tokens.length; i >= 1; i--) {
          const candidate = tokens.slice(tokens.length - i).join(' ');
          if (resolveStationToken(candidate)) { destToken = candidate; break; }
        }
        if (!destToken) destToken = cand;
      }
    }
  }

  let origin: ResolvedStation | undefined;
  let destination: ResolvedStation | undefined;
  const ambiguous: string[] = [];

  if (originToken) {
    const o = resolveStationToken(originToken);
    if (o) origin = o;
    else ambiguous.push(originToken);
  } else if (alreadyKnown?.origin) {
    origin = { code: alreadyKnown.origin, name: '' };
  }

  if (destToken) {
    const d = resolveStationToken(destToken);
    if (d) destination = d;
    else ambiguous.push(destToken);
  } else if (alreadyKnown?.destination) {
    destination = { code: alreadyKnown.destination, name: '' };
  }

  if (ambiguous.length > 0 || (!origin && !destination)) {
    return {
      ok: false,
      error: {
        code: 'AMBIGUOUS_STATION',
        message: `स्टेशन समझ नहीं आया: ${ambiguous.join(', ') || 'origin/destination'}. कृपया स्पष्ट करें।`,
        missing: !origin ? ['origin'] : !destination ? ['destination'] : undefined
      }
    };
  }

  if (origin && destination && origin.code === destination.code) {
    return {
      ok: false,
      error: { code: 'INVALID_ROUTE', message: 'शुरुआत और मंज़िल एक जैसी नहीं हो सकतीं।' }
    };
  }

  return { ok: true, origin, destination };
}
