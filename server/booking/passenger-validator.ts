/**
 * PassengerValidator (Prompt 9) — validates ONLY the fields of the existing
 * Passenger contract (shared/entities.ts):
 *
 *   name            required  non-empty letters (2–40 chars), no digits
 *   age             required  integer 1–120
 *   gender          required  enum MALE | FEMALE | OTHER
 *   berthPreference optional  enum BerthPreference (P39.2: asked in chat only for classes with berth choices)
 *   foodPreference  optional  enum VEG | NON_VEG | NO_FOOD (P39.2: only when provider data says catering — gated by
 *                             passenger-options.ts with the session; this validator checks the enum only)
 *
 * Anything else proposed by the LLM (phone, email, aadhaar, password, OTP …)
 * is NOT part of the contract: it is dropped and reported by key name only
 * (values are never echoed, stored or logged).
 *
 * LLM extraction is untrusted: every value goes through this validator before
 * it can reach BookingSession.
 */
import type { Passenger, Gender, BerthPreference, FoodPreference } from '@shared/entities';
import { PASSENGER_REQUIRED_FIELDS } from '@shared/constants';
import { resolvePassengerAge, resolvePassengerGender } from '../ai/agent/passenger-resolvers';

export type PassengerField = 'name' | 'age' | 'gender' | 'berthPreference' | 'foodPreference';
export const SCHEMA_FIELDS: ReadonlySet<string> = new Set(['name', 'age', 'gender', 'berthPreference', 'foodPreference']);

const BERTHS: BerthPreference[] = ['WINDOW', 'LOWER', 'MIDDLE', 'UPPER', 'SIDE_LOWER', 'SIDE_UPPER', 'SIDE_MIDDLE', 'CABIN', 'COUPE', 'NO_PREFERENCE'];
const GENDERS: Gender[] = ['MALE', 'FEMALE', 'OTHER'];
const FOODS: FoodPreference[] = ['VEG', 'NON_VEG', 'NO_FOOD'];

/** Words that must never be accepted as a passenger name (railway / command / secret words). */
const NOT_A_NAME = /\b(hai|hain|galat|sahi|theek|karo|kardo|train|fare|ticket|class|availability|date|kal|parso|seat|pnr|station|book|booking|cancel|confirm|haan|nahi|passenger|passengers|naam|name|age|umar|gender|male|female|otp|password|captcha|pin|cvv|upi|card|token|cookie|delhi|amritsar|ludhiana|chandigarh|jalandhar|change|remove|hata|add)\b/i;

export interface PassengerFieldError {
  field: string;
  /** P42.1 hardening: INVALID_PASSENGER_NAME_SCRIPT = a name that is not in Latin / English letters (IRCTC). */
  code: 'INVALID_PASSENGER_DETAILS' | 'INVALID_PASSENGER_NAME_SCRIPT';
  message: string;
}

/**
 * P42.1 hardening: IRCTC accepts passenger names in Latin (English) letters only — the same rule as the P38 passenger
 * form (LATIN_NAME) and the IRCTC handoff formatter (NAME_NOT_LATIN_LETTERS). A name in another script (e.g. Devanagari
 * from STT: "रवि") is never stored as a valid name and never transliterated by the backend.
 */
export const LATIN_NAME_RE = /^[A-Za-z][A-Za-z .'-]*$/;
export const isLatinName = (n: unknown): boolean => typeof n === 'string' && LATIN_NAME_RE.test(n.trim());

export interface PassengerValidationResult {
  /** Canonical, valid values only. */
  valid: Partial<Pick<Passenger, 'name' | 'age' | 'gender' | 'berthPreference' | 'foodPreference'>>;
  errors: PassengerFieldError[];
  /** Keys outside the passenger contract (dropped). Key names only. */
  rejectedFields: string[];
}

export class PassengerValidator {
  /** Validate a raw (LLM-extracted) partial passenger. */
  validatePartial(raw: Record<string, any>, label = 'Passenger'): PassengerValidationResult {
    const out: PassengerValidationResult = { valid: {}, errors: [], rejectedFields: [] };
    for (const [k, v] of Object.entries(raw || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (!SCHEMA_FIELDS.has(k)) { out.rejectedFields.push(k); continue; }
      switch (k as PassengerField) {
        case 'name': {
          const n = canonicalName(v);
          // P42.1 hardening: a recognisable name in a non-Latin script is refused (structured code; no transliteration)
          if (n && !isLatinName(n)) out.errors.push({ field: 'name', code: 'INVALID_PASSENGER_NAME_SCRIPT', message: `${label} ka naam IRCTC ke liye English (Latin) letters mein hona zaroori hai — yeh naam save nahi hua.` });
          else if (n) out.valid.name = n;
          else out.errors.push({ field: 'name', code: 'INVALID_PASSENGER_DETAILS', message: `${label} ka naam samajh nahi aaya. Sirf naam batayein, jaise "Rahul Sharma".` });
          break;
        }
        case 'age': {
          const a = typeof v === 'number' ? (Number.isInteger(v) && v >= 1 && v <= 120 ? v : null) : strictAge(String(v));
          if (a !== null) out.valid.age = a;
          else out.errors.push({ field: 'age', code: 'INVALID_PASSENGER_DETAILS', message: `${label} ki umar 1 se 120 ke beech number honi chahiye.` });
          break;
        }
        case 'gender': {
          const g = GENDERS.includes(String(v).toUpperCase() as Gender) ? (String(v).toUpperCase() as Gender) : resolvePassengerGender(String(v));
          if (g) out.valid.gender = g;
          else out.errors.push({ field: 'gender', code: 'INVALID_PASSENGER_DETAILS', message: `${label} ka gender male, female ya other hona chahiye.` });
          break;
        }
        case 'berthPreference': {
          const b = String(v).toUpperCase().replace(/\s+/g, '_') as BerthPreference;
          if (BERTHS.includes(b)) out.valid.berthPreference = b;
          else out.errors.push({ field: 'berthPreference', code: 'INVALID_PASSENGER_DETAILS', message: 'Berth preference samajh nahi aayi.' });
          break;
        }
        case 'foodPreference': {
          const f = String(v).toUpperCase().trim().replace(/[\s-]+/g, '_').replace(/^NONVEG$/, 'NON_VEG').replace(/^NOFOOD$/, 'NO_FOOD') as FoodPreference;
          if (FOODS.includes(f)) out.valid.foodPreference = f;
          else out.errors.push({ field: 'foodPreference', code: 'INVALID_PASSENGER_DETAILS', message: `${label} ke khane ki choice Veg, Non-veg ya No food honi chahiye.` });
          break;
        }
      }
    }
    return out;
  }

  /** Missing REQUIRED fields of a stored passenger (contract order). */
  missingRequired(p: Passenger | undefined): Array<'name' | 'age' | 'gender'> {
    const m: Array<'name' | 'age' | 'gender'> = [];
    for (const f of PASSENGER_REQUIRED_FIELDS) {
      const v = (p as any)?.[f];
      if (v === undefined || v === null || v === '') m.push(f);
    }
    return m;
  }

  /**
   * Prompt 19 — Part 10: deterministic completeness of the WHOLE passenger set (the LLM never decides this).
   * Required fields come from PASSENGER_REQUIRED_FIELDS; missing slots (count > records) are reported per index.
   */
  completeness(passengers: readonly Passenger[] | undefined, passengersCount?: number | null): {
    complete: boolean; missing: Array<{ passengerIndex: number; field: 'name' | 'age' | 'gender' }>; invalid: Array<{ passengerIndex: number; field: string }>;
  } {
    const ps = passengers || [];
    const n = Math.max(passengersCount || 0, ps.length);
    const missing: Array<{ passengerIndex: number; field: 'name' | 'age' | 'gender' }> = [];
    const invalid: Array<{ passengerIndex: number; field: string }> = [];
    for (let i = 0; i < n; i++) {
      const p = ps[i];
      for (const f of this.missingRequired(p)) missing.push({ passengerIndex: i + 1, field: f });
      if (p) for (const e of this.validateRecord(p).errors) invalid.push({ passengerIndex: i + 1, field: e.field });
    }
    return { complete: n > 0 && missing.length === 0 && invalid.length === 0, missing, invalid };
  }

  /**
   * Prompt 20 — Part 18: { valid, complete, missingFields, errors } over the active passenger set.
   * `complete` = every required field present for every expected passenger; `valid` = every stored value valid.
   * Errors carry passenger index + field name only (never the value — privacy).
   */
  validateSet(passengers: readonly Passenger[] | undefined, passengersCount?: number | null): {
    valid: boolean; complete: boolean;
    missingFields: Array<{ passengerIndex: number; field: 'name' | 'age' | 'gender' }>;
    errors: Array<{ passengerIndex: number; field: string; code: 'INVALID_PASSENGER_VALUE' }>;
  } {
    const c = this.completeness(passengers, passengersCount);
    const errors = c.invalid.map(e => ({ passengerIndex: e.passengerIndex, field: e.field, code: 'INVALID_PASSENGER_VALUE' as const }));
    return { valid: errors.length === 0, complete: c.missing.length === 0 && Math.max(passengersCount || 0, (passengers || []).length) > 0, missingFields: c.missing, errors };
  }

  /** Full validation of a stored passenger record (required + stored values valid). */
  validateRecord(p: Passenger): { complete: boolean; valid: boolean; missing: string[]; errors: PassengerFieldError[] } {
    const missing = this.missingRequired(p);
    const r = this.validatePartial({ name: p.name, age: p.age, gender: p.gender, berthPreference: p.berthPreference });
    return { complete: missing.length === 0, valid: r.errors.length === 0, missing, errors: r.errors };
  }
}

function strictAge(raw: string): number | null {
  const t = raw.trim();
  // only a plain number (optionally "31 saal" / "31 years") — never digits buried in other text
  if (!/^\d{1,3}(\s*(saal|sal|years?|yrs?|yr|varsh))?$/i.test(t)) return null;
  return resolvePassengerAge(t);
}

/** P38: Devanagari words that are never a name (\\b does not work for Devanagari, so whole-word set). */
const DEVANAGARI_NOT_A_NAME = new Set(['है', 'हैं', 'नहीं', 'हाँ', 'हां', 'टिकट', 'ट्रेन', 'यात्री', 'नाम', 'उम्र', 'साल', 'पुरुष', 'महिला', 'बुक', 'पासवर्ड', 'ओटीपी', 'दिल्ली', 'अमृतसर']);

export function canonicalName(v: any): string | null {
  if (typeof v !== 'string') return null;
  // Prompt 19: trailing punctuation is removed BEFORE the "hai" strip ("Mohit hai." → "Mohit", never "Mohit Hai")
  let n = v.trim().replace(/[.,!?;:]+$/g, '').trim()
    .replace(/^(actually|nahi|no|sorry)\s*,?\s*/i, '')
    .replace(/^(mera naam|my name is|uska naam|unka naam|naam|name|passenger ka naam)\s*(hai|is|:)?\s*/i, '')
    .replace(/^(मेरा नाम|उसका नाम|उनका नाम|नाम)\s*(है|:)?\s*/u, '')
    .replace(/\s+(है|हैं)$/u, '')
    .replace(/\s+(hai|he|h)$/i, '')
    .replace(/[.,!]+$/g, '')
    .trim();
  if (n.length < 2 || n.length > 40) return null;
  if (/\d/.test(n)) return null;
  if (NOT_A_NAME.test(n)) return null;
  if (!/^[\p{L}][\p{L}\p{M}\s.'-]*$/u.test(n)) return null;   // P38: \p{M} = Devanagari matras (मोहित)
  if (n.split(/\s+/).some(w => DEVANAGARI_NOT_A_NAME.has(w))) return null;
  return n.split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

export const passengerValidator = new PassengerValidator();
