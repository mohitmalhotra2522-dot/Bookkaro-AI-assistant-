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
 * Only tools registered here are visible to the LLM. If a provider
 * implementation hasn't been added yet (e.g. live PNR), we simply do
 * NOT register the tool. Never expose a fake/placeholder tool.
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
      passengersCount: { type: 'number', description: 'Number of passengers 1-6' }
    },
    requiresState: ['origin','destination','date']
  },
  {
    name: 'GET_TRAIN_INFO',
    description: 'Get detailed info about a specific train. If trainNumber is omitted, the backend uses the train currently in focus (selected / last discussed); it never guesses.',
    parameters: {
      trainNumber: { type: 'string', description: 'Train number e.g. 12014 (optional: defaults to focus train)' },
      date: { type: 'string', description: 'YYYY-MM-DD (optional)' }
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
      date: { type: 'string', description: 'YYYY-MM-DD (optional: defaults to journey date)' }
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
      date: { type: 'string', description: 'YYYY-MM-DD' }
    },
    requiresState: ['selectedTrain','selectedClass']
  }
  // NOTE: TRACK_TRAIN and CHECK_PNR are NOT registered until their provider
  // implementations return real data (mock provider currently returns error).
  // Registering them now would expose stubs/fake tools to the LLM, which
  // violates the "NO fake implementations" rule.
];

export function getToolDefinition(name: RegisteredToolName): ToolDefinition | undefined {
  return REGISTERED_TOOLS.find(t => t.name === name);
}
