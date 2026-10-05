/**
 * P38 — Devanagari number normalization for VALIDATION of LLM proposals (passenger count / grounding).
 * The LLM interprets the user's words; the backend only checks that a proposed count appears in them. Devanagari digits
 * (०–९) and the closed set of number words 1–10 (+ passenger units) are mapped to their ASCII equivalents so that check
 * works for "दो लोग" / "हम तीन हैं" / "२ यात्री" too. This is not an intent parser: nothing is extracted from it on its own.
 */
const DIGITS: Record<string, string> = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };
const WORDS: Array<[RegExp, string]> = [
  [/एक/g, ' 1 '], [/दो/g, ' 2 '], [/तीन/g, ' 3 '], [/चार/g, ' 4 '], [/पाँच|पांच/g, ' 5 '], [/छह|छः|छे/g, ' 6 '],
  [/सात/g, ' 7 '], [/आठ/g, ' 8 '], [/नौ/g, ' 9 '], [/दस/g, ' 10 ']
];
const UNITS = /(लोग|लोगों|यात्री|यात्रियों|पैसेंजर|पैसेंजरों|टिकट|टिकटें|जन|सीटें|सीट)/g;
export function normalizeDevanagariNumbers(text: string): string {
  let t = String(text || '');
  if (!/[\u0900-\u097F]/.test(t)) return t;
  t = t.replace(/[०-९]/g, d => DIGITS[d]);
  // only standalone words (surrounded by space / punctuation / string edge) — "दोस्त" is not "दो"
  for (const [re, v] of WORDS) t = t.replace(new RegExp(`(^|[\\s,.!?।])(?:${re.source})(?=$|[\\s,.!?।])`, 'g'), `$1${v}`);
  t = t.replace(new RegExp(`(^|[\\s,.!?।])(?:${UNITS.source})(?=$|[\\s,.!?।])`, 'g'), '$1 log ');
  return t.replace(/\s+/g, ' ');
}
