/**
 * PROMPT 33 — booking-state claim guard (LLM-authored text only).
 *
 * The LLM words every booking reply; the backend owns the booking state. A sentence may only describe the state the
 * session is actually in:
 *   - BOOKED     "ticket book ho gayi" / "booking confirmed" / "booked successfully" — NEVER valid: handoff-ready is not a
 *                booked ticket and actual railway booking is disabled.
 *   - HANDOFF    "details confirmed hain" / "handoff ready" — only in IRCTC_HANDOFF_READY with a READY handoff session.
 *   - REVIEW     "review ready" / "final details ready" — only while a CURRENT (valid, unchanged) review exists.
 * Negated sentences ("ticket abhi book nahi hua", "review abhi ready nahi") are not claims. Deterministic backend
 * strings are never judged here (they are not LLM-authored). Diagnostics only — no ids, no passenger data.
 */
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';
import { reviewStatusOf } from '../../booking/preparation/booking-preparation';

export type BookingStateClaimKind = 'BOOKED' | 'HANDOFF' | 'REVIEW';
export interface BookingStateClaimDiagnostic { kind: BookingStateClaimKind; accepted: boolean; reason: string | null; sentence: string }

const NEGATION_RE = /\b(nahi|nahin|nhi|not|never|no|mat|abhi tak nahi)\b|n't\b/i;
const BOOKED_RE = /\b(?:ticket|tickets|booking|seat|seats|berth)\s+(?:(?:successfully|safaltapoorvak)\s+)?(?:book(?:ed)?|confirm(?:ed)?|reserve(?:d)?)\s+(?:ho\s+(?:gay[aie]|chuk[aie])|kar\s+di(?:ya|ye)?|ho\s+gayi\s+hai|successful|hai|hain|is\s+done)\b|\b(?:ticket|booking)\s+(?:is|has\s+been)\s+(?:booked|confirmed)\b|\bbooking\s+(?:confirmed|successful|complete(?:d)?)\b|\bbooked\s+successfully\b|\bbook\s+ho\s+(?:gay[aie]|chuk[aie])\b|\bPNR\s+(?:mil|generate|ban)\s+(?:gaya|gayi|ho\s+gaya)\b/i;
const HANDOFF_RE = /\bhandoff\s+(?:ready|taiyaar|tayyar|ban\s+gaya|create|bana)|\bdetails\s+confirm(?:ed)?\s+(?:hain|hai|ho\s+gay[aie]|kar\s+di(?:ye|ya)?)\b|\bconfirmation\s+(?:ho\s+gayi|done|accepted|complete)\b/i;
const REVIEW_RE = /\breview\s+(?:ready|taiyaar|tayyar|ban\s+gaya|bana\s+diya|create\s+ho|is\s+ready)|\bfinal\s+details\s+(?:ready|taiyaar|tayyar)\b/i;

export function verifyBookingStateClaim(sentence: string, s: BookingSession | undefined): { reason: string | null; diagnostics: BookingStateClaimDiagnostic[] } {
  const t = String(sentence || '');
  const diags: BookingStateClaimDiagnostic[] = [];
  if (!t.trim()) return { reason: null, diagnostics: diags };
  const add = (kind: BookingStateClaimKind, reason: string | null) => { diags.push({ kind, accepted: !reason, reason, sentence: t.slice(0, 120) }); return reason; };
  // a claim is negated only by a negation next to it ("book nahi hua", "not booked") — not anywhere in the sentence
  const claims = (re: RegExp) => { const m = re.exec(t); if (!m) return false; return !NEGATION_RE.test(t.slice(Math.max(0, m.index - 14), m.index + m[0].length + 8)); };
  if (claims(BOOKED_RE)) return { reason: add('BOOKED', 'BOOKED_CLAIM_NEVER_VALID'), diagnostics: diags };
  if (claims(HANDOFF_RE)) {
    const ready = !!s && s.bookingState === BookingState.IRCTC_HANDOFF_READY
      && ((s as any).handoffSession ? (s as any).handoffSession.status === 'READY' : (s as any).handoff?.status === 'READY');
    const r = add('HANDOFF', ready ? null : 'HANDOFF_CLAIM_WITHOUT_HANDOFF');
    if (r) return { reason: r, diagnostics: diags };
  }
  if (claims(REVIEW_RE)) {
    const current = !!s && !!s.review?.valid && reviewStatusOf(s) === 'CURRENT';
    const r = add('REVIEW', current ? null : 'REVIEW_CLAIM_WITHOUT_CURRENT_REVIEW');
    if (r) return { reason: r, diagnostics: diags };
  }
  return { reason: null, diagnostics: diags };
}

/** Whole-text form (agent final text): removes only the failing sentences. */
export function guardBookingStateClaims(text: string, s: BookingSession | undefined): { text: string; removed: Array<{ sentence: string; reason: string }>; diagnostics: BookingStateClaimDiagnostic[] } {
  const res = { text, removed: [] as Array<{ sentence: string; reason: string }>, diagnostics: [] as BookingStateClaimDiagnostic[] };
  if (!text) return res;
  const lines = String(text).split('\n').map(line => {
    const kept = line.split(/(?<=[.!?।])\s+/).filter(sn => {
      const v = verifyBookingStateClaim(sn, s);
      res.diagnostics.push(...v.diagnostics);
      if (v.reason) res.removed.push({ sentence: sn.trim().slice(0, 120), reason: v.reason });
      return !v.reason;
    });
    return kept.join(' ').trim();
  });
  res.text = res.removed.length ? lines.filter(Boolean).join('\n').trim() : text;
  return res;
}
