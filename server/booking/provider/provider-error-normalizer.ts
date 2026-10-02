/**
 * Provider error normalization. Raw provider errors / messages / headers are NEVER
 * propagated — only a normalized category leaves this module.
 *
 * `definitelyNotSubmitted` is true only when the request provably never reached the
 * provider (e.g. connection refused, explicit auth / validation / rate-limit rejection).
 * Anything else (timeout, 5xx, unknown) is UNCERTAIN: the booking may exist → never auto-retry.
 */
import type { BookingProviderErrorCode, ProviderFailureCode } from '@shared/booking-provider';
import { BookingProviderError, ProviderTimeoutError } from './booking-provider';

export interface NormalizedProviderError {
  failureCode: ProviderFailureCode;
  code: BookingProviderErrorCode;
  definitelyNotSubmitted: boolean;
}

const NOT_SENT_NET = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET_BEFORE_SEND', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT']);

function fromHttp(status: number): NormalizedProviderError {
  if (status === 401 || status === 403) return { failureCode: 'PROVIDER_AUTH_FAILED', code: 'BOOKING_PROVIDER_AUTH_FAILED', definitelyNotSubmitted: true };
  if (status === 429) return { failureCode: 'PROVIDER_RATE_LIMITED', code: 'BOOKING_PROVIDER_UNAVAILABLE', definitelyNotSubmitted: true };
  if (status === 400 || status === 422) return { failureCode: 'PROVIDER_VALIDATION_FAILED', code: 'BOOKING_PROVIDER_VALIDATION_FAILED', definitelyNotSubmitted: true };
  if (status === 408 || status === 504) return { failureCode: 'PROVIDER_TIMEOUT', code: 'BOOKING_PROVIDER_TIMEOUT', definitelyNotSubmitted: false };
  if (status >= 500) return { failureCode: 'PROVIDER_UNAVAILABLE', code: 'BOOKING_PROVIDER_UNAVAILABLE', definitelyNotSubmitted: false };
  if (status >= 400) return { failureCode: 'PROVIDER_REJECTED', code: 'BOOKING_PROVIDER_REJECTED', definitelyNotSubmitted: true };
  return { failureCode: 'PROVIDER_UNKNOWN_ERROR', code: 'BOOKING_STATUS_UNKNOWN', definitelyNotSubmitted: false };
}

export function normalizeProviderError(e: unknown): NormalizedProviderError {
  if (e instanceof ProviderTimeoutError || (e as any)?.name === 'AbortError' || (e as any)?.name === 'TimeoutError') {
    return { failureCode: 'PROVIDER_TIMEOUT', code: 'BOOKING_PROVIDER_TIMEOUT', definitelyNotSubmitted: false };
  }
  if (e instanceof BookingProviderError) {
    if (typeof e.httpStatus === 'number') return fromHttp(e.httpStatus);
    switch (e.kind) {
      case 'NETWORK_NOT_SENT': return { failureCode: 'PROVIDER_UNAVAILABLE', code: 'BOOKING_PROVIDER_UNAVAILABLE', definitelyNotSubmitted: true };
      case 'PROVIDER_TIMEOUT': return { failureCode: 'PROVIDER_TIMEOUT', code: 'BOOKING_PROVIDER_TIMEOUT', definitelyNotSubmitted: false };
      case 'PROVIDER_AUTH_FAILED': return { failureCode: e.kind, code: 'BOOKING_PROVIDER_AUTH_FAILED', definitelyNotSubmitted: true };
      case 'PROVIDER_VALIDATION_FAILED': return { failureCode: e.kind, code: 'BOOKING_PROVIDER_VALIDATION_FAILED', definitelyNotSubmitted: true };
      case 'PROVIDER_REJECTED': return { failureCode: e.kind, code: 'BOOKING_PROVIDER_REJECTED', definitelyNotSubmitted: true };
      case 'PROVIDER_RATE_LIMITED': return { failureCode: e.kind, code: 'BOOKING_PROVIDER_UNAVAILABLE', definitelyNotSubmitted: true };
      case 'PROVIDER_UNAVAILABLE': return { failureCode: e.kind, code: 'BOOKING_PROVIDER_UNAVAILABLE', definitelyNotSubmitted: false };
      default: return { failureCode: 'PROVIDER_UNKNOWN_ERROR', code: 'BOOKING_STATUS_UNKNOWN', definitelyNotSubmitted: false };
    }
  }
  const net = (e as any)?.cause?.code ?? (e as any)?.code;
  if (typeof net === 'string' && NOT_SENT_NET.has(net)) return { failureCode: 'PROVIDER_UNAVAILABLE', code: 'BOOKING_PROVIDER_UNAVAILABLE', definitelyNotSubmitted: true };
  return { failureCode: 'PROVIDER_UNKNOWN_ERROR', code: 'BOOKING_STATUS_UNKNOWN', definitelyNotSubmitted: false };
}
