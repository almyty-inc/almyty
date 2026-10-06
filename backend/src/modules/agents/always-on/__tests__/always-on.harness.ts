/**
 * A truthful in-memory world for AlwaysOnService specs: the real service,
 * the real execution gate (membershipFixture), fake repositories that
 * compare-and-set like Postgres, a queue that keeps repeatable jobs and
 * added jobs, and a Redis that honours NX and PX.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 */
import { EventEmitter } from 'events';

import { AgentRun, AgentRunStatus } from '../../../../entities/agent-run.entity';
import { AgentWake } from '../../../../entities/agent-wake.entity';
import { fakeRepository, FakeRepository } from '../../../../test/fake-repository';
import { membershipFixture } from '../../../../test/execution-access.fixture';
import { AlwaysOnService } from '../always-on.service';
import { SCHEDULED_RESULT_POSTER } from '../../scheduled-result-poster';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OWNER = '22222222-2222-4222-8222-222222222222';
export const AGENT = '33333333-3333-4333-8333-333333333333';
export const SLACK = '44444444-4444-4444-8444-444444444444';
export const HOOK = '55555555-5555-4555-8555-555555555555';
export const GW_SLACK = '66666666-6666-4666-8666-666666666666';
export const GW_HOOK = '77777777-7777-4777-8777-777777777777';
export const TOOL_READ = '88888888-8888-4888-8888-888888888888';
export const TOOL_WRITE = '99999999-9999-4999-8999-999999999999';

export function fakeQueue() {
  const repeatable: Array<{ key: string; name: string; id: string; every: number; next: number }> = [];
  const added: Array<{ name: string; data: any; opts: any }> = [];
  return {
    repeatable,
    added,
    add: jest.fn(async (name: string, data: any, opts: any = {}) => {
      if (opts.repeat) {
        repeatable.push({ key: `${name}:${opts.jobId}:${opts.repeat.every}`, name, id: opts.jobId, every: opts.repeat.every, next: Date.now() + opts.repeat.every });
      } else {
        added.push({ name, data, opts });
      }
      return { id: opts.jobId };
    }),
    getRepeatableJobs: jest.fn(async () => repeatable.map((r) => ({ ...r }))),
    removeRepeatableByKey: jest.fn(async (key: string) => {
      const i = repeatable.findIndex((r) => r.key === key);
      if (i >= 0) repeatable.splice(i, 1);
    }),
  };
}

export function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (key: string, value: string, ..._args: any[]) => {
      const nx = _args.includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

export interface World {
  service: AlwaysOnService;
  agents: FakeRepository<any>;
  wakes: FakeRepository<any>;
  runs: FakeRepository<any>;
  channels: FakeRepository<any>;
  organizations: FakeRepository<any>;
  tools: FakeRepository<any>;
  messages: FakeRepository<any>;
  grants: FakeRepository<any>;
  queue: ReturnType<typeof fakeQueue>;
  redis: ReturnType<typeof fakeRedis>;
  startRun: jest.Mock;
  sendInput: jest.Mock;
  approvals: EventEmitter;
  posted: Array<{ delivery: any; text: string }>;
  notified: any[];
  audited: any[];
  membership: ReturnType<typeof membershipFixture>;
}

export function alwaysOnAgent(overrides: Record<string, any> = {}, alwaysOn: Record<string, any> = {}) {
  return {
    id: AGENT,
    organizationId: ORG,
    name: 'Support agent',
    mode: 'autonomous',
    status: 'active',
    visibility: 'org',
    teamId: null,
    createdBy: OWNER,
    toolIds: [TOOL_READ, TOOL_WRITE],
    alwaysOn: {
      enabled: true,
      brief: 'Keep the refund queue empty.',
      wakeOn: { timer: { everyMinutes: 30 }, channelIds: [SLACK, HOOK], connectionEvents: ['expiring'] },
      ownerChannel: { channelId: SLACK, address: 'U-OWNER' },
      actMode: 'propose',
      askFirstToolIds: [],
      reportTo: null,
      report: 'when_acted',
      ...alwaysOn,
    },
    ...overrides,
  };
}

export function world(options: { plan?: string; agent?: Record<string, any> | null; ownerIsMember?: boolean } = {}): World {
  const agents = fakeRepository<any>(options.agent === null ? [] : [options.agent ?? alwaysOnAgent()]);
  const wakes = fakeRepository<any>({ make: () => new AgentWake(), idPrefix: 'wake' });
  const runs = fakeRepository<any>({ make: () => new AgentRun(), idPrefix: 'run' });
  const channels = fakeRepository<any>([
    { id: SLACK, organizationId: ORG, agentId: AGENT, type: 'slack', name: 'Support Slack', gatewayId: GW_SLACK },
    { id: HOOK, organizationId: ORG, agentId: AGENT, type: 'webhook', name: 'GitHub', gatewayId: GW_HOOK },
  ]);
  const organizations = fakeRepository<any>([{ id: ORG, plan: options.plan ?? 'free', settings: {} }]);
  const tools = fakeRepository<any>([
    { id: TOOL_READ, organizationId: ORG, name: 'list_refunds', sideEffect: 'read' },
    { id: TOOL_WRITE, organizationId: ORG, name: 'issue_refund', sideEffect: 'write' },
  ]);
  const messages = fakeRepository<any>({ idPrefix: 'msg' });
  const grants = fakeRepository<any>([]);
  const queue = fakeQueue();
  const redis = fakeRedis();
  const membership = membershipFixture();
  if (options.ownerIsMember !== false) membership.member(ORG, OWNER);
  const approvals = new EventEmitter();

  let runSeq = 0;
  const startRun = jest.fn(async (agentId: string, organizationId: string, userId: string | null, input: any, opts: any = {}) => {
    const id = `run-${++runSeq}`;
    const conversationId = opts.conversationId ?? `conv-${runSeq}`;
    runs.seed({ id, agentId, organizationId, userId, input, status: AgentRunStatus.RUNNING, conversationId, metadata: opts.metadata ?? {}, steps: [], createdAt: new Date() });
    const run = runs.row(id)!;
    return run;
  });
  const sendInput = jest.fn(async (runId: string) => {
    await runs.update({ id: runId }, { status: AgentRunStatus.RUNNING });
    return runs.row(runId);
  });

  const posted: Array<{ delivery: any; text: string }> = [];
  const poster = {
    destinations: jest.fn(async () => []),
    checkDestination: jest.fn(async (_agent: any, d: any) => d),
    admit: jest.fn(async () => ({ ok: true })),
    post: jest.fn(async (_agent: any, result: any, delivery: any) => {
      posted.push({ delivery, text: typeof result.output === 'string' ? result.output : JSON.stringify(result.output) });
      // Recorded on the run, as ScheduledPostService.record does: the result's metadata plus the outcome.
      if (result.kind === 'run') await runs.update({ id: result.id }, { metadata: { ...(result.metadata ?? {}), channelDelivery: { status: 'delivered', channelId: delivery.channelId } } });
      return { status: 'delivered', channelId: delivery.channelId, at: new Date().toISOString() };
    }),
  };
  const moduleRef = {
    get: jest.fn((token: any) => {
      if (token === SCHEDULED_RESULT_POSTER) return poster;
      throw new Error('not provided');
    }),
  };
  const notified: any[] = [];
  const notifications = { emit: jest.fn(async (n: any) => notified.push(n)) };
  const audited: any[] = [];
  const audit = { log: jest.fn(async (row: any) => audited.push(row)) };

  const runtime = { startRun, sendInput, executionAccess: membership.executionAccess, approvals };
  const service = new AlwaysOnService(
    agents as any,
    wakes as any,
    runs as any,
    channels as any,
    organizations as any,
    tools as any,
    messages as any,
    grants as any,
    queue as any,
    redis as any,
    runtime as any,
    moduleRef as any,
    notifications as any,
    audit as any,
  );
  return { service, agents, wakes, runs, channels, organizations, tools, messages, grants, queue, redis, startRun, sendInput, approvals, posted, notified, audited, membership };
}

/** Finish a run the way the step processor leaves one. */
export async function finishRun(w: World, runId: string, patch: Record<string, any> = {}) {
  await w.runs.update({ id: runId }, { status: AgentRunStatus.COMPLETED, output: 'Done.', ...patch });
}
