/**
 * P42.12 — PRE-SELECTION AVAILABILITY MUST REMAIN ALLOWED WHEN CONTEXT SUPPORTS IT.
 * Real orchestrator + turn engine + validator + runtime + composer; a fake OpenAI-compatible server plays Muse; the mock
 * railway provider serves ASR→NDLS: 1 → 12014 04:55 (CC "Available", 2S "Available") · 2 → 12497 06:35 (3A "Available",
 * CC "RAC 4", SL "Waitlist 12", 2S "Available") · 3 → 18238 19:35 (3A "Available", SL "Waitlist 8").
 *   [1] search-row availability shown before any selection        [2] "kaunsi train mein seat hai?" from the rows, no SELECT
 *   [3] specific listed train (named) while ANOTHER is selected      [4] display index while another train is selected; no substitution
 *   [5] unique natural reference (tool + row answer)                [6] ambiguous reference → AMBIGUOUS_REFERENCE, no guess
 *   [7] unknown train → rejected, never substituted                 [8] missing / stale context → typed rejection, no claim
 *   [9] cross-train / cross-class claims rejected; CHECK wins       [10] a WL / RLWL position is never seats
 *   [11] explicit fresh request → provider call; rows never answer  [12] timeout / unknown stays unknown
 *   [13] text / voice parity
 * No network, no credits, no booking.
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
import { collectAvailabilityEvidence, judgeAvailabilityClaim, searchRowAvailability, type AvailabilityContext } from '../../server/ai/response/availability-authority';
import { FakeOpenAI, type TurnView } from '../helpers/fake-openai-server';

railwayRegistry.register('p4212', () => new MockRailwayProvider());
const ist = (days: number) => new Date(Date.now() + 5.5 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
const D1 = ist(1);
type Mode = 'TEXT' | 'VOICE';
const MODES: Mode[] = ['TEXT', 'VOICE'];
const U = (intent: string, action: string, entities: any = {}) => ({ name: 'update_booking_session', args: { intent, action, entities } });
const SEARCH = { name: 'SEARCH_TRAINS', args: { origin: 'Amritsar', destination: 'Delhi', date: D1 } };
const AV = (args: any) => ({ name: 'CHECK_AVAILABILITY', args });
const SEARCH_T = 'Kal Amritsar se Delhi ki trains dikhao';
const SEARCH_TURN = { [SEARCH_T]: [{ calls: [SEARCH] }, { content: 'Kal ke liye 3 trains mili hain.' }] };
const SELECT_12014 = { '12014 CC select karo': [{ calls: [U('BOOK_TRAIN', 'SELECT_TRAIN', { trainRef: { kind: 'TRAIN_NUMBER', value: '12014' }, classRaw: 'CC', selectionPurpose: 'BOOKING' })] }, { content: '12014 CC select ho gayi.' }] };

function stack(plan: Record<string, any[]>) {
  const views: TurnView[] = [];
  const fake = new FakeOpenAI((v: TurnView) => { views.push(v); const p = plan[v.user]; const st = p && v.step < p.length ? p[v.step] : { content: 'Theek hai.' }; return typeof st === 'function' ? st(v) : st; });
  const sel = createLLMProvider({ LLM_PROVIDER: 'openai-compatible', LLM_API_KEY: 'sk-test-P4212', LLM_MODEL: 'fake-muse', LLM_BASE_URL: 'https://llm.fake.test/v1' }, { fetch: fake.fetch });
  const state = new ConversationStateManager();
  const orch = new ConversationAgentOrchestrator(sel.provider, state, new RailwayToolService());
  (orch as any).runtime.toolRuntime = new RailwayToolRuntime({ timeoutMs: 300, sleep: async () => { /* no backoff */ } });
  const eng = new ConversationTurnEngine(orch, state, { longWaitMs: 0 });
  const sid = state.createSession().sessionId;
  return { fake, views, say: (t: string, mode: Mode = 'TEXT') => eng.processTurn(sid, t, mode) as Promise<any>, s: () => state.getSession(sid) as any };
}
const text = (r: any) => String(r?.voice?.assistantText ?? r?.responseMessage ?? '');
const execsOf = (r: any) => ((r?.turnLog?.toolExecutions || []) as any[]);
const tools = (r: any) => execsOf(r).map(x => [x.tool, x.status, x.rejectionReason ?? null]);
const av = (r: any) => execsOf(r).filter(x => x.tool === 'CHECK_AVAILABILITY').map(x => [x.status, x.rejectionReason ?? null]);
const rejected = (r: any) => (r?.turnLog?.naturalSpeech?.rejected || []) as string[];
const selected = (h: any) => h.s().selectedTrain ? String(h.s().selectedTrain.number ?? h.s().selectedTrain.trainNumber) : null;

/** offline authority context over a live-shaped search row set (RailCore raw strings + provider categories) */
const liveRows = (extra: any = {}) => ({
  origin: 'ASR', destination: 'NDLS', date: D1, selectedTrain: null, ...extra,
  searchResults: { date: D1, origin: 'ASR', destination: 'NDLS', resultId: 'rs_live', trains: [
    { trainNumber: '18310', classes: [{ code: 'SL', availability: 'RLWL93/WL65', availabilityStatus: 'WAITLIST' }, { code: '3A', availability: 'RLWL83/WL68', availabilityStatus: 'WAITLIST' }] },
    { trainNumber: '22488', classes: [{ code: 'CC', availability: 'CURR_AVBL-0241', availabilityStatus: 'AVAILABLE' }, { code: 'EC', availability: 'AVAILABLE-0001', availabilityStatus: 'AVAILABLE' }] },
    { trainNumber: '12498', classes: [{ code: 'CC', availability: 'GNWL/AVAILABLE', availabilityStatus: 'AVAILABLE' }, { code: '2S', availability: 'AVAILABLE-0386', availabilityStatus: 'AVAILABLE' }] },
    { trainNumber: '14680', classes: [{ code: 'CC', availability: 'TRAIN CANCELLED', availabilityStatus: 'UNKNOWN' }] },
    { trainNumber: '12904', classes: [{ code: 'SL', availability: 'GNWL1/WL1', availabilityStatus: 'WAITLIST' }, { code: '3A', availability: null, availabilityStatus: 'UNKNOWN' }, { code: '2A', availability: 'TIMEOUT', availabilityStatus: 'UNKNOWN' }] }
  ] }
});
const actx = (s: any, steps: any[] = [], userText?: string): AvailabilityContext => ({ session: s, evidence: collectAvailabilityEvidence(s, steps, { userText }) });

let fetchSpy: any; let availSpy: any;
beforeEach(() => {
  railwayRegistry.setActive('p4212');
  fetchSpy = vi.spyOn(globalThis, 'fetch' as any).mockImplementation(() => { throw new Error('network forbidden in tests'); });
  availSpy = vi.spyOn(MockRailwayProvider.prototype, 'checkAvailability');
});
afterEach(() => { expect(fetchSpy).not.toHaveBeenCalled(); vi.restoreAllMocks(); railwayRegistry.setActive('mock'); });

describe('P42.12 — availability before selection (search rows are provider availability)', () => {
  it('[1] search-result availability is shown in the search turn itself — no selection, no CHECK_AVAILABILITY, nothing removed', async () => {
    for (const mode of MODES) {
      const h = stack({ [SEARCH_T]: [{ calls: [SEARCH] }, { content: '12014 mein CC available hai. 12497 mein CC RAC 4 hai. 18238 mein SL Waitlist 8 hai.' }] });
      const r = await h.say(SEARCH_T, mode);
      expect(tools(r), mode).toEqual([['SEARCH_TRAINS', 'SUCCEEDED', null]]);
      expect(rejected(r), mode).toEqual([]);
      expect(text(r), mode).toMatch(/^12014 mein CC available hai\. 12497 mein CC RAC 4 hai\. 18238 mein SL Waitlist 8 hai\./);
      expect(r.turnLog.diagnostics.validation.claimTypes, mode).toMatchObject({ RAILWAY_LIVE_FACT: 3 });
      expect(selected(h), mode).toBeNull();
      expect(availSpy, mode).not.toHaveBeenCalled();
    }
  }, 30000);

  it('[2] "Kaunsi train mein CC seat available hai?" — answered from the current rows: no SELECT_TRAIN, no provider call, grounded', async () => {
    const h = stack({ ...SEARCH_TURN, 'Kaunsi train mein CC seat available hai?': [{ content: '12014 mein CC available hai. 12497 mein CC RAC 4 hai.' }] });
    await h.say(SEARCH_T);
    const r = await h.say('Kaunsi train mein CC seat available hai?');
    expect(tools(r)).toEqual([]);
    expect(rejected(r)).toEqual([]);
    expect(text(r)).toMatch(/^12014 mein CC available hai\. 12497 mein CC RAC 4 hai\./);
    expect(selected(h)).toBeNull();
    expect(h.s().availability || {}).toEqual({});                       // a displayed row is not a committed CHECK result
    expect(availSpy).not.toHaveBeenCalled();
  }, 30000);

  it('[3] specific listed train while ANOTHER train is selected → CHECK_AVAILABILITY executes (no CONTEXT_CONFLICT), selection unchanged', async () => {
    const h = stack({ ...SEARCH_TURN, ...SELECT_12014,
      'Shan-e-Punjab ki SL availability check karo': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }] });
    await h.say(SEARCH_T); await h.say('12014 CC select karo');
    const r = await h.say('Shan-e-Punjab ki SL availability check karo');
    expect(av(r)).toEqual([['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.at(-1)![0]).toMatchObject({ trainNumber: '12497', travelClass: 'SL', date: D1 });
    expect(text(r)).toMatch(/^12497 mein SL Waitlist 12 hai\./);
    expect(selected(h)).toBe('12014');
    expect(h.s().selectedClass).toBe('CC');
  }, 30000);

  it('[4] display index "doosri wali" while 12014 is selected → trainRef DISPLAY_INDEX resolves to 12497; an UNNAMED train the LLM maps itself is never substituted (asks)', async () => {
    const h = stack({ ...SEARCH_TURN, ...SELECT_12014,
      'Doosri wali ki SL availability': [{ calls: [AV({ trainRef: { kind: 'DISPLAY_INDEX', value: 2 }, travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }],
      'Doosri wali ka 3A dekho': [{ calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }, { content: 'Kaunsi train — 12014 ya 12497?' }],
      'Availability batao': [{ calls: [AV({ trainNumber: '18238', travelClass: 'SL' })] }, { content: '12014 selected hai. 18238 check karna hai?' }] });
    await h.say(SEARCH_T); await h.say('12014 CC select karo');
    const r1 = await h.say('Doosri wali ki SL availability');
    expect(av(r1)).toEqual([['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.at(-1)![0]).toMatchObject({ trainNumber: '12497', travelClass: 'SL' });
    const n0 = availSpy.mock.calls.length;
    const r2 = await h.say('Doosri wali ka 3A dekho');                 // a position mapped to a number by the LLM is unverifiable
    expect(av(r2)).toEqual([['REJECTED', 'CONTEXT_CONFLICT']]);
    const r3 = await h.say('Availability batao');                      // no reference at all → the selected train is meant
    expect(av(r3)).toEqual([['REJECTED', 'CONTEXT_CONFLICT']]);
    expect(availSpy.mock.calls.length).toBe(n0);                       // never a substituted provider call
    expect(selected(h)).toBe('12014');
  }, 30000);

  it('[5] unique natural reference: "evening wali" → 18238 (tool via TIME_PREFERENCE) and a row answer about it is grounded', async () => {
    const h = stack({ ...SEARCH_TURN, ...SELECT_12014,
      'Evening wali ki SL availability check karo': [{ calls: [AV({ trainRef: { kind: 'TIME_PREFERENCE', value: 'EVENING' }, travelClass: 'SL' })] }, { content: '18238 mein SL Waitlist 8 hai.' }],
      'Aur evening wali mein 3A?': [{ content: '18238 mein 3A available hai.' }] });
    await h.say(SEARCH_T); await h.say('12014 CC select karo');
    const r1 = await h.say('Evening wali ki SL availability check karo');
    expect(av(r1)).toEqual([['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.at(-1)![0]).toMatchObject({ trainNumber: '18238', travelClass: 'SL' });
    const n0 = availSpy.mock.calls.length;
    const r2 = await h.say('Aur evening wali mein 3A?');
    expect(rejected(r2)).toEqual([]);
    expect(text(r2)).toMatch(/^18238 mein 3A available hai\./);
    expect(availSpy.mock.calls.length).toBe(n0);
  }, 30000);
});

describe('P42.12 — invalid references and missing context stay rejected', () => {
  it('[6] ambiguous "morning wali" (12014 + 12497) → AMBIGUOUS_REFERENCE with candidates; provider NOT called; Muse asks', async () => {
    const h = stack({ ...SEARCH_TURN,
      'Morning wali ki CC availability': [{ calls: [AV({ trainRef: { kind: 'TIME_PREFERENCE', value: 'MORNING' }, travelClass: 'CC' })] },
        (v: TurnView) => { const e = v.results[0]?.content?.error || {}; return { content: e.code === 'AMBIGUOUS_REFERENCE' ? `Kaunsi train — ${e.candidates.join(' ya ')}?` : 'WRONG' }; }] });
    await h.say(SEARCH_T);
    const n0 = availSpy.mock.calls.length;
    const r = await h.say('Morning wali ki CC availability');
    expect(av(r)).toEqual([['REJECTED', 'AMBIGUOUS_REFERENCE']]);
    expect(text(r)).toBe('Kaunsi train — 12014 ya 12497?');
    expect(availSpy.mock.calls.length).toBe(n0);
  }, 30000);

  it('[7] unknown train: typed 99999 → INVALID_TRAIN_REFERENCE; an unlisted train Muse substitutes while 12014 is selected → CONTEXT_CONFLICT; its claim is removed', async () => {
    const h = stack({ ...SEARCH_TURN, ...SELECT_12014,
      '99999 ki SL availability': [{ calls: [AV({ trainNumber: '99999', travelClass: 'SL' })] }, { content: '99999 is list mein nahi hai.' }],
      'Rajdhani ki 3A availability': [{ calls: [AV({ trainNumber: '12425', travelClass: '3A' })] }, { content: '12425 mein 3A available hai.' }] });
    await h.say(SEARCH_T); await h.say('12014 CC select karo');
    const n0 = availSpy.mock.calls.length;
    const r1 = await h.say('99999 ki SL availability');
    expect(av(r1)).toEqual([['REJECTED', 'INVALID_TRAIN_REFERENCE']]);
    const r2 = await h.say('Rajdhani ki 3A availability');
    expect(av(r2)).toEqual([['REJECTED', 'CONTEXT_CONFLICT']]);          // not in the current results → never substituted
    expect(text(r2)).not.toMatch(/12425 mein 3A available/);
    expect(availSpy.mock.calls.length).toBe(n0);
    expect(selected(h)).toBe('12014');
  }, 30000);

  it('[8] missing context: no search → typed rejection and an availability claim is removed; a stale (other-date) row set proves nothing', async () => {
    const h = stack({ '12497 SL availability': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL available hai.' }] });
    const r = await h.say('12497 SL availability');
    expect(av(r)).toEqual([['REJECTED', 'INVALID_ACTION_FOR_STATE']]);
    expect(rejected(r)).toContain('UNVERIFIED_AVAILABILITY');
    expect(text(r)).not.toMatch(/12497 mein SL available/);
    expect(availSpy).not.toHaveBeenCalled();
    // rows of another journey date (the user changed the date, no new search) are never evidence
    const stale = liveRows({ date: ist(2) });
    expect(collectAvailabilityEvidence(stale, [])).toEqual([]);
    expect(judgeAvailabilityClaim('22488 mein CC available hai.', actx(stale)).outcome).toBe('UNVERIFIED_AVAILABILITY');
    // no result set at all
    expect(collectAvailabilityEvidence({ origin: 'ASR', destination: 'NDLS', date: D1 }, [])).toEqual([]);
  }, 30000);

  it('[9] entity safety: another train\'s / class\'s row never proves a claim; a newer CHECK_AVAILABILITY wins over the row', async () => {
    const h = stack({ ...SEARCH_TURN, 'CC mein kya scene hai?': [{ content: '12014 mein CC RAC 4 hai. 12014 mein SL available hai. 12497 mein CC RAC 4 hai.' }] });
    await h.say(SEARCH_T);
    const r = await h.say('CC mein kya scene hai?');
    expect(tools(r)).toEqual([]);
    expect(rejected(r)).toHaveLength(2);
    expect(rejected(r)[0]).toMatch(/^AVAILABILITY_MISMATCH/);            // 12497's RAC 4 is not 12014's (Available)
    expect(rejected(r)[1]).toMatch(/^(CLASS_NOT_LISTED|UNVERIFIED_AVAILABILITY)/);   // 12014 has no SL row
    expect(text(r)).toMatch(/^12497 mein CC RAC 4 hai\./);
    expect(text(r)).not.toMatch(/12014 mein/);
    // CHECK_AVAILABILITY (session entry) for the same train / class / date replaces the row
    const s = liveRows({ availability: { CC: { trainNumber: '22488', travelClass: 'CC', date: D1, status: 'WL 3', available: false, toolExecutionId: 'te_chk' } } });
    const c = actx(s);
    expect(c.evidence.filter(e => e.trainNumber === '22488' && e.travelClass === 'CC').map(e => [e.sourceTool, e.status])).toEqual([['CHECK_AVAILABILITY', 'WL 3']]);
    expect(judgeAvailabilityClaim('22488 mein CC available hai.', c).outcome).toBe('AVAILABILITY_MISMATCH');
    expect(judgeAvailabilityClaim('22488 CC mein WL 3 hai.', c)).toMatchObject({ outcome: 'VERIFIED_AVAILABILITY', provenance: { sourceTool: 'CHECK_AVAILABILITY' } });
    expect(judgeAvailabilityClaim('22488 mein EC available hai.', c)).toMatchObject({ outcome: 'VERIFIED_AVAILABILITY', provenance: { sourceTool: 'SEARCH_TRAINS', availability: 'AVAILABLE 1' } });
  }, 30000);

  it('[10] waitlist safety: RLWL83/WL68 is "WL 68" (never seats, never 83); GNWL1/WL1 is never "1 seat"; mock "Waitlist 12" is never 12 seats', async () => {
    expect(searchRowAvailability('RLWL83/WL68', 'WAITLIST')).toEqual({ status: 'WL 68', available: false });
    expect(searchRowAvailability('PQWL15/WL7', 'WAITLIST')).toEqual({ status: 'WL 7', available: false });
    expect(searchRowAvailability('CURR_AVBL-0241', 'AVAILABLE')).toEqual({ status: 'AVAILABLE 241', available: true });
    const c = actx(liveRows());
    expect(judgeAvailabilityClaim('18310 3A mein WL 68 hai.', c).outcome).toBe('VERIFIED_AVAILABILITY');
    expect(judgeAvailabilityClaim('18310 3A mein WL 83 hai.', c).reason).toBe('AVAILABILITY_MISMATCH:WL 83');
    expect(judgeAvailabilityClaim('18310 3A mein 68 seats available hain.', c).outcome).toBe('AVAILABILITY_MISMATCH');
    expect(judgeAvailabilityClaim('18310 3A mein 68 seats wait‑list mein hain.', c).reason).toBe('AVAILABILITY_MISMATCH:WL_POSITION_AS_SEATS');
    expect(judgeAvailabilityClaim('12904 SL mein 1 seat available hai.', c).outcome).toBe('AVAILABILITY_MISMATCH');
    expect(judgeAvailabilityClaim('12904 SL mein seat available hai.', c).outcome).toBe('AVAILABILITY_MISMATCH');
    expect(judgeAvailabilityClaim('12904 SL mein WL 1 hai.', c).outcome).toBe('VERIFIED_AVAILABILITY');
    const h = stack({ ...SEARCH_TURN, 'SL ka kya haal hai?': [{ content: '12497 mein SL 12 seats available hain. 12497 mein SL Waitlist 12 hai.' }] });
    await h.say(SEARCH_T);
    const r = await h.say('SL ka kya haal hai?');
    expect(rejected(r)).toHaveLength(1);
    expect(rejected(r)[0]).toMatch(/^AVAILABILITY_MISMATCH/);
    expect(text(r)).toMatch(/^12497 mein SL Waitlist 12 hai\./);
    expect(text(r)).not.toMatch(/12 seats/);
  }, 30000);
});

describe('P42.12 — freshness and unknown outcomes are unchanged', () => {
  it('[11] explicit "abhi dobara" → Muse calls the provider (executes, kept); a row-only answer to a fresh request is removed; a fresh search this turn counts', async () => {
    const h = stack({ ...SEARCH_TURN,
      '12497 SL abhi dobara check karo': [{ calls: [AV({ trainNumber: '12497', travelClass: 'SL' })] }, { content: '12497 mein SL Waitlist 12 hai.' }],
      'Abhi latest batao 12497 CC ka': [{ content: '12497 mein CC RAC 4 hai.' }],
      'Abhi ki kal ki trains dikhao, CC kisme available hai?': [{ calls: [SEARCH] }, { content: '12014 mein CC available hai.' }] });
    await h.say(SEARCH_T);
    const n0 = availSpy.mock.calls.length;
    const r1 = await h.say('12497 SL abhi dobara check karo');
    expect(av(r1)).toEqual([['SUCCEEDED', null]]);
    expect(availSpy.mock.calls.length - n0).toBe(1);                     // a NEW provider call even though the row exists
    expect(rejected(r1)).toEqual([]);
    const r2 = await h.say('Abhi latest batao 12497 CC ka');
    expect(tools(r2)).toEqual([]);
    expect(rejected(r2)).toEqual(['UNVERIFIED_AVAILABILITY']);         // the earlier row never answers a fresh request
    expect(text(r2)).not.toMatch(/RAC 4/);
    const r3 = await h.say('Abhi ki kal ki trains dikhao, CC kisme available hai?');
    expect(tools(r3)).toEqual([['SEARCH_TRAINS', 'SUCCEEDED', null]]);
    expect(rejected(r3)).toEqual([]);                                   // rows fetched THIS turn are fresh
    expect(text(r3)).toMatch(/^12014 mein CC available hai\./);
  }, 30000);

  it('[12] a CHECK that times out this turn stays a timeout (the row never stands in); unknown / null / TIMEOUT / contradicting rows prove nothing', async () => {
    const h = stack({ ...SEARCH_TURN,
      '12014 CC availability check karo': [{ calls: [AV({ trainNumber: '12014', travelClass: 'CC' })] }, { content: '12014 mein CC available hai.' }] });
    await h.say(SEARCH_T);
    availSpy.mockImplementation(() => new Promise(() => { /* never answers → runtime timeout */ }));
    const r = await h.say('12014 CC availability check karo');
    expect(av(r).map(x => x[0])).toEqual(['TIMEOUT']);                 // the outcome is reported as a timeout
    expect(rejected(r)).toEqual(['UNVERIFIED_AVAILABILITY']);
    expect(text(r)).not.toMatch(/12014 mein CC available/);
    const c = actx(liveRows());
    const keys = c.evidence.map(e => `${e.trainNumber}|${e.travelClass}`);
    for (const k of ['12904|3A', '12904|2A', '14680|CC', '12498|CC']) expect(keys, k).not.toContain(k);   // null / TIMEOUT / UNKNOWN / "GNWL/AVAILABLE"
    for (const t of ['12904 mein 3A available hai.', '12904 mein 2A full hai.', '14680 mein CC available nahi hai.', '12498 mein CC available hai.'])
      expect(judgeAvailabilityClaim(t, c).outcome, t).toBe('UNVERIFIED_AVAILABILITY');
    expect(searchRowAvailability(null)).toBeUndefined();
    expect(searchRowAvailability('UNKNOWN')).toBeUndefined();
    expect(searchRowAvailability('TIMEOUT', 'UNKNOWN')).toBeUndefined();
  }, 30000);

  it('[13] text / voice parity: identical tools, rejections and wording for the row answer, the pre-selection check and the fresh request', async () => {
    const out: Record<Mode, any[]> = { TEXT: [], VOICE: [] };
    for (const mode of MODES) {
      const h = stack({ ...SEARCH_TURN, ...SELECT_12014,
        'Kaunsi train mein CC seat available hai?': [{ content: '12014 mein CC available hai. 12497 mein CC RAC 4 hai.' }],
        'Shan-e-Punjab ka 3A dekho': [{ calls: [AV({ trainNumber: '12497', travelClass: '3A' })] }, { content: '12497 mein 3A available hai.' }],
        'Abhi latest batao 12497 CC ka': [{ content: '12497 mein CC RAC 4 hai.' }] });
      await h.say(SEARCH_T, mode);
      await h.say('12014 CC select karo', mode);
      for (const t of ['Kaunsi train mein CC seat available hai?', 'Shan-e-Punjab ka 3A dekho', 'Abhi latest batao 12497 CC ka']) {
        const r = await h.say(t, mode);
        out[mode].push({ tools: tools(r), rejected: rejected(r), text: text(r) });
      }
      expect(selected(h), mode).toBe('12014');
    }
    expect(out.VOICE).toEqual(out.TEXT);
    expect(out.TEXT.map(x => x.rejected)).toEqual([[], [], ['UNVERIFIED_AVAILABILITY']]);
    expect(out.TEXT[1].tools).toEqual([['CHECK_AVAILABILITY', 'SUCCEEDED', null]]);
  }, 60000);
});
