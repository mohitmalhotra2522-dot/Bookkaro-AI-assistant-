/**
 * Prompt 26 — Seat-availability authority (ONE deterministic rule, used by every response-validation layer).
 *
 *   SEAT_AVAILABILITY is authoritative ONLY when a CHECK_AVAILABILITY result (this turn's validated tool step, or the
 *   session entry the runtime committed from that tool) matches the claim's train + date + class + status.
 *
 * Two separate questions, never mixed:
 *   1. CLASSIFICATION (linguistic): is this sentence a current seat-availability claim at all, or a general
 *      explanation ("RAC mein cancellation hone par seat confirm ho sakti hai"), a class list ("CC aur 2S"), a
 *      statement attributed to the user, or unrelated? Keywords are allowed HERE — only to decide what kind of
 *      sentence it is.
 *   2. AUTHORITY (structured): a live claim is verified only by matching availability evidence. Keyword presence —
 *      in the LLM's text, the backend's reply or the user's words — is NEVER evidence. SEARCH_TRAINS (even its
 *      per-class `avail` field), GET_TRAIN_INFO, GET_TIMETABLE, GET_FARE and general knowledge never prove seats.
 *
 * Nothing here rewrites the LLM's language or calls a provider; an unverified claim is reported so the composer can
 * drop the sentence (existing safe behaviour) — availability is never invented.
 */
import type { BookingSession } from '@shared/entities';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { explicitDates } from './claim-dates';

export const AVAILABILITY_TOOL = 'CHECK_AVAILABILITY';

/** A single authoritative availability result (existing field names of AvailabilityResult / AvailabilityData). */
export interface AvailabilityEvidence {
  trainNumber?: string;
  date?: string;
  travelClass: string;
  status: string;
  available?: boolean;
  sourceTool: typeof AVAILABILITY_TOOL;
  sourceResultId: string | null;
  /** 'TOOL_STEP' = this turn's validated result; 'SESSION' = committed by the runtime from CHECK_AVAILABILITY. */
  origin: 'TOOL_STEP' | 'SESSION';
}

export type AvailabilityClassification =
  | 'NONE' | 'GENERAL_KNOWLEDGE_CLAIM' | 'CLASS_LIST' | 'USER_PROVIDED_FACT' | 'LIVE_AVAILABILITY_CLAIM';

export type AvailabilityOutcome =
  | Exclude<AvailabilityClassification, 'LIVE_AVAILABILITY_CLAIM'>
  | 'VERIFIED_AVAILABILITY' | 'UNVERIFIED_AVAILABILITY' | 'AVAILABILITY_MISMATCH' | 'CLASS_NOT_LISTED';

export type ClaimedStatus = { kind: 'AVAILABLE' | 'RAC' | 'WL' | 'NOT_AVAILABLE' | 'ANY'; n?: number };

/** Internal provenance of an availability sentence — never shown to the user. */
export interface AvailabilityProvenance {
  claimType: 'RAILWAY_LIVE_FACT' | 'USER_PROVIDED';
  factSubtype: 'SEAT_AVAILABILITY';
  verified: boolean;
  sourceTool: typeof AVAILABILITY_TOOL | null;
  sourceResultId: string | null;
  trainNumber?: string;
  date?: string;
  travelClass?: string;
  availability?: string;
}

export interface AvailabilityVerdict {
  outcome: AvailabilityOutcome;
  /** Rejection reason for the response validator (null = the sentence may stay). */
  reason: string | null;
  claim?: { trainNumbers: string[]; date?: string; classes: string[]; statuses: ClaimedStatus[] };
  evidence?: AvailabilityEvidence;
  provenance?: AvailabilityProvenance;
}

export interface AvailabilityContext {
  session: BookingSession | any;
  evidence: AvailabilityEvidence[];
  /** Train → listed classes (provider class lists) — only to report CLASS_NOT_LISTED; never availability evidence. */
  trains?: Array<{ num: string; classes: string[] }>;
  /** Who said the sentence. A USER statement is never authority. */
  origin?: 'USER' | 'ASSISTANT';
}

// ------------------------------------------------------------------ evidence (structured, tool-backed only)

const str = (v: any) => (v === undefined || v === null || v === '' ? undefined : String(v));

/**
 * Collect availability evidence. Accepts the composer's tool views ({toolName, ok, data}) and the runtime's steps
 * ({status, result: {toolName, data}}). ONLY CHECK_AVAILABILITY counts — any other tool is ignored by construction.
 */
export function collectAvailabilityEvidence(session: BookingSession | any, steps: any[] = []): AvailabilityEvidence[] {
  const s: any = session || {};
  const selected = str(s.selectedTrain?.number ?? s.selectedTrain?.trainNumber);
  const out: AvailabilityEvidence[] = [];
  for (const [key, v] of Object.entries((s.availability || {}) as Record<string, any>)) {
    if (!v || typeof v !== 'object' || !str(v.status)) continue;
    out.push({
      trainNumber: str(v.trainNumber) ?? selected, date: str(v.date) ?? str(s.date), travelClass: String(v.travelClass || key).toUpperCase(),
      status: String(v.status), available: typeof v.available === 'boolean' ? v.available : undefined,
      sourceTool: AVAILABILITY_TOOL, sourceResultId: str(v.toolExecutionId) ?? null, origin: 'SESSION'
    });
  }
  for (const st of steps || []) {
    const name = st?.toolName ?? st?.result?.toolName ?? st?.toolCall?.name;
    const ok = typeof st?.ok === 'boolean' ? st.ok
      : st?.status !== 'error' && st?.status !== 'rejected' && (st?.status === 'ok' || st?.result?.success === true);
    const d = st?.data ?? st?.result?.data;
    if (name !== AVAILABILITY_TOOL || !ok || !d || !str(d.status)) continue;
    out.push({
      trainNumber: str(d.trainNumber) ?? selected, date: str(d.date) ?? str(s.date), travelClass: String(d.travelClass || '').toUpperCase(),
      status: String(d.status), available: typeof d.available === 'boolean' ? d.available : undefined,
      sourceTool: AVAILABILITY_TOOL, sourceResultId: str(st?.execution?.toolExecutionId ?? st?.result?.toolExecutionId ?? st?.toolExecutionId ?? st?.callId) ?? null,
      origin: 'TOOL_STEP'
    });
  }
  return out;
}

// ------------------------------------------------------------------ classification (linguistic only)

const CLASS_CODE_RE = /\b(1A|2A|3A|3E|CC|EC|SL|2S|FC|EA)\b/g;
/** a sentence that mentions seats / berths / availability vocabulary at all */
const AVAIL_WORD_RE = /\b(available|availability|unavailable|avl|avbl|khaali|khali|seats?|berths?|cnf|waiting|waitlist(?:ed)?|wl|gnwl|rlwl|pqwl|tqwl|rac|sold\s?out|regret)\b/i;
/** a status code with a position: "RAC 5", "WL 4", "Waitlist 12", "AVL 0012" */
const STATUS_NUM_SRC = String.raw`\b(RAC|WL|GNWL|RLWL|PQWL|TQWL|RSWL|waitlist(?:ed)?|waiting(?:\s+list)?|AVL|AVBL|available)\s*[-:/#]?\s*(\d{1,4})(?!\d)`;
const STATUS_NUM_RE = new RegExp(STATUS_NUM_SRC, 'i');
/** "5 seats available", "2 berths khaali hain" */
const COUNT_SEAT_RE = /\b(\d{1,3}|ek|do|teen|char|chaar|paanch|das|one|two|three|four|five|ten)\s+(seats?|berths?)\b(?=[^.?!]*\b(available|khaali|khali|bachi|bache|baaki|left|remaining)\b)/i;
/** present / definite affirmation of seats ("available hai", "seats khaali", "seat mil jayegi", "confirmed seat milegi") */
const PRESENT_AFFIRM_RE = /\b(available\s+(hai|hain|h|he|ho|tha|thi)\b|(is|are)\s+(currently\s+|still\s+|now\s+)?available|available\s+(now|abhi)\b|seats?\s+(available|khaali|khali|bachi|bache|baaki|left)|berths?\s+(available|khaali|khali|bachi|left)|availability\s+(hai|hain|achhi|good|open)\b|(seats?|tickets?|berths?)\s+(mil\s+(jaayegi|jayegi|jaegi|jayega|jaega|jaayega)|milegi|milega|mil\s+rahi|mil\s+rahe)|seats?\s+confirm(ed)?\s+(hai|milegi|milega|ho\s+(jayegi|jaayegi|jaegi))|confirmed\s+seats?\s+(hai|hain|milegi|milega|available)|cnf\s+(hai|milega|milegi)|seats?\s+pakki|pakki\s+seats?)/i;
const TREND_RE = /\b(bhar\s+rahi|bhar\s+rahe|filling\s+(up|fast)|kam\s+(bachi|bache)|few\s+seats|limited\s+seats|last\s+few\s+seats)\b/i;
/** negative current state ("full hai", "available nahi", "sold out", "regret") */
const NEG_STATE_RE = /\b(full\s+(hai|hain|ho\s+(gayi|gaya|chuki|chuka))|(is|are)\s+full|sold\s?out|regret|bhar\s+(gayi|gaya|chuki|chuka)|bhari\s+(hai|hui)|not\s+available|available\s+nahi|nahi?n?\s+available|unavailable|no\s+seats|seats?\s+nahi?n?)\b/i;
/** seat context — "available nahi hai" about a FEATURE is not a seat claim */
const SEAT_CTX_RE = /\b(seats?|berths?|tickets?|rac|wl|waiting|waitlist|cnf|avl|avbl|availability|train|gaadi|gadi|quota)\b/i;
const MODAL_GK_RE = /\b(sakti|sakta|sakte|sakein|ho\s+jaati|ho\s+jati|ho\s+jaata|ho\s+jata|jaati\s+hai|jati\s+hai|jaati\s+hain|jaate\s+hain|hoti\s+hai|hota\s+hai|hote\s+hain|milti\s+hai|milta\s+hai|milte\s+hain|can|could|may|might|usually|generally|normally|typically|aam\s+taur|agar|if|jab|when|matlab|means)\b/i;
const EXPLAIN_ONLY_RE = /\b(matlab|means|ka\s+matlab|stands\s+for|kehte\s+hain|is\s+called)\b/i;
/** statements ABOUT checking ("availability check karun?", "verify nahi hui") are not seat claims */
const META_RE = /\b(availability|seat\s+status)\b[^.?!]*\b(check|dekh|verify|pata|data|jaankari|information|info|result|fetch|uplabdh\s+nahi|nahi\s+mil)\w*|\b(check|dekh|verify)\s*(kar|karke|karun|karoon|karta|karti|karein|kijiye|karna|karni|kiya|ki|kare|karu)\b/i;
const USER_ATTRIB_RE = /\b(aapne\s+(bataya|kaha|likha|bola)|aap(ne)?\s+(keh|kah)\s+rahe|aapke\s+(hisaab|mutabik|anusar)|aapki\s+jaankari\s+ke\s+(hisaab|mutabik)|you\s+(said|mentioned|told)|according\s+to\s+you|as\s+you\s+(said|mentioned))\b/i;
const VERIFY_CLAIM_RE = /\b(verified|verify\s+(kar|ho)\s+(liya|li|gaya|gayi)|check\s+(kar\s+)?(liya|kiya|li)|maine\s+check|pakka\s+hai|sahi\s+hai|correct\s+hai|confirm\s+kar\s+(diya|liya))\b/i;
const THIS_TRAIN_RE = /\b(is|iss|us|uss|yeh|ye|this|that)\s+(train|gaadi|gadi)\b|\bis\s?mein\b|\bisme\b/i;
const TRAIN_NUM_RE = /\b\d{5}\b/g;
const DAY_RE = /\b(aaj|today|kal|tomorrow|parso|parson|day after tomorrow)\b/i;
const SEAT_WORD_RE = /\b(seats?|berths?)\b/i;
const BERTH_PREF_RE = /\b(?:(?:side\s+)?(?:lower|middle|upper)|side)\s+berths?\b|\bberths?\s+(?:preferences?|choices?|options?|pasand)\b/gi;
const HYPOTHETICAL_RE = /\b(jaise|example|for example|e\.g\.|maan\s+(lo|lijiye|lijie)|suppose|say|cancel\w*|cancellation|chart\s+ban\w*|upgrade|move\s+up|aage\s+badh\w*|kam\s+ho\w*)\b/i;
const DEFINITE_PROMISE_RE = /\b(milega|milegi|milenge|you\s*'?ll\s+get|you\s+will\s+get|aapko\s+\w+\s+mil\s+(gaya|gayi)|abhi|currently|right\s+now)\b/i;

const codesIn = (t: string) => [...new Set((t.match(CLASS_CODE_RE) || []).map(c => c.toUpperCase()))];
const trainNumsIn = (t: string) => [...new Set(t.match(TRAIN_NUM_RE) || [])];
export const hasAvailabilityCode = (t: string) => STATUS_NUM_RE.test(t);

/** Prompt 25/26: "CC aur 2S available" — an ENUMERATION of ≥2 listed classes with no seat / status vocabulary. */
export function isClassEnumeration(t: string): boolean {
  return codesIn(t).length >= 2 && /\bavailable\b/i.test(t) && !SEAT_WORD_RE.test(t) && !STATUS_NUM_RE.test(t)
    && !/\b(rac|wl|waiting|waitlist|cnf|khaali|khali|confirm(ed)?|pakki)\b/i.test(t) && !NEG_STATE_RE.test(t);
}

/** Linguistic classification only — says WHAT a sentence is, never whether it is true. */
export function classifyAvailabilityClaim(t: string, origin: 'USER' | 'ASSISTANT' = 'ASSISTANT'): AvailabilityClassification {
  // P39.2: asking for / noting a passenger's BERTH PREFERENCE ("12926 3A mein berth preference batayein", "Lower berth
  // note kiya") is not seat-availability vocabulary. Only these phrases are neutralised — "available", "khaali", seat /
  // status words and codes in the same sentence are still classified exactly as before.
  const text = String(t || '').replace(BERTH_PREF_RE, 'preference');
  const neg = NEG_STATE_RE.test(text);
  if (!AVAIL_WORD_RE.test(text) && !neg) return 'NONE';
  const code = STATUS_NUM_RE.test(text);
  const count = COUNT_SEAT_RE.test(text);
  const pos = PRESENT_AFFIRM_RE.test(text) || TREND_RE.test(text);
  const trainAnchor = trainNumsIn(text).length > 0 || THIS_TRAIN_RE.test(text);
  const anchored = trainAnchor || DAY_RE.test(text) || codesIn(text).length > 0;
  const seatCtx = SEAT_CTX_RE.test(text) || codesIn(text).length > 0 || trainAnchor;
  const strong = code || count || ((pos || neg) && seatCtx);
  // a user's words are never railway authority — at most a USER_PROVIDED fact
  if (origin === 'USER') return strong || (trainAnchor && AVAIL_WORD_RE.test(text)) ? 'USER_PROVIDED_FACT' : 'NONE';
  if (!code && !count && isClassEnumeration(text)) return 'CLASS_LIST';
  if (strong && USER_ATTRIB_RE.test(text) && !VERIFY_CLAIM_RE.test(text)) return 'USER_PROVIDED_FACT';
  // Prompt 28: a status code inside an unanchored explanation / hypothetical ("agar RAC 1 wala cancel kare to berth mil
  // jaati hai") is general knowledge; a definite promise to the user ("WL 8 milega") stays a live claim
  if (code || count) return !anchored && (MODAL_GK_RE.test(text) || HYPOTHETICAL_RE.test(text)) && !DEFINITE_PROMISE_RE.test(text)
    ? 'GENERAL_KNOWLEDGE_CLAIM' : 'LIVE_AVAILABILITY_CLAIM';
  if (strong) return !anchored && MODAL_GK_RE.test(text) ? 'GENERAL_KNOWLEDGE_CLAIM' : 'LIVE_AVAILABILITY_CLAIM';
  if (META_RE.test(text)) return 'NONE';
  // a specific train + seat vocabulary ("12014 mein waiting chal rahi hai") is about that train's live status
  if (trainAnchor && !EXPLAIN_ONLY_RE.test(text)) return 'LIVE_AVAILABILITY_CLAIM';
  return 'GENERAL_KNOWLEDGE_CLAIM';
}

// ------------------------------------------------------------------ authority (structured matching)

export const normAvailabilityStatus = (x: string) => String(x || '').toUpperCase()
  .replace(/WAIT\s*LIST(ED)?|WAITING(\s+LIST)?|GNWL|PQWL|RLWL|RSWL|TQWL/g, 'WL').replace(/\bCURR_AVBL\b|\bAVBL\b|\bAVL\b/g, 'AVAILABLE')
  .replace(/[-/#:]+/g, ' ').replace(/\b0+(\d)/g, '$1').replace(/\s+/g, ' ').trim();

function claimedStatuses(t: string): ClaimedStatus[] {
  const out: ClaimedStatus[] = [];
  for (const m of t.matchAll(new RegExp(STATUS_NUM_SRC, 'gi'))) {
    const w = m[1].toUpperCase();
    out.push({ kind: w === 'RAC' ? 'RAC' : /^(AVL|AVBL|AVAILABLE)$/.test(w) ? 'AVAILABLE' : 'WL', n: Number(m[2]) });
  }
  if (out.length) return out;
  if (NEG_STATE_RE.test(t)) return [{ kind: 'NOT_AVAILABLE' }];
  if (/\bRAC\b/i.test(t)) return [{ kind: 'RAC' }];
  if (/\b(WL|waitlist(ed)?|waiting)\b/i.test(t)) return [{ kind: 'WL' }];
  const c = t.match(COUNT_SEAT_RE);
  if (c) { const n = Number(c[1]); return [{ kind: 'AVAILABLE', ...(Number.isFinite(n) ? { n } : {}) }]; }
  if (PRESENT_AFFIRM_RE.test(t) || TREND_RE.test(t)) return [{ kind: 'AVAILABLE' }];
  return [{ kind: 'ANY' }];
}

function statusMatches(c: ClaimedStatus, e: AvailabilityEvidence): boolean {
  const st = normAvailabilityStatus(e.status);
  const num = Number((st.match(/\d+/) || [])[0]);
  switch (c.kind) {
    case 'ANY': return true;
    case 'NOT_AVAILABLE': return e.available === false || (!/^AVAILABLE/.test(st) && e.available !== true);
    case 'AVAILABLE': {
      const isAvail = /^AVAILABLE/.test(st) || (e.available === true && !/^(RAC|WL)/.test(st));
      return isAvail && (c.n === undefined || num === c.n);
    }
    case 'RAC': return /^RAC/.test(st) && (c.n === undefined || num === c.n);
    case 'WL': return /^WL/.test(st) && (c.n === undefined || num === c.n);
  }
}

function claimDate(t: string, s: any): string | undefined {
  const m = t.match(DAY_RE);
  if (m) { const r: any = resolveDate(m[1].toLowerCase()); if (r?.ok && r.date) return String(r.date); }
  // Prompt 28: an explicit calendar date ("5 Oct", "2026-10-06") binds the claim to that date too
  return explicitDates(t)[0] ?? str(s?.date);
}

const mismatchReason = (c: ClaimedStatus) =>
  c.n !== undefined && c.kind !== 'ANY' && c.kind !== 'NOT_AVAILABLE' ? `AVAILABILITY_MISMATCH:${c.kind} ${c.n}` : 'AVAILABILITY_MISMATCH';

/** Evidence in scope of the sentence (train / date / class). Another train's or another date's result never applies. */
function scoped(t: string, ctx: AvailabilityContext) {
  const s: any = ctx.session || {};
  let trainNumbers = trainNumsIn(t);
  if (!trainNumbers.length) {
    const focus = THIS_TRAIN_RE.test(t) ? str(s.focusTrainNumber) ?? str(s.selectedTrain?.number) : str(s.selectedTrain?.number ?? s.selectedTrain?.trainNumber);
    if (focus) trainNumbers = [focus];
  }
  const date = claimDate(t, s);
  const named = codesIn(t);
  const classes = named.length ? named : (s.selectedClass ? [String(s.selectedClass).toUpperCase()] : []);
  const trainEvidence = ctx.evidence.filter(e =>
    (!trainNumbers.length || (!!e.trainNumber && trainNumbers.includes(e.trainNumber)))
    && (!date || !e.date || e.date === date));
  const evidence = trainEvidence.filter(e => !classes.length || classes.includes(e.travelClass));
  // every named train and every named class needs its OWN matching result (CC checked ≠ 2S checked)
  const coversAll = evidence.length > 0
    && trainNumbers.every(n => evidence.some(e => e.trainNumber === n))
    && classes.every(c => evidence.some(e => e.travelClass === c));
  return { trainNumbers, date, named, classes, evidence, trainEvidence, coversAll };
}

/** True when CHECK_AVAILABILITY evidence covers every train / class this sentence names (on the claimed date). */
export function hasScopedAvailability(t: string, ctx: AvailabilityContext): boolean {
  return scoped(t, ctx).coversAll;
}

/** THE availability rule. Classification first, then structured matching against CHECK_AVAILABILITY evidence only. */
export function judgeAvailabilityClaim(t: string, ctx: AvailabilityContext): AvailabilityVerdict {
  const text = String(t || '');
  let cls = classifyAvailabilityClaim(text, ctx.origin || 'ASSISTANT');
  // an enumeration is a class list — unless an availability result exists for it, then it IS a seat claim
  if (cls === 'CLASS_LIST' && hasScopedAvailability(text, ctx)) cls = 'LIVE_AVAILABILITY_CLAIM';
  if (cls === 'USER_PROVIDED_FACT') {
    return { outcome: cls, reason: null, provenance: { claimType: 'USER_PROVIDED', factSubtype: 'SEAT_AVAILABILITY', verified: false, sourceTool: null, sourceResultId: null } };
  }
  if (cls !== 'LIVE_AVAILABILITY_CLAIM') return { outcome: cls, reason: null };

  const sc = scoped(text, ctx);
  const statuses = claimedStatuses(text);
  const claim = { trainNumbers: sc.trainNumbers, date: sc.date, classes: sc.classes, statuses };
  // authority first: without a matching CHECK_AVAILABILITY result (for every named train / class) the claim is unverified
  if (!sc.coversAll) {
    // …and if evidence exists for that train, a class the provider does not even list is the more precise reason
    if (sc.trainEvidence.length && sc.trainNumbers.length === 1 && ctx.trains) {
      const listed = ctx.trains.find(x => x.num === sc.trainNumbers[0])?.classes || [];
      const bad = sc.named.find(c => listed.length && !listed.includes(c));
      if (bad) return { outcome: 'CLASS_NOT_LISTED', reason: `CLASS_NOT_LISTED:${bad}`, claim };
    }
    return { outcome: 'UNVERIFIED_AVAILABILITY', reason: 'UNVERIFIED_AVAILABILITY', claim };
  }
  for (const c of statuses) if (!sc.evidence.some(e => statusMatches(c, e))) return { outcome: 'AVAILABILITY_MISMATCH', reason: mismatchReason(c), claim };
  const e = sc.evidence.find(x => statuses.every(c => statusMatches(c, x))) || sc.evidence[0];
  return {
    outcome: 'VERIFIED_AVAILABILITY', reason: null, claim, evidence: e,
    provenance: { claimType: 'RAILWAY_LIVE_FACT', factSubtype: 'SEAT_AVAILABILITY', verified: true, sourceTool: AVAILABILITY_TOOL, sourceResultId: e.sourceResultId,
      trainNumber: e.trainNumber, date: e.date, travelClass: e.travelClass, availability: e.status }
  };
}
