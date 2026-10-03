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
 * The deterministic responseMessage (TEXT) is never changed: only VOICE speechText uses this wording.
 */
import type { LLMProvider, TurnToolResultView } from '../providers/llm-provider';
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';
import { containsChainOfThought, soundsRobotic, segmentForSpeech, splitSentences } from '@shared/voice/voice-response-policy';
import { detectLanguageStyle, type LanguageStyle } from '@shared/voice/language-style';
import { railwayResponseGrounding } from '../tool-runtime/railway-response-grounding';

export interface NaturalComposeInput {
  llm: LLMProvider;
  session: BookingSession;
  userText: string;
  /** Backend TEXT reply (authoritative wording of this turn's facts). */
  backendReply: string;
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
}

export interface NaturalComposeResult {
  text: string;
  segments: string[];
  source: 'LLM' | 'FALLBACK';
  language: LanguageStyle;
  rejected: Array<{ sentence: string; reason: string }>;
  fallbackReason?: string;
  streamed: number;
}

const SAFETY = new Set(['SENSITIVE_REQUEST_REJECTED', 'SENSITIVE_DATA_REJECTED', 'BOOKING_ACCESS_DENIED', 'INVALID_LLM_OUTPUT', 'SESSION_VERSION_CONFLICT']);
const CLASS_RE = /\b(1A|2A|3A|3E|CC|EC|SL|2S|FC)\b/g;
const AVAIL_RE = /\b(available|availability hai|waiting|WL|RAC|seats?|khaali|bhari|full)\b/i;
const SUCCESS_RE = /\b(book ho (gaya|gayi|gyi|chuka|chuki)|booked|booking (ho gayi|confirm(ed)?|successful|safal)|ticket (confirm|ban|book) (ho )?(gaya|gayi|chuka)|payment (ho gaya|done|successful)|pnr (number )?(hai|is|mil))/i;
const NEGATION_RE = /\b(nahi|nahin|na|not|no|never|abhi tak nahi)\b/i;
const NOT_BOOKED_RE = /(book nahi|booked nahi|nahi hua|not (been )?booked|no ticket|ticket book nahi)/i;
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
    if (typeof i.llm.generateSpokenResponse !== 'function') return fallback('PROVIDER_NO_SPOKEN_RESPONSE');

    // ---- the authoritative fact base for grounding ----
    const views = toolViews(i.steps);
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
    const maxLen = Math.min(260, Math.max(i.backendReply.length, confirmationTurn ? 140 : 90));

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
      for (const m of t.replace(CLASS_RE, ' ').match(/\d+(?:\.\d+)?/g) || []) if (!nums.has(Number(m))) return `UNGROUNDED_NUMBER:${m}`;
      for (const c of t.match(CLASS_RE) || []) if (!classes.has(c)) return `UNGROUNDED_CLASS:${c}`;
      if (/₹|\brs\.?\s*\d|\brupay/i.test(t) && !fareKnown) return 'UNGROUNDED_FARE';
      if (AVAIL_RE.test(t) && !/availability (check|dekh|verify)/i.test(t) && !availKnown) return 'UNGROUNDED_AVAILABILITY';
      if (SUCCESS_RE.test(t) && !NEGATION_RE.test(t)) return 'BOOKING_SUCCESS_CLAIM';
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
      if (accepted.length >= 3) { rejected.push({ sentence: t.slice(0, 120), reason: 'TOO_LONG' }); return; }
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
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
      const call = i.llm.generateSpokenResponse({
        userText: i.userText, inputMode: 'VOICE', language, session: s, stateBefore: i.stateBefore,
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
    return { text: accepted.join(' '), segments, source: 'LLM', language, rejected, streamed: streamable ? streamed : segments.length };
  }
}

export const naturalResponseComposer = new NaturalResponseComposer();
