// @vitest-environment happy-dom
/**
 * P42-13 Part 2 — inline train alternatives UI (real TrainAlternativesInline next to a real TrainCard in happy-dom — since P42-14
 * the TrainCard itself no longer embeds the other-trains list, see [36]; the payload is the
 * REAL backend builder's output over test data; the network is a mocked `fetch`). Loading / expand / collapse / View all
 * are local only — no chat message, no LLM turn, no TTS; [Select] uses the existing selection callback.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { TrainCard, TrainResults } from '../../src/components/trains/TrainCard';
import { __resetTrainAlternativesCache, ALT_PREVIEW, TrainAlternativesInline } from '../../src/components/trains/TrainAlternativesInline';
import { buildTrainAlternatives } from '../../server/railway/alternatives/train-alternatives';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const DATE = '2026-10-09';
const cat = (a: string | null) => !a ? 'UNKNOWN' : /^AVAILABLE/.test(a) ? 'AVAILABLE' : /^RAC/.test(a) ? 'RAC' : /WL/.test(a) ? 'WAITLIST' : 'NOT_AVAILABLE';
const T = (n: string, classes: Array<[string, string | null]>) => ({ trainNumber: n, trainName: `Express ${n}`, origin: 'LDH', destination: 'NDLS', departure: '06:00', arrival: '10:00', duration: '4h 0m',
  provider: 'railcore', classes: classes.map(([code, availability]) => ({ code, availability, availabilityStatus: cat(availability), fare: 750, fareCurrency: 'INR' })) }) as any;
const MAIN = T('12498', [['CC', 'WL 12'], ['EC', 'WL 3']]);
const OTHERS = [T('22478', [['CC', 'AVAILABLE-0418']]), T('12014', [['CC', 'RAC 4']]), T('12030', [['CC', null], ['2S', 'GNWL 7']]), T('15708', [['SL', 'REGRET']]), T('12460', [['CC', 'AVAILABLE-0012']])];
/** the backend's real answer for a list (test data) */
const payload = (rows: any[], version = 7) => buildTrainAlternatives({ origin: 'LDH', destination: 'NDLS', date: DATE, passengersCount: 1, searchResultsVersion: version, journeyVersion: 1,
  searchResults: { version, resultId: 'rs', date: DATE, origin: 'LDH', destination: 'NDLS', trains: rows } }, { trainNumber: '12498', searchResultsVersion: version });

let root: Root; let host: HTMLElement; let fetchMock: ReturnType<typeof vi.fn>; let reply: (body: any) => any; let ioBackup: any;
let selected: string[]; let handoffs: string[];
beforeEach(() => {
  __resetTrainAlternativesCache();
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  ioBackup = (globalThis as any).IntersectionObserver; delete (globalThis as any).IntersectionObserver;   // → visible
  selected = []; handoffs = [];
  reply = () => payload([MAIN, ...OTHERS]);
  fetchMock = vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init?.body || '{}');
    if (String(url).endsWith('/train-alternatives')) { const j = await reply(body); return { status: 200, json: async () => j } as any; }
    if (String(url).endsWith('/same-train-alternative/discover')) return { status: 200, json: async () => ({ ok: true, code: 'NO_VERIFIED_ALTERNATIVE' }) } as any;
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); if (ioBackup) (globalThis as any).IntersectionObserver = ioBackup; });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const auto = (over: any = {}) => ({ sessionId: 'sess-1', searchResultsVersion: 7, passengers: 1, onHandoff: (t: string) => handoffs.push(t), requestedClass: null, ...over });
const card = (train = MAIN, a: any = auto()) => React.createElement(TrainCard, { train, onSelectTrain: (n: string) => selected.push(n), autoSameTrain: a });
/** P42-14: the component under test rendered standalone beside the real TrainCard (the card no longer embeds it) */
const altCard = (train = MAIN, a: any = auto()) => React.createElement(React.Fragment, null, card(train, a),
  React.createElement(TrainAlternativesInline, { sessionId: a.sessionId, trainNumber: train.trainNumber, searchResultsVersion: a.searchResultsVersion, visible: true, onSelectTrain: (n: string) => selected.push(n) }));
const altCalls = () => fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/train-alternatives'));
const section = () => host.querySelector('.bk-alt') as HTMLElement | null;
const items = () => [...host.querySelectorAll('.bk-alt__item')].map(e => (e as HTMLElement).dataset.train);
const button = (re: RegExp) => [...host.querySelectorAll('button')].find(b => re.test(b.textContent || '')) as HTMLButtonElement | undefined;
const click = async (b?: HTMLElement) => { expect(b).toBeTruthy(); await act(async () => { b!.click(); }); await flush(); };

describe('P42-13 Part 2 — inline alternatives UI', () => {
  it('[26] qualifying (waitlisted) card: "Finding alternatives…" while loading, then collapsed "N alternatives available ▾" (N = backend total)', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    reply = async () => { await gate; return payload([MAIN, ...OTHERS]); };
    act(() => root.render(altCard()));
    await flush();
    expect(host.querySelector('.bk-alt--loading')?.textContent).toBe('Finding alternatives…');
    release(); await flush();
    expect(button(/alternatives available/)?.textContent).toMatch(/^5 alternatives available ▾$/);
    expect(button(/alternatives available/)?.getAttribute('aria-expanded')).toBe('false');
    expect(items()).toEqual([]);                                             // collapsed: no rows yet
    expect(altCalls()).toHaveLength(1);
    expect(JSON.parse(altCalls()[0][1].body)).toEqual({ trainNumber: '12498', searchResultsVersion: 7 });
  });
  it('[27] not under every card: a card without a shortage never fetches or renders; web lists never show alternatives', async () => {
    act(() => root.render(card(T('22478', [['CC', 'AVAILABLE-0418']]))));
    await flush();
    expect(section()).toBeNull(); expect(altCalls()).toHaveLength(0);
    act(() => root.render(React.createElement(TrainResults, { trains: [MAIN, ...OTHERS], source: 'erail', originLabel: (c: string) => c, onSelectTrain: () => {}, onSelectClass: () => {}, autoSameTrain: auto() })));
    await flush();
    expect(section()).toBeNull(); expect(altCalls()).toHaveLength(0);
  });
  it('[28] 0 alternatives, NOT_NEEDED, stale, HTTP garbage or a network error → nothing rendered, no error shown, booking UI intact', async () => {
    for (const r of [() => payload([MAIN]), () => ({ ok: true, code: 'NOT_NEEDED', alternatives: [], total: 0, searchResultsVersion: 7 }),
      () => ({ ok: false, code: 'RESULTS_STALE', alternatives: [], total: 0 }), () => ({ nope: 1 }), () => { throw new Error('offline'); }]) {
      __resetTrainAlternativesCache(); reply = r;
      act(() => root.render(React.createElement('div', { key: Math.random() }, card())));
      await flush();
      expect(section()).toBeNull();
      expect(host.textContent).not.toMatch(/alternative.*(fail|error)|nahi ho paay/i);
      expect(button(/^Select train$/)).toBeTruthy();
    }
  });
  it('[29] 1–3 alternatives: expanding shows all of them, no "View all"', async () => {
    reply = () => payload([MAIN, OTHERS[0], OTHERS[1]]);
    act(() => root.render(altCard())); await flush();
    expect(button(/alternatives available/)?.textContent).toMatch(/^2 alternatives available/);
    await click(button(/alternatives available/));
    expect(items()).toEqual(['22478', '12014']);
    expect(button(/View all/)).toBeUndefined(); expect(button(/Hide alternatives/)).toBeUndefined();
    // exactly one → singular wording, still no View all
    __resetTrainAlternativesCache(); reply = () => payload([MAIN, OTHERS[0]]);
    act(() => root.render(React.createElement('div', { key: 'one' }, altCard()))); await flush();
    expect(button(/alternatives? available/)?.textContent).toBe('1 alternative available ▾');
    await click(button(/alternatives? available/));
    expect(items()).toEqual(['22478']); expect(button(/View all/)).toBeUndefined();
  });
  it('[30] > 3: first 3 in search order + "View all alternatives (N) →"; View all expands inline; "Hide alternatives ↑" returns to 3', async () => {
    act(() => root.render(altCard())); await flush();
    await click(button(/alternatives available/));
    expect(items()).toEqual(['22478', '12014', '12030']);
    expect(ALT_PREVIEW).toBe(3);
    expect(button(/View all/)?.textContent).toBe('View all alternatives (5) →');
    await click(button(/View all/));
    expect(items()).toEqual(['22478', '12014', '12030', '15708', '12460']);
    expect(button(/View all/)).toBeUndefined();
    await click(button(/Hide alternatives/));
    expect(button(/Hide alternatives/)).toBeUndefined();
    expect(items()).toEqual(['22478', '12014', '12030']);
    await click(button(/alternatives available/));                           // header collapses the whole section
    expect(items()).toEqual([]);
  });
  it('[31] expand / collapse / View all / loading never create a chat message, LLM turn, TTS or selection — only the read-only endpoint is called', async () => {
    act(() => root.render(altCard())); await flush();
    for (const re of [/alternatives available/, /View all/, /Hide alternatives/, /alternatives available/, /alternatives available/]) await click(button(re));
    expect(selected).toEqual([]); expect(handoffs).toEqual([]);
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.every(u => /\/train-alternatives$|\/same-train-alternative\/discover$/.test(u))).toBe(true);
    expect(urls.some(u => /\/turn|\/message|\/chat|\/tts|\/voice/.test(u))).toBe(false);
    const src = readFileSync('src/components/trains/TrainAlternativesInline.tsx', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');   // code only
    expect(src).not.toMatch(/sendMessage|speak|tts|audio|\/turn/i);
  });
  it('[32] [Select] hands the train number to the existing selection flow exactly once; the main "Select train" label is unchanged', async () => {
    act(() => root.render(altCard())); await flush();
    await click(button(/alternatives available/));
    const sel = host.querySelector('.bk-alt__item[data-train="12014"] .bk-alt__select') as HTMLButtonElement;
    expect(sel.textContent).toBe('Select');
    await click(sel);
    expect(selected).toEqual(['12014']);
    expect(button(/^Select train$/)).toBeTruthy();
    expect(host.textContent).not.toMatch(/Confirm Ticket|best|recommended|faster|better/i);
  });
  it('[33] labels: authoritative status shown as-is, no label when status is null, never a fare', async () => {
    act(() => root.render(altCard())); await flush();
    await click(button(/alternatives available/));
    const row = (n: string) => host.querySelector(`.bk-alt__item[data-train="${n}"]`)!;
    expect(row('22478').textContent).toMatch(/CCAVAILABLE 418/);
    expect(row('12014').textContent).toMatch(/CCRAC 4/);
    expect(row('12030').querySelectorAll('.bk-alt__cls')[0].textContent).toBe('CC');          // null → code only
    expect(row('12030').querySelectorAll('.bk-alt__cls')[1].textContent).toBe('2SWL 7');
    expect(section()!.textContent).not.toMatch(/₹|750|INR/);
  });
  it('[34] stale / late responses are discarded: another version in the reply, or the list version changing mid-flight', async () => {
    reply = () => ({ ...payload([MAIN, ...OTHERS]), searchResultsVersion: 6 });
    act(() => root.render(React.createElement('div', { key: 'a' }, altCard()))); await flush();
    expect(section()).toBeNull();
    __resetTrainAlternativesCache();
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    reply = async (b: any) => { if (b.searchResultsVersion === 7) { await gate; return payload([MAIN, ...OTHERS], 7); } return payload([MAIN, OTHERS[0]], 8); };
    act(() => root.render(React.createElement('div', { key: 'b' }, altCard(MAIN, auto({ searchResultsVersion: 7 }))))); await flush();
    expect(host.querySelector('.bk-alt--loading')).toBeTruthy();                // v7 request in flight
    act(() => root.render(React.createElement('div', { key: 'b' }, altCard(MAIN, auto({ searchResultsVersion: 8 }))))); await flush();
    release(); await flush();
    expect(altCalls().map(c => JSON.parse(c[1].body).searchResultsVersion)).toEqual([7, 7, 8]);
    expect(button(/alternatives? available/)?.textContent).toBe('1 alternative available ▾');   // v7's late answer never shown
  });
  it('[35] one read per session|version|train (re-render / remount reuse it); expanding refreshes silently and picks up a newer CHECK label', async () => {
    act(() => root.render(altCard())); await flush();
    act(() => root.render(React.createElement('div', null, altCard()))); await flush();   // remount
    expect(altCalls()).toHaveLength(1);
    const withCheck = payload([MAIN, ...OTHERS]);
    withCheck.alternatives[0].classes[0] = { code: 'CC', status: 'AVAILABLE 405', available: true, source: 'CHECK' };
    withCheck.evidenceKey = 'deadbeef';
    reply = () => withCheck;
    await click(button(/alternatives available/));
    expect(altCalls()).toHaveLength(2);
    expect(host.querySelector('.bk-alt__item[data-train="22478"]')!.textContent).toMatch(/AVAILABLE 405/);
    expect(selected).toEqual([]); expect(handoffs).toEqual([]);
  });
  it('[36] P42-14: a waitlisted TrainCard renders ONLY same-train recovery — never the list of other trains, never a /train-alternatives call', async () => {
    act(() => root.render(card(MAIN, auto({ sessionId: 'sess-36' })))); await flush();   // own session: SameTrainInline dedupes discovery per session
    expect(section()).toBeNull(); expect(items()).toEqual([]);
    expect(button(/alternatives? available/)).toBeUndefined();
    expect(altCalls()).toHaveLength(0);
    expect(fetchMock.mock.calls.some(c => String(c[0]).endsWith('/same-train-alternative/discover'))).toBe(true);
    expect(button(/^Select train$/)).toBeTruthy();
  });
});
