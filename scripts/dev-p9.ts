/** Manual dev walkthrough for Prompt 9 booking preparation (not a test). Run: npx vite-node scripts/dev-p9.ts */
import { MockLLMProvider } from '../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../server/ai/state/conversation-state';
import { RailwayToolService } from '../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../server/ai/agent/conversation-agent-orchestrator';

const state = new ConversationStateManager();
const orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
async function run(lines: string[], mode: 'TEXT' | 'VOICE' = 'TEXT') {
  const sid = state.createSession().sessionId;
  for (const l of lines) {
    const r = await orch.processTurn(sid, l, mode);
    const s = r.context as any;
    const pax = (s.passengers || []).map((p: any) => `${p.id}:${p.name || '?'}/${p.age || '?'}/${p.gender?.[0] || '?'}`).join(' ');
    console.log(`\nUSER: ${l}\nBOT : ${r.responseMessage.replace(/\n/g, '\n      ')}`);
    console.log(`      [${r.newState} | pending=${r.pendingInteraction?.type} | ${s.origin || '-'}→${s.destination || '-'} ${s.date || '-'} n=${s.passengersCount ?? '-'} ${pax} | ${s.selectedTrain?.number || '-'} ${s.selectedClass || '-'} | rv=${s.review?.reviewVersion ?? '-'}${s.review ? (s.review.valid ? '✓' : '✗') : ''} conf=${s.confirmedReviewVersion ?? '-'} | tools=${r.toolActivity || '-'} | err=${r.error?.code || '-'} | ev=${r.events.join(',')}]`);
  }
}
const flows: Record<string, string[]> = {
  A: ['Amritsar se Delhi kal ki trains batao', '12014', 'CC', '2 passengers', 'Rahul Sharma', 'Actually naam Rohit Sharma hai', '31', 'male', 'Neha Sharma 28 female', 'haan'],
  B: ['Amritsar se Delhi kal 2 log', '12014 wali', 'CC', 'Rahul Sharma 31 male, Neha Sharma 28 female', 'Rahul ki age 32 hai', 'Class 2S kar do', 'Passenger 2 ka naam change karo', 'Neha Verma', 'Date parso kar do', 'Delhi nahi Chandigarh', '12412', 'CC', 'haan', 'payment kar do', 'haan'],
  C: ['Amritsar se Delhi kal 2 log', '12014', 'CC', 'First passenger ka naam Rahul hai', 'Second passenger female hai', 'Passenger 2 ka age 28 hai', 'Uska naam Neha hai', 'First passenger male hai', '30', '2 nahi 3 passengers hain', 'Amit 40 male', 'Actually second passenger nahi aa raha', 'Ek passenger remove kar do', 'mera OTP 123456 hai', 'Destination change karo', 'Chandigarh'],
};
for (const [k, f] of Object.entries(flows)) { console.log(`\n========== FLOW ${k} ==========`); await run(f); }
console.log('\n========== VOICE ==========');
await run(['amritsar se delhi kal', '12014', 'cc', 'do passenger hain pehla rahul sharma 31 male doosra neha sharma 28 female', 'haan'], 'VOICE');
