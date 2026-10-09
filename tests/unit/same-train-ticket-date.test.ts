/**
 * 2026-10-09 — same-train ticket DATE: a ticket from an earlier station of the SAME run is dated for that station's
 * departure: date = journeyDate + (day(ticket origin) − day(requested origin)) from the provider timetable.
 * Reported case (LIVE RailCore schedule 12425: NDLS day 1 → LDH day 2): boarding LDH on 20 Oct = NDLS ticket of 19 Oct.
 * Querying 20 Oct for NDLS checked a different run (WL) — the RAC seat of the 19 Oct NDLS ticket was missed.
 * Route / answers below are TEST DATA shaped like that case. MOCK only.
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import { runSameTrainSearch, ticketDateFor, addDaysIso, type SameTrainDeps, type SameTrainSearchRequest, type ProviderRef, type AvailabilityQuery } from '../../server/railway/same-train/same-train-engine';
import { sameTrainLLMView } from '../../server/railway/same-train/same-train-view';
import { revalidateSameTrainAlternative, sameTrainSelectionKey } from '../../server/railway/same-train/same-train-service';
import { applySameTrainSelection } from '../../server/railway/same-train/same-train-session';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { SAME_TRAIN_DEFAULT_LIMITS, SameTrainErrorCode as E } from '../../shared/same-train-alternatives';
import { ticketDateLine } from '../../src/components/trains/SameTrainInline';

const DATE = '2026-10-20';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
type Stop = [string, string, string, number | undefined];
const STOPS: Stop[] = [['NDLS', 'New Delhi', '20:40', 1], ['LDH', 'Ludhiana Jn', '00:38', 2], ['PTKC', 'Pathankot Cantt', '03:35', 2], ['MSKT', 'Station M', '04:10', 2], ['JAT', 'Jammu Tawi', '05:10', 2]];
const routeOf = (stops: Stop[]) => stops.map(([station, stationName, departure, day]) => ({ station, stationName, departure, ...(day !== undefined ? { day } : {}) }));

/** the provider answers PER DATE: the 19 Oct NDLS ticket (same run) has RAC, the 20 Oct NDLS ticket (next run) is WL */
function mkDeps(stops: Stop[] = STOPS) {
  const calls: AvailabilityQuery[] = [];
  const deps: SameTrainDeps = {
    limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 300, totalTimeoutMs: 3000 },
    getRoute: async () => ({ ok: true, data: routeOf(stops) }),
    checkAvailability: async (_p, q) => {
      calls.push(q);
      // provider-normalized statuses (LIVE RailCore 2026-10-09: 19 Oct status RAC / rac_count 78 → "RAC 78"; 20 Oct → "WL 84")
      const status = q.origin === 'NDLS' ? (q.date === '2026-10-19' ? 'RAC 78' : 'WL 84') : 'WL 5';
      return { ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status, providerUpdatedAt: new Date().toISOString() } };
    }
  };
  return { deps, calls };
}
const REQ = (over: Partial<SameTrainSearchRequest> = {}): SameTrainSearchRequest => ({
  sessionId: 's-td', turnId: 't1', requestId: 'r1', journeyVersion: 1,
  trainNumber: '12425', date: DATE, travelClass: '3A', passengersCount: 1, origin: 'LDH', destination: 'JAT',
  originSweep: true, destinationSweep: true, combinedPairs: 'NEVER', includeFare: false, webEvidence: false,
  providers: [RC], routeProvider: RC, webProviders: [], ...over
} as any);

describe('ticket date of a pair (timetable day offset)', () => {
  it('[TD1] earlier station one day before → journey date − 1; same origin → journey date; month / year boundaries', () => {
    const r = routeOf(STOPS);
    expect(ticketDateFor(r, 0, 1, DATE)).toEqual({ date: '2026-10-19', shiftDays: -1 });
    expect(ticketDateFor(r, 1, 1, DATE)).toEqual({ date: DATE, shiftDays: 0 });
    expect(ticketDateFor(r, 2, 1, DATE)).toEqual({ date: DATE, shiftDays: 0 });      // same day → no shift
    expect(addDaysIso('2026-11-01', -1)).toBe('2026-10-31');
    expect(addDaysIso('2027-01-01', -2)).toBe('2026-12-30');
    expect(addDaysIso('2028-03-01', -1)).toBe('2028-02-29');
  });
  it('[TD2] unknown day: a timetable WITH days but not for this stop → null (never guessed); a timetable with NO day at all → journey date flagged dayUnknown', () => {
    const partial = routeOf(STOPS.map((s, i) => (i === 0 ? [s[0], s[1], s[2], undefined] : s) as Stop));
    expect(ticketDateFor(partial, 0, 1, DATE)).toBeNull();
    const none = routeOf(STOPS.map(s => [s[0], s[1], s[2], undefined] as Stop));
    expect(ticketDateFor(none, 0, 1, DATE)).toEqual({ date: DATE, shiftDays: 0, dayUnknown: true });
  });
});

describe('same-train search checks every pair on its ticket date', () => {
  it('[TD3] 12425-shaped case: NDLS → JAT is queried for 19 Oct (same run) → RAC found; never queried for 20 Oct', async () => {
    const { deps, calls } = mkDeps();
    const r = await runSameTrainSearch(REQ(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nd = calls.filter(q => q.origin === 'NDLS');
    expect(nd.length).toBeGreaterThan(0);
    expect(nd.every(q => q.date === '2026-10-19')).toBe(true);
    // pairs from the requested origin keep the journey date
    expect(calls.filter(q => q.origin === 'LDH').every(q => q.date === DATE)).toBe(true);
    const a = r.result.alternatives.find(x => x.ticketOrigin === 'NDLS' && x.ticketDestination === 'JAT' && x.travelClass === '3A')!;
    expect(a).toBeTruthy();
    expect(a.availability).toBe('RAC');
    expect(a.date).toBe('2026-10-19');
    expect(a.ticketDateShiftDays).toBe(-1);
    expect(a.journeyDate).toBe(DATE);
    expect(a.ticketOriginDeparture).toBe('20:40');
    expect(r.result.date).toBe(DATE);                    // the result stays bound to the journey the user asked for
    expect(r.result.searchComplete).toBe(true);
  });
  it('[TD4] the provider identity check runs against the ticket date (an answer for the journey date is rejected for a shifted pair)', async () => {
    const { deps } = mkDeps();
    const wrong: SameTrainDeps = { ...deps, checkAvailability: async (p, q) => {
      const ok: any = await deps.checkAvailability(p, q);
      return q.origin === 'NDLS' ? { ok: true, data: { ...ok.data, date: DATE } } : ok;   // provider answers another run
    } };
    const r = await runSameTrainSearch(REQ(), wrong);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nd = r.result.alternatives.filter(x => x.ticketOrigin === 'NDLS');
    expect(nd.some(x => x.availability === 'RAC')).toBe(false);
  });
  it('[TD5] a timetable with days but none for an earlier stop → that pair is SKIPPED / TICKET_DATE_UNVERIFIED, search not complete, no verdict', async () => {
    const { deps, calls } = mkDeps(STOPS.map((s, i) => (i === 0 ? [s[0], s[1], s[2], undefined] : s) as Stop));
    const r = await runSameTrainSearch(REQ(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.some(q => q.origin === 'NDLS')).toBe(false);
    expect(r.result.searchComplete).toBe(false);
    expect(r.result.errors).toContain(E.TICKET_DATE_UNVERIFIED);
    const nd = r.result.alternatives.filter(x => x.ticketOrigin === 'NDLS');
    for (const x of nd) { expect(x.availability).toBe('UNKNOWN'); expect(x.verificationStatus).toBe('UNVERIFIED'); }
  });
  it('[TD6] a timetable without any day → journey date (previous behaviour) but every earlier option is flagged ticketDateUnverified (screen line + alternative warning)', async () => {
    const { deps, calls } = mkDeps(STOPS.map(s => [s[0], s[1], s[2], undefined] as Stop));
    const r = await runSameTrainSearch(REQ(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(calls.filter(q => q.origin === 'NDLS').every(q => q.date === DATE)).toBe(true);
    const nd = r.result.alternatives.find(x => x.ticketOrigin === 'NDLS')!;
    expect(nd.ticketDateUnverified).toBe(true);
    expect(nd.warnings).toContain(E.TICKET_DATE_UNVERIFIED);
    expect(ticketDateLine(nd)).toMatch(/Ticket date verify nahi hua/);
  });
});

describe('the ticket date travels to the screen, the LLM view, the fresh re-check and the booking session', () => {
  it('[TD7] screen line + LLM view name the ticket date for a shifted option only', async () => {
    const { deps } = mkDeps();
    const r = await runSameTrainSearch(REQ(), deps);
    if (!r.ok) throw new Error('search failed');
    const nd = r.result.alternatives.find(x => x.ticketOrigin === 'NDLS' && x.travelClass === '3A')!;
    expect(ticketDateLine(nd, r.result)).toBe('Ticket date 19 Oct — train NDLS se 20:40 isi run par chalti hai (aapki boarding 20 Oct)');
    const ld = r.result.alternatives.find(x => x.ticketOrigin === 'LDH');
    if (ld) expect(ticketDateLine(ld, r.result)).toBeNull();
    const v: any = sameTrainLLMView(r.result);
    const e: any = v.alternatives[nd.alternativeId];
    expect(e.ticketDate).toBe('2026-10-19');
    expect(v.date).toBe(DATE);                                  // journey date stays the result date
  });
  it('[TD8] fresh re-check queries the ticket date; handoff names it; apply sets the session date to the ticket date (same run)', async () => {
    const { deps, calls } = mkDeps();
    const r = await runSameTrainSearch(REQ(), deps);
    if (!r.ok) throw new Error('search failed');
    const res = r.result;
    const nd = res.alternatives.find(x => x.ticketOrigin === 'NDLS' && x.travelClass === '3A')!;
    const state = new ConversationStateManager();
    const s: any = state.createSession();
    Object.assign(s, { origin: 'LDH', destination: 'JAT', date: DATE, passengers: [], passengersCount: 1, selectedTrain: { number: '12425', name: 'Test' }, selectedClass: '3A' });
    calls.length = 0;
    const out = await revalidateSameTrainAlternative(res, res.alternativeSearchId, nd.alternativeId, sameTrainSelectionKey(s, res), { acknowledgeUnverifiedRules: true, deps: { ...deps, limits: deps.limits } as any });
    expect(out.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(q => q.origin === 'NDLS' && q.date === '2026-10-19')).toBe(true);
    expect(out.handoffText).toMatch(/2026-10-19/);
    expect(out.handoffText).toMatch(/Ticket date 2026-10-19 hai — train NDLS se isi run par chalti hai \(LDH ka date 2026-10-20\)/);
    const ap = applySameTrainSelection(state, s.sessionId, res, out as any);
    expect(ap.applied).toBe(true);
    const after: any = state.getSession(s.sessionId);
    expect(after.origin).toBe('NDLS');
    expect(after.date).toBe('2026-10-19');
    expect(ap.selection!.date).toBe('2026-10-19');
  });
  it('[TD9] an unshifted option (same calendar day) keeps the journey date everywhere — no ticket-date line, session date unchanged', async () => {
    const same = STOPS.map(s => [s[0], s[1], s[2], 1] as Stop);
    const { deps } = mkDeps(same);
    const custom: SameTrainDeps = { ...deps, checkAvailability: async (_p, q) => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: q.origin === 'NDLS' ? 'RAC 3' : 'WL 5', providerUpdatedAt: new Date().toISOString() } }) };
    const r = await runSameTrainSearch(REQ(), custom);
    if (!r.ok) throw new Error('search failed');
    const nd = r.result.alternatives.find(x => x.ticketOrigin === 'NDLS' && x.travelClass === '3A')!;
    expect(nd.date).toBe(DATE);
    expect(nd.ticketDateShiftDays).toBeUndefined();
    expect(ticketDateLine(nd, r.result)).toBeNull();
  });
});
