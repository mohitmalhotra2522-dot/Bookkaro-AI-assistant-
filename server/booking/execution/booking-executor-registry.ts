/**
 * BookingExecutorRegistry — resolves the executor the gateway may use.
 *
 * Production registry: contains ONLY DisabledBookingExecutor.
 *  - REAL executors cannot be registered in this milestone (throws).
 *  - TEST executors only in registries created with { allowTestExecutors: true }
 *    (tests). Their names must start with "test".
 *
 * resolve(config) is FAIL-CLOSED:
 *  - flag false / missing / malformed           → disabled (REAL_BOOKING_DISABLED)
 *  - flag true + config errors                    → disabled (BOOKING_EXECUTION_DISABLED)
 *  - flag true + unknown executor                 → no executor (UNKNOWN_BOOKING_EXECUTOR)
 *  - flag true + executor unavailable / throws    → no executor (BOOKING_EXECUTOR_UNAVAILABLE)
 */
import type { ExecutionCapability } from '@shared/booking-execution';
import type { BookingExecutor } from './booking-executor';
import { DisabledBookingExecutor, DISABLED_EXECUTOR_NAME } from './disabled-booking-executor';
import type { ExecutionConfig } from './execution-config';

export interface ExecutorResolution {
  /** Executor to invoke, or null (execution disabled — nothing is invoked). */
  executor: BookingExecutor | null;
  capability: ExecutionCapability;
}

export class BookingExecutorRegistry {
  private readonly executors = new Map<string, BookingExecutor>();
  readonly allowTestExecutors: boolean;

  constructor(opts: { allowTestExecutors?: boolean } = {}) {
    this.allowTestExecutors = !!opts.allowTestExecutors;
    this.executors.set(DISABLED_EXECUTOR_NAME, new DisabledBookingExecutor());
  }

  register(executor: BookingExecutor): void {
    if (executor.kind === 'REAL') throw new Error('REAL booking executors cannot be registered: real booking execution is not implemented in this milestone.');
    if (executor.kind === 'TEST') {
      if (!this.allowTestExecutors) throw new Error('Test booking executors are not allowed in the production registry.');
      if (!/^test/i.test(executor.name)) throw new Error('Test booking executor names must start with "test".');
    }
    if (executor.kind === 'DISABLED' && executor.name !== DISABLED_EXECUTOR_NAME) throw new Error('Only the built-in disabled executor may use kind DISABLED.');
    this.executors.set(executor.name, executor);
  }

  get(name: string): BookingExecutor | undefined { return this.executors.get(name); }
  names(): string[] { return [...this.executors.keys()]; }
  disabled(): BookingExecutor { return this.executors.get(DISABLED_EXECUTOR_NAME)!; }

  resolve(config: ExecutionConfig): ExecutorResolution {
    const base = { realBookingEnabled: config.realBookingEnabled, configuredExecutor: config.executorName, executionPossible: false as const, configErrors: [...config.configErrors] };
    const disabled = (reason: string): ExecutorResolution => ({ executor: this.disabled(), capability: { ...base, effectiveExecutor: DISABLED_EXECUTOR_NAME, reason } });
    const none = (reason: string): ExecutorResolution => ({ executor: null, capability: { ...base, effectiveExecutor: 'none', reason } });

    if (!config.realBookingEnabled) return disabled('REAL_BOOKING_DISABLED');
    if (config.configErrors.length) return disabled('BOOKING_EXECUTION_DISABLED');
    if (config.executorName === DISABLED_EXECUTOR_NAME) return disabled('REAL_BOOKING_DISABLED');
    const ex = this.executors.get(config.executorName);
    if (!ex) return none('UNKNOWN_BOOKING_EXECUTOR');
    let available = false;
    try { available = ex.isAvailable() === true; } catch { available = false; }
    if (!available) return none('BOOKING_EXECUTOR_UNAVAILABLE');
    return { executor: ex, capability: { ...base, effectiveExecutor: ex.name, reason: ex.kind === 'TEST' ? 'TEST_EXECUTOR_NON_PRODUCTION' : 'EXECUTOR_RESOLVED' } };
  }
}

/** The only registry wired into the running application. */
export function createProductionExecutorRegistry(): BookingExecutorRegistry {
  return new BookingExecutorRegistry({ allowTestExecutors: false });
}
