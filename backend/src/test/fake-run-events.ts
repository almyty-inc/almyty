/**
 * agent_run_events for unit specs that write runs over fake repositories
 * (durable runs step 1: every run write goes with its events,
 * run-event-writer.ts).
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 */
import { AgentRun } from '../entities/agent-run.entity';
import { AgentRunEvent } from '../entities/agent-run-event.entity';
import { onRunWritten } from '../modules/agents/run-event-writer';
import { ProjectionMismatch, RunProjectionChecker } from '../modules/agents/run-projection-check';
import { cloneRow, fakeManager, fakeRepository, FakeRepository } from './fake-repository';

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
    /**
     * The read a live run view replays from: a run's events after a seq
     * (`seq: MoreThan(n)`), in seq order, a page at a time.
     */
    find: jest.fn(async (options: any = {}) => {
      const where = options.where ?? {};
      const after = where.seq && typeof where.seq === 'object' && where.seq.type === 'moreThan' ? Number(where.seq.value) : -Infinity;
      const found = rows
        .filter((r) => (where.runId === undefined || r.runId === where.runId) && r.seq > after)
        .sort((a, b) => a.seq - b.seq);
      return (options.take ? found.slice(0, options.take) : found).map((r) => cloneRow(r));
    }),
  };
}

export type RunEventsTable = ReturnType<typeof runEventsTable>;

/**
 * Give a fake agent_runs repository the manager every run write uses
 * (run-event-writer.ts): the row write and the event insert in one
 * transaction. Returns the events.
 *
 * `headSeq` gets its column's default, 0, on rows already in the table and
 * on rows seeded, saved or inserted later without one, as Postgres would
 * give it: the writer's UPDATE names the head it read.
 */
export function withRunEvents(runRepository: FakeRepository<AgentRun>, more: Array<[Function, FakeRepository<any>]> = []): RunEventsTable {
  const events = runEventsTable();
  fakeManager([[AgentRun, runRepository], [AgentRunEvent, events as any], ...more]);
  const withDefault = (row: any) => {
    if (row && typeof row === 'object' && (row.headSeq === undefined || row.headSeq === null)) row.headSeq = 0;
    return row;
  };
  // Only a FakeRepository has a table to default; a hand-made double
  // (a few specs keep one) gets the manager and nothing else.
  if (typeof runRepository.rows !== 'function' || typeof runRepository.seed !== 'function') return events;
  for (const row of runRepository.rows()) {
    if ((row as any).headSeq === undefined || (row as any).headSeq === null) void runRepository.update({ id: (row as any).id }, { headSeq: 0 } as any);
  }
  const seed = runRepository.seed;
  runRepository.seed = (row: any) => seed(withDefault({ ...row }));
  for (const method of ['save', 'insert'] as const) {
    const original = runRepository[method]?.getMockImplementation?.();
    if (!original) continue;
    runRepository[method].mockImplementation(async (entity: any, ...rest: any[]) => {
      (Array.isArray(entity) ? entity : [entity]).forEach(withDefault);
      return (original as any)(entity, ...rest);
    });
  }
  return events;
}
/** A fake agent_runs table, seeded, with its event log beside it (withRunEvents). */
export function runsWithEvents(seed: Array<Partial<AgentRun>> = []) {
  const runs = fakeRepository<AgentRun>({ make: () => new AgentRun(), seed: seed.map((r) => ({ steps: [], currentStep: 0, ...r })) });
  const events = withRunEvents(runs);
  return Object.assign(runs, { events });
}

/**
 * The projection check (durable runs step 2, run-projection-check.ts) on
 * every run write made until `stop`: how many it compared and every
 * difference it found.
 */
export function watchRunProjection() {
  const mismatches: ProjectionMismatch[] = [];
  const checker = new RunProjectionChecker((m) => mismatches.push(m));
  const stop = onRunWritten((written) => {
    checker.check(written);
  });
  return { checker, mismatches, stop };
}

/**
 * In a describe: every run write its tests make is checked against its
 * event log, and a test fails on any difference. Returns the current
 * test's watch.
 */
export function expectRunProjectionsHold(): () => ReturnType<typeof watchRunProjection> {
  let watch: ReturnType<typeof watchRunProjection>;
  beforeEach(() => {
    watch = watchRunProjection();
  });
  afterEach(() => {
    watch.stop();
    expect(watch.mismatches).toEqual([]);
  });
  return () => watch;
}