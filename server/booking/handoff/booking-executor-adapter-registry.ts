/**
 * BookingExecutorAdapterRegistry — resolves the CONFIGURED adapter, fail-closed.
 *
 *  - Production registry contains ONLY DisabledBookingExecutorAdapter.
 *  - Adapters reporting enabled / supportsRealBooking, or kind REAL, cannot be
 *    registered in this milestone. TEST adapters only with { allowTestAdapters: true }.
 *  - resolve(): flag off / config errors → disabled adapter; configured name not
 *    registered → EXECUTOR_NOT_FOUND (never a silent / random fallback); capability
 *    missing, malformed or throwing → EXECUTOR_UNAVAILABLE.
 */
import type { BookingExecutorCapability } from '@shared/booking-handoff-session';
import type { BookingExecutorAdapter } from './booking-executor-adapter';
import { DisabledBookingExecutorAdapter, DISABLED_ADAPTER_NAME } from './disabled-booking-executor-adapter';
import type { ExecutionConfig } from '../execution/execution-config';

export type AdapterResolution =
  | { ok: true; adapter: BookingExecutorAdapter; capability: Readonly<BookingExecutorCapability> }
  | { ok: false; code: 'EXECUTOR_NOT_FOUND' | 'EXECUTOR_UNAVAILABLE'; capability: Readonly<BookingExecutorCapability> };

const NONE = (reason: string): BookingExecutorCapability => Object.freeze({ enabled: false, executorName: 'none', supportsRealBooking: false, reason });

export function isValidCapability(c: any): c is BookingExecutorCapability {
  return !!c && typeof c === 'object' && typeof c.enabled === 'boolean' && typeof c.supportsRealBooking === 'boolean' && typeof c.executorName === 'string' && !!c.executorName;
}

export class BookingExecutorAdapterRegistry {
  private readonly adapters = new Map<string, BookingExecutorAdapter>();
  readonly allowTestAdapters: boolean;

  constructor(opts: { allowTestAdapters?: boolean; includeDisabled?: boolean } = {}) {
    this.allowTestAdapters = !!opts.allowTestAdapters;
    if (opts.includeDisabled !== false) this.adapters.set(DISABLED_ADAPTER_NAME, new DisabledBookingExecutorAdapter());
  }

  register(adapter: BookingExecutorAdapter): void {
    if (adapter.kind === 'REAL') throw new Error('REAL booking executor adapters cannot be registered: real booking is not implemented in this milestone.');
    if (adapter.kind === 'TEST') {
      if (!this.allowTestAdapters) throw new Error('Test executor adapters are not allowed in the production registry.');
      if (!/^test/i.test(adapter.name)) throw new Error('Test executor adapter names must start with "test".');
    } else {
      let cap: any; try { cap = adapter.capability(); } catch { cap = null; }
      if (!isValidCapability(cap) || cap.enabled || cap.supportsRealBooking) throw new Error('Only disabled, non-real executor adapters may be registered in this milestone.');
    }
    this.adapters.set(adapter.name, adapter);
  }

  names(): string[] { return [...this.adapters.keys()]; }

  resolve(config: ExecutionConfig): AdapterResolution {
    const name = !config.realBookingEnabled || config.configErrors.length ? DISABLED_ADAPTER_NAME : config.executorName;
    const adapter = this.adapters.get(name);
    if (!adapter) return { ok: false, code: 'EXECUTOR_NOT_FOUND', capability: NONE('EXECUTOR_NOT_FOUND') };
    let cap: any;
    try { cap = adapter.capability(); } catch { cap = null; }
    if (!isValidCapability(cap)) return { ok: false, code: 'EXECUTOR_UNAVAILABLE', capability: NONE('EXECUTOR_UNAVAILABLE') };
    const reason = cap.reason || (cap.enabled ? 'EXECUTOR_ENABLED' : 'EXECUTOR_DISABLED');
    return { ok: true, adapter, capability: Object.freeze({ enabled: cap.enabled === true, executorName: String(cap.executorName), supportsRealBooking: cap.supportsRealBooking === true, reason }) };
  }
}

export function createProductionAdapterRegistry(): BookingExecutorAdapterRegistry {
  return new BookingExecutorAdapterRegistry({ allowTestAdapters: false });
}
