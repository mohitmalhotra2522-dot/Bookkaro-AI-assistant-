# BookKaro IRCTC Assist (Chrome MV3 extension) — P39

User-controlled IRCTC handoff. After you confirm a booking review in BookKaro, this extension pre-fills the IRCTC
forms with that **validated, non-sensitive** data. **You** do everything sensitive or final.

| Extension does | You do (always) |
|---|---|
| From / To (picks the suggestion ending in `- CODE`), journey date, class, quota GENERAL | IRCTC login — User ID + Password |
| Highlights your train + class in the train list | Tap **Search** and **Book Now** |
| Passenger Name / Age / Gender / Berth / Food (only options the page offers) | CAPTCHA |
| Highlights the final **Continue / Pay** control — **never clicks it** | OTP |
| Language choice (English / हिंदी) if the page offers a selector | Final Book / Continue tap, Payment |

Safety rules (enforced in `irctc-core.js`, tested in `tests/unit/p39-irctc-handoff.test.ts`):
- Never touches password / OTP / CAPTCHA / card / CVV / UPI / PIN / bank / login / mobile / email fields.
- Never clicks Book Now, passenger Continue, review Continue, OTP Submit or Pay & Book.
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
With the dev server (`npm run dev`), open `http://localhost:3000/api/dev/mock-irctc` (20 scenarios). MockIRCTC is
never served in production. The real IRCTC DOM could not be inspected from the build sandbox (HTTP 403), so the
detection is semantic (labels / placeholders / visible text); verify on the real site yourself and stop before payment.
