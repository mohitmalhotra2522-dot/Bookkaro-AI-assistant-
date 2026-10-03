/**
 * PROMPT 19 — Parts 13–14: PassengerChangeValidator.
 *
 * The LLM may PROPOSE `{ passengerIndex, changes: { name, age, gender, berthPreference } }`. This validator
 * decides — the proposal never reaches BookingSession unless:
 *   - passengerIndex exists in the CURRENT passenger list         else INVALID_PASSENGER_INDEX
 *   - every field is part of the existing Passenger contract     else INVALID_PASSENGER_FIELD
 *   - every value is valid / in the supported enum               else INVALID_PASSENGER_VALUE
 *   - no credential / payment / session field is present         else SENSITIVE_DATA_REJECTED (value never echoed)
 * Error results carry field NAMES only — never the proposed values (privacy, Part 12).
 */
import type { BookingSession } from '@shared/entities';
import { passengerValidator, SCHEMA_FIELDS } from '../passenger-validator';
import { resolveIndexNumber } from './passenger-index-resolver';
import { containsSensitiveRequest } from '../../security/validators/intent-validator';

/** Keys that are never passenger data (Part 4 / 55). Matched case-insensitively on normalized key names. */
const SENSITIVE_KEY = /(pass(word)?|pwd|otp|captcha|cvv|cvc|card|upi|pin|bank|token|cookie|session|auth|secret|credential|aadhaar|pan)/i;

export interface PassengerChangeProposal { passengerIndex: number; changes: Record<string, unknown> }

export type PassengerChangeValidation =
  | { ok: true; passengerIndex: number; passengerId: string; changes: Partial<Record<'name' | 'age' | 'gender' | 'berthPreference', any>> }
  | { ok: false; code: 'INVALID_PASSENGER_INDEX' | 'INVALID_PASSENGER_FIELD' | 'INVALID_PASSENGER_VALUE' | 'SENSITIVE_DATA_REJECTED'; passengerIndex: number; fields: string[]; message: string };

export class PassengerChangeValidator {
  validate(s: BookingSession, p: PassengerChangeProposal): PassengerChangeValidation {
    const idx = Number(p?.passengerIndex);
    const keys = Object.keys(p?.changes || {});
    // a credential smuggled inside a contract field's VALUE ("name": "OTP 123456") is refused the same way
    const sensitive = keys.filter(k => (SENSITIVE_KEY.test(k) && !SCHEMA_FIELDS.has(k))
      || (typeof (p.changes as any)[k] === 'string' && containsSensitiveRequest(String((p.changes as any)[k]))));
    if (sensitive.length) {
      return { ok: false, code: 'SENSITIVE_DATA_REJECTED', passengerIndex: idx, fields: sensitive,
        message: 'Password, OTP, CAPTCHA, card / UPI / bank details passenger details nahi hain — main inhe kabhi accept ya store nahi karta.' };
    }
    const unknown = keys.filter(k => !SCHEMA_FIELDS.has(k));
    if (unknown.length) {
      return { ok: false, code: 'INVALID_PASSENGER_FIELD', passengerIndex: idx, fields: unknown,
        message: 'Passenger ke liye sirf naam, umar, gender aur berth preference liye ja sakte hain.' };
    }
    const at = resolveIndexNumber(s, idx);
    if (!at || !at.ok) {
      return { ok: false, code: 'INVALID_PASSENGER_INDEX', passengerIndex: idx, fields: [], message: at && !at.ok ? at.message : 'Passenger number samajh nahi aaya.' };
    }
    const v = passengerValidator.validatePartial(p.changes as Record<string, any>, `Passenger ${idx}`);
    if (v.errors.length) {
      return { ok: false, code: 'INVALID_PASSENGER_VALUE', passengerIndex: idx, fields: v.errors.map(e => e.field), message: v.errors[0].message };
    }
    return { ok: true, passengerIndex: idx, passengerId: at.passengerId, changes: v.valid };
  }
}

export const passengerChangeValidator = new PassengerChangeValidator();
