import { AgentAppsService, MAX_APPS_PER_PAGE } from '../agent-apps.service';

/**
 * The apps page issued 1 + 2 x (apps x agents) queries: two findOnes per
 * agent of every app to find its latest activity, plus a name lookup per
 * failure. 20 apps x 3 agents was 121 queries per page load, against the two
 * largest tables in the schema. One windowed DISTINCT ON per table is 3.
 */
describe('AgentAppsService.list query count', () => {
  const ORG = 'org-1';

  const makeQb = (rows: any[]) => {
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      distinctOn: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    return qb;
  };

  const makeService = (apps: any[], executions: any[] = [], runs: any[] = [], agents: any[] = []) => {
    const appRepository = { find: jest.fn().mockResolvedValue(apps) };
    const executionQb = makeQb(executions);
    const runQb = makeQb(runs);
    const executionRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(executionQb),
      findOne: jest.fn(),
    };
    const runRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(runQb),
      findOne: jest.fn(),
    };
    const agentRepository = { find: jest.fn().mockResolvedValue(agents), findOne: jest.fn() };

    const service = Object.create(AgentAppsService.prototype) as AgentAppsService;
    (service as any).appRepository = appRepository;
    (service as any).executionRepository = executionRepository;
    (service as any).runRepository = runRepository;
    (service as any).agentRepository = agentRepository;
    return { service, appRepository, executionRepository, runRepository, agentRepository, executionQb, runQb };
  };

  const manyApps = Array.from({ length: 20 }, (_, i) => ({
    id: `app-${i}`,
    slug: `app-${i}`,
    organizationId: ORG,
    agentIds: [`a-${i}-1`, `a-${i}-2`, `a-${i}-3`],
    createdAt: new Date(),
  }));

  it('answers 20 apps x 3 agents in three queries, not 121', async () => {
    const { service, appRepository, executionRepository, runRepository, agentRepository } =
      makeService(manyApps);

    const result = await service.list(ORG);

    expect(result).toHaveLength(20);
    expect(appRepository.find).toHaveBeenCalledTimes(1);
    expect(executionRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(runRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
    // The per-agent findOne pair is gone entirely.
    expect(executionRepository.findOne).not.toHaveBeenCalled();
    expect(runRepository.findOne).not.toHaveBeenCalled();
    // No failures, so no name lookup at all.
    expect(agentRepository.find).not.toHaveBeenCalled();
  });

  it('asks the database for one row per agent with DISTINCT ON', async () => {
    const { service, executionQb, runQb } = makeService(manyApps);

    await service.list(ORG);

    expect(executionQb.distinctOn).toHaveBeenCalledWith(['"execution"."agentId"']);
    expect(executionQb.orderBy).toHaveBeenCalledWith('execution.agentId', 'ASC');
    expect(executionQb.addOrderBy).toHaveBeenCalledWith('execution.createdAt', 'DESC');
    expect(runQb.distinctOn).toHaveBeenCalledWith(['"run"."agentId"']);
    expect(runQb.addOrderBy).toHaveBeenCalledWith('run.createdAt', 'DESC');
  });

  it('reports the same failing verdict the per-agent version did', async () => {
    const at = new Date('2026-02-02T00:00:00Z');
    const apps = [{ id: 'app-1', organizationId: ORG, agentIds: ['a-1'], createdAt: new Date() }];
    const { service, agentRepository } = makeService(
      apps,
      [{ agentId: 'a-1', status: 'failed', createdAt: at, error: 'boom' }],
      [],
      [{ id: 'a-1', name: 'Support Bot' }],
    );

    const [app] = await service.list(ORG);

    expect(app.health).toEqual({
      state: 'failing',
      agentId: 'a-1',
      agentName: 'Support Bot',
      at,
      message: 'boom',
    });
    // One name lookup for all failures, batched.
    expect(agentRepository.find).toHaveBeenCalledTimes(1);
  });

  it('prefers whichever of execution or run happened last', async () => {
    const older = new Date('2026-01-01T00:00:00Z');
    const newer = new Date('2026-03-01T00:00:00Z');
    const apps = [{ id: 'app-1', organizationId: ORG, agentIds: ['a-1'], createdAt: new Date() }];
    const { service } = makeService(
      apps,
      [{ agentId: 'a-1', status: 'failed', createdAt: older, error: 'old failure' }],
      [{ agentId: 'a-1', status: 'completed', createdAt: newer, error: null }],
    );

    const [app] = await service.list(ORG);

    // The newer, successful run wins — same rule the old sort applied.
    expect(app.health).toEqual({ state: 'ok' });
  });

  it('bounds how many apps one page loads', async () => {
    const { service, appRepository } = makeService([]);

    await service.list(ORG);

    expect(appRepository.find.mock.calls[0][0].take).toBe(MAX_APPS_PER_PAGE);
  });

  it('asks for nothing when no app has an agent', async () => {
    const apps = [{ id: 'app-1', organizationId: ORG, agentIds: [], createdAt: new Date() }];
    const { service, executionRepository, runRepository } = makeService(apps);

    const [app] = await service.list(ORG);

    expect(app.health).toEqual({ state: 'ok' });
    expect(executionRepository.createQueryBuilder).not.toHaveBeenCalled();
    expect(runRepository.createQueryBuilder).not.toHaveBeenCalled();
  });
});
