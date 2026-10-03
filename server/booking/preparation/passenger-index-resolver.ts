/**
 * PROMPT 19 — Part 6: deterministic passenger index (1-based) from the user's words.
 *   "first passenger" · "second passenger" · "passenger 2" · "pehla" · "doosre wale ka naam" · "meri details" (= passenger 1)
 * Resolution is against the CURRENT passenger list only; an index outside it is INVALID_PASSENGER_INDEX.
 * The LLM may propose an index — this resolver / PassengerChangeValidator decide.
 */
import type { BookingSession } from '@shared/entities';

const ORDINALS: Array<[RegExp, number]> = [
  [/\b(first|1st|pehl[aeiy]|pahl[aeiy]|pehle wal[aei])\b/, 1],
  [/\b(second|2nd|doosr[aeiy]|dusr[aeiy]|dusre wal[aei])\b/, 2],
  [/\b(third|3rd|teesr[aeiy]|tisr[aeiy])\b/, 3],
  [/\b(fourth|4th|chauth[aeiy]|chautha)\b/, 4],
  [/\b(fifth|5th|paanchv[aeiy]|panchv[aeiy])\b/, 5],
  [/\b(sixth|6th|chhath[aeiy]|chhatv[aeiy])\b/, 6]
];

export type PassengerIndexResolution =
  | { ok: true; passengerIndex: number; passengerId: string; via: 'ORDINAL' | 'NUMBER' | 'SELF' }
  | { ok: false; code: 'INVALID_PASSENGER_INDEX'; passengerIndex: number; message: string }
  | null;

/** Extract the passenger index the text refers to (null = no passenger reference in the text). */
export function passengerIndexIn(text: string): { index: number; via: 'ORDINAL' | 'NUMBER' | 'SELF' } | null {
  const t = ` ${String(text || '').toLowerCase()} `;
  const num = t.match(/\bpassenger\s*(?:no\.?|number|#)?\s*(\d)\b/) || t.match(/\b(\d)(?:st|nd|rd|th)?\s+passenger\b/);
  if (num) return { index: Number(num[1]), via: 'NUMBER' };
  // an ordinal only counts as a PASSENGER reference when it is not about a train / class / date
  if (!/\b(train|gaadi|class|tareekh|date|wali train|wala train)\b/.test(t)) {
    for (const [re, i] of ORDINALS) if (re.test(t)) return { index: i, via: 'ORDINAL' };
  }
  if (/\b(meri|mera|mere|my|apni|apna)\s+(details?|naam|name|age|umar|gender)\b/.test(t)) return { index: 1, via: 'SELF' };
  return null;
}

export function resolvePassengerIndex(s: BookingSession, text: string): PassengerIndexResolution {
  const hit = passengerIndexIn(text);
  if (!hit) return null;
  return resolveIndexNumber(s, hit.index, hit.via);
}

export function resolveIndexNumber(s: BookingSession, index: number, via: 'ORDINAL' | 'NUMBER' | 'SELF' = 'NUMBER'): PassengerIndexResolution {
  const ps = s.passengers || [];
  if (!Number.isInteger(index) || index < 1 || index > ps.length) {
    return { ok: false, code: 'INVALID_PASSENGER_INDEX', passengerIndex: index, message: ps.length
      ? `Passenger ${index} nahi hai — abhi ${ps.length} passenger${ps.length > 1 ? 's' : ''} hain.`
      : 'Abhi koi passenger record nahi hai.' };
  }
  return { ok: true, passengerIndex: index, passengerId: ps[index - 1].id, via };
}
