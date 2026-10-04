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
