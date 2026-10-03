import { classifyLifecycleIntent } from '../../booking/lifecycle-actions/lifecycle-action-intent';
import type { LLMProvider, LLMTurnInput, LLMTurnResult, TurnToolResultView } from './llm-provider';
import type { AgentDecision, TrainReference, InfoRequest, ResultRefinement, ExtractedEntities, PassengerRef, PassengerUpdateRaw } from '../decisions/agent-decision';
import type { ToolCall, RegisteredToolName } from '../tools/tool-registry';
import { BookingState } from '@shared/states';
import type { BookingSession } from '@shared/entities';
import { v4 as uuid } from '../orchestrator/utils';
import { isPureAffirmation, isPureNegation } from '../context/pending-interaction';
import { canonicalClassToken, AC_CLASSES } from '../context/class-reference-resolver';
import { factFromTool, TOOL_LABEL } from '../context/response-formatter';
import { extractPnrCandidate } from '../../booking/post-booking/pnr-validator';

/**
 * Deterministic MockLLMProvider (Prompt 8) — behaves like a tool-calling LLM:
 *
 *   - It INTERPRETS language in the light of the structured context it is given
 *     (session view, pendingInteraction, versioned search results).
 *   - It PROPOSES entities, natural references (displayIndex / "ye wali" /
 *     "morning wali" …) and tool calls.
 *   - It NEVER resolves references to trains/classes, never computes dates,
 *     never mutates the session and never states railway facts that are not
 *     in a tool result of the current turn.
 *
 * Multi-step: after tool results arrive in the same turn it decides whether a
 * further tool is required (e.g. CHECK_AVAILABILITY → GET_FARE), otherwise it
 * produces a final message built only from those results.
 *
 * No randomness, no network.
 */

type NLU = {
  originRaw?: string; destinationRaw?: string; stationOnlyRaw?: string;
  dateRaw?: string; passengersCountRaw?: string; passengersDelta?: number;
  preferredClassRaw?: string; preferredTimeRaw?: string;
  trainRef?: TrainReference; classRaw?: string;
  infoRequests: InfoRequest[]; infoTrainNumber?: string;
  refinement?: ResultRefinement; compare?: string[];
  affirm: boolean; negate: boolean;
  changeRequested?: ExtractedEntities['changeRequested'];
  pax?: PaxOps;
  executionRequested?: boolean;
  wantsReview?: boolean;
  wantsBooking: boolean;
};

type PaxOps = { updates?: PassengerUpdateRaw[]; remove?: PassengerRef; fieldChange?: { ref?: PassengerRef; field: string } };

/** States where free-form replies are interpreted as passenger details. */
const PAX_STATES = new Set<string>([BookingState.BOOKING_PREPARE, BookingState.COLLECTING_PASSENGER_DETAILS, BookingState.PASSENGERS_READY, BookingState.REVIEW, BookingState.AWAITING_CONFIRMATION]);
const ORDINAL_IDX: Record<string, number> = {
  first: 1, pehla: 1, pehle: 1, pehli: 1, '1st': 1,
  second: 2, doosra: 2, doosre: 2, doosri: 2, dusra: 2, dusre: 2, dusri: 2, '2nd': 2,
  third: 3, teesra: 3, teesre: 3, teesri: 3, tisra: 3, '3rd': 3,
  fourth: 4, chautha: 4, chauthe: 4, '4th': 4, fifth: 5, paanchva: 5, sixth: 6
};
const ORD_WORDS = Object.keys(ORDINAL_IDX).join('|');
const GENDER_RE = /\b(male|female|other|purush|mahila|aadmi|aurat|ladka|ladki|पुरुष|महिला)\b/i;
const FIELD_KW_RE = /\b(naam|name|age|umar|umra|gender)\b/i;
const REMOVE_RE = /(nahi aa rah[ai]|nahi aa raha|nahi ja rah[ai]|nahi jaa rah[ai]|nahi jayeg[ai]|nahi aayeg[ai]|hata do|hatao|hata den|hata dijiye|remove|delete|nikal do)/i;
const FIELD_CHANGE_RE = /\b(change|badal|badlo|badalna|badalni|update|edit|galat)\b/i;
const PAX_FILLER = new Set(['hai', 'hain', 'he', 'h', 'ka', 'ki', 'ke', 'ko', 'naam', 'name', 'age', 'umar', 'umra', 'gender', 'saal', 'sal', 'years', 'year', 'yrs', 'yr', 'passenger', 'passengers', 'yatri', 'actually', 'sorry', 'galat', 'nahi', 'aur', 'and', 'is', 'ji', 'mera', 'meri', 'uska', 'uski', 'uske', 'unka', 'unki', 'unke', 'iska', 'iski', 'bhi', 'toh', 'to', 'wala', 'wali', 'kar', 'do', 'karo', 'kardo', 'please', 'plz', 'the', 'hi', 'kya', 'kaun', 'kab', 'kitna', 'hua', 'batao', 'help', 'ok', 'rakho', 'rakh', 'hoga', 'tha', 'thi', 'no', 'number', 'details', 'detail', 'baaki', 'sab', 'change', 'badal', 'badlo', 'update', 'edit', 'karna', 'karni', 'naya', 'nayi']);
const NAME_CMD_WORDS = new Set(['hai', 'hain', 'he', 'h', 'kar', 'do', 'karo', 'kardo', 'karna', 'karni', 'rakho', 'rakh', 'hoga', 'tha', 'thi', 'change', 'badal', 'badlo', 'badalna', 'badalni', 'update', 'edit', 'galat', 'chahiye', 'please', 'plz', 'ji', 'hua', 'naya', 'nayi']);
/** Strip leading/trailing command words; returns undefined if nothing name-like remains. */
function cleanNameValue(v: string): string | undefined {
  const w = v.trim().split(/\s+/);
  while (w.length && NAME_CMD_WORDS.has(w[w.length - 1].toLowerCase())) w.pop();
  while (w.length && NAME_CMD_WORDS.has(w[0].toLowerCase())) w.shift();
  const out = w.join(' ').trim();
  return out.length >= 2 ? out : undefined;
}
const EXEC_RE = /\b(payment|pay kar|pay karo|pay kardo|paise bhej|paise de do|submit kar|submit karo|submit kardo|irctc (pe |par )?login|login kar|login karo)\b/i;

const STATION_RE = /\b(new delhi|amritsar|ludhiana|delhi|chandigarh|jalandhar|ambala cantt|ambala city|ambala|asr|ldh|ndls|cdg|juc|umb|ubc)\b/g;
const STATION_CODE: Record<string, string> = {
  'new delhi': 'NDLS', delhi: 'NDLS', ndls: 'NDLS', amritsar: 'ASR', asr: 'ASR', ludhiana: 'LDH', ldh: 'LDH',
  chandigarh: 'CDG', cdg: 'CDG', jalandhar: 'JUC', juc: 'JUC', 'ambala cantt': 'UMB', umb: 'UMB', 'ambala city': 'UBC', ubc: 'UBC'
};
const DATE_RES: RegExp[] = [
  /\b(day after tomorrow|aaj|today|kal|tomorrow|parso|parson)\b/g,
  /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|ravivar|somvar|mangalvar|budhvar|guruvar|shukravar|shanivar)\b/g,
  /\b\d{1,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/g,
  /\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g,
  /\b20\d{2}-\d{2}-\d{2}\b/g
];
const NUM_WORD: Record<string, number> = { ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chheh: 6 };
const NEG_RE = /\b(nahi|nahin|nai|not|instead of)\b/;
const SENSITIVE_RE = /(password|passwd|otp|captcha|cvv|upi pin|card number|irctc (password|login|id))/i;
const NON_RAILWAY_RE = /\b(weather|mausam|movie|film|cricket|politics|news|stock|share market|joke)\b/i;

const norm = (s: string) => ` ${s.toLowerCase().replace(/[,?!।;:]/g, ' ').replace(/\s+/g, ' ').trim()} `;

export class MockLLMProvider implements LLMProvider {
  readonly providerId = 'mock-llm';
  readonly modelName = 'mock-deterministic-v2';

  async init(_config: any): Promise<void> {}

  async generateStructuredDecision(input: LLMTurnInput): Promise<LLMTurnResult> {
    return { decision: this.decide(input) };
  }

  // ------------------------------------------------------------------ main

  private decide(input: LLMTurnInput): AgentDecision {
    const raw = input.userText.trim();
    const t = norm(raw);
    const s = input.session as BookingSession;
    const turn = input.currentTurnToolResults ?? this.toolResultsSinceLastUser(input.history);

    if (SENSITIVE_RE.test(t)) return this.final('UNKNOWN', 'Main kabhi password, OTP, CAPTCHA, card ya UPI PIN nahi maangta. Kripya aisi jaankari share na karein.');
    if (NON_RAILWAY_RE.test(t) && !/\b(train|railway|ticket|fare|kiraya)\b/.test(t)) return this.final('UNKNOWN', 'Main railway booking aur train information mein help kar sakta hoon.');
    // Prompt 17: "cancelled trains" is a LIVE provider fact → request the approved tool (never answer from memory)
    if (!turn.length && /\b(cancel(led)?|radd?) (hui |huyi |hue )?trains?\b|\btrains? (jo )?(cancel(led)?|radd?) (hui|huyi|hai|hain)\b/.test(t)) {
      return this.d('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [{ callId: uuid(), name: 'GET_CANCELLED_TRAINS' as any, arguments: {} }]);
    }
    // Prompt 14: post-booking lookups — the LLM only PROPOSES read-only tool calls; the backend
    // grounds the PNR / train number (user's words or the booking record) and answers deterministically.
    // Prompt 15: lifecycle actions — the (mock) LLM only IDENTIFIES the intent; no tool exists for
    // cancel / modify / refund. The backend acts on the user's words after validation + confirmation.
    if (!turn.length && (input.context as any)?.postBooking) {
      const li = classifyLifecycleIntent(raw);
      if (li) {
        const intent = li.family === 'CANCEL' ? 'CANCEL_BOOKING' : li.family === 'REFUND' ? 'CHECK_REFUND_STATUS' : 'MODIFY_BOOKING';
        return { ...this.final(intent as any, ''), lifecycleAction: li.action === 'ACTION_STATUS' ? 'NO_ACTION' : li.action };
      }
    }
    const pb = this.postBookingDecision(raw, t, input, turn);
    if (pb) return pb;

    const u = this.understand(raw, t, s, input);

    if (turn.length) return this.afterTools(turn, u, s, input.inputMode);
    return this.plan(u, s, input);
  }

  private postBookingDecision(raw: string, t: string, input: LLMTurnInput, turn: TurnToolResultView[]): AgentDecision | null {
    const live = (r: TurnToolResultView) => r.toolName === 'CHECK_PNR' || r.toolName === 'TRACK_TRAIN';
    if (turn.length) {
      if (!turn.every(live)) return null;
      const facts = turn.filter(r => r.ok).map(r => factFromTool(r.toolName, r.data, input.inputMode)).filter(Boolean);
      const errs = turn.filter(r => !r.ok).map(r => r.error?.message || 'Jaankari abhi verify nahi ho paayi.');
      return this.final('GENERAL_RAILWAY_QUERY', [...facts, ...errs].join(' '));
    }
    const ctxPb: any = (input.context as any)?.postBooking;
    const isPnr = /\bpnr\b/.test(t);
    const isLive = /\b(track|tracking|live status|live location|running status|kahan pahunchi|kaha pahunchi|kitni late)\b|\babhi (kaha|kahan|kidhar)\b|\b(kaha|kahan|kidhar) hai\b/.test(t) && /\b(train|gaadi|gadi|track|live|running|\d{5})\b/.test(t);
    if (isPnr) {
      const cand = extractPnrCandidate(raw);
      if (cand) return this.d('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [this.call('CHECK_PNR', { pnr: cand })]);
      if (/\b(status|check|chart|current|confirm hua|waiting)\b/.test(t)) return this.d('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [this.call('CHECK_PNR', {})]);
      return this.final('GENERAL_RAILWAY_QUERY', '');                        // PNR value → backend booking record answers
    }
    if (isLive) {
      const n = t.match(/(?<!\d)(\d{4,5})(?!\d)/);
      return this.d('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [this.call('TRACK_TRAIN', n ? { trainNumber: n[1] } : {})]);
    }
    // follow-up to a booking clarification ("12014 wali") → same lookup for the chosen booking
    const pend = ctxPb?.pendingClarification;
    if (pend && Array.isArray(pend.candidates) && pend.candidates.some((c: any) => t.includes(String(c.trainNumber)))) {
      if (pend.kind === 'PNR_STATUS') return this.d('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [this.call('CHECK_PNR', {})]);
      if (pend.kind === 'LIVE_STATUS') return this.d('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [this.call('TRACK_TRAIN', {})]);
      return this.final('GENERAL_RAILWAY_QUERY', '');
    }
    return null;
  }

  /** Compatibility: derive current-turn tool results from history if not supplied. */
  private toolResultsSinceLastUser(history: LLMTurnInput['history']): TurnToolResultView[] {
    const out: TurnToolResultView[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      if (h.role === 'user') break;
      if (h.role === 'tool') {
        try { const p = JSON.parse(h.content); out.unshift({ toolName: h.toolName || p.toolName, callId: h.toolCallId || '', ok: !!p.ok, data: p.data, error: p.error }); } catch { /* ignore */ }
      }
    }
    return out;
  }

  // ------------------------------------------------------------- understanding

  private understand(raw: string, t: string, s: BookingSession, input: LLMTurnInput): NLU {
    const pending = (input.context?.pendingInteraction ?? s.pendingInteraction)?.type ?? 'NONE';
    const pendingData = (input.context?.pendingInteraction ?? s.pendingInteraction)?.data;
    const hasResults = (input.context?.searchResults.trains.length ?? (s.searchResults?.trains?.length || 0)) > 0;
    const u: NLU = { infoRequests: [], affirm: isPureAffirmation(raw), negate: isPureNegation(raw), wantsBooking: /\b(jaana|jana|book|ticket|chahiye|travel|safar|यात्रा|जाना)\b/.test(t) };
    if (u.affirm || u.negate) return u;
    if (EXEC_RE.test(t)) { u.executionRequested = true; return u; }
    if (/\b(review|summary)\b/.test(t) && /\b(dikhao|batao|show|dekhna|dekhao)\b/.test(t)) { u.wantsReview = true; return u; }
    const hasNeg = NEG_RE.test(t);

    // ---- passenger operations with an explicit reference / field keyword /
    //      "name age gender" pattern (extracted only — backend validates & resolves) ----
    const explicitPax = this.parsePassengerOps(raw, t, s, pending, pendingData, true);
    if (explicitPax) {
      u.pax = explicitPax;
      const c = this.countIn(t, pending);
      if (c) u.passengersCountRaw = c;
      return u;
    }

    // ---- stations / route ----
    const stations: Array<{ w: string; start: number; end: number }> = [];
    for (const m of t.matchAll(STATION_RE)) stations.push({ w: m[1], start: m.index!, end: m.index! + m[0].length });
    const roleOf = (st: { w: string; start: number; end: number }, other?: boolean): 'O' | 'D' | null => {
      const after = t.slice(st.end), before = t.slice(0, st.start);
      if (/^\s+(se|से|from)\b/.test(after) || /\bfrom\s+$/.test(before)) return 'O';
      if (/^\s+to\b/.test(after) && other) return 'O';
      if (/\b(to|se|से)\s+$/.test(before) || /^\s+(tak|ko|jaana|jana|jaane|ke liye|pahunchna)\b/.test(after)) return 'D';
      return null;
    };
    const between = (a: { end: number }, b: { start: number }) => t.slice(a.end, b.start);
    // Prompt 16: answer to "Ambala Cantt (UMB) ya Ambala City (UBC) — kaunsa?" (the LLM never picks one itself)
    const choice = pending === 'CLARIFICATION_REQUIRED' && pendingData?.kind === 'STATION_CHOICE' && stations.length <= 1;
    let chosen: string | undefined;
    if (choice) {
      chosen = stations[0] && stations[0].w !== 'ambala' ? stations[0].w : undefined;
      if (!chosen) {
        const c = (pendingData.candidates || []).find((x: any) => (/\bcantt?\b/.test(t) && /cantt/i.test(x.name)) || (/\bcity\b/.test(t) && /city/i.test(x.name)));
        if (c) chosen = String(c.code);
      }
    }
    if (choice && chosen) {
      if (pendingData.role === 'origin') u.originRaw = chosen;
      else if (pendingData.role === 'destination') u.destinationRaw = chosen;
      else u.stationOnlyRaw = chosen;
    } else if (stations.length >= 2 && NEG_RE.test(between(stations[0], stations[1]))) {
      // "Delhi nahi Ludhiana" — correction of whichever slot holds the old value
      const oldC = STATION_CODE[stations[0].w], newW = stations[1].w;
      if (s.origin === oldC && s.destination !== oldC) u.originRaw = newW;
      else u.destinationRaw = newW;
    } else if (stations.length >= 2) {
      const [a, b] = stations;
      const ra = roleOf(a, true), rb = roleOf(b);
      if (ra === 'D' || rb === 'O') { u.originRaw = b.w; u.destinationRaw = a.w; }
      else { u.originRaw = a.w; u.destinationRaw = b.w; }
    } else if (stations.length === 1) {
      const st = stations[0];
      const r = roleOf(st);
      if (r === 'O' || /\b(origin|source|boarding|shuru)\b/.test(t)) u.originRaw = st.w;
      else if (r === 'D' || /\b(destination|manzil)\b/.test(t)) u.destinationRaw = st.w;
      else if (pending === 'DESTINATION_REQUIRED') u.destinationRaw = st.w;
      else if (pending === 'ORIGIN_REQUIRED' && !pendingData?.route) u.originRaw = st.w;
      else u.stationOnlyRaw = st.w;
    } else if (/\b([a-z]{3,})\s+(?:se|से|to)\s+([a-z]{3,})\b/.test(t) && !this.isStopRoute(t)) {
      // Unknown place names are still EXTRACTED (as a real LLM would); the
      // backend RouteResolver is the authority that accepts or rejects them.
      const m = t.match(/\b([a-z]{3,})\s+(?:se|से|to)\s+([a-z]{3,})\b/)!;
      u.originRaw = m[1]; u.destinationRaw = m[2];
    } else if (pending === 'CLARIFICATION_REQUIRED' && pendingData?.kind === 'STATION_ROLE') {
      if (/\b(se|from|origin|shuru|wahan se|yahan se)\b/.test(t)) u.originRaw = String(pendingData.code);
      else if (/\b(jaana|jana|destination|tak|ko|manzil)\b/.test(t)) u.destinationRaw = String(pendingData.code);
    }

    // ---- date ----
    const dates: Array<{ v: string; i: number }> = [];
    for (const re of DATE_RES) for (const m of t.matchAll(re)) dates.push({ v: m[0].trim(), i: m.index! });
    dates.sort((a, b) => a.i - b.i || b.v.length - a.v.length);
    // Drop overlapping matches ("3 october 2 log" must not also yield "october 2").
    for (let k = 1; k < dates.length; k++) {
      const prev = dates[k - 1];
      if (dates[k].i < prev.i + prev.v.length) { dates.splice(k, 1); k--; }
    }
    if (dates.length) {
      const negIdx = t.search(NEG_RE);
      const after = negIdx >= 0 ? dates.filter(d => d.i > negIdx) : [];
      u.dateRaw = (after.length ? after[after.length - 1] : dates[dates.length - 1]).v;
    }

    // ---- passengers ----
    const numRe = '(\\d|ek|do|teen|char|chaar|paanch|panch|chhe|chheh)';
    const toN = (w: string) => /^\d$/.test(w) ? parseInt(w, 10) : NUM_WORD[w];
    const delta = t.match(new RegExp(`\\b${numRe}\\s+aur\\b`));
    const minus = t.match(new RegExp(`\\b${numRe}\\s+(passengers?\\s+|log\\s+)?(kam|hata|remove)`));
    const abs = t.match(new RegExp(`\\b${numRe}\\s*(log|logon|passengers?|passanger|yatri|tickets?|seats?|bande|members?|persons?|people|adults?|जन|लोग)\\b`));
    if (delta && !/\b\d{5}\s+aur\b/.test(t)) u.passengersDelta = toN(delta[1]);
    else if (minus) u.passengersDelta = -toN(minus[1]);
    else if (abs) u.passengersCountRaw = String(toN(abs[1]));
    else if (pending === 'PASSENGERS_REQUIRED' && new RegExp(`^\\s${numRe}\\s$`).test(t)) u.passengersCountRaw = String(toN(t.trim()));

    // ---- refinement / comparison ----
    const nums = [...t.matchAll(/\b(\d{5})\b/g)].map(m => m[1]);
    if (nums.length >= 2 && /(pahunch|reach|arriv|jaldi|fast|compare)/.test(t)) u.compare = nums.slice(0, 2);
    else if (/(sabse pehle pahunch|pehle pahunchne|earliest arriv|jaldi pahunch)/.test(t)) u.refinement = { kind: 'EARLIEST_ARRIVAL' };
    else if (/(fastest|sabse fast|sabse tez|kam time|sabse kam samay|quickest)/.test(t)) u.refinement = { kind: 'FASTEST' };
    else if (/(alternatives?|aur options|doosre options|dusre options|other options)/.test(t)) u.refinement = { kind: 'ALTERNATIVES', value: nums[0] };
    else if (/\b(sirf|only|keval)\s+non\s?ac\b/.test(t)) u.refinement = { kind: 'NON_AC_ONLY' };
    else if (/\b(sirf|only|keval)\s+ac\b|\bac (wali )?trains\b/.test(t)) u.refinement = { kind: 'AC_ONLY' };
    else {
      const tw = t.match(/\b(morning|subah|evening|shaam|night|raat|afternoon|dopahar)\b/);
      if (tw && /\btrains?\b/.test(t) && /\b(dikhao|show|list|batao|chahiye)\b/.test(t) && hasResults) u.refinement = { kind: 'TIME', value: this.timeWord(tw[1]) };
    }

    // ---- class ----
    const clsText = hasNeg ? t.split(NEG_RE).slice(-1)[0] : t;
    const cls = canonicalClassToken(clsText);
    const ordinalClassClash = /\b(first|second|third) (class|ac|sitting)\b/.test(t);

    // ---- train references ----
    const ver = input.context?.searchResults.version ?? s.searchResultsVersion;
    const withVer = (r: TrainReference): TrainReference => ({ ...r, searchResultsVersion: ver } as TrainReference);
    if (!u.compare && !u.refinement) {
      if (/\b(doosri|dusri|dosri|another|other|koi aur)\b/.test(t) && (hasNeg || /\b(koi aur|another|other)\b/.test(t)) && /\b(train|wali|wala|one)\b/.test(t)) u.trainRef = withVer({ kind: 'ALTERNATIVE', value: 'OTHER' });
      else if (/(jo pehle batayi|jo pehle wali|pehle wali train|previous|pichli wali|pichhli wali)/.test(t)) u.trainRef = withVer({ kind: 'PREVIOUS', value: 'PREVIOUS' });
      else if (nums.length === 1 && !this.isInfoOnly(t, cls)) u.trainRef = withVer({ kind: 'TRAIN_NUMBER', value: nums[0] });
      else if (nums.length === 2 && hasNeg && !this.isInfoOnly(t, cls)) {
        // Prompt 17: "12014 nahi 14542 wali" — the user explicitly switches to the post-negation train
        const after = t.split(NEG_RE).slice(-1)[0].match(/\b(\d{5})\b/);
        if (after) u.trainRef = withVer({ kind: 'TRAIN_NUMBER', value: after[1] });
      }
      else if (!ordinalClassClash && /\b(pehli|pehla|pahli|first|1st)\b/.test(t)) u.trainRef = withVer({ kind: 'DISPLAY_INDEX', value: 1 });
      else if (!ordinalClassClash && /\b(doosri|dusri|dosri|second|2nd)\b/.test(t)) u.trainRef = withVer({ kind: 'DISPLAY_INDEX', value: 2 });
      else if (!ordinalClassClash && /\b(teesri|tisri|third|3rd)\b/.test(t)) u.trainRef = withVer({ kind: 'DISPLAY_INDEX', value: 3 });
      else if (/\b(chauthi|fourth|4th)\b/.test(t)) u.trainRef = withVer({ kind: 'DISPLAY_INDEX', value: 4 });
      else if (/\b(last|aakhri|akhri|antim)\b/.test(t)) u.trainRef = withVer({ kind: 'DEMONSTRATIVE', value: 'LAST' });
      else if (/\b(ye wali|yeh wali|ye wala|yahi wali|yahi|is wali|isi wali|this one|this train|iski|iska|iske|isme|ismein|ismein)\b/.test(t)) u.trainRef = withVer({ kind: 'DEMONSTRATIVE', value: 'THIS' });
      else if (hasResults && /\b(morning|subah|evening|shaam|night|raat|afternoon|dopahar)\s*(wali|wala|train|one|ki)\b/.test(t)) {
        const tw = t.match(/\b(morning|subah|evening|shaam|night|raat|afternoon|dopahar)\b/)!;
        u.trainRef = withVer({ kind: 'TIME_PREFERENCE', value: this.timeWord(tw[1]) as any });
      } else if (pending === 'TRAIN_SELECTION_REQUIRED' && /^\s\d\s$/.test(t)) u.trainRef = withVer({ kind: 'DISPLAY_INDEX', value: parseInt(t.trim(), 10) });
    }
    if (!hasResults && !u.trainRef) {
      const tw = t.match(/\b(morning|subah|evening|shaam|night|raat|afternoon|dopahar)\b/);
      if (tw) u.preferredTimeRaw = this.timeWord(tw[1]);
    }

    // Class: selection (train known / referenced), class-preference reference, or pre-search preference.
    if (cls) {
      const trainKnown = !!s.selectedTrain || !!u.trainRef;
      if (trainKnown) u.classRaw = cls;
      else if (hasResults && cls !== 'AC' && cls !== 'NON_AC') {
        // "CC wali" while trains are listed → pick the train offering CC (backend
        // resolves; ambiguous if several) and then select that class.
        u.trainRef = withVer({ kind: 'CLASS_PREFERENCE', value: cls });
        u.classRaw = cls;
      } else if (hasResults && !u.refinement) {
        // generic "AC wali" over a list → fresh filtered search (never guess a class)
        u.refinement = { kind: cls === 'AC' ? 'AC_ONLY' : 'NON_AC_ONLY' };
      } else if (!hasResults) {
        u.preferredClassRaw = cls === 'NON_AC' ? 'NON_AC' : (cls === 'AC' || AC_CLASSES.has(cls)) ? 'AC' : 'NON_AC';
      }
    }

    // ---- information requests ----
    if (/\b(availability|available hai|seats?|jagah|confirm milegi|उपलब्ध)\b/.test(t)) u.infoRequests.push('AVAILABILITY');
    if (/\b(fare|kiraya|kiraaya|किराया|price|kitne ka|kitna paisa|kitne paise|cost|rate)\b/.test(t)) u.infoRequests.push('FARE');
    if (/\b(timetable|time table|schedule|stops|stoppage|kahan kahan rukti)\b/.test(t)) u.infoRequests.push('TIMETABLE');
    if (this.isInfoOnly(t, cls) && !u.infoRequests.length) { u.infoRequests.push('TRAIN_INFO'); u.infoTrainNumber = nums[0]; }
    // Prompt 16: a side question ("Waise 12014 kal chalti hai?") is NOT a journey change — no slot proposals
    if (this.isInfoOnly(t, cls)) { delete u.dateRaw; delete u.originRaw; delete u.destinationRaw; delete u.stationOnlyRaw; delete u.trainRef; }
    if (!u.infoRequests.length && /\b(iske baare|iski jaankari|iski details)\b/.test(t)) u.infoRequests.push('TRAIN_INFO');
    if (u.infoRequests.includes('TIMETABLE') && nums.length === 1) u.infoTrainNumber = nums[0];
    // Prompt 17: "abhi dobara check karo" — explicit FRESH repeat of the current quote (always a new provider call)
    if (!u.infoRequests.length && /\b(dobara|dubara|phir se|fir se|again|refresh|latest)\b/.test(t) && /\b(check|dekho|dekh|batao)\b/.test(t)
        && s.selectedTrain && s.selectedClass && !u.trainRef && !u.classRaw) u.infoRequests.push('AVAILABILITY');
    // order matters for multi-step chains
    const order: InfoRequest[] = ['TRAIN_INFO', 'TIMETABLE', 'AVAILABILITY', 'FARE'];
    u.infoRequests.sort((a, b) => order.indexOf(a) - order.indexOf(b));

    // ---- "X change karo" without a value ----
    const chg = /\b(change|badal|badlo|badli|badalni)\b/.test(t);
    if (chg) {
      if (/\b(date|tareekh|tarikh|din)\b/.test(t) && !u.dateRaw) u.changeRequested = 'date';
      else if (/\b(destination|manzil)\b/.test(t) && !stations.length) u.changeRequested = 'destination';
      else if (/\b(origin|source|boarding)\b/.test(t) && !stations.length) u.changeRequested = 'origin';
      else if (/\broute\b/.test(t) && !stations.length) u.changeRequested = 'route';
      else if (/\bclass\b/.test(t) && !cls) u.changeRequested = 'class';
      else if (/\btrain\b/.test(t) && !u.trainRef) u.changeRequested = 'train';
      else if (/\b(passengers?|log)\b/.test(t) && !u.passengersCountRaw && u.passengersDelta === undefined) u.changeRequested = 'passengers';
    }
    if (!u.changeRequested && /\b(change|edit|badalna|badalni)\b/.test(t) && !stations.length && !u.dateRaw && !cls && !u.trainRef) u.changeRequested = 'details';

    // ---- passenger details (only in that step, only when nothing else was understood) ----
    if (PAX_STATES.has(s.bookingState) && s.bookingState !== BookingState.AWAITING_CONFIRMATION && !this.anyBookingSignal(u)) {
      const ops = this.parsePassengerOps(raw, t, s, pending, pendingData, false);
      if (ops) u.pax = ops;
    } else if (s.bookingState === BookingState.AWAITING_CONFIRMATION && pending === 'PASSENGER_DETAILS_REQUIRED' && pendingData?.correction && !this.anyBookingSignal(u)) {
      const ops = this.parsePassengerOps(raw, t, s, pending, pendingData, false);
      if (ops) u.pax = ops;
    }
    return u;
  }

  private isStopRoute(t: string): boolean {
    const m = t.match(/\b([a-z]{3,})\s+(?:se|से|to)\s+([a-z]{3,})\b/);
    if (!m) return true;
    const STOP = new Set(['kal', 'aaj', 'parso', 'abhi', 'yahan', 'wahan', 'kahan', 'mujhe', 'hum', 'main', 'mera', 'meri', 'ghar', 'jaana', 'jana', 'chalna', 'nikalna', 'hai', 'hain', 'train', 'trains', 'date', 'class', 'passenger', 'passengers', 'log', 'fare', 'seat', 'pehle', 'baad', 'subah', 'shaam', 'raat', 'morning', 'evening', 'night', 'want', 'need', 'going', 'travel', 'book', 'ticket', 'wali', 'wala', 'one']);
    return STOP.has(m[1]) || STOP.has(m[2]);
  }

  private isInfoOnly(t: string, cls: string | null): boolean {
    return /\b\d{5}\b/.test(t) && /\b(batao|bataiye|info|details?|jaankari|jankari|ke baare|chalti|chalta|kab chalti|runs?|running days)\b/.test(t) && !cls
      && !/\b(availability|seats?|fare|kiraya|price|timetable|schedule)\b/.test(t);
  }

  private anyBookingSignal(u: NLU): boolean {
    return !!(u.originRaw || u.destinationRaw || u.stationOnlyRaw || u.dateRaw || u.passengersCountRaw || u.passengersDelta !== undefined
      || u.trainRef || u.classRaw || u.infoRequests.length || u.refinement || u.compare || u.changeRequested || u.preferredClassRaw);
  }

  /** Absolute passenger count mentioned in text ("do passenger hain"). */
  private countIn(t: string, pending: string): string | undefined {
    const numRe = '(\\d|ek|do|teen|char|chaar|paanch|panch|chhe|chheh)';
    const m = t.match(new RegExp(`\\b${numRe}\\s*(log|logon|passengers?|yatri|tickets?|bande|people|persons?)\\b`));
    if (m) return String(/^\d$/.test(m[1]) ? parseInt(m[1], 10) : NUM_WORD[m[1]]);
    return undefined;
  }

  /** Passenger reference inside a text fragment (proposal only; backend resolves). */
  private refIn(seg: string, s: BookingSession, allowBareOrdinal: boolean): { ref?: PassengerRef; stripped: string } {
    let x = ` ${seg} `;
    const lower = x.toLowerCase();
    let ref: PassengerRef | undefined;
    let m = lower.match(/\bpassenger\s*(?:no\.?\s*|number\s*)?(\d)\b/);
    if (m) { ref = { kind: 'INDEX', value: parseInt(m[1], 10) }; x = x.replace(new RegExp(m[0].trim(), 'i'), ' '); }
    if (!ref && (m = lower.match(new RegExp(`\\b(${ORD_WORDS})\\s+(passenger|yatri)\\b`)))) { ref = { kind: 'INDEX', value: ORDINAL_IDX[m[1]] }; x = x.replace(new RegExp(m[0], 'i'), ' '); }
    if (!ref && allowBareOrdinal && (m = lower.match(new RegExp(`^\\s*(${ORD_WORDS})\\b(?!\\s+(train|wali|wala|class))`)))) { ref = { kind: 'INDEX', value: ORDINAL_IDX[m[1]] }; x = x.replace(new RegExp(`\\b${m[1]}\\b`, 'i'), ' '); }
    if (!ref && (m = x.match(/\bP(\d)\b/))) { ref = { kind: 'ID', value: `P${m[1]}` }; x = x.replace(m[0], ' '); }
    if (!ref && (m = lower.match(/\b(uska|uski|uske|unka|unki|unke)\b/))) { ref = { kind: 'PRONOUN' }; }
    if (!ref) {
      for (const p of s.passengers || []) {
        const first = (p.name || '').split(/\s+/)[0];
        if (first.length < 2) continue;
        const re = new RegExp(`\\b(${first.toLowerCase()}(?:\\s+${((p.name || '').split(/\s+/)[1] || '§').toLowerCase()})?)\\s+(ki|ka|ke|ko)\\b`);
        const mm = lower.match(re);
        if (mm) { ref = { kind: 'NAME', value: mm[1] }; x = x.replace(new RegExp(`\\b${mm[1]}\\b`, 'i'), ' '); break; }
      }
    }
    return { ref, stripped: x };
  }

  /** Raw field extraction from one passenger fragment (validator decides validity). */
  private fieldsIn(seg: string): Record<string, string> {
    const out: Record<string, string> = {};
    let x = seg;
    const nm = x.match(/\b(?:naam|name)\s+(?:hai\s+|is\s+|:\s*)?([\p{L}][\p{L} .'-]*)/iu);
    if (nm) {
      const v = cleanNameValue(nm[1]);
      if (v) out.name = v;
      x = x.replace(nm[0], ' ');
    }
    const age = x.match(/\b(?:age|umar|umra)\s*(?:hai\s*|:\s*)?(\d{1,3})\b/i) || x.match(/\b(\d{1,3})\s*(?:saal|sal|years?|yrs?)\b/i) || x.match(/\b(\d{1,3})\b/);
    if (age) { out.age = age[1]; x = x.replace(age[0], ' '); }
    const g = x.match(GENDER_RE);
    if (g) { out.gender = g[1]; x = x.replace(g[0], ' '); }
    if (!out.name) {
      const words = x.replace(/[^\p{L}\s.'-]/gu, ' ').split(/\s+/).filter(w => w && !PAX_FILLER.has(w.toLowerCase()) && !ORDINAL_IDX[w.toLowerCase()]);
      const rest = words.join(' ').replace(/^[.'-]+|[.'-]+$/g, '').trim();
      if (rest.length >= 2) out.name = rest;
    }
    return out;
  }

  /**
   * Passenger operations. explicitOnly=true → only when the utterance clearly
   * talks about passengers (reference, field keyword, or "name age gender").
   */
  private parsePassengerOps(raw: string, t: string, s: BookingSession, pending: string, pendingData: any, explicitOnly: boolean): PaxOps | null {
    const probe = this.refIn(raw, s, false);
    const hasRef = !!probe.ref;
    const fieldKw = FIELD_KW_RE.test(t);
    const detailsPattern = GENDER_RE.test(t) && /\b\d{1,3}\b/.test(t) && !/\b\d{4,5}\b/.test(t);
    if (explicitOnly && !hasRef && !fieldKw && !detailsPattern) return null;
    if (explicitOnly && !hasRef && fieldKw && /\b(train|class|fare|date)\b/.test(t)) return null;
    const correction = /\b(actually|galat|sorry|change|badal|badlo|kar do|kardo|karo)\b/i.test(t) || /^\s*nahi\b/i.test(t);

    // removal ("passenger 2 hata do", "actually second passenger nahi aa raha")
    if (hasRef && REMOVE_RE.test(t)) return { remove: probe.ref };
    // field change without a value ("passenger 2 ka naam change karo")
    if (fieldKw && FIELD_CHANGE_RE.test(t)) {
      const f = this.fieldsIn(probe.stripped.replace(FIELD_CHANGE_RE, ' '));
      const field = /\b(naam|name)\b/i.test(t) ? 'name' : /\b(age|umar|umra)\b/i.test(t) ? 'age' : 'gender';
      if (!f[field]) return { fieldChange: { ref: probe.ref, field } };
    }

    // pending correction ("Passenger 2 ka naya naam?" → "Neha Verma")
    if (pending === 'PASSENGER_DETAILS_REQUIRED' && pendingData?.correction && pendingData?.passengerId && !hasRef) {
      const f = this.fieldsIn(raw);
      const field = String(pendingData.field || 'name');
      const v = field === 'name' ? (f.name || raw.trim()) : f[field];
      if (v) return { updates: [{ ref: { kind: 'ID', value: String(pendingData.passengerId) }, fields: { [field]: v }, explicit: true }] };
    }

    // one or many passengers in one utterance (text or STT without commas)
    const segs = raw.split(new RegExp(`[,;]|\\s+(?:aur|and)\\s+|\\s+(?=(?:${ORD_WORDS})\\b(?!\\s+(?:train|wali|wala|class)))|(?<=\\b(?:male|female|other)\\b)\\s+(?=[A-Za-z])`, 'i'));
    const entries: PassengerUpdateRaw[] = [];
    let cur: PassengerUpdateRaw | null = null;
    for (const seg0 of segs) {
      const seg = (seg0 || '').trim();
      if (!seg) continue;
      const segNoCount = seg.replace(/^\s*(\d|ek|do|teen|char|chaar|paanch|panch|chhe)\s+(passengers?|log|logon|yatri|tickets?)\b/i, ' ');
      const { ref, stripped } = this.refIn(segNoCount, s, true);
      const fields = this.fieldsIn(stripped);
      if (!Object.keys(fields).length) continue;
      const explicit = !!ref || FIELD_KW_RE.test(seg) || correction;
      if (cur && !ref && !fields.name && Object.keys(fields).every(k => !(k in cur!.fields))) {
        Object.assign(cur.fields, fields); cur.explicit = cur.explicit || explicit; continue;
      }
      cur = { ...(ref ? { ref } : {}), fields, explicit };
      entries.push(cur);
    }
    if (!entries.length) return null;
    return { updates: entries };
  }

  private timeWord(w: string): string {
    if (/morning|subah/.test(w)) return 'MORNING';
    if (/afternoon|dopahar/.test(w)) return 'AFTERNOON';
    if (/evening|shaam/.test(w)) return 'EVENING';
    return 'NIGHT';
  }

  // ------------------------------------------------------------------ planning

  private plan(u: NLU, s: BookingSession, input: LLMTurnInput): AgentDecision {
    const st = s.bookingState;
    const hasResults = (s.searchResults?.trains?.length || 0) > 0;

    // Context-dependent short replies
    const pi = s.pendingInteraction;
    if ((u.affirm || u.negate) && pi?.type === 'CLARIFICATION_REQUIRED' && pi.data?.kind === 'CONTEXT_CONFLICT') {
      if (u.negate) return this.final('UPDATE_JOURNEY', 'Theek hai, jo pehle tha wahi rakhte hain.');
      // the user CONFIRMED the backend's question → propose exactly that value (backend re-validates)
      const f = String(pi.data.field), v = String(pi.data.proposedCode);
      if (f === 'selectedTrain') {
        // Prompt 17: "12014 selected hai. 14542 check karna hai?" → haan → select 14542 (backend re-validates) + same lookup
        const ref = { kind: 'TRAIN_NUMBER', value: v, searchResultsVersion: s.searchResultsVersion } as TrainReference;
        const tool = String(pi.data.tool || '');
        const follow: ToolCall[] = tool === 'CHECK_AVAILABILITY' || tool === 'GET_FARE' ? [this.call(tool as RegisteredToolName, {})] : [];
        return this.d('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: ref }, follow);
      }
      const ce: ExtractedEntities = f === 'origin' ? { originRaw: v } : f === 'destination' ? { destinationRaw: v } : f === 'date' ? { dateRaw: v } : { passengersCountRaw: v };
      const o = f === 'origin' ? v : s.origin, dd = f === 'destination' ? v : s.destination, dt = f === 'date' ? v : s.date;
      const calls: ToolCall[] = [];
      if (o && dd && dt) {
        const args: Record<string, any> = { origin: o, destination: dd, date: dt };
        const pc = f === 'passengersCount' ? parseInt(v, 10) : s.passengersCount;
        if (pc) args.passengersCount = pc;
        if (s.preferredClass && s.preferredClass !== 'ANY') args.preferredClass = s.preferredClass;
        calls.push(this.call('SEARCH_TRAINS', args));
      }
      return this.d(f === 'date' ? 'UPDATE_DATE' : 'UPDATE_JOURNEY', calls.length ? 'SEARCH_TRAINS' : 'UPDATE_JOURNEY', ce, calls);
    }
    if (u.affirm) {
      if (st === BookingState.AWAITING_CONFIRMATION) return this.d('CONFIRM_BOOKING', 'PREPARE_IRCTC_HANDOFF', { affirmation: true });
      if (st === BookingState.REVIEW) return this.d('CONFIRM_BOOKING', 'REQUEST_CONFIRMATION', { affirmation: true });
      return this.d('UNKNOWN', 'ASK_CLARIFICATION', { affirmation: true });
    }
    if (u.negate) return this.d('UNKNOWN', 'ASK_CLARIFICATION', { negation: true });
    if (u.executionRequested) return this.d('UNKNOWN', 'NO_ACTION', { executionRequested: true });
    if (u.wantsReview) return this.d('SHOW_REVIEW', 'SHOW_REVIEW', {});
    if (u.pax) {
      const pe: ExtractedEntities = {};
      if (u.pax.updates) pe.passengerUpdates = u.pax.updates;
      if (u.pax.remove) pe.passengerRemove = u.pax.remove;
      if (u.pax.fieldChange) pe.passengerFieldChange = u.pax.fieldChange;
      if (u.passengersCountRaw) pe.passengersCountRaw = u.passengersCountRaw;
      return this.d('COLLECT_PASSENGER_DETAILS', 'COLLECT_PASSENGER_DETAILS', pe);
    }

    const e: ExtractedEntities = {};
    if (u.originRaw) e.originRaw = u.originRaw;
    if (u.destinationRaw) e.destinationRaw = u.destinationRaw;
    if (u.stationOnlyRaw) e.stationOnlyRaw = u.stationOnlyRaw;
    if (u.dateRaw) e.dateRaw = u.dateRaw;
    if (u.passengersCountRaw) e.passengersCountRaw = u.passengersCountRaw;
    if (u.passengersDelta !== undefined) e.passengersDelta = u.passengersDelta;
    if (u.preferredClassRaw) e.preferredClassRaw = u.preferredClassRaw;
    if (u.preferredTimeRaw) e.preferredTimeRaw = u.preferredTimeRaw;
    if (u.trainRef) e.trainRef = u.trainRef;
    if (u.classRaw) e.classRaw = u.classRaw;
    if (u.infoRequests.length) e.infoRequests = u.infoRequests;
    if (u.refinement) e.refinement = u.refinement;
    if (u.compare) e.compareTrainNumbers = u.compare;
    if (u.changeRequested) e.changeRequested = u.changeRequested;

    if (u.compare) return this.d('GENERAL_RAILWAY_QUERY', 'COMPARE_TRAINS', e);
    if (u.refinement && ['FASTEST', 'EARLIEST_ARRIVAL', 'ALTERNATIVES'].includes(u.refinement.kind)) return this.d('GENERAL_RAILWAY_QUERY', 'REFINE_RESULTS', e);
    if (u.refinement && s.origin && s.destination && s.date) {
      // Needs FRESH provider data with a filter → new SEARCH_TRAINS call.
      const args: Record<string, any> = { origin: s.origin, destination: s.destination, date: s.date };
      if (u.refinement.kind === 'AC_ONLY') args.preferredClass = 'AC';
      if (u.refinement.kind === 'NON_AC_ONLY') args.preferredClass = 'NON_AC';
      if (u.refinement.kind === 'TIME') args.preferredTime = u.refinement.value;
      if (s.passengersCount) args.passengersCount = s.passengersCount;
      return this.d('SEARCH_TRAINS', 'REFINE_RESULTS', e, [this.call('SEARCH_TRAINS', args)]);
    }

    // Journey slot filling (any order) → search as soon as origin+destination+date are known.
    const journeyGiven = !!(u.originRaw || u.destinationRaw || u.dateRaw || u.stationOnlyRaw);
    const paxGiven = !!(u.passengersCountRaw || u.passengersDelta !== undefined);
    const origin = u.originRaw || s.origin;
    const destination = u.destinationRaw || s.destination;
    const date = u.dateRaw || s.date;
    const toolCalls: ToolCall[] = [];
    const roleUnknown = !!u.stationOnlyRaw && !(s.origin && !s.destination) && !(s.destination && !s.origin) && !this.pendingRole(s);
    if ((journeyGiven || (paxGiven && !hasResults) || (u.preferredClassRaw && !hasResults) || (u.preferredTimeRaw && !hasResults)) && !roleUnknown) {
      const o = origin || (u.stationOnlyRaw && s.destination ? u.stationOnlyRaw : undefined);
      const dd = destination || (u.stationOnlyRaw && s.origin ? u.stationOnlyRaw : undefined);
      if (o && dd && date) {
        const args: Record<string, any> = { origin: o, destination: dd, date };
        const pc = u.passengersCountRaw ? parseInt(u.passengersCountRaw, 10) : undefined;
        if (pc) args.passengersCount = pc;
        const pcls = u.preferredClassRaw || s.preferredClass;
        if (pcls && pcls !== 'ANY') args.preferredClass = pcls;
        const ptime = u.preferredTimeRaw || s.preferredTime;
        if (ptime && ptime !== 'ANY') args.preferredTime = ptime;
        toolCalls.push(this.call('SEARCH_TRAINS', args));
      }
    }

    // Information requests (first tool now; the rest chained after its result)
    // Prompt 17: independent read-only lookups are requested together — the runtime runs them in parallel
    if (u.infoRequests.length && !toolCalls.length) toolCalls.push(...u.infoRequests.map(r => this.infoCall(r, u, s)));

    if (journeyGiven) {
      const isCorrection = !!((u.originRaw && s.origin) || (u.destinationRaw && s.destination) || (u.dateRaw && s.date));
      const intent = isCorrection ? (u.dateRaw && !u.originRaw && !u.destinationRaw ? 'UPDATE_DATE' : 'UPDATE_JOURNEY') : (toolCalls.length ? 'SEARCH_TRAINS' : 'BOOK_TRAIN');
      const dec = this.d(intent, toolCalls.length ? 'SEARCH_TRAINS' : 'UPDATE_JOURNEY', e, toolCalls);
      if (!toolCalls.length) dec.clarification = this.missingQuestion(origin, destination, date);
      return dec;
    }
    if (u.trainRef) return this.d('SELECT_TRAIN', 'SELECT_TRAIN', e, toolCalls);
    if (u.classRaw) return this.d('SELECT_CLASS', 'SELECT_CLASS', e, toolCalls);
    if (paxGiven) return this.d('UPDATE_PASSENGERS', toolCalls.length ? 'SEARCH_TRAINS' : 'UPDATE_PASSENGERS', e, toolCalls);
    if (toolCalls.length) return this.d(toolCalls[0].name === 'SEARCH_TRAINS' ? 'SEARCH_TRAINS' : 'GENERAL_RAILWAY_QUERY', toolCalls[0].name === 'SEARCH_TRAINS' ? 'SEARCH_TRAINS' : 'NO_ACTION', e, toolCalls);
    if (u.changeRequested) return this.d('UPDATE_JOURNEY', 'ASK_CLARIFICATION', e);
    if (u.preferredClassRaw || u.preferredTimeRaw || u.wantsBooking) {
      const dec = this.d('BOOK_TRAIN', 'ASK_CLARIFICATION', e);
      dec.clarification = this.missingQuestion(s.origin, s.destination, s.date);
      return dec;
    }
    return this.final('GENERAL_RAILWAY_QUERY', 'Main train search, train/class selection, availability aur fare mein madad kar sakta hoon.');
  }

  /** The LLM's own (non-authoritative) wording; the backend prefers its pendingInteraction question. */
  private missingQuestion(o?: string, d?: string, date?: string): string | null {
    if (!o && !d) return 'Kahan se kahan jaana hai?';
    if (!o) return 'Kahan se chalna hai?';
    if (!d) return 'Kahan jaana hai?';
    if (!date) return 'Kis date ko jaana hai?';
    return null;
  }

  private pendingRole(s: BookingSession): boolean {
    const p = s.pendingInteraction?.type;
    return p === 'DESTINATION_REQUIRED' || (p === 'ORIGIN_REQUIRED' && !s.pendingInteraction?.data?.route);
  }

  private infoCall(req: InfoRequest, u: NLU, s: BookingSession): ToolCall {
    switch (req) {
      case 'TRAIN_INFO': return this.call('GET_TRAIN_INFO', u.infoTrainNumber ? { trainNumber: u.infoTrainNumber } : {});
      case 'TIMETABLE': return this.call('GET_TIMETABLE', u.infoTrainNumber ? { trainNumber: u.infoTrainNumber } : {});
      case 'AVAILABILITY': return this.call('CHECK_AVAILABILITY', {});
      case 'FARE': return this.call('GET_FARE', {});
    }
  }

  // ------------------------------------------------------------ after tool results

  private afterTools(turn: TurnToolResultView[], u: NLU, s: BookingSession, mode: 'TEXT' | 'VOICE'): AgentDecision {
    const ok = turn.filter(r => r.ok);
    const facts = ok.filter(r => r.toolName !== 'SEARCH_TRAINS').map(r => factFromTool(r.toolName, r.data, mode)).filter(Boolean);
    const failed = turn.filter(r => !r.ok);
    if (failed.length) {
      const f = failed[failed.length - 1];
      // Prompt 17: partial failure keeps the verified results — "Timetable mil gaya, lekin availability abhi verify nahi ho paayi."
      const providerFail = failed.filter(r => r.status === 'FAILED' || r.status === 'TIMEOUT');
      if (facts.length && providerFail.length === failed.length) {
        const okL = [...new Set(ok.filter(r => r.toolName !== 'SEARCH_TRAINS').map(r => this.labelOf(r.toolName)))];
        const badL = [...new Set(providerFail.map(r => this.labelOf(r.toolName).toLowerCase()))];
        const head = `${cap(okL.join(' aur '))} mil gaya, lekin ${badL.join(' aur ')} abhi verify nahi ho paayi.`;
        return this.final('GENERAL_RAILWAY_QUERY', [head, ...facts].join(' '));
      }
      return this.final('GENERAL_RAILWAY_QUERY', [...facts, this.failureMessage(f, s)].join(' '));
    }
    // Prompt 17: SUCCESS with zero trains is an empty RESULT, never "search failed"
    const emptySearch = ok.find(r => r.toolName === 'SEARCH_TRAINS' && (r.empty || (Array.isArray(r.data?.trains) && r.data.trains.length === 0)));
    if (emptySearch && !facts.length) return this.final('SEARCH_TRAINS', 'Provider ne is route aur date ke liye koi train nahi di. Koi aur date ya route try karein?');
    // Multi-step chain: issue the next still-needed tool.
    const doneNames = new Set(turn.map(r => r.toolName));
    const toolFor: Record<InfoRequest, RegisteredToolName> = { TRAIN_INFO: 'GET_TRAIN_INFO', TIMETABLE: 'GET_TIMETABLE', AVAILABILITY: 'CHECK_AVAILABILITY', FARE: 'GET_FARE' };
    for (const req of u.infoRequests) {
      if (!doneNames.has(toolFor[req])) {
        return this.d('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [this.infoCall(req, u, s)]);
      }
    }
    if (doneNames.has('SEARCH_TRAINS') && !facts.length) return this.final('SEARCH_TRAINS', 'Trains mil gayi hain.');
    return this.final('GENERAL_RAILWAY_QUERY', facts.join(' ') || 'Jaankari mil gayi.');
  }

  private labelOf(tool: string): string {
    return tool === 'GET_FARE' ? 'Fare' : tool === 'CHECK_AVAILABILITY' ? 'Availability' : tool === 'GET_TIMETABLE' ? 'Timetable' : tool === 'GET_TRAIN_INFO' ? 'Train info' : (TOOL_LABEL[tool] || tool);
  }

  private failureMessage(f: TurnToolResultView, s: BookingSession): string {
    const code = f.error?.code;
    const label = f.toolName === 'GET_FARE' ? 'fare' : f.toolName === 'CHECK_AVAILABILITY' ? 'availability' : (TOOL_LABEL[f.toolName] || f.toolName).toLowerCase();
    if ((code === 'INVALID_ACTION_FOR_STATE' || code === 'MISSING_REQUIRED_FIELD') && (f.toolName === 'GET_FARE' || f.toolName === 'CHECK_AVAILABILITY')) {
      return !s.selectedTrain ? `Pehle train select kar lete hain, phir ${label} check kar deta hoon.` : `Pehle class select kar lete hain, phir ${label} check kar deta hoon.`;
    }
    if (code === 'TOOL_UNAVAILABLE' || code === 'UNKNOWN_TOOL') return 'Ye suvidha abhi uplabdh nahi hai.';
    if (code === 'TOOL_NOT_IMPLEMENTED') return f.toolName === 'GET_CANCELLED_TRAINS'
      ? 'Cancelled trains ki verified list abhi provider se uplabdh nahi hai, isliye main koi list nahi bata sakta.'
      : 'Ye jaankari abhi verified source se uplabdh nahi hai.';
    if (code === 'CONTEXT_CONFLICT' || code === 'FORBIDDEN_ARGUMENT' || code === 'FORBIDDEN_ACTION' || code === 'AMBIGUOUS_DATE' || code === 'AMBIGUOUS_STATION') return f.error?.message || 'Thodi aur jaankari chahiye.';
    if (f.status === 'TIMEOUT') return `${TOOL_LABEL[f.toolName] || 'Jaankari'} abhi verify nahi ho paayi — provider ne time par jawab nahi diya.`;
    if (f.toolName === 'SEARCH_TRAINS') return `Train search abhi complete nahi ho paayi. ${f.error?.message || ''}`.trim();
    if (code === 'MISSING_REQUIRED_FIELD' || code === 'INVALID_TRAIN_REFERENCE' || code === 'INVALID_CLASS_SELECTION') return f.error?.message || 'Thodi aur jaankari chahiye.';
    return `${TOOL_LABEL[f.toolName] || 'Jaankari'} abhi verify nahi ho paaya. Thodi der baad try karein.`;
  }

  // ------------------------------------------------------------------ builders

  private call(name: RegisteredToolName, args: Record<string, any>): ToolCall {
    return { callId: uuid(), name, arguments: args };
  }

  private d(intent: AgentDecision['intent'], action: AgentDecision['action'], entities: ExtractedEntities, toolCalls: ToolCall[] = []): AgentDecision {
    return { intent, action, entities, missingFields: [], clarification: null, confidence: 0.9, toolCalls };
  }

  private final(intent: AgentDecision['intent'], message: string): AgentDecision {
    return { intent, action: 'NO_ACTION', entities: {}, missingFields: [], clarification: null, confidence: 0.9, toolCalls: [], finalMessage: message };
  }
}

function cap(x: string): string { return x ? x.charAt(0).toUpperCase() + x.slice(1) : x; }
