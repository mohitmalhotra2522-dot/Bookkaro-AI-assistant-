/**
 * P42-13 Part 2 — inline train alternatives: the READ-ONLY backend builder.
 * Candidates = the current SEARCH_TRAINS rows in search order (no ranking), deduped by train number, main train
 * excluded; per-class labels = the existing availability authority (CHECK > preserved CHECK > search row), null when
 * there is no evidence; bound to searchResultsVersion + journey; no provider call, no session mutation. Test data only.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildTrainAlternatives, rowHasShortage } from '../../server/railway/alternatives/train-alternatives';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';

const DATE = '2026-10-09';
type Row = [string, Array<[string, string | null]>, any?];
const row = ([n, classes, extra]: Row) => ({ trainNumber: n, trainName: `Train ${n}`, origin: 'LDH', destination: 'NDLS', departure: '06:00', arrival: '10:00', duration: '4h 0m',
  provider: 'railcore', classes: classes.map(([code, availability]) => ({ code, availability, availabilityStatus: cat(availability), fare: 999 })), ...(extra || {}) });
/** the normalised category a provider adapter puts next to the raw status (test data) */
const cat = (a: string | null) => !a ? 'UNKNOWN' : /^AVAILABLE/.test(a) ? 'AVAILABLE' : /^RAC/.test(a) ? 'RAC' : /WL/.test(a) ? 'WAITLIST' : 'NOT_AVAILABLE';
function session(rows: Row[], over: any = {}) {
  const state = new ConversationStateManager();
  const s: any = state.createSession();
  Object.assign(s, { origin: 'LDH', destination: 'NDLS', date: DATE, passengersCount: 2, searchResultsVersion: 3, journeyVersion: 2,
    searchResults: { version: 3, resultId: 'rs-1', date: DATE, origin: 'LDH', destination: 'NDLS', journey: { origin: 'LDH', destination: 'NDLS', date: DATE }, trains: rows.map(row) }, ...over });
  return { state, s };
}
const ROWS: Row[] = [
  ['12498', [['CC', 'WL 12'], ['EC', 'WL 3']]],
  ['22478', [['CC', 'AVAILABLE-0418'], ['EC', 'AVAILABLE-0020']]],
  ['12014', [['CC', 'RAC 4'], ['EC', 'REGRET']]],
  ['12030', [['CC', null], ['2S', 'GNWL 7']]],
  ['22478', [['CC', 'AVAILABLE-0001']]],            // duplicate row — first occurrence wins
  ['15708', [['SL', 'AVAILABLE-0200']]]
];
const build = (s: any, train = '12498', v = 3) => buildTrainAlternatives(s, { trainNumber: train, searchResultsVersion: v });

describe('P42-13 Part 2 — train alternatives builder', () => {
  it('[16] other trains of the SAME result set, in search order (no ranking), main train excluded, deduped (first wins)', () => {
    const r = build(session(ROWS).s);
    expect(r).toMatchObject({ ok: true, code: 'OK', trainNumber: '12498', total: 4, searchResultsVersion: 3, journeyVersion: 2 });
    expect(r.alternatives.map(a => a.trainNumber)).toEqual(['22478', '12014', '12030', '15708']);
    expect(r.alternatives.map(a => a.searchPosition)).toEqual([2, 3, 4, 6]);
    expect(r.alternatives[0].classes.find(c => c.code === 'CC')).toMatchObject({ status: 'AVAILABLE 418', source: 'SEARCH_RESULT' });
    expect(r.alternatives[0].classes.map(c => c.code)).toEqual(['CC', 'EC']);   // the duplicate row's classes / status never leak in
  });
  it('[17] labels come from the authority unmodified; no evidence (null / unknown) → status null; RAC / REGRET kept as-is; no fares', () => {
    const r = build(session(ROWS).s);
    const t = (n: string) => r.alternatives.find(a => a.trainNumber === n)!;
    expect(t('12014').classes).toEqual([{ code: 'CC', status: 'RAC 4', available: false, source: 'SEARCH_RESULT' }, { code: 'EC', status: 'REGRET', available: false, source: 'SEARCH_RESULT' }]);
    expect(t('12030').classes[0]).toEqual({ code: 'CC', status: null, available: null, source: null });
    expect(t('12030').classes[1]).toMatchObject({ code: '2S', status: 'WL 7' });
    expect(JSON.stringify(r)).not.toMatch(/999|fare|best|recommend|faster|score|rank/i);
    // the authority's own rule, unmodified: a raw status whose category disagrees proves nothing → no label
    const { s } = session(ROWS); s.searchResults.trains[1].classes[0].availabilityStatus = 'WAITLIST';
    expect(build(s).alternatives[0].classes[0]).toEqual({ code: 'CC', status: null, available: null, source: null });
  });
  it('[18] a CHECK outranks the search row; a preserved CHECK (P42-12) outranks the row; evidence of another date is ignored', () => {
    const { s } = session(ROWS);
    s.selectedTrain = { number: '22478', name: 'Train 22478', classes: [] };
    s.availability = { CC: { trainNumber: '22478', travelClass: 'CC', date: DATE, status: 'AVAILABLE 405', available: true, toolExecutionId: 'x1' } };
    s.infoAvailability = { k: { trainNumber: '15708', travelClass: 'SL', date: DATE, origin: 'LDH', destination: 'NDLS', status: 'WL 2', available: false, searchResultsVersion: 3, searchResultId: 'rs-1', toolExecutionId: 'x2' } };
    const r = build(s);
    expect(r.alternatives.find(a => a.trainNumber === '22478')!.classes[0]).toMatchObject({ status: 'AVAILABLE 405', source: 'CHECK' });
    expect(r.alternatives.find(a => a.trainNumber === '15708')!.classes[0]).toEqual({ code: 'SL', status: 'WL 2', available: false, source: 'PRESERVED_CHECK' });
    // a preserved CHECK bound to another result set (P42-12 binding) never labels this list → the row's own status
    s.infoAvailability.k.searchResultId = 'rs-OLD';
    expect(build(s).alternatives.find(a => a.trainNumber === '15708')!.classes[0]).toMatchObject({ status: 'AVAILABLE 200', source: 'SEARCH_RESULT' });
    s.availability = { CC: { trainNumber: '22478', travelClass: 'CC', date: '2026-10-20', status: 'AVAILABLE 1', available: true } };
    expect(build(s).alternatives.find(a => a.trainNumber === '22478')!.classes[0]).toMatchObject({ status: 'AVAILABLE 418', source: 'SEARCH_RESULT' });
  });
  it('[19] only under a qualifying card: no meaningful shortage on the main train → NOT_NEEDED with nothing; requested class decides when listed', () => {
    const { s } = session(ROWS);
    expect(build(s, '22478')).toMatchObject({ ok: true, code: 'NOT_NEEDED', total: 0, alternatives: [] });
    expect(build(s, '12014')).toMatchObject({ code: 'OK' });                          // EC REGRET is a shortage
    expect(rowHasShortage(row(['1', [['CC', 'RAC 2'], ['EC', 'AVAILABLE-0009']]]), 2)).toBe(false);
    expect(rowHasShortage(row(['1', [['CC', 'AVAILABLE-0001']]]), 2)).toBe(true);    // too few seats for the party
    expect(rowHasShortage(row(['1', [['CC', 'WL 3'], ['EC', 'AVAILABLE-0009']]]), 2, 'EC')).toBe(false);
    expect(rowHasShortage(row(['1', [['CC', 'TRAIN CANCELLED']]]), 2)).toBe(false);
  });
  it('[20] stale protection: another searchResultsVersion, or a result set of another date / route → RESULTS_STALE', () => {
    expect(build(session(ROWS).s, '12498', 2)).toMatchObject({ ok: false, code: 'RESULTS_STALE', alternatives: [] });
    expect(build(session(ROWS, { date: '2026-10-10' }).s)).toMatchObject({ ok: false, code: 'RESULTS_STALE' });
    expect(build(session(ROWS, { destination: 'UMB' }).s)).toMatchObject({ ok: false, code: 'RESULTS_STALE' });
  });
  it('[21] a real date change through the state manager bumps the version → the old request is stale', () => {
    const { state, s } = session(ROWS);
    expect(build(s).code).toBe('OK');
    state.invalidate(s.sessionId, 'DATE');
    const now = state.getSession(s.sessionId) as any;
    expect(now.searchResultsVersion).not.toBe(3);
    const late = build(now, '12498', 3);   // the date change also clears the result set → nothing either way
    expect(['RESULTS_STALE', 'NO_RESULTS']).toContain(late.code);
    expect(late).toMatchObject({ ok: false, total: 0, alternatives: [] });
  });
  it('[22] fail closed: unknown train / no results / malformed request / unverified web rows → nothing', () => {
    expect(build(session(ROWS).s, '99999')).toMatchObject({ ok: false, code: 'TRAIN_NOT_FOUND', alternatives: [] });
    expect(build(session([]).s)).toMatchObject({ ok: false, code: 'NO_RESULTS' });
    expect(buildTrainAlternatives(session(ROWS).s, { trainNumber: '12a98', searchResultsVersion: 3 })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(buildTrainAlternatives(session(ROWS).s, { trainNumber: '12498', searchResultsVersion: 'x' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    const web = session(ROWS.map(([n, c]) => [n, c, { provider: 'erail' }] as Row)).s;
    expect(build(web)).toMatchObject({ ok: false, code: 'NOT_APPLICABLE', alternatives: [] });
    expect(buildTrainAlternatives(null, { trainNumber: '12498', searchResultsVersion: 3 }).ok).toBe(false);
  });
  it('[23] a train the provider lists as cancelled (every class TRAIN CANCELLED) is not offered; 0 alternatives → total 0', () => {
    const r = build(session([['12498', [['CC', 'WL 1']]], ['12030', [['CC', 'TRAIN CANCELLED'], ['2S', 'TRAIN CANCELLED']]]]).s);
    expect(r).toMatchObject({ ok: true, code: 'OK', total: 0, alternatives: [] });
  });
  it('[24] read-only: the session is byte-identical afterwards and no provider / tool is called', () => {
    const proto = RailwayToolService.prototype as any;
    const spies = Object.getOwnPropertyNames(proto).filter(k => k !== 'constructor' && typeof Object.getOwnPropertyDescriptor(proto, k)?.value === 'function')
      .map(k => vi.spyOn(RailwayToolService.prototype as any, k));
    const { s } = session(ROWS);
    s.availability = { CC: { trainNumber: '22478', travelClass: 'CC', date: DATE, status: 'AVAILABLE 405', available: true } };
    const before = JSON.stringify(s);
    build(s); build(s, '12014'); build(s, '12498', 1);
    expect(JSON.stringify(s)).toBe(before);
    for (const sp of spies) expect(sp).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('[25] deterministic: same input → same output (order + evidenceKey); a CHECK that changes a label changes evidenceKey', () => {
    const { s } = session(ROWS);
    const a = build(s), b = build(s);
    expect(a).toEqual(b);
    expect(a.evidenceKey).toMatch(/^[0-9a-f]{8}$/);
    s.selectedTrain = { number: '15708', classes: [] };
    s.availability = { SL: { trainNumber: '15708', travelClass: 'SL', date: DATE, status: 'WL 9', available: false } };
    expect(build(s).evidenceKey).not.toBe(a.evidenceKey);
    expect(build(s).alternatives.map(x => x.trainNumber)).toEqual(a.alternatives.map(x => x.trainNumber));
  });
});
