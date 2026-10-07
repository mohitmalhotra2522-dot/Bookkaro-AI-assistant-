import { webResearchEnabledFromEnv } from '../../research/web-research-service';
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
  | 'CHECK_PNR'
  | 'WEB_RAILWAY_RESEARCH'
  // Prompt 42: Same Train Alternative (composite, LLM-chosen, enabled via SAME_TRAIN_ALTERNATIVES_ENABLED)
  | 'SEARCH_SAME_TRAIN_ALTERNATIVES'
  | 'PRESENT_SAME_TRAIN_ALTERNATIVES';

export interface ToolParam {
  type: 'string' | 'number' | 'boolean' | 'object';
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolCall {
  callId: string;
  name: RegisteredToolName;
  arguments: Record<string, any>;
  /** P37: provider connector the LLM selected via a provider-level tool (`railcore_search` → 'railcore'). */
  provider?: string;
  /** P37: the provider-level tool name exactly as the LLM called it. */
  toolName?: string;
  /** P37: the LLM called a provider tool with no implemented / exposed integration (→ PROVIDER_NOT_IMPLEMENTED). */
  providerNotImplemented?: string;
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
      passengersCount: { type: 'number', description: 'Only a passenger count the user stated in their own words (omit otherwise — never default to 1). It is a search parameter; the session count changes through update_booking_session passengersCountRaw.' },
      requestedClass: { type: 'string', description: 'P42.7: the exact class CODE the user asked for, only when the user named one (1A, 2A, 3A, 3E, SL, CC, EC, 2S, FC, EA, EV). Omit when the user did not name a class.' },
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
    description: 'Check seat availability of a train + class on the journey date. No prior train selection is needed: the train may be the selected train or any train of the CURRENT search results (by trainNumber, or by trainRef as the user referred to it). The backend resolves it against the current results and never guesses (ambiguous → candidates, unknown → rejected). Omitted arguments default to the selected train / class.',
    parameters: {
      trainNumber: { type: 'string', description: 'Train number from the current results or the selected train (optional: defaults to the selected train)' },
      trainRef: { type: 'object', description: 'Post-P42.10: how the user referred to the train ("doosri wali" → DISPLAY_INDEX 2, "morning wali" → TIME_PREFERENCE MORNING, "last wali" → DEMONSTRATIVE LAST, "Vande Bharat wali" → TRAIN_NAME) — resolved by the backend against the current results (optional; use instead of trainNumber)' },
      travelClass: { type: 'string', description: 'Class code e.g. CC, 2S, 3A — a class listed for that train (optional: defaults to the selected class, else the class the user named at search)' },
      date: { type: 'string', description: 'YYYY-MM-DD (optional: defaults to journey date)' },
      origin: { type: 'string', description: 'Journey origin code (optional: must match the session journey)' },
      destination: { type: 'string', description: 'Journey destination code (optional: must match the session journey)' },
      passengersCount: { type: 'number', description: 'Passenger count (optional: must match the session count)' },
      dateExpression: { type: 'string', description: 'Raw date words as the user said them (kal / parso / 5 March) — the backend DateResolver resolves it (optional)' }
    }
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

/**
 * Prompt 35: WEB_EXTERNAL research. Listed for the LLM ONLY when WEB_RESEARCH_ENABLED=true and a key is set
 * (default: absent → UNKNOWN_TOOL). The LLM decides whether web research is appropriate; the backend never
 * launches it after a provider failure, and its results never authorize availability / fare / booking / PNR.
 */
export const WEB_RAILWAY_RESEARCH_TOOL: ToolDefinition = {
  name: 'WEB_RAILWAY_RESEARCH',
  description: 'Optional web research on trusted railway sources (official Indian Railways / IRCTC first, then ConfirmTkt / RailYatri / eRail as secondary). Use only for general railway information the railway tools cannot provide (rules, policies, news, station facilities). Results are WEB_EXTERNAL and NOT authoritative: never use them for seat availability, fare, booking or PNR status, and never call third-party pages official.',
  parameters: { query: { type: 'string', description: 'Short search query (no PNR, no personal details).', required: true } }
};
if (webResearchEnabledFromEnv()) REGISTERED_TOOLS.push(WEB_RAILWAY_RESEARCH_TOOL);

/**
 * Prompt 42 — Same Train Alternative. ONE bounded, high-level tool (no per-station tool loop): the backend fetches the
 * train's route from a route-capable provider, builds ordered candidate ticket pairs on the SAME train (upstream ticket
 * origins, downstream ticket destinations) and checks each with FRESH provider calls in parallel. Muse decides whether
 * to use it, which providers, and how to rank / present the results; the backend never ranks and never books.
 * Exposed only when SAME_TRAIN_ALTERNATIVES_ENABLED=1 (like WEB_RAILWAY_RESEARCH, opt-in per deployment).
 */
export function sameTrainAlternativesEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(String(env.SAME_TRAIN_ALTERNATIVES_ENABLED || '').trim());
}
export const SEARCH_SAME_TRAIN_ALTERNATIVES_TOOL: ToolDefinition = {
  name: 'SEARCH_SAME_TRAIN_ALTERNATIVES',
  description: 'OPTIONAL Same Train Alternative recovery search — only when YOU judge it useful AND the requested train/class shows a SHORTAGE for this party: WAITLIST, NOT_AVAILABLE, REGRET, TRAIN_CANCELLED, or fewer seats than passengers (e.g. AVAILABLE-0001 for 3 passengers = INSUFFICIENT_SEATS). Never for sufficient availability (e.g. AVAILABLE-0005 for 2 passengers) — the backend refuses that (SAME_TRAIN_ALTERNATIVE_NOT_NEEDED). UNKNOWN / timeout / provider error is NOT a shortage. SEARCH_TRAINS / CHECK_AVAILABILITY results carry seatCheck (requestedPassengerCount, shortages with availableSeatCount + triggerReason) to help you decide. One call = one train + one class: for several shortage classes listed on the train, or several displayed trains with a shortage, make targeted separate calls (they run in parallel; a per-turn budget applies) — never invent a class or train. Checks other TICKET station pairs on the SAME train number, same date / class / passengers: upstream ticket origins (train origin … requested origin) and downstream ticket destinations (5–7 stations after the requested destination, none if it is the terminal). Route comes from a provider timetable; every pair is a FRESH provider availability call (bounded, parallel). Returns per-pair availability with availabilityStatus, availableSeatCount, requestedPassengerCount, seatSufficiency (SUFFICIENT only when count ≥ passengers), provider evidence, verificationStatus (VERIFIED / PARTIALLY_VERIFIED / UNVERIFIED / CONFLICTING), boardingRuleStatus / alightingRuleStatus (UNVERIFIED = do NOT tell the user they can board / deboard at the requested station), and outcome (NO_VERIFIED_SAME_TRAIN_ALTERNATIVE when nothing covers the party — you phrase it). You decide relevance, order and wording; optionally call PRESENT_SAME_TRAIN_ALTERNATIVES to mark your best match. Nothing is booked or changed.',
  parameters: {
    trainNumber: { type: 'string', description: 'The SAME train number (from the shown results, the selected train, or the user\'s words).', required: true },
    travelClass: { type: 'string', description: 'The REQUESTED class code (default: the selected class, else the class the user named at search). No train / class selection is needed — a train from the shown results is enough.' },
    classes: { type: 'string', description: 'P42.7 all-class route matrix: ALL (default — every class the train\'s search result lists; requested class first), REQUESTED (only travelClass), or comma-separated codes from that train\'s listed classes.' },
    explicitUserRequest: { type: 'boolean', description: 'true ONLY when the user explicitly asked for more / other same-train options although the requested class already has enough seats.' },
    date: { type: 'string', description: 'Journey date YYYY-MM-DD (default: the session journey date).' },
    dateExpression: { type: 'string', description: 'Date exactly as the user said it ("kal") — resolved by the backend.' },
    origin: { type: 'string', description: 'Requested boarding station CODE (default: session journey origin).' },
    destination: { type: 'string', description: 'Requested destination station CODE (default: session journey destination).' },
    passengersCount: { type: 'number', description: 'Passengers 1–6 (default: session count or 1).' },
    originSweep: { type: 'boolean', description: 'Check upstream ticket origins (default true).' },
    destinationSweep: { type: 'boolean', description: 'Check downstream ticket destinations (default true; ignored when the destination is the terminal).' },
    destinationExtensionStations: { type: 'number', description: 'How many stations after the destination to try: 5–7 (default 7; never past the terminal). Up to 15 earlier boarding stations are checked.' },
    combinedPairs: { type: 'string', description: 'Upstream origin + downstream destination together: AUTO (only if no AVAILABLE / RAC pair found otherwise), ALWAYS, NEVER. Default AUTO.', enum: ['AUTO', 'ALWAYS', 'NEVER'] },
    providers: { type: 'string', description: 'Comma-separated availability providers to use (e.g. "railcore,railradar"). Default: all configured railway APIs.' },
    routeProvider: { type: 'string', description: 'Provider whose timetable gives the route (must support timetable). Default: first chosen provider with a timetable.' },
    includeFare: { type: 'boolean', description: 'Also fetch provider fares for pairs with an availability answer (default false — more calls).' },
    webEvidence: { type: 'boolean', description: 'Also collect public-web route evidence (robots-allowed sources only; UNVERIFIED_WEB, never availability). Default false.' },
    triggerReason: { type: 'string', description: 'Why you are searching (recorded; authoritative session data wins when present).', enum: ['INSUFFICIENT_SEATS', 'WAITLIST', 'NOT_AVAILABLE', 'REGRET', 'CLASS_UNAVAILABLE', 'TRAIN_CANCELLED', 'OTHER_AUTHORIZED_SHORTAGE'] }
  }
};
export const PRESENT_SAME_TRAIN_ALTERNATIVES_TOOL: ToolDefinition = {
  name: 'PRESENT_SAME_TRAIN_ALTERNATIVES',
  description: 'Optional, after SEARCH_SAME_TRAIN_ALTERNATIVES: record YOUR ranking for the screen. bestMatch = the alternativeId you recommend (only a VERIFIED or PARTIALLY_VERIFIED one), order = your display order. No provider call; nothing is booked. Skip it when no option deserves a recommendation.',
  parameters: {
    alternativeSearchId: { type: 'string', description: 'alternativeSearchId of the latest Same Train Alternative result.', required: true },
    bestMatch: { type: 'string', description: 'alternativeId you recommend (e.g. "A3"), or omit.' },
    order: { type: 'string', description: 'Comma-separated alternativeIds in your preferred order (e.g. "A3,A1,A2").' }
  }
};
if (sameTrainAlternativesEnabledFromEnv()) REGISTERED_TOOLS.push(SEARCH_SAME_TRAIN_ALTERNATIVES_TOOL, PRESENT_SAME_TRAIN_ALTERNATIVES_TOOL);

export function getToolDefinition(name: RegisteredToolName): ToolDefinition | undefined {
  return REGISTERED_TOOLS.find(t => t.name === name);
}
