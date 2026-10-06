/**
 * P39 — Safe IRCTC handoff contract (shared by the backend, the IRCTC Assist page and the MV3 browser extension).
 *
 * The handoff carries ONLY validated, non-sensitive booking data from the CURRENT confirmed review (journey, date,
 * train, class, quota, passengers) so it can be pre-filled on irctc.co.in. The USER always does: login (User ID /
 * Password), CAPTCHA, OTP, the final Book / Continue tap and payment. Nothing here can carry a password, OTP, CAPTCHA,
 * card / UPI / bank detail, cookie or token — events are metadata only (page kind, field KEYS, never field values).
 */

export const IRCTC_MAX_PASSENGERS = 6;
export const IRCTC_HANDOFF_TTL_MS = 20 * 60_000;
export const IRCTC_BRIDGE_TOKEN_HEADER = 'x-bookkaro-bridge-token';

export type IrctcHandoffStatus =
  | 'READY'                    // created from a confirmed review; nothing opened yet
  | 'LANGUAGE_SELECTION'       // IRCTC asked for / offers a language choice
  | 'LOGIN_REQUIRED'           // user must log in on IRCTC (User ID + Password typed by the user)
  | 'JOURNEY_PAGE'             // search form detected / journey being pre-filled
  | 'TRAIN_LIST'               // train list detected; the matching train / class is highlighted
  | 'PASSENGER_PAGE'           // passenger form detected / being pre-filled
  | 'READY_FOR_USER_BOOK'      // every supported field filled; the final control is highlighted — the USER taps it
  | 'CAPTCHA_REQUIRED'         // user must solve the CAPTCHA (never solved by BookKaro)
  | 'OTP_REQUIRED'             // user must enter the OTP on IRCTC / payment page
  | 'PAYMENT_PAGE'             // user pays on IRCTC / the payment gateway
  | 'PAUSED'                   // user paused the assistant (or a field conflict needs the user)
  | 'SESSION_EXPIRED'          // IRCTC session expired — user logs in again
  | 'COMPLETED'                // ONLY when the IRCTC booking-confirmation page was detected
  | 'BOOKING_FAILED'           // IRCTC showed a booking failure
  | 'BOOKING_STATUS_UNKNOWN'   // the flow ended without an IRCTC confirmation page — status is NOT known
  | 'EXPIRED'                  // handoff TTL passed — confirm a fresh review in BookKaro
  | 'STALE_HANDOFF'            // booking details changed after the handoff was created
  | 'STOPPED';                 // user stopped the assistant

export const IRCTC_TERMINAL_STATUSES: readonly IrctcHandoffStatus[] = ['COMPLETED', 'BOOKING_FAILED', 'BOOKING_STATUS_UNKNOWN', 'EXPIRED', 'STALE_HANDOFF', 'STOPPED'];

export type IrctcHandoffErrorCode =
  | 'IRCTC_HANDOFF_NOT_READY'
  | 'IRCTC_HANDOFF_NOT_FOUND'
  | 'STALE_HANDOFF'
  | 'HANDOFF_EXPIRED'
  | 'IRCTC_PASSENGER_LIMIT_EXCEEDED'
  | 'IRCTC_FIELD_NOT_CONFIRMED'
  | 'HANDOFF_LANGUAGE_SELECTION_UNAVAILABLE'
  | 'BRIDGE_TOKEN_INVALID'
  | 'SENSITIVE_DATA_REJECTED'
  | 'INVALID_EVENT'
  | 'HANDOFF_TERMINAL';

export type IrctcLanguage = 'en' | 'hi';

/** Page kinds the extension can recognise from VISIBLE page content (never private APIs). */
export type IrctcPageKind =
  | 'LANGUAGE' | 'HOME_SEARCH' | 'LOGIN' | 'TRAIN_LIST' | 'PASSENGER' | 'REVIEW_CAPTCHA' | 'OTP' | 'PAYMENT'
  | 'CONFIRMATION' | 'FAILURE' | 'SESSION_EXPIRED' | 'UNKNOWN';
export const IRCTC_PAGE_KINDS: readonly IrctcPageKind[] = ['LANGUAGE', 'HOME_SEARCH', 'LOGIN', 'TRAIN_LIST', 'PASSENGER', 'REVIEW_CAPTCHA', 'OTP', 'PAYMENT', 'CONFIRMATION', 'FAILURE', 'SESSION_EXPIRED', 'UNKNOWN'];

/** Field KEYS the assistant may fill. Anything credential / payment related is never a fillable field. */
export const IRCTC_FILLABLE_FIELDS = [
  'from', 'to', 'date', 'travelClass', 'quota', 'train',
  'passengerName', 'passengerAge', 'passengerGender', 'passengerBerth', 'passengerFood'
] as const;
export type IrctcFillableField = typeof IRCTC_FILLABLE_FIELDS[number];

/** Fields the assistant NEVER touches (also enforced by the extension's semantic filter). */
export const IRCTC_FORBIDDEN_FIELD_PATTERN = /pass(word|wd)|otp|captcha|cvv|card|upi|pin\b|vpa|bank|ifsc|account|cookie|token|secret|login|userid|user_id|username/i;

export type IrctcHandoffEvent =
  | { type: 'PAGE_DETECTED'; page: IrctcPageKind }
  | { type: 'FIELDS_FILLED'; page: IrctcPageKind; filled: IrctcFillableField[]; skipped?: Array<{ field: IrctcFillableField; reason: string }> }
  | { type: 'FIELD_NOT_CONFIRMED'; field: IrctcFillableField }
  | { type: 'USER_OVERRIDE'; field: IrctcFillableField }
  | { type: 'LANGUAGE_SELECTED'; language: IrctcLanguage }
  | { type: 'LANGUAGE_SELECTOR_MISSING' }
  | { type: 'FINAL_CONTROL_HIGHLIGHTED'; page: IrctcPageKind }
  | { type: 'PAUSED' } | { type: 'RESUMED' } | { type: 'STOPPED' }
  | { type: 'FLOW_ENDED_WITHOUT_CONFIRMATION' };

export interface IrctcStationRef {
  code: string;
  /** IRCTC autocomplete style ("NEW DELHI - NDLS"); null when the official name is not in the validated data. */
  display: string | null;
  /** What to type into the IRCTC station box — the code (matched against suggestions ending in "- CODE"). */
  query: string;
}

export interface IrctcPassengerFill {
  index: number;
  name: string;
  age: number;
  /** IRCTC option label; null = not representable → IRCTC_FIELD_NOT_CONFIRMED, the user chooses on IRCTC. */
  gender: 'Male' | 'Female' | 'Transgender' | null;
  berth: string | null;
  food: string | null;
}

/** Snapshot served to the extension / Assist page. Contains NO secrets (and no session internals). */
export interface IrctcHandoffSnapshot {
  handoffId: string;
  status: IrctcHandoffStatus;
  createdAt: string;
  expiresAt: string;
  language: IrctcLanguage;
  /** true when the railway data behind the review was MOCK — never to be used on the real IRCTC site. */
  mockData: boolean;
  journey: { from: IrctcStationRef; to: IrctcStationRef; dateIso: string; dateIrctc: string };
  train: { number: string; name: string | null; departure: string | null; arrival: string | null };
  travelClass: { code: string; label: string | null };
  quota: { code: 'GN'; label: 'GENERAL' };
  passengers: IrctcPassengerFill[];
  /** What the user does personally — shown on every surface. */
  userActions: readonly string[];
  notConfirmed: Array<{ field: IrctcFillableField; passengerIndex?: number; reason: string }>;
  message: string;
  /** P39.3 — payload contract version (the extension rejects other versions). */
  schemaVersion: number;
  /** P39.3 — the confirmed review version this handoff was built from (the extension binds to it at registration). */
  sourceReviewVersion: number;
  /** P39.3 — HMAC-SHA256 (key = this handoff's bridge token) over `irctcIntegrityPayload(snapshot)`; a modified
   *  payload fails verification in the extension (STALE_IRCTC_HANDOFF / INTEGRITY_FAILED). */
  integrity: string;
}

/** Client view stored on the session / pushed as the irctc_handoff card (no passenger values, no token). */
export interface IrctcHandoffView {
  handoffId: string;
  status: IrctcHandoffStatus;
  createdAt: string;
  expiresAt: string;
  language: IrctcLanguage;
  mockData: boolean;
  reviewVersion: number;
  passengersCount: number;
  trainNumber: string;
  travelClass: string;
  dateIso: string;
  message: string;
  lastPage: IrctcPageKind | null;
  filledFields: IrctcFillableField[];
  notConfirmed: Array<{ field: IrctcFillableField; passengerIndex?: number; reason: string }>;
  userOverrides: IrctcFillableField[];
  updatedAt: string;
}

export const IRCTC_USER_ACTIONS: readonly string[] = Object.freeze([
  'IRCTC login (User ID + Password) — aap khud',
  'CAPTCHA — aap khud',
  'OTP — aap khud',
  'Final Book / Continue tap — aap khud',
  'Payment — aap khud'
]);

/** Required user-facing texts (P39 spec). */
export const IRCTC_TEXT = Object.freeze({
  CONTINUE_PROMPT: 'Details verified hain. IRCTC par continue karun?',
  LOGIN_REQUIRED: 'IRCTC login required. Please enter your User ID and Password.',
  READY_FOR_USER_BOOK: 'IRCTC par saari details fill ho gayi hain. Final Book/Continue action aap khud tap karein.',
  OTP_REQUIRED: 'OTP required. Please enter it on the IRCTC/payment page.',
  CAPTCHA_REQUIRED: 'CAPTCHA IRCTC page par aap khud bhariye — BookKaro CAPTCHA solve nahi karta.',
  PAYMENT_PAGE: 'Payment IRCTC / payment page par aap khud kijiye. BookKaro payment details nahi leta.',
  READY: 'IRCTC handoff tayyar hai. IRCTC kholiye — journey aur passenger details fill ho jaayengi; login, CAPTCHA, OTP, final Book aur payment aap khud karenge.',
  LANGUAGE_SELECTION: 'IRCTC language choose kijiye (English / हिंदी).',
  LANGUAGE_UNAVAILABLE: 'IRCTC page par language selector nahi mila — page jis language mein hai usi mein continue kar rahe hain.',
  JOURNEY_PAGE: 'IRCTC search form par From / To / Date / Class fill kiye ja rahe hain — verify hote hi BookKaro Search tap karega.',
  TRAIN_LIST: 'Train list mein aapki train aur class highlight ki gayi hai — Book Now aap khud tap karein.',
  PASSENGER_PAGE: 'Passenger details fill ki ja rahi hain — koi bhi field aap badal sakte hain.',
  PAUSED: 'Assistant paused hai — aap Resume kar sakte hain.',
  SESSION_EXPIRED: 'IRCTC session expire ho gaya — IRCTC par dobara login kijiye.',
  COMPLETED: 'IRCTC confirmation page detect hua — ticket ki details IRCTC page / SMS par check kijiye.',
  BOOKING_FAILED: 'IRCTC par booking fail dikhi — IRCTC page par status check kijiye.',
  BOOKING_STATUS_UNKNOWN: 'Booking status pata nahi — IRCTC confirmation page detect nahi hua. IRCTC “My Transactions” mein check kijiye.',
  EXPIRED: 'IRCTC handoff expire ho gaya — BookKaro mein review dobara confirm kijiye.',
  STALE_HANDOFF: 'Booking details badal gayi hain — purana IRCTC handoff ab valid nahi. Naya review confirm kijiye.',
  STOPPED: 'Assistant band kar diya gaya — IRCTC par jo fill hua hai woh aap khud check kijiye.',
  PASSENGER_LIMIT: `IRCTC ek ticket mein maximum ${IRCTC_MAX_PASSENGERS} passengers allow karta hai — IRCTC handoff nahi bana.`
});

export function irctcStatusMessage(status: IrctcHandoffStatus): string {
  switch (status) {
    case 'READY': return IRCTC_TEXT.READY;
    case 'LANGUAGE_SELECTION': return IRCTC_TEXT.LANGUAGE_SELECTION;
    case 'LOGIN_REQUIRED': return IRCTC_TEXT.LOGIN_REQUIRED;
    case 'JOURNEY_PAGE': return IRCTC_TEXT.JOURNEY_PAGE;
    case 'TRAIN_LIST': return IRCTC_TEXT.TRAIN_LIST;
    case 'PASSENGER_PAGE': return IRCTC_TEXT.PASSENGER_PAGE;
    case 'READY_FOR_USER_BOOK': return IRCTC_TEXT.READY_FOR_USER_BOOK;
    case 'CAPTCHA_REQUIRED': return IRCTC_TEXT.CAPTCHA_REQUIRED;
    case 'OTP_REQUIRED': return IRCTC_TEXT.OTP_REQUIRED;
    case 'PAYMENT_PAGE': return IRCTC_TEXT.PAYMENT_PAGE;
    case 'PAUSED': return IRCTC_TEXT.PAUSED;
    case 'SESSION_EXPIRED': return IRCTC_TEXT.SESSION_EXPIRED;
    case 'COMPLETED': return IRCTC_TEXT.COMPLETED;
    case 'BOOKING_FAILED': return IRCTC_TEXT.BOOKING_FAILED;
    case 'BOOKING_STATUS_UNKNOWN': return IRCTC_TEXT.BOOKING_STATUS_UNKNOWN;
    case 'EXPIRED': return IRCTC_TEXT.EXPIRED;
    case 'STALE_HANDOFF': return IRCTC_TEXT.STALE_HANDOFF;
    case 'STOPPED': return IRCTC_TEXT.STOPPED;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// P39.3 — handoff integrity + autofill contract (additive; mirrored in extension/irctc-handoff-guard.js)

export const IRCTC_HANDOFF_SCHEMA_VERSION = 1;
/** The ONLY host the extension autofills (exact match, no wildcard) and its app path. */
export const IRCTC_APPROVED_HOST = 'www.irctc.co.in';
export const IRCTC_APPROVED_PATH_PREFIX = '/nget/';

/** Why a handoff is refused by the extension — always reported as STALE_IRCTC_HANDOFF + reason. */
export type StaleIrctcHandoffReason =
  | 'EXPIRED' | 'UNKNOWN_HANDOFF' | 'REVIEW_VERSION_MISMATCH' | 'HANDOFF_MISMATCH' | 'SESSION_MISMATCH'
  | 'SCHEMA_INVALID' | 'INTEGRITY_FAILED' | 'STALE_HANDOFF';

/** Typed autofill errors the extension reports (metadata only — never field values). */
export const IRCTC_AUTOFILL_ERROR_CODES = [
  'STALE_IRCTC_HANDOFF', 'UNAUTHORIZED_IRCTC_HOST', 'LANGUAGE_SELECTION_FAILED',
  'FROM_STATION_AUTOFILL_FAILED', 'TO_STATION_AUTOFILL_FAILED', 'DATE_AUTOFILL_FAILED', 'CLASS_AUTOFILL_FAILED',
  'QUOTA_AUTOFILL_FAILED', 'TRAIN_AUTOFILL_FAILED', 'PASSENGER_ROW_MISSING', 'PASSENGER_FIELD_REJECTED'
] as const;
export type IrctcAutofillErrorCode = typeof IRCTC_AUTOFILL_ERROR_CODES[number];

/** Snapshot fields covered by the integrity HMAC (validated booking data + binding metadata). */
export const IRCTC_INTEGRITY_FIELDS = ['schemaVersion', 'handoffId', 'sourceReviewVersion', 'createdAt', 'expiresAt', 'mockData',
  'journey', 'train', 'travelClass', 'quota', 'passengers'] as const;

/** Deterministic JSON (sorted keys, undefined → null) — identical in the backend and the extension. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

export function irctcIntegrityPayload(s: Pick<IrctcHandoffSnapshot, typeof IRCTC_INTEGRITY_FIELDS[number]>): string {
  const o: Record<string, unknown> = {};
  for (const k of IRCTC_INTEGRITY_FIELDS) o[k] = (s as any)[k];
  return canonicalJson(o);
}
