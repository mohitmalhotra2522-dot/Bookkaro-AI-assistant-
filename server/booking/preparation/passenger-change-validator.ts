/**
 * PROMPT 19 — Parts 13–14: PassengerChangeValidator.
 *
 * The LLM may PROPOSE `{ passengerIndex, changes: { name, age, gender, berthPreference, foodPreference } }`
 * (P39.2: berth / meal are additionally gated per class / catering in PassengerCollection.applyUpdates). This validator
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
  | { ok: true; passengerIndex: number; passengerId: string; changes: Partial<Record<'name' | 'age' | 'gender' | 'berthPreference' | 'foodPreference', any>> }
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
        message: 'Passenger ke liye sirf naam, umar, gender, berth preference aur khane ki choice liye ja sakte hain.' };
    }
    const at = resolveIndexNumber(s, idx);
    if (!at || !at.ok) {
      return { ok: false, code: 'INVALID_PASSENGER_INDEX', passengerIndex: idx, fields: [], message: at && !at.ok ? at.message : 'Passenger number samajh nahi aaya.' };
    }
    const v = passengerValidator.validatePartial(p.changes as Record<string, any>, `Passenger ${idx}`);
    if (v.errors.length) {
      return { ok: false, code: 'INVALID_PASSENGER_VALUE', passengerIndex: idx, fields: v.errors.map(e => e.field), message: v.errors[0].message };
    }
    const dup = duplicateOfOther(s, at.passengerId, v.valid);
    if (dup) {
      return { ok: false, code: 'INVALID_PASSENGER_VALUE', passengerIndex: idx, fields: ['name'],
        message: `Passenger ${idx} ki details Passenger ${dup} jaisi hi ho jaatin (same naam, umar aur gender) — duplicate passenger nahi banaya. Agar yeh alag vyakti hain to inka sahi naam / umar bataiye.` };
    }
    return { ok: true, passengerIndex: idx, passengerId: at.passengerId, changes: v.valid };
  }
}

export const passengerChangeValidator = new PassengerChangeValidator();

const normName = (n: unknown) => String(n ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** v0.39.6: 1-based number of ANOTHER passenger that this one would exactly duplicate (name + age + gender) after the
 *  change, else null. Partial records never count as duplicates. */
export function duplicateOfOther(s: BookingSession, passengerId: string, changes: Record<string, any>): number | null {
  const list = s.passengers || [];
  const cur: any = list.find(p => p.id === passengerId) || {};
  const m = { name: changes.name ?? cur.name, age: changes.age ?? cur.age, gender: changes.gender ?? cur.gender };
  if (!m.name || m.age === undefined || m.age === null || !m.gender) return null;
  const j = list.findIndex((o: any) => o.id !== passengerId && o.name && normName(o.name) === normName(m.name) && Number(o.age) === Number(m.age) && o.gender === m.gender);
  return j >= 0 ? j + 1 : null;
}
