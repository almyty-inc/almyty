import { AgentRunReaperService } from '../agent-run-reaper.service';
import { AgentRunStatus } from '../../../entities/agent-run.entity';

describe('AgentRunReaperService', () => {
  let repo: any;
  let service: AgentRunReaperService;

  beforeEach(() => {
    repo = {
      find: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 0 }),
    };
    service = new AgentRunReaperService(repo);
  });

  it('marks stale RUNNING runs as TIMEOUT', async () => {
    repo.find.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);

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
    repo.find.mockResolvedValue([]);

    const reaped = await service.reapStuckRuns();

    expect(reaped).toBe(0);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('unrefs its timer and clears it on destroy', () => {
    service.onModuleInit();
    expect((service as any).timer).toBeDefined();
    service.onModuleDestroy();
    expect((service as any).timer).toBeUndefined();
  });
});
