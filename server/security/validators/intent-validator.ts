import { Intent } from '@shared/intents';

const VALID_INTENTS = new Set(Object.values(Intent));

// Sensitive patterns we reject if AI/input contains credential requests
export const SENSITIVE_PATTERNS = [
  /\bpass\s*word\b|\bpasswd\b|\bpwd\b/i,
  /\botp\b|one[\s-]*time\s*password/i,
  /\bupi\s*pin\b|\bmpin\b|\bupi\s*password\b/i,
  /\birctc\s*(password|id|login|user\s*id|username)\b/i,
  /\b(atm\s*)?pin\b/i,
  /\bcaptcha\b/i,
  /card\s*(number|no\.?|details)/i,
  /\bcvv\b|\bcvc\b/i,
  /credit\s*card/i,
  /debit\s*card/i,
  /\b(net\s*banking|bank)\s*(password|login|pin)\b/i,
  /\b(auth|access|bearer|session|api)\s*(token|key)\b|\btoken\b/i,
  /\bcookies?\b/i,
  /\bbearer\s+[A-Za-z0-9._-]{10,}/i,
  // 13–19 digit card-like numbers (spaces/dashes allowed) — train numbers are 5 digits
  /\b(?:\d[ -]?){12,18}\d\b/
];

// Non-railway topics that should be short-circuited with a polite decline.
// Only triggers if no railway keywords are present.
export const NON_RAILWAY_PATTERNS = [
  /weather|mausam/i,
  /movie|film/i,
  /cricket|sports?\s+score/i,
  /politics|news\s+headline/i,
  /stock|share\s*market/i,
  /joke|chutkula/i
];

export function validateIntent(intent: any): intent is Intent {
  return VALID_INTENTS.has(intent);
}

export function validatePayloadAgainstState(intent: Intent, payload: any, currentState: string): boolean {
  // Block any intent that attempts confirmation when not in review state
  if (intent === Intent.CONFIRM_BOOKING || intent === Intent.HANDOFF_TO_IRCTC) {
    return currentState === 'BOOKING_REVIEW' || currentState === 'AWAITING_CONFIRMATION';
  }
  return true;
}

export function containsSensitiveRequest(text: string): boolean {
  return SENSITIVE_PATTERNS.some(p => p.test(text));
}

export function redactSensitiveData(text: string): string {
  let redacted = text;
  SENSITIVE_PATTERNS.forEach(p => {
    redacted = redacted.replace(p, '[REDACTED SENSITIVE DATA]');
  });
  return redacted;
}
