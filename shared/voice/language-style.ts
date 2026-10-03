/** PROMPT 21 — Part 17: reply in the user's own style (Devanagari Hindi / Hinglish / English), no forced translation. */
export type LanguageStyle = 'HINGLISH' | 'HINDI' | 'ENGLISH';
// Prompt 25 Part 7: DOMINANT language of the message (marker counts), so "Which train reaches earliest? do tell" stays
// English and "please book karke payment bhi kar do" stays Hinglish. Words shared by both languages ("do", "to",
// "no", "log") carry no weight.
const HINGLISH_W = /\b(hai|hain|ho|kal|parso|aaj|karo|kar|karke|karna|karni|dena|dikhao|batao|bataiye|wali|wala|wale|mein|se|ka|ki|ke|ko|nahi|nahin|haan|achha|accha|theek|chahiye|jaana|jana|kitna|kitne|kaunsi|kaunsa|kya|kyun|kab|kahan|abhi|dobara|ruko|bas|sirf|bhi|aur|lekin|mujhe|hum|humein|aap|aapka|aapki|yeh|ye|woh|wo|tak|liye|sabse|pehle|pahunchti|chalti|milegi|hoga|hogi)\b/gi;
const ENGLISH_W = /\b(the|is|are|was|were|for|from|want|please|i|i'm|me|my|need|show|check|what|how|which|when|where|why|can|could|would|should|you|your|tomorrow|today|book|ticket|yes|it|this|that|these|those|there|of|and|or|with|reaches|reach|arrive|arrives|leave|leaves|earliest|first|fastest|cheapest|available|tell|about|does|do you|will|have|has)\b/gi;

function styleOf(t: string): LanguageStyle | null {
  const dev = (t.match(/[\u0900-\u097F]/g) || []).length;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  if (dev > latin) return 'HINDI';
  const h = (t.match(HINGLISH_W) || []).length;
  const e = (t.match(ENGLISH_W) || []).length;
  if (!h && !e) return null;   // names / numbers / codes only ("Mohit 31 male", "12014", "CC") — no style signal
  return e > h ? 'ENGLISH' : 'HINGLISH';
}

/** Style of `text`; without a signal, the most recent styled earlier user message decides (default Hinglish). */
export function detectLanguageStyle(text: string, earlierUserTexts: readonly string[] = []): LanguageStyle {
  const own = styleOf(String(text || ''));
  if (own) return own;
  for (let k = earlierUserTexts.length - 1; k >= 0; k--) { const st = styleOf(String(earlierUserTexts[k] || '')); if (st) return st; }
  return 'HINGLISH';
}
