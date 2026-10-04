/**
 * PROMPT 21 — NaturalResponseComposer (Parts 2, 5, 14, 16–19, 24, 26, 36, 40).
 *
 * The LLM words the spoken reply; the backend decides whether each sentence may be spoken.
 *   authoritative post-turn session + this turn's tool results + backend reply
 *     → llm.generateSpokenResponse (streamed deltas)
 *     → per completed sentence: no chain-of-thought / IVR phrasing, every number / class / ₹ / availability /
 *       time / booking claim grounded in authoritative data (RailwayResponseGrounding + number grounding)
 *     → accepted sentences stream out immediately as SPEECH_SEGMENTs (TTS can start before the turn ends)
 *     → the pending question is guaranteed; a confirmation turn must say the ticket is NOT booked
 *   Any failure (no provider capability, timeout, nothing accepted, sensitive turn) → deterministic speech.
 * Prompt 22: the SAME composer words the TEXT reply too (assistantText). responseMessage stays the authoritative
 * backend reply (the fact base + safe fallback). Extra grounding: stations / cities, train names (bound to the train
 * number they are said with), day words (aaj / kal / parso vs the session date), count words, availability status
 * (no upgrade "available" over WL / RAC, exact WL / RAC numbers) and ₹ amounts only from fare fields. Live-status
 * turns (PNR / running status / cancelled trains) keep the authoritative rendering of the provider result.
 */
import type { LLMProvider, TurnToolResultView } from '../providers/llm-provider';
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';
import { containsChainOfThought, soundsRobotic, segmentForSpeech, splitSentences } from '@shared/voice/voice-response-policy';
import { detectLanguageStyle, type LanguageStyle } from '@shared/voice/language-style';
import { railwayResponseGrounding } from '../tool-runtime/railway-response-grounding';
import { STATION_ALIASES, AMBIGUOUS_STATION_NAMES } from '@shared/constants';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import {
  buildFactIndex, judgeTimes, judgeComparison, repairClassList, judgeClassList, judgeFareScope,
  classifyPaxCount, isSessionish, derivedTrainCounts, isGeneralKnowledgeClaim, classifyClaim, type ClaimProvenance, type TimeVerdict, type FareFact, type PaxClass
} from './claim-facts';
import { collectAvailabilityEvidence, judgeAvailabilityClaim, type AvailabilityEvidence, type AvailabilityContext } from './availability-authority';
import { ClaimEntityBinder, verifyBoundClaim, diagnoseCrossEntity, resultTrainsOf, isEntityClaim, type ClaimBinding, type ClaimBindingStatus, type CrossEntityDiagnosis } from './claim-entity-binding';
import { explicitDates } from './claim-dates';
import { RESULT_REF_RE } from '../tool-runtime/tool-result-identity';
import { actionLedgerFromSteps, guardActionSentence, type ActionLedger, type ActionClaimDiagnostic } from './action-claims';

export interface NaturalComposeInput {
  llm: LLMProvider;
  session: BookingSession;
  userText: string;
  /** Backend TEXT reply (authoritative wording of this turn's facts). */
  backendReply: string;
  /** Prompt 22: output channel (TEXT chat reply or VOICE speech). Default VOICE. */
  mode?: 'TEXT' | 'VOICE';
  /** Deterministic VOICE speech (the fallback). */
  deterministicSpeech: string;
  stateBefore: BookingState;
  reviewVersionBefore: number | null;
  selectedTrainBefore: string | null;
  selectedClassBefore: string | null;
  passengersCountBefore: number | null;
  steps: any[];
  appliedActions: string[];
  changes: Array<{ field: string; corrected: boolean }>;
  error: { code: string; message: string } | null;
  pendingQuestionCode: string | null;
  pendingQuestion: string | null;
  history: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
  records?: any[];
  sensitive?: boolean;
  timeoutMs?: number;
  /** Streaming: grounded sentence ready to speak (index-ordered). */
  onSegment?: (index: number, text: string) => void;
  /**
   * Prompt 23: the native agent's own final answer, written after it saw this turn's tool results and the backend's
   * outcomes. When present (and still fresh — decided by the orchestrator) its sentences are judged instead of asking
   * the provider for a second wording call.
   */
  agentText?: string | null;
  /** Prompt 29: this turn's execution ledger (built from `steps` when absent) — authority for action / progress claims. */
  actionLedger?: ActionLedger;
  /**
   * Prompt 23: general railway-knowledge turn (no tool, no session change, no error). Judged for what it can falsely
   * claim (unknown train numbers, PNR-like numbers, fares, availability, counts, booking success, grounding) — not for
   * mentioning cities, train types, days or small numbers that are part of a general explanation.
   */
  general?: boolean;
  /**
   * Prompt 25 Part 10: a separate wording call is allowed only when material information arrived after the agent
   * spoke (or the provider has no agent-authored replies). false → no second LLM call; the backend reply is used.
   */
  allowWordingCall?: boolean;
}

export interface NaturalComposeResult {
  text: string;
  segments: string[];
  source: 'LLM' | 'FALLBACK';
  language: LanguageStyle;
  rejected: Array<{ sentence: string; reason: string }>;
  fallbackReason?: string;
  streamed: number;
  /** Prompt 23: AGENT = the native agent's own final answer (validated); WORDING = separate spoken-wording call. */
  authoredBy?: 'AGENT' | 'WORDING';
  general?: boolean;
  /** Prompt 25 Part 12: internal provenance of every accepted sentence (never sent to the user). */
  provenance?: ClaimProvenance[];
  /** Prompt 25: sentences kept with a meaning-preserving repair (CLASS_LIST disambiguation). */
  repaired?: number;
  /** Prompt 25 Part 10: whether a second (wording) LLM call was made. */
  wordingCall?: boolean;
  /** Prompt 28: claim ↔ entity binding summary (internal diagnostics only — never user-facing). */
  claimBinding?: ClaimBindingSummary;
  /** Prompt 29: action / progress statements checked against this turn's executions (internal diagnostics only). */
  actionClaims?: ActionClaimDiagnostic[];
  /** Prompt 28: extended provenance of every accepted sentence (claimId, entity, binding, verification) — internal only.
   *  `provenance` keeps the P25 / P26 shape unchanged. */
  claimProvenance?: ClaimProvenance[];
}

/** Prompt 28 — per-reply binding diagnostics: how every sentence was bound and which claims crossed entities. */
export interface ClaimBindingSummary {
  counts: Partial<Record<ClaimBindingStatus, number>>;
  /** rejected sentences whose fact exists — for a different train / class / date (or an unresolvable reference) */
  crossEntity: Array<{ reason: string; diagnosis: CrossEntityDiagnosis | 'AMBIGUOUS_REFERENCE'; binding: ClaimBindingStatus; trainNumber?: string }>;
  /** BOUND = every entity claim bound to one entity; AMBIGUOUS_REMOVED / CROSS_ENTITY_REMOVED otherwise; NONE = no entity claims */
  status: 'BOUND' | 'AMBIGUOUS_REMOVED' | 'CROSS_ENTITY_REMOVED' | 'NONE';
}

const SAFETY = new Set(['FORBIDDEN_ACTION', 'SENSITIVE_REQUEST_REJECTED', 'SENSITIVE_DATA_REJECTED', 'BOOKING_ACCESS_DENIED', 'INVALID_LLM_OUTPUT', 'SESSION_VERSION_CONFLICT']);
const CLASS_RE = /\b(1A|2A|3A|3E|CC|EC|SL|2S|FC)\b/g;
const SUCCESS_RE = /\b(book ho (gaya|gayi|gyi|chuka|chuki)|booked|booking (ho gayi|confirm(ed)?|successful|safal)|ticket (confirm|ban|book) (ho )?(gaya|gayi|chuka)|payment (ho gaya|done|successful)|pnr (number )?(hai|is|mil))/i;
const NEGATION_RE = /\b(nahi|nahin|na|not|no|never|abhi tak nahi)\b/i;
const NOT_BOOKED_RE = /(book nahi|booked nahi|nahi hua|not (been )?booked|no ticket|ticket book nahi)/i;
const LIVE_TOOLS = new Set(['CHECK_PNR', 'TRACK_TRAIN', 'GET_CANCELLED_TRAINS']);
const TRAIN_NAME_RE = /\b(jan shatabdi|shatabdi|rajdhani|duronto|vande bharat|garib rath|humsafar|tejas|intercity|sampark kranti|superfast|express|mail|antyodaya|double decker)\b/gi;
const CITY_RE = /\b(mumbai|bombay|kolkata|calcutta|howrah|chennai|madras|bangalore|bengaluru|hyderabad|secunderabad|pune|jaipur|lucknow|kanpur|patna|ahmedabad|surat|bhopal|indore|agra|varanasi|banaras|prayagraj|allahabad|jammu|katra|dehradun|haridwar|shimla|kalka|pathankot|firozpur|ferozpur|bathinda|bikaner|jodhpur|udaipur|gwalior|nagpur|goa|guwahati|bhubaneswar|puri|ranchi|raipur|moradabad|bareilly|meerut|saharanpur|ambala|panipat|sonipat|karnal|kurukshetra|phagwara|pune|kota|ajmer)\b/gi;
const DAY_RE = /\b(aaj|today|kal|tomorrow|parso|parson|day after tomorrow)\b/gi;
const TRAIN_COUNT_RE = /\b(\d+|ek|one|do|two|teen|three|char|chaar|four|paanch|five|chhe|six)\s+(trains?|trainein|gaadiyan)\b/gi;
const PAX_COUNT_RE = /\b(\d+|ek|one|do|two|teen|three|char|chaar|four|paanch|five|chhe|six)\s+(passengers?|yatri|log)\b/gi;
const COUNT_WORD: Record<string, number> = { ek: 1, one: 1, do: 2, two: 2, teen: 3, three: 3, char: 4, chaar: 4, four: 4, paanch: 5, five: 5, chhe: 6, six: 6 };
const lcPad = (x: string) => ` ${String(x || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
function stationCodesIn(text: string): Set<string> {
  const t = lcPad(text); const out = new Set<string>();
  for (const [k, v] of Object.entries(STATION_ALIASES)) if (t.includes(` ${k} `)) out.add(v.code);
  for (const [k, c] of Object.entries(AMBIGUOUS_STATION_NAMES)) if (t.includes(` ${k} `)) for (const x of c) out.add(x.code);
  return out;
}
/** Numbers under fare-bearing keys only (a ₹ amount must be a fare / total the provider or the review returned). */
// ids / timestamps / provenance inside a fare object are never amounts ("…-55…" in a requestId, ":55" in retrievedAt)
const FARE_META_KEY = /(id|at|time|timestamp|date|version|session|request|provider|source|origin|destination|hash|status|currency|class|train|count)$/i;
function collectFare(into: Set<number>, v: any, key = '', inFare = false, depth = 0) {
  if (v === null || v === undefined || depth > 7) return;
  if (key && FARE_META_KEY.test(key) && !/fare|total|amount|perpassenger|price/i.test(key)) return;
  const own = /fare|total|amount|perpassenger|price/i.test(key);
  const f = inFare || own;
  if (typeof v === 'number') { if (f && Number.isFinite(v)) into.add(Math.abs(v)); return; }
  if (typeof v === 'string') { if (own) for (const m of v.match(/\d+(?:\.\d+)?/g) || []) into.add(Number(m)); return; }
  if (Array.isArray(v)) { for (const x of v.slice(0, 40)) collectFare(into, x, key, f, depth + 1); return; }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v)) collectFare(into, x, k, f, depth + 1);
}
const SHORT_Q: Record<string, string> = {
  TRAIN_SELECTION_REQUIRED: 'Kaunsi train chahiye?', CLASS_SELECTION_REQUIRED: 'Kaunsi class chahiye?',
  REVIEW_APPROVAL_REQUIRED: 'Confirm karna hai?', CONFIRMATION_REQUIRED: 'Confirm karna hai?'
};
/** Prompt 25 Part 7: the backend's OWN appended question follows the user's language (the LLM's text is never rewritten). */
const SHORT_Q_EN: Record<string, string> = {
  ORIGIN_REQUIRED: 'Where will you be travelling from?', DESTINATION_REQUIRED: 'Where would you like to go?',
  DATE_REQUIRED: 'Which date would you like to travel?', PASSENGERS_REQUIRED: 'How many passengers?',
  TRAIN_SELECTION_REQUIRED: 'Which train would you like?', CLASS_SELECTION_REQUIRED: 'Which class would you like?',
  PASSENGER_DETAILS_REQUIRED: 'Could you share the passenger details — name, age and gender?',
  REVIEW_APPROVAL_REQUIRED: 'Shall I go ahead and confirm?', CONFIRMATION_REQUIRED: 'Shall I go ahead and confirm?'
};
/** A sentence that already asks the user for something ("…bata dijiye.", "Please share…") — no second question. */
const ASKS_RE = /(\?|\b(bata\s?(o|iye|ie|ein|yein|dijiye|dein|do|dena)|batayein|bataiye|batao|share (karein|kijiye|kar dijiye)|let me know|tell me|please (confirm|share|tell|choose|select|provide)|chun (lijiye|lein|lo)|select kar(ein|iye| lijiye)|confirm kar(ein|iye| dijiye))\b[^.!?]*[.!]?\s*$)/i;
const LEAD_CONJ = /^(aur|and|lekin|but|par|magar|ya|or|also|bhi|toh|to|so)\b[,\s]+/i;
/**
 * Prompt 25 Part 11: markdown lists become plain sentences BEFORE splitting, so a list marker can never survive as an
 * orphan sentence ("1."); a heading line ending in ":" becomes a sentence.
 */
export function toSentences(text: string): string[] {
  const lines = String(text || '')
    .replace(/([:.!?])[ \t]+(\d{1,2})[.)][ \t]+(?=\S)/g, (_m, p) => `${p}\n`)
    .split(/\n+/)
    .map(l => l.replace(/^\s*(?:\d{1,2}[.)]|[-*•])\s+/, '').trim())
    .filter(Boolean)
    .map(l => (/[:;,–—-]$/.test(l) ? `${l.replace(/[:;,–—-]+$/, '').trim()}.` : /[.!?।]$/.test(l) ? l : `${l}.`));
  return lines.flatMap(l => splitSentences(l)).map(x => x.trim()).filter(Boolean);
}
/** A leftover with no words ("1.", "-", "₹.", "…") is a fragment, never a sentence. */
const isFragment = (t: string) => !/[A-Za-z\u0900-\u097F]{2,}/.test(t);

/** Numbers that are authoritative for this turn (IDs / timestamps / versions are skipped). */
function collectNumbers(into: Set<number>, v: any, depth = 0, key = '') {
  if (v === null || v === undefined || depth > 6) return;
  if (/(^id$|Id$|At$|version|Version|hash|requestId|resultId)/.test(key)) return;
  if (typeof v === 'number') { if (Number.isFinite(v)) into.add(Math.abs(v)); return; }
  if (typeof v === 'string') {
    if (/[a-f0-9]{8}-[a-f0-9]{4}/i.test(v) || /^tx_|^turn_/.test(v)) return;
    for (const m of v.match(/\d+(?:\.\d+)?/g) || []) into.add(Number(m));
    return;
  }
  if (Array.isArray(v)) { for (const x of v.slice(0, 30)) collectNumbers(into, x, depth + 1, key); return; }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v)) collectNumbers(into, x, depth + 1, k);
}

function toolViews(steps: any[]): TurnToolResultView[] {
  return (steps || []).map(st => ({
    toolName: st.toolCall?.name, callId: st.toolCall?.callId, ok: !!st.result?.success, data: st.result?.data, identity: st.result?.identity,
    error: st.result?.error ? { code: st.result.error.code, message: st.result.error.message } : undefined,
    status: st.execution?.status || (st.result?.success ? 'SUCCEEDED' : st.status === 'rejected' ? 'REJECTED' : 'FAILED')
  }));
}

export class NaturalResponseComposer {
  async compose(i: NaturalComposeInput): Promise<NaturalComposeResult> {
    // Part 17 — same style as the user; short / name-only replies keep the conversation's earlier style
    const language = detectLanguageStyle(i.userText, i.history.filter(h => h.role === 'user').map(h => h.content));
    const s = i.session;
    const fallback = (reason: string, rejected: NaturalComposeResult['rejected'] = []): NaturalComposeResult => {
      const segments = segmentForSpeech(i.deterministicSpeech);
      segments.forEach((t, k) => i.onSegment?.(k, t));
      return { text: i.deterministicSpeech, segments, source: 'FALLBACK', language, rejected, fallbackReason: reason, streamed: segments.length };
    };
    if (!i.deterministicSpeech) return { text: '', segments: [], source: 'FALLBACK', language, rejected: [], fallbackReason: 'EMPTY', streamed: 0 };
    if (i.sensitive) return fallback('SENSITIVE_TURN');
    if (i.error && SAFETY.has(i.error.code)) return fallback('SAFETY_ERROR');
    if (i.error?.code === 'LLM_UNAVAILABLE') return fallback('LLM_UNAVAILABLE');
    const agentText = typeof i.agentText === 'string' && i.agentText.trim() ? i.agentText.trim() : null;
    if (!agentText && typeof i.llm.generateSpokenResponse !== 'function') return fallback('PROVIDER_NO_SPOKEN_RESPONSE');
    // Prompt 25 Part 10: no second LLM call for formatting / polishing / a non-semantic state move
    if (!agentText && i.allowWordingCall === false) return fallback('NO_MATERIAL_CHANGE');
    const mode = i.mode || 'VOICE';
    const general = !!i.general && !!agentText;

    // ---- the authoritative fact base for grounding ----
    const views = toolViews(i.steps);
    // Prompt 14/22: PNR / running status / cancelled trains → authoritative rendering of the provider result only
    if (views.some(v => LIVE_TOOLS.has(String(v.toolName)))) return fallback('LIVE_STATUS_AUTHORITATIVE');
    const nums = new Set<number>();
    collectNumbers(nums, i.backendReply);
    collectNumbers(nums, i.deterministicSpeech);
    collectNumbers(nums, i.userText);
    collectNumbers(nums, views.filter(v => v.ok).map(v => v.data));
    collectNumbers(nums, {
      selectedTrain: s.selectedTrain, trains: (s.searchResults as any)?.trains, availability: s.availability, fare: s.fare,
      passengersCount: s.passengersCount, ages: (s.passengers || []).map(p => p.age), date: s.date, review: (s.review as any)?.snapshot
    });
    const trains: any[] = (s.searchResults as any)?.trains || [];
    nums.add(trains.length);
    nums.add((s.passengers || []).length);
    const classes = new Set<string>([
      ...(i.backendReply.match(CLASS_RE) || []), ...(i.deterministicSpeech.match(CLASS_RE) || []), ...(i.userText.toUpperCase().match(CLASS_RE) || []),
      ...(s.selectedClass ? [s.selectedClass] : []),
      ...(((s.selectedTrain as any)?.availableClasses || []) as string[]),
      ...trains.flatMap(t => (t.classes || []).map((c: any) => String(c.code)))
    ]);
    // numbers the user said / the train selected before this turn may appear in a NEGATIVE statement only
    const userTrainNums = new Set<string>([...(i.userText.match(/\b\d{5}\b/g) || []), ...(i.selectedTrainBefore ? [String(i.selectedTrainBefore)] : [])]);
    const knownTrainNums = new Set<string>([...trains.map(t => String(t.trainNumber)), ...((s.selectedTrain as any)?.number ? [String((s.selectedTrain as any).number)] : [])]);
    const fareKnown = !!s.fare || views.some(v => v.ok && v.toolName === 'GET_FARE') || /₹/.test(i.backendReply) || (s.review as any)?.snapshot?.fare?.status === 'VERIFIED';
    // Prompt 26: no `availKnown` boolean — keyword presence (backend reply / LLM text / user words) is never availability
    // evidence; every availability sentence is judged by availability-authority against CHECK_AVAILABILITY results only
    const confirmationTurn = s.bookingState === BookingState.IRCTC_HANDOFF_READY && i.stateBefore !== BookingState.IRCTC_HANDOFF_READY;
    const reviewTurn = s.bookingState === BookingState.AWAITING_CONFIRMATION;
    const streamable = !!i.onSegment && !confirmationTurn && !reviewTurn;
    const pendingType = String(s.pendingInteraction?.type || '');
    const question = !i.pendingQuestion ? null
      : language === 'ENGLISH' && SHORT_Q_EN[pendingType] ? SHORT_Q_EN[pendingType]
      : (SHORT_Q[pendingType] || SHORT_Q[i.pendingQuestionCode || ''] || i.pendingQuestion);
    // Part 18 — voice stays concise: never longer than the text reply (short replies may take a natural lead-in)
    const maxLen = general ? (mode === 'TEXT' ? 900 : 320)
      : agentText ? (mode === 'TEXT' ? 600 : 260)
      : mode === 'TEXT' ? Math.min(600, Math.max(i.backendReply.length, 160)) : Math.min(260, Math.max(i.backendReply.length, confirmationTurn ? 140 : 90));
    const maxSentences = general ? (mode === 'TEXT' ? 7 : 4) : mode === 'TEXT' ? 5 : 3;
    // ---- Prompt 22: extra authoritative fact sets ----
    const stations = new Set<string>([s.origin, s.destination, ...trains.flatMap(t => [t.origin, t.destination]),
      (s.review as any)?.snapshot?.origin, (s.review as any)?.snapshot?.destination,
      ...stationCodesIn(i.userText), ...stationCodesIn(i.backendReply), ...stationCodesIn(i.deterministicSpeech)].filter(Boolean).map(String));
    const sel: any = s.selectedTrain;
    const knownNames: Array<{ num: string; name: string }> = [
      ...trains.map(t => ({ num: String(t.trainNumber), name: String(t.trainName || '').toLowerCase() })),
      ...(sel?.number ? [{ num: String(sel.number), name: String(sel.name || sel.trainName || '').toLowerCase() }] : []),
      ...views.filter(v => v.ok && v.data && (v.data as any).trainNumber).map(v => ({ num: String((v.data as any).trainNumber), name: String((v.data as any).trainName || (v.data as any).name || '').toLowerCase() }))
    ];
    const nameSources = `${knownNames.map(k => k.name).join(' ')} ${i.backendReply} ${i.deterministicSpeech} ${i.userText} ${s.originName || ''} ${s.destinationName || ''}`.toLowerCase();
    // counts are checked against THE count (not any number seen this turn)
    const trainCounts = new Set<number>([trains.length, ...[...`${i.backendReply} ${i.deterministicSpeech}`.matchAll(/(\d+)\s+(?:trains?|trainein)/gi)].map(m => Number(m[1]))]);
    const paxCounts = new Set<number>([s.passengersCount, (s.passengers || []).length, ...(i.userText.match(/\b\d{1,2}\b/g) || []).map(Number)].filter((n): n is number => typeof n === 'number'));
    const countOf = (w: string) => /^\d+$/.test(w) ? Number(w) : COUNT_WORD[w.toLowerCase()];
    const fareNums = new Set<number>();
    // Prompt 25 Part 5: ₹ amounts are fares only from GET_FARE (session quote / this turn) and the verified review
    collectFare(fareNums, { fare: s.fare, review: (s.review as any)?.snapshot, steps: views.filter(v => v.ok && v.toolName === 'GET_FARE').map(v => ({ fare: v.data })) });
    const idx = buildFactIndex(s, views as any);
    for (const n of idx.farePax) paxCounts.add(n);
    // Prompt 26: availability evidence = CHECK_AVAILABILITY only (this turn's validated step / the runtime-committed session entry)
    const availCtx: AvailabilityContext = { session: s, evidence: collectAvailabilityEvidence(s, (i.steps || []) as any[]), trains: idx.trains.map(f => ({ num: f.num, classes: f.classes })) };
    for (const m of `${i.backendReply} ${i.deterministicSpeech}`.matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g)) fareNums.add(Number(m[1].replace(/,/g, '')));
    // Prompt 28: every railway claim is bound to ONE entity (explicit / reply antecedent / session focus) before it counts
    const binder = new ClaimEntityBinder({ idx, session: s, resultTrains: resultTrainsOf(idx, availCtx.evidence) });
    const bindCounts: Partial<Record<ClaimBindingStatus, number>> = {};
    const crossEntity: ClaimBindingSummary['crossEntity'] = [];
    let entityClaims = 0;

    const accepted: string[] = [];
    const rejected: NaturalComposeResult['rejected'] = [];
    const actionLedger: ActionLedger = i.actionLedger ?? actionLedgerFromSteps(i.steps, { session: s });
    const actionDiag: ActionClaimDiagnostic[] = [];
    let streamed = 0;
    const len = () => accepted.join(' ').length;
    const hasQ = () => accepted.some(a => a.includes('?')) || (!!accepted.length && ASKS_RE.test(accepted[accepted.length - 1]));

    // Prompt 25: per-sentence evidence → claim type / provenance; `text` may carry a meaning-preserving repair
    type Hits = { time?: TimeVerdict; fare?: FareFact; classList?: boolean; pax?: PaxClass; avail?: AvailabilityEvidence; userAvail?: boolean; count?: boolean; text?: string };
    const judge = (sentence: string, hits: Hits = {}): string | null => {
      let t = sentence.trim();
      if (!t) return 'EMPTY';
      if (containsChainOfThought(t)) return 'CHAIN_OF_THOUGHT';
      // Prompt 28: internal result references / ids never reach the user
      if (RESULT_REF_RE.test(t) || /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(t)) return 'INTERNAL_ID';
      if (soundsRobotic(t)) return 'ROBOTIC_PHRASING';
      // Prompt 25 Part 1: a general explanation (no train / class / date / fare / session anchor) is general knowledge in
      // ANY turn — judged for what it can falsely claim, never for merely containing a number
      const gk = general || isGeneralKnowledgeClaim(t, idx);
      // Prompt 26: ONE availability rule (availability-authority). CLASS_LIST ≠ SEAT_AVAILABILITY: "CC aur 2S available"
      // without an availability result is the provider's class list → kept with unambiguous wording. RAC / WL explanations
      // are general knowledge. A live seat claim must match a CHECK_AVAILABILITY result (train + date + class + status).
      {
        const av = judgeAvailabilityClaim(t, availCtx);
        if (av.outcome === 'CLASS_LIST' && (!gk || /\b\d{5}\b/.test(t))) { t = repairClassList(t); hits.classList = true; hits.text = t; }
        if (av.reason) return av.reason;
        if (av.outcome === 'VERIFIED_AVAILABILITY') hits.avail = av.evidence;
        if (av.outcome === 'USER_PROVIDED_FACT') hits.userAvail = true;
      }
      // class codes ("3A", "2S") are checked as classes, not as free numbers
      if (gk) {
        // general explanation: specific identifiers are still never invented
        for (const m of t.match(/\b\d{5}\b/g) || []) if (!knownTrainNums.has(m) && !userTrainNums.has(m)) return `UNGROUNDED_TRAIN_NUMBER:${m}`;
        if (/\b\d{10}\b/.test(t)) return 'UNGROUNDED_NUMBER:PNR_LIKE';
        // Prompt 25 Part 3: a time is checked as a structured claim (train ↔ departure / arrival), not banned outright
        const tv = judgeTimes(t, idx, false);
        if (tv.reason) return tv.reason.startsWith('TIME_MISMATCH') && general ? 'UNGROUNDED_TIME' : tv.reason;
        hits.time = tv;
      } else {
        for (const m of t.replace(CLASS_RE, ' ').match(/\d+(?:\.\d+)?/g) || []) if (!nums.has(Number(m))) return `UNGROUNDED_NUMBER:${m}`;
        for (const c of t.match(CLASS_RE) || []) if (!classes.has(c)) return `UNGROUNDED_CLASS:${c}`;
      }
      if (/₹|\brs\.?\s*\d|\brupay/i.test(t) && !fareKnown) return 'UNGROUNDED_FARE';
      if (SUCCESS_RE.test(t) && !NEGATION_RE.test(t)) return 'BOOKING_SUCCESS_CLAIM';
      // ---- Prompt 22 grounding ----
      for (const m of t.matchAll(/(?:₹|\brs\.?\s?|\binr\s?)\s?([\d,]+(?:\.\d+)?)/gi)) { const n = Number(m[1].replace(/,/g, '')); if (!fareNums.has(n)) return `UNGROUNDED_FARE_AMOUNT:${n}`; }
      if (!gk) for (const c of stationCodesIn(t)) if (!stations.has(c)) return `UNGROUNDED_STATION:${c}`;
      if (!gk) for (const m of t.matchAll(CITY_RE)) if (!nameSources.includes(m[1].toLowerCase())) return `UNGROUNDED_STATION:${m[1]}`;
      const saidNums = (t.match(/\b\d{5}\b/g) || []).filter(n => knownTrainNums.has(n) || knownNames.some(k => k.num === n));
      if (!gk || saidNums.length === 1) for (const m of t.matchAll(TRAIN_NAME_RE)) {
        const kw = m[1].toLowerCase();
        if (saidNums.length === 1) { const nm = knownNames.find(k => k.num === saidNums[0])?.name || ''; if (!nm.includes(kw)) return `UNGROUNDED_TRAIN_NAME:${m[1]}`; }
        else if (!knownNames.some(k => k.name.includes(kw)) && !`${i.backendReply} ${i.deterministicSpeech}`.toLowerCase().includes(kw)) return `UNGROUNDED_TRAIN_NAME:${m[1]}`;
      }
      if (!gk && !NEGATION_RE.test(t)) for (const m of t.matchAll(DAY_RE)) { const r: any = resolveDate(m[1].toLowerCase()); if (!r?.ok || r.date !== s.date) return `UNGROUNDED_DATE:${m[1]}`; }
      // Prompt 28: an explicit calendar date in a railway statement must be the journey date the results are for
      if (!gk && s.date && !NEGATION_RE.test(t)) for (const d of explicitDates(t)) if (d !== s.date) return `CROSS_DATE_FACT:${d}`;
      // Prompt 25 Part 6: a count derived from the returned set (all / "subah ki" / "CC wali") is preserved
      for (const m of t.matchAll(TRAIN_COUNT_RE)) {
        const n = countOf(m[1]);
        if (!trainCounts.has(n) && !derivedTrainCounts(t, idx).includes(n)) return `UNGROUNDED_COUNT:${m[1]} ${m[2]}`;
        hits.count = true;
      }
      // Prompt 25 Part 2: passenger counts by context — user-provided and general explanations are not session claims
      for (const m of t.matchAll(PAX_COUNT_RE)) {
        const n = countOf(m[1]);
        const kind = classifyPaxCount(t, n, m[1], i.userText);
        hits.pax = kind;
        if (kind === 'USER_PROVIDED' || kind === 'GENERAL_KNOWLEDGE') continue;
        if (kind === 'SESSION_FACT' && general && !isSessionish(t)) { hits.pax = 'GENERAL_KNOWLEDGE'; continue; }
        if (!paxCounts.has(n)) return `UNGROUNDED_COUNT:${m[1]} ${m[2]}`;
      }
      // ---- Prompt 25: structured railway claims (train ↔ time / comparison / class list / GET_FARE scope) ----
      if (!gk) { const tv = judgeTimes(t, idx, true); if (tv.reason) return tv.reason; hits.time = tv; }
      { const c = judgeComparison(t, idx); if (c) return c; }
      if (hits.classList) { const c = judgeClassList(t, idx); if (c) return c; }
      { const f = judgeFareScope(t, idx); if (f.reason) return f.reason; if (f.fact) hits.fare = f.fact; }
      // a train number the USER said, inside a negative statement ("14542 is list mein nahi hai"), is not a fact claim
      let probe = NEGATION_RE.test(t) ? t.replace(/\b\d{5}\b/g, m => userTrainNums.has(m) && !knownTrainNums.has(m) ? 'woh train' : m) : t;
      // times already judged as general knowledge (e.g. when Tatkal opens) are not timetable claims
      for (const g of hits.time?.general || []) probe = probe.split(g).join('—');
      const g = railwayResponseGrounding.validate(probe, { session: s, steps: i.steps, records: (i.records || []) as any });
      if (g.rejected.length) return `GROUNDING:${g.rejected[0]}`;
      return null;
    };
    const provenance: ClaimProvenance[] = [];
    const claimProvenance: ClaimProvenance[] = [];
    let repaired = 0;
    let prevRejected = false;
    const take = (sentence: string) => {
      let t = sentence.trim();
      if (!t) return;
      // Prompt 25 Part 11: no orphan numbering / bullets / punctuation; a sentence that only continued a removed one
      // ("Aur …") loses the dangling conjunction instead of reading as a fragment
      if (isFragment(t)) { if (t.length > 1 || /\d/.test(t)) rejected.push({ sentence: t.slice(0, 120), reason: 'FRAGMENT' }); return; }
      if (prevRejected && LEAD_CONJ.test(t)) { const r = t.replace(LEAD_CONJ, ''); if (/[A-Za-zऀ-ॿ]{2,}/.test(r)) t = r.charAt(0).toUpperCase() + r.slice(1); }
      // Prompt 29: a false action / progress clause ("availability bhi check kar raha hoon" when no such call ran this
      // turn) is removed; the rest of the sentence is judged by the fact guards as usual
      {
        const ag = guardActionSentence(t, actionLedger);
        actionDiag.push(...ag.diagnostics);
        if (ag.removed.length) {
          rejected.push({ sentence: (ag.text ? ag.removed[0].clause : t).slice(0, 120), reason: `ACTION_CLAIM:${ag.removed[0].verdict.removalReason}` });
          if (!ag.text) { prevRejected = true; return; }
          t = ag.text;
        }
      }
      const hits: Hits = {};
      // Prompt 28: bind BEFORE judging (the binder tracks the reply's antecedents from every sentence the LLM wrote)
      const binding: ClaimBinding = binder.bind(t);
      bindCounts[binding.status] = (bindCounts[binding.status] || 0) + 1;
      if (binding.status !== 'NOT_APPLICABLE' && isEntityClaim(t)) entityClaims++;
      let why = judge(t, hits);
      if (why && binding.status === 'EXPLICIT' && /^(FARE_MISMATCH|UNVERIFIED_AVAILABILITY|AVAILABILITY_MISMATCH|CLASS_NOT_LISTED|TIME_MISMATCH)/.test(why)) {
        const d = diagnoseCrossEntity(t, binding, idx, availCtx.evidence, s.date);
        if (d) crossEntity.push({ reason: why, diagnosis: d, binding: binding.status, trainNumber: binding.trainNumbers[0] });
      }
      if (!why) {
        // …the sentence passed on its own; now its BOUND form must verify (same judges, the right train / class / date)
        const bv = verifyBoundClaim(t, binding, idx, availCtx, { general });
        if (bv.reason) {
          why = bv.reason;
          crossEntity.push({ reason: bv.reason, diagnosis: bv.reason === 'AMBIGUOUS_REFERENCE' ? 'AMBIGUOUS_REFERENCE' : (bv.diagnosis || 'CROSS_TRAIN_FACT'), binding: binding.status, trainNumber: binding.trainNumbers[0] });
        }
      } else if (/^CROSS_DATE_FACT/.test(why)) crossEntity.push({ reason: why, diagnosis: 'CROSS_DATE_FACT', binding: binding.status, trainNumber: binding.trainNumbers[0] });
      if (why) { rejected.push({ sentence: t.slice(0, 120), reason: why }); prevRejected = true; return; }
      prevRejected = false;
      if (hits.text && hits.text !== t) { t = hits.text; repaired++; }
      // Prompt 23: an agent-authored reply keeps one sentence free for the pending question the backend appends
      const cap = agentText && question && !hasQ() && !t.includes('?') ? maxSentences - 1 : maxSentences;
      if (accepted.length >= cap) { rejected.push({ sentence: t.slice(0, 120), reason: 'TOO_LONG' }); return; }
      const reserve = question && !hasQ() && !t.includes('?') ? question.length + 1 : 0;
      if ((len() ? len() + 1 : 0) + t.length + reserve > maxLen) { rejected.push({ sentence: t.slice(0, 120), reason: 'TOO_LONG' }); return; }
      accepted.push(t);
      {
        const p = classifyClaim(t, idx, hits, general);
        provenance.push(p);
        const train = p.trainNumber ?? hits.fare?.train ?? (binding.trainNumbers.length === 1 ? binding.trainNumbers[0] : undefined);
        claimProvenance.push({ ...p, claimId: `c${claimProvenance.length + 1}`,
          entityType: train ? 'TRAIN' : p.claimType === 'SESSION_FACT' ? 'BOOKING' : 'NONE',
          ...(train && !p.trainNumber ? { trainNumber: train } : {}),
          ...(hits.fare?.cls && !p.travelClass ? { travelClass: hits.fare.cls } : {}),
          ...(hits.fare?.date && !p.date ? { date: hits.fare.date } : {}),
          ...(hits.fare?.provider ? { sourceProvider: hits.fare.provider } : {}),
          verificationStatus: p.claimType === 'USER_PROVIDED' ? 'USER_PROVIDED' : (p.claimType === 'RAILWAY_LIVE_FACT' || p.claimType === 'TOOL_DERIVED_FACT') ? 'VERIFIED' : 'NOT_REQUIRED',
          claimBindingStatus: binding.status });
      }
      if (streamable) { i.onSegment!(streamed, t); streamed++; }
    };

    // ---- generate (streaming deltas → complete sentences judged as they arrive) ----
    let buf = '';
    const flushComplete = () => {
      const m = buf.match(/^([\s\S]*?[.!?।])(\s+)([\s\S]*)$/);
      if (!m) return;
      take(m[1]);
      buf = m[3];
      flushComplete();
    };
    let out: { text: string } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (agentText) {
      // Prompt 23: the agent already wrote its answer from this turn's results — judge it, no second LLM call
      out = { text: agentText };
    } else try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const call = i.llm.generateSpokenResponse!({
        userText: i.userText, inputMode: mode, language, session: s, stateBefore: i.stateBefore,
        reviewVersionBefore: i.reviewVersionBefore, selectedTrainBefore: i.selectedTrainBefore, selectedClassBefore: i.selectedClassBefore,
        passengersCountBefore: i.passengersCountBefore, pendingQuestion: question, pendingQuestionCode: i.pendingQuestionCode,
        backendReply: i.backendReply, toolResults: views, appliedActions: i.appliedActions, changes: i.changes, error: i.error,
        history: i.history.slice(-8), signal: ctrl?.signal,
        onDelta: (d: string) => { buf += String(d || ''); flushComplete(); }
      });
      out = await Promise.race([
        call,
        new Promise<null>((_, rej) => { timer = setTimeout(() => { ctrl?.abort(); rej(new Error('LLM_SPOKEN_TIMEOUT')); }, i.timeoutMs ?? 4000); })
      ]);
    } catch (e: any) {
      if (!accepted.length) return fallback(e?.message === 'LLM_SPOKEN_TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_ERROR', rejected);
    } finally { if (timer) clearTimeout(timer); }

    // non-streaming providers (or the tail of a stream)
    if (out?.text && !accepted.length && !rejected.length && !buf) for (const sn of toSentences(out.text)) take(sn);
    else if (buf.trim()) { take(buf); buf = ''; }
    const bindingSummary = (): ClaimBindingSummary => ({ counts: bindCounts, crossEntity,
      status: crossEntity.some(c => c.diagnosis !== 'AMBIGUOUS_REFERENCE') ? 'CROSS_ENTITY_REMOVED' : crossEntity.length ? 'AMBIGUOUS_REMOVED' : entityClaims ? 'BOUND' : 'NONE' });
    if (!accepted.length) return { ...fallback(out ? 'NOTHING_GROUNDED' : 'NO_RESPONSE', rejected), claimBinding: bindingSummary(), actionClaims: actionDiag };

    // ---- guarantees ----
    if (confirmationTurn && !NOT_BOOKED_RE.test(accepted.join(' '))) return fallback('MISSING_NOT_BOOKED_DISCLAIMER', rejected);
    if (question && !hasQ()) {
      accepted.push(question);
      if (streamable) { i.onSegment!(streamed, question); streamed++; }
    }
    const segments = [...accepted];
    if (!streamable) segments.forEach((t, k) => i.onSegment?.(k, t));
    return { text: accepted.join(' '), segments, source: 'LLM', language, rejected, streamed: streamable ? streamed : segments.length, authoredBy: agentText ? 'AGENT' : 'WORDING', ...(general ? { general: true } : {}),
      provenance, claimProvenance, repaired, wordingCall: !agentText,
      claimBinding: bindingSummary(), actionClaims: actionDiag };
  }
}

export const naturalResponseComposer = new NaturalResponseComposer();
