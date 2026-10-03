/**
 * PROMPT 17 — Freshness policy (Parts 5, 6, 7).
 *
 * Every railway tool is ALWAYS_FRESH: each user turn that needs railway data calls the provider again.
 * There is no application-level railway cache (no 30 s / 60 s / 5 min reuse). The only reuse is of an
 * ACCIDENTAL duplicate inside one turn (LLM repeating the identical call) or a duplicate DELIVERY of the
 * same client message (retry / reconnect / double submit) — never a new user request.
 */
export const RAILWAY_FRESHNESS_POLICY = 'ALWAYS_FRESH' as const;
export const RAILWAY_RESULT_CACHE_TTL_MS = 0;

const FRESH_RE = /\b(abhi|abi|ab|dobara|dubara|phir se|fir se|again|latest|current|fresh|refresh|live|real ?time|turant|recheck|re-check|naya|nayi)\b/i;

/** "abhi dobara check karo", "latest availability batao", "PNR phir se check karo" … */
export function isExplicitFreshRequest(text: string): boolean {
  return FRESH_RE.test(String(text || ''));
}
