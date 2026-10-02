/**
 * Execution configuration — parsed FAIL-CLOSED from server-side env only.
 *
 *   REAL_BOOKING_ENABLED   enabled ONLY for the exact string "true".
 *                          Missing / empty / malformed / "TRUE" / "1" / "yes" → false.
 *   BOOKING_EXECUTOR       executor name (default "disabled"). Ignored unless the flag is true.
 *   BOOKING_HANDOFF_TTL_MS optional handoff TTL. Default is derived from the
 *                          availability freshness policy (a handoff can never
 *                          outlive the railway data it was built from). Malformed,
 *                          non-positive or > 15 min values fall back to the default.
 *   BOOKING_HANDOFF_SESSION_TTL_MS optional BookingHandoffSession TTL (Prompt 11).
 *                          Same rules; a session never outlives its BookingHandoff.
 *
 * Unrelated to — and never reads or writes — REAL_IRCTC_ENABLED.
 */
import { FRESHNESS_POLICY } from '@shared/constants';
import { DISABLED_EXECUTOR_NAME } from './disabled-booking-executor';

export interface ExecutionConfig {
  realBookingEnabled: boolean;
  executorName: string;
  handoffTtlMs: number;
  /** BookingHandoffSession lifetime (Prompt 11). Capped by the handoff's own expiry. */
  handoffSessionTtlMs: number;
  configErrors: string[];
}

export const DEFAULT_HANDOFF_TTL_MS = FRESHNESS_POLICY.AVAILABILITY_MAX_AGE_MS;
export const MAX_HANDOFF_TTL_MS = 15 * 60_000;
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

export function parseExecutionConfig(env: Record<string, string | undefined> = {}): ExecutionConfig {
  const configErrors: string[] = [];
  const rawFlag = env.REAL_BOOKING_ENABLED;
  const realBookingEnabled = rawFlag === 'true';
  if (rawFlag !== undefined && rawFlag !== 'true' && rawFlag !== 'false') configErrors.push('REAL_BOOKING_ENABLED_MALFORMED');

  let executorName = DISABLED_EXECUTOR_NAME;
  const rawExec = env.BOOKING_EXECUTOR;
  if (rawExec !== undefined && rawExec !== '') {
    const v = rawExec.trim().toLowerCase();
    if (NAME_RE.test(v)) executorName = v;
    else { executorName = `invalid:${v.slice(0, 20)}`; configErrors.push('BOOKING_EXECUTOR_MALFORMED'); }
  }

  const ttl = (raw: string | undefined, err: string): number => {
    if (raw === undefined || raw === '') return DEFAULT_HANDOFF_TTL_MS;
    const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (Number.isFinite(n) && n > 0 && n <= MAX_HANDOFF_TTL_MS) return n;
    configErrors.push(err);
    return DEFAULT_HANDOFF_TTL_MS;
  };
  const handoffTtlMs = ttl(env.BOOKING_HANDOFF_TTL_MS, 'BOOKING_HANDOFF_TTL_MS_INVALID');
  const handoffSessionTtlMs = ttl(env.BOOKING_HANDOFF_SESSION_TTL_MS, 'BOOKING_HANDOFF_SESSION_TTL_MS_INVALID');
  return { realBookingEnabled, executorName, handoffTtlMs, handoffSessionTtlMs, configErrors };
}

export const DEFAULT_EXECUTION_CONFIG: ExecutionConfig = Object.freeze({
  realBookingEnabled: false, executorName: DISABLED_EXECUTOR_NAME, handoffTtlMs: DEFAULT_HANDOFF_TTL_MS, handoffSessionTtlMs: DEFAULT_HANDOFF_TTL_MS, configErrors: [] as string[]
}) as ExecutionConfig;
