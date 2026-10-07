/**
 * P42.3 BLOCKER — availability claim guard regressions (server/ai/response/availability-authority.ts).
 * Found LIVE on staging: 12446 1A, 3 passengers, provider RLWL1/WL1 (0 confirmed seats) and Muse said
 * "Agar aap seat chahte hain, to 1 seat available hai, baki 2 seats waitlist mein." This must never pass.
 * Pure, deterministic: no LLM, no provider, no network.
 */
import { describe, it, expect } from 'vitest';
import { judgeAvailabilityClaim, collectAvailabilityEvidence, classifyAvailabilityClaim, type AvailabilityContext } from '../../server/ai/response/availability-authority';

const DATE = '2026-10-08';
const session = (pax = 3, extra: any = {}) => ({ passengersCount: pax, selectedTrain: { number: '12446', name: 'UTTAR S KRANTI' }, selectedClass: '1A', date: DATE, origin: 'LDH', destination: 'UMB', ...extra });
const ev = (status: string, available?: boolean, extra: any = {}) => ({ trainNumber: '12446', date: DATE, travelClass: '1A', status, ...(available === undefined ? {} : { available }),
  sourceTool: 'CHECK_AVAILABILITY' as const, sourceResultId: 'tx_test', origin: 'SESSION' as const, ...extra });
const ctx = (status: string | null, pax = 3, available?: boolean, extra: any = {}): AvailabilityContext =>
  ({ session: session(pax), evidence: status === null ? [] : [ev(status, available, extra)], origin: 'ASSISTANT' });
const rejected = (t: string, c: AvailabilityContext) => judgeAvailabilityClaim(t, c).reason !== null;
const allowed = (t: string, c: AvailabilityContext) => judgeAvailabilityClaim(t, c).reason === null;

const BUG = 'Agar aap seat chahte hain, to 1 seat available hai, baki 2 seats waitlist mein.';
const WL = ctx('RLWL1/WL1', 3, false);                                    // waitlist-only: 0 confirmed / 0 available seats

describe('P42.3 — the exact staging bug', () => {
  it('[BUG] RLWL1/WL1 (0 confirmed) + "Agar aap seat chahte hain, to 1 seat available hai, baki 2 seats waitlist mein." → REJECTED', () => {
    const v = judgeAvailabilityClaim(BUG, WL);
    expect(v.outcome).toBe('AVAILABILITY_MISMATCH');                   // classified as a live claim, then contradicted by the provider
    expect(v.reason).toBe('AVAILABILITY_MISMATCH:AVAILABLE 1');
    expect(classifyAvailabilityClaim(BUG)).toBe('LIVE_AVAILABILITY_CLAIM');
  });
  it('[BUG] the truthful first sentence of the same reply still passes (natural wording kept)', () => {
    expect(allowed('12446 UTTAR S KRANTI ki 1A class mein 3 passengers ke liye seats waitlist pe hain – WL 1.', WL)).toBe(true);
  });
});

describe('P42.3 — required regressions', () => {
  it('[1] WAITLIST + "1 seat available" → reject (also inside a waitlist sentence)', () => {
    expect(rejected('12446 1A mein 1 seat available hai.', WL)).toBe(true);
    expect(rejected('12446 1A mein 1 seat available hai, baki 2 seats waitlist mein.', WL)).toBe(true);
    expect(rejected('WL 1 hai, lekin one seat is available.', WL)).toBe(true);
  });
  it('[2] WAITLIST + "0 confirmed seats" → allow', () => {
    expect(allowed('12446 1A mein 0 confirmed seats hain aur waitlist hai.', WL)).toBe(true);
    expect(allowed('0 confirmed seats hain aur waitlist hai.', WL)).toBe(true);
    expect(allowed('12446 1A mein abhi WL 1 hai, confirmed seat nahi hai.', WL)).toBe(true);
  });
  it('[3] NOT_AVAILABLE + "1 seat available" → reject', () => {
    expect(rejected('12446 1A mein 1 seat available hai.', ctx('NOT AVAILABLE', 3, false))).toBe(true);
  });
  it('[4] UNKNOWN + "1 seat available" → reject (unknown status, and no evidence at all)', () => {
    expect(rejected('12446 1A mein 1 seat available hai.', ctx('UNKNOWN'))).toBe(true);
    expect(rejected('12446 1A mein 1 seat available hai.', ctx(null))).toBe(true);
  });
  it('[5] TIMEOUT + "1 seat available" → reject (a timed-out call is never evidence)', () => {
    const steps = [{ toolName: 'CHECK_AVAILABILITY', ok: false, data: null, error: { code: 'TOOL_TIMEOUT' } }];
    const c: AvailabilityContext = { session: session(), evidence: collectAvailabilityEvidence({ ...session(), availability: {} }, steps), origin: 'ASSISTANT' };
    expect(c.evidence).toEqual([]);
    expect(rejected('12446 1A mein 1 seat available hai.', c)).toBe(true);
    expect(rejected('12446 1A mein 1 seat available hai.', ctx('TIMEOUT'))).toBe(true);
  });
  it('[6] AVAILABLE 1 + "1 seat available" → allow', () => {
    expect(allowed('12446 1A mein 1 seat available hai.', ctx('AVAILABLE-0001', 1, true))).toBe(true);
    expect(allowed('12446 1A mein sirf 1 seat available hai.', ctx('AVAILABLE-0001', 3, true))).toBe(true);   // exact count stated for a party of 3
  });
  it('[7] AVAILABLE 3 + "3 seats available" → allow', () => {
    expect(allowed('12446 1A mein 3 seats available hain.', ctx('AVAILABLE-0003', 3, true))).toBe(true);
  });
  it('[8] AVAILABLE 3 + "1 seat available" → reject', () => {
    expect(rejected('12446 1A mein 1 seat available hai.', ctx('AVAILABLE-0003', 3, true))).toBe(true);
  });
  it('[9] conditional "Agar aap chahte hain, 1 seat available hai" with authoritative 0 → reject', () => {
    for (const st of ['AVAILABLE-0000', 'RLWL1/WL1', 'NOT AVAILABLE']) {
      expect(rejected('Agar aap chahte hain, 1 seat available hai.', ctx(st, 3, false)), st).toBe(true);
      expect(rejected('If you want, one seat is available.', ctx(st, 3, false)), st).toBe(true);
      expect(rejected('You can book it, 1 seat available hai.', ctx(st, 3, false)), st).toBe(true);
    }
  });
  it('[10] "WL1 ka matlab waitlist hai" is an explanation, not an availability claim', () => {
    const v = judgeAvailabilityClaim('WL1 ka matlab waitlist hai.', WL);
    expect(v.outcome).toBe('GENERAL_KNOWLEDGE_CLAIM');
    expect(v.reason).toBeNull();
    // Prompt 28 explanations stay general knowledge (conditional wording without a concrete claim)
    expect(classifyAvailabilityClaim('Agar RAC 1 wala cancel kare to berth mil jaati hai.')).toBe('GENERAL_KNOWLEDGE_CLAIM');
  });
  it('[11] a requestId / execution id with digits never becomes available-seat evidence', () => {
    const c = ctx('AVAILABLE', 3, true, { sourceResultId: 'req_0005' });
    expect(rejected('12446 1A mein 5 seats available hain.', c)).toBe(true);
    const fromSession = collectAvailabilityEvidence({ ...session(), availability: { '1A': { trainNumber: '12446', travelClass: '1A', date: DATE, status: 'RLWL1/WL1', available: false, requestId: 'req-0001', toolExecutionId: 'tx_0001' } } });
    expect(rejected('12446 1A mein 1 seat available hai.', { session: session(), evidence: fromSession, origin: 'ASSISTANT' })).toBe(true);
  });
  it('[12] a timestamp with digits never becomes available-seat evidence', () => {
    expect(rejected('12446 1A mein 12 seats available hain.', ctx('AVAILABLE @12:03', 3, true))).toBe(true);
    const fromSession = collectAvailabilityEvidence({ ...session(), availability: { '1A': { trainNumber: '12446', travelClass: '1A', date: DATE, status: 'RLWL1/WL1', available: false, providerUpdatedAt: '2026-10-07T12:03:01+05:30' } } });
    expect(rejected('12446 1A mein 3 seats available hain.', { session: session(), evidence: fromSession, origin: 'ASSISTANT' })).toBe(true);
  });
});

describe('P42.3 — cross-status protection (Rule 5) and UNKNOWN / TIMEOUT (Rule 6)', () => {
  const NON_AVAILABLE = ['RLWL1/WL1', 'GNWL 12', 'NOT AVAILABLE', 'REGRET', 'TRAIN CANCELLED', 'UNKNOWN', 'TIMEOUT', 'PROVIDER_ERROR'];
  it('[R5] "1 seat available" / "seats available hain" are rejected against every non-available status', () => {
    for (const st of NON_AVAILABLE) {
      expect(rejected('12446 1A mein 1 seat available hai.', ctx(st)), st).toBe(true);
      expect(rejected('12446 1A mein seats available hain.', ctx(st)), st).toBe(true);
    }
    expect(rejected('12446 1A mein WL 1 hai, lekin seats available hain.', WL)).toBe(true);
  });
  it('[R6] UNKNOWN / TIMEOUT / provider error never become "no seats" either', () => {
    for (const st of ['UNKNOWN', 'TIMEOUT', 'PROVIDER_ERROR']) {
      expect(rejected('12446 1A mein seats nahi hain.', ctx(st)), st).toBe(true);
      expect(rejected('12446 1A full hai.', ctx(st)), st).toBe(true);
    }
  });
  it('[R4] WL1 / RLWL1 is a waitlist position — never a confirmed or available seat, even with available:true metadata', () => {
    expect(rejected('12446 1A mein 1 confirmed seat hai.', WL)).toBe(true);
    expect(rejected('12446 1A mein 1 seat available hai.', ctx('RLWL1/WL1', 3, true))).toBe(true);
  });
});
