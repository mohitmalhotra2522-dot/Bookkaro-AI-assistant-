import { MockLLMProvider } from '../server/ai/providers/mock-llm';
import { ConversationStateManager } from '../server/ai/state/conversation-state';
import { RailwayToolService } from '../server/railway/tools/railway-tool-service';
import { ConversationAgentOrchestrator } from '../server/ai/agent/conversation-agent-orchestrator';

const state = new ConversationStateManager();
const orch = new ConversationAgentOrchestrator(new MockLLMProvider(), state, new RailwayToolService());
async function run(lines: string[], mode: 'TEXT'|'VOICE' = 'TEXT') {
  const sid = state.createSession().sessionId;
  for (const l of lines) {
    const r = await orch.processTurn(sid, l, mode);
    const s = r.context as any;
    console.log(`\nUSER: ${l}\nBOT : ${r.responseMessage.replace(/\n/g, '\n      ')}`);
    console.log(`      [${r.newState} | pending=${r.pendingInteraction?.type} | ${s.origin||'-'}→${s.destination||'-'} ${s.date||'-'} pax=${s.passengersCount??'-'} train=${s.selectedTrain?.number||'-'} cls=${s.selectedClass||'-'} v=${s.searchResultsVersion} tools=${r.toolActivity||'-'} err=${r.error?.code||'-'}]`);
  }
}
const flows: Record<string, string[]> = {
  A: ['Amritsar se Delhi jaana hai', 'Kal 2 log', 'haan', 'second wali', 'CC kar do', 'availability bhi check karo', 'fare bhi batao', 'Rahul Sharma', '34', 'male', 'Priya, 31, female', 'haan', 'haan'],
  B: ['2 passengers', 'Amritsar se Delhi', 'Kal', '12014 batao', 'Iski CC availability?', 'Fare?', 'Timetable?', 'Actually Ludhiana jaana hai', 'Kal nahi parso', 'morning wali'],
  C: ['Delhi', 'Delhi jaana hai', 'Amritsar se', 'kal', 'AC wali', '12497 wali', 'AC', 'CC nahi 3A', 'Nahi, doosri train', 'jo pehle batayi thi', 'Fare batao', 'ek aur add kar do', '12014 aur 12497 mein kaunsi jaldi pahunchti hai?', 'fastest wali', 'date change karo', 'Sunday'],
};
for (const [k, f] of Object.entries(flows)) { console.log(`\n========== FLOW ${k} ==========`); await run(f); }
