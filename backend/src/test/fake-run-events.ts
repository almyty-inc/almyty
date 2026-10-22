/**
 * agent_run_events for unit specs that drive the step processor over fake
 * repositories (durable runs step 1).
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 */
import { AgentRun } from '../entities/agent-run.entity';
import { AgentRunEvent } from '../entities/agent-run-event.entity';
import { cloneRow, fakeManager, FakeRepository } from './fake-repository';

/**
 * The table as Postgres keeps it: (runId, seq) is the primary key, so a
 * second event at a seq is refused, not stored beside the first.
 */
export function runEventsTable() {
  const rows: AgentRunEvent[] = [];
  return {
    rows: (runId?: string) => rows.filter((r) => !runId || r.runId === runId).map((r) => cloneRow(r)),
    insert: jest.fn(async (entity: any) => {
      const list: any[] = Array.isArray(entity) ? entity : [entity];
      for (const e of list) {
        if (rows.some((r) => r.runId === e.runId && r.seq === e.seq)) {
          throw new Error(`duplicate key value violates unique constraint "PK_agent_run_events" (${e.runId}, ${e.seq})`);
        }
      }
      for (const e of list) rows.push(cloneRow(e));
      return { identifiers: list.map((e) => ({ runId: e.runId, seq: e.seq })), generatedMaps: [], raw: [] };
    }),
  };
}

export type RunEventsTable = ReturnType<typeof runEventsTable>;

/**
 * Give a fake agent_runs repository the manager the step commit uses: the
 * row write and the event insert in one transaction. Returns the events.
 */
export function withRunEvents(runRepository: FakeRepository<AgentRun>, more: Array<[Function, FakeRepository<any>]> = []): RunEventsTable {
  const events = runEventsTable();
  fakeManager([[AgentRun, runRepository], [AgentRunEvent, events as any], ...more]);
  return events;
}
