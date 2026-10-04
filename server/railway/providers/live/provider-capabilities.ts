/**
 * PROMPT 35 — Explicit railway provider capability registry.
 *
 * Each provider DECLARES which railway tools it can execute (documented endpoints only). The registry answers ONE
 * question for the provider layer: "can provider P execute the tool the LLM already chose?". It never chooses a tool,
 * never orders tools and never triggers a follow-up — the LLM remains the only decision maker (no business-flow router).
 */
export type RailwayCapability =
  | 'SEARCH_TRAINS' | 'GET_TRAIN_INFO' | 'GET_TIMETABLE' | 'TRACK_TRAIN'
  | 'CHECK_AVAILABILITY' | 'GET_FARE' | 'CHECK_PNR' | 'GET_CANCELLED_TRAINS';

export type LiveProviderId = 'railcore' | 'railkit' | 'railradar';

export const RAILWAY_CAPABILITIES: readonly RailwayCapability[] = Object.freeze([
  'SEARCH_TRAINS', 'GET_TRAIN_INFO', 'GET_TIMETABLE', 'TRACK_TRAIN', 'CHECK_AVAILABILITY', 'GET_FARE', 'CHECK_PNR', 'GET_CANCELLED_TRAINS'
] as RailwayCapability[]);

/**
 * Documented endpoint behind every declared capability (for audit / docs; the adapters use exactly these paths).
 * A capability absent here is UNSUPPORTED for that provider — never emulated, never scraped.
 */
export const PROVIDER_CAPABILITY_MATRIX: Readonly<Record<LiveProviderId, Readonly<Partial<Record<RailwayCapability, string>>>>> = Object.freeze({
  railcore: Object.freeze({
    SEARCH_TRAINS: 'GET /v1/routes/trains',
    GET_TRAIN_INFO: 'GET /v1/trains/{train_number}/schedule',
    GET_TIMETABLE: 'GET /v1/trains/{train_number}/schedule',
    TRACK_TRAIN: 'GET /v1/trains/{train_number}/live',
    CHECK_AVAILABILITY: 'GET /v1/availability/seats',
    GET_FARE: 'GET /v1/availability/seats (date-specific class fare) · GET /v1/fares/estimate (no date)'
  }),
  // Only capabilities whose response contract was verified from RailKit's public docs are declared. RailKit also
  // documents train info, live tracking, PNR and cancelled trains — NOT integrated in P35 (no key to verify shapes).
  railkit: Object.freeze({
    SEARCH_TRAINS: 'GET /api/v1/trains/between/{from}/{to}?date=DD-MM-YYYY',
    CHECK_AVAILABILITY: 'GET /api/v1/seats/{trainNo}/{from}/{to}/{date}/{class}/{quota}',
    GET_FARE: 'GET /api/v1/seats/{trainNo}/{from}/{to}/{date}/{class}/{quota} (fare.totalFare, date + class specific)'
  }),
  railradar: Object.freeze({
    SEARCH_TRAINS: 'GET /v1/trains/between/{from}/{to}',
    GET_TRAIN_INFO: 'GET /v1/trains/{number}',
    GET_TIMETABLE: 'GET /v1/trains/{number}',
    TRACK_TRAIN: 'GET /v1/trains/{number}/live',
    CHECK_AVAILABILITY: 'GET /v1/trains/{number}/seats',
    GET_FARE: 'GET /v1/trains/{number}/fare',
    CHECK_PNR: 'GET /v1/pnr/{pnr}'
  })
});

export function providerSupports(provider: LiveProviderId, capability: RailwayCapability): boolean {
  return !!PROVIDER_CAPABILITY_MATRIX[provider]?.[capability];
}

/** RailwayProvider method → the tool / capability it serves (1:1, no inference). */
export const METHOD_CAPABILITY = Object.freeze({
  searchTrains: 'SEARCH_TRAINS', getTrainInfo: 'GET_TRAIN_INFO', getTimetable: 'GET_TIMETABLE', trackTrain: 'TRACK_TRAIN',
  checkAvailability: 'CHECK_AVAILABILITY', getFare: 'GET_FARE', checkPNR: 'CHECK_PNR'
} as const satisfies Record<string, RailwayCapability>);
export type ProviderMethod = keyof typeof METHOD_CAPABILITY;
