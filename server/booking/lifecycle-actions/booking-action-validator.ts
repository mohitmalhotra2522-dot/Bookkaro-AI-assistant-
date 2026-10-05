/**
 * BookingActionValidator (Prompt 15) — every lifecycle action passes here BEFORE any
 * provider call. Order:
 *   0. action is a known enum value (UNSUPPORTED_ACTION / NO_ACTION rejected)
 *   1. booking exists (session-scoped)
 *   2. explicit user intent (an LLM label alone is never enough)
 *   3. not already completed / pending / unresolved (duplicate & unsafe-retry protection)
 *   4. booking status permits the action; booking eligible (journey not in the past)
 *   5. provider exists / is reachable for this booking
 *   6. provider capability supports the action (declared AND implemented)
 *   7. providerReference exists
 *   8. requested change is valid (date / class / passenger fields of the provider contract)
 *   9. confirmation received (destructive actions, EXECUTE phase)
 * Any failure → typed rejection; the caller makes NO provider call.
 */
import type { BookingRecord } from '@shared/booking-record';
import type {
  BookingLifecycleActionRecord, LifecycleActionErrorCode, ParsedLifecycleAction, ProviderActionCapabilities,
  ProviderActionCapability, RequestedChanges
} from '@shared/booking-lifecycle-action';
import { DESTRUCTIVE_LIFECYCLE_ACTIONS, PASSENGER_CHANGE_FIELDS } from '@shared/booking-lifecycle-action';
import { VALID_TRAVEL_CLASSES } from './lifecycle-action-intent';

export type ValidationResult =
  | { ok: true; capability: ProviderActionCapability | null }
  | { ok: false; code: LifecycleActionErrorCode; message: string; capability: ProviderActionCapability | null };

export interface ValidateInput {
  action: ParsedLifecycleAction;
  record: Readonly<BookingRecord> | null;
  /** null = no provider available for this booking. */
  capabilities: ProviderActionCapabilities | null;
  /** Latest destructive action on this booking (any kind) other than the one being executed. */
  latestDestructive: Readonly<BookingLifecycleActionRecord> | null;
  phase: 'PREPARE' | 'EXECUTE' | 'READ';
  explicitIntent: boolean;
  retryRequested?: boolean;
  confirmation?: { required: boolean; received: boolean };
  changes?: RequestedChanges;
  today: string; // YYYY-MM-DD (IST)
}

export const LIFECYCLE_MESSAGES = {
  CANCEL_UNSUPPORTED: 'Is booking ke liye cancellation provider ke through available nahi hai.',
  MODIFY_UNSUPPORTED: 'Is booking ke liye modification provider ke through available nahi hai.',
  DATE_UNSUPPORTED: 'Is booking ke liye date modification available nahi hai.',
  CLASS_UNSUPPORTED: 'Is booking ke liye class change provider ke through available nahi hai.',
  PASSENGER_UNSUPPORTED: 'Is booking ke liye passenger details change provider ke through available nahi hai.',
  REFUND_UNAVAILABLE: 'Is booking ka refund status provider se available nahi hai. Cancellation aur refund alag hain — refund ka status main confirm nahi kar sakta.',
  CANCEL_ELIG_UNSUPPORTED: 'Is booking ke liye cancellation eligibility provider se check karna available nahi hai.',
  MODIFY_ELIG_UNSUPPORTED: 'Is booking ke liye modification eligibility provider se check karna available nahi hai.',
  ALREADY_CANCELLED: 'Ye booking already cancelled status mein hai.',
  CANCEL_PENDING: 'Is booking ki cancellation request pehle se provider ke paas pending hai — nayi request nahi bheji jayegi.',
  CANCEL_UNKNOWN_RETRY: 'Pichli cancellation request ka result abhi establish nahi hua hai. Duplicate cancellation avoid karne ke liye main dobara request nahi bhej raha.',
  CANCEL_TIMEOUT: 'Cancellation request ka final status abhi verify nahi hua hai. Duplicate cancellation avoid karne ke liye main dobara request nahi bhej raha.',
  MODIFY_PENDING: 'Is booking ki ek modification request pehle se pending hai — nayi request nahi bheji jayegi.',
  MODIFY_UNKNOWN_RETRY: 'Pichli modification request ka result abhi establish nahi hua hai. Duplicate request avoid karne ke liye main dobara request nahi bhej raha.',
  PROVIDER_UNAVAILABLE: 'Is booking ka provider abhi available nahi hai — koi request nahi bheji gayi.',
  NO_REFERENCE: 'Is booking ka provider reference available nahi hai, isliye request provider tak nahi bheji ja sakti.',
  NEEDS_CONFIRMATION: 'Is action ke liye aapka explicit confirmation zaroori hai — abhi koi request nahi bheji gayi.',
  NOT_EXPLICIT: 'Booking mein koi change aapke explicit request ke bina nahi kiya jata.'
} as const;

const CAPABILITY_FOR: Readonly<Partial<Record<ParsedLifecycleAction, ProviderActionCapability>>> = {
  REQUEST_CANCELLATION: 'CANCEL_BOOKING',
  CHECK_CANCELLATION_ELIGIBILITY: 'CHECK_CANCELLATION_ELIGIBILITY',
  REQUEST_MODIFICATION: 'MODIFY_BOOKING',
  CHECK_MODIFICATION_ELIGIBILITY: 'CHECK_MODIFICATION_ELIGIBILITY',
  REQUEST_JOURNEY_CHANGE: 'CHANGE_JOURNEY',
  REQUEST_CLASS_CHANGE: 'CHANGE_CLASS',
  REQUEST_PASSENGER_CHANGE: 'CHANGE_PASSENGER',
  CHECK_REFUND_STATUS: 'GET_REFUND_STATUS'
};
const UNSUPPORTED_MSG: Readonly<Partial<Record<ParsedLifecycleAction, string>>> = {
  REQUEST_CANCELLATION: LIFECYCLE_MESSAGES.CANCEL_UNSUPPORTED,
  CHECK_CANCELLATION_ELIGIBILITY: LIFECYCLE_MESSAGES.CANCEL_ELIG_UNSUPPORTED,
  REQUEST_MODIFICATION: LIFECYCLE_MESSAGES.MODIFY_UNSUPPORTED,
  CHECK_MODIFICATION_ELIGIBILITY: LIFECYCLE_MESSAGES.MODIFY_ELIG_UNSUPPORTED,
  REQUEST_JOURNEY_CHANGE: LIFECYCLE_MESSAGES.DATE_UNSUPPORTED,
  REQUEST_CLASS_CHANGE: LIFECYCLE_MESSAGES.CLASS_UNSUPPORTED,
  REQUEST_PASSENGER_CHANGE: LIFECYCLE_MESSAGES.PASSENGER_UNSUPPORTED
};

export function capabilityFor(action: ParsedLifecycleAction): ProviderActionCapability | null { return CAPABILITY_FOR[action] ?? null; }

const isCancelAction = (a: ParsedLifecycleAction) => a === 'REQUEST_CANCELLATION' || a === 'CHECK_CANCELLATION_ELIGIBILITY';
const isModifyAction = (a: ParsedLifecycleAction) => a === 'REQUEST_MODIFICATION' || a === 'CHECK_MODIFICATION_ELIGIBILITY' || a === 'REQUEST_JOURNEY_CHANGE' || a === 'REQUEST_CLASS_CHANGE' || a === 'REQUEST_PASSENGER_CHANGE';

export class BookingActionValidator {
  validate(i: ValidateInput): ValidationResult {
    const capability = capabilityFor(i.action);
    const no = (code: LifecycleActionErrorCode, message: string): ValidationResult => ({ ok: false, code, message, capability });

    // 0. closed enum
    if (i.action === 'UNSUPPORTED_ACTION') return no('ACTION_NOT_SUPPORTED', 'Ye booking action supported nahi hai.');
    if (i.action === 'NO_ACTION') return no('ACTION_NOT_ALLOWED', LIFECYCLE_MESSAGES.NOT_EXPLICIT);
    // 1. booking exists
    const r = i.record;
    if (!r) return no('BOOKING_NOT_FOUND', 'Is session mein woh booking nahi mili.');
    // 2. explicit user intent
    if (!i.explicitIntent) return no('ACTION_NOT_ALLOWED', LIFECYCLE_MESSAGES.NOT_EXPLICIT);

    const refund = i.action === 'CHECK_REFUND_STATUS';
    const cancelled = r.bookingStatus === 'CANCELLED' || r.cancellationStatus === 'CANCELLED';

    // 3. duplicates / unresolved previous actions (destructive + eligibility; refund is read-only)
    if (!refund) {
      if (cancelled) return isCancelAction(i.action)
        ? no('ACTION_ALREADY_COMPLETED', LIFECYCLE_MESSAGES.ALREADY_CANCELLED)
        : no('INVALID_BOOKING_STATE', `${LIFECYCLE_MESSAGES.ALREADY_CANCELLED} Cancelled booking modify nahi ho sakti.`);
      if (DESTRUCTIVE_LIFECYCLE_ACTIONS.has(i.action as any) || i.action === 'REQUEST_MODIFICATION') {
        const last = i.latestDestructive;
        const cancelPending = r.cancellationStatus === 'PENDING' || (last && last.actionType === 'REQUEST_CANCELLATION' && (last.status === 'ACTION_PENDING' || last.status === 'ACTION_IN_PROGRESS'));
        const cancelUnknown = r.cancellationStatus === 'UNKNOWN' || r.cancellationStatus === 'MANUAL_VERIFICATION_REQUIRED'
          || (last && last.actionType === 'REQUEST_CANCELLATION' && (last.status === 'ACTION_UNKNOWN' || last.status === 'MANUAL_VERIFICATION_REQUIRED'));
        const modPending = r.modificationStatus === 'PENDING' || (last && last.actionType !== 'REQUEST_CANCELLATION' && (last.status === 'ACTION_PENDING' || last.status === 'ACTION_IN_PROGRESS'));
        const modUnknown = r.modificationStatus === 'UNKNOWN' || r.modificationStatus === 'MANUAL_VERIFICATION_REQUIRED'
          || (last && last.actionType !== 'REQUEST_CANCELLATION' && (last.status === 'ACTION_UNKNOWN' || last.status === 'MANUAL_VERIFICATION_REQUIRED'));
        if (cancelPending) return no('ACTION_ALREADY_PENDING', LIFECYCLE_MESSAGES.CANCEL_PENDING);
        if (cancelUnknown) return i.retryRequested || i.action === 'REQUEST_CANCELLATION'
          ? no(i.retryRequested ? 'UNSAFE_RETRY' : 'CANCELLATION_UNKNOWN', LIFECYCLE_MESSAGES.CANCEL_UNKNOWN_RETRY)
          : no('CANCELLATION_UNKNOWN', `${LIFECYCLE_MESSAGES.CANCEL_UNKNOWN_RETRY} Tab tak koi modification bhi nahi bhej sakte.`);
        if (modPending) return no('ACTION_ALREADY_PENDING', LIFECYCLE_MESSAGES.MODIFY_PENDING);
        if (modUnknown) return no(i.retryRequested ? 'UNSAFE_RETRY' : 'MODIFICATION_UNKNOWN', LIFECYCLE_MESSAGES.MODIFY_UNKNOWN_RETRY);
      }
    }

    // 4. booking status permits the action / eligibility
    if (!refund && r.bookingStatus !== 'CONFIRMED') {
      return no('INVALID_BOOKING_STATE', `Ye booking provider-confirmed nahi hai (status: ${r.bookingStatus.toLowerCase()}) — ${isCancelAction(i.action) ? 'cancellation' : 'modification'} request nahi bheji ja sakti.`);
    }
    const effectiveDate = r.current?.journeyDate ?? r.journeyDate;
    if (!refund && effectiveDate < i.today) {
      return isCancelAction(i.action)
        ? no('CANCELLATION_NOT_ELIGIBLE', 'Is booking ki journey date nikal chuki hai — cancellation request eligible nahi hai.')
        : no('MODIFICATION_NOT_ELIGIBLE', 'Is booking ki journey date nikal chuki hai — modification eligible nahi hai.');
    }

    // 5. provider exists
    if (!i.capabilities) return no(refund ? 'REFUND_STATUS_UNAVAILABLE' : 'PROVIDER_ACTION_UNAVAILABLE', refund ? LIFECYCLE_MESSAGES.REFUND_UNAVAILABLE : LIFECYCLE_MESSAGES.PROVIDER_UNAVAILABLE);
    // 6. capability (declared AND implemented — never attempted when false)
    if (capability && !i.capabilities[capability]) {
      if (refund) return no('REFUND_STATUS_UNAVAILABLE', LIFECYCLE_MESSAGES.REFUND_UNAVAILABLE);
      return no('ACTION_NOT_SUPPORTED', UNSUPPORTED_MSG[i.action] ?? LIFECYCLE_MESSAGES.MODIFY_UNSUPPORTED);
    }
    // 7. provider reference
    if (!r.providerReference) return no(refund ? 'REFUND_STATUS_UNAVAILABLE' : 'ACTION_NOT_ALLOWED', LIFECYCLE_MESSAGES.NO_REFERENCE);

    // 8. requested change validity (journey / class / passenger)
    if (i.phase !== 'READ' && isModifyAction(i.action) && i.action !== 'REQUEST_MODIFICATION' && i.action !== 'CHECK_MODIFICATION_ELIGIBILITY') {
      const bad = this.validateChanges(i.action, r, i.changes || {}, i.today);
      if (bad) return no('MODIFICATION_NOT_ELIGIBLE', bad);
    }

    // 9. confirmation (destructive, execute phase)
    if (i.phase === 'EXECUTE' && DESTRUCTIVE_LIFECYCLE_ACTIONS.has(i.action as any)) {
      if (!i.confirmation?.received) return no('ACTION_REQUIRES_CONFIRMATION', LIFECYCLE_MESSAGES.NEEDS_CONFIRMATION);
    }
    return { ok: true, capability };
  }

  /** Returns a user-facing reason when the requested change is invalid; null when valid. */
  validateChanges(action: ParsedLifecycleAction, r: Readonly<BookingRecord>, c: RequestedChanges, today: string): string | null {
    const cur = { journeyDate: r.current?.journeyDate ?? r.journeyDate, travelClass: r.current?.travelClass ?? r.travelClass, passengers: r.current?.passengersCount ?? r.passengersSummary.count };
    if (action === 'REQUEST_JOURNEY_CHANGE') {
      if (!c.journeyDate || !/^\d{4}-\d{2}-\d{2}$/.test(c.journeyDate)) return 'Nayi journey date clear nahi hai — jaise "25 October" batayein.';
      if (c.journeyDate < today) return 'Nayi journey date beet chuki hai — aage ki date batayein.';
      if (c.journeyDate === cur.journeyDate) return 'Booking already isi date ki hai — koi change ki zaroorat nahi.';
      return null;
    }
    if (action === 'REQUEST_CLASS_CHANGE') {
      if (!c.travelClass) return 'Kaunsi class chahiye? Jaise "2A kar do".';
      if (!VALID_TRAVEL_CLASSES.has(c.travelClass)) return `${c.travelClass} valid travel class nahi hai.`;
      if (c.travelClass === cur.travelClass) return `Booking already ${cur.travelClass} class mein hai.`;
      return null;
    }
    if (action === 'REQUEST_PASSENGER_CHANGE') {
      const p = c.passenger;
      if (!p) return 'Kaunse passenger ka kya change karna hai? Jaise "passenger 2 ki age 29 kar do".';
      if (p.op === 'ADD') return 'Booking mein naya passenger add karna provider contract mein supported nahi hai — uske liye nayi booking karni hogi.';
      if (!p.passengerNumber || !Number.isInteger(p.passengerNumber) || p.passengerNumber < 1 || p.passengerNumber > cur.passengers) {
        return `Passenger number batayein (1${cur.passengers > 1 ? `–${cur.passengers}` : ''}) — jaise "passenger 2 ki age 29 kar do".`;
      }
      if (p.op === 'REMOVE') return cur.passengers <= 1 ? 'Akele passenger ko hataya nahi ja sakta — poori booking cancel karni hogi.' : null;
      if (!p.field || !(PASSENGER_CHANGE_FIELDS as readonly string[]).includes(p.field)) return 'Sirf naam, age, gender ya berth preference change ho sakti hai.';
      if (p.value === undefined || p.value === '') return `Passenger ${p.passengerNumber} ki nayi ${p.field === 'name' ? 'naam' : p.field === 'berthPreference' ? 'berth preference' : p.field} value batayein.`;
      if (p.field === 'age' && !(typeof p.value === 'number' && Number.isInteger(p.value) && p.value >= 1 && p.value <= 120)) return 'Age 1 se 120 ke beech honi chahiye.';
      if (p.field === 'gender' && !['MALE', 'FEMALE', 'OTHER'].includes(String(p.value))) return 'Gender male, female ya other ho sakta hai.';
      if (p.field === 'name' && !(typeof p.value === 'string' && /^[A-Za-z][A-Za-z .]{1,39}$/.test(p.value))) return 'Naam sirf letters mein, 2–40 characters ka hona chahiye.';
      if (p.field === 'berthPreference' && !['LOWER', 'MIDDLE', 'UPPER', 'SIDE_LOWER', 'SIDE_UPPER', 'WINDOW', 'CABIN', 'COUPE'].includes(String(p.value))) return 'Berth preference lower, middle, upper, side lower, side upper, (chair car mein) window side ya (1A mein) cabin / coupe ho sakti hai.';
      return null;
    }
    return null;
  }
}
