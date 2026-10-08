/**
 * P-3 follow-up — SEARCH_TRAINS filter arguments (preferredClass / preferredTime) are accepted ONLY when the CURRENT
 * user turn asks for that filter. Same backend-grounding principle as the passenger count (groundedSearchPassengers):
 * the LLM proposes, the user's own words this turn decide whether the value may reach the provider.
 *
 * Why: saved preferences stay in Muse's context for conversational awareness, but Muse must not copy them into a plain
 * search ("parso ki trains") — a provider that honours the filter would silently narrow the authoritative result set.
 *   "parso ki trains"            → no class / time filter
 *   "parso AC trains dikhao"     → preferredClass AC allowed
 *   "parso shaam ki trains"      → preferredTime EVENING allowed
 *   "parso AC shaam ki trains"   → both allowed
 * Grounding is value-specific (an AC filter needs AC wording, NON_AC needs sleeper / non-AC wording …). 'ANY' is not a
 * filter and is always kept. Nothing here reads or changes saved preferences.
 */

const CLASS_WORDS: Record<'AC' | 'NON_AC', RegExp> = {
  NON_AC: /\bnon[\s-]?a\.?c\b|\bsleeper\b|\bSL\b|\b2S\b|second\s+sitting|\bgeneral\b|नॉन[\s-]?एसी|नॉन[\s-]?ए\.?\s?सी|स्लीपर|जनरल|ਸਲੀਪਰ/i,
  AC: /(?<!non[\s-]?)\ba\.?c\b|\b(?:1A|2A|3A|3E|CC|EC|FC)\b|\b[123]\s*tier\b|chair\s*car|first\s+class|(?<!नॉन[\s-]?)एसी|(?<!नॉन[\s-]?)ए\.?\s?सी|चेयर\s*कार|ਏਸੀ|ਏ\.?\s?ਸੀ/i
};

const TIME_WORDS: Record<'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT', RegExp> = {
  MORNING: /\bsubah\b|\bsubha\b|\bsavere\b|\bmorning\b|सुबह|सवेरे|ਸਵੇਰ/i,
  AFTERNOON: /\bdopa?h[ae]r\b|\bdupahar\b|\bafternoon\b|\bnoon\b|दोपहर|ਦੁਪਹਿਰ/i,
  EVENING: /\bshaa?m\b|\bevening\b|शाम|ਸ਼ਾਮ|ਸ਼ਾਮ/i,
  NIGHT: /\braat\b|\bnight\b|\bovernight\b|रात|ਰਾਤ/i
};

const norm = (t: string) => String(t || '').normalize('NFC');

/** True when the user's words this turn request this class filter value. */
export function classFilterGrounded(value: unknown, userText: string): boolean {
  const v = String(value ?? '').trim().toUpperCase();
  if (!v || v === 'ANY') return true;
  const re = CLASS_WORDS[v as 'AC' | 'NON_AC'];
  return !!re && re.test(norm(userText));
}

/** True when the user's words this turn request this departure-time filter value. */
export function timeFilterGrounded(value: unknown, userText: string): boolean {
  const v = String(value ?? '').trim().toUpperCase();
  if (!v || v === 'ANY') return true;
  const re = TIME_WORDS[v as keyof typeof TIME_WORDS];
  return !!re && re.test(norm(userText));
}

/**
 * Returns the SEARCH_TRAINS arguments with every filter the current user turn did not ask for removed (input not
 * mutated), plus the names of the stripped fields (field names only — never logged with values).
 */
export function groundSearchFilterArgs<A extends Record<string, any>>(args: A, userText: string): { args: A; stripped: Array<'preferredClass' | 'preferredTime'> } {
  const out: any = { ...(args || {}) };
  const stripped: Array<'preferredClass' | 'preferredTime'> = [];
  if (out.preferredClass !== undefined && out.preferredClass !== null && out.preferredClass !== '' && !classFilterGrounded(out.preferredClass, userText)) {
    delete out.preferredClass; stripped.push('preferredClass');
  }
  if (out.preferredTime !== undefined && out.preferredTime !== null && out.preferredTime !== '' && !timeFilterGrounded(out.preferredTime, userText)) {
    delete out.preferredTime; stripped.push('preferredTime');
  }
  return { args: out as A, stripped };
}
