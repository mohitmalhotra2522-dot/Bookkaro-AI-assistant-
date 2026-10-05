/**
 * Builds a BookingExecutionRequest from the AUTHORITATIVE BookingSession only.
 * Whitelists fields — nothing the LLM said, and no credential-like data, can enter.
 */
import type { BookingSession } from '@shared/entities';
import type { BookingExecutionRequest, ExecutionPassenger } from '@shared/booking-execution';
import { computeIdempotencyKey } from './booking-handoff';

export function buildExecutionRequest(s: BookingSession, opts: { requestId: string; confirmedAt: string }): BookingExecutionRequest | null {
  const t: any = s.selectedTrain;
  const rv = s.review;
  if (!t || !rv || !s.origin || !s.destination || !s.date || !s.selectedClass) return null;
  const passengers: ExecutionPassenger[] = (s.passengers || []).map((p: any) => ({
    passengerId: String(p.passengerId ?? p.id ?? ''),
    name: String(p.name ?? ''),
    age: Number(p.age),
    gender: p.gender,
    ...(p.berthPreference ? { berthPreference: String(p.berthPreference) } : {}),
    ...(p.foodPreference ? { foodPreference: String(p.foodPreference) } : {})
  }));
  return {
    sessionId: s.sessionId,
    requestId: opts.requestId,
    idempotencyKey: computeIdempotencyKey(s.sessionId, rv.reviewVersion, rv.fingerprint),
    reviewVersion: rv.reviewVersion,
    sessionVersion: s.sessionVersion,
    journey: { origin: s.origin, destination: s.destination },
    date: s.date,
    selectedTrain: {
      trainNumber: String(t.number || t.trainNumber),
      trainName: t.name || t.trainName,
      resultId: String(t.resultId ?? ''),
      date: String(t.date ?? ''),
      origin: t.origin,
      destination: t.destination,
      departure: t.departure,
      arrival: t.arrival
    },
    selectedClass: s.selectedClass,
    passengers,
    confirmedAt: opts.confirmedAt,
    explicitConfirmation: true
  };
}

/** Field names that must never appear anywhere in an execution request / handoff. */
export const SENSITIVE_KEY_RE = /pass(word|wd)|otp|captcha|cvv|card|upi|pin\b|bank|token|cookie|secret|credential|auth/i;

/** Deep scan for credential-like keys. Returns offending key paths. */
export function findSensitiveKeys(o: any, path = ''): string[] {
  if (!o || typeof o !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    const p = path ? `${path}.${k}` : k;
    if (SENSITIVE_KEY_RE.test(k)) out.push(p);
    out.push(...findSensitiveKeys(v, p));
  }
  return out;
}
