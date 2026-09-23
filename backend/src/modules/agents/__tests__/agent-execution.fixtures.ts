/**
 * Shared fixtures for the workflow-execution specs.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`, so these
 * helpers used to be exported from `agent-execution-cancellation.spec.ts`
 * and every importer re-ran that whole suite inside its own.
 */
import { Agent, AgentPipeline, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';

export function makeExecutionRow(overrides: Partial<AgentExecution> = {}): AgentExecution {
  const exec = new AgentExecution();
  exec.id = 'exec-1';
  exec.agentId = 'agent-1';
  exec.organizationId = 'org-1';
  exec.userId = 'user-1';
  exec.status = AgentExecutionStatus.RUNNING;
  exec.input = {};
  exec.output = null;
  exec.nodeResults = {};
  exec.executionTime = 0;
  exec.totalCost = 0;
  exec.totalTokens = 0;
  exec.error = null as any;
  exec.metadata = {};
  return Object.assign(exec, overrides);
}

export function makeAgent(pipeline: AgentPipeline): Agent {
  const agent = new Agent();
  agent.id = 'agent-1';
  agent.name = 'Cancellable';
  agent.organizationId = 'org-1';
  agent.status = AgentStatus.ACTIVE;
  agent.pipeline = pipeline;
  agent.variables = {};
  agent.settings = {};
  agent.metadata = {};
  agent.totalExecutions = 0;
  agent.successfulExecutions = 0;
  agent.totalCost = 0;
  agent.averageExecutionTime = 0;
  agent.createdBy = 'user-1';
  return agent;
}

/**
 * Evaluate the `status` half of an update criteria against a row.
 *
 * The engine's terminal writes are compare-and-set —
 * `update({ id, status: In(writable) })` — so a fake that ignored the
 * operator would let every write through and prove nothing about the
 * guard.
 */
export function statusAllowed(rowStatus: string, op: any): boolean {
  if (op === undefined || op === null) return true;
  if (typeof op === 'string') return rowStatus === op;
  const child = typeof op.child !== 'undefined' ? op.child : undefined;
  if (op.type === 'not') return !statusAllowed(rowStatus, child ?? op.value);
  if (op.type === 'in') return (op.value as string[]).includes(rowStatus);
  return true;
}

/**
 * A repository backed by a little table of its own.
 *
 * Snapshots, deliberately: the rows this hands out are never the same
 * objects the code under test holds. An earlier version of this fake
 * returned the caller's entity itself, which meant the engine mutating
 * `execution.status = COMPLETED` in memory also mutated "the row" — so
 * every compare-and-set saw the status it was about to write and no
 * guard could ever be observed working.
 */
export function fakeExecutionRepo(rows: AgentExecution[]) {
  const saved: AgentExecution[] = [];
  const snapshot = (e: AgentExecution) => Object.assign(new AgentExecution(), e);
  const store = new Map<string, AgentExecution>();
  for (const r of rows) store.set(r.id, snapshot(r));

  return {
    saved,
    store,
    /** The row as the table holds it right now. */
    current: (id: string) => store.get(id),
    create: jest.fn((v: any) => Object.assign(makeExecutionRow(), v)),
    save: jest.fn(async (e: AgentExecution) => {
      store.set(e.id, snapshot(e));
      saved.push(snapshot(e));
      return e;
    }),
    // Compare-and-set, the way Postgres would: only rows whose current
    // status still satisfies the criteria are written.
    update: jest.fn(async (criteria: any, partial: any) => {
      const ids: string[] = criteria.id?.type === 'in' ? criteria.id.value : [criteria.id];
      let affected = 0;
      for (const id of ids) {
        const row = store.get(id);
        if (!row) continue;
        if (!statusAllowed(row.status, criteria.status)) continue;
        for (const [k, v] of Object.entries(partial)) {
          if (v === undefined) continue;
          (row as any)[k] = v;
        }
        saved.push(snapshot(row));
        affected += 1;
      }
      return { affected };
    }),
    findOne: jest.fn(async ({ where }: any) => {
      for (const row of store.values()) {
        if (Object.entries(where).every(([k, v]) => (row as any)[k] === v)) return snapshot(row);
      }
      return null;
    }),
    find: jest.fn(async () => [...store.values()].map(snapshot)),
  };
}
