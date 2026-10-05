// @vitest-environment happy-dom
/**
 * P39 — G4 (DOM): BookKaro IRCTC Assist core (extension/irctc-core.js) against the 20 MockIRCTC scenarios.
 * Proves: page detection, journey / passenger prefill from the snapshot, read-back verification, user overrides win,
 * forbidden fields (login / password / CAPTCHA / OTP / card / UPI / mobile / payment mode) are never touched, and the
 * final Book Now / Continue / Submit / Pay control is NEVER clicked (only highlighted). Reports carry keys only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { MOCK_IRCTC_SCENARIOS, renderMockIrctc } from '../../server/irctc/mock/mock-irctc';
import { parseEvent } from '../../server/irctc/handoff/irctc-handoff-manager';

const require = createRequire(import.meta.url);
const Core = require('../../extension/irctc-core.js');

const MOCK_SCRIPT = (renderMockIrctc(null).match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
let installed = false;
function load(id: string) {
  const sc = MOCK_IRCTC_SCENARIOS.find(s => s.id === id)!;
  document.body.innerHTML = sc.html;
  delete (document.body as any).dataset.finalClicked;
  if (!installed) { new Function('document', MOCK_SCRIPT)(document); installed = true; }   // mock suggestion / dropdown / add-row behaviour
  const clicks: string[] = [];
  document.querySelectorAll('[data-final]').forEach(el => el.addEventListener('click', () => clicks.push((el as HTMLElement).dataset.final!)));
  return clicks;
}
const snap = (over: any = {}) => ({
  handoffId: 'irh_test', status: 'READY', language: 'en', mockData: true,
  journey: { from: { code: 'ASR', display: 'AMRITSAR JN - ASR', query: 'ASR' }, to: { code: 'NDLS', display: 'NEW DELHI - NDLS', query: 'NDLS' }, dateIso: '2026-10-06', dateIrctc: '06/10/2026' },
  train: { number: '12014', name: 'Amritsar Shatabdi', departure: null, arrival: null },
  travelClass: { code: 'CC', label: 'AC Chair car (CC)' }, quota: { code: 'GN', label: 'GENERAL' },
  passengers: [{ index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: null, food: 'Veg' }],
  ...over
});
const pax = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i + 1, name: ['Rahul Sharma', 'Neha Sharma', 'Aman Verma', 'Riya Verma'][i], age: 30 + i, gender: i % 2 ? 'Female' : 'Male', berth: null, food: null }));
const noWait = { wait: async () => undefined };
const val = (sel: string, i = 0) => (document.querySelectorAll(sel)[i] as HTMLInputElement).value;

beforeEach(() => { document.body.innerHTML = ''; });

describe('P39 G4 — page detection over the 20 MockIRCTC scenarios', () => {
  it('[1] there are exactly 20 scenarios and each is detected as its documented page kind', () => {
    expect(MOCK_IRCTC_SCENARIOS).toHaveLength(20);
    const got = MOCK_IRCTC_SCENARIOS.map(s => { load(s.id); return [s.id, Core.detectPage(document)]; });
    expect(got).toEqual(MOCK_IRCTC_SCENARIOS.map(s => [s.id, s.expectPage]));
    document.body.innerHTML = '<div>Some other page</div>';
    expect(Core.detectPage(document)).toBe('UNKNOWN');
  });

  it('[2] language: selector found on the dialog / header; missing when the page has none', () => {
    load('language-select');
    expect(Core.findLanguageControl(document, 'hi')?.textContent).toBe('हिंदी');
    expect(Core.findLanguageControl(document, 'en')?.textContent).toBe('English');
    load('home-search');
    expect(Core.findLanguageControl(document, 'hi')).not.toBeNull();
    load('home-no-language-selector');
    expect(Core.findLanguageControl(document, 'hi')).toBeNull();
  });
});

describe('P39 G4 — journey prefill (From / To / Date / Class / Quota)', () => {
  it('[3] native selects: stations chosen from suggestions by code, date DD/MM/YYYY, class "(CC)", GENERAL; Search not clicked', async () => {
    load('home-search');
    const searchClicks: number[] = []; document.querySelector('button[type="submit"]')!.addEventListener('click', () => searchClicks.push(1));
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState(), noWait);
    expect(rep.filled.sort()).toEqual(['date', 'from', 'quota', 'to', 'travelClass']);
    expect(rep.skipped).toEqual([]);
    expect(val('#origin')).toBe('AMRITSAR JN - ASR');
    expect(val('#destination')).toBe('NEW DELHI - NDLS');
    expect(val('#jDate')).toBe('06/10/2026');
    expect((document.getElementById('journeyClass') as HTMLSelectElement).selectedOptions[0].textContent).toBe('AC Chair car (CC)');
    expect((document.getElementById('journeyQuota') as HTMLSelectElement).selectedOptions[0].textContent).toBe('GENERAL');
    expect(searchClicks).toHaveLength(0);
  });

  it('[4] ARIA dropdowns are operated through their visible options and read back', async () => {
    load('home-search-aria');
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap({ travelClass: { code: '3A', label: 'AC 3 Tier (3A)' } }), Core.newState(), noWait);
    expect(rep.filled).toEqual(expect.arrayContaining(['travelClass', 'quota']));
    expect(document.querySelector('#journeyClass .p-dropdown-label')!.textContent).toBe('AC 3 Tier (3A)');
  });

  it('[5] station without a "- CODE" suggestion → STATION_SUGGESTION_NOT_FOUND (never a guessed station)', async () => {
    load('station-ambiguous');
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState(), noWait);
    expect(rep.skipped).toEqual(expect.arrayContaining([{ field: 'from', reason: 'STATION_SUGGESTION_NOT_FOUND' }, { field: 'to', reason: 'STATION_SUGGESTION_NOT_FOUND' }]));
    expect(val('#origin')).not.toMatch(/XXX|DEE/);
    expect(rep.filled).toEqual(expect.arrayContaining(['date', 'travelClass', 'quota']));
  });
});

describe('P39 G4 — train list + passenger prefill', () => {
  it('[6] train list: the booked train + class are highlighted; Book Now is NEVER clicked; missing train is reported', async () => {
    const clicks = load('train-list');
    const rep = await Core.fillPage(document, 'TRAIN_LIST', snap(), Core.newState(), noWait);
    expect(rep.filled).toEqual(['train', 'travelClass']);
    expect(rep.finalControl?.textContent).toBe('Book Now');
    expect(rep.finalControl?.closest('[data-train-block]')?.textContent).toContain('(12014)');
    expect(document.querySelector('[data-bookkaro-highlight="train"]')?.textContent).toContain('12014');
    expect(clicks).toEqual([]);
    load('train-list-missing-train');
    const r2 = await Core.fillPage(document, 'TRAIN_LIST', snap(), Core.newState(), noWait);
    expect(r2.skipped).toEqual([{ field: 'train', reason: 'TRAIN_NOT_IN_LIST' }]);
  });

  it('[7] single passenger: name / age / gender / food filled and read back; Continue only highlighted; mobile + payment mode untouched', async () => {
    const clicks = load('passenger-single');
    const rep = await Core.fillPage(document, 'PASSENGER', snap(), Core.newState(), noWait);
    expect(rep.filled.sort()).toEqual(['passengerAge', 'passengerFood', 'passengerGender', 'passengerName']);
    expect(val('input[formcontrolname="passengerName"]')).toBe('Rahul Sharma');
    expect(val('input[formcontrolname="passengerAge"]')).toBe('31');
    expect((document.querySelector('select[formcontrolname="passengerGender"]') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Male');
    expect((document.querySelector('select[formcontrolname="passengerFoodChoice"]') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Veg');
    expect(rep.finalControl?.textContent).toBe('Continue');
    Core.highlight(rep.finalControl, 'final');
    expect(rep.finalControl.getAttribute('data-bookkaro-highlight')).toBe('final');
    expect(clicks).toEqual([]);
    expect(val('#mobileNumber')).toBe('+91 98XXXXXX10');
    expect(Array.from(document.querySelectorAll('input[type="radio"]')).some((r: any) => r.checked)).toBe(false);
  });

  it('[8] four passengers fill four rows; with fewer rows "+ Add Passenger" is used only when allowed', async () => {
    load('passenger-multi');
    const r4 = await Core.fillPage(document, 'PASSENGER', snap({ passengers: pax(4) }), Core.newState(), noWait);
    expect(r4.skipped).toEqual([]);
    expect(Array.from(document.querySelectorAll('input[formcontrolname="passengerName"]')).map((i: any) => i.value)).toEqual(['Rahul Sharma', 'Neha Sharma', 'Aman Verma', 'Riya Verma']);
    load('passenger-add-rows');
    const rNo = await Core.fillPage(document, 'PASSENGER', snap({ passengers: pax(3) }), Core.newState(), noWait);
    expect(rNo.skipped).toEqual(expect.arrayContaining([{ field: 'passengerName', reason: 'ROW_MISSING' }]));
    load('passenger-add-rows');
    const rAdd = await Core.fillPage(document, 'PASSENGER', snap({ passengers: pax(3) }), Core.newState(), { ...noWait, allowAddRows: true });
    expect(rAdd.skipped).toEqual([]);
    expect(document.querySelectorAll('input[formcontrolname="passengerName"]')).toHaveLength(3);
  });

  it('[9] options the page does not offer are reported, never forced: no Food Choice; Window Side vs Lower', async () => {
    load('passenger-no-food');
    const r1 = await Core.fillPage(document, 'PASSENGER', snap(), Core.newState(), noWait);
    expect(r1.skipped).toEqual([{ field: 'passengerFood', reason: 'FIELD_NOT_PRESENT' }]);
    load('passenger-window-berth');
    const r2 = await Core.fillPage(document, 'PASSENGER', snap({ passengers: [{ index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Window Side', food: null }] }), Core.newState(), noWait);
    expect(r2.filled).toContain('passengerBerth');
    load('passenger-window-berth');
    const r3 = await Core.fillPage(document, 'PASSENGER', snap({ passengers: [{ index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Lower', food: null }] }), Core.newState(), noWait);
    expect(r3.skipped).toEqual([{ field: 'passengerBerth', reason: 'OPTION_NOT_FOUND' }]);
    const r4 = await Core.fillPage(document, 'PASSENGER', snap({ passengers: [{ index: 1, name: 'Rahul Sharma', age: 31, gender: null, berth: null, food: null }] }), Core.newState(), noWait);
    expect(r4.skipped).toEqual(expect.arrayContaining([{ field: 'passengerGender', reason: 'NOT_REPRESENTABLE' }]));
  });

  it('[10] user overrides win: a pre-typed value and a later user edit are never overwritten', async () => {
    load('passenger-user-edited');
    const st = Core.newState();
    const r1 = await Core.fillPage(document, 'PASSENGER', snap(), st, noWait);
    expect(r1.overrides).toEqual(['passengerName']);
    expect(val('input[formcontrolname="passengerName"]')).toBe('USER TYPED');
    load('passenger-single');
    const st2 = Core.newState();
    await Core.fillPage(document, 'PASSENGER', snap(), st2, noWait);
    const age = document.querySelector('input[formcontrolname="passengerAge"]') as HTMLInputElement;
    age.value = '45'; st2.userEdited.add(age);                      // what the content script records for a trusted user edit
    const r2 = await Core.fillPage(document, 'PASSENGER', snap(), st2, noWait);
    expect(r2.overrides).toEqual(['passengerAge']);
    expect(age.value).toBe('45');
  });
});

describe('P39 G4 — user-only boundaries', () => {
  it('[11] login / CAPTCHA / OTP / payment pages: nothing is filled, sensitive inputs are forbidden, final controls never clicked', async () => {
    for (const id of ['login-required', 'review-captcha', 'otp', 'payment']) {
      const clicks = load(id);
      const page = Core.detectPage(document);
      const before = Array.from(document.querySelectorAll('input')).map((i: any) => i.value);
      const rep = await Core.fillPage(document, page, snap(), Core.newState(), noWait);
      expect(rep.filled, id).toEqual([]);
      expect(Array.from(document.querySelectorAll('input')).map((i: any) => i.value), id).toEqual(before);
      for (const i of Array.from(document.querySelectorAll('input'))) expect(Core.isForbidden(i), `${id} ${(i as any).placeholder}`).toBe(true);
      if (rep.finalControl) Core.highlight(rep.finalControl, 'user-action');
      expect(clicks, id).toEqual([]);
    }
  });

  it('[12] the core never calls click() on any final control across all scenarios', async () => {
    const proto = (window as any).HTMLElement.prototype;
    const orig = proto.click; const clicked: string[] = [];
    proto.click = function (this: HTMLElement) { if (this.dataset && this.dataset.final) clicked.push(this.dataset.final); return orig.call(this); };
    try {
      for (const s of MOCK_IRCTC_SCENARIOS) {
        load(s.id);
        await Core.fillPage(document, Core.detectPage(document), snap({ passengers: pax(2) }), Core.newState(), { ...noWait, allowAddRows: true });
      }
    } finally { proto.click = orig; }
    expect(clicked).toEqual([]);
  });

  it('[13] reports are metadata only (keys + reasons) and are accepted by the backend event parser', async () => {
    load('passenger-no-food');
    const rep = await Core.fillPage(document, 'PASSENGER', snap(), Core.newState(), noWait);
    const events = Core.reportEvents(rep);
    const json = JSON.stringify(events);
    expect(json).not.toMatch(/Rahul|Sharma|31|Veg/);
    for (const e of events) expect(parseEvent(e), JSON.stringify(e)).not.toBeNull();
    expect(events).toEqual(expect.arrayContaining([{ type: 'FIELD_NOT_CONFIRMED', field: 'passengerFood' }]));
    expect(parseEvent({ type: 'FIELDS_FILLED', page: 'PASSENGER', filled: ['passengerName'], value: 'Rahul' })).toBeNull();
    expect(parseEvent({ type: 'FIELDS_FILLED', page: 'PASSENGER', filled: ['password'] })).toBeNull();
  });
});

describe('P39 G4 — the passenger page must belong to the reviewed train', () => {
  it('[14] a different train on the passenger page → nothing filled, TRAIN_DIFFERENT_ON_PAGE, no final control; only an explicit user Resume allows it', async () => {
    const clicks = load('passenger-single');                       // page shows (12014)
    const state = Core.newState();
    const rep = await Core.fillPage(document, 'PASSENGER', snap({ train: { number: '12497', name: 'Shane Punjab', departure: null, arrival: null }, passengers: pax(1) }), state, noWait);
    expect(Core.pageTrainNumbers(document)).toEqual(['12014']);
    expect(rep.filled).toEqual([]);
    expect(rep.skipped).toEqual([{ field: 'train', reason: 'TRAIN_DIFFERENT_ON_PAGE' }]);
    expect(rep.trainOnPage).toBe('12014');
    expect(rep.finalControl).toBeNull();
    expect(val('input[formcontrolname="passengerName"]')).toBe('');
    expect(Core.reportEvents(rep).every((e: any) => parseEvent(e) !== null)).toBe(true);
    // the user explicitly chose to continue on this train (extension Resume)
    state.trainMismatchAccepted = true;
    const rep2 = await Core.fillPage(document, 'PASSENGER', snap({ train: { number: '12497', name: 'Shane Punjab', departure: null, arrival: null }, passengers: pax(1) }), state, noWait);
    expect(rep2.filled).toEqual(expect.arrayContaining(['passengerName', 'passengerAge']));
    expect(clicks).toEqual([]);
    // matching train (mock ?train=) fills straight away
    document.body.innerHTML = (renderMockIrctc('passenger-single', { train: '12497' }).match(/<body[^>]*>([\s\S]*)<\/body>/) || [])[1] || '';
    expect(Core.pageTrainNumbers(document)).toContain('12497');
  });
});
