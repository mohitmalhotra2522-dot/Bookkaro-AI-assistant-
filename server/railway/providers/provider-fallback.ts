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
import { parseProviderChain } from './live/live-config';
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

/** The configured primary provider id (RAILWAY_PRIMARY_PROVIDER, default railcore) or null when the chain is invalid. */
export function primaryProviderId(env: Env = process.env): string | null {
  try { return parseProviderChain(env)[0] ?? null; } catch { return null; }
}

/**
 * Fallback connector for (provider, capability): only for the configured PRIMARY, only a registered non-web connector
 * that implements the capability, first in RAILWAY_FALLBACK_PROVIDERS order. null → no fallback.
 */
export function fallbackProviderFor(provider: string | null | undefined, capability: string, env: Env = process.env): string | null {
  if (!provider || !providerFallbackEnabled(env)) return null;
  let chain: string[];
  try { chain = parseProviderChain(env); } catch { return null; }
  if (chain[0] !== provider) return null;
  const primaryInfo = providerToolCatalog.get(provider);
  for (const id of chain.slice(1)) {
    if ((WEB_PROVIDER_IDS as readonly string[]).includes(id)) continue;
    const c = providerToolCatalog.get(id);
    if (!c || !c.capabilities.includes(capability as any)) continue;
    // never MOCK for LIVE (or LIVE for MOCK)
    if (primaryInfo && /^mock-/.test(primaryInfo.registryId) !== /^mock-/.test(c.registryId)) continue;
    return id;
  }
  return null;
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
  const fb = isFallbackEligible(code) ? fallbackProviderFor(o.primary, o.capability, o.env) : null;
  if (!fb || (o.canFallback && !o.canFallback())) return { result: first, served: o.primary, attempts, fallbackUsed: false };
  const t1 = Date.now();
  const second = await o.call(fb);
  const code2 = o.errorCodeOf(second);
  attempts.push({ provider: fb, attempt: 2, status: code2 ? 'FAILED' : 'SUCCESS', errorCode: code2, latencyMs: Date.now() - t1, ...rl(second, code2), fallbackUsed: true, fallbackReason: code!, retryCount: 0 });
  o.log?.('provider_fallback', { ...(o.context || {}), capability: o.capability, primary: o.primary, fallback: fb, fallbackReason: code, primaryStatus: 'FAILED', fallbackStatus: code2 ? 'FAILED' : 'SUCCESS', fallbackErrorCode: code2, latencyMs: Date.now() - t0 });
  return { result: second, served: fb, attempts, fallbackUsed: true, fallbackReason: code! };
}
