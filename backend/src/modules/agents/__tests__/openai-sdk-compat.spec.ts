import 'reflect-metadata';
import * as crypto from 'crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import OpenAI from 'openai';

import { AgentOpenAICompatController } from '../agent-openai-compat.controller';
import { AgentOpenAIStreamHelper } from '../agent-openai-stream.helper';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentNodeExecutor } from '../agent-node-executor';
import { AgentTemplateResolver } from '../agent-template-resolver';
import { AgentsService } from '../agents.service';
import { AgentRuntimeService } from '../agent-runtime.service';
import { COMPAT_RATE_LIMIT_RPM } from '../compat-rate-limit.helper';
import { ExecutionAccessService } from '../../../common/authorization/execution-access.service';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { AgentExecution } from '../../../entities/agent-execution.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { ApiKey } from '../../../entities/api-key.entity';
import { BudgetExceededException } from '../../budgets/budget-exceeded.exception';
import { CAST, castFixture, MembershipFixture } from '../../../test/execution-access.fixture';
import { fakeRepository } from '../../../test/fake-repository';
import { listenOnLoopback } from '../../../test/http';

/**
 * The OpenAI-compatible surface, driven by the official `openai` SDK.
 *
 * Everything below the HTTP socket is real except the model and the tables:
 * the controller, the stream helper, the pipeline engine and its node
 * executor, the key policy and the execution gate. The model is a fake
 * LlmProvidersService that answers `saw: <what the prompt said>`, so every
 * assertion reads back what the agent was actually handed.
 *
 * The earlier compat specs call controller methods with hand-built req/res
 * doubles, which is how the stream could repeat the answer once per node
 * and still pass: nothing parsed it the way a client does.
 */

const token = (name: string) => `almyty_sdk_${name}_key`;
const hash = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

const ID = {
  echo: '0d000000-0000-4000-8000-000000000001',
  team: '0d000000-0000-4000-8000-000000000002',
  private: '0d000000-0000-4000-8000-000000000003',
  draft: '0d000000-0000-4000-8000-000000000004',
  otherOrg: '0d000000-0000-4000-8000-000000000005',
  auto: '0d000000-0000-4000-8000-000000000006',
  twoStep: '0d000000-0000-4000-8000-000000000007',
} as const;

const pos = { x: 0, y: 0 };
const llmPipeline = () => ({
  nodes: [
    { id: 'in', type: 'input', label: 'in', position: pos, data: {} },
    { id: 'llm', type: 'llm_call', label: 'llm', position: pos, data: { providerId: 'p1', userPromptTemplate: '{{input.message}}' } },
    { id: 'out', type: 'output', label: 'out', position: pos, data: { mapping: '{{nodes.llm.output}}' } },
  ],
  edges: [
    { id: 'e1', source: 'in', target: 'llm' },
    { id: 'e2', source: 'llm', target: 'out' },
  ],
});
/** A draft step and a final step: only the final one is the answer. */
const twoStepPipeline = () => ({
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
];

const member = (userId: string, organizationId: string = CAST.org) => ({
  id: userId,
  isActive: true,
  organizationMemberships: [{ organizationId, isActive: true, inviteAccepted: true, inviteToken: null }],
});
const keyRow = (name: string, userId: string, extra: Partial<ApiKey> = {}) => ({
  id: `key-${name}`,
  name,
  keyHash: hash(token(name)),
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

/** The model: echoes its prompt, reports a real split, records the request. */
function fakeLlm() {
  const calls: Array<{ providerId: string; request: any }> = [];
  return {
    calls,
    chat: jest.fn(async (providerId: string, request: any) => {
      calls.push({ providerId, request });
      const user = [...request.messages].reverse().find((m: any) => m.role === 'user');
      return {
        message: { role: 'assistant', content: `saw: ${user?.content ?? ''}` },
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        cost: 0,
      };
    }),
  };
}

/**
 * The autonomous runtime, as far as the compat route can see it: a run row
 * that the "worker" moves on a tick later. `nextRun` decides what that is.
 */
function fakeRuntime(runs: ReturnType<typeof fakeRepository<AgentRun>>) {
  const started: Array<{ agentId: string; input: any; options: any }> = [];
  let nextRun: (run: AgentRun) => Partial<AgentRun> = (run) => ({
    status: AgentRunStatus.COMPLETED,
    output: `autonomous saw: ${run.input}`,
    totalTokens: 42,
  });
  return {
    started,
    finishWith(fn: (run: AgentRun) => Partial<AgentRun>) {
      nextRun = fn;
    },
    startRun: jest.fn(async (agentId: string, organizationId: string, userId: string | null, input: any, options: any) => {
      started.push({ agentId, input, options });
      const run = await runs.save(Object.assign(new AgentRun(), {
        agentId, organizationId, userId, input, status: AgentRunStatus.RUNNING, metadata: {}, totalTokens: 0,
      }));
      setTimeout(() => {
        const current = runs.row(run.id)!;
        if (current.status !== AgentRunStatus.RUNNING) return;
        void runs.save(Object.assign(current, nextRun(current)));
      }, 30);
      return run;
    }),
    getRun: jest.fn(async (runId: string) => runs.row(runId)),
    cancelRun: jest.fn(async (runId: string) => {
      const run = runs.row(runId)!;
      run.status = AgentRunStatus.CANCELLED;
      await runs.save(run);
      return run;
    }),
  };
}

describe('the official openai SDK against /v1', () => {
  let app: INestApplication;
  let baseURL: string;
  let llm: ReturnType<typeof fakeLlm>;
  let runtime: ReturnType<typeof fakeRuntime>;
  let runs: ReturnType<typeof fakeRepository<AgentRun>>;
  let m: MembershipFixture;
  let apiKeys: ReturnType<typeof fakeRepository<ApiKey>>;
  let agentsService: any;
  let budgets: { enforceForRun: jest.Mock };

  const client = (name = 'member', opts: Partial<ConstructorParameters<typeof OpenAI>[0]> = {}) =>
    new OpenAI({ apiKey: token(name), baseURL, maxRetries: 0, timeout: 20_000, ...opts });

  const ask = (content = 'hi', over: Record<string, any> = {}) =>
    client().chat.completions.create({
      model: `agent:${ID.echo}`,
      messages: [{ role: 'user', content }],
      ...over,
    } as any) as Promise<OpenAI.Chat.Completions.ChatCompletion>;

  /** The status and OpenAI error body a call failed with. */
  const failure = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        return { status: err.status, type: err.type, code: err.code, param: err.param, message: err.message, headers: err.headers };
      }
      throw err;
    }
    throw new Error('expected the call to fail');
  };

  beforeEach(async () => {
    m = castFixture();
    llm = fakeLlm();
    const agents = fakeRepository<Agent>({ seed: AGENTS(), make: () => new Agent() });
    const executions = fakeRepository<AgentExecution>({ make: () => new AgentExecution(), idPrefix: 'exec' });
    apiKeys = fakeRepository<ApiKey>({ seed: KEYS() as any, make: () => new ApiKey() });
    runs = fakeRepository<AgentRun>({ make: () => new AgentRun(), idPrefix: 'run' });
    runtime = fakeRuntime(runs);
    budgets = { enforceForRun: jest.fn().mockResolvedValue(undefined) };

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
      m.executionAccess,
    );
    const nodes = new AgentNodeExecutor(
      new AgentTemplateResolver(), llm as unknown as LlmProvidersService, {} as any, agents as any, engine,
      {} as any, {} as any, {} as any, {} as any,
    );
    (engine as any).nodeExecutor = nodes;

    // The real read rules (getAgent, findAllActive) over the fake table;
    // only the by-name query builder is re-stated, with the same predicate.
    agentsService = Object.create(AgentsService.prototype);
    Object.assign(agentsService, { agentRepository: agents, accessPolicy: m.accessPolicy });
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
      controllers: [AgentOpenAICompatController],
      providers: [
        AgentOpenAIStreamHelper,
        { provide: AgentExecutionEngine, useValue: engine },
        { provide: AgentsService, useValue: agentsService },
        { provide: AgentRuntimeService, useValue: runtime },
        { provide: ExecutionAccessService, useValue: m.executionAccess },
        { provide: getRepositoryToken(ApiKey), useValue: apiKeys },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await listenOnLoopback(app);
    const { port } = app.getHttpServer().address();
    baseURL = `http://127.0.0.1:${port}/v1`;
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('a chat completion', () => {
    it('comes back in the shape the SDK types it as', async () => {
      const completion = await ask('hi');

      expect(completion.object).toBe('chat.completion');
      expect(completion.id).toMatch(/^chatcmpl-/);
      expect(completion.model).toBe(`agent:${ID.echo}`);
      expect(completion.choices).toHaveLength(1);
      expect(completion.choices[0]).toMatchObject({
        index: 0,
        message: { role: 'assistant', content: 'saw: hi' },
        finish_reason: 'stop',
      });
      expect(completion.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    });

    it('addresses an agent by id, by agent:name, by bare name and by slug', async () => {
      for (const model of [ID.echo, 'agent:Echo Agent', 'Echo Agent', 'echo-agent']) {
        const completion = await ask('hi', { model });
        expect(completion.choices[0].message.content).toBe('saw: hi');
      }
    });

    it('hands the agent the whole conversation, system instruction included, not just the last line', async () => {
      await ask('ignored', {
        messages: [
          { role: 'system', content: 'Answer in French.' },
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: 'Four.' },
          { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }] },
        ],
      });

      const prompt = llm.calls[0].request.messages.find((msg: any) => msg.role === 'user').content;
      expect(prompt).toBe(
        '[system]\nAnswer in French.\n\n[user]\nWhat is 2+2?\n\n[assistant]\nFour.\n\n[user]\nAnd 3+3?',
      );
    });

    it('passes temperature and max_tokens through to the model', async () => {
      await ask('hi', { temperature: 0.2, max_tokens: 33 });
      expect(llm.calls[0].request).toMatchObject({ temperature: 0.2, maxTokens: 33 });
    });

    it('honours max_completion_tokens, the name current SDKs send, as max_tokens', async () => {
      await ask('hi', { max_completion_tokens: 44 });
      expect(llm.calls[0].request.maxTokens).toBe(44);
    });

    it('answers with the final step only, whatever ran before it', async () => {
      const completion = await ask('x', { model: `agent:${ID.twoStep}` });
      expect(completion.choices[0].message.content).toBe('saw: polish saw: draft x');
    });

    it('accepts the defaults a client library sends unasked (n=1, top_p=1, zero penalties, user, metadata)', async () => {
      const completion = await ask('hi', {
        n: 1, top_p: 1, frequency_penalty: 0, presence_penalty: 0, user: 'end-user-7', metadata: { a: 'b' }, store: false,
      });
      expect(completion.choices[0].message.content).toBe('saw: hi');
    });
  });

  describe('streaming', () => {
    const collect = async (over: Record<string, any> = {}, model = `agent:${ID.echo}`) => {
      const stream = await client().chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        ...over,
      } as any);
      const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
      for await (const chunk of stream as any) chunks.push(chunk);
      return chunks;
    };
    const text = (chunks: OpenAI.Chat.Completions.ChatCompletionChunk[]) =>
      chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');

    it('streams exactly the answer the non-streaming call returns, once', async () => {
      const chunks = await collect();
      expect(text(chunks)).toBe('saw: hi');
    });

    it('never streams an intermediate step as if it were the answer', async () => {
      const chunks = await collect({}, `agent:${ID.twoStep}`);
      expect(text(chunks)).toBe('saw: polish saw: draft hi');
    });

    it('opens with the assistant role and ends with finish_reason stop, every chunk one completion id', async () => {
      const chunks = await collect();
      expect(chunks[0].choices[0].delta.role).toBe('assistant');
      const withChoices = chunks.filter((c) => c.choices.length > 0);
      expect(withChoices[withChoices.length - 1].choices[0].finish_reason).toBe('stop');
      expect(withChoices.slice(0, -1).every((c) => c.choices[0].finish_reason === null)).toBe(true);
      expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
      expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    });

    it('sends usage in a final empty-choices chunk only when stream_options.include_usage asks', async () => {
      const without = await collect();
      expect(without.some((c: any) => c.usage)).toBe(false);

      const withUsage = await collect({ stream_options: { include_usage: true } });
      const last = withUsage[withUsage.length - 1];
      expect(last.choices).toEqual([]);
      expect(last.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    });

    it('answers 200, as OpenAI does, not the 201 Nest gives a POST', async () => {
      const { response } = await client().chat.completions
        .create({ model: `agent:${ID.echo}`, messages: [{ role: 'user', content: 'hi' }] })
        .withResponse();
      expect(response.status).toBe(200);
    });

    it('is the text/event-stream wire format, terminated by data: [DONE]', async () => {
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token('member')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `agent:${ID.echo}`, messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const body = await res.text();
      const frames = body.split('\n\n').filter(Boolean);
      expect(frames.every((f) => f.startsWith('data: ') || f.startsWith(':'))).toBe(true);
      expect(frames[frames.length - 1]).toBe('data: [DONE]');
    });

    it('works through the SDK stream helper, finalChatCompletion included', async () => {
      const runner = client().chat.completions.stream({
        model: `agent:${ID.echo}`,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const final = await runner.finalChatCompletion();
      expect(final.choices[0].message.content).toBe('saw: hi');
      expect(final.choices[0].finish_reason).toBe('stop');
    });

    it('surfaces a failed run as an error the SDK raises, not as a short answer', async () => {
      llm.chat.mockRejectedValueOnce(new Error('upstream exploded'));
      const err = await failure(collect());
      expect(err.message).toMatch(/Pipeline failed|LLM call failed|did not complete/);
    });
  });

  describe('models', () => {
    const listed = async (name: string) => (await client(name).models.list()).data.map((m) => m.id).sort();

    it('lists the active agents the key may run, and nothing else', async () => {
      expect(await listed('member')).toEqual(
        [`agent:${ID.echo}`, `agent:${ID.team}`, `agent:${ID.auto}`, `agent:${ID.twoStep}`].sort(),
      );
      expect(await listed('nonmember')).toEqual([`agent:${ID.echo}`, `agent:${ID.auto}`, `agent:${ID.twoStep}`].sort());
      expect(await listed('owner')).toContain(`agent:${ID.private}`);
      expect(await listed('onlyecho')).toEqual([`agent:${ID.echo}`]);
      expect(await listed('elsewhere')).toEqual([]);
    });

    it('every model it lists answers a completion with a real answer', async () => {
      for (const name of ['member', 'nonmember', 'owner', 'onlyecho']) {
        for (const model of await listed(name)) {
          const completion = (await client(name).chat.completions.create({
            model,
            messages: [{ role: 'user', content: 'ping' }],
          })) as OpenAI.Chat.Completions.ChatCompletion;
          expect({ model, content: completion.choices[0].message.content }).toEqual({
            model,
            content: expect.stringContaining('ping'),
          });
        }
      }
    });

    it('lists each model in the OpenAI model shape', async () => {
      const [model] = (await client('onlyecho').models.list()).data;
      expect(model).toMatchObject({ id: `agent:${ID.echo}`, object: 'model', owned_by: 'almyty' });
      expect(typeof model.created).toBe('number');
    });

    it('retrieves one model the key may run, and 404s the rest', async () => {
      const model = await client().models.retrieve(`agent:${ID.echo}`);
      expect(model).toMatchObject({ id: `agent:${ID.echo}`, object: 'model' });

      for (const id of [`agent:${ID.private}`, `agent:${ID.draft}`, `agent:${ID.otherOrg}`, 'agent:nope']) {
        const err = await failure(client().models.retrieve(id));
        expect({ id, status: err.status, code: err.code }).toEqual({ id, status: 404, code: 'model_not_found' });
      }
    });
  });

  describe('who may call what', () => {
    const run = (name: string, id: string) =>
      failure(client(name).chat.completions.create({ model: `agent:${id}`, messages: [{ role: 'user', content: 'hi' }] }));

    it('keeps a team agent to its team, a private agent to its owner and every agent to its org', async () => {
      expect((await run('nonmember', ID.team)).status).toBe(404);
      expect((await run('member', ID.private)).status).toBe(404);
      expect((await run('elsewhere', ID.echo)).status).toBe(404);
      expect((await run('onlyecho', ID.twoStep)).status).toBe(404);
      expect(llm.calls).toHaveLength(0);
    });

    it('refuses a gateway key and a key carrying scopes, as the platform API does', async () => {
      expect(await run('gateway', ID.echo)).toMatchObject({ status: 401, type: 'authentication_error' });
      expect(await run('scoped', ID.echo)).toMatchObject({ status: 401, type: 'authentication_error' });
      expect(llm.calls).toHaveLength(0);
    });

    it('refuses a draft agent without running it', async () => {
      expect(await run('member', ID.draft)).toMatchObject({ status: 400 });
      expect(llm.calls).toHaveLength(0);
    });

    it('reads a key with no user as nobody: org-visible agents only, and the key itself is refused', async () => {
      // `api_keys.userId` is NOT NULL and cascades on user delete, so the row
      // cannot exist in a real table; if one did, it would still not reach
      // any agent -- the key is refused, and the listing rule for "nobody"
      // is org agents only.
      expect(
        (await agentsService.findAllActive(CAST.org, null)).map((a: Agent) => a.id).sort(),
      ).toEqual([ID.echo, ID.auto, ID.twoStep].sort());
      await apiKeys.save(Object.assign(new ApiKey(), keyRow('userless', null as any, { user: null as any })));
      expect(await run('userless', ID.echo)).toMatchObject({ status: 401, type: 'authentication_error' });
    });
  });

  describe('errors, in the OpenAI shape and status', () => {
    it('401 for a bad key, typed as the SDK AuthenticationError', async () => {
      const call = client('nobody').chat.completions.create({ model: `agent:${ID.echo}`, messages: [{ role: 'user', content: 'hi' }] });
      await expect(call).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
      expect(await failure(client('nobody').models.list())).toMatchObject({ status: 401, type: 'authentication_error', code: 'invalid_api_key' });
    });

    it('404 model_not_found for an unknown model', async () => {
      const call = ask('hi', { model: 'agent:does-not-exist' });
      await expect(call).rejects.toBeInstanceOf(OpenAI.NotFoundError);
      expect(await failure(ask('hi', { model: 'agent:does-not-exist' }))).toMatchObject({
        status: 404, type: 'invalid_request_error', code: 'model_not_found',
      });
    });

    it('400 for a malformed request', async () => {
      expect(await failure(ask('hi', { messages: [] }))).toMatchObject({ status: 400, type: 'invalid_request_error' });
      expect(await failure(ask('hi', { model: '' }))).toMatchObject({ status: 400, code: 'model_required' });
    });

    it('429 insufficient_quota when a spend budget refuses the run, not a 500', async () => {
      budgets.enforceForRun.mockRejectedValueOnce(
        new BudgetExceededException({
          budgetId: 'b1', organizationId: CAST.org, agentId: null, spentCents: 1000, limitCents: 1000, periodType: 'month',
        }),
      );
      const err = await failure(ask('hi'));
      expect(err).toMatchObject({ status: 429, type: 'insufficient_quota', code: 'insufficient_quota' });
      expect(err.message).toContain('Spend budget exceeded');
      expect(llm.calls).toHaveLength(0);
    });

    it.each([
      ['tools', { tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] }],
      ['tool_choice', { tool_choice: 'required' }],
      ['n', { n: 2 }],
      ['response_format', { response_format: { type: 'json_object' } }],
      ['top_p', { top_p: 0.5 }],
      ['stop', { stop: ['\n'] }],
      ['logprobs', { logprobs: true }],
    ])('400 unsupported_parameter naming %s, before anything runs', async (param, over) => {
      const err = await failure(ask('hi', over));
      expect(err).toMatchObject({ status: 400, type: 'invalid_request_error', code: 'unsupported_parameter', param });
      expect(llm.calls).toHaveLength(0);
    });

    it(`serves ${COMPAT_RATE_LIMIT_RPM} requests a minute per key, then 429 with a Retry-After the SDK can honour`, async () => {
      const served: number[] = [];
      for (let i = 0; i < COMPAT_RATE_LIMIT_RPM; i++) {
        served.push((await ask('hi').then(() => 200, (e) => e.status)) as number);
      }
      expect(served.filter((s) => s === 200)).toHaveLength(COMPAT_RATE_LIMIT_RPM);

      const err = await failure(ask('hi'));
      expect(err).toMatchObject({ status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded' });
      const retryAfter = Number(err.headers?.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    }, 60_000);
  });

  describe('the ways people configure the client', () => {
    it('works with a trailing slash on base_url', async () => {
      const completion = (await client('member', { baseURL: `${baseURL}/` }).chat.completions.create({
        model: `agent:${ID.echo}`,
        messages: [{ role: 'user', content: 'hi' }],
      })) as OpenAI.Chat.Completions.ChatCompletion;
      expect(completion.choices[0].message.content).toBe('saw: hi');
    });

    it('needs /v1 in base_url, as OpenAI itself does: without it the route is not this API', async () => {
      const bare = client('member', { baseURL: baseURL.replace(/\/v1$/, '') });
      await expect(bare.models.list()).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    });

    it('ignores OpenAI-Organization and OpenAI-Project headers', async () => {
      const completion = (await client('member', { organization: 'org-openai-xyz', project: 'proj_abc' }).chat.completions.create({
        model: `agent:${ID.echo}`,
        messages: [{ role: 'user', content: 'hi' }],
      })) as OpenAI.Chat.Completions.ChatCompletion;
      expect(completion.choices[0].message.content).toBe('saw: hi');
    });
  });

  describe('an autonomous agent', () => {
    it('runs on the autonomous runtime and answers with the run output', async () => {
      const completion = await ask('plan a trip', { model: `agent:${ID.auto}` });
      expect(completion.choices[0].message.content).toBe('autonomous saw: plan a trip');
      expect(completion.choices[0].finish_reason).toBe('stop');
      expect(runtime.started).toHaveLength(1);
      expect(runtime.started[0].options.principal).toMatchObject({ userId: CAST.member });
      expect(llm.calls).toHaveLength(0);
    });

    it('streams the run output', async () => {
      const stream = await client().chat.completions.create({
        model: `agent:${ID.auto}`,
        messages: [{ role: 'user', content: 'plan a trip' }],
        stream: true,
        stream_options: { include_usage: true },
      });
      const chunks: any[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('autonomous saw: plan a trip');
      expect(chunks[chunks.length - 1].usage).toMatchObject({ total_tokens: 42 });
    });

    it('reports a failed run as an error', async () => {
      runtime.finishWith(() => ({ status: AgentRunStatus.FAILED, error: 'tool blew up' }));
      expect(await failure(ask('x', { model: `agent:${ID.auto}` }))).toMatchObject({ status: 502, code: 'agent_execution_failed' });
    });

    it('does not leave a run waiting on a human that a stateless request can never answer', async () => {
      runtime.finishWith(() => ({ status: AgentRunStatus.WAITING_INPUT }));
      const err = await failure(ask('x', { model: `agent:${ID.auto}` }));
      expect(err).toMatchObject({ status: 409, code: 'agent_needs_input' });
      expect(runtime.cancelRun).toHaveBeenCalledTimes(1);
      expect(runs.rows()[0].status).toBe(AgentRunStatus.CANCELLED);
    });
  });
});
