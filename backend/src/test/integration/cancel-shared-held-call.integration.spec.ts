/**
 * Real-Postgres spec for cancelling a workflow execution that waits on a
 * held tool call (AgentExecutionCancellationService.closeApprovals). One
 * approval request can stand for several waiting executions; cancelling one
 * closes the request only when no other execution of the org still waits
 * on it. That check used to read the org's waiting executions with
 * `take: 500`, so a sharer past the first 500 was missed and the request
 * it still waited on was closed under it. It is now one EXISTS with a JSON
 * containment on metadata.waitingForApproval.steps, asked of the real
 * schema here with more waiting executions than that cap.
 *
 * Gated behind `RUN_DB_INTEGRATION=1`, like the other DB specs.
 */
import { DataSource, Repository } from 'typeorm';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../entities/agent-execution.entity';
import { ApprovalRequest } from '../../entities/approval-request.entity';
import { Organization } from '../../entities/organization.entity';
import { AgentExecutionCancellationService } from '../../modules/agents/agent-execution-cancellation.service';
import { ApprovalsService, RUN_CANCELLED_REASON } from '../../modules/approvals/approvals.service';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'cancel_shared_held_call_test';

jest.setTimeout(120_000);

describeIfDb('cancelling a run that shares a held call (real Postgres)', () => {
  let ds: DataSource;
  let executions: Repository<AgentExecution>;
  let requests: Repository<ApprovalRequest>;
  let cancellations: AgentExecutionCancellationService;
  let orgId: string;
  let otherOrgId: string;
  let agentId: string;
  let otherAgentId: string;

  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
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
    executions = ds.getRepository(AgentExecution);
    requests = ds.getRepository(ApprovalRequest);

    const orgs = ds.getRepository(Organization);
    const agents = ds.getRepository(Agent);
    const stamp = Date.now();
    orgId = (await orgs.save({ name: 'held-call', slug: `held-call-${stamp}`, plan: 'free', isActive: true } as any)).id;
    otherOrgId = (await orgs.save({ name: 'held-call-2', slug: `held-call-2-${stamp}`, plan: 'free', isActive: true } as any)).id;
    const agent = (org: string) =>
      agents.save({ name: `refunds-${org}`, organizationId: org, status: AgentStatus.ACTIVE, pipeline: { nodes: [], edges: [] } } as any);
    agentId = (await agent(orgId)).id;
    otherAgentId = (await agent(otherOrgId)).id;

    const approvals = new ApprovalsService(
      requests,
      ds.getRepository('AgentRun') as any,
      { find: async () => [], save: async (r: any) => r, create: (p: any) => p } as any,
      { canAccess: async () => ({ allowed: true }), applyListFilter: async () => ({ bypass: true }) } as any,
    );
    cancellations = new AgentExecutionCancellationService(executions, undefined, undefined, approvals);
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  beforeEach(async () => {
    await executions.createQueryBuilder().delete().execute();
    await requests.createQueryBuilder().delete().execute();
  });

  const heldRefund = (org = orgId) =>
    requests.save({
      organizationId: org,
      visibility: 'org',
      agentId: org === orgId ? agentId : otherAgentId,
      reason: 'Issue refund (amount is 820)',
      payload: { _gate: { kind: 'tool_amount' } },
      status: 'pending',
    } as any);

  const waitingOn = (approvalId: string, org = orgId) => ({
    organizationId: org,
    agentId: org === orgId ? agentId : otherAgentId,
    status: AgentExecutionStatus.WAITING_APPROVAL,
    metadata: {
      waitingForApproval: {
        steps: [{ nodeId: 'refund', kind: 'tool_call', approvalId, codeExecutionId: null, changes: 1, call: 'Issue refund' }],
        toolCalls: 1,
        pipeline: { nodes: [], edges: [] },
      },
    },
  });

  /** Waiting executions on requests of their own, inserted ahead of whatever comes next. */
  const fillers = async (n: number) => {
    const own = await requests.save(Array.from({ length: n }, () => ({ organizationId: orgId, visibility: 'org', reason: 'x', status: 'pending' }) as any));
    for (let i = 0; i < n; i += 200) {
      await executions.insert(own.slice(i, i + 200).map((r) => waitingOn(r.id)) as any);
    }
  };

  it('keeps the request open for a run waiting on it past the first 500 waiting runs', async () => {
    const shared = await heldRefund();
    const cancelled = await executions.save(waitingOn(shared.id) as any);
    await fillers(600);
    const sharer = await executions.save(waitingOn(shared.id) as any);
    expect(await executions.count({ where: { organizationId: orgId, status: AgentExecutionStatus.WAITING_APPROVAL } })).toBe(602);

    await cancellations.cancel(cancelled.id, orgId, undefined, undefined);

    expect((await executions.findOneByOrFail({ id: cancelled.id })).status).toBe(AgentExecutionStatus.CANCELLED);
    expect((await requests.findOneByOrFail({ id: shared.id })).status).toBe('pending');
    expect((await executions.findOneByOrFail({ id: sharer.id })).status).toBe(AgentExecutionStatus.WAITING_APPROVAL);
  });

  it('closes the request when no other run waits on it, however many other runs wait', async () => {
    const own = await heldRefund();
    const cancelled = await executions.save(waitingOn(own.id) as any);
    await fillers(600);

    await cancellations.cancel(cancelled.id, orgId, undefined, undefined);

    expect(await requests.findOneByOrFail({ id: own.id })).toMatchObject({ status: 'cancelled', decisionReason: RUN_CANCELLED_REASON });
  });

  it('a run in another org, or one no longer waiting, does not hold the request open', async () => {
    const shared = await heldRefund();
    const cancelled = await executions.save(waitingOn(shared.id) as any);
    await executions.save(waitingOn(shared.id, otherOrgId) as any);
    await executions.save({ ...waitingOn(shared.id), status: AgentExecutionStatus.COMPLETED } as any);

    await cancellations.cancel(cancelled.id, orgId, undefined, undefined);

    expect((await requests.findOneByOrFail({ id: shared.id })).status).toBe('cancelled');
  });
});
