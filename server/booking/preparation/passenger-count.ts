/**
 * PROMPT 19 — Parts 2–3: deterministic passenger-count parsing + validation.
 *
 *   "2 passengers" · "2 log" · "hum 3 hain" · "3 tickets" · "do passenger hain" · "one adult and one child"
 *   invalid: "zero passengers" · "minus two" · "-2 log" · "100 passengers" · "2.5 tickets"
 *
 * The existing Passenger contract has NO passenger category (adult / child / senior) field, so
 * "one adult and one child" is accepted as a COUNT of 2 only — no category is invented or stored; each
 * passenger's age (an existing field) is collected normally.
 *
 * The backend parses the user's OWN words. An LLM proposal can never turn an invalid count into a valid one
 * ("minus two" is INVALID_PASSENGER_COUNT even if an LLM proposes 2).
 */
import { MAX_PASSENGERS } from '@shared/constants';

const WORD_NUM: Record<string, number> = {
  zero: 0, shunya: 0, sifar: 0,
  one: 1, ek: 1, two: 2, do: 2, three: 3, teen: 3, four: 4, char: 4, chaar: 4, five: 5, paanch: 5, panch: 5,
  six: 6, chhe: 6, chheh: 6, che: 6, seven: 7, saat: 7, eight: 8, aath: 8, nine: 9, nau: 9, ten: 10, das: 10, dus: 10,
  eleven: 11, twelve: 12, twenty: 20, bees: 20, fifty: 50, pachaas: 50, hundred: 100, sau: 100
};
const NUM = `(-?\\d+(?:\\.\\d+)?|${Object.keys(WORD_NUM).join('|')})`;
const UNIT = '(?:passengers?|passanger|pasenger|log|logon|logo|tickets?|seats?|yatri|bande|members?|persons?|people|adults?|jan|जन|लोग)';
const CHILD = '(?:child|children|kids?|bacch?[ae]|bachch?[ae]|bachcha)';

export type PassengerCountInvalidReason = 'ZERO' | 'NEGATIVE' | 'TOO_MANY' | 'NOT_INTEGER';

export type PassengerCountParse =
  | { kind: 'COUNT'; count: number; breakdown?: { adults: number; children: number }; matched: string }
  | { kind: 'INVALID'; code: 'INVALID_PASSENGER_COUNT'; reason: PassengerCountInvalidReason; matched: string; message: string };

function toNumber(tok: string): number {
  const t = tok.toLowerCase();
  return t in WORD_NUM ? WORD_NUM[t] : Number(t);
}

/** Part 3 — integer, positive, ≤ MAX_PASSENGERS (existing session rule). */
export function validatePassengerCount(n: number): { ok: true; count: number } | { ok: false; code: 'INVALID_PASSENGER_COUNT'; reason: PassengerCountInvalidReason; message: string } {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, code: 'INVALID_PASSENGER_COUNT', reason: 'NOT_INTEGER', message: `Passengers ki sankhya poora number honi chahiye (1 se ${MAX_PASSENGERS}). Kitne passengers hain?` };
  if (n < 0) return { ok: false, code: 'INVALID_PASSENGER_COUNT', reason: 'NEGATIVE', message: `Passengers ki sankhya negative nahi ho sakti. 1 se ${MAX_PASSENGERS} ke beech batayein — kitne passengers hain?` };
  if (n === 0) return { ok: false, code: 'INVALID_PASSENGER_COUNT', reason: 'ZERO', message: `Kam se kam 1 passenger hona zaroori hai. Kitne passengers hain?` };
  if (n > MAX_PASSENGERS) return { ok: false, code: 'INVALID_PASSENGER_COUNT', reason: 'TOO_MANY', message: `Ek booking mein maximum ${MAX_PASSENGERS} passengers ho sakte hain. Kitne passengers hain?` };
  return { ok: true, count: n };
}

function result(n: number, matched: string, breakdown?: { adults: number; children: number }): PassengerCountParse {
  const v = validatePassengerCount(n);
  return v.ok ? { kind: 'COUNT', count: v.count, matched, ...(breakdown ? { breakdown } : {}) } : { kind: 'INVALID', code: v.code, reason: v.reason, matched, message: v.message };
}

/**
 * Parse a passenger-count statement from the user's own words.
 * `expectingCount` — the backend asked "Kitne passengers hain?" so a bare number ("3") is a count.
 * Returns null when the text does not state a passenger count (train numbers, ages, dates are ignored).
 */
export function parsePassengerCount(text: string, opts: { expectingCount?: boolean } = {}): PassengerCountParse | null {
  const t = ` ${String(text || '').toLowerCase().replace(/[!?]/g, ' ').replace(/\s+/g, ' ')} `;

  // "one adult and one child" / "2 adults, 1 bachcha" → total only (no category field in the contract)
  const mix = t.match(new RegExp(`\\b${NUM}\\s*adults?\\s*(?:and|aur|,|&|\\+)\\s*${NUM}\\s*${CHILD}\\b`));
  if (mix) {
    const a = toNumber(mix[1]), c = toNumber(mix[2]);
    return result(a + c, mix[0].trim(), { adults: a, children: c });
  }

  // "minus two" / "minus 2 passengers"
  const minus = t.match(new RegExp(`\\bminus\\s+${NUM}(?:\\s*${UNIT})?\\b`));
  if (minus && (opts.expectingCount || new RegExp(UNIT).test(t) || /^\s*minus\s+\S+\s*$/.test(t))) return result(-toNumber(minus[1]), minus[0].trim());

  // "hum 3 hain" / "hum teen log hain" / "we are 3"
  const hum = t.match(new RegExp(`\\b(?:hum|ham|we are|we're)\\s+${NUM}(?:\\s*${UNIT})?\\s*(?:hain|hai|he|h)?\\b`));
  if (hum) return result(toNumber(hum[1]), hum[0].trim());

  // "<n> passengers" — a 4+ digit token directly before the unit is never a count we accept silently
  const abs = t.match(new RegExp(`(?:^|\\s)${NUM}\\s*${UNIT}(?=\\s|[.,;:]|$)`));
  if (abs) {
    // "2 aur passengers" is a delta (handled elsewhere) — "aur" sits between number and unit, so it never matches here
    return result(toNumber(abs[1]), abs[0].trim());
  }

  // bare number while the backend is asking for the count ("3", "teen", "0", "100")
  if (opts.expectingCount) {
    const bare = t.match(new RegExp(`^\\s*${NUM}\\s*(?:hain|hai|h)?\\s*[.]?\\s*$`));
    if (bare) return result(toNumber(bare[1]), bare[0].trim());
  }
  return null;
}
