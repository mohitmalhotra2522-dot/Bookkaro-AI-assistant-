/**
 * Deterministic PNR handling (Prompt 14).
 *  - normalize user / LLM input (spaces, hyphens) → exactly 10 digits, else INVALID_PNR
 *  - a valid FORMAT is never proof that the PNR exists (only the provider can say that)
 *  - masking for logs / events / analytics / LLM context: 12******90
 * A PNR is never generated, derived, randomised or defaulted here.
 */
export const PNR_RE = /^\d{10}$/;

export type PnrCheck = { ok: true; pnr: string } | { ok: false; code: 'INVALID_PNR'; message: string };

export const INVALID_PNR_MESSAGE = 'PNR number 10 digits ka hona chahiye. Kripya sahi PNR batayein.';

export function normalizePnrInput(raw: unknown): PnrCheck {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, code: 'INVALID_PNR', message: INVALID_PNR_MESSAGE };
  const s = String(raw).trim();
  if (!s || s.length > 24 || !/^[\d\s-]+$/.test(s)) return { ok: false, code: 'INVALID_PNR', message: INVALID_PNR_MESSAGE };
  const digits = s.replace(/[\s-]/g, '');
  return PNR_RE.test(digits) ? { ok: true, pnr: digits } : { ok: false, code: 'INVALID_PNR', message: INVALID_PNR_MESSAGE };
}

export function maskPnr(pnr: string | null | undefined): string | null {
  if (!pnr) return null;
  const d = String(pnr);
  return d.length >= 4 ? `${d.slice(0, 2)}${'*'.repeat(Math.max(0, d.length - 4))}${d.slice(-2)}` : '**';
}

/** Mask every 10-digit run (PNR-shaped) in free text — used for logs, history and LLM context. */
export function maskPnrsInText(text: string): string {
  return String(text ?? '').replace(/(?<!\d)(\d{2})\d{6}(\d{2})(?!\d)/g, '$1******$2');
}

/** Deep copy with every PNR-shaped string / `pnr` field masked (observability only). */
export function maskPnrDeep<T>(v: T): T {
  if (v == null) return v;
  if (typeof v === 'string') return maskPnrsInText(v) as any;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(maskPnrDeep) as any;
  const o: any = {};
  for (const [k, x] of Object.entries(v as any)) o[k] = (k.toLowerCase() === 'pnr' && typeof x === 'string') ? maskPnr(x) : maskPnrDeep(x);
  return o;
}

/**
 * Extract a PNR candidate the USER typed: a 10-digit run (spaces / hyphens allowed), or —
 * if the user wrote "pnr <digits>" — whatever digits follow (so malformed input can be
 * rejected as INVALID_PNR without a provider call). Returns null if the text has no candidate.
 */
export function extractPnrCandidate(text: string): string | null {
  const t = String(text || '');
  // contiguous 10 digits, or the common printed forms 123-4567890 / 123 456 7890
  const ten = t.match(/(?<![\d])(\d{10}|\d{3}[-\s]\d{7}|\d{3}[-\s]\d{3}[-\s]\d{4})(?![\d])/);
  if (ten) return ten[1].replace(/[\s-]/g, '');
  const after = t.match(/\bpnr\b\s*(?:no\.?|number|nambar|:|#)?\s*([\d][\d\s-]*\d|\d)/i);
  return after ? after[1].replace(/[\s-]/g, '') : null;
}

/** All PNR-shaped values the USER typed (10 contiguous digits or 123-4567890 / 123 456 7890). */
export function pnrsInText(text: string): string[] {
  return [...String(text || '').matchAll(/(?<![\d])(\d{10}|\d{3}[-\s]\d{7}|\d{3}[-\s]\d{3}[-\s]\d{4})(?![\d])/g)].map(m => m[1].replace(/[\s-]/g, ''));
}
