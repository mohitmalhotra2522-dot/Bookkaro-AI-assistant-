// @vitest-environment happy-dom
/**
 * v0.39.5 — fixtures copied from IRCTC's OWN templates (www.irctc.co.in/nget BookingModule chunk, Oct 2026):
 *   - <app-passenger>: Name (p-autocomplete) / Age / Gender in one <span>; Berth (<select formcontrolname=
 *     "passengerBerthChoice"> "No Preference" + value codes LB/MB/…) and Food (<select formcontrolname="passengerFoodChoice"
 *     id="FOOD_n">, default "D" = "No Food/Beverages") in SIBLING <div>s.
 *   - <app-train-avl-enq>: class tab <div class="link pre-avl"> ("AC 3 Economy (3E)" + "3E" + "Refresh"), tapping it loads
 *     the availability <td><div class="pre-avl"> "Tue, 07 Oct" + status; Book Now = <button class="disable-book train_Search
 *     btnDefault"> until a date cell is selected.
 * Also: the 3E class resolver fix and the IRCTC age category shown in the BookKaro form.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { MOCK_IRCTC_SCENARIOS, renderMockIrctc } from '../../server/irctc/mock/mock-irctc';
import { MOCK_IRCTC_REAL_SCENARIOS, MOCK_IRCTC_REAL_SCRIPT } from '../../server/irctc/mock/mock-irctc-real';
import { canonicalClassToken, ClassReferenceResolver } from '../../server/ai/context/class-reference-resolver';
import { irctcAgeCategory } from '../../src/components/passengers/irctc-age-category';

const require = createRequire(import.meta.url);
const Core = require('../../extension/irctc-core.js');

const fast = { wait: (ms: number) => new Promise(r => setTimeout(r, Math.min(ms, 20))), timeoutMs: 1500 };
const snap = (over: any = {}) => ({
  handoffId: 'irh_test', status: 'READY', language: 'en', mockData: true,
  journey: { from: { code: 'ASR', display: 'AMRITSAR JN - ASR', query: 'ASR' }, to: { code: 'NDLS', display: 'NEW DELHI - NDLS', query: 'NDLS' }, dateIso: '2026-10-07', dateIrctc: '07/10/2026' },
  train: { number: '15708', name: 'ASR KIR EXPRESS', departure: null, arrival: null },
  travelClass: { code: '3E', label: 'AC 3 Economy (3E)' }, quota: { code: 'GN', label: 'GENERAL' },
  passengers: [{ index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Lower', food: null }],
  ...over
});

// ---------------------------------------------------------------------------------------------------------------
// real IRCTC passenger component
const BERTH_EN: Array<[string, string]> = [['', 'No Preference'], ['LB', 'Lower'], ['MB', 'Middle'], ['UB', 'Upper'], ['SL', 'Side Lower'], ['SM', 'Side Middle'], ['SU', 'Side Upper']];
const BERTH_HI: Array<[string, string]> = [['', 'कोई वरीयता नहीं'], ['LB', 'नीचे की'], ['MB', 'बीच की'], ['UB', 'ऊपर की'], ['SL', 'साइड नीचे'], ['SU', 'साइड ऊपर']];
const opt = (xs: Array<[string, string]>, sel = '') => xs.map(([v, t]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${t}</option>`).join('');
function appPassenger(i: number, o: { berth?: Array<[string, string]>; food?: boolean; gender?: Array<[string, string]> } = {}) {
  return `<app-passenger><div class="col-xs-12"><div class="col-xs-12">
    <span>
      <div class="col-sm-3 col-xs-12"><p-autocomplete formcontrolname="passengerName"><span class="ui-autocomplete">
        <input type="text" class="ui-inputtext" placeholder="Name" maxlength="16" autocomplete="off"></span></p-autocomplete></div>
      <div class="col-sm-1 col-xs-6"><input type="number" formcontrolname="passengerAge" placeholder="Age" maxlength="3" min="1" class="form-control"></div>
      <div class="Layer_7 col-sm-2 col-xs-6"><select formcontrolname="passengerGender" class="form-control">${opt(o.gender || [['', 'Gender'], ['M', 'Male'], ['F', 'Female'], ['T', 'Transgender']])}</select></div>
      <div class="Layer_7 col-sm-2 col-xs-6"><select formcontrolname="passengerNationality" class="form-control"><option value="IN" selected>India</option></select></div>
    </span>
    <div class="col-pad col-xs-12"><select formcontrolname="passengerBerthChoice" class="form-control">${opt(o.berth || BERTH_EN)}</select></div>
    ${o.food ? `<div class="col-pad col-xs-12"><select formcontrolname="passengerFoodChoice" id="FOOD_${i}" class="form-control">${opt([['', 'Catering Service Option*'], ['V', 'Veg'], ['N', 'Non Veg'], ['D', 'No Food/Beverages']], 'D')}</select></div>` : ''}
    <div class="col-xs-12"><input type="checkbox" formcontrolname="childBerthFlag" checked> Opt Berth</div>
  </div></div></app-passenger>`;
}
function passengerPage(rows: string[]) {
  return `<app-psgn-input><div class="train-summary">ASR KIR EXPRESS (15708) | AC 3 Economy (3E) | GENERAL</div>${rows.join('')}
    <div><input type="text" formcontrolname="mobileNumber" placeholder="Mobile Number" value="98XXXXXX10" readonly></div>
    <button type="submit" class="train_Search btnDefault" data-final="continue">Continue</button></app-psgn-input>`;
}
const sel = (fcn: string, i = 0) => document.querySelectorAll(`select[formcontrolname="${fcn}"]`)[i] as HTMLSelectElement;

describe('v0.39.5 — real IRCTC passenger layout (berth / food in sibling divs)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('[1] berth in the sibling div is found and filled (IRCTC value LB); name / age / gender as before; Continue never clicked', async () => {
    document.body.innerHTML = passengerPage([appPassenger(0)]);
    let clicked = 0; document.querySelector('[data-final]')!.addEventListener('click', () => clicked++);
    expect(Core.detectPage(document)).toBe('PASSENGER');
    const rep = await Core.fillPage(document, 'PASSENGER', snap(), Core.newState(), fast);
    expect(rep.filled).toEqual(expect.arrayContaining(['passengerName', 'passengerAge', 'passengerGender', 'passengerBerth']));
    expect(rep.skipped.filter((s: any) => s.field === 'passengerBerth')).toEqual([]);
    expect(sel('passengerBerthChoice').value).toBe('LB');
    expect(sel('passengerGender').value).toBe('M');
    expect(sel('passengerNationality').value).toBe('IN');                                     // untouched
    expect((document.querySelector('input[formcontrolname="mobileNumber"]') as HTMLInputElement).value).toBe('98XXXXXX10');
    expect((document.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true);   // Opt Berth untouched
    expect(rep.finalControl?.textContent).toBe('Continue');
    const adv = await Core.autoAdvance(document, 'PASSENGER', snap(), rep, Core.newState(), fast);
    expect(adv.clicked).toEqual([]); expect(clicked).toBe(0);
  });

  it('[2] every passenger component gets its own berth (3 rows, incl. Side Middle for 3E)', async () => {
    document.body.innerHTML = passengerPage([appPassenger(0), appPassenger(1), appPassenger(2)]);
    const s = snap({ passengers: [
      { index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Lower', food: null },
      { index: 2, name: 'Neha Sharma', age: 28, gender: 'Female', berth: 'Side Middle', food: null },
      { index: 3, name: 'Aman Verma', age: 8, gender: 'Male', berth: 'No Preference', food: null }] });
    const rep = await Core.fillPage(document, 'PASSENGER', s, Core.newState(), fast);
    expect(rep.errors).toEqual([]);
    expect([0, 1, 2].map(i => sel('passengerBerthChoice', i).value)).toEqual(['LB', 'SM', '']);
    expect([0, 1, 2].map(i => sel('passengerGender', i).value)).toEqual(['M', 'F', 'M']);
  });

  it('[3] Hindi IRCTC page: option text differs, the IRCTC value code is used (Lower → LB, Male → M)', async () => {
    document.body.innerHTML = passengerPage([appPassenger(0, { berth: BERTH_HI, gender: [['', 'लिंग'], ['M', 'पुरुष'], ['F', 'महिला'], ['T', 'ट्रांसजेंडर']] })]);
    const rep = await Core.fillPage(document, 'PASSENGER', snap({ language: 'hi' }), Core.newState(), fast);
    expect(sel('passengerBerthChoice').value).toBe('LB');
    expect(sel('passengerGender').value).toBe('M');
    expect(rep.errors).toEqual([]);
  });

  it('[4] food: IRCTC default "No Food/Beverages" is not a user edit; Veg → V, No Food → D; no pause', async () => {
    document.body.innerHTML = passengerPage([appPassenger(0, { food: true }), appPassenger(1, { food: true })]);
    document.querySelectorAll('select[formcontrolname="passengerFoodChoice"]').forEach(f => { (f as HTMLSelectElement).value = 'D'; });   // Angular's form default "D"
    expect(sel('passengerFoodChoice', 0).value).toBe('D');
    const s = snap({ passengers: [
      { index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Upper', food: 'Veg' },
      { index: 2, name: 'Neha Sharma', age: 28, gender: 'Female', berth: 'Lower', food: 'No Food' }] });
    const rep = await Core.fillPage(document, 'PASSENGER', s, Core.newState(), fast);
    expect(rep.overrides).toEqual([]);
    expect(rep.errors).toEqual([]);
    expect([sel('passengerFoodChoice', 0).value, sel('passengerFoodChoice', 1).value]).toEqual(['V', 'D']);
    expect([sel('passengerBerthChoice', 0).value, sel('passengerBerthChoice', 1).value]).toEqual(['UB', 'LB']);
  });

  it('[5] the user\'s own berth choice still wins (never overwritten) and an option IRCTC does not offer is reported, never substituted', async () => {
    document.body.innerHTML = passengerPage([appPassenger(0)]);
    const st = Core.newState();
    const b = sel('passengerBerthChoice'); b.value = 'UB'; st.userEdited.add(b);
    const rep = await Core.fillPage(document, 'PASSENGER', snap(), st, fast);
    expect(rep.overrides).toContain('passengerBerth'); expect(b.value).toBe('UB');

    document.body.innerHTML = passengerPage([appPassenger(0, { berth: [['', 'No Preference'], ['LB', 'Lower'], ['UB', 'Upper']] })]);
    const rep2 = await Core.fillPage(document, 'PASSENGER', snap({ passengers: [{ index: 1, name: 'Rahul Sharma', age: 31, gender: 'Male', berth: 'Side Middle', food: null }] }), Core.newState(), fast);
    expect(rep2.skipped).toContainEqual({ field: 'passengerBerth', reason: 'OPTION_NOT_FOUND' });
    expect(sel('passengerBerthChoice').value).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// real IRCTC train list (class tab → async availability → date cell → Book Now)
const DATES = ['Tue, 07 Oct', 'Wed, 08 Oct', 'Thu, 09 Oct', 'Fri, 10 Oct', 'Sat, 11 Oct', 'Sun, 12 Oct'];
function avlBlock(no: string, name: string, classes: Array<[string, string]>) {
  return `<app-train-avl-enq data-no="${no}"><div class="form-group no-pad col-xs-12 bull-back border-all">
    <div class="dull-back no-pad col-xs-12"><div class="col-sm-5 col-xs-11 train-heading"><strong>${name} (${no})</strong></div></div>
    <div class="white-back no-pad col-xs-12"><span class="time">07:40 | Tue, 07 Oct</span> <span class="time">17:20 | Tue, 07 Oct</span></div>
    <div class="white-back col-xs-12"><table><tr>${classes.map(([lab, code]) => `<td><div class="link pre-avl" tabindex="0" data-cls="${code}">
      <div><strong>${lab}</strong></div><div><strong><span class="pull-left">${code}</span></strong></div>
      <div class="col-xs-12 link">Refresh <span class="fa fa-repeat"></span></div></div></td>`).join('')}</tr></table></div>
    <div class="avl-area"></div>
    <div class="col-xs-12"><span class="pull-left"><span></span></span></div></div></app-train-avl-enq>`;
}
/** Behaviour of IRCTC's setClass / selectAvl / bookNow, with an async availability fetch. */
function wireTrainList(status: (cls: string, d: string) => string, log: string[]) {
  document.querySelectorAll('app-train-avl-enq').forEach(t => {
    const no = (t as HTMLElement).dataset.no!;
    t.querySelectorAll('[data-cls]').forEach(tab => tab.addEventListener('click', () => {
      const cls = (tab as HTMLElement).dataset.cls!;
      log.push(`class:${no}:${cls}`);
      t.querySelectorAll('[data-cls]').forEach(x => x.classList.remove('selected-class'));
      setTimeout(() => {                                                                   // availability arrives later
        tab.classList.add('selected-class');
        t.querySelector('.avl-area')!.innerHTML = `<table><tr>${DATES.map((d, i) => `<td><div class="pre-avl" tabindex="0" data-i="${i}"><div><strong>${d}</strong></div>
          <div class="col-xs-12 ${status(cls, d).startsWith('AVAILABLE') ? 'AVAILABLE' : 'WL'}"><strong>${status(cls, d)}</strong></div></div></td>`).join('')}</tr></table>`;
        const span = t.querySelector('.pull-left > span')!;
        span.innerHTML = '<button type="button" class="disable-book train_Search btnDefault"> Book Now </button>';
        const book = span.querySelector('button')!;
        book.addEventListener('click', () => { if (!book.classList.contains('disable-book')) log.push(`book:${no}`); });
        t.querySelectorAll('.avl-area .pre-avl').forEach(c => c.addEventListener('click', () => {
          log.push(`date:${no}:${(c as HTMLElement).textContent!.replace(/\s+/g, ' ').trim().slice(0, 11)}`);
          t.querySelectorAll('.avl-area .pre-avl').forEach(x => x.classList.remove('selected-class'));
          c.classList.add('selected-class');
          if (!/REGRET|NOT AVAILABLE/.test(c.textContent || '')) setTimeout(() => book.classList.remove('disable-book'), 60);
        }));
      }, 120);
    }));
  });
}
function trainList(status = (_c: string, _d: string) => 'AVAILABLE-0012') {
  document.body.innerHTML = `<app-train-list><div>2 Results</div>
    ${avlBlock('12014', 'ASR SHATABDI', [['AC Chair car (CC)', 'CC'], ['Exec. Chair Car (EC)', 'EC']])}
    ${avlBlock('15708', 'ASR KIR EXPRESS', [['Sleeper (SL)', 'SL'], ['AC 3 Tier (3A)', '3A'], ['AC 3 Economy (3E)', '3E']])}</app-train-list>`;
  const log: string[] = [];
  wireTrainList(status, log);
  return log;
}

describe('v0.39.5 — auto-advance on the real IRCTC train list', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('[6] reviewed train only: 3E tab (Refresh) → waits for availability → 07 Oct cell → Book Now once enabled; other train untouched', async () => {
    const log = trainList();
    expect(Core.detectPage(document)).toBe('TRAIN_LIST');
    const st = Core.newState(); const s = snap();
    const rep = await Core.fillPage(document, 'TRAIN_LIST', s, st, fast);
    expect(rep.filled).toContain('train');
    const adv = await Core.autoAdvance(document, 'TRAIN_LIST', s, rep, st, fast);
    expect(adv.stopped).toBeNull();
    expect(adv.clicked).toEqual(['class', 'date', 'bookNow']);
    expect(log).toEqual(['class:15708:3E', 'date:15708:Tue, 07 Oct', 'book:15708']);   // never 3A, never the heading, never 12014
    expect(adv.status).toMatch(/AVAILABLE-0012/);
    // a second run (page re-render) never taps again
    const again = await Core.autoAdvance(document, 'TRAIN_LIST', s, rep, st, fast);
    expect(again.clicked).toEqual([]); expect(again.stopped).toBe('BOOK_NOW_ALREADY_TAPPED');
    expect(log.filter(x => x.startsWith('book:'))).toHaveLength(1);
  });

  it('[7] REGRET: IRCTC keeps Book Now disabled → BOOK_NOW_DISABLED with the status, nothing booked', async () => {
    const log = trainList(() => 'REGRET/WL');
    const st = Core.newState();
    const adv = await Core.autoAdvance(document, 'TRAIN_LIST', snap(), { filled: [], errors: [], overrides: [], skipped: [] }, st, fast);
    expect(adv.stopped).toBe('BOOK_NOW_DISABLED'); expect(adv.status).toMatch(/REGRET/);
    expect(log.some(x => x.startsWith('book:'))).toBe(false);
  });

  it('[8] train / class missing → stop, nothing tapped; Pause → nothing tapped', async () => {
    let log = trainList();
    const r1 = await Core.autoAdvance(document, 'TRAIN_LIST', snap({ train: { number: '99999', name: 'X' } }), { filled: [], errors: [], overrides: [], skipped: [] }, Core.newState(), fast);
    expect(r1.stopped).toBe('TRAIN_NOT_IN_LIST'); expect(log).toEqual([]);
    log = trainList();
    const r2 = await Core.autoAdvance(document, 'TRAIN_LIST', snap({ travelClass: { code: '2A', label: 'AC 2 Tier (2A)' } }), { filled: [], errors: [], overrides: [], skipped: [] }, Core.newState(), fast);
    expect(r2.stopped).toBe('CLASS_NOT_IN_TRAIN'); expect(log).toEqual([]);
    log = trainList();
    const r3 = await Core.autoAdvance(document, 'TRAIN_LIST', snap(), { filled: [], errors: [], overrides: [], skipped: [] }, Core.newState(), { ...fast, shouldStop: () => true });
    expect(r3.stopped).toBe('PAUSED'); expect(log).toEqual([]);
  });

  it('[9] after IRCTC login brought the user back to the list, Book Now may be tapped exactly once more', async () => {
    const log = trainList();
    const st = Core.newState(); const s = snap();
    await Core.autoAdvance(document, 'TRAIN_LIST', s, { filled: [], errors: [], overrides: [], skipped: [] }, st, fast);
    st.loginSeen = true;
    const r = await Core.autoAdvance(document, 'TRAIN_LIST', s, { filled: [], errors: [], overrides: [], skipped: [] }, st, fast);
    expect(r.clicked).toEqual(['bookNow']);
    const r2 = await Core.autoAdvance(document, 'TRAIN_LIST', s, { filled: [], errors: [], overrides: [], skipped: [] }, st, fast);
    expect(r2.clicked).toEqual([]);
    expect(log.filter(x => x.startsWith('book:'))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// journey page Search (REAL-LIKE MockIRCTC PrimeNG page, real timers)
const MOCK_SCRIPT = (renderMockIrctc(null).match(/<script>([\s\S]*?)<\/script>/) || [])[1] || '';
let installed = false;
function load(id: string) {
  const sc = [...MOCK_IRCTC_SCENARIOS, ...MOCK_IRCTC_REAL_SCENARIOS].find(x => x.id === id)!;
  document.body.innerHTML = sc.html;
  document.body.removeAttribute('data-final-clicked');
  if (!installed) { new Function('document', MOCK_SCRIPT)(document); new Function('document', MOCK_IRCTC_REAL_SCRIPT)(document); installed = true; }
  const clicks: string[] = [];
  document.querySelectorAll('[data-final]').forEach(el => {
    el.removeAttribute('onclick');   // the MOCK's inline handler uses the window.event global (absent in happy-dom); the click itself is recorded here
    el.addEventListener('click', e => { e.preventDefault(); clicks.push((el as HTMLElement).dataset.final!); });
  });
  document.querySelectorAll('form').forEach(f => f.addEventListener('submit', e => e.preventDefault()));
  return clicks;
}
const searchSnap = () => snap({ journey: { from: { code: 'ASR', display: 'AMRITSAR JN - ASR', query: 'ASR' }, to: { code: 'NDLS', display: 'NEW DELHI - NDLS', query: 'NDLS' }, dateIso: '2026-10-08', dateIrctc: '08/10/2026' },
  train: { number: '12904', name: 'Mock Superfast' }, travelClass: { code: 'SL', label: 'Sleeper (SL)' } });

describe('v0.39.5 — Search is tapped only after the whole journey was verified', () => {
  it('[10] verified From / To / Date / Class → Search tapped exactly once', async () => {
    const clicks = load('real-search');
    const st = Core.newState();
    const rep = await Core.fillPage(document, 'HOME_SEARCH', searchSnap(), st, {});
    expect(rep.errors).toEqual([]);
    expect(clicks).toEqual([]);                                             // fillPage itself never clicks
    const adv = await Core.autoAdvance(document, 'HOME_SEARCH', searchSnap(), rep, st, {});
    expect(adv.clicked).toEqual(['search']); expect(clicks).toEqual(['search']);
    const again = await Core.autoAdvance(document, 'HOME_SEARCH', searchSnap(), rep, st, {});
    expect(again.clicked).toEqual([]); expect(clicks).toEqual(['search']);
  }, 20000);

  it('[11] wrong / unverified station → Search NOT tapped (JOURNEY_NOT_VERIFIED)', async () => {
    const clicks = load('real-search-decoy-stations');
    const st = Core.newState();
    const rep = await Core.fillPage(document, 'HOME_SEARCH', searchSnap(), st, {});
    expect(rep.stopped).toBe('FROM_STATION_AUTOFILL_FAILED');
    const adv = await Core.autoAdvance(document, 'HOME_SEARCH', searchSnap(), rep, st, {});
    expect(adv.clicked).toEqual([]); expect(adv.stopped).toBe('JOURNEY_NOT_VERIFIED'); expect(clicks).toEqual([]);
  }, 20000);
});

// ---------------------------------------------------------------------------------------------------------------
describe('3E class selection + IRCTC age category', () => {
  it('[12] "3E" / "AC 3 Economy" resolve to 3E (never 3A); 3A words still 3A', () => {
    expect(canonicalClassToken('3E')).toBe('3E');
    expect(canonicalClassToken('15708 3E')).toBe('3E');
    expect(canonicalClassToken('AC 3 economy')).toBe('3E');
    expect(canonicalClassToken('3A')).toBe('3A');
    expect(canonicalClassToken('third ac')).toBe('3A');
    expect(canonicalClassToken('3 tier')).toBe('3A');
    const r = new ClassReferenceResolver();
    const train = { number: '15708', availableClasses: ['SL', '3A', '3E'] };
    expect(r.resolve('3E', train)).toEqual({ ok: true, code: '3E' });
    expect(r.resolve('3A', train)).toEqual({ ok: true, code: '3A' });
    expect(r.resolve('3E', { number: '12904', availableClasses: ['SL', '3A'] }).ok).toBe(false);   // not offered → never 3A
  });

  it('[13] IRCTC age category: 1–4 infant (child under 5), 5–11 child, 12+ adult, empty → none', () => {
    expect(irctcAgeCategory(4)?.kind).toBe('INFANT');
    expect(irctcAgeCategory('1')?.kind).toBe('INFANT');
    expect(irctcAgeCategory(4)?.note).toMatch(/Add Infant Without Berth/);
    expect(irctcAgeCategory(5)?.kind).toBe('CHILD');
    expect(irctcAgeCategory('11')?.kind).toBe('CHILD');
    expect(irctcAgeCategory(11)?.note).toMatch(/Opt Berth/);
    expect(irctcAgeCategory(12)?.kind).toBe('ADULT');
    expect(irctcAgeCategory(12)?.note).toBeNull();
    expect(irctcAgeCategory('')).toBeNull();
    expect(irctcAgeCategory(0)).toBeNull();
    expect(irctcAgeCategory('abc')).toBeNull();
  });
});
