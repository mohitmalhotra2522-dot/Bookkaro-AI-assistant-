// @vitest-environment happy-dom
/**
 * v0.39.7 — two user-reported issues (Android Lemur Browser screenshots):
 *   1. IRCTC Search was not auto-tapped on the mobile layout, and the overlay kept showing the generic
 *      "fill kiye ja rahe hain — Search aap khud tap karein" text (every later tick overwrote the real outcome).
 *      Now: Search is gated on what the IRCTC form SHOWS (From / To / Date / Class / Quota read back from the page),
 *      the visible mobile submit button is used (IRCTC renders a hidden desktop twin), HOME_SEARCH re-verifies a few
 *      times, and the outcome / reason + extension version stay on the overlay.
 *   2. The food preference was shown for 14680 (Intercity) — RailCore's `catering` flag contradicts IRCTC. The meal
 *      choice now follows IRCTC's pre-paid catering trains (Rajdhani / Shatabdi / Duronto / Vande Bharat / Tejas /
 *      Gatimaan) on the provider's train name.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';
import { MOCK_IRCTC_SCENARIOS, renderMockIrctc } from '../../server/irctc/mock/mock-irctc';
import { MOCK_IRCTC_REAL_SCENARIOS, MOCK_IRCTC_REAL_SCRIPT } from '../../server/irctc/mock/mock-irctc-real';
import { irctcFoodChoiceOffered } from '../../shared/irctc-catering';
import { RailCoreProvider } from '../../server/railway/providers/live/railcore-provider';
import { buildFormSpec } from '../../server/booking/passenger-form';
import { IRCTC_TEXT } from '../../shared/irctc-handoff';

const require = createRequire(import.meta.url);
const Core = require('../../extension/irctc-core.js');
const ROOT = path.resolve(__dirname, '../..');

const snap = (over: any = {}) => ({
  handoffId: 'irh_test', status: 'READY', language: 'en', mockData: true,
  journey: { from: { code: 'ASR', display: 'AMRITSAR JN - ASR', query: 'ASR' }, to: { code: 'NDLS', display: 'NEW DELHI - NDLS', query: 'NDLS' }, dateIso: '2026-10-08', dateIrctc: '08/10/2026' },
  train: { number: '14680', name: 'Mock Intercity' }, travelClass: { code: 'SL', label: 'Sleeper (SL)' }, quota: { code: 'GN', label: 'GENERAL' },
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

describe('v0.39.7 [1] — IRCTC Search auto-tap on the mobile layout', () => {
  it('[1] IRCTC mobile layout: hidden desktop "Search Trains" twin is skipped, the visible one is tapped', async () => {
    const clicks = load('real-search');
    const visible = searchBtn(); visible.textContent = ' Search Trains ';
    const desktop = visible.cloneNode(true) as HTMLElement;          // IRCTC: button.hidden-xs.search_btn (display:none on phones)
    desktop.setAttribute('data-final', 'desktop-hidden'); desktop.style.display = 'none';
    desktop.addEventListener('click', () => clicks.push('desktop-hidden'));
    visible.parentElement!.insertBefore(desktop, visible);
    expect(Core.findFinalControl(document, 'HOME_SEARCH')).toBe(visible);
    const st = Core.newState();
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), st, {});
    const adv = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), rep, st, {});
    expect(adv.clicked).toEqual(['search']); expect(clicks).toEqual(['search']);
  }, 20000);

  it('[2] the page already shows the exact journey (fill round reported nothing new) → Search is still tapped, once', async () => {
    const clicks = load('real-search');
    searchBtn().textContent = 'Search Trains';
    await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState(), {});
    const st = Core.newState();
    const quietRep = { page: 'HOME_SEARCH', filled: [], skipped: [], errors: [], overrides: [] };
    expect(Core.journeyOnPage(document, snap())).toEqual({ ok: true, missing: [] });
    const adv = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), quietRep, st, {});
    expect(adv.clicked).toEqual(['search']);
    const again = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), quietRep, st, {});
    expect(again.stopped).toBe('SEARCH_ALREADY_TAPPED'); expect(clicks).toEqual(['search']);
  }, 20000);

  it('[3] the page shows another date / station / quota than the review → NOT tapped, the field is named', async () => {
    const clicks = load('real-search');
    searchBtn().textContent = 'Search Trains';
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState(), {});
    const date: any = Core.findDateInput(document);
    date.value = '09/10/2026';
    let adv = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), rep, Core.newState(), {});
    expect(adv.stopped).toBe('JOURNEY_NOT_VERIFIED'); expect(adv.missing).toEqual(['date']);
    date.value = '08/10/2026';
    const to: any = Core.findStationInput(document, 'to'); const keep = to.value; to.value = 'NEW DELHI - NDLSX';
    adv = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), rep, Core.newState(), {});
    expect(adv.missing).toEqual(['to']);
    to.value = keep;
    const lab: any = document.querySelector('#journeyQuota .p-dropdown-label, #journeyQuota [class*="label"]');
    lab.textContent = 'TATKAL';
    adv = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), rep, Core.newState(), {});
    expect(adv.missing).toEqual(['quota']);
    expect(clicks).toEqual([]);
  }, 20000);

  it('[4] a user change (override) or an unconfirmed station still blocks Search even if the page looks right', async () => {
    const clicks = load('real-search');
    searchBtn().textContent = 'Search Trains';
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState(), {});
    let adv = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), { ...rep, overrides: ['date'] }, Core.newState(), {});
    expect(adv.stopped).toBe('JOURNEY_NOT_VERIFIED');
    adv = await Core.autoAdvance(document, 'HOME_SEARCH', snap(), { ...rep, stopped: 'FROM_AUTOFILL_FAILED' }, Core.newState(), {});
    expect(adv.stopped).toBe('JOURNEY_NOT_VERIFIED');
    expect(clicks).toEqual([]);
  }, 20000);

  it('[5] overlay: a repeat tick keeps the last outcome; HOME_SEARCH retries then names the reason; version shown', () => {
    const src = fs.readFileSync(path.join(ROOT, 'extension/irctc-content.js'), 'utf8');
    const early = src.indexOf('=== lastFillKey) return;');
    const generic = src.indexOf('say(MSG[page] || snapshot.message');
    expect(early).toBeGreaterThan(0); expect(early).toBeLessThan(generic);
    expect(src).toMatch(/SEARCH_RETRIES = 6/);
    expect(src).toMatch(/BookKaro ne Search tap nahi kiya/);
    expect(src).toMatch(/chrome\.runtime\.getManifest\(\)\.version/);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'extension/manifest.json'), 'utf8')).version).toBe('0.39.7');
    expect(IRCTC_TEXT.JOURNEY_PAGE).not.toMatch(/Search aap khud tap/);
    expect(IRCTC_TEXT.JOURNEY_PAGE).toMatch(/BookKaro Search tap karega/);
  });
});

describe('v0.39.7 [2] — food preference only where real IRCTC offers it', () => {
  it('[6] IRCTC pre-paid catering trains → true; Intercity / Mail / Express / Jan Shatabdi → false; no name → unknown', () => {
    for (const n of ['Shatabdi Express', 'Swarna Shatabdi Express', 'New Delhi - Mumbai Central Rajdhani Express', 'Vande Bharat Express', 'Duronto Express', 'Tejas Express', 'Gatimaan Express', 'NDLS ASR SHTBDI'])
      expect([n, irctcFoodChoiceOffered(n)]).toEqual([n, true]);
    for (const n of ['Amritsar - New Delhi Intercity Express', 'ASR DLI EXP', 'Shan-e-Punjab Express', 'Paschim SF Express', 'Jan Shatabdi Express', 'Una Janshatabdi', 'Golden Temple Mail'])
      expect([n, irctcFoodChoiceOffered(n)]).toEqual([n, false]);
    expect(irctcFoodChoiceOffered('')).toBeNull(); expect(irctcFoodChoiceOffered(undefined)).toBeNull();
  });

  const schedule = (train_number: string, train_name: string, catering: boolean) => JSON.stringify({ success: true, data: {
    train_number, train_name, source_station_code: 'ASR', destination_station_code: 'NDLS', running_days: ['MON'], classes: ['CC', 'SL'],
    total_duration_minutes: 300, distance_km: 448, catering, pantry: false,
    stops: [{ sequence: 1, station_code: 'ASR', station_name: 'AMRITSAR JN', arrival_time: '00:00', departure_time: '05:00', day: 1 },
      { sequence: 2, station_code: 'NDLS', station_name: 'NEW DELHI', arrival_time: '10:00', departure_time: '00:00', day: 1 }] } });
  const provider = (body: string) => new RailCoreProvider({ apiKey: 'rc-TEST', baseUrl: 'https://ir.railcore.tech/v1', timeoutMs: 5000,
    fetchImpl: async () => ({ status: 200, text: async () => body }) });

  it('[7] RailCore says catering=true for 14680 Intercity → facilities.catering false (no food); Rajdhani with false → true', async () => {
    const a: any = await provider(schedule('14680', 'Amritsar - New Delhi Intercity Express', true)).getTrainInfo({ trainNumber: '14680' } as any);
    expect(a.ok).toBe(true); expect(a.data.facilities).toEqual({ catering: false, pantry: false });
    const b: any = await provider(schedule('12952', 'New Delhi - Mumbai Central Rajdhani Express', false)).getTrainInfo({ trainNumber: '12952' } as any);
    expect(b.data.facilities.catering).toBe(true);
  });

  it('[8] passenger form: no food section and an IRCTC-worded note when IRCTC offers no meal choice', () => {
    const s: any = { selectedTrain: { number: '14680', name: 'ASR DLI EXP' }, selectedClass: 'CC', passengersCount: 1, passengers: [] };
    const off = buildFormSpec(s, { catering: false, pantry: true, provider: 'railcore', dataSource: 'LIVE' } as any).food;
    expect(off).toMatchObject({ status: 'NOT_INCLUDED', options: [] });
    expect(off.note).toMatch(/IRCTC is train mein booking ke saath khane ka option nahi deta/);
    const on = buildFormSpec(s, { catering: true, pantry: null, provider: 'railcore', dataSource: 'LIVE' } as any).food;
    expect(on.status).toBe('OFFERED'); expect(on.note).not.toMatch(/provider data/);
  });
});
