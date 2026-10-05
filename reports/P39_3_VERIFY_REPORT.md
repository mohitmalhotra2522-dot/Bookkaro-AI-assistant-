# P39 IRCTC Handoff — Real-User Verification Package — REPORT

Nothing committed, pushed or deployed. P40 not started. Labels: MOCK = local MockIRCTC · USER VERIFICATION REQUIRED = real IRCTC.

## 1. P39 implementation inspected (read-only first)
| Area | Result |
|---|---|
| Handoff manager / snapshot | OK: built only from the current confirmed review (fingerprint), TTL 20 min, token rotation |
| Signed handoff | OK: HMAC-SHA256 (per-handoff bridge token) over the canonical payload |
| reviewVersion binding | OK: Assist page sends it, background requires + stores it, guard compares it |
| Session binding | OK: wrong / rotated token → `SESSION_MISMATCH`; unknown id → `UNKNOWN_HANDOFF` |
| Expiry | OK: backend TTL + extension checks `expiresAt` on every tick |
| Manifest | OK: exact `https://www.irctc.co.in/nget/*` + local mock; guard loaded first |
| Content script / service worker | OK: host stop (no overlay elsewhere), snapshot/events only from approved senders |
| Station autocomplete | OK: focus → keydown → input → keyup → async list → exact `- CODE` → settle re-check |
| **Date picker** | **GAP: fixed (see 2)** |
| Class / quota | OK: PrimeNG p-dropdown, exact label / `(CODE)`, verified, else `CLASS_AUTOFILL_FAILED` |
| Train | OK: by snapshot train number only; highlight, never click; else `TRAIN_AUTOFILL_FAILED` |
| Passenger mapping | OK: index-preserving rows; name / age / gender / berth / food only; re-read verification |
| Safety stops | OK: login / CAPTCHA / OTP / payment detected first, nothing filled, nothing clicked |

## 2. Files changed in this verification milestone (smallest additive fix)
- `extension/irctc-core.js`: +2 lines. One `keydown` is dispatched on the date input before the value is set.
  **Why:** IRCTC's date field is a PrimeNG Calendar. Its typed-input handler ignores `input` events that don't follow a
  keydown (`isKeydown` guard), and on blur it re-formats the field from its old model. Without the fix, the date would
  likely revert on real IRCTC; the verification would catch it as `DATE_AUTOFILL_FAILED` (safe, but never filled).
- `server/irctc/mock/mock-irctc-real.ts`: the mock p-calendar now enforces the same guard, so the test exercises it.
  **Proof:** with the fix temporarily removed, test [8] fails exactly like that (`expected '05/10/2026' to be '08/10/2026'`);
  with the fix, it passes.
- `extension/manifest.json`: version 0.39.3 → **0.39.4** (so the user can see which build is loaded).

## 3. Files NOT changed
Everything else, including: Devanagari handling, form handling, eRail, RailYatri, railway provider tools,
Muse/LLM orchestration, STT, TTS, booking workflow, review engine, passenger collection, RailwayProvider, RailCore,
RailRadar, AI tools, UI, state machine, handoff manager, guard, background, content script and all tests.

## 4. Extension package path
- `/home/user/bookkaro-irctc-user-test-package.zip`, which contains:
  - `bookkaro-irctc-extension-v0.39.4.zip`
  - `bookkaro-source-p39-verify.zip` (no `.env`)
  - `env.template` (placeholders only)
  - `USER_TEST_GUIDE.md`
  - `TEST_RESULT_FORM.md`
- Secret-value scan of the whole package: **0 hits**.

## 5. Installation status
**Verified in Chromium:** the ZIP was unzipped into a fresh folder and loaded with `--load-extension` (= Load unpacked). The
service worker and guard loaded and the manifest version is 0.39.4; the whole G3 run used that unzipped package.
Edge / Brave use the same Chromium MV3 Load-unpacked flow, but haven't been tested here; the user confirms them.
**Android Chrome is NOT supported** (it has no extensions).

## 6. G1 BUILD: **PASS** (`npm run build` exit 0)
## 7. G2 FOCUSED TESTS: **PASS** (52/52, one run: P39.3 DOM 16, guard/backend 6, P39 unit 17, P39 integration 13)
## 8. G3 MOCK CHROMIUM E2E: **PASS** (23/23, from the unzipped extension ZIP; results `/home/user/p39_verify/e2e/results.json`)
## 9. G5 REAL IRCTC: **USER VERIFICATION REQUIRED** (not run; nothing here claims real IRCTC is verified)

## 10. Manual checklist given to the user
This is in `USER_TEST_GUIDE.md` §4, following your 20 steps exactly. The guide also covers:
- the Amritsar/ASR → New Delhi/NDLS test, plus a "Delhi" variant where IRCTC must show exactly the review's code;
- the language check (English main, Hindi optional);
- safety tests A–E and the non-IRCTC site test (§6);
- troubleshooting (§7);
- the failure form asking for: page, field, expected value, actual value, whether the autocomplete appeared, whether IRCTC cleared the value, the grey diagnostic line, handoff status and console errors.

The guide stops before login submission. If the user wants to check the passenger page (only reachable after
login), logging in is their own manual action; BookKaro never touches it.

## 11. Known limitations
- **Live site blocker:** Render still serves P39.2 (`index-CF23TgXM.js`). Extension v0.39.4 correctly refuses handoffs from it
  (no reviewVersion, no signature). So the user must either run BookKaro locally with their own keys (Option A), or
  approve a deploy before testing (Option B, which conflicts with "commit/deploy only after the test").
- A real-IRCTC test needs LIVE railway data; MOCK handoffs are refused on irctc.co.in by design.
- The real IRCTC DOM could not be inspected from the sandbox (403). Selectors follow PrimeNG's public structure.
- The date is set through the picker's own typed-input path (then re-verified), not by clicking calendar day cells.
- Hindi IRCTC may reduce matching of the final-control highlight (English labels); fields matched by id should still fill.
- Safety test D (modified handoff) is verified by automated tests only; C needs a DevTools console step.

## 12. Confirmation
- Login: untouched (detected → stop; never typed or submitted)
- CAPTCHA: untouched
- OTP: untouched
- Book / Continue: untouched (highlight only; `data-final-clicked` empty in all tests and e2e)
- Payment: untouched
- Real booking: untouched (`REAL_BOOKING_ENABLED=false`, no executor)
- P39 railway / AI functionality: untouched

## Git status (uncommitted; P39.3 + this fix)
```
 M docs/CONTINUATION.md          M extension/README.md         M extension/background.js
 M extension/bookkaro-bridge.js  M extension/irctc-content.js  M extension/irctc-core.js
 M extension/manifest.json       M server/irctc/handoff/irctc-handoff-manager.ts
 M server/irctc/mock/mock-irctc.ts  M server/main.ts  M shared/irctc-handoff.ts  M src/components/irctc/IrctcAssistPage.tsx
?? extension/irctc-handoff-guard.js  ?? reports/  ?? server/irctc/mock/mock-irctc-real.ts
?? tests/integration/p39-3-irctc-handoff-guard.test.ts  ?? tests/unit/p39-3-irctc-autofill.test.ts
12 files changed, 386 insertions(+), 64 deletions(-)
```
**STOPPED.** Waiting for the user's real IRCTC test result.
