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
  | 'CLASS_NOT_AVAILABLE';

export interface RailwayError {
  code: RailwayErrorCode;
  message: string;
  missing?: string[];
}

export interface RailwayMeta {
  source: DataSource;
  providerId: string;
  requestTimestamp: string;
  responseTimestamp: string;
  latencyMs: number;
  cache: 'disabled';
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
export interface AvailabilityRequest { trainNumber: string; travelClass: string; date: string; }
export interface FareRequest { trainNumber: string; travelClass: string; passengersCount: number; date?: string; origin?: string; destination?: string; }
export interface TrackRequest { trainNumber: string; }
export interface PNRRequest { pnr: string; }

export interface TrainDetails extends NormalizedTrain {
  timetable?: Array<{ station: StationCode; stationName?: string; arrival?: string; departure?: string }>;
}

export interface AvailabilityData {
  trainNumber: string;
  travelClass: string;
  date: string;
  status: string;
  available: boolean;
}

export interface FareData {
  trainNumber: string;
  travelClass: string;
  passengersCount: number;
  perPassenger: number;
  total: number;
  currency: 'INR';
  breakdown: Record<string, number>;
}

export interface TrackData {
  trainNumber: string;
  currentStatus?: string;
  lastUpdated?: string;
}

export interface PNRData {
  pnr: string;
  status?: string;
}
