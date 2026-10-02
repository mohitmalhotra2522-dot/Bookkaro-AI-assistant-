/**
 * Deterministic post-booking query classification (Prompt 14) — from the user's OWN words,
 * never from an LLM label (same discipline as the P13 locked-intent classifier).
 *
 *   PNR_STATUS     "PNR status check karo", "PNR 1234567890", "12014 wali booking ka PNR check karo"  → fresh CHECK_PNR
 *   LIVE_STATUS    "meri train abhi kaha hai?", "12014 track karo"                                   → fresh TRACK_TRAIN
 *   PNR_VALUE      "PNR kya hai?", "PNR batao"                                                       → authoritative record
 *   BOOKING_STATUS "Ticket book ho gayi?", "kal wali booking ka status?"                             → authoritative record
 *   BOOKING_DETAILS"latest ticket dikhao", "booking details"                                         → authoritative record
 *   HISTORY        "meri bookings dikhao", "booking history"                                         → authoritative records
 */
export type PostBookingQueryKind = 'PNR_STATUS' | 'LIVE_STATUS' | 'PNR_VALUE' | 'BOOKING_STATUS' | 'BOOKING_DETAILS' | 'HISTORY';

export const INFO_KINDS: ReadonlySet<PostBookingQueryKind> = new Set(['PNR_STATUS', 'LIVE_STATUS']);
/** Only read-only railway lookups may run during a post-booking information turn. */
export const POST_BOOKING_READ_ONLY_TOOLS: readonly string[] = ['CHECK_PNR', 'TRACK_TRAIN', 'GET_TIMETABLE', 'GET_TRAIN_INFO'];

const PNR_RE = /\bpnr\b|पीएनआर/i;
const PNR_STATUS_WORD = /\b(status|check|chek|stithi|chart|current|confirm hua|confirm hui|confirm hai kya|waiting|rac)\b/i;
const LIVE_RE = /\b(track|tracking|live status|live location|running status|kahan pahunchi|kaha pahunchi|kahan pahuchi|kaha pahuchi|kitni late|late chal|delay)\b|\babhi (kaha|kahan|kidhar)\b/i;
const TRAIN_WORD = /\b(train|gaadi|gadi|ट्रेन)\b|\b\d{5}\b/i;
const BOOKING_WORD = /\b(booking|bookings|ticket|tickets|tikat)\b/i;
const BOOKED_Q = /\b(book ho gayi|book ho gaya|book ho gya|book hui|book hua|booking ho gayi|booking hui|confirm ho gayi|confirm ho gaya|confirm hui|confirm hua)\b/i;
const SHOW_WORD = /\b(dikhao|dikha do|dikhana|batao|bata do|show|dekhna|dekho|details|detail|kya hai|kya tha|jaankari)\b/i;
const STATUS_WORD = /\b(status|kya hua|confirm hai)\b/i;
const HISTORY_WORD = /\b(bookings|tickets|history|sab booking|saari booking|sari booking|sabhi booking|meri sabhi)\b/i;
const BOOKING_INTENT = /\b(book karo|book kar do|book kardo|book karni|book karna|book karwa|karwa do|nayi booking|new booking|dobara book|phir se book|fir se book|cancel)\b/i;
const PLANNING_WORD = /\b(fare|kiraya|kiraaya|availability|available|seat|seats|search|trains)\b/i;

export function classifyPostBookingQuery(raw: string): PostBookingQueryKind | null {
  const t = String(raw || '').toLowerCase();
  if (!t.trim()) return null;
  if (BOOKING_INTENT.test(t)) return null;
  if (PNR_RE.test(t)) {
    // digits typed with "pnr" (even malformed → INVALID_PNR later, provider never called) or any 10-digit run
    if (/\bpnr\b\s*(?:no\.?|number|nambar|:|#)?\s*\d/i.test(t) || /(?<!\d)\d{10}(?!\d)/.test(t)) return 'PNR_STATUS';
    return PNR_STATUS_WORD.test(t) ? 'PNR_STATUS' : 'PNR_VALUE';
  }
  if (LIVE_RE.test(t) && (TRAIN_WORD.test(t) || /\btrack\b|live status|running status/.test(t))) return 'LIVE_STATUS';
  if (BOOKED_Q.test(t)) return 'BOOKING_STATUS';
  if (BOOKING_WORD.test(t)) {
    if (HISTORY_WORD.test(t) && SHOW_WORD.test(t)) return 'HISTORY';
    if (/\bbooking history\b/.test(t)) return 'HISTORY';
    if (STATUS_WORD.test(t)) return 'BOOKING_STATUS';
    if (SHOW_WORD.test(t)) return 'BOOKING_DETAILS';
  }
  return null;
}

/** Before a booking exists, booking-ish words may be ordinary planning ("ticket ka fare batao"). */
export function isPlanningQuestion(raw: string): boolean {
  return PLANNING_WORD.test(String(raw || '').toLowerCase());
}
