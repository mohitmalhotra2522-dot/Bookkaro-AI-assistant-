/**
 * PROMPT 17 — ToolArgumentNormalizer + argument security (Parts 8, 9, 25, 33, 37, 39).
 *
 * Runs BEFORE the existing ToolCallValidator. It:
 *   - rejects credential-like keys / values (password, OTP, CAPTCHA, card, UPI PIN, cookies, tokens),
 *   - resolves raw date words (dateExpression / "kal") through DateResolver; an LLM ISO date that
 *     contradicts the date the USER said is corrected to the resolver's date (user words win),
 *   - resolves station names through RouteResolver (unknown / ambiguous → AMBIGUOUS_STATION, no call),
 *   - checks optional journey arguments on quotes against the authoritative session journey,
 *   - detects "LLM picked a different train than the selected one" without an explicit user change
 *     (→ ask "12014 selected hai. 14542 check karna hai?", no provider call).
 * It never fills a value the user / session did not provide.
 */
import type { BookingSession } from '@shared/entities';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { resolveStationToken, resolveStationArgumentDetailed, stationCandidatesText } from '../../railway/resolvers/route-resolver';
import { stationCodesMentioned } from '../conversation/grounding';
import { STATION_ALIASES, AMBIGUOUS_STATION_NAMES } from '@shared/constants';
import { stationCodesNamedInText, ambiguousStationNamesInText } from '../../railway/resolvers/station-catalog';
import { extractDateExpression } from '../conversation/grounding';
import { validateToolArgumentShape } from './tool-argument-schema';

export interface NormalizedArgs {
  ok: true;
  arguments: Record<string, any>;
  /** Human-auditable corrections applied (e.g. "date: 2026-10-09 → 2026-10-04 (DateResolver)"). */
  corrections: string[];
}
export interface ArgRejection {
  ok: false;
  code: 'FORBIDDEN_ARGUMENT' | 'AMBIGUOUS_DATE' | 'INVALID_DATE' | 'AMBIGUOUS_STATION' | 'CONTEXT_CONFLICT' | 'INVALID_REQUEST' | 'INVALID_ARGUMENT';
  message: string;
  details?: Record<string, any>;
}

const SENSITIVE_KEY_PARTS = ['password', 'passwd', 'otp', 'captcha', 'cvv', 'upipin', 'cardnumber', 'cardno', 'cookie', 'token', 'secret', 'apikey', 'credential', 'sessionid', 'login', 'username', 'irctc'];
const SENSITIVE_KEY_EXACT = new Set(['pin', 'card', 'auth', 'authorization', 'mpin', 'upi']);
const isSensitiveKey = (k: string): boolean => {
  const n = k.toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_KEY_EXACT.has(n) || SENSITIVE_KEY_PARTS.some(p => n.includes(p));
};
const SENSITIVE_VALUE: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._-]{8,}/i,          // auth header
  /\bsk-[A-Za-z0-9]{8,}/,                     // API secret key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/, // JWT
  /(?<!\d)(?:\d[ -]?){13,19}(?!\d)/,          // card-like number (PNR is 10 digits, train 4–5)
  /\b(password|otp|captcha|upi pin|cvv)\b/i
];

const DATE_TOOLS = new Set(['SEARCH_TRAINS', 'GET_TRAIN_INFO', 'CHECK_AVAILABILITY', 'GET_FARE', 'TRACK_TRAIN', /* P42 */ 'SEARCH_SAME_TRAIN_ALTERNATIVES']);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CODE = /^[A-Z]{2,5}$/;

export function scanArgumentSecurity(args: Record<string, any>): ArgRejection | null {
  const walk = (v: any, k: string, depth: number): ArgRejection | null => {
    if (depth > 4) return null;
    if (k && isSensitiveKey(k)) {
      return { ok: false, code: 'FORBIDDEN_ARGUMENT', message: 'Main password, OTP, CAPTCHA, card ya UPI PIN jaisi jaankari kabhi nahi leta.', details: { field: k } };
    }
    if (typeof v === 'string' && SENSITIVE_VALUE.some(re => re.test(v))) {
      return { ok: false, code: 'FORBIDDEN_ARGUMENT', message: 'Main password, OTP, CAPTCHA, card ya UPI PIN jaisi jaankari kabhi nahi leta.', details: { field: k || 'value' } };
    }
    if (v && typeof v === 'object') for (const [ck, cv] of Object.entries(v)) { const r = walk(cv, ck, depth + 1); if (r) return r; }
    return null;
  };
  for (const [k, v] of Object.entries(args || {})) { const r = walk(v, k, 0); if (r) return r; }
  return null;
}

const trainOf = (s: BookingSession): string | undefined => {
  const t: any = s.selectedTrain;
  return t ? String(t.number || t.trainNumber || '') || undefined : undefined;
};

function resolveStationArg(v: any): { code: string } | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const raw = v.trim();
  if (CODE.test(raw)) return { code: raw };
  // 2026-10-09: all stations — official code in any case ("Svdk") / full official name via the station catalog
  const d = resolveStationArgumentDetailed(raw);
  if (d.kind === 'RESOLVED') return { code: d.code };
  const r = d.kind === 'UNKNOWN' ? resolveStationToken(raw) : null;
  return r ? { code: r.code } : null;
}

function groundStationArgs(args: Record<string, any>, session: BookingSession, userText: string, corrections: string[]): ArgRejection | null {
  const text = String(userText || '');
  if (!text.trim() || /[^\u0000-\u024F\s]/.test(text)) return null;        // other scripts: LLM semantic authority
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const mentioned = stationCodesMentioned(text);
  const grounded = (code: string, f: 'origin' | 'destination') =>
    mentioned.has(code) || lower.includes(` ${code.toLowerCase()} `) || (session as any)[f] === code;
  for (const f of ['origin', 'destination'] as const) {
    const code = typeof args[f] === 'string' ? args[f] : '';
    if (!code || grounded(code, f)) continue;
    const other = f === 'origin' ? args.destination : args.origin;
    const free = [...stationCodesNamedInText(text)].filter(c => c !== other);
    if (free.length === 1) {
      corrections.push(`${f}: ${code} → ${free[0]} (user named the station)`);
      args[f] = free[0];
      continue;
    }
    const amb = ambiguousStationNamesInText(text, n => !!STATION_ALIASES[n] || !!AMBIGUOUS_STATION_NAMES[n])
      .find(a => !a.allCodes.has(code) && !(other && a.allCodes.has(other)));
    if (amb) {
      return { ok: false, code: 'AMBIGUOUS_STATION', message: `"${amb.name}" naam ke ek se zyada stations hain — ${stationCandidatesText(amb.candidates)}. Kaunsa station?`,
        details: { field: f, missingField: 'STATION', candidates: amb.candidates.map(c => ({ code: c.code, name: c.name })) } } as any;
    }
  }
  return null;
}

/** 2026-10-09: an unresolved station value → the honest reason (several stations share the name → list them). */
function stationArgRejection(v: any, f: string): ArgRejection {
  const d = typeof v === 'string' ? resolveStationArgumentDetailed(v.trim()) : { kind: 'UNKNOWN' as const };
  if (d.kind === 'AMBIGUOUS') {
    return { ok: false, code: 'AMBIGUOUS_STATION', message: `"${v}" naam ke ek se zyada stations hain — ${stationCandidatesText(d.candidates)}. Kaunsa station?`,
      details: { field: f, missingField: 'STATION', candidates: d.candidates.map(c => ({ code: c.code, name: c.name })) } } as any;
  }
  return { ok: false, code: 'AMBIGUOUS_STATION', message: `"${v}" station identify nahi hua.`, details: { field: f, missingField: 'STATION' } };
}

export function normalizeToolArguments(tool: string, rawArgs: Record<string, any>, session: BookingSession, userText: string): NormalizedArgs | ArgRejection {
  const args: Record<string, any> = { ...(rawArgs || {}) };
  const corrections: string[] = [];

  const sec = scanArgumentSecurity(args);
  if (sec) return sec;

  // ---- Prompt 25 Part 8: schema / type / identifier format, before anything is resolved or executed ----
  const shape = validateToolArgumentShape(tool, args);
  if (!shape.ok) return { ok: false, code: shape.code, message: shape.message, details: shape.details };
  for (const k of Object.keys(args)) delete args[k];
  Object.assign(args, shape.arguments);
  for (const c of shape.coerced) corrections.push(`type: ${c} (lossless)`);

  // ---- Dates: DateResolver is authoritative (Part 8) ----
  if (DATE_TOOLS.has(tool)) {
    const expr = typeof args.dateExpression === 'string' ? args.dateExpression.trim() : '';
    delete args.dateExpression;
    if (expr) {
      const r = resolveDate(expr);
      if (!r.ok) return { ok: false, code: r.error === 'AMBIGUOUS_DATE' ? 'AMBIGUOUS_DATE' : 'INVALID_DATE', message: 'Journey date clear nahi hai (jaise kal / parso / 12 October).', details: { missingField: 'DATE' } } as any;
      if (args.date && args.date !== r.date) corrections.push(`date: ${args.date} → ${r.date} (DateResolver)`);
      args.date = r.date;
    } else if (typeof args.date === 'string' && args.date && !ISO.test(args.date)) {
      const r = resolveDate(args.date);
      if (!r.ok) return { ok: false, code: r.error === 'AMBIGUOUS_DATE' ? 'AMBIGUOUS_DATE' : 'INVALID_DATE', message: 'Journey date clear nahi hai (jaise kal / parso / 12 October).', details: { missingField: 'DATE' } } as any;
      corrections.push(`date: "${args.date}" → ${r.date} (DateResolver)`);
      args.date = r.date;
    }
    // An LLM-computed ISO date contradicting the date words the USER said this turn → resolver wins.
    if (typeof args.date === 'string' && ISO.test(args.date)) {
      const said = extractDateExpression(userText || '');
      if (said && said.date !== args.date) { corrections.push(`date: ${args.date} → ${said.date} (user said "${said.expression}")`); args.date = said.date; }
    }
  }

  // ---- Stations: RouteResolver (Part 8) ----
  if (tool === 'SEARCH_TRAINS') {
    for (const f of ['origin', 'destination'] as const) {
      if (args[f] === undefined) continue;
      const r = resolveStationArg(args[f]);
      if (!r) return stationArgRejection(args[f], f);
      if (r.code !== args[f]) corrections.push(`${f}: "${args[f]}" → ${r.code} (RouteResolver)`);
      args[f] = r.code;
    }
    // 2026-10-09: an LLM station code that contradicts the station the user's OWN (Latin-script) words name is never
    // used silently — full official name typed → that station; a shared name typed ("Katra") with a code outside its
    // stations → ask with the real candidates. A code the user's words ground (alias / name / code) is untouched, and
    // without a typed station name the LLM's semantic mapping stays (Jammu → JAT, Bombay → CSMT …).
    const g = groundStationArgs(args, session, userText, corrections);
    if (g) return g;
  }

  // ---- Quotes: optional journey args must match the authoritative session journey (Parts 9, 37) ----
  if (tool === 'CHECK_AVAILABILITY' || tool === 'GET_FARE') {
    for (const f of ['origin', 'destination'] as const) {
      if (args[f] === undefined) continue;
      const r = resolveStationArg(args[f]);
      const cur = session[f];
      if (!r) return stationArgRejection(args[f], f);
      if (cur && r.code !== cur) {
        return { ok: false, code: 'CONTEXT_CONFLICT', message: `Abhi journey ${session.origin} → ${session.destination} hai. ${f === 'origin' ? 'Origin' : 'Destination'} ${r.code} karna hai to pehle journey badal dijiye.`, details: { field: f, current: cur, proposed: r.code } };
      }
      delete args[f];                     // the journey always comes from BookingSession
    }
    if (tool === 'CHECK_AVAILABILITY') delete args.passengersCount;   // availability is per class, not per head
    // Part 39 — the LLM chose a different train than the selected one and the user did NOT name it.
    // P42.12: an availability ENQUIRY about another row of the current same-journey result set that the user NAMED
    // ("Vande Bharat wali" → 22488) needs no selection. Unnamed ("availability batao" with a train selected) or an
    // ambiguous name still asks — the LLM never substitutes a train. Positional references use trainRef. GET_FARE unchanged.
    const sel = trainOf(session);
    const proposed = args.trainNumber !== undefined ? String(args.trainNumber) : undefined;
    const listedEnquiry = tool === 'CHECK_AVAILABILITY' && !!proposed && namedResultRow(session, userText || '') === proposed;
    if (sel && proposed && proposed !== sel && !listedEnquiry && !new RegExp(`(?<!\\d)${proposed}(?!\\d)`).test(userText || '')) {
      return { ok: false, code: 'CONTEXT_CONFLICT', message: `${sel} selected hai. ${proposed} check karna hai?`, details: { field: 'selectedTrain', current: sel, proposed } };
    }
  }

  // ---- TRACK: live run date window (today-2 … today+1); never a timetable substitute (Part 29) ----
  if (tool === 'TRACK_TRAIN' && typeof args.date === 'string' && ISO.test(args.date)) {
    const today = resolveDate('aaj');
    if (today.ok) {
      const d = (Date.parse(args.date) - Date.parse(today.date)) / 86400000;
      if (d < -2 || d > 1) return { ok: false, code: 'INVALID_REQUEST', message: 'Live status sirf haal hi ki run dates ke liye milta hai.' };
    }
  }

  return { ok: true, arguments: args, corrections };
}

const GENERIC_NAME_WORDS = new Set(['express', 'mail', 'superfast', 'special', 'passenger', 'local', 'train', 'wali', 'wala', 'new', 'junction']);

/**
 * P42.12: the ONE row of the session's CURRENT search result set (same date / route as the session journey) whose
 * distinctive name word the user said ("Vande Bharat wali", "Shan-e-Punjab ki"). Generic words and the journey's own
 * station names never identify a train; a word shared by several rows identifies none (→ null, the caller asks).
 */
export function namedResultRow(session: any, userText: string): string | null {
  const sr = session?.searchResults;
  if (!sr || !Array.isArray(sr.trains) || !userText) return null;
  const same = (a: unknown, b: unknown) => a === undefined || a === null || a === '' || b === undefined || b === null || b === ''
    || String(a).toUpperCase() === String(b).toUpperCase();
  if (!same(sr.date ?? sr.journey?.date, session.date) || !same(sr.origin ?? sr.journey?.origin, session.origin)
    || !same(sr.destination ?? sr.journey?.destination, session.destination)) return null;
  const words = (v: unknown) => String(v ?? '').toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 4);
  const stations = new Set([...words(session.originName), ...words(session.destinationName)]);
  const said = new Set(words(userText));
  const hits = sr.trains.filter((t: any) => words(t?.trainName ?? t?.name).some(w => !GENERIC_NAME_WORDS.has(w) && !stations.has(w) && said.has(w)));
  return hits.length === 1 ? String(hits[0]?.trainNumber ?? hits[0]?.number ?? '') || null : null;
}
