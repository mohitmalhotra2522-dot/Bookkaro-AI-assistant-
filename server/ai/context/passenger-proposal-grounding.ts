/**
 * P42.1 FINAL HARDENING — grounding of the LLM's passenger proposals BEFORE the backend applies them.
 *
 * Muse (or the user-selected fallback LLM) understands the user's words semantically and PROPOSES passenger changes;
 * this module only checks, deterministically and language-agnostically, that two things are actually grounded in what
 * the user said. It never interprets Hindi / English words, never transliterates and never writes wording.
 *
 *   1. Passenger NAME — stored in Latin (English) letters only (IRCTC). A proposed name in another script (Devanagari
 *      "रवि" from STT) is not stored. A Latin name the user never wrote while their message is in another script
 *      (Muse silently transliterating "रवि" → "Ravi") is not stored either. Both → structured
 *      INVALID_PASSENGER_NAME_SCRIPT (field=name, userActionRequired=true); Muse asks for the English spelling.
 *   2. Optional PREFERENCES (berthPreference / foodPreference) — never invented. A proposed preference is stored only
 *      with `userWords`: the user's own words from THIS message that state / confirm it, which must occur verbatim in
 *      this message. No words / words not in the message → not stored (UNSET stays UNSET; an explicit "no preference"
 *      stays an explicit NO_PREFERENCE only when the user said it).
 *
 * The other fields of the same proposal are untouched (validated by PassengerChangeValidator as before). Rejections
 * carry passenger index + field + reason only — never the proposed value (privacy).
 */
import type { BookingSession } from '@shared/entities';
import { isLatinName } from '../../booking/passenger-validator';

export type PassengerProposalRejectionReason = 'INVALID_PASSENGER_NAME_SCRIPT' | 'PREFERENCE_NOT_STATED_BY_USER';
export interface PassengerProposalRejection {
  passengerIndex: number | null;
  field: 'name' | 'berthPreference' | 'foodPreference';
  reason: PassengerProposalRejectionReason;
  userActionRequired: boolean;
}

const PREFERENCE_FIELDS = ['berthPreference', 'foodPreference'] as const;
/** A letter outside the Latin script (Devanagari, Gurmukhi, …). */
const NON_LATIN_LETTER = /(?![\p{Script=Latin}])\p{L}/u;

const norm = (t: string) => String(t || '').normalize('NFC').toLowerCase()
  .replace(/[\u2010-\u2015]/g, '-').replace(/[.,!?;:"'“”‘’()।|]/g, ' ').replace(/\s+/g, ' ').trim();

/** `userWords` (string or string[]) all occur verbatim (case / punctuation / spacing-insensitive) in the user's text. */
export function userWordsInText(userWords: unknown, userText: string): boolean {
  const list = (Array.isArray(userWords) ? userWords : [userWords]).filter(w => typeof w === 'string') as string[];
  const t = ` ${norm(userText)} `;
  const words = list.map(norm).filter(w => w.length >= 2);
  return words.length > 0 && words.every(w => t.includes(w));
}

/**
 * The proposed preference VALUE itself is in the user's words of this turn ("…32 male lower", "veg", "विंडो सीट",
 * "koi preference nahi"). Checks the LLM's proposal against what the user said — never a router, never fills anything.
 */
const VALUE_WORDS: Record<string, RegExp> = {
  LOWER: /(?<!side[\s-]?)\blower\b|(?<!साइड\s?)लोअर/,
  MIDDLE: /(?<!side[\s-]?)\bmiddle\b|(?<!साइड\s?)मिडिल/,
  UPPER: /(?<!side[\s-]?)\bupper\b|(?<!साइड\s?)अपर/,
  SIDE_LOWER: /\bside[\s-]?lower\b|साइड\s?लोअर/,
  SIDE_MIDDLE: /\bside[\s-]?middle\b|साइड\s?मिडिल/,
  SIDE_UPPER: /\bside[\s-]?upper\b|साइड\s?अपर/,
  WINDOW: /\bwindow\b|विंडो|खिड़की/,
  CABIN: /\bcabin\b|केबिन/,
  COUPE: /\bcoupe\b|कूपे/,
  NO_PREFERENCE: /\bno[\s-]?preference\b|\bkoi (?:bhi )?preference nahi?\b|कोई (?:भी )?(?:प्रेफरेंस|प्रेफ़रेंस|preference|पसंद|प्राथमिकता) नहीं/,
  VEG: /(?<!non[\s-]?)\bveg\b|(?<!नॉन[\s-]?)वेज|(?<!मां)शाकाहारी/,
  NON_VEG: /\bnon[\s-]?veg\b|नॉन[\s-]?वेज|मांसाहारी/,
  NO_FOOD: /\bno[\s-]?food\b|\bkhana nahi\b|खाना नहीं/
};
function valueStated(value: unknown, userText: string): boolean {
  const code = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  const re = VALUE_WORDS[code];
  return !!re && re.test(norm(userText));
}

/** The user is spelling something letter by letter ("R A V I", "आर ए वी आई"). */
function spellsLetters(userText: string): boolean {
  const toks = norm(userText).split(/[\s-]+/).filter(Boolean);
  let run = 0;
  for (const w of toks) {
    run = [...w].length <= 2 ? run + 1 : 0;
    if (run >= 3) return true;
  }
  return false;
}

/**
 * A Latin name the user did not write: every word of the proposed name must occur in the user's message whenever the
 * message contains another script (else it is the LLM's own transliteration). Latin-only messages are not checked
 * here (unchanged behaviour); letter-by-letter spelling is the user's own spelling.
 */
function transliterated(name: string, userText: string): boolean {
  if (!NON_LATIN_LETTER.test(userText)) return false;
  if (spellsLetters(userText)) return false;
  const t = ` ${norm(userText)} `;
  return !name.toLowerCase().split(/\s+/).filter(Boolean).every(w => t.includes(norm(w)));
}

function storedName(s: BookingSession | undefined, passengerIndex: unknown): string | null {
  const i = Number(passengerIndex);
  const p: any = Number.isInteger(i) && i >= 1 ? (s?.passengers || [])[i - 1] : null;
  return p && typeof p.name === 'string' ? p.name : null;
}

/** Grounds ONE proposal's `changes` (input not mutated); returns the kept changes + rejections. */
function groundChanges(changes: Record<string, any>, passengerIndex: number | null, userWords: unknown, userText: string, s?: BookingSession) {
  const kept: Record<string, any> = { ...changes };
  const rejections: PassengerProposalRejection[] = [];
  if (typeof kept.name === 'string' && kept.name.trim()) {
    const name = kept.name.trim();
    const same = storedName(s, passengerIndex);
    const unchanged = !!same && same.toLowerCase() === name.toLowerCase();
    if (!unchanged && (!isLatinName(name.replace(/\s+/g, ' ')) || transliterated(name, userText))) {
      delete kept.name;
      rejections.push({ passengerIndex, field: 'name', reason: 'INVALID_PASSENGER_NAME_SCRIPT', userActionRequired: true });
    }
  }
  for (const f of PREFERENCE_FIELDS) {
    if (kept[f] === undefined || kept[f] === null || kept[f] === '') continue;
    if (!userWordsInText(userWords, userText) && !valueStated(kept[f], userText)) {
      delete kept[f];
      rejections.push({ passengerIndex, field: f, reason: 'PREFERENCE_NOT_STATED_BY_USER', userActionRequired: false });
    }
  }
  return { kept, rejections };
}

/**
 * Grounds the passenger proposals of one LLM decision against the user's words of THIS turn. Returns a new entities
 * object (the decision's other entities untouched) and the rejections. `userWords` is consumed here (never stored).
 */
export function groundPassengerProposals<E extends Record<string, any>>(entities: E | undefined, userText: string, s?: BookingSession): { entities: E | undefined; rejections: PassengerProposalRejection[] } {
  if (!entities || typeof entities !== 'object') return { entities, rejections: [] };
  const rejections: PassengerProposalRejection[] = [];
  const out: any = { ...entities };
  if (Array.isArray(out.passengerChanges)) {
    out.passengerChanges = out.passengerChanges.map((pc: any) => {
      if (!pc || typeof pc !== 'object' || !pc.changes || typeof pc.changes !== 'object') return pc;
      const g = groundChanges(pc.changes, Number.isFinite(Number(pc.passengerIndex)) ? Number(pc.passengerIndex) : null, pc.userWords, userText, s);
      rejections.push(...g.rejections);
      const { userWords: _w, ...rest } = pc;
      return { ...rest, changes: g.kept };
    }).filter((pc: any) => !pc || typeof pc !== 'object' || !pc.changes || Object.keys(pc.changes).length > 0);
    if (!out.passengerChanges.length) delete out.passengerChanges;
  }
  // the internal passengerUpdates shape is not part of the native tool schema, but an LLM can still send it
  if (Array.isArray(out.passengerUpdates)) {
    out.passengerUpdates = out.passengerUpdates.map((u: any) => {
      if (!u || typeof u !== 'object' || !u.fields || typeof u.fields !== 'object') return u;
      const idx = u.ref && u.ref.kind === 'INDEX' && Number.isFinite(Number(u.ref.value)) ? Number(u.ref.value) : null;
      const g = groundChanges(u.fields, idx, u.userWords, userText, s);
      rejections.push(...g.rejections);
      const { userWords: _w, ...rest } = u;
      return { ...rest, fields: g.kept };
    }).filter((u: any) => !u || typeof u !== 'object' || !u.fields || Object.keys(u.fields).length > 0);
    if (!out.passengerUpdates.length) delete out.passengerUpdates;
  }
  return { entities: out as E, rejections };
}
