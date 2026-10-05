# P39.3 — IRCTC Handoff + Real Browser Autofill Completion — REPORT

Extension **v0.39.3**. Base `bc2c229` (P39.2, deployed). **Not committed, not pushed, not deployed** (awaiting approval).
Labels: **MOCK** = local MockIRCTC + mock LLM + mock railway · **NOT RUN** = real IRCTC (G5, user-run only).

---

## 1. Untouched files
Muse/LLM providers, Orchestrator, TurnEngine, BookingSession, ReviewBuilder/ReviewSnapshot, voice, railway providers,
`irctc-station-formatter.ts`, `irctc-handoff-adapter.ts`, all existing tests (including `p39-irctc-extension.test.ts` and
`p39-irctc-handoff.test.ts`, which pass unchanged), UI apart from one line in the Assist page, RailBook (not touched).

## 2. New files
| File | Purpose |
|---|---|
| `extension/irctc-handoff-guard.js` | UMD guard: approved host, strict schema, binding (handoffId + reviewVersion), expiry, HMAC integrity |
| `server/irctc/mock/mock-irctc-real.ts` | 10 real-like PrimeNG MockIRCTC pages + their inline behaviour script (separate export) |
| `tests/unit/p39-3-irctc-autofill.test.ts` | 16 DOM tests (happy-dom, **real timers**) |
| `tests/integration/p39-3-irctc-handoff-guard.test.ts` | 6 tests: real manager → background.js in a VM → guard |

## 3. Modified files (additive)
`shared/irctc-handoff.ts` (+3 snapshot fields, integrity helpers, error-code list) · `irctc-handoff-manager.ts`
(`snapshotOf` signs) · `mock-irctc.ts` (serves + lists the real-like list; renders a 2nd `<script data-mock-real>`) ·
`server/main.ts` (mock route accepts the new ids) · `IrctcAssistPage.tsx` (posts `reviewVersion`) · `extension/`
`background.js`, `bookkaro-bridge.js`, `irctc-core.js`, `irctc-content.js`, `manifest.json` (guard first, v0.39.3),
`README.md` · `docs/CONTINUATION.md`. `git diff --stat`: 12 files, +383 / −63. The −63 lines are lines changed in place; no function was removed.

## 4. Manager status
`IrctcHandoffManager` is unchanged apart from `snapshotOf`: same states, TTL (20 min), create / authorize / refresh / retire
(token rotation). The snapshot now also carries `schemaVersion: 1`, `sourceReviewVersion = record.reviewVersion`, and
`integrity = HMAC-SHA256(bridgeToken, canonical payload)`. No new secret and no new env var.

## 5. Payload
`IrctcHandoffSnapshot` (extended, not duplicated) = handoffId, createdAt, expiresAt, journey {from, to, dateIso,
dateIrctc}, train, travelClass, quota, passengers [index, name, age, gender, berth, food], **sourceReviewVersion**,
schemaVersion, integrity, plus the existing status, language, mockData, userActions, notConfirmed, message. It is built only
from the CURRENT confirmed review (existing fingerprint check). There is no raw LLM text and no transcript, and the
guard's strict key allow-list rejects any extra key.
Refusals: expired / unknown / stale reviewVersion / mismatched session / modified payload / bad schema → **`STALE_IRCTC_HANDOFF`** + reason.

## 6. Station handling
Find the field (wrapper `p-autocomplete#origin` / `#destination`, label, placeholder) → `focus()` → keydown → type the
code (deterministic `query = code`, no guessing) → input/change → keyup. **No blur**, because blur closes the panel. The
assistant then waits for the async suggestions (up to 12×250 ms) in the input's own panel (`aria-controls`) first. It
clicks **only** an item matching `- CODE` exactly, never the first item. Verification is a poll, plus a **300 ms settle
re-check**, so a value the page clears again is caught.
Failure → `FROM_STATION_AUTOFILL_FAILED` / `TO_STATION_AUTOFILL_FAILED`, `rep.stopped`, and Search is **not** highlighted.

## 7. Date handling
`p-calendar#jDate` / `formcontrolname=journeyDate` / floating label `DD/MM/YYYY`. The handoff's `dateIrctc` is set as is
(no calculation). After the picker re-validates (150 ms) the value is re-read; if it changed →
`DATE_AUTOFILL_FAILED` (`VALUE_CHANGED_BY_PAGE`) and the journey step stops.

## 8. Train handling
By `trainNumber` only. TRAIN_LIST is detected before HOME_SEARCH, because the real list page also keeps a modify-search
form; the collapsed real list is detected via `app-train-avl-enq`. The train block is anchored on "Book Now", or on the
`(NNNNN)` heading when IRCTC hasn't shown Book Now yet. Another train is never picked or highlighted.
Missing train → `TRAIN_AUTOFILL_FAILED`. The handoff date's cell ("08 Oct") is highlighted only, never clicked.

## 9. Class handling
Real PrimeNG `p-dropdown#journeyClass` / `#journeyQuota`. The aria-hidden `<select>` inside the dropdown is ignored. The
trigger is clicked, the assistant waits for the async options, and the option matching the validated label exactly (or
`(CODE)`) is clicked. The `.ui-dropdown-label` is then verified. If no option matches, the panel is closed again and
`CLASS_AUTOFILL_FAILED` / `QUOTA_AUTOFILL_FAILED` is reported. On the train list, class tabs with bare codes
(`SL 3E 3A`) are also matched. Native `<select>` and ARIA combobox paths are unchanged.

## 10. Passenger autofill
Existing schema fields only (name, age, gender, berth, food). Field priority stays: formcontrolname / data-attr > id/name > label >
aria-label > placeholder; new placeholder "Full Name as per Govt. ID". Passenger index is preserved (row n = passenger n).
Values longer than `maxlength` → `VALUE_TOO_LONG` (never truncated). After filling, every control that was set is re-read →
`PASSENGER_FIELD_REJECTED` (with `passengerIndex`); missing rows → `PASSENGER_ROW_MISSING` #n. "+ Add Passenger"
behaviour is unchanged (only after the row count is stable). Nationality, mobile, payment mode and hidden login/infant
inputs are never touched.

## 11. DOM events
Text: native value setter → `input` + `change` (+ `blur` / `focusout` for plain fields). Stations: focus / focusin (only
if `focus()` didn't take) → keydown → input/change → keyup. Dropdowns: real `click()` on the trigger and option. User
edits are recognised only from trusted events, and user-edited fields are never overwritten.

## 12. Verification
Every field is read back after the page has had time to validate it: stations (poll + settle), date (re-read), dropdown
label, passenger re-read. Additive `rep.errors = [{code, field, passengerIndex?, reason}]` contains metadata only and no
values (tested). `rep.skipped` reasons are unchanged, and backend events still pass `parseEvent`.

## 13–16. Login / CAPTCHA / OTP / payment boundaries
These pages are detected **before** anything else. Nothing is filled; password, CAPTCHA, OTP, card, CVV and UPI inputs are forbidden; final
controls are highlighted only (`data-final-clicked` stays empty in all tests and in e2e). Login shows "IRCTC login
required. Please enter your User ID and Password." Backend statuses are LOGIN_REQUIRED / CAPTCHA_REQUIRED / OTP_REQUIRED /
PAYMENT_PAGE (e2e). There is no auto-submit, and no PNR, ticket or success is ever invented.

## 17. Security (Part 34)
- **Host:** content script and background accept `https://www.irctc.co.in/nget/*` exactly (no subdomain wildcard,
  no `http`, no other port, no `irctc.co.in` without `www`) or the localhost mock path (`/api/dev/mock-irctc[/…]` exactly,
  so the manifest glob's `mock-irctc-evil` is refused). On any other page there is no overlay and no messages
  (unit [22] + e2e). `BK_GET_SNAPSHOT` / `BK_EVENT` are accepted only from this extension's content scripts on approved pages.
- **Origin:** registration only from the BookKaro origins (unchanged), and now with `reviewVersion` required.
- **Integrity:** WebCrypto HMAC with the per-handoff bridge token (256-bit, rotated on retire); constant-time compare.
- **Refused handoffs:** a refused handoff is removed from `chrome.storage.session`. Expiry is checked on every tick, and the
  snapshot is re-fetched and re-verified on every IRCTC page change.
- No credentials, CAPTCHA, OTP or payment data are read, stored or sent. Server logs contain IDs, event types and counts only
  (seen in the e2e log). The secret scan of the diff and new files is clean, and `.env` is excluded from the zip.

## 18. Mock results (MOCK)
10 new real-like pages: `real-language-alert`, `real-search`, `real-search-decoy-stations`,
`real-search-station-rejected`, `real-search-date-rejected`, `real-train-list`, `real-train-list-expanded`,
`real-passenger-mobile`, `real-passenger-mobile-2`, `real-passenger-rejecting`. The original 23 are unchanged (test [1] still 23).

## 19. G1 — build: **PASS** (`tsc --noEmit` clean; `npm run build` exit 0, twice)

## 20. G2 — focused tests: **PASS 52/52** (confirming run)
New: 16 DOM + 6 guard/backend (all 20 required cases: valid [1], expired [2], stale version [3], invalid schema [4],
wrong origin [5], wrong destination [6], autocomplete [7], date [8], train [9], class [10], pax1 [11], pax2 [12], multiple
[13], verification [14], login [15], CAPTCHA [16], OTP [17], payment [18], unauthorized host [19], modified handoff [20];
plus language dialog [21] and the content-script host stop [22]). Existing P39 unit 17/17 and integration 13/13 pass unchanged.
Honest history: 1st run: the DOM file failed at collection (harness `URL` in happy-dom) → fixed. 2nd run: 15/16; [7]
found a **real bug**: a station the page clears 80 ms later was accepted. Fixed in the code with the settle re-check,
without weakening the test. The confirming run passed 52/52. A small guard tightening (mock path) was made after that,
followed by one more confirming run: 52/52. The full 800+ suite was **not** run (as instructed).

## 21. G3 — Chromium e2e (MOCK): **PASS 23/23**
Real Chromium + unpacked v0.39.3 + BookKaro UI (mock LLM / mock railway) + real-like MockIRCTC. Results:
`/home/user/p39_3/e2e/results.json`, screenshots `01–04`. Covers:
- registration with a stale reviewVersion is refused and nothing is stored;
- Assist page binding;
- the language Alert;
- exact async stations ASR → NDLS;
- date, class and quota;
- decoy stations: nothing guessed;
- train list (only 12497; another train's Book Now is never highlighted);
- mobile passengers (including Add Passenger);
- the unapproved path: no overlay;
- the four STOP pages with backend status.

## 22. G5 — real IRCTC: **NOT RUN** (user-run; stop before payment). Not verified against the live irctc.co.in DOM.

## 23. ZIP paths
- Extension: `/home/user/bookkaro-irctc-extension-v0.39.3.zip`
- Whole workspace (incl. `dist/`, `docs/CONTINUATION.md`, `extension/`, no `.env`): `/home/user/bookkaro-p39-3-full-workspace.zip`

## 24. Manual checklist (Part 33): 18 steps
Desktop Chrome / Edge / Brave. Chrome on Android cannot run extensions.
1. `chrome://extensions` → Developer mode → remove the old BookKaro IRCTC Assist → **Load unpacked** the unzipped v0.39.3 folder → version shows **0.39.3**.
2. Open BookKaro and complete a booking chat up to the review: route, date, train, class, passengers.
3. Confirm the review ("haan") → the **IRCTC handoff** card appears → **Open IRCTC Assist**.
4. Press **Send to extension** → "Extension ko bhej diya" appears (it would refuse if the review changed).
5. Open `https://www.irctc.co.in/nget/train-search` in the same browser → the BookKaro box appears bottom-right.
6. Language Alert → BookKaro taps your language once (English default) → the dialog closes.
7. **From** shows IRCTC's own suggestion text with your station code (e.g. "… - ASR (…)"); if not → the box shows `FROM_STATION_AUTOFILL_FAILED`; choose it yourself.
8. **To** is the same (`TO_STATION_AUTOFILL_FAILED` if not confirmed).
9. **Date** = the review date (DD/MM/YYYY); otherwise `DATE_AUTOFILL_FAILED`.
10. **Class** dropdown = the reviewed class (e.g. "AC Chair car (CC)"); **Quota** = GENERAL.
11. **Search** is only highlighted → check everything → **you** tap Search.
12. Train list: only your train is highlighted (and its class tab / date cell) → tap class + date yourself → tap **Book Now** yourself.
13. Login dialog → the box says "IRCTC login required." → type User ID / Password / CAPTCHA **yourself** (BookKaro reads nothing).
14. Passenger page: names / ages / genders / berth filled in passenger order; nationality / mobile / payment mode untouched. Check the grey line for `PASSENGER_*` errors.
15. **Continue** is only highlighted → check → **you** tap Continue.
16. Review + CAPTCHA → you type the CAPTCHA and tap Continue.
17. OTP / payment → you only; BookKaro fills nothing.
18. Negative checks: (a) change something in the BookKaro review after sending → the next IRCTC page shows `STALE_IRCTC_HANDOFF` and fills nothing; (b) wait 20+ minutes → `EXPIRED`; (c) open any non-IRCTC site → no BookKaro box. **Stop before payment unless you intend to book.**

## 25. Git status (uncommitted)
```
 M docs/CONTINUATION.md
 M extension/README.md
 M extension/background.js
 M extension/bookkaro-bridge.js
 M extension/irctc-content.js
 M extension/irctc-core.js
 M extension/manifest.json
 M server/irctc/handoff/irctc-handoff-manager.ts
 M server/irctc/mock/mock-irctc.ts
 M server/main.ts
 M shared/irctc-handoff.ts
 M src/components/irctc/IrctcAssistPage.tsx
?? extension/irctc-handoff-guard.js
?? reports/
?? server/irctc/mock/mock-irctc-real.ts
?? tests/integration/p39-3-irctc-handoff-guard.test.ts
?? tests/unit/p39-3-irctc-autofill.test.ts
12 files changed, 383 insertions(+), 63 deletions(-)
```

## 26. Confirmation of no rewrite
No existing P39 module was rewritten or refactored. All changes extend existing functions, contracts and the existing
channel (bridge → background → backend). There are no new types that duplicate existing ones, no new state machine and no new LLM tool.
The original 23 MockIRCTC scenarios and all existing tests are unchanged and green. No commit, push or deploy was done.

**Known limits (honest):** the real IRCTC DOM was not inspected from the sandbox (403). Selectors follow the public
PrimeNG structure and your screenshots generically, so **G5 on the real site is the remaining verification**. Hindi IRCTC
labels may reduce what is matched, so English is recommended for autofill.
