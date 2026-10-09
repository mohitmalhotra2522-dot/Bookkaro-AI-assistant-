/**
 * 2026-10-09 (approved) — LOCAL monthly request accounting for RailKit (10,000 / calendar month, NOT authoritative).
 * Offline only (injected fetch, dummy key, temp state file) — no network, no credits.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MonthlyRequestQuota, istMonth, nextIstMonthStart, railKitMonthlyQuota, resetRailKitMonthlyQuota } from '../../server/railway/providers/live/monthly-quota';
import { RailKitProvider } from '../../server/railway/providers/live/railkit-provider';
import { createFailoverProvider } from '../../server/railway/providers/live/live-config';
import { resetRateLimiters } from '../../server/railway/providers/live/provider-rate-limiter';

const KEY = 'rk_dummy_quota_key';
const REQ = { trainNumber: '12425', travelClass: '3A', date: '2026-10-20', origin: 'LDH', destination: 'JAT', quota: 'GN' } as any;
const quota = (limit: number, safetyMargin = 0, extra: Partial<ConstructorParameters<typeof MonthlyRequestQuota>[0]> = {}) => {
  const q = new MonthlyRequestQuota({ limit, safetyMargin, ...extra }); resetRailKitMonthlyQuota(q); return q;
};
const rk = (fetchImpl: any) => new RailKitProvider({ apiKey: KEY, baseUrl: 'https://api.railkit.in', timeoutMs: 2000, fetchImpl });

afterEach(() => { resetRailKitMonthlyQuota(); resetRateLimiters(); });

describe('RK-Q1 counting', () => {
  it('each dispatched HTTP request is counted exactly once — success or provider error alike', async () => {
    const q = quota(100);
    let n = 0;
    const p = rk(async () => { n++; return { status: n === 2 ? 503 : 404, text: async () => '{"success":false}' }; });
    for (let i = 0; i < 3; i++) await p.checkAvailability(REQ);
    expect(n).toBe(3);
    expect(q.snapshot()).toMatchObject({ used: 3, inFlight: 0, remaining: 97 });
  });

  it('commit is idempotent; release after commit is a no-op; release before dispatch returns the slot', () => {
    const q = quota(2);
    const a = q.reserve(); const b = q.reserve();
    expect(q.reserve().ok).toBe(false);                      // 2 reserved (in flight) = limit
    q.commit(a); q.commit(a); q.release(a);
    q.release(b);                                            // never dispatched
    expect(q.snapshot()).toMatchObject({ used: 1, inFlight: 0, remaining: 1 });
    expect(q.reserve().ok).toBe(true);
  });
});

describe('RK-Q2 concurrency + limit → no request, safe failover', () => {
  it('20 concurrent calls with 5 left → exactly 5 HTTP requests; the other 15 are local RATE_LIMITED (reason LOCAL_MONTHLY_QUOTA)', async () => {
    const q = quota(5);
    let n = 0;
    const p = rk(async () => { n++; await new Promise(r => setTimeout(r, 15)); return { status: 503, text: async () => '{}' }; });
    const out: any[] = await Promise.all(Array.from({ length: 20 }, () => p.checkAvailability(REQ)));
    expect(n).toBe(5);
    const local = out.filter(r => r.meta?.rateLimit?.reason === 'LOCAL_MONTHLY_QUOTA');
    expect(local).toHaveLength(15);
    expect(local.every(r => r.error.code === 'RATE_LIMITED' && r.meta.rateLimit.local === true)).toBe(true);
    expect(q.snapshot()).toMatchObject({ used: 5, inFlight: 0, remaining: 0, exhausted: true });
  });

  it('the safety margin is kept below the plan limit (10,000 − 200 by default)', () => {
    const q = new MonthlyRequestQuota({ limit: 10_000, safetyMargin: 200 });
    expect(q.effectiveLimit).toBe(9_800);
    const env = railKitMonthlyQuota({})!.snapshot();
    expect(env).toMatchObject({ limit: 10_000, safetyMargin: 200, effectiveLimit: 9_800, source: 'LOCAL_ESTIMATE', authoritative: false, persisted: false });
    expect(railKitMonthlyQuota({ RAILKIT_MONTHLY_QUOTA: 'off' })).toBeNull();
  });

  it('at the limit the failover chain moves on WITHOUT a RailKit request (RailCore → RailRadar answer / fail honestly)', async () => {
    const q = quota(1); q.commit(q.reserve());              // limit reached
    const hosts: string[] = [];
    const fetchImpl = async (url: string) => { hosts.push(new URL(url).host); return { status: 503, text: async () => '{}' }; };
    const f = createFailoverProvider({ RAILWAY_PROVIDER: 'live', RAILWAY_PRIMARY_PROVIDER: 'railcore', RAILWAY_FALLBACK_PROVIDERS: 'railradar', RAILWAY_AVAILABILITY_PROVIDERS: 'railkit,railcore,railradar',
      RAILCORE_API_KEY: 'rc_dummy', RAILKIT_API_KEY: KEY, RAILRADAR_API_KEY: 'rr_dummy' }, fetchImpl as any);
    const r: any = await f.checkAvailability(REQ);
    expect(r.meta.attempts.map((a: any) => [a.provider, a.errorCode])).toEqual([['railkit', 'RATE_LIMITED'], ['railcore', 'PROVIDER_UNAVAILABLE'], ['railradar', 'PROVIDER_UNAVAILABLE']]);
    expect(hosts).toEqual(['ir.railcore.tech', 'api.railradar.in']);
    expect(q.snapshot().used).toBe(1);
  });
});

describe('RK-Q3 local pacer refusal releases the reservation (never counted)', () => {
  it('pacer at 1/min, no wait: 2nd call refused locally → counted once, nothing left in flight', async () => {
    resetRateLimiters({ paceInjectedFetch: true, config: { railkit: { perMinute: 1, minIntervalMs: 0, maxWaitMs: 0 } } });
    const q = quota(100);
    let n = 0;
    const p = rk(async () => { n++; return { status: 503, text: async () => '{}' }; });
    await p.checkAvailability(REQ);
    const second: any = await p.checkAvailability(REQ);
    expect(n).toBe(1);
    expect(second.error.code).toBe('RATE_LIMITED'); expect(second.meta.rateLimit).toEqual({ local: true });
    expect(q.snapshot()).toMatchObject({ used: 1, inFlight: 0 });
  });
});

describe('RK-Q4 calendar month (IST) reset', () => {
  it('31 Oct 23:59:59 IST is October; 00:00 IST 1 Nov resets the count; a request reserved before midnight counts once', () => {
    let now = Date.parse('2026-10-31T18:29:59Z');               // 23:59:59 IST
    const q = new MonthlyRequestQuota({ limit: 3, safetyMargin: 0, now: () => now });
    expect(istMonth(now)).toBe('2026-10');
    q.commit(q.reserve()); q.commit(q.reserve());
    const late = q.reserve();
    expect(q.snapshot()).toMatchObject({ month: '2026-10', used: 2, inFlight: 1, resetsAt: '2026-10-31T18:30:00.000Z' });
    now = Date.parse('2026-10-31T18:30:00Z');                   // 00:00 IST 1 Nov
    expect(q.snapshot()).toMatchObject({ month: '2026-11', used: 0, inFlight: 0 });
    q.commit(late);                                             // dispatched in November → counted once, in November
    q.commit(late);
    expect(q.snapshot().used).toBe(1);
    expect(nextIstMonthStart(Date.parse('2026-12-15T00:00:00Z'))).toBe('2026-12-31T18:30:00.000Z');
  });
});

describe('RK-Q5 optional persistence (atomic, current month only, no secrets)', () => {
  it('state survives a restart within the month; another month in the file is ignored', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rkq-'));
    const file = path.join(dir, 'railkit-quota.json');
    const q = new MonthlyRequestQuota({ limit: 100, safetyMargin: 0, stateFile: file });
    for (let i = 0; i < 4; i++) q.commit(q.reserve());
    await q.flush(); await q.flush();
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(j).toMatchObject({ month: istMonth(), used: 4, source: 'LOCAL_ESTIMATE' });
    expect(fs.readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([]);   // tmp file renamed away
    expect(new MonthlyRequestQuota({ limit: 100, safetyMargin: 0, stateFile: file }).snapshot()).toMatchObject({ used: 4, persisted: true, persistError: false });
    fs.writeFileSync(file, JSON.stringify({ month: '2020-01', used: 999 }));
    expect(new MonthlyRequestQuota({ limit: 100, safetyMargin: 0, stateFile: file }).snapshot().used).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(KEY);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
