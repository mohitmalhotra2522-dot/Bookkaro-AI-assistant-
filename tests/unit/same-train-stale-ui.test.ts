// @vitest-environment happy-dom
/**
 * 2026-10-09 UI — a same-train search whose unchecked results are too-old provider snapshots says so (never "saare N
 * checks complete … koi verified seat nahi mili", never the "provider limit" wording), listing route · class · provider
 * time · status, with the existing tap action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SameTrainInline, setSameTrainPollMsForTests, SAME_TRAIN_STALE_NOTE, SAME_TRAIN_PARTIAL_NOTE } from '../../src/components/trains/SameTrainInline';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const STALE = { provider: 'railcore', ticketOrigin: 'NDLS', ticketDestination: 'JAT', travelClass: '3A', status: 'GNWL84/WL17', providerUpdatedAt: '2026-10-09T07:05:27+05:30', ageMinutes: 282 };
const card = (over: any = {}) => ({ alternativeSearchId: 'sta_st', trainNumber: '12425', trainName: 'JAMMU RAJDHANI', travelClass: '3A', date: '2026-10-20',
  passengersCount: 1, requestedPassengerCount: 1, requestedOrigin: 'LDH', requestedDestination: 'JAT', status: 'PARTIAL', searchComplete: false,
  alternatives: [], checkSummary: { total: 3, succeeded: 2, failed: 1, skipped: 0, retried: 0, paced: true, stale: 1 }, staleChecks: [STALE], ...over });

let root: Root; let host: HTMLElement; let n = 0;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); setSameTrainPollMsForTests(20); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); setSameTrainPollMsForTests(null); });
const flush = async (k = 6) => { for (let i = 0; i < k; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const reply = (j: any) => vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => j })));
const render = () => { n += 1; act(() => root.render(React.createElement(SameTrainInline, { key: `st-${n}`, sessionId: `st-${n}`, trainNumber: '12425', travelClass: '3A', searchResultsVersion: 1, visible: true, onHandoff: () => {}, onFallback: () => {} }))); };

describe('stale provider data — screen', () => {
  it('[SU1] reported case: 3 checks, origin pair stale → stale note + line, NOT "complete / no seat", NOT "provider limit"', async () => {
    reply({ ok: true, code: 'OK', card: card() });
    render(); await flush();
    const t = host.textContent || '';
    expect(t).toContain(SAME_TRAIN_STALE_NOTE);
    expect(t).toContain('NDLS → JAT 3A: provider data 07:05 ka (282 min purana · GNWL84/WL17) — fresh status confirm nahi ho paaya');
    expect(t).toContain('Search adhoora: 1 / 3 checks ka provider data purana tha');
    expect(t).not.toMatch(/checks complete/);
    expect(t).not.toContain(SAME_TRAIN_PARTIAL_NOTE);
    expect([...host.querySelectorAll('button')].some(b => /Same Train Alternative/.test(b.textContent || ''))).toBe(true);
  });
  it('[SU2] stale + provider errors mixed → P42-14 partial note kept, counts split, stale line listed', async () => {
    reply({ ok: true, code: 'OK', card: card({ checkSummary: { total: 10, succeeded: 7, failed: 3, skipped: 0, retried: 0, paced: true, stale: 1 } }) });
    render(); await flush();
    const t = host.textContent || '';
    expect(t).toContain(SAME_TRAIN_PARTIAL_NOTE);
    expect(t).toMatch(/3 \/ 10 checks verify nahi ho paaye \(1 purana provider data, 2 provider limit \/ error\)/);
    expect(t).toContain('NDLS → JAT 3A: provider data 07:05 ka');
  });
  it('[SU3] every check stale (failed search) → stale note + lines instead of the generic provider-error note', async () => {
    reply({ ok: false, code: 'SEARCH_FAILED', staleChecks: [STALE] });
    render(); await flush();
    const t = host.textContent || '';
    expect(t).toContain(SAME_TRAIN_STALE_NOTE);
    expect(t).toContain('NDLS → JAT 3A');
    expect(t).not.toMatch(/provider error ki wajah se/);
  });
});
