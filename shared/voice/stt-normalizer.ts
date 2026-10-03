/**
 * PROMPT 21 — STT transcript normalization (Part 1 "STT / Streaming Transcript", Part 17 Hinglish).
 *
 * Speech recognisers return spoken forms ("ek do zero ek chaar", "see see", "०४", "umm kal"). This module turns a
 * FINAL transcript into the same canonical text a user would type, so voice and text reach the SAME
 * ConversationTurnEngine.processTurn() with the same meaning (Part 31 — no drift between modes).
 *
 * It never invents content: it only rewrites unambiguous spoken forms. Partial transcripts are never normalized into
 * actions — they are display-only until the VoiceTurnDetector reports end-of-turn (Part 11).
 */
const DEVANAGARI_DIGITS: Record<string, string> = { '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9' };

/** Single spoken digits (Hindi / English / Devanagari words). Only RUNS of ≥ 4 are joined (train numbers, PNRs). */
const DIGIT_WORDS: Record<string, string> = {
  zero: '0', shunya: '0', sunya: '0', oh: '0', 'शून्य': '0',
  ek: '1', one: '1', 'एक': '1',
  do: '2', two: '2', 'दो': '2',
  teen: '3', three: '3', 'तीन': '3',
  char: '4', chaar: '4', four: '4', 'चार': '4',
  paanch: '5', panch: '5', five: '5', 'पांच': '5', 'पाँच': '5',
  chhe: '6', chheh: '6', che: '6', six: '6', 'छह': '6', 'छः': '6',
  saat: '7', seven: '7', 'सात': '7',
  aath: '8', eight: '8', 'आठ': '8',
  nau: '9', nine: '9', 'नौ': '9'
};
const MIN_DIGIT_RUN = 4;

/** Spoken class names → class codes (only full, unambiguous phrases). */
const CLASS_PHRASES: Array<[RegExp, string]> = [
  [/\b(see\s*see|c\s*c|chair\s*car|सीसी|सी\s*सी)\b/giu, 'CC'],
  [/\b(two\s*s|2\s*s|second\s*sitting|सेकंड\s*सिटिंग)\b/giu, '2S'],
  [/\b(three\s*a|3\s*a|third\s*a\.?\s*c\.?|three\s*tier\s*ac)\b/giu, '3A'],
  [/\b(two\s*a|2\s*a|second\s*a\.?\s*c\.?|two\s*tier\s*ac)\b/giu, '2A'],
  [/\b(one\s*a|1\s*a|first\s*a\.?\s*c\.?)\b/giu, '1A'],
  [/\b(sleeper\s*class|स्लीपर)\b/giu, 'SL'],
  [/\b(executive\s*chair\s*car|e\s*c)\b/giu, 'EC']
];

/** Leading hesitation fillers (never meaningful). */
const LEADING_FILLERS = /^(?:\s*(?:umm+|um+|uh+|uhh+|hmm+|err+|aa+h?|matlab|like)\b[\s,.]*)+/i;
const INNER_FILLERS = /\s*\b(?:umm+|uhh+|hmm+|err+)\b\s*/gi;

export interface NormalizedTranscript {
  text: string;
  /** Which rewrites were applied (observability — never contains the transcript itself). */
  applied: string[];
}

export function normalizeTranscript(raw: string): NormalizedTranscript {
  const applied: string[] = [];
  let t = String(raw || '').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
  if (!t) return { text: '', applied };

  const dev = t.replace(/[०-९]/g, d => DEVANAGARI_DIGITS[d] || d);
  if (dev !== t) { t = dev; applied.push('DEVANAGARI_DIGITS'); }

  const noLead = t.replace(LEADING_FILLERS, '');
  const noFill = noLead.replace(INNER_FILLERS, ' ').replace(/\s+/g, ' ').trim();
  if (noFill !== t) { t = noFill; applied.push('FILLERS'); }

  // "ek do zero ek chaar" → "12014" (runs of ≥ 4 single-digit words or digits)
  const toks = t.split(' ');
  const out: string[] = [];
  for (let i = 0; i < toks.length;) {
    let j = i; const run: string[] = [];
    while (j < toks.length) {
      const w = toks[j].toLowerCase().replace(/[,.]$/, '');
      const d = DIGIT_WORDS[w] ?? (/^\d$/.test(w) ? w : undefined);
      if (d === undefined) break;
      run.push(d); j++;
    }
    if (run.length >= MIN_DIGIT_RUN) { out.push(run.join('')); applied.includes('SPOKEN_DIGITS') || applied.push('SPOKEN_DIGITS'); i = j; }
    else { out.push(toks[i]); i++; }
  }
  t = out.join(' ');

  for (const [re, code] of CLASS_PHRASES) {
    const n = t.replace(re, code);
    if (n !== t) { t = n; applied.includes('CLASS_PHRASE') || applied.push('CLASS_PHRASE'); }
  }

  // immediate word repetition from recogniser stutter: "kal kal" → "kal"
  const dedup = t.replace(/\b(\p{L}+)(\s+\1\b)+/giu, '$1');
  if (dedup !== t) { t = dedup; applied.push('REPEATED_WORD'); }

  return { text: t.trim(), applied };
}
