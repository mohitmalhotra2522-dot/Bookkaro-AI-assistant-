/**
 * PROMPT 17 — Tool error normalization (Part 47).
 *
 * Provider / service / validator error codes are mapped onto ONE stable vocabulary for the LLM, the
 * execution record and the UI. The original code is preserved as `detail` (existing flows keep reading
 * it) — normalization never invents success, never turns a timeout into "no results", never exposes
 * stack traces, provider internals or credentials.
 */
import type { ToolErrorCode, ToolExecutionStatus } from '@shared/railway-tool-runtime';

const RUNTIME_CODES: ReadonlySet<string> = new Set([
  'UNKNOWN_TOOL', 'TOOL_NOT_IMPLEMENTED', 'TOOL_CALL_REJECTED', 'FORBIDDEN_ACTION', 'FORBIDDEN_ARGUMENT',
  'TOOL_CALL_LIMIT_EXCEEDED', 'TOOL_LOOP_DETECTED', 'STALE_TOOL_RESULT', 'PROVIDER_DATA_CONFLICT',
  'TOOL_FAILED', 'TOOL_TIMEOUT', 'INVALID_REQUEST', 'NO_RESULTS', 'PROVIDER_UNAVAILABLE', 'RATE_LIMITED',
  'AUTH_ERROR', 'DATA_UNAVAILABLE', 'UNKNOWN', 'DEPENDENCY_NOT_SATISFIED'
]);

export function normalizeToolErrorCode(raw: string | undefined | null): ToolErrorCode {
  const c = String(raw || '').toUpperCase();
  if (!c) return 'UNKNOWN';
  if (RUNTIME_CODES.has(c)) return c as ToolErrorCode;
  // must precede the generic *_UNAVAILABLE rule (registry-disabled tool ≠ missing data)
  if (c === 'TOOL_UNAVAILABLE') return 'TOOL_NOT_IMPLEMENTED';
  if (/TIMEOUT|TIMED_OUT/.test(c)) return 'TOOL_TIMEOUT';
  if (c === 'NO_TRAINS_FOUND' || c === 'NOT_FOUND' || c === 'EMPTY_RESULT') return 'NO_RESULTS';
  if (/RATE_?LIMIT|TOO_MANY/.test(c)) return 'RATE_LIMITED';
  if (/AUTH|UNAUTHORI[SZ]ED|FORBIDDEN_PROVIDER|API_KEY/.test(c)) return 'AUTH_ERROR';
  if (c === 'PROVIDER_UNAVAILABLE' || /PROVIDER_(ERROR|DOWN)/.test(c)) return 'PROVIDER_UNAVAILABLE';
  if (/_UNAVAILABLE$|NOT_AVAILABLE$|CLASS_NOT_AVAILABLE/.test(c)) return 'DATA_UNAVAILABLE';
  if (/^INVALID_|^MISSING_|^AMBIGUOUS_|TRAIN_NOT_IN_RESULTS|CONTEXT_CONFLICT|ACCESS_DENIED|AUTHORITATIVE_DATA_REQUIRED|BOOKING_CONTEXT_MISSING|MULTIPLE_BOOKINGS/.test(c)) return 'INVALID_REQUEST';
  return 'TOOL_FAILED';
}

/** Execution status implied by a normalized error (validation-stage errors are REJECTED by the caller). */
export function statusForError(code: ToolErrorCode): ToolExecutionStatus {
  if (code === 'TOOL_TIMEOUT') return 'TIMEOUT';
  if (code === 'STALE_TOOL_RESULT') return 'CANCELLED';
  if (code === 'UNKNOWN') return 'UNKNOWN';
  return 'FAILED';
}

/** Short, user-safe Hinglish fallback per category (callers may keep a more specific safe message). */
export const SAFE_ERROR_MESSAGE: Record<ToolErrorCode, string> = {
  TOOL_FAILED: 'Ye jaankari abhi verify nahi ho paayi. Thodi der baad try karein.',
  TOOL_TIMEOUT: 'Railway provider ne time par jawab nahi diya — jaankari abhi verify nahi ho paayi.',
  INVALID_REQUEST: 'Request poori nahi thi — thodi aur jaankari chahiye.',
  NO_RESULTS: 'Provider ne is request ke liye koi result nahi diya.',
  PROVIDER_UNAVAILABLE: 'Railway provider abhi uplabdh nahi hai. Thodi der baad try karein.',
  RATE_LIMITED: 'Railway provider abhi busy hai. Thodi der baad try karein.',
  AUTH_ERROR: 'Railway provider se jaankari abhi nahi mil paayi.',
  DATA_UNAVAILABLE: 'Is information ka verified result available nahi hai.',
  UNKNOWN: 'Is information ka verified result available nahi hai.',
  UNKNOWN_TOOL: 'Ye suvidha abhi uplabdh nahi hai.',
  TOOL_NOT_IMPLEMENTED: 'Ye jaankari abhi verified source se uplabdh nahi hai.',
  TOOL_CALL_REJECTED: 'Ye request abhi process nahi ho sakti.',
  FORBIDDEN_ACTION: 'Ye action main seedha nahi kar sakta — booking se jude badlav sirf confirm kiye gaye backend flow se hote hain.',
  FORBIDDEN_ARGUMENT: 'Main password, OTP, CAPTCHA, card ya UPI PIN jaisi jaankari kabhi nahi leta.',
  TOOL_CALL_LIMIT_EXCEEDED: 'Request bahut lambi ho gayi — thoda simple karke poochiye.',
  TOOL_LOOP_DETECTED: 'Ye jaankari dobara nahi mangwa raha — upar wala verified result hi current hai.',
  STALE_TOOL_RESULT: 'Purana result ignore kiya gaya.',
  DEPENDENCY_NOT_SATISFIED: 'Pehle wala step verify nahi ho paaya, isliye ye check abhi nahi kiya.',
  PROVIDER_DATA_CONFLICT: 'Railway providers ki jaankari mel nahi kha rahi — abhi verified result available nahi hai.',
  INVALID_ARGUMENT: 'Ek detail sahi format mein nahi thi — thoda clear karke bataiye.',
  INVALID_REPEATED_CALL: 'Wahi galat detail dobara aayi — sahi value bataiye.'
};

/** Strip anything that is not a short human message (stack traces, URLs with keys, JSON blobs). */
export function safeErrorMessage(code: ToolErrorCode, raw?: string): string {
  const m = String(raw || '').trim();
  if (!m || m.length > 280 || /\n\s+at\s|Error:|https?:\/\/|api[_-]?key|token|secret|\{".*"\}/i.test(m)) return SAFE_ERROR_MESSAGE[code];
  return m;
}
