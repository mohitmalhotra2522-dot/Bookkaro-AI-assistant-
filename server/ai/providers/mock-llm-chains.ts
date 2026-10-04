/**
 * PROMPT 27 — deterministic MULTI-STEP behaviour of the MockLLM (offline test double of the real LLM).
 *
 * The real LLM interprets every turn and chains tools itself; this module lets the offline MockLLM do the same so the
 * backend chain (validation → tool → result → next decision → … → final answer) is exercised without credits.
 *
 *  - Stateless: every call re-derives the next step from (user text, authoritative session, THIS turn's tool results).
 *  - It reasons only over authoritative data it was given (search rows / tool results) — like the LLM, it compares the
 *    returned times; the backend still resolves + validates every reference / selection / argument it proposes.
 *  - No randomness. It never invents a train, time, class, availability or fare.
 *  - It engages only for genuinely multi-step / general-knowledge shapes; every other utterance stays on the
 *    existing single-step mock planner (older suites keep their behaviour).
 *
 * Forced scenarios (MockLLMProvider option `chainScenario`) make the mock misbehave ON PURPOSE so the backend guards
 * can be tested: an invalid argument it then corrects, a stubborn invalid repeat, a redundant identical call, a chain
 * that exceeds the tool-step budget, and an attempted forbidden booking/payment tool.
 */
import type { LLMTurnInput, TurnToolResultView } from './llm-provider';
import type { AgentDecision, ExtractedEntities, TrainReference } from '../decisions/agent-decision';
import type { ToolCall } from '../tools/tool-registry';
import type { BookingSession } from '@shared/entities';
import { currentResults, timeWindowOf, type ResultTrain } from '../context/train-reference-resolver';
import { factFromTool } from '../context/response-formatter';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { resolveStationToken } from '../../railway/resolvers/route-resolver';

export type MockChainScenarioId =
  | 'INVALID_ARGUMENT_CORRECTION' | 'INVALID_ARGUMENT_STUBBORN' | 'REPEATED_IDENTICAL_CALL' | 'MAX_TOOL_STEPS' | 'FORBIDDEN_TOOL_ATTEMPT';

/** The 16 required deterministic scenarios (documentation + the utterances the tests drive). */
export const MOCK_CHAIN_SCENARIOS: ReadonlyArray<{ no: number; name: string; turns: string[]; forced?: MockChainScenarioId }> = Object.freeze([
  { no: 1, name: 'SEARCH → SELECT → AVAILABILITY', turns: ['Kal Amritsar se Delhi 12497 ki 3A availability batao'] },
  { no: 2, name: 'SEARCH → SELECT → FARE', turns: ['Kal Amritsar se Delhi 12497 ka 3A fare batao'] },
  { no: 3, name: 'SEARCH → SELECT → AVAILABILITY → FARE', turns: ['Kal Amritsar se Delhi 12497 ki 3A availability aur fare batao'] },
  { no: 4, name: 'SEARCH → compare → SELECT → AVAILABILITY', turns: ['Kal Amritsar se Delhi ki sabse jaldi pahunchne wali train ki CC availability batao'] },
  { no: 5, name: 'date correction → fresh search → revalidation', turns: ['Kal Amritsar se Delhi trains batao', 'Beech wali ki 3A availability aur fare check karo', 'Kal nahi parso, aur jo train pehle choose ki thi uski 3A availability aur fare phir se check karo'] },
  { no: 6, name: 'reference "second wali"', turns: ['Kal Amritsar se Delhi trains mein second wali ki 3A availability batao'] },
  { no: 7, name: 'reference "last wali"', turns: ['Kal Amritsar se Delhi trains mein last wali ki SL availability batao'] },
  { no: 8, name: 'reference "subah wali" (+ comparison)', turns: ['Kal Amritsar se Delhi trains batao', 'Subah wali train jo sabse pehle Delhi pahunchti hai uski CC check karo'] },
  { no: 9, name: 'general knowledge — zero tools', turns: ['RAC kya hota hai?'] },
  { no: 10, name: 'mixed general + railway', turns: ['Shatabdi aur Vande Bharat mein difference kya hai aur kal Amritsar se Delhi trains dikhao'] },
  { no: 11, name: 'tool failure → one retry', turns: ['Kal Amritsar se Delhi 12497 ki 3A availability batao'] },
  { no: 12, name: 'invalid tool argument → correction', turns: ['Kal Amritsar se Delhi trains batao', '12497 ki 3A availability batao'], forced: 'INVALID_ARGUMENT_CORRECTION' },
  { no: 13, name: 'repeated identical tool call', turns: ['Kal Amritsar se Delhi 12497 ki 3A availability batao'], forced: 'REPEATED_IDENTICAL_CALL' },
  { no: 14, name: 'max tool-step protection', turns: ['Kal Amritsar se Delhi trains batao', 'Sab trains ki poori details batao'], forced: 'MAX_TOOL_STEPS' },
  { no: 15, name: 'booking / payment request blocked', turns: ['Kal Amritsar se Delhi trains batao', 'Pehli wali book karke payment bhi kar do'], forced: 'FORBIDDEN_TOOL_ATTEMPT' },
  { no: 16, name: 'ambiguous reference → clarification', turns: ['Kal Amritsar se Delhi trains batao', 'Subah wali ki CC availability'] }
]);

// ------------------------------------------------------------------ mock understanding (test double only)

const CLASS_RE = /\b(1a|2a|3a|3e|cc|ec|sl|2s|fc)\b/i;
const CLASS_WORDS: Array<[RegExp, string]> = [[/\bsleeper\b/i, 'SL'], [/\bchair ?car\b/i, 'CC'], [/\bsecond sitting\b/i, '2S'], [/\b(third|3rd) ac\b/i, '3A'], [/\b(second|2nd) ac\b/i, '2A']];
const AVAIL_RE = /\b(availability|available|avail|seats?|berths?|check)\b/i;
const FARE_RE = /\b(fare|kiraya|kiraaya|price|cost|ticket price)\b/i;
const EARLIEST_ARR_RE = /(sabse (jaldi|pehle) (delhi )?(pahunch|pohonch|pahuch)|jaldi pahunchne|pehle (delhi )?pahunch|reach(es)? .*earliest|earliest arriv|arrives? (the )?earliest|first to reach)/i;
const EARLIEST_DEP_RE = /(sabse pehle (nikal|chal)|earliest depart|leaves? (the )?earliest)/i;
const RECHECK_RE = /\b(dobara|phir se|fir se|again|recheck|re-check)\b/i;
const BOOK_RE = /\b(book (kar|karo|kardo|karna|karke)|booking (kar|karo|karni)|book it|isko book|ticket book)\b/i;
const DATE_FIX_RE = /\b(kal|aaj|parso|parson)\s+nahi,?\s+(kal|aaj|parso|parson)\b/i;
const GK_Q_RE = /(kya hota hai|kya hai\b|kya matlab|matlab kya|difference|fark|farq|antar|what is|what's|meaning|explain)/i;
const GK_TOPIC_RE = /\b(rac|waiting list|waitlist|wl|tatkal|shatabdi|vande bharat|rajdhani|chair car|sleeper class|3a|cnf)\b/i;
const HINGLISH_RE = /\b(hai|hain|kya|ki|ka|ke|se|mein|batao|wali|wala|kal|parso|karo|kar|aur|nahi|jo|uski|iski|sabse|pahunch\w*|dikhao|chahiye)\b/i;
const ENGLISH_RE = /\b(the|which|what|of|these|trains?|reaches|earliest|show|check|availability|fare|is|for|tomorrow)\b/i;

function classIn(t: string): string | undefined {
  const m = t.match(CLASS_RE); if (m) return m[1].toUpperCase();
  for (const [re, c] of CLASS_WORDS) if (re.test(t)) return c;
  return undefined;
}
export function isEnglishUtterance(raw: string): boolean { return ENGLISH_RE.test(raw) && !HINGLISH_RE.test(raw); }

interface Query {
  raw: string; en: boolean; cls?: string; wantsAvail: boolean; wantsFare: boolean;
  origin?: string; destination?: string; dateWord?: string; dateFix?: string;
  ref?: TrainReference; trainNumber?: string; criterion?: 'EARLIEST_ARRIVAL' | 'EARLIEST_DEPARTURE'; timePref?: 'MORNING' | 'EVENING' | 'NIGHT';
  gk?: string; recheck: boolean; booking: boolean;
}

function parse(raw: string, s: BookingSession): Query {
  const t = raw.toLowerCase();
  const q: Query = { raw, en: isEnglishUtterance(raw), wantsAvail: false, wantsFare: FARE_RE.test(t), recheck: RECHECK_RE.test(t), booking: BOOK_RE.test(t) };
  q.cls = classIn(t);
  q.wantsAvail = /\b(availability|available|avail|seats?|berths?)\b/i.test(t) || (/\bcheck\b/i.test(t) && !!q.cls && !q.wantsFare);
  const route = t.match(/\b([a-z]+(?: [a-z]+)?) se ([a-z]+(?: [a-z]+)??)\b(?= ki| ka| ke| trains?| wali| tak| \d|$|,|\.| mein)/i);
  if (route) {
    const o = resolveStationToken(route[1].split(' ').pop() || ''), d = resolveStationToken(route[2].split(' ')[0] || '');
    if (o && d && o.code !== d.code) { q.origin = o.code; q.destination = d.code; }
  }
  if (!q.origin) {
    // English: "from Amritsar to Delhi" / "Amritsar to Delhi"
    const en = t.match(/\b(?:from )?([a-z]+) to ([a-z]+)\b/i);
    if (en) {
      const o = resolveStationToken(en[1]), d = resolveStationToken(en[2]);
      if (o && d && o.code !== d.code) { q.origin = o.code; q.destination = d.code; }
    }
  }
  const fix = t.match(DATE_FIX_RE); if (fix) q.dateFix = fix[2];
  const dw = t.match(/\b(aaj|kal|parso|parson|day after tomorrow|tomorrow|today)\b/i);
  if (dw && !fix) q.dateWord = dw[1] === 'tomorrow' ? 'kal' : dw[1] === 'today' ? 'aaj' : dw[1] === 'day after tomorrow' ? 'parso' : dw[1];
  const num = t.match(/(?<!\d)(\d{5})(?!\d)/); if (num) q.trainNumber = num[1];
  if (EARLIEST_ARR_RE.test(t)) q.criterion = 'EARLIEST_ARRIVAL'; else if (EARLIEST_DEP_RE.test(t)) q.criterion = 'EARLIEST_DEPARTURE';
  if (/\b(subah|morning)\b/i.test(t)) q.timePref = 'MORNING'; else if (/\b(shaam|evening)\b/i.test(t)) q.timePref = 'EVENING'; else if (/\b(raat|night)\b/i.test(t)) q.timePref = 'NIGHT';
  const v = s.searchResultsVersion;
  if (/\b(beech|middle)\b/i.test(t)) q.ref = { kind: 'DEMONSTRATIVE', value: 'MIDDLE', searchResultsVersion: v };
  else if (/\b(second|doosri|dusri|2nd)\b/i.test(t)) q.ref = { kind: 'DISPLAY_INDEX', value: 2, searchResultsVersion: v };
  else if (/\b(third|teesri|3rd)\b/i.test(t)) q.ref = { kind: 'DISPLAY_INDEX', value: 3, searchResultsVersion: v };
  else if (/\b(last|aakhri|akhri)\b/i.test(t)) q.ref = { kind: 'DEMONSTRATIVE', value: 'LAST' };
  else if (/\b(pehli|first)\b/i.test(t)) q.ref = { kind: 'DEMONSTRATIVE', value: 'FIRST' };
  else if (/(pehle choose|pehle select|pehle wali train|usi train|wahi train|same train|jo train pehle)/i.test(t)) q.ref = { kind: 'PREVIOUS', value: 'PREVIOUS' };
  else if (q.trainNumber) q.ref = { kind: 'TRAIN_NUMBER', value: q.trainNumber, searchResultsVersion: v };
  else if (q.timePref && !q.criterion) q.ref = { kind: 'TIME_PREFERENCE', value: q.timePref, searchResultsVersion: v };
  if (GK_Q_RE.test(t) && GK_TOPIC_RE.test(t)) q.gk = (t.match(GK_TOPIC_RE) || [''])[1];
  return q;
}

/** Test-double world knowledge (the real LLM answers general questions from its own knowledge — no FAQ in production). */
function gkAnswer(topic: string, raw: string, en: boolean): string {
  const t = raw.toLowerCase();
  if (/shatabdi/.test(t) && /vande/.test(t)) return en
    ? 'Shatabdi is a day-time chair-car express; Vande Bharat is a newer semi-high-speed train set with similar day-time seating.'
    : 'Shatabdi ek din ki chair-car express hai; Vande Bharat nayi semi-high-speed train set hai, seating dono mein chair car type ki hoti hai.';
  if (/tatkal/.test(topic)) return en ? 'Tatkal is a last-minute quota that opens a day before the journey, at a higher fare.' : 'Tatkal ek last-minute quota hai jo yatra se ek din pehle khulta hai, thode zyada fare par.';
  if (/rac/.test(topic)) return en ? 'RAC means Reservation Against Cancellation: you can board and share a berth, and get a full berth if someone cancels.'
    : 'RAC ka matlab Reservation Against Cancellation hai — aap yatra kar sakte hain, berth share hoti hai, aur cancellation hone par poori berth mil sakti hai.';
  if (/waiting|waitlist|wl/.test(topic)) return en ? 'A waitlisted ticket gets confirmed only if enough confirmed passengers cancel.' : 'Waitlist ticket tabhi confirm hota hai jab kaafi confirmed yatri cancel karein.';
  if (/pnr/.test(topic)) return en ? 'A PNR is the booking reference used to track a ticket.' : 'PNR ticket ka booking reference number hota hai jisse status track hota hai.';
  return en ? 'That is a general railway concept; I can also check live train details for you.' : 'Ye general railway jaankari hai; main live train details bhi check kar sakta hoon.';
}

// ------------------------------------------------------------------ helpers over authoritative data

const has = (turn: TurnToolResultView[], name: string) => turn.some(r => r.toolName === name && r.ok);
const fails = (turn: TurnToolResultView[], name: string) => turn.filter(r => r.toolName === name && !r.ok);
const lastOf = (turn: TurnToolResultView[], name: string) => [...turn].reverse().find(r => r.toolName === name);
const TRANSIENT = new Set(['TOOL_FAILED', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'TOOL_TIMEOUT']);
let seq = 0;
const call = (name: string, args: Record<string, any> = {}): ToolCall => ({ callId: `mc_${++seq}`, name: name as any, arguments: args });
const dec = (intent: AgentDecision['intent'], action: AgentDecision['action'], entities: ExtractedEntities, toolCalls: ToolCall[] = []): AgentDecision =>
  ({ intent, action, entities, missingFields: [], clarification: null, confidence: 0.9, toolCalls });
const final = (message: string, intent: AgentDecision['intent'] = 'GENERAL_RAILWAY_QUERY'): AgentDecision =>
  ({ intent, action: 'NO_ACTION', entities: {}, missingFields: [], clarification: null, confidence: 0.9, toolCalls: [], finalMessage: message });
const clarify = (message: string): AgentDecision =>
  ({ intent: 'GENERAL_RAILWAY_QUERY', action: 'ASK_CLARIFICATION' as any, entities: {}, missingFields: [], clarification: message, confidence: 0.9, toolCalls: [] });

function minutes(hhmm?: string): number | null { const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; }
function durationMin(d?: string): number | null { const m = String(d || '').match(/(\d+)\s*h(?:\s*(\d+)\s*m)?/i); return m ? Number(m[1]) * 60 + Number(m[2] || 0) : null; }
/** Absolute arrival (minutes from the departure day's midnight) — ONLY from returned values; null when missing. */
function arrivalAbs(t: ResultTrain): number | null {
  const dep = minutes(t.departure), arr = minutes(t.arrival), dur = durationMin(t.duration);
  if (dep !== null && dur !== null) return dep + dur;
  if (dep !== null && arr !== null) return arr >= dep ? arr : arr + 1440;
  return null;
}
const classesOf = (t: ResultTrain) => (t.classes || []).map(c => String(c.code).toUpperCase());

function resolveLikeBackend(ref: TrainReference | undefined, trains: ResultTrain[], s: BookingSession): ResultTrain | undefined {
  if (!ref || !trains.length) return undefined;
  switch (ref.kind) {
    case 'TRAIN_NUMBER': return trains.find(x => x.trainNumber === String(ref.value));
    case 'DISPLAY_INDEX': return trains.find(x => x.displayIndex === Number(ref.value));
    case 'DEMONSTRATIVE': return ref.value === 'FIRST' ? trains[0] : ref.value === 'LAST' ? trains[trains.length - 1]
      : ref.value === 'MIDDLE' && trains.length % 2 === 1 && trains.length >= 3 ? trains[(trains.length - 1) / 2] : undefined;
    case 'PREVIOUS': { const p = s.previousTrainNumber || s.carryOverSelection?.trainNumber || s.focusTrainNumber; return p ? trains.find(x => x.trainNumber === p) : undefined; }
    case 'TIME_PREFERENCE': { const c = trains.filter(x => timeWindowOf(x.departure) === ref.value); return c.length === 1 ? c[0] : undefined; }
  }
  return undefined;
}

/** Comparison over RETURNED times only (missing values are excluded, never inferred). */
function compare(q: Query, trains: ResultTrain[]): { pick?: ResultTrain; earliestOverall?: ResultTrain; missing: string[] } {
  let cands = q.timePref ? trains.filter(x => timeWindowOf(x.departure) === q.timePref) : trains;
  const key = (t: ResultTrain) => q.criterion === 'EARLIEST_DEPARTURE' ? minutes(t.departure) : arrivalAbs(t);
  const missing = cands.filter(t => key(t) === null).map(t => t.trainNumber);
  cands = cands.filter(t => key(t) !== null).sort((a, b) => (key(a) as number) - (key(b) as number));
  const earliestOverall = cands[0];
  const pick = q.cls ? cands.find(t => classesOf(t).includes(q.cls!)) : earliestOverall;
  return { pick, earliestOverall, missing };
}

// ------------------------------------------------------------------ final answers (from authoritative results only)

function answerFromResults(turn: TurnToolResultView[], s: BookingSession, en: boolean, lead: string[] = []): string {
  const parts = [...lead];
  const sel: any = s.selectedTrain; const num = sel ? String(sel.number || sel.trainNumber) : '';
  const av = lastOf(turn, 'CHECK_AVAILABILITY'), fr = lastOf(turn, 'GET_FARE');
  if (av?.ok) {
    const st = String(av.data?.status ?? av.data?.availability ?? '').trim();
    const cls = String(av.data?.travelClass || s.selectedClass || '');
    if (st) parts.push(en ? `${num} ${cls} availability: ${st}.` : `${num} mein ${cls} ${/^available$/i.test(st) ? 'available hai' : `${st} hai`}.`);
  } else if (av && !av.ok) parts.push(en ? 'Availability could not be verified right now.' : 'Availability abhi verify nahi ho paayi.');
  if (fr?.ok && en && Number.isFinite(Number(fr.data?.perPassenger))) {
    const d = fr.data; const pc = Number(d.passengersCount) || 1;
    parts.push(`The ${d.travelClass || s.selectedClass || ''} fare on ${d.trainNumber || num} is ₹${d.perPassenger} per passenger${pc > 1 ? ` (₹${d.total} for ${pc})` : ''}.`);
  } else if (fr?.ok) { const f = factFromTool('GET_FARE', fr.data, 'TEXT'); if (f) parts.push(f); }
  else if (fr && !fr.ok) parts.push(en ? 'The fare could not be verified right now.' : 'Fare abhi verify nahi ho paaya.');
  if (parts.length === lead.length) {
    const facts = turn.filter(r => r.ok && r.toolName !== 'SEARCH_TRAINS').map(r => factFromTool(r.toolName, r.data, 'TEXT')).filter(Boolean);
    parts.push(...facts);
  }
  return parts.join(' ').trim();
}

// ------------------------------------------------------------------ the planner

export function mockChainDecision(input: LLMTurnInput, forced?: MockChainScenarioId): AgentDecision | null {
  const s = input.session as BookingSession;
  const turn = input.currentTurnToolResults || [];
  const q = parse(input.userText.trim(), s);

  // Backend stopped the chain (budget / loop): answer ONLY from what this turn already verified.
  if (input.chainStop) {
    const body = answerFromResults(turn, s, q.en);
    const note = q.en ? 'I could not complete every check in one go.' : 'Saari checks ek saath poori nahi ho paayi.';
    return final(body ? `${body} ${note}` : note);
  }

  if (forced) { const f = forcedScenario(forced, q, s, turn, input.userText); if (f) return f; }

  const trains = currentResults(s);
  const isPrep = ['BOOKING_PREPARE', 'COLLECTING_PASSENGER_DETAILS', 'PASSENGERS_READY', 'REVIEW', 'AWAITING_CONFIRMATION', 'IRCTC_HANDOFF_READY', 'COMPLETE',
    'BOOKING_EXECUTION_REQUESTED', 'BOOKING_IN_PROGRESS', 'BOOKING_CONFIRMED', 'BOOKING_FAILED', 'BOOKING_STATUS_UNKNOWN'].includes(String(s.bookingState));
  const wantsInfo = q.wantsAvail || q.wantsFare;
  // a lookup phrased as a question ("3A ka fare kya hai", "PNR 1234567890 ka status kya hai") is NOT general knowledge
  if (q.gk && (wantsInfo || /\d{5,}/.test(q.raw) || /\b(status|pnr|meri|mera|my|booking|ticket|latest)\b/i.test(q.raw))) q.gk = undefined;
  const route = !!(q.origin && q.destination);
  const engage = !isPrep && (
    !!q.criterion || (q.ref?.kind === 'DEMONSTRATIVE' && q.ref.value === 'MIDDLE') || (route && wantsInfo && (!!q.ref || !!q.cls))
    || (!!q.dateFix && (wantsInfo || q.recheck)) || !!q.gk || (q.recheck && !!s.selectedTrain && wantsInfo));
  if (!engage) return null;

  // ---- general knowledge only → zero tools ----
  if (q.gk && !route && !wantsInfo && !q.criterion && !q.ref) return final(gkAnswer(q.gk, q.raw, q.en));

  // ---- date correction: propose the changed slot + a fresh search (backend DateResolver resolves "parso") ----
  if (q.dateFix) {
    const want = resolveDate(q.dateFix);
    if (want.ok && s.date !== want.date && !has(turn, 'SEARCH_TRAINS')) {
      const args = s.origin && s.destination ? { origin: s.origin, destination: s.destination, date: q.dateFix } : null;
      return dec('UPDATE_DATE', 'UPDATE_DATE', { dateRaw: q.dateFix, correctionTarget: 'date', correctionValueRaw: q.dateFix }, args ? [call('SEARCH_TRAINS', args)] : []);
    }
  }

  // ---- search first when the request names a route / date not covered by the current results ----
  const wantDate = q.dateWord ? (resolveDate(q.dateWord) as any).date : undefined;
  const differs = route && (q.origin !== s.origin || q.destination !== s.destination || (wantDate && wantDate !== s.date));
  const needSearch = (route && (!trains.length || differs)) || (!!q.dateFix && !trains.length && !!s.origin && !!s.destination);
  if (needSearch && !has(turn, 'SEARCH_TRAINS')) {
    const sf = fails(turn, 'SEARCH_TRAINS');
    if (sf.length) return final(q.en ? 'The train search could not be completed right now.' : 'Train search abhi complete nahi ho paayi. Thodi der baad try karein.');
    const args: Record<string, any> = { origin: q.origin || s.origin, destination: q.destination || s.destination, date: q.dateWord || q.dateFix || s.date };
    return dec('SEARCH_TRAINS', 'SEARCH_TRAINS', { originRaw: args.origin, destinationRaw: args.destination, dateRaw: String(args.date) }, [call('SEARCH_TRAINS', args)]);
  }
  if (has(turn, 'SEARCH_TRAINS') && !trains.length) return final(q.en ? 'The provider returned no trains for this route and date.' : 'Provider ne is route aur date ke liye koi train nahi di.');

  // ---- mixed: the general part from knowledge + the railway part from the tools ----
  if (q.gk && !wantsInfo && !q.criterion) return final(gkAnswer(q.gk, q.raw, q.en));

  // ---- comparison without a follow-up check → answer from the returned times (no tool needed) ----
  const lead: string[] = [];
  let ref = q.ref;
  if (q.criterion) {
    const c = compare(q, trains);
    if (!c.earliestOverall) return final(q.en ? 'The results do not include the times needed for that comparison.' : 'Results mein is comparison ke liye zaroori times nahi hain.');
    const what = q.criterion === 'EARLIEST_DEPARTURE' ? 'departure' : 'arrival';
    const time = (t: ResultTrain) => (q.criterion === 'EARLIEST_DEPARTURE' ? t.departure : t.arrival);
    const dest = s.destinationName ? s.destinationName.replace(/ Junction$/, '') : 'destination';
    if (!wantsInfo && !q.cls) {
      return final(q.en ? `${c.earliestOverall.trainNumber} reaches ${dest} earliest, at ${time(c.earliestOverall)}.`
        : `${c.earliestOverall.trainNumber} sabse pehle ${time(c.earliestOverall)} par pahunchti hai.`);
    }
    if (!c.pick) return final(q.en ? `None of these trains lists ${q.cls}.` : `In trains mein kisi mein ${q.cls} listed nahi hai.`);
    if (c.pick.trainNumber !== c.earliestOverall.trainNumber) {
      lead.push(q.en ? `${c.earliestOverall.trainNumber} arrives first (${time(c.earliestOverall)}) but does not list ${q.cls}; the earliest with ${q.cls} is ${c.pick.trainNumber} (${what} ${time(c.pick)}).`
        : `Sabse pehle ${c.earliestOverall.trainNumber} pahunchti hai (${time(c.earliestOverall)}), par usmein ${q.cls} listed nahi hai. ${q.cls} wali sabse pehle ${c.pick.trainNumber} hai (${time(c.pick)}).`);
    } else lead.push(q.en ? `${c.pick.trainNumber} arrives earliest (${time(c.pick)}).` : `${c.pick.trainNumber} sabse pehle ${time(c.pick)} par pahunchti hai.`);
    ref = { kind: 'TRAIN_NUMBER', value: c.pick.trainNumber, searchResultsVersion: s.searchResultsVersion };
  }

  // ---- re-check of the current selection ("dobara check karo") — a NEW provider call every new turn ----
  if (q.recheck && !q.dateFix && s.selectedTrain && !ref) {
    const calls = [...(q.wantsAvail || !q.wantsFare ? [call('CHECK_AVAILABILITY', {})] : []), ...(q.wantsFare ? [call('GET_FARE', {})] : [])];
    if (!turn.length) return dec('GENERAL_RAILWAY_QUERY', 'NO_ACTION', { selectionPurpose: 'INFORMATION' }, calls);
    return retryOrFinal(turn, s, q, lead) ?? final(answerFromResults(turn, s, q.en, lead));
  }

  // ---- select (backend resolves the reference) + the independent checks in ONE round ----
  const needAv = q.wantsAvail && !lastOf(turn, 'CHECK_AVAILABILITY');
  const needFare = q.wantsFare && !lastOf(turn, 'GET_FARE');
  if ((needAv || needFare) && turn.every(r => r.toolName === 'SEARCH_TRAINS')) {
    if (!ref) return clarify(q.en ? 'Which train should I check?' : 'Kaunsi train check karun?');
    if (!q.cls) return clarify(q.en ? 'Which class should I check?' : 'Kaunsi class check karun?');
    const target = resolveLikeBackend(ref, trains, s);
    // the LLM reads the class list itself: no availability / fare call for a class the train does not list
    if (target && !classesOf(target).includes(q.cls)) {
      return final([...lead, q.en ? `${target.trainNumber} does not list ${q.cls}; listed classes: ${classesOf(target).join(', ')}.`
        : `${target.trainNumber} mein ${q.cls} listed nahi hai — ${classesOf(target).join(' aur ')} classes listed hain. Kaunsi class dekhun?`].join(' '));
    }
    const calls = [...(needAv ? [call('CHECK_AVAILABILITY', target ? { trainNumber: target.trainNumber, travelClass: q.cls } : {})] : []),
      ...(needFare ? [call('GET_FARE', target ? { trainNumber: target.trainNumber, travelClass: q.cls } : {})] : [])];
    return dec('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: ref, classRaw: q.cls, selectionPurpose: q.booking ? 'BOOKING' : 'INFORMATION' }, calls);
  }
  return retryOrFinal(turn, s, q, lead) ?? final(answerFromResults(turn, s, q.en, lead) || (q.en ? 'Here is what I found.' : 'Jaankari mil gayi.'));
}

/** A transient provider failure is retried ONCE with the identical call; otherwise answer honestly (partial results kept). */
function retryOrFinal(turn: TurnToolResultView[], s: BookingSession, q: Query, lead: string[]): AgentDecision | null {
  for (const name of ['CHECK_AVAILABILITY', 'GET_FARE']) {
    const f = fails(turn, name); const okAlready = has(turn, name);
    const code = String((f[f.length - 1]?.error as any)?.code || '');
    // one retry in total: not when the backend already retried this call (attempts ≥ 2)
    if (f.length === 1 && !okAlready && TRANSIENT.has(code) && (f[0].attempts ?? 1) < 2) return dec('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [call(name, {})]);
  }
  return null;
}

// ------------------------------------------------------------------ forced (misbehaving) scenarios

function forcedScenario(id: MockChainScenarioId, q: Query, s: BookingSession, turn: TurnToolResultView[], raw: string): AgentDecision | null {
  const trains = currentResults(s);
  switch (id) {
    case 'INVALID_ARGUMENT_CORRECTION':
    case 'INVALID_ARGUMENT_STUBBORN': {
      if (!trains.length || !q.trainNumber || !q.cls) return null;
      const bad = () => call('CHECK_AVAILABILITY', { trainNumber: 'abc', travelClass: q.cls });
      const rejected = turn.filter(r => !r.ok && r.toolName === 'CHECK_AVAILABILITY');
      if (!turn.length) return dec('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [bad()]);
      if (id === 'INVALID_ARGUMENT_STUBBORN' && !has(turn, 'CHECK_AVAILABILITY')) {
        const last = (rejected[rejected.length - 1]?.error as any)?.code;
        if (last === 'TOOL_LOOP_DETECTED') return final('Train number samajh nahi aaya — kaunsi train check karun?');
        return dec('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [bad()]);
      }
      if (!has(turn, 'CHECK_AVAILABILITY') && rejected.length) {
        return dec('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: q.trainNumber, searchResultsVersion: s.searchResultsVersion }, classRaw: q.cls, selectionPurpose: 'INFORMATION' },
          [call('CHECK_AVAILABILITY', { trainNumber: q.trainNumber, travelClass: q.cls })]);
      }
      return final(answerFromResults(turn, s, q.en));
    }
    case 'REPEATED_IDENTICAL_CALL': {
      const avs = turn.filter(r => r.toolName === 'CHECK_AVAILABILITY');
      if (has(turn, 'CHECK_AVAILABILITY') && avs.length === 1) return dec('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, [call('CHECK_AVAILABILITY', {})]);
      return null;   // otherwise behave naturally (search → select → check → final)
    }
    case 'MAX_TOOL_STEPS': {
      if (!trains.length || !/\b(details?|sab|saari|all)\b/i.test(raw)) return null;
      const nums = trains.map(t => t.trainNumber);
      const dateWord = s.date;
      const asked = turn.length;
      // keeps asking for MORE distinct data than the per-turn budget allows (info → timetable → info by date → …)
      const plan: ToolCall[] = [...nums.map(n => call('GET_TRAIN_INFO', { trainNumber: n })), ...nums.map(n => call('GET_TIMETABLE', { trainNumber: n })),
        ...nums.map(n => call('GET_TRAIN_INFO', { trainNumber: n, date: dateWord })), ...nums.map(n => call('GET_TIMETABLE', { trainNumber: n, date: dateWord }))];
      const next = plan.slice(asked, asked + 3);
      return next.length ? dec('GENERAL_RAILWAY_QUERY', 'NO_ACTION', {}, next) : final(answerFromResults(turn, s, q.en));
    }
    case 'FORBIDDEN_TOOL_ATTEMPT': {
      if (!/\b(book|payment|pay)\b/i.test(raw)) return null;
      if (!turn.length) return dec('BOOK_TRAIN', 'NO_ACTION', {}, [call('BOOK_TICKET', { trainNumber: trains[0]?.trainNumber || '12014' }), call('MAKE_PAYMENT', { method: 'UPI' })]);
      return final('Main booking ya payment khud nahi kar sakta — ticket IRCTC par aap hi confirm karte hain.', 'BOOK_TRAIN');
    }
  }
  return null;
}
