/**
 * P39.3 — MockIRCTC "real-like" pages: the component structure the real www.irctc.co.in/nget app renders (Angular +
 * PrimeNG ≤8), as documented by public open-source IRCTC fill scripts and the visible mobile flow:
 *
 *  - language "Alert" dialog (ui-dialog, role=dialog) over the search form — "preferred language", हिंदी / English
 *  - <p-autocomplete id="origin" / "destination"> with an id-less input; suggestions arrive ASYNC (~300 ms debounce)
 *    as "NAME. - CODE (CITY)"
 *  - <p-calendar id="jDate" formcontrolname="journeyDate"> that re-validates the typed date on blur (async)
 *  - <p-dropdown id="journeyClass" / "journeyQuota">: aria-hidden <select> inside .ui-helper-hidden-accessible,
 *    .ui-dropdown-label, div[role=button] trigger, options rendered only after a click
 *  - train list of <app-train-avl-enq> blocks (collapsed: no "Book Now" yet; expanded: bare class tabs + date cells)
 *  - mobile passenger page ("Full Name as per Govt. ID", nationality select, sleeper berth codes)
 *  - modes (data-mock-mode) for pages that refuse a value: decoy stations, a station the page clears, a date the
 *    picker rejects, a passenger name the form rejects.
 *
 * Clearly MOCK (banner, nothing booked, final buttons only record `data-final-clicked`). Separate export so the
 * original 23-scenario contract (MOCK_IRCTC_SCENARIOS) stays unchanged. Data is generic — no screenshot values.
 */
import type { MockIrctcScenario } from './mock-irctc';

const attr = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

const CLASSES = ['All Classes', 'Anubhuti Class (EA)', 'AC First Class (1A)', 'Exec. Chair Car (EC)', 'AC 2 Tier (2A)', 'First Class (FC)',
  'AC 3 Tier (3A)', 'AC 3 Economy (3E)', 'AC Chair car (CC)', 'Sleeper (SL)', 'Second Sitting (2S)'];
const QUOTAS = ['GENERAL', 'LADIES', 'LOWER BERTH/SR.CITIZEN', 'PERSON WITH DISABILITY', 'DUTY PASS', 'TATKAL', 'PREMIUM TATKAL'];

const header = `<header class="h_container"><a class="h_logo">INDIAN RAILWAYS (MOCK)</a><a class="lang-toggle" href="#">हिंदी</a>
  <a class="search_btn loginText" href="#">LOGIN</a><a>REGISTER</a></header>`;

const autocomplete = (id: string, label: string) => `<p-autocomplete id="${id}" formcontrolname="${id}" data-station class="ng-untouched ng-invalid">
  <span class="ui-autocomplete ui-widget"><input type="text" class="ui-inputtext ui-autocomplete-input" role="searchbox" aria-autocomplete="list" aria-controls="${id}_list" autocomplete="off"></span>
  <label class="ui-float-label">${label}</label>
  <div class="ui-autocomplete-panel ui-widget-content" hidden><ul class="ui-autocomplete-items ui-autocomplete-list" role="listbox" id="${id}_list"></ul></div></p-autocomplete>`;

const dropdown = (id: string, options: string[], selected: string) => `<p-dropdown id="${id}" formcontrolname="${id}" data-options="${attr(JSON.stringify(options))}">
  <div class="ui-dropdown ui-widget ui-state-default ui-corner-all">
    <div class="ui-helper-hidden-accessible"><select aria-hidden="true" tabindex="-1">${options.map(o => `<option${o === selected ? ' selected' : ''}>${o}</option>`).join('')}</select></div>
    <label class="ui-dropdown-label ui-inputtext ui-corner-all">${selected}</label>
    <div class="ui-dropdown-trigger ui-state-default" role="button" aria-haspopup="listbox"><span class="ui-dropdown-trigger-icon pi pi-chevron-down"></span></div>
  </div></p-dropdown>`;

function realSearchForm(mode = ''): string {
  return `${mode ? `<div data-mock-mode="${mode}" hidden></div>` : ''}<app-jp-input><form class="ng-untouched" aria-label="Book Ticket"><h2>BOOK TICKET</h2>
  ${autocomplete('origin', 'From*')}
  ${autocomplete('destination', 'To*')}
  <p-calendar id="jDate" formcontrolname="journeyDate"><span class="ui-calendar"><input type="text" class="ui-inputtext ui-calendar-input" autocomplete="off"></span>
    <label class="ui-float-label">DD/MM/YYYY *</label></p-calendar>
  ${dropdown('journeyClass', CLASSES, 'All Classes')}
  ${dropdown('journeyQuota', QUOTAS, 'GENERAL')}
  <button type="submit" class="search_btn train_Search" data-final="search" onclick="event.preventDefault();this.ownerDocument.body.dataset.finalClicked='search'">Search</button></form></app-jp-input>`;
}

const languageDialog = `<div class="ui-widget-overlay ui-dialog-mask"></div>
  <div class="ui-dialog ui-widget ui-corner-all" role="dialog" aria-labelledby="lang-dlg-title"><div class="ui-dialog-titlebar"><span class="ui-dialog-title" id="lang-dlg-title">Alert</span></div>
  <div class="ui-dialog-content"><p>Please select your preferred language</p><p>कृपया अपनी पसंदीदा भाषा चुनें</p></div>
  <div class="ui-dialog-footer"><button type="button" class="btn" data-lang-choice="hi">हिंदी</button><button type="button" class="btn" data-lang-choice="en">English</button></div></div>`;

const CLASS_CODE = (label: string) => (/\(([0-9A-Z]{2})\)$/.exec(label) || [])[1] || '';
const DATES = ['Tue, 06 Oct', 'Wed, 07 Oct', 'Thu, 08 Oct', 'Fri, 09 Oct', 'Sat, 10 Oct', 'Sun, 11 Oct'];

function trainBlock(t: { no: string; name: string; classes: string[] }, expanded: boolean): string {
  return `<app-train-avl-enq><div class="form-group no-pad col-xs-12 bull-back border-all">
    <div class="col-sm-5 col-xs-11 train-heading"><strong>${t.name} (${t.no})</strong></div>
    <div class="col-xs-12 white-back"><span class="time">--:--</span> | <span class="time">--:--</span></div>
    <table class="pre-avl-table"><tr>${t.classes.map(c => `<td><div class="pre-avl" role="button" tabindex="0"><div><strong>${c}</strong></div><span class="refresh">Refresh</span></div></td>`).join('')}</tr></table>
    ${expanded ? `<div class="class-tabs" role="tablist">${t.classes.map((c, i) => `<span role="tab" class="${i ? '' : 'selected-class'}">${CLASS_CODE(c)}</span>`).join('')}</div>
    <div class="avl-dates">${DATES.map(d => `<div class="pre-avl date-cell" role="button" tabindex="0"><div><strong>${d}</strong></div><div class="AVAILABLE">AVAILABLE-0001</div></div>`).join('')}</div>
    <button type="button" class="btnDefault train_Search" data-final="book-now" onclick="this.ownerDocument.body.dataset.finalClicked='book-now'">Book Now</button>` : ''}
  </div></app-train-avl-enq>`;
}

const TRAINS = [
  { no: '12498', name: 'SHAN-E- PUNJAB', classes: ['AC Chair car (CC)', 'Second Sitting (2S)'] },
  { no: '12014', name: 'AMRITSAR SHTABDI', classes: ['AC Chair car (CC)', 'Exec. Chair Car (EC)'] },
  { no: '12904', name: 'MOCK SUPERFAST', classes: ['Sleeper (SL)', 'AC 3 Economy (3E)', 'AC 3 Tier (3A)'] },
  { no: '12497', name: 'SHANE PUNJAB', classes: ['AC Chair car (CC)', 'Second Sitting (2S)'] }
];

function realTrainList(expandNo: string | null): string {
  return `<app-train-list><div class="tbis-div"><span>${TRAINS.length} Results (MOCK)</span>
    ${TRAINS.map(t => trainBlock(t, t.no === expandNo)).join('')}</div></app-train-list>`;
}

const codeSelect = (fcn: string, opts: Array<[string, string]>, sel = '') =>
  `<select formcontrolname="${fcn}" class="form-control">${opts.map(([v, t]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${t}</option>`).join('')}</select>`;

function mobilePassengerRow(i: number): string {
  return `<app-passenger><div class="passenger-block" id="psgn-${i}"><span class="psgn-no">Passenger ${i}</span>
    <div class="ui-float-label"><input type="text" class="form-control" placeholder="Full Name as per Govt. ID" maxlength="16" autocomplete="off"></div>
    <input type="number" formcontrolname="passengerAge" placeholder="Age" class="form-control" min="1" max="125">
    ${codeSelect('passengerGender', [['', 'Gender'], ['M', 'Male'], ['F', 'Female'], ['T', 'Transgender']])}
    ${codeSelect('passengerNationality', [['IN', 'India'], ['NP', 'Nepal']], 'IN')}
    ${codeSelect('passengerBerthChoice', [['', 'No Preference'], ['LB', 'Lower'], ['MB', 'Middle'], ['UB', 'Upper'], ['SL', 'Side Lower'], ['SU', 'Side Upper']])}
  </div></app-passenger>`;
}

function mobilePassengerPage(rows: number, mode = ''): string {
  return `${mode ? `<div data-mock-mode="${mode}" hidden></div>` : ''}<style>.d-none{display:none!important}</style>
  <div class="d-none"><app-login><input type="text" formcontrolname="userid" placeholder="User Name"><input type="password" formcontrolname="password" placeholder="Password"></app-login></div>
  <app-psgn-input><div class="passenger-page"><h3>Passenger Details</h3><div class="train-summary">MOCK SUPERFAST (12904) | Sleeper (SL) | GENERAL</div>
  <div class="passenger-rows">${Array.from({ length: rows }, (_, k) => mobilePassengerRow(k + 1)).join('')}</div>
  <a href="#" class="add-passenger" role="button">+ Add Passenger</a>
  <div class="contact"><label for="mobileNumber">Mobile Number</label><input id="mobileNumber" formcontrolname="mobileNumber" aria-label="Mobile Number" value="+91 98XXXXXX10" readonly></div>
  <fieldset class="payment-mode"><legend>Payment Mode</legend>
    <label><input type="radio" name="paymentType" value="upi"> Pay through BHIM/UPI</label></fieldset>
  <button type="submit" class="train_Search btnDefault" data-final="continue" onclick="this.ownerDocument.body.dataset.finalClicked='continue'">Continue</button></div></app-psgn-input>`;
}

const S = (id: string, title: string, expectPage: string, html: string): MockIrctcScenario => ({ id, title, expectPage, html });

export const MOCK_IRCTC_REAL_SCENARIOS: readonly MockIrctcScenario[] = Object.freeze([
  S('real-language-alert', 'REAL-LIKE — language Alert dialog over the search form', 'LANGUAGE', `${header}${languageDialog}${realSearchForm()}`),
  S('real-search', 'REAL-LIKE — PrimeNG search form (async station suggestions, p-calendar, p-dropdown class / quota)', 'HOME_SEARCH', `${header}${realSearchForm()}`),
  S('real-search-decoy-stations', 'REAL-LIKE — suggestions never contain the requested station code', 'HOME_SEARCH', `${header}${realSearchForm('decoy-stations')}`),
  S('real-search-station-rejected', 'REAL-LIKE — the page clears the chosen station again', 'HOME_SEARCH', `${header}${realSearchForm('reject-station')}`),
  S('real-search-date-rejected', 'REAL-LIKE — the date picker rejects the typed date', 'HOME_SEARCH', `${header}${realSearchForm('reject-date')}`),
  S('real-train-list', 'REAL-LIKE — train list, collapsed (no Book Now until class + date are tapped)', 'TRAIN_LIST', `${header}${realTrainList(null)}`),
  S('real-train-list-expanded', 'REAL-LIKE — train list, 12904 expanded (class tabs SL / 3E / 3A, date cells, Book Now)', 'TRAIN_LIST', `${header}${realTrainList('12904')}`),
  S('real-passenger-mobile', 'REAL-LIKE — mobile passenger page, 1 row + Add Passenger (sleeper berths, nationality)', 'PASSENGER', mobilePassengerPage(1)),
  S('real-passenger-mobile-2', 'REAL-LIKE — mobile passenger page, 2 rows', 'PASSENGER', mobilePassengerPage(2)),
  S('real-passenger-rejecting', 'REAL-LIKE — passenger form that rejects names shorter than 3 letters', 'PASSENGER', mobilePassengerPage(2, 'reject-short-name'))
]);

/**
 * Inline behaviour of the real-like pages (PrimeNG emulation). Rendered as a SEPARATE <script data-mock-real> after
 * the original mock script, so the original one is unchanged.
 */
export const MOCK_IRCTC_REAL_SCRIPT = `(function () {
  var mode = function () { var mk = document.querySelector('[data-mock-mode]'); return mk ? mk.getAttribute('data-mock-mode') : ''; };
  var ST = ['AMRITSAR JN. - ASR (AMRITSAR)', 'NEW DELHI - NDLS (NEW DELHI)', 'DELHI - DLI (NEW DELHI)', 'H NIZAMUDDIN - NZM (NEW DELHI)',
    'LUDHIANA JN. - LDH (LUDHIANA)', 'JALANDHAR CITY - JUC (JALANDHAR)', 'CHANDIGARH - CDG (CHANDIGARH)', 'MUMBAI CENTRAL - MMCT (MUMBAI)'];
  var DECOY = ['ASARVA JN. - ASV (AHMEDABAD)', 'ANAND VIHAR TRM - ANVT (NEW DELHI)'];
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  var d0 = new Date(); var TODAY = pad(d0.getDate()) + '/' + pad(d0.getMonth() + 1) + '/' + d0.getFullYear();
  var cal = document.querySelector('p-calendar input'); if (cal && !cal.value) cal.value = TODAY;
  function validDate(v) {
    var m = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(v || ''); if (!m) return false;
    var d = new Date(+m[3], +m[2] - 1, +m[1]); return d.getFullYear() === +m[3] && d.getMonth() === +m[2] - 1 && d.getDate() === +m[1];
  }
  document.addEventListener('input', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    var h = t.closest('p-autocomplete[data-station]');
    if (h) {
      var panel = h.querySelector('.ui-autocomplete-panel');
      clearTimeout(h._t);
      h._t = setTimeout(function () {                                  // PrimeNG delay=300 then the app's completeMethod
        var q = String(t.value || '').toUpperCase().trim();
        var MODE = mode();
        var hits = !q ? [] : MODE === 'decoy-stations' ? DECOY : ST.filter(function (s) { return s.indexOf(q) >= 0; });
        panel.querySelector('ul').innerHTML = hits.map(function (s) { return '<li role="option" class="ui-autocomplete-list-item" aria-label="' + s + '"><span>' + s + '</span></li>'; }).join('');
        panel.hidden = !hits.length;
      }, 300);
      return;
    }
    if (mode() === 'reject-short-name' && /full name/i.test(t.getAttribute('placeholder') || '')) {
      setTimeout(function () { if (t.value && t.value.length < 3) t.value = ''; }, 80);   // form validator clears it
    }
  });
  // p-calendar like PrimeNG Calendar: typed input updates the model ONLY after a keydown (isKeydown guard);
  // on blur the field is re-formatted from the model (so un-armed typing is reverted)
  document.addEventListener('keydown', function (e) { var t = e.target; if (t && t.closest && t.closest('p-calendar')) t._kd = true; }, true);
  document.addEventListener('input', function (e) {
    var t = e.target; var c = t && t.closest && t.closest('p-calendar'); if (!c) return;
    if (!t._kd) return;
    t._kd = false;
    if (validDate(t.value)) c._model = t.value;
  }, true);
  document.addEventListener('focusout', function (e) {
    var t = e.target; var c = t && t.closest && t.closest('p-calendar'); if (!c) return;
    setTimeout(function () { t.value = mode() === 'reject-date' ? TODAY : (c._model || TODAY); }, 60);   // async re-format / reject
  });
  document.addEventListener('click', function (e) {
    var tg = e.target; if (!tg || !tg.closest) return;
    var li = tg.closest('li[role="option"]');
    var ac = li && li.closest('p-autocomplete[data-station]');
    if (ac) {
      var inp = ac.querySelector('input'); inp.value = li.getAttribute('aria-label'); ac.querySelector('.ui-autocomplete-panel').hidden = true;
      if (mode() === 'reject-station') setTimeout(function () { inp.value = ''; }, 80);
      return;
    }
    var dd = li && li.closest('p-dropdown');
    if (dd) {
      var lab = li.getAttribute('aria-label'); dd.querySelector('.ui-dropdown-label').textContent = lab;
      Array.prototype.forEach.call(dd.querySelectorAll('option'), function (o) { o.selected = o.textContent === lab; });
      var pn = dd.querySelector('.ui-dropdown-panel'); if (pn) pn.parentNode.removeChild(pn);
      return;
    }
    var box = tg.closest('p-dropdown .ui-dropdown');
    if (box) {
      var host = box.closest('p-dropdown'); var open = box.querySelector('.ui-dropdown-panel');
      if (open) { open.parentNode.removeChild(open); return; }
      setTimeout(function () {                                          // options are rendered only after opening
        var opts = JSON.parse(host.getAttribute('data-options'));
        box.insertAdjacentHTML('beforeend', '<div class="ui-dropdown-panel ui-widget-content"><div class="ui-dropdown-items-wrapper"><ul class="ui-dropdown-items" role="listbox">' +
          opts.map(function (o) { return '<li role="option" class="ui-dropdown-item" aria-label="' + o + '"><span>' + o + '</span></li>'; }).join('') + '</ul></div></div>');
      }, 120);
      return;
    }
    var lb = tg.closest('[data-lang-choice]');
    if (lb) {
      document.body.setAttribute('data-lang', lb.getAttribute('data-lang-choice'));
      var dl = lb.closest('.ui-dialog'); if (dl) dl.parentNode.removeChild(dl);
      var ov = document.querySelector('.ui-widget-overlay'); if (ov) ov.parentNode.removeChild(ov);
    }
  });
})();`;
