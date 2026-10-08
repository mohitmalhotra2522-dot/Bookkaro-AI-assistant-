/**
 * PROMPT 25 — claim classification + structured fact index for reply validation (Parts 1–6, 12).
 *
 * The composer used to judge every sentence with flat regexes ("any HH:MM in a general turn is invented", "any
 * 'available' is a seat claim", "any 'N passengers' must equal the session count"). That removed correct sentences.
 * This module gives the composer:
 *   - a FactIndex built ONLY from authoritative data (tool results of this turn + provider data synced into the
 *     session + the verified review snapshot), with the tool that owns each fact;
 *   - claim classification (GENERAL_KNOWLEDGE … ACTION_STATEMENT) so general explanations are not validated as live
 *     railway facts, while railway facts are validated as STRUCTURED claims (train ↔ time ↔ comparison, train ↔ class
 *     list, train/class ↔ GET_FARE amount, result-set ↔ count);
 *   - a minimal internal provenance record per accepted sentence (never shown to the user).
 * Nothing here rewrites the LLM's language; the only repair is CLASS_LIST disambiguation ("CC aur 2S available" →
 * "CC aur 2S classes listed") when no availability result exists, which keeps the provider-backed meaning.
 */
import type { BookingSession } from '@shared/entities';
import { isClassEnumeration, type AvailabilityEvidence } from './availability-authority';
import { claimedDate } from './claim-dates';
import { STATION_ALIASES } from '@shared/constants';

export type ClaimType =
  | 'GENERAL_KNOWLEDGE' | 'RAILWAY_LIVE_FACT' | 'SESSION_FACT' | 'TOOL_DERIVED_FACT'
  | 'USER_PROVIDED' | 'OPINION_OR_EXPLANATION' | 'ACTION_STATEMENT';

/** Internal only (turn log counts / tests) — never part of a user-facing payload. */
export interface ClaimProvenance {
  claimType: ClaimType;
  sourceTool: string | null;
  sourceResultId: string | null;
  fields: string[];
  /** Prompt 26: availability provenance (internal only) — absent ⇒ availability is NOT verified. */
  factSubtype?: 'SEAT_AVAILABILITY';
  verified?: boolean;
  trainNumber?: string;
  date?: string;
  travelClass?: string;
  availability?: string;
  // ---- Prompt 28 (internal only, never user-facing) ----
  claimId?: string;
  entityType?: 'TRAIN' | 'ROUTE' | 'BOOKING' | 'NONE';
  sourceProvider?: string;
  verificationStatus?: 'VERIFIED' | 'NOT_REQUIRED' | 'USER_PROVIDED';
  /** how the sentence was bound to its entity (EXPLICIT / REFERENCE_RESOLVED / SESSION_FOCUS / SINGLE_RESULT / UNBOUND / NOT_APPLICABLE) */
  claimBindingStatus?: string;
}

export interface TrainFact { num: string; name: string; dep?: string; arr?: string; durMin?: number; classes: string[]; source: string; resultId: string | null }
export interface FareFact { train?: string; cls?: string; perPassenger?: number; total?: number; pax?: number; source: string; resultId: string | null; date?: string; provider?: string }
export interface FactIndex {
  trains: TrainFact[];
  /** Trains of the current SEARCH result set (count / comparison basis). */
  searchTrains: TrainFact[];
  fares: FareFact[];
  /** Passenger counts that are authoritative for this session / fare quote. */
  sessionPax: Set<number>;
  farePax: Set<number>;
}

const hhmm = (v: any): string | undefined => {
  const m = String(v ?? '').match(/(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : undefined;
};
export const minutesOf = (t?: string): number | undefined => { if (!t) return undefined; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const durationMin = (v: any): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v ?? '').match(/(\d+)\s*h(?:\s*(\d+)\s*m)?/i);
  return m ? Number(m[1]) * 60 + Number(m[2] || 0) : undefined;
};
const classesOf = (t: any): string[] => [
  ...((Array.isArray(t?.classes) ? t.classes : []) as any[]).map(c => String(typeof c === 'string' ? c : c?.code || '').toUpperCase()),
  ...((Array.isArray(t?.availableClasses) ? t.availableClasses : []) as any[]).map(c => String(c).toUpperCase())
].filter(Boolean);

function trainFact(t: any, source: string): TrainFact | null {
  const num = String(t?.trainNumber ?? t?.number ?? '').trim();
  if (!/^\d{4,5}$/.test(num)) return null;
  return {
    num, name: String(t?.trainName ?? t?.name ?? '').toLowerCase(),
    dep: hhmm(t?.departure ?? t?.departureTime), arr: hhmm(t?.arrival ?? t?.arrivalTime), durMin: durationMin(t?.duration),
    classes: [...new Set(classesOf(t))], source, resultId: t?.resultId ? String(t.resultId) : null
  };
}

function fareFact(f: any, source: string, resultId: string | null, identity?: any): FareFact | null {
  if (!f || typeof f !== 'object') return null;
  const num = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? x : (typeof x === 'string' && /^\d+(\.\d+)?$/.test(x) ? Number(x) : undefined));
  const perPassenger = num(f.perPassenger ?? f.perPassengerFare ?? f.farePerPassenger);
  const total = num(f.total ?? f.totalFare ?? f.amount);
  if (perPassenger === undefined && total === undefined) return null;
  // Prompt 28: the fare's entity = the provider fields, else the result identity / fare basis (never guessed)
  const train = f.trainNumber ?? identity?.trainNumber ?? f.fareBasis?.trainNumber;
  const cls = f.travelClass ?? identity?.travelClass ?? f.fareBasis?.travelClass;
  const date = f.date ?? identity?.date ?? f.fareBasis?.date;
  return {
    train: train ? String(train) : undefined, cls: cls ? String(cls).toUpperCase() : undefined,
    perPassenger, total, pax: num(f.passengersCount ?? f.fareBasis?.passengersCount), source, resultId,
    ...(date ? { date: String(date) } : {}), ...(identity?.provider ? { provider: String(identity.provider) } : {})
  };
}

export interface FactView { toolName?: string; ok: boolean; data?: any; callId?: string; identity?: any }

export function buildFactIndex(s: BookingSession, views: FactView[]): FactIndex {
  const sx: any = s;
  const trains: TrainFact[] = [];
  const searchTrains: TrainFact[] = [];
  const add = (t: any, src: string, search = false) => { const f = trainFact(t, src); if (f) { trains.push(f); if (search) searchTrains.push(f); } };
  for (const t of (sx.searchResults?.trains || []) as any[]) add(t, 'SEARCH_TRAINS', true);
  for (const v of views) if (v.ok && v.toolName === 'SEARCH_TRAINS' && !sx.searchResults?.trains?.length) for (const t of (v.data?.trains || []) as any[]) add(t, 'SEARCH_TRAINS', true);
  if (sx.selectedTrain) add(sx.selectedTrain, 'SESSION');
  if (sx.lastTrainInfo) add(sx.lastTrainInfo, 'GET_TRAIN_INFO');
  for (const v of views) if (v.ok && v.toolName === 'GET_TRAIN_INFO' && v.data) add(v.data, 'GET_TRAIN_INFO');

  // Part 5 — fares come from GET_FARE (session quote / this turn) and the verified review snapshot only
  const fares: FareFact[] = [];
  const pushFare = (f: FareFact | null) => { if (f) fares.push(f); };
  if (sx.fare) pushFare(fareFact(sx.fare, 'GET_FARE', sx.fare.toolExecutionId ? String(sx.fare.toolExecutionId) : null));
  for (const v of views) if (v.ok && v.toolName === 'GET_FARE') pushFare(fareFact(v.data, 'GET_FARE', v.identity?.resultId ? String(v.identity.resultId) : v.callId ? String(v.callId) : null, v.identity));
  const snap: any = sx.review?.snapshot;
  if (snap?.fare && (snap.fare.status === undefined || snap.fare.status === 'VERIFIED')) {
    pushFare(fareFact({ ...snap.fare, trainNumber: snap.fare.trainNumber ?? snap.trainNumber ?? snap.train?.number, travelClass: snap.fare.travelClass ?? snap.travelClass, passengersCount: snap.fare.passengersCount ?? snap.passengersCount }, 'REVIEW', null));
  }
  const sessionPax = new Set<number>([sx.passengersCount, (sx.passengers || []).length || undefined, snap?.passengersCount].filter((n: any): n is number => typeof n === 'number' && n > 0));
  const farePax = new Set<number>(fares.map(f => f.pax).filter((n): n is number => typeof n === 'number' && n > 0));
  return { trains, searchTrains, fares, sessionPax, farePax };
}

// ---------------------------------------------------------------- claim helpers

const GENERIC_NAME_WORDS = new Set(['express', 'exp', 'mail', 'superfast', 'sf', 'special', 'passenger', 'train', 'the']);
const norm = (x: string) => ` ${x.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;

/** Trains a sentence talks about: by number, or by a distinctive name phrase / keyword that identifies ONE train. */
export function trainsIn(t: string, idx: FactIndex): TrainFact[] {
  const out = new Map<string, TrainFact>();
  const byNum = new Map<string, TrainFact>();
  for (const x of idx.trains) if (!byNum.has(x.num)) byNum.set(x.num, x);   // provider result first (provenance)
  for (const m of t.match(/\b\d{4,5}\b/g) || []) { const f = byNum.get(m); if (f) out.set(f.num, f); }
  if (out.size) return [...out.values()];
  const nt = norm(t);
  const uniq = [...byNum.values()];
  for (const f of uniq) {
    const words = norm(f.name).trim().split(' ').filter(w => w && !GENERIC_NAME_WORDS.has(w));
    if (words.length && nt.includes(` ${words.join(' ')} `)) out.set(f.num, f);
  }
  if (out.size) return [...out.values()];
  for (const kw of ['shatabdi', 'rajdhani', 'duronto', 'vande bharat', 'garib rath', 'humsafar', 'tejas', 'intercity', 'jan shatabdi', 'shan e punjab']) {
    if (!nt.includes(` ${kw} `)) continue;
    const hits = uniq.filter(f => norm(f.name).includes(` ${kw} `));
    if (hits.length === 1) out.set(hits[0].num, hits[0]);
  }
  return [...out.values()];
}

export const TIME_RE = /(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/g;
const ARR_VERB = /\b(pahunch\w*|pahuch\w*|arriv\w*|reach\w*|aati hai|aayegi)\b/i;
const DEP_VERB = /\b(nikal\w*|chal(ti|ta|egi|ega|te)\b|depart\w*|leav\w*|chhoot\w*|chhut\w*|chut\w*|start\w*|rawana|shuru)\b/i;
const TIMETABLE_HINT = /\b(train|trains|trainein|gaadi|gadi|gaadiyan|journey|safar|shatabdi|rajdhani|duronto|vande bharat|garib rath|humsafar|tejas|intercity|express|mail)\b/i;

export interface TimeVerdict { reason: string | null; validated: string[]; general: string[]; fact?: TrainFact; fields: string[] }

/**
 * Part 3 — times as STRUCTURED claims. A time said with a train must be that train's departure / arrival (the verb
 * decides which); a time without a train must belong to the result set when the sentence is about trains / journeys;
 * a time in a general explanation (e.g. when Tatkal opens) is general knowledge.
 */
export function judgeTimes(t: string, idx: FactIndex, strict = false): TimeVerdict {
  const times = [...t.matchAll(TIME_RE)].map(m => ({ raw: m[0], v: `${m[1].padStart(2, '0')}:${m[2]}` }));
  const out: TimeVerdict = { reason: null, validated: [], general: [], fields: [] };
  if (!times.length) return out;
  const mentioned = trainsIn(t, idx);
  const arrOnly = ARR_VERB.test(t) && !DEP_VERB.test(t);
  const depOnly = DEP_VERB.test(t) && !ARR_VERB.test(t);
  // Bug-fix pass (Bug 4): a clock time in a general explanation (no train, station, train movement or live context —
  // e.g. when Tatkal booking opens) is general knowledge, even if the explanation says "train" generically
  const generalCtx = !strict && !mentioned.length && isGeneralTimeContext(t, idx);
  const timetableish = strict || mentioned.length > 0 || (!generalCtx && (TIMETABLE_HINT.test(t) || ARR_VERB.test(t) || DEP_VERB.test(t)));
  const all = new Set(idx.trains.flatMap(f => [f.dep, f.arr]).filter(Boolean) as string[]);
  for (const x of times) {
    if (mentioned.length) {
      const ok = mentioned.find(f => (arrOnly ? [f.arr] : depOnly ? [f.dep] : [f.dep, f.arr]).includes(x.v));
      if (!ok) { out.reason = mentioned.length === 1 ? `TIME_MISMATCH:${mentioned[0].num}@${x.v}` : `TIME_MISMATCH:${x.v}`; return out; }
      out.validated.push(x.raw); out.fact = ok; out.fields.push(ok.arr === x.v && !depOnly ? 'arrival' : 'departure');
    } else if (timetableish) {
      if (!all.has(x.v)) { out.reason = 'UNGROUNDED_TIME'; return out; }
      out.validated.push(x.raw); out.fields.push('time');
    } else out.general.push(x.raw);
  }
  return out;
}

const FIRST_RE = /\b(sabse pehle|sabse jaldi|earliest|first)\b/i;
const FASTEST_RE = /\b(sabse (tez|fast|kam time)|fastest|quickest|shortest (journey|travel|duration))\b/i;
const arrivalAbs = (f: TrainFact): number | undefined => {
  const d = minutesOf(f.dep); const a = minutesOf(f.arr);
  if (d !== undefined && f.durMin !== undefined) return d + f.durMin;
  if (d !== undefined && a !== undefined) return a < d ? a + 1440 : a;
  return a;
};
const durationOf = (f: TrainFact): number | undefined => { const d = minutesOf(f.dep); const a = arrivalAbs(f); return f.durMin ?? (d !== undefined && a !== undefined ? a - d : undefined); };

/** Part 3 — "12014 sabse pehle pahunchti hai" is checked against the result set (arrival / departure / duration). */
export function judgeComparison(t: string, idx: FactIndex): string | null {
  const set = idx.searchTrains;
  if (set.length < 2) return null;
  const said = trainsIn(t, idx).filter(f => set.some(x => x.num === f.num));
  if (said.length !== 1) return null;
  const pick = (val: (f: TrainFact) => number | undefined): string | null => {
    const vals = set.map(f => [f.num, val(f)] as const).filter(([, v]) => v !== undefined) as Array<readonly [string, number]>;
    if (vals.length < 2) return null;
    const best = Math.min(...vals.map(([, v]) => v));
    return vals.some(([n, v]) => n === said[0].num && v === best) ? null : `COMPARISON_MISMATCH:${said[0].num}`;
  };
  if (FASTEST_RE.test(t)) return pick(durationOf);
  if (FIRST_RE.test(t) && ARR_VERB.test(t)) return pick(arrivalAbs);
  if (FIRST_RE.test(t) && DEP_VERB.test(t)) return pick(f => minutesOf(f.dep));
  return null;
}

// ---- Part 4: CLASS_LIST ≠ SEAT_AVAILABILITY ----
const CLASS_CODE_RE = /\b(1A|2A|3A|3E|CC|EC|SL|2S|FC|EA)\b/g;
const SEAT_RE = /\b(seats?|berths?|khaali|khali|confirm(ed)?|cnf|avl\s*\d|wl|rac|waiting|waitlist|bhari|full|sold out|mil (jayegi|jaegi|jaayegi|jaati)|tickets? (available|mil))\b/i;
export function isClassListClaim(t: string): boolean {
  // Prompt 26: only an ENUMERATION of classes is a class list; "12014 mein CC available hai" is a seat claim
  return isClassEnumeration(t) && !SEAT_RE.test(t);
}
/** "CC aur 2S available hain" → "CC aur 2S classes listed hain"; "CC and 2S are available" → "CC and 2S classes are listed". */
export function repairClassList(t: string): string {
  return t.replace(/\b(classes?\s+)?(are\s+|is\s+)?available\b/i, (_m, _c, be) => (be ? `classes ${String(be).trim() === 'is' ? 'is' : 'are'} listed` : 'classes listed'));
}
export function judgeClassList(t: string, idx: FactIndex): string | null {
  const said = trainsIn(t, idx);
  const codes = [...new Set(t.match(CLASS_CODE_RE) || [])];
  const allowed = new Set((said.length ? said : idx.trains).flatMap(f => f.classes));
  if (!allowed.size) return null;
  for (const c of codes) if (!allowed.has(c)) return `CLASS_NOT_LISTED:${c}`;
  return null;
}

// ---- Part 5: fares scoped to GET_FARE (train, class, passenger context, amount) ----
const PER_PAX_RE = /\b(per (passenger|person|head|ticket)|prati (yatri|vyakti)|har (passenger|yatri)|each|ek passenger|1 passenger|per seat)\b/i;
const TOTAL_RE = /\b(total|kul|sab mila(ke|kar)|overall|in total|altogether)\b/i;
export function judgeFareScope(t: string, idx: FactIndex): { reason: string | null; fact?: FareFact } {
  const amounts = [...t.matchAll(/(?:₹|\brs\.?\s?|\binr\s?)\s?([\d,]+(?:\.\d+)?)/gi)].map(m => Number(m[1].replace(/,/g, '')));
  if (!amounts.length || !idx.fares.length) return { reason: null };
  const trains = trainsIn(t, idx).map(f => f.num);
  const classes = [...new Set(t.match(CLASS_CODE_RE) || [])];
  // Prompt 28: a date said in the claim must be the fare's date (a fare for another date never applies)
  const cd = claimedDate(t);
  const entityOk = (f: FareFact) => (!trains.length || !f.train || trains.includes(f.train)) && (!classes.length || !f.cls || classes.includes(f.cls));
  const scoped = idx.fares.filter(f => entityOk(f) && (!cd || !f.date || f.date === cd));
  let fact: FareFact | undefined;
  for (const n of amounts) {
    const per = PER_PAX_RE.test(t); const tot = TOTAL_RE.test(t);
    const amountOk = (f: FareFact) => (per && !tot ? f.perPassenger === n : tot && !per ? f.total === n || (f.pax === 1 && f.perPassenger === n) : f.perPassenger === n || f.total === n);
    const hit = scoped.find(amountOk);
    if (!hit) return { reason: cd && idx.fares.some(f => entityOk(f) && amountOk(f)) ? `CROSS_DATE_FACT:${cd}` : `FARE_MISMATCH:${n}` };
    fact = hit;
  }
  return { reason: null, fact };
}

// ---- Part 2: passenger counts are context-aware ----
const SESSIONISH_RE = /\b(aapk[eia]|aapne|your|you have|you're|ke liye|for (you|your|the|this)|booking|ticket|tickets|travel(l)?ing|ja rahe|jaa rahe|safar kar|add (ho|kar)|added|hain aapke)\b/i;
const FARE_CTX_RE = /(₹|\bfare\b|\bkiraya\b|\btotal\b|\bprice\b|\bcost\b|\bamount\b|\bquote\b)/i;
const GENERALISH_RE = /\b(berth share|share kar\w*|ek berth|rac|sakte|sakta|can|could|usually|generally|normally|typically|aam taur|matlab|means|maximum|max|tak (book|ho)|up ?to|limit|ek pnr|per pnr|ek ticket mein|har pnr|rule|niyam)\b/i;
export type PaxClass = 'USER_PROVIDED' | 'TOOL_DERIVED_FACT' | 'GENERAL_KNOWLEDGE' | 'SESSION_FACT';
export function classifyPaxCount(t: string, n: number, word: string, userText: string): PaxClass {
  const u = ` ${userText.toLowerCase()} `;
  if (new RegExp(`(?<![\\d])${n}(?![\\d])`).test(userText) || u.includes(` ${word.toLowerCase()} `)) return 'USER_PROVIDED';
  if (FARE_CTX_RE.test(t) || PER_PAX_RE.test(t)) return 'TOOL_DERIVED_FACT';
  if (GENERALISH_RE.test(t) && !/\b(aapk[eia]|your)\b/i.test(t)) return 'GENERAL_KNOWLEDGE';
  return 'SESSION_FACT';
}
/** true when "N passenger(s)" is a statement about THIS session / quote rather than a bare count (fare per head etc.). */
export const isSessionish = (t: string) => SESSIONISH_RE.test(t);

// ---- Part 6: train counts derived from the result set (incl. time-of-day subsets) ----
const BUCKETS: Array<[RegExp, number, number]> = [
  [/\b(subah|morning|savere)\b/i, 4 * 60, 12 * 60 - 1],
  [/\b(dopahar|afternoon)\b/i, 12 * 60, 16 * 60 - 1],
  [/\b(shaam|sham|evening)\b/i, 16 * 60, 20 * 60 - 1],
  [/\b(raat|night)\b/i, 20 * 60, 28 * 60 - 1]
];
export function derivedTrainCounts(t: string, idx: FactIndex): number[] {
  const out: number[] = [];
  const set = idx.searchTrains;
  for (const [re, lo, hi] of BUCKETS) if (re.test(t)) out.push(set.filter(f => { let d = minutesOf(f.dep); if (d === undefined) return false; if (d < 4 * 60) d += 1440; return d >= lo && d <= hi; }).length);
  for (const c of new Set(t.match(CLASS_CODE_RE) || [])) out.push(set.filter(f => f.classes.includes(c)).length);
  return out;
}

// ---- Part 1: general-knowledge / explanation / action classification ----
const EXPLAIN_RE = /\b(khulti hai|khulta hai|banta hai|banti hai|matlab|means|mean|hota hai|hoti hai|hote hain|karte hain|karti hai|karta hai|padta hai|padti hai|sakte hain|sakta hai|generally|usually|normally|typically|aam taur|kehte hain|is called|rule|niyam|jab|agar|if|when)\b/i;
const OPINION_RE = /\b(best|accha|achha|behtar|recommend|suggest|lagta|i think|prefer|comfortable|aaramdayak|aaram)\b/i;
const ACTION_RE = /\b(nahi kar (sakta|sakti|sakte)|can't|cannot|can not|main (check|search|dekh|select|add|update|book)\w*|let me|i'll|i will|maine \w+|kar raha hoon|kar rahi hoon|kar diya|kar di|kar li|le liya|le li|rakh li|rakh liya)\b/i;
const ANCHOR_RE = /\b\d{4,5}\b|₹|\brs\.?\s*\d|\b(aaj|today|kal|tomorrow|parso|parson)\b|\b(1A|2A|3A|3E|CC|EC|SL|2S|FC|EA)\b|\b(aapk[eia] (booking|ticket|journey|train|seat|passengers?)|your (booking|ticket|journey|train|seat|passengers?)|selected|select ki|chuni|is train|yeh train|ye train|this train)\b/i;

/** A sentence that explains how railways work (no specific train / class / date / fare / session anchor). */
export function isGeneralKnowledgeClaim(t: string, idx: FactIndex): boolean {
  if (ANCHOR_RE.test(t) || trainsIn(t, idx).length) return false;
  if (/\b\d+\s*(trains?|trainein|gaadiyan)\b/i.test(t)) return false;
  return EXPLAIN_RE.test(t) || OPINION_RE.test(t);
}

/**
 * Prompt 34 follow-up — FARE AUTHORITY (one rule for TEXT and VOICE). A ₹ / Rs / INR amount written by the LLM is a
 * fare claim; it is valid ONLY when matching successful GET_FARE-derived data exists in the fact index (this turn's
 * successful GET_FARE, the session's committed GET_FARE quote, or the verified review snapshot) for the claimed
 * train / class / date. A failed / malformed / timed-out GET_FARE contributes nothing (only `ok` views are indexed),
 * search-result fixture fares are never fare authority, and the LLM's own words can never ground themselves.
 * Returns null (valid / no fare claim) or a rejection reason.
 */
const FARE_AMOUNT_RE = /(?:₹|\brs\.?\s?|\binr\s?)\s?([\d,]+(?:\.\d+)?)/gi;
export function judgeFareAuthority(t: string, idx: FactIndex): string | null {
  const amounts = [...String(t || '').matchAll(FARE_AMOUNT_RE)].map(m => Number(m[1].replace(/,/g, ''))).filter(n => Number.isFinite(n));
  if (!amounts.length) return null;
  if (!idx.fares.length) return `UNVERIFIED_FARE:${amounts[0]}`;
  return judgeFareScope(t, idx).reason;
}

export function classifyClaim(t: string, idx: FactIndex, hits: { time?: TimeVerdict; fare?: FareFact; classList?: boolean; pax?: PaxClass; avail?: AvailabilityEvidence; userAvail?: boolean; count?: boolean }, general: boolean): ClaimProvenance {
  const prov = (claimType: ClaimType, sourceTool: string | null = null, sourceResultId: string | null = null, fields: string[] = []): ClaimProvenance => ({ claimType, sourceTool, sourceResultId, fields });
  if (hits.fare) return prov('TOOL_DERIVED_FACT', hits.fare.source, hits.fare.resultId, ['fare', ...(hits.fare.train ? ['trainNumber'] : []), ...(hits.fare.cls ? ['travelClass'] : [])]);
  if (hits.avail) {
    const e = hits.avail;
    return { ...prov('RAILWAY_LIVE_FACT', e.sourceTool, e.sourceResultId, ['availability', 'trainNumber', 'date', 'travelClass']),
      factSubtype: 'SEAT_AVAILABILITY', verified: true, trainNumber: e.trainNumber, date: e.date, travelClass: e.travelClass, availability: e.status };
  }
  if (hits.userAvail) return { ...prov('USER_PROVIDED', null, null, ['availability']), factSubtype: 'SEAT_AVAILABILITY', verified: false };
  if (hits.time?.fact) return prov('TOOL_DERIVED_FACT', hits.time.fact.source, hits.time.fact.resultId, ['trainNumber', ...hits.time.fields]);
  if (hits.time?.validated.length) return prov('TOOL_DERIVED_FACT', 'SEARCH_TRAINS', null, hits.time.fields);
  if (hits.classList) { const f = trainsIn(t, idx)[0]; return prov('TOOL_DERIVED_FACT', f?.source || 'SEARCH_TRAINS', f?.resultId ?? null, ['classes']); }
  if (hits.count) return prov('TOOL_DERIVED_FACT', 'SEARCH_TRAINS', null, ['resultCount']);
  if (hits.pax === 'USER_PROVIDED') return prov('USER_PROVIDED', null, null, ['passengersCount']);
  if (hits.pax === 'SESSION_FACT') return prov('SESSION_FACT', 'BOOKING_SESSION', null, ['passengersCount']);
  const said = trainsIn(t, idx);
  if (said.length) return prov('TOOL_DERIVED_FACT', said[0].source, said[0].resultId, ['trainNumber']);
  if (ACTION_RE.test(t)) return prov('ACTION_STATEMENT');
  if (OPINION_RE.test(t) && !EXPLAIN_RE.test(t)) return prov('OPINION_OR_EXPLANATION');
  if (general || isGeneralKnowledgeClaim(t, idx)) return prov('GENERAL_KNOWLEDGE');
  return prov('OPINION_OR_EXPLANATION');
}

// ---- Bug-fix pass (Bug 4): general clock times vs railway timing facts ----
/** Specific train services (a named service is a specific-train claim, unlike the generic noun "train"). */
const NAMED_SERVICE_RE = /\b(shatabdi|rajdhani|duronto|vande bharat|garib rath|humsafar|tejas|intercity|express|mail|superfast|passenger train|memu|demu|local)\b/i;
/** A train MOVING at that time (departure / arrival / running) — the time is then a timetable or live fact. */
const MOTION_RE = /\b(pahunch\w*|pahuch\w*|arriv\w*|reach\w*|aati hai|aayegi|aata hai|aayega|nikal\w*|chal(ti|ta|egi|ega|te|ti hain)\b|depart\w*|leav\w*|chhoot\w*|chhut\w*|chut(ti|ta|egi)\b|rawana|ruk(ti|ta|egi|ega)\b|halt\w*|stop(s|ped)?\b)/i;
/** Live running context. */
const LIVE_CTX_RE = /\b(platform|late|delay\w*|der se|eta|expected|running|live|abhi kahan)\b/i;
/** Date nouns built on a movement word ("departure date", "journey date") name a DATE, not a train movement. */
const DATE_NOUN_RE = /\b(departure|journey|boarding|travel|yatra|safar)\s+(date|din|tareekh|tarikh|tithi|se ek din|ke din)\b/gi;
const stationWordRe = (() => {
  const keys = Object.keys(STATION_ALIASES).filter(k => k.length >= 4).sort((a, b) => b.length - a.length).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return keys.length ? new RegExp(`\\b(${keys.join('|')})\\b`, 'i') : null;
})();

/**
 * true when the clock times of sentence `t` belong to a GENERAL explanation ("Tatkal booking AC ke liye 10:00 baje khulti
 * hai") rather than a railway timing fact. Never true when the sentence names a specific train (number, known name,
 * named service, "is train"), a station, a train movement (departs / arrives / runs / halts) or a live-running context
 * (platform / late / delay / ETA) — those timing claims stay protected by the timetable / live guards.
 */
export function isGeneralTimeContext(t: string, idx: FactIndex): boolean {
  if (/\b\d{4,5}\b/.test(t) || trainsIn(t, idx).length) return false;
  if (NAMED_SERVICE_RE.test(t) || LIVE_CTX_RE.test(t)) return false;
  if (MOTION_RE.test(t.replace(DATE_NOUN_RE, ' '))) return false;
  if (stationWordRe && stationWordRe.test(t)) return false;
  return isGeneralKnowledgeClaim(t, idx);
}
