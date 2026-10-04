# BookKaro AI Agent — Continuation / Handoff

Read this first in a new workspace. It is enough to continue the project from this zip alone.

## 1. What this is

BookKaro is a mobile-first Hindi/Hinglish/English **railway assistant** (text + voice) with a conversational booking
*preparation* flow. A real LLM (OpenAI-compatible, e.g. NVIDIA `meta/muse-glimmer-30b`) is the agent: it decides
meaning and tools. The backend is a strict safety and validation boundary. **Phase 1:**
- railway data comes from `MockRailwayProvider` (labelled non-live);
- real booking, payment, IRCTC login and submission are **disabled** (interface-only handoff).

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
- `RAILWAY_PROVIDER` defaults to `mock` (the only registered provider). `REAL_IRCTC_ENABLED` must stay off.

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
| 34 | `caa2ac4` + fare follow-up (see `git log`) | voice production hardening: structured STT boundary, no interim turns, TTS = final validated text only, barge-in/stale, TTS retry, voice observability — see `docs/AGENT_AUTHORITY.md` §8 |

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

## 6. Test groups (P33 definition — booking milestone)

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

## 7. Practical gotchas

- `.git/config` may not persist between workspaces. Set the identity again: `git config user.name "BookKaro Dev"; git config user.email dev@bookkaro.local`.
- Patch with exact-match replacements and grep `tests/` before changing user-facing strings or error codes.
- A new `ToolErrorCode` needs entries in `shared/railway-tool-runtime.ts`, `RUNTIME_CODES`, `SAFE_ERROR_MESSAGE`, and (if terminal) `NON_RETRYABLE_ERRORS`.
- Native tool calling needs a tool message for every `tool_call_id`. Muse takes ~12–40 s per turn (timeout ≤ 60 s).
- Use `rt.toolExecutions` / `turnLog.diagnostics.*` in tests. Voice tests need `agent.listen()` first.

## 8. Next-step template (for P35+)

1. `git remote -v` (stop if it shows RailBook) → `git log --oneline | head` → `npm ci`.
2. Read this file + `docs/AGENT_AUTHORITY.md`.
3. Wait for the user's prompt. Audit, then implement after IMPLEMENT.
4. Add `tests/unit/pNN-*.test.ts` + `tests/integration/pNN-*-e2e.test.ts`. Run G1/G2/G3 once each.
5. Update this file (history row, new invariants). Commit. Build the zip (with `dist/` + `docs/`). Report. STOP.
