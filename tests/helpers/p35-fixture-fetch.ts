/**
 * Prompt 35 — MOCK-CONTROLLED provider transport for offline tests (never a real network call, never labelled LIVE in
 * reports). Replays the REAL trimmed provider samples captured by scripts/p35-live-providers.ts
 * (tests/fixtures/p35/*.json) through the real adapters, and injects faults per provider to exercise failover.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FetchLike } from '../../server/railway/providers/live/live-http';

export type Fault = 'ok' | 'timeout' | 'http500' | 'http429' | 'malformed' | 'notFound' | 'badRequest' | 'emptySearch' | 'network';
const FIX = path.resolve(__dirname, '../fixtures/p35');
const CAPTURED_DATE = '2026-10-05';
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8')).body;

function routeOf(u: URL): { provider: 'railcore' | 'railradar' | 'railkit' | null; fx: string | null } {
  const p = u.pathname;
  if (u.hostname.includes('railcore')) {
    if (p.endsWith('/routes/trains')) return { provider: 'railcore', fx: 'railcore-search' };
    if (p.endsWith('/availability/seats')) return { provider: 'railcore', fx: 'railcore-availability' };
    if (p.endsWith('/fares/estimate')) return { provider: 'railcore', fx: 'railcore-fare' };
    if (/\/trains\/\d+\/schedule$/.test(p)) return { provider: 'railcore', fx: 'railcore-timetable' };
    if (/\/trains\/\d+\/live$/.test(p)) return { provider: 'railcore', fx: 'railcore-track' };
    return { provider: 'railcore', fx: null };
  }
  if (u.hostname.includes('railradar')) {
    if (p.includes('/trains/between/')) return { provider: 'railradar', fx: 'railradar-search' };
    if (/\/trains\/\d+\/seats$/.test(p)) return { provider: 'railradar', fx: 'railradar-availability' };
    if (/\/trains\/\d+\/fare$/.test(p)) return { provider: 'railradar', fx: 'railradar-fare' };
    if (/\/trains\/\d+\/live$/.test(p)) return { provider: 'railradar', fx: 'railradar-track' };
    if (/\/trains\/\d+$/.test(p)) return { provider: 'railradar', fx: 'railradar-info' };
    return { provider: 'railradar', fx: null };
  }
  if (u.hostname.includes('railkit')) return { provider: 'railkit', fx: null };
  return { provider: null, fx: null };
}

export interface FixtureTransport {
  fetch: FetchLike;
  fault: Partial<Record<'railcore' | 'railradar' | 'railkit', Fault>>;
  calls: Array<{ provider: string; path: string; query: string; headers: Record<string, string> }>;
  /** Mutate a parsed fixture body before it is served (e.g. AVAILABLE seats for a booking flow). */
  patch: Partial<Record<string, (body: any) => any>>;
  reset(): void;
}

export function fixtureTransport(): FixtureTransport {
  const t: FixtureTransport = {
    fault: {}, calls: [], patch: {},
    reset() { t.fault = {}; t.calls = []; t.patch = {}; },
    fetch: async (url, init) => {
      const u = new URL(url);
      const { provider, fx } = routeOf(u);
      t.calls.push({ provider: provider || u.hostname, path: u.pathname, query: u.search, headers: { ...init.headers } });
      const f: Fault = (provider && t.fault[provider]) || 'ok';
      const reply = (status: number, body: unknown) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
      if (f === 'timeout') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      if (f === 'network') throw new TypeError('fetch failed');
      if (f === 'http500') return reply(502, { success: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'upstream', retryable: true } });
      if (f === 'http429') return reply(429, { success: false, error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true } });
      if (f === 'malformed') return reply(200, '<html>not json</html>');
      if (f === 'notFound') return reply(404, { success: false, error: { code: provider === 'railcore' ? 'NO_TRAINS_FOUND' : 'NOT_FOUND', message: 'none' } });
      if (f === 'badRequest') return reply(400, { success: false, error: { code: 'VALIDATION_ERROR', message: 'bad input', retryable: false } });
      if (!fx) return reply(404, { success: false, error: { code: 'NOT_FOUND', message: 'no fixture' } });
      // re-date the captured sample to the requested journey date (tests must not go stale with the calendar)
      const want = u.searchParams.get('date') || u.searchParams.get('journeyDate');
      let text = JSON.stringify(fixture(fx));
      if (want && /^\d{4}-\d{2}-\d{2}$/.test(want)) text = text.split(CAPTURED_DATE).join(want);
      let body = JSON.parse(text);
      if (f === 'emptySearch') body = provider === 'railcore' ? { ...body, data: { ...body.data, trains: [] } } : { ...body, data: { ...body.data, trains: [], count: 0 } };
      const p = t.patch[fx]; if (p) body = p(body);
      return reply(200, body);
    }
  };
  return t;
}

/** Env for a controlled live chain (fake keys — never real). */
export const P35_TEST_ENV = (over: Record<string, string | undefined> = {}) => ({
  RAILCORE_API_KEY: 'rc-TEST-SECRET-35a', RAILRADAR_API_KEY: 'rr-TEST-SECRET-35b', RAILKIT_API_KEY: undefined,
  RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railkit,railradar',
  RAILWAY_PROVIDER_TIMEOUT_MS: '300', RAILWAY_FAILOVER_BUDGET_MS: '1500', ...over
}) as NodeJS.ProcessEnv;
