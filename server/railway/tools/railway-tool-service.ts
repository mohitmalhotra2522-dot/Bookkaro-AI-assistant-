import type { RailwayProvider, SearchTrainsParams, CheckAvailabilityParams, GetFareParams } from '../providers/railway-provider';
import type {
  TrainDetails, AvailabilityData, FareData,
  TrackData, PNRData, RailwayResponse, TrainSearchResultData
} from '../types/railway-types';
import { railwayRegistry } from '../registry/provider-registry';
import { providerFreshnessOf, type ProviderFreshness } from '@shared/provider-freshness';
import { SAME_TRAIN_DEFAULT_LIMITS } from '@shared/same-train-alternatives';

/** 2026-10-09: freshness limit = the existing same-train snapshot limit (SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN, default 120; 0 = off). */
export function providerFreshnessMaxAgeMs(env: Record<string, string | undefined> = process.env): number {
  const v = env.SAME_TRAIN_MAX_SNAPSHOT_AGE_MIN;
  const n = v !== undefined && String(v).trim() !== '' ? Number(v) : NaN;
  const min = Number.isFinite(n) ? Math.min(Math.max(0, n), 24 * 60) : Math.round((SAME_TRAIN_DEFAULT_LIMITS.maxSnapshotAgeMs ?? 7_200_000) / 60_000);
  return min * 60_000;
}

/** Adds `freshness` (from the provider's own providerUpdatedAt only — never invented) to a successful answer. */
function withFreshness<T extends object>(r: RailwayResponse<T>): RailwayResponse<T & { freshness: ProviderFreshness }> {
  if (!r || !r.ok || !r.data || typeof r.data !== 'object') return r as RailwayResponse<T & { freshness: ProviderFreshness }>;
  const freshness = providerFreshnessOf((r.data as any).providerUpdatedAt, { maxAgeMs: providerFreshnessMaxAgeMs() });
  return { ...r, data: { ...r.data, freshness } };
}

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

  // 2026-10-09: every provider (incl. one the LLM picked via a provider tool) gets the same freshness label here
  async CHECK_AVAILABILITY(params: CheckAvailabilityParams): Promise<RailwayResponse<AvailabilityData & { freshness?: ProviderFreshness }>> {
    return withFreshness(await this.provider.checkAvailability(params));
  }

  async GET_FARE(params: GetFareParams): Promise<RailwayResponse<FareData & { freshness?: ProviderFreshness }>> {
    return withFreshness(await this.provider.getFare(params));
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
