import * as crypto from 'crypto';
import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentOpenAIStreamHelper } from '../modules/agents/agent-openai-stream.helper';
import { CompatAgentInvoker } from '../modules/agents/compat-agent-invoker.service';
import { AgentExecutionEngine } from '../modules/agents/agent-execution.engine';
import { AgentNodeExecutor } from '../modules/agents/agent-node-executor';
import { AgentTemplateResolver } from '../modules/agents/agent-template-resolver';
import { AgentsService } from '../modules/agents/agents.service';
import { AgentRuntimeService } from '../modules/agents/agent-runtime.service';
import { ExecutionAccessService } from '../common/authorization/execution-access.service';
import { LlmProvidersService } from '../modules/llm-providers/llm-providers.service';
import { Agent, AgentStatus } from '../entities/agent.entity';
import { AgentExecution } from '../entities/agent-execution.entity';
import { AgentRun, AgentRunStatus } from '../entities/agent-run.entity';
import { ApiKey } from '../entities/api-key.entity';
import { CAST, castFixture, MembershipFixture } from './execution-access.fixture';
import { fakeRepository } from './fake-repository';
import { listenOnLoopback } from './http';

/**
 * The /v1 compat surfaces as an SDK sees them: a Nest app on loopback with
 * the real controllers, the real invocation path, the real pipeline engine
 * and node executor, the key policy and the execution gate. Only the model,
 * the autonomous runtime's worker and the tables are fakes.
 *
 * The model answers `saw: <what the prompt said>`, so an assertion reads
 * back what the agent was actually handed. Its streaming call emits that
 * answer word by word, and can be held after the first word until the test
 * lets it go: a client that has the first word while the model is still
 * held received it before the run finished, however slow the machine is.
 */

export const compatToken = (name: string) => `almyty_sdk_${name}_key`;
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export const ID = {
  echo: '0d000000-0000-4000-8000-000000000001',
  team: '0d000000-0000-4000-8000-000000000002',
  private: '0d000000-0000-4000-8000-000000000003',
  draft: '0d000000-0000-4000-8000-000000000004',
  otherOrg: '0d000000-0000-4000-8000-000000000005',
  auto: '0d000000-0000-4000-8000-000000000006',
  twoStep: '0d000000-0000-4000-8000-000000000007',
  mapped: '0d000000-0000-4000-8000-000000000008',
} as const;

const pos = { x: 0, y: 0 };
export const llmPipeline = () => ({
  nodes: [
    { id: 'in', type: 'input', label: 'in', position: pos, data: {} },
    { id: 'llm', type: 'llm_call', label: 'llm', position: pos, data: { providerId: 'p1', userPromptTemplate: '{{input.message}}' } },
    { id: 'out', type: 'output', label: 'out', position: pos, data: { mapping: '{{nodes.llm.output}}' } as Record<string, any> },
  ],
  edges: [
    { id: 'e1', source: 'in', target: 'llm' },
    { id: 'e2', source: 'llm', target: 'out' },
  ],
});
/** A draft step and a final step: only the final one is the answer. */
export const twoStepPipeline = () => ({
  nodes: [
    { id: 'in', type: 'input', label: 'in', position: pos, data: {} },
    { id: 'draft', type: 'llm_call', label: 'draft', position: pos, data: { providerId: 'p1', userPromptTemplate: 'draft {{input.message}}' } },
    { id: 'final', type: 'llm_call', label: 'final', position: pos, data: { providerId: 'p1', userPromptTemplate: 'polish {{nodes.draft.output}}' } },
    { id: 'out', type: 'output', label: 'out', position: pos, data: { mapping: '{{nodes.final.output}}' } },
  ],
  edges: [
    { id: 'e1', source: 'in', target: 'draft' },
    { id: 'e2', source: 'draft', target: 'final' },
    { id: 'e3', source: 'final', target: 'out' },
  ],
});
/** The output node wraps the model's text, so the model's tokens are not the answer. */
export const mappedPipeline = () => {
  const pipeline = llmPipeline();
  pipeline.nodes[2].data.mapping = 'Answer: {{nodes.llm.output}}';
  return pipeline;
};

const agentRow = (id: string, name: string, extra: Partial<Agent> = {}) =>
  Object.assign(new Agent(), {
    id,
    name,
    organizationId: CAST.org,
    status: AgentStatus.ACTIVE,
    mode: 'workflow',
    visibility: 'org',
    teamId: null,
    createdBy: CAST.member,
    settings: {},
    isTemporary: false,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    pipeline: llmPipeline(),
    ...extra,
  });

const AGENTS = () => [
  agentRow(ID.echo, 'Echo Agent'),
  agentRow(ID.team, 'Team Agent', { visibility: 'team', teamId: CAST.team }),
  agentRow(ID.private, 'Private Agent', { visibility: 'private', createdBy: CAST.owner }),
  agentRow(ID.draft, 'Draft Agent', { status: AgentStatus.DRAFT }),
  agentRow(ID.otherOrg, 'Elsewhere Agent', { organizationId: CAST.otherOrg }),
  agentRow(ID.auto, 'Auto Agent', { mode: 'autonomous', pipeline: undefined as any }),
  agentRow(ID.twoStep, 'Two Step Agent', { pipeline: twoStepPipeline() }),
  agentRow(ID.mapped, 'Mapped Agent', { pipeline: mappedPipeline() as any }),
];

const member = (userId: string, organizationId: string = CAST.org) => ({
  id: userId,
  isActive: true,
  organizationMemberships: [{ organizationId, isActive: true, inviteAccepted: true, inviteToken: null }],
});
export const keyRow = (name: string, userId: string, extra: Partial<ApiKey> = {}) => ({
  id: `key-${name}`,
  name,
  keyHash: hash(compatToken(name)),
  keyPrefix: 'almyty_s',
  userId,
  user: member(userId),
  organizationId: CAST.org,
  gatewayId: null,
  agentId: null,
  isActive: true,
  expiresAt: null,
  lastUsedAt: null,
  scopes: null,
  ...extra,
});
const KEYS = () => [
  keyRow('member', CAST.member),
  keyRow('nonmember', CAST.nonMember),
  keyRow('owner', CAST.owner),
  keyRow('onlyecho', CAST.nonMember, { agentId: ID.echo }),
  keyRow('gateway', CAST.member, { gatewayId: 'gw-1' }),
  keyRow('scoped', CAST.member, { scopes: ['read'] }),
  keyRow('elsewhere', 'someone-else', { organizationId: CAST.otherOrg, user: member('someone-else', CAST.otherOrg) as any }),
];

/** How long a held model waits for the test before giving up and finishing anyway. */
export const HOLD_FALLBACK_MS = 3_000;
/** The pause between two streamed words. */
const TOKEN_GAP_MS = 20;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A promise the test opens; it opens by itself after HOLD_FALLBACK_MS so a red run still ends. */
export function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, HOLD_FALLBACK_MS).unref?.();
  });
  return { opened, release };
}

/** Words with their separating spaces kept, so they concatenate back to the text. */
export const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? [];

/** The model: echoes its prompt, reports a real split, records the request. */
export function fakeLlm() {
  const calls: Array<{ providerId: string; request: any; streamed: boolean }> = [];
  let hold: ReturnType<typeof gate> | null = null;
  const state = { finished: false };
  const answer = (request: any) => {
    const user = [...request.messages].reverse().find((m: any) => m.role === 'user');
    return `saw: ${user?.content ?? ''}`;
  };
  const response = (content: string) => ({
    message: { role: 'assistant', content },
    usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
    cost: 0,
  });
  return {
    calls,
    state,
    /** Hold the next answer after its first word, until `release()`. */
    holdAfterFirstToken() {
      hold = gate();
      return hold;
    },
    chat: jest.fn(async (providerId: string, request: any) => {
      calls.push({ providerId, request, streamed: false });
      const held = hold;
      hold = null;
      // A held model that is not streamed still takes as long to answer.
      if (held) await held.opened;
      state.finished = true;
      return response(answer(request));
    }),
    chatStream: jest.fn(async (providerId: string, request: any, _org: string, _caller: any, onChunk?: (chunk: any) => void) => {
      calls.push({ providerId, request, streamed: !!onChunk });
      const text = answer(request);
      state.finished = false;
      const held = hold;
      hold = null;
      const parts = words(text);
      for (let i = 0; i < parts.length; i++) {
        onChunk?.({ content: parts[i] });
        if (i === 0 && held) await held.opened;
        else await sleep(TOKEN_GAP_MS);
      }
      state.finished = true;
      return response(text);
    }),
  };
}
export type FakeLlm = ReturnType<typeof fakeLlm>;

type RunEvent = { type: string; data: any; timestamp: string };

/**
 * The autonomous runtime, as far as a compat route can see it: a run row
 * that the "worker" moves a tick later, and the run's event stream. With
 * `streamAnswer()`, the worker writes its answer the way a composed final
 * answer does (a working step, then llm.started answer:true, llm.chunk per
 * word, llm.response), held after the first word until the test releases it.
 */
export function fakeRuntime(runs: ReturnType<typeof fakeRepository<AgentRun>>) {
  const started: Array<{ agentId: string; input: any; options: any }> = [];
  const events = new Map<string, RunEvent[]>();
  const listeners = new Map<string, Array<(e: RunEvent) => void>>();
  const emit = (runId: string, type: string, data: any = {}) => {
    const event = { type, data, timestamp: new Date().toISOString() };
    events.set(runId, [...(events.get(runId) ?? []), event]);
    for (const listener of listeners.get(runId) ?? []) listener(event);
  };
  let nextRun: (run: AgentRun) => Partial<AgentRun> = (run) => ({
    status: AgentRunStatus.COMPLETED,
    output: `autonomous saw: ${run.input}`,
    totalTokens: 42,
  });
  let script: ReturnType<typeof gate> | null = null;
  const state = { finished: false };

  const finish = async (runId: string) => {
    const current = runs.row(runId)!;
    if (current.status !== AgentRunStatus.RUNNING) return;
    const next = nextRun(current);
    await runs.save(Object.assign(current, next));
    state.finished = true;
    if (next.status === AgentRunStatus.COMPLETED) emit(runId, 'run.completed', {});
    if (next.status === AgentRunStatus.FAILED) emit(runId, 'run.failed', {});
  };

  return {
    started,
    state,
    finishWith(fn: (run: AgentRun) => Partial<AgentRun>) {
      nextRun = fn;
    },
    /** Stream the next run's answer word by word, held after the first word until `release()`. */
    streamAnswer() {
      script = gate();
      return script;
    },
    startRun: jest.fn(async (agentId: string, organizationId: string, userId: string | null, input: any, options: any) => {
      started.push({ agentId, input, options });
      state.finished = false;
      const run = await runs.save(Object.assign(new AgentRun(), {
        agentId, organizationId, userId, input, status: AgentRunStatus.RUNNING, metadata: options?.metadata ?? {}, totalTokens: 0,
      }));
      const held = script;
      script = null;
      if (!held) {
        setTimeout(() => void finish(run.id), 30);
        return run;
      }
      void (async () => {
        await sleep(10);
        const text = `autonomous saw: ${input}`;
        emit(run.id, 'llm.started', { step: 1, answer: false });
        emit(run.id, 'llm.chunk', { step: 1, content: 'let me look that up' });
        emit(run.id, 'llm.response', { step: 1, content: 'let me look that up', toolCalls: [] });
        emit(run.id, 'llm.started', { step: 2, answer: true });
        const parts = words(text);
        for (let i = 0; i < parts.length; i++) {
          emit(run.id, 'llm.chunk', { step: 2, content: parts[i] });
          if (i === 0) await held.opened;
          else await sleep(TOKEN_GAP_MS);
        }
        emit(run.id, 'llm.response', { step: 2, content: text, answer: true });
        await finish(run.id);
      })();
      return run;
    }),
    getRun: jest.fn(async (runId: string) => runs.row(runId)),
    cancelRun: jest.fn(async (runId: string) => {
      const run = runs.row(runId)!;
      run.status = AgentRunStatus.CANCELLED;
      await runs.save(run);
      emit(runId, 'run.cancelled', {});
      return run;
    }),
    subscribeRunEvents: jest.fn(async (runId: string, handler: (e: RunEvent) => void, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => {
        const listener = (event: RunEvent) => {
          handler(event);
          if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) done();
        };
        const done = () => {
          listeners.set(runId, (listeners.get(runId) ?? []).filter((l) => l !== listener));
          resolve();
        };
        for (const event of events.get(runId) ?? []) listener(event);
        listeners.set(runId, [...(listeners.get(runId) ?? []), listener]);
        signal?.addEventListener('abort', done, { once: true });
      });
    }),
  };
}
export type FakeRuntime = ReturnType<typeof fakeRuntime>;

export interface CompatApp {
  app: INestApplication;
  origin: string;
  llm: FakeLlm;
  runtime: FakeRuntime;
  runs: ReturnType<typeof fakeRepository<AgentRun>>;
  apiKeys: ReturnType<typeof fakeRepository<ApiKey>>;
  agentsService: any;
  budgets: { enforceForRun: jest.Mock };
  membership: MembershipFixture;
}

/** The named compat controllers, on loopback, over the fakes above. */
export async function startCompatApp(controllers: Type<unknown>[]): Promise<CompatApp> {
  const membership = castFixture();
  const llm = fakeLlm();
  const agents = fakeRepository<Agent>({ seed: AGENTS(), make: () => new Agent() });
  const executions = fakeRepository<AgentExecution>({ make: () => new AgentExecution(), idPrefix: 'exec' });
  const apiKeys = fakeRepository<ApiKey>({ seed: KEYS() as any, make: () => new ApiKey() });
  const runs = fakeRepository<AgentRun>({ make: () => new AgentRun(), idPrefix: 'run' });
  const runtime = fakeRuntime(runs);
  const budgets = { enforceForRun: jest.fn().mockResolvedValue(undefined) };

  const state = {
    emitEvent: (onEvent: any, event: any) => onEvent?.(event),
    bumpAgentStats: jest.fn().mockResolvedValue(undefined),
    withTimeout: (promise: Promise<unknown>) => promise,
  };
  const engine = new AgentExecutionEngine(
    agents as any,
    executions as any,
    null as any,
    { sendExecutionWebhook: jest.fn().mockResolvedValue(undefined) } as any,
    state as any,
    undefined, undefined, undefined, undefined,
    budgets as any,
    undefined,
    membership.executionAccess,
  );
  const nodes = new AgentNodeExecutor(
    new AgentTemplateResolver(), llm as unknown as LlmProvidersService, {} as any, agents as any, engine,
    {} as any, {} as any, {} as any, {} as any,
  );
  (engine as any).nodeExecutor = nodes;

  // The real read rules (getAgent, findAllActive) over the fake table;
  // only the by-name query builder is re-stated, with the same predicate.
  const agentsService: any = Object.create(AgentsService.prototype);
  Object.assign(agentsService, { agentRepository: agents, accessPolicy: membership.accessPolicy });
  agentsService.findByName = async (name: string, organizationId: string, callerId?: string | null) => {
    const rows = await agents.find({ where: { organizationId } });
    const mine = (a: Agent) => a.visibility !== 'private' || a.createdBy === (callerId ?? null);
    const lower = name.toLowerCase();
    return (
      rows.find((a) => a.name === name && mine(a)) ??
      rows.find((a) => a.name.toLowerCase() === lower && mine(a)) ??
      rows.find((a) => a.name.toLowerCase() === lower.replace(/-/g, ' ') && mine(a)) ??
      null
    );
  };

  const moduleRef = await Test.createTestingModule({
    controllers,
    providers: [
      CompatAgentInvoker,
      AgentOpenAIStreamHelper,
      { provide: AgentExecutionEngine, useValue: engine },
      { provide: AgentsService, useValue: agentsService },
      { provide: AgentRuntimeService, useValue: runtime },
      { provide: ExecutionAccessService, useValue: membership.executionAccess },
      { provide: getRepositoryToken(ApiKey), useValue: apiKeys },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await listenOnLoopback(app);
  const { port } = app.getHttpServer().address();
  return { app, origin: `http://127.0.0.1:${port}`, llm, runtime, runs, apiKeys, agentsService, budgets, membership };
}
