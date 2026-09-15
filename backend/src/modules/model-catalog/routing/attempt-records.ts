import { AttemptRecord } from './co-failure';

/**
 * Read attempts out of what a run already recorded.
 *
 * The co-failure maths needed a table nobody was writing. It does not:
 * every routed call already stamps which model answered and which ones
 * were tried before it, on the node result, so the history is there and
 * was simply never read. Deriving beats collecting — a new table would
 * have started empty and told us nothing about last week.
 *
 * One request is one node of one run: that is the unit a router actually
 * chose for. The task class groups comparable requests, and an agent is
 * the coarsest grouping that is still comparable — two different agents
 * do different work and their failure rates should not be averaged.
 */
export interface RunLikeExecution {
  id: string;
  agentId: string;
  nodeResults?: Record<string, any> | null;
}

export function attemptsFrom(executions: RunLikeExecution[]): AttemptRecord[] {
  const records: AttemptRecord[] = [];

  for (const execution of executions) {
    for (const [nodeId, result] of Object.entries(execution.nodeResults ?? {})) {
      const routing = (result as any)?.routing;
      if (!routing?.modelId) continue;

      const requestId = `${execution.id}:${nodeId}`;
      const taskClass = execution.agentId;

      // Everything tried before the answer failed. Recorded first so the
      // order reads the way it happened.
      for (const tried of (routing.tried ?? []) as Array<{ modelId?: string }>) {
        if (tried?.modelId) records.push({ taskClass, requestId, modelId: tried.modelId, succeeded: false });
      }
      records.push({ taskClass, requestId, modelId: routing.modelId, succeeded: true });
    }
  }

  return records;
}

/**
 * Attempts from a node that failed outright.
 *
 * A node whose every candidate failed leaves no attribution, because
 * nothing answered — so the co-failure it represents would be invisible
 * exactly when it matters most. The error carries the list instead.
 */
export function failedAttemptsFrom(executions: RunLikeExecution[]): AttemptRecord[] {
  const records: AttemptRecord[] = [];

  for (const execution of executions) {
    for (const [nodeId, result] of Object.entries(execution.nodeResults ?? {})) {
      const tried = (result as any)?.triedModels as Array<{ modelId?: string }> | undefined;
      if (!(result as any)?.error || !tried?.length) continue;

      const requestId = `${execution.id}:${nodeId}`;
      for (const attempt of tried) {
        if (attempt?.modelId) {
          records.push({ taskClass: execution.agentId, requestId, modelId: attempt.modelId, succeeded: false });
        }
      }
    }
  }

  return records;
}
