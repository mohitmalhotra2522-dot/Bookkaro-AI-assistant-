/**
 * Tool Execution Guard.
 *
 * Even if the LLM requests a tool call, this guard verifies that:
 *  1. The session is in a state where the tool is allowed
 *  2. All required session data exists (e.g. selectedTrain before CHECK_AVAILABILITY)
 *  3. No disallowed transition/action occurs.
 *
 * This is the layer that prevents AI from fabricating state or calling tools
 * out of order regardless of prompt injection or mis-generation.
 */
import type { BookingSession } from '@shared/entities';
import { BookingState } from '@shared/states';
import { Intent } from '@shared/intents';

export interface GuardResult { allowed: boolean; errorCode?: string; message?: string; }

export function canExecuteTool(intent: Intent, session: BookingSession): GuardResult {
  switch (intent) {
    case Intent.SEARCH_TRAINS: {
      if (!session.origin || !session.destination || !session.date) {
        return { allowed: false, errorCode: 'MISSING_REQUIRED_FIELD', message: 'Search needs origin, destination, date.' };
      }
      return { allowed: true };
    }
    case Intent.SELECT_TRAIN: {
      if (!session.searchResults && session.availableTrains.length === 0) {
        return { allowed: false, errorCode: 'NO_TRAINS_FOUND', message: 'कोई ट्रेन results मौजूद नहीं।' };
      }
      return { allowed: true };
    }
    case Intent.SELECT_CLASS:
    case Intent.CHECK_AVAILABILITY: {
      if (!session.selectedTrain) {
        return { allowed: false, errorCode: 'INVALID_ROUTE', message: 'Class select करने से पहले train ज़रूरी है।' };
      }
      return { allowed: true };
    }
    case Intent.GET_FARE: {
      if (!session.selectedTrain || !session.selectedClass) {
        return { allowed: false, errorCode: 'MISSING_REQUIRED_FIELD', message: 'Fare के लिए train + class ज़रूरी हैं।' };
      }
      return { allowed: true };
    }
    case Intent.CONFIRM_BOOKING:
    case Intent.HANDOFF_TO_IRCTC: {
      if (![BookingState.REVIEW, BookingState.AWAITING_CONFIRMATION, BookingState.IRCTC_HANDOFF_READY].includes(session.bookingState)) {
        return { allowed: false, errorCode: 'INVALID_STATE', message: 'Confirmation only allowed at review step.' };
      }
      return { allowed: true };
    }
    default:
      return { allowed: true };
  }
}
