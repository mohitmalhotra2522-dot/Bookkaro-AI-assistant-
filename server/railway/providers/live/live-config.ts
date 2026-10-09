/**
 * PROMPT 35 — live railway provider configuration (environment only; keys are never hard-coded, logged or exposed).
 *
 *   RAILWAY_PROVIDER=live                       → FailoverRailwayProvider (code default stays 'mock' — tests are offline)
 *   RAILWAY_PRIMARY_PROVIDER=railcore           (default railcore)
 *   RAILWAY_FALLBACK_PROVIDERS=railkit,railradar (default railkit,railradar; empty string = no fallback)
 *   RAILCORE_API_KEY / RAILKIT_API_KEY / RAILRADAR_API_KEY
 *   RAILWAY_PROVIDER_TIMEOUT_MS (per attempt, default 4000) · RAILWAY_FAILOVER_BUDGET_MS (chain, default runtime timeout − 1000)
 *   RAILCORE_BASE_URL / RAILKIT_BASE_URL / RAILRADAR_BASE_URL (optional overrides; defaults = documented production hosts)
 *
 *   RAILWAY_AVAILABILITY_PROVIDERS=railkit,railcore,railradar (optional, 2026-10-09) → ordered chain for CHECK_AVAILABILITY
 *     and GET_FARE ONLY (search / route / timetable / PNR / tracking keep RAILWAY_PRIMARY_PROVIDER → RAILWAY_FALLBACK_PROVIDERS).
 *     Unset / empty → every capability uses the general chain (pre-2026-10-09 behaviour, unchanged).
 *
 * An unknown provider id is a configuration ERROR (thrown at startup) — never a silent switch to another provider or to MOCK.
 */
import type { FetchLike } from './live-http';
import { LiveRailwayProvider } from './live-provider-base';
import { RailCoreProvider } from './railcore-provider';
import { RailKitProvider } from './railkit-provider';
import { RailRadarProvider } from './railradar-provider';
import { FailoverRailwayProvider } from './failover-provider';
import { METHOD_CAPABILITY, PROVIDER_CAPABILITY_MATRIX, type LiveProviderId, type RailwayCapability } from './provider-capabilities';

type Env = Record<string, string | undefined>;
const IDS: readonly LiveProviderId[] = ['railcore', 'railkit', 'railradar'];
const DEFAULT_BASE: Record<LiveProviderId, string> = {
  railcore: 'https://ir.railcore.tech/v1', railkit: 'https://api.railkit.in', railradar: 'https://api.railradar.in'
};
const KEY_VAR: Record<LiveProviderId, string> = { railcore: 'RAILCORE_API_KEY', railkit: 'RAILKIT_API_KEY', railradar: 'RAILRADAR_API_KEY' };
const BASE_VAR: Record<LiveProviderId, string> = { railcore: 'RAILCORE_BASE_URL', railkit: 'RAILKIT_BASE_URL', railradar: 'RAILRADAR_BASE_URL' };

const posInt = (v: string | undefined, d: number) => (Number(v) > 0 ? Math.floor(Number(v)) : d);

export function liveTimeouts(env: Env = process.env) {
  const runtime = posInt(env.RAILWAY_TOOL_TIMEOUT_MS, 9000);
  const perAttemptMs = posInt(env.RAILWAY_PROVIDER_TIMEOUT_MS, 4000);
  // Chain budget must finish inside BOTH the tool-runtime timeout and the live TRACK/PNR service timeout (8000 ms),
  // so an honest PROVIDER_UNAVAILABLE/TIMEOUT outcome is produced by the chain, not a blunt outer timeout.
  const budgetMs = Math.min(posInt(env.RAILWAY_FAILOVER_BUDGET_MS, runtime - 1500), runtime - 500, 7500);
  return { perAttemptMs, budgetMs: Math.max(budgetMs, 500) };
}

export function parseProviderChain(env: Env = process.env): LiveProviderId[] {
  const primary = String(env.RAILWAY_PRIMARY_PROVIDER || 'railcore').trim().toLowerCase();
  const fb = env.RAILWAY_FALLBACK_PROVIDERS === undefined ? 'railkit,railradar' : env.RAILWAY_FALLBACK_PROVIDERS;
  const list = [primary, ...String(fb).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)];
  const out: LiveProviderId[] = [];
  for (const id of list) {
    if (!(IDS as readonly string[]).includes(id)) throw new Error(`Unknown railway provider "${id}" in RAILWAY_PRIMARY_PROVIDER / RAILWAY_FALLBACK_PROVIDERS (allowed: ${IDS.join(', ')})`);
    if (!out.includes(id as LiveProviderId)) out.push(id as LiveProviderId);
  }
  return out;
}

/** Capabilities routed by RAILWAY_AVAILABILITY_PROVIDERS (2026-10-09). */
export const AVAILABILITY_ROUTED_CAPABILITIES: readonly string[] = Object.freeze(['CHECK_AVAILABILITY', 'GET_FARE']);

/** RAILWAY_AVAILABILITY_PROVIDERS as an ordered id list; null when unset / empty. Unknown id → configuration error. */
export function parseAvailabilityChain(env: Env = process.env): LiveProviderId[] | null {
  const raw = String(env.RAILWAY_AVAILABILITY_PROVIDERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!raw.length) return null;
  const out: LiveProviderId[] = [];
  for (const id of raw) {
    if (!(IDS as readonly string[]).includes(id)) throw new Error(`Unknown railway provider "${id}" in RAILWAY_AVAILABILITY_PROVIDERS (allowed: ${IDS.join(', ')})`);
    if (!out.includes(id as LiveProviderId)) out.push(id as LiveProviderId);
  }
  return out;
}

/**
 * 2026-10-10 (approved, blocker 5): SAME_TRAIN_ROUTE_PROVIDERS — ordered route-discovery chain for the SAME-TRAIN flow
 * only (e.g. railcore,railkit,railradar: RailCore primary, RailKit's documented train-info route, then RailRadar). null when
 * unset / empty → same-train route resolution unchanged. Unknown id → configuration error. Never affects chat tools.
 */
export function parseSameTrainRouteChain(env: Env = process.env): LiveProviderId[] | null {
  const raw = String(env.SAME_TRAIN_ROUTE_PROVIDERS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!raw.length) return null;
  const out: LiveProviderId[] = [];
  for (const id of raw) {
    if (!(IDS as readonly string[]).includes(id)) throw new Error(`Unknown railway provider "${id}" in SAME_TRAIN_ROUTE_PROVIDERS (allowed: ${IDS.join(', ')})`);
    if (!out.includes(id as LiveProviderId)) out.push(id as LiveProviderId);
  }
  return out;
}

/**
 * Ordered provider chain for ONE capability. CHECK_AVAILABILITY / GET_FARE use RAILWAY_AVAILABILITY_PROVIDERS when set
 * (followed by any general-chain provider it does not list, so no configured fallback is lost); every other capability —
 * and availability when the variable is unset — uses the general chain.
 */
export function providerChainFor(capability: string | null | undefined, env: Env = process.env): LiveProviderId[] {
  const base = parseProviderChain(env);
  if (!capability || !AVAILABILITY_ROUTED_CAPABILITIES.includes(String(capability))) return base;
  const av = parseAvailabilityChain(env);
  if (!av) return base;
  return [...av, ...base.filter(id => !av.includes(id))];
}

/** Every provider id used by ANY capability chain (general chain order first). */
export function allChainProviderIds(env: Env = process.env): LiveProviderId[] {
  const base = parseProviderChain(env);
  const av = parseAvailabilityChain(env) || [];
  return [...base, ...av.filter(id => !base.includes(id))];
}

/** True when `id` serves `capability` under the current routing (in that capability's chain). */
export function providerRoutedFor(id: string, capability: string, env: Env = process.env): boolean {
  try { return (providerChainFor(capability, env) as string[]).includes(id); } catch { return false; }
}

export function createLiveProvider(id: LiveProviderId, env: Env = process.env, fetchImpl?: FetchLike): LiveRailwayProvider {
  const cfg = { apiKey: env[KEY_VAR[id]] || undefined, baseUrl: env[BASE_VAR[id]] || DEFAULT_BASE[id], timeoutMs: liveTimeouts(env).perAttemptMs, fetchImpl };
  switch (id) {
    case 'railcore': return new RailCoreProvider(cfg);
    case 'railkit': return new RailKitProvider(cfg);
    case 'railradar': return new RailRadarProvider(cfg);
  }
}

export function createFailoverProvider(env: Env = process.env, fetchImpl?: FetchLike): FailoverRailwayProvider {
  parseSameTrainRouteChain(env);   // 2026-10-10: unknown id in SAME_TRAIN_ROUTE_PROVIDERS fails at startup like the other chains
  const providers = allChainProviderIds(env).map(id => createLiveProvider(id, env, fetchImpl));
  const av = parseAvailabilityChain(env);
  // every capability gets its own order, so a provider added only for availability / fare is never asked for anything else
  const capabilityOrder = av ? Object.fromEntries(Object.values(METHOD_CAPABILITY).map(c => [c, providerChainFor(c, env) as string[]])) : undefined;
  return new FailoverRailwayProvider(providers, { ...liveTimeouts(env), ...(capabilityOrder ? { capabilityOrder } : {}) });
}

/** Safe status for /api/health and docs: configured yes/no + declared capabilities. NEVER the key or any part of it. */
export function liveProviderStatus(env: Env = process.env): Array<{ provider: string; priority: number | null; availabilityPriority?: number | null; configured: boolean; capabilities: RailwayCapability[] }> {
  let chain: LiveProviderId[] = [];
  try { chain = parseProviderChain(env); } catch { chain = []; }
  let av: LiveProviderId[] | null = null;
  try { av = parseAvailabilityChain(env) ? providerChainFor('CHECK_AVAILABILITY', env) : null; } catch { av = null; }
  return IDS.map(id => ({
    provider: id.toUpperCase(), priority: chain.includes(id) ? chain.indexOf(id) + 1 : null,
    ...(av ? { availabilityPriority: av.includes(id) ? av.indexOf(id) + 1 : null } : {}),
    configured: !!(env[KEY_VAR[id]] && String(env[KEY_VAR[id]]).trim()),
    capabilities: Object.keys(PROVIDER_CAPABILITY_MATRIX[id]) as RailwayCapability[]
  }));
}
