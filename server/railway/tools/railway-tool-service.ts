import type { RailwayProvider, SearchTrainsParams, CheckAvailabilityParams, GetFareParams } from '../providers/railway-provider';
import type {
  TrainDetails, AvailabilityData, FareData,
  TrackData, PNRData, RailwayResponse, TrainSearchResultData
} from '../types/railway-types';
import { railwayRegistry } from '../registry/provider-registry';

/**
 * Railway Tool Service: routes to the active RailwayProvider from the registry.
 * Every tool returns a typed RailwayResponse with metadata; AI never invents data.
 */
export class RailwayToolService {
  private get provider(): RailwayProvider { return railwayRegistry.getActive(); }

  async SEARCH_TRAINS(params: SearchTrainsParams): Promise<RailwayResponse<TrainSearchResultData>> {
    if (!params.origin || !params.destination || !params.date) {
      return {
        ok: false,
        error: { code: 'MISSING_REQUIRED_FIELD', message: 'SEARCH_TRAINS requires origin, destination, date', missing: ['origin','destination','date'].filter(f => !(params as any)[f]) },
        meta: this._meta()
      };
    }
    return this.provider.searchTrains(params);
  }

  async GET_TRAIN_INFO(trainNumber: string): Promise<RailwayResponse<TrainDetails | null>> {
    if (!trainNumber) {
      return { ok: false, error: { code: 'MISSING_REQUIRED_FIELD', message: 'trainNumber required' }, meta: this._meta() };
    }
    return this.provider.getTrainInfo({ trainNumber });
  }

  async GET_TIMETABLE(trainNumber: string): Promise<RailwayResponse<any[]>> {
    return this.provider.getTimetable({ trainNumber });
  }

  async CHECK_AVAILABILITY(params: CheckAvailabilityParams): Promise<RailwayResponse<AvailabilityData>> {
    return this.provider.checkAvailability(params);
  }

  async GET_FARE(params: GetFareParams): Promise<RailwayResponse<FareData>> {
    return this.provider.getFare(params);
  }

  async TRACK_TRAIN(trainNumber: string): Promise<RailwayResponse<TrackData>> {
    return this.provider.trackTrain({ trainNumber });
  }

  async CHECK_PNR(pnr: string): Promise<RailwayResponse<PNRData>> {
    return this.provider.checkPNR({ pnr });
  }

  get providerLabel(): string { return this.provider.label; }
  get isMock(): boolean { return this.provider.source === 'mock'; }

  private _meta() {
    const now = new Date().toISOString();
    return {
      source: this.provider.source, providerId: this.provider.providerId,
      requestTimestamp: now, responseTimestamp: now, latencyMs: 0, cache: 'disabled' as const
    };
  }
}
