/**
 * PROMPT 18 — Part 52: a bare day number ("22", "22 ko", "22 tareekh") is AMBIGUOUS (which month?).
 * DateResolver already refuses to guess (AMBIGUOUS_DATE); this turns that into ONE short clarification
 * with the two upcoming candidate months, and maps the user's month answer back to an explicit date
 * expression that DateResolver resolves deterministically. No model assumption is ever used.
 */
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';

const BARE_DAY_RE = /^(\d{1,2})(?:\s*(?:ko|tareekh|tarikh|tarik|date|th|st|nd|rd))?\s*(?:ko)?[.?!]?$/i;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_RE: Array<[RegExp, number]> = MONTHS.map((m, i) => [new RegExp(`\\b(${m}|${m.slice(0, 3)}${m === 'September' ? '|sept' : ''})\\b`, 'i'), i]);
const JOURNEY_STATES = new Set<string>([BookingState.IDLE, BookingState.COLLECTING_JOURNEY, BookingState.COLLECTING_DATE]);

export interface DayClarification { day: number; candidates: string[]; labels: string[]; message: string }

function iso(y: number, m: number, d: number) { return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
function validDay(y: number, m: number, d: number) { return new Date(Date.UTC(y, m, d)).getUTCDate() === d; }

/** Two nearest upcoming months in which `day` exists (today counts for the current month). */
export function candidateMonths(day: number, today = new Date()): Array<{ date: string; label: string }> {
  const out: Array<{ date: string; label: string }> = [];
  let y = today.getFullYear(), m = today.getMonth();
  if (day < today.getDate()) { m++; if (m > 11) { m = 0; y++; } }
  for (let i = 0; i < 14 && out.length < 2; i++) {
    if (validDay(y, m, day)) out.push({ date: iso(y, m, day), label: `${day} ${MONTHS[m]}` });
    m++; if (m > 11) { m = 0; y++; }
  }
  return out;
}

/**
 * Applies only where a bare number most plausibly means a DATE: the date question is pending, or the
 * journey is still being collected and no date exists yet. (At train selection "2" = second train; at the
 * passenger question "2" = count — those flows are untouched.)
 */
export function detectBareDay(text: string, s: BookingSession, today = new Date()): DayClarification | null {
  const m = BARE_DAY_RE.exec(String(text || '').trim());
  if (!m) return null;
  const day = Number(m[1]);
  if (!(day >= 1 && day <= 31)) return null;
  const pt = s.pendingInteraction?.type;
  const dateQuestion = pt === 'DATE_REQUIRED';
  const collecting = !s.date && JOURNEY_STATES.has(s.bookingState) && (!pt || pt === 'NONE' || pt === 'ORIGIN_REQUIRED' || pt === 'DESTINATION_REQUIRED');
  if (!dateQuestion && !collecting) return null;
  const c = candidateMonths(day, today);
  if (c.length < 2) return null;
  const routeMissing = !s.origin || !s.destination;
  const message = `${day} tareekh kis mahine ki — ${c[0].label} ya ${c[1].label}?${routeMissing ? ' Aur kahan se kahan jaana hai?' : ''}`;
  return { day, candidates: c.map(x => x.date), labels: c.map(x => x.label), message };
}

/** Map the answer to a pending DATE_MONTH clarification → explicit expression ("22 October"), or null. */
export function resolveMonthAnswer(text: string, data: { day?: number; candidates?: string[]; labels?: string[] } | undefined): string | null {
  if (!data?.day || !data.candidates?.length || !data.labels?.length) return null;
  const t = String(text || '').toLowerCase();
  if (/\b(pehl[ai]|pahl[ai]|first|1st|is mahine|isi mahine|this month)\b/.test(t)) return data.labels[0];
  if (/\b(doosr[ai]|dusr[ai]|second|2nd|agle mahine|next month)\b/.test(t)) return data.labels[1] ?? null;
  for (const [re, idx] of MONTH_RE) {
    if (re.test(t)) {
      const hit = data.labels.find(l => l.endsWith(MONTHS[idx]));
      return hit || `${data.day} ${MONTHS[idx]}`;
    }
  }
  return null;
}
