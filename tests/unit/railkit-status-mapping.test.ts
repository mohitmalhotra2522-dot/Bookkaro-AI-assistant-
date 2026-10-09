/**
 * RailKit paid-plan live shapes (2026-10-09, 12425): the coarse `status` says WAITLIST for an RAC row — the class's
 * current status comes from availabilityText. RAC / AVAILABLE must never become WL (WL-only alternative eligibility).
 * Recorded public railway facts only (no key, no PII). Offline: injected fetch.
 */
import { describe, it, expect } from 'vitest';
import { createLiveProvider } from '../../server/railway/providers/live/live-config';
import { railKitStatusOf } from '../../server/railway/providers/live/railkit-provider';
import { isWaitlistStatus as isWaitlistedSeatStatus } from '../../shared/same-train-shortage';

const row = (date: string, status: string, availabilityText: string, rawStatus?: string) =>
  ({ date, status, availabilityText, ...(rawStatus ? { rawStatus } : {}), prediction: 'x', predictionPercentage: 90, canBook: true });
const body = (from: string, cls: string, rows: any[]) => JSON.stringify({ success: true, data: {
  train: { trainNo: '12425', trainName: 'JAMMU RAJDHANI', from, to: 'JAT', travelClass: cls, quota: 'GN' },
  fare: { baseFare: 972, reservationCharge: 40, superfastCharge: 45, serviceTax: 73, totalFare: 1705 }, availability: rows } });
function provider(json: string, seen: string[] = []) {
  const fetchImpl: any = async (url: string) => { seen.push(url); return { status: 200, text: async () => json, headers: { get: () => null } }; };
  return createLiveProvider('railkit', { RAILKIT_API_KEY: 'rk-TEST-not-a-key' } as any, fetchImpl);
}

describe('RailKit availability status mapping (live shapes)', () => {
  it('[RK1] RAC row reported as status WAITLIST → RAC 80 (never WL 80), exact date row only', async () => {
    const seen: string[] = [];
    const p = provider(body('NDLS', '3A', [row('19-10-2026', 'WAITLIST', 'RAC 80', 'GNWL53/RAC80'), row('20-10-2026', 'WAITLIST', 'WL 16', 'GNWL86/WL16')]), seen);
    const r: any = await p.checkAvailability({ trainNumber: '12425', origin: 'NDLS', destination: 'JAT', date: '2026-10-19', travelClass: '3A' } as any);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ trainNumber: '12425', travelClass: '3A', date: '2026-10-19', status: 'RAC 80', available: false, statusText: 'GNWL53/RAC80', providerUpdatedAt: null });
    expect(isWaitlistedSeatStatus(r.data.status)).toBe(false);
    expect(seen[0]).toMatch(/\/api\/v1\/seats\/12425\/NDLS\/JAT\/19-10-2026\/3A\/GN$/);
  });
  it('[RK2] WL row → WL 1 (eligible); AVAILABLE "AVL 1" → AVAILABLE 1 (ineligible)', async () => {
    const wl: any = await provider(body('LDH', '3A', [row('20-10-2026', 'WAITLIST', 'WL 1', 'RLWL1/WL1')]))
      .checkAvailability({ trainNumber: '12425', origin: 'LDH', destination: 'JAT', date: '2026-10-20', travelClass: '3A' } as any);
    expect(wl.data).toMatchObject({ status: 'WL 1', available: false });
    expect(isWaitlistedSeatStatus(wl.data.status)).toBe(true);
    const av: any = await provider(body('LDH', '2A', [row('20-10-2026', 'AVAILABLE', 'AVL 1')]))
      .checkAvailability({ trainNumber: '12425', origin: 'LDH', destination: 'JAT', date: '2026-10-20', travelClass: '2A' } as any);
    expect(av.data).toMatchObject({ status: 'AVAILABLE 1', available: true });
    expect(isWaitlistedSeatStatus(av.data.status)).toBe(false);
  });
  it('[RK3] requested date missing from the calendar → not a result (no silent date substitution)', async () => {
    const r: any = await provider(body('LDH', '3A', [row('21-10-2026', 'WAITLIST', 'WL 2')]))
      .checkAvailability({ trainNumber: '12425', origin: 'LDH', destination: 'JAT', date: '2026-10-20', travelClass: '3A' } as any);
    expect(r.ok).toBe(false);
  });
  it('[RK4] text/status contradiction is rejected, REGRET stays REGRET (ineligible)', async () => {
    expect(() => railKitStatusOf('WL 3', 'AVAILABLE')).toThrow();
    expect(() => railKitStatusOf('AVL 4', 'WAITLIST')).toThrow();
    expect(railKitStatusOf('REGRET', 'WAITLIST')).toBe('REGRET');
    expect(railKitStatusOf('', 'WAITLIST')).toBe('WAITLIST');
    const rg: any = await provider(body('LDH', 'SL', [row('20-10-2026', 'WAITLIST', 'REGRET')]))
      .checkAvailability({ trainNumber: '12425', origin: 'LDH', destination: 'JAT', date: '2026-10-20', travelClass: 'SL' } as any);
    expect(rg.data.status).toBe('REGRET');
    expect(isWaitlistedSeatStatus(rg.data.status)).toBe(false);
  });
});
