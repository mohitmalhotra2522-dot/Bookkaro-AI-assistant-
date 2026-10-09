/**
 * Railway domain types — provider-independent.
 * All railway results carry source/timestamp/latency/error metadata.
 */

export type StationCode = string;

export type DataSource = 'mock' | 'railway-provider';

export type RailwayErrorCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'NO_TRAINS_FOUND'
  | 'INVALID_ROUTE'
  | 'INVALID_DATE'
  | 'AMBIGUOUS_DATE'
  | 'AMBIGUOUS_STATION'
  | 'MISSING_REQUIRED_FIELD'
  | 'AVAILABILITY_UNAVAILABLE'
  | 'FARE_UNAVAILABLE'
  | 'TIMEOUT'
  | 'TRAIN_NOT_IN_RESULTS'
  | 'CLASS_NOT_AVAILABLE'
  // Prompt 35: live-provider outcomes (all map onto the existing ToolErrorCode vocabulary — no new tool codes)
  | 'RATE_LIMITED'
  | 'AUTH_ERROR'
  | 'PROVIDER_DATA_INVALID'
  | 'TOOL_NOT_IMPLEMENTED'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'NOT_CONFIGURED';

export interface RailwayError {
  code: RailwayErrorCode;
  message: string;
  missing?: string[];
  /** Prompt 35 (additive): provider said the same request may succeed later (429 / 5xx / timeout). */
  retryable?: boolean;
  httpStatus?: number | null;
}

export interface RailwayMeta {
  source: DataSource;
  providerId: string;
  requestTimestamp: string;
  responseTimestamp: string;
  latencyMs: number;
  cache: 'disabled';
  /** Prompt 35 (additive): provider freshness metadata as returned (never synthesized). */
  freshness?: { mode?: string; retrievedAt?: string } | null;
  /** Prompt 35 (additive): every provider attempt behind this response (failover chain), no credentials. */
  attempts?: ProviderAttempt[];
  /** Prompt 35 (additive): true when a fallback provider (not the primary) served this response. */
  fallbackUsed?: boolean;
  /** P42.9 (additive): why the backend fell back (primary's error code: RATE_LIMITED / TIMEOUT / PROVIDER_UNAVAILABLE). */
  fallbackReason?: string;
  /** P42.9 (additive): RATE_LIMITED produced by the local pacer (no provider request spent) vs by the provider (429). */
  rateLimit?: { local: boolean; /** 2026-10-09: local monthly request estimate reached (no provider request made) */ reason?: 'LOCAL_MONTHLY_QUOTA' };
}

/** Prompt 35 — one provider attempt inside a failover chain (observability; never contains keys or raw bodies). */
export interface ProviderAttempt {
  provider: string;
  attempt: number;
  outcome: 'DATA' | 'NO_RESULTS' | 'UNSUPPORTED' | 'NOT_CONFIGURED' | 'TIMEOUT' | 'PROVIDER_FAILURE' | 'MALFORMED_DATA' | 'REJECTED' | 'SKIPPED_BUDGET';
  errorCode: string | null;
  httpStatus: number | null;
  latencyMs: number;
  retryable: boolean;
}

export interface RailwayResponse<T> {
  ok: boolean;
  data?: T;
  error?: RailwayError;
  meta: RailwayMeta;
}

// ---- Search ----

export interface SearchTrainsRequest {
  origin: StationCode;
  destination: StationCode;
  date: string; // canonical YYYY-MM-DD
  preferredTime?: 'MORNING' | 'AFTERNOON' | 'EVENING' | 'NIGHT' | 'ANY';
  preferredClass?: 'AC' | 'NON_AC' | 'ANY';
  passengersCount?: number;
}

export interface ResolvedStation {
  code: StationCode;
  name: string;
}

export interface ClassOption {
  code: string; // CC, 2S, 3A, SL …
  name?: string;
  availability: string | null; // null = unknown / unavailable to retrieve
  availabilityStatus: 'AVAILABLE' | 'RAC' | 'WAITLIST' | 'NOT_AVAILABLE' | 'UNKNOWN';
  fare: number | null; // INR, null = unknown
  fareCurrency: 'INR' | null;
}

export interface NormalizedTrain {
  trainNumber: string;
  trainName: string;
  origin: StationCode;
  destination: StationCode;
  departure: string; // HH:MM
  arrival: string; // HH:MM
  duration: string; // e.g. "5h 55m"
  runsOn?: string[];
  classes: ClassOption[]; // grouped: same-train classes live here together
}

export interface TrainSearchResultData {
  journey: {
    origin: StationCode;
    originName?: string;
    destination: StationCode;
    destinationName?: string;
    date: string;
  };
  trains: NormalizedTrain[];
  totalCount: number;
}

// ---- Other tools ----
export interface TrainInfoRequest { trainNumber: string; date?: string; }
export interface TimetableRequest { trainNumber: string; }
export interface AvailabilityRequest { trainNumber: string; travelClass: string; date: string; /** Prompt 35: authoritative session journey (live APIs need the segment). */ origin?: string; destination?: string; }
export interface FareRequest { trainNumber: string; travelClass: string; passengersCount: number; date?: string; origin?: string; destination?: string; }
export interface TrackRequest { trainNumber: string; }
export interface PNRRequest { pnr: string; }

export interface TrainDetails extends NormalizedTrain {
  /** P38: provider-reported on-board facilities (absent = the provider does not say). */
  facilities?: { catering?: boolean; pantry?: boolean };
  timetable?: Array<{ station: StationCode; stationName?: string; arrival?: string; departure?: string }>;
}

export interface AvailabilityData {
  trainNumber: string;
  travelClass: string;
  date: string;
  status: string;
  available: boolean;
  /** Prompt 35 (additive, provider-returned only): raw availability text (e.g. "GNWL51/WL30"), quota, provider update time. */
  statusText?: string;
  quota?: string;
  providerUpdatedAt?: string | null;
}

export interface FareData {
  trainNumber: string;
  travelClass: string;
  passengersCount: number;
  perPassenger: number;
  total: number;
  currency: 'INR';
  breakdown: Record<string, number>;
  /** Prompt 35 (additive): journey date the provider priced (absent when the provider fare is not date-specific). */
  date?: string;
  quota?: string;
}

export interface TrackData {
  trainNumber: string;
  currentStatus?: string;
  lastUpdated?: string;
  /** Prompt 14 (optional, provider-supplied only): last reported station / delay. */
  trainName?: string;
  currentStationCode?: string;
  currentStationName?: string;
  delayMinutes?: number;
}

/** Prompt 14: per-passenger PNR status — provider-supplied only (never derived locally). */
export interface PNRPassengerStatus { number: number; bookingStatus: string; currentStatus: string }

export interface PNRData {
  pnr: string;
  status?: string;
  /** Prompt 14 (optional, provider-supplied only). */
  chartStatus?: string;
  trainNumber?: string;
  trainName?: string;
  journeyDate?: string;
  from?: string;
  to?: string;
  travelClass?: string;
  passengers?: PNRPassengerStatus[];
}
