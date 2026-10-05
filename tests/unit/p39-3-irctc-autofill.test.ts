// @vitest-environment happy-dom
/**
 * P39.3 — real DOM autofill against the REAL-LIKE MockIRCTC pages (PrimeNG structure, async suggestions / dropdown
 * panels / date re-validation, mobile passenger rows). Real timers — no `noWait` — so the extension has to wait for the
 * page like on www.irctc.co.in. Covers: wrong origin / destination, autocomplete, date, train, class, passengers
 * (1 / 2 / many), verification, the login / CAPTCHA / OTP / payment stops, language dialog, the content-script host stop.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MOCK_IRCTC_SCENARIOS, renderMockIrctc } from '../../server/irctc/mock/mock-irctc';
import { MOCK_IRCTC_REAL_SCENARIOS, MOCK_IRCTC_REAL_SCRIPT } from '../../server/irctc/mock/mock-irctc-real';
import { parseEvent } from '../../server/irctc/handoff/irctc-handoff-manager';
import { IRCTC_AUTOFILL_ERROR_CODES } from '../../shared/irctc-handoff';

const require = createRequire(import.meta.url);
const Core = require('../../extension/irctc-core.js');
const Guard = require('../../extension/irctc-handoff-guard.js');

const html = renderMockIrctc(null);
const MOCK_SCRIPT = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
let installed = false;
function load(id: string) {
  const sc = [...MOCK_IRCTC_SCENARIOS, ...MOCK_IRCTC_REAL_SCENARIOS].find(s => s.id === id)!;
  document.body.innerHTML = sc.html;
  document.body.removeAttribute('data-final-clicked');
  document.body.removeAttribute('data-lang');
  if (!installed) { new Function('document', MOCK_SCRIPT)(document); new Function('document', MOCK_IRCTC_REAL_SCRIPT)(document); installed = true; }
  const clicks: string[] = [];
  document.querySelectorAll('[data-final]').forEach(el => el.addEventListener('click', () => clicks.push((el as HTMLElement).dataset.final!)));
  return clicks;
}
const snap = (over: any = {}) => ({
  handoffId: 'irh_test', status: 'READY', language: 'en', mockData: true,
  journey: { from: { code: 'ASR', display: 'AMRITSAR JN - ASR', query: 'ASR' }, to: { code: 'NDLS', display: 'NEW DELHI - NDLS', query: 'NDLS' }, dateIso: '2026-10-08', dateIrctc: '08/10/2026' },
  train: { number: '12904', name: 'Mock Superfast', departure: null, arrival: null },
  travelClass: { code: 'SL', label: 'Sleeper (SL)' }, quota: { code: 'GN', label: 'GENERAL' },
  passengers: [{ index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Lower', food: null }],
  ...over
});
const P = [
  { index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Lower', food: null },
  { index: 2, name: 'Neha Sharma', age: 28, gender: 'Female', berth: 'Side Upper', food: null },
  { index: 3, name: 'Aman Verma', age: 64, gender: 'Male', berth: 'Middle', food: null }
];
const $ = (sel: string, i = 0) => document.querySelectorAll(sel)[i] as any;
const station = (id: string) => $(`p-autocomplete#${id} input`).value;
const label = (id: string) => $(`p-dropdown#${id} .ui-dropdown-label`).textContent.trim();
const nameInputs = () => Array.from(document.querySelectorAll('input[placeholder="Full Name as per Govt. ID"]')) as HTMLInputElement[];
const codes = (rep: any) => rep.errors.map((e: any) => e.code);

beforeEach(() => { document.body.innerHTML = ''; });

describe('P39.3 — journey page (PrimeNG): stations / date / class', () => {
  it('[7] autocomplete: focus → keydown → input → keyup, waits for the async list, picks ONLY the exact "- CODE" item, verifies', async () => {
    const clicks = load('real-search');
    expect(Core.detectPage(document)).toBe('HOME_SEARCH');
    const seen: string[] = [];
    ['focus', 'keydown', 'input', 'change', 'keyup', 'blur'].forEach(t => $('p-autocomplete#origin input').addEventListener(t, () => seen.push(t)));
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState());
    const at = (t: string) => seen.indexOf(t);
    expect(at('focus')).toBe(0);
    expect(at('focus') < at('keydown') && at('keydown') < at('input') && at('input') < at('change') && at('change') < at('keyup')).toBe(true);
    expect(at('blur') === -1 || at('blur') > at('keyup')).toBe(true);    // never blurred while the PrimeNG panel is open
    expect(station('origin')).toBe('AMRITSAR JN. - ASR (AMRITSAR)');
    expect(station('destination')).toBe('NEW DELHI - NDLS (NEW DELHI)');   // not "DELHI - DLI" / not the first item
    expect(rep.filled.slice().sort()).toEqual(['date', 'from', 'quota', 'to', 'travelClass']);
    expect(rep.skipped).toEqual([]);
    expect(rep.errors).toEqual([]);
    expect(rep.finalControl?.textContent).toBe('Search');                 // highlighted for the user …
    expect(clicks).toEqual([]);                                           // … never clicked
    expect(Core.reportEvents(rep).every((e: any) => parseEvent(e) !== null)).toBe(true);
    // page clears the chosen station again → not confirmed, typed error, Search not offered
    load('real-search-station-rejected');
    const r2 = await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState());
    expect(r2.skipped).toContainEqual({ field: 'from', reason: 'VALUE_NOT_CONFIRMED' });
    expect(codes(r2)).toContain('FROM_STATION_AUTOFILL_FAILED');
    expect(r2.stopped).toBe('FROM_STATION_AUTOFILL_FAILED');
    expect(r2.finalControl).toBeNull();
  }, 20000);

  it('[5] wrong origin: the suggestions never contain the requested code → nothing guessed, FROM_STATION_AUTOFILL_FAILED, stop (Search not highlighted)', async () => {
    const clicks = load('real-search-decoy-stations');
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState());
    expect(station('origin')).toBe('ASR');                                // only what was typed — no decoy item picked
    expect(station('destination')).toBe('NDLS');
    expect(rep.skipped).toEqual(expect.arrayContaining([{ field: 'from', reason: 'STATION_SUGGESTION_NOT_FOUND' }, { field: 'to', reason: 'STATION_SUGGESTION_NOT_FOUND' }]));
    expect(rep.errors).toEqual(expect.arrayContaining([
      { code: 'FROM_STATION_AUTOFILL_FAILED', field: 'from', reason: 'STATION_SUGGESTION_NOT_FOUND' },
      { code: 'TO_STATION_AUTOFILL_FAILED', field: 'to', reason: 'STATION_SUGGESTION_NOT_FOUND' }]));
    expect(rep.stopped).toBe('FROM_STATION_AUTOFILL_FAILED');
    expect(rep.finalControl).toBeNull();
    expect(clicks).toEqual([]);
  }, 20000);

  it('[6] wrong destination: unknown destination code → TO_STATION_AUTOFILL_FAILED; the verified origin stays, no other station chosen', async () => {
    load('real-search');
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap({ journey: { ...snap().journey, to: { code: 'ZZQ', display: null, query: 'ZZQ' } } }), Core.newState());
    expect(station('origin')).toBe('AMRITSAR JN. - ASR (AMRITSAR)');
    expect(station('destination')).toBe('ZZQ');
    expect(rep.filled).toContain('from');
    expect(rep.filled).not.toContain('to');
    expect(rep.errors.filter((e: any) => e.field === 'to')).toEqual([{ code: 'TO_STATION_AUTOFILL_FAILED', field: 'to', reason: 'STATION_SUGGESTION_NOT_FOUND' }]);
    expect(rep.stopped).toBe('TO_STATION_AUTOFILL_FAILED');
    expect(rep.finalControl).toBeNull();
  }, 20000);

  it('[8] date: p-calendar#jDate (formcontrolname journeyDate) gets DD/MM/YYYY, re-read after the picker re-validates; a rejected date → DATE_AUTOFILL_FAILED', async () => {
    load('real-search');
    expect(Core.findDateInput(document)).toBe($('p-calendar#jDate input'));
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState());
    expect($('p-calendar#jDate input').value).toBe('08/10/2026');
    expect(rep.filled).toContain('date');
    load('real-search-date-rejected');
    const r2 = await Core.fillPage(document, 'HOME_SEARCH', snap(), Core.newState());
    expect($('p-calendar#jDate input').value).not.toBe('08/10/2026');
    expect(r2.filled).not.toContain('date');
    expect(r2.skipped).toContainEqual({ field: 'date', reason: 'VALUE_CHANGED_BY_PAGE' });
    expect(codes(r2)).toContain('DATE_AUTOFILL_FAILED');
    expect(r2.finalControl).toBeNull();
  }, 20000);

  it('[10] class: PrimeNG p-dropdown#journeyClass — opened, async option clicked by exact label, label verified; hidden select ignored; unknown class → CLASS_AUTOFILL_FAILED', async () => {
    load('real-search');
    const host = Core.findChoice(document, /class/);
    expect(host.tagName).toBe('P-DROPDOWN');
    expect(Core.isPrimeDropdown(host)).toBe(true);
    const rep = await Core.fillPage(document, 'HOME_SEARCH', snap({ travelClass: { code: '3A', label: 'AC 3 Tier (3A)' } }), Core.newState());
    expect(label('journeyClass')).toBe('AC 3 Tier (3A)');
    expect(label('journeyQuota')).toBe('GENERAL');
    expect(document.querySelector('.ui-dropdown-panel')).toBeNull();      // panel closed again
    expect(rep.filled).toEqual(expect.arrayContaining(['travelClass', 'quota']));
    load('real-search');
    const r2 = await Core.fillPage(document, 'HOME_SEARCH', snap({ travelClass: { code: 'ZZ', label: 'Unknown (ZZ)' } }), Core.newState());
    expect(label('journeyClass')).toBe('All Classes');                     // never another class
    expect(r2.errors).toContainEqual({ code: 'CLASS_AUTOFILL_FAILED', field: 'travelClass', reason: 'OPTION_NOT_FOUND' });
    expect(document.querySelector('.ui-dropdown-panel')).toBeNull();
  }, 20000);
});

describe('P39.3 — train list', () => {
  it('[9] train by number: collapsed list → block highlighted, no other train; expanded → bare class tab + date cell highlighted, Book Now never clicked; missing → TRAIN_AUTOFILL_FAILED', async () => {
    let clicks = load('real-train-list');
    expect(Core.detectPage(document)).toBe('TRAIN_LIST');
    let rep = await Core.fillPage(document, 'TRAIN_LIST', snap(), Core.newState());
    expect(rep.filled).toEqual(['train', 'travelClass']);
    const hl = Array.from(document.querySelectorAll('[data-bookkaro-highlight="train"]'));
    expect(hl).toHaveLength(1);
    expect(hl[0].textContent).toContain('(12904)');
    expect(hl[0].textContent).not.toMatch(/\((12498|12014)\)/);
    expect(rep.finalControl).toBeNull();
    clicks = load('real-train-list-expanded');
    rep = await Core.fillPage(document, 'TRAIN_LIST', snap({ travelClass: { code: '3A', label: 'AC 3 Tier (3A)' } }), Core.newState());
    expect(rep.filled).toEqual(['train', 'travelClass']);
    expect(rep.skipped).toEqual([]);
    expect($('[data-bookkaro-highlight="date"]').textContent).toContain('Thu, 08 Oct');
    expect($('[data-bookkaro-highlight="class"]').textContent).toMatch(/3A/);
    expect(rep.finalControl.textContent).toBe('Book Now');
    expect(rep.finalControl.closest('app-train-avl-enq').textContent).toContain('(12904)');
    Core.highlight(rep.finalControl, 'final');
    expect(clicks).toEqual([]);
    expect(document.body.getAttribute('data-final-clicked')).toBeNull();
    load('real-train-list');
    rep = await Core.fillPage(document, 'TRAIN_LIST', snap({ train: { number: '22488', name: null, departure: null, arrival: null } }), Core.newState());
    expect(rep.filled).toEqual([]);
    expect(rep.errors).toEqual([{ code: 'TRAIN_AUTOFILL_FAILED', field: 'train', reason: 'TRAIN_NOT_IN_LIST' }]);
    expect(document.querySelector('[data-bookkaro-highlight]')).toBeNull();
  }, 20000);
});

describe('P39.3 — passenger page (mobile structure)', () => {
  it('[11] passenger 1: name via "Full Name as per Govt. ID", age, gender code M, sleeper berth LB; nationality / mobile / payment untouched', async () => {
    const clicks = load('real-passenger-mobile');
    expect(Core.detectPage(document)).toBe('PASSENGER');
    const rep = await Core.fillPage(document, 'PASSENGER', snap(), Core.newState());
    expect(nameInputs()[0].value).toBe('Rahul Sharma');
    expect($('input[formcontrolname="passengerAge"]').value).toBe('31');
    expect($('select[formcontrolname="passengerGender"]').value).toBe('M');
    expect($('select[formcontrolname="passengerBerthChoice"]').value).toBe('LB');
    expect($('select[formcontrolname="passengerNationality"]').value).toBe('IN');
    expect($('#mobileNumber').value).toBe('+91 98XXXXXX10');
    expect(Array.from(document.querySelectorAll('input[type=radio]')).some((r: any) => r.checked)).toBe(false);
    expect(rep.filled.slice().sort()).toEqual(['passengerAge', 'passengerBerth', 'passengerGender', 'passengerName']);
    expect(rep.errors).toEqual([]);
    expect(rep.finalControl.textContent).toBe('Continue');
    expect(clicks).toEqual([]);
  }, 20000);

  it('[12] passenger 2: index preserved — row 2 gets passenger 2 (name / age / gender F / berth SU), row 1 passenger 1', async () => {
    load('real-passenger-mobile-2');
    const rep = await Core.fillPage(document, 'PASSENGER', snap({ passengers: P.slice(0, 2) }), Core.newState());
    expect(nameInputs().map(i => i.value)).toEqual(['Rahul Sharma', 'Neha Sharma']);
    expect(Array.from(document.querySelectorAll('input[formcontrolname="passengerAge"]')).map((i: any) => i.value)).toEqual(['31', '28']);
    expect(Array.from(document.querySelectorAll('select[formcontrolname="passengerGender"]')).map((s: any) => s.value)).toEqual(['M', 'F']);
    expect(Array.from(document.querySelectorAll('select[formcontrolname="passengerBerthChoice"]')).map((s: any) => s.value)).toEqual(['LB', 'SU']);
    expect(rep.errors).toEqual([]);
  }, 20000);

  it('[13] multiple passengers: "+ Add Passenger" adds rows (only when allowed) and all 3 are filled in order; otherwise PASSENGER_ROW_MISSING #2 #3', async () => {
    load('real-passenger-mobile');
    const r0 = await Core.fillPage(document, 'PASSENGER', snap({ passengers: P }), Core.newState());
    expect(nameInputs()).toHaveLength(1);
    expect(r0.errors.filter((e: any) => e.code === 'PASSENGER_ROW_MISSING').map((e: any) => [e.passengerIndex, e.field])).toEqual([
      [2, 'passengerName'], [2, 'passengerAge'], [2, 'passengerGender'], [3, 'passengerName'], [3, 'passengerAge'], [3, 'passengerGender']]);
    load('real-passenger-mobile');
    const rep = await Core.fillPage(document, 'PASSENGER', snap({ passengers: P }), Core.newState(), { allowAddRows: true });
    expect(nameInputs().map(i => i.value)).toEqual(['Rahul Sharma', 'Neha Sharma', 'Aman Verma']);
    expect(Array.from(document.querySelectorAll('select[formcontrolname="passengerBerthChoice"]')).map((s: any) => s.value)).toEqual(['LB', 'SU', 'MB']);
    expect(rep.errors).toEqual([]);
  }, 20000);

  it('[14] verification: a value the page rejects after validation → PASSENGER_FIELD_REJECTED with the passenger index; too-long values never truncated', async () => {
    load('real-passenger-rejecting');
    const rep = await Core.fillPage(document, 'PASSENGER', snap({ passengers: [P[0], { ...P[1], name: 'Al' }] }), Core.newState());
    expect(nameInputs().map(i => i.value)).toEqual(['Rahul Sharma', '']);
    expect(rep.errors).toEqual([{ code: 'PASSENGER_FIELD_REJECTED', field: 'passengerName', passengerIndex: 2, reason: 'VALUE_REJECTED_BY_PAGE' }]);
    load('real-passenger-mobile');
    const r2 = await Core.fillPage(document, 'PASSENGER', snap({ passengers: [{ ...P[0], name: 'Rahul Kumar Sharma Verma' }] }), Core.newState());
    expect(nameInputs()[0].value).toBe('');
    expect(r2.errors).toContainEqual({ code: 'PASSENGER_FIELD_REJECTED', field: 'passengerName', passengerIndex: 1, reason: 'VALUE_TOO_LONG' });
    expect(r2.errors.every((e: any) => (IRCTC_AUTOFILL_ERROR_CODES as readonly string[]).includes(e.code))).toBe(true);
    expect(JSON.stringify(r2.errors)).not.toMatch(/Rahul|Sharma/);       // typed errors carry no values
  }, 20000);
});

describe('P39.3 — user-only boundaries (STOP)', () => {
  const stopCase = async (id: string, page: string) => {
    const clicks = load(id);
    expect(Core.detectPage(document)).toBe(page);
    const before = Array.from(document.querySelectorAll('input')).map((i: any) => i.value);
    const rep = await Core.fillPage(document, page, snap(), Core.newState());
    expect(rep.filled).toEqual([]);
    expect(Array.from(document.querySelectorAll('input')).map((i: any) => i.value)).toEqual(before);
    for (const i of Array.from(document.querySelectorAll('input'))) expect(Core.isForbidden(i)).toBe(true);
    if (rep.finalControl) Core.highlight(rep.finalControl, 'user-action');
    expect(clicks).toEqual([]);
    return rep;
  };
  const content = readFileSync(resolve(__dirname, '../../extension/irctc-content.js'), 'utf8');
  it('[15] login: detected first, nothing filled, credentials never read; the overlay says "IRCTC login required."', async () => {
    await stopCase('login-required', 'LOGIN');
    expect(content).toMatch(/LOGIN: 'IRCTC login required\./);
  });
  it('[16] CAPTCHA: nothing filled, CAPTCHA input forbidden, review Continue only highlighted', async () => {
    const rep = await stopCase('review-captcha', 'REVIEW_CAPTCHA');
    expect(rep.finalControl?.textContent).toBe('Continue');
  });
  it('[17] OTP: nothing filled, OTP input forbidden, Submit never clicked', async () => { await stopCase('otp', 'OTP'); });
  it('[18] payment: nothing filled, card / CVV forbidden, Pay & Book never clicked', async () => {
    const rep = await stopCase('payment', 'PAYMENT');
    expect(rep.finalControl?.textContent).toMatch(/Pay/);
    expect(document.body.getAttribute('data-final-clicked')).toBeNull();
  });
});

describe('P39.3 — language dialog + content-script host stop', () => {
  it('[21] language Alert dialog ("preferred language") is detected; the button is found INSIDE the dialog (not the header toggle)', async () => {
    load('real-language-alert');
    expect(Core.detectPage(document)).toBe('LANGUAGE');
    const en = Core.findLanguageControl(document, 'en');
    const hi = Core.findLanguageControl(document, 'hi');
    expect(en.closest('[role=dialog]')).not.toBeNull();
    expect(hi.closest('[role=dialog]')).not.toBeNull();
    en.click();
    expect(document.body.getAttribute('data-lang')).toBe('en');
    expect(Core.detectPage(document)).toBe('HOME_SEARCH');
  });

  it('[22] the IRCTC content script stops on an unapproved host (no overlay, no messages) and runs on the approved mock page', async () => {
    const src = readFileSync(resolve(__dirname, '../../extension/irctc-content.js'), 'utf8');
    const run = (href: string) => {
      document.body.innerHTML = '<p>page</p>';
      const sent: any[] = [];
      const w: any = { BookKaroHandoffGuard: Guard, BookKaroIrctcCore: Core };
      const chromeStub = { runtime: { sendMessage: (m: any, cb: any) => { sent.push(m.type); cb({ ok: false, code: 'NO_ACTIVE_HANDOFF' }); } } };
      new Function('window', 'document', 'location', 'chrome', 'MutationObserver', src)(w, document, new URL(href), chromeStub, class { observe() {} disconnect() {} });
      return { overlay: !!document.getElementById('bookkaro-irctc-assist'), sent };
    };
    for (const u of ['https://evil.example/nget/train-search', 'https://irctc.co.in/nget/train-search', 'https://www.irctc.co.in.attacker.example/nget/'])
      expect(run(u), u).toEqual({ overlay: false, sent: [] });
    const ok = run('http://localhost:3000/api/dev/mock-irctc/real-search');
    expect(ok.overlay).toBe(true);
    expect(ok.sent).toContain('BK_GET_SNAPSHOT');
  });
});
