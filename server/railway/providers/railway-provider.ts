import type {
  SearchTrainsRequest, TrainSearchResultData,
  TrainInfoRequest, TrainDetails,
  TimetableRequest, AvailabilityRequest, AvailabilityData,
  FareRequest, FareData,
  TrackRequest, TrackData,
  PNRRequest, PNRData,
  RailwayResponse
} from '../types/railway-types';

// Re-export aliases used by RailwayToolService
export type SearchTrainsParams = SearchTrainsRequest;
export type CheckAvailabilityParams = AvailabilityRequest;
export type GetFareParams = FareRequest;

export interface RailwayProvider {
  readonly providerId: string;
  readonly source: import('../types/railway-types').DataSource;
  readonly label: string;
  readonly isMock: boolean;

  init?(): Promise<void>;

  searchTrains(req: SearchTrainsRequest): Promise<RailwayResponse<TrainSearchResultData>>;
  getTrainInfo(req: TrainInfoRequest): Promise<RailwayResponse<TrainDetails | null>>;
  getTimetable(req: TimetableRequest): Promise<RailwayResponse<any[]>>;
  checkAvailability(req: AvailabilityRequest): Promise<RailwayResponse<AvailabilityData>>;
  getFare(req: FareRequest): Promise<RailwayResponse<FareData>>;
  trackTrain(req: TrackRequest): Promise<RailwayResponse<TrackData>>;
  checkPNR(req: PNRRequest): Promise<RailwayResponse<PNRData>>;
}
