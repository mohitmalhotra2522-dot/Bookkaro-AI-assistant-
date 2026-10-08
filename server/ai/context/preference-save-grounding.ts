/**
 * P-2 — a SAVED travel preference (session.preferredClass / preferredTime) may be created or updated ONLY when the
 * user's own words this turn explicitly ask to remember / save / always use it ("AC prefer hai, yaad rakhna",
 * "Mujhe hamesha AC chahiye", "Prefer 3A, isse remember karna", "याद रखना").
 *
 * This is GROUNDING, not routing: Muse still decides (semantically) that the user stated a preference and proposes it
 * via update_booking_session (preferredClassRaw / preferredTimeRaw). The backend only refuses to PERSIST a proposal the
 * user's words do not support — the same pattern as the existing passenger-preference / new-booking grounding.
 * An ordinary search or filter ("AC trains dikhao", "shaam ki trains", "3A mein trains dikhao", "subah wali trains")
 * carries no remember instruction → nothing is saved. A rejected save is never confirmed ("yaad rakh liya" is
 * removed by guardPreferenceClaims because the session does not hold it).
 */

/** Explicit remember / save / standing-instruction markers (Roman Hindi / English, Devanagari, Gurmukhi). */
const SAVE_MARKERS: RegExp[] = [
  /\byaa?d\s*(?:rakh|kar)/,                              // yaad rakhna / yaad rakh lo / yaad kar lena
  /\bremember\b/,
  /\bsave\b/,
  /\bnote\s*(?:kar|kr|down)/,                            // note kar lo / note down
  /\bh[au]mm?esh?a\b/,                                   // hamesha / humesha / hamesa
  /\balways\b/,
  /\bfuture\b/, /\baage\s+se\b/, /\bagli\s+baar\b/, /\bnext\s+time\b/, /\bfrom\s+now\s+on\b/, /\bdefault\b/,
  /याद\s*(?:रख|कर)/, /रिमेंबर/, /सेव/, /हमेशा/, /आगे\s+से/, /अगली\s+बार/, /फ्यूचर/, /डिफ़?ॉल्ट/, /नोट\s*कर/,
  /ਯਾਦ\s*(?:ਰੱਖ|ਰਖ|ਕਰ)/, /ਹਮੇਸ਼ਾ/, /ਸੇਵ/
];

/** "don't remember", "yaad mat rakhna", "save mat karo", "yaad rakhne ki zarurat nahi" → NOT an instruction to save. */
const NEGATED: RegExp[] = [
  /\b(?:don'?t|do\s+not|never|no\s+need\s+to)\s+(?:\w+\s+){0,2}?(?:remember|save|note)\b/,
  /(?:\byaa?d|\bsave|\bremember|याद|सेव|ਯਾਦ)\s*(?:mat|मत)(?:\s|$|[,.!?])/,
  /(?:\bmat|मत)\s+(?:\S+\s+)?(?:yaa?d|save|remember|याद|सेव)/,
  /(?:\byaa?d|\bsave|\bremember|याद|सेव)\S*\s+(?:\S+\s+){0,3}?(?:zaroo?rat|zarurat|jarurat|need|ज़रूरत|जरूरत)\s+(?:nahi|nahin|nhi|नहीं)/
];

const norm = (t: string) => String(t || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** True only when the user's own words this turn explicitly ask to remember / save a travel preference. */
export function explicitPreferenceSaveRequested(userText: string): boolean {
  const t = norm(userText);
  if (!t) return false;
  if (NEGATED.some(re => re.test(t))) return false;
  return SAVE_MARKERS.some(re => re.test(t));
}

export const PREFERENCE_NOT_EXPLICIT = 'PREFERENCE_NOT_EXPLICIT';
