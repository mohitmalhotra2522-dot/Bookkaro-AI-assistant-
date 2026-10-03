/**
 * PROMPT 17 — journeyVersion (Part 55).
 *
 * Increments whenever the MATERIAL journey (origin | destination | date) changes. Tool results carry the
 * journeyVersion they were requested under; a result whose journeyVersion is no longer current is a
 * STALE_TOOL_RESULT and is never applied ("Amritsar se Delhi" search returning after "nahi Ludhiana").
 * Synced lazily on read and on every session bump, so no mutation path can skip it.
 */
import type { BookingSession } from '@shared/entities';

export function journeyKeyOf(s: Pick<BookingSession, 'origin' | 'destination' | 'date'>): string {
  return `${s.origin || ''}|${s.destination || ''}|${s.date || ''}`;
}

/** Returns the current journeyVersion, bumping it first if the journey fingerprint moved. */
export function syncJourneyVersion(s: BookingSession): number {
  const key = journeyKeyOf(s);
  if (s.journeyKey !== key) {
    s.journeyVersion = (s.journeyVersion || 0) + 1;
    s.journeyKey = key;
  }
  return s.journeyVersion || 0;
}
