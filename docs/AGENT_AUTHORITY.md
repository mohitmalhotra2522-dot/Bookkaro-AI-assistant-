# BookKaro — Agent Authority (Prompt 32)

> **The LLM decides. The provider knows. The backend protects.**

This document says exactly what the LLM controls, what the backend controls, and why every remaining piece of
deterministic code exists. A backend rule is allowed only if it is **validation, safety, state integrity, booking
boundary, or provider normalization**. A backend rule that picks the next tool or decides what the user meant
counts as a hidden agent, and those are not allowed.

---

## 1. What the LLM decides (agent authority)

| Decision | Where |
|---|---|
| What the user means, whether it's GK or live, whether to ask a clarifying question | `NATIVE_AGENT_SYSTEM_PROMPT` (`server/ai/prompts/system-prompt.ts`), native tool calling in `OpenAICompatibleLLMProvider` |
| Whether a tool is needed, which one, in what order, and whether to run calls in parallel | `LLMToolRuntime` chain loop: the LLM emits `tool_calls` and the runtime only validates and executes them |
| Whether an earlier result in the same turn can be reused | The LLM sees every result with `toolResultId`, `entity`, `outcome` and `dataSource` |
| Reference interpretation ("doosri wali", "iska fare", "last train") | LLM `trainRef` proposals; P30 `referenceContext` gives it the current list |
| Comparison, mixed GK + live answers, next action, wording, language | The LLM's final message (fact-guarded, not rewritten) |
| Retrying after a structured failure | `{ errorType, reason, retryable }` plus the P32 `outcome` |
| Running SEARCH_TRAINS again after a date or route change | The LLM. The backend never auto-searches |

The backend has **no** pre-LLM keyword router, intent whitelist, response tree, or "if X then tool Y" rule.

## 2. What the backend controls (safety and validation boundary)

| Responsibility | Component | Category |
|---|---|---|
| Tool-name and argument schema validation, forbidden tools and arguments | `ToolCallValidator`, `railway-tool-registry.ts` | VALIDATION / SAFETY |
| Canonical dates ("kal" → ISO), station codes | `resolveDate`, `resolveRoute` | VALIDATION |
| Session and journey versioning, stale-result rejection | `ToolTurnTracker`, `isStale`, `STALE_TOOL_RESULT` | STATE INTEGRITY |
| Result identity binding (train/date/class/route must match the request) | `tool-result-identity.ts` (P28) | INTEGRITY |
| Fact authority: train facts, availability (P26), fare (P25), counts, times | `railwayResponseGrounding`, `availability-authority.ts`, composer judge | FACT AUTHORITY |
| Action-truth claims ("check kar liya") | `action-claims.ts` (P29) | TRUTHFULNESS |
| Reference / list-membership claims | `reference-claims.ts` (P30) | TRUTHFULNESS |
| **Outcome claims ("koi train nahi mili", "railway data ke according", "live")** | **`outcome-claims.ts` (P32)** | **TRUTHFULNESS** |
| Provider timeouts, bounded retry, error normalization | `RailwayToolRuntime`, `tool-retry-policy.ts`, `tool-error-normalizer.ts` | PROVIDER NORMALIZATION |
| **Malformed provider data → `PROVIDER_DATA_INVALID`** | **`tool-outcome.ts` `isWellFormedToolData`, `search-orchestrator.ts` `isWellFormedSearch` (P32)** | **VALIDATION** |
| Step budget (MAX_TOOL_STEPS = 8), loop detection, same-turn dedup | `LLMToolRuntime` | SAFETY |
| Confirmation policy, idempotency, locks, booking disabled | `confirmation-policy.ts`, `BookingExecutionGateway`, P10–P13 | BOOKING BOUNDARY |
| Secrets and PII (never sent to the LLM, frontend or logs) | env loading, redaction, sensitive-input refusal | SECURITY |

## 3. Audit results (Prompt 32 §32)

### 3.1 Backend-initiated railway tool calls

| Code | Behaviour | Verdict |
|---|---|---|
| `BookingPreparationService.refresh` | Runs CHECK_AVAILABILITY + GET_FARE **only** at PASSENGERS_READY → review, on explicit confirm, or on retry-after-failure | **Kept (justified exception: BOOKING BOUNDARY).** A booking review or confirmation must never show stale availability or fare (P11–P13). It never runs for informational questions; P27 `holdAtSelection` blocks informational selections. Executions are real current-turn records, so P29 action claims treat them truthfully. |
| `applier.applyCarryOver` after a successful LLM-initiated search | Re-validates the user's existing train/class against the fresh results | **Kept (STATE INTEGRITY, standing user rule #28).** No tool call is made. It only keeps or drops an existing selection. |
| Auto search on route mention / auto availability after search / auto fare after selection | none | **Not present** (verified). |

### 3.2 Deterministic language handling

| Code | Purpose | Verdict |
|---|---|---|
| `freshness.ts` `isExplicitFreshRequest` | Sets an informational `forceFresh` flag only. Every request is fresh anyway (TTL 0) | Kept: it doesn't decide anything |
| `NON_RAILWAY_PATTERNS` scope guard | Runs **after** the LLM, and only when the LLM produced no answer and no tool | Kept (SAFETY: out-of-scope refusal) |
| `confirmation-policy.ts` `classifyConfirmation` | Only explicit words confirm a booking. "theek hai", "hmm", "acha", "ok", "chalo" → AMBIGUOUS (asked again); "do it" → NONE | Kept (BOOKING BOUNDARY). Note: "continue" and "proceed" are classified EXPLICIT by the documented P11 policy (pinned in `tests/unit/p11-handoff-session.test.ts`); §28 allows this exception |
| `pending-interaction.ts` `isPureAffirmation` | Used **only** by `MockLLMProvider` (the offline LLM stand-in for tests and no-key dev) | Kept: it is not production decision logic |
| `MockLLMProvider` keyword NLU | The offline LLM stand-in. Selected only when `LLM_PROVIDER` is unset | Kept: test/dev only, labelled |
| Fact / action / reference / outcome claim guards (regex) | Verify claims against tool results; they remove false sentences and never choose tools | Kept (TRUTHFULNESS) |

### 3.3 Freshness

- There is no cross-turn railway cache, no TTL, no stale-while-revalidate, and no cross-turn dedup. SEARCH_TRAINS always goes through `searchOrch.trySearch` → provider.
- Same-turn dedup only (identical call in the same chain → the earlier result is reused, `duplicateCallPrevented`).
- "dobara check karo" is a new turn, so it gets a new provider call.
- A changed date, class, train, route or pax means different arguments, so it's a new logical request.
- Session facts from earlier turns are **reference context** (what "iska" means), never fresh evidence: P26/P30 guards require current-entity evidence.

## 4. Honest tool outcomes (P32)

Every tool result resolves to exactly one outcome (`server/ai/tool-runtime/tool-outcome.ts`). The outcome is given to the
LLM verbatim and recorded in `diagnostics.tools[].outcome`.

| Outcome | Source | User meaning (the LLM words it) |
|---|---|---|
| `DATA` | provider success with well-formed data | facts may be stated |
| `NO_RESULTS` | provider success with zero items / NO_TRAINS_FOUND / NOT_FOUND | "koi matching result nahi mila": **only here** |
| `UNSUPPORTED` | TOOL_NOT_IMPLEMENTED / UNKNOWN_TOOL | "is type ki information abhi available nahi hai" |
| `TIMEOUT` | runtime timeout | "check time par complete nahi ho paaya" |
| `PROVIDER_FAILURE` | PROVIDER_UNAVAILABLE / RATE_LIMITED / AUTH_ERROR / TOOL_FAILED | "railway data service se response nahi mil paaya" |
| `MALFORMED_DATA` | `PROVIDER_DATA_INVALID` (new) / PROVIDER_DATA_CONFLICT | "provider ka jawab usable nahi tha" |
| `STALE` | STALE_TOOL_RESULT / NOT_EXECUTED / RESULT_IDENTITY_MISMATCH | the result was not used |
| `REJECTED` | validation / policy rejection (provider not called) | the LLM fixes the argument or asks |

**Malformed data** is never repaired, never replaced by fallback data, never retried, and never committed to the session:
- SEARCH: `trains` must be an array of objects with `trainNumber` (+ `classes` before the session commit);
- CHECK_AVAILABILITY needs a non-empty `status`;
- GET_FARE needs a finite `perPassenger` or `total`;
- GET_TRAIN_INFO needs `trainNumber`;
- GET_TIMETABLE needs an array.

**Outcome-claim guard** (`server/ai/response/outcome-claims.ts`), run in the composer judge and on the final backend reply:
- **Zero-result claims** ("koi train nahi mili", "no trains found") are kept only after a successful empty result. They are rejected with:
  - `NO_RESULTS_CLAIM_ON_TIMEOUT`, `…_PROVIDER_FAILURE`, `…_MALFORMED_DATA`, `…_STALE` after a failed or unusable result;
  - `NO_RESULTS_CONTRADICTS_DATA` when trains came back;
  - `NO_RESULTS_CLAIM_WITHOUT_EMPTY_RESULT` when there was no result at all.
  - "aaj koi train cancel nahi hui" needs an empty GET_CANCELLED_TRAINS result (that tool is currently UNSUPPORTED, so such a claim is always removed).
- **Source claims** ("railway data ke according") need provider data → `SOURCE_CLAIM_ON_<outcome>` / `SOURCE_CLAIM_WITHOUT_PROVIDER_DATA`.
- **Live claims** ("live data", "real-time information") are never allowed for MOCK data → `MOCK_DATA_PRESENTED_AS_LIVE` / `LIVE_CLAIM_WITHOUT_LIVE_DATA`.
- If removal empties the reply, the backend states the **real** failure category (`honestFailureFallback`), not a generic "not verified".

## 5. Provider identity

- `RailwayProviderRegistry.getActiveKind()` → `MOCK` | `REAL`, from the provider's own declared `source`.
  - It's shown in `/api/health` (`providerKind`) and the startup log.
  - An unknown `RAILWAY_PROVIDER` throws. There is never a silent MOCK↔REAL switch.
- Every tool result carries `dataSource` (`MOCK` | `LIVE`) from the provider's response meta. The LLM sees it, `diagnostics.tools[].providerKind` records it, and MOCK data is never presented as live.
- Only `mock` is registered today (Phase 1). A real provider must register itself with `source !== 'mock'`, behind the same `RailwayProvider` interface.

## 6. Observability (per turn, `turnLog.diagnostics`)

- `provider`, `model`, `llmCalls`, `agentLlmCalls`, `secondLlmCall`, `secondLlmCallReason`, `latencyMs`, `llmLatencyMs`;
- `toolCalls`, `toolNames`, `retryCount`;
- `tools[]` = `{ tool, status, outcome, latencyMs, attempt, retried, provider, providerKind, errorCode, fresh, resultCount }`;
- `steps` = `{ count, limitReached, limitReason, stopReason, timeouts, retries }`;
- `chain` (P27), `binding` (P28), `actionClaims` (P29), `references` (P30), `outcomeClaims` (P32), `validation.rejected`.

These contain no arguments, PII or secrets.

## 7. Booking preparation → review → confirmation → handoff (Prompt 33)

**Flow:** user → LLM (decides) → info tools → authoritative data → booking preparation → passengers → review (fresh availability + fare) → explicit confirmation → `IRCTC_HANDOFF_READY` → execution DISABLED. No booking, payment, IRCTC, OTP or CAPTCHA tool exists; no PNR / transaction id is ever produced.

**The LLM decides** what to ask and in which order. It sees `context.bookingPreparation` (built from the one authoritative BookingSession — no second state system):
`{ origin, destination, journeyDate, train{number,name}, class, passengerCount, passengers[{passenger, name?, age?, gender?, berthPreference?, missing[]}], missing[], availabilityCheck, fareCheck, review{version,status}, confirmation, handoff }`.
Statuses only — no fare amounts / availability values (they come from this turn's tool results or the review), no internal ids, no credentials (never collected). There is no `if missing → ask` engine.

**The backend validates** every proposal (`update_booking_session`): train references against the CURRENT results, class against that train, passenger count (1–6), passenger fields (name / age / gender, optional berth) via `PassengerChangeValidator`. One message may carry train + class + count + every passenger — slots for the validated count are created before the passenger proposal is validated (the count is never inferred from names).

**Review authority:** availability only from a matching CHECK_AVAILABILITY (train/class/date/route), fare only from a matching GET_FARE (train/class/route/pax). A NEW review version needs both obtained in the review-building turn (checked by execution identity — the stored `toolExecutionId` must be one of this turn's executions; `freshSince` is only a fallback): the LLM's own call, or the existing P11–P13 review-boundary refresh (the only backend-initiated railway calls — a safety boundary, never an informational follow-up). A previous turn's fare is never review authority. Default policy requires BOTH: a timeout / provider failure / malformed / unsupported / empty result leaves NO valid review, and the reply states the real P32 reason (`dependencyFailureReason`). No service fee exists, so the total is the fare total.

**Changes:** train / class / date / route / passenger count / passenger details change the review fingerprint → review, confirmation and handoff are invalidated (`BOOKING_DETAILS_CHANGED:<fields>`). The LLM chooses fresh enquiries; a new review is only built through the boundary above. Count changes keep valid passengers.

**Confirmation (policy unchanged):** haan / yes / confirm / continue / proceed = explicit; theek hai / hmm / achha / ok = ambiguous; "do it" is not a confirmation. Bound to reviewVersion + review fingerprint + session version. At confirmation the TTL window applies (availability 2 min, fare 10 min); stale data is refreshed and a changed result rebuilds the review (new version) instead of handing off.

**Handoff:** existing `BookingHandoffSession` + validator, immutable snapshot of exactly what was confirmed, expiry, single READY session per confirmation (repeat confirmation → no new handoff), INVALIDATED on change, EXPIRED after TTL, consume always fails closed (execution disabled).

**Language guards (LLM-authored text only):**
- `booking-state-claims.ts`: "ticket book ho gayi" / "booking confirmed" never valid (handoff-ready ≠ booked); "details confirmed / handoff ready" only with a READY handoff; "review ready" only with a CURRENT review.
- Composer: a newly presented review must carry train, class and — when verified — fare and availability (`REVIEW_FACTS_MISSING` → validated review text); a blocked review must acknowledge the failure (`REVIEW_BLOCK_REASON_MISSING`).
- P15 lifecycle guard: a backend-applied preparation change ("age update kar di") is not a post-booking modification claim; cancellation / refund claims are always removed.

**Observability:** `turnLog.bookingPreparation.audit` = `{trainNumber, travelClass, journeyDate, availabilityRefresh, fareRefresh, reviewCreatedAt, confirmedAt, confirmationState, handoffSessionId, handoffState, invalidationReason}` plus the existing `sessionVersion`, `reviewVersion`, `confirmationVersion`, `handoffId`, `handoffStatus`. No passenger names, no secrets.

## 8. Voice production hardening (Prompt 34)

Voice is an input/output modality of the SAME agent — not a second brain:
`speech → STT transcript → ConversationTurnEngine.processTurn(…, 'VOICE') → the same LLM agent / tools / validation → final validated text → TTS`.
There is no voice intent router, command parser, keyword routing, voice state or voice-only fact.

| Concern | Owner | Where |
|---|---|---|
| Meaning, tools, references, wording | LLM agent (unchanged) | orchestrator / runtime |
| Transcript text, interim/final, confidence, language hint, timing | STT (information only — never intent, tools or state) | `shared/voice/transcript.ts`, STT adapters |
| "Is the user done?" | detector: STT final + silence (adaptive); interim-only never submitted (`INCOMPLETE` at 2 s) | `voice-turn-detector.ts` |
| Interim / empty transcript at the server | backend gate BEFORE a turn exists (422) | engine `processTurn`, `/api/chat` |
| What is spoken | ONLY the final validated text (same as the UI); composer emits final segments once; credential-shaped tokens masked | composer `emitFinal`, `redactForSpeech` |
| Acknowledgement | only after a tool really started (P29 `TOOL_PROGRESS` on `TOOL_STARTED`) | turn engine |
| Barge-in | stop TTS on the user's partial (Conversation Mode only); old turn stale, never resumed; new speech = new turn; never a booking cancellation | voice agent `interrupt()`, engine supersede |
| Stale protection | turn identity (engine sequence + agent local seq); superseded results DISCARDED, never spoken, never overwrite focus | engine + agent |
| TTS / playback failure | text stays; no new turn / LLM / tool; `retrySpeech()` re-speaks the same validated outcome | voice agent |
| STT failure | no transcript invented, no turn; `TEXT_FALLBACK`; typing always works | voice agent |
| Conversation Mode | opt-in, visible; tap-to-talk default; mic opened only by user action; one tap stops; no background listening | voice agent |
| Observability | `turnLog.voiceTurn` (server) + `voiceMetrics()` (client): ids, mode, STT duration, transcript status/confidence/language, LLM latency + calls, tools, TTS latency, interruption, stale, final status, failure category — no text, no secrets | engine / agent |

Mocks (`MockStreamingSTT`, `MockStreamingTTS`) are deterministic test adapters and are never presented as real audio.
Real STT/TTS plug in behind `SpeechInput` / `SpeechOutput` (browser Web Speech adapters exist; no external voice
provider is hard-coded). Booking boundary unchanged: no booking, payment, OTP, CAPTCHA, IRCTC login or submission.

