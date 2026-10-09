/**
 * 2026-10-09 — "Ludhiana se Svdk 20 October 1 passenger" was resolved to 2027-10-01: the user-words date guard
 * (extractDateExpression) also matched "october 1" (month + the passenger count) and took the LAST match. The month word
 * already has its day before it ("20 october") → the overlapping later match is dropped. DateResolver prefers a real
 * month word so a number before another word ("1 passenger 20 October") never hijacks the day. Clock pinned (IST).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { extractDateExpression } from '../../server/ai/conversation/grounding';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

beforeAll(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-09T10:00:00+05:30')); });
afterAll(() => { vi.useRealTimers(); });

describe('day + month followed by a passenger count', () => {
  it('[DT1] the reported sentence → 20 Oct 2026 (never 1 Oct 2027)', () => {
    expect(extractDateExpression('Ludhiana se Svdk 20 October 1 passenger')).toEqual({ expression: '20 october', date: '2026-10-20' });
    expect(extractDateExpression('20 October 1 passenger')!.date).toBe('2026-10-20');
    expect(extractDateExpression('kal nahi 20 oct 3 passengers')!.date).toBe('2026-10-20');
    expect(extractDateExpression('20 oct 2 log jayenge')!.date).toBe('2026-10-20');
  });
  it('[DT2] other orders still work: "October 20", count before the date, a year, "Oct 25" alone', () => {
    expect(extractDateExpression('October 20 2 log')!.date).toBe('2026-10-20');
    expect(extractDateExpression('1 passenger 20 October')!.date).toBe('2026-10-20');
    expect(extractDateExpression('20 oct 2026 1 passenger')!.date).toBe('2026-10-20');
    expect(extractDateExpression('Oct 25')!.date).toBe('2026-10-25');
    expect(extractDateExpression('25 Oct')!.date).toBe('2026-10-25');
  });
  it('[DT3] negation keeps working: the post-negation date wins', () => {
    expect(extractDateExpression('20 oct nahi 22 oct 1 passenger')!.date).toBe('2026-10-22');
  });
  it('[DT4] DateResolver: a real month word is preferred over "<number> <word>"; unknown month words still ask', () => {
    expect(resolveDate('1 passenger 20 October')).toEqual({ ok: true, date: '2026-10-20' });
    expect(resolveDate('October 20 2 log')).toEqual({ ok: true, date: '2026-10-20' });
    expect(resolveDate('20 October 1 passenger')).toEqual({ ok: true, date: '2026-10-20' });
    expect(resolveDate('5 Oct')).toEqual({ ok: true, date: '2027-10-05' });           // already passed this year → next year (unchanged rule)
    expect(resolveDate('3 xyz')).toMatchObject({ ok: false, error: 'AMBIGUOUS_DATE' });
  });
});
