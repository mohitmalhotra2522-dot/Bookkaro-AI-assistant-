/**
 * P42.1 FINAL PRE-RELEASE PATCH
 *  (A) the P42 Same Train Alternative guidance reaches Muse's system prompt ONLY when SAME_TRAIN_ALTERNATIVES_ENABLED
 *      is on (the same flag that exposes the P42 tools); when on, the guidance text is injected unchanged.
 *  (B) a passenger-update claim ("Age 31 noted") survives only when that detail really changed this turn.
 * Offline: fake OpenAI-compatible fetch; global network forbidden.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NATIVE_AGENT_SYSTEM_PROMPT, SAME_TRAIN_ALTERNATIVES_PROMPT_GUIDANCE, nativeAgentSystemPrompt } from '../../server/ai/prompts/system-prompt';
import { createLLMProvider } from '../../server/ai/providers/llm-provider-factory';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';
import { verifyPassengerUpdateClaim, passengerFieldsChanged, guardPassengerUpdateClaims } from '../../server/ai/response/passenger-claims';
import { FakeOpenAI } from '../helpers/fake-openai-server';

const ENV = { LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-p421', LLM_MODEL: 'm-test', LLM_BASE_URL: 'https://llm.fake.test/v1', LLM_TIMEOUT_MS: '3000' };
const input = () => ({ userText: 'Kal Amritsar se Delhi jaana hai', history: [{ role: 'user', content: 'Kal Amritsar se Delhi jaana hai' }],
  state: 'IDLE', session: {}, missingFields: ['origin'], inputMode: 'TEXT', tools: REGISTERED_TOOLS, context: { sessionView: { bookingState: 'IDLE' } } }) as any;

let saved: string | undefined;
let fetchSpy: any;
beforeEach(() => {
  saved = process.env.SAME_TRAIN_ALTERNATIVES_ENABLED;
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
});
afterEach(() => {
  if (saved === undefined) delete process.env.SAME_TRAIN_ALTERNATIVES_ENABLED; else process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = saved;
  expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore();
});

async function systemPromptSent(): Promise<string> {
  const fake = new FakeOpenAI(() => ({ content: 'Namaste!' }));
  const p = createLLMProvider(ENV, { fetch: fake.fetch }).provider;
  await p.generateStructuredDecision(input());
  return fake.requests[0].body.messages[0].content;
}

describe('P42.1 pre-release (A) — P42 prompt guidance behind SAME_TRAIN_ALTERNATIVES_ENABLED', () => {
  it('[A1] OFF (unset / 0): no P42 guidance in the system prompt Muse receives', async () => {
    for (const v of [undefined, '0', 'false', '']) {
      if (v === undefined) delete process.env.SAME_TRAIN_ALTERNATIVES_ENABLED; else process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = v;
      const sys = await systemPromptSent();
      expect(sys).toBe(NATIVE_AGENT_SYSTEM_PROMPT);
      expect(sys).not.toContain('SEARCH_SAME_TRAIN_ALTERNATIVES');
      expect(sys).not.toContain('PRESENT_SAME_TRAIN_ALTERNATIVES');
      expect(sys).not.toContain(SAME_TRAIN_ALTERNATIVES_PROMPT_GUIDANCE);
    }
    expect(nativeAgentSystemPrompt(false)).toBe(NATIVE_AGENT_SYSTEM_PROMPT);
  });

  it('[A2] ON: the existing P42 guidance is injected unchanged (only difference from OFF), at its original place', async () => {
    process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1';
    const sys = await systemPromptSent();
    expect(sys).toBe(nativeAgentSystemPrompt(true));
    expect(sys).toContain(SAME_TRAIN_ALTERNATIVES_PROMPT_GUIDANCE);
    expect(sys.split(SAME_TRAIN_ALTERNATIVES_PROMPT_GUIDANCE)).toHaveLength(2);           // injected exactly once
    expect(sys.replace(SAME_TRAIN_ALTERNATIVES_PROMPT_GUIDANCE, '')).toBe(NATIVE_AGENT_SYSTEM_PROMPT);
    // original position: right after the WEB_EXTERNAL bullet, right before the failed-call bullet
    const at = sys.indexOf(SAME_TRAIN_ALTERNATIVES_PROMPT_GUIDANCE);
    expect(sys.slice(0, at)).toMatch(/is from the web\. Use it only when the railway tools cannot answer a general railway question\.\n$/);
    expect(sys.slice(at + SAME_TRAIN_ALTERNATIVES_PROMPT_GUIDANCE.length)).toMatch(/^- A failed call comes back as/);
    for (const k of ['(only if listed) is OPTIONAL and entirely your decision', 'Ticket station ≠ travel station', 'CONFLICTING means providers disagree',
      'call PRESENT_SAME_TRAIN_ALTERNATIVES', 'Nothing is booked or changed by these tools']) expect(SAME_TRAIN_ALTERNATIVES_PROMPT_GUIDANCE).toContain(k);
    for (const v of ['true', 'yes', 'on']) { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = v; expect(await systemPromptSent()).toContain(SAME_TRAIN_ALTERNATIVES_PROMPT_GUIDANCE); }
  });
});

describe('P42.1 pre-release (B) — passenger-update claims need a real update this turn', () => {
  it('[B1] "Age 31 noted" with NO stored change → removed; with the age really stored → allowed (no fixed backend ack)', () => {
    expect(verifyPassengerUpdateClaim('Age 31 noted.', [])).toBe('FIELD_NOT_UPDATED:age');
    expect(verifyPassengerUpdateClaim('Age 31 noted.', ['P1.name'])).toBe('FIELD_NOT_UPDATED:age');   // a different field changed
    expect(verifyPassengerUpdateClaim('Age 31 noted.', ['P1.age'])).toBeNull();
    expect(verifyPassengerUpdateClaim('Noted.', [])).toBe('NO_PASSENGER_UPDATE_APPLIED');
    expect(verifyPassengerUpdateClaim('Noted.', ['P1.name'])).toBeNull();
    for (const c of ['Rahul ki umar save ho gayi.', 'Age update kar di.', 'Gender male kar diya.', "Rahul's age is updated.", 'Naam likh liya.', 'Passenger details save ho gayi.'])
      expect(verifyPassengerUpdateClaim(c, []), c).not.toBeNull();
    expect(verifyPassengerUpdateClaim('Age update kar di.', ['P1.age'])).toBeNull();
    // screen-reply path: only the claim sentence is removed, the rest of Muse's reply stays
    expect(guardPassengerUpdateClaims('Age 31 noted. Ab gender bataiye?', [])).toEqual({ text: 'Ab gender bataiye?', removed: [{ sentence: 'Age 31 noted.', reason: 'FIELD_NOT_UPDATED:age' }] });
    expect(guardPassengerUpdateClaims('Age 31 noted. Ab gender bataiye?', ['P1.age']).text).toBe('Age 31 noted. Ab gender bataiye?');
  });

  it('[B2] not a claim: questions, honest negatives, non-passenger updates; no evidence supplied → nothing judged', () => {
    for (const c of ['Rahul ji ki age bataiye.', 'Age 31 save karun?', 'Age abhi save nahi hui.', 'Date update ho gayi.', 'CC class select ho gayi.', 'Review updated.'])
      expect(verifyPassengerUpdateClaim(c, []), c).toBeNull();
    expect(verifyPassengerUpdateClaim('Age 31 noted.', undefined)).toBeNull();
  });

  it('[B3] evidence = fields whose value really changed (by passenger id), never values', () => {
    const before = [{ id: 'P1', name: 'Rahul Sharma' }];
    expect(passengerFieldsChanged(before, [{ id: 'P1', name: 'Rahul Sharma' }])).toEqual([]);
    expect(passengerFieldsChanged(before, [{ id: 'P1', name: 'Rahul Sharma', age: 31 }])).toEqual(['P1.age']);
    expect(passengerFieldsChanged(before, [{ id: 'P1', name: 'Rohit Sharma' }, { id: 'P2', name: 'Neha' }])).toEqual(['P1.name', 'P2.name']);
  });
});
