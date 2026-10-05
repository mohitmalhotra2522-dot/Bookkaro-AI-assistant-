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
    return w.getAttribute('formcontrolname') || '';
  }

  /** Semantic descriptor of a control: attributes + label (lower-case). */
  function descriptor(el) {
    var a = ['id', 'name', 'placeholder', 'aria-label', 'autocomplete', 'formcontrolname', 'title', 'type'];
    var parts = [];
    for (var i = 0; i < a.length; i++) { var v = el.getAttribute(a[i]); if (v) parts.push(v); }
    var w = wrapperControlName(el);
    if (w) parts.push(w);
    parts.push(labelText(el));
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
    return /passenger ?name|passengername/.test(d) || /^(passenger )?name\b/.test(ph);
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
    return visibleAll(doc, 'input').filter(function (el) { return !isForbidden(el) && /journey date|dd\/mm\/yyyy|jdate|\bdate\b/.test(descriptor(el)); })[0] || null;
  }

  /** Native <select> or ARIA combobox (role=combobox, not an input) whose descriptor matches. */
  function findChoice(scope, re) {
    var c = visibleAll(scope, 'select, [role="combobox"]').filter(function (el) {
      return el.tagName !== 'INPUT' && !isForbidden(el) && re.test(descriptor(el));
    });
    return c[0] || null;
  }

  function findLanguageDialog(doc) {
    return visibleAll(doc, '[role="dialog"], .language-dialog').filter(function (d) { return /select language|choose language|भाषा चुनें/i.test(d.textContent || ''); })[0] || null;
  }

  function findLanguageControl(doc, lang) {
    var re = lang === 'hi' ? /^(हिंदी|hindi)$/i : /^(english|अंग्रेज़ी|अंग्रेजी)$/i;
    return visibleAll(doc, 'button, a, [role="button"]').filter(function (el) { return re.test(norm(el.textContent)); })[0] || null;
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
    if (findStationInput(doc, 'from') && findStationInput(doc, 'to')) return 'HOME_SEARCH';
    if (buttons(doc).some(function (b) { return /^book now$/i.test(controlText(b)); }) && /\(\d{5}\)/.test(text)) return 'TRAIN_LIST';
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

  /** Station suggestion item ending in "- CODE" (IRCTC autocomplete style). */
  function findSuggestion(doc, code) {
    var re = new RegExp('-\\s*' + String(code).replace(/[^A-Z0-9]/gi, '') + '(\\s|\\)|$)');
    return visibleAll(doc, 'li[role="option"], .ui-autocomplete-list-item, [role="listbox"] [role="option"]').filter(function (li) { return re.test(norm(li.textContent)); })[0] || null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // fill engine

  function newState() { return { filled: new WeakMap(), userEdited: new WeakSet() }; }

  /** The user's own value wins: an edited control, or a pre-existing value we did not put there. */
  function userOwned(el, state, target, code) {
    if (state.userEdited.has(el)) return true;
    if (state.pageDefaultsReplaceable) return false;   // journey page: untouched values are IRCTC defaults
    var mine = state.filled.get(el);
    if (el.tagName === 'SELECT' || el.getAttribute('role') === 'combobox') {
      var cur = currentChoice(el);
      if (mine !== undefined && cur.text === mine) return false;
      if (!cur.value || /^(gender|food choice|no preference|all classes|select)/i.test(cur.text)) return false;
      return !optionMatch(cur.text, target, code);
    }
    var v = norm(el.value);
    if (!v || (mine !== undefined && v === mine)) return false;
    return lower(v) !== lower(target);
  }

  function Report(page) { this.page = page; this.filled = []; this.skipped = []; this.overrides = []; this.finalControl = null; this.located = []; }
  Report.prototype.ok = function (f) { if (this.filled.indexOf(f) < 0) this.filled.push(f); };
  Report.prototype.skip = function (f, reason) { if (!this.skipped.some(function (s) { return s.field === f && s.reason === reason; })) this.skipped.push({ field: f, reason: reason }); };
  Report.prototype.override = function (f) { if (this.overrides.indexOf(f) < 0) this.overrides.push(f); };

  function fillText(el, field, value, state, rep) {
    if (!el) { rep.skip(field, 'FIELD_NOT_PRESENT'); return false; }
    if (isForbidden(el)) { rep.skip(field, 'FIELD_FORBIDDEN'); return false; }
    if (userOwned(el, state, value)) { rep.override(field); return false; }
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

  function wait(opts, ms) { return opts && opts.wait ? opts.wait(ms) : new Promise(function (r) { setTimeout(r, ms); }); }

  async function fillStation(doc, el, field, ref, state, rep, opts) {
    if (!el) { rep.skip(field, 'FIELD_NOT_PRESENT'); return; }
    if (isForbidden(el)) { rep.skip(field, 'FIELD_FORBIDDEN'); return; }
    var re = new RegExp('-\\s*' + ref.code + '(\\s|\\)|$)');
    if (re.test(norm(el.value)) && !state.userEdited.has(el)) { state.filled.set(el, norm(el.value)); rep.ok(field); return; }
    if (userOwned(el, state, ref.code)) { rep.override(field); return; }
    setNativeValue(el, ref.query);
    var sug = null;
    for (var i = 0; i < 12 && !sug; i++) { sug = findSuggestion(doc, ref.code); if (!sug) await wait(opts, 250); }
    if (!sug) { rep.skip(field, 'STATION_SUGGESTION_NOT_FOUND'); return; }
    sug.click();
    await wait(opts, 50);
    if (!re.test(norm(el.value))) { rep.skip(field, 'VALUE_NOT_CONFIRMED'); return; }
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
    return null;
  }

  /** Highlight only — NEVER clicks. */
  function highlight(el, label) {
    if (!el) return;
    el.setAttribute('data-bookkaro-highlight', label || 'final');
    el.style.outline = '4px solid #f59e0b';
    el.style.outlineOffset = '3px';
    if (el.scrollIntoView) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { /* ignore */ } }
  }

  /**
   * Fill the supported fields of the current page from the snapshot. Async (station suggestions appear after typing).
   * opts: { wait(ms) → Promise, allowAddRows: boolean }
   */
  async function fillPage(doc, page, snapshot, state, opts) {
    var rep = new Report(page);
    state = state || newState();
    if (page === 'HOME_SEARCH') {
      state.pageDefaultsReplaceable = true;
      try {
      await fillStation(doc, findStationInput(doc, 'from'), 'from', snapshot.journey.from, state, rep, opts);
      await fillStation(doc, findStationInput(doc, 'to'), 'to', snapshot.journey.to, state, rep, opts);
      fillText(findDateInput(doc), 'date', snapshot.journey.dateIrctc, state, rep);
      fillChoice(findChoice(doc, /class/), 'travelClass', snapshot.travelClass.label, snapshot.travelClass.code, state, rep);
      fillChoice(findChoice(doc, /quota/), 'quota', snapshot.quota.label, null, state, rep);
      } finally { state.pageDefaultsReplaceable = false; }
      // the Search button is highlighted for the user, never clicked (they check what was filled first)
      rep.finalControl = findFinalControl(doc, 'HOME_SEARCH');
      return rep;
    }
    if (page === 'TRAIN_LIST') {
      var tb = trainBlock(doc, snapshot.train.number);
      if (!tb) { rep.skip('train', 'TRAIN_NOT_IN_LIST'); return rep; }
      highlight(tb.block, 'train'); rep.ok('train');
      var cls = Array.prototype.slice.call(tb.block.querySelectorAll('*')).filter(function (e) { return e.children.length === 0 && new RegExp('\\(' + snapshot.travelClass.code + '\\)').test(e.textContent || ''); })[0];
      if (cls) { highlight(cls.parentElement || cls, 'class'); rep.ok('travelClass'); } else rep.skip('travelClass', 'CLASS_NOT_IN_TRAIN');
      rep.finalControl = tb.book;   // "Book Now" — highlighted by the caller, tapped by the user
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
      for (var p = 0; p < pax.length; p++) {
        var P = pax[p];
        var nameEl = names[p];
        if (!nameEl) { ['passengerName', 'passengerAge', 'passengerGender'].forEach(function (f) { rep.skip(f, 'ROW_MISSING'); }); continue; }
        var row = rowContainer(nameEl) || nameEl.parentElement;
        fillText(nameEl, 'passengerName', P.name, state, rep);
        var ageEl = Array.prototype.slice.call(row.querySelectorAll('input')).filter(function (i) { return /\bage\b|passengerage/.test(descriptor(i)) && !isForbidden(i); })[0];
        fillText(ageEl, 'passengerAge', P.age, state, rep);
        if (P.gender) fillChoice(findChoice(row, /gender/), 'passengerGender', P.gender, null, state, rep); else rep.skip('passengerGender', 'NOT_REPRESENTABLE');
        if (P.berth) fillChoice(findChoice(row, /berth/), 'passengerBerth', P.berth, null, state, rep);
        if (P.food) fillChoice(findChoice(row, /food|meal|catering/), 'passengerFood', P.food, null, state, rep);
      }
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
    newState: newState, fillPage: fillPage, reportEvents: reportEvents, highlight: highlight, choose: choose
  };
});
