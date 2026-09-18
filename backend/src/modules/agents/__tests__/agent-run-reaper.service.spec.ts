import { AgentRunReaperService } from '../agent-run-reaper.service';
import { AgentRunStatus } from '../../../entities/agent-run.entity';

describe('AgentRunReaperService', () => {
  let repo: any;
  let service: AgentRunReaperService;

  /** The sweep runs RUNNING first, then PENDING. */
  const findReturns = (running: any[], pending: any[]) => {
    repo.find.mockResolvedValueOnce(running).mockResolvedValueOnce(pending);
  };

  beforeEach(() => {
    repo = {
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    service = new AgentRunReaperService(repo);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
  });

  it('marks stale RUNNING runs as TIMEOUT', async () => {
    findReturns([{ id: 'r1' }, { id: 'r2' }], []);

    const reaped = await service.reapStuckRuns();

    expect(reaped).toBe(2);
    // Only RUNNING runs older than the cutoff are selected.
    const where = repo.find.mock.calls[0][0].where;
    expect(where.status).toBe(AgentRunStatus.RUNNING);
    expect(where.updatedAt).toBeDefined();
    // The UPDATE is guarded on status RUNNING and sets TIMEOUT.
    const [criteria, patch] = repo.update.mock.calls[0];
    expect(criteria.status).toBe(AgentRunStatus.RUNNING);
    expect(patch.status).toBe(AgentRunStatus.TIMEOUT);
    expect(patch.error).toMatch(/timed out/i);
  });

  it('does nothing when there are no stale runs', async () => {
    findReturns([], []);

    const reaped = await service.reapStuckRuns();

    expect(reaped).toBe(0);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('reaps a run stuck in PENDING because its first step was never queued', async () => {
    // PENDING was skipped entirely as "newly queued". A run whose initial
    // enqueue threw after the row was saved has no job, is never written
    // again, and so sat PENDING permanently with nothing recorded.
    findReturns([], [{ id: 'p1' }]);

    const reaped = await service.reapStuckRuns();

    expect(reaped).toBe(1);
    const where = repo.find.mock.calls[1][0].where;
    expect(where.status).toBe(AgentRunStatus.PENDING);
    // Judged on createdAt, because such a row's updatedAt never moves.
    expect(where.createdAt).toBeDefined();
    expect(where.updatedAt).toBeUndefined();

    const [criteria, patch] = repo.update.mock.calls[0];
    expect(criteria.status).toBe(AgentRunStatus.PENDING);
    expect(patch.status).toBe(AgentRunStatus.FAILED);
    expect(patch.error).toMatch(/never started/i);
    // The reason names the cause, so the record answers "why".
    expect(patch.error).toMatch(/enqueue failed|queue is unreachable/i);
  });

  it('counts both sweeps in one pass', async () => {
    findReturns([{ id: 'r1' }], [{ id: 'p1' }, { id: 'p2' }]);
    expect(await service.reapStuckRuns()).toBe(3);
    expect(repo.update).toHaveBeenCalledTimes(2);
  });

  it('unrefs its timer and clears it on destroy', () => {
    service.onModuleInit();
    expect((service as any).timer).toBeDefined();
    service.onModuleDestroy();
    expect((service as any).timer).toBeUndefined();
  });
});
