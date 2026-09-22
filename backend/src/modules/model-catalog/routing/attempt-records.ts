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

/**
 * One node of one run, as the database hands it back.
 *
 * `agent_executions.nodeResults` is a json blob holding every node's full
 * output; node payloads are capped at 32KB each, so a ten-node run is
 * ~320KB and a 5,000-run window is up to 1.6GB if the column is selected
 * whole. The three things the co-failure maths actually reads --
 * `routing.modelId`, `routing.tried[].modelId` and `triedModels[]` -- are
 * a few dozen bytes per node, so they are extracted server-side and the
 * outputs never leave Postgres.
 */
export interface RoutingAttemptRow {
  executionId: string;
  agentId: string;
  nodeId: string;
  modelId: string | null;
  tried: Array<{ modelId?: string }> | null;
  triedModels: Array<{ modelId?: string }> | null;
  hasError: boolean;
}

/**
 * Rebuild the minimal run shape the two readers above expect.
 *
 * Deliberately not a second copy of the traversal: `attemptsFrom` and
 * `failedAttemptsFrom` keep their single definition of what an attempt is,
 * and this only restores the handful of fields they look at.
 */
export function executionsFromRoutingRows(rows: RoutingAttemptRow[]): RunLikeExecution[] {
  const byExecution = new Map<string, RunLikeExecution>();

  for (const row of rows) {
    let execution = byExecution.get(row.executionId);
    if (!execution) {
      execution = { id: row.executionId, agentId: row.agentId, nodeResults: {} };
      byExecution.set(row.executionId, execution);
    }

    const node: Record<string, any> = {};
    if (row.modelId) {
      node.routing = { modelId: row.modelId, tried: row.tried ?? [] };
    }
    if (row.hasError) {
      node.error = true;
    }
    if (row.triedModels?.length) {
      node.triedModels = row.triedModels;
    }

    (execution.nodeResults as Record<string, any>)[row.nodeId] = node;
  }

  return [...byExecution.values()];
}
