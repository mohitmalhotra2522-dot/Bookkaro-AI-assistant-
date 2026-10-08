# SELECT_TRAIN grounding — behaviour and known limitations

Introduced by commit `6ee8af2` ("SELECT_TRAIN grounding: a listed train is not the user's choice").
Module: `server/ai/context/train-selection-grounding.ts`, wired in `server/ai/context/turn-applier.ts` step 8.
Tests: `tests/integration/train-selection-grounding.test.ts` (A–L, TEXT and VOICE).

## Rule
The LLM interprets the user's words and proposes a `TrainReference`. The backend decides whether that train becomes
the selected train. A train that appears in the current results is **not** the user's choice merely because it is
listed, is the model's preferred / first / fastest option, or offers the class the user mentioned.

Accepted (grounding `via`, written to the reference record's `grounding` field):

| via | When |
|---|---|
| `ALREADY_SELECTED` | the train is already the selected train (no-op) |
| `TYPED_NUMBER` | the user typed the train number in this turn (`userTypedTrain`) |
| `NAMED_ROW` | the user named exactly one current row (P42.12 `namedResultRow`) |
| `PENDING_CONFIRMATION` | the backend itself raised a CONTEXT_CONFLICT on `selectedTrain` with this train as `proposedCode` |
| `GROUNDED_ENQUIRY` | a bare model TRAIN_NUMBER for a train the user already enquired about in the current journey and result set (P42-12 `retainedInfoAvailability`) |
| `RESOLVED_REFERENCE` | DISPLAY_INDEX / DEMONSTRATIVE / PREVIOUS / ALTERNATIVE / TIME_PREFERENCE / TRAIN_NAME, resolved by the deterministic `TrainReferenceResolver` (which already rejects ambiguity) |

Rejected:
- `TRAIN_NOT_GROUNDED`: a model TRAIN_NUMBER with none of the above; any CLASS_PREFERENCE reference.
- `STALE_RESULT_SET`: the result set no longer matches the session journey (date or route changed).

On rejection: no selection, no focus change, the decision's tools do not run (no RailCore call), `CONTEXT_PATCH_REJECTED`
is emitted, and the turn fails with `INVALID_TRAIN_REFERENCE` (pending `TRAIN_SELECTION_REQUIRED`, missingField TRAIN)
or `STALE_SEARCH_REFERENCE`. No internal code reaches the user. Downstream CHECK_AVAILABILITY / GET_TRAIN_INFO /
GET_TIMETABLE grounding (`c8c91ea`, `eabfc1c`) is unchanged and still refuses train-less calls.

## Known limitations (documented, intentionally not fixed — owner decision)

### 1. "haan" after the model's own suggestion
If the model's free-text reply suggests a single train ("Kya aap 12716 select karna chahte hain?") and the user answers
"haan", the selection is not grounded. The user is asked for the number or name. Reason: without keyword lists the
backend cannot distinguish "haan" from an unrelated answer such as "3A mein 2 log hain", and accepting any reply to
the model's suggestion would re-open the original bug. A backend-raised confirmation (CONTEXT_CONFLICT on
`selectedTrain`) is still honoured.

### 2. Model-computed comparative picks are not supported
"Jo sabse jaldi pahunchti hai, 3A wali" ("earliest-arriving train"): the model computes the pick itself and selects it
by TRAIN_NUMBER. The backend cannot verify that pick. Supporting it needs a structured comparison criterion in
`TrainReference` (a tool-schema / prompt change) and backend ordering, which are not approved. The selection is
rejected and the user is asked which train.

**Known failing tests, kept failing on purpose (assertions and inputs unchanged, not force-passed):**
- `tests/integration/p27-toolchain-e2e.test.ts` › `[D] Example 1 — compare over returned times: 12014 arrives first but has no 3A → 12497 checked; nothing called for 12014`
- `tests/integration/p27-toolchain-e2e.test.ts` › `[T] voice / text parity: the same chain from VOICE and TEXT → same tools, same provider calls, same state`

Both fail because the mock model's comparative pick of 12497 is now rejected. In [T], TEXT and VOICE are still rejected
identically (parity holds); only the 12497 expectation fails.

### 3. Fabricated positional or name references
If the model claims a positional / name reference the user never said (e.g. emits DISPLAY_INDEX 2 for "3A mein 2 log
hain"), the resolver resolves it and the selection goes through. Detecting this needs either phrase lists (not allowed —
no keyword routing) or a schema change where the model quotes the user's words as evidence (not approved). The resolver
still rejects ambiguous and out-of-range references.

### Also unchanged
- `applyCarryOver` (backend-owned re-selection after a date-only correction).
- The same-train alternative tap path and the legacy orchestrator path are outside this rule.

## Approved test input edits (no assertion changes)
- `p29-action-truth-e2e [C]`: "Parso wali 12497 mein 3A availability aur fare bhi check karo."
- `p29-action-truth-e2e [F]`, `p28-identity-binding [19]`, `p28-binding-e2e [H]`: "Kal nahi parso, 12497 3A hi"
