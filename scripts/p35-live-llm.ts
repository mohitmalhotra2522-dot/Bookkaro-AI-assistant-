/**
 * Prompt 35 — LIVE end-to-end: the REAL LLM (env LLM_*) + the REAL railway provider chain (RailCore → RailKit →
 * RailRadar). Spends real LLM + provider credits — run deliberately, never in the gates.
 *   ./node_modules/.bin/vite-node scripts/p35-live-llm.ts
 * Writes docs/p35-live-llm-results.json (no keys; passenger names redacted).
 */
import '../server/config/load-dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { ConversationStateManager } from '../server/ai/state/conversation-state';
import { RailwayToolService } from '../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../server/railway/registry/provider-registry';
import { createLLMProvider } from '../server/ai/providers/llm-provider-factory';
import { createFailoverProvider } from '../server/railway/providers/live/live-config';
import type { FetchLike } from '../server/railway/providers/live/live-http';

const ROOT = path.resolve(__dirname, '..');
const KEYS = ['RAILCORE_API_KEY', 'RAILKIT_API_KEY', 'RAILRADAR_API_KEY', 'LLM_API_KEY'].map(k => process.env[k]).filter((v): v is string => !!v && v.length > 8);

// ---- instrumentation (counts only; never records headers / bodies) ----
let providerCalls: string[] = [];
const providerFetch: FetchLike = async (url, init) => {
  const u = new URL(url); providerCalls.push(`${u.hostname.split('.').slice(-2, -1)[0].toUpperCase()} ${u.pathname}`);
  const r = await fetch(url, init as any); const body = await r.text();
  return { status: r.status, text: async () => body } as any;
};
railwayRegistry.register('p35-live-instrumented', () => createFailoverProvider(process.env, providerFetch));
railwayRegistry.setActive('p35-live-instrumented');

let llmCalls = 0, llmMs = 0;
const llmFetch = (async (url: any, init: any) => { llmCalls++; const t0 = Date.now(); try { return await fetch(url, init); } finally { llmMs += Date.now() - t0; } }) as any;
const sel = createLLMProvider(process.env as any, { fetch: llmFetch });
if (sel.info.providerId === 'mock' || !sel.info.configured) { console.error('Real LLM not configured — aborting (no MOCK run is reported as LIVE).'); process.exit(1); }

const state = new ConversationStateManager();
const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
const redact = (s: string) => { let x = String(s || '').replace(/\b(Rahul|Neha)\b/g, '[PASSENGER]'); for (const k of KEYS) x = x.split(k).join('***'); return x; };

interface Row { id: string; mode: string; request: string; model: string | null; latencyMs: number; llmCalls: number; llmMs: number; toolCalls: string[]; providerCalls: string[]; fallbacks: string[]; finalResult: string; bookingState: string; errors: string[] }
const rows: Row[] = [];

async function turn(id: string, sid: string, text: string, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  providerCalls = []; llmCalls = 0; llmMs = 0;
  const t0 = Date.now();
  let r: any; const errors: string[] = [];
  try { r = await eng.processTurn(sid, text, mode); } catch (e: any) { errors.push(`THROW ${String(e?.message || e).slice(0, 120)}`); }
  const execs: any[] = r?.turnLog?.toolExecutions || [];
  const row: Row = {
    id, mode, request: text, model: sel.info.model || null, latencyMs: Date.now() - t0, llmCalls, llmMs,
    toolCalls: execs.map(e => `${e.tool}:${e.outcome ?? e.status}${e.dataSource ? `/${e.dataSource}` : ''}${e.provider ? `@${String(e.provider).toUpperCase()}` : ''}`),
    providerCalls: [...providerCalls],
    fallbacks: execs.filter(e => e.fallbackUsed).map(e => `${e.tool}: ${(e.providerAttempts || []).map((a: any) => `${a.provider}:${a.outcome}`).join(' → ')}`),
    finalResult: redact(r?.voice?.assistantText || r?.responseMessage || '').slice(0, 400),
    bookingState: String(state.getSession(sid).bookingState),
    errors: [...errors, ...(r?.error?.code ? [String(r.error.code)] : [])]
  };
  rows.push(row);
  console.log(`\n[LIVE ${id}] (${mode}) USER: ${text}\n  BOT: ${row.finalResult}\n  model=${row.model} latency=${row.latencyMs}ms llmCalls=${row.llmCalls} (${row.llmMs}ms) tools=[${row.toolCalls.join(', ')}] provider=[${row.providerCalls.join(', ')}] fallbacks=[${row.fallbacks.join('; ')}] state=${row.bookingState} errors=[${row.errors.join(', ')}]`);
  return r;
}

async function main() {
  console.log(`P35 LIVE LLM TEST — model ${sel.info.model} (${sel.info.providerId}); railway = live failover chain`);
  const s1 = state.createSession().sessionId;
  await turn('A', s1, 'RAC kya hota hai?');
  await turn('B', s1, 'Kal Amritsar se Delhi jaana hai');
  await turn('C', s1, 'Doosri wali ka 3A availability batao');
  await turn('D', s1, 'Uska fare batao');
  await turn('E', s1, 'Kaunsi sabse jaldi Delhi pahunchti hai?');
  await turn('F', s1, 'Kal nahi, parso');
  await turn('G', s1, 'Abhi dobara availability check karo');
  const s2 = state.createSession().sessionId;                         // K: voice parity for B
  await turn('K', s2, 'Kal Amritsar se Delhi jaana hai', 'VOICE');
  const s3 = state.createSession().sessionId;                         // L: booking up to the handoff
  await turn('L1', s3, 'Kal Amritsar se Delhi jaana hai');
  await turn('L2', s3, 'Doosri wali CC mein, do log: Rahul 31 male, Neha 28 female');
  await turn('L3', s3, 'haan confirm');
  await turn('L4', s3, 'ab book kar do');
  const out = { kind: 'LIVE', ranAt: new Date().toISOString(), model: sel.info.model, rows };
  const json = JSON.stringify(out, null, 1);
  for (const k of KEYS) if (json.includes(k)) throw new Error('KEY IN REPORT — aborting');
  fs.writeFileSync(path.join(ROOT, 'docs/p35-live-llm-results.json'), json);
}
main().catch(e => { console.error('FAILED', redact(String(e?.message || e))); process.exit(1); });
