/**
 * Train-selection grounding — a train becomes the SELECTED train only when the user's own reference establishes it.
 *
 * The LLM interprets the user's words and proposes a TrainReference; TrainReferenceResolver resolves it against the
 * CURRENT result set. Being resolvable is not enough: a train is not the user's choice merely because it is listed, is
 * the model's preferred / first / fastest option, or offers the class the user mentioned ("3A mein 2 log hain",
 * "2 tickets chahiye", "AC chahiye" carry passenger / class information only).
 *
 * Grounding sources (existing mechanisms only — no phrase lists, no keyword routing):
 *   - the train is already the selected train (re-selection is a no-op);
 *   - the user typed the number in this turn (`userTypedTrain`, the TRACK_TRAIN / CHECK_AVAILABILITY own-words check);
 *   - the user named the row in this turn (P42.12 `namedResultRow`: one distinctive name word → exactly one current row);
 *   - the backend itself presented exactly this train as the pending choice (CLARIFICATION_REQUIRED / CONTEXT_CONFLICT on
 *     selectedTrain with proposedCode = n: "12497 selected hai. 12014 check karna hai?" → "haan") — the same pending-conflict
 *     grounding ContextPatchValidator uses for date / passenger count;
 *   - a plain TRAIN_NUMBER the LLM produced is otherwise accepted ONLY for a train the user already enquired about in the
 *     CURRENT journey + result set (P42-12 F3 `retainedInfoAvailability` record — "haan, wahi book karo" after
 *     "12716 ki 3A availability batao"); any new search / date / route change drops that record;
 *   - a positional / descriptive reference (DISPLAY_INDEX, DEMONSTRATIVE, PREVIOUS, ALTERNATIVE, TIME_PREFERENCE,
 *     TRAIN_NAME) is the LLM's reading of the user's words, resolved deterministically by the backend resolver (which
 *     already refuses ambiguity / stale versions) → accepted;
 *   - CLASS_PREFERENCE is never a selection: having the requested class does not make a train the user's choice.
 * A result set that no longer matches the session journey (date / route moved on) never yields a selection.
 *
 * Pure function: reads the session, never mutates it, never calls a tool.
 */
import type { BookingSession } from '@shared/entities';
import type { TrainReference } from '../decisions/agent-decision';
import { userTypedTrain } from '../tools/tool-call-validator';
import { namedResultRow } from '../tool-runtime/tool-argument-normalizer';
import { retainedInfoAvailability } from '../response/availability-authority';
import { resultSetOf } from './reference-context';

export type SelectionGroundingVia = 'ALREADY_SELECTED' | 'TYPED_NUMBER' | 'NAMED_ROW' | 'PENDING_CONFIRMATION' | 'GROUNDED_ENQUIRY' | 'RESOLVED_REFERENCE';
export type SelectionRejectReason = 'TRAIN_NOT_GROUNDED' | 'STALE_RESULT_SET';

export type SelectionGrounding = { ok: true; via: SelectionGroundingVia } | { ok: false; reason: SelectionRejectReason };

export function selectionGrounding(ref: TrainReference, trainNumber: string, session: BookingSession, userText: string | undefined): SelectionGrounding {
  const n = String(trainNumber);
  const sel: any = session.selectedTrain;
  if (sel && String(sel.number ?? sel.trainNumber) === n) return { ok: true, via: 'ALREADY_SELECTED' };
  const rs = resultSetOf(session);
  if (rs && !rs.current) return { ok: false, reason: 'STALE_RESULT_SET' };
  const text = userText || '';
  if (userTypedTrain(text, n)) return { ok: true, via: 'TYPED_NUMBER' };
  if (namedResultRow(session, text) === n) return { ok: true, via: 'NAMED_ROW' };
  const pend: any = session.pendingInteraction;
  if (pend?.type === 'CLARIFICATION_REQUIRED' && pend.data?.kind === 'CONTEXT_CONFLICT' && pend.data?.field === 'selectedTrain'
    && String(pend.data?.proposedCode) === n) return { ok: true, via: 'PENDING_CONFIRMATION' };
  if (ref.kind === 'TRAIN_NUMBER') {
    return Object.values(retainedInfoAvailability(session)).some(r => String(r.trainNumber) === n)
      ? { ok: true, via: 'GROUNDED_ENQUIRY' } : { ok: false, reason: 'TRAIN_NOT_GROUNDED' };
  }
  if (ref.kind === 'CLASS_PREFERENCE') return { ok: false, reason: 'TRAIN_NOT_GROUNDED' };
  return { ok: true, via: 'RESOLVED_REFERENCE' };
}

/** Fact-only text (no instruction, no internal code) — the LLM words any question from the structured missingField. */
export const TRAIN_NOT_GROUNDED_MESSAGE = 'Train abhi select nahi hui — kaunsi train chahiye, ye clear nahi hai.';
export const STALE_RESULT_SET_MESSAGE = 'Train abhi select nahi hui — ye list purani date / route ki hai.';
