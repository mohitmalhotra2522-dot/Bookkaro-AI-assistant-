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
| Error vocabulary / retry policy | `server/ai/tool-runtime/tool-error-normalizer.ts`, `tool-retry-policy.ts` |
| LLM adapter + native tool messages | `server/ai/providers/openai-compatible-llm.ts`; MockLLM `server/ai/providers/mock-llm.ts` |
| System prompts | `server/ai/prompts/system-prompt.ts` |
| Response composer (sentence judge) | `server/ai/response/natural-response-composer.ts` |
| Claim guards | `availability-authority.ts` (P26), `claim-entity-binding.ts` (P28), `action-claims.ts` (P29), `reference-claims.ts` (P30), `outcome-claims.ts` (P32) in `server/ai/response/` |
| Railway providers | `server/railway/registry/provider-registry.ts`, `server/railway/providers/mock/` |
| Search commit | `server/railway/orchestrator/search-orchestrator.ts` |
| Booking prep / review / confirmation / execution boundary | `server/booking/` (`booking-preparation-service.ts`, `handoff/confirmation-policy.ts`, `execution/`) |
| Authority split + audit | `docs/AGENT_AUTHORITY.md` |

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
| 32 | see `git log` | full LLM agent authority + honest provider outcomes (this milestone) |

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

## 6. Test groups (P32 definition)

- **G1:** `npm run build` (tsc -b + vite build).
- **G2 (domain/provider/security, unit):** `tests/unit/p17-tool-runtime.test.ts`, `p25`–`p30` unit files, `tests/unit/p32-*.test.ts`.
- **G3 (e2e):** `tests/integration/p17-tool-runtime-e2e.test.ts`, `p25`–`p30` e2e files, `tests/integration/p32-*-e2e.test.ts`.

Known pre-existing failures in older suites (they also fail at earlier HEADs; report, don't "fix" blindly):
- p19 [13]/[14]/[20], p16 [2]/[6], p8 [19][H] + closed-tool-set, p17 e2e [14], p18 [11];
- p7-agent-loop Group 3, unit p18 [6][7][8], p23 [8], p7 unit SEARCH_TRAINS date.

### Pinned invariants (must not break)

- A serialized turn result never contains the key `"sourceResultId"` (P25–P27 e2e afterEach).
- P26 reasons: `UNVERIFIED_AVAILABILITY`, `CLASS_NOT_LISTED:<cls>`, `AVAILABILITY_MISMATCH`. P25: `FARE_MISMATCH:<n>`. P22: `UNGROUNDED_NUMBER:<n>`, `UNGROUNDED_FARE_AMOUNT:<n>`, `UNGROUNDED_COUNT:…`.
- P30 reference reasons: `STALE_INDEX_REFERENCE`, `INVALID_INDEX_REFERENCE`, `INDEX_REFERENCE_MISMATCH`, `NOT_IN_CURRENT_RESULTS`, `IN_CURRENT_RESULTS`.
- P32 outcome reasons: `NO_RESULTS_CLAIM_ON_<OUTCOME>`, `NO_RESULTS_CONTRADICTS_DATA`, `NO_RESULTS_CLAIM_WITHOUT_EMPTY_RESULT`, `SOURCE_CLAIM_*`, `MOCK_DATA_PRESENTED_AS_LIVE`, `LIVE_CLAIM_WITHOUT_LIVE_DATA`.
- Entity, action, reference and outcome rejections go to `diagnostics.*`, never into the orchestrator's `extra.rejectedClaims`.
- Never add fields to `provenance` entries. Keep new runtime counters out of `RailwayToolRuntime.validation`.
- Tool-limit text: "Request bahut lambi ho gayi — thoda simple karke poochiye." LLM_UNAVAILABLE text: "Maaf kijiye, main abhi jawab nahi de paa raha. Aapki booking details safe hain — thodi der mein dobara boliye."

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

## 8. Next-step template (for P33+)

1. `git remote -v` (stop if it shows RailBook) → `git log --oneline | head` → `npm ci`.
2. Read this file + `docs/AGENT_AUTHORITY.md`.
3. Wait for the user's prompt. Audit, then implement after IMPLEMENT.
4. Add `tests/unit/pNN-*.test.ts` + `tests/integration/pNN-*-e2e.test.ts`. Run G1/G2/G3 once each.
5. Update this file (history row, new invariants). Commit. Build the zip (with `dist/` + `docs/`). Report. STOP.
