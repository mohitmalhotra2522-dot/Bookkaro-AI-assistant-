/**
 * Post-P42.10 F1 — truthful preference-memory claims ("AC class preference yaad rakh liya", "I'll remember you prefer
 * morning trains").
 *
 * Like Prompt 29's action claims, the words only say WHAT is claimed (saved / remembered + which class family / time
 * window); the AUTHORITATIVE session state after the turn decides whether it is true. The preference is stored only by the
 * existing update_booking_session path (turn-applier 7b → session.preferredClass / preferredTime). A claim the session does
 * not hold is removed (clause level) and replaced by an honest, natural "could not be saved" line — the user never hears
 * that a preference was remembered when it was not.
 *
 * Not claims: offers / questions ("yaad rakhun?"), negations ("save nahi ho paayi"), passenger-detail acknowledgements
 * ("naam note kar liya" — no preference wording) and berth / seat / food wording (passenger details, not session
 * preferences — governed by the passenger flow). No new memory store; never calls a tool; never mutates the session.
 */

export interface PreferenceClaimDiagnostic {
  claim: string;
  claimedClass: 'AC' | 'NON_AC' | 'ANY' | null;
  claimedTime: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | null;
  sessionClass: string | null;
  sessionTime: string | null;
  validationStatus: 'VALID' | 'REJECTED';
  removalReason: 'PREFERENCE_NOT_SAVED' | 'PREFERENCE_MISMATCH' | null;
}
export interface PreferenceGuardResult { text: string; removed: string[]; diagnostics: PreferenceClaimDiagnostic[]; }

// "saved / remembered" — affirmative completion or commitment (Roman Hinglish, English, Devanagari)
const SAVE_RE = /(yaad\s+rakh\s*(?:liya|li|lunga|lungi|loonga|loongi|unga|ungi|enge|a\s+hai|i\s+hai|i\s+gayi|a\s+gaya)|yaad\s+kar\s+(?:liya|li)|save\s+(?:kar\s+)?(?:liya|li|di|diya|lunga|lungi|ho\s+gay[ai])|note\s+kar\s+(?:liya|li|lunga|lungi)|\bi(?:'ll|\s+will)\s+remember\b|\bi(?:'ve|\s+have)\s+(?:saved|noted|remembered)\b|\b(?:saved|remembered|noted)\s+(?:your|that|it|the)\b|याद\s+रख\s*(?:लिया|ली|लूंगा|लूँगा|लूंगी|लूँगी)|सेव\s+कर\s+(?:लिया|ली|दिया|दी))/i;
// a PREFERENCE is what is claimed (not a passenger detail)
const PREF_CTX_RE = /(prefer\w*|preference|pasand|\bac\b|non[\s-]?ac|sleeper|\b(?:1A|2A|3A|3E|CC|EC|SL|2S|FC)\b|subah|morning|dopahar|afternoon|shaam|evening|raat|night|पसंद|एसी|सुबह|शाम|रात)/i;
// berth / seat / food = passenger details — not a session preference, never judged here
const PASSENGER_RE = /(window|berth|lower|upper|middle|side\s|seat\s+pref|\bveg\b|non[\s-]?veg|meal|food|khana|बर्थ|खाना)/i;
const NEG_RE = /(\bnahi\b|\bnahin\b|\bnot\b|\bcouldn'?t\b|\bcan'?t\b|\bcannot\b|\bunable\b|\bna\s+ho\b|नहीं|न\s+हो)/i;
const OFFER_RE = /(\?|\b(?:karun|karoon|rakhun|rakhoon|kar\s+doon|kar\s+du|kar\s+dun|shall\s+i|should\s+i|want\s+me|do\s+you\s+want|chahenge|chahte)\b|रखूं|रखूँ|करूं|करूँ)/i;
const SENT_SPLIT = /(?<=[.!?।])\s+/;

function claimedClassOf(t: string): PreferenceClaimDiagnostic['claimedClass'] {
  if (/non[\s-]?ac|sleeper|\bSL\b|\b2S\b|general|नॉन/i.test(t)) return 'NON_AC';
  if (/\bany\s+class\b|koi\s+bhi\s+class/i.test(t)) return 'ANY';
  if (/\bac\b|\b(?:1A|2A|3A|3E|CC|EC|FC)\b|एसी/i.test(t)) return 'AC';
  return null;
}
function claimedTimeOf(t: string): PreferenceClaimDiagnostic['claimedTime'] {
  if (/subah|morning|सुबह/i.test(t)) return 'MORNING';
  if (/dopahar|afternoon|दोपहर/i.test(t)) return 'AFTERNOON';
  if (/shaam|evening|शाम/i.test(t)) return 'EVENING';
  if (/raat|night|रात/i.test(t)) return 'NIGHT';
  return null;
}

/** Detect a preference-saved claim in ONE sentence (null = not such a claim). */
export function detectPreferenceClaim(sentence: string): { claimedClass: PreferenceClaimDiagnostic['claimedClass']; claimedTime: PreferenceClaimDiagnostic['claimedTime'] } | null {
  const t = String(sentence || '');
  if (!SAVE_RE.test(t) || !PREF_CTX_RE.test(t)) return null;
  if (PASSENGER_RE.test(t) || NEG_RE.test(t) || OFFER_RE.test(t)) return null;
  return { claimedClass: claimedClassOf(t), claimedTime: claimedTimeOf(t) };
}

/** Honest "not saved" line in the reply's own style (no internal error codes). */
export function preferenceNotSavedLine(styleSample: string): string {
  const s = String(styleSample || '');
  if ((s.match(/[\u0900-\u097F]/g) || []).length > (s.match(/[A-Za-z]/g) || []).length) return 'यह पसंद अभी सेव नहीं हो पाई।';
  if (/\b(i'll|i will|i've|remember|saved|your|the|you)\b/i.test(s) && !/\b(hai|kar|liya|aap|mein|nahi)\b/i.test(s)) return "I couldn't save that preference right now.";
  return 'Ye preference abhi save nahi ho paayi.';
}

/**
 * Guard a whole reply against the session state AFTER the turn. A claim is valid only when the session holds every
 * class family / time window the sentence names (or, if it names none, holds some preference).
 */
export function guardPreferenceClaims(text: string, session: any): PreferenceGuardResult {
  const res: PreferenceGuardResult = { text, removed: [], diagnostics: [] };
  if (!text || !SAVE_RE.test(text)) return res;
  const sessionClass: string | null = session?.preferredClass ?? null;
  const sessionTime: string | null = session?.preferredTime ?? null;
  const lines = String(text).split('\n');
  let anyRemoved = false;
  const outLines = lines.map(line => {
    if (!SAVE_RE.test(line)) return line;
    const kept: string[] = [];
    for (const sent of line.split(SENT_SPLIT)) {
      const c = detectPreferenceClaim(sent);
      if (!c) { kept.push(sent); continue; }
      const named = !!(c.claimedClass || c.claimedTime);
      const ok = named
        ? (!c.claimedClass || c.claimedClass === sessionClass) && (!c.claimedTime || c.claimedTime === sessionTime)
        : !!(sessionClass || sessionTime);
      res.diagnostics.push({ claim: sent.trim().slice(0, 120), claimedClass: c.claimedClass, claimedTime: c.claimedTime, sessionClass, sessionTime,
        validationStatus: ok ? 'VALID' : 'REJECTED', removalReason: ok ? null : ((sessionClass || sessionTime) && named ? 'PREFERENCE_MISMATCH' : 'PREFERENCE_NOT_SAVED') });
      if (ok) kept.push(sent);
      else { anyRemoved = true; res.removed.push(sent.trim()); kept.push(preferenceNotSavedLine(sent)); }
    }
    return kept.join(' ');
  });
  if (!anyRemoved) return res;
  // one honest line is enough even if several false claims were removed
  const line = res.removed.length ? preferenceNotSavedLine(res.removed[0]) : '';
  let joined = outLines.join('\n');
  if (line) { const first = joined.indexOf(line); joined = joined.slice(0, first + line.length) + joined.slice(first + line.length).split(line).join(''); }
  res.text = joined.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return res;
}
