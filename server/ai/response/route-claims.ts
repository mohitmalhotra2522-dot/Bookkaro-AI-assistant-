/**
 * Bug-fix pass (Bug 3) — ROUTE / STATION claims as structured facts.
 *
 * A sentence that says something about WHERE a specific train goes — runs between / from / to, serves / stops at,
 * station order (before / after), origin, destination, passes through, or the negation of any of these — is a railway
 * fact. It is supported ONLY by authoritative data of this session / turn:
 *   - a provider timetable (GET_TIMETABLE, or GET_TRAIN_INFO's timetable): ordered halts, first = origin, last = terminus
 *   - GET_TRAIN_INFO's origin / destination
 *   - a SEARCH_TRAINS row: the train serves the searched segment in that direction (from before to)
 * Nothing else (no LLM knowledge, no web data). A NEGATIVE claim ("X pe nahi rukti", "Ludhiana se koi Shatabdi nahi
 * chalti") needs the complete halt list. An unverifiable or contradicted claim is rejected (ROUTE_CLAIM:<kind>); the
 * existing one-shot fact-authority recovery / honest fallback then applies — no replacement fact is ever invented.
 *
 * Detection is structural, not a phrase list: (train reference) + (station mention resolved against the session's own
 * station names / codes or the station dictionary) + (a closed-class topology marker of Hinglish / English grammar).
 */
import type { BookingSession } from '@shared/entities';
import { STATION_ALIASES } from '@shared/constants';

type Step = { status: string; result: { toolName: string; data?: any }; validatedArguments?: any; toolCall?: any };

interface TrainRoute {
  /** Ordered halts (station codes) when a provider timetable is known. */
  stops?: string[];
  origin?: string;
  terminus?: string;
  /** Directed segments this train is known to serve (search rows). */
  segments: Array<[string, string]>;
  name?: string;
}

export interface RouteFacts {
  trains: Map<string, TrainRoute>;
  /** normalized station name / code → station code */
  names: Map<string, string>;
  focus?: string;
}

const norm = (v: any) => ` ${String(v ?? '').toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const code = (v: any): string | undefined => { const s = String(v ?? '').trim().toUpperCase(); return /^[A-Z]{2,6}$/.test(s) ? s : undefined; };
const num = (v: any): string | undefined => { const s = String(v ?? '').trim(); return /^\d{4,5}$/.test(s) ? s : undefined; };
/** Words of a station name that do not identify it ("Ludhiana Junction" ≈ "Ludhiana"). */
const STATION_SUFFIX = /\b(junction|jn|jct|cantt|cantonment|city|terminal|terminus|central|railway station|station|halt|road)\b/g;

function addName(names: Map<string, string>, name: any, c: string | undefined) {
  if (!c) return;
  names.set(c.toLowerCase(), c);
  const n = norm(name).trim();
  if (!n || n.length < 3) return;
  if (!names.has(n)) names.set(n, c);
  const core = n.replace(STATION_SUFFIX, ' ').replace(/\s+/g, ' ').trim();
  if (core.length >= 4 && !names.has(core)) names.set(core, c);
}

function stopsOf(arr: any): Array<{ code: string; name?: string }> | null {
  if (!Array.isArray(arr) || !arr.length) return null;
  const out: Array<{ code: string; name?: string }> = [];
  for (const x of arr) {
    const c = code(x?.station ?? x?.stationCode ?? x?.code);
    if (!c) return null;
    out.push({ code: c, name: x?.stationName ?? x?.name });
  }
  return out.length >= 2 ? out : null;
}

export function collectRouteFacts(session: BookingSession | any, steps: Step[] = []): RouteFacts {
  const s: any = session || {};
  const trains = new Map<string, TrainRoute>();
  const names = new Map<string, string>();
  const get = (n: string) => { let t = trains.get(n); if (!t) { t = { segments: [] }; trains.set(n, t); } return t; };
  for (const [k, v] of Object.entries(STATION_ALIASES)) { if (k.length >= 3) names.set(norm(k).trim(), v.code); addName(names, v.name, v.code); }

  const timetable = (n: string | undefined, arr: any) => {
    const st = n && stopsOf(arr);
    if (!n || !st) return;
    const t = get(n);
    t.stops = st.map(x => x.code); t.origin = st[0].code; t.terminus = st[st.length - 1].code;
    for (const x of st) addName(names, x.name, x.code);
  };
  const info = (d: any) => {
    const n = num(d?.trainNumber ?? d?.number);
    if (!n) return;
    const t = get(n);
    if (d.trainName) t.name = String(d.trainName);
    // GET_TRAIN_INFO origin / destination are the train's own end points (not a searched segment)
    const o = code(d.origin); const de = code(d.destination);
    if (o && !t.origin) t.origin = o;
    if (de && !t.terminus) t.terminus = de;
    addName(names, d.originName, o); addName(names, d.destinationName, de);
    timetable(n, d.timetable);
  };
  const search = (data: any) => {
    const j = data?.journey || {};
    addName(names, j.originName, code(j.origin)); addName(names, j.destinationName, code(j.destination));
    for (const r of (data?.trains || []) as any[]) {
      const n = num(r?.trainNumber ?? r?.number);
      if (!n) continue;
      const t = get(n);
      if (r.trainName) t.name = String(r.trainName);
      // a search row = the train serves the SEARCHED segment in that direction (and the row's own end points)
      for (const [a, b] of [[code(j.origin), code(j.destination)], [code(r.origin), code(r.destination)]])
        if (a && b && a !== b && !t.segments.some(([x, y]) => x === a && y === b)) t.segments.push([a, b]);
    }
  };

  if (s.searchResults) search(s.searchResults);
  if (s.lastTrainInfo) info(s.lastTrainInfo);
  timetable(num(s.focusTrainNumber), s.lastTimetable);
  for (const st of steps) {
    if (st.status !== 'ok') continue;
    const tool = st.result.toolName; const d = st.result.data;
    if (tool === 'SEARCH_TRAINS') search(d);
    else if (tool === 'GET_TRAIN_INFO') info(d);
    else if (tool === 'GET_TIMETABLE') timetable(num(st.validatedArguments?.trainNumber ?? st.toolCall?.arguments?.trainNumber ?? d?.trainNumber), Array.isArray(d) ? d : d?.stops ?? d?.timetable);
  }
  const sel = s.selectedTrain;
  if (sel) { const n = num(sel.trainNumber ?? sel.number); if (n && sel.trainName) get(n).name = String(sel.trainName); }
  return { trains, names, focus: num(s.focusTrainNumber) || num(sel?.trainNumber ?? sel?.number) };
}

// ---- closed-class topology grammar (Hinglish + English) ----
const NEG = /\b(nahi|nahin|nhi|not|never|doesn'?t|don'?t|isn'?t|aren'?t|won'?t)\b/i;
const STOP = /\b(ruk\w*|stop\w*|halt\w*|thehar\w*|thahar\w*|thehr\w*|stoppage)\b/i;
const ORIGIN = /\b(shuru|starts?|starting|originat\w*|origin|source)\b/i;
const TERMINUS = /\b(khatam|terminat\w*|ends?|ending|destination|antim|aakhri|last stop|last station)\b/i;
const RUN = /\b(chal\w*|run\w*|jaati|jati|jaata|jata|jaate|jaayegi|jayegi|goes|go|going|pass\w*|guzar\w*|through|via|hoke|hokar|hote hue|route|serve\w*|connect\w*|between|ke beech)\b/i;
const ORDER_HI = /^\s*(se|ke|ki)\s+(pehle|pahle|baad)\b/i;
const ORDER_EN_BEFORE = /\b(before|after)\s*$/i;
const ORDER_ANY = /\b(pehle|pahle|baad|before|after|aage|peeche|pichhe)\b/i;
const DEICTIC = /\b(is|isi|ye|yeh|yahi|wahi|woh|wo|us|usi|this|that|same)\s+(train|gaadi|gadi)\b|\b(isme|ismein|is mein|isi mein|usme|usmein|us mein|iske|iski|uske|uski)\b|\bit (stops|halts|runs|goes|starts|ends|terminates|reaches|passes)\b/i;
const SERVICE_KW = ['shatabdi', 'shtabdi', 'rajdhani', 'duronto', 'vande bharat', 'garib rath', 'humsafar', 'tejas', 'intercity', 'jan shatabdi', 'express', 'mail', 'superfast'];
const GENERIC_NAME = new Set(['express', 'exp', 'mail', 'superfast', 'sf', 'special', 'spl', 'jn', 'junction']);

interface Mention { code: string; start: number; end: number }

function stationsIn(t: string, facts: RouteFacts): Mention[] {
  const out: Mention[] = [];
  const low = t.toLowerCase();
  const taken: Array<[number, number]> = [];
  const keys = [...facts.names.keys()].filter(k => k.length >= 3).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const isCode = /^[a-z]{2,6}$/.test(k) && facts.names.get(k)!.toLowerCase() === k;
    const re = isCode ? new RegExp(`\\b${k.toUpperCase()}\\b`, 'g') : new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}\\b`, 'gi');
    for (const m of (isCode ? t : low).matchAll(re)) {
      const a = m.index!; const b = a + m[0].length;
      // a one-word name counts only as a proper noun ("Gaya", not "gaya" = went)
      if (!isCode && !k.includes(' ') && !/^[A-Z]/.test(t.slice(a, a + 1))) continue;
      if (taken.some(([x, y]) => a < y && b > x)) continue;
      taken.push([a, b]); out.push({ code: facts.names.get(k)!, start: a, end: b });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Trains the sentence is about: explicit numbers, a known train's distinctive name / service keyword, or "is train". */
function trainsOf(t: string, facts: RouteFacts): { nums: string[]; serviceOnly: boolean } {
  const nums = [...new Set(t.match(/\b\d{4,5}\b/g) || [])].filter(n => facts.trains.has(n));
  if (nums.length) return { nums, serviceOnly: false };
  const nt = norm(t);
  const byName: string[] = [];
  for (const [n, r] of facts.trains) {
    if (!r.name) continue;
    const words = norm(r.name).trim().split(' ').filter(w => w && !GENERIC_NAME.has(w));
    if (words.length && nt.includes(` ${words.join(' ')} `)) byName.push(n);
  }
  if (byName.length) return { nums: byName, serviceOnly: false };
  const kw = SERVICE_KW.filter(k => nt.includes(` ${k} `));
  if (kw.length) {
    const hits = [...facts.trains].filter(([, r]) => r.name && kw.some(k => norm(r.name).includes(` ${k} `) || (k === 'shatabdi' && norm(r.name).includes(' shtabdi ')))).map(([n]) => n);
    return { nums: hits, serviceOnly: true };
  }
  if (DEICTIC.test(t) && facts.focus) return { nums: [facts.focus], serviceOnly: false };
  return { nums: [], serviceOnly: false };
}

type Kind = 'ORDER' | 'STOP' | 'ORIGIN' | 'TERMINUS' | 'RUN';
type Verdict = 'SUPPORTED' | 'CONTRADICTED' | 'UNKNOWN';

const serves = (r: TrainRoute, c: string): Verdict => {
  if (r.stops) return r.stops.includes(c) ? 'SUPPORTED' : 'CONTRADICTED';
  if (r.origin === c || r.terminus === c || r.segments.some(([a, b]) => a === c || b === c)) return 'SUPPORTED';
  return 'UNKNOWN';
};
/** a before b on this train's route */
const before = (r: TrainRoute, a: string, b: string): Verdict => {
  if (r.stops) { const i = r.stops.indexOf(a); const j = r.stops.indexOf(b); if (i < 0 || j < 0) return 'UNKNOWN'; return i < j ? 'SUPPORTED' : 'CONTRADICTED'; }
  if (r.segments.some(([x, y]) => x === a && y === b)) return 'SUPPORTED';
  if (r.segments.some(([x, y]) => x === b && y === a)) return 'CONTRADICTED';
  return 'UNKNOWN';
};
const flip = (v: Verdict): Verdict => (v === 'SUPPORTED' ? 'CONTRADICTED' : v === 'CONTRADICTED' ? 'SUPPORTED' : 'UNKNOWN');

/** Order relation(s) "S is before / after R" stated in the sentence: Hinglish "S, R se pehle", English "S before R". */
function orderPairs(t: string, st: Mention[]): Array<{ s: string; r: string; rel: 'before' | 'after' }> {
  const out: Array<{ s: string; r: string; rel: 'before' | 'after' }> = [];
  for (let i = 0; i < st.length; i++) {
    const after = t.slice(st[i].end, st[i].end + 16);
    const m = ORDER_HI.exec(after);
    if (m) {
      const other = st.find((x, j) => j !== i && x.code !== st[i].code);
      if (other) out.push({ s: other.code, r: st[i].code, rel: /baad/i.test(m[2]) ? 'after' : 'before' });
      continue;
    }
    const prev = t.slice(Math.max(0, st[i].start - 12), st[i].start);
    const e = ORDER_EN_BEFORE.exec(prev);
    if (e) {
      const other = [...st].reverse().find((x, j) => x.start < st[i].start && x.code !== st[i].code) || st.find(x => x.code !== st[i].code);
      if (other) out.push({ s: other.code, r: st[i].code, rel: /after/i.test(e[1]) ? 'after' : 'before' });
    }
  }
  return out;
}

function judgeOne(r: TrainRoute, kind: Kind, t: string, st: Mention[], neg: boolean): Verdict {
  const codes = [...new Set(st.map(x => x.code))];
  switch (kind) {
    case 'ORDER': {
      const pairs = orderPairs(t, st);
      if (!pairs.length) return 'UNKNOWN';
      let v: Verdict = 'SUPPORTED';
      for (const p of pairs) {
        const b = p.rel === 'before' ? before(r, p.s, p.r) : before(r, p.r, p.s);
        const x = neg ? flip(b) : b;
        if (x !== 'SUPPORTED') { v = x; break; }
      }
      return v;
    }
    case 'ORIGIN': case 'TERMINUS': {
      const end = kind === 'ORIGIN' ? r.origin : r.terminus;
      if (!end) return 'UNKNOWN';
      const hit = codes.includes(end);
      return (neg ? !hit : hit) ? 'SUPPORTED' : 'CONTRADICTED';
    }
    case 'STOP': case 'RUN': {
      if (neg) {
        // "X pe nahi rukti" / "X se nahi chalti": only a COMPLETE halt list can prove an absence
        if (!r.stops) return 'UNKNOWN';
        return codes.every(c => !r.stops!.includes(c) || (kind === 'RUN' && c === r.terminus && /\bse\b|\bfrom\b/i.test(t))) ? 'SUPPORTED' : 'CONTRADICTED';
      }
      for (const c of codes) { const v = serves(r, c); if (v !== 'SUPPORTED') return v; }
      // "A se B" / "from A to B": direction must hold where it is known
      if (kind === 'RUN' && st.length >= 2 && st[0].code !== st[st.length - 1].code) {
        const b = before(r, st[0].code, st[st.length - 1].code);
        if (b === 'CONTRADICTED' && /\b(se|from)\b/i.test(t)) return 'CONTRADICTED';
      }
      return 'SUPPORTED';
    }
  }
}

/**
 * Judge one sentence. Returns null when it makes no route / station claim about a specific train, or the claim is
 * supported by authoritative data; otherwise `ROUTE_CLAIM:<KIND>`.
 */
export function judgeRouteClaim(t: string, facts: RouteFacts): string | null {
  if (!t || !/[a-zऀ-ॿ]/i.test(t)) return null;
  const st = stationsIn(t, facts);
  if (!st.length) return null;
  const { nums, serviceOnly } = trainsOf(t, facts);
  const deictic = DEICTIC.test(t);
  if (!nums.length && !serviceOnly && !deictic) return null;          // not about a specific train
  const neg = NEG.test(t);
  const kinds: Kind[] = [];
  if (ORDER_ANY.test(t) && orderPairs(t, st).length) kinds.push('ORDER');
  else if (ORDER_ANY.test(t) && /\bstations?\b/i.test(t) && st.length) kinds.push('ORDER');   // order claim with an unresolved station
  if (ORIGIN.test(t)) kinds.push('ORIGIN');
  if (TERMINUS.test(t)) kinds.push('TERMINUS');
  if (STOP.test(t)) kinds.push('STOP');
  if (!kinds.length && RUN.test(t)) kinds.push('RUN');
  if (!kinds.length) return null;
  const routes = nums.map(n => facts.trains.get(n)).filter(Boolean) as TrainRoute[];
  for (const kind of kinds) {
    if (!routes.length) return `ROUTE_CLAIM:${kind}`;               // a train we hold no route data for
    const vs = routes.map(r => judgeOne(r, kind, t, st, neg));
    // a negative / existential claim about a service ("koi Shatabdi nahi") must hold for EVERY matching train;
    // a positive claim about a named train must hold for it (any one of several same-named candidates)
    const ok = neg || serviceOnly ? vs.every(v => v === 'SUPPORTED') : vs.some(v => v === 'SUPPORTED');
    if (!ok) return `ROUTE_CLAIM:${kind}`;
  }
  return null;
}
