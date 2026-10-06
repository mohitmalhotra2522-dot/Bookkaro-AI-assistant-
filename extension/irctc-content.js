/*
 * BookKaro IRCTC Assist — content script on irctc.co.in (and the local MockIRCTC).
 *
 * Watches the VISIBLE page, pre-fills supported fields from the BookKaro snapshot (irctc-core.js), highlights the
 * next control the USER must tap, and reports metadata-only progress. A shadow-DOM overlay offers Pause / Resume /
 * Stop at all times. v0.39.5 (user-requested): taps journey Search (all journey fields verified) and, for the reviewed
 * train only, its class tab / date cell / train-list "Book Now" (navigation before login — nothing booked or paid).
 * It never clicks passenger "Continue", review "Continue", OTP "Submit" or "Pay & Book"; never touches login / CAPTCHA /
 * OTP / payment fields; never overwrites the user's own edits.
 */
'use strict';
(function () {
  if (window.__bookkaroIrctcAssist) return;
  // P39.3: exact approved host only (https://www.irctc.co.in/nget/* or the local MockIRCTC) — anything else: STOP, no overlay
  const Guard = window.BookKaroHandoffGuard;
  const HOST_CHECK = Guard ? Guard.isApprovedIrctcPage(location.href) : { ok: false, code: 'UNAUTHORIZED_IRCTC_HOST' };
  if (!HOST_CHECK.ok) return;
  window.__bookkaroIrctcAssist = true;
  const Core = window.BookKaroIrctcCore;
  const IS_REAL_IRCTC = HOST_CHECK.kind === 'REAL';
  const FILL_PAGES = new Set(['HOME_SEARCH', 'TRAIN_LIST', 'PASSENGER']);
  const MSG = {
    LOGIN: 'IRCTC login required. Please enter your User ID and Password.',
    REVIEW_CAPTCHA: 'CAPTCHA aap khud bhariye — BookKaro CAPTCHA solve nahi karta. Phir Continue aap khud tap karein.',
    OTP: 'OTP required. Please enter it on the IRCTC/payment page.',
    PAYMENT: 'Payment aap khud kijiye. BookKaro payment details nahi leta.',
    READY: 'IRCTC par saari details fill ho gayi hain. Final Book/Continue action aap khud tap karein.',
    CONFIRMATION: 'IRCTC confirmation page detect hua — ticket details IRCTC par check kijiye.',
    FAILURE: 'IRCTC par booking fail dikhi — status IRCTC par check kijiye.',
    SESSION_EXPIRED: 'IRCTC session expire ho gaya — dobara login kijiye.',
    MOCK_ON_REAL: 'Ye handoff MOCK railway data se bana hai — real IRCTC par fill nahi kiya jaayega.',
    UNAUTHORIZED_IRCTC_HOST: 'Ye approved IRCTC page nahi hai — BookKaro yahan kuch fill nahi karega.'
  };
  // P39.3: why a handoff was refused (STALE_IRCTC_HANDOFF) — nothing is filled from a refused handoff
  const STALE_MSG = {
    EXPIRED: 'Ye IRCTC handoff expire ho gaya hai. BookKaro mein review dobara confirm karke naya handoff banaiye.',
    UNKNOWN_HANDOFF: 'Ye handoff BookKaro ko nahi mila. BookKaro mein “Continue to IRCTC” dobara dabaiye.',
    REVIEW_VERSION_MISMATCH: 'Booking review badal gaya hai — purana handoff use nahi hoga. BookKaro mein naya review confirm kijiye.',
    HANDOFF_MISMATCH: 'Handoff match nahi hua — BookKaro mein “Continue to IRCTC” dobara dabaiye.',
    SESSION_MISMATCH: 'Is booking ke liye naya handoff ban chuka hai — purana use nahi hoga. BookKaro tab se dobara kholiye.',
    SCHEMA_INVALID: 'Handoff data valid nahi hai — kuch fill nahi kiya. BookKaro mein dobara try kijiye.',
    INTEGRITY_FAILED: 'Handoff data badla hua mila — security ke liye kuch fill nahi kiya. BookKaro mein dobara try kijiye.',
    STALE_HANDOFF: 'Booking details badal gayi hain — purana handoff use nahi hoga. BookKaro mein naya review confirm kijiye.'
  };
  let refusal = null;        // { code, reason } — set once; only “Fill again” (or a new handoff) retries

  const state = Core.newState();
  let snapshot = null;
  let paused = false;
  let stopped = false;
  let lastPage = null;
  let lastFillKey = '';
  let busy = false;
  let pendingTick = false;   // a mutation arrived while busy → run once more afterwards (Angular renders late)
  let autoPaused = false;    // paused by the assistant (user edit / other train) — scoped to the current page
  let searchRetries = {};    // v0.39.7: HOME_SEARCH re-verify rounds before handing Search to the user
  const SEARCH_RETRIES = 6;
  const VER = (() => { try { return chrome.runtime.getManifest().version; } catch (e) { return '?'; } })();
  let fillAttempts = {};     // page key → retries while IRCTC is still rendering rows
  let rowsSeen = -1, rowsStableSince = 0;   // "+ Add Passenger" only after the rendered row count stopped changing
  const ROWS_STABLE_MS = 2500;

  // ---- overlay (shadow DOM; page CSS / scripts cannot restyle or read it) ------------------------------------------
  const host = document.createElement('div');
  host.id = 'bookkaro-irctc-assist';
  host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>
    .box{font:13px/1.4 system-ui,sans-serif;background:#111827;color:#f9fafb;border-radius:12px;padding:10px 12px;width:290px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
    .t{font-weight:700;margin-bottom:4px}.m{margin:6px 0}.s{opacity:.75;font-size:11px}
    button{font:inherit;margin:4px 4px 0 0;padding:4px 10px;border-radius:8px;border:0;cursor:pointer}
    .p{background:#f59e0b;color:#111}.r{background:#10b981;color:#062}.x{background:#ef4444;color:#fff}
    ul{margin:4px 0 0 16px;padding:0;font-size:11px;opacity:.85}</style>
    <div class="box" role="status" aria-live="polite"><div class="t">BookKaro IRCTC Assist</div>
    <div class="m" id="msg">Handoff load ho raha hai…</div><div class="s" id="st"></div>
    <ul><li>Search, train / class / date, Book Now — BookKaro</li><li>Login, CAPTCHA, OTP — aap khud</li><li>Passenger Continue / final Book — aap khud</li><li>Payment — aap khud</li></ul>
    <button class="p" id="pause">Pause</button><button class="r" id="again" title="Is page ke fields dobara fill karein">Fill again</button><button class="r" id="resume" hidden>Resume</button><button class="x" id="stop">Stop</button></div>`;
  const $ = (id) => root.getElementById(id);
  const say = (m, st) => { $('msg').textContent = m; if (st !== undefined) $('st').textContent = st; };
  (document.body || document.documentElement).appendChild(host);

  const send = (event) => new Promise((res) => chrome.runtime.sendMessage({ type: 'BK_EVENT', event }, (r) => res(r || { ok: false })));
  const getSnapshot = () => new Promise((res) => chrome.runtime.sendMessage({ type: 'BK_GET_SNAPSHOT' }, (r) => res(r || { ok: false })));

  $('pause').onclick = () => { paused = true; $('pause').hidden = true; $('resume').hidden = false; say('Assistant paused.'); send({ type: 'PAUSED' }); };
  $('resume').onclick = () => { if (trainMismatchPending) { state.trainMismatchAccepted = true; trainMismatchPending = false; } paused = false; $('pause').hidden = false; $('resume').hidden = true; lastFillKey = ''; send({ type: 'RESUMED' }); tick(); };
  $('again').onclick = () => {
    paused = false; autoPaused = false; trainMismatchPending = false; lastFillKey = ''; fillAttempts = {}; searchRetries = {}; refusal = null; snapshot = null; lastPage = null;
    state.auto = null; state.loginSeen = false;   // an explicit "Fill again" may tap Search / Book Now once more
    $('pause').hidden = false; $('resume').hidden = true; tick();
  };
  $('stop').onclick = () => { stopped = true; say('Assistant band. IRCTC par jo fill hua hai woh aap khud check kijiye.', ''); send({ type: 'STOPPED' }); observer.disconnect(); };

  // the user's own edits always win (trusted events only — our own synthetic events are not trusted)
  const markUser = (e) => { if (e.isTrusted && e.target && e.target.nodeType === 1 && !host.contains(e.target)) state.userEdited.add(e.target); };
  document.addEventListener('input', markUser, true);
  document.addEventListener('change', markUser, true);

  async function loadSnapshot() {
    const r = await getSnapshot();
    if (!r.ok && r.code === 'STALE_IRCTC_HANDOFF') { refusal = { code: r.code, reason: r.reason }; say(STALE_MSG[r.reason] || STALE_MSG.STALE_HANDOFF, `STALE_IRCTC_HANDOFF · ${r.reason}`); return null; }
    if (!r.ok && r.code === 'UNAUTHORIZED_IRCTC_HOST') { refusal = { code: r.code }; say(MSG.UNAUTHORIZED_IRCTC_HOST, r.code); return null; }
    if (!r.ok) { say(r.code === 'NO_ACTIVE_HANDOFF' ? 'Koi active BookKaro handoff nahi. BookKaro mein review confirm karke “Continue to IRCTC” dabaiye.' : `Handoff load nahi hua (${r.code}).`); return null; }
    return r.body;
  }

  let trainMismatchPending = false;   // set when the passenger page shows another train; Resume = the user's explicit choice
  const TERMINAL = new Set(['COMPLETED', 'BOOKING_FAILED', 'BOOKING_STATUS_UNKNOWN', 'EXPIRED', 'STALE_HANDOFF', 'STOPPED']);

  async function tick() {
    if (stopped) return;
    if (busy) { pendingTick = true; return; }
    busy = true;
    try {
      if (refusal) return;
      // SPA route changes: still the approved host / app path?
      if (!Guard.isApprovedIrctcPage(location.href).ok) { say(MSG.UNAUTHORIZED_IRCTC_HOST, 'UNAUTHORIZED_IRCTC_HOST'); return; }
      if (!snapshot) { snapshot = await loadSnapshot(); if (!snapshot) return; }
      // expiry is checked on every tick (not only when loaded)
      if (!TERMINAL.has(snapshot.status) && Date.parse(snapshot.expiresAt) <= Date.now()) {
        refusal = { code: 'STALE_IRCTC_HANDOFF', reason: 'EXPIRED' }; snapshot = null;
        say(STALE_MSG.EXPIRED, 'STALE_IRCTC_HANDOFF · EXPIRED'); return;
      }
      if (snapshot.status === 'BOOKING_STATUS_UNKNOWN') {
        // only IRCTC's own outcome page can still resolve an unknown outcome — nothing is filled any more
        const outcome = Core.detectPage(document);
        if (outcome === 'CONFIRMATION' || outcome === 'FAILURE') {
          const r = await send({ type: 'PAGE_DETECTED', page: outcome });
          if (r.ok && r.body && r.body.view) { snapshot.status = r.body.view.status; snapshot.message = r.body.view.message; }
        }
        say(snapshot.message, snapshot.status); return;
      }
      if (TERMINAL.has(snapshot.status)) { say(snapshot.message, snapshot.status); return; }
      if (snapshot.mockData && IS_REAL_IRCTC) { say(MSG.MOCK_ON_REAL, 'MOCK DATA'); return; }
      const page = Core.detectPage(document);
      if (page !== lastPage) {
        // P39.3: a new IRCTC step → re-fetch + re-verify the handoff (schema / binding / expiry / integrity)
        const fresh = await loadSnapshot();
        if (!fresh) { snapshot = null; return; }
        snapshot = fresh;
        if (TERMINAL.has(snapshot.status)) { say(snapshot.message, snapshot.status); return; }
        lastPage = page; lastFillKey = ''; fillAttempts = {}; searchRetries = {}; rowsSeen = -1;
        // an assistant pause belongs to the page it happened on (a user Pause stays until Resume)
        if (autoPaused) { paused = false; autoPaused = false; trainMismatchPending = false; $('pause').hidden = false; $('resume').hidden = true; }
        const r = await send({ type: 'PAGE_DETECTED', page });
        if (r.ok && r.body && r.body.view) { snapshot.status = r.body.view.status; snapshot.message = r.body.view.message; }
        if (r.code === 'HANDOFF_TERMINAL' || r.code === 'STALE_HANDOFF') { snapshot = await loadSnapshot(); if (snapshot) say(snapshot.message, snapshot.status); return; }
      }
      // v0.39.7: a repeat tick of an already-handled fill page keeps the last outcome on screen (it used to be overwritten
      // by the generic page message, hiding whether / why Search was tapped)
      if (FILL_PAGES.has(page) && `${page}:${Core.passengerNameInputs(document).length}` === lastFillKey) return;
      say(MSG[page] || snapshot.message, `${page} · ${snapshot.train.number} ${snapshot.travelClass.code} · ${snapshot.passengers.length} pax · v${VER}`);
      if (page === 'LOGIN') state.loginSeen = true;
      if (paused) return;
      if (page === 'LANGUAGE' || page === 'HOME_SEARCH') await handleLanguage(page);
      if (!FILL_PAGES.has(page)) {
        const fc = Core.findFinalControl(document, page, snapshot);
        if (fc) Core.highlight(fc, 'user-action');
        return;
      }
      const key = `${page}:${Core.passengerNameInputs(document).length}`;
      if (key === lastFillKey) return;
      lastFillKey = key;
      const rowsNow = Core.passengerNameInputs(document).length;
      if (rowsNow !== rowsSeen) { rowsSeen = rowsNow; rowsStableSince = Date.now(); }
      const allowAddRows = page === 'PASSENGER' && Date.now() - rowsStableSince >= ROWS_STABLE_MS;
      const rep = await Core.fillPage(document, page, snapshot, state, { allowAddRows });
      for (const ev of Core.reportEvents(rep)) await send(ev);
      // metadata-only diagnostics (field keys + reasons, never values) — helps the user report what IRCTC showed
      const diag = `v${VER} · ${page} · rows ${Core.passengerNameInputs(document).length}/${snapshot.passengers.length} · filled ${rep.filled.length}` +
        (rep.errors && rep.errors.length ? ` · errors: ${rep.errors.map(x => `${x.code}${x.passengerIndex ? '#' + x.passengerIndex : ''}:${x.reason}`).join(', ')}`
          : (rep.skipped.length ? ` · not filled: ${rep.skipped.map(x => `${x.field}:${x.reason}`).join(', ')}` : ''));
      say(MSG[page] || snapshot.message, diag);
      // IRCTC is still rendering (rows / selects not there yet) → retry a few times
      const retryable = rep.skipped.some(x => /FIELD_NOT_PRESENT|ROW_MISSING|VALUE_NOT_CONFIRMED|SUGGESTION_NOT_FOUND/.test(x.reason));
      if (retryable && !rep.trainOnPage && (fillAttempts[key] || 0) < 4) {
        fillAttempts[key] = (fillAttempts[key] || 0) + 1;
        // missing rows: wait until the row count has been stable long enough to use "+ Add Passenger"
        const delay = rep.skipped.some(x => x.reason === 'ROW_MISSING') ? ROWS_STABLE_MS + 200 : 1500;
        setTimeout(() => { if (lastFillKey === key) { lastFillKey = ''; tick(); } }, delay);
      }
      if (rep.trainOnPage) {
        // a different train than the confirmed review: stop and ask — never prefill silently
        paused = true; autoPaused = true; trainMismatchPending = true; $('pause').hidden = true; $('resume').hidden = false;
        say(`IRCTC page par train ${rep.trainOnPage} hai, lekin BookKaro review ${snapshot.train.number} ke liye hai. Passenger details fill nahi ki — sahi train chuniye, ya Resume dabakar isi train par fill karwaiye.`, page);
        return;
      }
      if (rep.overrides.length) {
        paused = true; autoPaused = true; $('pause').hidden = true; $('resume').hidden = false;
        say(`Aapne ${rep.overrides.join(', ')} khud badla hai — overwrite nahi kiya. Resume par baaki fields fill hongi.`);
        return;
      }
      if (rep.finalControl) {
        Core.highlight(rep.finalControl, 'final');
        if (page === 'PASSENGER') {
          const r = await send({ type: 'FINAL_CONTROL_HIGHLIGHTED', page });
          const view = r.ok && r.body && r.body.view;
          say(view && view.status === 'READY_FOR_USER_BOOK' ? MSG.READY : (view ? view.message : MSG.READY), diag);
        } else if (page === 'TRAIN_LIST') say('Train aur class highlight ki gayi hai — “Book Now” aap khud tap karein.', page);
      } else if (page === 'TRAIN_LIST' && rep.filled.indexOf('train') >= 0) {
        say(`Train ${snapshot.train.number} highlight ki gayi hai — class ${snapshot.travelClass.code} aur date aap khud tap karein, phir “Book Now”.`, diag);
      } else if (page === 'TRAIN_LIST') {
        say(`Train ${snapshot.train.number} is list mein nahi mili (TRAIN_AUTOFILL_FAILED) — doosri train nahi chuni gayi.`, diag);
      }
      // v0.39.5: navigation taps (Search → class / date → Book Now) — only on a verified page, stops on Pause / Stop
      if ((page === 'HOME_SEARCH' || page === 'TRAIN_LIST') && !paused && !stopped) {
        const adv = await Core.autoAdvance(document, page, snapshot, rep, state, { shouldStop: () => paused || stopped });
        const AUTO_MSG = {
          TRAIN_NOT_IN_LIST: `Train ${snapshot.train.number} is list mein nahi mili — BookKaro ne doosri train nahi chuni.`,
          CLASS_NOT_IN_TRAIN: `Class ${snapshot.travelClass.code} is train ki list mein nahi dikhi — class aap khud chuniye.`,
          DATE_NOT_SHOWN: `${snapshot.travelClass.code} ki availability IRCTC par nahi aayi — class par “Refresh” aap khud tap karein.`,
          BOOK_NOW_DISABLED: `IRCTC ne “Book Now” enable nahi kiya${adv.status ? ` (${adv.status})` : ''} — availability dekhkar aap khud decide karein.`
        };
        if (page === 'HOME_SEARCH' && adv.clicked.indexOf('search') >= 0) { say('From / To / Date / Class verify ho gaye — BookKaro ne Search tap kiya.', diag); return; }
        if (page === 'HOME_SEARCH' && adv.stopped === 'SEARCH_ALREADY_TAPPED') { say('Search pehle hi tap ho chuka hai — IRCTC train list khul rahi hai.', diag); return; }
        if (page === 'HOME_SEARCH' && (adv.stopped === 'JOURNEY_NOT_VERIFIED' || adv.stopped === 'SEARCH_NOT_FOUND') && !rep.overrides.length && !rep.stopped) {
          // IRCTC (mobile) may still be rendering / re-validating: re-fill + re-verify a few times, then hand over with the reason
          const why = adv.stopped === 'SEARCH_NOT_FOUND' ? 'Search button' : (adv.missing || []).join(', ');
          searchRetries[key] = (searchRetries[key] || 0) + 1;
          if (searchRetries[key] <= SEARCH_RETRIES) {
            say(`Search se pehle IRCTC par ${why} dobara verify kar raha hoon…`, `${diag} · ${adv.stopped} · retry ${searchRetries[key]}/${SEARCH_RETRIES}`);
            setTimeout(() => { if (lastFillKey === key && !paused && !stopped) { lastFillKey = ''; tick(); } }, 1500);
          } else say(`IRCTC par ${why} confirm nahi hua, isliye BookKaro ne Search tap nahi kiya. Details check karke Search aap khud tap karein.`, `${diag} · ${adv.stopped}: ${why}`);
          return;
        }
        if (page === 'TRAIN_LIST' && adv.clicked.indexOf('bookNow') >= 0) {
          say(`Train ${snapshot.train.number} · ${snapshot.travelClass.code} · ${adv.status || 'date'} select karke “Book Now” tap kiya. Ab IRCTC login (User ID + Password) aap khud karein.`, diag); return;
        }
        if (page === 'TRAIN_LIST' && AUTO_MSG[adv.stopped]) { say(AUTO_MSG[adv.stopped], `${diag} · ${adv.stopped}`); return; }
      }
      if (page === 'HOME_SEARCH' && rep.stopped) {
        // station / date not verified on IRCTC → stop here; nothing guessed, Search not highlighted
        const what = rep.stopped === 'FROM_STATION_AUTOFILL_FAILED' ? 'From station' : rep.stopped === 'TO_STATION_AUTOFILL_FAILED' ? 'To station' : 'Journey date';
        say(`${what} IRCTC par confirm nahi hua (${rep.stopped}) — BookKaro ne koi andaaza nahi lagaya. Ise aap khud chuniye, phir Search tap karein.`, diag);
      } else if (page === 'HOME_SEARCH') say(rep.skipped.length ? `Kuch fields aap khud bhariye: ${rep.skipped.map(s => s.field).join(', ')}. Phir Search tap karein.` : 'From / To / Date / Class fill ho gaye — Search aap khud tap karein.', diag);
      if (page === 'PASSENGER' && !rep.filled.length && !rep.trainOnPage && !rep.overrides.length)
        say('Passenger fields abhi fill nahi ho paaye — page poora load hone par “Fill again” dabaiye. Na ho to neeche ki line BookKaro team ko bhejiye.', diag);
    } finally {
      busy = false;
      if (pendingTick) { pendingTick = false; clearTimeout(timer); timer = setTimeout(tick, 300); }
    }
  }

  let languageDone = false;
  async function handleLanguage(page) {
    if (languageDone) return;
    const want = snapshot.language === 'hi' ? 'hi' : 'en';
    const ctl = Core.findLanguageControl(document, want);
    if (page === 'LANGUAGE') {
      // P39.3: the language dialog — click the wanted button inside it (once); done only after an actual click
      languageDone = true;
      if (ctl) { ctl.click(); await send({ type: 'LANGUAGE_SELECTED', language: want }); return; }
      await send({ type: 'LANGUAGE_SELECTOR_MISSING' });
      return;
    }
    // search page without a dialog: only a Hindi preference needs the header toggle; English = IRCTC default (the dialog may
    // still appear later, so nothing is marked done here)
    if (want === 'hi') {
      languageDone = true;
      if (ctl) { ctl.click(); await send({ type: 'LANGUAGE_SELECTED', language: want }); }
      else await send({ type: 'LANGUAGE_SELECTOR_MISSING' });
    }
  }

  let timer = null;
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(tick, 600); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // No pagehide → "flow ended": navigation between IRCTC steps (CAPTCHA → OTP → payment gateway → confirmation) also
  // fires pagehide. The end of a flow without a confirmation page is reported only by the user (BookKaro Assist page).
  tick();
})();
