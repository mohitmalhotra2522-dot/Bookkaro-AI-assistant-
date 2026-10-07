/**
 * Post-P42.10 — F2: a waitlist POSITION is never a seat count.
 * Production (P42.10 smoke D3), CHECK_AVAILABILITY 12716 SL = "WL 62" (available: false); Muse wrote
 *   "12716 SACHKHAND EXP ki SL class abhi wait‑list par hai – 62 seats wait‑list mein."   (U+2011 hyphens)
 * and the P42.3 availability-authority guard VERIFIED it: (1) "wait‑list" / "wait-list" was not waitlist vocabulary →
 * the claim degraded to ANY (matches any result); (2) "N seats … waitlist" had no claim kind → a bare WL claim matched.
 */
import { describe, it, expect } from 'vitest';
import { judgeAvailabilityClaim, classifyAvailabilityClaim, hasAvailabilityCode } from '../../server/ai/response/availability-authority';
import { guardResponseFacts } from '../../server/ai/conversation/response-fact-guard';

const D = '2026-10-09';
const ev = (status: string, available = false, cls = 'SL', train = '12716') =>
  ({ trainNumber: train, date: D, travelClass: cls, status, available, sourceTool: 'CHECK_AVAILABILITY', sourceResultId: 'r1', origin: 'TOOL_STEP' }) as any;
const ctx = (e: any[]) => ({ session: { selectedTrain: { number: '12716' }, selectedClass: 'SL', date: D }, evidence: e });
const WL62 = ctx([ev('WL 62')]);
const verdict = (t: string, c = WL62) => judgeAvailabilityClaim(t, c);
const rejected = (t: string, c = WL62) => !!verdict(t, c).reason;

describe('Post-P42.10 F2 — waitlist position is never a seat count (P42.3 guard, structured)', () => {
  it('[1] the exact production sentence (U+2011 hyphens) is REJECTED as WL_POSITION_AS_SEATS', () => {
    const t = '12716 SACHKHAND EXP ki SL class abhi wait\u2011list par hai \u2013 62 seats wait\u2011list mein.';
    expect(classifyAvailabilityClaim(t)).toBe('LIVE_AVAILABILITY_CLAIM');
    expect(verdict(t).reason).toBe('AVAILABILITY_MISMATCH:WL_POSITION_AS_SEATS');
  });

  it('[2] every spelling / order / language of "N seats waitlist" is rejected — with or without a train number', () => {
    for (const t of [
      '12716 ki SL class abhi wait-list par hai - 62 seats wait-list mein.',
      '12716 SL mein 62 seats wait list mein hain.',
      '12716 SL mein 62 seats waitlist mein hain.',
      '12716 SL mein 62 berths waitlisted hain.',
      '12716 SL has 62 seats on the waitlist.',
      'SL class mein 62 seats wait\u2011list mein hain.',                   // no train number → the selected train
      'Is train mein 62 seats WL mein hain.'
    ]) expect([t, verdict(t).reason]).toEqual([t, 'AVAILABILITY_MISMATCH:WL_POSITION_AS_SEATS']);
    // reverse order: "62 seats hain" is already an AVAILABLE 62 claim (P42.2 rule) — that existing reason keeps priority
    expect(verdict('12716 SL mein waitlist mein 62 seats hain.').reason).toBe('AVAILABILITY_MISMATCH:AVAILABLE 62');
    expect(verdict('12716 SL mein waitlist mein 62 seats.').reason).toBe('AVAILABILITY_MISMATCH:WL_POSITION_AS_SEATS');
  });

  it('[3] correct waitlist wording stays (Muse\'s wording is kept, not templated)', () => {
    for (const t of [
      '12716 SL mein WL 62 hai.',
      '12716 SACHKHAND EXP ki SL class abhi wait\u2011list par hai \u2013 WL 62.',
      '12716 ki SL class abhi wait-list par hai.',
      '12716 SL mein waitlist 62 chal rahi hai.',
      '12716 SL abhi waiting list 62 par hai.'
    ]) expect([t, verdict(t).outcome]).toEqual([t, 'VERIFIED_AVAILABILITY']);
    expect(verdict('WL 62 ka matlab hai ki aap waitlist mein 62ve number par hain.').reason).toBeNull();   // explanation
  });

  it('[4] the hyphen no longer hides a wrong position or a false "available" claim', () => {
    expect(hasAvailabilityCode('12716 SL abhi wait\u2011list 12 par hai.')).toBe(true);
    expect(verdict('12716 SL abhi wait\u2011list 12 par hai.').reason).toBe('AVAILABILITY_MISMATCH:WL 12');
    expect(rejected('12716 SL wait-list par nahi hai, seats available hain.')).toBe(true);
  });

  it('[5] not over-matching: a NEED for seats, available seats beside a waitlist, a passenger count', () => {
    expect(rejected('12716 SL mein 3 seats ke liye abhi WL 62 hai.')).toBe(false);
    expect(rejected('12716 SL mein 3 passengers ke liye seats waitlist pe hain \u2013 WL 62.')).toBe(false);
    const mixed = ctx([ev('AVAILABLE 5', true, '3A'), ev('WL 62')]);
    expect(rejected('12716 3A mein 5 seats available hain, SL waitlist mein hai.', mixed)).toBe(false);
    expect(rejected('12716 3A mein 0 confirmed seats hain aur waitlist hai.', ctx([ev('WL 62', false, '3A')]))).toBe(false);
  });

  it('[6] the response-fact guard path removes only that sentence; other sentences stay', () => {
    const session: any = { selectedTrain: { number: '12716' }, selectedClass: 'SL', date: D, searchResults: { trains: [{ trainNumber: '12716' }] } };
    const steps: any[] = [{ status: 'ok', result: { toolName: 'CHECK_AVAILABILITY', ok: true, data: { trainNumber: '12716', travelClass: 'SL', date: D, status: 'WL 62', available: false } } }];
    const out = guardResponseFacts('12716 select ho gayi. SL class select ho gayi. 12716 ki SL class abhi wait\u2011list par hai \u2013 62 seats wait\u2011list mein.', { session, steps } as any);
    expect(out.text).not.toMatch(/62 seats/);
    expect(out.text).toMatch(/12716 select ho gayi\. SL class select ho gayi\./);
  });
});
