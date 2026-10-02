/**
 * BookingProviderConfig — server-side env only, parsed FAIL-CLOSED (Prompt 12).
 *
 *   BOOKING_PROVIDER              provider name; missing → "disabled"; malformed → "disabled" (+configError)
 *   REAL_BOOKING_ENABLED          master switch (Prompt 10). Only the exact string "true" enables.
 *   BOOKING_PROVIDER_BASE_URL     optional; for a FUTURE adapter. Must be https:// in production
 *                                 (http://localhost allowed outside production). Invalid → ignored (+configError).
 *   BOOKING_PROVIDER_TIMEOUT_MS   1000 … 60000 (default 15000). Invalid → default (+configError).
 *
 * Deliberately NO credential fields (no IRCTC_USERNAME / IRCTC_PASSWORD / OTP_SECRET /
 * CAPTCHA_SECRET / API keys): no actual provider contract exists that would need them.
 * Unrelated to — and never reads or writes — REAL_IRCTC_ENABLED.
 */
export interface BookingProviderConfig {
  /** Configured provider name (normalized). */
  provider: string;
  /** REAL_BOOKING_ENABLED === "true". */
  enabled: boolean;
  baseUrl?: string;
  timeoutMs: number;
  configErrors: string[];
}

export const DEFAULT_BOOKING_PROVIDER = 'disabled';
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;
const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

export function parseBookingProviderConfig(env: Record<string, string | undefined>): BookingProviderConfig {
  const configErrors: string[] = [];
  let provider = DEFAULT_BOOKING_PROVIDER;
  const rawName = env.BOOKING_PROVIDER;
  if (rawName !== undefined && rawName.trim() !== '') {
    const n = rawName.trim().toLowerCase();
    if (NAME_RE.test(n)) provider = n; else configErrors.push('BOOKING_PROVIDER_INVALID');
  }
  const enabled = env.REAL_BOOKING_ENABLED === 'true';
  let baseUrl: string | undefined;
  const rawUrl = env.BOOKING_PROVIDER_BASE_URL;
  if (rawUrl !== undefined && rawUrl.trim() !== '') {
    try {
      const u = new URL(rawUrl.trim());
      const prod = env.NODE_ENV === 'production';
      const localHttp = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
      if (u.username || u.password) configErrors.push('BOOKING_PROVIDER_BASE_URL_HAS_CREDENTIALS');
      else if (u.protocol === 'https:' || (!prod && localHttp)) baseUrl = u.origin + u.pathname.replace(/\/+$/, '');
      else configErrors.push('BOOKING_PROVIDER_BASE_URL_NOT_HTTPS');
    } catch { configErrors.push('BOOKING_PROVIDER_BASE_URL_INVALID'); }
  }
  let timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS;
  const rawT = env.BOOKING_PROVIDER_TIMEOUT_MS;
  if (rawT !== undefined && rawT !== '') {
    const n = /^\d+$/.test(rawT.trim()) ? Number(rawT.trim()) : NaN;
    if (Number.isFinite(n) && n >= 1000 && n <= 60_000) timeoutMs = n; else configErrors.push('BOOKING_PROVIDER_TIMEOUT_MS_INVALID');
  }
  return { provider, enabled, baseUrl, timeoutMs, configErrors };
}

export const DEFAULT_BOOKING_PROVIDER_CONFIG: Readonly<BookingProviderConfig> = Object.freeze({
  provider: DEFAULT_BOOKING_PROVIDER, enabled: false, timeoutMs: DEFAULT_PROVIDER_TIMEOUT_MS, configErrors: [] as string[]
});
