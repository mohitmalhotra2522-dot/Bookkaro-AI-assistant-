/**
 * P39 — G2 (unit): API-first web fallback — ConfirmTkt running-status parser, verified capability matrix,
 * WEB_ACCESS_BLOCKED resolution, WebRailwayResult envelope + freshness labels, enable flags, LLM source labels.
 * No network: every fetch is a fixture.
 */
import { describe, it, expect } from 'vitest';
import {
  parseConfirmTktLive, confirmTktTime, ConfirmTktWebProvider, WEB_SOURCE_CAPABILITIES, blockedWebCapability, webCapabilityMatrix,
  toWebRailwayResult, enabledWebConnectors, WEB_CAPABILITY_MATRIX
} from '../../server/railway/providers/web/web-providers';
import { providerToolCatalog, providerStatusOf } from '../../server/ai/tools/provider-tools';
import '../../server/railway/registry/provider-registry';   // installs the blocked-capability lookup
import { sourceLabelOf } from '../../server/ai/providers/openai-compatible-llm';
import { normalizeTrackResponse } from '../../server/booking/post-booking/pnr-status-service';
import { factFromTool } from '../../server/ai/context/response-formatter';
import { NATIVE_AGENT_SYSTEM_PROMPT } from '../../server/ai/prompts/system-prompt';

const FIXTURE = `<html><body><h1>12014 Running Status</h1>
<script>var data = {"TrainName":"Amritsar Shtabdi","TrainNo":"12014","Classes":["CC","EC"],"Schedule":[]};
</script>
<div>Last Updated:&nbsp;05 Oct 2026 10:51</div>
<div class="row rs__station-row"><svg class="bi bi-check-circle"></svg><span class="rs__station-name">Amritsar Jn</span><span>Day 1</span><div class="rs__station-delay rs__station-delay--no">Right Time</div></div>
<div class="row rs__station-row"><svg class="bi bi-check-circle"></svg><span class="rs__station-name">Ludhiana Jn</span><span>Day 1</span><div class="rs__station-delay">Delay by 7 min</div></div>
<div class="row rs__station-row"><span class="rs__station-name">Ambala Cant Jn</span><div class="rs__station-delay">Delay by 5 min</div></div>
<div class="row rs__station-row"><span class="rs__station-name">New Delhi</span><div class="rs__station-delay"></div></div>
<div class="well well-sm">Not affiliated with Indian Railways.</div></body></html>`;

describe('P39 G2 — ConfirmTkt running status (robots-allowed public page)', () => {
  it('[1] parses last passed station, delay, next station, source time and train name — nothing invented', () => {
    const d: any = parseConfirmTktLive(FIXTURE, '12014');
    expect(d.trainName).toBe('Amritsar Shtabdi');
    expect(d.currentStationName).toBe('Ludhiana Jn');
    expect(d.delayMinutes).toBe(7);
    expect(d.nextStationName).toBe('Ambala Cant Jn');
    expect(d.lastUpdated).toBe(confirmTktTime('05 Oct 2026 10:51'));
    expect(d.lastUpdated).toMatch(/^2026-10-05 10:51/);
    expect(d.sourceNote).toMatch(/unverified/i);
    expect(d).not.toHaveProperty('platform');
    expect(d).not.toHaveProperty('fare');
  });

  it('[2] mismatched train / empty page throw instead of returning a guess', () => {
    expect(() => parseConfirmTktLive(FIXTURE, '12013')).toThrow();
    expect(() => parseConfirmTktLive('<html>nothing</html>', '12014')).toThrow();
  });

  it('[3] provider: fetches only /train-running-status/{n}; not-found is honest; normalized result keeps the ConfirmTkt label', async () => {
    const urls: string[] = [];
    const p = new ConfirmTktWebProvider({ timeoutMs: 2000, fetchImpl: (async (u: string) => { urls.push(String(u)); return { ok: true, status: 200, text: async () => (String(u).includes('99999') ? '<html></html>' : FIXTURE) }; }) as any });
    const r: any = await p.trackTrain({ trainNumber: '12014' } as any);
    expect(r.ok).toBe(true);
    expect(urls).toEqual(['https://www.confirmtkt.com/train-running-status/12014']);
    const nf: any = await p.trackTrain({ trainNumber: '99999' } as any);
    expect(nf.ok).toBe(false); expect(nf.error.code).toBe('NOT_FOUND');
    const bad: any = await p.trackTrain({ trainNumber: '12' } as any);
    expect(bad.ok).toBe(false);
    const n: any = normalizeTrackResponse(r, '12014', { providerId: 'confirmtkt', source: 'web', latencyMs: 1 } as any);
    expect(n.ok).toBe(true);
    expect(n.data.verification).toBe('UNVERIFIED_WEB');
    const txt = factFromTool('TRACK_TRAIN', n.data, 'TEXT');
    expect(txt).toMatch(/ConfirmTkt website — unverified/);
    expect(txt).toMatch(/as of 10:51/);
    expect(txt).not.toMatch(/RailYatri/);
    expect((normalizeTrackResponse(nf, '99999', { providerId: 'confirmtkt', source: 'web', latencyMs: 1 } as any) as any).error.code).toBe('LIVE_STATUS_NOT_FOUND');
  });
});

describe('P39 G2 — verified capability matrix + WEB_ACCESS_BLOCKED', () => {
  it('[4] matrix: only verified capabilities are IMPLEMENTED; availability / fare / PNR never available from the web', () => {
    const impl = WEB_SOURCE_CAPABILITIES.filter(c => c.status === 'IMPLEMENTED').map(c => `${c.source}:${c.capability}`).sort();
    expect(impl).toEqual(['confirmtkt:TRACK_TRAIN', 'erail:SEARCH_TRAINS', 'railyatri:TRACK_TRAIN']);
    for (const c of WEB_SOURCE_CAPABILITIES) if (['CHECK_AVAILABILITY', 'GET_FARE', 'CHECK_PNR'].includes(c.capability)) expect(c.available).toBe(false);
    expect(blockedWebCapability('confirmtkt', 'CHECK_PNR')?.status).toBe('BLOCKED_BY_ROBOTS');
    expect(blockedWebCapability('confirmtkt', 'SEARCH_TRAINS')?.status).toBe('BLOCKED_BY_ROBOTS');
    expect(blockedWebCapability('railyatri', 'CHECK_AVAILABILITY')?.status).toBe('PRIVATE_API');
    expect(blockedWebCapability('erail', 'CHECK_AVAILABILITY')?.status).toBe('BLOCKED_BY_ROBOTS');
    expect(blockedWebCapability('erail', 'SEARCH_TRAINS')).toBeNull();
    expect(Object.keys(WEB_CAPABILITY_MATRIX.confirmtkt)).toEqual(['TRACK_TRAIN']);
    const m = webCapabilityMatrix(['erail']);
    expect(m.find(x => x.source === 'erail')!.enabled).toBe(true);
    expect(m.find(x => x.source === 'confirmtkt')!.enabled).toBe(false);
  });

  it('[5] ConfirmTkt may be registered ONLY for TRACK_TRAIN; blocked capabilities resolve to BLOCKED (never fetched)', () => {
    expect(() => providerToolCatalog.register({ id: 'confirmtkt', label: 'ConfirmTkt', registryId: 'confirmtkt', capabilities: ['SEARCH_TRAINS'] } as any)).toThrow();
    expect(() => providerToolCatalog.register({ id: 'confirmtkt', label: 'ConfirmTkt', registryId: 'mock', capabilities: ['TRACK_TRAIN'] } as any)).toThrow();
    providerToolCatalog.register({ id: 'confirmtkt', label: 'ConfirmTkt (web)', registryId: 'confirmtkt', capabilities: ['TRACK_TRAIN'] } as any);
    try {
      expect(providerToolCatalog.resolve('confirmtkt_live_status')).toMatchObject({ kind: 'PROVIDER_TOOL', canonical: 'TRACK_TRAIN' });
      expect(providerToolCatalog.resolve('confirmtkt_pnr')).toMatchObject({ kind: 'BLOCKED', status: 'BLOCKED_BY_ROBOTS' });
      expect(providerToolCatalog.resolve('confirmtkt_availability')).toMatchObject({ kind: 'BLOCKED', status: 'NO_PUBLIC_PAGE' });
      expect(providerStatusOf({ ok: false, error: { code: 'WEB_ACCESS_BLOCKED' } })).toBe('WEB_ACCESS_BLOCKED');
    } finally { providerToolCatalog.unregister('confirmtkt'); }
    expect(providerToolCatalog.resolve('confirmtkt_search')).toMatchObject({ kind: 'NOT_IMPLEMENTED' });
  });
});

describe('P39 G2 — WebRailwayResult envelope, freshness, flags, labels', () => {
  const now = new Date('2026-10-05T06:00:00Z');
  it('[6] freshness: WEB_REPORTED_TIME / WEB_CURRENT / WEB_UNAVAILABLE; status mapping; url reference', () => {
    const a = toWebRailwayResult('confirmtkt', 'TRACK_TRAIN', { ok: true, data: { lastUpdated: '2026-10-05 10:51:00 +0530' } }, { trainNumber: '12014' }, now);
    expect(a).toMatchObject({ status: 'SUCCESS', freshness: 'WEB_REPORTED_TIME', sourceReportedAt: '2026-10-05 10:51:00 +0530', verification: 'UNVERIFIED_WEB', fetchedAt: now.toISOString(),
      urlReference: 'https://www.confirmtkt.com/train-running-status/12014' });
    expect(toWebRailwayResult('erail', 'SEARCH_TRAINS', { ok: true, data: { trains: [1] } }, { origin: 'ASR', destination: 'NDLS' }, now).freshness).toBe('WEB_CURRENT');
    expect(toWebRailwayResult('railyatri', 'TRACK_TRAIN', { ok: true, data: {} }, {}, now).freshness).toBe('WEB_UNVERIFIED');
    const t = toWebRailwayResult('erail', 'SEARCH_TRAINS', { ok: false, error: { code: 'PROVIDER_TIMEOUT' } }, {}, now);
    expect(t).toMatchObject({ status: 'TIMEOUT', freshness: 'WEB_UNAVAILABLE' });
    expect(toWebRailwayResult('confirmtkt', 'CHECK_PNR' as any, { ok: false, error: { code: 'WEB_ACCESS_BLOCKED' } }, {}, now).status).toBe('BLOCKED');
    expect(toWebRailwayResult('erail', 'SEARCH_TRAINS', { ok: true, empty: true, data: {} }, {}, now).status).toBe('NO_RESULT');
  });

  it('[7] enable flags: default all three; master switch and per-source switches', () => {
    expect(enabledWebConnectors({} as any)).toEqual(['erail', 'railyatri', 'confirmtkt']);
    expect(enabledWebConnectors({ WEB_RAILWAY_ENABLED: 'false' } as any)).toEqual([]);
    expect(enabledWebConnectors({ CONFIRMTKT_WEB_ENABLED: 'false' } as any)).toEqual(['erail', 'railyatri']);
    expect(enabledWebConnectors({ RAILWAY_WEB_CONNECTORS: 'none' } as any)).toEqual([]);
    expect(enabledWebConnectors({ RAILWAY_WEB_CONNECTORS: 'erail,bogus' } as any)).toEqual(['erail']);
  });

  it('[8] LLM labels: live API = LIVE_API, MOCK never LIVE_API, web carries envelope + the API failures of this turn', () => {
    expect(sourceLabelOf('railcore_availability', { toolName: 'CHECK_AVAILABILITY', ok: true, dataSource: 'LIVE' }, [])).toEqual({ sourceLabel: 'LIVE_API' });
    expect(sourceLabelOf('railcore_availability', { toolName: 'CHECK_AVAILABILITY', ok: true, dataSource: 'MOCK' }, [])).toEqual({});
    const steps = [{ toolCalls: [{ callId: 'a', name: 'railcore_search' }, { callId: 'b', name: 'railradar_search' }, { callId: 'c', name: 'erail_search', arguments: { origin: 'ASR', destination: 'NDLS' } }],
      results: [{ callId: 'a', ok: false, toolName: 'SEARCH_TRAINS', error: { code: 'PROVIDER_TIMEOUT' } }, { callId: 'b', ok: false, toolName: 'SEARCH_TRAINS', error: { code: 'AUTH_ERROR' } }, { callId: 'c', ok: true, toolName: 'SEARCH_TRAINS' }] }];
    const l: any = sourceLabelOf('erail_search', { toolName: 'SEARCH_TRAINS', ok: true, data: { trains: [] } }, steps);
    expect(l.verification).toBe('UNVERIFIED_WEB');
    expect(l.sourceLabel).toMatch(/eRail/);
    expect(l.webResult).toMatchObject({ source: 'erail', capability: 'SEARCH_TRAINS', freshness: 'WEB_CURRENT' });
    expect(l.priorApiFailures).toEqual([{ provider: 'railcore', code: 'PROVIDER_TIMEOUT' }, { provider: 'railradar', code: 'AUTH_ERROR' }]);
    expect(sourceLabelOf('confirmtkt_live_status', { toolName: 'TRACK_TRAIN', ok: true, data: { lastUpdated: 'x' } }, []) as any).toMatchObject({ freshness: 'WEB_REPORTED_TIME' });
  });

  it('[9] the prompt carries the fallback / freshness / conflict / blocked / IRCTC handoff rules', () => {
    const P = NATIVE_AGENT_SYSTEM_PROMPT.replace(/\s+/g, ' ');
    expect(P).toContain('confirmtkt_live_status');
    expect(P).toContain('RailCore aur RailRadar se live availability verify nahi ho paayi. eRail par available information mili hai; source web data hai.');
    expect(P).toContain('WEB_ACCESS_BLOCKED');
    expect(P).toContain('sourceConflict');
    expect(P).toMatch(/"abhi", "current", "latest", "dobara"/);
    expect(P).toMatch(/IRCTC par le chalo/);
    expect(P).toMatch(/never calculate, estimate or infer a fare/);
  });
});
