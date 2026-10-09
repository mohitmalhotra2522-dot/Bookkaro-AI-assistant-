/**
 * 2026-10-09 (approved) — provider data FRESHNESS, separate from identity / route verification.
 *
 * A result is freshness-verified ONLY when the provider itself returned a snapshot timestamp (providerUpdatedAt) and it is
 * within the configured limit (SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN, default 120). No / unparsable / far-future timestamp →
 * TIMESTAMP_UNAVAILABLE with the exact label below. A timestamp is NEVER invented (request / response time is not a
 * provider snapshot time). This is a label: it does not change the existing 120-minute guard, which still turns a dated
 * snapshot older than the limit into STALE_PROVIDER_DATA (never a verdict).
 *
 * `verificationStatus` (VERIFIED / PARTIALLY_VERIFIED …) keeps its meaning — train / class / date / pair binding and
 * boarding rules — and is NOT a freshness claim.
 */

export const PROVIDER_TIMESTAMP_UNAVAILABLE_LABEL = 'Provider timestamp unavailable — freshness cannot be verified.';

export type ProviderFreshnessStatus =
  | 'VERIFIED_WITHIN_LIMIT'     // provider timestamp present, age ≤ limit
  | 'OLDER_THAN_LIMIT'          // provider timestamp present, age > limit
  | 'TIMESTAMP_UNAVAILABLE'     // no usable provider timestamp → freshness cannot be verified
  | 'NO_LIMIT_CONFIGURED';      // provider timestamp present but the limit is off (0) → not verified either

export interface ProviderFreshness {
  status: ProviderFreshnessStatus;
  /** true ONLY for VERIFIED_WITHIN_LIMIT */
  freshnessVerified: boolean;
  /** the provider's own snapshot time (as returned), when present */
  providerUpdatedAt?: string;
  ageMinutes?: number;
  maxAgeMinutes?: number;
  /** exact user-facing text for TIMESTAMP_UNAVAILABLE */
  label?: string;
}

/** A provider clock may be slightly ahead; beyond this a "future" snapshot time is not a usable timestamp. */
const FUTURE_SKEW_MS = 5 * 60_000;

export function providerFreshnessOf(providerUpdatedAt: unknown, opts: { maxAgeMs?: number; nowMs?: number } = {}): ProviderFreshness {
  const raw = typeof providerUpdatedAt === 'string' ? providerUpdatedAt.trim() : '';
  const t = raw ? Date.parse(raw) : NaN;
  const now = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  if (!raw || !Number.isFinite(t) || t - now > FUTURE_SKEW_MS) {
    return { status: 'TIMESTAMP_UNAVAILABLE', freshnessVerified: false, label: PROVIDER_TIMESTAMP_UNAVAILABLE_LABEL };
  }
  const ageMs = Math.max(0, now - t);
  const base = { providerUpdatedAt: raw.slice(0, 40), ageMinutes: Math.round(ageMs / 60_000) };
  const max = Number(opts.maxAgeMs) || 0;
  if (max <= 0) return { status: 'NO_LIMIT_CONFIGURED', freshnessVerified: false, ...base };
  const maxAgeMinutes = Math.round(max / 60_000);
  return ageMs <= max
    ? { status: 'VERIFIED_WITHIN_LIMIT', freshnessVerified: true, ...base, maxAgeMinutes }
    : { status: 'OLDER_THAN_LIMIT', freshnessVerified: false, ...base, maxAgeMinutes };
}

export const isFreshnessUnverifiable = (f: { status?: string } | null | undefined): boolean => !!f && f.status === 'TIMESTAMP_UNAVAILABLE';
