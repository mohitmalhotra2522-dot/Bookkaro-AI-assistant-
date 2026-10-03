/**
 * PROMPT 18 — Part 19 pending-question codes, derived ONLY from the authoritative
 * BookingSession.pendingInteraction (BookingSession wins over any conversational memory).
 */
import type { PendingInteraction } from '@shared/entities';
import type { PendingQuestionCode } from '@shared/turn-engine';

export function pendingQuestionCode(p?: PendingInteraction | null): PendingQuestionCode | null {
  if (!p) return null;
  switch (p.type) {
    case 'ORIGIN_REQUIRED': case 'DESTINATION_REQUIRED': return 'MISSING_ROUTE';
    case 'DATE_REQUIRED': return 'MISSING_DATE';
    case 'PASSENGERS_REQUIRED': return 'MISSING_PASSENGERS';
    case 'TRAIN_SELECTION_REQUIRED': return 'SELECT_TRAIN';
    case 'CLASS_SELECTION_REQUIRED': return 'SELECT_CLASS';
    case 'PASSENGER_DETAILS_REQUIRED': return 'PASSENGER_DETAILS';
    case 'REVIEW_APPROVAL_REQUIRED': return 'REVIEW_APPROVAL';
    case 'CONFIRMATION_REQUIRED': return 'CONFIRM_REVIEW';
    case 'CLARIFICATION_REQUIRED': return p.data?.kind === 'DATE_MONTH' ? 'MISSING_DATE' : 'CLARIFICATION';
    default: return null;
  }
}

/** Only CONFIRM_REVIEW may turn a bare "haan" into a confirmation REQUEST (still never a booking). */
export function affirmationMayConfirm(code: PendingQuestionCode | null): boolean {
  return code === 'CONFIRM_REVIEW';
}
