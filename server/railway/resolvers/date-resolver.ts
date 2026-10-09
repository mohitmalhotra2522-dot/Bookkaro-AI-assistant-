/**
 * DateResolver — deterministic date parsing.
 * Returns canonical YYYY-MM-DD (Asia/Kolkata).
 * LLM does not do date math; all resolution happens here.
 */

export type DateResolveResult =
  | { ok: true; date: string /* YYYY-MM-DD */ }
  | { ok: false; error: 'AMBIGUOUS_DATE' | 'INVALID_DATE'; message: string };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9, sept: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12
};

const TODAY_IST = (): Date => {
  // Application uses Asia/Kolkata (UTC+5:30)
  const now = new Date();
  // Shift to IST for date logic (the system clock is already set to IST per environment)
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
  return new Date(utcMs + istOffsetMs);
};

const pad = (n: number) => String(n).padStart(2, '0');
const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function addDays(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export function resolveDate(raw: string): DateResolveResult {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, error: 'AMBIGUOUS_DATE', message: 'कृपया तारीख स्पष्ट करें।' };
  }
  const text = raw.toLowerCase().trim();

  // Relative dates (Asia/Kolkata)
  const today = TODAY_IST();
  if (/\b(aaj|today)\b/.test(text)) return { ok: true, date: toISO(today) };
  if (/\b(kal|tomorrow)\b/.test(text)) return { ok: true, date: addDays(today, 1) };
  if (/\b(parso|day after tomorrow|parson)\b/.test(text)) return { ok: true, date: addDays(today, 2) };
  if (/\b(aane wala kal|after tomorrow)\b/.test(text)) return { ok: true, date: addDays(today, 2) };

  // Weekdays: "Sunday ko", "agle monday", "next friday", Hindi names.
  const WEEKDAYS: Array<[RegExp, number]> = [
    [/\b(sunday|ravivar|itwar|itvaar)\b/, 0], [/\b(monday|somvar|somvaar)\b/, 1],
    [/\b(tuesday|mangalvar|mangalwar)\b/, 2], [/\b(wednesday|budhvar|budhwar)\b/, 3],
    [/\b(thursday|guruvar|veervar|brihaspativar)\b/, 4], [/\b(friday|shukravar|shukrawar)\b/, 5],
    [/\b(saturday|shanivar|shaniwar)\b/, 6]
  ];
  for (const [re, wd] of WEEKDAYS) {
    if (re.test(text)) {
      let delta = (wd - today.getDay() + 7) % 7;
      if (delta === 0) delta = 7; // same weekday → next week's occurrence
      return { ok: true, date: addDays(today, delta) };
    }
  }

  // ISO format already: YYYY-MM-DD
  const isoMatch = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const [_, y, m, d] = isoMatch;
    return validDate(+y, +m, +d);
  }

  // DD/MM/YYYY or DD-MM-YYYY
  const slashMatch = text.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
  if (slashMatch) {
    const d = +slashMatch[1], m = +slashMatch[2];
    let y = +slashMatch[3];
    if (y < 100) y += 2000;
    return validDate(y, m, d);
  }

  // "22 September", "2 oct", "October 3" (current year assumed; if month already passed → next year)
  // 2026-10-09: a real month word is preferred ("1 passenger 20 October" → 20 Oct; "20 October 1 passenger" → 20 Oct);
  // the generic word pattern stays as the fallback (an unknown month word still asks instead of guessing)
  const MON_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  const fwd = text.match(new RegExp(`\\b(\\d{1,2})\\s+(${MON_RE})\\b`, 'i'));     // "20 October"
  const rev = fwd ? null : text.match(new RegExp(`\\b(${MON_RE})\\s+(\\d{1,2})\\b`, 'i'));   // "October 20"
  const wordMatch = fwd || (rev ? null : text.match(/(\d{1,2})\s+([a-zA-Z]+)/));
  const revWordMatch = rev || (fwd ? null : text.match(/([a-zA-Z]+)\s+(\d{1,2})/));
  if (wordMatch || revWordMatch) {
    const day = wordMatch ? +wordMatch[1] : +(revWordMatch?.[2] ?? '');
    const monRaw = wordMatch ? wordMatch[2] : (revWordMatch?.[1] ?? '');
    const mon = MONTHS[monRaw.toLowerCase()];
    if (!mon) {
      return { ok: false, error: 'AMBIGUOUS_DATE', message: 'Month समझ नहीं आया, कृपया स्पष्ट करें।' };
    }
    let year = today.getFullYear();
    if (mon < today.getMonth() + 1 || (mon === today.getMonth() + 1 && day < today.getDate())) {
      year += 1;
    }
    return validDate(year, mon, day);
  }

  return { ok: false, error: 'AMBIGUOUS_DATE', message: 'तारीख समझ नहीं आयी, कृपया जैसे "3 October" या "kal" बताएं।' };
}

function validDate(y: number, m: number, d: number): DateResolveResult {
  if (m < 1 || m > 12) return { ok: false, error: 'INVALID_DATE', message: 'महीना गलत है।' };
  if (d < 1 || d > 31) return { ok: false, error: 'INVALID_DATE', message: 'दिन गलत है।' };
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return { ok: false, error: 'INVALID_DATE', message: 'अमान्य तारीख।' };
  }
  // Disallow dates more than 1 day in the past (allow today)
  const now = TODAY_IST();
  const todayOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (date < todayOnly) {
    return { ok: false, error: 'INVALID_DATE', message: 'आप बीती हुई तारीख चुन नहीं सकते।' };
  }
  return { ok: true, date: toISO(date) };
}

export function isISO(v: any): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
