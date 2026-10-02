/**
 * Tool execution logger.
 * Records structured per-tool-call events.
 * NEVER logs passwords, OTP, CAPTCHA, payment credentials, or other secrets.
 * All sensitive input is redacted before logging.
 */
export interface ToolLogEntry {
  sessionId: string;
  turnId: string;
  toolName: string;
  provider: string;
  requestTimestamp: string;
  responseTimestamp: string;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
  cache?: string;
}

const SENSITIVE_KEYS = ['password', 'otp', 'captcha', 'cvv', 'pin', 'cardNumber', 'token', 'cookie'];

class ToolLogger {
  private logs: ToolLogEntry[] = [];

  record(entry: ToolLogEntry) {
    this.logs.push(entry);
    // In production, this would ship to an observability backend.
    // For dev we keep a capped in-memory ring buffer.
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
  }

  all(): ReadonlyArray<ToolLogEntry> {
    return this.logs;
  }
}

/** Mask secrets inside free text (OTP/PIN/CVV/password values, card numbers, tokens). */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(password|passwd|pwd|otp|upi\s*pin|pin|cvv|captcha|irctc\s*password)\b(\s*(is|hai|ka|:|=|-)?\s*)([^\s,.;]+)/gi, '$1$2[REDACTED]')
    .replace(/\b(bearer|token|api[_-]?key|cookie|session[_-]?cookie|auth(orization)?)\b(\s*[:=]?\s*)([^\s,;]+)/gi, '$1$3[REDACTED]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED_CARD]');
}

export function redactSensitive(input: any): any {
  if (input == null) return input;
  if (typeof input === 'string') return redactSensitiveText(input);
  if (typeof input !== 'object') return input;
  const out: any = Array.isArray(input) ? [] : {};
  for (const k of Object.keys(input)) {
    if (SENSITIVE_KEYS.some(sk => k.toLowerCase().includes(sk))) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactSensitive(input[k]);
    }
  }
  return out;
}

export const toolLogger = new ToolLogger();
