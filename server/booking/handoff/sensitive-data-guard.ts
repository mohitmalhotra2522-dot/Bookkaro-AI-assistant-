/**
 * SensitiveDataGuard — the handoff layer EXPLICITLY rejects credential-like data.
 *
 * If any object crossing the handoff boundary contains a key such as password,
 * otp, captcha, cvv, upiPin, bankPassword, authorizationToken, sessionCookie
 * (or IRCTC username/password, card number, captcha answer, tokens, cookies),
 * it is NOT persisted and the operation fails with SENSITIVE_DATA_REJECTED.
 * Only key paths are reported — values are never echoed or logged.
 */
const EXACT = new Set([
  'password', 'passwd', 'pwd', 'otp', 'captcha', 'captchaanswer', 'cvv', 'cvc', 'upipin', 'pin', 'mpin', 'atmpin',
  'bankpassword', 'authorizationtoken', 'authtoken', 'accesstoken', 'refreshtoken', 'token', 'bearer', 'authorization',
  'sessioncookie', 'cookie', 'cookies', 'irctcusername', 'irctcpassword', 'irctcuserid', 'cardnumber', 'cardno', 'card',
  'expiry', 'cardexpiry', 'netbankingpassword', 'secret', 'apikey'
]);
const CONTAINS = ['password', 'passwd', 'otp', 'captcha', 'cvv', 'upipin', 'cardnumber', 'token', 'cookie', 'secret', 'credential', 'irctcuser'];

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isSensitiveKey(key: string): boolean {
  const k = norm(key);
  if (!k) return false;
  if (EXACT.has(k)) return true;
  // 'otp' only as a whole-word-ish part (avoid e.g. "footprint")
  if (/(^|[^a-z])otp([^a-z]|$)/i.test(key.replace(/([a-z])([A-Z])/g, '$1 $2'))) return true;
  return CONTAINS.filter(c => c !== 'otp').some(c => k.includes(c));
}

/** Deep scan; returns offending key paths (never values). Handles cycles. */
export function findSensitiveFields(o: unknown, path = '', seen = new WeakSet<object>()): string[] {
  if (!o || typeof o !== 'object') return [];
  if (seen.has(o as object)) return [];
  seen.add(o as object);
  const out: string[] = [];
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (isSensitiveKey(k)) out.push(p);
    out.push(...findSensitiveFields(v, p, seen));
  }
  return out;
}

export type SensitiveCheck = { ok: true } | { ok: false; code: 'SENSITIVE_DATA_REJECTED'; fields: string[] };

export function checkNoSensitiveData(...objects: unknown[]): SensitiveCheck {
  const fields = objects.flatMap(o => findSensitiveFields(o));
  return fields.length ? { ok: false, code: 'SENSITIVE_DATA_REJECTED', fields } : { ok: true };
}
