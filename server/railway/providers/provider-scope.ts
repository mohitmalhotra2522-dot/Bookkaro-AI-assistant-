/**
 * P37 — Provider scope for ONE tool execution.
 *
 * The LLM chose a provider-level tool (e.g. `railcore_search`). The gateway executes the validated call inside a scope
 * naming exactly that provider connector, so every railway lookup made while serving the call
 * (`railwayRegistry.getActive()`) hits THAT connector only — no failover chain, no hidden provider switch.
 * AsyncLocalStorage keeps parallel calls (`railcore_search` + `railradar_search`) isolated from each other.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<{ registryId: string }>();

/** Run `fn` with every railway-provider lookup bound to the registry entry `registryId`. */
export function runWithProvider<T>(registryId: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ registryId }, fn);
}

/** Registry id of the provider connector bound to the current execution (null = no provider scope). */
export function scopedProviderId(): string | null {
  return scope.getStore()?.registryId ?? null;
}
