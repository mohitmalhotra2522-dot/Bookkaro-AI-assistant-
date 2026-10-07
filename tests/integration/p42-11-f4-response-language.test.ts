/**
 * Post-P42.10 — Group 4 (F4): response language / SCRIPT follows the user's active style (no hardcoded language).
 * Real orchestrator + turn engine, fake OpenAI-compatible server plays Muse (captures the context it receives).
 *   [1] Roman Hinglish → replyLanguage HINGLISH + replyScript ROMAN        [2] English → ENGLISH / ROMAN
 *   [3] Devanagari Hindi → HINDI / DEVANAGARI (allowed)                     [4] mixed Hinglish conversation → consistent style
 *   [5] text / voice parity — same words, same language + script; the same prompt rule for both
 *   [prompt] the script rule is explicit and backend messages are never a script source
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
import { NATIVE_AGENT_SYSTEM_PROMPT } from '../../server/ai/prompts/system-prompt';
import { replyScriptOf } from '../../server/ai/providers/openai-compatible-llm';
import { ToolCallValidator } from '../../server/ai/tools/tool-call-validator';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('p4211-f4', () => new MockRailwayProvider());
const ist = (days: number) => new Date(Date.now() + 5.5 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
function stack() {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); return { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P4211-F4', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { fake, views, say: (t: string, mode: 'TEXT' | 'VOICE' = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any> };
}
/** the language / script fields of the context JSON Muse received for that user message */
const style = (h: ReturnType<typeof stack>, user: string) => { const c = h.views.filter(x => x.user === user).at(-1)!.context; return [c.replyLanguage, c.replyScript]; };
const sysPrompt = (h: ReturnType<typeof stack>) => String(h.fake.decisionRequests.at(-1)!.body.messages[0].content);
let fetchSpy: any;
beforeEach(() => { railwayRegistry.setActive('p4211-f4'); fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('Post-P42.10 G4 (F4) — response language follows the active user style', () => {
  it('[prompt] explicit script rule: Hinglish in Roman letters, Devanagari only for Devanagari users, never copy backend script', () => {
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/context\.replyScript/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/HINGLISH → Hindi\/English in ROMAN letters \("12716 mein SL available hai"\), never Devanagari/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/HINDI \(the user wrote Devanagari\) → Devanagari is fine/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/never copy their script/);
    expect(replyScriptOf('HINGLISH')).toBe('ROMAN'); expect(replyScriptOf('ENGLISH')).toBe('ROMAN'); expect(replyScriptOf('HINDI')).toBe('DEVANAGARI');
  });

  it('[1] Roman Hinglish input → HINGLISH + ROMAN', async () => {
    const h = stack();
    await h.say('Abhi availability check karo.');
    expect(style(h, 'Abhi availability check karo.')).toEqual(['HINGLISH', 'ROMAN']);
    await h.say('12716 SL mein');
    expect(style(h, '12716 SL mein')).toEqual(['HINGLISH', 'ROMAN']);
  }, 30000);

  it('[2] English input → ENGLISH + ROMAN', async () => {
    const h = stack();
    await h.say('Which train reaches Delhi earliest tomorrow?');
    expect(style(h, 'Which train reaches Delhi earliest tomorrow?')).toEqual(['ENGLISH', 'ROMAN']);
  }, 30000);

  it('[3] Devanagari Hindi input → HINDI + DEVANAGARI (allowed)', async () => {
    const h = stack();
    await h.say('कल अमृतसर से दिल्ली की ट्रेन दिखाओ');
    expect(style(h, 'कल अमृतसर से दिल्ली की ट्रेन दिखाओ')).toEqual(['HINDI', 'DEVANAGARI']);
  }, 30000);

  it('[4] mixed Hinglish conversation: a style-neutral message ("12497", "CC") keeps the active Hinglish / Roman style', async () => {
    const h = stack();
    await h.say('Kal Amritsar se Delhi jaana hai');
    await h.say('12497');
    expect(style(h, '12497')).toEqual(['HINGLISH', 'ROMAN']);
    await h.say('CC');
    expect(style(h, 'CC')).toEqual(['HINGLISH', 'ROMAN']);
    await h.say('please check availability for it');                                                     // the user switched → follow
    expect(style(h, 'please check availability for it')).toEqual(['ENGLISH', 'ROMAN']);
  }, 30000);

  it('[5] text / voice parity: identical (STT-normalized) words give identical language + script and the same system prompt', async () => {
    const t = stack(); const v = stack();
    for (const u of ['Abhi availability check karo.', 'Which one is cheaper?', 'कल की ट्रेन']) {
      await t.say(u, 'TEXT'); await v.say(u, 'VOICE');
      expect(style(v, u)).toEqual(style(t, u));
    }
    expect(sysPrompt(v)).toBe(sysPrompt(t));
  }, 30000);

  it('[root cause] the new F3 availability messages Muse reads are Roman (backend errors were a Devanagari script source)', () => {
    const v = new ToolCallValidator();
    const D1 = ist(1);
    const s: any = { origin: 'ASR', destination: 'NDLS', date: D1, searchResultsVersion: 1,
      searchResults: { date: D1, origin: 'ASR', destination: 'NDLS', trains: [{ trainNumber: '12014', trainName: 'Shatabdi', departure: '04:55', classes: [{ code: 'CC' }], displayIndex: 1 }, { trainNumber: '12497', trainName: 'Shan-e-Punjab', departure: '06:35', classes: [{ code: 'SL' }], displayIndex: 2 }] } };
    const msgs = [
      v.validate({ callId: 'a', name: 'CHECK_AVAILABILITY', arguments: {} } as any, s),
      v.validate({ callId: 'b', name: 'CHECK_AVAILABILITY', arguments: { trainNumber: '12014', travelClass: 'SL' } } as any, s),
      v.validate({ callId: 'c', name: 'CHECK_AVAILABILITY', arguments: { trainNumber: '12014' } } as any, { ...s, searchResults: { ...s.searchResults, trains: [{ ...s.searchResults.trains[0], classes: [{ code: 'CC' }, { code: '2S' }] }] } }),
      v.validate({ callId: 'd', name: 'CHECK_AVAILABILITY', arguments: { trainRef: { kind: 'TIME_PREFERENCE', value: 'MORNING' } } } as any, s),
      v.validate({ callId: 'e', name: 'CHECK_AVAILABILITY', arguments: { trainNumber: '12497', travelClass: 'SL' } } as any, { ...s, searchResults: undefined })
    ].map((r: any) => String(r.error?.message || ''));
    for (const m of msgs) { expect(m.length).toBeGreaterThan(5); expect(m).not.toMatch(/[\u0900-\u097F]/); }
  });
});
