/**
 * Explicit LLM fallback model (LLM_FALLBACK_MODEL) — primary Muse → fallback gpt-oss-20b on timeout / errors.
 * Visible (health state, log event, diagnostics model), never on abort/auth, cooldown, unset = unchanged provider.
 */
import { describe, it, expect } from 'vitest';
import { FallbackLLMProvider } from '../../server/ai/providers/fallback-llm';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { OpenAICompatibleLLMProvider } from '../../server/ai/providers/openai-compatible-llm';
import { LLMProviderError } from '../../server/ai/providers/llm-provider';

const KEY = 'nvapi-TEST-FALLBACK-SECRET-0123456789';
const ENV = { LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: KEY, LLM_MODEL: 'meta/muse-glimmer-30b', LLM_BASE_URL: 'https://llm.fake.test/v1', LLM_TIMEOUT_MS: '120000' };

function stub(model: string, behave: () => any) {
  const calls: string[] = [];
  return {
    calls,
    p: {
      providerId: 'openai-compatible', modelName: model, agentAuthoredReplies: true,
      async init() { /* noop */ },
      async generateStructuredDecision() { calls.push('decision'); return behave(); },
      async generateSpokenResponse() { calls.push('spoken'); return { text: model }; },
    } as any,
  };
}
const fail = (code: any, status?: number) => () => { throw new LLMProviderError(code, status); };
const ok = (tag: string) => () => ({ decision: { tag } });

describe('LLM fallback model', () => {
  it('[1] unset LLM_FALLBACK_MODEL → the plain provider, exactly as before (no wrapper, no fallback info)', () => {
    const sel = createLLMProvider(ENV);
    expect(sel.provider).toBeInstanceOf(OpenAICompatibleLLMProvider);
    expect((sel.provider as any).cfg.timeoutMs).toBe(120000);
    expect(sel.info.fallback).toBeUndefined();
    const same = createLLMProvider({ ...ENV, LLM_FALLBACK_MODEL: 'meta/muse-glimmer-30b' });
    expect(same.provider).toBeInstanceOf(OpenAICompatibleLLMProvider);   // fallback == primary → ignored
  });

  it('[2] configured → wrapper; health info shows the fallback state (JSON) and never the key', () => {
    const sel = createLLMProvider({ ...ENV, LLM_FALLBACK_MODEL: 'openai/gpt-oss-20b' });
    expect(sel.provider).toBeInstanceOf(FallbackLLMProvider);
    expect(sel.provider.providerId).toBe('openai-compatible');
    expect((sel.provider as any).agentAuthoredReplies).toBe(true);
    const json = JSON.stringify(sel.info);
    expect(JSON.parse(json).fallback).toEqual({ model: 'openai/gpt-oss-20b', cooldownMs: 300000, active: false, lastReason: null, lastSwitchAt: null, fallbackCalls: 0 });
    expect(json).not.toContain(KEY);
    expect(JSON.parse(json).model).toBe('meta/muse-glimmer-30b');
  });

  it('[3] primary OK → fallback never called; modelName = primary', async () => {
    const a = stub('muse', ok('muse')), b = stub('oss', ok('oss'));
    const f = new FallbackLLMProvider(a.p, b.p, { cooldownMs: 1000 });
    expect(await f.generateStructuredDecision({} as any)).toEqual({ decision: { tag: 'muse' } });
    expect(b.calls).toEqual([]); expect(f.modelName).toBe('muse'); expect(f.state.active).toBe(false);
  });

  it('[4] primary LLM_TIMEOUT → same call answered by the fallback, logged with codes only; cooldown skips the primary; after cooldown the primary is tried again', async () => {
    let t = 1_000_000; const logs: any[] = [];
    let primaryFails = true;
    const a = stub('muse', () => (primaryFails ? fail('LLM_TIMEOUT')() : ok('muse')())), b = stub('oss', ok('oss'));
    const f = new FallbackLLMProvider(a.p, b.p, { cooldownMs: 300000, now: () => t, log: e => logs.push(e) });
    expect(await f.generateStructuredDecision({} as any)).toEqual({ decision: { tag: 'oss' } });
    expect(f.modelName).toBe('oss');
    expect(logs).toEqual([{ llm: { event: 'LLM_FALLBACK_USED', from: 'muse', to: 'oss', reason: 'LLM_TIMEOUT', cooldownMs: 300000 } }]);
    expect(f.state).toMatchObject({ active: true, lastReason: 'LLM_TIMEOUT', fallbackCalls: 1 });
    t += 1000;                                           // within cooldown → straight to fallback
    await f.generateStructuredDecision({} as any);
    expect(a.calls.length).toBe(1); expect(b.calls.length).toBe(2);
    t += 300000; primaryFails = false;                   // cooldown over → primary again
    expect(await f.generateStructuredDecision({} as any)).toEqual({ decision: { tag: 'muse' } });
    expect(f.modelName).toBe('muse'); expect(f.state.active).toBe(false);
  });

  it('[5] network / rate-limit / HTTP errors fall back; abort, auth, bad response, not-configured do NOT', async () => {
    for (const [code, status] of [['LLM_NETWORK_ERROR'], ['LLM_RATE_LIMITED', 429], ['LLM_HTTP_ERROR', 503]] as any[]) {
      const b = stub('oss', ok('oss'));
      const f = new FallbackLLMProvider(stub('muse', fail(code, status)).p, b.p, { cooldownMs: 0 });
      expect(await f.generateStructuredDecision({} as any)).toEqual({ decision: { tag: 'oss' } });
    }
    for (const code of ['LLM_ABORTED', 'LLM_AUTH_ERROR', 'LLM_BAD_RESPONSE', 'LLM_NOT_CONFIGURED'] as any[]) {
      const b = stub('oss', ok('oss'));
      const f = new FallbackLLMProvider(stub('muse', fail(code)).p, b.p, { cooldownMs: 0 });
      await expect(f.generateStructuredDecision({} as any)).rejects.toMatchObject({ code });
      expect(b.calls).toEqual([]);
    }
    const b = stub('oss', ok('oss'));
    const f = new FallbackLLMProvider(stub('muse', () => { throw new Error('boom'); }).p, b.p, { cooldownMs: 0 });
    await expect(f.generateStructuredDecision({} as any)).rejects.toThrow('boom');
    expect(b.calls).toEqual([]);
  });

  it('[6] fallback also fails → the error propagates (normal safe LLM_UNAVAILABLE path), nothing invented', async () => {
    const f = new FallbackLLMProvider(stub('muse', fail('LLM_TIMEOUT')).p, stub('oss', fail('LLM_HTTP_ERROR', 500)).p, { cooldownMs: 1000 });
    await expect(f.generateStructuredDecision({} as any)).rejects.toMatchObject({ code: 'LLM_HTTP_ERROR' });
  });

  it('[7] real adapter path: primary 503 → fallback model requested on the same endpoint with the same key; both fail → error', async () => {
    const seen: Array<{ model: string; auth: string; url: string }> = [];
    const fetch = async (url: string, init: any) => {
      seen.push({ model: JSON.parse(init.body).model, auth: init.headers.Authorization || init.headers.authorization, url });
      return { ok: false, status: 503, json: async () => ({}), text: async () => '' } as any;
    };
    const logs: any[] = [];
    const sel = createLLMProvider({ ...ENV, LLM_FALLBACK_MODEL: 'openai/gpt-oss-20b' }, { fetch, log: e => logs.push(e) });
    const input: any = { userText: 'kal Amritsar se Delhi', history: [], state: {}, tools: [], toolResults: [] };
    await expect(sel.provider.generateStructuredDecision(input)).rejects.toMatchObject({ code: 'LLM_HTTP_ERROR' });
    expect(seen.map(s => s.model)).toEqual(['meta/muse-glimmer-30b', 'openai/gpt-oss-20b']);
    expect(new Set(seen.map(s => s.url)).size).toBe(1);
    expect(seen.every(s => s.auth === `Bearer ${KEY}`)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(KEY);
    expect(JSON.stringify(logs)).not.toContain('Amritsar');
    expect(sel.info.fallback).toMatchObject({ active: true, lastReason: 'LLM_HTTP_ERROR:503' });
  });
});
