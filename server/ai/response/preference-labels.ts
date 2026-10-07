/**
 * P42.1 FINAL HARDENING — internal passenger-preference codes never reach the user.
 *
 * The schema keeps its enums (NO_PREFERENCE, WINDOW, SIDE_UPPER, VEG, NON_VEG, NO_FOOD …). Muse is told to say them
 * naturally; this display step is the backstop for LLM-written text on BOTH reply paths (screen compose + voice
 * composer): an all-caps code is replaced by the same natural label the review / passenger form already use. It adds
 * no sentence, removes nothing and asks nothing. Only the exact upper-case code is touched ("window", "Veg" in normal
 * prose stay as written), and never inside an all-caps name such as a train name ("UPPER INDIA EXP").
 */

const CODE_LABEL: Record<string, string> = {
  NO_PREFERENCE: 'no preference', WINDOW: 'window side', WINDOW_SIDE: 'window side',
  LOWER: 'lower', MIDDLE: 'middle', UPPER: 'upper', SIDE_LOWER: 'side lower', SIDE_UPPER: 'side upper', SIDE_MIDDLE: 'side middle',
  CABIN: 'cabin', COUPE: 'coupe', VEG: 'veg', NON_VEG: 'non-veg', NONVEG: 'non-veg', NO_FOOD: 'no food'
};

/** Upper-case code, incl. the space / hyphen variants an LLM writes ("NO FOOD", "NON-VEG", "NON‑VEG" with U+2011). */
const CODE_RE = /(?<![A-Za-z0-9_])(NO[_ ]PREFERENCE|WINDOW(?:_SIDE)?|SIDE[_ ](?:LOWER|UPPER|MIDDLE)|NON[_\-\u2010\u2011\u2012\u2013 ]?VEG|NO[_ ]FOOD|LOWER|MIDDLE|UPPER|CABIN|COUPE|VEG)(?![A-Za-z0-9_])/g;

/** All-caps words that may stand next to a code without making it part of a name (class codes, abbreviations). */
const ALLOWED_CAPS = new Set(['CC', 'EC', 'SL', '2S', '3A', '2A', '1A', '3E', 'FC', 'EA', 'EV', 'VS', 'AC', 'IRCTC', 'PNR', 'RAC', 'WL', 'GN', 'OR', 'YA']);

const canonical = (raw: string) => raw.replace(/[\s\-\u2010-\u2013]/g, '_');

/** The all-caps-looking word next to [from] (skipping spaces / commas / slashes) with its span. */
function neighbourWord(text: string, from: number, dir: -1 | 1): { word: string; start: number; end: number } {
  let i = from;
  while (i >= 0 && i < text.length && /[\s,/]/.test(text[i])) i += dir;
  let j = i;
  while (j >= 0 && j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += dir;
  const [start, end] = dir === 1 ? [i, j] : [j + 1, i + 1];
  return { word: text.slice(start, end), start, end };
}

const isCapsWord = (w: string) => /^[A-Z][A-Z0-9_]+$/.test(w);

/** Replaces internal preference codes in user-facing (LLM-written) text with natural labels. */
export function humanizePreferenceCodes(text: string): string {
  const src = String(text ?? '');
  if (!src || !/[A-Z]{3}/.test(src)) return src;
  const spans: Array<[number, number]> = [];
  for (const m of src.matchAll(CODE_RE)) if (CODE_LABEL[canonical(m[0])]) spans.push([m.index!, m.index! + m[0].length]);
  const inCode = (n: { start: number; end: number }) => spans.some(([a, b]) => n.start < b && n.end > a);
  // a neighbour that is an all-caps word, not a code and not a class code / abbreviation → this "code" is part of a name
  const blocks = (n: { word: string; start: number; end: number }) => isCapsWord(n.word) && !inCode(n) && !ALLOWED_CAPS.has(n.word);
  return src.replace(CODE_RE, (m: string, _g: string, offset: number) => {
    const label = CODE_LABEL[canonical(m)];
    if (!label) return m;
    if (blocks(neighbourWord(src, offset - 1, -1)) || blocks(neighbourWord(src, offset + m.length, 1))) return m;
    const sentenceStart = /(^|[.!?।:\n]\s*)$/.test(src.slice(0, offset));
    return sentenceStart ? label[0].toUpperCase() + label.slice(1) : label;
  });
}

/** True when the text still shows an internal preference code (test / diagnostics helper). */
export function containsPreferenceCode(text: string): boolean {
  return /(?<![A-Za-z0-9_])(NO_PREFERENCE|SIDE_LOWER|SIDE_UPPER|SIDE_MIDDLE|NON_VEG|NO_FOOD)(?![A-Za-z0-9_])/.test(String(text ?? ''));
}
