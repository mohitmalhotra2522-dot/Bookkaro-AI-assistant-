/**
 * Strict schema validation of everything a provider adapter returns (adapters are untrusted).
 *
 *  - only the contract fields are accepted; unknown keys → INVALID_PROVIDER_RESPONSE
 *  - status must be one of the normalized enums (no "OK" / HTTP-200 inference)
 *  - pnr is accepted ONLY with status CONFIRMED and only as exactly 10 digits
 *  - CONFIRMED must carry a providerReference or a pnr (an authoritative identifier)
 *  - providerReference / failureCode are length- and charset-restricted
 *  - message is dropped (free text from providers is never persisted or shown)
 */
import { BOOKING_PROVIDER_RESULT_STATUSES, BOOKING_STATUS_RESULT_STATUSES } from '@shared/booking-provider';
import type { BookingProviderCapabilities, BookingProviderResult, BookingStatusResult, ProviderHealth } from '@shared/booking-provider';

export type SchemaCheck<T> = { ok: true; value: T } | { ok: false; code: 'INVALID_PROVIDER_RESPONSE'; detail: string };

const RESULT_KEYS = new Set(['status', 'providerReference', 'pnr', 'message', 'failureCode']);
const STATUS_KEYS = new Set(['status', 'providerReference', 'pnr', 'failureCode']);
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PNR_RE = /^\d{10}$/;
const FAILURE_RE = /^[A-Z][A-Z0-9_]{0,47}$/;
const bad = (detail: string) => ({ ok: false as const, code: 'INVALID_PROVIDER_RESPONSE' as const, detail });
const isPlain = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype;

function common(raw: Record<string, unknown>, keys: Set<string>, confirmed: boolean): string | null {
  for (const k of Object.keys(raw)) if (!keys.has(k)) return `unexpected field "${k}"`;
  if (raw.providerReference !== undefined && (typeof raw.providerReference !== 'string' || !REF_RE.test(raw.providerReference))) return 'invalid providerReference';
  if (raw.failureCode !== undefined && (typeof raw.failureCode !== 'string' || !FAILURE_RE.test(raw.failureCode))) return 'invalid failureCode';
  if (raw.pnr !== undefined) {
    if (typeof raw.pnr !== 'string' || !PNR_RE.test(raw.pnr)) return 'invalid pnr';
    if (!confirmed) return 'pnr only allowed with CONFIRMED';
  }
  if (confirmed && raw.providerReference === undefined && raw.pnr === undefined) return 'CONFIRMED without an authoritative identifier';
  return null;
}

export function validateProviderResult(raw: unknown): SchemaCheck<BookingProviderResult> {
  if (!isPlain(raw)) return bad('not an object');
  if (typeof raw.status !== 'string' || !(BOOKING_PROVIDER_RESULT_STATUSES as readonly string[]).includes(raw.status)) return bad('invalid status');
  if (raw.message !== undefined && typeof raw.message !== 'string') return bad('invalid message');
  const e = common(raw, RESULT_KEYS, raw.status === 'CONFIRMED');
  if (e) return bad(e);
  const v: BookingProviderResult = { status: raw.status as BookingProviderResult['status'] };
  if (raw.providerReference !== undefined) v.providerReference = raw.providerReference as string;
  if (raw.pnr !== undefined) v.pnr = raw.pnr as string;
  if (raw.failureCode !== undefined) v.failureCode = raw.failureCode as string;
  return { ok: true, value: v };
}

export function validateStatusResult(raw: unknown): SchemaCheck<BookingStatusResult> {
  if (!isPlain(raw)) return bad('not an object');
  if (typeof raw.status !== 'string' || !(BOOKING_STATUS_RESULT_STATUSES as readonly string[]).includes(raw.status)) return bad('invalid status');
  const e = common(raw, STATUS_KEYS, raw.status === 'CONFIRMED');
  if (e) return bad(e);
  const v: BookingStatusResult = { status: raw.status as BookingStatusResult['status'] };
  if (raw.providerReference !== undefined) v.providerReference = raw.providerReference as string;
  if (raw.pnr !== undefined) v.pnr = raw.pnr as string;
  if (raw.failureCode !== undefined) v.failureCode = raw.failureCode as string;
  return { ok: true, value: v };
}

const HEALTH: readonly ProviderHealth[] = ['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'];
export function validateHealth(raw: unknown): ProviderHealth {
  return typeof raw === 'string' && (HEALTH as readonly string[]).includes(raw) ? raw as ProviderHealth : 'UNKNOWN';
}

/** Capability object must be complete and typed; otherwise the provider is treated as unavailable. */
export function validateCapabilities(raw: unknown, expectedName: string): SchemaCheck<BookingProviderCapabilities> {
  if (!isPlain(raw)) return bad('capabilities missing');
  const bools = ['available', 'supportsBooking', 'supportsStatus', 'supportsCancellation', 'requiresExternalHandoff', 'supportsIdempotency'];
  for (const b of bools) if (typeof raw[b] !== 'boolean') return bad(`capability ${b} missing`);
  if (raw.providerName !== expectedName) return bad('capability providerName mismatch');
  if (typeof raw.health !== 'string' || !(HEALTH as readonly string[]).includes(raw.health)) return bad('capability health invalid');
  return {
    ok: true,
    value: Object.freeze({
      providerName: expectedName, available: raw.available as boolean, supportsBooking: raw.supportsBooking as boolean, supportsStatus: raw.supportsStatus as boolean,
      supportsCancellation: raw.supportsCancellation as boolean, requiresExternalHandoff: raw.requiresExternalHandoff as boolean,
      supportsIdempotency: raw.supportsIdempotency as boolean, health: raw.health as ProviderHealth,
      ...(typeof raw.reason === 'string' && FAILURE_RE.test(raw.reason) ? { reason: raw.reason } : {})
    })
  };
}
