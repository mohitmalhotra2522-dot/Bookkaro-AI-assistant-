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
  /** P42.2: a Same Train Alternative pair OTHER than the requested one — it only verifies a sentence that names one of
   *  its own ticket stations (code / name); otherwise it never stands in for the requested journey. */
  alternativePair?: { ticketOrigin: string; ticketDestination: string; tokens: string[] };
}

export type AvailabilityClassification =
  | 'NONE' | 'GENERAL_KNOWLEDGE_CLAIM' | 'CLASS_LIST' | 'USER_PROVIDED_FACT' | 'LIVE_AVAILABILITY_CLAIM';

export type AvailabilityOutcome =
  | Exclude<AvailabilityClassification, 'LIVE_AVAILABILITY_CLAIM'>
  | 'VERIFIED_AVAILABILITY' | 'UNVERIFIED_AVAILABILITY' | 'AVAILABILITY_MISMATCH' | 'CLASS_NOT_LISTED';

/** F2: 'WL_SEATS' = a waitlist POSITION stated as a seat count ("62 seats wait-list mein") — never true for any result. */
export type ClaimedStatus = { kind: 'AVAILABLE' | 'RAC' | 'WL' | 'NOT_AVAILABLE' | 'ANY' | 'WL_SEATS'; n?: number };

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
    // Prompt 42: a Same Train Alternative result is provider availability evidence too — per checked ticket pair, only
    // successful PROVIDER_API answers (never UNVERIFIED_WEB, never a failed / rejected / timed-out call)
    if (name === 'SEARCH_SAME_TRAIN_ALTERNATIVES' && ok && d && Array.isArray(d.alternatives)) {
      for (const alt of d.alternatives) {
        const pair = alt && !alt.isRequestedPair ? alternativePairOf(alt) : undefined;
        for (const e of (alt?.evidence || [])) {
          if (e?.level !== 'PROVIDER_API' || e?.outcome !== 'SUCCESS' || !str(e?.availability?.status)) continue;
          out.push({ trainNumber: str(e.trainNumber), date: str(e.date), travelClass: String(e.travelClass || '').toUpperCase(),
            status: String(e.availability.status), available: e.availability.category === 'AVAILABLE',
            sourceTool: AVAILABILITY_TOOL, sourceResultId: str(e.toolExecutionId) ?? null, origin: 'TOOL_STEP', ...(pair ? { alternativePair: pair } : {}) });
        }
      }
      continue;
    }
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

/** P42.2: the ticket stations of an alternative pair that differ from the requested journey (code + name tokens). */
function alternativePairOf(alt: any): AvailabilityEvidence['alternativePair'] {
  const tokens: string[] = [];
  const add = (code: any, name: any) => {
    if (str(code)) tokens.push(String(code).toUpperCase());
    const n = String(name || '').toLowerCase().replace(/\b(jn|junction|cantt?|city|railway station)\b\.?/g, ' ').replace(/\s+/g, ' ').trim();
    if (n.length >= 4) tokens.push(n);
    const first = n.split(' ')[0];
    if (first && first.length >= 5 && first !== n) tokens.push(first);
  };
  if (alt.ticketOrigin && alt.ticketOrigin !== alt.requestedOrigin) add(alt.ticketOrigin, alt.ticketOriginName);
  if (alt.ticketDestination && alt.ticketDestination !== alt.requestedDestination) add(alt.ticketDestination, alt.ticketDestinationName);
  return { ticketOrigin: String(alt.ticketOrigin || ''), ticketDestination: String(alt.ticketDestination || ''), tokens: [...new Set(tokens)] };
}
const escRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionsPair = (t: string, pair: NonNullable<AvailabilityEvidence['alternativePair']>) => pair.tokens.some(k =>
  /^[A-Z0-9]+$/.test(k) ? new RegExp(`\\b${k}\\b`).test(t) : new RegExp(`\\b${escRe(k)}`, 'i').test(t));

// ------------------------------------------------------------------ classification (linguistic only)

const CLASS_CODE_RE = /\b(1A|2A|3A|3E|CC|EC|SL|2S|FC|EA)\b/g;
/** F2 (post-P42.10): "wait-list" / "wait‑list" (U+2010–U+2015 hyphens / dashes) / "wait list" is the waitlist word —
 *  the LLM's typographic hyphen must not hide a waitlist claim from the rules below (normalised before classification). */
const normWaitlistWords = (t: string) => String(t || '').replace(/\bwait[\s\-\u2010-\u2015]+list(ed)?\b/gi, 'waitlist$1');
/** F2: a WL / RAC position stated as a SEAT COUNT in the same clause — "62 seats wait-list mein", "62 seats are on the
 *  waitlist", "waitlist mein 62 seats hain". At most 3 words between, never across a clause break; a NEED ("2 seats ke
 *  liye waitlist 12") or an availability word ("5 seats available, baaki waitlist") in between is not this claim. */
const WL_SEATS_FWD_SRC = String.raw`\b(\d{1,4})\s+(?:seats?|berths?)\s+((?:[^\s,.;:!?–—-]+\s+){0,3}?)(?:waitlist(?:ed)?|waiting(?:\s+list)?|WL|GNWL|RLWL|PQWL|TQWL|RAC)\b`;
const WL_SEATS_REV_SRC = String.raw`\b(?:waitlist(?:ed)?|waiting(?:\s+list)?|WL|GNWL|RLWL|PQWL|TQWL|RAC)\s+((?:[^\s,.;:!?–—-]+\s+){0,2}?)(\d{1,4})\s+(?:seats?|berths?)\b`;
const WL_SEATS_GAP_EXCLUDE_RE = /\b(ke|liye|for|chahiye|chahiyein|need|needed|book|available|avl|avbl|khaali|khali|bachi|bache|baaki|left|remaining|confirm(ed)?|cnf)\b/i;
function wlAsSeats(t: string): number[] {
  const out: number[] = [];
  for (const m of t.matchAll(new RegExp(WL_SEATS_FWD_SRC, 'gi'))) if (!WL_SEATS_GAP_EXCLUDE_RE.test(m[2] || '')) out.push(Number(m[1]));
  for (const m of t.matchAll(new RegExp(WL_SEATS_REV_SRC, 'gi'))) if (!WL_SEATS_GAP_EXCLUDE_RE.test(m[1] || '')) out.push(Number(m[2]));
  return out;
}
/** a sentence that mentions seats / berths / availability vocabulary at all */
const AVAIL_WORD_RE = /\b(available|availability|unavailable|avl|avbl|khaali|khali|seats?|berths?|cnf|waiting|waitlist(?:ed)?|wl|gnwl|rlwl|pqwl|tqwl|rac|sold\s?out|regret)\b/i;
/** a status code with a position: "RAC 5", "WL 4", "Waitlist 12", "AVL 0012" */
const STATUS_NUM_SRC = String.raw`\b(RAC|WL|GNWL|RLWL|PQWL|TQWL|RSWL|waitlist(?:ed)?|waiting(?:\s+list)?|AVL|AVBL|available)\s*[-:/#]?\s*(\d{1,4})(?!\d)`;
const STATUS_NUM_RE = new RegExp(STATUS_NUM_SRC, 'i');
/** "5 seats available", "2 berths khaali hain" */
const COUNT_SEAT_RE = /\b(\d{1,3}|ek|do|teen|char|chaar|paanch|das|one|two|three|four|five|ten)\s+(seats?|berths?)\b(?=[^.?!]*\b(available|khaali|khali|bachi|bache|baaki|left|remaining)\b)/i;
/** P42.2: "3 seats hain", "sirf 1 seat hai", "3 seats mil rahi hain" — a count stated as the current state (the verb
 *  follows the count directly, so "2 seats chahiye" / "2 seats book karni hain" are not seat claims) */
const COUNT_SEAT_STATE_RE = /\b(\d{1,3}|ek|do|teen|char|chaar|paanch|das|one|two|three|four|five|ten|zero)\s+(?:confirmed\s+|confirm\s+|cnf\s+|khaali\s+|khali\s+|available\s+)?(seats?|berths?)\s+(?:hi\s+|bhi\s+)?(hain|hai|h|he|mil\s+rahi|mil\s+rahe|mil\s+jayengi|mil\s+jayegi|milengi|milegi|milenge)\b/i;
/** P42.3: a concrete available-seat COUNT tied to an availability word in the same clause: "1 seat available hai",
 *  "one seat is available", "2 berths abhi khaali hain", "0 confirmed seats available". At most 3 words between the
 *  count phrase and the availability word, never across a comma / clause break — so in "1 seat available hai, baki 2
 *  seats waitlist mein" only "1 seat available" is a count claim. A trailing "nahi" / "not" makes it a negative claim. */
const COUNT_AVAIL_SRC = String.raw`\b(\d{1,3}|ek|do|teen|char|chaar|paanch|das|one|two|three|four|five|ten|zero)\s+(?:confirmed\s+|confirm\s+|cnf\s+)?(?:seats?|berths?)\s+(?:[^\s,.;:!?–—-]+\s+){0,3}?(?:is\s+|are\s+)?(available|avl|avbl|khaali|khali|bachi|bache|baaki|left|remaining|free)\b(\s+(?:nahi|nahin|nhi|not)\b)?`;
const COUNT_AVAIL_RE = new RegExp(COUNT_AVAIL_SRC, 'i');
/** P42.3: a plain present-tense affirmation that seats ARE available (no count) — used only to keep a conditional /
 *  modal sentence from hiding a concrete claim and to catch "WL 1 hai, seats available hain" style contradictions */
const STRICT_AFFIRM_RE = /\b((seats?|berths?|tickets?)\s+(available|khaali|khali)\b(?!\s+(nahi|nahin|nhi|not)\b)|available\s+(hai|hain|h|he)\b|(is|are)\s+(currently\s+|still\s+|now\s+)?available\b|confirmed\s+seats?\s+(hai|hain|available))/i;
/** P42.3: the leading condition of a conditional sentence ("Agar aap seat chahte hain," / "If you want," / "Jab chahein
 *  to") — a concrete claim in the CONSEQUENT is still a railway fact and is checked */
const CONDITION_CLAUSE_RE = /^\s*(?:agar|if|jab|when|in\s+case)\b[^,;]*?(?:,|\bto\b|\bthen\b)/i;
const consequentOf = (t: string) => t.replace(CONDITION_CLAUSE_RE, ' ');
const hasCountClaim = (t: string) => COUNT_AVAIL_RE.test(t) || COUNT_SEAT_STATE_RE.test(t);
const COUNT_WORDS: Record<string, number> = { zero: 0, ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4, paanch: 5, five: 5, das: 10, ten: 10 };
const countOf = (w: string) => { const n = Number(w); return Number.isFinite(n) ? n : COUNT_WORDS[w.toLowerCase()]; };
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
export const hasAvailabilityCode = (t: string) => STATUS_NUM_RE.test(normWaitlistWords(t));

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
  const text = normWaitlistWords(String(t || '')).replace(BERTH_PREF_RE, 'preference');
  const neg = NEG_STATE_RE.test(text);
  if (!AVAIL_WORD_RE.test(text) && !neg) return 'NONE';
  const code = STATUS_NUM_RE.test(text);
  const count = COUNT_SEAT_RE.test(text) || COUNT_SEAT_STATE_RE.test(text) || wlAsSeats(text).length > 0;
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
  // P42.3: conditional / modal wording ("Agar aap seat chahte hain, to 1 seat available hai", "If you want, one seat is
  // available", "you can …") is NOT a reason to skip fact-checking — a concrete seat count or a present "available hai"
  // assertion outside the condition clause is a live claim. Explanations ("WL1 ka matlab waitlist hai", "agar RAC 1 wala
  // cancel kare to berth mil jaati hai") carry no such assertion and stay general knowledge.
  const rest = consequentOf(text);
  const concrete = !EXPLAIN_ONLY_RE.test(text) && (hasCountClaim(rest) || STRICT_AFFIRM_RE.test(rest)) && !/\b(sakti|sakta|sakte|sakein|ho\s+jaati|ho\s+jati|jaati\s+hain?|jati\s+hain?|hoti\s+hain?|hote\s+hain|milti\s+hain?|milte\s+hain|usually|generally|normally|typically)\b/i.test(rest);
  if (code || count) return !anchored && !concrete && (MODAL_GK_RE.test(text) || HYPOTHETICAL_RE.test(text)) && !DEFINITE_PROMISE_RE.test(text)
    ? 'GENERAL_KNOWLEDGE_CLAIM' : 'LIVE_AVAILABILITY_CLAIM';
  if (strong) return !anchored && !concrete && MODAL_GK_RE.test(text) ? 'GENERAL_KNOWLEDGE_CLAIM' : 'LIVE_AVAILABILITY_CLAIM';
  if (META_RE.test(text)) return 'NONE';
  // a specific train + seat vocabulary ("12014 mein waiting chal rahi hai") is about that train's live status
  if (trainAnchor && !EXPLAIN_ONLY_RE.test(text)) return 'LIVE_AVAILABILITY_CLAIM';
  return 'GENERAL_KNOWLEDGE_CLAIM';
}

// ------------------------------------------------------------------ authority (structured matching)

export const normAvailabilityStatus = (x: string) => String(x || '').toUpperCase()
  .replace(/WAIT\s*LIST(ED)?|WAITING(\s+LIST)?|GNWL|PQWL|RLWL|RSWL|TQWL/g, 'WL').replace(/\bCURR_AVBL\b|\bAVBL\b|\bAVL\b/g, 'AVAILABLE')
  .replace(/[-/#:]+/g, ' ').replace(/\b0+(\d)/g, '$1').replace(/\s+/g, ' ').trim();

/** A stated seat count as a claim: 0 = "no confirmed seats" (a negative claim), otherwise AVAILABLE n. */
const countClaim = (w: string, negated = false): ClaimedStatus => {
  const n = countOf(w);
  return negated || n === 0 ? { kind: 'NOT_AVAILABLE' } : { kind: 'AVAILABLE', ...(n !== undefined ? { n } : {}) };
};

/** F2: "62 seats wait-list mein" states a waitlist position as seats — a claim no result can support. It is checked
 *  AFTER the sentence's existing claims, so their (more specific) mismatch reasons keep priority. */
function claimedStatuses(t: string): ClaimedStatus[] {
  const base = baseClaimedStatuses(t);
  const wl = wlAsSeats(t);
  return wl.length ? [...base.filter(c => c.kind !== 'ANY'), ...wl.map(n => ({ kind: 'WL_SEATS' as const, n }))] : base;
}

function baseClaimedStatuses(t: string): ClaimedStatus[] {
  const out: ClaimedStatus[] = [];
  for (const m of t.matchAll(new RegExp(STATUS_NUM_SRC, 'gi'))) {
    const w = m[1].toUpperCase();
    out.push({ kind: w === 'RAC' ? 'RAC' : /^(AVL|AVBL|AVAILABLE)$/.test(w) ? 'AVAILABLE' : 'WL', n: Number(m[2]) });
  }
  // P42.3: concrete seat counts are claims IN ADDITION to any status code / waitlist word in the same sentence —
  // "WL 1 hai, 1 seat available hai" claims WL 1 AND AVAILABLE 1, and each must match the authoritative result
  for (const m of t.matchAll(new RegExp(COUNT_AVAIL_SRC, 'gi'))) out.push(countClaim(m[1], !!m[3]));
  if (!out.some(c => c.kind === 'AVAILABLE' || c.kind === 'NOT_AVAILABLE')) {
    const st = t.match(COUNT_SEAT_STATE_RE);
    if (st) out.push(countClaim(st[1]));
  }
  // …and a plain "seats available hain" next to a waitlist / RAC code is an AVAILABLE claim too (cross-status check)
  if (out.length && out.some(c => c.kind === 'WL' || c.kind === 'RAC') && !out.some(c => c.kind === 'AVAILABLE' || c.kind === 'NOT_AVAILABLE')
    && !NEG_STATE_RE.test(t) && STRICT_AFFIRM_RE.test(t)) out.push({ kind: 'AVAILABLE' });
  if (out.length) return out;
  if (NEG_STATE_RE.test(t)) return [{ kind: 'NOT_AVAILABLE' }];
  if (/\bRAC\b/i.test(t) || /\b(WL|waitlist(ed)?|waiting)\b/i.test(t)) {
    const kinds: ClaimedStatus[] = [];
    if (/\bRAC\b/i.test(t)) kinds.push({ kind: 'RAC' });
    if (/\b(WL|waitlist(ed)?|waiting)\b/i.test(t)) kinds.push({ kind: 'WL' });
    if (STRICT_AFFIRM_RE.test(t)) kinds.push({ kind: 'AVAILABLE' });
    return kinds;
  }
  const c = t.match(COUNT_SEAT_RE) || t.match(COUNT_SEAT_STATE_RE);
  if (c) { const n = countOf(c[1]); return [{ kind: 'AVAILABLE', ...(n !== undefined ? { n } : {}) }]; }
  if (PRESENT_AFFIRM_RE.test(t) || TREND_RE.test(t)) return [{ kind: 'AVAILABLE' }];
  return [{ kind: 'ANY' }];
}

/** P42.3: a status that says nothing about seats (unknown / timeout / provider error / empty) supports NO claim —
 *  neither "seats available" nor "no seats". */
const UNKNOWN_STATUS_RE = /^(UNKNOWN|TIMEOUT|TIMED OUT|TOOL TIMEOUT|ERROR|PROVIDER ERROR|PROVIDER_ERROR|PROVIDER UNAVAILABLE|FAILED|NULL|UNDEFINED|N A|NA|-|)$/;

function statusMatches(c: ClaimedStatus, e: AvailabilityEvidence): boolean {
  const st = normAvailabilityStatus(e.status);
  // the count is ONLY the number belonging to the status itself ("AVAILABLE 10", "WL 1", "RAC 4") — never a request id,
  // timestamp, PNR, train number or any other provider metadata
  const num = Number((st.match(/^(?:AVAILABLE|WL|RAC)\s?(\d+)/) || [])[1]);
  if (c.kind !== 'ANY' && (UNKNOWN_STATUS_RE.test(st) || /\bUNKNOWN\b|\bTIMEOUT\b/.test(st))) return false;
  const availZero = /^AVAILABLE\s?0+$/.test(st);
  switch (c.kind) {
    case 'ANY': return true;
    case 'NOT_AVAILABLE': return availZero || e.available === false || (!/^AVAILABLE/.test(st) && e.available !== true);
    case 'AVAILABLE': {
      // "WL1" / "RLWL1" is a waitlist POSITION, never a confirmed or available seat; "AVAILABLE 0" is no seat
      const isAvail = !availZero && (/^AVAILABLE/.test(st) || (e.available === true && !/^(RAC|WL)/.test(st) && !/\bWL\d*\b/.test(st)));
      return isAvail && (c.n === undefined || num === c.n);
    }
    case 'RAC': return /^RAC/.test(st) && (c.n === undefined || num === c.n);
    case 'WL': return /^WL/.test(st) && (c.n === undefined || num === c.n);
    case 'WL_SEATS': return false;   // F2: a WL / RAC position is never a seat count
  }
}

function claimDate(t: string, s: any): string | undefined {
  const m = t.match(DAY_RE);
  if (m) { const r: any = resolveDate(m[1].toLowerCase()); if (r?.ok && r.date) return String(r.date); }
  // Prompt 28: an explicit calendar date ("5 Oct", "2026-10-06") binds the claim to that date too
  return explicitDates(t)[0] ?? str(s?.date);
}

const mismatchReason = (c: ClaimedStatus) => c.kind === 'WL_SEATS' ? 'AVAILABILITY_MISMATCH:WL_POSITION_AS_SEATS' :
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
  // P42.2: a sentence naming an alternative ticket station is judged ONLY against that pair's evidence; a sentence
  // naming none is judged against the requested journey only (another pair's "AVAILABLE 3" never proves it)
  const datedTrain = ctx.evidence.filter(e =>
    (!trainNumbers.length || (!!e.trainNumber && trainNumbers.includes(e.trainNumber)))
    && (!date || !e.date || e.date === date));
  const pairNamed = datedTrain.filter(e => e.alternativePair && mentionsPair(t, e.alternativePair));
  const trainEvidence = pairNamed.length ? pairNamed : datedTrain.filter(e => !e.alternativePair);
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
  const text = normWaitlistWords(String(t || ''));
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
  // P42.2: "1A available hai" when the provider gave only 1 seat for a party of 3 hides the shortage — the exact count
  // must be stated ("sirf 1 seat"); a bare AVAILABLE claim over an insufficient count is rejected
  const pax = Number((ctx.session as any)?.passengersCount);
  const seats = Number((normAvailabilityStatus(e.status).match(/^AVAILABLE (\d+)/) || [])[1]);
  if (Number.isInteger(pax) && pax > 1 && Number.isFinite(seats) && seats < pax && statuses.some(c => c.kind === 'AVAILABLE' && c.n === undefined)) {
    return { outcome: 'AVAILABILITY_MISMATCH', reason: 'AVAILABILITY_INSUFFICIENT_FOR_PARTY', claim, evidence: e };
  }
  return {
    outcome: 'VERIFIED_AVAILABILITY', reason: null, claim, evidence: e,
    provenance: { claimType: 'RAILWAY_LIVE_FACT', factSubtype: 'SEAT_AVAILABILITY', verified: true, sourceTool: AVAILABILITY_TOOL, sourceResultId: e.sourceResultId,
      trainNumber: e.trainNumber, date: e.date, travelClass: e.travelClass, availability: e.status }
  };
}
