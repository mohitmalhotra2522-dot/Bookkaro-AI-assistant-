/**
 * Deterministic lifecycle-intent detection (Prompt 15).
 *
 * The backend acts ONLY on the user's own explicit words. An LLM label can never create
 * a lifecycle action by itself; it is parsed against the closed enum and used for logging.
 *
 *  - "ticket cancel kar do" / "booking hata do" / "12014 wali cancel karo" → REQUEST_CANCELLATION
 *  - a bare "cancel", "ruk jao", "stop", "band karo", "mat karo", "rehne do" → NOT a cancellation
 *    (local interruption / negative reply — handled elsewhere; never a provider action)
 *  - "date 25 September kar do" → REQUEST_JOURNEY_CHANGE (date resolved by the backend DateResolver)
 *  - "CC se 2A kar do"          → REQUEST_CLASS_CHANGE
 *  - "passenger 2 ki age 29 kar do" → REQUEST_PASSENGER_CHANGE (provider-contract fields only)
 *  - "refund status"            → CHECK_REFUND_STATUS (cancellation ≠ refund)
 */
import type { BookingLifecycleAction, PassengerChangeField, RequestedChanges } from '@shared/booking-lifecycle-action';
import { resolveDate } from '../../railway/resolvers/date-resolver';

export type LifecycleIntentKind = BookingLifecycleAction | 'ACTION_STATUS';

export interface LifecycleIntent {
  action: LifecycleIntentKind;
  /** For ACTION_STATUS / eligibility: which family the user asked about. */
  family: 'CANCEL' | 'MODIFY' | 'REFUND';
  /** "phir se cancel karo" — an explicit retry request (blocked while the previous result is unknown). */
  retry: boolean;
  changes: RequestedChanges;
  /** Parse problems for the requested change (e.g. invalid date) — reported, never guessed. */
  changeError?: { code: 'INVALID_DATE' | 'INVALID_CLASS' | 'INVALID_PASSENGER_CHANGE'; message: string };
  /** Text left for booking-reference resolution (change values removed). */
  referenceText: string;
}

const norm = (raw: string) => ` ${String(raw || '').toLowerCase().replace(/[,?!।;:"']/g, ' ').replace(/\s+/g, ' ').trim()} `;

const INTERRUPT_RE = /\b(ruko|ruk jao|ruk ja|rukiye|stop|band karo|band kar do|mat karo|mat kar|rehne do|rahne do|chup|chhodo|chodo|wait)\b/;
const NEGATION_RE = /\b(nahi|nahin|nhi|mat|don ?t|do not|not|na karo|na kare)\b/;
const RETRY_RE = /\b(phir se|fir se|phirse|firse|dobara|dubara|again|retry|ek baar aur)\b/;
const CANCEL_WORD = /\b(cancel|cancell?ation|cancal|cancle|radd|radd karo)\b/;
const HATA_RE = /\b(hata do|hata de|hatao|hata dena|hata dijiye|delete kar do|delete karo|remove kar do|remove karo)\b/;
const OBJECT_RE = /\b(booking|bookings|ticket|tickets|tikat|reservation|wali|wala|wale|isko|usko|ise|use)\b|(?<!\d)\d{5}(?!\d)/;
const ACTION_VERB_RE = /\b(kar do|kardo|kar de|karo|karna|karni|karna hai|karni hai|karwa do|karwao|kar dijiye|kijiye|it|please|plz|chahta|chahti|chahiye)\b/;
const STATUS_Q_RE = /\b(status|hua|hui|hue|ho gaya|ho gayi|ho gyi|ho gya|kya hua|update|check)\b/;
const ELIGIBILITY_RE = /\b(ho sakti|ho sakta|ho sakte|possible|eligible|eligibility|kar sakte|kar sakta|kar sakti|allowed|mumkin)\b/;
const REFUND_RE = /\b(refund|refunds|paisa wapas|paise wapas|paisa vapas|paise vapas|money back)\b/;
const DATE_WORD = /\b(date|tareekh|tarikh|tithi|journey date|yatra ki date)\b/;
const CHANGE_VERB = /\b(change|badal|badlo|badal do|badalni|badalna|shift|modify|update|postpone|prepone|aage|peeche|kar do|kardo|karo|karni|karna|kar dijiye|correct|sahi)\b/;
const CLASS_WORD = /\b(class|coach type|upgrade|downgrade)\b/;
const PASSENGER_WORD = /\b(passenger|passengers|yatri|naam|name|age|umar|umr|gender|berth)\b/;
const GENERIC_MODIFY = /\b(modify|modification|change|badal|badalni|badalna|edit)\b/;

const CONFIRM_RE = /^(haan|han|haa|ha|yes|yep|yeah|confirm|confirmed|ok confirm|haan confirm|haan ji|ji haan|ji|bilkul|theek hai confirm|cancel it|cancel kar do|haan cancel kar do|haan cancel karo|confirm karo|confirm kar do|kar do|haan kar do|change kar do|haan change kar do|go ahead|proceed)( please| plz| ji)?$/;
const REJECT_RE = /\b(nahi|nahin|nhi|no|mat karo|mat kar|rehne do|rahne do|ruk jao|ruko|stop|mat|band karo|cancel mat|don ?t|nope)\b/;

/** Explicit confirmation for a PENDING lifecycle action (whole utterance, nothing else). */
export function isLifecycleConfirmation(raw: string): boolean {
  const t = norm(raw).replace(/[.।]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!t || REJECT_RE.test(` ${t} `) && !/^haan\b/.test(t)) return false;
  return CONFIRM_RE.test(t);
}
export function isLifecycleRejection(raw: string): boolean {
  const t = norm(raw).replace(/[.।]+/g, ' ');
  return REJECT_RE.test(t) && !CONFIRM_RE.test(t.trim().replace(/\s+/g, ' '));
}

// ---------------------------------------------------------------------------
// Class tokens
// ---------------------------------------------------------------------------

export const VALID_TRAVEL_CLASSES: ReadonlySet<string> = new Set(['1A', '2A', '3A', '3E', 'CC', 'EC', 'SL', '2S', 'FC']);
const CLASS_TOKENS: Array<[RegExp, string]> = [
  [/\b(chair car|chaircar)\b/g, 'CC'], [/\b(executive chair|executive|exec)\b/g, 'EC'], [/\b(second sitting|2s)\b/g, '2S'],
  [/\b(sleeper|sl)\b/g, 'SL'], [/\b(3e|3 economy|ac economy)\b/g, '3E'], [/\b(3a|3ac|3 ac|third ac|3 tier)\b/g, '3A'],
  [/\b(2a|2ac|2 ac|second ac|2 tier)\b/g, '2A'], [/\b(1a|1ac|1 ac|first ac)\b/g, '1A'], [/\b(cc)\b/g, 'CC'], [/\b(ec)\b/g, 'EC'], [/\b(fc|first class)\b/g, 'FC']
];
function classTokens(t: string): Array<{ code: string; index: number; text: string }> {
  const out: Array<{ code: string; index: number; text: string }> = [];
  for (const [re, code] of CLASS_TOKENS) {
    for (const m of t.matchAll(re)) {
      if (!out.some(o => m.index! >= o.index && m.index! < o.index + o.text.length)) out.push({ code, index: m.index!, text: m[0] });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Date (backend DateResolver only — the LLM never resolves dates)
// ---------------------------------------------------------------------------

const DATE_EXPR = /\b(aaj|today|kal|tomorrow|parso|parson|(?:agle |next )?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|ravivar|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar)|20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{1,2})\b/g;

export function extractNewDate(t: string, resolve: (s: string) => ReturnType<typeof resolveDate> = resolveDate): { date?: string; matched?: string; error?: string } {
  // the NEW date is the date expression after the date keyword / "se … kar do", else the last one
  const all = [...t.matchAll(DATE_EXPR)];
  if (!all.length) return {};
  const kw = t.search(DATE_WORD);
  const seIdx = t.search(/\b(se|ki jagah|instead of)\b/);
  let pick = all[all.length - 1];
  if (kw >= 0) { const after = all.filter(m => m.index! > kw); if (after.length) pick = after[after.length - 1]; }
  else if (seIdx >= 0) { const after = all.filter(m => m.index! > seIdx); if (after.length) pick = after[after.length - 1]; }
  const r = resolve(pick[0]);
  if (!r.ok) return { matched: pick[0], error: r.message };
  return { date: r.date, matched: pick[0] };
}

// ---------------------------------------------------------------------------
// Passenger change (fields of the provider contract ONLY)
// ---------------------------------------------------------------------------

const ORDINALS: Record<string, number> = { pehla: 1, pehle: 1, pahla: 1, first: 1, '1st': 1, dusra: 2, doosra: 2, dusre: 2, second: 2, '2nd': 2, teesra: 3, tisra: 3, third: 3, '3rd': 3, chautha: 4, fourth: 4, '4th': 4 };

function parsePassengerChange(t: string): { change?: RequestedChanges['passenger']; error?: string } {
  const numM = t.match(/\b(?:passenger|yatri)\s*(?:no\.?|number|#)?\s*(\d)\b/) || t.match(/\b(\d)\s*(?:number|no)?\s*(?:passenger|yatri)\b/);
  let passengerNumber = numM ? +numM[1] : undefined;
  if (passengerNumber === undefined) for (const [w, n] of Object.entries(ORDINALS)) if (new RegExp(`\\b${w}\\b`).test(t)) { passengerNumber = n; break; }
  if (/\b(add|jodo|jod do|aur ek|ek aur|naya passenger|new passenger)\b/.test(t)) return { change: { op: 'ADD' } };
  if (/\b(hata do|hatao|hata de|remove|nikal do|nikalo|delete)\b/.test(t)) return { change: { op: 'REMOVE', passengerNumber } };
  let field: PassengerChangeField | undefined;
  let value: string | number | undefined;
  if (/\b(age|umar|umr|saal)\b/.test(t)) {
    field = 'age';
    const nums = [...t.matchAll(/(?<!\d)(\d{1,3})(?!\d)/g)].map(m => +m[1]).filter(n => n !== passengerNumber || !numM);
    if (nums.length) value = nums[nums.length - 1];
  } else if (/\b(gender|male|female|purush|mahila|ladka|ladki|aadmi|aurat)\b/.test(t)) {
    field = 'gender';
    if (/\b(female|mahila|ladki|aurat|f)\b/.test(t)) value = 'FEMALE'; else if (/\b(male|purush|ladka|aadmi|m)\b/.test(t)) value = 'MALE'; else if (/\b(other)\b/.test(t)) value = 'OTHER';
  } else if (/\b(berth|seat preference|lower|upper|middle|side lower|side upper)\b/.test(t)) {
    field = 'berthPreference';
    const b = t.match(/\b(side lower|side upper|lower|upper|middle)\b/);
    if (b) value = b[1].toUpperCase().replace(' ', '_');
  } else if (/\b(naam|name|spelling)\b/.test(t)) {
    field = 'name';
    const m = t.match(/\b(?:naam|name)\s+(?:ko\s+|badal kar\s+|change karke\s+)?([a-z][a-z.]*(?: [a-z][a-z.]*){0,3}?)\s+(?:kar do|kardo|karo|kar dijiye|hai|rakh do|rakho|likho|change)\b/);
    if (m && !/\b(passenger|ka|ki|ke|change|badal)\b/.test(m[1])) value = m[1].split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  if (!field) return { change: { op: 'CORRECT', passengerNumber } };
  return { change: { op: 'CORRECT', passengerNumber, field, ...(value !== undefined ? { value } : {}) } };
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

export function classifyLifecycleIntent(raw: string, opts: { awaiting?: 'DATE' | 'CLASS' } = {}): LifecycleIntent | null {
  const t = norm(raw);
  if (!t.trim()) return null;
  const retry = RETRY_RE.test(t);
  const base = { retry, changes: {} as RequestedChanges, referenceText: t };

  // ---- refund (read-only provider check; cancellation ≠ refund) ----
  if (REFUND_RE.test(t)) return { ...base, action: 'CHECK_REFUND_STATUS', family: 'REFUND' };

  // ---- cancellation ----
  const cancelWord = CANCEL_WORD.test(t);
  const hata = HATA_RE.test(t) && /\b(booking|ticket|tikat|reservation)\b/.test(t) && !PASSENGER_WORD.test(t);
  if (cancelWord || hata) {
    // interruption / negation: NEVER a cancellation request (e.g. "ruk jao", "cancel mat karo", "rehne do")
    if (INTERRUPT_RE.test(t) || NEGATION_RE.test(t)) return null;
    if (ELIGIBILITY_RE.test(t)) return { ...base, action: 'CHECK_CANCELLATION_ELIGIBILITY', family: 'CANCEL' };
    if (STATUS_Q_RE.test(t) && !retry && !/\b(kar do|kardo|karo|karwa do|kar dijiye)\b/.test(t)) return { ...base, action: 'ACTION_STATUS', family: 'CANCEL' };
    // a bare "cancel" (no object, no action verb) is NOT a booking-cancellation intent
    if (!hata && !(OBJECT_RE.test(t) || ACTION_VERB_RE.test(t) || retry)) return null;
    return { ...base, action: 'REQUEST_CANCELLATION', family: 'CANCEL', referenceText: t.replace(CANCEL_WORD, ' ').replace(HATA_RE, ' ') };
  }
  if (INTERRUPT_RE.test(t)) return null;

  // ---- modification status / eligibility ----
  const isModifyTalk = DATE_WORD.test(t) || CLASS_WORD.test(t) || GENERIC_MODIFY.test(t) || /\b(modification)\b/.test(t);
  if (/\b(modification|change request)\b/.test(t) && STATUS_Q_RE.test(t) && !ELIGIBILITY_RE.test(t)) return { ...base, action: 'ACTION_STATUS', family: 'MODIFY' };
  if (isModifyTalk && ELIGIBILITY_RE.test(t) && !NEGATION_RE.test(t)) return { ...base, action: 'CHECK_MODIFICATION_ELIGIBILITY', family: 'MODIFY' };

  // ---- journey date change ----
  if ((DATE_WORD.test(t) && CHANGE_VERB.test(t)) || opts.awaiting === 'DATE') {
    if (NEGATION_RE.test(t) && !opts.awaiting) return null;
    const d = extractNewDate(t);
    const referenceText = d.matched ? t.replace(d.matched, ' ') : t;
    if (opts.awaiting === 'DATE' && !d.date && !d.error) return null;
    return {
      ...base, action: 'REQUEST_JOURNEY_CHANGE', family: 'MODIFY', referenceText,
      changes: d.date ? { journeyDate: d.date } : {},
      ...(d.error ? { changeError: { code: 'INVALID_DATE' as const, message: 'Nayi journey date sahi nahi hai (jaise "25 October"; beeti hui date nahi chalegi).' } } : {})
    };
  }

  // ---- class change ----
  const toks = classTokens(t);
  const seBetween = toks.length >= 2 && /\b(se|to|ki jagah|instead of|→)\b/.test(t.slice(toks[0].index, toks[toks.length - 1].index));
  if ((CLASS_WORD.test(t) && (CHANGE_VERB.test(t) || /\bupgrade|downgrade\b/.test(t))) || (seBetween && CHANGE_VERB.test(t)) || (opts.awaiting === 'CLASS' && toks.length)) {
    if (NEGATION_RE.test(t) && !opts.awaiting) return null;
    const target = toks.length ? toks[toks.length - 1] : null;
    let referenceText = t;
    for (const k of toks) referenceText = referenceText.replace(k.text, ' ');
    return { ...base, action: 'REQUEST_CLASS_CHANGE', family: 'MODIFY', referenceText, changes: target ? { travelClass: target.code } : {} };
  }

  // ---- passenger change ----
  // Explicit only: the user must name a passenger slot ("passenger 2 …") or the booking/ticket itself.
  // A bare "Neha ki age 29 kar do" keeps its P12/P13 meaning (EXECUTION_LOCKED / fresh-handoff edit).
  if (/\b(passenger|yatri)\b/.test(t) || (/\b(naam|name|age|umar|umr|gender|berth)\b/.test(t) && CHANGE_VERB.test(t) && /\b(booking|ticket)\b/.test(t))) {
    if (!(CHANGE_VERB.test(t) || /\b(hata|remove|nikal|add|jodo|galat|wrong)\b/.test(t))) return null;
    if (NEGATION_RE.test(t) && !/\b(galat|wrong)\b/.test(t)) return null;
    const p = parsePassengerChange(t);
    return { ...base, action: 'REQUEST_PASSENGER_CHANGE', family: 'MODIFY', changes: p.change ? { passenger: p.change } : {}, referenceText: t.replace(/\b(passenger|yatri)\s*\d\b/g, ' ') };
  }

  // ---- generic modification ("booking change karni hai") ----
  if (GENERIC_MODIFY.test(t) && /\b(booking|ticket|tikat|reservation)\b/.test(t) && !NEGATION_RE.test(t)) {
    return { ...base, action: 'REQUEST_MODIFICATION', family: 'MODIFY' };
  }
  return null;
}
