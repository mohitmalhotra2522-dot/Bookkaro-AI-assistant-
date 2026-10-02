/**
 * BookingProviderRegistry — deterministic provider resolution, fail-closed.
 *
 *  - REAL_BOOKING_ENABLED off, or any config error → the "disabled" provider (BOOKING_EXECUTION_DISABLED).
 *  - configured name not registered → BOOKING_PROVIDER_UNKNOWN. NEVER a fallback to
 *    another provider (no silent switch to "disabled" or anything else).
 *  - capabilities missing / malformed / throwing → BOOKING_PROVIDER_UNAVAILABLE.
 *  - Production registry: ONLY DisabledBookingProvider (no real provider exists in this project).
 *    TEST providers only with { allowTestProviders: true } and a "test" name prefix.
 */
import type { BookingProviderCapabilities } from '@shared/booking-provider';
import type { BookingProvider } from './booking-provider';
import { DisabledBookingProvider, DISABLED_PROVIDER_NAME } from './disabled-booking-provider';
import type { BookingProviderConfig } from './booking-provider-config';
import { validateCapabilities } from './provider-response-schema';

export type ProviderResolution =
  | { ok: true; provider: BookingProviderProviderRef; capabilities: Readonly<BookingProviderCapabilities>; configured: string; effective: string; masterSwitchOff: boolean }
  | { ok: false; code: 'BOOKING_PROVIDER_UNKNOWN' | 'BOOKING_PROVIDER_UNAVAILABLE'; configured: string; effective: string; capabilities: Readonly<BookingProviderCapabilities> };
type BookingProviderProviderRef = BookingProvider;

export const noneCapabilities = (name: string, reason: string): Readonly<BookingProviderCapabilities> => Object.freeze({
  providerName: name, available: false, supportsBooking: false, supportsStatus: false, supportsCancellation: false,
  requiresExternalHandoff: false, supportsIdempotency: false, health: 'UNKNOWN', reason
});

export class BookingProviderRegistry {
  private readonly providers = new Map<string, BookingProvider>();
  readonly allowTestProviders: boolean;

  constructor(opts: { allowTestProviders?: boolean; includeDisabled?: boolean } = {}) {
    this.allowTestProviders = !!opts.allowTestProviders;
    if (opts.includeDisabled !== false) this.providers.set(DISABLED_PROVIDER_NAME, new DisabledBookingProvider());
  }

  register(p: BookingProvider): void {
    if (!p || typeof p.name !== 'string' || !/^[a-z][a-z0-9-]{1,39}$/.test(p.name)) throw new Error('Invalid booking provider name.');
    if (this.providers.has(p.name)) throw new Error(`Booking provider "${p.name}" is already registered.`);
    if (p.kind === 'TEST') {
      if (!this.allowTestProviders) throw new Error('Test booking providers are not allowed in the production registry.');
      if (!p.name.startsWith('test')) throw new Error('Test booking provider names must start with "test".');
    } else if (p.kind === 'DISABLED') {
      let c: any; try { c = p.getCapabilities(); } catch { c = null; }
      if (!c || c.available !== false || c.supportsBooking !== false) throw new Error('A DISABLED provider must not claim availability or booking support.');
    } else if (p.kind !== 'REAL') {
      throw new Error('Unknown booking provider kind.');
    }
    this.providers.set(p.name, p);
  }

  names(): string[] { return [...this.providers.keys()]; }

  resolve(config: BookingProviderConfig): ProviderResolution {
    const masterSwitchOff = !config.enabled || config.configErrors.length > 0;
    const effective = masterSwitchOff ? DISABLED_PROVIDER_NAME : config.provider;
    const p = this.providers.get(effective);
    if (!p) return { ok: false, code: 'BOOKING_PROVIDER_UNKNOWN', configured: config.provider, effective, capabilities: noneCapabilities('none', 'BOOKING_PROVIDER_UNKNOWN') };
    let raw: unknown;
    try { raw = p.getCapabilities(); } catch { raw = null; }
    const v = validateCapabilities(raw, p.name);
    if (!v.ok) return { ok: false, code: 'BOOKING_PROVIDER_UNAVAILABLE', configured: config.provider, effective, capabilities: noneCapabilities(p.name, 'CAPABILITIES_INVALID') };
    return { ok: true, provider: p, capabilities: v.value, configured: config.provider, effective, masterSwitchOff };
  }
}

export function createProductionBookingProviderRegistry(): BookingProviderRegistry {
  return new BookingProviderRegistry({ allowTestProviders: false });
}
