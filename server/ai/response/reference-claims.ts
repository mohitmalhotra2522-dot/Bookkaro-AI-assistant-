/**
 * Prompt 30 — contextual-reference claim validation (guard step 7: after railway fact → availability → fare → entity
 * binding → date binding → P29 action/progress; before cleanup).
 *
 * The LLM interprets "doosri wali", "last wali", "iska" itself. When its REPLY then states a position or list
 * membership, that statement must hold for the CURRENT authoritative result set:
 *
 *   "Doosri wali 12497 hai"              → 12497 must be display index 2 of the current set
 *   "Last wali 18238 hai"                → 18238 must be the last train of the current set
 *   "12497 parso ki list mein nahi hai"  → 12497 must really be absent from the current set
 *   "12014 nayi list mein bhi hai"       → 12014 must really be present
 *
 * An index from an older list (new search / date / route change) or a mismatched position is removed — only that
 * sentence; the rest of the reply stays. Superlatives ("sabse pehli / sabse pehle pahunchti") and class names
 * ("First AC", "second sitting") are not positions. Nothing here calls a tool or picks a train.
 */
import type { BookingSession } from '@shared/entities';
import { currentResults } from '../context/train-reference-resolver';
import { resultSetOf } from '../context/reference-context';

const ORD: Record<string, number | 'LAST'> = {
  pehli: 1, pehla: 1, pahli: 1, pahla: 1, first: 1, '1st': 1,
  doosri: 2, dusri: 2, doosra: 2, dusra: 2, second: 2, '2nd': 2,
  teesri: 3, tisri: 3, teesra: 3, tisra: 3, third: 3, '3rd': 3,
  chauthi: 4, chautha: 4, fourth: 4, '4th': 4,
  paanchvi: 5, panchvi: 5, paanchvin: 5, fifth: 5, '5th': 5,
  last: 'LAST', aakhri: 'LAST', akhri: 'LAST', aakhiri: 'LAST', antim: 'LAST'
};
/** oblique forms — a position only together with number / position / option ("doosre number par") */
const OBL: Record<string, number> = { pehle: 1, pahle: 1, doosre: 2, dusre: 2, teesre: 3, tisre: 3, chauthe: 4 };
const ALL = [...Object.keys(ORD), ...Object.keys(OBL)].sort((a, b) => b.length - a.length).join('|');
const TRAIN = String.raw`(?<![₹\d,.])(\d{5})(?!\d)`;
const FILLER = String.raw`((?:\s*(?:wali|wale|wala|train|option|number|no\.?|position|one|is|hai|par|pe|:|—|–|-|,|\())*)`;
/** "<ordinal> [wali / train / option / number par …] <train>" */
const ORD_FIRST = new RegExp(String.raw`(\bsabse\s+)?\b(${ALL})\b${FILLER}\s*${TRAIN}`, 'gi');
/** "<train> [(name)] [list mein] [is the] <ordinal> <number / position / option / wali / train / hai>" */
const TRAIN_FIRST = new RegExp(String.raw`${TRAIN}\s*(?:\([^)]{0,40}\)\s*)?(?:[,—–-]\s*)?(?:(?:list|results?)\s+(?:mein|me)\s+)?(?:is\s+(?:the\s+)?)?(\bsabse\s+)?\b(${ALL})\s+(number|no\.?|position|option|wali|wala|train|one|par|pe|hai|is)\b`, 'gi');
/** list membership ("12497 parso ki list mein nahi hai" / "list mein 12497 bhi hai" / "12014 is in the new list") */
const MEMBER_HI = new RegExp(String.raw`${TRAIN}\b[^.?!\n]{0,40}?\b(?:list|results?)\s+(?:mein|me|men|main)\s+(?:bhi\s+)?(nahi(?:n)?\s+|nhi\s+)?(?:hai|hain)\b`, 'gi');
const MEMBER_HI2 = new RegExp(String.raw`\b(?:list|results?)\s+(?:mein|me|men|main)\s+(?:bhi\s+)?${TRAIN}\s+(?:bhi\s+)?(nahi(?:n)?\s+|nhi\s+)?(?:hai|hain)\b`, 'gi');
const MEMBER_EN = new RegExp(String.raw`${TRAIN}\s+(?:also\s+)?(is(?:n['’]t|\s+not)?)\s+(?:also\s+)?(?:in|on)\s+the\s+(?:new\s+|fresh\s+|current\s+|updated\s+)?(?:list|results)`, 'gi');

export interface ReferenceClaimDiagnostic {
  kind: 'ORDINAL' | 'LIST_MEMBERSHIP';
  trainNumber: string;
  /** claimed position ("2" / "LAST") or membership ("PRESENT" / "ABSENT") */
  claimed: string;
  status: 'VALID' | 'STALE' | 'INVALID';
  reason: string | null;
  resultSetVersion: number;
}

interface Claim { kind: ReferenceClaimDiagnostic['kind']; trainNumber: string; claimed: string }

function claimsOf(sentence: string): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  const push = (c: Claim) => { const k = `${c.kind}:${c.trainNumber}:${c.claimed}`; if (!seen.has(k)) { seen.add(k); out.push(c); } };
  for (const m of sentence.matchAll(ORD_FIRST)) {
    if (m[1]) continue;                                         // "sabse pehli" — a superlative, not a position
    const w = m[2].toLowerCase();
    const filler = m[3] || '';
    if (OBL[w] !== undefined && !/number|no\.?|position|option/i.test(filler)) continue;
    const pos = ORD[w] ?? OBL[w];
    push({ kind: 'ORDINAL', trainNumber: m[4], claimed: String(pos) });
  }
  for (const m of sentence.matchAll(TRAIN_FIRST)) {
    if (m[2]) continue;
    const w = m[3].toLowerCase();
    if (OBL[w] !== undefined && !/number|no\.?|position|option/i.test(m[4])) continue;
    push({ kind: 'ORDINAL', trainNumber: m[1], claimed: String(ORD[w] ?? OBL[w]) });
  }
  for (const m of sentence.matchAll(MEMBER_HI)) push({ kind: 'LIST_MEMBERSHIP', trainNumber: m[1], claimed: m[2] ? 'ABSENT' : 'PRESENT' });
  for (const m of sentence.matchAll(MEMBER_HI2)) push({ kind: 'LIST_MEMBERSHIP', trainNumber: m[1], claimed: m[2] ? 'ABSENT' : 'PRESENT' });
  for (const m of sentence.matchAll(MEMBER_EN)) push({ kind: 'LIST_MEMBERSHIP', trainNumber: m[1], claimed: /n['’]t|not/i.test(m[2]) ? 'ABSENT' : 'PRESENT' });
  return out;
}

/** Judge one sentence against the current result set → first failing reason (null = fine) + diagnostics. */
export function verifyReferenceClaims(sentence: string, s: BookingSession): { reason: string | null; diagnostics: ReferenceClaimDiagnostic[] } {
  const claims = claimsOf(String(sentence || ''));
  if (!claims.length) return { reason: null, diagnostics: [] };
  const rs = resultSetOf(s);
  const list = rs && rs.current ? currentResults(s) : [];
  const version = s.searchResultsVersion || 0;
  const diagnostics: ReferenceClaimDiagnostic[] = [];
  let reason: string | null = null;
  for (const c of claims) {
    const at = list.findIndex(t => t.trainNumber === c.trainNumber);
    let status: ReferenceClaimDiagnostic['status'] = 'VALID';
    let why: string | null = null;
    if (c.kind === 'ORDINAL') {
      if (!list.length) { status = 'STALE'; why = `STALE_INDEX_REFERENCE:${c.trainNumber}`; }
      else {
        const want = c.claimed === 'LAST' ? list.length : Number(c.claimed);
        if (want > list.length) { status = 'INVALID'; why = `INVALID_INDEX_REFERENCE:${c.trainNumber}`; }
        else if (at === -1) { status = 'STALE'; why = `STALE_INDEX_REFERENCE:${c.trainNumber}`; }
        else if (at + 1 !== want) { status = 'INVALID'; why = `INDEX_REFERENCE_MISMATCH:${c.trainNumber}`; }
      }
    } else {
      if (c.claimed === 'PRESENT' && at === -1) { status = rs && !rs.current ? 'STALE' : 'INVALID'; why = `NOT_IN_CURRENT_RESULTS:${c.trainNumber}`; }
      else if (c.claimed === 'ABSENT' && at !== -1) { status = 'INVALID'; why = `IN_CURRENT_RESULTS:${c.trainNumber}`; }
    }
    diagnostics.push({ kind: c.kind, trainNumber: c.trainNumber, claimed: c.claimed, status, reason: why, resultSetVersion: version });
    if (why && !reason) reason = why;
  }
  return { reason, diagnostics };
}

const SENT_SPLIT = /(?<=[.!?।])\s+(?=\S)/;
const ORPHAN_RE = /^[\s\d.,;:!?()•*·\-–—]*$/;
const LEAD_CONJ_RE = /^(aur|and|lekin|but|par|toh|phir|magar|so)\s+/i;

export interface ReferenceGuardResult { text: string; removed: Array<{ sentence: string; reason: string }>; diagnostics: ReferenceClaimDiagnostic[] }

/** Final-reply guard: removes only the sentences whose reference claim fails (orphans cleaned where removed). */
export function guardReferenceClaims(text: string, s: BookingSession): ReferenceGuardResult {
  const res: ReferenceGuardResult = { text, removed: [], diagnostics: [] };
  if (!text || !/\d{5}/.test(text)) return res;
  const out: string[] = [];
  for (const line of String(text).split('\n')) {
    if (!/\d{5}/.test(line)) { out.push(line); continue; }
    const kept: string[] = [];
    let changed = false;
    for (const sent of line.split(SENT_SPLIT)) {
      const v = verifyReferenceClaims(sent, s);
      res.diagnostics.push(...v.diagnostics);
      if (v.reason) { changed = true; res.removed.push({ sentence: sent.trim().slice(0, 120), reason: v.reason }); }
      else kept.push(sent);
    }
    if (!changed) { out.push(line); continue; }
    const clean: string[] = [];
    for (const k of kept) {
      const t = k.trim();
      if (!t || ORPHAN_RE.test(t)) continue;
      clean.push(clean.length ? t : t.replace(LEAD_CONJ_RE, '').replace(/^./, ch => ch.toUpperCase()));
    }
    if (clean.length) out.push(clean.join(' '));
  }
  res.text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return res;
}
