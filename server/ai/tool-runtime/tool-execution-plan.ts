/**
 * PROMPT 18 — ToolExecutionPlan (Part 6). Per LLM round, a small dependency graph:
 *
 *   SEARCH_TRAINS ──► (train resolved from the NEW results) ──► CHECK_AVAILABILITY / GET_FARE
 *
 * Calls after a SEARCH_TRAINS barrier that need a resolved train (availability / fare) depend on that
 * search. A dependent call never runs before its dependency SUCCEEDED; if the dependency failed / was
 * empty / stale, the dependent call is BLOCKED (DEPENDENCY_NOT_SATISFIED) — no provider call.
 * Independent calls (e.g. GET_TRAIN_INFO + GET_TIMETABLE) have no dependencies and run in parallel.
 */
import type { ToolCall } from '../tools/tool-registry';
import type { ToolExecutionPlanNode } from '@shared/turn-engine';

const NEEDS_RESOLVED_TRAIN = new Set(['CHECK_AVAILABILITY', 'GET_FARE']);

export function buildToolExecutionPlan(calls: ToolCall[], round: number, now = () => new Date().toISOString()): ToolExecutionPlanNode[] {
  const nodes: ToolExecutionPlanNode[] = [];
  let lastSearch: string | null = null;
  calls.forEach((c, i) => {
    const id = `r${round}n${i + 1}`;
    const deps: string[] = [];
    if (c?.name !== 'SEARCH_TRAINS' && lastSearch && NEEDS_RESOLVED_TRAIN.has(String(c?.name))) deps.push(lastSearch);
    nodes.push({ planNodeId: id, callId: String(c?.callId ?? id), tool: String(c?.name ?? ''), toolExecutionId: null, dependencies: deps,
      status: 'PLANNED', arguments: {}, createdAt: now(), round });
    if (c?.name === 'SEARCH_TRAINS') lastSearch = id;
  });
  return nodes;
}

/** null = all dependencies succeeded; otherwise the first unsatisfied dependency. */
export function unsatisfiedDependency(node: ToolExecutionPlanNode, plan: readonly ToolExecutionPlanNode[]): ToolExecutionPlanNode | null {
  for (const d of node.dependencies) {
    const dep = plan.find(n => n.planNodeId === d);
    if (!dep || dep.status !== 'SUCCEEDED') return dep || null;
  }
  return null;
}
