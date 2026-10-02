import { MockLLMProvider } from '../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../server/ai/state/conversation-state';
import { RailwayToolService } from '../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../server/ai/agent/conversation-agent-orchestrator';
import { railwayRegistry } from '../server/railway/registry/provider-registry';
import { MockRailwayProvider } from '../server/railway/providers/mock/mock-provider';

class SlowDelhi extends MockRailwayProvider {
  async searchTrains(req: any) {
    if (req.destination === 'NDLS') await new Promise(r => setTimeout(r, 80));
    return super.searchTrains(req);
  }
}
railwayRegistry.register('slow-delhi', () => new SlowDelhi());
railwayRegistry.setActive('slow-delhi');
const state = new ConversationStateManager();
const orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
const sid = state.createSession().sessionId;
const pA = orch.processTurn(sid, 'Amritsar se Delhi kal', 'TEXT');
await new Promise(r => setTimeout(r, 10));
const pB = orch.processTurn(sid, 'Actually Delhi nahi Ludhiana jaana hai', 'TEXT');
const [a, b] = await Promise.all([pA, pB]);
const s = state.getSession(sid) as any;
console.log('A stale:', a.stale, a.error?.code, 'msg:', JSON.stringify(a.responseMessage), a.turnLog.toolResults);
console.log('B:', b.responseMessage.split('\n')[0], b.newState);
console.log('final dest:', s.destination, 'trains:', s.searchResults?.trains?.map((t: any) => t.trainNumber), 'v', s.searchResultsVersion);
console.log('events:', s.eventLog.map((e: any) => e.type).join(','));
// version conflict
const r = await orch.processTurn(sid, 'pehli wali', 'TEXT', { expectedSessionVersion: 1 });
console.log('conflict:', r.error?.code, r.responseMessage, 'state unchanged:', r.newState);
// voice mode same session
const v = await orch.processTurn(sid, 'pehli wali', 'VOICE');
console.log('voice:', v.responseMessage, v.context.mode);
