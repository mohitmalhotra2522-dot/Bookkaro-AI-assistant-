/** PROMPT 21 — Part 17: reply in the user's own style (Devanagari Hindi / Hinglish / English), no forced translation. */
export type LanguageStyle = 'HINGLISH' | 'HINDI' | 'ENGLISH';
const HINGLISH = /\b(hai|hain|ho|kal|parso|aaj|karo|kar|do|dena|dikhao|batao|wali|wala|mein|se|ka|ki|ke|ko|nahi|nahin|haan|achha|theek|chahiye|jaana|kitna|kitne|kaunsi|log|passenger ka|abhi|dobara|ruko|bas|sirf)\b/i;
const ENGLISH = /\b(the|is|are|to|for|from|want|please|i|i'm|me|my|need|show|check|what|how|which|can|you|tomorrow|today|book|train to|ticket for|yes|no)\b/i;

function styleOf(t: string): LanguageStyle | null {
  const dev = (t.match(/[\u0900-\u097F]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (dev > latin) return 'HINDI';
  if (HINGLISH.test(t)) return 'HINGLISH';
  if (ENGLISH.test(t)) return 'ENGLISH';
  return null;   // names / numbers / codes only ("Mohit 31 male", "12014", "CC") — no style signal
}

/** Style of `text`; without a signal, the most recent styled earlier user message decides (default Hinglish). */
export function detectLanguageStyle(text: string, earlierUserTexts: readonly string[] = []): LanguageStyle {
  const own = styleOf(String(text || ''));
  if (own) return own;
  for (let k = earlierUserTexts.length - 1; k >= 0; k--) { const st = styleOf(String(earlierUserTexts[k] || '')); if (st) return st; }
  return 'HINGLISH';
}
