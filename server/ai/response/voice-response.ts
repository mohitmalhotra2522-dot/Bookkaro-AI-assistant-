/**
 * PROMPT 41 — VoiceResponse contract + NaturalVoiceResponseComposer helpers + VoiceResponseGroundingValidator.
 *
 * The existing NaturalResponseComposer (P21–P35) stays the brain's wording / grounding layer. P41 adds a VOICE view
 * on top of the SAME authoritative turn result:
 *   Path A — the validated reply is already speech-suitable → spoken as is (no extra LLM call).
 *   Path B — the reply is screen-oriented (train list, long review, many numbers) → ONE short conversational
 *            "voice brief" wording call through the existing provider (same Muse config), judged by every existing
 *            composer guard AND cross-checked here against the already-validated authoritative texts.
 *   Path C — deterministic fallback speech is reused when speech-suitable; composed only when it is not.
 * Any composer failure / timeout / rejected fact → the existing validated short response (never an error).
 *
 * Nothing here calculates or invents a railway fact: the validator only ACCEPTS facts already present in the
 * authoritative material (validated reply, backend reply, deterministic speech, session / provider data).
 */

export type VoicePurpose =
  | 'SEARCH_RESULTS' | 'SELECTION' | 'AVAILABILITY' | 'FARE' | 'LIVE_STATUS' | 'PNR' | 'PASSENGER_COLLECTION'
  | 'CORRECTION' | 'REVIEW' | 'CONFIRMATION' | 'BOOKING_DISABLED' | 'ERROR' | 'QUESTION' | 'GENERAL' | 'INFO';

export type VoicePath = 'A_REUSED' | 'B_COMPOSED' | 'C_DETERMINISTIC' | 'C_COMPOSED';

export interface VoiceFact { type: 'TRAIN' | 'FARE' | 'TIME' | 'CLASS' | 'AVAILABILITY' | 'COUNT' | 'DATE' | 'PNR'; value: string }

/** P41 Part 8 — the validated spoken response of ONE turn (Play Again replays exactly this; never re-generated). */
export interface VoiceResponse {
  text: string;
  segments: string[];
  purpose: VoicePurpose;
  factsUsed: VoiceFact[];
  question: string | null;
  /** words */
  speechLength: number;
  turnId: string | null;
  path: VoicePath;
  composerUsed: boolean;
  fallbackUsed: boolean;
  groundingStatus: 'VALIDATED' | 'FALLBACK';
  composerLatencyMs: number | null;
  /** codes only — why Path B was chosen / why it fell back */
  reasons: string[];
  /** total VOICE composition time (validated reply + voice view), ms */
  totalComposeMs?: number;
}

// ------------------------------------------------------------------ text helpers

export const wordCount = (t: string): number => String(t || '').trim().split(/\s+/).filter(w => /[\p{L}\p{N}₹]/u.test(w)).length;

const TRAIN_NUM = /(?<![\d:.,₹])\b\d{5}\b(?![\d:])/g;
const TIME_RE = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b(?!\d)/g;
const AMPM_RE = /\b(1[0-2]|0?[1-9])(?:[:.]([0-5]\d))?\s?(am|pm|a\.m\.|p\.m\.)(?![a-z])/gi;
const FARE_RE = /(?:₹|\brs\.?\s?|\binr\s?)\s?(\d[\d,]*(?:\.\d+)?)/gi;
const CLASS_RE = /\b(1A|2A|3A|3E|CC|EC|SL|2S|FC|EA|EV|VS)\b/g;
const AVAIL_NUM_RE = /\b(GNWL|RLWL|PQWL|TQWL|WL|RAC|CNF|AVAILABLE|AVL)\s*[-/#]?\s*(\d{1,4})\b/gi;
const PNR_RE = /\b\d{10}\b/g;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DMY_DATE = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})\b/g;
const COUNT_RE = /\b(\d{1,2})\s+(trains?|trainein|gaadiyan|passengers?|yatri|log|options?)\b/gi;

const fareNum = (s: string) => Number(String(s).replace(/,/g, ''));
const hhmm = (h: string | number, m: string | number = 0) => `${String(Number(h)).padStart(2, '0')}:${String(Number(m)).padStart(2, '0')}`;
function to24(h: string, m: string | undefined, ap: string): string {
  let hr = Number(h) % 12;
  if (/^p/i.test(ap)) hr += 12;
  return hhmm(hr, m || 0);
}
/** strip everything that is a structured fact so the remaining bare numbers can be checked */
function withoutStructured(t: string): string {
  return t.replace(FARE_RE, ' ').replace(AMPM_RE, ' ').replace(TIME_RE, ' ').replace(CLASS_RE, ' ').replace(AVAIL_NUM_RE, ' ')
    .replace(ISO_DATE, ' ').replace(DMY_DATE, ' ');
}

/** Facts mentioned in a spoken text (railway facts only — never names, ages or other passenger data). */
export function extractVoiceFacts(text: string): VoiceFact[] {
  const t = String(text || '');
  const out: VoiceFact[] = [];
  const add = (type: VoiceFact['type'], value: string) => { if (!out.some(f => f.type === type && f.value === value)) out.push({ type, value }); };
  for (const m of t.matchAll(PNR_RE)) add('PNR', 'PNR_MASKED');
  for (const m of t.matchAll(FARE_RE)) add('FARE', `₹${fareNum(m[1])}`);
  for (const m of t.matchAll(AVAIL_NUM_RE)) add('AVAILABILITY', `${m[1].toUpperCase()} ${Number(m[2])}`);
  for (const m of t.matchAll(AMPM_RE)) add('TIME', to24(m[1], m[2], m[3]));
  for (const m of t.replace(AMPM_RE, ' ').matchAll(TIME_RE)) add('TIME', hhmm(m[1], m[2]));
  for (const m of t.matchAll(CLASS_RE)) add('CLASS', m[1]);
  for (const m of withoutStructured(t).replace(PNR_RE, ' ').matchAll(TRAIN_NUM)) add('TRAIN', m[0]);
  for (const m of t.matchAll(ISO_DATE)) add('DATE', m[0]);
  for (const m of t.matchAll(COUNT_RE)) add('COUNT', `${Number(m[1])} ${m[2].toLowerCase()}`);
  return out;
}

// ------------------------------------------------------------------ Path A / B decision

const LIST_MARKER = /(^|\n)\s*(?:[-•*▪]|\d{1,2}[.)])\s+\S/;
/**
 * Is this text fit to be SPOKEN as is? Screen-oriented content (a list of trains, many times / fares, bullets,
 * tables, raw ids / JSON, very long) is not — it would sound like a screen reader.
 */
export function assessSpeechSuitability(text: string): { suitable: boolean; reasons: string[] } {
  const t = String(text || '');
  const reasons: string[] = [];
  if (!t.trim()) return { suitable: true, reasons };
  const facts = extractVoiceFacts(t);
  const trains = facts.filter(f => f.type === 'TRAIN').length;
  const times = facts.filter(f => f.type === 'TIME').length;
  const fares = facts.filter(f => f.type === 'FARE').length;
  if (trains >= 3) reasons.push('MANY_TRAINS');
  if (times >= 4) reasons.push('MANY_TIMES');
  if (fares >= 3) reasons.push('MANY_FARES');
  if (LIST_MARKER.test(t)) reasons.push('LIST_MARKERS');
  if (/\|.*\|/.test(t) || /[{}[\]]"?\w+"?\s*:/.test(t)) reasons.push('TABLE_OR_JSON');
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t) || /\b(?:irh|res|req|turn|sess)_[\w-]{6,}/i.test(t)) reasons.push('INTERNAL_ID');
  if (wordCount(t) > 50) reasons.push('TOO_MANY_WORDS');
  if (t.split(/(?<=[.!?।])\s+/).filter(s => s.trim()).length > 4) reasons.push('TOO_MANY_SENTENCES');
  return { suitable: reasons.length === 0, reasons };
}

// ------------------------------------------------------------------ VoiceResponseGroundingValidator

export interface VoiceAuthority {
  /** already-validated / authoritative texts of THIS turn (validated reply, backend reply, deterministic speech, question) */
  texts: string[];
  /** authoritative structured data (session snapshot / provider results) — facts are collected from strings + numbers */
  data?: unknown;
}

function collectStrings(v: any, out: string[], depth = 0) {
  if (v === null || v === undefined || depth > 7) return;
  if (typeof v === 'string') { out.push(v); return; }
  if (typeof v === 'number') { out.push(String(v)); return; }
  if (Array.isArray(v)) { for (const x of v.slice(0, 60)) collectStrings(x, out, depth + 1); return; }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (/^(name|passengerName|mobile|phone|email|id|.*Id)$/i.test(k)) continue;   // never needed as voice authority
    collectStrings(x, out, depth + 1);
  }
}

/**
 * P41 Part 20 — every train / fare / time / class / availability / PNR / date / count / bare number in the spoken
 * text must already exist in the authoritative material. Numeric safety: "12014" (train) never becomes "12:14"
 * (time); "3A" (class) never becomes "3 AM"; "₹1125" must match a ₹ amount exactly.
 */
export class VoiceResponseGroundingValidator {
  validate(voiceText: string, a: VoiceAuthority): { ok: boolean; rejected: string[] } {
    const strings: string[] = [...a.texts.filter(Boolean).map(String)];
    collectStrings(a.data, strings);
    const src = strings.join(' \n ');
    const trains = new Set<string>([...src.matchAll(/\b\d{5}\b/g)].map(m => m[0]));
    const times = new Set<string>([...src.replace(AMPM_RE, ' ').matchAll(TIME_RE)].map(m => hhmm(m[1], m[2])));
    for (const m of src.matchAll(AMPM_RE)) times.add(to24(m[1], m[2], m[3]));
    const fares = new Set<number>([...src.matchAll(FARE_RE)].map(m => fareNum(m[1])));
    // structured fare fields (`fare: 1125`, `totalFare`, `amount`) count as ₹ authority
    collectFareFields(a.data, fares);
    const classes = new Set<string>([...src.matchAll(CLASS_RE)].map(m => m[1]));
    const avail = new Set<string>([...src.matchAll(AVAIL_NUM_RE)].map(m => `${norm(m[1])} ${Number(m[2])}`));
    const pnrs = new Set<string>([...src.matchAll(PNR_RE)].map(m => m[0]));
    const nums = new Set<number>([...src.matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0])));
    for (const m of src.matchAll(/\d[\d,]*\d/g)) nums.add(fareNum(m[0]));
    const isoDates = new Set<string>([...src.matchAll(ISO_DATE)].map(m => m[0]));

    const t = String(voiceText || '');
    const rejected: string[] = [];
    for (const m of t.matchAll(PNR_RE)) if (!pnrs.has(m[0])) rejected.push('UNSUPPORTED_PNR');
    for (const m of t.matchAll(FARE_RE)) if (!fares.has(fareNum(m[1]))) rejected.push(`UNSUPPORTED_FARE:${fareNum(m[1])}`);
    for (const m of t.matchAll(AMPM_RE)) if (!times.has(to24(m[1], m[2], m[3]))) rejected.push(`UNSUPPORTED_TIME:${m[0].trim()}`);
    for (const m of t.replace(AMPM_RE, ' ').matchAll(TIME_RE)) if (!times.has(hhmm(m[1], m[2]))) rejected.push(`UNSUPPORTED_TIME:${m[0]}`);
    for (const m of t.matchAll(CLASS_RE)) if (!classes.has(m[1])) rejected.push(`UNSUPPORTED_CLASS:${m[1]}`);
    for (const m of t.matchAll(AVAIL_NUM_RE)) if (!avail.has(`${norm(m[1])} ${Number(m[2])}`)) rejected.push(`UNSUPPORTED_AVAILABILITY:${m[1].toUpperCase()} ${m[2]}`);
    for (const m of t.matchAll(ISO_DATE)) if (!isoDates.has(m[0])) rejected.push(`UNSUPPORTED_DATE:${m[0]}`);
    const rest = withoutStructured(t).replace(PNR_RE, ' ');
    for (const m of rest.matchAll(TRAIN_NUM)) if (!trains.has(m[0])) rejected.push(`UNSUPPORTED_TRAIN:${m[0]}`);
    // any other bare number (counts, WL positions said loosely, platform, etc.) must exist in the authority
    for (const m of rest.replace(TRAIN_NUM, ' ').matchAll(/\b\d+(?:\.\d+)?\b/g)) if (!nums.has(Number(m[0]))) rejected.push(`UNSUPPORTED_NUMBER:${m[0]}`);
    // availability status words: never upgrade / invent a status the authority does not contain
    if (/\b(available|uplabdh|seats? (?:hain|mil))/i.test(t) && !/\b(available|avl|uplabdh|seats?)\b/i.test(src)) rejected.push('UNSUPPORTED_AVAILABILITY_STATUS');
    if (/\b(waiting|wl)\b/i.test(t) && !/\b(waiting|wl|gnwl|rlwl|pqwl|tqwl)\b/i.test(src)) rejected.push('UNSUPPORTED_AVAILABILITY_STATUS');
    if (/\brac\b/i.test(t) && !/\brac\b/i.test(src)) rejected.push('UNSUPPORTED_AVAILABILITY_STATUS');
    return { ok: rejected.length === 0, rejected: [...new Set(rejected)] };
  }
}
const norm = (s: string) => { const u = s.toUpperCase(); return u === 'AVL' ? 'AVAILABLE' : u; };
function collectFareFields(v: any, into: Set<number>, inFare = false, depth = 0) {
  if (v === null || v === undefined || depth > 7) return;
  if (typeof v === 'number') { if (inFare) into.add(v); return; }
  if (Array.isArray(v)) { for (const x of v.slice(0, 60)) collectFareFields(x, into, inFare, depth + 1); return; }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (/(id|count|version|age|seq|index|status|at|time)$/i.test(k)) continue;
    collectFareFields(x, into, inFare || /(fare|amount|total|price)/i.test(k), depth + 1);
  }
}
export const voiceResponseGrounding = new VoiceResponseGroundingValidator();

// ------------------------------------------------------------------ speech polish (wording only, never facts)

const ACK_WORD = /^(bilkul|ji|ji haan|haan ji|haan|theek hai|thik hai|achha|accha|okay|ok|sure|great|zaroor|sahi hai)\b[\s,!.।-]*/i;
/**
 * P41 Part 29 — no "..." spam, at most ONE leading acknowledgement per reply, no repeated "bilkul / ji" openers.
 * Removes filler words only; a sentence that would become empty is dropped. Facts are never touched.
 */
export function polishSpeech(segments: string[]): string[] {
  const out: string[] = [];
  let acked = false;
  for (const raw of segments) {
    let s = String(raw || '').replace(/\s*(?:\.{3,}|…)+\s*/g, (m, off: number, all: string) => off + m.length >= all.length ? '.' : ', ').replace(/,\s*([.!?।])/g, '$1').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (ACK_WORD.test(s) && !s.includes('?')) {
      if (acked || out.length) {
        const rest = s.replace(ACK_WORD, '').trim();
        if (!/[\p{L}\p{N}]/u.test(rest)) continue;
        s = rest.charAt(0).toUpperCase() + rest.slice(1);
      }
      acked = true;
    }
    s = s.replace(/\b(ji)(?:[\s,]+ji)+\b/gi, '$1');
    out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------ purpose

export function classifyVoicePurpose(x: {
  errorCode: string | null; confirmationTurn: boolean; reviewTurn: boolean; toolNames: string[]; toolFailed: boolean;
  pendingType: string; corrected: boolean; appliedActions: string[]; hasQuestion: boolean; general: boolean;
}): VoicePurpose {
  if (x.errorCode === 'BOOKING_EXECUTION_DISABLED') return 'BOOKING_DISABLED';
  if (x.confirmationTurn) return 'CONFIRMATION';
  if (x.corrected) return 'CORRECTION';
  if (x.reviewTurn) return 'REVIEW';
  if (x.toolNames.includes('CHECK_PNR')) return 'PNR';
  if (x.toolNames.some(n => n === 'TRACK_TRAIN' || n === 'GET_CANCELLED_TRAINS')) return 'LIVE_STATUS';
  if (x.errorCode || x.toolFailed) return 'ERROR';
  if (x.toolNames.includes('CHECK_AVAILABILITY')) return 'AVAILABILITY';
  if (x.toolNames.includes('GET_FARE')) return 'FARE';
  if (x.toolNames.includes('SEARCH_TRAINS')) return 'SEARCH_RESULTS';
  if (/PASSENGER/i.test(x.pendingType) || x.appliedActions.some(a => /PASSENGER/i.test(a))) return 'PASSENGER_COLLECTION';
  if (x.appliedActions.some(a => /TRAIN_SELECTED|CLASS_SELECTED/i.test(a))) return 'SELECTION';
  if (x.general) return 'GENERAL';
  if (x.hasQuestion) return 'QUESTION';
  return 'INFO';
}

/** Default latency budget of the Path B voice-brief call (ms); beyond it the validated short response is spoken. */
export function voiceComposerTimeoutMs(env: Record<string, string | undefined> = (typeof process !== 'undefined' ? process.env : {}) as any): number {
  const n = Number(env.VOICE_COMPOSER_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 500 && n <= 20000 ? n : 4500;
}

/** P41 Part 44 — metadata-only observability record (no transcript, no reply text, no PII, no keys). */
export function voiceResponseLogRecord(sessionId: string, v: VoiceResponse, totalComposeMs: number) {
  return {
    kind: 'voice_response', sessionId, turnId: v.turnId, voiceResponseGenerated: !!v.text, composerUsed: v.composerUsed, path: v.path,
    purpose: v.purpose, latencyMs: totalComposeMs, composerLatencyMs: v.composerLatencyMs, speechLength: v.speechLength,
    fallbackUsed: v.fallbackUsed, groundingStatus: v.groundingStatus, reasons: v.reasons
  };
}
