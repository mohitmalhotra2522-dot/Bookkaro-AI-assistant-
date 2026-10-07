// @vitest-environment happy-dom
/**
 * P42.7 G4 — automatic same-train recovery display (BookKaro-native). Real component tree (TrainCard → SameTrainInline →
 * SameTrainOptionList) in happy-dom; the card payload comes from the REAL engine over mock test data; the network is a
 * mocked `fetch` (discover / select endpoints) — no provider, no credits. No tap is needed for the section to appear;
 * Select always goes to the backend's fresh recheck (the UI never applies anything itself).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { readFileSync } from 'node:fs';
import { TrainCard, trainNeedsRecovery } from '../../src/components/trains/TrainCard';
import { SameTrainOptionList, BFE_HEADING } from '../../src/components/trains/SameTrainInline';
import { runSameTrainSearch, type SameTrainDeps, type ProviderRef } from '../../server/railway/same-train/same-train-engine';
import { SAME_TRAIN_DEFAULT_LIMITS } from '../../shared/same-train-alternatives';
import { sameTrainCardData } from '../../server/railway/same-train/same-train-view';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const DATE = '2026-10-08';
const RC: ProviderRef = { id: 'railcore', label: 'RailCore', level: 'PROVIDER_API' };
const ROUTE49 = [['JAT', 'Jammu Tawi', '01:10'], ['PTKC', 'Pathankot Cantt', '03:05'], ['JUC', 'Jalandhar City', '04:40'], ['ASR', 'Amritsar Jn', '06:00'], ['LDH', 'Ludhiana Jn', '08:10'], ['UMB', 'Ambala Cant Jn', '09:40'], ['NDLS', 'New Delhi', '12:00']]
  .map(([station, stationName, departure]) => ({ station, stationName, departure }));
const P49 = (q: any): string => {
  if (q.origin === 'ASR' && q.destination === 'NDLS') return q.travelClass === 'SL' ? 'WL 1' : q.travelClass === '3A' ? 'WL 6' : 'AVAILABLE-0009';
  if (q.origin === 'JUC' && q.destination === 'NDLS') return ({ SL: 'AVAILABLE-0003', '3A': 'AVAILABLE-0004', '2A': 'RAC 4', '1A': 'GNWL 2' } as any)[q.travelClass];
  return 'GNWL 9';
};
async function engineCard(status: (q: any) => string = P49) {
  const deps: SameTrainDeps = {
    limits: { ...SAME_TRAIN_DEFAULT_LIMITS, perCallTimeoutMs: 150, totalTimeoutMs: 3000 },
    getRoute: async () => ({ ok: true, data: ROUTE49 }),
    checkAvailability: async (_p, q) => ({ ok: true, data: { trainNumber: q.trainNumber, travelClass: q.travelClass, date: q.date, status: status(q) } })
  };
  const r = await runSameTrainSearch({ sessionId: 's1', turnId: 't1', requestId: 'r1', journeyVersion: 1, trainNumber: '12414', trainName: 'Pooja SF Express', date: DATE,
    travelClass: 'SL', classes: ['SL', '3A', '2A', '1A'], passengersCount: 3, origin: 'ASR', destination: 'NDLS', originSweep: true, destinationSweep: true,
    combinedPairs: 'NEVER', includeFare: false, webEvidence: false, providers: [RC], routeProvider: RC, webProviders: [] } as any, deps);
  if (!r.ok) throw new Error(r.code);
  return sameTrainCardData(r.result, { stale: false }) as any;
}
const TRAIN = (classes: Array<[string, string]>) => ({ trainNumber: '12414', trainName: 'Pooja SF Express', origin: 'ASR', destination: 'NDLS', departure: '06:00', arrival: '12:00', duration: '6h 0m',
  classes: classes.map(([code, availability]) => ({ code, availability, availabilityStatus: 'UNKNOWN', fare: null, fareCurrency: null })) }) as any;
const ROW: Array<[string, string]> = [['SL', 'WL 1'], ['3A', 'WL 6'], ['2A', 'AVAILABLE-0009'], ['1A', 'AVAILABLE-0004']];

let root: Root; let host: HTMLElement; let fetchMock: ReturnType<typeof vi.fn>; let discoverCard: any; let handoffs: string[]; let ioBackup: any;
let version = 100;
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  ioBackup = (globalThis as any).IntersectionObserver; delete (globalThis as any).IntersectionObserver;   // useOnScreen → visible
  handoffs = [];
  fetchMock = vi.fn(async (url: string, init: any) => {
    const body = JSON.parse(init?.body || '{}');
    if (String(url).endsWith('/same-train-alternative/discover')) return { status: 200, json: async () => (discoverCard ? { ok: true, code: 'OK', card: discoverCard } : { ok: true, code: 'NO_VERIFIED_ALTERNATIVE' }), _body: body } as any;
    if (String(url).endsWith('/same-train-alternative/select')) return { status: 200, json: async () => ({ ok: true, applied: true, message: 'Fresh check: Jalandhar City → New Delhi SL AVAILABLE-0003. Ticket update ho gaya.', handoffText: 'SAME_TRAIN_APPLIED' }) } as any;
    throw new Error(`unexpected ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); if (ioBackup) (globalThis as any).IntersectionObserver = ioBackup; });
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
async function renderCard(classes = ROW, requestedClass: string | null = 'SL') {
  version += 1;                                     // fresh list version per test (module-level discovery memo is keyed by it)
  await act(async () => {
    root.render(React.createElement(TrainCard, { train: TRAIN(classes), onSelectTrain: () => {}, autoSameTrain: { sessionId: 'sess-1', searchResultsVersion: version, passengers: 3, requestedClass, onHandoff: (t: string) => handoffs.push(t) } }));
  });
  await flush();
}
const discoverCalls = () => fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/discover'));
const sti = () => host.querySelector('section.bk-sti') as HTMLElement | null;

describe('P42.7 G4 — automatic recovery display', () => {
  it('[G4.1] automatic section: SL WL 1 for 3 → the recovery section renders under the train card by itself', async () => {
    discoverCard = await engineCard();
    await renderCard();
    expect(sti()).not.toBeNull();
    expect(sti()!.getAttribute('aria-label')).toBe(BFE_HEADING);
    expect(host.querySelector('article.bk-train')!.contains(sti())).toBe(true);
  });

  it('[G4.2] no tap needed: discovery is requested on render (one call per train, requested class as context), no click happened', async () => {
    discoverCard = await engineCard();
    await renderCard();
    expect(discoverCalls()).toHaveLength(1);
    expect(JSON.parse(discoverCalls()[0][1].body)).toEqual({ trainNumber: '12414', travelClass: 'SL', searchResultsVersion: version });
  });

  it('[G4.3] no empty section: no verified option → nothing rendered; requested class sufficient → no discovery at all (2A / 1A AVL never suppress, SL sufficiency does)', async () => {
    discoverCard = await engineCard(() => 'GNWL 9');
    await renderCard();
    expect(sti()).toBeNull();
    expect(host.textContent).not.toMatch(/Same train ·/);
    fetchMock.mockClear();
    await renderCard([['SL', 'AVAILABLE-0005'], ['3A', 'WL 2']]);
    expect(discoverCalls()).toHaveLength(0);
    expect(trainNeedsRecovery(TRAIN(ROW).classes, 'SL', 3)).toBe(true);             // other classes AVL — still recovery
    expect(trainNeedsRecovery(TRAIN([['SL', 'RAC 2']]).classes, 'SL', 3)).toBe(false); // RAC stays RAC (usable)
    expect(trainNeedsRecovery(TRAIN([['SL', 'AVAILABLE-0002']]).classes, 'SL', 3)).toBe(true); // 2 < 3 passengers
    expect(trainNeedsRecovery(TRAIN([['SL', 'AVAILABLE-0009'], ['3A', 'WL 1']]).classes, null, 3)).toBe(true); // class unknown → any shortage
  });

  it('[G4.4] BookKaro-native styling: existing tokens / classes; header copy; never "Alternative trains" / RailBook copy', async () => {
    discoverCard = await engineCard();
    await renderCard();
    expect(host.querySelector('.bk-sti__head')!.textContent).toContain('Same train · pehle station se board karo');
    expect(host.textContent).not.toMatch(/Alternative trains|RailBook|best option|recommended/i);
    expect(host.querySelectorAll('.bk-sti__opt').length).toBeGreaterThan(0);
    const css = readFileSync('src/styles/bookkaro.css', 'utf8');
    const block = css.slice(css.indexOf('.bk-sti__opt { padding'), css.indexOf('.bk-sti__cls'));
    expect(block).toMatch(/var\(--r-md\)/); expect(block).toMatch(/var\(--navy-700\)/); expect(block).not.toMatch(/#[0-9a-f]{3,6}\b/i);   // tokens, no raw colours
  });

  it('[G4.5] train number and name in the section', async () => {
    discoverCard = await engineCard();
    await renderCard();
    const t = host.querySelector('.bk-sti__train')!;
    expect(t.querySelector('b')!.textContent).toBe('12414');
    expect(t.textContent).toContain('Pooja SF Express');
    expect(t.textContent).toMatch(/8 Oct · 3 passengers/);
  });

  it('[G4.6] ticket route: BOOK Jalandhar City → New Delhi (bookFrom → bookUpto), earlier pair listed first', async () => {
    discoverCard = await engineCard();
    await renderCard();
    const pairs = [...host.querySelectorAll('.bk-sti__pair')].map(e => e.textContent);
    expect(pairs[0]).toBe('BOOK Jalandhar City → New Delhi');
  });

  it('[G4.7] boarding: BOARD Jalandhar City with the authoritative departure; boarding rule shown as unverified (never "allowed")', async () => {
    discoverCard = await engineCard();
    await renderCard();
    const b = host.querySelector('.bk-sti__board')!;
    expect(b.textContent).toContain('BOARD Jalandhar City');
    expect(b.textContent).toContain('dep 04:40');
    expect(host.querySelector('.bk-sti__note')!.textContent).toBe('Amritsar Jn se boarding ka rule verify nahi hua');
    expect(host.textContent).not.toMatch(/boarding allowed|board kar sakte/i);
  });

  it('[G4.8] class chips per pair: verified classes only, requested class first (SL, 3A, 2A) — 1A GNWL and unverified states never become chips', async () => {
    discoverCard = await engineCard();
    await renderCard();
    const first = host.querySelector('.bk-sti__opt')!;
    expect([...first.querySelectorAll('.bk-sti__cls')].map(e => e.textContent)).toEqual(['SL', '3A', '2A']);
    expect(first.textContent).not.toMatch(/1A|GNWL|UNKNOWN|TIMEOUT|NOT_AVAILABLE|REGRET/);
  });

  it('[G4.9] AVL chips are green (bk-tag--good) with the authoritative count', async () => {
    discoverCard = await engineCard();
    await renderCard();
    const tags = [...host.querySelectorAll('.bk-sti__opt')[0].querySelectorAll('.bk-sti__chip .bk-tag')];
    expect(tags.slice(0, 2).map(t => `${t.className}|${t.textContent}`)).toEqual(['bk-tag bk-tag--good|AVL 3', 'bk-tag bk-tag--good|AVL 4']);
  });

  it('[G4.10] RAC chip stays RAC and amber (bk-tag--warn), still selectable', async () => {
    discoverCard = await engineCard();
    await renderCard();
    const chip = [...host.querySelectorAll('.bk-sti__opt')[0].querySelectorAll('.bk-sti__chip')].find(c => c.textContent!.startsWith('2A'))! as HTMLButtonElement;
    expect(chip.querySelector('.bk-tag')!.className).toBe('bk-tag bk-tag--warn');
    expect(chip.querySelector('.bk-tag')!.textContent).toBe('RAC 4');
    await act(async () => { chip.click(); });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect((host.querySelector('.bk-sti__use') as HTMLButtonElement).getAttribute('aria-label')).toBe('Select 2A JUC to NDLS');
  });

  it('[G4.11] Select button per pair, bound to the active chip (its own class); nothing is sent before the user acts', async () => {
    discoverCard = await engineCard();
    await renderCard();
    const btn = host.querySelector('.bk-sti__use') as HTMLButtonElement;
    expect(btn.textContent).toBe('Select');
    expect(btn.getAttribute('aria-label')).toBe('Select SL JUC to NDLS');
    expect(fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/select'))).toHaveLength(0);
  });

  it('[G4.12] Select → the backend fresh recheck (unverified boarding needs an explicit confirm), then the result message + handoff', async () => {
    discoverCard = await engineCard();
    await renderCard();
    await act(async () => { (host.querySelector('.bk-sti__use') as HTMLButtonElement).click(); });
    // boarding rule unverified → explicit confirm first (no request yet)
    expect(fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/select'))).toHaveLength(0);
    const yes = [...host.querySelectorAll('.bk-sta-confirm button')].find(b => b.textContent === 'Haan, aage badhein') as HTMLButtonElement;
    await act(async () => { yes.click(); });
    await flush();
    const sel = fetchMock.mock.calls.filter(c => String(c[0]).endsWith('/select'));
    expect(sel).toHaveLength(1);
    const sl = discoverCard.alternatives.find((a: any) => a.ticketOrigin === 'JUC' && a.travelClass === 'SL');
    expect(JSON.parse(sel[0][1].body)).toEqual({ alternativeSearchId: discoverCard.alternativeSearchId, alternativeId: sl.alternativeId, acknowledgeUnverifiedRules: true });
    expect(host.querySelector('.bk-sta-note')!.textContent).toContain('Fresh check');
    expect(handoffs).toEqual(['SAME_TRAIN_APPLIED']);
  });
});

describe('P42.7 G4 — option list markup (shared by the chat card)', () => {
  it('[G4.extra] the expanded chat card hides the train line (showTrain=false) but keeps pairs / chips / Select', async () => {
    const d = await engineCard();
    await act(async () => { root.render(React.createElement(SameTrainOptionList, { d, sessionId: 'sess-1', onHandoff: () => {}, requestedClass: 'SL', showTrain: false })); });
    expect(host.querySelector('.bk-sti__train')).toBeNull();
    expect(host.querySelector('.bk-sti__use')).not.toBeNull();
  });
});
