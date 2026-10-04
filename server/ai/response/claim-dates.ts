/**
 * PROMPT 28 — date words inside a railway CLAIM ("kal", "parso", "5 Oct", "October 6", "2026-10-06") resolved to the
 * canonical YYYY-MM-DD the evidence carries. Pure linguistics over the backend date resolver — no railway facts.
 */
import { resolveDate } from '../../railway/resolvers/date-resolver';

const DAY_RE = /\b(aaj|today|kal|tomorrow|parso|parson|day after tomorrow)\b/gi;
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DM_RE = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MON}\b`, 'gi');
const MD_RE = new RegExp(String.raw`\b${MON}\s+(\d{1,2})(?:st|nd|rd|th)?\b`, 'gi');
const ISO_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;

const res = (x: string): string | undefined => { const r: any = resolveDate(x); return r?.ok && r.date ? String(r.date) : undefined; };

/** Every distinct date a sentence states, canonical. "kal" in "kal nahi parso" yields both (callers decide). */
export function claimedDates(t: string): string[] {
  const out: string[] = [];
  const add = (d?: string) => { if (d && !out.includes(d)) out.push(d); };
  const text = String(t || '');
  for (const m of text.matchAll(ISO_RE)) add(res(m[1]));
  for (const m of text.matchAll(DM_RE)) add(res(`${m[1]} ${m[2]}`));
  for (const m of text.matchAll(MD_RE)) add(res(`${m[2]} ${m[1]}`));
  for (const m of text.matchAll(DAY_RE)) add(res(m[1].toLowerCase()));
  return out;
}

/** Explicit calendar dates only (not relative day words). */
export function explicitDates(t: string): string[] {
  const out: string[] = [];
  const text = String(t || '');
  for (const re of [ISO_RE, DM_RE, MD_RE]) for (const m of text.matchAll(re)) {
    const d = re === ISO_RE ? res(m[1]) : re === DM_RE ? res(`${m[1]} ${m[2]}`) : res(`${m[2]} ${m[1]}`);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** The single date a claim is about (first stated), or undefined when it states none. */
export const claimedDate = (t: string): string | undefined => claimedDates(t)[0];
