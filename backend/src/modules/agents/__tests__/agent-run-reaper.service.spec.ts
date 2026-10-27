import { AgentRunReaperService } from '../agent-run-reaper.service';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { RunEventsTable, withRunEvents } from '../../../test/fake-run-events';
import { projectRunEvents, storedRunState } from '../run-events';

describe('AgentRunReaperService', () => {
  const HOUR = 3_600_000;
  const long = () => new Date(Date.now() - 24 * HOUR);
  const now = () => new Date();

  let repo: FakeRepository<AgentRun>;
  let events: RunEventsTable;
  let service: AgentRunReaperService;

  const setup = (rows: Array<Partial<AgentRun>>) => {
    repo = fakeRepository<AgentRun>({
      make: () => new AgentRun(),
      seed: rows.map((r) => ({ steps: [], headSeq: 0, currentStep: 0, totalCost: 0, totalTokens: 0, executionTime: 0, ...r })) as any,
    });
    events = withRunEvents(repo);
    service = new AgentRunReaperService(repo as any);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  };

  /** The run's log is contiguous and folds back into its row. */
  const expectLogged = (id: string) => {
    const log = events.rows(id);
    const row = repo.row(id)!;
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    const { headSeq, ...state } = projectRunEvents(log);
    expect(headSeq).toBe(row.headSeq);
    expect(state).toEqual(storedRunState(row));
  };

  it('marks stale RUNNING runs as TIMEOUT, each on its own log', async () => {
    setup([
      { id: 'r1', status: AgentRunStatus.RUNNING, updatedAt: long(), createdAt: long() },
      { id: 'r2', status: AgentRunStatus.RUNNING, updatedAt: long(), createdAt: long() },
      // Fresh: still working.
      { id: 'r3', status: AgentRunStatus.RUNNING, updatedAt: now(), createdAt: long() },
    ]);

    expect(await service.reapStuckRuns()).toBe(2);

    for (const id of ['r1', 'r2']) {
      const row = repo.row(id)!;
      expect(row.status).toBe(AgentRunStatus.TIMEOUT);
      expect(row.error).toMatch(/timed out/i);
      expect(events.rows(id).map((e) => e.type)).toEqual(['run_started', 'status_changed', 'step_committed']);
      expectLogged(id);
    }
    expect(repo.row('r3')!.status).toBe(AgentRunStatus.RUNNING);
    expect(events.rows('r3')).toEqual([]);
  });

  it('does nothing when there are no stale runs', async () => {
    setup([{ id: 'r1', status: AgentRunStatus.RUNNING, updatedAt: now(), createdAt: now() }]);
    expect(await service.reapStuckRuns()).toBe(0);
    expect(events.rows()).toEqual([]);
  });

  it('reaps a run stuck in PENDING because its first step was never queued', async () => {
    // PENDING was skipped entirely as "newly queued". A run whose initial
    // enqueue threw after the row was saved has no job, is never written
    // again, and so sat PENDING permanently with nothing recorded. Judged
    // on createdAt, because such a row's updatedAt never moves.
    setup([{ id: 'p1', status: AgentRunStatus.PENDING, createdAt: long(), updatedAt: now() }]);

    expect(await service.reapStuckRuns()).toBe(1);
    const row = repo.row('p1')!;
    expect(row.status).toBe(AgentRunStatus.FAILED);
    expect(row.error).toMatch(/never started/i);
    // The reason names the cause, so the record answers "why".
    expect(row.error).toMatch(/enqueue failed|queue is unreachable/i);
    expect(events.rows('p1').find((e) => e.type === 'run_failed')!.payload.error).toBe(row.error);
    expectLogged('p1');
  });

  it('leaves a run that moved on between the read and the write', async () => {
    setup([{ id: 'r1', status: AgentRunStatus.RUNNING, updatedAt: long(), createdAt: long() }]);
    const find = repo.find.getMockImplementation()!;
    repo.find.mockImplementationOnce(async (opts: any) => {
      const found = await (find as any)(opts);
      // The worker was alive after all: it finished the run just now.
      await repo.update({ id: 'r1' }, { status: AgentRunStatus.COMPLETED });
      return found;
    });

    expect(await service.reapStuckRuns()).toBe(0);
    expect(repo.row('r1')!.status).toBe(AgentRunStatus.COMPLETED);
    expect(events.rows('r1')).toEqual([]);
  });

  it('counts both sweeps in one pass', async () => {
    setup([
      { id: 'r1', status: AgentRunStatus.RUNNING, updatedAt: long(), createdAt: long() },
      { id: 'p1', status: AgentRunStatus.PENDING, updatedAt: now(), createdAt: long() },
      { id: 'p2', status: AgentRunStatus.PENDING, updatedAt: now(), createdAt: long() },
    ]);
    expect(await service.reapStuckRuns()).toBe(3);
  });

  it('unrefs its timer and clears it on destroy', () => {
    setup([]);
    service.onModuleInit();
    expect((service as any).timer).toBeDefined();
    service.onModuleDestroy();
    expect((service as any).timer).toBeUndefined();
  });
});