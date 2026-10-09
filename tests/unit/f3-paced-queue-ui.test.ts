// @vitest-environment happy-dom
/**
 * F3 UI — the automatic same-train section polls the paced queue and shows DISTINCT states (spec #47.6 / #47.7):
 *   PENDING (queued) · RUNNING (n / total, interim seats NOT selectable) · COMPLETED with options · UNAVAILABLE
 *   (all checks complete, no seat) · PARTIAL (never labelled complete, provider errors said honestly) · FAILED.
 * Async is requested by header; the discovery body / binding fields are unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { SameTrainInline, setSameTrainPollMsForTests, SAME_TRAIN_QUEUED_TEXT, SAME_TRAIN_FAILED_NOTE, SAME_TRAIN_PARTIAL_NOTE } from '../../src/components/trains/SameTrainInline';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const DATE = '2026-10-12';
const alt = (id: string, o: string, d: string, extra: any = {}) => ({
  alternativeId: id, trainNumber: '11906', travelClass: 'SL', kind: 'ORIGIN_SWEEP', requestedOrigin: 'LDH', requestedDestination: 'NDLS',
  ticketOrigin: o, ticketDestination: d, availability: 'RAC', availabilityStatusText: 'RAC 28', verificationStatus: 'VERIFIED',
  boardingRuleStatus: 'NOT_REQUIRED', alightingRuleStatus: 'NOT_REQUIRED', boardingStation: o, alightingStation: d, isRequestedPair: false, evidence: [], ...extra });
const cardOf = (alternatives: any[], over: any = {}) => ({ alternativeSearchId: 'sta_f3', trainNumber: '11906', trainName: 'HSX AGC EXP', travelClass: 'SL', date: DATE,
  passengersCount: 1, requestedPassengerCount: 1, requestedOrigin: 'LDH', requestedDestination: 'NDLS', status: 'OK', searchComplete: true, alternatives, ...over });
const PROG = (over: any = {}) => ({ state: 'RUNNING', total: 40, done: 10, succeeded: 9, failed: 1, retried: 2, found: [], ...over });

let root: Root; let host: HTMLElement; let n = 0;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); setSameTrainPollMsForTests(20); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); setSameTrainPollMsForTests(null); });
const flush = async (k = 6) => { for (let i = 0; i < k; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const wait = async (ms: number) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const button = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent || '')) as HTMLButtonElement | undefined;
/** fetch mock answering the queued replies in order (the last one repeats) */
function replies(list: any[]) {
  let i = 0;
  const f = vi.fn(async (_u: string, _init: any) => ({ status: 200, json: async () => list[Math.min(i++, list.length - 1)] }));
  vi.stubGlobal('fetch', f);
  return f;
}
const render = (onFallback?: () => void) => {
  n += 1;
  act(() => root.render(React.createElement(SameTrainInline, { key: `f3-${n}`, sessionId: `f3-${n}`, trainNumber: '11906', travelClass: 'SL', searchResultsVersion: 1, visible: true, onHandoff: () => {}, onFallback })));
};

describe('F3 UI — polling + distinct states', () => {
  it('[U1] PENDING → RUNNING (genuine counts, interim seats not selectable) → COMPLETED with options; async by header, body unchanged', async () => {
    const f = replies([
      { ok: true, code: 'RUNNING', progress: PROG({ state: 'QUEUED', total: 40, done: 0, succeeded: 0, failed: 0, retried: 0 }) },
      { ok: true, code: 'RUNNING', progress: PROG({ found: [{ ticketOrigin: 'HSX', ticketDestination: 'NDLS', travelClass: 'SL', status: 'RAC 28' }] }) },
      { ok: true, code: 'RUNNING', progress: PROG({ found: [{ ticketOrigin: 'HSX', ticketDestination: 'NDLS', travelClass: 'SL', status: 'RAC 28' }] }) },
      { ok: true, code: 'OK', card: cardOf([alt('A1', 'HSX', 'NDLS')], { checkSummary: { total: 40, succeeded: 40, failed: 0, skipped: 0, retried: 2, paced: true } }) }
    ]);
    render();
    await flush();
    expect(host.textContent).toContain(SAME_TRAIN_QUEUED_TEXT);
    expect(host.textContent).toContain('0 / 40');
    await wait(25); await flush();
    expect(host.textContent).toMatch(/10 \/ 40 checks/);
    expect(host.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('10');
    expect(host.textContent).toContain('HSX → NDLS · SL RAC 28');
    expect(host.textContent).toMatch(/abhi select nahi kar sakte/);
    expect(button(/Select/)).toBeUndefined();                       // interim seat is NOT selectable
    expect(host.textContent).toMatch(/1 checks abhi provider error/);
    await wait(60); await flush();
    expect(host.querySelector('section.bk-sti')).not.toBeNull();
    expect(button(/^Select$/)).toBeTruthy();
    expect(host.textContent).toContain('Saare 40 checks complete.');
    // header-based async; the body is exactly the old discovery body
    const [url, init] = f.mock.calls[0] as any[];
    expect(String(url).endsWith('/same-train-alternative/discover')).toBe(true);
    expect(init.headers['X-Same-Train-Async']).toBe('1');
    expect(JSON.parse(init.body)).toEqual({ trainNumber: '11906', travelClass: 'SL', searchResultsVersion: 1 });
    const polls = f.mock.calls.length;
    await wait(80);
    expect(f.mock.calls.length).toBe(polls);                        // polling stops at the final answer
  });

  it('[U2] PARTIAL with options → listed, but the state line says the search is incomplete (never "complete")', async () => {
    replies([{ ok: true, code: 'OK', card: cardOf([alt('A1', 'HSX', 'NDLS')], { status: 'PARTIAL', searchComplete: false, checkSummary: { total: 40, succeeded: 36, failed: 4, skipped: 0, retried: 8, paced: true } }) }]);
    render();
    await flush();
    expect(host.querySelector('section.bk-sti')).not.toBeNull();
    expect(host.textContent).toContain('Search adhoora: 4 / 40 checks');
    expect(host.textContent).not.toMatch(/complete\./);
  });

  it('[U3] UNAVAILABLE (all checks complete, no seat) ≠ PARTIAL-with-nothing ≠ FAILED', async () => {
    replies([{ ok: true, code: 'OK', card: cardOf([alt('W1', 'HSX', 'NDLS', { availability: 'WAITLIST', availabilityStatusText: 'WL 3' })], { status: 'NOT_FOUND', checkSummary: { total: 31, succeeded: 31, failed: 0, skipped: 0, retried: 0, paced: true } }) }]);
    render(() => {});
    await flush();
    expect(host.textContent).toContain('saare 31 checks complete');
    expect(host.textContent).toContain('koi verified seat nahi mili');
    expect(button(/Same Train Alternative/)).toBeUndefined();

    replies([{ ok: true, code: 'OK', card: cardOf([], { status: 'PARTIAL', searchComplete: false, checkSummary: { total: 31, succeeded: 20, failed: 11, skipped: 0, retried: 4, paced: true } }) }]);
    render(() => {});
    await flush();
    expect(host.textContent).toContain(SAME_TRAIN_PARTIAL_NOTE);
    expect(host.textContent).toContain('Search adhoora: 11 / 31 checks');
    expect(host.textContent).not.toMatch(/checks complete/);
    expect(button(/Same Train Alternative/)).toBeTruthy();

    const fb: string[] = [];
    replies([{ ok: false, code: 'SEARCH_FAILED' }]);
    render(() => fb.push('x'));
    await flush();
    expect(host.textContent).toContain(SAME_TRAIN_FAILED_NOTE);
    expect(host.textContent).not.toMatch(/seat nahi mili/);
    await act(async () => { button(/Same Train Alternative/)!.click(); });
    expect(fb).toEqual(['x']);
  });

  it('[U4] a list that went stale while queued stops polling and shows nothing', async () => {
    const f = replies([{ ok: true, code: 'RUNNING', progress: PROG() }, { ok: false, code: 'RESULTS_STALE' }]);
    render(() => {});
    await flush(); await wait(30); await flush();
    expect(host.textContent).toBe('');
    const k = f.mock.calls.length;
    await wait(60);
    expect(f.mock.calls.length).toBe(k);
  });
});
