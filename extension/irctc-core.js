/*
 * BookKaro IRCTC Assist — pure page logic (UMD: browser global `BookKaroIrctcCore`, CommonJS for tests).
 *
 * SAFETY CONTRACT (enforced here, tested in tests/unit/p39-irctc-handoff.test.ts):
 *  - Only VISIBLE, normal page controls are used. No private APIs, no network calls, no cookies / storage access.
 *  - Never touches a password / OTP / CAPTCHA / card / CVV / UPI / PIN / bank / login / mobile / email field.
 *  - Never clicks the final Book / Continue / Pay control — it is only highlighted for the USER to tap.
 *  - Never overwrites a value the user typed or changed (user overrides win; the assistant pauses).
 *  - Every filled value is read back; a value that did not stick is reported as IRCTC_FIELD_NOT_CONFIRMED.
 *  - Reports contain field KEYS and reasons only — never field values.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BookKaroIrctcCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORBIDDEN = /pass(word|wd)|\botp\b|one.?time|captcha|cvv|cvc|card|upi|\bpin\b|vpa|bank|ifsc|account|cookie|token|secret|user ?name|userid|user id|login|sign ?in|mobile|phone|email|e-mail|payment|gst|address/i;

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function lower(s) { return norm(s).toLowerCase(); }

  function isVisible(el) {
    var win = el && el.ownerDocument && el.ownerDocument.defaultView;
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
      var st = n.style;
      if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
      // CSS-class hidden (real IRCTC hides dialogs / templates with stylesheet rules, not inline styles)
      if (win && win.getComputedStyle) {
        try { var cs = win.getComputedStyle(n); if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false; } catch (e) { /* ignore */ }
      }
    }
    return true;
  }

  function labelText(el) {
    var doc = el.ownerDocument, out = '';
    if (el.id) { try { var l = doc.querySelector('label[for="' + el.id.replace(/"/g, '') + '"]'); if (l) out += ' ' + l.textContent; } catch (e) { /* ignore */ } }
    var c = el.closest ? el.closest('label') : null;
    if (c) out += ' ' + c.textContent;
    return out;
  }

  /** formcontrolname of a wrapping component that holds exactly this one input (IRCTC: <p-autocomplete formcontrolname="passengerName">). */
  function wrapperControlName(el) {
    if (el.getAttribute('formcontrolname') || !el.parentElement || !el.parentElement.closest) return '';
    var w = el.parentElement.closest('[formcontrolname]');
    if (!w || w.tagName === 'FORM' || w.querySelectorAll('input, select').length !== 1) return '';
    // P39.3: the component's id too (real IRCTC: <p-autocomplete id="origin">, <p-calendar id="jDate">)
    return (w.getAttribute('formcontrolname') || '') + (w.id ? ' ' + w.id : '');
  }

  /** P39.3: floating label of a single-control field container (IRCTC mobile: <label>DD/MM/YYYY *</label> beside the input). */
  function nearbyLabel(el) {
    var n = el.parentElement;
    for (var depth = 0; n && depth < 4; depth++, n = n.parentElement) {
      if (n.tagName === 'FORM' || n.querySelectorAll('input, select, textarea').length !== 1) break;
      var labs = n.querySelectorAll('label');
      if (labs.length) return Array.prototype.map.call(labs, function (l) { return l.textContent; }).join(' ');
    }
    return '';
  }

  /** Semantic descriptor of a control: attributes + label (lower-case). */
  function descriptor(el) {
    var a = ['id', 'name', 'placeholder', 'aria-label', 'autocomplete', 'formcontrolname', 'title', 'type'];
    var parts = [];
    for (var i = 0; i < a.length; i++) { var v = el.getAttribute(a[i]); if (v) parts.push(v); }
    var w = wrapperControlName(el);
    if (w) parts.push(w);
    parts.push(labelText(el));
    parts.push(nearbyLabel(el));
    return lower(parts.join(' '));
  }

  function isForbidden(el) {
    if (!el) return true;
    var t = lower(el.getAttribute('type'));
    if (t === 'password' || t === 'hidden' || t === 'radio' || t === 'checkbox' || t === 'file') return true;
    return FORBIDDEN.test(descriptor(el));
  }

  function all(doc, sel) { return Array.prototype.slice.call(doc.querySelectorAll(sel)); }
  function visibleAll(doc, sel) { return all(doc, sel).filter(isVisible); }
  function controlText(el) { return norm(el.textContent || el.value || el.getAttribute('aria-label')); }

  function isPassengerNameInput(el) {
    if (isForbidden(el)) return false;
    var d = descriptor(el);
    if (/infant|child below|nominee/.test(d)) return false;
    var ph = lower(el.getAttribute('placeholder'));
    return /passenger ?name|passengername/.test(d) || /^(passenger )?name\b/.test(ph) || /^full name\b|name as per (govt|id)/.test(ph);
  }

  function passengerNameInputs(doc) {
    return visibleAll(doc, 'input').filter(isPassengerNameInput);
  }

  function findStationInput(doc, which) {
    var inputs = visibleAll(doc, 'input').filter(function (el) { return !isForbidden(el); });
    var from = inputs.filter(function (el) { return /\bfrom\b|origin|source/.test(descriptor(el)); })[0] || null;
    if (which === 'from') return from;
    return inputs.filter(function (el) { return el !== from && /\bto\b|destination/.test(descriptor(el)); })[0] || null;
  }

  function findDateInput(doc) {
    return visibleAll(doc, 'input').filter(function (el) { return !isForbidden(el) && /journey ?date|dd\/mm\/yyyy|jdate|\bdate\b/.test(descriptor(el)); })[0] || null;
  }

  /** Native <select> or ARIA combobox (role=combobox, not an input) whose descriptor matches. */
  function findChoice(scope, re) {
    var c = visibleAll(scope, 'select, [role="combobox"], p-dropdown').filter(function (el) {
      if (el.tagName === 'INPUT' || isForbidden(el) || !re.test(descriptor(el))) return false;
      if (el.tagName === 'SELECT' && el.closest && el.closest('p-dropdown, .ui-dropdown, .p-dropdown, .ui-helper-hidden-accessible, .p-hidden-accessible')) return false;
      if (el.tagName !== 'P-DROPDOWN' && el.closest && el.parentElement && el.parentElement.closest('p-dropdown')) return false;   // use the host
      return true;
    });
    return c[0] || null;
  }

  /** P39.3: PrimeNG dropdown host (real IRCTC class / quota) — options render asynchronously after opening. */
  function isPrimeDropdown(el) { return !!el && el.tagName !== 'SELECT' && (el.tagName === 'P-DROPDOWN' || !!el.querySelector('.ui-dropdown, .p-dropdown-trigger, .ui-dropdown-trigger')); }

  var LANGUAGE_PROMPT = /select language|choose language|select your preferred language|preferred language|भाषा चुनें|भाषा का चयन/i;
  function findLanguageDialog(doc) {
    var c = visibleAll(doc, '[role="dialog"], [role="alertdialog"], .language-dialog, .ui-dialog, .p-dialog, p-dialog, .modal, .modal-dialog')
      .filter(function (d) { return LANGUAGE_PROMPT.test(d.textContent || '') && hasBothLanguageButtons(d); });
    return c[c.length - 1] || null;   // innermost match
  }
  function langButtons(scope, lang) {
    var re = lang === 'hi' ? /^(हिंदी|हिन्दी|hindi)$/i : /^(english|अंग्रेज़ी|अंग्रेजी)$/i;
    return visibleAll(scope, 'button, a, [role="button"]').filter(function (el) { return re.test(norm(el.textContent)); });
  }
  function hasBothLanguageButtons(scope) { return langButtons(scope, 'hi').length > 0 && langButtons(scope, 'en').length > 0; }

  /** Language control — inside the language dialog when one is open (never a random header link then). */
  function findLanguageControl(doc, lang) {
    var dlg = findLanguageDialog(doc);
    return langButtons(dlg || doc, lang)[0] || null;
  }

  function buttons(doc) { return visibleAll(doc, 'button, a, [role="button"], input[type="submit"], input[type="button"]'); }

  /** Page kind from VISIBLE content only. */
  function detectPage(doc) {
    if (!doc || !doc.body) return 'UNKNOWN';
    var text = norm(doc.body.textContent);
    var inputs = visibleAll(doc, 'input');
    if (/booking confirmed|ticket has been booked|booked successfully/i.test(text) && !/failed/i.test(text)) return 'CONFIRMATION';
    if (/transaction failed|booking failed|payment failed/i.test(text)) return 'FAILURE';
    if (/session (has )?expired|session timed? ?out/i.test(text)) return 'SESSION_EXPIRED';
    if (inputs.some(function (i) { return lower(i.getAttribute('type')) === 'password'; })) return 'LOGIN';
    if (inputs.some(function (i) { return /\botp\b|one.?time/.test(descriptor(i)); })) return 'OTP';
    if (inputs.some(function (i) { return /captcha/.test(descriptor(i)); })) return 'REVIEW_CAPTCHA';
    if (passengerNameInputs(doc).length) return 'PASSENGER';
    if (/payment methods|pay & book|make payment/i.test(text) || inputs.some(function (i) { return /card number|cc-number/.test(descriptor(i)); })) return 'PAYMENT';
    if (findLanguageDialog(doc)) return 'LANGUAGE';
    // P39.3: the real train-list page also shows a "modify search" From / To form → list signals win
    if (buttons(doc).some(function (b) { return /^book now$/i.test(controlText(b)); }) && /\(\d{5}\)/.test(text)) return 'TRAIN_LIST';
    if (visibleAll(doc, 'app-train-avl-enq').length && /\(\d{5}\)/.test(text)) return 'TRAIN_LIST';   // real list before a class is tapped
    if (findStationInput(doc, 'from') && findStationInput(doc, 'to')) return 'HOME_SEARCH';
    return pageFromUrl(doc);
  }

  /** IRCTC route names (www.irctc.co.in/nget/...) — used only when the DOM did not decide. */
  function pageFromUrl(doc) {
    var path = '';
    try { path = lower((doc.defaultView && doc.defaultView.location && doc.defaultView.location.pathname) || ''); } catch (e) { path = ''; }
    if (!/\/nget\//.test(path)) return 'UNKNOWN';
    if (/psgninput|pax-?info|passenger/.test(path)) return 'PASSENGER';
    if (/train-list/.test(path)) return 'TRAIN_LIST';
    if (/train-search/.test(path)) return 'HOME_SEARCH';
    return 'UNKNOWN';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // value setting (framework-friendly: native setter + input/change events)

  function setNativeValue(el, value) {
    var proto = Object.getPrototypeOf(el);
    var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    var win = el.ownerDocument.defaultView;
    var Ev = (win && win.Event) || Event;
    el.dispatchEvent(new Ev('input', { bubbles: true }));
    el.dispatchEvent(new Ev('change', { bubbles: true }));
  }

  function optionMatch(text, target, code) {
    var t = lower(text), g = lower(target);
    if (t === g) return 3;
    if (code && new RegExp('\\(' + String(code).replace(/[^A-Za-z0-9]/g, '') + '\\)', 'i').test(text)) return 2;
    return 0;
  }

  function currentChoice(el) {
    if (el.tagName === 'SELECT') {
      var o = Array.prototype.filter.call(el.options, function (x) { return x.selected; })[0] || el.options[el.selectedIndex];
      return o ? { value: o.value, text: norm(o.textContent) } : { value: '', text: '' };
    }
    var lab = el.querySelector('.p-dropdown-label, [class*="label"]');
    return { value: norm(lab ? lab.textContent : el.textContent), text: norm(lab ? lab.textContent : el.textContent) };
  }

  /** Choose an option by visible text (exact label, else "(CODE)"). Returns 'OK' | reason. Never a final control. */
  function choose(el, target, code) {
    if (el.tagName === 'SELECT') {
      var best = null, score = 0;
      for (var i = 0; i < el.options.length; i++) { var s = optionMatch(el.options[i].textContent, target, code); if (s > score) { score = s; best = el.options[i]; } }
      if (!best) return 'OPTION_NOT_FOUND';
      if (!best.selected || el.value !== best.value) {
        var proto = Object.getPrototypeOf(el); var d = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && d.set) d.set.call(el, best.value); else el.value = best.value;
        best.selected = true;
        var Ev = (el.ownerDocument.defaultView && el.ownerDocument.defaultView.Event) || Event;
        el.dispatchEvent(new Ev('input', { bubbles: true })); el.dispatchEvent(new Ev('change', { bubbles: true }));
      }
      return optionMatch(currentChoice(el).text, target, code) ? 'OK' : 'VALUE_NOT_CONFIRMED';
    }
    // ARIA combobox: open it, click the matching option, read the label back
    el.click();
    var list = el.querySelector('[role="listbox"]') || (el.getAttribute('aria-controls') && el.ownerDocument.getElementById(el.getAttribute('aria-controls')));
    var opts = list ? Array.prototype.slice.call(list.querySelectorAll('[role="option"]')) : [];
    var hit = null, sc = 0;
    opts.forEach(function (o) { var s2 = optionMatch(o.textContent, target, code); if (s2 > sc) { sc = s2; hit = o; } });
    if (!hit) { if (list) list.hidden = true; return 'OPTION_NOT_FOUND'; }
    if (list && list.hidden) list.hidden = false;
    hit.click();
    if (list) list.hidden = true;
    return optionMatch(currentChoice(el).text, target, code) ? 'OK' : 'VALUE_NOT_CONFIRMED';
  }

  /** Station suggestion item ending in "- CODE" (IRCTC autocomplete style). Exact code only — never "the first item".
   *  P39.3: when `input` is given, its own suggestion panel (aria-controls / aria-owns / PrimeNG host) is searched first. */
  function findSuggestion(doc, code, input) {
    var re = new RegExp('-\\s*' + String(code).replace(/[^A-Z0-9]/gi, '') + '(\\s|\\)|$)');
    var SEL = 'li[role="option"], .ui-autocomplete-list-item, .p-autocomplete-item, [role="listbox"] [role="option"]';
    var pick = function (scope) { return visibleAll(scope, SEL).filter(function (li) { return re.test(norm(li.textContent)); })[0] || null; };
    if (input) {
      var id = input.getAttribute('aria-controls') || input.getAttribute('aria-owns');
      var own = id && doc.getElementById(id);
      var host = input.closest && input.closest('p-autocomplete, .ui-autocomplete, .p-autocomplete');
      var hit = (own && pick(own)) || (host && pick(host));
      if (hit) return hit;
    }
    return pick(doc);
  }

  /** P39.3: dispatch a DOM event the way a user interaction would (focus / key / input events for Angular + PrimeNG). */
  function fire(el, type, init) {
    var win = el.ownerDocument.defaultView;
    var C = (/^key/.test(type) && win && win.KeyboardEvent) || (/^focus|blur/.test(type) && win && win.FocusEvent) || (win && win.Event) || Event;
    el.dispatchEvent(new C(type, init || { bubbles: true }));
  }

  /** P39.3: options of an opened PrimeNG dropdown (panel inside the host; or the single visible panel appended to body). */
  function primeOptions(doc, host) {
    var SEL = 'li[role="option"], .ui-dropdown-item, .p-dropdown-item';
    var own = visibleAll(host, SEL);
    if (own.length) return own;
    var panels = visibleAll(doc, '.ui-dropdown-panel, .p-dropdown-panel, [role="listbox"]').filter(function (pn) { return !host.contains(pn); });
    return panels.length === 1 ? visibleAll(panels[0], SEL) : [];   // never guess between two open panels
  }

  /** P39.3: PrimeNG ≤8 / 9+ dropdown — open, wait for the async options, click the exact label / "(CODE)", verify the label. */
  async function choosePrime(doc, el, target, code, opts) {
    var trig = el.querySelector('.ui-dropdown-trigger, .p-dropdown-trigger, [role="button"]') || el.querySelector('.ui-dropdown, .p-dropdown') || el;
    trig.click();                                                     // bubbles to the dropdown container (PrimeNG opens on container click)
    var hit = null, sc = 0;
    for (var i = 0; i < 12 && !hit; i++) {
      primeOptions(doc, el).forEach(function (o) { var t = o.getAttribute('aria-label') || o.textContent; var s2 = optionMatch(t, target, code); if (s2 > sc) { sc = s2; hit = o; } });
      if (!hit) await wait(opts, 150);
    }
    if (!hit) { if (primeOptions(doc, el).length) trig.click(); return 'OPTION_NOT_FOUND'; }   // close the panel again
    hit.click();
    for (var v = 0; v < 6; v++) { if (optionMatch(currentChoice(el).text, target, code)) return 'OK'; await wait(opts, 100); }
    return 'VALUE_NOT_CONFIRMED';
  }

  // ---------------------------------------------------------------------------------------------------------------
  // fill engine

  function newState() { return { filled: new WeakMap(), userEdited: new WeakSet() }; }

  /** The user's own value wins: an edited control, or a pre-existing value we did not put there. */
  function userOwned(el, state, target, code) {
    if (state.userEdited.has(el)) return true;
    if (state.pageDefaultsReplaceable) return false;   // journey page: untouched values are IRCTC defaults
    var mine = state.filled.get(el);
    if (el.tagName === 'SELECT' || el.getAttribute('role') === 'combobox' || isPrimeDropdown(el)) {
      var cur = currentChoice(el);
      if (mine !== undefined && cur.text === mine) return false;
      if (!cur.value || /^(gender|food choice|no preference|all classes|select)/i.test(cur.text)) return false;
      return !optionMatch(cur.text, target, code);
    }
    var v = norm(el.value);
    if (!v || (mine !== undefined && v === mine)) return false;
    return lower(v) !== lower(target);
  }

  function Report(page) { this.page = page; this.filled = []; this.skipped = []; this.overrides = []; this.finalControl = null; this.located = []; this.raw = []; this.curPax = null; this.errors = []; }
  Report.prototype.ok = function (f) { if (this.filled.indexOf(f) < 0) this.filled.push(f); };
  Report.prototype.unok = function (f) { var i = this.filled.indexOf(f); if (i >= 0) this.filled.splice(i, 1); };
  Report.prototype.skip = function (f, reason) {
    this.raw.push({ field: f, reason: reason, passengerIndex: this.curPax });   // P39.3: per-passenger, for typed errors
    if (!this.skipped.some(function (s) { return s.field === f && s.reason === reason; })) this.skipped.push({ field: f, reason: reason });
  };
  Report.prototype.override = function (f) { if (this.overrides.indexOf(f) < 0) this.overrides.push(f); };

  function fillText(el, field, value, state, rep) {
    if (!el) { rep.skip(field, 'FIELD_NOT_PRESENT'); return false; }
    if (isForbidden(el)) { rep.skip(field, 'FIELD_FORBIDDEN'); return false; }
    if (userOwned(el, state, value)) { rep.override(field); return false; }
    if (el.maxLength > 0 && String(value).length > el.maxLength) { rep.skip(field, 'VALUE_TOO_LONG'); return false; }   // never truncated
    if (norm(el.value) !== String(value)) {
      setNativeValue(el, String(value));
      var Ev = (el.ownerDocument.defaultView && el.ownerDocument.defaultView.Event) || Event;
      el.dispatchEvent(new Ev('blur', { bubbles: false })); el.dispatchEvent(new Ev('focusout', { bubbles: true }));
    }
    if (norm(el.value) !== String(value)) { rep.skip(field, 'VALUE_NOT_CONFIRMED'); return false; }
    state.filled.set(el, String(value)); rep.ok(field); return true;
  }

  function fillChoice(el, field, label, code, state, rep) {
    if (!el) { rep.skip(field, 'FIELD_NOT_PRESENT'); return false; }
    if (isForbidden(el)) { rep.skip(field, 'FIELD_FORBIDDEN'); return false; }
    if (!label && !code) { rep.skip(field, 'NOT_REPRESENTABLE'); return false; }
    if (userOwned(el, state, label || '', code)) { rep.override(field); return false; }
    var r = choose(el, label || '', code);
    if (r !== 'OK') { rep.skip(field, r); return false; }
    state.filled.set(el, currentChoice(el).text); rep.ok(field); return true;
  }

  /** P39.3: like fillChoice, but PrimeNG dropdowns (real IRCTC class / quota) go through the async open → pick → verify flow. */
  async function fillChoiceAsync(doc, el, field, label, code, state, rep, opts) {
    if (!el || !isPrimeDropdown(el)) return fillChoice(el, field, label, code, state, rep);
    if (isForbidden(el)) { rep.skip(field, 'FIELD_FORBIDDEN'); return false; }
    if (!label && !code) { rep.skip(field, 'NOT_REPRESENTABLE'); return false; }
    if (userOwned(el, state, label || '', code)) { rep.override(field); return false; }
    var r = optionMatch(currentChoice(el).text, label || '', code) ? 'OK' : await choosePrime(doc, el, label || '', code, opts);
    if (r !== 'OK') { rep.skip(field, r); return false; }
    state.filled.set(el, currentChoice(el).text); rep.ok(field); return true;
  }

  function wait(opts, ms) { return opts && opts.wait ? opts.wait(ms) : new Promise(function (r) { setTimeout(r, ms); }); }

  async function fillStation(doc, el, field, ref, state, rep, opts) {
    if (!el) { rep.skip(field, 'FIELD_NOT_PRESENT'); return; }
    if (isForbidden(el)) { rep.skip(field, 'FIELD_FORBIDDEN'); return; }
    var re = new RegExp('-\\s*' + ref.code + '(\\s|\\)|$)');
    if (re.test(norm(el.value)) && !state.userEdited.has(el)) { state.filled.set(el, norm(el.value)); rep.ok(field); return; }
    if (userOwned(el, state, ref.code)) { rep.override(field); return; }
    // focus → keydown → value + input/change → keyup: what Angular forms + PrimeNG autocomplete listen to (no blur: it closes the panel)
    if (el.focus) { try { el.focus(); } catch (e) { /* ignore */ } }
    if (doc.activeElement !== el) { fire(el, 'focus', { bubbles: false }); fire(el, 'focusin'); }   // focus() did not take (background tab)
    var lastKey = String(ref.query).slice(-1);
    fire(el, 'keydown', { bubbles: true, key: lastKey });
    setNativeValue(el, ref.query);
    fire(el, 'keyup', { bubbles: true, key: lastKey });
    var sug = null;
    for (var i = 0; i < 12 && !sug; i++) { sug = findSuggestion(doc, ref.code, el); if (!sug) await wait(opts, 250); }   // async suggestions (~300 ms debounce)
    if (!sug) { rep.skip(field, 'STATION_SUGGESTION_NOT_FOUND'); return; }   // no guess: nothing else is ever picked
    sug.click();
    var ok = false;
    for (var v = 0; v < 6 && !ok; v++) { await wait(opts, v ? 200 : 50); ok = re.test(norm(el.value)); }
    if (ok) { await wait(opts, 300); ok = re.test(norm(el.value)); }   // still the chosen station after the page's own validation settled?
    if (!ok) { rep.skip(field, 'VALUE_NOT_CONFIRMED'); return; }
    state.filled.set(el, norm(el.value)); rep.ok(field);
  }

  function rowContainer(nameInput) {
    var n = nameInput.parentElement;
    while (n && n.parentElement) {
      var names = Array.prototype.slice.call(n.querySelectorAll('input')).filter(isPassengerNameInput);
      if (names.length > 1) return null;
      if (Array.prototype.slice.call(n.querySelectorAll('input')).some(function (i) { return /\bage\b|passengerage/.test(descriptor(i)); })) return n;
      n = n.parentElement;
    }
    return null;
  }

  function findAddPassengerControl(doc) {
    return buttons(doc).filter(function (b) { return /^\+?\s*add passenger/i.test(controlText(b)); })[0] || null;
  }

  function findFinalControl(doc, page, snapshot) {
    var b = buttons(doc);
    var pick = function (re) { return b.filter(function (x) { return re.test(controlText(x)); })[0] || null; };
    if (page === 'PASSENGER' || page === 'REVIEW_CAPTCHA') return pick(/^continue$/i);
    if (page === 'HOME_SEARCH') return pick(/^(search|find trains|खोजें)$/i);   // highlighted only — the user taps Search
    if (page === 'PAYMENT') return pick(/pay\s*&\s*book|make payment|^pay$/i);
    if (page === 'OTP') return pick(/^(submit|verify|confirm)$/i);
    if (page === 'TRAIN_LIST' && snapshot) { var blk = trainBlock(doc, snapshot.train.number); return blk ? blk.book : null; }
    return null;
  }

  /** 5-digit train numbers shown as "(12345)" in the page text (the assistant's closed shadow UI is not included). */
  function pageTrainNumbers(doc) {
    var m = ((doc.body && doc.body.textContent) || '').match(/\((\d{5})\)/g) || [];
    var out = [];
    m.forEach(function (x) { var n = x.slice(1, 6); if (out.indexOf(n) < 0) out.push(n); });
    return out;
  }

  function trainBlock(doc, number) {
    var re = new RegExp('\\(' + number + '\\)');
    var books = buttons(doc).filter(function (x) { return /^book now$/i.test(controlText(x)); });
    for (var i = 0; i < books.length; i++) {
      for (var n = books[i].parentElement; n; n = n.parentElement) {
        var txt = n.textContent || '';
        var trainNos = txt.match(/\(\d{5}\)/g) || [];
        if (trainNos.length > 1) break;           // grew past one train's block
        if (re.test(txt)) return { block: n, book: books[i] };
      }
    }
    // P39.3: real list before a class / date is chosen has no "Book Now" — anchor on the train heading instead
    var heads = all(doc, 'body *').filter(function (e) { return e.children.length === 0 && !/^(SCRIPT|STYLE|TEMPLATE)$/.test(e.tagName) && re.test(e.textContent || '') && isVisible(e); });
    for (var h = 0; h < heads.length; h++) {
      var top = null;
      for (var m = heads[h].parentElement; m && m !== doc.body; m = m.parentElement) {
        var nos = (m.textContent || '').match(/\(\d{5}\)/g) || [];
        if (nos.some(function (x) { return x !== '(' + number + ')'; })) break;
        top = m;
      }
      if (top) return { block: top, book: null };
    }
    return null;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** P39.3: the availability cell for the handoff date ("06 Oct") inside the train block — highlighted only, never clicked. */
  function findDateCell(block, dateIso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso || '');
    if (!m) return null;
    var re = new RegExp('(^|\\D)' + m[3] + ' ' + MONTHS[Number(m[2]) - 1] + '(\\D|$)', 'i');
    return all(block, '*').filter(function (e) { return e.children.length === 0 && re.test(norm(e.textContent)); })[0] || null;
  }

  /** Highlight only — NEVER clicks. */
  function highlight(el, label, noScroll) {
    if (!el) return;
    el.setAttribute('data-bookkaro-highlight', label || 'final');
    el.style.outline = '4px solid #f59e0b';
    el.style.outlineOffset = '3px';
    if (!noScroll && el.scrollIntoView) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ } }
  }

  /**
   * Fill the supported fields of the current page from the snapshot. Async (station suggestions appear after typing).
   * opts: { wait(ms) → Promise, allowAddRows: boolean }
   */
  var FIELD_ERROR = { from: 'FROM_STATION_AUTOFILL_FAILED', to: 'TO_STATION_AUTOFILL_FAILED', date: 'DATE_AUTOFILL_FAILED', travelClass: 'CLASS_AUTOFILL_FAILED',
    quota: 'QUOTA_AUTOFILL_FAILED', train: 'TRAIN_AUTOFILL_FAILED' };
  /** P39.3: typed errors (code + field + passengerIndex + reason; never values). NOT_REPRESENTABLE is known up-front, not an error. */
  function typedErrors(rep) {
    return rep.raw.filter(function (r) { return r.reason !== 'NOT_REPRESENTABLE'; }).map(function (r) {
      var code = /^passenger/.test(r.field) ? (r.reason === 'ROW_MISSING' ? 'PASSENGER_ROW_MISSING' : 'PASSENGER_FIELD_REJECTED') : (FIELD_ERROR[r.field] || 'AUTOFILL_FAILED');
      var e = { code: code, field: r.field, reason: r.reason };
      if (r.passengerIndex) e.passengerIndex = r.passengerIndex;
      return e;
    });
  }

  async function fillPage(doc, page, snapshot, state, opts) {
    var rep = await fillPageInner(doc, page, snapshot, state, opts);
    rep.errors = typedErrors(rep);
    var stop = rep.errors.filter(function (e) { return e.code === 'FROM_STATION_AUTOFILL_FAILED' || e.code === 'TO_STATION_AUTOFILL_FAILED' || e.code === 'DATE_AUTOFILL_FAILED'; })[0];
    if (page === 'HOME_SEARCH' && stop) { rep.stopped = stop.code; rep.finalControl = null; }   // never point at Search with a wrong / unverified journey
    return rep;
  }

  async function fillPageInner(doc, page, snapshot, state, opts) {
    var rep = new Report(page);
    state = state || newState();
    if (page === 'HOME_SEARCH') {
      state.pageDefaultsReplaceable = true;
      try {
      await fillStation(doc, findStationInput(doc, 'from'), 'from', snapshot.journey.from, state, rep, opts);
      await fillStation(doc, findStationInput(doc, 'to'), 'to', snapshot.journey.to, state, rep, opts);
      var dateEl = findDateInput(doc);
      // PrimeNG Calendar (IRCTC p-calendar) only parses typed input that follows a keydown (its `isKeydown` guard)
      if (dateEl && !isForbidden(dateEl) && norm(dateEl.value) !== snapshot.journey.dateIrctc) fire(dateEl, 'keydown', { bubbles: true, key: 'Unidentified' });
      if (fillText(dateEl, 'date', snapshot.journey.dateIrctc, state, rep)) {
        await wait(opts, 150);                                        // let the date picker parse / re-format, then read back
        if (norm(dateEl.value) !== snapshot.journey.dateIrctc) { rep.unok('date'); rep.skip('date', 'VALUE_CHANGED_BY_PAGE'); }
      }
      await fillChoiceAsync(doc, findChoice(doc, /class/), 'travelClass', snapshot.travelClass.label, snapshot.travelClass.code, state, rep, opts);
      await fillChoiceAsync(doc, findChoice(doc, /quota/), 'quota', snapshot.quota.label, null, state, rep, opts);
      } finally { state.pageDefaultsReplaceable = false; }
      // the Search button is highlighted for the user, never clicked (they check what was filled first)
      rep.finalControl = findFinalControl(doc, 'HOME_SEARCH');
      return rep;
    }
    if (page === 'TRAIN_LIST') {
      var tb = trainBlock(doc, snapshot.train.number);
      if (!tb) { rep.skip('train', 'TRAIN_NOT_IN_LIST'); return rep; }
      highlight(tb.block, 'train'); rep.ok('train');
      var leaves = Array.prototype.slice.call(tb.block.querySelectorAll('*')).filter(function (e) { return e.children.length === 0; });
      var code = snapshot.travelClass.code;
      var cls = leaves.filter(function (e) { return new RegExp('\\(' + code + '\\)').test(e.textContent || ''); })[0]
        || leaves.filter(function (e) { return norm(e.textContent) === code; })[0];   // P39.3: class tabs "SL 3E 3A" (bare code)
      if (cls) { highlight(cls.parentElement || cls, 'class', true); rep.ok('travelClass'); } else rep.skip('travelClass', 'CLASS_NOT_IN_TRAIN');
      var cell = findDateCell(tb.block, snapshot.journey.dateIso);
      if (cell) highlight(cell.parentElement || cell, 'date', true);  // guidance only — the user taps it
      rep.finalControl = tb.book;   // "Book Now" — highlighted by the caller, tapped by the user (null until IRCTC shows it)
      return rep;
    }
    if (page === 'PASSENGER') {
      // the passenger page must belong to the reviewed train — a different train is never silently prefilled
      var shown = pageTrainNumbers(doc);
      if (shown.length && shown.indexOf(snapshot.train.number) < 0 && !state.trainMismatchAccepted) {
        rep.skip('train', 'TRAIN_DIFFERENT_ON_PAGE'); rep.trainOnPage = shown[0];
        return rep;
      }
      var pax = snapshot.passengers || [];
      var names = passengerNameInputs(doc);
      if (names.length < pax.length && opts && opts.allowAddRows) {
        var add = findAddPassengerControl(doc);
        for (var k = names.length; add && k < pax.length; k++) { add.click(); await wait(opts, 150); }
        names = passengerNameInputs(doc);
      }
      var touched = [];   // P39.3: [{ el, field, index }] → re-read after the page had time to validate
      for (var p = 0; p < pax.length; p++) {
        var P = pax[p];
        rep.curPax = p + 1;
        var nameEl = names[p];
        if (!nameEl) { ['passengerName', 'passengerAge', 'passengerGender'].forEach(function (f) { rep.skip(f, 'ROW_MISSING'); }); continue; }   // typed: PASSENGER_ROW_MISSING #index
        var row = rowContainer(nameEl) || nameEl.parentElement;
        if (fillText(nameEl, 'passengerName', P.name, state, rep)) touched.push({ el: nameEl, field: 'passengerName', index: p + 1 });
        var ageEl = Array.prototype.slice.call(row.querySelectorAll('input')).filter(function (i) { return /\bage\b|passengerage/.test(descriptor(i)) && !isForbidden(i); })[0];
        if (fillText(ageEl, 'passengerAge', P.age, state, rep)) touched.push({ el: ageEl, field: 'passengerAge', index: p + 1 });
        var gEl = findChoice(row, /gender/), bEl = findChoice(row, /berth/), fEl = findChoice(row, /food|meal|catering/);
        if (P.gender) { if (await fillChoiceAsync(doc, gEl, 'passengerGender', P.gender, null, state, rep, opts)) touched.push({ el: gEl, field: 'passengerGender', index: p + 1 }); } else rep.skip('passengerGender', 'NOT_REPRESENTABLE');
        if (P.berth && await fillChoiceAsync(doc, bEl, 'passengerBerth', P.berth, null, state, rep, opts)) touched.push({ el: bEl, field: 'passengerBerth', index: p + 1 });
        if (P.food && await fillChoiceAsync(doc, fEl, 'passengerFood', P.food, null, state, rep, opts)) touched.push({ el: fEl, field: 'passengerFood', index: p + 1 });
      }
      rep.curPax = null;
      // P39.3 verification: re-read every control we set; a value the page rejected / changed is reported, never assumed
      if (touched.length) await wait(opts, 200);
      touched.forEach(function (t) {
        var now = (t.el.tagName === 'SELECT' || isPrimeDropdown(t.el)) ? currentChoice(t.el).text : norm(t.el.value);
        if (now !== state.filled.get(t.el)) { rep.curPax = t.index; rep.skip(t.field, 'VALUE_REJECTED_BY_PAGE'); rep.curPax = null; }
      });
      rep.finalControl = findFinalControl(doc, 'PASSENGER');
      return rep;
    }
    rep.finalControl = findFinalControl(doc, page, snapshot);
    return rep;
  }

  /** Events for the backend — field keys + reasons only (never values). */
  function reportEvents(rep) {
    var ev = [{ type: 'FIELDS_FILLED', page: rep.page, filled: rep.filled.slice(), skipped: rep.skipped.map(function (s) { return { field: s.field, reason: s.reason }; }) }];
    rep.overrides.forEach(function (f) { ev.push({ type: 'USER_OVERRIDE', field: f }); });
    rep.skipped.filter(function (s) { return s.reason !== 'NOT_REPRESENTABLE'; }).forEach(function (s) { ev.push({ type: 'FIELD_NOT_CONFIRMED', field: s.field }); });
    return ev;
  }

  return {
    FORBIDDEN: FORBIDDEN, descriptor: descriptor, isForbidden: isForbidden, isVisible: isVisible, detectPage: detectPage,
    findStationInput: findStationInput, findDateInput: findDateInput, findChoice: findChoice, findSuggestion: findSuggestion,
    findLanguageDialog: findLanguageDialog, findLanguageControl: findLanguageControl, findAddPassengerControl: findAddPassengerControl,
    findFinalControl: findFinalControl, passengerNameInputs: passengerNameInputs, trainBlock: trainBlock, pageTrainNumbers: pageTrainNumbers, pageFromUrl: pageFromUrl, isPassengerNameInput: isPassengerNameInput,
    newState: newState, fillPage: fillPage, reportEvents: reportEvents, highlight: highlight, choose: choose,
    // P39.3
    isPrimeDropdown: isPrimeDropdown, choosePrime: choosePrime, findDateCell: findDateCell, typedErrors: typedErrors
  };
});
