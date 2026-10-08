/**
 * RailRadar Phase 1 — adapter error classification by BODY meaning onto the existing RailwayErrorCode taxonomy.
 * RailRadar answers "train not found" AND "invalid journey class" with HTTP 404 (observed live, docs say 400 for the
 * latter); before Phase 1 both became PROVIDER_UNAVAILABLE. Real outages / rate limits / timeouts keep their meaning.
 * Test data only — fetch is stubbed, no network, no key.
 */
import { describe, it, expect } from 'vitest';
import { RailRadarProvider, classifyRailRadarError } from '../../server/railway/providers/live/railradar-provider';
import { runSameTrainSearch, type SameTrainDeps, type ProviderRef } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS } from '../../shared/same-train-alternatives';

type Reply = { status: number; body?: any; raw?: string } | 'network' | 'hang';
function provider(reply: Reply, timeoutMs = 2000) {
  const urls: string[] = [];
  const fetchImpl: any = (url: string, init: { signal: AbortSignal }) => {
    urls.push(url);
    if (reply === 'network') return Promise.reject(new Error('ECONNRESET'));
    if (reply === 'hang') return new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    return Promise.resolve({ status: reply.status, text: async () => reply.raw ?? JSON.stringify(reply.body ?? {}) });
  };
  return { p: new RailRadarProvider({ apiKey: 'test-key', baseUrl: 'https://rr.test', timeoutMs, fetchImpl }), urls };
}
/** observed RailRadar bodies (test data) */
const TRAIN_NOT_FOUND = { success: false, error: { code: 'TRAIN_NOT_FOUND', message: 'Train 99999 not found' } };
const INVALID_CLASS = { success: false, error: { code: 'API:DATA_NOT_AVAILABLE', message: 'Invalid Journey Class for this Route.' } };
const AVQ = { trainNumber: '12498', travelClass: 'ZZ', date: '2026-10-09', origin: 'ASR', destination: 'NDLS' } as any;

describe('RailRadar Phase 1 — error mapping', () => {
  it('[I] 404 TRAIN_NOT_FOUND → NOT_FOUND (timetable, availability and fare) — never PROVIDER_UNAVAILABLE / CLASS_NOT_AVAILABLE', async () => {
    const tt = await provider({ status: 404, body: TRAIN_NOT_FOUND }).p.getTimetable({ trainNumber: '99999' } as any);
    expect(tt).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const av = await provider({ status: 404, body: TRAIN_NOT_FOUND }).p.checkAvailability({ ...AVQ, trainNumber: '99999', travelClass: '3A' });
    expect(av).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const fare = await provider({ status: 404, body: TRAIN_NOT_FOUND }).p.getFare({ ...AVQ, trainNumber: '99999', travelClass: '3A' });
    expect(fare).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(classifyRailRadarError(404, { error: { code: 'NOT_FOUND', message: 'Train 99999 not found.' } })).toBe('NOT_FOUND');
  });
  it('[J] 404 "Invalid Journey Class" → CLASS_NOT_AVAILABLE by body meaning (status code alone never decides)', async () => {
    const av = await provider({ status: 404, body: INVALID_CLASS }).p.checkAvailability(AVQ);
    expect(av).toMatchObject({ ok: false, error: { code: 'CLASS_NOT_AVAILABLE' } });
    expect(classifyRailRadarError(400, INVALID_CLASS)).toBe('CLASS_NOT_AVAILABLE');
    expect(classifyRailRadarError(422, { error: { code: 'X', message: 'invalid class code' } })).toBe('CLASS_NOT_AVAILABLE');
    // a 404 whose body means neither → the shared status mapping (unchanged)
    expect(classifyRailRadarError(404, { error: { code: 'NOT_FOUND', message: 'Route not found' } })).toBeNull();
    const route404 = await provider({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Route not found' } } }).p.getTimetable({ trainNumber: '12498' } as any);
    expect(route404).toMatchObject({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } });
    // other 400 validation problems keep INVALID_REQUEST
    expect(await provider({ status: 400, body: { error: { code: 'VALIDATION', message: 'journeyDate must be YYYY-MM-DD' } } }).p.checkAvailability({ ...AVQ, travelClass: '3A' }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });
  it('[K] real outage → PROVIDER_UNAVAILABLE (5xx / 503 PRS maintenance / network error) — even if the body mentions a train', async () => {
    for (const status of [500, 502, 503]) {
      const r = await provider({ status, body: { error: { code: 'PRS_MAINTENANCE', message: 'Train not found due to maintenance' } } }).p.getTimetable({ trainNumber: '12498' } as any);
      expect(r).toMatchObject({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } });
    }
    expect(classifyRailRadarError(503, TRAIN_NOT_FOUND)).toBeNull();
    expect(await provider('network').p.getTimetable({ trainNumber: '12498' } as any)).toMatchObject({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } });
    expect(await provider({ status: 502, raw: '<html>bad gateway</html>' }).p.getTimetable({ trainNumber: '12498' } as any)).toMatchObject({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } });
  });
  it('[L] 429 → RATE_LIMITED (never NOT_FOUND / CLASS_NOT_AVAILABLE)', async () => {
    const r = await provider({ status: 429, body: { error: { code: 'RATE_LIMIT', message: 'Invalid class? no: too many requests' } } }).p.checkAvailability({ ...AVQ, travelClass: '3A' });
    expect(r).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect(classifyRailRadarError(429, INVALID_CLASS)).toBeNull();
  });
  it('[M] timeout → TIMEOUT (client abort, 408, 504)', async () => {
    expect(await provider('hang', 30).p.getTimetable({ trainNumber: '12498' } as any)).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
    for (const status of [408, 504]) expect(await provider({ status }).p.getTimetable({ trainNumber: '12498' } as any)).toMatchObject({ ok: false, error: { code: 'TIMEOUT' } });
  });
  it('[I2] a RailRadar NOT_FOUND during the route cross-check is never turned into a route / train-existence claim', async () => {
    const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
    const RR: ProviderRef = { id: 'railradar', label: 'RailRadar', level: 'PROVIDER_API' };
    const d: SameTrainDeps = {
      limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 150, totalTimeoutMs: 2000 },
      getRoute: async p => p.id === 'railcore' ? { ok: true, data: ['DDL', 'UMB', 'PNP', 'NDLS'].map(station => ({ station })) } : { ok: false, error: { code: 'NOT_FOUND' } },
      checkAvailability: async () => { throw new Error('no availability call during a failed cross-check'); },
      getFare: async () => { throw new Error('no fare call during a failed cross-check'); }
    };
    const r: any = await runSameTrainSearch({ sessionId: 's', turnId: 't', requestId: 'r', journeyVersion: 1, trainNumber: '12498', date: '2026-10-09', travelClass: 'CC',
      passengersCount: 1, origin: 'ASR', destination: 'NDLS', originSweep: true, destinationSweep: true, combinedPairs: 'AUTO', includeFare: true, webEvidence: false,
      providers: [RC], routeProvider: RC, routeFallback: RR, fallbackProviders: { railcore: RR }, webProviders: [] } as any, d);
    expect(r).toMatchObject({ ok: false, code: 'INVALID_STATION_PAIR', errorClass: 'ROUTE_DATA_UNVERIFIED', routeCheck: { verdict: 'ROUTE_UNVERIFIED', crossCheckResult: 'NOT_FOUND' } });
    expect(r.code).not.toBe('INVALID_TRAIN_ROUTE');
  });
});
