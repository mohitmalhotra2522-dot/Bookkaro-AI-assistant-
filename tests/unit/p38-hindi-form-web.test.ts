/**
 * P38 — Devanagari numbers / names · IRCTC-like passenger form (berth from class, food only from provider catering) ·
 * web connectors (eRail search parser, RailYatri live-status parser) · unverified web label in replies.
 * Pure functions + inline fixtures only. No network, no LLM.
 */
import { describe, it, expect } from 'vitest';
import { normalizeDevanagariNumbers } from '../../shared/devanagari-numbers';
import { canonicalName } from '../../server/booking/passenger-validator';
import { parsePassengerCount } from '../../server/booking/preparation/passenger-count';
import { berthOptionsForClass } from '../../shared/constants';
import { buildFormSpec, validateForm, formNotReady, type TrainFacilitiesView } from '../../server/booking/passenger-form';
import { parseErailTrains, erailClasses, monFirstWeekday, parseRailYatriLive, webSourceLabel } from '../../server/railway/providers/web/web-providers';
import { normalizeTrackResponse } from '../../server/booking/post-booking/pnr-status-service';
import { factFromTool, searchSummary } from '../../server/ai/context/response-formatter';

const session = (cls: string, extra: any = {}): any => ({
  sessionId: 's1', sessionVersion: 7, date: '2026-10-06', selectedClass: cls, passengersCount: 2, passengers: [],
  selectedTrain: { number: '12926', name: 'PASCHIM EXP', origin: 'ASR', destination: 'NDLS', departure: '17:10', arrival: '23:25' },
  providerSource: 'railcore', ...extra
});
const fac = (catering: boolean | null, pantry: boolean | null = null): TrainFacilitiesView => ({ catering, pantry, provider: 'railcore', dataSource: 'LIVE' });

describe('[1] Devanagari numbers (validation aid only)', () => {
  it('maps Devanagari digits and standalone number words', () => {
    expect(normalizeDevanagariNumbers('१२९२६ में ३ यात्री')).toMatch(/12926/);
    expect(normalizeDevanagariNumbers('हम तीन लोग हैं')).toMatch(/\b3 log\b/);
    expect(normalizeDevanagariNumbers('दो टिकट चाहिए')).toMatch(/\b2 log\b/);
  });
  it('does not touch words that merely contain a number word, nor Latin text', () => {
    expect(normalizeDevanagariNumbers('मेरा दोस्त')).not.toMatch(/2/);
    expect(normalizeDevanagariNumbers('do log hain')).toBe('do log hain');
  });
  it('a proposed count is grounded in Devanagari text', () => {
    expect(parsePassengerCount('हम तीन लोग हैं')).toMatchObject({ kind: 'COUNT', count: 3 });
    expect(parsePassengerCount('२ यात्री')).toMatchObject({ kind: 'COUNT', count: 2 });
  });
});

describe('[2] Devanagari names', () => {
  it('accepts names with matras (\\p{M})', () => {
    expect(canonicalName('मोहित शर्मा')).toBe('मोहित शर्मा');
    expect(canonicalName('मेरा नाम सीमा है')).toBe('सीमा');
  });
  it('still rejects non-names', () => {
    expect(canonicalName('टिकट')).toBeNull();
    expect(canonicalName('नई दिल्ली')).toBeNull();
    expect(canonicalName('Rahul 12')).toBeNull();
  });
});

describe('[3] Passenger form spec — nothing fake', () => {
  it('berth options come only from the class layout', () => {
    expect(berthOptionsForClass('3A')).toEqual(['NO_PREFERENCE', 'LOWER', 'MIDDLE', 'UPPER', 'SIDE_LOWER', 'SIDE_UPPER']);
    expect(berthOptionsForClass('EA')).toEqual([]);
    expect(berthOptionsForClass('XYZ')).toEqual([]);
    const cc = buildFormSpec(session('EA'), fac(true));
    expect(cc.berth.options).toEqual([]);
    expect(cc.berth.note).toMatch(/seat railway allot/);
  });
  it('food is offered only when provider data shows catering', () => {
    expect(buildFormSpec(session('CC'), fac(true)).food).toMatchObject({ status: 'OFFERED', options: ['VEG', 'NON_VEG', 'NO_FOOD'] });
    expect(buildFormSpec(session('3A'), fac(false, false)).food).toMatchObject({ status: 'NOT_INCLUDED', options: [] });
    expect(buildFormSpec(session('3A'), fac(null)).food).toMatchObject({ status: 'UNKNOWN', options: [] });
  });
  it('form needs a selected train and class', () => {
    expect(formNotReady(session('3A', { selectedTrain: null }))?.status).toBe(409);
    expect(formNotReady(session('3A'))).toBeNull();
  });
});

describe('[4] Passenger form validation', () => {
  it('rejects Devanagari name, bad age, berth not in class and food not offered — per field', () => {
    const r = validateForm({ passengers: [{ name: 'मोहित', age: 200, gender: 'MALE', berthPreference: 'LOWER', foodPreference: 'VEG' }] }, session('CC'), fac(false));
    expect(r.ok).toBe(false);
    const fields = (r as any).error.fieldErrors.map((e: any) => e.field).sort();
    expect(fields).toEqual(expect.arrayContaining(['name', 'age', 'berthPreference', 'foodPreference']));
  });
  it('requires a food choice when catering is included', () => {
    const r = validateForm({ passengers: [{ name: 'Rahul Sharma', age: 30, gender: 'MALE' }] }, session('CC'), fac(true));
    expect(r.ok).toBe(false);
    expect((r as any).error.fieldErrors[0].field).toBe('foodPreference');
  });
  it('accepts a valid 3A form (berth from the class layout, no food key when not offered)', () => {
    const r = validateForm({ passengers: [{ name: 'Mohit Sharma', age: 34, gender: 'MALE', berthPreference: 'side_lower' }, { name: 'Seema Sharma', age: 31, gender: 'FEMALE' }] }, session('3A'), fac(false));
    expect(r.ok).toBe(true);
    const p = (r as any).passengers;
    expect(p[0]).toMatchObject({ name: 'Mohit Sharma', age: 34, gender: 'MALE', berthPreference: 'SIDE_LOWER' });
    expect(p[0].foodPreference).toBeUndefined();
    expect(p[1].berthPreference).toBeUndefined();
  });
  it('rejects 0 or more than 6 passengers', () => {
    expect(validateForm({ passengers: [] }, session('3A'), fac(false)).ok).toBe(false);
    expect(validateForm({ passengers: Array(7).fill({ name: 'Rahul', age: 30, gender: 'MALE' }) }, session('3A'), fac(false)).ok).toBe(false);
  });
});

describe('[5] eRail parser (inline fixture)', () => {
  const head = '~ASR~Amritsar Jn~NDLS~New Delhi~~ts';
  const row = (no: string, days: string, comp: string) => [no, 'PASCHIM EXP', '', '', '', '', 'Amritsar Jn', 'ASR', 'New Delhi', 'NDLS', '17.10', '23.25', '6.15', days, '', comp].join('~');
  it('weekday index is Monday-first', () => {
    expect(monFirstWeekday('2026-10-05')).toBe(0); // Monday
    expect(monFirstWeekday('2026-10-11')).toBe(6); // Sunday
  });
  it('classes come from the coach composition', () => {
    expect(erailClasses(['x', ',,En:SLRD,SLRD,SLRD:S,S1,SL:B,B1,3A:A,A1,2A'])).toEqual(expect.arrayContaining(['SL', '3A', '2A']));
    expect(erailClasses(['x', ',,En:SLRD,SLRD,SLRD:S,S1,SL:B,B1,3A'])).not.toContain('SLRD');
  });
  it('parses rows, filters by run day of the date, never invents fare / availability', () => {
    const txt = [head, row('12926', '1111111', ',,En:S,S1,SL:B,B1,3A'), row('19999', '1000000', ',,En:S,S1,SL')].join('^');
    const r = parseErailTrains(txt, '2026-10-06'); // Tuesday → 19999 (Mon only) excluded
    expect(r.ok).toBe(true);
    const t = (r as any).trains;
    expect(t.map((x: any) => x.trainNumber)).toEqual(['12926']);
    expect(t[0]).toMatchObject({ origin: 'ASR', destination: 'NDLS', departure: '17:10', arrival: '23:25', duration: '6h 15m' });
    expect(t[0].classes.every((c: any) => c.fare === null && c.availability === null)).toBe(true);
    expect((r as any).originName).toBe('Amritsar Jn');
  });
  it('search summary of eRail results is labelled unverified (text + voice); RailCore summary unchanged', () => {
    const ses: any = { origin: 'ASR', destination: 'NDLS', originName: 'Amritsar Junction', destinationName: 'New Delhi', date: '2026-10-06', providerSource: 'erail',
      searchResults: { trains: [{ trainNumber: '12926', trainName: 'PASCHIM EXP', departure: '17:10', arrival: '23:25', duration: '6h 15m', classes: [{ code: 'SL' }] }] } };
    const r = searchSummary(ses, 'TEXT');
    expect(r).toMatch(/1 train mili hai \(eRail website — unverified web data; fare \/ seat availability nahi\)/);
    expect(r).toMatch(/12926 PASCHIM EXP — 17:10 → 23:25/);
    expect(searchSummary(ses, 'VOICE')).toMatch(/eRail website se, unverified/);
    expect(searchSummary({ ...ses, providerSource: 'railcore' }, 'TEXT')).not.toMatch(/unverified/);
    expect(searchSummary({ ...ses, searchResults: { trains: [] } }, 'TEXT')).toMatch(/koi train nahi mili \(eRail website — unverified/);
  });
  it('station-not-found is an honest error', () => {
    const r = parseErailTrains('~~~~~To station not found', '2026-10-06');
    expect(r.ok).toBe(false);
    expect((r as any).message).toMatch(/not found/);
  });
});

describe('[6] RailYatri live-status parser + unverified label', () => {
  const page = (lts: any) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { ltsData: lts } } })}</script></html>`;
  const lts = { success: true, train_number: '12926', train_name: 'Paschim SF Express', update_time: '2026-10-05 10:12:00 +0530',
    current_station_code: 'SNL', current_station_name: 'SANAHWAL~', delay: 15, platform_number: '0', next_stoppage_info: { next_stoppage: 'LUDHIANA JN' },
    current_location_info: [{ message: 'Crossed SANAHWAL~ at 10:12' }], status_as_of: 'As of 2 mins ago' };
  it('parses status, strips ~, drops unknown platform 0, carries a sourceNote', () => {
    const d: any = parseRailYatriLive(page(lts), '12926');
    expect(d).toMatchObject({ trainNumber: '12926', currentStatus: 'Crossed SANAHWAL at 10:12', currentStationName: 'SANAHWAL', delayMinutes: 15, nextStationName: 'LUDHIANA JN' });
    expect(d.platformNumber).toBeUndefined();
    expect(d.sourceNote).toMatch(/unverified/);
  });
  it('not found / mismatch / missing data throw instead of inventing', () => {
    expect(() => parseRailYatriLive(page({ success: false }), '12926')).toThrow();
    expect(() => parseRailYatriLive(page(lts), '12925')).toThrow();
    expect(() => parseRailYatriLive('<html></html>', '12926')).toThrow();
  });
  it('normalized web result keeps the label; reply says RailYatri / unverified, never "railway provider"', () => {
    const raw = { ok: true, data: parseRailYatriLive(page(lts), '12926') };
    const n: any = normalizeTrackResponse(raw, '12926', { providerId: 'railyatri', source: 'railway-provider', latencyMs: 1 });
    expect(n.ok).toBe(true);
    expect(n.data.verification).toBe('UNVERIFIED_WEB');
    const text = factFromTool('TRACK_TRAIN', n.data, 'TEXT');
    expect(text).toMatch(/RailYatri website, crowd-sourced — unverified, as of 10:12/);
    expect(text).not.toMatch(/railway provider/);
    expect(webSourceLabel('erail')).toBe('WEB (eRail) — unverified');
  });
  it('RailCore track results are unchanged (no web fields) and RailYatri not-found is honest', () => {
    const n: any = normalizeTrackResponse({ ok: true, data: { trainNumber: '12926', currentStatus: 'Running' } }, '12926', { providerId: 'railcore', source: 'railway-provider', latencyMs: 1 });
    expect(n.data.verification).toBeUndefined();
    expect(factFromTool('TRACK_TRAIN', n.data, 'TEXT')).toMatch(/railway provider/);
    const nf: any = normalizeTrackResponse({ ok: false, error: { code: 'NOT_FOUND' } }, '12926', { providerId: 'railyatri', source: 'web', latencyMs: 1 });
    expect(nf.error.code).toBe('LIVE_STATUS_NOT_FOUND');
  });
});
