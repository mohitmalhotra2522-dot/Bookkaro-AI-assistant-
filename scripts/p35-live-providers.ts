/**
 * Prompt 35 — LIVE provider test (REAL network calls; spends real provider credits — run deliberately, not in gates).
 *   ./node_modules/.bin/vite-node scripts/p35-live-providers.ts
 * Writes docs/p35-live-provider-results.json and trimmed real fixtures under tests/fixtures/p35/ (no keys, no PII:
 * headers are never recorded, only public train data bodies are trimmed and saved).
 */
import '../server/config/load-dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { createLiveProvider, createFailoverProvider, parseProviderChain } from '../server/railway/providers/live/live-config';
import type { FetchLike } from '../server/railway/providers/live/live-http';
import type { LiveProviderId } from '../server/railway/providers/live/provider-capabilities';

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(ROOT, 'tests/fixtures/p35');
fs.mkdirSync(FIX, { recursive: true });
const KEYS = ['RAILCORE_API_KEY', 'RAILKIT_API_KEY', 'RAILRADAR_API_KEY', 'LLM_API_KEY'].map(k => process.env[k]).filter((v): v is string => !!v && v.length > 8);

const ORIGIN = 'ASR', DEST = 'NDLS', TRAIN = '12014', CLASS = 'CC';
const KAL = process.env.P35_DATE || '2026-10-05';

let lastRaw: { url: string; status: number; body: string } | null = null;
let networkCalls = 0;
const recordingFetch: FetchLike = async (url, init) => {
  networkCalls++;
  const res = await fetch(url, init as any);
  const body = await res.text();
  lastRaw = { url: redactUrl(url), status: res.status, body };
  return { ok: res.ok, status: res.status, headers: res.headers as any, text: async () => body, json: async () => JSON.parse(body) } as any;
};
function redactUrl(u: string): string { let s = u.replace(/([?&](api_?key|key|token)=)[^&]+/gi, '$1***'); for (const k of KEYS) s = s.split(k).join('***'); return s; }
function endpointOf(u: string): string { try { const x = new URL(u); return x.pathname; } catch { return u; } }
function trim(v: any, depth = 0): any {
  if (Array.isArray(v)) return v.slice(0, depth === 0 ? 3 : 4).map(x => trim(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
  return v;
}
function saveFixture(name: string) {
  if (!lastRaw) return;
  let parsed: any; try { parsed = JSON.parse(lastRaw.body); } catch { return; }
  const out = JSON.stringify({ _note: 'P35 REAL provider sample (trimmed). Captured ' + new Date().toISOString(), status: lastRaw.status, endpoint: endpointOf(lastRaw.url), body: trim(parsed) }, null, 1);
  for (const k of KEYS) if (out.includes(k)) throw new Error('KEY IN FIXTURE — aborting');
  fs.writeFileSync(path.join(FIX, `${name}.json`), out);
}

interface Row { provider: string; endpoint: string; capability: string; result: string; latencyMs: number | null; dataSource: string; fallbackUsed: string; error: string | null; network: boolean; summary?: string }
const rows: Row[] = [];

async function call(id: LiveProviderId, capability: string, fn: (p: any) => Promise<any>, summarize: (d: any) => string, fixture?: string) {
  const p = createLiveProvider(id, process.env, recordingFetch);
  lastRaw = null;
  const before = networkCalls;
  const t0 = Date.now();
  let r: any;
  try { r = await fn(p); } catch (e: any) { r = { ok: false, error: { code: 'SCRIPT_ERROR', message: String(e?.message || e).slice(0, 120) } }; }
  const network = networkCalls > before;
  rows.push({
    provider: id.toUpperCase(), endpoint: lastRaw ? `${endpointOf(lastRaw.url)} → HTTP ${lastRaw.status}` : '—', capability,
    result: r.ok ? 'DATA' : r.error?.code || 'ERROR', latencyMs: network ? (r.meta?.latencyMs ?? Date.now() - t0) : null,
    dataSource: network ? (r.ok ? 'LIVE' : 'LIVE (error)') : 'NOT RUN', fallbackUsed: 'no (single provider)', error: r.ok ? null : `${r.error?.code}${r.error?.httpStatus ? ` (HTTP ${r.error.httpStatus})` : ''}`,
    network, summary: r.ok ? summarize(r.data) : undefined
  });
  if (r.ok && fixture) saveFixture(fixture);
  return r;
}

async function main() {
  console.log(`P35 LIVE PROVIDER TEST — real network. Route ${ORIGIN}→${DEST} ${KAL}; train ${TRAIN} ${CLASS}. Chain: ${parseProviderChain().join(' → ')}`);
  for (const id of ['railcore', 'railkit', 'railradar'] as LiveProviderId[]) {
    await call(id, 'SEARCH_TRAINS', p => p.searchTrains({ origin: ORIGIN, destination: DEST, date: KAL }), d => `${d.trains?.length ?? 0} trains; first ${d.trains?.[0]?.trainNumber} ${d.trains?.[0]?.departure}→${d.trains?.[0]?.arrival}`, `${id}-search`);
    await call(id, 'CHECK_AVAILABILITY', p => p.checkAvailability({ trainNumber: TRAIN, travelClass: CLASS, date: KAL, origin: ORIGIN, destination: DEST }), d => `${d.status}${d.statusText ? ` (${d.statusText})` : ''}`, `${id}-availability`);
    await call(id, 'GET_FARE', p => p.getFare({ trainNumber: TRAIN, travelClass: CLASS, passengersCount: 1, date: KAL, origin: ORIGIN, destination: DEST }), d => `₹${d.perPassenger ?? d.total} per passenger`, `${id}-fare`);
    await call(id, 'GET_TRAIN_INFO', p => p.getTrainInfo({ trainNumber: TRAIN }), d => `${d?.trainNumber} ${d?.trainName ?? ''} classes=${(d?.classes || []).map((c: any) => c?.classCode ?? c?.code ?? c).join('/')}`, `${id}-info`);
    await call(id, 'GET_TIMETABLE', p => p.getTimetable({ trainNumber: TRAIN }), d => `${Array.isArray(d) ? d.length : d?.stops?.length ?? 0} stops`, `${id}-timetable`);
    await call(id, 'TRACK_TRAIN', p => p.trackTrain({ trainNumber: TRAIN }), d => `${d.currentStatus ?? d.status ?? ''} ${d.currentStationCode ?? ''} delay=${d.delayMinutes ?? 'n/a'}`, `${id}-track`);
  }
  // Freshness: "dobara check karo" = a second, independent network call (no cache)
  const n0 = networkCalls;
  await call('railcore', 'CHECK_AVAILABILITY (repeat — freshness)', p => p.checkAvailability({ trainNumber: TRAIN, travelClass: CLASS, date: KAL, origin: ORIGIN, destination: DEST }), d => `${d.status}${d.statusText ? ` (${d.statusText})` : ''}`);
  const freshCall = networkCalls > n0;
  // Real chain through the failover provider (primary answers → no fallback expected)
  const fo = createFailoverProvider(process.env, recordingFetch);
  const t0 = Date.now();
  const r = await fo.searchTrains({ origin: ORIGIN, destination: DEST, date: KAL });
  rows.push({ provider: 'FAILOVER CHAIN', endpoint: (r.meta as any)?.attempts?.map((a: any) => `${a.provider}:${a.outcome}`).join(' → ') || '—', capability: 'SEARCH_TRAINS', result: r.ok ? 'DATA' : r.error?.code || 'ERROR', latencyMs: Date.now() - t0, dataSource: r.ok ? 'LIVE' : 'LIVE (error)', fallbackUsed: String(!!(r.meta as any)?.fallbackUsed), error: r.ok ? null : r.error?.code || null, network: true, summary: r.ok ? `served by ${r.meta.providerId}; ${(r.data as any).trains.length} trains` : undefined });

  const out = { kind: 'LIVE', ranAt: new Date().toISOString(), route: `${ORIGIN}-${DEST}`, date: KAL, train: TRAIN, travelClass: CLASS, freshRepeatMadeNetworkCall: freshCall, totalNetworkCalls: networkCalls, rows };
  const json = JSON.stringify(out, null, 1);
  for (const k of KEYS) if (json.includes(k)) throw new Error('KEY IN REPORT — aborting');
  fs.writeFileSync(path.join(ROOT, 'docs/p35-live-provider-results.json'), json);
  for (const x of rows) console.log(`[LIVE] ${x.provider.padEnd(14)} | ${x.capability.padEnd(38)} | ${x.endpoint.padEnd(52)} | ${x.result.padEnd(22)} | ${String(x.latencyMs ?? '—').padStart(5)} ms | ${x.dataSource.padEnd(12)} | fb=${x.fallbackUsed} | ${x.error ?? ''} ${x.summary ?? ''}`);
  console.log(`fresh repeat made a network call: ${freshCall}; total network calls: ${networkCalls}`);
}
main().catch(e => { console.error('FAILED', String(e?.message || e)); process.exit(1); });
