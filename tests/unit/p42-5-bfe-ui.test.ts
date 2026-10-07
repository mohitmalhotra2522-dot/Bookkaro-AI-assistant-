/**
 * P42.5 G4 — same-train (BFE) UI: heading, verified-only, same train number only, dedup by trainNumber + bookFrom,
 * max 15, canBookAvail (AVAILABLE / RAC book; WL / NA / REGRET / UNKNOWN never), class chips exclude the hero class
 * (max 3), RAC keeps its tag, nothing rendered without a verified option, card + inline share the list.
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SameTrainOptionList, groupSameTrainOptions, canBookAvail, extraClassChips, BFE_HEADING, EXTENSION_HEADING, MAX_SAME_TRAIN_OPTIONS } from '../../src/components/trains/SameTrainInline';
import { SameTrainCard } from '../../src/components/trains/SameTrainAlternatives';

const alt = (id: string, o: string, d: string, availability: string, text: string, extra: any = {}) => ({
  alternativeId: id, trainNumber: '12414', travelClass: '3A', kind: 'ORIGIN_SWEEP', requestedOrigin: 'LDH', requestedDestination: 'UMB',
  ticketOrigin: o, ticketDestination: d, availability, availabilityStatusText: text, verificationStatus: 'PARTIALLY_VERIFIED',
  boardingRuleStatus: 'UNVERIFIED', alightingRuleStatus: 'NOT_REQUIRED', boardingStation: o, alightingStation: d, isRequestedPair: false, evidence: [],
  ...(availability === 'AVAILABLE' ? { seatSufficiency: 'SUFFICIENT', availableSeatCount: 3 } : {}), ...extra });
const card = (alternatives: any[]) => ({ alternativeSearchId: 'sta_p425', trainNumber: '12414', trainName: 'Pooja SF Express', travelClass: '3A', date: '2026-10-08',
  passengersCount: 3, requestedPassengerCount: 3, requestedOrigin: 'LDH', requestedDestination: 'UMB', status: 'OK', alternatives });
const html = (d: any) => renderToStaticMarkup(React.createElement(SameTrainOptionList, { d, sessionId: 's', onHandoff: () => {}, classTag: '3A' }));

describe('P42.5 G4 — BFE UI', () => {
  it('[G4.1] heading "Same train · pehle station se board karo" appears only when a verified earlier-boarding option exists', () => {
    expect(html(card([alt('A1', 'JUC', 'UMB', 'RAC', 'RAC 1')]))).toContain(BFE_HEADING);
    expect(BFE_HEADING).toBe('Same train · pehle station se board karo');
    expect(html(card([alt('A1', 'JUC', 'UMB', 'WAITLIST', 'WL 2')]))).toBe('');
  });
  it('[G4.2] no verified option → nothing rendered (no empty card)', () => {
    expect(html(card([]))).toBe('');
    expect(html(card([alt('A1', 'LDH', 'UMB', 'WAITLIST', 'WL 5', { isRequestedPair: true, verificationStatus: 'VERIFIED' })]))).toBe('');
  });
  it('[G4.3] canBookAvail: AVAILABLE (whole party) + RAC → true; WL / NA / REGRET / UNKNOWN / short AVAILABLE / unverified → false', () => {
    expect(canBookAvail(alt('a', 'JUC', 'UMB', 'AVAILABLE', 'AVL 3'))).toBe(true);
    expect(canBookAvail(alt('b', 'JUC', 'UMB', 'RAC', 'RAC 1'))).toBe(true);
    for (const a of ['WAITLIST', 'NOT_AVAILABLE', 'REGRET', 'UNKNOWN']) expect(canBookAvail(alt('c', 'JUC', 'UMB', a, a)), a).toBe(false);
    expect(canBookAvail(alt('d', 'JUC', 'UMB', 'AVAILABLE', 'AVL 1', { seatSufficiency: 'INSUFFICIENT', availableSeatCount: 1 }))).toBe(false);
    expect(canBookAvail(alt('e', 'JUC', 'UMB', 'RAC', 'RAC 1', { verificationStatus: 'UNVERIFIED' }))).toBe(false);
  });
  it('[G4.4] RAC keeps its amber "RAC 1" tag and is selectable; AVAILABLE green', () => {
    const h = html(card([alt('A1', 'ASR', 'UMB', 'AVAILABLE', 'AVL 3'), alt('A2', 'JUC', 'UMB', 'RAC', 'RAC 1')]));
    expect(h).toContain('bk-tag--warn">RAC 1<');
    expect(h).toContain('bk-tag--good">AVL 3<');
    expect((h.match(/>Select</g) || []).length).toBe(2);
  });
  it('[G4.5] dedup by trainNumber + bookFrom (ticketOrigin): first (backend order) kept', () => {
    const g = groupSameTrainOptions(card([alt('A1', 'JUC', 'UMB', 'RAC', 'RAC 1'), alt('A2', 'JUC', 'KKDE', 'AVAILABLE', 'AVL 3'), alt('A3', 'ASR', 'UMB', 'AVAILABLE', 'AVL 3')]));
    expect(g.earlier.map(a => a.alternativeId)).toEqual(['A1', 'A3']);
  });
  it('[G4.6] at most 15 options', () => {
    const many = Array.from({ length: 22 }, (_, i) => alt(`A${i}`, `S${String(i).padStart(2, '0')}`, 'UMB', 'AVAILABLE', 'AVL 3'));
    const g = groupSameTrainOptions(card(many));
    expect(g.earlier.length + g.further.length).toBe(MAX_SAME_TRAIN_OPTIONS);
    expect(MAX_SAME_TRAIN_OPTIONS).toBe(15);
  });
  it('[G4.7] same train number only — another train is never listed under the same-train section', () => {
    const g = groupSameTrainOptions(card([alt('A1', 'JUC', 'UMB', 'RAC', 'RAC 1'), alt('A2', 'ASR', 'UMB', 'AVAILABLE', 'AVL 3', { trainNumber: '12904' })]));
    expect(g.earlier.map(a => a.alternativeId)).toEqual(['A1']);
  });
  it('[G4.8] earlier-boarding group first, destination-only extensions after it (own heading)', () => {
    const h = html(card([alt('X1', 'LDH', 'KKDE', 'AVAILABLE', 'AVL 3', { kind: 'DESTINATION_EXTENSION' }), alt('A1', 'JUC', 'UMB', 'RAC', 'RAC 1')]));
    expect(h.indexOf(BFE_HEADING)).toBeGreaterThan(-1);
    expect(h.indexOf(EXTENSION_HEADING)).toBeGreaterThan(h.indexOf(BFE_HEADING));
    expect(h.indexOf('RAC 1')).toBeLessThan(h.indexOf(EXTENSION_HEADING));
  });
  it('[G4.9] class chips: provider-returned classes only, hero class excluded, max 3; none invented', () => {
    const a = alt('A1', 'JUC', 'UMB', 'RAC', 'RAC 1', { classOptions: [{ code: '3A', status: 'RAC 1' }, { code: '2A', status: 'AVL 4' }, { code: 'SL', status: 'AVL 9' }, { code: '1A', status: 'AVL 1' }, { code: '3E', status: 'AVL 2' }, { code: 'CC' }] });
    expect(extraClassChips(a)).toEqual([{ code: '2A', status: 'AVL 4' }, { code: 'SL', status: 'AVL 9' }, { code: '1A', status: 'AVL 1' }]);
    expect(extraClassChips(alt('A2', 'JUC', 'UMB', 'RAC', 'RAC 1'))).toEqual([]);
    const h = html(card([a]));
    expect(h).toContain('2A · AVL 4');
    expect(h).not.toContain('3E');
  });
  it('[G4.10] the chat card uses the same list (heading + only verified + Select) and is expanded', () => {
    const d = card([alt('A1', 'JUC', 'UMB', 'RAC', 'RAC 1'), alt('A2', 'ASR', 'UMB', 'WAITLIST', 'WL 4')]);
    const h = renderToStaticMarkup(React.createElement(SameTrainCard, { d, sessionId: 's', onHandoff: () => {} }));
    expect(h).toContain(BFE_HEADING);
    expect(h).toContain('RAC 1');
    expect(h).toMatch(/>Select</);
  });
  it('[G4.11] unverified boarding rule shown as a note (no claim the user can board at the requested station); stale → Select disabled', () => {
    const d = card([alt('A1', 'JUC', 'UMB', 'RAC', 'RAC 1')]);
    expect(html(d)).toMatch(/boarding ka rule verify nahi hua/);
    const st = renderToStaticMarkup(React.createElement(SameTrainOptionList, { d, sessionId: 's', disabled: true, onHandoff: () => {} }));
    expect(st).toMatch(/disabled=""[^>]*>Select</);
  });
});
