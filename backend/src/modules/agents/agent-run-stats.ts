/** What the loader needs of an EntityManager or DataSource: raw SQL. */
type QueryRunnerLike = { query(sql: string, parameters?: any[]): Promise<any> };

import { FINISHED_RUN_STATUSES as FINISHED_AGENT_RUN_STATUSES } from './run-removal';

/**
 * An agent's numbers, worked out from the runs it still has.
 *
 * The agent row keeps lifetime counters (totalExecutions and the rest,
 * bumped as each run ends). Deleting a run, a visitor's erasure and the
 * retention sweep remove runs but leave those counters alone, so the
 * header read "142 runs" over a Runs tab holding two. Everything that
 * describes "this agent's runs" reads these numbers instead: one grouped
 * aggregate over agent_runs (autonomous) and one over agent_executions
 * (workflow), per agent, served by the (agentId, createdAt) index on each.
 *
 * Only finished runs count: a run still going has no time or final cost
 * yet, and the counters never counted it either.
 */
export interface AgentRunStats {
  /** Finished runs that still exist. */
  runs: number;
  /** Of `runs`, those that completed (whatever their answer's check said). */
  completed: number;
  /** Completed runs a checker gave a verdict on ("No contradictions found" counts these). */
  checked: number;
  /** Of `checked`, the runs whose check passed. */
  checksPassed: number;
  /** Mean run time of the finished runs, in ms (0 when there are none). */
  averageRunTimeMs: number;
  /** What the finished runs cost, in dollars. */
  totalCost: number;
}

export const EMPTY_RUN_STATS: AgentRunStats = Object.freeze({
  runs: 0,
  completed: 0,
  checked: 0,
  checksPassed: 0,
  averageRunTimeMs: 0,
  totalCost: 0,
}) as AgentRunStats;

/**
 * Finished, the statuses neither kind of run leaves: the same four for
 * agent_runs (run-removal.ts) and agent_executions (TERMINAL_EXECUTION_STATUSES).
 */
export const FINISHED_RUN_STATUSES: readonly string[] = [...FINISHED_AGENT_RUN_STATUSES];

// A check counts when a checker gave a verdict: `metadata.verify` holds it
// (agent-step-processor), and a check no checker could give a verdict on
// is marked `unavailable` and was not a check.
const CHECKED = `"status" = 'completed'
      AND ("metadata"->'verify'->>'verdict') IN ('pass', 'fail')
      AND COALESCE("metadata"->'verify'->>'unavailable', 'false') <> 'true'`;

const RUNS_SQL = `
  SELECT "agentId" AS "agentId",
         COUNT(*)::int AS "runs",
         COUNT(*) FILTER (WHERE "status" = 'completed')::int AS "completed",
         COUNT(*) FILTER (WHERE ${CHECKED})::int AS "checked",
         COUNT(*) FILTER (WHERE ${CHECKED} AND ("metadata"->'verify'->>'verdict') = 'pass')::int AS "checksPassed",
         COALESCE(SUM("executionTime"), 0)::float8 AS "time",
         COALESCE(SUM("totalCost"), 0)::float8 AS "cost"
    FROM "agent_runs"
   WHERE "agentId" = ANY($1::uuid[]) AND "status" = ANY($2::text[])
   GROUP BY "agentId"`;

const EXECUTIONS_SQL = `
  SELECT "agentId" AS "agentId",
         COUNT(*)::int AS "runs",
         COUNT(*) FILTER (WHERE "status" = 'completed')::int AS "completed",
         COALESCE(SUM("executionTime"), 0)::float8 AS "time",
         COALESCE(SUM("totalCost"), 0)::float8 AS "cost"
    FROM "agent_executions"
   WHERE "agentId" = ANY($1::uuid[]) AND "status"::text = ANY($2::text[])
   GROUP BY "agentId"`;

interface Row {
  agentId: string;
  runs: number | string;
  completed: number | string;
  checked?: number | string;
  checksPassed?: number | string;
  time: number | string;
  cost: number | string;
}

/** Each agent's numbers from its existing runs; an agent with none gets zeros. */
export async function loadAgentRunStats(
  manager: QueryRunnerLike,
  agentIds: string[],
): Promise<Map<string, AgentRunStats>> {
  const ids = [...new Set(agentIds.filter(Boolean))];
  const out = new Map<string, AgentRunStats>();
  if (ids.length === 0) return out;

  const statuses = [...FINISHED_RUN_STATUSES];
  const [runRows, executionRows] = await Promise.all([
    manager.query(RUNS_SQL, [ids, statuses]) as Promise<Row[]>,
    manager.query(EXECUTIONS_SQL, [ids, statuses]) as Promise<Row[]>,
  ]);

  const sums = new Map<string, { runs: number; completed: number; checked: number; checksPassed: number; time: number; cost: number }>();
  for (const row of [...(runRows ?? []), ...(executionRows ?? [])]) {
    const s = sums.get(row.agentId) ?? { runs: 0, completed: 0, checked: 0, checksPassed: 0, time: 0, cost: 0 };
    s.runs += Number(row.runs) || 0;
    s.completed += Number(row.completed) || 0;
    s.checked += Number(row.checked) || 0;
    s.checksPassed += Number(row.checksPassed) || 0;
    s.time += Number(row.time) || 0;
    s.cost += Number(row.cost) || 0;
    sums.set(row.agentId, s);
  }

  for (const id of ids) {
    const s = sums.get(id);
    out.set(
      id,
      s
        ? {
            runs: s.runs,
            completed: s.completed,
            checked: s.checked,
            checksPassed: s.checksPassed,
            averageRunTimeMs: s.runs > 0 ? Math.round(s.time / s.runs) : 0,
            totalCost: s.cost,
          }
        : { ...EMPTY_RUN_STATS },
    );
  }
  return out;
}

/**
 * The agent as the API serves it: its numbers from its existing runs, as
 * `runStats` and in the old counter fields, so a reader of either (the
 * app, the CLI's --json, the API) sees the same thing. Returns a copy;
 * the entity is never touched, so a later save cannot write these back
 * into the counter columns.
 */
export function withRunStats<T extends object>(agent: T, stats: AgentRunStats | undefined): T & {
  runStats: AgentRunStats;
  totalExecutions: number;
  successfulExecutions: number;
  checkedExecutions: number;
  passedCheckExecutions: number;
  averageExecutionTime: number;
  totalCost: number;
} {
  const s = stats ?? { ...EMPTY_RUN_STATS };
  return {
    ...agent,
    runStats: s,
    totalExecutions: s.runs,
    successfulExecutions: s.completed,
    checkedExecutions: s.checked,
    passedCheckExecutions: s.checksPassed,
    averageExecutionTime: s.averageRunTimeMs,
    totalCost: s.totalCost,
  };
}
