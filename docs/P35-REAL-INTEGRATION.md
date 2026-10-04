# Prompt 35 — Real railway data, provider failover, live voice, IRCTC handoff boundary

Status: implemented. The LLM stays the autonomous agent: it decides tools, order and retries. The backend owns:
- validation and safety;
- state integrity;
- provider normalization;
- factual authority;
- security;
- the booking/handoff boundary.

P35 adds no intent router, wizard or "if X then tool" rule. RailBook is untouched.

## 1. Provider priority and configuration

```
RAILWAY_PROVIDER=live                       # default stays "mock" (labelled non-live)
RAILWAY_PRIMARY_PROVIDER=railcore
RAILWAY_FALLBACK_PROVIDERS=railkit,railradar
RAILCORE_API_KEY / RAILKIT_API_KEY / RAILRADAR_API_KEY   # .env only, server-side only
RAILWAY_PROVIDER_TIMEOUT_MS=4000            # per attempt
RAILWAY_FAILOVER_BUDGET_MS                  # whole chain; default min(RAILWAY_TOOL_TIMEOUT_MS - 1500, 7500)
```

The chain is RailCore → RailKit → RailRadar.
- A provider without a key is skipped and recorded as `NOT_CONFIGURED`. It is never called.
- `WEB_EXTERNAL` is **not** part of the chain. It is a separate tool that only the LLM can choose (§5).

Code:
- `server/railway/providers/live/`:
  - `railcore-provider.ts`, `railkit-provider.ts`, `railradar-provider.ts`;
  - `failover-provider.ts`, `live-config.ts`, `live-http.ts`;
  - `live-provider-base.ts`, `provider-capabilities.ts`.
- Providers are registered in `server/railway/registry/provider-registry.ts` (ids `mock`, `live`, `railcore`, `railkit`, `railradar`).
- They plug in behind the existing `RailwayProvider` interface. There is no second provider abstraction, and the tool service, runtime, guards and booking code are reused.

Endpoints come only from the providers' published documentation. There is no scraping and no guessed endpoint.

| Provider | Base | Auth header | Endpoints used |
|---|---|---|---|
| RailCore | `https://ir.railcore.tech/v1` | `X-RailCore-Key` | `/routes/trains`, `/availability/seats`, `/fares/estimate`, `/trains/{n}`, `/trains/{n}/schedule`, `/trains/{n}/live` |
| RailKit | `https://api.railkit.in` | `x-api-key` | `/api/v1/trains/between/:from/:to`, `/api/v1/seats/…`, `/api/v1/fare/…` (dates DD-MM-YYYY) |
| RailRadar | `https://api.railradar.in` | `X-Api-Key` | `/v1/trains/between/{from}/{to}`, `/v1/trains/{n}`, `/v1/trains/{n}/live`, `/v1/trains/{n}/seats`, `/v1/trains/{n}/fare`, `/v1/pnr/{pnr}` |

## 2. Capability matrix (`provider-capabilities.ts`)

| Capability | RailCore | RailKit | RailRadar |
|---|---|---|---|
| SEARCH_TRAINS | ✓ | ✓ | ✓ |
| GET_TRAIN_INFO | ✓ | — | ✓ |
| GET_TIMETABLE | ✓ | — | ✓ |
| TRACK_TRAIN | ✓ | — | ✓ |
| CHECK_AVAILABILITY | ✓ | ✓ | ✓ |
| GET_FARE | ✓ | ✓ | ✓ |
| CHECK_PNR | — (no PNR API) | — | ✓ |
| GET_CANCELLED_TRAINS | — | — | — |

- If a provider lacks a capability, it is recorded as an `UNSUPPORTED` attempt, which allows fallback.
- GET_CANCELLED_TRAINS remains `TOOL_NOT_IMPLEMENTED`.

## 3. Failover policy (provider normalization, never an agent decision)

| Attempt outcome | Fallback? | Notes |
|---|---|---|
| success (data) | no — used | |
| NO_RESULTS (e.g. RailCore 404 NO_TRAINS_FOUND) | **no** | A valid answer. No provider documents a cross-provider confirmation policy, so none is implemented. |
| UNSUPPORTED / NOT_CONFIGURED | yes | |
| TIMEOUT (network abort, 408/504, TOOL_TIMEOUT) | yes | |
| PROVIDER_FAILURE (5xx, 401/403/402/429, network) | yes | Never mapped to NO_RESULTS |
| MALFORMED (unparseable or identity mismatch) | yes | |
| INVALID_REQUEST (400 / VALIDATION_ERROR; bad segment or date before any call) | **no** | Structured validation error |

- **Budget:** a whole-chain budget is enforced, so the chain can't exceed the runtime tool timeout. The chain stops at the first terminal outcome.
- **What the LLM receives** (the LLM view): `{outcome, provider (UPPERCASE), dataSource, retryable, errorType, reason, data, fallbackUsed, providerAttempts[{provider, outcome, errorCode}]}`.
- The fallback never triggers an LLM rewrite or an extra LLM call.

**Provenance on every success.**
- Fields: provider, dataSource (`LIVE` / `MOCK`), tool, toolResultId, train, route, date, class, timestamp/`retrievedAt`, freshness and attempt number.
- `provider: unknown` never appears. MOCK is never labelled LIVE.

**Freshness.**
- There is no cross-turn cache. "dobara check karo" is a fresh network call (live run G).
- Same-turn dedup still applies.
- A fallback is not a cache.

**Observability.** Each tool execution records:
- tool, provider, status/outcome, dataSource, latencyMs, attempt;
- fallbackUsed, `providerAttempts[{provider, attempt, outcome, errorCode, httpStatus, latencyMs, retryable}]`;
- freshness and resultCount.

Records never contain keys or PII.

## 4. Fixes made during P35

1. **Search validation.** All three providers' `searchTrains` validate the segment and the ISO date, and return `INVALID_REQUEST` before any network call.
2. **Timeout mapping.** The failover maps `TOOL_TIMEOUT` to `TIMEOUT`, which allows fallback. It is never NO_RESULTS.
3. **Fare-refresh date gap.** GET_FARE now carries the authoritative session date when the LLM omits it (`llm-tool-runtime.ts`).
   - Before the fix, the review-boundary fare refresh had no date.
   - RailRadar rejected that as INVALID_REQUEST, and RailCore fell back to `/fares/estimate`.
   - p28 e2e [D] pinned the old dateless call; its expectation now carries the session date. The train/class binding assertions are unchanged.
4. **Execution-boundary communication.** When a turn's error is `BOOKING_EXECUTION_DISABLED`, the visible reply must state the boundary ("Booking execution abhi enabled nahi hai …").
   - If the agent's wording doesn't state it (e.g. a bare "Theek hai.", which reads as agreement), the orchestrator replaces it with the backend refusal text.
   - The composer applies the same check through the shared helper `statesExecutionBoundary`.
   - No extra LLM call is made.

## 5. Web research authority (`server/research/web-research-service.ts`)

- **Enablement.** Off unless `WEB_RESEARCH_ENABLED=true`, `WEB_RESEARCH_PROVIDER=tavily` and `WEB_RESEARCH_API_KEY` are all set. While disabled, the tool doesn't exist for the LLM (UNKNOWN_TOOL).
- **No auto-launch.** It is chosen by the LLM only. The backend never auto-launches it after a provider failure.
- **Labelling and authority.** Results are labelled `dataSource=WEB_EXTERNAL` and `NOT_AUTHORITATIVE`. They are excluded from fact harvesting, so they can never authorize seat, availability, fare, booking or PNR claims.
- **Source tiers.**
  - OFFICIAL: indianrail.gov.in, enquiry.indianrail.gov.in, irctc.co.in, indianrailways.gov.in.
  - SECONDARY: confirmtkt, railyatri, erail.
  - Third-party sources are never called official.
- **Limits.** https only, ≤ 5 results, snippets ≤ 320 chars.
- **Rejected queries.** PNR-like numbers and sensitive terms are rejected. There is no auth bypass and no CAPTCHA bypass.

## 6. Voice

The existing P34 pipeline is reused:

STT → `processTurn(VOICE)` → same agent, tools, guards and state → final validated text → TTS.

- **Server adapters** (`server/voice/live/`): `openai-compatible-voice.ts` and `voice-routes.ts`.
  - `POST /api/voice/turn` runs STT, then the same chat turn, and returns `stt{provider, transcript, latencyMs}`.
  - `POST /api/voice/speak` speaks only the latest validated response. A stale turn returns 409 `STALE_TURN`.
  - Failures return 503 / 504 / 502 / 400 / 422, always with `fallback: 'TEXT'`.
- **Env:**
  - `VOICE_STT_PROVIDER=openai_compatible`, `VOICE_STT_BASE_URL`, `VOICE_STT_MODEL`, `VOICE_STT_API_KEY`;
  - `VOICE_TTS_PROVIDER`, `VOICE_TTS_BASE_URL`, `VOICE_TTS_MODEL`, `VOICE_TTS_VOICE` (alloy), `VOICE_TTS_FORMAT`, `VOICE_TTS_API_KEY`, `*_TIMEOUT_MS`.
- **Parity.** The same transcript gives the same decision in TEXT and VOICE (G3 [K1]; live run K vs B both called SEARCH_TRAINS on RailCore LIVE).
- **Limitation.** The browser client still uses Web Speech (P34). There is no MediaRecorder adapter that posts audio to `/api/voice/turn` yet, so the server STT/TTS routes are exercised by tests and API only.
- **Live STT/TTS: NOT RUN.** No voice provider key is configured.

## 7. IRCTC handoff boundary

The states stay distinct:
- BOOKING_REVIEW (`AWAITING_CONFIRMATION`);
- confirmation → `IRCTC_HANDOFF_READY`;
- HANDOFF_STARTED;
- `BOOKING_EXECUTION_DISABLED` (turn error);
- BOOKING_CONFIRMED is never set.

Rules:
- When execution is unavailable, the reply says "Booking execution abhi enabled nahi hai."
- No PNR, booking ID, transaction ID, coach, berth or status is ever fabricated.
- There is no payment, OTP, CAPTCHA, UPI PIN or password automation. `executeHandoff` is spied in G3 and never called.

G3 [L] covers steps 1–12, and [L-exp] covers expiry. Both pass:
1. select train;
2. class;
3. passengers;
4. fresh availability;
5. fresh fare;
6. review;
7. explicit confirm tied to the review version;
8. handoff created;
9. execution request refused with the boundary sentence;
10. handoff not reusable;
11. a change invalidates it;
12. an expired handoff is not reusable.

## 8. Live results (LIVE = real network; MOCK-labelled controlled tests are separate)

### 8a. LIVE PROVIDER TEST (adapters, 2026-10-04; ASR→NDLS 2026-10-05; train 12014 CC) — `docs/p35-live-provider-results.json`

Every row below has data source LIVE and no fallback.

| Provider | Endpoint | Capability | Result | Latency |
|---|---|---|---|---|
| RailCore | `/v1/routes/trains` | SEARCH_TRAINS | 14 trains | 1747 ms |
| RailCore | `/v1/availability/seats` | CHECK_AVAILABILITY | WL 30 | 675 ms |
| RailCore | `/v1/availability/seats` | GET_FARE | ₹1125 | 600 ms |
| RailCore | `/v1/trains/12014/schedule` | GET_TRAIN_INFO | EC/CC | 519 ms |
| RailCore | `/v1/trains/12014/schedule` | GET_TIMETABLE | 8 stops | 503 ms |
| RailCore | `/v1/trains/12014/live` | TRACK_TRAIN | completed | 829 ms |
| RailCore | repeat availability | CHECK_AVAILABILITY | fresh call, WL 30 | 430 ms |
| RailRadar | `/v1/trains/between` | SEARCH_TRAINS | 8 trains | 382 ms |
| RailRadar | `/v1/trains/12014/seats` | CHECK_AVAILABILITY | WL 32 | 524 ms |
| RailRadar | `/v1/trains/12014/fare` | GET_FARE | ₹1125 | 496 ms |
| RailRadar | `/v1/trains/12014` | GET_TRAIN_INFO | ok | 320 ms |
| RailRadar | `/v1/trains/12014` | GET_TIMETABLE | 8 stops | 286 ms |
| RailRadar | `/v1/trains/12014/live` | TRACK_TRAIN | delay 7 min | 287 ms |
| Failover chain | RailCore first | SEARCH_TRAINS | railcore DATA (no fallback needed) | 1137 ms |
| RailKit | — | — | **NOT RUN — no RAILKIT_API_KEY (NOT_CONFIGURED)** | — |

RailCore and RailRadar can disagree on the same snapshot (WL 30 vs WL 32). Snapshots are never merged, and every answer names its provider.

### 8b. Real LLM end-to-end (model `meta/muse-glimmer-30b`, real provider chain) — `scripts/p35-live-llm.ts` → `docs/p35-live-llm-results.json`

| # | Request | Latency | LLM calls | Tool calls | Provider calls | Fallback | Result |
|---|---|---|---|---|---|---|---|
| A | RAC kya hota hai? | 13.2 s | 1 | none | none | — | correct explanation, no tool |
| B | Kal Amritsar se Delhi jaana hai | 57.1 s | 3 | SEARCH_TRAINS DATA/LIVE | RailCore `/routes/trains` | none | 14 trains, earliest first |
| C | Doosri wali ka 3A availability batao | 39.8 s | 2 | none | none | — | correctly says 12014 has only CC/EC; offers alternatives |
| D | Uska fare batao | 30.1 s | 1 | none | none | — | asks for class (3A doesn't exist) |
| E | Kaunsi sabse jaldi Delhi pahunchti hai? | 43.1 s | 1 | none (from search result) | none | — | 22126 arrives 10:50 |
| F | Kal nahi, parso | 56.5 s | 2 | SEARCH_TRAINS DATA/LIVE | RailCore `/routes/trains` | none | fresh search for 6 Oct, 12 trains |
| G | Abhi dobara availability check karo | 56.3 s | 3 | CHECK_AVAILABILITY DATA/LIVE | RailCore `/availability/seats` | none | **fresh call made, but the final reply didn't state the result** (see limitations) |
| K | (VOICE) Kal Amritsar se Delhi jaana hai | 24.5 s | 3 | SEARCH_TRAINS DATA/LIVE | RailCore | none | same decision as B (TEXT) |
| L1 | Kal Amritsar se Delhi jaana hai | 33.2 s | 3 | SEARCH_TRAINS | RailCore | none | 14 trains |
| L2 | Doosri wali CC, do log … | 116.1 s | 5 | CHECK_AVAILABILITY + GET_FARE DATA/LIVE | RailCore seats ×2 | none | review built (`AWAITING_CONFIRMATION`); visible text terse |
| L3 | haan confirm | 20.4 s | 3 | none | none | — | `IRCTC_HANDOFF_READY` |
| L4 | ab book kar do | 29.6 s | 1 | none | none | — | "booking execution disabled hai … ticket abhi book nahi hua"; review ₹2250 (₹1125 × 2), WL 32 |

Errors: none. Fallbacks: none were needed, because RailCore answered every call. Failover is proven by the MOCK-labelled controlled tests (G3 [H][I][J]), which spend no credits.

## 9. Gates (P35 definitions)

- **G1 = typecheck + build:** `tsc --noEmit -p tsconfig.json` and `npm run build`. **PASS.**
- **G2 = provider / security / domain (unit):** p17, p21, p22, p25–p30, p32, p33, p34 ×2, p35-provider-failover. **232/234.** Both failures are pre-existing: p21 [11] and p22 [9].
- **G3 = end-to-end (integration):** p35-real-integration-e2e, p34-voice-e2e, p8-booking-engine, p10, p11, p16, p17, p21–p23, p25–p30, p32, p33.
  - Final run: **290/302**.
  - 11 failures are pre-existing: p22 [K+L], p21 [2]/[12]/[17], p16 [2]/[6], p8 [24]/[19][H]/closed-tool-set, p17 [14], p25 [J].
  - 1 was p28 [D], which pinned the old dateless GET_FARE (fix 3). After the test correction, the p28 file is 14/14 (targeted run).
- Live tests run separately (§8) and are never mixed with the gates.

## 10. Limitations

- **RailKit live:** not run (no key). Its adapter is tested with controlled fixtures only.
- **Tavily / web research live:** not run (no key). The tool stays disabled.
- **Live STT/TTS:** not run (no key). The browser client still uses Web Speech; there is no MediaRecorder → `/api/voice/turn` adapter.
- **Live LLM latency:** high, 13–116 s per turn, almost all of it LLM time.
- **Thin replies in the live run.** On some turns the visible reply was terse (G, L2, L3): the validated text kept only what the guards accepted. No false facts were shown. Improving this needs LLM wording or prompt work, not new rules.
- **RailCore data quirks.** RailCore `/fares/estimate` (dateless) is a range estimate; the date-bound seats endpoint is preferred. RailCore schedule data can list an "UNKNOWN" class.
- **GET_CANCELLED_TRAINS:** not implemented.
- **Real booking execution:** disabled by design.
