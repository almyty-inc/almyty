import { AgentRuntimeService, MAX_RUNS_PAGE_SIZE, AGENT_RUN_LIST_COLUMNS } from '../agent-runtime.service';
import { AgentsService, MAX_EXECUTIONS_PAGE_SIZE } from '../agents.service';
import { ApisService, MAX_APIS_PAGE_SIZE, DEFAULT_APIS_PAGE_SIZE } from '../../apis/apis.service';

/**
 * Caller-set `limit` with no ceiling: `?limit=100000` on the runs endpoint
 * put 100,000 rows in heap each carrying its full `steps` array. The ceiling
 * convention already existed in this codebase (`audit-log.service.ts` uses
 * min(limit, 200); tools and gateways use min(limit, 100)); these endpoints
 * simply did not apply it.
 */
describe('list endpoints clamp a caller-set limit', () => {
  describe('GET /agents/:id/runs', () => {
    const makeService = () => {
      const runRepository = { findAndCount: jest.fn().mockResolvedValue([[], 0]) };
      const service = Object.create(AgentRuntimeService.prototype) as AgentRuntimeService;
      (service as any).runRepository = runRepository;
      return { service, runRepository };
    };

    it('refuses to take more than MAX_RUNS_PAGE_SIZE rows', async () => {
      const { service, runRepository } = makeService();

      const result = await service.listRuns('agent-1', 'org-1', 1, 100000);

      const options = runRepository.findAndCount.mock.calls[0][0];
      expect(options.take).toBe(MAX_RUNS_PAGE_SIZE);
      expect(options.take).toBeLessThanOrEqual(100);
      // The pagination the caller is told about matches what was fetched.
      expect(result.limit).toBe(MAX_RUNS_PAGE_SIZE);
    });

    it('honours a limit under the ceiling and pages from it', async () => {
      const { service, runRepository } = makeService();

      await service.listRuns('agent-1', 'org-1', 3, 25);

      const options = runRepository.findAndCount.mock.calls[0][0];
      expect(options.take).toBe(25);
      expect(options.skip).toBe(50);
    });

    it('projects columns and leaves workingMemory out of the list', async () => {
      const { service, runRepository } = makeService();

      await service.listRuns('agent-1', 'org-1');

      const options = runRepository.findAndCount.mock.calls[0][0];
      expect(options.select).toBe(AGENT_RUN_LIST_COLUMNS);
      expect(options.select.workingMemory).toBeUndefined();
      expect(options.select.status).toBe(true);
    });

    it('falls back to the default for a nonsense limit or page', async () => {
      const { service, runRepository } = makeService();

      await service.listRuns('agent-1', 'org-1', -4, 0);

      const options = runRepository.findAndCount.mock.calls[0][0];
      expect(options.take).toBe(20);
      expect(options.skip).toBe(0);
    });
  });

  describe('GET /agents/:id/executions', () => {
    const makeService = () => {
      const agentExecutionRepository = { findAndCount: jest.fn().mockResolvedValue([[], 0]) };
      const service = Object.create(AgentsService.prototype) as AgentsService;
      (service as any).agentExecutionRepository = agentExecutionRepository;
      (service as any).getAgent = jest.fn().mockResolvedValue({ id: 'agent-1' });
      return { service, agentExecutionRepository };
    };

    it('refuses to take more than MAX_EXECUTIONS_PAGE_SIZE rows', async () => {
      const { service, agentExecutionRepository } = makeService();

      const result = await service.getAgentExecutions('agent-1', 'org-1', 1, 100000);

      expect(agentExecutionRepository.findAndCount.mock.calls[0][0].take)
        .toBe(MAX_EXECUTIONS_PAGE_SIZE);
      expect(result.limit).toBe(MAX_EXECUTIONS_PAGE_SIZE);
    });

    it('honours a limit under the ceiling', async () => {
      const { service, agentExecutionRepository } = makeService();

      await service.getAgentExecutions('agent-1', 'org-1', 2, 10);

      const options = agentExecutionRepository.findAndCount.mock.calls[0][0];
      expect(options.take).toBe(10);
      expect(options.skip).toBe(10);
    });
  });

  describe('GET /apis', () => {
    const makeService = () => {
      const qb: any = {
        andWhere: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        // The list now adds a unique tiebreak after the sort key, because
        // createdAt ties and skip/take over a tied ordering can show one row
        // on two pages and another on none.
        addOrderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getCount: jest.fn().mockResolvedValue(0),
        getRawAndEntities: jest.fn().mockResolvedValue({ entities: [], raw: [] }),
      };
      const service = Object.create(ApisService.prototype) as ApisService;
      (service as any).apiRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      (service as any).accessPolicy = { applyListFilter: jest.fn().mockResolvedValue(undefined) };
      return { service, qb };
    };

    it('refuses to take more than MAX_APIS_PAGE_SIZE rows', async () => {
      const { service, qb } = makeService();

      await service.findAllByOrganization({ id: 'u-1' }, 'org-1', { limit: 100000 });

      expect(qb.take).toHaveBeenCalledWith(MAX_APIS_PAGE_SIZE);
    });

    it('keeps the existing default when the caller asks for nothing', async () => {
      const { service, qb } = makeService();

      await service.findAllByOrganization({ id: 'u-1' }, 'org-1', {});

      expect(qb.take).toHaveBeenCalledWith(DEFAULT_APIS_PAGE_SIZE);
      expect(qb.skip).toHaveBeenCalledWith(0);
    });

    it('honours a limit under the ceiling', async () => {
      const { service, qb } = makeService();

      await service.findAllByOrganization({ id: 'u-1' }, 'org-1', { page: 2, limit: 25 });

      expect(qb.take).toHaveBeenCalledWith(25);
      expect(qb.skip).toHaveBeenCalledWith(25);
    });
  });
});
