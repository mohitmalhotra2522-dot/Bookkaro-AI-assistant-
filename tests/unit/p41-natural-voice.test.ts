/**
 * PROMPT 41 — G2: NaturalVoiceResponseComposer / VoiceResponse / VoiceResponseGroundingValidator.
 * Offline: MockLLM + mock railway provider build REAL authoritative sessions; the voice-brief wording is a scripted
 * provider (the real Muse run is G3). Global fetch is forbidden.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { ConversationTurnEngine } from '../../server/ai/turn-engine/conversation-turn-engine';
import { naturalResponseComposer } from '../../server/ai/response/natural-response-composer';
import {
  assessSpeechSuitability, voiceResponseGrounding, polishSpeech, extractVoiceFacts, wordCount, voiceResponseLogRecord, voiceComposerTimeoutMs
} from '../../server/ai/response/voice-response';
import { VOICE_BRIEF_PROMPT } from '../../server/ai/prompts/system-prompt';
import { renderForSpeech, digitFacts } from '../../shared/voice/speech-renderer';
import { segmentForSpeech } from '../../shared/voice/voice-response-policy';
import { ConversationalVoiceAgent, type TurnProcessor, type VoiceTurnOutcome } from '../../shared/voice/conversational-voice-agent';
import { MockStreamingSTT } from '../../server/voice/stt/stt-provider';
import { MockStreamingTTS } from '../../server/voice/tts/tts-provider';
import { BookingState } from '../../shared/states';

// ---------------------------------------------------------------- authoritative sessions (mock provider, real backend)
function mk() {
  const state = new ConversationStateManager();
  const eng = new ConversationTurnEngine(new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService()), state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { eng, sid, say: (t: string, m: 'TEXT' | 'VOICE' = 'VOICE') => eng.processTurn(sid, t, m, {}) as Promise<any>, s: () => structuredClone(state.getSession(sid)) as any };
}
let SEARCH: any, SELECTED: any, PAX: any, REVIEW: any;
let REVIEW_REPLY = '';
const flush = () => new Promise(r => setTimeout(r, 0));
const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

beforeAll(async () => {
  const h = mk();
  await h.say('Amritsar se Delhi kal'); SEARCH = h.s();
  await h.say('12014 wali kar do'); SELECTED = h.s();
  await h.say('CC'); PAX = h.s();
  const r = await h.say('2 passengers. Mohit 31 male, Ravi 28 male.'); REVIEW = h.s(); REVIEW_REPLY = r.responseMessage;
}, 60_000);

let fetchSpy: any;
beforeEach(() => { fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); }); logSpy.mockClear(); });
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); fetchSpy.mockRestore(); });

// ---------------------------------------------------------------- scripted voice-brief provider
function scripted(reply: string | ((inp: any) => string | Promise<string>) | null, o: { delayMs?: number; throws?: boolean } = {}) {
  const calls: any[] = [];
  const llm = {
    providerId: 'scripted', agentAuthoredReplies: true, generateStructuredDecision: async () => ({}) as any,
    generateSpokenResponse: async (inp: any) => {
      calls.push(inp);
      if (o.throws) throw new Error('LLM_HTTP_ERROR');
      if (o.delayMs) await new Promise(r => setTimeout(r, o.delayMs));
      const t = typeof reply === 'function' ? await reply(inp) : reply;
      if (t && inp.onDelta) inp.onDelta(t);
      return t ? { text: t } : null;
    }
  } as any;
  return { llm, calls };
}
const SEARCH_SCREEN = 'Kal Amritsar se New Delhi ke liye 3 trainein mili hain:\n1. 12014 Amritsar Shatabdi — 04:55 se 10:50\n2. 12497 — 06:35\n3. 18238 — 19:35\nKaunsi train select karni hai?';
const SEARCH_BACKEND = '7 Oct ko 3 trainein mili hain. 12014 aur 12497 sabse pehle hain. 12014 (04:55), 12497 (06:35) ya 18238 (19:35) — kaunsi train select karni hai?';

function input(session: any, o: any = {}) {
  return {
    session, userText: 'Amritsar se Delhi kal jaana hai', backendReply: SEARCH_BACKEND, mode: 'VOICE',
    deterministicSpeech: SEARCH_BACKEND, stateBefore: BookingState.IDLE, reviewVersionBefore: null, selectedTrainBefore: null,
    selectedClassBefore: null, passengersCountBefore: null, steps: [], appliedActions: [], changes: [], error: null,
    pendingQuestionCode: null, pendingQuestion: null, history: [], turnId: 'turn_test', ...o
  } as any;
}
const step = (name: string, success: boolean, data: any = {}, error?: any) => ({ toolCall: { name, callId: `c_${name}` }, status: success ? 'ok' : 'error', result: { success, data, ...(error ? { error } : {}) } });
const searchTurn = (llm: any, o: any = {}) => naturalResponseComposer.compose(input(SEARCH, { llm, agentText: SEARCH_SCREEN, steps: [step('SEARCH_TRAINS', true, { trains: SEARCH.searchResults.trains })], ...o }));

// ================================================================= G2 — 25 composer cases
describe('P41 G2 — NaturalVoiceResponseComposer (Paths A / B / C)', () => {
  it('[1] search results: screen-oriented list → ONE voice brief (Path B): count + highlight + question; screen keeps the validated reply', async () => {
    const { llm, calls } = scripted('Kal ke liye 3 trainein mili hain. Sabse pehli 12014 hai, subah 04:55 wali. Kaunsi chahiye?');
    const r = await searchTurn(llm);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ voiceBrief: true, inputMode: 'VOICE' });
    expect(calls[0].screenText).toBe(r.screen!.text);
    expect(r.voice).toMatchObject({ path: 'B_COMPOSED', composerUsed: true, fallbackUsed: false, groundingStatus: 'VALIDATED', purpose: 'SEARCH_RESULTS', turnId: 'turn_test', question: 'Kaunsi chahiye?' });
    expect(r.voice!.reasons).toEqual(expect.arrayContaining(['SCREEN_MANY_TRAINS']));
    expect(r.text).toBe(r.voice!.text);
    expect(r.text).not.toBe(r.screen!.text);                    // speechText ≠ screenText (same authoritative facts)
    expect(r.voice!.speechLength).toBeGreaterThanOrEqual(10);
    expect(r.voice!.speechLength).toBeLessThanOrEqual(35);
  });

  it('[2] multiple trains: the voice never reads every train (no list), the screen still has all three', async () => {
    const { llm } = scripted('3 trainein mili hain, sabse pehli 12014 subah 04:55 par hai. Baaki options screen par hain. Kaunsi chahiye?');
    const r = await searchTurn(llm);
    expect(r.voice!.path).toBe('B_COMPOSED');
    const spokenTrains = r.voice!.factsUsed.filter(f => f.type === 'TRAIN').map(f => f.value);
    expect(spokenTrains.length).toBeLessThanOrEqual(2);
    expect(r.text).not.toContain('18238');
    expect(assessSpeechSuitability(r.text).suitable).toBe(true);
  });

  it('[3] Path A: a short, speech-suitable validated reply is reused — no extra LLM call', async () => {
    const { llm, calls } = scripted('SHOULD NOT BE CALLED');
    const r = await naturalResponseComposer.compose(input(SELECTED, { llm, userText: '12014 wali kar do', agentText: '12014 select ho gayi. CC ya 2S — kaunsi class chahiye?',
      backendReply: '12014 Amritsar Shatabdi Express select ho gayi. 12014 mein CC aur 2S available hain. Kaunsi class chahiye?', deterministicSpeech: '12014 select ho gayi. Kaunsi class chahiye?', appliedActions: ['TRAIN_SELECTED'] }));
    expect(calls).toHaveLength(0);
    expect(r.voice).toMatchObject({ path: 'A_REUSED', composerUsed: false, fallbackUsed: false });
    expect(r.text).toBe(r.screen!.text);
  });

  it('[4] selection: purpose SELECTION, question kept', async () => {
    const { llm } = scripted(null);
    const r = await naturalResponseComposer.compose(input(SELECTED, { llm, userText: 'pehli wali', agentText: '12014 select ho gayi. Kaunsi class chahiye?', appliedActions: ['TRAIN_SELECTED'],
      backendReply: '12014 select ho gayi. Kaunsi class chahiye?', deterministicSpeech: '12014 select ho gayi. Kaunsi class chahiye?' }));
    expect(r.voice!.purpose).toBe('SELECTION');
    expect(r.voice!.question).toContain('class');
  });

  it('[5] availability: a status that is not in an availability result is never spoken (brief rejected → validated reply)', async () => {
    const { llm } = scripted('12014 mein CC ki seats available hain, WL 12 nahi. Kaunsi chahiye?');
    const r = await searchTurn(llm);
    expect(r.voice).toMatchObject({ composerUsed: false, fallbackUsed: true, path: 'A_REUSED' });
    expect(r.text).not.toMatch(/seats available|WL 12/);
    const v = voiceResponseGrounding.validate('CC mein WL 12 hai.', { texts: ['12014 CC: AVAILABLE-0040'] });
    expect(v.ok).toBe(false);
    expect(v.rejected).toEqual(expect.arrayContaining(['UNSUPPORTED_AVAILABILITY:WL 12']));
    expect(voiceResponseGrounding.validate('CC mein AVAILABLE 40 hai.', { texts: ['12014 CC: AVAILABLE-0040'] }).ok).toBe(true);
  });

  it('[6] fare: no ₹ amount without fare authority; a ₹ amount must match exactly', async () => {
    const { llm } = scripted('12014 ka CC fare ₹1125 hai. Kaunsi chahiye?');
    const r = await searchTurn(llm);
    expect(r.voice!.composerUsed).toBe(false);
    expect(r.text).not.toContain('₹1125');
    expect(voiceResponseGrounding.validate('Total ₹1,125 hai.', { texts: ['Total fare ₹1125.'] }).ok).toBe(true);
    expect(voiceResponseGrounding.validate('Total ₹1152 hai.', { texts: ['Total fare ₹1125.'] }).rejected).toEqual(['UNSUPPORTED_FARE:1152']);
    expect(voiceResponseGrounding.validate('Fare ₹520 per passenger.', { texts: [], data: { fare: { perPassenger: 520, total: 1040 } } }).ok).toBe(true);
  });

  it('[7] live status: provider rendering only — never composed, no extra LLM call', async () => {
    const { llm, calls } = scripted('Train 2 ghante late hai.');
    const backend = '12014 abhi Ludhiana ke paas hai, 10 min late. Aur kuch?';
    const r = await naturalResponseComposer.compose(input(SEARCH, { llm, userText: '12014 kahan hai', backendReply: backend, deterministicSpeech: backend, agentText: backend,
      steps: [step('TRACK_TRAIN', true, { trainNumber: '12014', delayMinutes: 10 })] }));
    expect(calls).toHaveLength(0);
    expect(r.voice).toMatchObject({ purpose: 'LIVE_STATUS', composerUsed: false });
    expect(r.text).toContain('10 min late');
  });

  it('[8] PNR: never composed; a PNR-like number not in the result is rejected by the validator', async () => {
    const { llm, calls } = scripted('PNR confirmed hai.');
    const backend = 'PNR status: CNF, coach C2. Aur kuch?';
    const r = await naturalResponseComposer.compose(input(SEARCH, { llm, userText: 'PNR check karo', backendReply: backend, deterministicSpeech: backend, agentText: backend,
      steps: [step('CHECK_PNR', true, { status: 'CNF' })] }));
    expect(calls).toHaveLength(0);
    expect(r.voice!.purpose).toBe('PNR');
    expect(voiceResponseGrounding.validate('PNR 4512345678 confirmed hai.', { texts: [backend] }).rejected).toContain('UNSUPPORTED_PNR');
  });

  it('[9] passenger collection: conversational, Path A, purpose PASSENGER_COLLECTION', async () => {
    const { llm, calls } = scripted(null);
    const r = await naturalResponseComposer.compose(input(PAX, { llm, userText: 'CC', agentText: 'CC theek hai. Kitne passengers hain?', appliedActions: ['CLASS_SELECTED'],
      backendReply: 'CC class select ho gayi. Kitne passengers hain?', deterministicSpeech: 'CC class select ho gayi. Kitne passengers hain?', pendingQuestionCode: 'ASK_PASSENGERS_COUNT', pendingQuestion: 'Kitne passengers hain?' }));
    expect(calls).toHaveLength(0);
    expect(r.voice!.purpose).toBe('PASSENGER_COLLECTION');
    expect(r.voice!.question).toBe('Kitne passengers hain?');
    expect(r.text.match(/passengers hain\?/g)).toHaveLength(1);           // asked once, not repeated
  });

  it('[10] passenger correction: purpose CORRECTION; success wording only from the backend reply', async () => {
    const { llm } = scripted(null);
    const r = await naturalResponseComposer.compose(input(REVIEW, { llm, userText: 'Ravi ki age 29 hai', agentText: 'Ravi ki age update ho gayi.', changes: [{ field: 'passengers', corrected: true }],
      backendReply: 'Ravi ki age update ho gayi.', deterministicSpeech: 'Ravi ki age update ho gayi.', stateBefore: BookingState.AWAITING_CONFIRMATION, reviewVersionBefore: REVIEW.review?.reviewVersion ?? null }));
    expect(r.voice!.purpose).toBe('CORRECTION');
  });

  it('[11] review: deterministic review text (5 sentences) → voice brief that still carries train / class / fare / availability (P33 informed confirmation)', async () => {
    const { llm, calls } = scripted('Review ready hai: 12014 CC, total fare ₹1040, availability Available. Baaki details screen par hain. Confirm karna hai?');
    const r = await naturalResponseComposer.compose(input(REVIEW, { llm, userText: '2 passengers. Mohit 31 male, Ravi 28 male.', backendReply: REVIEW_REPLY, deterministicSpeech: REVIEW_REPLY,
      stateBefore: BookingState.BOOKING_PREPARE, allowWordingCall: false, pendingQuestionCode: 'ASK_REVIEW_APPROVAL', pendingQuestion: 'Confirm karna hai?' }));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(r.voice).toMatchObject({ purpose: 'REVIEW', path: 'C_COMPOSED', composerUsed: true });
    for (const f of ['12014', 'CC', '₹1040']) expect(r.text).toContain(f);
    expect(r.screen!.text).toContain('Amritsar');                     // the screen keeps the full review
  });

  it('[12] review: a brief that drops the fare falls back to the validated review speech (never confirm unheard facts)', async () => {
    const { llm } = scripted('Review ready hai, details screen par dekh lijiye. Sab sahi hai?');
    const r = await naturalResponseComposer.compose(input(REVIEW, { llm, userText: 'ok', backendReply: REVIEW_REPLY, deterministicSpeech: REVIEW_REPLY,
      stateBefore: BookingState.BOOKING_PREPARE, allowWordingCall: false, pendingQuestionCode: 'ASK_REVIEW_APPROVAL', pendingQuestion: 'Confirm karna hai?' }));
    expect(r.voice).toMatchObject({ composerUsed: false, fallbackUsed: true, path: 'C_DETERMINISTIC' });
    expect(r.voice!.reasons).toContain('COMPOSER_REVIEW_FACTS_MISSING');
    expect(r.text).toContain('₹1040');
  });

  it('[13] confirmation: a "ticket book ho gaya" brief is rejected; the confirmation-request speech never claims booking', async () => {
    const { llm } = scripted('Ticket book ho gaya hai! Aapka PNR jaldi aayega.');
    const det = 'Confirmation request ready hai. Details verified hain, ticket abhi book nahi hua. IRCTC par continue karun?';
    const r = await naturalResponseComposer.compose(input({ ...REVIEW, bookingState: BookingState.IRCTC_HANDOFF_READY }, { llm, userText: 'haan confirm',
      agentText: `${det} ${REVIEW_REPLY} ${SEARCH_SCREEN}`, backendReply: det, deterministicSpeech: det, stateBefore: BookingState.AWAITING_CONFIRMATION }));
    expect(r.voice!.purpose).toBe('CONFIRMATION');
    expect(r.voice!.composerUsed).toBe(false);
    expect(r.text).not.toMatch(/book ho gaya|PNR jaldi/i);
    expect(r.text).toMatch(/book nahi/i);
  });

  it('[14] booking disabled: never composed; the boundary is stated', async () => {
    const { llm, calls } = scripted('Theek hai, ho gaya.');
    const msg = 'Booking details verify ho gaye hain. Actual railway booking abhi enabled nahi hai.';
    const r = await naturalResponseComposer.compose(input(REVIEW, { llm, userText: 'book kar do', agentText: 'Theek hai.', backendReply: msg, deterministicSpeech: msg,
      error: { code: 'BOOKING_EXECUTION_DISABLED', message: msg } }));
    expect(calls).toHaveLength(0);
    expect(r.voice).toMatchObject({ purpose: 'BOOKING_DISABLED', composerUsed: false });
    expect(r.text).toMatch(/enabled nahi/);
  });

  it('[15] tool error: purpose ERROR; spoken text has no technical codes', async () => {
    const { llm } = scripted(null);
    const msg = 'Railway service ka response abhi nahi aa raha. Thodi der baad dobara check karte hain.';
    const r = await naturalResponseComposer.compose(input(SEARCH, { llm, userText: 'availability check karo', agentText: msg, backendReply: msg, deterministicSpeech: msg,
      steps: [step('CHECK_AVAILABILITY', false, null, { code: 'PROVIDER_TIMEOUT', message: 'timeout' })] }));
    expect(r.voice!.purpose).toBe('ERROR');
    expect(r.text).not.toMatch(/PROVIDER_TIMEOUT|[A-Z]{3,}_[A-Z]{3,}/);
  });

  it('[16] composer timeout → the validated short response, fast (latency threshold)', async () => {
    const { llm } = scripted('Kal ke liye 3 trainein mili hain. Kaunsi chahiye?', { delayMs: 400 });
    const t0 = Date.now();
    const r = await searchTurn(llm, { timeoutMs: 60 });
    expect(Date.now() - t0).toBeLessThan(350);
    expect(r.voice).toMatchObject({ composerUsed: false, fallbackUsed: true, path: 'A_REUSED' });
    expect(r.voice!.reasons).toContain('COMPOSER_TIMEOUT');
    expect(r.text).toBe(r.screen!.text.length ? r.voice!.text : '');
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('[16b] composer timeout on a screen-oriented validated reply → concise selection of validated sentences + "screen par" (no list read out, no new fact)', async () => {
    const listReply = 'CC class ke liye aapko koi aur train chuni padegi. Subah ki list mein CC wali trains hain: 12014 (AMRITSAR SHTABDI – 04:55), 12497 (06:35), 18238 (19:35). Kaunsi train aur class select karni hai?';
    const { llm } = scripted('late', { delayMs: 400 });
    const r = await naturalResponseComposer.compose(input(SEARCH, { llm, agentText: listReply, backendReply: listReply, deterministicSpeech: listReply, timeoutMs: 60,
      steps: [step('SEARCH_TRAINS', true, { trains: SEARCH.searchResults.trains })] }));
    expect(r.voice).toMatchObject({ composerUsed: false, fallbackUsed: true });
    expect(r.voice!.reasons).toEqual(expect.arrayContaining(['COMPOSER_TIMEOUT', 'CONCISE_FALLBACK']));
    expect(r.screen!.text).toContain('18238');                       // the screen keeps the full list
    expect(r.text).not.toContain('18238');                           // the voice does not read it
    expect(r.text).toMatch(/screen par/);
    expect(r.text).toMatch(/Kaunsi train aur class select karni hai\?$/);
    expect(voiceResponseGrounding.validate(r.text, { texts: [r.screen!.text] }).ok).toBe(true);
  });

  it('[17] provider failure → validated short response (never an error to the user)', async () => {
    const { llm } = scripted('x', { throws: true });
    const r = await searchTurn(llm);
    expect(r.voice).toMatchObject({ composerUsed: false, fallbackUsed: true });
    expect(r.voice!.reasons).toContain('COMPOSER_PROVIDER_ERROR');
    expect(r.text.length).toBeGreaterThan(0);
  });

  it('[18] long screen content (80+ words) is detected as not speech-suitable', () => {
    const long = Array.from({ length: 12 }, (_, k) => `Yeh line number ${k + 1} hai screen ke liye.`).join(' ');
    const a = assessSpeechSuitability(long);
    expect(a.suitable).toBe(false);
    expect(a.reasons).toEqual(expect.arrayContaining(['TOO_MANY_WORDS', 'TOO_MANY_SENTENCES']));
    expect(assessSpeechSuitability(SEARCH_SCREEN).reasons).toEqual(expect.arrayContaining(['MANY_TRAINS', 'LIST_MARKERS']));
    expect(assessSpeechSuitability('12014 select ho gayi. Kaunsi class chahiye?').suitable).toBe(true);
  });

  it('[19] Hindi: Hindi user → Hindi brief accepted (facts unchanged)', async () => {
    const { llm, calls } = scripted('कल के लिए 3 ट्रेनें मिली हैं। सबसे पहली 12014 है, सुबह 04:55 वाली। कौन सी चाहिए?');
    const r = await searchTurn(llm, { userText: 'अमृतसर से दिल्ली कल जाना है' });
    expect(calls[0].language).toBe('HINDI');
    expect(r.voice!.path).toBe('B_COMPOSED');
    expect(r.language).toBe('HINDI');
    expect(r.text).toContain('12014');
  });

  it('[20] Hinglish: Hinglish user → Hinglish style passed to the provider', async () => {
    const { llm, calls } = scripted('Kal ke liye 3 trainein mili hain. Sabse pehli 12014 hai. Kaunsi chahiye?');
    const r = await searchTurn(llm, { userText: 'Amritsar se Delhi kal jaana hai' });
    expect(calls[0].language).toBe('HINGLISH');
    expect(r.voice!.composerUsed).toBe(true);
  });

  it('[21] English: English user → English brief', async () => {
    const { llm, calls } = scripted('I found 3 trains for tomorrow. The earliest is 12014 at 04:55. Which one would you like?');
    const r = await searchTurn(llm, { userText: 'I want to go from Amritsar to Delhi tomorrow' });
    expect(calls[0].language).toBe('ENGLISH');
    expect(r.voice).toMatchObject({ path: 'B_COMPOSED', composerUsed: true });
  });

  it('[22] unsupported fact rejection: an invented train / station / time in the brief → validated reply instead', async () => {
    for (const bad of ['3 trainein mili hain, sabse pehli 22440 hai. Kaunsi chahiye?', '3 trainein mili hain, sabse pehli 12014 subah 05:10 par hai. Kaunsi chahiye?', 'Mumbai se 3 trainein mili hain. Kaunsi chahiye?']) {
      const { llm } = scripted(bad);
      const r = await searchTurn(llm);
      expect(r.voice, bad).toMatchObject({ composerUsed: false, fallbackUsed: true });
      expect(r.text).not.toMatch(/22440|05:10|Mumbai/);
    }
  });

  it('[23] numeric safety: 12014 ≠ 12:14, 3A ≠ 3 AM — the validator never accepts the confusion', () => {
    const auth = { texts: ['12014 Amritsar Shatabdi, class 3A, fare ₹1125.'] };
    expect(voiceResponseGrounding.validate('12:14 baje chalegi.', auth).rejected).toEqual(['UNSUPPORTED_TIME:12:14']);
    expect(voiceResponseGrounding.validate('3 AM wali seat.', auth).rejected).toEqual(['UNSUPPORTED_TIME:3 AM']);
    expect(voiceResponseGrounding.validate('12014 mein 3A ka fare ₹1125 hai.', auth).ok).toBe(true);
    expect(extractVoiceFacts('12014 mein 3A, 04:55 par, ₹1125')).toEqual(expect.arrayContaining([
      { type: 'TRAIN', value: '12014' }, { type: 'CLASS', value: '3A' }, { type: 'TIME', value: '04:55' }, { type: 'FARE', value: '₹1125' }]));
    expect(extractVoiceFacts('12014').some(f => f.type === 'TIME')).toBe(false);
  });

  it('[24] train number + fare safety through polish and the EXISTING pronunciation layer (applied after composing)', () => {
    const spoken = polishSpeech(['Bilkul ji...', 'Bilkul, 12014 ka CC fare ₹1125 hai…', 'Ji, kaunsi chahiye?']);
    expect(spoken).toEqual(['Bilkul ji.', '12014 ka CC fare ₹1125 hai.', 'Ji, kaunsi chahiye?']);
    expect(spoken.join(' ')).not.toMatch(/\.\.\.|…/);
    const rendered = renderForSpeech(spoken.join(' '), 'HINGLISH');
    expect(digitFacts(rendered)).toEqual(expect.arrayContaining(['12014', '1125']));
    expect(rendered).not.toMatch(/12:14/);
    expect(VOICE_BRIEF_PROMPT).not.toMatch(/pronounc|spell/i);         // pronunciation is NOT in the LLM prompt
  });

  it('[25] fallback: provider returns nothing / only ungrounded text → existing validated short response (Path A / C)', async () => {
    const none = await searchTurn(scripted(null).llm);
    expect(none.voice).toMatchObject({ composerUsed: false, fallbackUsed: true });
    expect(none.voice!.reasons.some(x => /^COMPOSER_/.test(x))).toBe(true);
    const det = await naturalResponseComposer.compose(input(SEARCH, { llm: scripted('Abhi 7 trainein hain, ₹999 se shuru.').llm, agentText: null, allowWordingCall: false }));
    expect(det.voice!.path).toBe('C_DETERMINISTIC');
    expect(det.text).not.toMatch(/₹999|7 trainein/);
  });
});

// ================================================================= contract / pipeline / observability
describe('P41 G2 — VoiceResponse contract, pipeline, Play Again, observability', () => {
  it('[26] contract shape {text, purpose, factsUsed, question, speechLength, turnId}; factsUsed never carries passenger names', async () => {
    const { llm } = scripted('Review ready hai: 12014 CC, total fare ₹1040, availability Available. Baaki details screen par. Confirm karna hai?');
    const r = await naturalResponseComposer.compose(input(REVIEW, { llm, userText: 'ok', backendReply: REVIEW_REPLY, deterministicSpeech: REVIEW_REPLY, stateBefore: BookingState.BOOKING_PREPARE, allowWordingCall: false }));
    const v = r.voice!;
    expect(Object.keys(v)).toEqual(expect.arrayContaining(['text', 'purpose', 'factsUsed', 'question', 'speechLength', 'turnId']));
    expect(v.speechLength).toBe(wordCount(v.text));
    expect(JSON.stringify(v.factsUsed)).not.toMatch(/Mohit|Ravi/);
  });

  it('[27] end-to-end VOICE turn: engine outcome carries voiceResponse; one metadata-only log record (no text / PII / keys); TEXT mode unchanged', async () => {
    const h = mk();
    const r = await h.say('Amritsar se Delhi kal');
    expect(r.voice.voiceResponse).toMatchObject({ purpose: 'SEARCH_RESULTS', turnId: r.voice.turnId });
    expect(r.voice.segments.join(' ')).toBe(r.voice.speechText);
    const recs = logSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes('"voice_response"')).map(l => JSON.parse(l));
    expect(recs).toHaveLength(1);
    expect(Object.keys(recs[0]).sort()).toEqual(['composerLatencyMs', 'composerUsed', 'fallbackUsed', 'groundingStatus', 'kind', 'latencyMs', 'path', 'purpose', 'reasons', 'sessionId', 'speechLength', 'turnId', 'voiceResponseGenerated'].sort());
    expect(JSON.stringify(recs[0])).not.toMatch(/Amritsar|12014|trainein/);
    expect(r.turnLog.voiceTurn).toMatchObject({ voiceResponseGenerated: true, voicePath: expect.any(String) });
    const t = mk();
    const rt = await t.say('Amritsar se Delhi kal', 'TEXT');
    expect(rt.speech?.voiceResponse).toBeUndefined();
    expect(rt.voice.voiceResponse).toBeUndefined();
  });

  it('[28] Play Again replays the SAME VoiceResponse (no new turn / LLM call); barge-in marks it stale and it is never resumed', async () => {
    const tts = new MockStreamingTTS();
    const calls: string[] = [];
    let n = 0;
    const segs = ['Kal ke liye 3 trainein mili hain.', 'Kaunsi chahiye?'];
    const proc: TurnProcessor = async (text, x) => {
      calls.push(text); const k = ++n;
      x.onEvent({ type: 'TURN_STARTED', turnId: `t${k}`, sequence: k });
      return { sessionId: 's1', turnId: `t${k}`, sequence: k, presentable: true, assistantText: 'SCREEN TEXT (longer)', speechText: segs.join(' '), segments: segs, shouldSpeak: true, interruptible: true, responsePriority: x.priority,
        voiceResponse: { purpose: 'SEARCH_RESULTS', factsUsed: [], question: 'Kaunsi chahiye?', speechLength: 8, turnId: `t${k}`, path: 'B_COMPOSED' } } as VoiceTurnOutcome;
    };
    const agent = new ConversationalVoiceAgent({ sessionId: 's1', processTurn: proc, output: tts, input: new MockStreamingSTT(), now: () => 1000 });
    tts.failNext = 1;
    await agent.processTurn('Amritsar se Delhi kal', { normalize: false });
    await flush();
    expect(agent.retrySpeech()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(tts.playing).toBe(segs[0]);                                  // the SAME voice segments, not the screen text
    tts.finish(); await flush(); tts.finish(); await flush();
    expect(tts.spoken.filter(x => x.status === 'DONE').map(x => x.text)).toEqual(segs);
    // barge-in during speech: stale, never resumed
    await agent.processTurn('subah ki dikhao', { normalize: false }); await flush();
    expect(tts.playing).toBe(segs[0]);
    agent.interrupt('BARGE_IN');
    expect(tts.playing).toBeNull();
    expect(agent.retrySpeech()).toBe(false);
    expect(calls).toHaveLength(2);
    expect(segmentForSpeech(segs.join(' '))).toEqual(segs);
  });

  it('[29] polish: at most one acknowledgement, no "..." spam, no repeated "ji ji"; a question is never dropped', () => {
    expect(polishSpeech(['Bilkul!', 'Theek hai, 3 trainein mili hain.', 'Ji ji, kaunsi chahiye?'])).toEqual(['Bilkul!', '3 trainein mili hain.', 'Ji, kaunsi chahiye?']);
    expect(polishSpeech(['Haan.', 'Theek hai?'])).toEqual(['Haan.', 'Theek hai?']);
    expect(polishSpeech(['Achha...', 'Okay.'])).toEqual(['Achha.']);
  });

  it('[30] latency budget + log record helpers are bounded and metadata-only', () => {
    expect(voiceComposerTimeoutMs({})).toBe(4500);
    expect(voiceComposerTimeoutMs({ VOICE_COMPOSER_TIMEOUT_MS: '2500' })).toBe(2500);
    expect(voiceComposerTimeoutMs({ VOICE_COMPOSER_TIMEOUT_MS: '999999' })).toBe(4500);
    const rec = voiceResponseLogRecord('s1', { text: 'SECRET TEXT Mohit', segments: ['SECRET TEXT Mohit'], purpose: 'INFO', factsUsed: [{ type: 'TRAIN', value: '12014' }], question: null, speechLength: 3, turnId: 't1', path: 'A_REUSED', composerUsed: false, fallbackUsed: false, groundingStatus: 'VALIDATED', composerLatencyMs: null, reasons: [] }, 5);
    expect(JSON.stringify(rec)).not.toMatch(/SECRET|Mohit|12014/);
  });
});
