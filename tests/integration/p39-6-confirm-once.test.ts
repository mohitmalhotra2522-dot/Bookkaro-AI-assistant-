/**
 * v0.39.6 — "Confirm & continue to IRCTC" must be asked only ONCE.
 * Slow LLM turns let the availability (2 min) / fare (10 min) results go stale before the user's "haan"; the backend
 * then refreshes them. When the refreshed values are the SAME as in the confirmed review, the confirmation proceeds
 * (same review version, fingerprint carried forward) — no second "naye review ko confirm karein". A real change still
 * re-asks (pinned by p11-handoff-e2e G3 [14] / [15]; re-checked here).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MockLLMProvider } from '../../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../../server/ai/state/conversation-state';
import { RailwayToolService } from '../../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../../server/railway/providers/mock/mock-provider';
import { BookingState } from '../../shared/states';
import { reviewFingerprint } from '../../server/booking/review-builder';

class P396Provider extends MockRailwayProvider {
  static fareBump = 0; static calls: string[] = [];
  async getFare(r: any): Promise<any> {
    P396Provider.calls.push('fare');
    const res: any = await super.getFare(r);
    if (res.ok && P396Provider.fareBump) { const per = res.data.perPassenger + P396Provider.fareBump; res.data = { ...res.data, perPassenger: per, total: per * res.data.passengersCount, breakdown: { baseFare: per * res.data.passengersCount } }; }
    return res;
  }
  async checkAvailability(r: any): Promise<any> { P396Provider.calls.push('availability'); return super.checkAvailability(r); }
}
railwayRegistry.register('p396-provider', () => new P396Provider());

let state: ConversationStateManager;
let orch: ConversationAgentOrchestrator;
const say = (sid: string, text: string): Promise<any> => orch.processTurn(sid, text, 'TEXT');
const S = (sid: string): any => state.getSession(sid);
const count = (sid: string, type: string) => (S(sid).eventLog || []).filter((e: any) => e.type === type).length;

async function toAwaiting(sid: string) {
  await say(sid, 'Amritsar se Delhi kal 2 log');
  await say(sid, '12497');
  await say(sid, 'CC');
  const r = await say(sid, 'Rahul Sharma 31 male, Neha Sharma 28 female');
  expect(r.newState).toBe(BookingState.AWAITING_CONFIRMATION);
}

beforeEach(() => {
  P396Provider.fareBump = 0; P396Provider.calls = [];
  railwayRegistry.setActive('p396-provider');
  state = new ConversationStateManager();
  orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService(), {});
});
afterEach(() => { vi.useRealTimers(); });

describe('v0.39.6 — one confirmation even when the data had to be re-checked', () => {
  for (const [label, minutes, needs] of [['availability stale (3 min)', 3, ['availability']], ['availability + fare stale (11 min)', 11, ['availability', 'fare']]] as const) {
    it(`[1] ${label}, values unchanged → ONE "haan" reaches IRCTC handoff; review version unchanged; fingerprints consistent`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const sid = state.createSession().sessionId;
      await toAwaiting(sid);
      const v1 = S(sid).review.reviewVersion;
      const fare1 = S(sid).fare.total;
      vi.setSystemTime(new Date(Date.now() + minutes * 60_000));
      P396Provider.calls = [];
      const r = await say(sid, 'haan book karo');
      for (const n of needs) expect(P396Provider.calls).toContain(n);           // really re-checked
      expect(r.error).toBeUndefined();
      expect(r.responseMessage).not.toMatch(/naye review ko confirm|dobara confirm/i);
      expect(r.newState).toBe(BookingState.IRCTC_HANDOFF_READY);
      expect(S(sid).review).toMatchObject({ valid: true, reviewVersion: v1 });
      expect(count(sid, 'REVIEW_CREATED')).toBe(1);
      expect(count(sid, 'BOOKING_CONFIRMATION_CREATED')).toBe(1);
      expect(S(sid).review.fingerprint).toBe(reviewFingerprint(S(sid)));
      expect(S(sid).confirmation.reviewFingerprint).toBe(S(sid).review.fingerprint);
      expect(S(sid).handoffSession.status).toBe('READY');
      expect(S(sid).handoffSession.bookingSnapshot.fareSnapshot.total).toBe(fare1);
    });
  }

  it('[2] a real fare change on the refresh still re-asks (new review v2) — unchanged behaviour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const sid = state.createSession().sessionId;
    await toAwaiting(sid);
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    P396Provider.fareBump = 100;
    const r = await say(sid, 'haan');
    expect(r.error).toMatchObject({ code: 'STALE_REVIEW', details: { changed: ['fare'] } });
    expect(S(sid).review).toMatchObject({ valid: true, reviewVersion: 2 });
    expect(S(sid).handoffSession).toBeUndefined();
    expect(count(sid, 'BOOKING_CONFIRMATION_CREATED')).toBe(0);
  });
});
