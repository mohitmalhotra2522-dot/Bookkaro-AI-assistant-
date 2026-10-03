/**
 * Prompt 18 — Part 60/62: deterministic multi-step conversation scenarios for the MockLLMProvider.
 *
 * These are DEVELOPMENT fixtures only. Every railway answer in them comes from the mock railway
 * provider (labelled non-live) through the real RailwayToolRuntime — the scenarios never fabricate
 * railway data and never bypass ConversationTurnEngine / ToolRuntime / BookingSession.
 *
 * Each scenario is a list of user turns plus expectations on the LAST turn (or per-turn `expect`).
 */
export interface ScenarioTurnExpectation {
  /** Tools that must have SUCCEEDED in this turn (order-insensitive). */
  toolsSucceeded?: string[];
  /** Tools that must NOT have executed in this turn. */
  toolsNotExecuted?: string[];
  pendingQuestion?: string | null;
  bookingState?: string;
  responseType?: string;
  /** Substrings (case-insensitive) expected in the response. */
  responseIncludes?: string[];
  /** Substrings that must NOT appear in the response. */
  responseExcludes?: string[];
}

export interface ScenarioTurn { text: string; mode?: 'TEXT' | 'VOICE'; expect?: ScenarioTurnExpectation }

export interface MockConversationScenario {
  id: string;
  title: string;
  turns: ScenarioTurn[];
}

/** No-booking-side-effect phrases a confirmation turn must never contain. */
export const FORBIDDEN_SUCCESS_CLAIMS = ['ticket book ho gaya', 'booking confirmed', 'payment successful', 'pnr generated'];

export const MOCK_CONVERSATION_SCENARIOS: readonly MockConversationScenario[] = Object.freeze([
  {
    id: 'S1_INCREMENTAL', title: 'Incremental slots → search → ordinal train → class',
    turns: [
      // route + date are enough to search (stable P1–17 behaviour); the passenger count is inherited later
      { text: 'Amritsar se Delhi kal jaana hai', expect: { toolsSucceeded: ['SEARCH_TRAINS'], pendingQuestion: 'SELECT_TRAIN' } },
      { text: '2 passengers', expect: { toolsNotExecuted: ['SEARCH_TRAINS'], pendingQuestion: 'SELECT_TRAIN' } },
      { text: 'second wali', expect: { pendingQuestion: 'SELECT_CLASS', responseIncludes: ['12497'] } },
      { text: 'CC', expect: { pendingQuestion: 'PASSENGER_DETAILS', responseIncludes: ['CC'] } }
    ]
  },
  {
    id: 'S2_ALL_IN_ONE', title: 'All slots in one message',
    turns: [{ text: 'Amritsar se Delhi kal, 2 log, AC', expect: { toolsSucceeded: ['SEARCH_TRAINS'], bookingState: 'SHOWING_TRAINS', pendingQuestion: 'SELECT_TRAIN' } }]
  },
  {
    id: 'S3_MULTI_TOOL', title: 'Timetable + availability in one turn',
    turns: [
      { text: 'Amritsar se Delhi kal 2 log' },
      { text: '12014 ka timetable aur CC availability batao', expect: { toolsSucceeded: ['GET_TIMETABLE', 'CHECK_AVAILABILITY'] } }
    ]
  },
  {
    id: 'S4_FARE_MISSING', title: 'Fare asks only for the missing slot',
    turns: [{ text: '12014 ka fare batao', expect: { toolsNotExecuted: ['GET_FARE'], responseType: 'CLARIFICATION' } }]
  },
  {
    id: 'S5_FRESH_RECHECK', title: 'Explicit fresh availability re-check',
    turns: [
      { text: 'Amritsar se Delhi kal 2 log' }, { text: '12497' }, { text: 'CC' },
      { text: 'Abhi availability dobara check karo', expect: { toolsSucceeded: ['CHECK_AVAILABILITY'], responseIncludes: ['RAC 4'] } }
    ]
  },
  {
    id: 'S6_CORRECTION', title: 'Destination correction keeps the journey',
    turns: [
      { text: 'Amritsar se Delhi kal 2 log' },
      { text: 'Delhi nahi Ludhiana', expect: { toolsSucceeded: ['SEARCH_TRAINS'], responseIncludes: ['Ludhiana'] } }
    ]
  },
  {
    id: 'S7_REF_NO_RESULTS', title: '"Second wali" with no results',
    turns: [{ text: 'Second wali', expect: { responseIncludes: ['Current search results available nahi hain'], toolsNotExecuted: ['SEARCH_TRAINS'] } }]
  },
  {
    id: 'S8_BARE_HAAN', title: '"haan" with nothing pending',
    turns: [{ text: 'haan', expect: { bookingState: 'IDLE', responseExcludes: FORBIDDEN_SUCCESS_CLAIMS } }]
  },
  {
    id: 'S9_ROUTE_CHANGE_IN_FLIGHT', title: 'Route change while a search is in flight (driven by the test with a slow provider)',
    turns: [{ text: 'Amritsar se Delhi kal' }, { text: 'nahi Amritsar se Ludhiana kal' }]
  },
  {
    id: 'S10_VOICE_BARGE_IN', title: 'Voice interrupts TTS — same session (driven by the test via interrupt)',
    turns: [{ text: 'Amritsar se Delhi kal 2 log', mode: 'VOICE' }, { text: 'second wali', mode: 'VOICE' }]
  }
]);
