import type {
  AgentDecision, ValidatedDecision, OrchestratorError, TrainReference
} from '../decisions/agent-decision';
import { BookingState } from '@shared/states';
import type { BookingSession } from '@shared/entities';
import { resolveDate } from '../../railway/resolvers/date-resolver';
import { resolveStationToken, resolveRoute } from '../../railway/resolvers/route-resolver';
type NormalizedTrain = any;
import { resolvePassengerAge, resolvePassengerGender } from './passenger-resolvers';

/**
 * ActionValidator — deterministic backend validation of LLM-proposed decisions.
 *
 * This is the safety layer: even if the LLM is compromised or mis-generates,
 * this validator blocks invalid actions. It produces a ValidatedDecision with
 * normalized/canonical values when acceptable, or an OrchestratorError when not.
 */
export class ActionValidator {

  validate(decision: AgentDecision, session: BookingSession, userText: string): { ok: true; v: ValidatedDecision } | { ok: false; error: OrchestratorError; followUp?: string } {
    // 1) Schema sanity
    if (!decision || typeof decision !== 'object' || !decision.intent || !decision.action) {
      return { ok: false, error: { code: 'INVALID_LLM_OUTPUT', message: 'LLM output is not a valid AgentDecision.' } };
    }
    const allowedIntents: AgentDecision['intent'][] = ['GENERAL_RAILWAY_QUERY','BOOK_TRAIN','SEARCH_TRAINS','SELECT_TRAIN','SELECT_CLASS','UPDATE_JOURNEY','UPDATE_DATE','UPDATE_PASSENGERS','COLLECT_PASSENGER_DETAILS','SHOW_REVIEW','CONFIRM_BOOKING','CANCEL_FLOW','CANCEL_BOOKING','MODIFY_BOOKING','CHECK_REFUND_STATUS','UNKNOWN'];
    const allowedActions: AgentDecision['action'][] = ['ASK_CLARIFICATION','SEARCH_TRAINS','SELECT_TRAIN','SELECT_CLASS','UPDATE_JOURNEY','UPDATE_DATE','UPDATE_PASSENGERS','COLLECT_PASSENGER_DETAILS','SHOW_REVIEW','REQUEST_CONFIRMATION','PREPARE_IRCTC_HANDOFF','NO_ACTION'];
    if (!allowedIntents.includes(decision.intent)) return { ok: false, error: { code: 'UNKNOWN_INTENT', message: 'Unknown intent.' } };
    if (!allowedActions.includes(decision.action)) return { ok: false, error: { code: 'UNSUPPORTED_ACTION', message: 'Unsupported action.' } };

    const v: ValidatedDecision = { ...decision, normalized: {} };

    // 2) Intent/Action legality for current state
    const state = session.bookingState;

    // CONFIRM_BOOKING guard: only allowed at REVIEW or AWAITING_CONFIRMATION
    if (decision.intent === 'CONFIRM_BOOKING') {
      if (![BookingState.REVIEW, BookingState.AWAITING_CONFIRMATION].includes(state)) {
        return { ok: false, error: { code: 'NO_CONFIRMATION_PENDING', message: 'फिलहाल confirm करने के लिए कुछ नहीं है।' } };
      }
    }

    // SELECT_TRAIN only valid if we're showing trains (or currently TRAIN_SELECTED but user is re-picking)
    if (decision.action === 'SELECT_TRAIN') {
      if (![BookingState.SHOWING_TRAINS, BookingState.TRAIN_SELECTED, BookingState.CLASS_OPTIONS, BookingState.CLASS_SELECTED].includes(state)) {
        return { ok: false, error: { code: 'INVALID_ACTION_FOR_STATE', message: 'पहले trains search होनी चाहिए।' } };
      }
    }

    // SELECT_CLASS only valid after train is selected
    if (decision.action === 'SELECT_CLASS') {
      if (!session.selectedTrain) {
        return { ok: false, error: { code: 'INVALID_ACTION_FOR_STATE', message: 'पहले train select करें।' } };
      }
    }

    // SEARCH_TRAINS needs origin+destination+date (passengers optional at search step)
    if (decision.action === 'SEARCH_TRAINS') {
      // merge entities with existing session
      const o = decision.entities.originRaw ? this.resolveStation(decision.entities.originRaw) : (session.origin ? { code: session.origin, name: session.originName || '' } : null);
      const d = decision.entities.destinationRaw ? this.resolveStation(decision.entities.destinationRaw) : (session.destination ? { code: session.destination, name: session.destinationName || '' } : null);
      const date = decision.entities.dateRaw ? this.resolveDateStr(decision.entities.dateRaw) : (session.date || null);
      if (!o || !d || !date) {
        const missing = [];
        if (!o) missing.push('origin');
        if (!d) missing.push('destination');
        if (!date) missing.push('date');
        return { ok: false, error: { code: 'MISSING_REQUIRED_FIELD', message: 'ज़रूरी जानकारी अधूरी है।', details: { missing } } };
      }
      if (o.code === d.code) return { ok: false, error: { code: 'AMBIGUOUS_ROUTE', message: 'शुरुआत और मंज़िल एक जैसी नहीं हो सकतीं।' } };
      v.normalized!.origin = o; v.normalized!.destination = d; v.normalized!.date = date;
      if (decision.entities.passengersCountRaw) {
        const n = parseInt(decision.entities.passengersCountRaw, 10);
        if (n >= 1 && n <= 6) v.normalized!.passengersCount = n;
      }
      if (decision.entities.preferredClassRaw) v.normalized!.preferredClass = this.resolveClassPref(decision.entities.preferredClassRaw);
      if (decision.entities.preferredTimeRaw) v.normalized!.preferredTime = this.resolveTimePref(decision.entities.preferredTimeRaw);
      return { ok: true, v };
    }

    // UPDATE_JOURNEY / UPDATE_DATE / UPDATE_PASSENGERS
    if (decision.action === 'UPDATE_JOURNEY' || decision.action === 'UPDATE_DATE' || decision.intent === 'UPDATE_JOURNEY' || decision.intent === 'UPDATE_DATE') {
      const e = decision.entities;
      if (e.correctionTarget === 'destination' && e.correctionValueRaw) {
        const d = this.resolveStation(e.correctionValueRaw);
        if (!d) return { ok: false, error: { code: 'AMBIGUOUS_STATION', message: `स्टेशन "${e.correctionValueRaw}" समझ नहीं आया।` } };
        v.normalized!.destination = d;
        return { ok: true, v };
      }
      // Route resolution on free text (entities may have originRaw/destinationRaw)
      if (e.originRaw || e.destinationRaw) {
        const o = e.originRaw ? this.resolveStation(e.originRaw) : (session.origin ? { code: session.origin, name: session.originName || '' } : null);
        const d = e.destinationRaw ? this.resolveStation(e.destinationRaw) : (session.destination ? { code: session.destination, name: session.destinationName || '' } : null);
        if (e.originRaw && !o) return { ok: false, error: { code: 'AMBIGUOUS_STATION', message: `शुरुआती स्टेशन समझ नहीं आया।` } };
        if (e.destinationRaw && !d) return { ok: false, error: { code: 'AMBIGUOUS_STATION', message: `मंज़िल स्टेशन समझ नहीं आया।` } };
        if (o) v.normalized!.origin = o;
        if (d) v.normalized!.destination = d;
      }
      if (e.dateRaw) {
        const d = this.resolveDateStr(e.dateRaw);
        if (!d) return { ok: false, error: { code: 'AMBIGUOUS_DATE', message: 'तारीख समझ नहीं आयी।' } };
        v.normalized!.date = d;
      }
      return { ok: true, v };
    }

    // SELECT_TRAIN — resolve train reference against current session results
    if (decision.action === 'SELECT_TRAIN' && decision.entities.trainRef) {
      const trains: NormalizedTrain[] = session.searchResults?.trains || (session.availableTrains as any) || [];
      const resolved = this.resolveTrainRef(decision.entities.trainRef, trains, userText);
      if (!resolved) return { ok: false, error: { code: 'INVALID_TRAIN_SELECTION', message: 'यह ट्रेन वर्तमान results में उपलब्ध नहीं है। कृपया list में से चुनें।' } };
      v.normalized!.selectedTrainNumber = resolved.trainNumber;
      return { ok: true, v };
    }

    // SELECT_CLASS
    if (decision.action === 'SELECT_CLASS' && decision.entities.classRaw) {
      const train = session.selectedTrain as any;
      if (!train) return { ok: false, error: { code: 'INVALID_ACTION_FOR_STATE', message: 'पहले train select करें।' } };
      const classCode = this.resolveClassCode(decision.entities.classRaw, train.classes || []);
      if (!classCode) return { ok: false, error: { code: 'INVALID_CLASS_SELECTION', message: `"${decision.entities.classRaw}" इस ट्रेन में उपलब्ध नहीं है। उपलब्ध classes: ${(train.classes||[]).map((c:any)=>c.code).join(', ')}` } };
      v.normalized!.selectedClassCode = classCode;
      return { ok: true, v };
    }

    // COLLECT_PASSENGER_DETAILS
    if (decision.action === 'COLLECT_PASSENGER_DETAILS') {
      const e = decision.entities;
      if (e.passengerField && e.passengerValueRaw !== undefined && typeof e.passengerIndex === 'number') {
        let value: any = e.passengerValueRaw;
        if (e.passengerField === 'age') {
          const r = resolvePassengerAge(e.passengerValueRaw);
          if (r === null) return { ok: false, error: { code: 'INVALID_ACTION_FOR_STATE', message: 'कृपया age number में बताइए।' } };
          value = r;
        } else if (e.passengerField === 'gender') {
          const g = resolvePassengerGender(e.passengerValueRaw);
          if (!g) return { ok: false, error: { code: 'INVALID_ACTION_FOR_STATE', message: 'Gender के लिए Male / Female / Other बताइए।' } };
          value = g;
        }
        v.normalized!.passengerUpdate = { index: e.passengerIndex, field: e.passengerField, value };
      }
      return { ok: true, v };
    }

    // SHOW_REVIEW only allowed when enough data exists
    if (decision.action === 'SHOW_REVIEW') {
      if (!session.origin || !session.destination || !session.date || !session.selectedTrain || !session.selectedClass) {
        return { ok: false, error: { code: 'MISSING_REQUIRED_FIELD', message: 'Review दिखाने के लिए सभी ज़रूरी details पूरी नहीं हैं।' } };
      }
      return { ok: true, v };
    }

    // PREPARE_IRCTC_HANDOFF only at AWAITING_CONFIRMATION
    if (decision.action === 'PREPARE_IRCTC_HANDOFF') {
      if (state !== BookingState.AWAITING_CONFIRMATION) return { ok: false, error: { code: 'INVALID_ACTION_FOR_STATE', message: 'पहले explicit confirmation चाहिए।' } };
      return { ok: true, v };
    }

    // REQUEST_CONFIRMATION only at REVIEW
    if (decision.action === 'REQUEST_CONFIRMATION') {
      if (state !== BookingState.REVIEW) return { ok: false, error: { code: 'INVALID_ACTION_FOR_STATE', message: 'पहले review पूरा होना चाहिए।' } };
      return { ok: true, v };
    }

    // ASK_CLARIFICATION / NO_ACTION / UNKNOWN always allowed
    return { ok: true, v };
  }

  private resolveStation(raw: string): { code: string; name: string } | null {
    const s = resolveStationToken(raw);
    return s ? { code: s.code, name: s.name } : null;
  }

  private resolveDateStr(raw: string): string | null {
    const r = resolveDate(raw);
    return r.ok ? r.date : null;
  }

  private resolveClassPref(raw: string): 'AC' | 'NON_AC' | 'ANY' {
    const t = raw.toLowerCase();
    if (t.includes('non')) return 'NON_AC';
    if (t.includes('ac')) return 'AC';
    return 'ANY';
  }

  private resolveTimePref(raw: string): 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | 'ANY' {
    const t = raw.toLowerCase();
    if (t.includes('morning') || t.includes('subah') || t.includes('jaldi')) return 'MORNING';
    if (t.includes('afternoon') || t.includes('dopahar')) return 'AFTERNOON';
    if (t.includes('evening') || t.includes('shaam')) return 'EVENING';
    if (t.includes('night') || t.includes('raat')) return 'NIGHT';
    return 'ANY';
  }

  private resolveClassCode(raw: string, classes: Array<{ code: string; name?: string }>): string | null {
    const up = raw.toUpperCase().trim();
    if (classes.find(c => c.code === up)) return up;
    for (const c of classes) {
      if (up.includes(c.code)) return c.code;
      if (c.name && up.includes(c.name.toUpperCase())) return c.code;
    }
    return null;
  }

  private resolveTrainRef(ref: TrainReference, trains: NormalizedTrain[], userText: string): { trainNumber: string } | null {
    if (!trains || trains.length === 0) return null;
    switch (ref.kind) {
      case 'TRAIN_NUMBER': {
        const t = trains.find(x => x.trainNumber === ref.value || x.trainNumber.startsWith(ref.value));
        return t ? { trainNumber: t.trainNumber } : null;
      }
      case 'DISPLAY_INDEX': {
        const i = (ref.value as number) - 1;
        return i >= 0 && i < trains.length ? { trainNumber: trains[i].trainNumber } : null;
      }
      case 'DEMONSTRATIVE': {
        if (ref.value === 'THIS') return { trainNumber: trains[0].trainNumber };
        if (ref.value === 'LAST') return { trainNumber: trains[trains.length - 1].trainNumber };
        return null;
      }
      case 'TIME_PREFERENCE': {
        const tp = ref.value as string;
        const inWindow = (dep: string) => {
          const h = parseInt(dep.split(':')[0], 10);
          if (tp === 'MORNING') return h >= 4 && h < 12;
          if (tp === 'AFTERNOON') return h >= 12 && h < 16;
          if (tp === 'EVENING') return h >= 16 && h < 20;
          if (tp === 'NIGHT') return h >= 20 || h < 4;
          return false;
        };
        const match = trains.find(x => inWindow(x.departure));
        return match ? { trainNumber: match.trainNumber } : null;
      }
      case 'CLASS_PREFERENCE': {
        const code = ref.value as string;
        const match = trains.find(x => (x.classes as any[]).some((c: any) => c.code === code));
        return match ? { trainNumber: match.trainNumber } : null;
      }
    }
    return null;
  }
}
