/**
 * PROMPT 20 — Parts 3–6: BookingJourneyValidator.
 *
 * Validates origin / destination / date / selectedTrain / selectedClass against the CURRENT BookingSession only:
 *   - origin + destination present and different
 *   - date is a real calendar date (YYYY-MM-DD) and not in the past (IST calendar day)
 *   - selectedTrain is the ACTUAL train object from the CURRENT authoritative result set
 *     (same resultSetId when recorded, train number present in the displayed results, same journey date)
 *   - selectedClass exists in that train's provider-reported classes (never an LLM claim)
 * Returns typed missing / invalid information; never "fixes" anything.
 */
import type { BookingSession } from '@shared/entities';
import type { JourneyValidation, JourneyField, JourneyIssueCode } from '@shared/booking-preparation';
import { displayedResultsOf } from '../../ai/conversation/conversation-context';

const trainNo = (t: any): string | null => (t ? String(t.number || t.trainNumber || '') || null : null);
const istToday = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);

export function isValidCalendarDate(d: unknown): d is string {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const dt = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d;
}

/** The selected train's record inside the CURRENT result set (null when it is not there). */
export function currentResultRecord(s: BookingSession): any | null {
  const num = trainNo(s.selectedTrain);
  if (!num) return null;
  if (!displayedResultsOf(s).items.some(i => i.trainNumber === num)) return null;
  const trains: any[] = (s.searchResults as any)?.trains || [];
  return trains.find(t => trainNo(t) === num) || null;
}

/** Classes the provider reported for the selected train in the current results. */
export function providerClassesOf(s: BookingSession): string[] {
  const t = currentResultRecord(s);
  return t ? (t.classes || []).map((c: any) => String(c.code || c).toUpperCase()) : [];
}

export class BookingJourneyValidator {
  constructor(private readonly clock: () => number = () => Date.now()) {}

  validate(s: BookingSession): JourneyValidation {
    const issues: Array<{ field: JourneyField; code: JourneyIssueCode }> = [];
    const add = (field: JourneyField, code: JourneyIssueCode) => issues.push({ field, code });
    const resultSetId: string | null = (s.searchResults as any)?.resultId ?? s.searchMeta?.resultId ?? null;

    if (!s.origin) add('origin', 'MISSING');
    if (!s.destination) add('destination', 'MISSING');
    if (s.origin && s.destination && s.origin === s.destination) add('destination', 'SAME_STATION');

    if (!s.date) add('date', 'MISSING');
    else if (!isValidCalendarDate(s.date) || s.date < istToday(this.clock())) add('date', 'INVALID_DATE');

    const t: any = s.selectedTrain;
    if (!trainNo(t)) add('selectedTrain', 'MISSING');
    else {
      const rec = currentResultRecord(s);
      const sameSet = !t.searchResultId || !resultSetId || t.searchResultId === resultSetId;
      const sameDate = !t.date || !s.date || t.date === s.date;
      if (!rec || !sameSet || !sameDate) add('selectedTrain', 'INVALID_TRAIN_SELECTION');
    }

    if (!s.selectedClass) add('selectedClass', 'MISSING');
    else if (!issues.some(i => i.field === 'selectedTrain') && !providerClassesOf(s).includes(String(s.selectedClass).toUpperCase())) {
      add('selectedClass', 'INVALID_CLASS_SELECTION');
    }
    return { valid: issues.length === 0, issues, resultSetId };
  }
}

export const bookingJourneyValidator = new BookingJourneyValidator();
