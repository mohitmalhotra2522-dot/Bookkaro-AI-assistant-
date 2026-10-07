/**
 * P42.1 FINAL HARDENING — focused checks (new file; no existing test changed).
 *   [1] passenger names: Latin / English letters only (Devanagari refused, never transliterated; Latin names unchanged)
 *   [2] optional preferences: never invented (UNSET stays unset; explicit preferences incl. NO_PREFERENCE still work)
 *   [3] no internal enum codes in user-facing text (screen + voice)
 *   [4] an optional detail is asked once — no repeated food / seat question; answered fields visible as complete
 *   [5] P42.1 passenger-claim guard unchanged
 *   [6] sensitive data unchanged (refusal only, no LLM call, never stored)
 * Real orchestrator + native (OpenAI-compatible) agent via the injected fake server (no network) + mock railway provider.
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
import { passengerValidator, canonicalName } from '../../server/booking/passenger-validator';
import { passengerChangeValidator } from '../../server/booking/preparation/passenger-change-validator';
import { groundPassengerProposals, userWordsInText } from '../../server/ai/context/passenger-proposal-grounding';
import { humanizePreferenceCodes, containsPreferenceCode } from '../../server/ai/response/preference-labels';
import { nextPassengerDetail, markOptionalAsked, optionalToAsk } from '../../server/booking/passenger-options';
import { bookingPreparationView } from '../../server/ai/context/context-builder';
import { nativeToolDefs } from '../../server/ai/providers/openai-compatible-llm';
import { NATIVE_AGENT_SYSTEM_PROMPT } from '../../server/ai/prompts/system-prompt';
import { REGISTERED_TOOLS } from '../../server/ai/tools/tool-registry';

railwayRegistry.register('p421-hard', () => new MockRailwayProvider());
const istTomorrow = () => new Date(Date.now() + 5.5 * 3600_000 + 86400_000).toISOString().slice(0, 10);
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const PAX = (changes: any, passengerIndex = 1, userWords?: string) =>
  U('COLLECT_PASSENGER_DETAILS', 'UPDATE_PASSENGER', { passengerChanges: [{ passengerIndex, changes, ...(userWords ? { userWords } : {}) }] });
const CODES = /\b(NO_PREFERENCE|NON_VEG|NO_FOOD|SIDE_UPPER|SIDE_LOWER)\b|\bWINDOW\b|\bVEG\b/;

function stack(plan: Record<string, any[]>, mode: 'TEXT' | 'VOICE' = 'TEXT') {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; return p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P421-HARD', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 1000, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { fake, views, say: (t: string, m: 'TEXT' | 'VOICE' = mode) => eng.processTurn(sid, t, m) as Promise<any>, s: () => state.getSession(sid) as any,
    viewsOf: (u: string) => views.filter(v => v.user === u) };
}
const outcomeOf = (v: TurnView) => v.results.find(r => r.name === 'update_booking_session')?.content;
const SETUP = (d: string) => ({
  'search': [{ calls: [{ name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: d } }] }, { content: 'Trains mil gayi.' }],
  '12497 CC 1 log': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12497' }, classRaw: 'CC', passengersCountRaw: '1', selectionPurpose: 'BOOKING' })] }, { content: 'Passenger 1 ka naam kya hai?' }]
});

let fetchSpy: any;
beforeEach(() => { railwayRegistry.setActive('p421-hard'); fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('[1] passenger name — Latin / English letters only', () => {
  it('validator: Devanagari refused with INVALID_PASSENGER_NAME_SCRIPT (not stored); Latin names unchanged', () => {
    for (const n of ['रवि', 'सीता', 'मोहित शर्मा', 'Ravi कुमार']) {
      const r = passengerValidator.validatePartial({ name: n }, 'Passenger 2');
      expect(r.valid.name, n).toBeUndefined();
      expect(r.errors.map(e => e.code), n).toEqual(['INVALID_PASSENGER_NAME_SCRIPT']);
      expect(r.errors[0].message).not.toMatch(/\?/);                                    // fact only — Muse asks
      expect(r.errors[0].message).not.toContain(n);                                    // never echoes the value
    }
    for (const [n, out] of [['Ravi', 'Ravi'], ['Mohit', 'Mohit'], ['sita', 'Sita'], ['Rahul Sharma', 'Rahul Sharma']]) {
      const r = passengerValidator.validatePartial({ name: n });
      expect(r.errors, n).toEqual([]);
      expect(r.valid.name).toBe(out);
    }
    expect(canonicalName('मोहित शर्मा')).toBe('मोहित शर्मा');                              // P38 normalizer itself unchanged
  });
  it('change validator returns the structured reason; a stored Devanagari name is never complete (no review)', () => {
    const s: any = { passengersCount: 1, passengers: [{ id: 'p1' }], selectedTrain: { number: '12497' }, selectedClass: 'CC' };
    const v: any = passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { name: 'रवि', age: 28 } });
    expect(v).toMatchObject({ ok: false, code: 'INVALID_PASSENGER_VALUE', reason: 'INVALID_PASSENGER_NAME_SCRIPT', fields: ['name'] });
    expect(JSON.stringify(v)).not.toContain('रवि');
    expect(passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { name: 'Ravi' } })).toMatchObject({ ok: true });
    const legacy = [{ id: 'p1', name: 'रवि', age: 28, gender: 'MALE' }] as any;
    expect(passengerValidator.completeness(legacy, 1).complete).toBe(false);
    const sv: any = { ...s, passengers: legacy };
    expect(nextPassengerDetail(sv)).toEqual({ passenger: 1, field: 'name' });
    const pv: any = bookingPreparationView(sv);
    expect(pv.passengers[0].name).toBeUndefined();
    expect(pv.passengers[0].missing).toContain('name');
    expect(pv.passengers[0].invalid).toEqual([{ field: 'name', reason: 'INVALID_PASSENGER_NAME_SCRIPT', userActionRequired: true }]);
  });
  it('grounding: Devanagari or silently transliterated name not stored; other fields kept; Latin / spelled / unchanged names pass', () => {
    const dev = groundPassengerProposals({ passengerChanges: [{ passengerIndex: 2, changes: { name: 'रवि', age: 28, gender: 'male' } }] }, 'दूसरा passenger रवि 28 साल male');
    expect(dev.entities!.passengerChanges).toEqual([{ passengerIndex: 2, changes: { age: 28, gender: 'male' } }]);
    expect(dev.rejections).toEqual([{ passengerIndex: 2, field: 'name', reason: 'INVALID_PASSENGER_NAME_SCRIPT', userActionRequired: true }]);
    const tr = groundPassengerProposals({ passengerChanges: [{ passengerIndex: 2, changes: { name: 'Ravi' } }] }, 'रवि');
    expect(tr.entities!.passengerChanges).toBeUndefined();                              // nothing left to apply
    expect(tr.rejections[0]).toMatchObject({ field: 'name', reason: 'INVALID_PASSENGER_NAME_SCRIPT' });
    for (const [text, name] of [['Ravi', 'Ravi'], ['दूसरा passenger Ravi', 'Ravi'], ['naam Mohit hai', 'Mohit'], ['आर ए वी आई', 'Ravi'], ['R A V I', 'Ravi']]) {
      const g = groundPassengerProposals({ passengerChanges: [{ passengerIndex: 1, changes: { name } }] }, text);
      expect(g.rejections, text).toEqual([]);
    }
    const s: any = { passengers: [{ id: 'p1', name: 'Ravi' }] };                          // re-sending the stored name is not a new name
    expect(groundPassengerProposals({ passengerChanges: [{ passengerIndex: 1, changes: { name: 'Ravi', age: 29 } }] }, 'रवि की उम्र 29 कर दो', s).rejections).toEqual([]);
  });
  it('e2e: "रवि" → nothing stored, Muse gets INVALID_PASSENGER_NAME_SCRIPT and asks the spelling itself (no backend question); "Ravi" → stored', async () => {
    const h = stack({ ...SETUP(istTomorrow()),
      'रवि': [{ calls: [PAX({ name: 'रवि' })] }, { content: 'Ravi ka naam English spelling mein kaise likhte hain?' }],
      'रवि ': [{ calls: [PAX({ name: 'Ravi' })] }, { content: 'Ravi ka naam English spelling mein kaise likhte hain?' }],
      'Ravi': [{ calls: [PAX({ name: 'Ravi' })] }, { content: 'Noted. Ravi ji ki age bataiye.' }]
    });
    await h.say('search'); await h.say('12497 CC 1 log');
    for (const u of ['रवि', 'रवि ']) {
      const r = await h.say(u);
      expect(h.s().passengers[0].name, u).toBeUndefined();
      const o = outcomeOf(h.viewsOf(u.trim())[h.viewsOf(u.trim()).length - 1]);
      expect(o.rejectedPassengerFields, u).toEqual([{ passengerIndex: 1, field: 'name', reason: 'INVALID_PASSENGER_NAME_SCRIPT', userActionRequired: true }]);
      expect(String(r.responseMessage)).toBe('Ravi ka naam English spelling mein kaise likhte hain?');   // Muse's words only
      expect((String(r.responseMessage).match(/\?/g) || []).length).toBe(1);
      expect(JSON.stringify(r.context)).not.toContain('रवि');
    }
    await h.say('Ravi');
    expect(h.s().passengers[0].name).toBe('Ravi');
  }, 30000);
});

describe('[2] optional preferences are never invented', () => {
  it('grounding: no userWords / words not in this message → not stored; explicit words → stored (incl. NO_PREFERENCE)', () => {
    const none = groundPassengerProposals({ passengerChanges: [{ passengerIndex: 1, changes: { gender: 'male', berthPreference: 'NO_PREFERENCE', foodPreference: 'VEG' } }] }, 'Actually तीन passenger');
    expect(none.entities!.passengerChanges).toEqual([{ passengerIndex: 1, changes: { gender: 'male' } }]);
    expect(none.rejections.map(r => [r.field, r.reason])).toEqual([['berthPreference', 'PREFERENCE_NOT_STATED_BY_USER'], ['foodPreference', 'PREFERENCE_NOT_STATED_BY_USER']]);
    const fake = groundPassengerProposals({ passengerChanges: [{ passengerIndex: 1, changes: { berthPreference: 'WINDOW' }, userWords: 'window seat' }] }, 'Actually 3 passengers');
    expect(fake.entities!.passengerChanges).toBeUndefined();
    const ok = groundPassengerProposals({ passengerChanges: [{ passengerIndex: 1, changes: { berthPreference: 'NO_PREFERENCE' }, userWords: 'koi preference nahi' }] }, 'Koi preference nahi.');
    expect(ok.rejections).toEqual([]);
    expect(ok.entities!.passengerChanges).toEqual([{ passengerIndex: 1, changes: { berthPreference: 'NO_PREFERENCE' } }]);   // userWords consumed, never stored
    // the value itself said by the user in this message also grounds it ("…32 male lower"); a look-alike does not
    const said = (changes: any, text: string) => groundPassengerProposals({ passengerChanges: [{ passengerIndex: 1, changes }] }, text).rejections.length === 0;
    expect(said({ berthPreference: 'LOWER' }, 'Rahul Sharma 32 male lower')).toBe(true);
    expect(said({ berthPreference: 'WINDOW' }, 'मोहित के लिए विंडो सीट')).toBe(true);
    expect(said({ berthPreference: 'LOWER' }, 'side lower chahiye')).toBe(false);
    expect(said({ foodPreference: 'VEG' }, 'non veg')).toBe(false);
    expect(said({ berthPreference: 'NO_PREFERENCE' }, 'theek hai')).toBe(false);
    expect(userWordsInText('विंडो सीट', 'मोहित के लिए विंडो सीट')).toBe(true);
    expect(userWordsInText(['window', 'veg'], 'window aur veg')).toBe(true);
    expect(userWordsInText('', 'window')).toBe(false);
    // the internal passengerUpdates shape an LLM could still send is grounded the same way
    const pu = groundPassengerProposals({ passengerUpdates: [{ ref: { kind: 'INDEX', value: 1 }, fields: { berthPreference: 'NO_PREFERENCE' } }] }, 'theek hai');
    expect(pu.entities!.passengerUpdates).toBeUndefined();
  });
  it('e2e: an unstated preference stays UNSET (not NO_PREFERENCE) while stated fields are stored; an explicit one is stored', async () => {
    const h = stack({ ...SETUP(istTomorrow()),
      'Rahul Sharma': [{ calls: [PAX({ name: 'Rahul Sharma' })] }, { content: 'Rahul ji ki age bataiye.' }],
      '31 male': [{ calls: [PAX({ age: 31, gender: 'male', berthPreference: 'NO_PREFERENCE' })] }, { content: 'Theek hai.' }],
      'koi preference nahi': [{ calls: [PAX({ berthPreference: 'NO_PREFERENCE' }, 1, 'koi preference nahi')] }, { content: 'Theek hai.' }]
    });
    await h.say('search'); await h.say('12497 CC 1 log'); await h.say('Rahul Sharma');
    await h.say('31 male');
    expect(h.s().passengers[0]).toMatchObject({ name: 'Rahul Sharma', age: 31, gender: 'MALE' });
    expect(h.s().passengers[0].berthPreference ?? null).toBeNull();                    // UNSET ≠ NO_PREFERENCE
    expect(outcomeOf(h.viewsOf('31 male')[1]).rejectedPassengerFields).toEqual([{ passengerIndex: 1, field: 'berthPreference', reason: 'PREFERENCE_NOT_STATED_BY_USER', userActionRequired: false }]);
    const review = JSON.stringify(h.s().review?.data ?? {});
    expect(review).not.toMatch(/No preference|NO_PREFERENCE/i);                        // never displayed as user-selected
    await h.say('koi preference nahi');
    expect(h.s().passengers[0].berthPreference).toBe('NO_PREFERENCE');                 // explicit user choice
  }, 30000);
  it('tool schema + prompt tell Muse: userWords required, never invent, names in Latin letters', () => {
    const defs = nativeToolDefs({ tools: REGISTERED_TOOLS as any });
    const items = defs.find((d: any) => d.function?.name === 'update_booking_session').function.parameters.properties.entities.properties.passengerChanges.items;
    expect(items.properties.userWords.description).toMatch(/never set a preference the user did not state/);
    expect(items.properties.changes.properties.name.description).toMatch(/Latin/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/NEVER invent a passenger preference/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/INVALID_PASSENGER_NAME_SCRIPT/);
    expect(NATIVE_AGENT_SYSTEM_PROMPT).toMatch(/Never show internal codes/);
  });
});

describe('[3] no internal enum codes in user-facing text', () => {
  it('codes → natural labels; normal prose and all-caps train names untouched', () => {
    expect(humanizePreferenceCodes('Mohit ke liye kya chahiye: NO_PREFERENCE ya WINDOW?')).toBe('Mohit ke liye kya chahiye: No preference ya window side?');
    expect(humanizePreferenceCodes('भोजन का विकल्प बताइए — VEG, NON‑VEG या NO FOOD?')).toBe('भोजन का विकल्प बताइए — veg, non-veg या no food?');
    expect(humanizePreferenceCodes('SIDE_UPPER ya LOWER?')).toBe('Side upper ya lower?');
    expect(humanizePreferenceCodes('13049 UPPER INDIA EXP CC mein')).toBe('13049 UPPER INDIA EXP CC mein');
    expect(humanizePreferenceCodes('Window seat chahiye ya veg khana?')).toBe('Window seat chahiye ya veg khana?');
    expect(containsPreferenceCode('No preference ya window side?')).toBe(false);
  });
  it('e2e (TEXT + VOICE): Muse writes codes → screen and spoken text show natural labels', async () => {
    for (const mode of ['TEXT', 'VOICE'] as const) {
      const h = stack({ ...SETUP(istTomorrow()),
        'Rahul Sharma': [{ calls: [PAX({ name: 'Rahul Sharma' })] }, { content: 'Rahul ji ki age bataiye.' }],
        '31': [{ calls: [PAX({ age: 31 })] }, { content: 'Seat preference kya rahegi: NO_PREFERENCE ya WINDOW?' }]
      }, mode);
      await h.say('search'); await h.say('12497 CC 1 log'); await h.say('Rahul Sharma');
      const r = await h.say('31');
      expect(h.s().passengers[0].age).toBe(31);
      for (const t of [r.responseMessage, r.voice?.assistantText, r.voice?.speechText].filter(Boolean)) {
        expect(String(t), mode).not.toMatch(CODES);
      }
      expect(String(r.responseMessage)).toMatch(/no preference ya window side\?/i);
    }
  }, 40000);
});

describe('[4] optional detail asked once — no repeated food / seat question', () => {
  it('options: an asked optional detail leaves nextToAsk / alsoAsk; answered fields are complete', () => {
    const s: any = { passengersCount: 1, selectedTrain: { number: '12497' }, selectedClass: 'CC',
      lastTrainInfo: { trainNumber: '12497', facilities: { catering: true } }, passengers: [{ id: 'p1', name: 'Rahul Sharma', age: 31, gender: 'MALE' }] };
    expect(nextPassengerDetail(s)).toEqual({ passenger: 1, field: 'berthPreference' });
    markOptionalAsked(s, { passenger: 1, field: 'berthPreference' });
    expect(nextPassengerDetail(s)).toEqual({ passenger: 1, field: 'foodPreference' });
    markOptionalAsked(s, { passenger: 1, field: 'foodPreference' });
    expect(nextPassengerDetail(s)).toBeNull();
    const v: any = bookingPreparationView(s);
    expect(v.alsoAsk).toBeUndefined();
    expect(v.optionalAlreadyAsked).toEqual(['passenger1.berthPreference', 'passenger1.foodPreference']);
    s.passengers[0].foodPreference = 'VEG';                                             // answered later (volunteered)
    const v2: any = bookingPreparationView(s);
    expect(v2.passengers[0].foodPreference).toBe('VEG');
    expect(v2.optionalAlreadyAsked).toEqual(['passenger1.berthPreference']);
    markOptionalAsked(s, { passenger: 1, field: 'name' });                               // required fields are never "asked once"
    expect(optionalToAsk({ ...s, selectedClass: 'EC' }, s.passengers[0])).toEqual(['berthPreference']);   // new class → asked again
  });
  it('e2e: food asked once; the following turns no longer push it; lastAsked maps a short answer; no repeat', async () => {
    const h = stack({ ...SETUP(istTomorrow()),
      'Rahul Sharma 31 male': [{ calls: [PAX({ name: 'Rahul Sharma', age: 31, gender: 'male' })] }, { content: 'Window seat chahiye ya koi preference nahi?' }],
      'window': [{ calls: [PAX({ berthPreference: 'WINDOW' }, 1, 'window')] }, { content: 'Khane mein veg, non-veg ya no food?' }],
      'age 32 kar do': [{ calls: [PAX({ age: 32 })] }, { content: 'Age 32 kar di.' }],
      'veg': [{ calls: [PAX({ foodPreference: 'VEG' }, 1, 'veg')] }, { content: 'Theek hai.' }]
    });
    await h.say('search'); await h.say('12497 CC 1 log');
    h.s().lastTrainInfo = { trainNumber: '12497', trainName: 'Shan-e-Punjab Express', facilities: { catering: true } };   // fixture: catering offered
    await h.say('Rahul Sharma 31 male');
    await h.say('window');
    const vw = h.viewsOf('window')[0].context.context.bookingPreparation;             // what Muse saw for the short answer
    expect(vw.lastAsked).toMatchObject({ passenger: 1, field: 'berthPreference', optionLabels: ['No preference', 'Window side'] });
    expect(vw.nextToAsk?.field).not.toBe('berthPreference');                             // asked once → not pushed again
    expect(h.s().passengers[0].berthPreference).toBe('WINDOW');                          // the short answer mapped via lastAsked
    await h.say('age 32 kar do');                                                        // user ignores the meal question
    const va = h.viewsOf('age 32 kar do');
    const bp = va[va.length - 1].context.context.bookingPreparation;
    expect(bp.nextToAsk ?? null).toBeNull();                                             // food NOT pushed a second time
    expect(bp.optionalAlreadyAsked).toEqual(['passenger1.foodPreference']);
    expect(bp.passengers[0]).toMatchObject({ age: 32, berthPreference: 'WINDOW' });     // answered = complete
    expect(h.s().passengers[0].foodPreference ?? null).toBeNull();
    await h.say('veg');                                                                  // still accepted when volunteered
    expect(h.s().passengers[0].foodPreference).toBe('VEG');
  }, 40000);
});

describe('[5] passenger-claim guard unchanged', () => {
  it('"Window seat set ho gaya" without a real update is removed (screen + voice); with a real update it stays', async () => {
    const h = stack({ ...SETUP(istTomorrow()),
      'Rahul Sharma 31 male': [{ calls: [PAX({ name: 'Rahul Sharma', age: 31, gender: 'male' })] }, { content: 'Window seat chahiye?' }],
      'seat ka kya hua': [{ calls: [PAX({ berthPreference: 'WINDOW' })] }, { content: 'Window seat set ho gaya. Kuch aur?' }],
      'window seat': [{ calls: [PAX({ berthPreference: 'WINDOW' }, 1, 'window seat')] }, { content: 'Window seat set ho gaya.' }]
    }, 'VOICE');
    await h.say('search'); await h.say('12497 CC 1 log'); await h.say('Rahul Sharma 31 male');
    const r1 = await h.say('seat ka kya hua');   // (not a confirmation word — a pending review would take that path)
    expect(h.s().passengers[0].berthPreference ?? null).toBeNull();
    expect(String(r1.responseMessage)).not.toMatch(/set ho gaya/i);
    expect(String(r1.voice?.assistantText ?? '')).not.toMatch(/set ho gaya/i);
    expect(r1.turnLog.naturalSpeech.rejected).toContain('PASSENGER_UPDATE_CLAIM:FIELD_NOT_UPDATED:berthPreference');
    const r2 = await h.say('window seat');
    expect(h.s().passengers[0].berthPreference).toBe('WINDOW');
    expect(String(r2.responseMessage)).toMatch(/^Window seat set ho gaya\./);
    expect(r2.turnLog.naturalSpeech.rejected).toEqual([]);
  }, 30000);
});

describe('[6] sensitive data unchanged', () => {
  it('OTP → refusal only, no LLM call, not stored / in context; a credential inside a name is refused', async () => {
    const h = stack(SETUP(istTomorrow()));
    await h.say('search'); await h.say('12497 CC 1 log');
    const before = h.fake.decisionRequests.length;
    const r = await h.say('My OTP is 123456');
    expect(h.fake.decisionRequests.length).toBe(before);
    expect(r.error?.code).toBe('SENSITIVE_REQUEST_REJECTED');
    expect(String(r.responseMessage)).not.toMatch(/\?/);
    expect(JSON.stringify(r.context)).not.toContain('123456');
    expect(JSON.stringify(r.turnLog)).not.toContain('123456');
    const s: any = { passengersCount: 1, passengers: [{ id: 'p1' }] };
    expect(passengerChangeValidator.validate(s, { passengerIndex: 1, changes: { name: 'OTP 123456' } })).toMatchObject({ ok: false, code: 'SENSITIVE_DATA_REJECTED' });
    const g = groundPassengerProposals({ passengerChanges: [{ passengerIndex: 1, changes: { name: 'रवि' } }] }, 'रवि');
    expect(JSON.stringify(g.rejections)).not.toContain('रवि');                            // rejections never carry values
  }, 30000);
});
