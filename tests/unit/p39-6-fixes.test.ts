// @vitest-environment happy-dom
/**
 * v0.39.6 — three user-reported issues:
 *   1. IRCTC's journey button is labelled "Search Trains" (IRCTC labels_en.json lang.search) — the extension only
 *      matched an exact "Search", so it was never auto-tapped on the real site.
 *   2. "Confirm & continue to IRCTC" was asked twice: the review fingerprint carries the availability / fare
 *      "retrievedAt" check times, so the refresh at confirmation always looked like a change (see the integration test
 *      p39-6-confirm-once for the full flow; here the pure comparison).
 *   3. Passenger details are collected step by step — bookingPreparation.nextToAsk = the next single detail
 *      (name → age → berth → gender → meal, passenger 1 before passenger 2) — and no duplicate passengers.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { MOCK_IRCTC_SCENARIOS, renderMockIrctc } from '../../server/irctc/mock/mock-irctc';
import { MOCK_IRCTC_REAL_SCENARIOS, MOCK_IRCTC_REAL_SCRIPT } from '../../server/irctc/mock/mock-irctc-real';
import { bookingPreparationView } from '../../server/ai/context/context-builder';
import { sameExceptCheckTimes } from '../../server/booking/booking-preparation-service';
import { passengerChangeValidator } from '../../server/booking/preparation/passenger-change-validator';
import { validateForm } from '../../server/booking/passenger-form';
import { NATIVE_AGENT_SYSTEM_PROMPT } from '../../server/ai/prompts/system-prompt';

const require = createRequire(import.meta.url);
const Core = require('../../extension/irctc-core.js');

const snap = (over: any = {}) => ({
  handoffId: 'irh_test', status: 'READY', language: 'en', mockData: true,
  journey: { from: { code: 'ASR', display: 'AMRITSAR JN - ASR', query: 'ASR' }, to: { code: 'NDLS', display: 'NEW DELHI - NDLS', query: 'NDLS' }, dateIso: '2026-10-08', dateIrctc: '08/10/2026' },
  train: { number: '12904', name: 'Mock Superfast' }, travelClass: { code: 'SL', label: 'Sleeper (SL)' }, quota: { code: 'GN', label: 'GENERAL' },
  passengers: [{ index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Lower', food: null }], ...over
});
const MOCK_SCRIPT = (renderMockIrctc(null).match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
let installed = false;
function load(id: string) {
  const sc = [...MOCK_IRCTC_SCENARIOS, ...MOCK_IRCTC_REAL_SCENARIOS].find(x => x.id === id)!;
  document.body.innerHTML = sc.html;
  if (!installed) { new Function('document', MOCK_SCRIPT)(document); new Function('document', MOCK_IRCTC_REAL_SCRIPT)(document); installed = true; }
  const clicks: string[] = [];
  document.querySelectorAll('[data-final]').forEach(el => {
    el.removeAttribute('onclick');
    el.addEventListener('click', e => { e.preventDefault(); clicks.push((el as HTMLElement).dataset.final!); });
  });
  document.querySelectorAll('form').forEach(f => f.addEventListener('submit', e => e.preventDefault()));
  return clicks;
}
const searchBtn = () => document.querySelector('[data-final="search"]') as HTMLElement;

describe('v0.39.6 [1] — IRCTC "Search Trains" is auto-tapped after From / To / Date / Class are verified', () => {
  it('[1] button text "Search Trains" (IRCTC lang.search) → found and tapped exactly once', async () => {
    const clicks = load('real-search');
    searchBtn().textContent = ' Search Trains ';
    expect(Core.findFinalControl(document, 'HOME_SEARCH')).toBe(searchBtn());
    const st = Core.newState();
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), st, {});
    expect(rep.errors).toEqual([]);
    const adv = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), rep, st, {});
    expect(adv.clicked).toEqual(['search']); expect(clicks).toEqual(['search']);
    const again = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), rep, st, {});
    expect(again.clicked).toEqual([]); expect(clicks).toEqual(['search']);
  }, 20000);

  it('[2] Hindi IRCTC "ट्रेन खोजें" and the journey-form search_btn class are found; "Modify Search" is not the search button', () => {
    load('real-search');
    searchBtn().textContent = 'ट्रेन खोजें';
    expect(Core.findFinalControl(document, 'HOME_SEARCH')).toBe(searchBtn());
    searchBtn().textContent = 'Modify Search';
    expect(Core.findFinalControl(document, 'HOME_SEARCH')).toBeNull();
  });

  it('[3] a quota error alone does not block Search while IRCTC still shows the snapshot quota (GENERAL); another quota → blocked', async () => {
    const clicks = load('real-search');
    searchBtn().textContent = 'Search Trains';
    const st = Core.newState();
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), st, {});
    const withQuotaErr = { ...rep, errors: [{ code: 'QUOTA_AUTOFILL_FAILED', field: 'quota', reason: 'NOT_FOUND' }] };
    const quotaHost: any = document.querySelector('#journeyQuota');
    const lab = quotaHost && quotaHost.querySelector('.p-dropdown-label, [class*="label"]');
    expect(lab && lab.textContent.trim().toUpperCase()).toBe('GENERAL');
    const st2 = Core.newState();
    lab.textContent = 'TATKAL';
    const blocked = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), withQuotaErr, st2, {});
    expect(blocked.clicked).toEqual([]); expect(blocked.stopped).toBe('JOURNEY_NOT_VERIFIED'); expect(clicks).toEqual([]);
    lab.textContent = 'GENERAL';
    const ok = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), withQuotaErr, Core.newState(), {});
    expect(ok.clicked).toEqual(['search']); expect(clicks).toEqual(['search']);
  }, 20000);

  it('[4] a From / To / Date / Class error still blocks Search', async () => {
    const clicks = load('real-search');
    searchBtn().textContent = 'Search Trains';
    for (const field of ['from', 'to', 'date', 'travelClass']) {
      const adv = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), { filled: [], errors: [{ code: 'X', field }], overrides: [], skipped: [] }, Core.newState(), {});
      expect([field, adv.stopped]).toEqual([field, 'JOURNEY_NOT_VERIFIED']);
    }
    expect(clicks).toEqual([]);
  });
});

describe('v0.39.6 [2] — check times alone are not a review change', () => {
  const fp = (availAt: string, fareAt: string, status = 'AVAILABLE-0042', total = 980) =>
    JSON.stringify(['ASR', 'NDLS', '2026-10-08', '12497', 'CC', 2, [['rahul sharma', 31, 'MALE']], [status, availAt], [total, 2, fareAt]]);
  it('[5] same values, newer retrievedAt → equal; changed fare / availability / passengers → not equal; garbage → not equal', () => {
    expect(sameExceptCheckTimes(fp('2026-10-06T09:00:00Z', '2026-10-06T09:00:00Z'), fp('2026-10-06T09:05:00Z', '2026-10-06T09:12:00Z'))).toBe(true);
    expect(sameExceptCheckTimes(fp('a', 'b'), fp('a', 'b', 'AVAILABLE-0042', 1180))).toBe(false);
    expect(sameExceptCheckTimes(fp('a', 'b'), fp('a', 'b', 'WL3'))).toBe(false);
    const other = JSON.parse(fp('a', 'b')); other[6] = [['neha sharma', 28, 'FEMALE']];
    expect(sameExceptCheckTimes(fp('a', 'b'), JSON.stringify(other))).toBe(false);
    expect(sameExceptCheckTimes('x', 'x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
const session = (over: any = {}): any => ({
  sessionId: 's', bookingState: 'COLLECTING_PASSENGER_DETAILS', origin: 'ASR', destination: 'NDLS', date: '2026-10-08',
  selectedTrain: { number: '12014', name: 'Shatabdi' }, selectedClass: '3A', passengersCount: 2, passengers: [], ...over
});
const P = (id: string, x: any = {}) => ({ id, ...x });

describe('v0.39.6 [3] — step-by-step passenger details (nextToAsk) + no duplicates', () => {
  it('[6] order per passenger: name → age → berth → gender → meal (meal only when catering OFFERED); passenger 1 before 2', () => {
    const food = { lastTrainInfo: { trainNumber: '12014', facilities: { catering: true } } };
    const steps: Array<[any, any]> = [
      [[P('p1'), P('p2')], { passenger: 1, field: 'name' }],
      [[P('p1', { name: 'Rahul Sharma' }), P('p2')], { passenger: 1, field: 'age' }],
      [[P('p1', { name: 'Rahul Sharma', age: 31 }), P('p2')], { passenger: 1, field: 'berthPreference' }],
      [[P('p1', { name: 'Rahul Sharma', age: 31, berthPreference: 'LOWER' }), P('p2')], { passenger: 1, field: 'gender' }],
      [[P('p1', { name: 'Rahul Sharma', age: 31, berthPreference: 'LOWER', gender: 'MALE' }), P('p2')], { passenger: 1, field: 'foodPreference' }],
      [[P('p1', { name: 'Rahul Sharma', age: 31, berthPreference: 'LOWER', gender: 'MALE', foodPreference: 'VEG' }), P('p2', { name: 'Neha Sharma' })], { passenger: 2, field: 'age' }],
    ];
    for (const [passengers, next] of steps) expect((bookingPreparationView(session({ ...food, passengers })) as any).nextToAsk).toEqual(next);
    // no catering info / not offered → no meal step; berth "No preference" counts as answered
    const done1 = P('p1', { name: 'Rahul Sharma', age: 31, berthPreference: 'NO_PREFERENCE', gender: 'MALE' });
    expect((bookingPreparationView(session({ passengers: [done1, P('p2')] })) as any).nextToAsk).toEqual({ passenger: 2, field: 'name' });
    expect((bookingPreparationView(session({ lastTrainInfo: { trainNumber: '12014', facilities: { catering: false } }, passengers: [done1, P('p2')] })) as any).nextToAsk).toEqual({ passenger: 2, field: 'name' });
    // a class without berth choice (EA) → no berth step
    expect((bookingPreparationView(session({ selectedClass: 'EA', passengers: [P('p1', { name: 'A B', age: 30 })] , passengersCount: 1})) as any).nextToAsk).toEqual({ passenger: 1, field: 'gender' });
    // everything answered → no nextToAsk; existing keys unchanged
    const all = session({ passengersCount: 1, passengers: [done1] });
    const v: any = bookingPreparationView(all);
    expect(v.nextToAsk).toBeUndefined();
    expect(v.missing).toEqual([]);
  });

  it('[7] the prompt asks ONE detail at a time from nextToAsk, passenger 1 first, into that passenger\'s slot, no duplicates', () => {
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toContain('bookingPreparation.nextToAsk');
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/ONE detail per reply/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/Finish passenger 1 completely before\s+passenger 2/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/Never\s+create a duplicate passenger/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).not.toContain('in ONE friendly question');
  });

  it('[8] chat proposal that would duplicate another passenger (name + age + gender) is rejected without echoing values', () => {
    const s = session({ passengers: [P('p1', { name: 'Rahul Sharma', age: 31, gender: 'MALE' }), P('p2', { name: 'rahul  sharma', age: 31 })] });
    const r: any = passengerChangeValidator.validate(s, { passengerIndex: 2, changes: { gender: 'MALE' } });
    expect(r.ok).toBe(false); expect(r.code).toBe('INVALID_PASSENGER_VALUE'); expect(r.message).toContain('Passenger 1');
    expect(r.message).not.toMatch(/rahul/i);
    // a different age / gender / partial record is fine
    expect(passengerChangeValidator.validate(s, { passengerIndex: 2, changes: { gender: 'FEMALE' } }).ok).toBe(true);
    expect(passengerChangeValidator.validate(session({ passengers: [P('p1', { name: 'Rahul Sharma', age: 31, gender: 'MALE' }), P('p2')] }), { passengerIndex: 2, changes: { name: 'Rahul Sharma' } }).ok).toBe(true);
    // updating passenger 1 itself is not a duplicate of itself
    expect(passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { age: 31 } }).ok).toBe(true);
  });

  it('[9] passenger form: duplicate rows → field error on the later row; distinct rows OK', () => {
    const s = session({ selectedClass: '3A' });
    const dup: any = validateForm({ passengers: [{ name: 'Rahul Sharma', age: 31, gender: 'MALE' }, { name: 'RAHUL SHARMA', age: 31, gender: 'MALE' }] }, s, null);
    expect(dup.ok).toBe(false);
    expect(dup.error.fieldErrors).toEqual([expect.objectContaining({ passengerIndex: 2, field: 'name' })]);
    expect(validateForm({ passengers: [{ name: 'Rahul Sharma', age: 31, gender: 'MALE' }, { name: 'Neha Sharma', age: 28, gender: 'FEMALE' }] }, s, null).ok).toBe(true);
  });
});
