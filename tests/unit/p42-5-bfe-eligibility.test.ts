/**
 * P42.5 G1 — BFE eligibility (pure): shortage only from the provider's status text for the CURRENT party; unknown /
 * failed results never count; identity numbers are never seats; binding to session / turn / journey / date / selection.
 */
import { describe, it, expect } from 'vitest';
import { evaluateBfeEligibility, bfeEligibilityCurrent, bfeKey, type BfeBinding } from '../../shared/bfe-eligibility';

const B: BfeBinding = { sessionId: 's1', turnId: 't1', journeyVersion: 4, toolExecutionId: 'tx_9f1c', selectedTrain: '12414', selectedClass: '3A' };
const ev = (status: unknown, passengers: unknown = 3, extra: any = {}) => evaluateBfeEligibility({
  ok: true, status, trainNumber: '12414', trainName: 'Pooja SF Express', date: '2026-10-08', classCode: '3A',
  requestedOrigin: 'LDH', requestedDestination: 'UMB', passengers, binding: B, ...extra });
const NOW = { sessionId: 's1', turnId: 't1', journeyVersion: 4, date: '2026-10-08', passengers: 3, selectedTrain: '12414', selectedClass: '3A' };

describe('P42.5 G1 — BFE eligibility', () => {
  it('[G1.1] RLWL1/WL1 for 3 passengers → eligible WAITLIST, confirmedSeats 0, identity + party carried', () => {
    expect(ev('RLWL1/WL1')).toMatchObject({ eligible: true, reason: 'WAITLIST', trainNumber: '12414', trainName: 'Pooja SF Express', date: '2026-10-08',
      classCode: '3A', requestedOrigin: 'LDH', requestedDestination: 'UMB', passengers: 3, confirmedSeats: 0, status: 'RLWL1/WL1' });
  });
  it('[G1.2] GNWL / PQWL / WL forms → WAITLIST', () => {
    for (const s of ['GNWL 5/WL 3', 'PQWL 2', 'WL 7']) expect(ev(s).reason).toBe('WAITLIST');
  });
  it('[G1.3] NOT AVAILABLE → NOT_AVAILABLE; REGRET → REGRET', () => {
    expect(ev('NOT AVAILABLE')).toMatchObject({ eligible: true, reason: 'NOT_AVAILABLE', confirmedSeats: 0 });
    expect(ev('REGRET')).toMatchObject({ eligible: true, reason: 'REGRET', confirmedSeats: 0 });
  });
  it('[G1.4] AVAILABLE-0001 for 3 → INSUFFICIENT_SEATS with the exact provider count', () => {
    expect(ev('AVAILABLE-0001')).toMatchObject({ eligible: true, reason: 'INSUFFICIENT_SEATS', confirmedSeats: 1, passengers: 3 });
  });
  it('[G1.5] AVAILABLE-0003 / CURR_AVBL-0005 for 3 → not eligible (seats sufficient)', () => {
    expect(ev('AVAILABLE-0003')).toMatchObject({ eligible: false, reason: null, notEligibleReason: 'SEATS_SUFFICIENT', confirmedSeats: 3 });
    expect(ev('CURR_AVBL-0005').eligible).toBe(false);
  });
  it('[G1.6] bare AVAILABLE (count unknown) is never INSUFFICIENT_SEATS', () => {
    const e = ev('AVAILABLE');
    expect(e.eligible).toBe(false);
    expect(e.confirmedSeats).toBeUndefined();
  });
  it('[G1.7] RAC is usable, not a shortage', () => {
    expect(ev('RAC 4')).toMatchObject({ eligible: false, notEligibleReason: 'RAC_AVAILABLE' });
  });
  it('[G1.8] UNKNOWN / TIMEOUT / PROVIDER_ERROR / RATE_LIMITED / AUTH_ERROR / DATA_UNAVAILABLE / empty → never eligible', () => {
    for (const s of ['UNKNOWN', 'TIMEOUT', 'PROVIDER_ERROR', 'RATE_LIMITED', 'AUTH_ERROR', 'DATA_UNAVAILABLE', 'data unavailable', '', null, undefined]) {
      const e = ev(s);
      expect(e.eligible, String(s)).toBe(false);
      expect(e.notEligibleReason).toBe('UNKNOWN_STATUS');
    }
  });
  it('[G1.9] a failed provider call is never a shortage (whatever text it carried)', () => {
    const e = evaluateBfeEligibility({ ok: false, status: 'WL 5', errorCode: 'TIMEOUT', trainNumber: '12414', classCode: '3A', passengers: 3, binding: B });
    expect(e).toMatchObject({ eligible: false, notEligibleReason: 'PROVIDER_ERROR', status: null });
  });
  it('[G1.10] request id / timestamp / train number / PNR / UUID never read as seats', () => {
    for (const s of ['req-8842193', '2026-10-07T12:40:00Z', '12414', 'PNR 4512345678', '3f2a9c1e-77b0-4c1d-9a51-0d3e1b2c4f00']) {
      const e = ev(s);
      expect(e.eligible, s).toBe(false);
      expect(e.confirmedSeats, s).toBeUndefined();
    }
    // the train number / execution id in the binding never become a count either
    expect(ev('AVAILABLE').confirmedSeats).toBeUndefined();
  });
  it('[G1.11] party unknown: WL still a shortage; AVAILABLE-0001 is not (no invented party size)', () => {
    expect(ev('WL 3', null)).toMatchObject({ eligible: true, reason: 'WAITLIST', passengers: null });
    expect(ev('AVAILABLE-0001', null).eligible).toBe(false);
  });
  it('[G1.12] party change → fresh evaluation of the same fresh status (2 → not eligible, 3 → eligible); TRAIN_CANCELLED never', () => {
    expect(ev('AVAILABLE-0002', 2).eligible).toBe(false);
    expect(ev('AVAILABLE-0002', 3)).toMatchObject({ eligible: true, reason: 'INSUFFICIENT_SEATS', confirmedSeats: 2 });
    expect(ev('TRAIN CANCELLED')).toMatchObject({ eligible: false, notEligibleReason: 'TRAIN_CANCELLED' });
    expect(evaluateBfeEligibility({ ok: true, status: 'WL 1', trainNumber: '', classCode: '3A', passengers: 1, binding: B }).notEligibleReason).toBe('MISSING_IDENTITY');
  });
  it('[G1.13] binding: same session/turn/journey/date/selection → current; turn, journeyVersion, date, train or class change → stale; key per turn', () => {
    const e = ev('WL 4');
    expect(bfeEligibilityCurrent(e, NOW)).toEqual({ current: true });
    expect(bfeEligibilityCurrent(e, { ...NOW, turnId: 't2' })).toMatchObject({ current: false, why: 'TURN' });
    expect(bfeEligibilityCurrent(e, { ...NOW, journeyVersion: 5 })).toMatchObject({ current: false, why: 'JOURNEY_VERSION' });
    expect(bfeEligibilityCurrent(e, { ...NOW, date: '2026-10-09' })).toMatchObject({ current: false, why: 'DATE' });
    expect(bfeEligibilityCurrent(e, { ...NOW, selectedClass: 'CC' })).toMatchObject({ current: false, why: 'CLASS' });
    expect(bfeEligibilityCurrent(e, { ...NOW, selectedTrain: '12014' })).toMatchObject({ current: false, why: 'TRAIN' });
    expect(bfeEligibilityCurrent(e, { ...NOW, sessionId: 's2' })).toMatchObject({ current: false, why: 'SESSION' });
    expect(bfeKey('t1', '12414', '3a', '2026-10-08', 4)).toBe('t1|12414|3A|2026-10-08|4');
    expect(bfeKey('t2', '12414', '3A', '2026-10-08', 4)).not.toBe(bfeKey('t1', '12414', '3A', '2026-10-08', 4));
  });
});
