/**
 * P42.4 — unit: inline same-train options (SSR markup), chat card expanded by default, discovery gate mirror,
 * native LLM payload (recent turns not duplicated in the context JSON) and the safe `llm_context` log record.
 */
import { describe, it, expect, vi } from 'vitest';
vi.hoisted(() => { process.env.SAME_TRAIN_ALTERNATIVES_ENABLED = '1'; });
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SameTrainOptionList, needsSameTrainDiscovery, verifiedInRouteOrder } from '../../src/components/trains/SameTrainInline';
import { SameTrainCard } from '../../src/components/trains/SameTrainAlternatives';
import { TrainCard } from '../../src/components/trains/TrainCard';
import { buildNativeMessages } from '../../server/ai/providers/openai-compatible-llm';
import { llmContextLogRecord, memoryContextView, LLM_CONTEXT_VERSION } from '../../server/ai/context/context-builder';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';

const alt = (id: string, o: string, d: string, availability: string, text: string, extra: any = {}) => ({
  alternativeId: id, kind: 'ORIGIN_SWEEP', ticketOrigin: o, ticketDestination: d, availability, availabilityStatusText: text,
  verificationStatus: 'PARTIALLY_VERIFIED', boardingRuleStatus: 'UNVERIFIED', alightingRuleStatus: 'NOT_REQUIRED', boardingStation: 'LDH', alightingStation: d,
  isRequestedPair: false, evidence: [], ...extra
});
const CARD = {
  alternativeSearchId: 'sta_x', trainNumber: '14612', trainName: 'Express', travelClass: '2A', date: '2026-10-08', passengersCount: 1, requestedPassengerCount: 1,
  requestedOrigin: 'LDH', requestedDestination: 'LKO', requestedOriginName: 'Ludhiana Jn', requestedDestinationName: 'Lucknow', candidateCount: 6, status: 'COMPLETE',
  alternatives: [
    alt('A1', 'LDH', 'LKO', 'WAITLIST', 'WL 5', { isRequestedPair: true, kind: 'REQUESTED', verificationStatus: 'VERIFIED', boardingRuleStatus: 'NOT_REQUIRED' }),
    alt('A2', 'ASR', 'LKO', 'AVAILABLE', 'AVL 4', { seatSufficiency: 'SUFFICIENT', availableSeatCount: 4 }),
    alt('A3', 'JAT', 'LKO', 'RAC', 'RAC 1'),
    alt('A4', 'JUC', 'LKO', 'WAITLIST', 'WL 2'),
    alt('A5', 'BEAS', 'LKO', 'AVAILABLE', 'AVL 1', { seatSufficiency: 'INSUFFICIENT', availableSeatCount: 1 })
  ]
};

describe('P42.4 inline same-train options', () => {
  it('[U1] only verified options (AVL enough, RAC) in route order; RAC keeps an amber "RAC 1" tag, AVL green; each has Select', () => {
    expect(verifiedInRouteOrder(CARD).map(a => a.alternativeId)).toEqual(['A2', 'A3']);
    const html = renderToStaticMarkup(React.createElement(SameTrainOptionList, { d: CARD, sessionId: 's', onHandoff: () => {}, heading: '2A · same train options' }));
    expect(html).toContain('bk-tag--warn">RAC 1<');
    expect(html).toContain('bk-tag--good">AVL 4<');
    expect(html).not.toMatch(/WL 2|WL 5|AVL 1/);
    expect((html.match(/>Select</g) || []).length).toBe(2);
    expect(html.indexOf('AVL 4')).toBeLessThan(html.indexOf('RAC 1'));                            // route order, not ranked
    expect(html).toContain('se boarding ka rule verify nahi hua');                                  // never "boarding allowed"
    expect(html).not.toMatch(/Best match/);
  });

  it('[U2] nothing verified → no markup; chat card shows options expanded (Select visible without tapping)', () => {
    const none = { ...CARD, alternatives: CARD.alternatives.filter(a => a.alternativeId === 'A1' || a.alternativeId === 'A4') };
    expect(renderToStaticMarkup(React.createElement(SameTrainOptionList, { d: none, sessionId: 's', onHandoff: () => {} }))).toBe('');
    const card = renderToStaticMarkup(React.createElement(SameTrainCard, { d: CARD, sessionId: 's', onHandoff: () => {} }));
    expect(card).toContain('RAC 1');
    expect((card.match(/>Select</g) || []).length).toBe(2);
    expect(card).toContain('Full details');
  });

  // Phase 2 (findBoardFromEarlier, user-authorized 2026-10-09): only a WAITLISTED class is discovered
  it('[U3] gate mirror: WL → discover; REGRET / NOT AVAILABLE / fewer seats than party / RAC / enough / unknown → no', () => {
    expect(needsSameTrainDiscovery('GNWL 5', 1)).toBe(true);
    expect(needsSameTrainDiscovery('RLWL1/WL1', 2)).toBe(true);
    expect(needsSameTrainDiscovery('REGRET', 1)).toBe(false);
    expect(needsSameTrainDiscovery('NOT AVAILABLE', 1)).toBe(false);
    expect(needsSameTrainDiscovery('AVAILABLE-0001', 3)).toBe(false);
    expect(needsSameTrainDiscovery('AVAILABLE-0010', 3)).toBe(false);
    expect(needsSameTrainDiscovery('RAC 4', 2)).toBe(false);
    expect(needsSameTrainDiscovery(null, 2)).toBe(false);
  });

  it('[U4] train card: auto mode renders a lazy placeholder slot only for the WL class (SSR = not yet visible → no request)', () => {
    const t: any = { trainNumber: '14612', trainName: 'Express', origin: 'LDH', destination: 'LKO', departure: '10:00', arrival: '22:00', duration: '12h',
      classes: [{ code: '2A', availability: 'WL 5', availabilityStatus: 'UNKNOWN', fare: null }, { code: '3A', availability: 'AVAILABLE-0020', availabilityStatus: 'UNKNOWN', fare: null }] };
    const html = renderToStaticMarkup(React.createElement(TrainCard, { train: t, onSelectTrain: () => {}, autoSameTrain: { sessionId: 's', searchResultsVersion: 1, passengers: 1, onHandoff: () => {} } }));
    expect(html).toContain('WL 5');
    expect(html).not.toContain('same train seats check ho rahe hain');                              // nothing requested before on-screen
  });
});

describe('P42.4 Part 2.1 memory payload + safe log', () => {
  it('[U5] native payload: recent turns as chat messages, not inside the context JSON; memory block kept', () => {
    const state = new ConversationStateManager();
    const s: any = state.getSession(state.createSession().sessionId);
    const ctx = { sessionView: { state: 'IDLE', passengersCount: 2 }, memory: memoryContextView(s), recentMessages: [{ role: 'user', content: 'Mohit' }] };
    const msgs = buildNativeMessages({ userText: 'Actually age 32', history: [{ role: 'user', content: '2 passengers' }, { role: 'assistant', content: 'Naam?' }, { role: 'user', content: 'Mohit' }, { role: 'assistant', content: 'Age?' }, { role: 'user', content: 'Actually age 32' }],
      state: 'IDLE', session: s, missingFields: [], inputMode: 'TEXT', context: ctx } as any);
    const sys = String(msgs[1].content);
    expect(sys).not.toContain('recentMessages');
    expect(sys).toContain(LLM_CONTEXT_VERSION);
    expect(msgs.filter((m: any) => m.role === 'user').map((m: any) => m.content)).toEqual(['2 passengers', 'Mohit', 'Actually age 32']);
  });

  it('[U6] llm_context record: names / versions / counts only — no passenger values, no secrets', () => {
    const state = new ConversationStateManager();
    const s: any = state.getSession(state.createSession().sessionId);
    s.origin = 'LDH'; s.destination = 'UMB'; s.passengersCount = 2;
    const ctx: any = { sessionView: { origin: 'LDH', destination: 'UMB', passengersCount: 2 }, memory: memoryContextView(s),
      bookingPreparation: { passengers: [{ passenger: 1, name: 'Mohit', age: 32, gender: 'MALE', missing: [] }] }, recentMessages: [{ role: 'user', content: 'otp 123456' }] };
    const rec = llmContextLogRecord(ctx, s);
    expect(rec).toMatchObject({ event: 'llm_context', contextVersion: LLM_CONTEXT_VERSION, staleContextRejected: 0, pendingInteraction: expect.anything() });
    expect(rec.memoryFieldsUsed).toEqual(expect.arrayContaining(['route', 'passengersCount', 'passengerFields', 'recentTurns']));
    const txt = JSON.stringify(rec);
    expect(txt).not.toMatch(/Mohit|MALE|123456|otp|LDH|UMB/);
  });
});
