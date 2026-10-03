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
  /**
   * Prompt 23: general railway-knowledge turn (no tool, no session change, no error). Judged for what it can falsely
   * claim (unknown train numbers, PNR-like numbers, fares, availability, counts, booking success, grounding) — not for
   * mentioning cities, train types, days or small numbers that are part of a general explanation.
   */
  general?: boolean;
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
}

const SAFETY = new Set(['FORBIDDEN_ACTION', 'SENSITIVE_REQUEST_REJECTED', 'SENSITIVE_DATA_REJECTED', 'BOOKING_ACCESS_DENIED', 'INVALID_LLM_OUTPUT', 'SESSION_VERSION_CONFLICT']);
const CLASS_RE = /\b(1A|2A|3A|3E|CC|EC|SL|2S|FC)\b/g;
const AVAIL_RE = /\b(available|availability hai|waiting|WL|RAC|seats?|khaali|bhari|full)\b/i;
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
const POS_AVAIL_RE = /\b(seats? (available|khaali|mil (jaayegi|jayegi|jaegi))|available (hain|hai|h)\b|confirm(ed)? seats?|pakki seats?|seats? (confirm|pakki))/i;
const normStatus = (x: string) => String(x || '').toUpperCase().replace(/WAIT\s*LIST(ED)?|WAITING(\s+LIST)?|GNWL|PQWL|RLWL|RSWL/g, 'WL').replace(/\s+/g, ' ').trim();
const lcPad = (x: string) => ` ${String(x || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
function stationCodesIn(text: string): Set<string> {
  const t = lcPad(text); const out = new Set<string>();
  for (const [k, v] of Object.entries(STATION_ALIASES)) if (t.includes(` ${k} `)) out.add(v.code);
  for (const [k, c] of Object.entries(AMBIGUOUS_STATION_NAMES)) if (t.includes(` ${k} `)) for (const x of c) out.add(x.code);
  return out;
}
/** Numbers under fare-bearing keys only (a ₹ amount must be a fare / total the provider or the review returned). */
function collectFare(into: Set<number>, v: any, key = '', inFare = false, depth = 0) {
  if (v === null || v === undefined || depth > 7) return;
  const f = inFare || /fare|total|amount|perpassenger|price/i.test(key);
  if (typeof v === 'number') { if (f && Number.isFinite(v)) into.add(Math.abs(v)); return; }
  if (typeof v === 'string') { if (f) for (const m of v.match(/\d+(?:\.\d+)?/g) || []) into.add(Number(m)); return; }
  if (Array.isArray(v)) { for (const x of v.slice(0, 40)) collectFare(into, x, key, f, depth + 1); return; }
  if (typeof v === 'object') for (const [k, x] of Object.entries(v)) collectFare(into, x, k, f, depth + 1);
}
const SHORT_Q: Record<string, string> = {
  TRAIN_SELECTION_REQUIRED: 'Kaunsi train chahiye?', CLASS_SELECTION_REQUIRED: 'Kaunsi class chahiye?',
  REVIEW_APPROVAL_REQUIRED: 'Confirm karna hai?', CONFIRMATION_REQUIRED: 'Confirm karna hai?'
};

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
    toolName: st.toolCall?.name, callId: st.toolCall?.callId, ok: !!st.result?.success, data: st.result?.data,
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
    const availKnown = !!(s.availability && Object.keys(s.availability).length) || views.some(v => v.ok && v.toolName === 'CHECK_AVAILABILITY') || AVAIL_RE.test(i.backendReply);
    const confirmationTurn = s.bookingState === BookingState.IRCTC_HANDOFF_READY && i.stateBefore !== BookingState.IRCTC_HANDOFF_READY;
    const reviewTurn = s.bookingState === BookingState.AWAITING_CONFIRMATION;
    const streamable = !!i.onSegment && !confirmationTurn && !reviewTurn;
    const question = i.pendingQuestion ? (SHORT_Q[String(s.pendingInteraction?.type || '')] || SHORT_Q[i.pendingQuestionCode || ''] || i.pendingQuestion) : null;
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
    const statuses: Array<{ cls: string; status: string }> = [
      ...Object.entries((s.availability || {}) as Record<string, any>).map(([c, v]) => ({ cls: c, status: String(v?.status ?? v ?? '') })),
      ...views.filter(v => v.ok && v.toolName === 'CHECK_AVAILABILITY' && v.data).map(v => ({ cls: String((v.data as any).travelClass || ''), status: String((v.data as any).status || '') }))
    ];
    // counts are checked against THE count (not any number seen this turn)
    const trainCounts = new Set<number>([trains.length, ...[...`${i.backendReply} ${i.deterministicSpeech}`.matchAll(/(\d+)\s+(?:trains?|trainein)/gi)].map(m => Number(m[1]))]);
    const paxCounts = new Set<number>([s.passengersCount, (s.passengers || []).length, ...(i.userText.match(/\b\d{1,2}\b/g) || []).map(Number)].filter((n): n is number => typeof n === 'number'));
    const countOf = (w: string) => /^\d+$/.test(w) ? Number(w) : COUNT_WORD[w.toLowerCase()];
    const fareNums = new Set<number>();
    collectFare(fareNums, { fare: s.fare, review: (s.review as any)?.snapshot, trains, steps: views.filter(v => v.ok).map(v => v.toolName === 'GET_FARE' ? { fare: v.data } : { data: v.data }) });
    for (const m of `${i.backendReply} ${i.deterministicSpeech}`.matchAll(/₹\s?([\d,]+(?:\.\d+)?)/g)) fareNums.add(Number(m[1].replace(/,/g, '')));

    const accepted: string[] = [];
    const rejected: NaturalComposeResult['rejected'] = [];
    let streamed = 0;
    const len = () => accepted.join(' ').length;
    const hasQ = () => accepted.some(a => a.includes('?'));

    const judge = (sentence: string): string | null => {
      const t = sentence.trim();
      if (!t) return 'EMPTY';
      if (containsChainOfThought(t)) return 'CHAIN_OF_THOUGHT';
      if (soundsRobotic(t)) return 'ROBOTIC_PHRASING';
      // class codes ("3A", "2S") are checked as classes, not as free numbers
      if (general) {
        // general explanation: specific identifiers are still never invented
        for (const m of t.match(/\b\d{5}\b/g) || []) if (!knownTrainNums.has(m) && !userTrainNums.has(m)) return `UNGROUNDED_TRAIN_NUMBER:${m}`;
        if (/\b\d{10}\b/.test(t)) return 'UNGROUNDED_NUMBER:PNR_LIKE';
        if (/\b\d{1,2}[:.]\d{2}\b/.test(t)) return 'UNGROUNDED_TIME';
      } else {
        for (const m of t.replace(CLASS_RE, ' ').match(/\d+(?:\.\d+)?/g) || []) if (!nums.has(Number(m))) return `UNGROUNDED_NUMBER:${m}`;
        for (const c of t.match(CLASS_RE) || []) if (!classes.has(c)) return `UNGROUNDED_CLASS:${c}`;
      }
      if (/₹|\brs\.?\s*\d|\brupay/i.test(t) && !fareKnown) return 'UNGROUNDED_FARE';
      // general: explaining WL / RAC / seats is fine; a concrete availability claim (train / day / "available hai") is not
      if (general ? (!availKnown && (POS_AVAIL_RE.test(t) || (AVAIL_RE.test(t) && /\b\d{5}\b|\b(aaj|today|kal|tomorrow|parso)\b/i.test(t))))
        : (AVAIL_RE.test(t) && !/availability (check|dekh|verify)/i.test(t) && !availKnown)) return 'UNGROUNDED_AVAILABILITY';
      if (SUCCESS_RE.test(t) && !NEGATION_RE.test(t)) return 'BOOKING_SUCCESS_CLAIM';
      // ---- Prompt 22 grounding ----
      for (const m of t.matchAll(/(?:₹|\brs\.?\s?|\binr\s?)\s?([\d,]+(?:\.\d+)?)/gi)) { const n = Number(m[1].replace(/,/g, '')); if (!fareNums.has(n)) return `UNGROUNDED_FARE_AMOUNT:${n}`; }
      if (!general) for (const c of stationCodesIn(t)) if (!stations.has(c)) return `UNGROUNDED_STATION:${c}`;
      if (!general) for (const m of t.matchAll(CITY_RE)) if (!nameSources.includes(m[1].toLowerCase())) return `UNGROUNDED_STATION:${m[1]}`;
      const saidNums = (t.match(/\b\d{5}\b/g) || []).filter(n => knownTrainNums.has(n) || knownNames.some(k => k.num === n));
      if (!general || saidNums.length === 1) for (const m of t.matchAll(TRAIN_NAME_RE)) {
        const kw = m[1].toLowerCase();
        if (saidNums.length === 1) { const nm = knownNames.find(k => k.num === saidNums[0])?.name || ''; if (!nm.includes(kw)) return `UNGROUNDED_TRAIN_NAME:${m[1]}`; }
        else if (!knownNames.some(k => k.name.includes(kw)) && !`${i.backendReply} ${i.deterministicSpeech}`.toLowerCase().includes(kw)) return `UNGROUNDED_TRAIN_NAME:${m[1]}`;
      }
      if (!general && !NEGATION_RE.test(t)) for (const m of t.matchAll(DAY_RE)) { const r: any = resolveDate(m[1].toLowerCase()); if (!r?.ok || r.date !== s.date) return `UNGROUNDED_DATE:${m[1]}`; }
      for (const m of t.matchAll(TRAIN_COUNT_RE)) if (!trainCounts.has(countOf(m[1]))) return `UNGROUNDED_COUNT:${m[1]} ${m[2]}`;
      for (const m of t.matchAll(PAX_COUNT_RE)) if (!paxCounts.has(countOf(m[1]))) return `UNGROUNDED_COUNT:${m[1]} ${m[2]}`;
      {
        const mentioned: string[] = [...(t.match(CLASS_RE) || [])];
        const rel = statuses.filter(x => !mentioned.length || mentioned.includes(x.cls));
        if (POS_AVAIL_RE.test(t) && !NEGATION_RE.test(t) && rel.length && !rel.some(x => /^(AVAIL|AVBL|CURR_AVBL)/i.test(x.status))) return 'AVAILABILITY_MISMATCH';
        for (const m of t.matchAll(/\b(WL|waitlist|waiting(?:\s+list)?)\s*(\d+)/gi)) if (!rel.some(x => normStatus(x.status) === `WL ${m[2]}`)) return `AVAILABILITY_MISMATCH:WL ${m[2]}`;
        for (const m of t.matchAll(/\bRAC\s*(\d+)/gi)) if (!rel.some(x => normStatus(x.status) === `RAC ${m[1]}`)) return `AVAILABILITY_MISMATCH:RAC ${m[1]}`;
      }
      // a train number the USER said, inside a negative statement ("14542 is list mein nahi hai"), is not a fact claim
      const probe = NEGATION_RE.test(t) ? t.replace(/\b\d{5}\b/g, m => userTrainNums.has(m) && !knownTrainNums.has(m) ? 'woh train' : m) : t;
      const g = railwayResponseGrounding.validate(probe, { session: s, steps: i.steps, records: (i.records || []) as any });
      if (g.rejected.length) return `GROUNDING:${g.rejected[0]}`;
      return null;
    };
    const take = (sentence: string) => {
      const t = sentence.trim();
      if (!t) return;
      const why = judge(t);
      if (why) { rejected.push({ sentence: t.slice(0, 120), reason: why }); return; }
      // Prompt 23: an agent-authored reply keeps one sentence free for the pending question the backend appends
      const cap = agentText && question && !hasQ() && !t.includes('?') ? maxSentences - 1 : maxSentences;
      if (accepted.length >= cap) { rejected.push({ sentence: t.slice(0, 120), reason: 'TOO_LONG' }); return; }
      const reserve = question && !hasQ() && !t.includes('?') ? question.length + 1 : 0;
      if ((len() ? len() + 1 : 0) + t.length + reserve > maxLen) { rejected.push({ sentence: t.slice(0, 120), reason: 'TOO_LONG' }); return; }
      accepted.push(t);
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
    if (out?.text && !accepted.length && !rejected.length && !buf) for (const sn of splitSentences(out.text)) take(sn);
    else if (buf.trim()) { take(buf); buf = ''; }
    if (!accepted.length) return fallback(out ? 'NOTHING_GROUNDED' : 'NO_RESPONSE', rejected);

    // ---- guarantees ----
    if (confirmationTurn && !NOT_BOOKED_RE.test(accepted.join(' '))) return fallback('MISSING_NOT_BOOKED_DISCLAIMER', rejected);
    if (question && !hasQ()) {
      accepted.push(question);
      if (streamable) { i.onSegment!(streamed, question); streamed++; }
    }
    const segments = [...accepted];
    if (!streamable) segments.forEach((t, k) => i.onSegment?.(k, t));
    return { text: accepted.join(' '), segments, source: 'LLM', language, rejected, streamed: streamable ? streamed : segments.length, authoredBy: agentText ? 'AGENT' : 'WORDING', ...(general ? { general: true } : {}) };
  }
}

export const naturalResponseComposer = new NaturalResponseComposer();
