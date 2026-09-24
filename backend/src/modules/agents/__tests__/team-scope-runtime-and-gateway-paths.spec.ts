import * as crypto from 'crypto';
import axios from 'axios';
import { NotFoundException } from '@nestjs/common';

import { AgentRuntimeService } from '../agent-runtime.service';
import { AgentBuiltInToolsHelper } from '../agent-builtin-tools.helper';
import { AgentRuntimeProcessor } from '../agent-runtime.processor';
import { AgentHeartbeatHelper } from '../agent-heartbeat.helper';
import { AgentStepProcessor } from '../agent-step-processor';
import { ChannelGatewayService } from '../../gateways/channels/channel-gateway.service';
import { ChatWidgetAdapter } from '../../gateways/channels/adapters/chat-widget.adapter';
import { SlackAdapter } from '../../gateways/channels/adapters/slack.adapter';
import { DiscordAdapter } from '../../gateways/channels/adapters/discord.adapter';
import { TelegramAdapter } from '../../gateways/channels/adapters/telegram.adapter';
import { WhatsAppAdapter } from '../../gateways/channels/adapters/whatsapp.adapter';
import { WhatsAppCloudAdapter } from '../../gateways/channels/adapters/whatsapp-cloud.adapter';
import { SmsAdapter } from '../../gateways/channels/adapters/sms.adapter';
import { EmailAdapter } from '../../gateways/channels/adapters/email.adapter';
import { WebhookAdapter } from '../../gateways/channels/adapters/webhook.adapter';
import { GoogleChatAdapter } from '../../gateways/channels/adapters/google-chat.adapter';
import { MicrosoftTeamsAdapter } from '../../gateways/channels/adapters/microsoft-teams.adapter';
import { SignalAdapter } from '../../gateways/channels/adapters/signal.adapter';
import { MatrixAdapter } from '../../gateways/channels/adapters/matrix.adapter';
import { IrcAdapter } from '../../gateways/channels/adapters/irc.adapter';
import { McpToolHandler } from '../../mcp/services/mcp-tool.handler';
import { JsonRpcErrorCode } from '../../mcp/types/mcp.types';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { ToolHttpExecutor } from '../../tools/executors/tool-http.executor';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { Tool, ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeManager, fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture, MembershipFixture } from '../../../test/execution-access.fixture';
import {
  ExecutionPrincipal,
  userPrincipal,
} from '../../../common/authorization/execution-access.service';

jest.mock('axios', () => {
  const fn: any = jest.fn();
  fn.isAxiosError = () => false;
  return { __esModule: true, default: fn, isAxiosError: () => false };
});

/**
 * "Team only is team only" on the autonomous runtime and the published
 * surfaces: a direct run, invoke_agent and create_agent from inside a run,
 * a heartbeat, an inbound webhook (the Webhook channel gateway) and an MCP
 * gateway's tools/call.
 *
 * The real AgentRuntimeService.startRun, AgentBuiltInToolsHelper,
 * ChannelGatewayService, McpToolHandler and ToolExecutorService, over the
 * real ExecutionAccessService and AccessPolicyService.canAccess. Doubles:
 * the membership rows (execution-access.fixture), the tables
 * (fakeRepository), the queue, and the pieces of the runtime a run start
 * does not decide anything with (limits, emitters).
 *
 * Cast (CAST): `member` is in the team, `nonMember` in another team of the
 * same org, `admin` an org admin in no team, `owner` owns the private rows.
 */
describe('team scope is an execution boundary (runtime and gateway paths)', () => {
  const mockedAxios = axios as unknown as jest.Mock;

  const agentRow = (id: string, visibility: 'org' | 'team' | 'private', extra: Partial<Agent> = {}) =>
    Object.assign(new Agent(), {
      id,
      name: id,
      organizationId: CAST.org,
      status: AgentStatus.ACTIVE,
      mode: 'autonomous',
      visibility,
      teamId: visibility === 'team' ? CAST.team : null,
      createdBy: visibility === 'private' ? CAST.owner : CAST.member,
      toolIds: [],
      modelConfig: { providerId: 'p-1', model: 'm' },
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
  const toolRow = (id: string, visibility: 'org' | 'team' | 'private') =>
    Object.assign(new Tool(), {
      ...toolBase,
      id,
      name: id,
      visibility,
      teamId: visibility === 'team' ? CAST.team : null,
      createdBy: visibility === 'private' ? CAST.owner : CAST.member,
    });

  let m: MembershipFixture;
  let agents: ReturnType<typeof fakeRepository<Agent>>;
  let runs: ReturnType<typeof fakeRepository<AgentRun>>;
  let tools: ReturnType<typeof fakeRepository<Tool>>;
  let gatewayTools: ReturnType<typeof fakeRepository<GatewayTool>>;
  let runtime: AgentRuntimeService;
  let toolExecutor: ToolExecutorService;
  let queue: { add: jest.Mock; getRepeatableJobs: jest.Mock; removeRepeatableByKey: jest.Mock };

  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { ok: true }, headers: {} });
    m = castFixture();
    agents = fakeRepository<Agent>({
      seed: [agentRow('team-agent', 'team'), agentRow('private-agent', 'private'), agentRow('org-agent', 'org')],
      make: () => new Agent(),
    });
    tools = fakeRepository<Tool>({
      seed: [toolRow('org-tool', 'org'), toolRow('team-tool', 'team'), toolRow('private-tool', 'private')],
      make: () => new Tool(),
    });
    fakeManager([[Agent, agents], [Tool, tools]]);
    runs = fakeRepository<AgentRun>({ make: () => new AgentRun(), idPrefix: 'run' });
    // One gateway_tools table, read by the MCP handler and the executor alike.
    gatewayTools = fakeRepository<GatewayTool>({ make: () => new GatewayTool() });
    queue = { add: jest.fn(), getRepeatableJobs: jest.fn().mockResolvedValue([]), removeRepeatableByKey: jest.fn() };

    toolExecutor = new ToolExecutorService(
      tools as any,
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
      gatewayTools as any,
      undefined,
      m.executionAccess,
    );

    const misc = {
      resolveLimits: async () => ({ maxSteps: 50, maxRecursionDepth: 10 }),
      // A child run "finishes" as soon as it is asked about.
      waitForRun: async (id: string) => ({ ...runs.row(id), status: AgentRunStatus.COMPLETED, output: 'ok' }),
    };
    const events = { ensureRunEmitter: jest.fn(), getRunEmitter: jest.fn().mockReturnValue(null), emitEvent: jest.fn() };
    runtime = new AgentRuntimeService(
      runs as any,
      agents as any,
      tools as any,
      {} as any,
      fakeRepository<any>({ idPrefix: 'conv' }) as any,
      fakeRepository<any>({ idPrefix: 'msg' }) as any,
      queue as any,
      {} as any,
      toolExecutor,
      {} as any,
      {} as any,
      {} as any,
      // The real helper over the same agents table, so what it writes is read back.
      new AgentHeartbeatHelper(agents as any, queue as any),
      {} as any,
      {} as any,
      events as any,
      misc as any,
      undefined,
      {} as any,
      {} as any,
      { enforceForRun: jest.fn().mockResolvedValue(undefined) } as any,
      m.executionAccess,
    );
  });

  const start = (agentId: string, principal: ExecutionPrincipal, userId: string | null = null) =>
    runtime.startRun(agentId, CAST.org, userId, 'go', { principal });

  describe('a direct autonomous run', () => {
    it.each([
      ['a member of its team', CAST.member],
      ['an org admin (the read rule)', CAST.admin],
    ])('starts a team agent for %s, and the run carries that scope', async (_l, who) => {
      const run = await start('team-agent', userPrincipal(who), who);
      expect(runs.row(run.id)!.principal).toEqual(userPrincipal(who));
      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('refuses a team agent to a member of another team as not found, and writes and queues nothing', async () => {
      await expect(start('team-agent', userPrincipal(CAST.nonMember), CAST.nonMember)).rejects.toThrow(
        new NotFoundException('Agent not found'),
      );
      await expect(start('no-such-agent', userPrincipal(CAST.nonMember))).rejects.toThrow(
        new NotFoundException('Agent not found'),
      );
      expect(runs.rows()).toHaveLength(0);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('starts a private agent for its owner and nobody else, admins included', async () => {
      await start('private-agent', userPrincipal(CAST.owner), CAST.owner);
      await expect(start('private-agent', userPrincipal(CAST.admin))).rejects.toThrow(NotFoundException);
      await expect(start('private-agent', userPrincipal(CAST.member))).rejects.toThrow(NotFoundException);
      expect(runs.rows()).toHaveLength(1);
    });
  });

  describe('every step of an autonomous run re-checks the run scope', () => {
    const stepOf = (principal: ExecutionPrincipal) => {
      runs.seed(
        Object.assign(new AgentRun(), {
          id: 'run-resumed',
          agentId: 'team-agent',
          organizationId: CAST.org,
          status: AgentRunStatus.RUNNING,
          currentStep: 3,
          steps: [],
          totalCost: 0,
          totalTokens: 0,
          executionTime: 0,
          toolCallCount: 0,
          maxSteps: 50,
          limits: {},
          principal,
          // fakeRepository does not join; the row carries its agent.
          agent: agents.row('team-agent'),
        }),
      );
      const chatStream = jest.fn();
      (runtime as any).llmProvidersService = { chatStream };
      (runtime as any).builders = { buildMessages: async () => [], buildToolDefinitions: () => [] };
      (runtime as any).organizationRepository = fakeRepository<any>([{ id: CAST.org }]);
      (runtime as any).logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn(), error: jest.fn() };
      const processor = new AgentStepProcessor(runtime, {} as any, {} as any, {} as any);
      return { processor, chatStream };
    };

    it('stops a run, with a reason, once its starter has left the agent\'s team (e.g. resumed after input)', async () => {
      const { processor, chatStream } = stepOf(userPrincipal(CAST.member));
      m.leaveTeam(CAST.team, CAST.member);
      await expect(processor.processStep('run-resumed')).resolves.toBe('done');
      const after = runs.row('run-resumed')!;
      expect(after.status).toBe(AgentRunStatus.FAILED);
      expect(after.error).toContain(`user ${CAST.member} can no longer run this agent`);
      expect(chatStream).not.toHaveBeenCalled();
    });

    it('carries on while the starter is still in the team', async () => {
      const { processor, chatStream } = stepOf(userPrincipal(CAST.member));
      chatStream.mockRejectedValue(new Error('model reached'));
      await processor.processStep('run-resumed').catch(() => undefined);
      // It got as far as calling the model, and failed only on what the model did.
      expect(chatStream).toHaveBeenCalledTimes(1);
      expect(runs.row('run-resumed')!.error).toBe('model reached');
    });
  });

  // The parent agent may start and create agents at all (the #783 gate);
  // which ones is then the run principal's scope.
  const spawner = (id: string, visibility: 'org' | 'team' | 'private') =>
    agentRow(id, visibility, {
      agentConfig: { canCreateAgents: true, canCallAgents: true },
      // A child only gets tools its parent has (#783); scope then decides.
      toolIds: ['team-tool', 'org-tool', 'private-tool'],
    } as any);

  describe('invoke_agent, from inside a run', () => {
    const helper = () =>
      new AgentBuiltInToolsHelper(agents as any, queue as any, {} as any, runtime, {} as any);
    const parentRun = (principal: ExecutionPrincipal, userId: string | null = null) =>
      Object.assign(new AgentRun(), { id: 'parent-run', organizationId: CAST.org, userId, endUserId: null, principal });

    it.each([
      ['a member of its team', CAST.member],
      ['an org admin', CAST.admin],
    ])('starts a team agent for a run started by %s, and the child inherits the parent scope', async (_l, who) => {
      const out = await helper().executeBuiltInTool(
        'invoke_agent',
        { agentId: 'team-agent', input: 'hi' },
        parentRun(userPrincipal(who)),
        spawner('org-agent', 'org'),
      );
      expect(out?.error).toBeUndefined();
      const [child] = runs.rows();
      expect(child.agentId).toBe('team-agent');
      expect(child.parentRunId).toBe('parent-run');
      expect(child.principal).toEqual(userPrincipal(who));
    });

    it('refuses a team agent to a run a non-member started, even when the run is stamped with an admin', async () => {
      const out = await helper().executeBuiltInTool(
        'invoke_agent',
        { agentId: 'team-agent', input: 'hi' },
        parentRun(userPrincipal(CAST.nonMember), CAST.admin),
        spawner('org-agent', 'org'),
      );
      expect(out?.error).toBe('Failed to invoke agent: Agent not found');
      expect(runs.rows()).toHaveLength(0);
    });

    it('starts a private agent only for a run its owner started', async () => {
      const own = await helper().executeBuiltInTool('invoke_agent', { agentId: 'private-agent', input: 'hi' }, parentRun(userPrincipal(CAST.owner)), spawner('owner-parent', 'private'));
      const admins = await helper().executeBuiltInTool('invoke_agent', { agentId: 'private-agent', input: 'hi' }, parentRun(userPrincipal(CAST.admin)), spawner('owner-parent', 'private'));
      expect(own?.error).toBeUndefined();
      expect(admins?.error).toBe('Failed to invoke agent: Agent not found');
      expect(runs.rows()).toHaveLength(1);
    });
  });

  describe('create_agent, from inside a run', () => {
    const helper = () =>
      new AgentBuiltInToolsHelper(agents as any, queue as any, {} as any, runtime, {} as any);
    const parentRun = (principal: ExecutionPrincipal) =>
      Object.assign(new AgentRun(), { id: 'parent-run', organizationId: CAST.org, userId: null, principal });
    const create = (principal: ExecutionPrincipal, toolIds: string[]) =>
      helper().executeBuiltInTool(
        'create_agent',
        { name: 'helper', instructions: 'help', toolIds },
        parentRun(principal),
        spawner('org-agent', 'org'),
      );
    const temporaries = () => agents.rows().filter((a) => a.isTemporary);

    it.each([
      ['a member of its team', CAST.member],
      ['an org admin', CAST.admin],
    ])('gives the new agent a team tool for a run started by %s', async (_l, who) => {
      const out = await create(userPrincipal(who), ['team-tool', 'org-tool']);
      expect(out?.error).toBeUndefined();
      expect(temporaries().map((a) => a.toolIds)).toEqual([['team-tool', 'org-tool']]);
    });

    it('refuses a team tool to a run a non-member started, naming it missing and creating nothing', async () => {
      const out = await create(userPrincipal(CAST.nonMember), ['org-tool', 'team-tool']);
      expect(out?.error).toBe('Failed to create temporary agent: tool not found: team-tool');
      expect(temporaries()).toHaveLength(0);
    });

    it('gives a private tool only to its owner\'s run', async () => {
      expect((await create(userPrincipal(CAST.owner), ['private-tool']))?.error).toBeUndefined();
      expect((await create(userPrincipal(CAST.admin), ['private-tool']))?.error).toContain('tool not found: private-tool');
      expect(temporaries()).toHaveLength(1);
    });
  });

  describe('a heartbeat, authorized as the agent owner at fire time', () => {
    const beat = (agentId: string) =>
      new AgentRuntimeProcessor(runtime, queue as any, agents as any, runs as any).handleHeartbeat({
        data: { agentId, organizationId: CAST.org },
      } as any);
    const withHeartbeat = (id: string, createdBy: string) =>
      agents.seed({ ...agents.row(id)!, createdBy, heartbeat: { enabled: true, intervalMinutes: 5, prompt: 'check in' } });

    it('starts a team agent owned by a member of its team', async () => {
      withHeartbeat('team-agent', CAST.member);
      await beat('team-agent');
      expect(runs.rows().map((r) => r.status)).toEqual([AgentRunStatus.RUNNING]);
    });

    it('stops with a failed run that says why once the owner has left the team', async () => {
      withHeartbeat('team-agent', CAST.member);
      m.leaveTeam(CAST.team, CAST.member);
      await beat('team-agent');
      const [refused] = runs.rows();
      expect(refused.status).toBe(AgentRunStatus.FAILED);
      expect(refused.error).toContain(`the agent's owner (${CAST.member}) can no longer run this agent`);
      // Off, on the agent row, with the reason its page shows.
      const { heartbeat } = agents.row('team-agent')!;
      expect(heartbeat).toMatchObject({
        enabled: false,
        intervalMinutes: 5,
        prompt: 'check in',
        pausedReason: { code: 'OWNER_CANNOT_RUN', message: refused.error },
      });
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('turning the heartbeat back on clears the reason', async () => {
      withHeartbeat('team-agent', CAST.member);
      m.leaveTeam(CAST.team, CAST.member);
      await beat('team-agent');
      await runtime.enableHeartbeat('team-agent', CAST.org, 5, 'check in');
      expect(agents.row('team-agent')!.heartbeat).toEqual({ enabled: true, intervalMinutes: 5, prompt: 'check in' });
    });
  });

  describe('an inbound webhook (the Webhook channel gateway)', () => {
    const SECRET = 'shared-secret';
    let events: ReturnType<typeof fakeRepository<any>>;

    const gatewayRow = (scope: Partial<Gateway>) =>
      Object.assign(new Gateway(), {
        id: 'gw-hook',
        organizationId: CAST.org,
        type: GatewayType.WEBHOOK,
        status: GatewayStatus.ACTIVE,
        agentId: 'team-agent',
        configuration: { secret: SECRET },
        visibility: 'org',
        teamId: null,
        ownerUserId: CAST.member,
        ...scope,
      });

    async function deliver(gateway: Gateway, deliveryId: string) {
      events = fakeRepository<any>({ idPrefix: 'evt' });
      const service = new ChannelGatewayService(
        fakeRepository<any>([]) as any,
        runs as any,
        events as any,
        runtime,
        new ChatWidgetAdapter(null as any), new SlackAdapter(), new DiscordAdapter(), new TelegramAdapter(),
        new WhatsAppAdapter(), new WhatsAppCloudAdapter(), new SmsAdapter(), new EmailAdapter(), new WebhookAdapter(),
        new GoogleChatAdapter(), new MicrosoftTeamsAdapter(), new SignalAdapter(), new MatrixAdapter(), new IrcAdapter(),
      );
      const body = { text: 'hello', deliveryId };
      const raw = JSON.stringify(body);
      const signature = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
      await service.handleInboundMessage(gateway, body, { 'x-webhook-signature': signature }, raw);
    }

    it('starts the team agent through a webhook gateway scoped to its team, in the gateway scope', async () => {
      await deliver(gatewayRow({ visibility: 'team', teamId: CAST.team }), 'd-1');
      const [run] = runs.rows();
      expect(run.agentId).toBe('team-agent');
      expect(run.principal).toMatchObject({ kind: 'gateway', gatewayId: 'gw-hook', teamId: CAST.team });
    });

    it.each([
      ['an org-wide webhook gateway', { visibility: 'org' as const }],
      ['a webhook gateway scoped to another team', { visibility: 'team' as const, teamId: CAST.otherTeam }],
    ])('refuses the team agent through %s, recording why on the delivery', async (_l, scope) => {
      await deliver(gatewayRow(scope), 'd-2');
      expect(runs.rows()).toHaveLength(0);
      expect(events.rows()[0]).toMatchObject({ direction: 'inbound', status: 'failed' });
      expect(events.rows()[0].errorMessage).toContain('run refused');
    });

    it('serves an org agent through any webhook gateway of the org', async () => {
      await deliver(gatewayRow({ agentId: 'org-agent' }), 'd-3');
      expect(runs.rows().map((r) => r.agentId)).toEqual(['org-agent']);
    });
  });

  describe('an MCP gateway: tools/call', () => {
    let gateways: ReturnType<typeof fakeRepository<Gateway>>;
    let handler: McpToolHandler;

    beforeEach(() => {
      gateways = fakeRepository<Gateway>({
        seed: [
          { id: 'gw-org', organizationId: CAST.org, visibility: 'org', teamId: null, ownerUserId: CAST.member, isSystem: false },
          { id: 'gw-team', organizationId: CAST.org, visibility: 'team', teamId: CAST.team, ownerUserId: CAST.member, isSystem: false },
          { id: 'gw-other-team', organizationId: CAST.org, visibility: 'team', teamId: CAST.otherTeam, ownerUserId: CAST.nonMember, isSystem: false },
          { id: 'gw-private-member', organizationId: CAST.org, visibility: 'private', teamId: null, ownerUserId: CAST.member, isSystem: false },
          { id: 'gw-private-nonmember', organizationId: CAST.org, visibility: 'private', teamId: null, ownerUserId: CAST.nonMember, isSystem: false },
          { id: 'gw-private-owner', organizationId: CAST.org, visibility: 'private', teamId: null, ownerUserId: CAST.owner, isSystem: false },
          { id: 'gw-system', organizationId: CAST.org, visibility: 'org', teamId: null, ownerUserId: null, isSystem: true },
        ] as any,
        make: () => new Gateway(),
      });
      // Every tool attached to every gateway: what is under test here is the
      // scope rule, which has to hold even for a row that is attached (a row
      // from before the attach-time check, or a gateway re-scoped since).
      // Serving what is not attached at all is gateway-executes-only-
      // published-tools.spec.ts.
      for (const gateway of gateways.rows()) {
        for (const tool of tools.rows()) {
          gatewayTools.seed({ id: `${gateway.id}:${tool.id}`, gatewayId: gateway.id, toolId: tool.id, isActive: true, tool, gateway } as any);
        }
      }
      fakeManager([[Gateway, gateways], [GatewayTool, gatewayTools]]);
      const toolsService = {
        findByName: async (name: string, organizationId: string) =>
          tools.rows().find((t) => t.name === name && t.organizationId === organizationId) ?? null,
      };
      handler = new McpToolHandler(tools as any, gatewayTools as any, {} as any, toolsService as any, toolExecutor, {} as any);
    });

    const call = (name: string, gatewayId: string | undefined, userId?: string) =>
      handler.handleToolCall({ name, arguments: {} }, CAST.org, userId, gatewayId);

    it.each([
      ['the gateway scoped to its team (any caller its auth admits)', 'gw-team', undefined],
      ['a private gateway of a member of its team', 'gw-private-member', CAST.member],
    ])('serves a team tool through %s', async (_l, gw, owner) => {
      const result = await call('team-tool', gw, owner);
      expect(result.isError).toBe(false);
      expect(mockedAxios).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['an org-wide gateway', 'gw-org', undefined],
      ['another team\'s gateway', 'gw-other-team', undefined],
      // A private gateway is only ever reached authenticated as its owner.
      ['a private gateway of a non-member', 'gw-private-nonmember', CAST.nonMember],
    ])('refuses a team tool through %s with the not-found answer, off the network', async (_l, gw, owner) => {
      const refused = await call('team-tool', gw, owner).catch((e) => e);
      expect(refused).toMatchObject({ code: JsonRpcErrorCode.TOOL_NOT_FOUND, message: 'Tool not found: team-tool' });
      expect(mockedAxios).not.toHaveBeenCalled();
    });

    it('re-checks on every call: the private gateway stops serving the team tool once its owner leaves the team', async () => {
      expect((await call('team-tool', 'gw-private-member', CAST.member)).isError).toBe(false);
      m.leaveTeam(CAST.team, CAST.member);
      await expect(call('team-tool', 'gw-private-member', CAST.member)).rejects.toMatchObject({
        code: JsonRpcErrorCode.TOOL_NOT_FOUND,
        message: 'Tool not found: team-tool',
      });
    });

    it('serves a private tool only through a gateway private to its owner', async () => {
      expect((await call('private-tool', 'gw-private-owner', CAST.owner)).isError).toBe(false);
      await expect(call('private-tool', 'gw-private-member', CAST.member)).rejects.toMatchObject({
        message: 'Tool not found: private-tool',
      });
    });

    it('with no gateway (the org MCP endpoint) the caller\'s own scope decides: members and admins, not other teams', async () => {
      expect((await call('team-tool', undefined, CAST.member)).isError).toBe(false);
      expect((await call('team-tool', undefined, CAST.admin)).isError).toBe(false);
      await expect(call('team-tool', undefined, CAST.nonMember)).rejects.toMatchObject({
        code: JsonRpcErrorCode.TOOL_NOT_FOUND,
        message: 'Tool not found: team-tool',
      });
    });
  });
});
