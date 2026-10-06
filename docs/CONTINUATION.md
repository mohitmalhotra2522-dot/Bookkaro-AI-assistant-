# BookKaro AI Agent — Continuation / Handoff

Read this first in a new workspace. It is enough to continue the project from this zip alone.

## 1. What this is

BookKaro is a mobile-first Hindi/Hinglish/English **railway assistant** (text + voice) with a conversational booking
*preparation* flow. A real LLM (OpenAI-compatible, e.g. NVIDIA `meta/muse-glimmer-30b`) is the agent: it decides
meaning and tools. The backend is a strict safety and validation boundary. **Phase 1:**
- railway data comes from `MockRailwayProvider` (labelled non-live) by default. **Since P35:** `RAILWAY_PROVIDER=live`
  enables the real RailCore → RailKit → RailRadar failover chain (see `docs/P35-REAL-INTEGRATION.md`);
- real booking, payment, IRCTC login and submission are **disabled** (interface-only handoff).
  **Since P39:** after a confirmed current review the user can open a *user-controlled IRCTC handoff* — the BookKaro
  Chrome extension (`extension/`) prefills non-sensitive validated fields on IRCTC; the user does login, CAPTCHA, OTP,
  the final Book/Continue tap and payment personally (see §6f).

Stack:
- server: Node 20 + TypeScript + Fastify (`server/`);
- web: React 18 + Vite + Zustand (`src/`);
- shared types: `shared/`;
- tests: Vitest (`tests/unit`, `tests/integration`).

This is a **standalone** repo. It is NOT RailBook. Never touch RailBook code, git, API, Render or AI assets.

## 2. Commands

```bash
npm ci                                   # install (node_modules is not in the zip)
cp .env.example .env && chmod 600 .env   # then fill LLM_* only if you want a real LLM (never commit .env)
npm run dev                              # server :3000 + vite frontend
npm run build                            # tsc -b && vite build  (G1)
./node_modules/.bin/tsc -b               # typecheck
./node_modules/.bin/vitest run <files>   # tests (use local binaries, not npx)
./node_modules/.bin/vite-node <script>   # scripts (does NOT auto-load .env → call loadEnvFile())
```

Env:
- No `LLM_PROVIDER` → MockLLM (offline stand-in; tests always use it or the FakeOpenAI helper).
- Real LLM: `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL=https://integrate.api.nvidia.com/v1`, `LLM_MODEL=meta/muse-glimmer-30b`, `LLM_API_KEY=…` (in `.env` only).
- `RAILWAY_PROVIDER` defaults to `mock`. P35: `RAILWAY_PROVIDER=live` + `RAILWAY_PRIMARY_PROVIDER=railcore` + `RAILWAY_FALLBACK_PROVIDERS=railkit,railradar` + `RAILCORE_API_KEY` / `RAILKIT_API_KEY` / `RAILRADAR_API_KEY` (`.env` only). Other registered ids: `railcore`, `railkit`, `railradar` (single provider). `REAL_IRCTC_ENABLED` must stay off.
- P36-C optional: `ELEVENLABS_API_KEY` (server env only) enables batch STT for tap-to-talk; `ELEVENLABS_STT_TIMEOUT_MS` (default 8000, clamped 1000–20000), `ELEVENLABS_STT_ENABLED=false` kill switch.
- P35 optional: web research (`WEB_RESEARCH_ENABLED=true`, `WEB_RESEARCH_PROVIDER=tavily`, `WEB_RESEARCH_API_KEY`); server voice (`VOICE_STT_*`, `VOICE_TTS_*`). All placeholders are in `.env.example`.
- Live scripts (spend real credits; never part of the gates): `vite-node scripts/p35-live-providers.ts` (adapters) and `vite-node scripts/p35-live-llm.ts` (real LLM + real providers).

## 3. Architecture map (where things live)

| Area | Path |
|---|---|
| Turn entry (text/voice share one pipeline) | `server/ai/turn-engine/conversation-turn-engine.ts` |
| Agent orchestration, final guards, diagnostics | `server/ai/agent/conversation-agent-orchestrator.ts` |
| LLM chain loop (tool calls, dedup, step budget, chain trace) | `server/ai/runtime/llm-tool-runtime.ts` |
| Provider execution, timeout, retry, malformed-data check | `server/ai/tool-runtime/railway-tool-runtime.ts` |
| Outcome categories, data source, shape validation (P32) | `server/ai/tool-runtime/tool-outcome.ts` |
| Booking preparation view for the LLM (P33) | `server/ai/context/context-builder.ts` → `bookingPreparationView` |
| Review boundary / freshness / block reasons (P33) | `server/booking/booking-preparation-service.ts` (`freshSince`, `dependencyFailureReason`), `server/booking/booking-readiness.ts` |
| Booking-state claim guard (P33) | `server/ai/response/booking-state-claims.ts`; review-facts + block-reason guarantees in `natural-response-composer.ts` |
| Error vocabulary / retry policy | `server/ai/tool-runtime/tool-error-normalizer.ts`, `tool-retry-policy.ts` |
| LLM adapter + native tool messages | `server/ai/providers/openai-compatible-llm.ts`; MockLLM `server/ai/providers/mock-llm.ts` |
| System prompts | `server/ai/prompts/system-prompt.ts` |
| Response composer (sentence judge) | `server/ai/response/natural-response-composer.ts` |
| Claim guards | `availability-authority.ts` (P26), `claim-entity-binding.ts` (P28), `action-claims.ts` (P29), `reference-claims.ts` (P30), `outcome-claims.ts` (P32) in `server/ai/response/` |
| Railway providers | `server/railway/registry/provider-registry.ts`, `server/railway/providers/mock/` |
| Search commit | `server/railway/orchestrator/search-orchestrator.ts` |
| Booking prep / review / confirmation / execution boundary | `server/booking/` (`booking-preparation-service.ts`, `handoff/confirmation-policy.ts`, `execution/`) |
| Authority split + audit | `docs/AGENT_AUTHORITY.md` |
| Voice coordinator (turn detection, barge-in, stale, TTS queue, retrySpeech, voiceMetrics) (P21/P34) | `shared/voice/conversational-voice-agent.ts` |
| Structured STT transcript boundary (P34) | `shared/voice/transcript.ts` (`checkTranscriptForTurn`, `sanitizeTranscriptInfo`, `VoiceTranscriptRejectedError`) |
| End-of-turn detection (final + silence; INCOMPLETE, never submits interim) | `shared/voice/voice-turn-detector.ts` |
| P36-C batch STT (ElevenLabs Scribe v2) | server `server/voice/stt/elevenlabs-batch-stt.ts` + routes in `server/voice/live/voice-routes.ts` (`/api/voice/transcribe`, `/api/voice/config`); browser `src/voice/batch-speech-input.ts`, `src/voice/pcm-recorder.ts` |
| STT / TTS interfaces + deterministic mocks | `server/voice/stt/stt-provider.ts`, `server/voice/tts/tts-provider.ts`; browser adapters `src/voice/browser-voice-adapters.ts` |
| Voice → engine wiring (same agent) | `server/voice/server-voice-agent.ts` (`createEngineVoiceAgent`, `engineTurnProcessor`) |

## 4. Milestone history

| P | Commit | Summary |
|---|---|---|
| 7–9 | `447b7a1` | agent loop, booking engine, preparation/review/confirmation versioning |
| 10 | `11aecfe` | booking execution boundary (gateway, disabled executor, fail-closed) |
| 11 | `771da48` | secure handoff session, snapshot, confirmation, validator |
| 12 | `ed58596` | booking provider adapter boundary (idempotency, lock) |
| 13 | `7cf7139` | execution lifecycle, reconciliation (UNKNOWN never FAILED) |
| 14 | `170924d` | post-booking: records, PNR + live status (read-only tools) |
| 15 | `d2f7b32` | cancellation/modification safety (capability-gated) |
| 16 | `5680f02` | multi-turn context, ContextPatch, fact guard |
| 17 | `c4df6b5`, `7760198` | LLM tool runtime, parallel tools, fresh-data grounding |
| 18 | `ef0cdc4` | ConversationTurnEngine, streaming, interruption safety |
| 19–20 | `468e0c6`, `96ac5ff` | passenger workflow + review engine |
| 21 | `a796e72` | natural voice agent (streaming STT/TTS, opt-in barge-in) |
| 22 | `f5b2c01` | architecture audit, LLM-owned interpretation, LLM_UNAVAILABLE |
| 23 | `d494cd4` | real OpenAI-compatible LLM + native tool orchestration |
| 24 | — | (no prompt in this workspace) |
| 25 | `2715d7b` | claim classification, structured fact validation |
| 26 | `1a7395b` | strict seat-availability authority |
| 27 | `dadce16` | autonomous multi-step tool chains, step budget, chain trace |
| 28 | `b752ad2` | tool-result identity + claim-entity binding |
| 29 | `677b453` | truthful action state / progress-claim guard |
| 30 | `36c0469` | contextual reference resolution + agent memory |
| 31 | — | **no P31 commit exists in this workspace** (P32 was built on P30) |
| 32 | `397ce32` | full LLM agent authority + honest provider outcomes |
| 33 | `6f71466`, `74063e1` | AI-driven booking preparation + review + secure handoff readiness — see `docs/AGENT_AUTHORITY.md` §7 |
| 34 | `caa2ac4`, `8032d5c` (fare follow-up) | voice production hardening: structured STT boundary, no interim turns, TTS = final validated text only, barge-in/stale, TTS retry, voice observability — see `docs/AGENT_AUTHORITY.md` §8 |
| 35 | see `git log` | real railway data (RailCore/RailKit/RailRadar adapters + failover), provenance, capability matrix, LLM-chosen web research, server STT/TTS routes, IRCTC handoff boundary wording — see `docs/P35-REAL-INTEGRATION.md` |
| 36-C | `773651a` | ElevenLabs Scribe v2 BATCH STT for tap-to-talk — see §6c |
| UI | `b9d292a` | full mobile-first UI/UX rebuild (frontend only) |
| 36-C.1.1 | `b2afeca` | voice layer: TTS renderer, concise fact-weighted speech, STT fallback setting |
| 37 | see `git log` | LLM-native DIRECT multi-provider railway tools (`railcore_*`, `railradar_*`), no hidden failover — see §6d |
| 38 | see `git log` | Devanagari names/numbers, long messages (held passengers), agent token budget, IRCTC-like passenger form (berth/food from real data), eRail + RailYatri web connectors (unverified) — see §6e |
| 39 | see `git log` | API-first web fallback (ConfirmTkt live status, capability matrix, SOURCE_CONFLICT) + safe IRCTC handoff + Chrome extension prefill — §6f |

## 5. Standing rules (user-mandated; keep for every prompt)

1. Standalone repo only. Run `git remote -v` first and STOP if it points to RailBook. No push, PR or deploy without explicit approval.
2. Never enable real IRCTC, booking, payment or credentials. Never ask for or store password/OTP/CAPTCHA/card/UPI PIN/tokens.
3. The LLM decides (meaning, tools, order, references, wording). No keyword router, intent whitelist, response tree or auto follow-up tools. The backend only validates and protects.
4. No cross-turn railway cache. Same-turn dedup only. Every new enquiry gets fresh provider data. Never fake or fallback railway data. MOCK is never presented as live.
5. The 8 outcomes stay distinct (data, no results, unsupported, timeout, provider failure, malformed, stale, rejected).
6. MAX_TOOL_STEPS = 8 (never raise it silently). No second LLM call for cosmetic rewording. Text and voice share the same validated response.
7. Secrets go only in the gitignored `.env`. Never commit, log, echo, zip or put them in chat or LLM context.
8. **Testing:**
   - only the 3 grouped checks, once each, at the END;
   - on failure: fix, then ONE confirming run of the affected group only;
   - change a test expectation only when the implementation is clearly correct;
   - report failures honestly; tests never use real LLM credits.
9. Implement only after the user says IMPLEMENT. If a prompt is truncated, ask for the rest.
10. Every milestone: commit locally, and produce `/home/user/bookkaro-ai-agent-pNN.zip` containing the full project, the latest `dist/`, and `docs/` (incl. this file). Exclude `.env`, `node_modules`, `.git`.
11. Stop after each milestone. End the report with "P(N+1) NOT STARTED.". Don't redesign the premium UI.
12. Live check (when asked): only with a configured real provider, max 3 requests, no reruns.

## 6. Test groups

**P35 definition (latest):**
- G1 = `tsc --noEmit -p tsconfig.json` + `npm run build`.
- G2 = unit p17, p21, p22, p25–p30, p32, p33, p34 ×2, p35-provider-failover.
- G3 = integration p35-real-integration-e2e, p34-voice-e2e, p8-booking-engine, p10, p11, p16, p17, p21–p23, p25–p30, p32, p33.

P35 results: G1 PASS; G2 232/234; G3 290/302. Then p28 [D] was corrected to the session-dated GET_FARE (a targeted run gave 14/14). All remaining failures are pre-existing.

P35 test helpers: `tests/helpers/p35-fixture-fetch.ts` replays real trimmed provider bodies from `tests/fixtures/p35/` and re-dates them. It also lets tests inject faults and records calls. The fake keys only exist in tests.

### Older definition (P33 — booking milestone)

- **G1:** `npm run build` (tsc -b + vite build).
- **G2 (booking domain / security, unit):** `tests/unit/p9-passenger-readiness`, `p10-execution-gateway`, `p11-handoff-session`, `p12-booking-provider`, `p13-execution-lifecycle`, `p15-lifecycle-actions`, `p19-passenger-collection`, `p20-passenger-workflow`, `p23-real-llm-adapter`, `p32-agent-authority`, `p33-booking-preparation`.
- **G3 (NL / booking e2e):** `tests/integration/p8-booking-engine`, `p9-booking-preparation`, `p10-confirmation-boundary`, `p11-handoff-e2e`, `p12-provider-e2e`, `p13-lifecycle-e2e`, `p15-lifecycle-actions-e2e`, `p19-booking-preparation-e2e`, `p20-booking-review-e2e`, `p23-agentic-e2e`, `p32-agent-authority-e2e`, `p33-booking-e2e`.
- (P32 definition, for railway-information work: G2 = p17 + p25–p30 + p32 unit; G3 = p17 + p25–p30 + p32 e2e.)
- (P34 fare follow-up, fact-validation work: G2 = unit p34-fare-authority, p34-voice-hardening, p21, p22, p25–p30, p32, p33; G3 = integration p34-voice-e2e, p8-booking-engine, p16, p17, p21–p23, p25–p30, p32, p33 e2e. Result: G2 177/179, G3 249/260 — all failures pre-existing.)
- (P34 definition, for voice work: G2 = unit p34-voice-hardening, p21-voice-infrastructure, p22-architecture-hardening, p18-turn-engine, p25, p26, p29, p33; G3 = integration p34-voice-e2e, p21-natural-voice-e2e, p22-architecture-e2e, p23-agentic-e2e, p29-action-truth-e2e, p32-agent-authority-e2e, p33-booking-e2e.)

Known pre-existing failures in older suites (they also fail at earlier HEADs; report, don't "fix" blindly):
- p19 [13]/[14]/[20], p16 [2]/[6], p8 [19][H] + closed-tool-set, p17 e2e [14], p18 [11];
- p7-agent-loop Group 3, unit p18 [6][7][8], p23 [8], p7 unit SEARCH_TRAINS date;
- found during P33 (verified failing at `397ce32` too): unit p12 [13] (pins 5 REGISTERED_TOOLS; CHECK_PNR / TRACK_TRAIN exist since P14), integration p8 [24] (expects the old "Pehle train select kar lete hain, phir fare…" wording).

P33 final check (resolved): G3 p33 [2] now observes the FIRST decision request of the turn at the turn boundary (`sayObserved`: request index captured before the turn; asserted pre-application) for both the piecewise and the one-message count + details cases; the P33 G3 file passed 23/23.

Found during P34 (verified failing at `74063e1`, before any P34 code): unit p21 [11] (expects reason `BOOKING_SUCCESS_CLAIM`, P33 renamed booking claims), unit p22 [9], integration p21 [2] / [12] / [17] and p22 [K+L] (P33 review/date wording: "Haan ya nahi boliye." suffix, "6 Oct" instead of "parso").

**Fare-authority gap — FIXED (P34 final follow-up, see `git log`).** Previously a native agent's own ₹ amount with NO GET_FARE (or after GET_FARE = MALFORMED/TIMEOUT/failed) survived, because `factGuard` returned early when no tool step was ok, `judgeFareScope` returns null when the fact index has no fares, and the legacy P16 grounding validator accepts ₹ numbers found in search fixtures / any ok step. Fix (targeted, at the orchestration / fact-validation boundary): `judgeFareAuthority` (`server/ai/response/claim-facts.ts`) + `guardFareClaims` (`claim-entity-binding.ts`), applied in the orchestrator `factGuard` BEFORE the no-ok-tool early return and on the clarification path. Same code for TEXT and VOICE (the validated text feeds UI and TTS); no extra LLM call; composer, voice stack and P33 booking untouched. Regression: unit `p34-fare-authority`, integration `p34-voice-e2e` [P] (TEXT+VOICE × no-GET_FARE / malformed / correct). Newly seen in the follow-up's G3 (verified failing at `caa2ac4` too): integration p25 [J] (llmCalls count on the passengers turn).

### Pinned invariants (must not break)

- A serialized turn result never contains the key `"sourceResultId"` (P25–P27 e2e afterEach).
- **Fare authority (P34 follow-up):** a ₹/Rs/INR amount in any LLM-authored reply text is valid ONLY if the fact index holds a GET_FARE-derived fare (this turn's *successful* GET_FARE view, the session's committed quote, or the VERIFIED review snapshot) matching train / class / date / amount. No such fare → sentence removed, reason `UNVERIFIED_FARE:<n>` (diagnostics `binding.crossEntityRejections`) and `FARE:<n>` in `turnLog.rejectedClaims` (P16 invented-fact contract); mismatch → `FARE_MISMATCH:<n>` / `CROSS_DATE_FACT` (diagnostics only). Search-result fixture fares and malformed / failed / timed-out GET_FARE never authorize. Do not re-introduce an early return in `factGuard` ahead of the fare guard.
- P26 reasons: `UNVERIFIED_AVAILABILITY`, `CLASS_NOT_LISTED:<cls>`, `AVAILABILITY_MISMATCH`. P25: `FARE_MISMATCH:<n>`. P22: `UNGROUNDED_NUMBER:<n>`, `UNGROUNDED_FARE_AMOUNT:<n>`, `UNGROUNDED_COUNT:…`.
- P30 reference reasons: `STALE_INDEX_REFERENCE`, `INVALID_INDEX_REFERENCE`, `INDEX_REFERENCE_MISMATCH`, `NOT_IN_CURRENT_RESULTS`, `IN_CURRENT_RESULTS`.
- P32 outcome reasons: `NO_RESULTS_CLAIM_ON_<OUTCOME>`, `NO_RESULTS_CONTRADICTS_DATA`, `NO_RESULTS_CLAIM_WITHOUT_EMPTY_RESULT`, `SOURCE_CLAIM_*`, `MOCK_DATA_PRESENTED_AS_LIVE`, `LIVE_CLAIM_WITHOUT_LIVE_DATA`.
- P33: a review is VALID only with current matching availability AND fare (`DEFAULT_PREPARATION_POLICY` = both required); a NEW review version needs data from that turn — by EXECUTION IDENTITY (`turnExecutionIds` = this turn's LLM tool executions + the boundary refresh; `freshSince` timestamp only as fallback for entries without `toolExecutionId`; robust to frozen clocks); confirmation keeps the TTL window (`FRESHNESS_POLICY`).
- P33 booking-state reasons: `BOOKED_CLAIM_NEVER_VALID`, `HANDOFF_CLAIM_WITHOUT_HANDOFF`, `REVIEW_CLAIM_WITHOUT_CURRENT_REVIEW` (composer: `BOOKING_STATE_CLAIM:<r>`; outcomeClaims kind `BOOKING_STATE`). Composer fallbacks `REVIEW_FACTS_MISSING`, `REVIEW_BLOCK_REASON_MISSING`.
- P33: `context.bookingPreparation` carries statuses only (no ids, fare amounts, availability values, credentials). No service fee exists — none is added.
- Entity, action, reference and outcome rejections go to `diagnostics.*`, never into the orchestrator's `extra.rejectedClaims`.
- Never add fields to `provenance` entries. Keep new runtime counters out of `RailwayToolRuntime.validation`.
- Tool-limit text: "Request bahut lambi ho gayi — thoda simple karke poochiye." LLM_UNAVAILABLE text: "Maaf kijiye, main abhi jawab nahi de paa raha. Aapki booking details safe hain — thodi der mein dobara boliye."

- P34 voice: only a FINAL, non-empty transcript becomes a turn (`checkTranscriptForTurn`; engine throws `VoiceTranscriptRejectedError` BEFORE a turn exists; `/api/chat` → 422 `TRANSCRIPT_NOT_FINAL|TRANSCRIPT_EMPTY`). The detector never returns USER_FINISHED without a final (interim-only → USER_PAUSED `WAITING_FOR_FINAL`, then `INCOMPLETE` at `maxSilenceMs` 2000, nothing submitted). Low reported confidence (< `MIN_FINAL_CONFIDENCE` 0.35, 0 = unknown) = uncertain → treated as interim.
- P34 §7: the composer emits `onSegment` ONLY for the final validated segments, once (`emitFinal`, declared before `fallback`); never streams an LLM sentence before all guarantees ran.
- P34: TTS text passes `redactForSpeech` (masks `sk-|pk-|rk-|nvapi-|key-` + 8 chars, Bearer tokens). `retrySpeech()` re-speaks the CURRENT turn's validated outcome only (no turn / LLM / tool); refused for interrupted / stale turns. `snapshot().textFallback` = TTS output fallback; STT failure = `TEXT_FALLBACK` event + `lastError`. Do NOT add `snapshot()` keys (pinned by p21 e2e).
- P34 observability: `turnLog.voiceTurn` (VOICE only; statuses / counts / timings, no text) and client `agent.voiceMetrics()` (≤ 20 records, no text).

### Mock data (today-relative; ASR → NDLS)

- 12014 Shatabdi: CC/2S, 04:55→10:50, CC ₹520 available.
- 12497 Shan-e-Punjab: 3A/CC/SL/2S, 06:35→13:50, 3A ₹650 available (display index 2 of 3).
- 18238: 3A/SL, 19:35→04:10, SL Waitlist 8.

## 6b. Post-P35 live voice test (configuration only — P35 frozen, no code changes)

Status as of 2026-10-04:
- **TTS live: PASS.**
  - Config: `VOICE_TTS_PROVIDER=openai`, the RailBook Edge-TTS Render endpoint as `VOICE_TTS_BASE_URL`, `VOICE_TTS_MODEL=tts-1`, `VOICE_TTS_VOICE=hi-IN-SwaraNeural`, plus `VOICE_TTS_API_KEY`. All values are in `.env` only.
  - It returned a 48.8 KB MP3 in 2.3 s once the service was awake.
  - The first request timed out at the default `VOICE_TTS_TIMEOUT_MS=15000` because the free Render service was asleep. The timeout was left unchanged; optionally raise it with `VOICE_TTS_TIMEOUT_MS=60000`.
  - The endpoint is only called as an API client; nothing on it is modified.
- **Checks verified on the real server:**
  - `/api/voice/speak` ignores client-supplied text and returns 404 `NO_RESPONSE_TO_SPEAK` when there is no validated reply.
  - An INTERIM transcript on `/api/chat` returns 422 `TRANSCRIPT_NOT_FINAL`, creates no turn and makes no LLM call.
  - `/api/voice/turn` without STT returns 503 `VOICE_NOT_CONFIGURED` with `fallback: TEXT`.
  - `/api/health` voice status shows no key.
- **STT live and the end-to-end voice test: NOT RUN yet.** `VOICE_STT_PROVIDER`, `VOICE_STT_BASE_URL`, `VOICE_STT_MODEL` and `VOICE_STT_API_KEY` must be present in the server's environment or in `.env`. An external secret store is not visible inside the sandbox.
  - The STT endpoint must accept `POST {VOICE_STT_BASE_URL}/audio/transcriptions` (multipart: file, model, language, `response_format=json`) and return `{ text }`.
- **Next steps:**
  1. Run one live STT request.
  2. Run one end-to-end test: audio → `/api/voice/turn` → `processTurn(VOICE)` → Muse → RailCore → validated text → `/api/voice/speak` → TTS.
  3. Run focused parity and barge-in checks only (p34-voice-e2e, p34-voice-hardening, p21-voice-infrastructure).
  4. Do NOT run the full suite. Do NOT start P36 without the user's prompt.

## 6c. P36-C — ElevenLabs Scribe v2 batch STT (tap-to-talk)

**What changed: STT only.** Everything downstream is unchanged and authoritative: ConversationalVoiceAgent, VoiceTurnDetector, `normalizeTranscript`, `/api/chat`, the LLM agent, tools, validation, TTS, booking safety.

**Pipeline**
1. The user taps the mic and the browser records 16 kHz mono PCM16 (`src/voice/pcm-recorder.ts`).
2. Tapping again (release) submits the recording ONCE to `POST /api/voice/transcribe`.
3. The server calls ElevenLabs Scribe v2 batch and returns `{ transcript }` only. The route never calls `/api/chat`.
4. `BatchSttSpeechInput` hands the transcript to the EXISTING agent with `onFinal`: agent → turn detector → normalizer → `/api/chat` (mode VOICE, transcript status FINAL).

**Provider and request lock** (server constants in `elevenlabs-batch-stt.ts`; the client can change none of them)
- Provider ElevenLabs, model `scribe_v2`, mode **batch**. No realtime, WebSocket, v1 or fallback model, and no SDK (plain `fetch` + `FormData`).
- `POST https://api.elevenlabs.io/v1/speech-to-text` with header `xi-api-key` = `ELEVENLABS_API_KEY` (server env only).
- `language_code=hin`, with no translation.
- Keyterms `AC, 3A, CC, SL, RAC, WL`, sent as repeated multipart fields.
- `tag_audio_events=false`, `timestamps_granularity=word`, `diarize=false`.
- `file_format=pcm_s16le_16` for PCM. Encoded containers (webm/ogg/wav/mp4/mpeg) are accepted as a fallback; they are auto-detected and no `file_format` is sent.

**Why this set:** in P36-B.6 (one run per condition, synthetic corpus plus 20 real-human clips), the railway keyterm set scored:
- keywords 171/171 (baseline 160/171);
- AC 6/6, 3A 6/6, WL 3/3;
- 0 dangerous errors (baseline 3);
- a median latency cost of about +20 ms.

It is still not called production-ready. Pending: repeat runs, human sentence recordings, and a P34 check on Latin/digit output.

**Cost:** keyterms add a **+20% surcharge** on Scribe v2 batch (list price $0.22/h; using more than 100 keyterms would also raise the minimum billable duration to 20 s).

**Safety**
- *Turn IDs:* each recording has a unique `voiceTurnId`. A cancelled or superseded recording is discarded on the client and never reaches the agent or `/api/chat`; the server also returns 409 `STT_STALE_TURN` for a superseded id.
- *Retries:* at most ONE retry, on timeout / network / 429 / 5xx only. The per-attempt timeout is bounded.
- *Audio validation:* type, size (≤ 2 MB), duration (250 ms–60 s), PCM framing, digital silence, and session ownership. All checks run before any paid call.
- *No persistence:* audio is kept in memory only, with no temp files, and is never logged.
- *Logs* contain only session/turn id, provider, model, latency, success, transcript length and error category. They never contain audio or transcript text.
- *Errors:* `STT_CONFIG_MISSING`, `STT_AUDIO_INVALID`, `STT_AUDIO_TOO_LARGE`, `STT_PROVIDER_TIMEOUT`, `STT_PROVIDER_AUTH_ERROR`, `STT_PROVIDER_RATE_LIMIT`, `STT_PROVIDER_UNAVAILABLE`, `STT_PROVIDER_BAD_RESPONSE`, `STT_STALE_TURN`, plus two additive codes, `STT_NO_SPEECH` and `STT_SESSION_INVALID`. Each has a short Hinglish message and never includes a raw provider body. A failure starts no agent turn and no tool, and typing stays available.
- *No interpretation:* confidence/logprob is ignored (never authorization). There is no AC→एसी conversion, and STT output is never railway truth.

**Config, health and fallback**
- `GET /api/voice/config` returns `{ stt: { enabled, provider:'elevenlabs', model:'scribe_v2', mode:'batch', keytermsEnabled, audio:{…} }, browserFallback:true }`.
- `/api/health` `voice.batchStt` reports config presence only and makes no provider call.
- If the key is missing, `enabled` is false and tap-to-talk falls back to the existing browser recogniser (or typing).
- The opt-in hands-free conversation mode (voice barge-in needs streaming speech activity) keeps using the browser recogniser. Tap barge-in works with batch.
- UI states: Recording → Transcribing → Thinking (`PROCESSING`) → Speaking.

**Tests:** `tests/unit/p36c-elevenlabs-stt.test.ts` (G2) and `tests/integration/p36c-voice-stt-e2e.test.ts` (G3). Both use a fake fetch only, with no real ElevenLabs call.

**Live status:** a live ElevenLabs STT call through BookKaro has NOT been run (no credits spent). The key is not in BookKaro's `.env`; set `ELEVENLABS_API_KEY` in the server environment to enable it.

## 6d. P37 — LLM-native direct multi-provider railway tools

- **Tools the LLM sees (live mode):** `<provider>_<capability>` for every CONFIGURED real connector only, built in
  `server/ai/tools/provider-tools.ts` (`providerToolCatalog`) and registered in
  `server/railway/registry/provider-registry.ts` (`registerLiveProviderTools`, from `PROVIDER_CAPABILITY_MATRIX`).
  - Suffixes: `search`, `train_info`, `timetable`, `availability`, `fare`, `live_status`, `pnr`.
  - RailCore: no `pnr`. RailKit is listed only when its key is set.
  - ConfirmTkt, RailYatri and eRail can NEVER be registered. Calling them returns PROVIDER_NOT_IMPLEMENTED.
  - Generic `SEARCH_TRAINS` etc. are hidden in provider mode. A generic call from the LLM returns PROVIDER_TOOL_REQUIRED.
- **Execution:**
  - `mapProviderToolCall` (llm-tool-runtime) maps the call onto the canonical contract, with `provider` and `toolName`.
  - The runtime runs `executor.execute` inside `inProviderScope` (AsyncLocalStorage, `provider-scope.ts`), so
    `railwayRegistry.getActive()` returns exactly that connector. There is no failover chain.
  - Provider is part of the loop, failure and duplicate signatures, so parallel same-args calls on two providers both run.
- **Results to the LLM** carry `providerTool` plus `providerStatus` (SUCCESS / NO_RESULTS / PROVIDER_TIMEOUT / …). The
  LLM decides on any fallback (prompt "RAILWAY PROVIDER TOOLS").
- **Booking re-validation** (`BoundToolRuntime.runTools`, backend) reuses the provider the LLM used in this turn, else
  the first configured connector. It also has no hidden chain.
- **Stations and dates:** the LLM passes official codes and YYYY-MM-DD, and `ctx.today` (IST) is sent.
  - `route-resolver` accepts any `^[A-Z]{2,5}$` code in provider mode.
  - `context-patch` trusts LLM semantics for Indic-script user text, where the backend has no parser. Latin-script
    grounding and ambiguity checks remain.
- **Budget:** the native step is no longer silently cut to 6 calls (bound 32). `MAX_TOOL_CALLS_PER_TURN` and
  `MAX_TOOL_ROUNDS_PER_TURN` (env, default 8 / 5) reject the excess with TOOL_CALL_LIMIT_EXCEEDED.
- **Observability:** `ToolExecutionRecord.providerTool` + `provider`; `turnLog.toolCalls[].provider/providerTool`.
- **Mocks** (tests only, labelled MOCK): `server/railway/providers/mock/mock-provider-connectors.ts`, for RailCore and
  RailRadar only, with fault injection and fare override.
- **Tests:** `tests/integration/p37-provider-tools.test.ts` (14 scenarios).
- **Known limitation:** with parallel same-route searches, the session/cards show the list from the search that
  completed LAST. The LLM still receives both results separately.

## 6e. P38 — Hindi/Devanagari, IRCTC-like passenger form, web connectors (eRail / RailYatri)
- **Devanagari**: `shared/devanagari-numbers.ts` maps ०–९ and the words एक…दस (+ unit words) to ASCII — a *validation* aid for
  LLM-proposed counts (`passenger-count.ts`, `grounding.ts`), not an intent parser. `canonicalName` accepts `\p{M}` (matras).
  The system prompt tells the LLM to transliterate Devanagari names to editable English (IRCTC needs Latin names).
- **Long messages**: passenger changes given before train+class exist are *held* (`session.heldPassengerChanges`, keyed
  by journey) and applied automatically once both are selected (`turn-applier.ts`); the context shows
  `heldUntilTrainAndClassSelected`.
- **Token budget**: `MAX_TOKENS_AGENT` 1400 → 3200 (env `LLM_MAX_TOKENS_AGENT`, clamp 800–8000). Muse (reasoning model)
  spent all 1400 on reasoning for Devanagari multi-passenger turns → `finish_reason=length`, no tool call → LLM_UNAVAILABLE.
  Not a step limit / guard.
- **Passenger form** (`server/booking/passenger-form.ts`; `GET/POST /api/session/:id/passenger-form`;
  UI `src/components/passengers/PassengerFormPage.tsx`, full-screen `bk-pform`):
  berth options only from the class layout (`BERTH_OPTIONS_BY_CLASS`; seat classes CC/EC/2S… → none);
  food (`VEG`/`NON_VEG`/`NO_FOOD`) only when the train's provider schedule says `catering: true` (RailCore schedule
  flags; `/routes/trains has_pantry` contradicts them — not used). Names must be Latin; server `fieldErrors`;
  409 on stale `sessionVersion`. `foodPreference` flows to review, snapshot, execution request and IRCTC handoff payload
  (conditional spreads only).
- **Web connectors** (`server/railway/providers/web/web-providers.ts`): `erail_search` (eRail `getTrains.aspx`; trains,
  timings, run days, classes; NO fare / availability — robots disallows `/Rail/getAvailability.aspx`) and
  `railyatri_live_status` (`__NEXT_DATA__.ltsData`; crowd-sourced, may be stale). Results carry
  `verification: UNVERIFIED_WEB` + label `WEB (eRail/RailYatri) — unverified`. The LLM decides when to use them (no automatic
  switch). ConfirmTkt stays PROVIDER_NOT_IMPLEMENTED (robots + private API). Booking review stays API-only.
- Tests: `tests/unit/p38-hindi-form-web.test.ts` (20). Live harness outside the repo: `/home/user/p38/` (`g3.py`,
  `cases-final.json`, `form_test.py`).

## 6f. P39 — API-first web fallback + safe IRCTC handoff + extension prefill

**Web fallback (LLM-chosen, never automatic)**
- Order in the prompt: RailCore → RailRadar → web. A web tool is used only after the LLM saw the API failures
  (`priorApiFailures` is attached to web results). The backend never switches.
- `WEB_SOURCE_CAPABILITIES` (`server/railway/providers/web/web-providers.ts`, `GET /api/railway/web-capabilities`) is the
  verified matrix (2026-10-05): eRail SEARCH = IMPLEMENTED (availability BLOCKED_BY_ROBOTS, fare UNVERIFIABLE);
  RailYatri LIVE_STATUS = IMPLEMENTED (availability PRIVATE_API, fare page 404); ConfirmTkt LIVE_STATUS = IMPLEMENTED
  (`/train-running-status/{no}`, server-rendered, robots-allowed; search + PNR BLOCKED_BY_ROBOTS). Web availability and
  web fare tools are NOT exposed. A blocked capability returns `WEB_ACCESS_BLOCKED` without any fetch.
- `toWebRailwayResult` envelope: source, label, `verification: UNVERIFIED_WEB`, freshness (`WEB_REPORTED_TIME` when the page
  shows "Last Updated", `WEB_CURRENT` for search, else `WEB_UNVERIFIED`; API = `LIVE_API`). No caching — "abhi / dobara"
  makes a new call (validator still needs the train number in the user's message; it never guesses).
- **SOURCE_CONFLICT**: in one turn, two providers returning different availability / fare for the same
  train|class|date → `sourceConflict {kind, values[{provider, value}]}` goes to the LLM, the conflicting session
  fare/availability is removed (no silent pick), `s.sourceConflicts` keeps the last 5 (no values). Provider = the id the
  LLM named (`railcore`, not `mock-railcore`).
- Web data is never authoritative booking data; the review still needs API availability + fare.

**IRCTC handoff**
- `shared/irctc-handoff.ts` (statuses, events, `IRCTC_TEXT`, max 6 passengers, TTL 20 min, bridge-token header).
- `server/irctc/handoff/irctc-handoff-manager.ts` — created only from a READY booking handoff + VALID confirmation +
  current review fingerprint (inside the existing confirm path, **no new booking events** — p10/p11 pin the sequence).
  Snapshot = validated values only (no secrets). `parseEvent` accepts metadata only (field keys + reason codes; unknown
  keys rejected; sensitive data → 400). COMPLETED only from the IRCTC confirmation page; flow ended without it →
  BOOKING_STATUS_UNKNOWN (an UNKNOWN can still be resolved by a later confirmation/failure page; everything else
  terminal stays terminal). Booking details change → STALE_HANDOFF. BookingSession is never set COMPLETE.
- `irctc-station-formatter.ts` — station "NAME - CODE" queries, DD/MM/YYYY, class labels "(CC)", passengers
  (`notConfirmed` reasons e.g. NAME_LENGTH_IRCTC_3_16, GENDER_NOT_REPRESENTABLE).
- Routes: `GET|POST /api/session/:id/irctc-handoff` (owner: view + snapshot + bridgeToken),
  `GET /api/irctc/handoff/:id` + `POST /api/irctc/handoff/:id/events` (header `X-BookKaro-Bridge-Token`),
  dev only `GET /api/dev/mock-irctc[/:scenario][?train=NNNNN]` (disabled when `RENDER` is set / production).
- UI: `irctc_handoff` card → `src/components/irctc/IrctcAssistPage.tsx` (values + copy buttons, user-only checklist,
  language EN/हिंदी, "Send to extension", "flow ended without confirmation" button).
- **Extension** (`extension/`, MV3, load unpacked): `bookkaro-bridge.js` (same-window postMessage on the BookKaro origin)
  → `background.js` (`chrome.storage.session`: apiBase, handoffId, bridgeToken only) → `irctc-content.js` +
  `irctc-core.js` (UMD; unit-tested with happy-dom; `extension/package.json` = commonjs only for Node tests).
  Fills only visible normal controls; never types into login / CAPTCHA / OTP / payment / mobile fields; Search / Book Now
  / Continue / Pay are **highlighted, never clicked**; user edits always win (pause + ask); a passenger page showing a
  different train than the review → nothing filled, paused (TRAIN_DIFFERENT_ON_PAGE) until the user taps Resume.
  Mock-data handoffs are refused on real IRCTC. No `pagehide` "flow ended" (navigation also fires it).
- **P39.1 (user report: passenger details not filled on IRCTC)** — v0.39.1: a CSS-hidden login form made the passenger
  page detect as LOGIN (visibility now uses computed style); the name field is `<p-autocomplete formcontrolname=
  "passengerName">` wrapping a plain input (wrapper formcontrolname is now part of the descriptor); IRCTC journey
  defaults (today's date, last search) are replaceable unless the user edited them (passenger fields stay strict);
  assistant pauses are page-scoped; retries while Angular renders; "+ Add Passenger" only after the row count has been
  stable for 2.5 s; "Fill again" button + metadata-only diagnostics line; `/nget/` route fallback. MockIRCTC now has
  23 scenarios (`irctc-home-defaults`, `irctc-passenger-real`, `irctc-passenger-late`).
- **P39.2 (user report: "LLM form open hone par details khud nahi pooch rha")** — the agent now ASKS passenger details in
  chat / voice (name, age, gender + berth preference only for classes with berths, meal Veg / Non-veg / No food only
  when the provider schedule says catering); answers go into `s.passengers` and the passenger form shows them
  prefilled (form stays as an alternative). Pieces: `server/booking/passenger-options.ts` (berth options per class from
  the standard IR layout, `foodStatusOf`, `gateOptionalField` — a value not offered is dropped with a reason, never
  stored); `foodPreference` accepted end-to-end (validator, collection, change-validator, tool schema, prompt);
  context `bookingPreparation.passengerOptions` + top-level `alsoAsk` (never per-passenger keys — p33 [2] toEquals the
  per-passenger shape); `server/booking/train-facilities-prefetch.ts` — once train + class are selected the backend
  fetches that train's catering flags once (same `fetchTrainFacilities` the form uses, provider of the results), fire-
  and-forget after the turn, awaited ≤3 s before the next turn; failure → NOT_CHECKED/UNKNOWN → no meal offered.
  turn-applier: SHOW_REVIEW while COLLECTING_PASSENGER_DETAILS is no longer refused (preparation runs after the tool
  loop and decides: review if every gate passes, else the next missing detail) — before this, "details + review" in
  one turn always answered "Review ke liye abhi details poori nahi hain". Also fixed p33 unit [18] (P39 handoff
  `message` was persisted on the session; `sync()` now strips it — text lives in API view / card only).
  Known: p33 e2e G3 [21] fails since P39 — the spec-mandated READY handoff text names CAPTCHA/OTP and that test scans
  turn responses for those words (reword e.g. "login, security checks…" if the user wants). Tests:
  `tests/unit/p39-2-passenger-chat.test.ts` (14). Live Muse check (3 flows, 3A berth / CC meal / 2A no-catering) → all
  reached a correct review.
- **P39.3 (IRCTC handoff + real browser autofill completion, extension v0.39.3)** — additive only. Backend `snapshotOf`
  adds `schemaVersion`, `sourceReviewVersion` (= record reviewVersion) and `integrity` = HMAC-SHA256(bridgeToken,
  `irctcIntegrityPayload`) (shared/irctc-handoff.ts: `canonicalJson`, `IRCTC_INTEGRITY_FIELDS`, error-code list).
  New `extension/irctc-handoff-guard.js` (exact host `www.irctc.co.in` + `/nget/`, or mock `/api/dev/mock-irctc[/…]`;
  strict schema; binding handoffId + reviewVersion; expiry; WebCrypto HMAC) — loaded first by the IRCTC content
  script and by background.js (`importScripts`). Assist page posts `reviewVersion`; BK_REGISTER requires it; refusals =
  `STALE_IRCTC_HANDOFF` + reason and the registration is dropped. BK_GET_SNAPSHOT / BK_EVENT only from approved
  IRCTC senders. irctc-core: PrimeNG p-dropdown (async panel), async station flow (focus/keydown/input/keyup, exact
  "- CODE", settle re-check), p-calendar re-verify, language "preferred language" dialog (buttons scoped to it),
  TRAIN_LIST before HOME_SEARCH + `app-train-avl-enq`, bare class tabs, date-cell highlight, passenger placeholder
  "Full Name as per Govt. ID", maxlength (never truncates), post-fill re-read; additive `rep.errors` (typed codes) and
  `rep.stopped` (station/date failure → Search not highlighted). `rep.skipped` reasons unchanged. Real-like mock pages
  in `server/irctc/mock/mock-irctc-real.ts` (`MOCK_IRCTC_REAL_SCENARIOS`; the original 23 untouched). Tests:
  `tests/unit/p39-3-irctc-autofill.test.ts` (16, real timers) + `tests/integration/p39-3-irctc-handoff-guard.test.ts` (6).
  G5 (real IRCTC) is user-run only.
- **Real IRCTC DOM was never inspected** (Akamai 403 from the sandbox). MockIRCTC (20 scenarios,
  `server/irctc/mock/mock-irctc.ts`) is a reconstruction; selectors use labels / placeholders / formcontrolname /
  ARIA, not fixed ids. G5 (real IRCTC up to, not including, the paid booking) is **user-run**.
- Tests: `tests/unit/p39-web-fallback.test.ts` (9), `tests/unit/p39-irctc-extension.test.ts` (14, happy-dom),
  `tests/integration/p39-web-conflict.test.ts` (5), `tests/integration/p39-irctc-handoff.test.ts` (13). Real-Chromium
  E2E harness (outside the repo): `/home/user/p39/e2e/e2e_p39.py` (mock LLM + mock railway + Vite + unpacked extension).

## 7. Practical gotchas

- `.git/config` may not persist between workspaces. Set the identity again: `git config user.name "BookKaro Dev"; git config user.email dev@bookkaro.local`.
- Patch with exact-match replacements and grep `tests/` before changing user-facing strings or error codes.
- A new `ToolErrorCode` needs entries in `shared/railway-tool-runtime.ts`, `RUNTIME_CODES`, `SAFE_ERROR_MESSAGE`, and (if terminal) `NON_RETRYABLE_ERRORS`.
- Native tool calling needs a tool message for every `tool_call_id`. Muse takes ~12–40 s per turn (timeout ≤ 60 s).
- Use `rt.toolExecutions` / `turnLog.diagnostics.*` in tests. Voice tests need `agent.listen()` first.
- P35 provider rules:
  - live provider normalizers must echo the requested identity (train, date, class), or the runtime rejects the result as RESULT_IDENTITY_MISMATCH;
  - `RailwayMeta` uses `providerId`;
  - never add fields to `provenance`; use `meta` or view fields instead.
- P35 execution boundary: a `BOOKING_EXECUTION_DISABLED` turn always states "Booking execution abhi enabled nahi hai" (`statesExecutionBoundary` in the composer and the orchestrator).
- Never put provider keys anywhere but `.env`. Before zipping, grep the zip for every key value.

## 8. Next-step template (for P36+)

1. `git remote -v` (stop if it shows RailBook) → `git log --oneline | head` → `npm ci`.
2. Read this file + `docs/AGENT_AUTHORITY.md`.
3. Wait for the user's prompt. Audit, then implement after IMPLEMENT.
4. Add `tests/unit/pNN-*.test.ts` + `tests/integration/pNN-*-e2e.test.ts`. Run G1/G2/G3 once each.
5. Update this file (history row, new invariants). Commit. Build the zip (with `dist/` + `docs/`). Report. STOP.
- **P39.3 verification (extension v0.39.4)** — smallest additive fix: date fill fires one `keydown` before setting the
  value (PrimeNG Calendar `isKeydown` guard); mock p-calendar emulates the guard (test [8] fails without the fix).
  User test package: `bookkaro-irctc-user-test-package.zip` (guide, result form, env template — no secrets).
  G5 real IRCTC = USER VERIFICATION REQUIRED.
- **LLM fallback model (user-requested)** — `LLM_FALLBACK_MODEL=openai/gpt-oss-20b` (same NVIDIA endpoint/key) wraps the
  primary (`meta/muse-glimmer-30b`) in `server/ai/providers/fallback-llm.ts`, only when the env var is set. Switches on
  LLM_TIMEOUT / NETWORK / RATE_LIMITED / HTTP errors (never on abort/auth/bad response); 5-min cooldown
  (`LLM_FALLBACK_COOLDOWN_MS`), fallback timeout `LLM_FALLBACK_TIMEOUT_MS` (60 s). Visible: log
  `{"llm":{"event":"LLM_FALLBACK_USED",...}}`, `/api/health` `llm.fallback` state, turn diagnostics `model`. Both fail →
  normal LLM_UNAVAILABLE. Per-call timeout cap is 120 s (`2b36ddc`). Tests: `tests/unit/llm-fallback.test.ts` (7).
- **Seat / berth preferences = verified IRCTC passenger-form choices** (`shared/constants.ts` BERTH_OPTIONS_BY_CLASS):
  SL/3A/3E: Lower/Middle/Upper/Side Lower/Side Upper · 2A: Lower/Upper/Side Lower/Side Upper · 1A: Lower/Upper/Cabin/Coupe ·
  CC/2S/EC: Window Side only (EC seen on the real IRCTC page for 12014 EC) · EA/EV/unknown: none (not verified).
  New enum values WINDOW (existing), CABIN, COUPE → IRCTC labels "Window Side" / "Cabin" / "Coupe" in the handoff.
  Also fixed: live trains selected via the agent were labelled MOCK ("Development data — not live") — `setSelectedTrain`
  now derives LIVE from the row's provider (unknown stays MOCK). Tests: `tests/unit/seat-preference-cc.test.ts`.

## Berth/seat preferences — confirmed from IRCTC's own code (uncommitted, after f0271fc)
- Source: www.irctc.co.in/nget lazy chunk `8-es2015.d29198c5a744dd83df7f.js` (BookingModule, `app-passenger-input`),
  `main` berthName pipe, `assets/json/labels_en.json` (fetched Oct 2026).
- IRCTC passenger berth <select> = `No Preference` + `bookingConfigurables.applicableBerthTypes` (server bkgCfg, per
  train/class/date, after login — BookKaro never calls it). Codes→labels: LB Lower, MB Middle, UB Upper, SL Side Lower,
  SU Side Upper, SM Side Middle, WS Window Side, CB Cabin, CP Coupe.
- Change: added `SIDE_MIDDLE` (IRCTC SM, "Side Middle") for 3E only; constants comment cites the IRCTC source; form note
  says IRCTC decides per train. Extension unchanged (labels already exact; unknown option → field reported, never substituted).

## v0.39.5 — 3E selection, IRCTC-accurate passenger form, berth autofill on real IRCTC, auto Search / Book Now
- **3E → 3A bug:** `canonicalClassToken` mapped `3e` to `3A`; 3E (AC 3 Economy) now has its own rule before 3A.
- **Berth / food not filled on www.irctc.co.in:** IRCTC `<app-passenger>` (BookingModule chunk `8-es2015.d29198c5a744dd83df7f.js`)
  keeps Name/Age/Gender in a `<span>` and Berth/Food in sibling `<div>`s → `rowContainer()` never contained them. Now looked up in
  `passengerScope()` (the `app-passenger` component when it holds exactly one row). IRCTC option VALUES are a fallback when the text
  differs (`pageOptionLabel`: berth LB MB UB SL SU SM WS CB CP, food V N D, gender M F T — Hindi page, food "No Food/Beverages").
  IRCTC's untouched food default ("No Food/Beverages" / "Catering Service Option") is not treated as a user edit.
- **Auto-advance (user-requested):** `Core.autoAdvance()` (separate from `fillPage`, which stays highlight-only): journey Search
  only after From/To/Date/Class verified with no error/user edit; train list → reviewed train only: class tab (IRCTC "Refresh")
  → wait for the journey-date `.pre-avl` cell → tap → wait until IRCTC enables "Book Now" (no `disable-book`) → tap once (one more
  only after IRCTC login returned to the list). REGRET / missing train / class / date → stop with a message. Pause/Stop halt it.
  Passenger Continue, CAPTCHA, OTP, final Book, payment untouched. Manifest 0.39.5.
- **BookKaro passenger form:** `src/components/passengers/irctc-age-category.ts` — age 1–4 "Child · 5 saal se kam (IRCTC: Infant)"
  with IRCTC's infantMsg rule, 5–11 "Child (5–11)" with the IRCTC "Opt Berth" note, 12+ Adult (display only, no logic/API change).
  Berth/food labels = exact IRCTC texts.
- Tests: new `tests/unit/p39-5-irctc-real-dom.test.ts` (13, fixtures copied from IRCTC templates; old core fails [1]–[5]).
  G3 (real Chromium + v0.39.5): `/home/user/p39_verify/e2e/e2e_verify_v0395.py` 23/23.
- **v0.39.6 (3 user-reported issues, extension 0.39.6)** — smallest additive fixes, diagnosed first.
  1. *Search Trains not auto-tapped*: IRCTC's own label is `lang.search = "Search Trains"` (labels_en.json); the
     extension's HOME_SEARCH matcher required exactly "Search" (MockIRCTC used "Search", so tests passed while the real
     site failed). `findFinalControl` now matches search / search trains / find trains / खोजें / ट्रेन खोजें, else the
     journey form's `button.search_btn|train_Search` whose text says search (never "Modify Search"). autoAdvance on
     HOME_SEARCH is gated by From / To / Date / Class errors; a quota error only blocks when the IRCTC quota label is not
     the snapshot quota (never searches with another quota).
  2. *Confirm asked twice*: `reviewFingerprint` carries availability / fare `retrievedAt`; slow LLM turns make them stale
     (2 / 10 min) before "haan", the confirm-time refresh always changed the fingerprint → review v2 + second confirm.
     Now, in that refresh branch, when no value changed and the fingerprints differ ONLY in the check times
     (`sameExceptCheckTimes`), the confirmed review is rebuilt in place (same reviewVersion, fresh data / snapshot,
     fingerprint carried forward) and the flow continues to confirmation → handoff. Any real change still re-asks
     (p11 G3 [14]/[15] unchanged).
  3. *Passenger details step by step*: context `bookingPreparation.nextToAsk = { passenger, field }` (state fact; order
     name → age → berth (if class offers) → gender → meal (if catering OFFERED); passenger 1 finished before 2). Prompt:
     ONE detail per reply from nextToAsk, answer into that passengerIndex, volunteered details still accepted. Duplicate
     guard: chat proposal / passenger form rejecting a passenger identical (name + age + gender) to another
     (INVALID_PASSENGER_VALUE / field error; no values in messages).
  Tests: `tests/unit/p39-6-fixes.test.ts` (9), `tests/integration/p39-6-confirm-once.test.ts` (3) — all fail on the
  old code. Focused 21 files 318/318, tsc 0. G5 still USER VERIFICATION REQUIRED. (commit a44fb90)
  Follow-up (live Muse check after a44fb90): Muse answered "31" with "age 31 noted" but NO update_booking_session (nothing
  stored; the backend's honest "… ki umar kitni hai?" was appended), and after a stored name it asked the age while
  the backend appended its own age question too (doubled). Fixes: prompt + passengerChanges tool description — a bare
  answer to nextToAsk MUST be stored via update_booking_session before replying; shared `nextPassengerDetail()`
  (server/booking/passenger-options.ts) used by context + compose; compose() no longer appends the backend
  name/age/gender question when the agent's own reply asks a question AND (a passenger detail was really stored this
  turn OR nextToAsk is berth / meal). Replies without their own question (mock / deterministic) keep the backend
  question (p9 unchanged). Test `tests/integration/p39-6-passenger-steps.test.ts` (native fake-OpenAI stack; fails on
  the old orchestrator with the exact doubled question). Focused 26 files 371/372 (p23 [8] pre-existing, fails on HEAD).
  Follow-up 2 (live Muse re-check after a4f9f58: age now stored; "window" answered without a tool call, imperative
  "…bataiye." without "?" still got the backend question appended): context nextToAsk now also carries `options` (berth /
  meal choices for that field), `askOnlyThis: true` and `saveAnswerWith` (the update_booking_session passengerChanges
  shape for that passenger + field); compose() counts a Hinglish request ("bataiye / batao / boliye / chuniye …") as the
  agent's own question (output de-dup only, not routing).

## v0.39.7 — mobile IRCTC Search auto-tap + food choice only on IRCTC pre-paid catering trains

User report (Android Lemur Browser screenshots): Search not auto-tapped on IRCTC; overlay stuck on "fill kiye ja rahe hain —
Search aap khud tap karein"; BookKaro form showed food for 14680 (IRCTC has none).

- `extension/irctc-core.js`: new `journeyOnPage(doc, snapshot)` reads From / To / Date / Class / Quota back from the IRCTC
  form. HOME_SEARCH `autoAdvance` gates Search on it (plus: fill not stopped, no user override, Search not yet tapped)
  instead of "which fields THIS fill round reported". `out.missing` names the failing fields. Visible-button pick already
  skips IRCTC's hidden desktop twin (`button.hidden-xs.search_btn`; mobile = `hidden-sm hidden-md hidden-lg`).
- `extension/irctc-content.js`: a repeat tick of an already-handled fill page returns BEFORE the generic page message
  (the outcome stays visible); HOME_SEARCH re-fills + re-verifies up to 6× (1.5 s) on JOURNEY_NOT_VERIFIED /
  SEARCH_NOT_FOUND, then says why Search was not tapped; diagnostics carry `v<manifest version>`.
- `shared/irctc-handoff.ts` JOURNEY_PAGE text: "… verify hote hi BookKaro Search tap karega."
- `shared/irctc-catering.ts` `irctcFoodChoiceOffered(trainName)`: Rajdhani / Shatabdi / Duronto / Vande Bharat / Tejas /
  Gatimaan → true; Jan Shatabdi and everything else → false; empty → null. `railcore-provider.getTrainInfo` sets
  `facilities.catering` from it. RailCore's schedule `catering` flag is NOT used: it is wrong vs IRCTC (14680 true; 12952
  Rajdhani, 22488 Vande Bharat, 12030 Shatabdi false). `foodStatusOf` / form / chat are unchanged and follow the flag.
- `passenger-form.ts` food notes reworded (IRCTC offers / does not offer a meal choice).
- Manifest 0.39.7. Tests: `tests/unit/p39-7-fixes.test.ts` (8).

## P40 — Android app shell + native IRCTC WebView (local commit only; NOT pushed, NOT deployed)
- `android/` holds the Kotlin debug shell; see `android/README.md`.
  - BookKaro WebView: `MainActivity`. IRCTC WebView: `IrctcActivity`.
  - Narrow WebMessage bridges `BookKaroAndroid` / `BookKaroIrctc` (origin-restricted, main frame only).
    There is no `addJavascriptInterface`.
- It reuses the P39.3 signed handoff unchanged and the UNMODIFIED extension page scripts (copied into the APK at
  build time). Android behaves exactly like the desktop extension: auto-tap Search, then the class tab, date and
  Book Now. It never taps passenger Continue, CAPTCHA, OTP, final Book or Payment.
- Web change: `src/components/irctc/IrctcAssistPage.tsx`.
  - With `window.BookKaroAndroid` present, "Continue to IRCTC" goes to the native app.
  - The browser/extension path is unchanged.
  - This needs a deploy before the installed APK sees it. The deploy is not done yet.
- Vectors: `scripts/p40-android-vectors.ts` writes `android/app/src/test/resources/p40-handoff-vectors.json`.
  Re-run it whenever the handoff schema or guard changes.
- Sandbox notes: no KVM, so the emulator was NOT RUN. Gradle needs ~1 GB, so never run `tsc` or vitest alongside it.
- G5 (a real device with real IRCTC) = USER VERIFICATION REQUIRED.
- Rebuild note: the first P40 commit (`a97dc17`) was never pushed and was lost when the workspace went over the
  ~128 MB snapshot cap. It was rebuilt from the debug APK (manifest / resources / decompiled classes) plus the unchanged
  JS sources, then re-verified (Gradle JUnit 22/22 + assembleDebug, tsc, vitest p40 17/17, npm run build).
- Workspace rule: keep `/home/user` under ~100 MB (no stacks of milestone zips). After a reset run
  `bash /home/user/restore-workspace.sh [--android]` (remote, fetch, npm ci; `--android` = JDK 17 + SDK 34 + Gradle 8.7
  in `/home/user/.cache/android-toolchain`, `source .../env.sh`). Build the APK with
  `cd android && ./gradlew --no-daemon testDebugUnitTest assembleDebug` (never alongside tsc / vitest).
