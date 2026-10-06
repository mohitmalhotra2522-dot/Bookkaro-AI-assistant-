/**
 * P36-C.1.1 — VOICE RESPONSE LAYER (deterministic, no LLM call, no tools, no state).
 *
 * Input is ALWAYS the already-validated final reply (or a validated segment of it). Two pure steps:
 *
 *  1. conciseForVoice(text) — SELECTS whole sentences of the validated text for speech (never rewrites them):
 *     safety/boundary sentences and the final question are always kept, the rest fills a short budget in order;
 *     when something was dropped a fixed, fact-free "details are on screen" line is added. The screen keeps the
 *     full text. Used for the deterministic VOICE speech (server `speechOf`).
 *
 *  2. renderForSpeech(text) — PRONUNCIATION ONLY, applied at the TTS boundary to every utterance:
 *     train numbers digit-by-digit, ₹ → "rupaye", WL → "waiting list", class codes spelled out, "5 Oct" →
 *     "5 October", station codes after a station name dropped, arrows/symbols spoken; and it removes what must never
 *     be spoken (credential-shaped strings, session / turn ids, URLs, raw JSON, stack traces, internal provider names,
 *     markdown, emoji). Every digit sequence of the input survives unchanged (order preserved) except inside removed
 *     unsafe material — railway facts cannot change.
 */
import { detectLanguageStyle, type LanguageStyle } from './language-style';

// ------------------------------------------------------------------ sentence helpers

function sentencesOf(text: string): string[] {
  return String(text || '')
    .split(/\n+/)
    .map(l => l.trim())
    .filter(Boolean)
    .flatMap(l => l.split(/(?<=[.!?।])\s+/))
    .map(s => s.trim())
    .filter(Boolean);
}

const isLabel = (s: string) => /:\s*$/.test(s) && s.split(/\s+/).length <= 4;

/** Sentences that must never be dropped from speech: booking boundary, unverified / failed facts, non-live data. */
export const MUST_KEEP = new RegExp([
  'abhi enabled nahi', 'enabled nahi', 'not enabled', 'disabled',
  'not booked', 'book nahi', 'booked nahi', 'ticket abhi', 'ticket nahi',
  'verify nahi', 'not verified', 'unverified', 'could not', 'couldn\'t', 'nahi ho paa', 'nahi mil paa',
  'mock', 'development data', 'not live', 'live nahi',
  'नहीं', 'बुक नहीं'
].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

export const DETAILS_NOTE: Record<LanguageStyle, string> = {
  HINGLISH: 'Baaki details screen par hain.',
  ENGLISH: 'The rest is on your screen.',
  HINDI: 'बाकी जानकारी स्क्रीन पर है।'
};

export interface ConciseOptions { maxChars?: number; maxSentences?: number; detailsNote?: boolean; question?: string }

const ENDS = /[.!?।]$/;
/** Fact weight of a sentence (what a listener needs most): money / availability, then train, class, date, count. */
function factScore(s: string): number {
  let n = 0;
  if (/₹|\bRs\.?\s?\d|\bfare\b|kiraya|किराया|\brupa?y/i.test(s)) n += 3;
  if (/\b(?:GN|PQ|RL|TQ)?WL\s*\d|\bRAC\b|\bavailab|\bseats?\b|\bwaiting\b|उपलब्ध|सीट/i.test(s)) n += 3;
  if (/(?<!\d)\d{5}(?!\d)/.test(s)) n += 2;
  if (/\b(?:1A|2A|3A|3E|2S|CC|EC|SL|FC)\b/.test(s)) n += 1;
  if (/\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|\bkal\b|\bparso\b|\b\d{1,2}:\d{2}\b/i.test(s)) n += 1;
  if (/\b\d+\s*(?:passengers?|log|yatri|trains?|trainein)\b/i.test(s)) n += 1;
  return n;
}

/**
 * Select (never rewrite) the sentences that are spoken. Boundary / safety sentences and the final question are always
 * kept; the rest is chosen by fact weight within a short budget and spoken in original order. A run of ≥3 train-list
 * lines is screen-only (the cards show it). Unpunctuated lines get a full stop (a spoken pause — punctuation only).
 */
export function conciseForVoice(text: string, o: ConciseOptions = {}): { text: string; dropped: number } {
  const maxChars = o.maxChars ?? 240;
  const maxSentences = o.maxSentences ?? 3;
  const all = sentencesOf(text);
  if (!all.length) return { text: '', dropped: 0 };
  const hindi = detectLanguageStyle(all.join(' ')) === 'HINDI';
  const close = (s: string) => (ENDS.test(s) ? s : `${s.replace(/[:;,]\s*$/, '')}${hindi ? '।' : '.'}`);
  const listLines = all.filter(s => !ENDS.test(s) && !/:\s*$/.test(s) && /(?<!\d)\d{5}(?!\d)/.test(s));
  const isList = listLines.length >= 3;
  const flat = all.map(close).join(' ');
  if (!isList && flat.length <= maxChars && all.length <= maxSentences && !all.some(isLabel)) return { text: flat, dropped: 0 };

  const idx = all.map((s, i) => ({ s, i })).filter(x => !isLabel(x.s) && !(isList && listLines.includes(x.s)));
  let q = -1;
  for (let k = idx.length - 1; k >= 0; k--) {
    if (idx[k].s.includes('?') || (o.question && idx[k].s.includes(o.question))) { q = idx[k].i; break; }
  }
  const chosen = new Set<number>();
  for (const x of idx) if (MUST_KEEP.test(x.s)) chosen.add(x.i);
  if (q >= 0) chosen.add(q);
  const content = () => [...chosen].filter(i => i !== q).length;
  const len = () => [...chosen].reduce((n, i) => n + all[i].length + 1, 0);
  const ranked = idx.filter(x => !chosen.has(x.i) && x.i < (q >= 0 ? q : Infinity))
    .map(x => ({ ...x, score: factScore(x.s) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  for (const x of ranked) {
    if (content() >= maxSentences) break;
    if (len() + x.s.length > maxChars) continue;
    chosen.add(x.i);
  }
  const ordered = [...chosen].sort((a, b) => a - b);
  const dropped = all.length - ordered.length;
  const body = ordered.filter(i => i !== q).map(i => close(all[i]));
  const tail = q >= 0 ? [all[q]] : [];
  const note = dropped > 0 && o.detailsNote ? [DETAILS_NOTE[detectLanguageStyle(flat)]] : [];
  return { text: [...body, ...note, ...tail].join(' ').replace(/\s+/g, ' ').trim(), dropped };
}

// ------------------------------------------------------------------ never-spoken material

const CREDENTIAL = new RegExp([
  String.raw`\b(?:sk|pk|rk|nvapi|key|xi|rnd|ghp|gho|ghu|ghs|ghr)[-_][A-Za-z0-9_-]{8,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{10,}`,
  String.raw`\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*`,
  String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}`,          // JWT
  String.raw`\b[A-Za-z0-9+/_-]{32,}={0,2}`                            // long opaque token
].join('|'), 'g');
const INTERNAL_ID = /\b(?:sess|session|turn|vt|cm|req|hnd|handoff|exec|trace|span)_[A-Za-z0-9-]{6,}\b|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
const RAW_JSON = /[{[]\s*"[^"\n]{1,40}"\s*:/;
const STACK = /^\s*at\s+\S+.*:\d+:\d+\)?\s*$|\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):\s|\bstack\s*trace\b|\bECONN\w+|\bETIMEDOUT\b/i;
const PROVIDER_DATA = /\b(?:RailCore|Rail\s?Radar|RailKit|IRCTC\s+API)\b/gi;
const PROVIDER_INTERNAL = /\b(?:ElevenLabs|Eleven\s+Labs|scribe_v2(?:_realtime)?|Muse(?:-Glimmer)?|NVIDIA|OpenAI|openai-compatible|meta\/[\w.-]+|mock-llm|vosk)\b/gi;

/** Mask credential-shaped strings (defence in depth — validated replies never contain them). */
export function maskCredentials(text: string): string {
  return String(text || '').replace(CREDENTIAL, ' ');
}

// ------------------------------------------------------------------ pronunciation

const NON_STATION = new Set(['AC', 'CC', 'EC', 'SL', 'FC', 'RAC', 'WL', 'GNWL', 'PQWL', 'RLWL', 'TQWL', 'PNR', 'IRCTC', 'OTP', 'UPI',
  'ID', 'OK', 'TTS', 'STT', 'AI', 'SMS', 'PDF', 'ETA', 'GPS', 'NO', 'YES', 'AM', 'PM', 'IST', 'INR', 'RS', 'VIP', 'EXP', 'SF', 'MAIL']);
const MONTHS: Record<string, string> = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', jun: 'June', jul: 'July', aug: 'August', sep: 'September', sept: 'September', oct: 'October', nov: 'November', dec: 'December' };
const RUPEES: Record<LanguageStyle, string> = { HINGLISH: 'rupaye', ENGLISH: 'rupees', HINDI: 'रुपये' };
const FROM_TO: Record<LanguageStyle, string> = { HINGLISH: ' se ', ENGLISH: ' to ', HINDI: ' से ' };
const TIMES_SIGN: Record<LanguageStyle, string> = { HINGLISH: ' into ', ENGLISH: ' into ', HINDI: ' गुणा ' };
const WAITING: Record<LanguageStyle, string> = { HINGLISH: 'waiting list', ENGLISH: 'waiting list', HINDI: 'वेटिंग लिस्ट' };
const spell = (s: string) => s.split('').join(' ');

/** Speakable rendering of ONE validated utterance (same facts; pronunciation + never-spoken removal only). */
export function renderForSpeech(text: string, style?: LanguageStyle): string {
  let t = String(text || '');
  if (!t.trim()) return '';
  const st = style || detectLanguageStyle(t);

  // 0. a line break is a spoken pause; screen-only version markers ("Review (v1):") are dropped
  t = t.replace(/([^\s.!?।:;,])[ \t]*\n+/g, '$1.\n').replace(/\s*\(v\d+\)/g, '');
  // 1. never spoken: whole sentences that are raw JSON / stack traces; tokens that are credentials / ids / URLs
  t = sentencesOf(t).filter(s => !RAW_JSON.test(s) && !STACK.test(s)).join(' ');
  t = maskCredentials(t).replace(/\[redacted\]/gi, ' ').replace(INTERNAL_ID, ' ').replace(URL_RE, ' ');
  t = t.replace(PROVIDER_DATA, 'railway system').replace(PROVIDER_INTERNAL, ' ');

  // 2. markup / emoji
  t = t.replace(/^\s*(?:[-•*]|\d+[.)])\s+/gm, '').replace(/[*_`#>|]+/g, ' ').replace(/\p{Extended_Pictographic}|\uFE0F/gu, ' ');

  // 3. station codes right after a station name ("New Delhi NDLS", "Amritsar Jn (ASR)") — the name is kept
  t = t.replace(/\(([A-Z]{2,5})\)/g, (m, c) => (NON_STATION.has(c) ? m : ' '));
  t = t.replace(/\b([A-Z][a-z]+\.?)\s+([A-Z]{2,5})\b(?![a-z])/g, (m, w, c) => (NON_STATION.has(c) ? m : w));

  // 4. railway terms (before numbers, so "WL 42" keeps its number)
  t = t.replace(/\b(?:GN|PQ|RL|TQ)?WL\s*[-/]?\s*(\d+)\b/g, (m: string, n: string, off: number, str: string) => `${WAITING[st]} ${n}${/^\s*(?:[₹\d]|Rs\b)/.test(str.slice(off + m.length)) ? ',' : ''}`);
  t = t.replace(/\bRAC\b/g, 'R A C');
  t = t.replace(/\b(1A|2A|3A|3E|2S|CC|EC|SL|FC|AC)\b/g, m => spell(m));

  // 5. train numbers (5 digits, not money) digit-by-digit — the digits themselves are unchanged
  t = t.replace(/(?<!(?:₹|Rs\.?)\s?)(?<![\d,.])(\d{5})(?![\d,.]|\s*(?:rupaye|rupees|रुपये))/g, (_m, d: string, off: number, str: string) => spell(d) + (/^\s+\d/.test(str.slice(off + 5)) ? ',' : ''));

  // 6. money, dates, symbols
  t = t.replace(/(?:₹|\bRs\.?)\s?(\d[\d,]*(?:\.\d+)?)/g, `$1 ${RUPEES[st]}`);
  t = t.replace(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b\.?/gi, (_m, d, mo) => `${d} ${MONTHS[mo.toLowerCase()]}`);
  t = t.replace(/\s*(?:→|->|⟶)\s*/g, FROM_TO[st]).replace(/\s*×\s*/g, TIMES_SIGN[st]);
  t = t.replace(/[()[\]{}]/g, ', ').replace(/\s*[—–]\s*/g, ', ');

  // 7. tidy
  t = t.replace(/\s+([,.!?।:;])/g, '$1').replace(/,\s*([:;])/g, '$1').replace(/([,])(\s*[,])+/g, '$1').replace(/^[\s,.;:]+/, '').replace(/,\s*([.!?।])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : '';
}

/** Digit sequences of a text with spelled-out digit runs re-joined ("1 2 0 1 4" → "12014") — fact-invariance checks. */
export function digitFacts(text: string): string[] {
  const joined = String(text || '').replace(/\b(\d)(?:\s(\d)\b)+/g, m => m.replace(/\s/g, ''));
  return (joined.match(/\d[\d,.:]*\d|\d/g) || []).map(x => x.replace(/,/g, ''));
}
