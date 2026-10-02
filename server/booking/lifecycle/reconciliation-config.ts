/**
 * Reconciliation config (Prompt 13) — deterministic, bounded, server-side only.
 * No infinite polling: at most `maxAttempts` status checks per reconciliation run,
 * at most `maxTotalAttempts` per execution record, then MANUAL_VERIFICATION_REQUIRED.
 * Unresolved longer than `unresolvedTtlMs` → MANUAL_VERIFICATION_REQUIRED (checked lazily
 * on the next turn / API call — there is no background timer).
 */
export interface ReconciliationConfig {
  maxAttempts: number;
  /** Delay before attempt 2; doubles for each later attempt (1000 → 2000 → …). */
  backoffMs: number;
  /** Per status-check timeout. */
  attemptTimeoutMs: number;
  maxTotalAttempts: number;
  unresolvedTtlMs: number;
}

export const DEFAULT_RECONCILIATION_CONFIG: Readonly<ReconciliationConfig> = Object.freeze({
  maxAttempts: 3,
  backoffMs: 1000,
  attemptTimeoutMs: 10_000,
  maxTotalAttempts: 9,
  unresolvedTtlMs: 15 * 60_000
});

const LIMITS: Record<keyof ReconciliationConfig, [number, number]> = {
  maxAttempts: [1, 5], backoffMs: [0, 30_000], attemptTimeoutMs: [100, 60_000], maxTotalAttempts: [1, 20], unresolvedTtlMs: [1_000, 24 * 3_600_000]
};

/** Clamp to safe bounds (a misconfiguration can never create unbounded polling). */
export function normalizeReconciliationConfig(partial: Partial<ReconciliationConfig> = {}): ReconciliationConfig {
  const out = { ...DEFAULT_RECONCILIATION_CONFIG } as ReconciliationConfig;
  for (const k of Object.keys(LIMITS) as Array<keyof ReconciliationConfig>) {
    const v = partial[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], Math.floor(v)));
  }
  if (out.maxTotalAttempts < out.maxAttempts) out.maxTotalAttempts = out.maxAttempts;
  return out;
}

export function parseReconciliationConfig(env: Record<string, string | undefined> = process.env): ReconciliationConfig {
  const n = (k: string) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : undefined);
  return normalizeReconciliationConfig({
    maxAttempts: n('BOOKING_RECONCILIATION_MAX_ATTEMPTS'),
    backoffMs: n('BOOKING_RECONCILIATION_BACKOFF_MS'),
    attemptTimeoutMs: n('BOOKING_RECONCILIATION_TIMEOUT_MS'),
    unresolvedTtlMs: n('BOOKING_EXECUTION_UNRESOLVED_TTL_MS')
  });
}

/** Deterministic delay before attempt i (0-based): 0, backoff, 2·backoff, … */
export function backoffDelay(cfg: ReconciliationConfig, attemptIndex: number): number {
  return attemptIndex <= 0 ? 0 : cfg.backoffMs * 2 ** (attemptIndex - 1);
}
