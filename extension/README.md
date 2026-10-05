# BookKaro IRCTC Assist (Chrome MV3 extension) — P39

User-controlled IRCTC handoff. After you confirm a booking review in BookKaro, this extension pre-fills the IRCTC
forms with that **validated, non-sensitive** data. **You** do everything sensitive or final.

| Extension does | You do (always) |
|---|---|
| From / To (picks the suggestion ending in `- CODE`), journey date, class, quota GENERAL | IRCTC login — User ID + Password |
| Taps **Search** (only after From / To / Date / Class were verified); in the list taps **your** train's class (IRCTC “Refresh”), the journey date and **Book Now** | — |
| Passenger Name / Age / Gender / Berth / Food (only options the page offers) | CAPTCHA |
| Highlights the passenger **Continue** / final **Pay** control — **never clicks it** | OTP |
| Language choice (English / हिंदी) if the page offers a selector | Final Book / Continue tap, Payment |

Safety rules (enforced in `irctc-core.js`, tested in `tests/unit/p39-irctc-handoff.test.ts`):
- Never touches password / OTP / CAPTCHA / card / CVV / UPI / PIN / bank / login / mobile / email fields.
- Never clicks passenger Continue, review Continue, OTP Submit or Pay & Book. (Search and the train-list Book Now are
  navigation before login — tapped once, for the reviewed train / class / date only; v0.39.5, user-requested.)
- Never overwrites a value you typed — the assistant pauses instead (overlay **Resume** continues).
- Every value is read back; anything that did not stick is reported `IRCTC_FIELD_NOT_CONFIRMED` for you to fill.
- Reports to BookKaro are metadata only (page kind, field names) — never field values or credentials.
- Uses only visible page controls. No IRCTC private APIs, no cookies, no CAPTCHA solving.
- A handoff built from MOCK railway data is refused on the real irctc.co.in.
- COMPLETED is reported only when the IRCTC confirmation page is detected; otherwise BOOKING_STATUS_UNKNOWN.

## Install (developer mode)
1. Chrome → `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this `extension/` folder.
2. Open BookKaro (`https://bookkaro-ai-assistant.onrender.com` or `http://localhost:5173`), complete a booking review,
   confirm it, then tap **Open IRCTC Assist → Send to extension**, then **Open IRCTC**.
3. A small BookKaro overlay appears on IRCTC with **Pause / Resume / Stop**.

Without the extension, the **IRCTC Assist** page in BookKaro shows every value with copy buttons.

## Local testing with MockIRCTC
With the dev server (`npm run dev`), open `http://localhost:3000/api/dev/mock-irctc` (23 + 10 real-like scenarios). MockIRCTC is
never served in production. The real IRCTC DOM could not be inspected from the build sandbox (HTTP 403), so the
detection is semantic (labels / placeholders / visible text); verify on the real site yourself and stop before payment.

## Troubleshooting (v0.39.1)

- **Passenger details fill nahi hui?** Check that `chrome://extensions` shows version **0.39.1**. If not, press the
  ↻ Reload icon on "BookKaro IRCTC Assist", then open the IRCTC tab again.
- Press **Fill again** in the BookKaro box once the IRCTC passenger page has fully loaded.
- The small grey line in the box shows *metadata only*, for example
  `PASSENGER · rows 1/2 · filled 3 · not filled: passengerBerth:OPTION_NOT_FOUND`.
  If something is still not filled, send that line (no names or ages are in it).
- If you edited a field yourself, BookKaro does not overwrite it and pauses on that page only. The next IRCTC
  page fills normally.
- If the IRCTC passenger page shows a different train than your BookKaro review, nothing is filled until you
  press **Resume**.

## v0.39.4 — date picker keydown (verification fix)

IRCTC's journey date is a PrimeNG Calendar whose typed-input handler ignores `input` events not preceded by a
keydown (and re-formats from its old model on blur). The date fill now dispatches one `keydown` before setting the
value; the value is still re-read after the picker settles and `DATE_AUTOFILL_FAILED` is raised if IRCTC changed it.
The real-like mock calendar emulates the same guard. Real IRCTC: USER VERIFICATION REQUIRED.

## v0.39.3 — handoff guard + real IRCTC (PrimeNG) autofill

- **Approved page only:** fills ONLY on `https://www.irctc.co.in/nget/*` (exact host, no wildcard) or the local MockIRCTC
  (`http://localhost|127.0.0.1/api/dev/mock-irctc/...`). Anywhere else the content script stops (no box, nothing sent).
- **Handoff check (every IRCTC step):** strict schema, bound to the confirmed review version, expiry, and an HMAC
  integrity check (key = this handoff's bridge token). Any mismatch → `STALE_IRCTC_HANDOFF` (+ reason: EXPIRED /
  REVIEW_VERSION_MISMATCH / SESSION_MISMATCH / UNKNOWN_HANDOFF / SCHEMA_INVALID / INTEGRITY_FAILED / STALE_HANDOFF)
  and nothing is filled. Create a new handoff in BookKaro.
- **Real IRCTC controls:** language Alert dialog ("preferred language"), PrimeNG station autocomplete (async list, exact
  "- CODE" only), `p-calendar` date (re-read after IRCTC validates it), `p-dropdown` class / quota (async panel),
  train list with bare class tabs + date cells (highlighted, never clicked), mobile passenger rows ("Full Name as per
  Govt. ID").
- **Typed errors** in the grey line: `FROM_STATION_AUTOFILL_FAILED`, `TO_STATION_AUTOFILL_FAILED`, `DATE_AUTOFILL_FAILED`,
  `CLASS_AUTOFILL_FAILED`, `QUOTA_AUTOFILL_FAILED`, `TRAIN_AUTOFILL_FAILED`, `PASSENGER_ROW_MISSING#n`,
  `PASSENGER_FIELD_REJECTED#n` (metadata only). A station / date that IRCTC does not confirm stops the journey step:
  nothing is guessed and Search is not highlighted.
- Real-like MockIRCTC pages: `real-language-alert`, `real-search`, `real-search-decoy-stations`,
  `real-search-station-rejected`, `real-search-date-rejected`, `real-train-list`, `real-train-list-expanded`,
  `real-passenger-mobile`, `real-passenger-mobile-2`, `real-passenger-rejecting`.
- Chrome on Android has no extensions: use desktop Chrome / Edge / Brave (or an Android browser that supports MV3
  extensions) for the autofill; otherwise the Assist page copy buttons.

## v0.39.5 — real IRCTC passenger layout + auto Search / Book Now (user-requested)
- **Berth / food fix:** on www.irctc.co.in `<app-passenger>` keeps Name / Age / Gender in one `<span>` and Berth / Food in
  sibling `<div>`s, so the old row lookup never found them. They are now looked up inside the passenger component.
- IRCTC option **values** are used when the visible text differs (Hindi page; food “No Food/Beverages”):
  berth LB MB UB SL SU SM WS CB CP, food V N D, gender M F T. IRCTC's untouched food default is not treated as a user edit.
- **Auto-advance:** journey page → Search (only when every journey field verified, no user edit); train list → for the
  reviewed train only: class tab (availability refresh) → journey-date cell → Book Now once IRCTC enables it. Pause / Stop
  halt it. REGRET / not bookable (Book Now disabled), train / class / date missing → stops with a message, nothing guessed.
- Login, CAPTCHA, OTP, passenger Continue, final Book and payment stay with the user.
