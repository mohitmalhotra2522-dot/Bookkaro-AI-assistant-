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
import { resolveStationToken } from '../../railway/resolvers/route-resolver';
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

const DATE_TOOLS = new Set(['SEARCH_TRAINS', 'GET_TRAIN_INFO', 'CHECK_AVAILABILITY', 'GET_FARE', 'TRACK_TRAIN']);
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
  const r = resolveStationToken(raw);
  return r ? { code: r.code } : null;
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
      if (!r.ok) return { ok: false, code: r.error === 'AMBIGUOUS_DATE' ? 'AMBIGUOUS_DATE' : 'INVALID_DATE', message: 'Kis date ko? Thoda saaf bata dijiye (jaise kal / parso / 12 October).' };
      if (args.date && args.date !== r.date) corrections.push(`date: ${args.date} → ${r.date} (DateResolver)`);
      args.date = r.date;
    } else if (typeof args.date === 'string' && args.date && !ISO.test(args.date)) {
      const r = resolveDate(args.date);
      if (!r.ok) return { ok: false, code: r.error === 'AMBIGUOUS_DATE' ? 'AMBIGUOUS_DATE' : 'INVALID_DATE', message: 'Kis date ko? Thoda saaf bata dijiye (jaise kal / parso / 12 October).' };
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
      if (!r) return { ok: false, code: 'AMBIGUOUS_STATION', message: `"${args[f]}" kaunsa station hai? Thoda saaf bata dijiye.`, details: { field: f } };
      if (r.code !== args[f]) corrections.push(`${f}: "${args[f]}" → ${r.code} (RouteResolver)`);
      args[f] = r.code;
    }
  }

  // ---- Quotes: optional journey args must match the authoritative session journey (Parts 9, 37) ----
  if (tool === 'CHECK_AVAILABILITY' || tool === 'GET_FARE') {
    for (const f of ['origin', 'destination'] as const) {
      if (args[f] === undefined) continue;
      const r = resolveStationArg(args[f]);
      const cur = session[f];
      if (!r) return { ok: false, code: 'AMBIGUOUS_STATION', message: `"${args[f]}" kaunsa station hai? Thoda saaf bata dijiye.`, details: { field: f } };
      if (cur && r.code !== cur) {
        return { ok: false, code: 'CONTEXT_CONFLICT', message: `Abhi journey ${session.origin} → ${session.destination} hai. ${f === 'origin' ? 'Origin' : 'Destination'} ${r.code} karna hai to pehle journey badal dijiye.`, details: { field: f, current: cur, proposed: r.code } };
      }
      delete args[f];                     // the journey always comes from BookingSession
    }
    if (tool === 'CHECK_AVAILABILITY') delete args.passengersCount;   // availability is per class, not per head
    // Part 39 — the LLM chose a different train than the selected one and the user did NOT name it.
    const sel = trainOf(session);
    const proposed = args.trainNumber !== undefined ? String(args.trainNumber) : undefined;
    if (sel && proposed && proposed !== sel && !new RegExp(`(?<!\\d)${proposed}(?!\\d)`).test(userText || '')) {
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
