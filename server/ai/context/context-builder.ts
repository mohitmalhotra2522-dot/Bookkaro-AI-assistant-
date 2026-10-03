/**
 * LLM context builder — the MEMORY MODEL boundary (Prompt 8).
 *
 * Four separate stores:
 *   1. Conversational history  (orchestrator, user/assistant text, redacted)
 *   2. BookingSession          (ConversationStateManager — AUTHORITATIVE)
 *   3. Railway tool results    (per-turn records; synced into session by runtime)
 *   4. Temporary LLM context   (THIS — rebuilt from 1+2 every LLM call)
 *
 * The LLM never receives a free-form "memory" it could trust over the session:
 * the structured sessionView is always loaded fresh from BookingSession. When
 * history grows, older turns are compressed into a deterministic summary that
 * is ALSO built from BookingSession — an LLM-generated summary can never
 * replace BookingSession.
 */
import type { BookingSession } from '@shared/entities';
import { currentResults } from './train-reference-resolver';
import type { PostBookingContextView } from '../../booking/post-booking/post-booking-service';

export interface HistoryMsg { role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolName?: string; /** Prompt 16: active journey the message belongs to */ journeyId?: string }

export interface LLMContext {
  /** Authoritative snapshot (safe fields only; no secrets ever stored). */
  sessionView: {
    state: string;
    origin?: string; originName?: string; destination?: string; destinationName?: string;
    date?: string; passengersCount?: number; preferredClass?: string; preferredTime?: string;
    selectedTrain?: { number: string; name: string; availableClasses: string[] } | null;
    selectedClass?: string | null;
    focusTrainNumber?: string; previousTrainNumber?: string;
    fareVerified: boolean; availabilityVerified: boolean;
    passengerDetails: { required: number; completed: number; currentIndex: number };
    sessionVersion: number;
  };
  pendingInteraction: BookingSession['pendingInteraction'];
  searchResults: { version: number; trains: Array<{ displayIndex: number; trainNumber: string; trainName: string; departure: string; arrival: string; duration: string; classes: string[] }> };
  /** Deterministic summary of compressed older turns (from BookingSession). */
  summary?: string;
  recentMessages: HistoryMsg[];
  /**
   * Prompt 12 — normalized, READ-ONLY booking execution summary (status / provider /
   * failure category / authoritative PNR). The LLM cannot change it and has no tool to
   * execute bookings. Never contains provider config, URLs, credentials or raw responses.
   */
  bookingExecution?: { providerName: string; status: string; code: string; failureCode?: string; providerReference?: string; pnrAvailable?: boolean; retryBlocked: boolean };
  /**
   * Prompt 14 — AUTHORITATIVE_BACKEND_CONTEXT: backend-owned booking history summary (read-only).
   * Contains NO PNR values (only pnrAvailable), no credentials, no raw provider data.
   */
  postBooking?: PostBookingContextView;
  /**
   * Prompt 16 — STRUCTURED conversation context (ConversationContextSummarizer): active journey,
   * displayed result set, pending question, missing slots, verified flags. Deterministic; built
   * from BookingSession — never an LLM-written summary, never PNR values / names / secrets.
   */
  conversationContext?: Readonly<Record<string, any>>;
}

export const MAX_RECENT_MESSAGES = 12;

export function buildLLMContext(s: BookingSession, history: HistoryMsg[], maxRecent = MAX_RECENT_MESSAGES, postBooking?: PostBookingContextView): LLMContext {
  const t: any = s.selectedTrain;
  const recent = history.filter(h => h.role !== 'tool').slice(-maxRecent);
  const compressed = history.filter(h => h.role !== 'tool').length > maxRecent;
  return {
    sessionView: {
      state: s.bookingState,
      origin: s.origin, originName: s.originName, destination: s.destination, destinationName: s.destinationName,
      date: s.date, passengersCount: s.passengersCount, preferredClass: s.preferredClass, preferredTime: s.preferredTime,
      selectedTrain: t ? { number: t.number || t.trainNumber, name: t.name || t.trainName, availableClasses: t.availableClasses || (t.classes || []).map((c: any) => c.code) } : null,
      selectedClass: s.selectedClass ?? null,
      focusTrainNumber: s.focusTrainNumber, previousTrainNumber: s.previousTrainNumber,
      fareVerified: !!s.fare, availabilityVerified: !!s.availability,
      passengerDetails: {
        required: s.passengersCount || 0,
        completed: (s.passengers || []).filter(p => p.name && p.age && p.gender).length,
        currentIndex: s.currentPassengerIndex || 0
      },
      sessionVersion: s.sessionVersion
    },
    pendingInteraction: s.pendingInteraction,
    searchResults: {
      version: s.searchResultsVersion,
      trains: currentResults(s).map(x => ({
        displayIndex: x.displayIndex, trainNumber: x.trainNumber, trainName: x.trainName,
        departure: x.departure, arrival: x.arrival, duration: x.duration, classes: (x.classes || []).map(c => c.code)
      }))
    },
    summary: compressed ? summarizeFromSession(s) : undefined,
    recentMessages: recent,
    ...(s.bookingExecution ? { bookingExecution: Object.freeze({
      providerName: s.bookingExecution.providerName, status: s.bookingExecution.status, code: s.bookingExecution.code,
      ...(s.bookingExecution.failureCode ? { failureCode: s.bookingExecution.failureCode } : {}),
      ...(s.bookingExecution.providerReference ? { providerReference: s.bookingExecution.providerReference } : {}),
      // Prompt 14: the PNR value never enters LLM context — only whether one exists
      ...(s.bookingExecution.status === 'CONFIRMED' ? { pnrAvailable: !!s.bookingExecution.pnr } : {}),
      retryBlocked: s.bookingExecution.retryBlocked
    }) } : {}),
    ...(postBooking ? { postBooking } : {})
  };
}

/** Deterministic summary — authoritative values only. */
export function summarizeFromSession(s: BookingSession): string {
  const t: any = s.selectedTrain;
  const parts = [
    s.origin || s.destination ? `journey=${s.origin || '?'}→${s.destination || '?'}` : null,
    s.date ? `date=${s.date}` : null,
    s.passengersCount ? `passengers=${s.passengersCount}` : null,
    s.preferredClass && s.preferredClass !== 'ANY' ? `pref=${s.preferredClass}` : null,
    t ? `selectedTrain=${t.number || t.trainNumber}` : null,
    s.selectedClass ? `selectedClass=${s.selectedClass}` : null,
    s.pendingInteraction && s.pendingInteraction.type !== 'NONE' ? `pending=${s.pendingInteraction.type}` : null,
    `state=${s.bookingState}`
  ].filter(Boolean);
  return `Earlier conversation summary (from BookingSession): ${parts.join(', ')}`;
}
