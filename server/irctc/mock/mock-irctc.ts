/**
 * P39 — MockIRCTC: 23 local pages that imitate the VISIBLE structure of the IRCTC booking flow, for developing and
 * testing the BookKaro extension / irctc-core without touching irctc.co.in (which returns 403 to automated clients).
 *
 * Clearly MOCK: every page carries a MOCK banner, nothing is booked, no payment exists, and the "final" buttons only
 * record that they were clicked (`data-final-clicked`) so tests can prove the assistant never clicks them.
 * Served at /api/dev/mock-irctc[/:scenario] only when not running in production.
 *
 * NOTE: the real IRCTC DOM could not be inspected from the sandbox (Akamai 403); these pages follow IRCTC's public
 * visible labels (From*, To*, Journey Date, class "(CC)", quota GENERAL, Book Now, Name / Age / Gender / Berth
 * Preference / Food Choice, Continue, captcha, OTP, Pay & Book). Real-site behaviour is verified by the user (G5).
 */

export interface MockIrctcScenario { id: string; title: string; expectPage: string; html: string }

const CLASS_OPTIONS = ['All Classes', 'Anubhuti Class (EA)', 'AC First Class (1A)', 'Vistadome AC (EV)', 'Exec. Chair Car (EC)', 'AC 2 Tier (2A)',
  'First Class (FC)', 'AC 3 Tier (3A)', 'AC 3 Economy (3E)', 'Vistadome Chair Car (VC)', 'AC Chair car (CC)', 'Sleeper (SL)', 'Vistadome Non AC (VS)', 'Second Sitting (2S)'];
const QUOTAS = ['GENERAL', 'LADIES', 'LOWER BERTH/SR.CITIZEN', 'PERSON WITH DISABILITY', 'DUTY PASS', 'TATKAL', 'PREMIUM TATKAL'];
const STATIONS = ['AMRITSAR JN - ASR', 'NEW DELHI - NDLS', 'DELHI - DLI', 'LUDHIANA JN - LDH', 'JALANDHAR CITY - JUC', 'CHANDIGARH - CDG', 'H NIZAMUDDIN - NZM', 'MUMBAI CENTRAL - MMCT'];

const header = (lang = true) => `<header class="h_container"><a class="h_logo">INDIAN RAILWAYS (MOCK)</a>
  ${lang ? '<a class="lang-toggle" href="#" data-lang="hi">हिंदी</a>' : ''}<a class="search_btn loginText" href="#">LOGIN</a><a>REGISTER</a></header>`;

const select = (attrs: string, options: string[], selected = 0) => `<select ${attrs}>${options.map((o, i) => `<option value="${i === 0 && /^(All|Gender|Food|Berth)/.test(o) ? '' : o}"${i === selected ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
const ariaDropdown = (id: string, label: string, options: string[], selected: string) => `<div class="p-dropdown" id="${id}" role="combobox" aria-label="${label}" aria-haspopup="listbox" aria-expanded="false" tabindex="0">
  <span class="p-dropdown-label">${selected}</span>
  <ul class="p-dropdown-items" role="listbox" hidden>${options.map(o => `<li role="option" aria-label="${o}">${o}</li>`).join('')}</ul></div>`;

function searchForm(opts: { aria?: boolean; suggestions?: string[]; values?: { from?: string; to?: string; date?: string } } = {}): string {
  const v = (x?: string) => (x ? ` value="${x}"` : '');
  const sugg = (opts.suggestions || STATIONS).map(x => `<li role="option" class="ui-autocomplete-list-item">${x}</li>`).join('');
  return `<form class="search-form" aria-label="Book Ticket"><h2>BOOK TICKET</h2>
  <span class="p-autocomplete"><input id="origin" role="searchbox" aria-label="Enter From station. Input is Mandatory." placeholder="From*" autocomplete="off" class="ui-inputtext"${v(opts.values?.from)}></span>
  <ul class="ui-autocomplete-items" role="listbox" data-for="origin" hidden>${sugg}</ul>
  <span class="p-autocomplete"><input id="destination" role="searchbox" aria-label="Enter To station. Input is Mandatory." placeholder="To*" autocomplete="off" class="ui-inputtext"${v(opts.values?.to)}></span>
  <ul class="ui-autocomplete-items" role="listbox" data-for="destination" hidden>${sugg}</ul>
  <span class="p-calendar"><input id="jDate" aria-label="Journey Date(dd/mm/yyyy)" placeholder="DD/MM/YYYY" class="ui-inputtext"${v(opts.values?.date)}></span>
  ${opts.aria ? ariaDropdown('journeyClass', 'Select Class', CLASS_OPTIONS, 'All Classes') + ariaDropdown('journeyQuota', 'Select Quota', QUOTAS, 'GENERAL')
    : select('id="journeyClass" aria-label="Select Class"', CLASS_OPTIONS) + select('id="journeyQuota" aria-label="Select Quota"', QUOTAS)}
  <button type="submit" class="search_btn train_Search">Search</button></form>`;
}

function trainList(trains: Array<{ no: string; name: string; classes: string[] }>): string {
  return `<div class="train-list"><h3>Trains from AMRITSAR JN to NEW DELHI (MOCK)</h3>${trains.map(t => `<div class="form-group train-block" data-train-block>
    <div class="train-heading"><strong>${t.name} (${t.no})</strong></div>
    <div class="classes">${t.classes.map(c => `<div class="pre-avl" role="button" tabindex="0"><strong>${c}</strong><span class="refresh">Refresh</span></div>`).join('')}</div>
    <button type="button" class="btnDefault train_Search" data-final="book-now" onclick="this.ownerDocument.body.dataset.finalClicked='book-now'">Book Now</button></div>`).join('')}</div>`;
}

function passengerRow(i: number, o: { food?: boolean; berth?: string[]; name?: string } = {}): string {
  return `<div class="ui-panel passenger-row" data-passenger-row="${i}">
    <span>Passenger ${i}</span>
    <input placeholder="Name" aria-label="Passenger Name" formcontrolname="passengerName" maxlength="16" class="ui-inputtext" value="${o.name ?? ''}">
    <input placeholder="Age" type="number" aria-label="Passenger Age" formcontrolname="passengerAge" class="ui-inputtext">
    ${select('formcontrolname="passengerGender" aria-label="Gender"', ['Gender', 'Male', 'Female', 'Transgender'])}
    ${select('formcontrolname="passengerBerthChoice" aria-label="Berth Preference"', o.berth || ['No Preference', 'Lower', 'Middle', 'Upper', 'Side Lower', 'Side Upper'])}
    ${o.food === false ? '' : select('formcontrolname="passengerFoodChoice" aria-label="Food Choice"', ['Food Choice', 'Veg', 'Non Veg', 'No Food'])}
  </div>`;
}

function passengerPage(rows: string[], o: { addLink?: boolean } = {}): string {
  return `<div class="passenger-page"><h3>Passenger Details</h3><div class="train-summary">AMRITSAR SHTABDI (12014) | AC Chair car (CC) | GENERAL</div>
  <div class="passenger-rows">${rows.join('')}</div>
  ${o.addLink ? '<a href="#" class="add-passenger" role="button">+ Add Passenger</a>' : ''}
  <div class="contact"><label for="mobileNumber">Mobile Number</label><input id="mobileNumber" formcontrolname="mobileNumber" aria-label="Mobile Number" value="+91 98XXXXXX10" readonly></div>
  <fieldset class="payment-mode"><legend>Payment Mode</legend>
    <label><input type="radio" name="paymentType" value="cards"> Pay through Credit &amp; Debit Cards / Net Banking / Wallets</label>
    <label><input type="radio" name="paymentType" value="upi"> Pay through BHIM/UPI</label></fieldset>
  <button type="submit" class="train_Search btnDefault" data-final="continue" onclick="this.ownerDocument.body.dataset.finalClicked='continue'">Continue</button></div>`;
}

/**
 * Structure documented by public IRCTC autofill scripts (2023–2025): the name field is a PrimeNG
 * <p-autocomplete formcontrolname="passengerName"> wrapping a plain <input placeholder="…Name">, selects carry CODE
 * values (M / F / T, LB / WS, V / N / D) with readable option text, one <app-passenger> per row. The page also keeps
 * a CSS-hidden login dialog and a hidden infant section in the DOM.
 */
function codeSelect(fcn: string, label: string, opts: Array<[string, string]>): string {
  return `<select formcontrolname="${fcn}" class="form-control">${[['', label] as [string, string], ...opts].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`;
}
function realPassengerRow(i: number): string {
  return `<app-passenger><div class="ui-g passenger-block" id="psgn-${i}">
    <p-autocomplete formcontrolname="passengerName" class="ng-pristine ng-invalid"><span class="ui-autocomplete ui-widget">
      <input type="text" class="ui-autocomplete-input ui-inputtext ui-widget" autocomplete="off" placeholder="Passenger Name" maxlength="16" aria-autocomplete="list"></span></p-autocomplete>
    <input type="number" formcontrolname="passengerAge" placeholder="Age" class="form-control" min="1" max="125">
    ${codeSelect('passengerGender', 'Gender', [['M', 'Male'], ['F', 'Female'], ['T', 'Transgender']])}
    ${codeSelect('passengerBerthChoice', 'No Preference', [['WS', 'Window Side']])}
    ${codeSelect('passengerFoodChoice', 'Food Choice', [['V', 'Veg'], ['N', 'Non Veg'], ['D', 'No Food']])}
  </div></app-passenger>`;
}
function realPassengerPage(rows: string): string {
  return `<style>.d-none{display:none!important}</style>
  <div class="d-none"><app-login><input type="text" formcontrolname="userid" placeholder="User Name"><input type="password" formcontrolname="password" placeholder="Password"></app-login></div>
  <div class="passenger-page"><h3>Passenger Details</h3><div class="train-summary">AMRITSAR SHTABDI (12014) | AC Chair car (CC) | GENERAL</div>
  <div class="passenger-rows">${rows}</div>
  <a href="#" class="add-passenger" role="button">+ Add Passenger</a>
  <div class="d-none infant-section"><input type="text" formcontrolname="infantName" placeholder="Name"><input type="number" placeholder="Age"></div>
  <div class="contact"><label for="mobileNumber">Mobile Number</label><input id="mobileNumber" formcontrolname="mobileNumber" aria-label="Mobile Number" value="+91 98XXXXXX10" readonly></div>
  <fieldset class="payment-mode"><legend>Payment Mode</legend>
    <label><input type="radio" name="paymentType" value="cards"> Pay through Credit &amp; Debit Cards / Net Banking / Wallets</label>
    <label><input type="radio" name="paymentType" value="upi"> Pay through BHIM/UPI</label></fieldset>
  <button type="submit" class="train_Search btnDefault" data-final="continue" onclick="this.ownerDocument.body.dataset.finalClicked='continue'">Continue</button></div>`;
}

const S = (id: string, title: string, expectPage: string, html: string): MockIrctcScenario => ({ id, title, expectPage, html });

export const MOCK_IRCTC_SCENARIOS: readonly MockIrctcScenario[] = Object.freeze([
  S('language-select', 'Language chooser dialog', 'LANGUAGE', `${header()}<div role="dialog" class="language-dialog" aria-label="Select Language"><h2>Select Language / भाषा चुनें</h2>
    <button type="button" data-lang="en">English</button><button type="button" data-lang="hi">हिंदी</button></div>${searchForm()}`),
  S('home-search', 'Home — Book Ticket form (native selects)', 'HOME_SEARCH', `${header()}${searchForm()}`),
  S('home-search-aria', 'Home — Book Ticket form (ARIA dropdowns)', 'HOME_SEARCH', `${header()}${searchForm({ aria: true })}`),
  S('home-no-language-selector', 'Home without any language selector', 'HOME_SEARCH', `${header(false)}${searchForm()}`),
  S('station-ambiguous', 'Station suggestions without the requested code', 'HOME_SEARCH', `${header()}${searchForm({ suggestions: ['AMRITSAR CANTT - XXX', 'DELHI SARAI ROHILLA - DEE'] })}`),
  S('login-required', 'Login dialog (user types User ID / Password / CAPTCHA)', 'LOGIN', `${header()}<div role="dialog" class="login-dialog" aria-label="LOGIN"><h2>LOGIN</h2>
    <input formcontrolname="userid" placeholder="User Name" aria-label="User Name" autocomplete="username">
    <input type="password" formcontrolname="password" placeholder="Password" aria-label="Password" autocomplete="current-password">
    <img alt="Captcha Image" class="captcha-img"><input id="captcha" formcontrolname="captcha" placeholder="Enter Captcha" aria-label="Enter Captcha">
    <button type="submit" class="search_btn">SIGN IN</button></div>`),
  S('train-list', 'Train list containing the booked train', 'TRAIN_LIST', `${header()}${trainList([
    { no: '12498', name: 'SHAN-E- PUNJAB', classes: ['AC Chair car (CC)', 'Second Sitting (2S)'] },
    { no: '12014', name: 'AMRITSAR SHTABDI', classes: ['AC Chair car (CC)', 'Exec. Chair Car (EC)'] }])}`),
  S('train-list-missing-train', 'Train list WITHOUT the booked train', 'TRAIN_LIST', `${header()}${trainList([
    { no: '12498', name: 'SHAN-E- PUNJAB', classes: ['AC Chair car (CC)', 'Second Sitting (2S)'] }])}`),
  S('passenger-single', 'Passenger form — 1 row', 'PASSENGER', passengerPage([passengerRow(1)])),
  S('passenger-multi', 'Passenger form — 4 rows', 'PASSENGER', passengerPage([1, 2, 3, 4].map(i => passengerRow(i)))),
  S('passenger-add-rows', 'Passenger form — 1 row + "+ Add Passenger"', 'PASSENGER', passengerPage([passengerRow(1)], { addLink: true })),
  S('passenger-no-food', 'Passenger form without Food Choice (no catering)', 'PASSENGER', passengerPage([passengerRow(1, { food: false })])),
  S('passenger-window-berth', 'Passenger form — chair car berth (Window Side)', 'PASSENGER', passengerPage([passengerRow(1, { berth: ['No Preference', 'Window Side'] })])),
  S('passenger-user-edited', 'Passenger form where the user already typed a different name', 'PASSENGER', passengerPage([passengerRow(1, { name: 'USER TYPED' })])),
  S('review-captcha', 'Review journey + CAPTCHA (user solves)', 'REVIEW_CAPTCHA', `<div class="review"><h3>Review Journey Details</h3><div>AMRITSAR SHTABDI (12014)</div>
    <img alt="Captcha Image" class="captcha-img"><input id="captcha" formcontrolname="captcha" placeholder="Enter Captcha" aria-label="Enter Captcha">
    <button type="submit" class="train_Search btnDefault" data-final="review-continue" onclick="this.ownerDocument.body.dataset.finalClicked='review-continue'">Continue</button></div>`),
  S('otp', 'OTP entry (user types OTP)', 'OTP', `<div class="otp"><h3>Verify OTP</h3><p>One Time Password (OTP) has been sent to your registered mobile.</p>
    <input id="otp" placeholder="Enter OTP" aria-label="Enter OTP" autocomplete="one-time-code"><button type="submit" data-final="otp-submit" onclick="this.ownerDocument.body.dataset.finalClicked='otp-submit'">Submit</button></div>`),
  S('payment', 'Payment page (user pays)', 'PAYMENT', `<div class="payment"><h3>Payment Methods</h3><div>Multiple Payment Service</div>
    <input placeholder="Card Number" aria-label="Card Number" autocomplete="cc-number"><input placeholder="CVV" aria-label="CVV">
    <button type="button" class="btn-primary" data-final="pay" onclick="this.ownerDocument.body.dataset.finalClicked='pay'">Pay &amp; Book</button></div>`),
  S('confirmation', 'IRCTC booking confirmation page (MOCK)', 'CONFIRMATION', `<div class="confirmation"><h2>Booking Confirmed</h2><p>Your ticket has been booked successfully. (MOCK page — nothing was booked.)</p></div>`),
  S('booking-failed', 'Booking failure page', 'FAILURE', `<div class="failure"><h2>Transaction Failed</h2><p>Booking failed. Any amount debited will be refunded. (MOCK)</p></div>`),
  S('session-expired', 'IRCTC session expired', 'SESSION_EXPIRED', `<div class="expired"><h2>Session Expired</h2><p>Your session has expired. Please login again.</p></div>`),
  S('irctc-home-defaults', 'Home — IRCTC defaults already filled (today\'s date, last searched stations)', 'HOME_SEARCH', `${header()}${searchForm({ values: { from: 'LUDHIANA JN - LDH', to: 'CHANDIGARH - CDG', date: '05/10/2026' } })}`),
  S('irctc-passenger-real', 'Passenger form — real IRCTC structure (p-autocomplete name, code-valued selects, hidden login + infant)', 'PASSENGER', realPassengerPage([1, 2].map(realPassengerRow).join(''))),
  S('irctc-passenger-late', 'Passenger form — 2nd row rendered late (Angular progressive render)', 'PASSENGER', `${realPassengerPage(realPassengerRow(1))}<script>setTimeout(function () {
    document.querySelector('.passenger-rows').insertAdjacentHTML('beforeend', ${JSON.stringify(realPassengerRow(2))}); }, 1500);</script>`)
]);

export function mockIrctcEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== 'production' && !env.RENDER;
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** Full HTML page for one scenario (or the index). The small inline script only emulates suggestion / dropdown lists. */
export function renderMockIrctc(id: string | null, opts: { train?: string } = {}): string {
  const found = id ? MOCK_IRCTC_SCENARIOS.find(x => x.id === id) : null;
  // optional ?train=NNNNN: the passenger / review summary shows that train (default 12014)
  const sc = found && opts.train && /^\d{5}$/.test(opts.train) && found.id !== 'train-list' && found.id !== 'train-list-missing-train'
    ? { ...found, html: found.html.split('AMRITSAR SHTABDI (12014)').join(`MOCK TRAIN (${opts.train})`) } : found;
  const nav = MOCK_IRCTC_SCENARIOS.map((x, i) => `<li><a href="/api/dev/mock-irctc/${x.id}">${i + 1}. ${esc(x.title)}</a> <code>${x.expectPage}</code></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MockIRCTC — ${esc(sc?.title || 'scenarios')}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:0 12px 40px}.mock-banner{background:#b91c1c;color:#fff;padding:8px 12px;margin:0 -12px 12px;font-weight:700}
input,select,.p-dropdown{display:block;margin:6px 0;padding:6px;min-width:240px}.p-dropdown{border:1px solid #999}.passenger-row{border:1px solid #ddd;padding:8px;margin:8px 0}
.train-block{border:1px solid #ccc;padding:8px;margin:8px 0}.pre-avl{display:inline-block;border:1px solid #aaa;padding:4px 8px;margin:4px}button{padding:8px 16px;margin:6px 0}</style></head>
<body data-mock-irctc="${sc ? sc.id : 'index'}"><div class="mock-banner" data-mock-banner>MOCK IRCTC — development only. Nothing here books a ticket or takes payment.</div>
${sc ? sc.html : `<h1>MockIRCTC scenarios</h1><ol style="list-style:none;padding:0">${nav}</ol>`}
<script>
document.addEventListener('input',function(e){var t=e.target;if(!t||!t.id)return;var l=document.querySelector('ul[data-for="'+t.id+'"]');if(!l)return;l.hidden=!t.value;
  Array.prototype.forEach.call(l.children,function(li){li.hidden=t.value&&li.textContent.toUpperCase().indexOf(String(t.value).toUpperCase())<0;});});
document.addEventListener('click',function(e){var li=e.target.closest&&e.target.closest('li[role="option"]');if(li){var l=li.parentElement;
  if(l.dataset.for){document.getElementById(l.dataset.for).value=li.textContent;l.hidden=true;return;}
  var dd=l.closest('.p-dropdown');if(dd){dd.querySelector('.p-dropdown-label').textContent=li.textContent;l.hidden=true;dd.setAttribute('aria-expanded','false');e.stopPropagation();return;}}
  var d=e.target.closest&&e.target.closest('.p-dropdown');if(d){var u=d.querySelector('ul');u.hidden=!u.hidden;d.setAttribute('aria-expanded',String(!u.hidden));}
  var a=e.target.closest&&e.target.closest('.add-passenger');if(a){e.preventDefault();var rows=document.querySelector('.passenger-rows');var n=rows.children.length+1;
  var c=rows.children[0].cloneNode(true);c.dataset.passengerRow=n;c.querySelector('span').textContent='Passenger '+n;Array.prototype.forEach.call(c.querySelectorAll('input'),function(i){i.value='';});rows.appendChild(c);}
});
</script></body></html>`;
}
