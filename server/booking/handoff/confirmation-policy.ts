/**
 * ConfirmationPolicy — the BACKEND decides whether a reply is an explicit booking
 * confirmation. The LLM may classify intent, but in AWAITING_CONFIRMATION a
 * confirmation is accepted only if the user's own words are EXPLICIT.
 *
 *   EXPLICIT   "haan", "haan book karo", "yes", "confirm", "book it", "continue", "bilkul"
 *   NEGATIVE   "nahi", "no", "cancel", "ruk jao", "abhi nahi"            → no handoff, back to REVIEW
 *   AMBIGUOUS  "theek hai", "okay", "ok", "haan?", "hmm", "chalo"        → ask "Booking confirm karni hai?"
 *   NONE       anything else (corrections, questions) — never a confirmation
 */
import { isPureNegation } from '../../ai/context/pending-interaction';

export type ConfirmationClass = 'EXPLICIT' | 'NEGATIVE' | 'AMBIGUOUS' | 'NONE';

/** @deprecated P42.1 — no longer sent: the backend never asks; it states the fact + structured pendingConfirmation. */
export const AMBIGUOUS_CONFIRMATION_PROMPT = 'Booking confirm karni hai?';
/** P42.1 (Category B): fact only — the confirmation is still REQUIRED (backend-verified); the LLM words the request. */
export const AMBIGUOUS_CONFIRMATION_FACT = 'Confirmation clear nahi hai — booking abhi confirm nahi hui.';

const EXPLICIT = new Set(['haan', 'haa', 'han', 'ha', 'haanji', 'ji', 'yes', 'yeah', 'yep', 'confirm', 'confirmed', 'book', 'bilkul', 'continue', 'proceed', 'हाँ', 'हां', 'जी']);
const AMBIGUOUS = new Set(['theek', 'thik', 'ok', 'okay', 'okk', 'achha', 'acha', 'accha', 'hmm', 'hmmm', 'hm', 'chalo', 'sahi', 'done', 'sure', 'fine', 'shayad', 'ठीक']);
const FILLER = new Set(['hai', 'kar', 'do', 'karo', 'kardo', 'it', 'please', 'plz', 'aage', 'badhao', 'sab', 'karna', 'karein', 'booking', 'details', 'hain', 'ji', 'bhai', 'है', 'कर', 'दो', 'ticket', 'now', 'abhi']);

export function classifyConfirmation(raw: string): ConfirmationClass {
  const text = String(raw || '').trim();
  if (!text) return 'NONE';
  if (isPureNegation(text)) return 'NEGATIVE';
  const toks = text.toLowerCase().replace(/[.,!।]/g, ' ').replace(/\?/g, ' ? ').split(/\s+/).filter(Boolean);
  const question = toks.includes('?');
  const words = toks.filter(w => w !== '?');
  if (!words.length) return 'NONE';
  if (words.some(w => w === 'nahi' || w === 'nahin' || w === 'no' || w === 'mat' || w === 'cancel')) return question ? 'AMBIGUOUS' : 'NONE';
  const hasExplicit = words.some(w => EXPLICIT.has(w));
  const hasAmbiguous = words.some(w => AMBIGUOUS.has(w));
  const allKnown = words.every(w => EXPLICIT.has(w) || AMBIGUOUS.has(w) || FILLER.has(w));
  if (question && (hasExplicit || hasAmbiguous) && allKnown) return 'AMBIGUOUS';     // "haan?" / "theek hai?"
  if (hasExplicit && !question) return 'EXPLICIT';
  if (hasAmbiguous && allKnown) return 'AMBIGUOUS';
  return 'NONE';
}
