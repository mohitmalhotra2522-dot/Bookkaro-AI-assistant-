/**
 * Registered tool that the LLM is allowed to invoke during a turn.
 * Only explicitly registered tools are exposed to the LLM. Each tool has
 * a JSON-schema-like parameter descriptor. Execution is gated by the
 * ActionValidator in ConversationAgentOrchestrator.
 */
export interface ToolDefinition {
  name: RegisteredToolName;
  description: string;
  parameters: Record<string, ToolParam>;
  /** If true, the tool must NOT be called unless all required params resolve
   *  against current BookingSession. Used for safety gating. */
  requiresState?: Array<'origin'|'destination'|'date'|'selectedTrain'|'selectedClass'>;
}

export type RegisteredToolName =
  | 'SEARCH_TRAINS'
  | 'GET_TRAIN_INFO'
  | 'GET_TIMETABLE'
  | 'CHECK_AVAILABILITY'
  | 'GET_FARE'
  | 'TRACK_TRAIN'
  | 'CHECK_PNR';

export interface ToolParam {
  type: 'string' | 'number' | 'boolean';
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolCall {
  callId: string;
  name: RegisteredToolName;
  arguments: Record<string, any>;
}

export interface ToolResult {
  callId: string;
  name: RegisteredToolName;
  ok: boolean;
  data?: any;
  error?: { code: string; message: string };
  meta?: {
    source: string;
    latencyMs: number;
    timestamp: string;
  };
}

/**
 * ToolRegistry — deterministic, closed set of registered tools.
 * Only tools registered here are visible to the LLM. Never expose a
 * fake/placeholder tool. Prompt 14 registers the READ-ONLY TRACK_TRAIN and
 * CHECK_PNR lookups: they always call the active RailwayProvider fresh and
 * report its normalized answer — or an honest *_UNAVAILABLE error when the
 * provider has no data (the Phase-1 mock has no PNR / live data).
 */
export const REGISTERED_TOOLS: ToolDefinition[] = [
  {
    name: 'SEARCH_TRAINS',
    description: 'Search trains between origin and destination on a date. Requires canonical station codes and YYYY-MM-DD date resolved by DateResolver/RouteResolver.',
    parameters: {
      origin: { type: 'string', description: 'Origin station code (e.g. ASR)', required: true },
      destination: { type: 'string', description: 'Destination station code (e.g. NDLS)', required: true },
      date: { type: 'string', description: 'Canonical date YYYY-MM-DD (after DateResolver)', required: true },
      preferredClass: { type: 'string', description: 'AC | NON_AC | ANY', enum: ['AC','NON_AC','ANY'] },
      preferredTime: { type: 'string', description: 'MORNING | AFTERNOON | EVENING | NIGHT | ANY', enum: ['MORNING','AFTERNOON','EVENING','NIGHT','ANY'] },
      passengersCount: { type: 'number', description: 'Number of passengers 1-6' },
      dateExpression: { type: 'string', description: 'Raw date words as the user said them (kal / parso / 5 March) — the backend DateResolver resolves it (optional)' }
    },
    requiresState: ['origin','destination','date']
  },
  {
    name: 'GET_TRAIN_INFO',
    description: 'Get detailed info about a specific train. If trainNumber is omitted, the backend uses the train currently in focus (selected / last discussed); it never guesses.',
    parameters: {
      trainNumber: { type: 'string', description: 'Train number e.g. 12014 (optional: defaults to focus train)' },
      date: { type: 'string', description: 'YYYY-MM-DD (optional)' },
      dateExpression: { type: 'string', description: 'Raw date words as the user said them (kal / parso / 5 March) — the backend DateResolver resolves it (optional)' }
    }
  },
  {
    name: 'GET_TIMETABLE',
    description: 'Get station-wise timetable for a train. If trainNumber is omitted, the backend uses the train currently in focus.',
    parameters: { trainNumber: { type: 'string', description: 'Train number (optional: defaults to focus train)' } }
  },
  {
    name: 'CHECK_AVAILABILITY',
    description: 'Check seat availability for the SELECTED train and class on the journey date. Omitted arguments default to the authoritative session selection; mismatching arguments are rejected.',
    parameters: {
      trainNumber: { type: 'string', description: 'Train number (optional: defaults to selected train)' },
      travelClass: { type: 'string', description: 'Class code e.g. CC, 2S, 3A (optional: defaults to selected class)' },
      date: { type: 'string', description: 'YYYY-MM-DD (optional: defaults to journey date)' },
      origin: { type: 'string', description: 'Journey origin code (optional: must match the session journey)' },
      destination: { type: 'string', description: 'Journey destination code (optional: must match the session journey)' },
      passengersCount: { type: 'number', description: 'Passenger count (optional: must match the session count)' },
      dateExpression: { type: 'string', description: 'Raw date words as the user said them (kal / parso / 5 March) — the backend DateResolver resolves it (optional)' }
    },
    requiresState: ['selectedTrain','selectedClass']
  },
  {
    name: 'GET_FARE',
    description: 'Get fare for the SELECTED train, class and passenger count. Omitted arguments default to the authoritative session selection.',
    parameters: {
      trainNumber: { type: 'string', description: 'Train number (optional: defaults to selected train)' },
      travelClass: { type: 'string', description: 'Class code (optional: defaults to selected class)' },
      passengersCount: { type: 'number', description: 'Number of passengers (optional: defaults to session count)' },
      date: { type: 'string', description: 'YYYY-MM-DD' },
      origin: { type: 'string', description: 'Journey origin code (optional: must match the session journey)' },
      destination: { type: 'string', description: 'Journey destination code (optional: must match the session journey)' },
      dateExpression: { type: 'string', description: 'Raw date words as the user said them (kal / parso / 5 March) — the backend DateResolver resolves it (optional)' }
    },
    requiresState: ['selectedTrain','selectedClass']
  },
  // ---- Prompt 14: read-only post-booking lookups (fresh provider call every time) ----
  {
    name: 'TRACK_TRAIN',
    description: 'Fresh LIVE running status of a train (read-only, always a new provider call). trainNumber must come from the user, the current results or the backend booking record; if omitted the backend uses the booking / train in focus. Never guess a train number. Live train status is separate from booking status and PNR status.',
    parameters: {
      trainNumber: { type: 'string', description: 'Train number e.g. 12014 (optional: defaults to the booking / train in focus)' },
      date: { type: 'string', description: 'Run date YYYY-MM-DD (optional; live data only, never the timetable)' },
      dateExpression: { type: 'string', description: 'Raw date words as the user said them (kal / parso / 5 March) — the backend DateResolver resolves it (optional)' }
    }
  },
  {
    name: 'CHECK_PNR',
    description: 'Fresh PNR status from the railway provider (read-only, always a new provider call). Pass EITHER pnr (only a PNR the user typed) OR bookingId (from AUTHORITATIVE_BACKEND_CONTEXT); if omitted the backend uses the booking in focus. Never invent, guess or complete a PNR. PNR status is separate from booking status.',
    parameters: {
      pnr: { type: 'string', description: '10-digit PNR exactly as typed by the user (optional)' },
      bookingId: { type: 'string', description: 'bookingId from AUTHORITATIVE_BACKEND_CONTEXT (optional)' }
    }
  }
  // NOTE: booking execution / history mutation are NEVER tools. GET_CANCELLED_TRAINS and
  // GENERAL_RAILWAY_ANSWER stay unexposed (no authoritative provider implementation).
];

export function getToolDefinition(name: RegisteredToolName): ToolDefinition | undefined {
  return REGISTERED_TOOLS.find(t => t.name === name);
}
