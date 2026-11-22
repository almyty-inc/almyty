/**
 * Real-Postgres spec for an agent's numbers (agent-run-stats.ts): the
 * header's runs, completed, checks, average time and cost are aggregates
 * over the runs that still exist, so removing runs (Delete run and a
 * visitor's erasure go through removeRuns; the retention sweep deletes
 * rows) brings them down, whatever the lifetime counters on the agent row
 * say. Also runs the list's "sort by runs" expression against Postgres.
 *
 * Gated behind RUN_DB_INTEGRATION=1 like the other specs in this folder.
 */
import { DataSource, Repository } from 'typeorm';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentRun, AgentRunStatus, AgentMode } from '../../entities/agent-run.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import { Organization } from '../../entities/organization.entity';
import { loadAgentRunStats } from '../../modules/agents/agent-run-stats';
import { removeRuns } from '../../modules/agents/run-removal';
import { AgentsService } from '../../modules/agents/agents.service';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'agent_run_stats_test';

jest.setTimeout(60_000);

describeIfDb('agent run stats from existing runs (real Postgres)', () => {
  let ds: DataSource;
  let orgId: string;
  let agents: Repository<Agent>;
  let runs: Repository<AgentRun>;
  let executions: Repository<AgentExecution>;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres_test',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      migrationsTransactionMode: 'each',
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();

    const org = await ds.getRepository(Organization).save({
      name: 'agent-run-stats',
      slug: 'agent-run-stats',
      description: 'fixture',
      plan: 'free',
      isActive: true,
    } as any);
    orgId = org.id;
    agents = ds.getRepository(Agent);
    runs = ds.getRepository(AgentRun);
    executions = ds.getRepository(AgentExecution);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  async function agent(name: string, counters: Partial<Agent> = {}): Promise<Agent> {
    return (await agents.save({
      name,
      organizationId: orgId,
      status: AgentStatus.ACTIVE,
      pipeline: { nodes: [], edges: [] },
      ...counters,
    } as any)) as Agent;
  }

  async function run(agentId: string, status: AgentRunStatus, executionTime: number, totalCost: number, verify?: object): Promise<AgentRun> {
    return runs.save({
      agentId,
      organizationId: orgId,
      mode: AgentMode.AUTONOMOUS,
      status,
      executionTime,
      totalCost,
      metadata: verify ? { verify } : null,
    } as any);
  }

  async function execution(agentId: string, status: AgentExecutionStatus, executionTime: number, totalCost: number): Promise<AgentExecution> {
    return executions.save({ agentId, organizationId: orgId, status, executionTime, totalCost } as any);
  }

  it('counts the runs that exist and drops with every removed run, whatever the counters say', async () => {
    // Lifetime counters from runs long gone: none of this may show.
    const a = await agent('stats-autonomous', {
      totalExecutions: 142,
      successfulExecutions: 140,
      checkedExecutions: 50,
      passedCheckExecutions: 49,
      totalCost: 9.99,
      averageExecutionTime: 1600,
    });
    const passed = await run(a.id, AgentRunStatus.COMPLETED, 1000, 0.01, { verdict: 'pass' });
    const failedCheck = await run(a.id, AgentRunStatus.COMPLETED, 3000, 0.03, { verdict: 'fail', reportOnly: true });
    const failed = await run(a.id, AgentRunStatus.FAILED, 2000, 0.02);
    await run(a.id, AgentRunStatus.COMPLETED, 6000, 0.04, { verdict: 'fail', unavailable: true });
    // Still going: no final time or cost yet, not counted.
    await run(a.id, AgentRunStatus.RUNNING, 500, 0.5);

    let stats = (await loadAgentRunStats(ds.manager, [a.id])).get(a.id)!;
    expect(stats).toEqual({
      runs: 4,
      completed: 3,
      checked: 2,
      checksPassed: 1,
      averageRunTimeMs: 3000, // (1000 + 3000 + 2000 + 6000) / 4
      totalCost: expect.closeTo(0.1, 6),
    });

    // "Delete run" (and a visitor's erasure) go through removeRuns.
    await ds.transaction((tx) => removeRuns(tx, orgId, [passed.id, failed.id]));

    stats = (await loadAgentRunStats(ds.manager, [a.id])).get(a.id)!;
    expect(stats).toEqual({
      runs: 2,
      completed: 2,
      checked: 1,
      checksPassed: 0,
      averageRunTimeMs: 4500, // (3000 + 6000) / 2
      totalCost: expect.closeTo(0.07, 6),
    });

    // The retention sweep deletes rows outright.
    await runs.delete({ id: failedCheck.id });
    stats = (await loadAgentRunStats(ds.manager, [a.id])).get(a.id)!;
    expect(stats.runs).toBe(1);
    expect(stats.checked).toBe(0);
    expect(stats.averageRunTimeMs).toBe(6000);
    expect(stats.totalCost).toBeCloseTo(0.04, 6);
  });

  it('counts a workflow agent from its executions, and an agent with no runs as zeros', async () => {
    const w = await agent('stats-workflow', { totalExecutions: 30, successfulExecutions: 30, totalCost: 3 });
    const none = await agent('stats-none', { totalExecutions: 7, averageExecutionTime: 900 });
    const done = await execution(w.id, AgentExecutionStatus.COMPLETED, 1000, 0.1);
    await execution(w.id, AgentExecutionStatus.FAILED, 3000, 0.2);
    await execution(w.id, AgentExecutionStatus.RUNNING, 10, 0.3);

    let all = await loadAgentRunStats(ds.manager, [w.id, none.id]);
    expect(all.get(w.id)).toEqual({ runs: 2, completed: 1, checked: 0, checksPassed: 0, averageRunTimeMs: 2000, totalCost: expect.closeTo(0.3, 6) });
    expect(all.get(none.id)).toEqual({ runs: 0, completed: 0, checked: 0, checksPassed: 0, averageRunTimeMs: 0, totalCost: 0 });

    await executions.delete({ id: done.id });
    all = await loadAgentRunStats(ds.manager, [w.id]);
    expect(all.get(w.id)).toEqual({ runs: 1, completed: 0, checked: 0, checksPassed: 0, averageRunTimeMs: 3000, totalCost: expect.closeTo(0.2, 6) });
  });

  it('sorts the agents list by the runs that exist, not the counter column', async () => {
    const sortOrg = await ds.getRepository(Organization).save({
      name: 'agent-run-stats-sort',
      slug: 'agent-run-stats-sort',
      description: 'fixture',
      plan: 'free',
      isActive: true,
    } as any);
    const mk = (name: string, totalExecutions: number) =>
      agents.save({ name, organizationId: sortOrg.id, status: AgentStatus.ACTIVE, pipeline: { nodes: [], edges: [] }, totalExecutions } as any) as Promise<Agent>;
    const many = await mk('many-counted', 500);
    const two = await mk('two-runs', 0);
    const one = await mk('one-execution', 0);
    for (const s of [AgentRunStatus.COMPLETED, AgentRunStatus.FAILED]) {
      await runs.save({ agentId: two.id, organizationId: sortOrg.id, mode: AgentMode.AUTONOMOUS, status: s } as any);
    }
    await executions.save({ agentId: one.id, organizationId: sortOrg.id, status: AgentExecutionStatus.COMPLETED } as any);

    // The real filter scopes to the organization (and the caller's teams).
    const accessPolicy = {
      applyListFilter: jest.fn(async (qb: any, _caller: unknown, organizationId: string, alias: string) => {
        qb.andWhere(`${alias}.organizationId = :organizationId`, { organizationId });
      }),
    };
    const service = new AgentsService(agents, executions, {} as any, {} as any, {} as any, {} as any, accessPolicy as any, {} as any);
    const page = await service.getAgents({ organizationId: sortOrg.id, caller: { id: 'u' }, sortBy: 'totalExecutions', sortOrder: 'DESC' });
    expect(page.data.map((x) => x.name)).toEqual(['two-runs', 'one-execution', 'many-counted']);
    expect(page.total).toBe(3);
    expect(many.id).toBeDefined();
  });
});
