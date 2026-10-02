/**
 * StateTransitionValidator — single deterministic authority for BookingState
 * transitions (Prompt 8).
 *
 * Rules:
 *  1. FORWARD moves are allowed only along explicit edges in
 *     VALID_BOOKING_TRANSITIONS (no skipping: SHOWING_TRAINS → COMPLETE is invalid).
 *  2. REWIND moves (caused by user corrections / invalidation) may go back to
 *     an EARLIER, re-enterable state. e.g. COLLECTING_PASSENGER_DETAILS →
 *     COLLECTING_JOURNEY after "Delhi nahi Ludhiana".
 *  3. IRCTC_HANDOFF_READY is reachable ONLY from AWAITING_CONFIRMATION.
 *  4. COMPLETE is reachable ONLY from IRCTC_HANDOFF_READY (and this milestone
 *     never drives it — REVIEW → COMPLETE is always invalid).
 *  5. IDLE → (COLLECTING_* | SEARCHING_TRAINS) is expanded into the explicit
 *     path IDLE → COLLECTING_JOURNEY → target, so no state is silently skipped.
 */
import { BookingState, VALID_BOOKING_TRANSITIONS, EXECUTION_LOCKED_STATES, EXECUTION_TRANSITIONS } from '@shared/states';

/** Canonical ordering of the booking funnel (used to detect backward moves). */
export const STATE_ORDER: BookingState[] = [
  BookingState.IDLE,
  BookingState.COLLECTING_JOURNEY,
  BookingState.COLLECTING_DATE,
  BookingState.COLLECTING_PASSENGERS,
  BookingState.SEARCHING_TRAINS,
  BookingState.SHOWING_TRAINS,
  BookingState.TRAIN_SELECTED,
  BookingState.CLASS_OPTIONS,
  BookingState.CLASS_SELECTED,
  BookingState.BOOKING_PREPARE,
  BookingState.COLLECTING_PASSENGER_DETAILS,
  BookingState.PASSENGERS_READY,
  BookingState.REVIEW,
  BookingState.AWAITING_CONFIRMATION,
  BookingState.IRCTC_HANDOFF_READY,
  BookingState.COMPLETE,
  // Prompt 10 — locked future execution states (unreachable in this milestone)
  BookingState.BOOKING_EXECUTION_REQUESTED,
  BookingState.BOOKING_IN_PROGRESS,
  BookingState.BOOKING_CONFIRMED,
  BookingState.BOOKING_FAILED
];

/** States that may be re-entered by a rewind (correction). */
const REWIND_TARGETS: ReadonlySet<BookingState> = new Set([
  BookingState.COLLECTING_JOURNEY,
  BookingState.COLLECTING_DATE,
  BookingState.COLLECTING_PASSENGERS,
  BookingState.SEARCHING_TRAINS,
  BookingState.SHOWING_TRAINS,
  BookingState.TRAIN_SELECTED,
  BookingState.CLASS_OPTIONS,
  BookingState.CLASS_SELECTED,
  BookingState.COLLECTING_PASSENGER_DETAILS,
  BookingState.REVIEW
]);

/** States from which no rewind is allowed (terminal for this milestone). */
const NO_REWIND_FROM: ReadonlySet<BookingState> = new Set([BookingState.COMPLETE, ...EXECUTION_LOCKED_STATES]);

export type TransitionCheck =
  | { ok: true; path: BookingState[]; kind: 'SAME' | 'FORWARD' | 'REWIND' }
  | { ok: false; code: 'INVALID_STATE_TRANSITION'; message: string };

const idx = (s: BookingState) => STATE_ORDER.indexOf(s);

export class StateTransitionValidator {
  check(from: BookingState, to: BookingState): TransitionCheck {
    if (from === to) return { ok: true, path: [], kind: 'SAME' };

    // Hard guards (never relaxed)
    // 0) Execution states are never entered through the generic path (LLM / applier /
    //    preparation). Only checkExecution() — used exclusively by the provider
    //    execution service on an authoritative provider response — may enter them.
    if (EXECUTION_LOCKED_STATES.has(to)) {
      return this.reject(from, to, 'Real booking execution is disabled — execution states are locked.');
    }
    if (to === BookingState.IRCTC_HANDOFF_READY && from !== BookingState.AWAITING_CONFIRMATION) {
      return this.reject(from, to, 'IRCTC handoff requires explicit AWAITING_CONFIRMATION first.');
    }
    if (to === BookingState.COMPLETE && from !== BookingState.IRCTC_HANDOFF_READY) {
      return this.reject(from, to, 'COMPLETE is only reachable from IRCTC_HANDOFF_READY.');
    }
    if (to === BookingState.AWAITING_CONFIRMATION && from !== BookingState.REVIEW) {
      return this.reject(from, to, 'AWAITING_CONFIRMATION is only reachable from REVIEW.');
    }

    // Explicit forward edge
    if ((VALID_BOOKING_TRANSITIONS[from] || []).includes(to)) {
      return { ok: true, path: [to], kind: idx(to) < idx(from) ? 'REWIND' : 'FORWARD' };
    }

    // IDLE expansion
    if (from === BookingState.IDLE && (VALID_BOOKING_TRANSITIONS[BookingState.COLLECTING_JOURNEY] || []).includes(to)) {
      return { ok: true, path: [BookingState.COLLECTING_JOURNEY, to], kind: 'FORWARD' };
    }

    // Rewind (correction) — backward to a re-enterable state only
    if (!NO_REWIND_FROM.has(from) && REWIND_TARGETS.has(to) && idx(to) < idx(from)) {
      return { ok: true, path: [to], kind: 'REWIND' };
    }

    return this.reject(from, to, `Invalid state transition: ${from} → ${to}.`);
  }

  /** Provider-result transitions only (EXECUTION_TRANSITIONS). Never relaxes the generic guards. */
  checkExecution(from: BookingState, to: BookingState): TransitionCheck {
    if (from === to) return { ok: true, path: [], kind: 'SAME' };
    if ((EXECUTION_TRANSITIONS[from] || []).includes(to)) return { ok: true, path: [to], kind: 'FORWARD' };
    return this.reject(from, to, `Invalid execution transition: ${from} → ${to}.`);
  }

  canTransition(from: BookingState, to: BookingState): boolean {
    return this.check(from, to).ok;
  }

  private reject(from: BookingState, to: BookingState, message: string): TransitionCheck {
    return { ok: false, code: 'INVALID_STATE_TRANSITION', message: `${message} (${from} → ${to})` };
  }
}

export class InvalidStateTransitionError extends Error {
  readonly code = 'INVALID_STATE_TRANSITION' as const;
  constructor(message: string, readonly from: BookingState, readonly to: BookingState) { super(message); }
}

export const stateTransitionValidator = new StateTransitionValidator();
