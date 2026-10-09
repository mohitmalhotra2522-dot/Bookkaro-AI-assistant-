/**
 * PROMPT 42.9 — backend-controlled provider fallback (RailCore primary → RailRadar fallback).
 *
 * Muse chooses the TOOL (and may name a provider tool); it never chooses a fallback provider and never sees keys. When
 * the configured PRIMARY provider fails with an ELIGIBLE failure, the backend executes the SAME request (same tool,
 * same canonical arguments) once on the configured fallback provider and records it visibly:
 *
 *   eligible   : RATE_LIMITED · PROVIDER_UNAVAILABLE · TIMEOUT (TOOL_TIMEOUT / PROVIDER_TIMEOUT) — transient provider faults
 *   NOT eligible: any INVALID_* / validation / user-input error, NOT_FOUND / NO_TRAINS_FOUND (a valid railway answer is
 *                never "confirmed" elsewhere), AUTH_ERROR, NOT_CONFIGURED, PROVIDER_DATA_INVALID, a success
 *
 * RailRadar is never called when RailCore succeeded. Answers are never merged: the response is the fallback provider's
 * own fresh answer with provider / fetchedAt / fallbackUsed / fallbackReason metadata. No cache, no replay.
 *
 * Policy: RAILWAY_PROVIDER_FALLBACK=on|off (default: on for RAILWAY_PROVIDER=live, off for mock/dev connectors, so a
 * mock connector suite keeps its own explicit contract). The chain order is RAILWAY_PRIMARY_PROVIDER →
 * RAILWAY_FALLBACK_PROVIDERS; only a registered (configured) API connector with the capability is eligible — never a
 * web connector, never MOCK for LIVE.
 */
import { providerToolCatalog } from '../../ai/tools/provider-tools';
import { AVAILABILITY_ROUTED_CAPABILITIES, parseAvailabilityChain, providerChainFor } from './live/live-config';
import { WEB_PROVIDER_IDS } from './web/web-providers';

type Env = Record<string, string | undefined>;

export const FALLBACK_ELIGIBLE_CODES: ReadonlySet<string> = new Set(['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'TIMEOUT', 'TOOL_TIMEOUT', 'PROVIDER_TIMEOUT']);
export const isFallbackEligible = (code: string | null | undefined): boolean => !!code && FALLBACK_ELIGIBLE_CODES.has(String(code));

export function providerFallbackEnabled(env: Env = process.env): boolean {
  const v = String(env.RAILWAY_PROVIDER_FALLBACK || '').trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return String(env.RAILWAY_PROVIDER || '').trim().toLowerCase() === 'live';
}

/**
 * The configured primary provider id or null when the chain is invalid. Without a capability: the general chain
 * (RAILWAY_PRIMARY_PROVIDER, default railcore). 2026-10-09: with CHECK_AVAILABILITY / GET_FARE the availability chain
 * (RAILWAY_AVAILABILITY_PROVIDERS) when configured.
 */
export function primaryProviderId(env: Env = process.env, capability?: string): string | null {
  try { return providerChainFor(capability, env)[0] ?? null; } catch { return null; }
}

/**
 * Ordered fallback connectors for (provider, capability): for that capability's configured PRIMARY (and, for availability /
 * fare with RAILWAY_AVAILABILITY_PROVIDERS set, for an LLM-named provider further down that chain — the rest of it), only registered
 * non-web connectors that implement the capability, in chain order (2026-10-09: the whole chain, so RailKit → RailCore →
 * RailRadar keeps the RailCore → RailRadar step). [] → no fallback.
 */
export function fallbackChainFor(provider: string | null | undefined, capability: string, env: Env = process.env): string[] {
  if (!provider || !providerFallbackEnabled(env)) return [];
  let chain: string[];
  try { chain = providerChainFor(capability, env); } catch { return []; }
  let start = chain.indexOf(provider as any);
  if (start !== 0) {
    // 2026-10-09 (approved routing): with RAILWAY_AVAILABILITY_PROVIDERS set, an LLM-named NON-primary availability / fare
    // provider keeps the REST of that chain after it (RailKit preferred → an LLM-picked RailCore still falls back to
    // RailRadar; never back up the chain). Everything else (general chain, or the variable unset) is unchanged: [].
    let routed = false;
    try { routed = AVAILABILITY_ROUTED_CAPABILITIES.includes(capability) && !!parseAvailabilityChain(env); } catch { routed = false; }
    if (start < 0 || !routed) return [];
  }
  const primaryInfo = providerToolCatalog.get(provider);
  const out: string[] = [];
  for (const id of chain.slice(start + 1)) {
    if ((WEB_PROVIDER_IDS as readonly string[]).includes(id)) continue;
    const c = providerToolCatalog.get(id);
    if (!c || !c.capabilities.includes(capability as any)) continue;
    // never MOCK for LIVE (or LIVE for MOCK)
    if (primaryInfo && /^mock-/.test(primaryInfo.registryId) !== /^mock-/.test(c.registryId)) continue;
    out.push(id);
  }
  return out;
}

/** First fallback connector for (provider, capability) — see fallbackChainFor. null → no fallback. */
export function fallbackProviderFor(provider: string | null | undefined, capability: string, env: Env = process.env): string | null {
  return fallbackChainFor(provider, capability, env)[0] ?? null;
}

export interface FallbackAttempt {
  provider: string; attempt: number; status: string; errorCode: string | null; latencyMs: number;
  rateLimited: boolean; rateLimitLocal?: boolean; fallbackUsed: boolean; fallbackReason?: string; retryCount: number;
}
export interface FallbackOutcome<T> { result: T; served: string; attempts: FallbackAttempt[]; fallbackUsed: boolean; fallbackReason?: string }

/**
 * Run `call(primary)`; on an ELIGIBLE failure run `call(fallback)` once (sequential — a late primary answer can never
 * overwrite the fallback answer, the primary has already completed). `canFallback()` lets the caller veto when its own
 * budget / turn is gone.
 */
export async function runWithProviderFallback<T>(o: {
  primary: string; capability: string; call: (provider: string) => Promise<T>;
  errorCodeOf: (r: T) => string | null; rateLimitLocalOf?: (r: T) => boolean | undefined; canFallback?: () => boolean; env?: Env;
  log?: (event: string, fields: Record<string, unknown>) => void; context?: Record<string, unknown>;
}): Promise<FallbackOutcome<T>> {
  const attempts: FallbackAttempt[] = [];
  const t0 = Date.now();
  const first = await o.call(o.primary);
  const code = o.errorCodeOf(first);
  const rl = (r: T, c: string | null) => (c === 'RATE_LIMITED' ? { rateLimited: true, ...(o.rateLimitLocalOf?.(r) !== undefined ? { rateLimitLocal: !!o.rateLimitLocalOf!(r) } : {}) } : { rateLimited: false });
  attempts.push({ provider: o.primary, attempt: 1, status: code ? 'FAILED' : 'SUCCESS', errorCode: code, latencyMs: Date.now() - t0, ...rl(first, code), fallbackUsed: false, retryCount: 0 });
  const fbs = isFallbackEligible(code) ? fallbackChainFor(o.primary, o.capability, o.env) : [];
  if (!fbs.length || (o.canFallback && !o.canFallback())) return { result: first, served: o.primary, attempts, fallbackUsed: false };
  // sequential down the chain: each next provider only after the previous one FAILED with an ELIGIBLE fault
  let result = first; let served = o.primary; let lastCode = code;
  for (const fb of fbs) {
    if (served !== o.primary && (!isFallbackEligible(lastCode) || (o.canFallback && !o.canFallback()))) break;
    const t1 = Date.now();
    const next = await o.call(fb);
    const c2 = o.errorCodeOf(next);
    attempts.push({ provider: fb, attempt: attempts.length + 1, status: c2 ? 'FAILED' : 'SUCCESS', errorCode: c2, latencyMs: Date.now() - t1, ...rl(next, c2), fallbackUsed: true, fallbackReason: code!, retryCount: 0 });
    o.log?.('provider_fallback', { ...(o.context || {}), capability: o.capability, primary: o.primary, fallback: fb, fallbackReason: code, ...(served !== o.primary ? { previousFallback: served, previousErrorCode: lastCode } : {}), primaryStatus: 'FAILED', fallbackStatus: c2 ? 'FAILED' : 'SUCCESS', fallbackErrorCode: c2, latencyMs: Date.now() - t0 });
    result = next; served = fb; lastCode = c2;
    if (!c2) break;
  }
  return { result, served, attempts, fallbackUsed: true, fallbackReason: code! };
}
