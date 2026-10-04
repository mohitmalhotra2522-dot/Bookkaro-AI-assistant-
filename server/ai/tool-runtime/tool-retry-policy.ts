/**
 * PROMPT 18 — ToolRetryPolicy (Parts 46–48). Retries are BACKEND-controlled; the LLM can never retry
 * endlessly (its own repeats are bounded by the P17 budget / loop detector).
 *
 *  - only transient provider errors are retried (PROVIDER_UNAVAILABLE, RATE_LIMITED, TOOL_FAILED);
 *  - validation-stage errors (INVALID_REQUEST, INVALID_ARGUMENTS, INVALID_TRAIN_SELECTION, …) are never
 *    retried — they are REJECTED before any provider call and only a changed input can fix them;
 *  - a TIMEOUT is not retried by default (the user is already waiting; the late answer is dropped);
 *  - every retry is a NEW tool execution (new toolExecutionId, `retryOf` → previous id) inside the SAME
 *    logical turn, and only while the turn is still current (never for a superseded turn).
 * Read-only information tools only — this is NOT idempotency/caching: each attempt calls the provider.
 */
import type { ToolErrorCode } from '@shared/railway-tool-runtime';

export interface ToolRetryPolicy {
  maxRetries: number;
  retryableErrors: readonly ToolErrorCode[];
  /** Delay before retry `attempt` (1-based). */
  backoffMs: (attempt: number) => number;
}

export const NON_RETRYABLE_ERRORS: readonly string[] = Object.freeze([
  'INVALID_REQUEST', 'INVALID_ARGUMENTS', 'INVALID_TOOL_CALL', 'INVALID_TRAIN_SELECTION', 'INVALID_CLASS_SELECTION',
  'TOOL_CALL_REJECTED', 'FORBIDDEN_ACTION', 'FORBIDDEN_ARGUMENT', 'UNKNOWN_TOOL', 'TOOL_NOT_IMPLEMENTED',
  'NO_RESULTS', 'AUTH_ERROR', 'DATA_UNAVAILABLE', 'STALE_TOOL_RESULT', 'TOOL_LOOP_DETECTED', 'TOOL_CALL_LIMIT_EXCEEDED',
  'INVALID_ARGUMENT', 'INVALID_REPEATED_CALL', 'REPEATED_FAILED_CALL', 'PROVIDER_DATA_INVALID'
]);

export const DEFAULT_TOOL_RETRY_POLICY: ToolRetryPolicy = Object.freeze({
  maxRetries: 1,
  retryableErrors: Object.freeze(['PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'TOOL_FAILED'] as ToolErrorCode[]),
  backoffMs: (attempt: number) => Math.min(100 * attempt, 1000)
});

/** No retries at all (tests / callers that need single-shot semantics). */
export const NO_RETRY_POLICY: ToolRetryPolicy = Object.freeze({ maxRetries: 0, retryableErrors: Object.freeze([] as ToolErrorCode[]), backoffMs: () => 0 });

/** `retriesSoFar` = retries already made for this call (0 on the first failure). */
export function shouldRetry(policy: ToolRetryPolicy, normalizedCode: string | undefined, retriesSoFar: number): boolean {
  if (!normalizedCode || NON_RETRYABLE_ERRORS.includes(normalizedCode)) return false;
  if (retriesSoFar >= policy.maxRetries) return false;
  return (policy.retryableErrors as readonly string[]).includes(normalizedCode);
}
