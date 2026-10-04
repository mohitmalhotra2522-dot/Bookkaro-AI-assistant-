/**
 * P37 — deterministic MOCK connectors for the REAL providers only (RailCore, RailRadar) — used by automated tests and
 * the §29 scenarios. They are labelled MOCK everywhere (source 'mock', isMock true, label "… (MOCK)") and are never
 * presented as live data. There are deliberately NO mock ConfirmTkt / RailYatri / eRail connectors: those providers have
 * no real integration, so they only ever answer PROVIDER_NOT_IMPLEMENTED.
 *
 * Failure injection per capability: TIMEOUT (never answers → runtime timeout), UNAVAILABLE, RATE_LIMITED, AUTH_ERROR,
 * EMPTY (success, zero trains). A fare override lets two providers disagree (conflict scenario).
 */
import { MockRailwayProvider } from './mock-provider';
import { railwayRegistry } from '../../registry/provider-registry';
import { providerToolCatalog } from '../../../ai/tools/provider-tools';
import type { RegisteredToolName } from '../../../ai/tools/tool-registry';

export type MockFault = 'TIMEOUT' | 'UNAVAILABLE' | 'RATE_LIMITED' | 'AUTH_ERROR' | 'EMPTY';
export type MockCapability = 'search' | 'availability' | 'fare' | 'live_status' | 'pnr' | 'train_info' | 'timetable';

const now = () => new Date().toISOString();

export class MockProviderConnector extends MockRailwayProvider {
  /** capability → injected fault (cleared by reset()) */
  faults: Partial<Record<MockCapability, MockFault>> = {};
  /** travelClass → per-passenger fare override (conflict scenario) */
  fareOverride: Record<string, number> = {};
  /** every call this connector received: [capability, request] — proves which provider the backend ran */
  calls: Array<[MockCapability, any]> = [];

  constructor(readonly connectorId: 'railcore' | 'railradar', readonly connectorLabel: string) { super(); }

  get mockProviderId(): string { return `mock-${this.connectorId}`; }

  reset(): void { this.faults = {}; this.fareOverride = {}; this.calls = []; }

  private meta() { const t = now(); return { source: 'mock' as const, providerId: this.mockProviderId, requestTimestamp: t, responseTimestamp: t, latencyMs: 1, cache: 'disabled' as const }; }

  private fault(cap: MockCapability): any {
    const f = this.faults[cap];
    if (!f || f === 'EMPTY') return null;
    if (f === 'TIMEOUT') return new Promise(() => { /* never answers → the gateway's timeout → PROVIDER_TIMEOUT */ });
    const code = f === 'UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : f;
    return { ok: false, error: { code, message: `${this.connectorLabel} mock fault ${f}` }, meta: this.meta() };
  }

  private tag<T extends { meta?: any }>(r: T): T {
    return r && (r as any).meta ? { ...r, meta: { ...(r as any).meta, providerId: this.mockProviderId } } : r;
  }

  async searchTrains(req: any): Promise<any> {
    this.calls.push(['search', req]);
    const f = this.fault('search'); if (f) return f;
    if (this.faults.search === 'EMPTY') return { ok: true, data: { trains: [], origin: req.origin, destination: req.destination, date: req.date }, meta: this.meta() };
    return this.tag(await super.searchTrains(req));
  }
  async checkAvailability(req: any): Promise<any> {
    this.calls.push(['availability', req]);
    return this.fault('availability') ?? this.tag(await super.checkAvailability(req));
  }
  async getFare(req: any): Promise<any> {
    this.calls.push(['fare', req]);
    const f = this.fault('fare'); if (f) return f;
    const r: any = this.tag(await super.getFare(req));
    const o = this.fareOverride[req.travelClass];
    if (r?.ok && typeof o === 'number') r.data = { ...r.data, perPassenger: o, total: o * (req.passengersCount || 1), breakdown: { baseFare: o * (req.passengersCount || 1) } };
    return r;
  }
  async trackTrain(req: any): Promise<any> {
    this.calls.push(['live_status', req]);
    const f = this.fault('live_status'); if (f) return f;
    // deterministic MOCK running status (labelled mock) — lets the live-status tool path be tested without a network
    return { ok: true, data: { trainNumber: req.trainNumber, currentStatus: 'Running (MOCK)', currentStationCode: 'LDH', currentStationName: 'Ludhiana Jn (MOCK)', delayMinutes: this.connectorId === 'railcore' ? 12 : 15, lastUpdated: now() }, meta: this.meta() };
  }
  async checkPNR(req: any): Promise<any> {
    this.calls.push(['pnr', req]);
    return this.fault('pnr') ?? this.tag(await super.checkPNR(req));
  }
}

export const MOCK_CONNECTOR_CAPS: Record<'railcore' | 'railradar', RegisteredToolName[]> = {
  railcore: ['SEARCH_TRAINS', 'CHECK_AVAILABILITY', 'GET_FARE', 'TRACK_TRAIN'],
  railradar: ['SEARCH_TRAINS', 'CHECK_AVAILABILITY', 'GET_FARE', 'TRACK_TRAIN', 'CHECK_PNR']
};

/** Register MOCK RailCore + RailRadar connectors as provider tools (tests). Returns them + an unregister function. */
export function registerMockProviderConnectors(): { railcore: MockProviderConnector; railradar: MockProviderConnector; dispose: () => void } {
  const railcore = new MockProviderConnector('railcore', 'RailCore (MOCK)');
  const railradar = new MockProviderConnector('railradar', 'RailRadar (MOCK)');
  for (const c of [railcore, railradar]) {
    railwayRegistry.register(c.mockProviderId, () => c);
    providerToolCatalog.register({ id: c.connectorId, label: c.connectorLabel, registryId: c.mockProviderId, capabilities: MOCK_CONNECTOR_CAPS[c.connectorId] });
  }
  return { railcore, railradar, dispose: () => providerToolCatalog.clear() };
}
