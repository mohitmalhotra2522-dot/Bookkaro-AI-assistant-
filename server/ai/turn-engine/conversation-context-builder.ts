/**
 * PROMPT 18 — ConversationContextBuilder (Parts 8, 9, 10, 40, 50).
 *
 * What the LLM receives each round — bounded and structured, never the unlimited transcript:
 *   1. authoritative BookingSession summary            (buildLLMContext.sessionView)
 *   2. relevant recent turns of the ACTIVE journey     (≤ MAX_RECENT_MESSAGES, tool chatter excluded)
 *   3. current displayed railway results               (current resultSetId only)
 *   4. selected train / class                          (from BookingSession — BookingSession wins)
 *   5. pending question                                (Part 19 code, derived from the session)
 *   6. relevant recent tool results                    (structured; earlier turns marked HISTORICAL)
 *
 * Results from earlier turns are HISTORICAL context: a request for current / latest / "abhi" data must
 * run a NEW tool call — historical availability / live status / PNR are never presented as current.
 */
import type { BookingSession } from '@shared/entities';
import type { PendingQuestionCode } from '@shared/turn-engine';
import { buildLLMContext, type LLMContext, type HistoryMsg } from '../context/context-builder';
import type { PostBookingContextView } from '../../booking/post-booking/post-booking-service';
import { pendingQuestionCode } from './pending-question';
import { syncJourneyVersion } from '../tool-runtime/journey-version';
import { maskPnr } from '../../booking/post-booking/pnr-validator';

export const MAX_TOOL_RESULT_MEMORY = 5;
export const CONTEXT_RECENT_MESSAGES = 8;

/** Structured memory of a tool result (Part 10) — compact, PNR masked, no provider internals. */
export interface ToolResultContext {
  tool: string;
  executionId: string | null;
  turnId: string;
  fetchedAt: string | null;
  fresh: boolean;
  status: string;
  journeyVersion: number;
  resultSetId: string | null;
  /** Compact authoritative content (train numbers / times / status / fare). */
  results: unknown;
  errorCode: string | null;
}

/** Per-session bounded tool-result memory (NOT a cache: never served instead of a provider call). */
export class ToolResultContextStore {
  private mem = new Map<string, ToolResultContext[]>();

  record(sessionId: string, turnId: string, steps: Array<{ toolCall: { name: string }; status: string; result: any; execution?: any }>, s: BookingSession) {
    if (!steps.length) return;
    const list = this.mem.get(sessionId) || [];
    for (const st of steps) {
      const r = st.result || {};
      const ok = st.status === 'ok' && r.success;
      list.push(Object.freeze({
        tool: st.toolCall.name,
        executionId: st.execution?.toolExecutionId ?? r.toolExecutionId ?? null,
        turnId,
        fetchedAt: r.provenance?.retrievedAt ?? r.timestamp ?? null,
        fresh: !!(st.execution?.fresh ?? r.fresh),
        status: st.execution?.status ?? (ok ? 'SUCCEEDED' : 'FAILED'),
        journeyVersion: syncJourneyVersion(s),
        resultSetId: st.toolCall.name === 'SEARCH_TRAINS' && ok ? ((s.searchResults as any)?.resultId ?? null) : null,
        results: ok ? compact(st.toolCall.name, r.data) : null,
        errorCode: ok ? null : String(r.error?.code || st.status || 'TOOL_FAILED')
      }));
    }
    if (list.length > MAX_TOOL_RESULT_MEMORY) list.splice(0, list.length - MAX_TOOL_RESULT_MEMORY);
    this.mem.set(sessionId, list);
  }

  /** Journey reset (explicit new booking) → earlier journey results are never shown again. */
  clear(sessionId: string) { this.mem.delete(sessionId); }

  get(sessionId: string): readonly ToolResultContext[] { return [...(this.mem.get(sessionId) || [])]; }
}

function compact(tool: string, d: any): unknown {
  if (!d || typeof d !== 'object') return null;
  switch (tool) {
    case 'SEARCH_TRAINS': return { count: (d.trains || []).length, trains: (d.trains || []).slice(0, 10).map((t: any) => ({ trainNumber: t.trainNumber, departure: t.departure, arrival: t.arrival, classes: (t.classes || []).map((c: any) => c.code || c) })) };
    case 'CHECK_AVAILABILITY': return { trainNumber: d.trainNumber, travelClass: d.travelClass, date: d.date, status: d.status };
    case 'GET_FARE': return { trainNumber: d.trainNumber, travelClass: d.travelClass, passengersCount: d.passengersCount, perPassenger: d.perPassenger, total: d.total };
    case 'GET_TIMETABLE': return { trainNumber: d.trainNumber, stops: (d.stops || d.schedule || []).length };
    case 'GET_TRAIN_INFO': return { trainNumber: d.trainNumber, trainName: d.trainName };
    case 'TRACK_TRAIN': return { trainNumber: d.trainNumber, currentStatus: d.currentStatus, currentStationCode: d.currentStationCode, delayMinutes: d.delayMinutes };
    case 'CHECK_PNR': return { pnr: d.pnr ? (maskPnr(String(d.pnr)) || '**********') : null, status: d.status, chartStatus: d.chartStatus };
    default: return null;
  }
}

export interface TurnContextView {
  kind: 'AUTHORITATIVE_TURN_CONTEXT';
  journeyVersion: number;
  pendingQuestion: PendingQuestionCode | null;
  pendingConfirmation: boolean;
  lastUserIntent: string | null;
  lastAssistantIntent: string | null;
  /** This turn's results are current; earlier turns' results are HISTORICAL (re-check for current data). */
  lastToolResults: Array<ToolResultContext & { currency: 'CURRENT_TURN' | 'HISTORICAL' }>;
  rules: readonly string[];
}

export const TOOL_TRUST_RULES: readonly string[] = Object.freeze([
  'You may describe only facts contained in authoritative tool results or current BookingSession state.',
  'HISTORICAL tool results are context only — for current / latest / abhi requests call the tool again.',
  'If a tool failed or timed out, say the data could not be verified — never answer from model knowledge.'
]);

export class ConversationContextBuilder {
  constructor(private readonly toolMemory: ToolResultContextStore) {}

  build(a: {
    session: BookingSession; history: HistoryMsg[]; turnId: string; postBooking?: PostBookingContextView;
    intents?: { lastUserIntent: string | null; lastAssistantIntent: string | null };
  }): LLMContext & { turnContext: TurnContextView } {
    const s = a.session;
    const base = buildLLMContext(s, a.history, CONTEXT_RECENT_MESSAGES, a.postBooking);
    const pq = pendingQuestionCode(s.pendingInteraction);
    return {
      ...base,
      turnContext: Object.freeze({
        kind: 'AUTHORITATIVE_TURN_CONTEXT' as const,
        journeyVersion: syncJourneyVersion(s),
        pendingQuestion: pq,
        pendingConfirmation: pq === 'CONFIRM_REVIEW',
        lastUserIntent: a.intents?.lastUserIntent ?? null,
        lastAssistantIntent: a.intents?.lastAssistantIntent ?? null,
        lastToolResults: this.toolMemory.get(s.sessionId).map(r => ({ ...r, currency: r.turnId === a.turnId ? 'CURRENT_TURN' as const : 'HISTORICAL' as const })),
        rules: TOOL_TRUST_RULES
      })
    };
  }
}
