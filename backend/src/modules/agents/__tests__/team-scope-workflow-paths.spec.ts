import axios from 'axios';
import { NotFoundException } from '@nestjs/common';

import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver } from '../agent-template-resolver';
import { AgentSchedulerService } from '../agent-scheduler.service';
import { AgentOpenAIStreamHelper } from '../agent-openai-stream.helper';
import { resolveCompatAgent } from '../compat-auth.helper';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { ToolHttpExecutor } from '../../tools/executors/tool-http.executor';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture, MembershipFixture } from '../../../test/execution-access.fixture';
import {
  ExecutionPrincipal,
  gatewayPrincipal,
  userPrincipal,
} from '../../../common/authorization/execution-access.service';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * "Team only is team only": team scope is an execution boundary on every
 * workflow path, and a run's scope is inherited by everything it starts.
 *
 * One real stack, end to end: AgentExecutionEngine -> AgentNodeExecutor ->
 * (tool_call) ToolExecutorService / (sub_agent) AgentSubAgentExecutors ->
 * the engine again, all over the real ExecutionAccessService and the real
 * AccessPolicyService.canAccess. Only the membership rows
 * (execution-access.fixture), the tables (fakeRepository) and the network
 * (axios) are doubles. Paths covered here: a direct workflow run, the /v1
 * compat surface, a tool_call node, a sub_agent node and a schedule tick.
 *
 * Cast (CAST): `member` is in the agent's team; `nonMember` is in the org
 * but another team; `admin` is an org admin in no team (the READ rule lets
 * owners/admins see every team's resources, so they may run them too);
 * `owner` owns the private resources, which nobody else runs -- admins
 * included.
 */
describe('team scope is an execution boundary (workflow paths)', () => {
  const mockedAxios = axios as unknown as jest.Mock;
  const output = (id = 'out') => ({ id, type: 'output', label: 'Output', position: { x: 0, y: 0 }, data: { mapping: 'done' } });
  const pipelineOf = (...nodes: any[]) => ({ nodes, edges: [] });
  const toolCall = (toolId: string) => ({ id: 'call', type: 'tool_call', label: 'call', position: { x: 0, y: 0 }, data: { toolId } });
  const subAgent = (agentId: string) => ({ id: 'sub', type: 'sub_agent', label: 'sub', position: { x: 0, y: 0 }, data: { agentId } });

  const agentRow = (id: string, visibility: 'org' | 'team' | 'private', extra: Partial<Agent> = {}) =>
    Object.assign(new Agent(), {
      id,
      name: id,
      organizationId: CAST.org,
      status: AgentStatus.ACTIVE,
      mode: 'workflow',
      visibility,
      teamId: visibility === 'team' ? CAST.team : null,
      createdBy: visibility === 'private' ? CAST.owner : CAST.member,
      settings: {},
      pipeline: pipelineOf(output()),
      ...extra,
    });

  const toolBase = {
    organizationId: CAST.org,
    status: ToolStatus.ACTIVE,
    type: ToolType.API,
    httpConfig: { method: 'GET', path: 'https://upstream.example.com/things' },
    configuration: {},
    api: null,
    operation: null,
  };
  const TOOLS = [
    { ...toolBase, id: 'team-tool', name: 'team-tool', visibility: 'team', teamId: CAST.team, createdBy: CAST.member },
    { ...toolBase, id: 'private-tool', name: 'private-tool', visibility: 'private', teamId: null, createdBy: CAST.owner },
  ];

  const AGENTS = () => [
    agentRow('team-agent', 'team'),
    agentRow('private-agent', 'private'),
    // Org agents that reach a team / private resource: what they may reach
    // is decided by whoever runs them, not by the agent.
    agentRow('calls-team-tool', 'org', { pipeline: pipelineOf(toolCall('team-tool')) }),
    agentRow('calls-private-tool', 'org', { pipeline: pipelineOf(toolCall('private-tool')) }),
    agentRow('calls-team-agent', 'org', { pipeline: pipelineOf(subAgent('team-agent')) }),
    agentRow('calls-private-agent', 'org', { pipeline: pipelineOf(subAgent('private-agent')) }),
  ];

  let m: MembershipFixture;
  let engine: AgentExecutionEngine;
  let executions: ReturnType<typeof fakeRepository<AgentExecution>>;
  let agents: ReturnType<typeof fakeRepository<Agent>>;

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
    m = castFixture();
    agents = fakeRepository<Agent>({ seed: AGENTS(), make: () => new Agent() });
    executions = fakeRepository<AgentExecution>({ make: () => new AgentExecution(), idPrefix: 'exec' });

    const tools = new ToolExecutorService(
      fakeRepository<any>(TOOLS) as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue({ hasPermissionInOrganization: () => true, organizationMemberships: [] }) } as any,
      {} as any,
      new ToolHttpExecutor({ applyApiAuth: jest.fn(), applyInlineToolAuth: jest.fn() } as any),
      {} as any,
      {} as any,
      {} as any,
      {
        checkRateLimit: jest.fn().mockResolvedValue({ limited: false }),
        getCachedResult: jest.fn().mockResolvedValue(null),
        cacheResult: jest.fn().mockResolvedValue(undefined),
      } as any,
      { validateParameters: jest.fn().mockResolvedValue({ isValid: true, errors: [] }), recordExecution: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
      fakeRepository<any>([]) as any,
      undefined,
      m.executionAccess,
    );
    const state = {
      emitEvent: jest.fn(),
      bumpAgentStats: jest.fn().mockResolvedValue(undefined),
      withTimeout: (promise: Promise<unknown>) => promise,
    };
    engine = new AgentExecutionEngine(
      agents as any,
      executions as any,
      null as any,
      { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } as any,
      state as any,
      undefined, undefined, undefined, undefined, undefined, undefined,
      m.executionAccess,
    );
    const resolver = new AgentTemplateResolver();
    const subAgents = new AgentSubAgentExecutors(resolver, agents as any, engine, {} as any, {} as any);
    const nodes = new AgentNodeExecutor(resolver, {} as any, tools, agents as any, engine, {} as any, {} as any, subAgents, {} as any);
    (engine as any).nodeExecutor = nodes;
  });

  const agent = (id: string) => agents.row(id)!;
  const run = (id: string, principal: ExecutionPrincipal, userId: string | null = null) =>
    engine.execute(agent(id), CAST.org, userId as any, { input: {}, principal });

  describe('a direct run', () => {
    it.each([
      ['a member of its team', CAST.member],
      ['an org admin (the read rule)', CAST.admin],
    ])('runs a team agent for %s', async (_l, who) => {
      const execution = await run('team-agent', userPrincipal(who));
      expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    });

    it('refuses a team agent to a member of another team as not found, and writes nothing', async () => {
      await expect(run('team-agent', userPrincipal(CAST.nonMember))).rejects.toThrow(new NotFoundException('Agent not found'));
      expect(executions.rows()).toHaveLength(0);
    });

    it('runs a private agent for its owner and nobody else, admins included', async () => {
      expect((await run('private-agent', userPrincipal(CAST.owner))).status).toBe(AgentExecutionStatus.COMPLETED);
      await expect(run('private-agent', userPrincipal(CAST.admin))).rejects.toThrow(NotFoundException);
      await expect(run('private-agent', userPrincipal(CAST.member))).rejects.toThrow(NotFoundException);
      expect(executions.rows()).toHaveLength(1);
    });

    it('decides on the principal, never on the userId the run is stamped with', async () => {
      await expect(run('team-agent', userPrincipal(CAST.nonMember), CAST.admin)).rejects.toThrow(NotFoundException);
    });
  });

  describe('a tool_call node, in an org agent anyone may run', () => {
    it.each([
      ['a member of the tool\'s team', CAST.member],
      ['an org admin', CAST.admin],
    ])('reaches a team tool for %s', async (_l, who) => {
      const execution = await run('calls-team-tool', userPrincipal(who));
      expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('fails the run for a non-member, with the tool reported missing and never called', async () => {
      const execution = await run('calls-team-tool', userPrincipal(CAST.nonMember));
      expect(execution.status).toBe(AgentExecutionStatus.FAILED);
      expect(execution.error).toContain('Tool not found');
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it('reaches a private tool for its owner only', async () => {
      expect((await run('calls-private-tool', userPrincipal(CAST.owner))).status).toBe(AgentExecutionStatus.COMPLETED);
      expect((await run('calls-private-tool', userPrincipal(CAST.admin))).status).toBe(AgentExecutionStatus.FAILED);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it('inherits the scope: an admin-stamped run started by a non-member still cannot reach the team tool', async () => {
      const execution = await run('calls-team-tool', userPrincipal(CAST.nonMember), CAST.admin);
      expect(execution.status).toBe(AgentExecutionStatus.FAILED);
      expect(mockedAxios).not.toHaveBeenCalled();
    });
  });

  describe('a sub_agent node, in an org agent anyone may run', () => {
    it.each([
      ['a member of its team', CAST.member],
      ['an org admin', CAST.admin],
    ])('starts a team sub-agent for %s', async (_l, who) => {
      const execution = await run('calls-team-agent', userPrincipal(who));
      expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
      // Parent and child both ran.
      expect(executions.rows().map((e) => e.agentId).sort()).toEqual(['calls-team-agent', 'team-agent']);
    });

    it('fails the run for a non-member, naming the sub-agent as missing; the child never starts', async () => {
      const execution = await run('calls-team-agent', userPrincipal(CAST.nonMember));
      expect(execution.status).toBe(AgentExecutionStatus.FAILED);
      expect(execution.error).toContain("Sub-agent 'team-agent' not found");
      expect(executions.rows().map((e) => e.agentId)).toEqual(['calls-team-agent']);
    });

    it('starts a private sub-agent for its owner only', async () => {
      expect((await run('calls-private-agent', userPrincipal(CAST.owner))).status).toBe(AgentExecutionStatus.COMPLETED);
      expect((await run('calls-private-agent', userPrincipal(CAST.admin))).status).toBe(AgentExecutionStatus.FAILED);
    });

    it('hands the child the parent\'s scope: a gateway scoped to the team reaches the team sub-agent, an org gateway does not', async () => {
      const teamGateway = gatewayPrincipal({ id: 'gw-t', organizationId: CAST.org, visibility: 'team', teamId: CAST.team });
      const orgGateway = gatewayPrincipal({ id: 'gw-o', organizationId: CAST.org, visibility: 'org', ownerUserId: CAST.member });
      expect((await run('calls-team-agent', teamGateway)).status).toBe(AgentExecutionStatus.COMPLETED);
      expect((await run('calls-team-agent', orgGateway)).status).toBe(AgentExecutionStatus.FAILED);
    });
  });

  describe('the /v1 compat surface', () => {
    // AgentsService as it answers over Postgres, for the two lookups used.
    const agentsService = () => ({
      async getAgent(id: string, organizationId: string) {
        const row = agents.rows().find((a) => a.id === id && a.organizationId === organizationId);
        if (!row) throw new NotFoundException(`Agent not found: ${id}`);
        return row;
      },
      async findByName(name: string, organizationId: string) {
        return agents.rows().find((a) => a.name === name && a.organizationId === organizationId) ?? null;
      },
    });
    const key = (userId: string) => ({ userId, organizationId: CAST.org, agentId: null }) as any;
    const resolve = (model: string, userId: string) =>
      resolveCompatAgent(agentsService() as any, model, key(userId), m.executionAccess);

    it.each([
      ['a member of its team', CAST.member],
      ['an org admin', CAST.admin],
    ])('serves a team agent to the key of %s, and runs it in that key\'s scope', async (_l, who) => {
      const resolved = await resolve('agent:team-agent', who);
      const res: any = { statusCode: 200, setHeader: jest.fn(), status(c: number) { this.statusCode = c; return this; }, json: jest.fn() };
      await new AgentOpenAIStreamHelper(engine).handleSync(resolved, {}, key(who), res);
      expect(res.statusCode).toBe(200);
      expect(executions.rows()[0].status).toBe(AgentExecutionStatus.COMPLETED);
    });

    it('answers a non-member exactly as it answers a model that does not exist', async () => {
      const refused = await resolve('agent:team-agent', CAST.nonMember).catch((e) => e);
      const missing = await resolve('agent:no-such-agent', CAST.nonMember).catch((e) => e);
      expect(refused).toBeInstanceOf(NotFoundException);
      expect(refused.message).toBe('Agent not found: agent:team-agent');
      expect(missing.message).toBe('Agent not found: agent:no-such-agent');
    });

    it('serves a private agent to its owner\'s key only', async () => {
      await expect(resolve('agent:private-agent', CAST.owner)).resolves.toMatchObject({ id: 'private-agent' });
      await expect(resolve('agent:private-agent', CAST.admin)).rejects.toThrow(NotFoundException);
    });
  });

  describe('a schedule tick, authorized as the agent owner at fire time', () => {
    function scheduler() {
      const queue = {
        add: jest.fn(),
        getRepeatableJobs: jest.fn().mockResolvedValue([{ id: 'schedule-team-agent', key: 'k-1' }]),
        removeRepeatableByKey: jest.fn().mockResolvedValue(undefined),
      };
      const svc = new AgentSchedulerService({} as any, engine, agents as any, queue as any, m.executionAccess, executions as any);
      return { svc, queue };
    }
    const tick = (svc: AgentSchedulerService, agentId: string) =>
      svc.handleScheduledExecution({ data: { agentId, organizationId: CAST.org, input: {} } } as any);
    const schedule = (id: string, createdBy: string) => {
      const row = agents.row(id)!;
      agents.seed({ ...row, createdBy, settings: { schedule: { enabled: true, intervalMinutes: 60, input: {} } } });
    };

    it.each([
      ['a member of its team', CAST.member],
      ['an org admin', CAST.admin],
    ])('runs a team agent owned by %s', async (_l, owner) => {
      schedule('team-agent', owner);
      await tick(scheduler().svc, 'team-agent');
      expect(executions.rows().map((e) => e.status)).toEqual([AgentExecutionStatus.COMPLETED]);
      expect(executions.rows()[0].userId).toBe(owner);
    });

    it('stops, visibly, once the owner has left the team: a failed run saying why, and the schedule paused', async () => {
      schedule('team-agent', CAST.member);
      const { svc, queue } = scheduler();
      await tick(svc, 'team-agent');
      m.leaveTeam(CAST.team, CAST.member);
      await tick(svc, 'team-agent');

      const [first, second] = executions.rows();
      expect(first.status).toBe(AgentExecutionStatus.COMPLETED);
      expect(second.status).toBe(AgentExecutionStatus.FAILED);
      expect(second.error).toContain(`the agent's owner (${CAST.member}) can no longer run this agent`);
      expect(second.metadata).toMatchObject({ triggerType: 'scheduled', refusedBy: 'execution_access' });
      const after = agents.row('team-agent')!;
      expect(after.settings.schedule).toMatchObject({ enabled: false, pausedReason: { code: 'OWNER_CANNOT_RUN' } });
      expect(queue.removeRepeatableByKey).toHaveBeenCalledWith('k-1');
    });

    it('refuses a team agent whose owner is not in the team at all', async () => {
      schedule('team-agent', CAST.nonMember);
      await tick(scheduler().svc, 'team-agent');
      expect(executions.rows().map((e) => e.status)).toEqual([AgentExecutionStatus.FAILED]);
    });

    it('runs a private agent for its owner; the owner is the only one it can run as', async () => {
      schedule('private-agent', CAST.owner);
      await tick(scheduler().svc, 'private-agent');
      expect(executions.rows().map((e) => e.status)).toEqual([AgentExecutionStatus.COMPLETED]);
    });
  });
});
