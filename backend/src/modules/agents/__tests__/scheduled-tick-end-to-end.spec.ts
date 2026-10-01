jest.mock('../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));

import { AgentSchedulerService } from '../agent-scheduler.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentSubAgentExecutors } from '../agent-subagent-executors.helper';
import { AgentTemplateResolver } from '../agent-template-resolver';
import { SCHEDULED_RESULT_POSTER } from '../scheduled-result-poster';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution, AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import { AgentRunStatus } from '../../../entities/agent-run.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { AgentChannel, ChannelStatus, ChannelType } from '../../../entities/agent-channel.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { ScheduledPostService } from '../../gateways/channels/scheduled-post.service';
import { ChannelGatewayService } from '../../gateways/channels/channel-gateway.service';
import { SlackAdapter } from '../../gateways/channels/adapters/slack.adapter';
import { installFetchMock, parseSentJson } from '../../gateways/channels/adapters/__tests__/test-helpers';
import { anthropicText, runAgent } from './autonomous-harness';

/**
 * A scheduled tick, end to end, for both kinds of agent: the scheduler
 * fires, the agent runs on the engine that owns it, and its result is
 * posted to the Slack channel the schedule chose, through the real Slack
 * adapter (only the network faked).
 *
 * The autonomous case is the one that was broken: the scheduler sent every
 * agent to the workflow engine, which ran an autonomous agent's empty
 * pipeline, finished at once with no output, and posted nothing. Here the
 * autonomous agent runs on the autonomous runtime -- the real step
 * processor, with the model's reply faked on the wire -- and what the model
 * wrote is what lands in Slack.
 */
describe('a scheduled tick, end to end', () => {
  const OWNER = '11111111-1111-4111-8111-000000000001';
  const MODEL = 'claude-sonnet-5';
  let fetchMock: ReturnType<typeof installFetchMock>;

  const deliverTo = { kind: 'channel', channelId: 'ch-slack', to: 'C0123SALES', label: '#sales' };

  const build = (agent: Record<string, any>) => {
    const access = membershipFixture();
    access.member('org-1', OWNER);
    access.member('org-1', 'u-1');
    const agents = fakeRepository<Agent>({ make: () => new Agent(), seed: [agent as any] });
    const executions = fakeRepository<AgentExecution>({ make: () => new AgentExecution(), idPrefix: 'exec' });
    const users = fakeRepository<any>([
      { id: OWNER, isActive: true, organizationMemberships: [{ organizationId: 'org-1', role: 'member', isActive: true }] },
    ]);

    // The Slack channel the result goes to, and the real poster behind it.
    const gateways = fakeRepository<any>([
      Object.assign(new Gateway(), {
        id: 'gw-slack', type: GatewayType.SLACK, status: GatewayStatus.ACTIVE, visibility: 'org',
        agentId: agent.id, organizationId: 'org-1', configuration: { bot_token: 'xoxb-1' },
      }),
    ]);
    const channels = fakeRepository<any>([
      Object.assign(new AgentChannel(), {
        id: 'ch-slack', agentId: agent.id, organizationId: 'org-1', type: ChannelType.SLACK, name: 'Sales Slack',
        status: ChannelStatus.LIVE, gatewayId: 'gw-slack', createdAt: new Date(),
      }),
    ]);
    const slack = new SlackAdapter();
    const channelGateway = new ChannelGatewayService(
      gateways as any, fakeRepository<any>([]) as any, fakeRepository<any>([]) as any, {} as any,
      {} as any, slack, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    // The autonomous run's row lives in the harness's run table, set once the run exists.
    const runs: { repo: any } = { repo: null };
    const runRepo = new Proxy({}, { get: (_t, key) => (runs.repo as any)[key] });
    const poster = new ScheduledPostService(
      channels as any, gateways as any, executions as any, channelGateway, slack, undefined, undefined, runRepo as any,
    );

    // The workflow engine, real, as the scheduler reaches it.
    const engine = new AgentExecutionEngine(
      agents as any, executions as any, null as any,
      { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } as any,
      { emitEvent: jest.fn(), bumpAgentStats: jest.fn().mockResolvedValue(undefined), withTimeout: (p: Promise<unknown>) => p } as any,
      undefined, undefined, undefined, undefined, undefined, undefined,
      access.executionAccess,
    );
    const resolver = new AgentTemplateResolver();
    const subAgents = new AgentSubAgentExecutors(resolver, agents as any, engine, {} as any, {} as any);
    (engine as any).nodeExecutor = new AgentNodeExecutor(resolver, {} as any, {} as any, agents as any, engine, {} as any, {} as any, subAgents, {} as any);
    const engineSpy = jest.spyOn(engine, 'execute');

    // The autonomous runtime: startRun creates the run and the real step
    // processor drives it to the end (autonomous-harness), the model's
    // reply faked on the wire; then the runtime's processor hands the
    // finished run to the scheduler, as AgentRuntimeProcessor does.
    const started: any[] = [];
    let scheduler: AgentSchedulerService;
    const runtime = {
      startRun: jest.fn(async (_agentId: string, _org: string, userId: string | null, task: string, options: any) => {
        started.push({ task, options });
        const result = await runAgent({
          models: null,
          members: [OWNER],
          agent: { ...agent, toolIds: [] },
          userMessage: task,
          run: { userId, metadata: options.metadata, principal: options.principal },
          streams: { [MODEL]: [anthropicText(MODEL, 90, ['Sales were up 4% yesterday. ', 'Returns fell.'], 14)] },
        });
        runs.repo = result.runRepository;
        await scheduler.deliverScheduledRun(result.run.id);
        return result.run;
      }),
    };

    const moduleRef = { get: (token: unknown) => (token === SCHEDULED_RESULT_POSTER ? poster : null) };
    scheduler = new AgentSchedulerService(
      { getAgent: async (id: string) => agents.row(id) } as any,
      engine,
      agents as any,
      { add: jest.fn(), getRepeatableJobs: jest.fn(async () => []), removeRepeatableByKey: jest.fn() } as any,
      access.executionAccess,
      executions as any,
      users as any,
      moduleRef as any,
      undefined,
      runtime as any,
      runRepo as any,
    );
    return { scheduler, engineSpy, runtime, started, executions, runs };
  };

  const schedule = { enabled: true, kind: 'days', time: '08:00', days: [1, 2, 3, 4, 5], timezone: 'Europe/Berlin', input: {}, deliverTo };
  const tick = (scheduler: AgentSchedulerService, agentId: string) =>
    scheduler.handleScheduledExecution({ data: { agentId, organizationId: 'org-1', input: schedule.input } } as any);

  beforeEach(() => {
    fetchMock = installFetchMock();
    fetchMock.setNextResponse({ ok: true, status: 200, json: { ok: true } });
  });
  afterEach(() => fetchMock.restore());

  it('an autonomous agent runs on the autonomous runtime, and what it wrote is posted to Slack', async () => {
    const agent = {
      id: 'agent-1', name: 'Acme support', organizationId: 'org-1', status: AgentStatus.ACTIVE, mode: 'autonomous',
      visibility: 'org', createdBy: OWNER, instructions: 'Summarise yesterday.',
      modelConfig: { providerId: 'p-strong', model: MODEL, temperature: 0.2, maxTokens: 800 },
      settings: { schedule: { ...schedule, input: { message: 'Write the morning sales summary.' } } },
      pipeline: { nodes: [], edges: [] },
    };
    const { scheduler, engineSpy, runtime, started, runs } = build(agent);
    await scheduler.handleScheduledExecution({
      data: { agentId: 'agent-1', organizationId: 'org-1', input: { message: 'Write the morning sales summary.' } },
    } as any);

    expect(engineSpy).not.toHaveBeenCalled();
    expect(runtime.startRun).toHaveBeenCalledTimes(1);
    expect(started[0].task).toBe('Write the morning sales summary.');
    expect(started[0].options.metadata).toMatchObject({ triggerType: 'scheduled', scheduledDelivery: deliverTo });

    const run = runs.repo.row('run-1');
    expect([run.status, run.error]).toEqual([AgentRunStatus.COMPLETED, undefined]);
    expect(run.output).toBe('Sales were up 4% yesterday. Returns fell.');

    const posts = fetchMock.calls.filter((c) => c.url === 'https://slack.com/api/chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(parseSentJson(posts[0])).toMatchObject({ channel: 'C0123SALES', text: 'Sales were up 4% yesterday. Returns fell.' });
    expect(run.metadata.channelDelivery).toMatchObject({ status: 'delivered', channelId: 'ch-slack', destination: '#sales' });

    // A second report of the same finished run posts nothing more.
    await scheduler.deliverScheduledRun('run-1');
    expect(fetchMock.calls.filter((c) => c.url === 'https://slack.com/api/chat.postMessage')).toHaveLength(1);
  });

  it('a workflow agent runs on the workflow engine, and its result is posted to Slack', async () => {
    const agent = {
      id: 'agent-2', name: 'Sales digest', organizationId: 'org-1', status: AgentStatus.ACTIVE, mode: 'workflow',
      visibility: 'org', createdBy: OWNER, settings: { schedule },
      pipeline: {
        nodes: [{ id: 'out', type: 'output', label: 'Output', position: { x: 0, y: 0 }, data: { mapping: 'Orders shipped: 42.' } }],
        edges: [],
      },
    };
    const { scheduler, engineSpy, runtime, executions } = build(agent);
    await tick(scheduler, 'agent-2');

    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(engineSpy).toHaveBeenCalledTimes(1);
    const [execution] = executions.rows();
    expect(execution.status).toBe(AgentExecutionStatus.COMPLETED);
    const posts = fetchMock.calls.filter((c) => c.url === 'https://slack.com/api/chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(parseSentJson(posts[0])).toMatchObject({ channel: 'C0123SALES', text: 'Orders shipped: 42.' });
    expect(execution.metadata.channelDelivery).toMatchObject({ status: 'delivered' });
  });
});
