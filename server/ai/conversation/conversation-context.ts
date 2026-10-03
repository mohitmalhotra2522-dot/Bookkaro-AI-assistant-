/**
 * Prompt 16 — ConversationContextManager.
 *
 * Builds the structured ConversationContext as a DERIVED VIEW of the authoritative BookingSession
 * (+ BookingHistoryStore for the active booking) plus a tiny per-session conversational memory
 * (active journey id, last tool call/result, last intents). It never duplicates booking state and
 * never stores raw provider payloads, PNR values, passenger names or secrets.
 */
import type { BookingSession, PendingInteraction } from '@shared/entities';
import type { ConversationContext, DisplayedResultsContext, PendingQuestion, ToolCallMemory, ToolResultMemory } from '@shared/conversation-context';
import { currentResults } from '../context/train-reference-resolver';
import { BookingState } from '@shared/states';
import { maskPnr } from '../../booking/post-booking/pnr-validator';

interface Memory {
  journeySeq: number;
  activeJourneyId: string;
  lastToolCall: ToolCallMemory | null;
  lastToolResult: ToolResultMemory | null;
  lastUserIntent: string | null;
  lastAssistantIntent: string | null;
}

/** PendingInteraction (backend-derived) → question memory code. */
export function pendingQuestionOf(p?: PendingInteraction | null): PendingQuestion | null {
  if (!p) return null;
  switch (p.type) {
    case 'ORIGIN_REQUIRED': return p.data?.route ? 'ASK_ROUTE' : 'ASK_ORIGIN';
    case 'DESTINATION_REQUIRED': return 'ASK_DESTINATION';
    case 'DATE_REQUIRED': return 'ASK_DATE';
    case 'PASSENGERS_REQUIRED': return 'ASK_PASSENGERS';
    case 'TRAIN_SELECTION_REQUIRED': return 'ASK_TRAIN_SELECTION';
    case 'CLASS_SELECTION_REQUIRED': return 'ASK_CLASS';
    case 'PASSENGER_DETAILS_REQUIRED': return 'ASK_PASSENGER_DETAILS';
    case 'REVIEW_APPROVAL_REQUIRED': return 'ASK_REVIEW_APPROVAL';
    case 'CONFIRMATION_REQUIRED': return 'ASK_CONFIRMATION';
    case 'CLARIFICATION_REQUIRED':
      if (p.data?.kind === 'STATION_ROLE') return 'ASK_STATION_ROLE';
      if (p.data?.kind === 'STATION_CHOICE') return 'ASK_STATION_CHOICE';
      if (p.data?.kind === 'CONTEXT_CONFLICT') return 'ASK_CONTEXT_CONFLICT';
      return 'ASK_CLARIFICATION';
    default: return null;
  }
}

/** Displayed results for the CURRENT result set only (older sets are never addressable). */
export function displayedResultsOf(s: BookingSession): DisplayedResultsContext {
  const sr: any = s.searchResults;
  return Object.freeze({
    resultSetId: sr?.resultId ?? s.searchMeta?.resultId ?? null,
    version: s.searchResultsVersion || 0,
    createdAt: sr?.retrievedAt ?? s.searchMeta?.retrievedAt ?? null,
    items: Object.freeze(currentResults(s).map(t => Object.freeze({ displayIndex: t.displayIndex, trainNumber: t.trainNumber, resultId: t.resultId ?? null, departure: t.departure })))
  });
}

/** Missing journey / preparation slots computed from AUTHORITATIVE session state (Part 19). */
export function missingSlots(s: BookingSession): string[] {
  const m: string[] = [];
  if (!s.origin) m.push('origin');
  if (!s.destination) m.push('destination');
  if (!s.date) m.push('date');
  if (m.length) return m;
  const past = [BookingState.TRAIN_SELECTED, BookingState.CLASS_OPTIONS, BookingState.CLASS_SELECTED, BookingState.BOOKING_PREPARE].includes(s.bookingState);
  if (!s.selectedTrain && !past) m.push('selectedTrain');
  if (!s.selectedClass) m.push('selectedClass');
  if (!s.passengersCount) m.push('passengersCount');
  return m;
}

export class ConversationContextManager {
  private mem = new Map<string, Memory>();

  private m(sid: string): Memory {
    let x = this.mem.get(sid);
    if (!x) { x = { journeySeq: 1, activeJourneyId: `J1`, lastToolCall: null, lastToolResult: null, lastUserIntent: null, lastAssistantIntent: null }; this.mem.set(sid, x); }
    return x;
  }

  activeJourneyId(sid: string): string { return this.m(sid).activeJourneyId; }

  /** Start a new active journey (explicit new booking only). Returns the new journey id. */
  startNewJourney(sid: string): string {
    const x = this.m(sid);
    x.journeySeq += 1;
    x.activeJourneyId = `J${x.journeySeq}`;
    x.lastToolCall = null; x.lastToolResult = null; x.lastUserIntent = 'NEW_BOOKING'; x.lastAssistantIntent = null;
    return x.activeJourneyId;
  }

  /** Record structured (never raw) tool memory for the turn. */
  noteTools(sid: string, steps: Array<{ toolCall: { name: string }; status: string; result: { error?: { code?: string } | null; timestamp?: string } }>, s: BookingSession) {
    if (!steps.length) return;
    const x = this.m(sid);
    const last = steps[steps.length - 1];
    x.lastToolCall = { tool: last.toolCall.name, at: last.result.timestamp || new Date().toISOString() };
    const ok = last.status === 'ok';
    const r: ToolResultMemory = { tool: last.toolCall.name, ok };
    if (!ok && last.result.error?.code) r.errorCode = String(last.result.error.code);
    if (last.toolCall.name === 'SEARCH_TRAINS' && ok) { const d = displayedResultsOf(s); r.resultSetId = d.resultSetId ?? undefined; r.count = d.items.length; }
    x.lastToolResult = Object.freeze(r);
  }

  noteIntents(sid: string, userIntent: string | null | undefined, assistantIntent: string | null | undefined) {
    const x = this.m(sid);
    if (userIntent) x.lastUserIntent = userIntent;
    if (assistantIntent) x.lastAssistantIntent = assistantIntent;
  }

  /** Structured ConversationContext — derived; safe to log and to show in the inspector. */
  snapshot(s: BookingSession, activeBooking?: { bookingId: string; pnr: string | null } | null): ConversationContext {
    const x = this.m(s.sessionId);
    const t: any = s.selectedTrain;
    const pq = pendingQuestionOf(s.pendingInteraction);
    return {
      sessionId: s.sessionId,
      currentState: s.bookingState,
      activeJourneyId: x.activeJourneyId,
      activeJourney: {
        journeyId: x.activeJourneyId,
        origin: s.origin ?? null, originName: s.originName ?? null,
        destination: s.destination ?? null, destinationName: s.destinationName ?? null,
        date: s.date ?? null, passengersCount: s.passengersCount ?? null,
        preferredClass: s.preferredClass ?? null, preferredTime: s.preferredTime ?? null
      },
      selectedTrain: t ? (t.number || t.trainNumber || null) : null,
      selectedClass: s.selectedClass ?? null,
      displayedResults: displayedResultsOf(s),
      pendingQuestion: pq,
      pendingConfirmation: pq === 'ASK_CONFIRMATION' || !!s.pendingLifecycleAction,
      pendingAction: s.pendingLifecycleAction ? 'LIFECYCLE_ACTION' : pq === 'ASK_CONFIRMATION' ? 'CONFIRM_BOOKING' : null,
      missingFields: missingSlots(s),
      activeBookingId: activeBooking?.bookingId ?? s.activeBookingId ?? null,
      activePnrMasked: activeBooking?.pnr ? maskPnr(activeBooking.pnr) : null,
      lastToolCall: x.lastToolCall,
      lastToolResult: x.lastToolResult,
      lastUserIntent: x.lastUserIntent,
      lastAssistantIntent: x.lastAssistantIntent
    };
  }
}

/**
 * ConversationContextSummarizer (Part 28) — deterministic, structured, authoritative values only.
 * Unverified facts are never summarized as facts (fare / availability appear only as "verified" flags
 * backed by provider results). No extra LLM call is ever made to summarize.
 */
export function summarizeContext(c: ConversationContext, s: BookingSession) {
  return Object.freeze({
    kind: 'STRUCTURED_CONVERSATION_CONTEXT' as const,
    journeyId: c.activeJourneyId,
    journey: { origin: c.activeJourney.origin, destination: c.activeJourney.destination, date: c.activeJourney.date },
    passengersCount: c.activeJourney.passengersCount,
    preference: { class: c.activeJourney.preferredClass, time: c.activeJourney.preferredTime },
    selectedTrain: c.selectedTrain,
    selectedClass: c.selectedClass,
    displayedResults: { resultSetId: c.displayedResults.resultSetId, version: c.displayedResults.version, count: c.displayedResults.items.length },
    verified: { fare: !!s.fare, availability: !!(s.availability && s.selectedClass && s.availability[s.selectedClass]) },
    pendingQuestion: c.pendingQuestion,
    missingFields: c.missingFields,
    activeBookingId: c.activeBookingId,
    lastToolResult: c.lastToolResult
  });
}
