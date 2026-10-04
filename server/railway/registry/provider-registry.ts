import type { RailwayProvider } from '../providers/railway-provider';
import { MockRailwayProvider } from '../providers/mock/mock-provider';
import { createFailoverProvider, createLiveProvider } from '../providers/live/live-config';

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

    this.activeId = process.env.RAILWAY_PROVIDER || 'mock';
    // an unknown id / chain is a startup error, never a silent switch
    if (!this.providers.has(this.activeId)) throw new Error(`Unknown railway provider: ${this.activeId}. Available: ${[...this.providers.keys()].join(', ')}`);
    if (this.activeId === 'live') createFailoverProvider();
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
