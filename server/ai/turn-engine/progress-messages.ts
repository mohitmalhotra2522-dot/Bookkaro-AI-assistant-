/**
 * PROMPT 18 — honest progress text (Parts 24–26). Progress describes REAL execution only:
 * no percentages, no "10/10 checked", and never a railway fact before the provider returned.
 */
const TOOL_PROGRESS_TEXT: Readonly<Record<string, string>> = Object.freeze({
  SEARCH_TRAINS: 'Trains search ho rahi hain...',
  CHECK_AVAILABILITY: 'Availability check kar raha hoon...',
  GET_FARE: 'Fare check kar raha hoon...',
  GET_TIMETABLE: 'Timetable check kar raha hoon...',
  GET_TRAIN_INFO: 'Train ki jaankari check kar raha hoon...',
  TRACK_TRAIN: 'Live status check kar raha hoon...',
  CHECK_PNR: 'PNR status check kar raha hoon...'
});
/** Several provider calls genuinely in flight at once. */
export const MULTI_TOOL_PROGRESS_TEXT = 'Railway data check ho raha hai...';

export function toolProgressText(activeTools: readonly string[]): string {
  const uniq = [...new Set(activeTools)];
  if (uniq.length > 1) return MULTI_TOOL_PROGRESS_TEXT;
  return TOOL_PROGRESS_TEXT[uniq[0]] || MULTI_TOOL_PROGRESS_TEXT;
}

/** Short spoken acknowledgement (VOICE) — contains no result, only what is being checked. */
export function voiceAcknowledgement(tool: string): string {
  switch (tool) {
    case 'SEARCH_TRAINS': return 'Ek second, trains check kar raha hoon.';
    case 'CHECK_AVAILABILITY': return 'Ek second, availability check kar raha hoon.';
    case 'GET_FARE': return 'Ek second, fare check kar raha hoon.';
    case 'TRACK_TRAIN': return 'Ek second, live status check kar raha hoon.';
    case 'CHECK_PNR': return 'Ek second, PNR status check kar raha hoon.';
    default: return 'Ek second, check kar raha hoon.';
  }
}
