/**
 * PROMPT 20 — Parts 43–45: booking-session STATE ACTIONS vs railway INFORMATION tools.
 *
 *  - Railway information (CHECK_AVAILABILITY / GET_FARE / SEARCH_TRAINS / GET_TIMETABLE / GET_TRAIN_INFO /
 *    TRACK_TRAIN / CHECK_PNR …) is requested as a toolCall and runs ONLY through
 *    ToolCallValidator → RailwayToolRuntime → RailwaySearchOrchestrator → RailwayProvider.
 *  - Passenger / review / confirmation operations are STATE ACTIONS: deterministic application logic
 *    (applier + PassengerChangeValidator + BookingPreparationService). They are never railway tools and never
 *    reach a RailwayProvider. A state-action name requested as a tool call is rejected by the tool validator.
 *
 * The Prompt-20 action names are accepted as validated ALIASES of the existing contract (no second pipeline):
 *   SET_PASSENGER_COUNT → UPDATE_PASSENGERS · UPDATE_PASSENGER → COLLECT_PASSENGER_DETAILS ·
 *   START_PASSENGER_COLLECTION → COLLECT_PASSENGERS · SHOW_REVIEW · REQUEST_CONFIRMATION.
 * Anything else outside the closed enum → UNSUPPORTED_ACTION.
 */
import type { AgentDecision } from './agent-decision';
import type { AgentActionKind } from '@shared/booking-preparation';

export const STATE_ACTION_ALIASES: Readonly<Record<string, AgentDecision['action']>> = Object.freeze({
  SET_PASSENGER_COUNT: 'UPDATE_PASSENGERS',
  UPDATE_PASSENGER: 'COLLECT_PASSENGER_DETAILS',
  START_PASSENGER_COLLECTION: 'COLLECT_PASSENGERS',
  SHOW_REVIEW: 'SHOW_REVIEW',
  REQUEST_CONFIRMATION: 'REQUEST_CONFIRMATION'
});

/** Existing actions that operate on BookingSession / passengers / review (state actions, never railway tools). */
export const BOOKING_SESSION_ACTIONS: ReadonlySet<string> = new Set([
  'SELECT_TRAIN', 'SELECT_CLASS', 'UPDATE_JOURNEY', 'UPDATE_DATE', 'UPDATE_PASSENGERS', 'COLLECT_PASSENGERS',
  'COLLECT_PASSENGER_DETAILS', 'SHOW_REVIEW', 'REQUEST_CONFIRMATION', 'PREPARE_IRCTC_HANDOFF'
]);

/** Map a Prompt-20 alias onto the existing action (returns a copy; unknown names are left for the validator). */
export function normalizeStateAction<T extends { action?: unknown }>(d: T): T {
  if (!d || typeof d !== 'object') return d;
  const a = String((d as any).action ?? '');
  const mapped = STATE_ACTION_ALIASES[a];
  return mapped && mapped !== a ? { ...d, action: mapped, requestedAction: a } as T : d;
}

/** Part 45 — what this turn asked for: railway information (tool call) vs booking-session action vs talk. */
export function classifyAgentTurn(d: Pick<AgentDecision, 'action'> & { toolCalls?: Array<{ name: string }> } | null | undefined, toolNames: string[] = []): {
  kind: AgentActionKind; stateAction: string | null; railwayTools: string[];
} {
  const tools = [...new Set([...(d?.toolCalls || []).map(t => t.name), ...toolNames])];
  const action = d ? String(STATE_ACTION_ALIASES[String(d.action)] || d.action) : '';
  const stateAction = BOOKING_SESSION_ACTIONS.has(action) ? action : null;
  const kind: AgentActionKind = stateAction ? 'BOOKING_SESSION' : tools.length || action === 'SEARCH_TRAINS' ? 'RAILWAY_INFORMATION' : 'CONVERSATION';
  return { kind, stateAction, railwayTools: tools };
}
