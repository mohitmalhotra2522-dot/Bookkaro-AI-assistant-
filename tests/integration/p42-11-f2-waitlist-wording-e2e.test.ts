/**
 * Post-P42.10 — F2 end to end (native Muse path, fake OpenAI-compatible server): a fresh CHECK_AVAILABILITY result
 * "Waitlist 12" + Muse wording "12 seats wait‑list mein" → that sentence never reaches the user (text or voice);
 * the rest of Muse's reply and the correct waitlist wording stay.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { RailwayToolRuntime } from '../../server/ai/tool-runtime/railway-tool-runtime';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('p4211-f2', () => new MockRailwayProvider());
const ist = (days: number) => new Date(Date.now() + 5.5 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
function stack(plan: Record<string, any[]>) {
  const fake = new FakeOpenAI((v: TurnView) => { const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P4211-F2', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any> };
}
const reply = (r: any) => String(r?.assistantResponse?.text ?? r?.voice?.assistantText ?? '');
const speech = (r: any) => String(r?.voice?.assistantText ?? '');
let fetchSpy: any;
beforeEach(() => { railwayRegistry.setActive('p4211-f2'); fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('Post-P42.10 F2 e2e — "N seats wait-list mein" never reaches the user', () => {
  for (const mode of ['TEXT', 'VOICE'] as const) {
    it(`[7] ${mode}: WL 12 result + "12 seats wait‑list mein" → sentence removed; correct wording + the rest kept`, async () => {
      const h = stack({
        'Kal Amritsar se Delhi': [{ calls: [{ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: D1 } }] }, { content: 'Kal ki trains mil gayi.' }],
        '12497 SL ki availability': [
          { calls: [U('SELECT_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'SL', selectionPurpose: 'BOOKING' })] },
          { calls: [{ name: 'CHECK_AVAILABILITY', args: { trainNumber: '12497', travelClass: 'SL' } }] },
          { content: '12497 ki SL class abhi wait\u2011list par hai \u2013 12 seats wait\u2011list mein. 12497 SL abhi wait\u2011list par hai. Kya aap 3A bhi dekhna chahenge?' }]
      });
      await h.say('Kal Amritsar se Delhi', mode);
      const r = await h.say('12497 SL ki availability', mode);
      const execs = ((r?.turnLog?.toolExecutions || []) as any[]).map(x => [x.tool, x.status]);
      expect(execs).toContainEqual(['CHECK_AVAILABILITY', 'SUCCEEDED']);
      for (const t of [reply(r), speech(r)].filter(Boolean)) {
        expect(t).not.toMatch(/\b12 seats\b/);
        expect(t).toMatch(/Kya aap 3A bhi dekhna chahenge\?/);
      }
      expect(reply(r)).toMatch(/wait.list par hai\./);
    }, 30000);
  }
});
