/**
 * P40 — shared handoff vectors for the Android native guard (Kotlin) ⇄ extension guard (JS).
 *
 * Creates a REAL signed IRCTC handoff through the existing flow (MockLLM + mock railway provider + IrctcHandoffManager),
 * derives valid / expired / stale / tampered / wrong-key / schema-invalid cases, and records what the extension's own
 * guard (extension/irctc-handoff-guard.js) answers for each. The Kotlin port must give the identical answer
 * (android/app/src/test/.../HandoffGuardVectorsTest.kt) and tests/unit/p40-android-bridge.test.ts re-checks the JS side.
 * Test data only (mock railway data, in-memory handoff, throw-away bridge token) — no secret, no real passenger.
 *
 *   ./node_modules/.bin/vite-node scripts/p40-android-vectors.ts
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';
import { webcrypto } from 'crypto';
import { MockLLMProvider } from '../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../server/ai/state/conversation-state';
import { RailwayToolService } from '../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../server/railway/registry/provider-registry';
import { canonicalJson } from '../shared/irctc-handoff';

const require = createRequire(import.meta.url);
const Guard = require('../extension/irctc-handoff-guard.js');
const OUT = resolve(__dirname, '../android/app/src/test/resources/p40-handoff-vectors.json');

async function main() {
  railwayRegistry.setActive('mock');
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
  const sid = state.createSession().sessionId;
  for (const t of ['Amritsar se Delhi kal 2 log', '12497', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female', 'haan book karo']) await orch.processTurn(sid, t, 'TEXT');
  const a = orch.preparation.irctcHandoffs.ownerAccess(state.getSession(sid), Date.now());
  if (!a) throw new Error('no handoff — flow did not reach IRCTC_HANDOFF_READY');
  const base = a.snapshot as any;
  const key = a.bridgeToken;
  const expected = { handoffId: base.handoffId, reviewVersion: a.view.reviewVersion };
  const created = Date.parse(base.createdAt);
  const now = created + 1000;
  const clone = () => JSON.parse(JSON.stringify(base));

  const cases: Array<{ name: string; snapshot: any; expected: any; key: string; now: number }> = [];
  const add = (name: string, snapshot: any, o: { expected?: any; key?: string; now?: number } = {}) =>
    cases.push({ name, snapshot, expected: o.expected ?? expected, key: o.key ?? key, now: o.now ?? now });

  add('valid', clone());
  add('expired_by_clock', clone(), { now: Date.parse(base.expiresAt) + 1 });
  add('expired_at_exact_expiry', clone(), { now: Date.parse(base.expiresAt) });
  add('stale_review_version', clone(), { expected: { ...expected, reviewVersion: expected.reviewVersion + 1 } });
  add('other_handoff_id', clone(), { expected: { ...expected, handoffId: 'irh_00000000-0000-4000-8000-000000000000' } });
  add('wrong_key_other_session', clone(), { key: 'f'.repeat(64) });
  add('invalid_signature', { ...clone(), integrity: '0'.repeat(64) });
  { const s = clone(); s.passengers[0].name = 'Mallory Evil'; add('tampered_passenger_name', s); }
  { const s = clone(); s.train.number = '12014'; add('tampered_train', s); }
  { const s = clone(); s.journey.dateIso = '2030-01-02'; s.journey.dateIrctc = '02/01/2030'; add('tampered_date', s); }
  { const s = clone(); s.travelClass = { code: 'EC', label: 'Exec. Chair Car (EC)' }; add('tampered_class', s); }
  { const s = clone(); s.status = 'STALE_HANDOFF'; add('backend_status_stale', s); }
  { const s = clone(); s.status = 'EXPIRED'; add('backend_status_expired', s); }
  { const s = clone(); s.status = 'COMPLETED'; add('backend_status_completed_passthrough', s); }
  { const s = clone(); s.extra = 'x'; add('unknown_key', s); }
  { const s = clone(); delete s.integrity; add('missing_integrity', s); }
  { const s = clone(); s.integrity = s.integrity.toUpperCase(); add('integrity_uppercase', s); }
  { const s = clone(); s.schemaVersion = 2; add('schema_version_2', s); }
  { const s = clone(); s.quota = { code: 'TQ', label: 'TATKAL' }; add('quota_not_general', s); }
  { const s = clone(); s.journey.dateIrctc = '2026/10/07'; add('date_format', s); }
  { const s = clone(); s.journey.to = { ...s.journey.from }; add('same_from_to', s); }
  { const s = clone(); s.travelClass.label = 'Sleeper (SL)'; add('class_label_mismatch', s); }
  { const s = clone(); s.passengers = s.passengers.slice().reverse(); add('passenger_order', s); }
  { const s = clone(); const p = s.passengers[0]; s.passengers = Array.from({ length: 7 }, (_, i) => ({ ...p, index: i + 1 })); add('seven_passengers', s); }
  { const s = clone(); s.passengers[0].gender = 'X'; add('passenger_gender', s); }
  { const s = clone(); s.passengers[0].age = 0; add('passenger_age_zero', s); }
  { const s = clone(); s.handoffId = 'irh_bad'; add('handoff_id_format', s); }
  add('not_an_object', 'hello');

  const results = [];
  for (const c of cases) {
    const r = await Guard.guardSnapshot(c.snapshot, c.expected, c.key, c.now, webcrypto.subtle);
    results.push({ ...c, result: r.ok ? { ok: true } : { ok: false, code: r.code, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) } });
  }

  const urls = ['https://www.irctc.co.in/nget/train-search', 'https://www.irctc.co.in/nget/booking/psgninput', 'https://www.irctc.co.in:443/nget/train-list',
    'https://WWW.IRCTC.CO.IN/nget/train-search', 'https://www.irctc.co.in/', 'https://www.irctc.co.in/eticketing/login', 'http://www.irctc.co.in/nget/train-search',
    'https://irctc.co.in/nget/train-search', 'https://www.irctc.co.in.attacker.example/nget/', 'https://evil.example/nget/train-search',
    'https://www.irctc.co.in:8443/nget/train-search', 'https://www.irctc.co.in/nget/../evil', 'http://localhost:3000/api/dev/mock-irctc/real-search',
    'http://127.0.0.1:3000/api/dev/mock-irctc', 'http://127.0.0.1:3000/api/dev/mock-irctcX', 'https://localhost:3000/api/dev/mock-irctc/real-search',
    'http://10.0.2.2:3000/api/dev/mock-irctc/real-search', 'javascript:alert(1)', 'file:///sdcard/x.html', 'not a url'];
  const urlCases = urls.map(url => ({ url, result: Guard.isApprovedIrctcPage(url) }));

  const canonicalInputs: any[] = [
    { b: 1, a: [3, 'x', null, true], c: { z: 'ü', y: 'नमस्ते' } },
    { q: 'quote " back \\ slash / nl \n tab \t cr \r bs \b ff \f ctl \u0001 \u001f' },
    { emoji: '🚆 train', n: [0, -5, 31, 1000000, 125] },
    { k10: 1, k2: 2, K: 3, _: 4, 'é': 5, '': 6 }
  ];
  const canonicalCases = canonicalInputs.map(input => ({ input, canonical: canonicalJson(input) }));

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ _note: 'P40 generated by scripts/p40-android-vectors.ts from the real backend + extension guard. Test data only.', integrityPayloadOfValid: Guard.integrityPayload(base), cases: results, urlCases, canonicalCases }, null, 1) + '\n');
  console.log(`wrote ${results.length} guard cases, ${urlCases.length} url cases, ${canonicalCases.length} canonical cases → ${OUT}`);
  console.log(results.map(r => `${r.name}: ${r.result.ok ? 'OK' : r.result.reason + (r.result.detail ? '/' + r.result.detail : '')}`).join('\n'));
}
main().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
