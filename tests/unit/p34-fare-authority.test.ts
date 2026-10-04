/**
 * PROMPT 34 FINAL FOLLOW-UP — G2: FARE AUTHORITY at the orchestration / fact-validation boundary.
 * A ₹ amount written by the LLM is valid ONLY with matching successful GET_FARE-derived data (this turn's GET_FARE,
 * the committed session quote, or the verified review) for train / class / date. Never from a failed / malformed /
 * timed-out lookup, never from search-result fixture fares, never from the LLM's own words. Identical for TEXT/VOICE.
 */
import { describe, it, expect } from 'vitest';
import { buildFactIndex, judgeFareAuthority } from '../../server/ai/response/claim-facts';
import { guardFareClaims } from '../../server/ai/response/claim-entity-binding';
import { factGuard } from '../../server/ai/agent/conversation-agent-orchestrator';
import { resolveDate } from '../../server/railway/resolvers/date-resolver';

const DATE = (resolveDate('kal') as any).date as string;
const FARE = { trainNumber: '12497', travelClass: '3A', date: DATE, perPassenger: 650, total: 650, passengersCount: 1, currency: 'INR' };
const ok = (data: any = FARE) => ({ toolCall: { name: 'GET_FARE', callId: 'f1' }, result: { toolName: 'GET_FARE', success: true, data }, status: 'ok', execution: { status: 'SUCCEEDED' } });
const bad = (status: 'malformed' | 'failed' | 'timeout') => ({ toolCall: { name: 'GET_FARE', callId: 'f2' },
  result: { toolName: 'GET_FARE', success: false, ...(status === 'malformed' ? { data: { weird: true } } : {}), error: { code: status === 'timeout' ? 'TOOL_TIMEOUT' : status === 'malformed' ? 'PROVIDER_DATA_INVALID' : 'PROVIDER_UNAVAILABLE' } },
  status: status === 'timeout' ? 'timeout' : 'error', execution: { status: status === 'timeout' ? 'TIMEOUT' : 'FAILED' } });
const session = (over: any = {}) => ({
  sessionId: 's1', origin: 'ASR', destination: 'NDLS', date: DATE,
  // search results carry fixture class fares — they must NEVER authorize a ₹ amount
  searchResults: { trains: [{ trainNumber: '12014', classes: [{ code: 'CC', fare: 520 }] }, { trainNumber: '12497', classes: [{ code: '3A', fare: 650 }] }] },
  ...over
});
const views = (steps: any[]) => steps.map(st => ({ toolName: st.result.toolName, ok: st.status === 'ok' || st.result.success === true, data: st.result.data, callId: st.toolCall.callId }));
const judge = (t: string, s: any, steps: any[] = []) => judgeFareAuthority(t, buildFactIndex(s, views(steps) as any));

describe('P34 follow-up G2 — judgeFareAuthority (one rule)', () => {
  it('[1] ₹ amount with NO GET_FARE → UNVERIFIED_FARE (search-result fixture fares are not authority); no amount → no claim', () => {
    expect(judge('12497 mein 3A ka fare ₹650 hai.', session())).toBe('UNVERIFIED_FARE:650');
    expect(judge('Fare Rs. 520 hoga.', session())).toBe('UNVERIFIED_FARE:520');
    expect(judge('12497 Shan-e-Punjab 06:35 par nikalti hai.', session())).toBeNull();
  });

  it('[2] malformed / failed / timed-out GET_FARE never authorizes the amount', () => {
    for (const k of ['malformed', 'failed', 'timeout'] as const) expect(judge('12497 mein 3A ka fare ₹650 hai.', session(), [bad(k)])).toBe('UNVERIFIED_FARE:650');
  });

  it('[3] matching successful GET_FARE (this turn / committed quote / verified review) → valid; wrong amount / train / class / date → rejected', () => {
    expect(judge('12497 mein 3A ka fare ₹650 hai.', session(), [ok()])).toBeNull();
    expect(judge('Iska fare ₹650 per passenger hai.', session(), [ok()])).toBeNull();
    expect(judge('12497 mein 3A ka fare ₹650 hai.', session({ fare: { ...FARE, toolExecutionId: 'x1' } }))).toBeNull();       // earlier turn's committed quote
    expect(judge('Total fare ₹1300 hai.', session({ review: { snapshot: { trainNumber: '12497', travelClass: '3A', passengersCount: 2, fare: { status: 'VERIFIED', perPassenger: 650, total: 1300, passengersCount: 2 } } } }))).toBeNull();
    expect(judge('12497 mein 3A ka fare ₹999 hai.', session(), [ok()])).toBe('FARE_MISMATCH:999');
    expect(judge('12014 mein 3A ka fare ₹650 hai.', session(), [ok()])).toBe('FARE_MISMATCH:650');
    expect(judge('12497 mein SL ka fare ₹650 hai.', session(), [ok()])).toBe('FARE_MISMATCH:650');
    expect(judge('12497 3A ka fare parso ₹650 hai.', session(), [ok()])).toMatch(/^CROSS_DATE_FACT/);                    // a fare for another date never applies
    expect(judge('Fare ₹1300 hai.', session({ review: { snapshot: { fare: { status: 'PENDING', total: 1300 } } } }))).toBe('UNVERIFIED_FARE:1300');   // unverified review ≠ authority
  });
});

describe('P34 follow-up G2 — boundary guard (factGuard) for LLM text that becomes the reply', () => {
  it('[4] no GET_FARE: the fare sentence is removed, the rest is kept; identical for TEXT and VOICE', () => {
    const msg = '12497 mein 3A ka fare ₹650 hai. 12497 Shan-e-Punjab 06:35 par nikalti hai.';
    const t = factGuard(msg, [], 'TEXT', session() as any);
    const v = factGuard(msg, [], 'VOICE', session() as any);
    expect(t).toBe('12497 Shan-e-Punjab 06:35 par nikalti hai.');
    expect(v).toBe(t);
    const rej: string[] = [];
    expect(factGuard('12497 mein 3A ka fare ₹650 hai.', [], 'VOICE', session() as any, r => rej.push(...r.map(x => x.reason)))).toBe('');   // nothing left → caller's honest fallback
    expect(rej).toEqual(['UNVERIFIED_FARE:650']);
  });

  it('[5] malformed GET_FARE: the amount is removed (TEXT and VOICE alike) — the step is not authority', () => {
    for (const mode of ['TEXT', 'VOICE'] as const) {
      expect(factGuard('12497 mein 3A ka fare ₹650 hai.', [bad('malformed')] as any, mode, session() as any)).not.toMatch(/650/);
      expect(factGuard('12497 mein 3A ka fare ₹650 hai.', [bad('timeout')] as any, mode, session() as any)).not.toMatch(/650/);
    }
  });

  it('[6] correct GET_FARE: the real fare survives unchanged (TEXT and VOICE); a mismatching amount is replaced by the tool fact', () => {
    for (const mode of ['TEXT', 'VOICE'] as const) {
      expect(factGuard('12497 mein 3A ka fare ₹650 hai.', [ok()] as any, mode, session() as any)).toBe('12497 mein 3A ka fare ₹650 hai.');
      const wrong = factGuard('12497 mein 3A ka fare ₹999 hai.', [ok()] as any, mode, session() as any);
      expect(wrong).not.toMatch(/999/);
      expect(wrong).toMatch(/650/);                                                     // deterministic GET_FARE fact
    }
  });

  it('[7] guardFareClaims is mode-free and keeps every non-fare sentence verbatim', () => {
    const g = guardFareClaims('Haan, 12497 achhi train hai. Fare ₹650 hai. Kaunsi class chahiye?', session(), []);
    expect(g.kept).toEqual(['Haan, 12497 achhi train hai.', 'Kaunsi class chahiye?']);
    expect(g.rejected.map(r => r.reason)).toEqual(['UNVERIFIED_FARE:650']);
    expect(guardFareClaims('Fare ₹650 hai.', session(), [ok()]).rejected).toEqual([]);
  });
});
