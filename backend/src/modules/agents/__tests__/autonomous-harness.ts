/**
 * An autonomous agent's run, driven end to end with only the socket faked.
 *
 * Not a `.spec.ts`, deliberately: jest collects `.*\.spec\.ts$`.
 *
 * The provider parsers, LlmChatHelper.chatStream, the step processor, the
 * strategy runner, the verifier, the message builder and the hosted chat
 * controller's stream are the production classes. What is faked is the
 * byte stream a provider sends (what Anthropic and chat-completions put on
 * the wire), the database (truthful fake repositories) and, for a role
 * routed by policy, the router's plan head.
 *
 * A spec using this must mock the socket itself, before its imports:
 *
 *   jest.mock('../../llm-providers/providers/safe-request', () => ({
 *     ...jest.requireActual('../../llm-providers/providers/safe-request'),
 *     callLlmProviderHttpStream: jest.fn(),
 *   }));
 */
import { Readable } from 'stream';
import { NotFoundException } from '@nestjs/common';

import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../entities/llm-provider.entity';
import { Message, MessageContent } from '../../../entities/message.entity';
import { MessageAttachmentResolver } from '../../llm-providers/message-attachments.resolver';
import { Conversation } from '../../../entities/conversation.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { AgentStepProcessor } from '../agent-step-processor';
import { AgentRuntimeBuilders } from '../agent-runtime-builders';
import { AgentVerifierHelper } from '../agent-verifier.helper';
import { BUILT_IN_TOOLS } from '../agent-runtime.service';
import { resolveRunLimits } from '../run-limits';
import { AgentModels } from '../autonomous-models';
import { LlmChatHelper } from '../../llm-providers/llm-chat.helper';
import { HostedChatController } from '../../gateways/channels/hosted-chat.controller';
import { fakeRepository, UnmodelledQueryError } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { gatewayPrincipal, userPrincipal } from '../../../common/authorization/execution-access.service';
import { callLlmProviderHttpStream } from '../../llm-providers/providers/safe-request';

// ── Provider byte streams, one per call, keyed by the model asked for ──
export const openaiText = (model: string, prompt: number, parts: string[], completion: number) => [
  ...parts.map(
    (content, i) =>
      `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content }, finish_reason: i === parts.length - 1 ? 'stop' : null }] })}\n\n`,
  ),
  `data: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`,
  'data: [DONE]\n\n',
];
export const openaiTool = (model: string, name: string, args: Record<string, unknown>, prompt: number, completion: number) => [
  `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: 'Let me look that up' }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `tc-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
  `data: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } })}\n\n`,
  'data: [DONE]\n\n',
];
export const anthropicText = (model: string, input: number, parts: string[], output: number) => [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model, usage: { input_tokens: input } } })}\n\n`,
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  ...parts.map(
    (text) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
  ),
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${output}}}\n\n`,
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
export const anthropicTool = (model: string, name: string, args: Record<string, unknown>, input: number, output: number) => [
  `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model, usage: { input_tokens: input } } })}\n\n`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${name}`, name } })}\n\n`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } })}\n\n`,
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":${output}}}\n\n`,
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];

// ── Two accounts, priced an order of magnitude apart ─────────────────
export const CHEAP = { in: 0.0000001, out: 0.0000004 };
export const DEAR = { in: 0.000003, out: 0.000015 };
export const price = (p: LlmProvider, input: number, output: number) => {
  const rate = p.type === LlmProviderType.ANTHROPIC ? DEAR : CHEAP;
  return input * rate.in + output * rate.out;
};
export const cheap = (input: number, output: number) => input * CHEAP.in + output * CHEAP.out;
export const dear = (input: number, output: number) => input * DEAR.in + output * DEAR.out;

export const provider = (id: string, type: 'openai' | 'anthropic') =>
  Object.assign(new LlmProvider(), {
    id,
    organizationId: 'org-1',
    name: id,
    type: type === 'anthropic' ? LlmProviderType.ANTHROPIC : LlmProviderType.OPENAI,
    status: LlmProviderStatus.ACTIVE,
    isHealthy: true,
    configuration: { model: type === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o-mini', timeout: 30000 },
    getApiUrl: () => (type === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
    getAuthHeaders: () => (type === 'anthropic' ? { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' } : { Authorization: 'Bearer k' }),
  });
export const providers = [provider('p-cheap', 'openai'), provider('p-strong', 'anthropic')];

export const MAIN = { key: 'main', name: 'Main', purpose: 'main', kind: 'model', providerId: 'p-strong', model: 'claude-sonnet-5', temperature: 0.2, maxTokens: 800 } as const;
export const DRAFTER = { key: 'drafter', name: 'Drafter', purpose: 'drafter', kind: 'model', providerId: 'p-cheap', model: 'gpt-4o-mini', temperature: 0.3, maxTokens: 400 } as const;
export const CHECKER = { key: 'checker', name: 'Checker', purpose: 'checker', kind: 'model', providerId: 'p-cheap', model: 'o4-mini', instructions: 'Every claim needs order data.' } as const;
export const mainModelConfig = { providerId: 'p-strong', model: 'claude-sonnet-5', temperature: 0.2, maxTokens: 800 };

export const FAIL = JSON.stringify({ verdict: 'fail', failures: [{ rule: 'cites no order data', evidence: 'ships soon' }], passed_rules: [] });
export const PASS = JSON.stringify({ verdict: 'pass', failures: [], passed_rules: ['grounded'] });

export type Streams = Record<string, Array<string[] | Error>>;

/**
 * One run, end to end. `startRun`/`waitForRun` are the queue's double:
 * a child run is a row in the same table, driven by the same processor
 * until it ends.
 */
export async function runAgent(opts: {
  models: AgentModels | null;
  modelConfig?: Record<string, any>;
  streams: Streams;
  limits?: Record<string, number>;
  hosted?: boolean;
  /**
   * What the router picks for a role routed by policy, keyed by the
   * policy's objective: the head of the plan, on one of `providers`.
   */
  routes?: Record<string, { providerId: string; model: string }>;
  /** Fields of the agent row this case sets (memoryConfig, agentConfig, toolIds). */
  agent?: Record<string, any>;
  /** Fields of the run this case sets (userId, endUserId, metadata). */
  run?: Record<string, any>;
  /** The memory accounts double (MemoryAccountsService's put and search). */
  memoryAccounts?: { put: jest.Mock; search: jest.Mock };
  /** Other agents of the organization. */
  otherAgents?: Array<Record<string, any>>;
  /** More tool rows of the organization. */
  tools?: Array<Record<string, any>>;
  /** The tool executor's executeTool, when a case needs to see its options. */
  executeTool?: jest.Mock;
  /** The run's first user message, when a case sends files with it (parts, attached-files.ts). */
  userMessage?: string | MessageContent[];
  /** The files resolver the model calls go through (message-attachments.resolver.ts). */
  attachmentResolver?: MessageAttachmentResolver;
  /** The approvals service double (its create), for a case whose tool calls an approval rule holds. */
  approvals?: { create: jest.Mock; findInOrganization?: jest.Mock };
  /** run_code (code mode): a CodeModeService, for a case whose agent writes scripts. */
  codeMode?: any;
  /** More members of the organization, besides u-1 (a scheduled run acts as the agent's owner). */
  members?: string[];
}) {
  const bodies: Array<{ model: string; body: any }> = [];
  const queues: Streams = JSON.parse(JSON.stringify(opts.streams));
  (callLlmProviderHttpStream as jest.Mock).mockReset();
  (callLlmProviderHttpStream as jest.Mock).mockImplementation(async (config: any) => {
    const body = JSON.parse(JSON.stringify(config.data));
    bodies.push({ model: body.model, body });
    const next = queues[body.model]?.shift();
    if (!next) throw new Error(`the test has no stream left for model ${body.model}`);
    return { data: Readable.from((next as string[]).map((s) => Buffer.from(s))) };
  });

  let clock = Date.parse('2026-09-24T10:00:00Z');
  const messageRepository = fakeRepository<Message>({ make: () => new Message(), idPrefix: 'msg' });
  const storeMessage = messageRepository.save.getMockImplementation()!;
  messageRepository.save.mockImplementation(async (entity: any) => {
    if (!entity.createdAt) entity.createdAt = new Date(clock++);
    return storeMessage(entity);
  });
  await messageRepository.save(Message.createUserMessage('conv-1', opts.userMessage ?? 'Where is my order 4411?'));

  const agent = {
    id: 'agent-1',
    name: 'Acme support',
    organizationId: 'org-1',
    visibility: 'org',
    createdBy: 'u-owner',
    mode: 'autonomous',
    status: 'active',
    instructions: 'You are Acme support. Answer the customer.',
    toolIds: ['tool-crm'],
    modelConfig: opts.modelConfig ?? mainModelConfig,
    models: opts.models,
    memoryConfig: { enabled: false },
    agentConfig: {},
    collaboration: null,
    settings: {},
  };
  // A case's own settings on the agent: its memory, its capabilities, its tools.
  Object.assign(agent, opts.agent ?? {});
  const limits = { maxSteps: 20, maxCostCents: 100, maxDurationMs: 3_600_000, maxToolCalls: 100, ...(opts.limits ?? {}) };
  const runRow = (id: string, conversationId: string, extra: Record<string, any> = {}) => ({
    id,
    agentId: agent.id,
    organizationId: 'org-1',
    userId: 'u-1',
    endUserId: null,
    conversationId,
    status: AgentRunStatus.RUNNING,
    input: 'Where is my order 4411?',
    steps: [],
    currentStep: 0,
    maxSteps: limits.maxSteps,
    limits,
    totalCost: 0,
    totalTokens: 0,
    toolCallCount: 0,
    recursionDepth: 0,
    executionTime: 0,
    workingMemory: {},
    createdAt: new Date(),
    metadata: opts.hosted ? { visitorMemory: false, composeFinalAnswer: true } : {},
    agent: agent as any,
    principal: opts.hosted ? gatewayPrincipal({ id: 'gw-1', organizationId: 'org-1', visibility: 'org' } as any) : userPrincipal('u-1'),
    parentRunId: null,
    ...extra,
  });
  const runRepository = fakeRepository<AgentRun>({ make: () => new AgentRun(), seed: [runRow('run-1', 'conv-1', opts.run ?? {}) as any] });

  const toolExecutorService = {
    executeTool:
      opts.executeTool ??
      jest.fn(async (toolId: string) => {
        if (toolId !== 'tool-crm') throw new Error(`unexpected tool ${toolId}`);
        return { success: true, data: { account: '4411', eta: 'Monday' }, executionTime: 4 };
      }),
  };

  const llm = new LlmChatHelper(
    fakeRepository(providers.map((p) => ({ id: p.id, organizationId: p.organizationId }))) as any,
    fakeRepository<Conversation>({ make: () => new Conversation(), idPrefix: 'session' }) as any,
    fakeRepository<Message>({ make: () => new Message(), idPrefix: 'llmmsg' }) as any,
    fakeRepository() as any,
    {} as any,
    {} as any,
    { calculateProviderCost: price } as any,
    {
      getProvider: async (id: string, organizationId: string) => {
        const found = providers.find((p) => p.id === id && p.organizationId === organizationId);
        if (!found) throw new NotFoundException('LLM provider not found');
        return found;
      },
    } as any,
    { bumpSessionStats: async () => undefined, bumpProviderStats: async () => undefined } as any,
    {
      resolveProviderSecrets: async () => undefined,
      // The real resolver when a case hands one in (files a message refers
      // to), else the request as it is.
      resolveAttachments: async (org: string | undefined, p: any, request: any) =>
        opts.attachmentResolver ? opts.attachmentResolver.resolve(org, p, request) : request,
      planRouteHead: async (_org: string, request: any) => {
        const route = opts.routes?.[request.routing?.objective];
        if (!route) throw new UnmodelledQueryError('no route is modelled for this policy');
        const head = providers.find((p) => p.id === route.providerId)!;
        return {
          provider: head,
          candidate: {
            modelId: `card-${route.model}`,
            modelVersionId: null,
            vendorModelId: route.model,
            providerId: head.id,
            rationale: `${request.routing.objective}: ${route.model}`,
            card: { providerId: head.id },
            provider: head,
          },
          rejected: [],
        };
      },
      recordRoute: () => undefined,
      prepareTools: async (tools: unknown[] | undefined) => {
        if (tools?.length) throw new UnmodelledQueryError('tool lookup by name is not modelled');
        return [];
      },
    } as any,
    { resolve: async (p: LlmProvider) => p.configuration.model } as any,
    { warmOrg: async () => undefined } as any,
  );
  const llmProvidersService = {
    chatStream: (...args: Parameters<LlmChatHelper['chatStream']>) => llm.chatStream(...args),
    // The checker's non-streaming call, carried over the same real
    // provider parsers: a response is a response, whichever way it came.
    chat: (providerId: string, request: any, organizationId: string, userId?: string) =>
      llm.chatStream(providerId, request, organizationId, userId, () => undefined),
  };

  const events: Array<{ runId: string; type: string; data: any }> = [];
  let sink: ((event: any) => void) | null = null;
  let processor: AgentStepProcessor;
  const drive = async (runId: string) => {
    let result: string;
    do {
      result = await processor.processStep(runId);
    } while (result === 'continue');
    return result;
  };

  let childSeq = 0;
  // The run's starter is a member of the org: every step re-checks it.
  const access = membershipFixture();
  access.member('org-1', 'u-1');
  for (const member of opts.members ?? []) access.member('org-1', member);
  const s: any = {
    logger: { log: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
    runRepository,
    messageRepository,
    organizationRepository: fakeRepository([{ id: 'org-1', settings: {} }]),
    toolRepository: fakeRepository([
      { id: 'tool-crm', organizationId: 'org-1', name: 'crm_lookup', description: 'Look up an order', parameters: { type: 'object', properties: { account: { type: 'string' } } } },
      ...(opts.tools ?? []),
    ]),
    agentRepository: fakeRepository([agent, ...(opts.otherAgents ?? [])]),
    executionAccess: access.executionAccess,
    misc: {
      resolveLimits: async (run: AgentRun, organization: any) => resolveRunLimits({ organization, agent: run.agent, run }),
      bumpAgentStats: async () => undefined,
    },
    builders: new AgentRuntimeBuilders(messageRepository as any, { listActiveRules: async () => [] } as any),
    builtInTools: {
      executeBuiltInTool: async (name: string) => {
        // store_memory and recall_memory are the memory keeper's, not this helper's.
        if (name in BUILT_IN_TOOLS && name !== 'store_memory' && name !== 'recall_memory') throw new Error(`built-in ${name} is not part of these runs`);
        return null;
      },
    },
    // The agent's memory account (almyty's own or an outside one): the
    // double a memory case hands in, or nothing.
    memoryAccounts: opts.memoryAccounts,
    toolExecutorService,
    // The approvals service, for a case whose tool calls an approval rule holds.
    approvals: opts.approvals,
    llmProvidersService,
    processStep: (runId: string) => processor.processStep(runId),
    startRun: async (agentId: string, organizationId: string, _userId: string, input: string, options: any) => {
      if (agentId !== agent.id || organizationId !== 'org-1') throw new NotFoundException('Agent not found');
      // Nothing here works the queue: a child run a strategy starts must be
      // one it drives itself, or it would wait behind its own parent.
      if (options.inline !== true) throw new Error('a strategy child run was queued instead of driven inline');
      const id = `child-${++childSeq}`;
      const conversationId = `conv-${id}`;
      await messageRepository.save(Message.createUserMessage(conversationId, input));
      const childLimits = { ...limits, maxSteps: options.maxSteps, maxCostCents: options.maxCostCents, maxDurationMs: options.maxDurationMs };
      await runRepository.save(
        Object.assign(new AgentRun(), runRow(id, conversationId, {
          input,
          parentRunId: options.parentRunId,
          principal: options.principal,
          metadata: options.metadata ?? {},
          limits: childLimits,
          maxSteps: options.maxSteps,
          recursionDepth: 1,
        })),
      );
      return runRepository.findOne({ where: { id } });
    },
    emitEvent: (runId: string, type: string, data: any) => {
      events.push({ runId, type, data });
      if (runId === 'run-1') sink?.({ type, data });
    },
  };
  const verifier = new AgentVerifierHelper(llmProvidersService as any);
  processor = new AgentStepProcessor(s, verifier, {} as any, {} as any, undefined, opts.codeMode);

  // A visitor's view, through the hosted chat controller's own stream().
  let tokens: string[] = [];
  if (opts.hosted) {
    const frames: string[] = [];
    const gateway = Object.assign(new Gateway(), {
      id: 'gw-1',
      type: GatewayType.HOSTED_CHAT,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      agentId: agent.id,
      configuration: { hostedChat: { slug: 'acme' } },
    });
    const controller = new HostedChatController(
      {
        findBySlug: async () => gateway,
        resolveEndUser: async () => ({ endUser: { id: 'eu-1' }, issuedSessionKey: null }),
        requiresAuth: () => false,
        runBelongsToEndUser: async () => true,
      } as any,
      {} as any,
      {
        getRun: async (runId: string) => runRepository.findOne({ where: { id: runId } }),
        subscribeRunEvents: async (runId: string, handler: (event: any) => void) => {
          sink = handler;
          await drive(runId);
        },
      } as any,
    );
    await controller.stream('acme', 'run-1', { headers: {}, cookies: {}, ip: '203.0.113.9', on: () => undefined } as any, {
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (frame: string) => frames.push(frame),
      end: () => undefined,
    } as any);
    tokens = frames.filter((f) => f.startsWith('event: token')).map((f) => JSON.parse(f.split('data: ')[1]).content);
  } else {
    await drive('run-1');
  }

  const run = runRepository.row('run-1')!;
  const visible = (await messageRepository.find({ where: { conversationId: 'conv-1' } }))
    .filter((m: any) => !m.metadata?.internal)
    .map((m: any) => [m.role, m.content]);
  return {
    run,
    bodies,
    events: events.filter((e) => e.runId === 'run-1'),
    allEvents: events,
    visible,
    tokens,
    leftover: Object.fromEntries(Object.entries(queues).filter(([, q]) => q.length > 0)),
    runRepository,
    /** Drive the run again, after the case decided what it was waiting for (an approval). */
    drive: () => drive('run-1'),
  };
}

/** [type, role key, status or verdict] per step: the run's story in one line each. */
export const story = (run: AgentRun) =>
  run.steps.map((st: any) => [st.type, st.role?.key ?? null, st.output?.status ?? st.output?.verdict ?? (st.output?.toolCalls ? 'tools' : null)]);
