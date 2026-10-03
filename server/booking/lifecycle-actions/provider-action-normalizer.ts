/**
 * Provider action normalizer (Prompt 15). Raw provider responses are UNTRUSTED: anything that
 * does not match the contract becomes UNKNOWN (never CANCELLED / MODIFIED / a refund status).
 * Also resolves the provider's ACTUAL action capabilities: a capability is true only when it
 * is declared AND the provider implements the method (fail closed).
 */
import type {
  CancellationResult, ModificationResult, ProviderActionCapabilities, ProviderActionCapability, RefundStatusResult
} from '@shared/booking-lifecycle-action';
import { NO_ACTION_CAPABILITIES, PROVIDER_ACTION_CAPABILITIES } from '@shared/booking-lifecycle-action';
import type { BookingProvider } from '../provider/booking-provider';
import { normalizeProviderError } from '../provider/provider-error-normalizer';
import { ProviderTimeoutError } from '../provider/booking-provider';

const CODE_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cleanCode = (v: unknown) => (typeof v === 'string' && CODE_RE.test(v) ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Method each capability requires. BOOK / GET_BOOKING_STATUS map to the P12 flags. */
const METHOD: Readonly<Record<ProviderActionCapability, keyof BookingProvider>> = {
  BOOK: 'executeBooking', GET_BOOKING_STATUS: 'getBookingStatus',
  CANCEL_BOOKING: 'cancelBooking', CHECK_CANCELLATION_ELIGIBILITY: 'checkCancellationEligibility', GET_CANCELLATION_STATUS: 'getCancellationStatus',
  MODIFY_BOOKING: 'modifyBooking', CHANGE_JOURNEY: 'modifyBooking', CHANGE_CLASS: 'modifyBooking', CHANGE_PASSENGER: 'modifyBooking',
  CHECK_MODIFICATION_ELIGIBILITY: 'checkModificationEligibility', GET_MODIFICATION_STATUS: 'getModificationStatus',
  GET_REFUND_STATUS: 'getRefundStatus'
};

export function resolveProviderActionCapabilities(provider: BookingProvider | null | undefined): ProviderActionCapabilities {
  if (!provider || provider.kind === 'DISABLED') return NO_ACTION_CAPABILITIES;
  let raw: any;
  try { raw = provider.getCapabilities(); } catch { return NO_ACTION_CAPABILITIES; }
  if (!isObj(raw) || raw.available !== true) return NO_ACTION_CAPABILITIES;
  const declared = isObj(raw.actions) ? raw.actions : {};
  const out = {} as Record<ProviderActionCapability, boolean>;
  for (const c of PROVIDER_ACTION_CAPABILITIES) {
    const flag = c === 'BOOK' ? raw.supportsBooking === true
      : c === 'GET_BOOKING_STATUS' ? raw.supportsStatus === true
      : c === 'CANCEL_BOOKING' ? raw.supportsCancellation === true && declared.CANCEL_BOOKING !== false
      : declared[c] === true;
    out[c] = flag && typeof (provider as any)[METHOD[c]] === 'function';
  }
  // specific modification types require the generic MODIFY_BOOKING capability as well
  if (!out.MODIFY_BOOKING) { out.CHANGE_JOURNEY = false; out.CHANGE_CLASS = false; out.CHANGE_PASSENGER = false; }
  return Object.freeze(out);
}

export type ErrorOutcome = { kind: 'TIMEOUT' | 'UNCERTAIN' | 'NOT_SENT'; failureCode: string };
/** Thrown errors: timeout / ambiguous transport → outcome UNCERTAIN; definitely-not-sent → NOT_SENT. */
export function classifyActionError(e: unknown): ErrorOutcome {
  if (e instanceof ProviderTimeoutError) return { kind: 'TIMEOUT', failureCode: 'PROVIDER_TIMEOUT' };
  const n = normalizeProviderError(e);
  if (n.failureCode === 'PROVIDER_TIMEOUT') return { kind: 'TIMEOUT', failureCode: n.failureCode };
  return n.definitelyNotSubmitted ? { kind: 'NOT_SENT', failureCode: n.failureCode } : { kind: 'UNCERTAIN', failureCode: n.failureCode };
}

export function normalizeCancellationResponse(raw: unknown): CancellationResult {
  const unknown = (code = 'INVALID_PROVIDER_RESPONSE'): CancellationResult => ({ status: 'UNKNOWN', evidence: 'NONE', providerStatus: null, cancellationReference: null, failureCode: code });
  if (!isObj(raw) || typeof raw.status !== 'string') return unknown();
  const ref = typeof raw.cancellationReference === 'string' && REF_RE.test(raw.cancellationReference) ? raw.cancellationReference : null;
  switch (raw.status) {
    case 'CANCELLED': return { status: 'CANCELLED', evidence: 'PROVIDER', providerStatus: 'CANCELLED', cancellationReference: ref, failureCode: null };
    case 'PENDING': return { status: 'CANCELLATION_PENDING', evidence: 'PROVIDER', providerStatus: 'PENDING', cancellationReference: ref, failureCode: null };
    case 'FAILED': return { status: 'CANCELLATION_FAILED', evidence: 'PROVIDER', providerStatus: 'FAILED', cancellationReference: null, failureCode: cleanCode(raw.failureCode) ?? 'PROVIDER_REJECTED' };
    case 'NOT_ELIGIBLE': return { status: 'NOT_ELIGIBLE', evidence: 'PROVIDER', providerStatus: 'NOT_ELIGIBLE', cancellationReference: null, failureCode: cleanCode(raw.failureCode) ?? 'CANCELLATION_NOT_ELIGIBLE' };
    default: return unknown();
  }
}

export function normalizeModificationResponse(raw: unknown): ModificationResult {
  const unknown = (code = 'INVALID_PROVIDER_RESPONSE'): ModificationResult => ({ status: 'UNKNOWN', evidence: 'NONE', providerStatus: null, applied: null, failureCode: code });
  if (!isObj(raw) || typeof raw.status !== 'string') return unknown();
  switch (raw.status) {
    case 'MODIFIED': {
      let applied: ModificationResult['applied'] = null;
      if (raw.applied !== undefined) {
        if (!isObj(raw.applied)) return unknown();
        const a: { journeyDate?: string; travelClass?: string } = {};
        if (raw.applied.journeyDate !== undefined) { if (typeof raw.applied.journeyDate !== 'string' || !DATE_RE.test(raw.applied.journeyDate)) return unknown(); a.journeyDate = raw.applied.journeyDate; }
        if (raw.applied.travelClass !== undefined) { if (typeof raw.applied.travelClass !== 'string' || !/^[0-9A-Z]{2}$/.test(raw.applied.travelClass)) return unknown(); a.travelClass = raw.applied.travelClass; }
        applied = a;
      }
      return { status: 'MODIFIED', evidence: 'PROVIDER', providerStatus: 'MODIFIED', applied, failureCode: null };
    }
    case 'PENDING': return { status: 'PENDING', evidence: 'PROVIDER', providerStatus: 'PENDING', applied: null, failureCode: null };
    case 'FAILED': return { status: 'FAILED', evidence: 'PROVIDER', providerStatus: 'FAILED', applied: null, failureCode: cleanCode(raw.failureCode) ?? 'PROVIDER_REJECTED' };
    case 'NOT_ELIGIBLE': return { status: 'NOT_ELIGIBLE', evidence: 'PROVIDER', providerStatus: 'NOT_ELIGIBLE', applied: null, failureCode: cleanCode(raw.failureCode) ?? 'MODIFICATION_NOT_ELIGIBLE' };
    default: return unknown();
  }
}

/** Status (reconciliation) responses → the same normalized shapes. */
export function normalizeCancellationStatus(raw: unknown): CancellationResult {
  if (!isObj(raw) || typeof raw.status !== 'string') return normalizeCancellationResponse(null);
  if (raw.status === 'UNKNOWN' || raw.status === 'NOT_REQUESTED') return { status: 'UNKNOWN', evidence: 'NONE', providerStatus: raw.status, cancellationReference: null, failureCode: raw.status === 'NOT_REQUESTED' ? 'PROVIDER_HAS_NO_REQUEST' : null };
  return normalizeCancellationResponse(raw);
}
export function normalizeModificationStatus(raw: unknown): ModificationResult {
  if (!isObj(raw) || typeof raw.status !== 'string') return normalizeModificationResponse(null);
  if (raw.status === 'UNKNOWN' || raw.status === 'NOT_REQUESTED') return { status: 'UNKNOWN', evidence: 'NONE', providerStatus: raw.status, applied: null, failureCode: raw.status === 'NOT_REQUESTED' ? 'PROVIDER_HAS_NO_REQUEST' : null };
  return normalizeModificationResponse(raw);
}

export function normalizeRefundResponse(raw: unknown): RefundStatusResult | null {
  if (!isObj(raw) || typeof raw.status !== 'string' || !['NOT_INITIATED', 'PENDING', 'PROCESSED', 'FAILED'].includes(raw.status)) return null;
  const amount = typeof raw.amount === 'number' && Number.isFinite(raw.amount) && raw.amount >= 0 ? raw.amount : null;
  const currency = typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : null;
  const refundReference = typeof raw.refundReference === 'string' && REF_RE.test(raw.refundReference) ? raw.refundReference : null;
  return { status: raw.status as RefundStatusResult['status'], evidence: 'PROVIDER', amount, currency, refundReference };
}

export function normalizeEligibility(raw: unknown): { eligible: boolean; reasonCode: string | null; fareDifference: { amount: number; currency: string; source: 'PROVIDER' } | null } | null {
  if (!isObj(raw) || typeof raw.eligible !== 'boolean') return null;
  let fare: { amount: number; currency: string; source: 'PROVIDER' } | null = null;
  if (isObj(raw.fareDifference) && typeof raw.fareDifference.amount === 'number' && Number.isFinite(raw.fareDifference.amount)
    && typeof raw.fareDifference.currency === 'string' && /^[A-Z]{3}$/.test(raw.fareDifference.currency)) {
    fare = { amount: raw.fareDifference.amount, currency: raw.fareDifference.currency, source: 'PROVIDER' };
  }
  return { eligible: raw.eligible, reasonCode: cleanCode(raw.reasonCode), fareDifference: fare };
}
