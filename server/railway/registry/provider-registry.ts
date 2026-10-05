import type { RailwayProvider } from '../providers/railway-provider';
import { MockRailwayProvider } from '../providers/mock/mock-provider';
import { createFailoverProvider, createLiveProvider, parseProviderChain } from '../providers/live/live-config';
import { scopedProviderId } from '../providers/provider-scope';
import { providerToolCatalog, setWebBlockedLookup } from '../../ai/tools/provider-tools';
import { PROVIDER_CAPABILITY_MATRIX, type LiveProviderId } from '../providers/live/provider-capabilities';
import type { RegisteredToolName } from '../../ai/tools/tool-registry';
import { createWebProvider, enabledWebConnectors, blockedWebCapability, WEB_CAPABILITY_MATRIX, WEB_PROVIDER_LABEL } from '../providers/web/web-providers';

// P39: a call for a web capability that robots.txt blocks / that only a private API offers is answered WEB_ACCESS_BLOCKED
setWebBlockedLookup((provider, canonical) => { const b = blockedWebCapability(provider, canonical); return b ? { status: b.status, note: b.note } : null; });

const LIVE_LABEL: Record<LiveProviderId, string> = { railcore: 'RailCore', railradar: 'RailRadar', railkit: 'RailKit' };
/** Declared capability → canonical tool contract (GET_CANCELLED_TRAINS has no RailwayProvider contract → not exposed). */
const CAP_TO_TOOL: Record<string, RegisteredToolName> = {
  SEARCH_TRAINS: 'SEARCH_TRAINS', GET_TRAIN_INFO: 'GET_TRAIN_INFO', GET_TIMETABLE: 'GET_TIMETABLE', TRACK_TRAIN: 'TRACK_TRAIN',
  CHECK_AVAILABILITY: 'CHECK_AVAILABILITY', GET_FARE: 'GET_FARE', CHECK_PNR: 'CHECK_PNR'
};

/**
 * P37: every configured live provider (RAILWAY_PRIMARY_PROVIDER + RAILWAY_FALLBACK_PROVIDERS, key present) becomes a set
 * of provider-level LLM tools for exactly its documented capabilities. Unconfigured / unimplemented providers are not
 * exposed. The LLM picks among them — the registry never does.
 */
export function registerLiveProviderTools(env: NodeJS.ProcessEnv = process.env): string[] {
  const ids = parseProviderChain(env);
  const exposed: string[] = [];
  for (const id of ids) {
    const p = createLiveProvider(id, env);
    if (!p.configured) continue;
    const caps = Object.keys(PROVIDER_CAPABILITY_MATRIX[id] || {}).map(c => CAP_TO_TOOL[c]).filter(Boolean);
    if (!caps.length) continue;
    providerToolCatalog.register({ id, label: LIVE_LABEL[id], registryId: id, capabilities: caps });
    exposed.push(id);
  }
  // P38: robots-allowed WEB connectors (eRail / RailYatri) — extra tools the LLM may choose; never a hidden fallback
  for (const id of enabledWebConnectors(env)) {
    const caps = Object.keys(WEB_CAPABILITY_MATRIX[id] || {}).map(c => CAP_TO_TOOL[c]).filter(Boolean);
    if (!caps.length) continue;
    providerToolCatalog.register({ id, label: `${WEB_PROVIDER_LABEL[id]} (web)`, registryId: id, capabilities: caps, note: WEB_NOTE[id] });
    exposed.push(id);
  }
  return exposed;
}

const WEB_NOTE: Record<string, string> = {
  erail: 'WEB_RAILWAY_SEARCH via the public eRail website — WEB DATA, UNVERIFIED (not a railway API): trains, timings, run days and coach classes only; NO seat availability (robots.txt blocks it) and NO fare (unverifiable). Use it when the API providers cannot answer, or when the user asks for web verification. Always tell the user it is unverified web data.',
  railyatri: 'WEB_RAILWAY_STATUS via the RailYatri website — WEB DATA, UNVERIFIED, crowd-sourced (not a railway API): live running status, delay, next station, platform. Tell the user it is crowd-sourced / unverified and give its source-reported time.',
  confirmtkt: 'WEB_RAILWAY_STATUS via the ConfirmTkt website — WEB DATA, UNVERIFIED (not affiliated with Indian Railways): running status, last reported station, delay and the source "Last Updated" time. ONLY live status: ConfirmTkt train search / PNR are robots-blocked; availability / fare have no public page.'
};

/**
 * RailwayProviderRegistry — simple config-driven provider selector.
 * Active provider is selected via RAILWAY_PROVIDER env var (default: mock).
 * Future real providers register themselves here WITHOUT touching other layers.
 */
export class RailwayProviderRegistry {
  private providers: Map<string, () => RailwayProvider> = new Map();
  private activeId: string;

  constructor() {
    // Register built-in providers
    this.register('mock', () => new MockRailwayProvider());
    // Prompt 35: real providers (documented APIs, env keys only). 'live' = RAILCORE → RAILKIT → RAILRADAR failover
    // (order from RAILWAY_PRIMARY_PROVIDER / RAILWAY_FALLBACK_PROVIDERS). The chain holds LIVE adapters only — there is
    // never a fallback to MOCK, and MOCK never falls back to live.
    this.register('live', () => createFailoverProvider());
    this.register('railcore', () => createLiveProvider('railcore'));
    this.register('railkit', () => createLiveProvider('railkit'));
    this.register('railradar', () => createLiveProvider('railradar'));
    // P38: web connectors (only reachable through their own provider tools / provider scope)
    this.register('erail', () => createWebProvider('erail'));
    this.register('railyatri', () => createWebProvider('railyatri'));
    this.register('confirmtkt', () => createWebProvider('confirmtkt'));   // P39: robots-allowed running-status page only

    this.activeId = process.env.RAILWAY_PROVIDER || 'mock';
    // an unknown id / chain is a startup error, never a silent switch
    if (!this.providers.has(this.activeId)) throw new Error(`Unknown railway provider: ${this.activeId}. Available: ${[...this.providers.keys()].join(', ')}`);
    if (this.activeId === 'live') { createFailoverProvider(); registerLiveProviderTools(); }
  }

  register(id: string, factory: () => RailwayProvider): void {
    this.providers.set(id, factory);
  }

  setActive(id: string): void {
    if (!this.providers.has(id)) {
      throw new Error(`Unknown railway provider: ${id}. Available: ${[...this.providers.keys()].join(', ')}`);
    }
    this.activeId = id;
  }

  getActive(): RailwayProvider {
    // P37: inside a provider-tool execution the LLM-selected connector is used — never the failover chain
    const scoped = scopedProviderId();
    if (scoped) {
      const f = this.providers.get(scoped);
      if (!f) throw new Error(`No railway provider connector registered for ${scoped}`);
      return f();
    }
    const factory = this.providers.get(this.activeId);
    if (!factory) throw new Error(`No active railway provider (id=${this.activeId})`);
    return factory();
  }

  getActiveId(): string {
    return this.activeId;
  }

  /**
   * Prompt 32: explicit provider identity — MOCK (development fixtures, never presented as live) or REAL. Taken from
   * the provider's own declared source; there is no fallback between kinds (an unknown id throws, never switches).
   */
  getActiveKind(): 'MOCK' | 'REAL' {
    return this.getActive().source === 'mock' ? 'MOCK' : 'REAL';
  }

  listAvailable(): string[] {
    return [...this.providers.keys()];
  }
}

// Singleton registry for the application
export const railwayRegistry = new RailwayProviderRegistry();
