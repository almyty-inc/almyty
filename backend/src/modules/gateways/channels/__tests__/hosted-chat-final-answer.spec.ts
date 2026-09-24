import { Readable } from 'stream';
import { NotFoundException } from '@nestjs/common';

import { HostedChatController } from '../hosted-chat.controller';
import { HostedChatService } from '../hosted-chat.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../../entities/llm-provider.entity';
import { Message } from '../../../../entities/message.entity';
import { Conversation } from '../../../../entities/conversation.entity';
import { AgentRun, AgentRunStatus } from '../../../../entities/agent-run.entity';
import { AgentStepProcessor } from '../../../agents/agent-step-processor';
import { AgentRuntimeBuilders } from '../../../agents/agent-runtime-builders';
import { BUILT_IN_TOOLS } from '../../../agents/agent-runtime.service';
import { resolveRunLimits } from '../../../agents/run-limits';
import { LlmChatHelper } from '../../../llm-providers/llm-chat.helper';
import { fakeRepository, UnmodelledQueryError } from '../../../../test/fake-repository';
import { membershipFixture } from '../../../../test/execution-access.fixture';
import { gatewayPrincipal } from '../../../../common/authorization/execution-access.service';

// Only the socket is faked. The provider parsers, LlmChatHelper.chatStream,
// the step processor, the message builder and the controller are the real
// code; the byte streams are what Anthropic and chat-completions send.
jest.mock('../../../llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../../llm-providers/providers/safe-request'),
  callLlmProviderHttpStream: jest.fn(),
}));
const { callLlmProviderHttpStream } = require('../../../llm-providers/providers/safe-request');

/**
 * A hosted chat run with tool work answers the visitor word by word.
 *
 * Every tool step and the draft reply stay hidden; a last call with no
 * tools writes the answer, and that is what streams and what is kept.
 */
describe('hosted chat: the answer is a no-tools call that streams', () => {
  // ── Provider byte streams ──────────────────────────────────────────
  const anthropicToolStep = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":90}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Looking up account 4411"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" for jane@corp.test"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"crm_lookup"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"account\\":\\"4411\\"}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const anthropicText = (inputTokens: number, parts: string[], outputTokens: number) => [
    `event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5","usage":{"input_tokens":${inputTokens}}}}\n\n`,
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    ...parts.map(
      (text) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    ),
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${outputTokens}}}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const openaiToolStep = [
    'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"content":"Let me check account 4411"},"finish_reason":null}]}\n\n',
    'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"tc-1","type":"function","function":{"name":"crm_lookup","arguments":"{\\"account\\":\\"4411\\"}"}}]},"finish_reason":null}]}\n\n',
    'data: {"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":90,"completion_tokens":7,"total_tokens":97}}\n\n',
    'data: [DONE]\n\n',
  ];
  const openaiText = (promptTokens: number, parts: string[], completionTokens: number) => [
    ...parts.map(
      (content, i) =>
        `data: ${JSON.stringify({ model: 'gpt-4o', choices: [{ index: 0, delta: { content }, finish_reason: i === parts.length - 1 ? 'stop' : null }] })}\n\n`,
    ),
    `data: {"model":"gpt-4o","choices":[],"usage":{"prompt_tokens":${promptTokens},"completion_tokens":${completionTokens},"total_tokens":${promptTokens + completionTokens}}}\n\n`,
    'data: [DONE]\n\n',
  ];

  const DRAFT = ['Draft: order for 4411', ' ships Monday.'];
  const ANSWER = ['Your order', ' ships', ' Monday.'];

  /** Per-token price, so every call has a cost the run must account for. */
  const price = (_p: LlmProvider, input: number, output: number) => input * 0.000001 + output * 0.000002;

  const providerFor = (type: 'anthropic' | 'openai') =>
    Object.assign(new LlmProvider(), {
      id: `p-${type}`,
      organizationId: 'org-1',
      name: type,
      type: type === 'anthropic' ? LlmProviderType.ANTHROPIC : LlmProviderType.OPENAI,
      status: LlmProviderStatus.ACTIVE,
      isHealthy: true,
      configuration: { model: type === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o', timeout: 30000 },
      getApiUrl: () => (type === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
      getAuthHeaders: () => (type === 'anthropic' ? { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' } : { Authorization: 'Bearer k' }),
    });

  /**
   * One hosted chat run, end to end: the controller's stream() drives the
   * real step processor until the run ends, and returns what the visitor
   * received, what went to the provider, and what the run left behind.
   */
  async function hostedChatRun(opts: {
    provider: 'anthropic' | 'openai';
    streams: Array<string[] | Error>;
    maxSteps?: number;
    agentConfig?: Record<string, any>;
    verifier?: { runPanel: jest.Mock };
    /** False for a run no hosted chat started. */
    compose?: boolean;
  }) {
    const provider = providerFor(opts.provider);
    const bodies: any[] = [];
    const queue = [...opts.streams];
    (callLlmProviderHttpStream as jest.Mock).mockReset();
    (callLlmProviderHttpStream as jest.Mock).mockImplementation(async (config: any) => {
      bodies.push(JSON.parse(JSON.stringify(config.data)));
      const next = queue.shift();
      if (!next) throw new Error('the test ran out of provider streams');
      if (next instanceof Error) throw next;
      return { data: Readable.from(next.map((s) => Buffer.from(s))) };
    });

    // The messages table. createdAt is the database's to assign
    // (@CreateDateColumn), and the message builder orders on it.
    let clock = Date.parse('2026-09-24T10:00:00Z');
    const messageRepository = fakeRepository<Message>({ make: () => new Message(), idPrefix: 'msg' });
    const storeMessage = messageRepository.save.getMockImplementation()!;
    messageRepository.save.mockImplementation(async (entity: any) => {
      if (!entity.createdAt) entity.createdAt = new Date(clock++);
      return storeMessage(entity);
    });

    const conversation = Object.assign(new Conversation(), { id: 'conv-visitor', organizationId: 'org-1', agentId: 'agent-1' });
    await messageRepository.save(Object.assign(Message.createUserMessage(conversation.id, 'Where is my order?')));

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
      modelConfig: { providerId: provider.id, model: provider.configuration.model, temperature: 0.2, maxTokens: 512 },
      memoryConfig: { enabled: false },
      agentConfig: opts.agentConfig ?? {},
      collaboration: null,
      settings: {},
    };
    const runRepository = fakeRepository<AgentRun>({
      make: () => new AgentRun(),
      seed: [
        {
          id: 'run-1',
          agentId: agent.id,
          organizationId: 'org-1',
          userId: null,
          endUserId: 'eu-1',
          conversationId: conversation.id,
          status: AgentRunStatus.RUNNING,
          input: { message: 'Where is my order?' },
          steps: [],
          currentStep: 0,
          maxSteps: opts.maxSteps ?? 50,
          limits: { maxSteps: opts.maxSteps ?? 50, maxCostCents: 100, maxDurationMs: 3_600_000, maxToolCalls: 100 },
          totalCost: 0,
          totalTokens: 0,
          toolCallCount: 0,
          recursionDepth: 0,
          executionTime: 0,
          createdAt: new Date(),
          metadata: opts.compose === false ? { visitorMemory: false } : { visitorMemory: false, composeFinalAnswer: true },
          agent: agent as any,
          // What the controller stamps on a hosted-chat run: the gateway's scope.
          principal: gatewayPrincipal({ id: 'gw-1', organizationId: 'org-1', visibility: 'org' } as any),
        } as any,
      ],
    });

    const toolExecutorService = {
      executeTool: jest.fn(async (toolId: string) => {
        if (toolId !== 'tool-crm') throw new Error(`unexpected tool ${toolId}`);
        return { success: true, data: { account: '4411', email: 'jane@corp.test', eta: 'Monday' }, executionTime: 4 };
      }),
    };

    const llm = new LlmChatHelper(
      fakeRepository([{ id: provider.id, organizationId: provider.organizationId }]) as any,
      fakeRepository<Conversation>({ make: () => new Conversation(), idPrefix: 'session' }) as any,
      messageRepository as any,
      fakeRepository() as any,
      {} as any,
      {} as any,
      { calculateProviderCost: price } as any,
      {
        getProvider: async (id: string, organizationId: string) => {
          if (id !== provider.id || organizationId !== provider.organizationId) throw new NotFoundException('LLM provider not found');
          return provider;
        },
      } as any,
      { bumpSessionStats: async () => undefined, bumpProviderStats: jest.fn(async () => undefined) } as any,
      {
        planRouteHead: async () => {
          throw new UnmodelledQueryError('these runs name a provider, not a routing policy');
        },
        prepareTools: async (tools: unknown[] | undefined) => {
          // Only ever reached with no tools: the runtime inlines its own.
          if (tools?.length) throw new UnmodelledQueryError('tool lookup by name is not modelled');
          return [];
        },
      } as any,
      { resolve: async () => provider.configuration.model } as any,
      { warmOrg: async () => undefined } as any,
    );

    let sink: ((event: any) => void) | null = null;
    const events: Array<{ type: string; data: any }> = [];
    const s: any = {
      logger: { log: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
      runRepository,
      messageRepository,
      organizationRepository: fakeRepository([{ id: 'org-1', settings: {} }]),
      toolRepository: fakeRepository([{ id: 'tool-crm', organizationId: 'org-1', name: 'crm_lookup', description: 'Look up an account', parameters: { type: 'object', properties: { account: { type: 'string' } } } }]),
      agentRepository: fakeRepository([agent]),
      // The real execution gate: an org-wide agent and tool, served by an
      // org gateway, are in scope for the run on every step.
      executionAccess: membershipFixture().executionAccess,
      misc: {
        resolveLimits: async (run: AgentRun, organization: any) => resolveRunLimits({ organization, agent: run.agent, run }),
        bumpAgentStats: async () => undefined,
        autoSaveMemory: async () => undefined,
      },
      builders: new AgentRuntimeBuilders(messageRepository as any, { listActiveRules: async () => [] } as any),
      builtInTools: {
        executeBuiltInTool: async (name: string) => {
          if (name in BUILT_IN_TOOLS) throw new Error(`built-in ${name} is not part of these runs`);
          return null;
        },
      },
      toolExecutorService,
      llmProvidersService: { chatStream: (...args: Parameters<LlmChatHelper['chatStream']>) => llm.chatStream(...args) },
      emitEvent: (_runId: string, type: string, data: any) => {
        events.push({ type, data });
        sink?.({ type, data });
      },
    };
    const processor = new AgentStepProcessor(s, (opts.verifier ?? {}) as any, {} as any, {} as any);

    const gateway = Object.assign(new Gateway(), {
      id: 'gw-1',
      type: GatewayType.HOSTED_CHAT,
      status: GatewayStatus.ACTIVE,
      organizationId: 'org-1',
      agentId: agent.id,
      configuration: { hostedChat: { slug: 'acme' } },
    });
    const hostedChat = {
      findBySlug: async () => gateway,
      resolveEndUser: async () => ({ endUser: { id: 'eu-1' }, issuedSessionKey: null }),
      requiresAuth: () => false,
      runBelongsToEndUser: async (runId: string) => (await runRepository.findOne({ where: { id: runId, endUserId: 'eu-1' } })) !== null,
    };
    const results: string[] = [];
    const agentRuntime = {
      getRun: async (runId: string) => runRepository.findOne({ where: { id: runId } }),
      subscribeRunEvents: async (runId: string, handler: (event: any) => void) => {
        sink = handler;
        let result: string;
        do {
          result = await processor.processStep(runId);
          results.push(result);
        } while (result === 'continue');
      },
    };

    const frames: string[] = [];
    const res = {
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write: (frame: string) => frames.push(frame),
      end: () => undefined,
    };
    const controller = new HostedChatController(hostedChat as any, {} as any, agentRuntime as any);
    await controller.stream('acme', 'run-1', { headers: {}, cookies: {}, ip: '203.0.113.9', on: () => undefined } as any, res as any);

    // The replay a returning visitor gets, through the service's own filter.
    const transcriptService = Object.assign(Object.create(HostedChatService.prototype), { messageRepository });
    const transcript = await transcriptService.listMessages(conversation);

    return {
      raw: frames.join(''),
      tokens: frames.filter((f) => f.startsWith('event: token')).map((f) => JSON.parse(f.split('data: ')[1]).content),
      done: frames.filter((f) => f.startsWith('event: done')).map((f) => JSON.parse(f.split('data: ')[1]).reason),
      bodies,
      run: runRepository.row('run-1')!,
      transcript,
      toolExecutorService,
      results,
      events,
    };
  }

  const cost = (calls: Array<[number, number]>) => calls.reduce((sum, [i, o]) => sum + i * 0.000001 + o * 0.000002, 0);

  describe.each([
    {
      name: 'Anthropic',
      provider: 'anthropic' as const,
      toolStep: anthropicToolStep,
      text: anthropicText,
    },
    {
      name: 'chat completions',
      provider: 'openai' as const,
      toolStep: openaiToolStep,
      text: openaiText,
    },
  ])('$name', ({ provider, toolStep, text }) => {
    const streams = () => [toolStep, text(120, DRAFT, 12), text(118, ANSWER, 5)];

    it('streams the answer in several token events, in order, with nothing of the working', async () => {
      const seen = await hostedChatRun({ provider, streams: streams() });

      expect(seen.tokens).toEqual(ANSWER);
      expect(seen.tokens.join('')).toBe('Your order ships Monday.');
      // Neither the narration ahead of the tool call, nor the tool's result,
      // nor the draft the answer call replaced.
      expect(seen.raw).not.toContain('4411');
      expect(seen.raw).not.toContain('jane@corp.test');
      expect(seen.raw).not.toContain('Draft');
      expect(seen.raw).not.toContain('event: reset');
      expect(seen.done).toEqual(['run.completed']);
      expect(seen.toolExecutorService.executeTool).toHaveBeenCalledTimes(1);
    });

    it('sends the answer call with no tools and otherwise the same request', async () => {
      const seen = await hostedChatRun({ provider, streams: streams() });

      expect(seen.bodies).toHaveLength(3);
      const [toolCall, draft, answer] = seen.bodies;
      expect(toolCall.tools.map((t: any) => t.name ?? t.function?.name)).toContain('crm_lookup');
      expect(draft.tools.length).toBeGreaterThan(0);
      expect(answer).not.toHaveProperty('tools');
      expect(answer).not.toHaveProperty('tool_choice');
      // Same model and sampling as the step it replaces.
      expect(answer.model).toBe(draft.model);
      expect(answer.temperature).toBe(draft.temperature);
      expect(answer.max_tokens).toBe(draft.max_tokens);

      if (provider === 'anthropic') {
        expect(answer.system).toBe(draft.system);
        expect(answer.system).toContain('You are Acme support.');
      } else {
        expect(answer.messages[0]).toEqual(draft.messages[0]);
        expect(answer.messages[0].content).toContain('You are Acme support.');
        // Tool turns go as text: a request without tools carries no tool
        // calls and no tool-role results.
        expect(answer.messages.some((m: any) => m.tool_calls || m.role === 'tool' || m.tool_call_id)).toBe(false);
      }
      // What the tool returned is still in front of the model.
      const said = JSON.stringify(answer.messages);
      expect(said).toContain('[called crm_lookup with {\\"account\\":\\"4411\\"}]');
      expect(said).toContain('[result of crm_lookup]');
      expect(said).toContain('Monday');
      expect(said).toContain('Where is my order?');
      // The draft itself is not: it was set aside, not added to the thread.
      expect(said).not.toContain('Draft');
    });

    it('charges the answer call to the run, and keeps the answer as the reply', async () => {
      const seen = await hostedChatRun({ provider, streams: streams() });

      expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
      expect(seen.run.output).toBe('Your order ships Monday.');
      expect(seen.run.currentStep).toBe(3);
      expect(seen.run.totalCost).toBeCloseTo(cost([[90, 7], [120, 12], [118, 5]]), 12);
      expect(seen.run.totalTokens).toBe(90 + 7 + 120 + 12 + 118 + 5);

      const calls = seen.run.steps.filter((st: any) => st.type === 'llm_call');
      expect(calls.map((st: any) => st.output?.status ?? 'tools')).toEqual(['tools', 'drafted', 'completed']);
      expect(calls[1].cost).toBeCloseTo(cost([[120, 12]]), 12);
      expect(calls[2].cost).toBeCloseTo(cost([[118, 5]]), 12);
      expect(calls[2].tokens).toEqual({ input: 118, output: 5 });
      expect(calls[2].input.toolCount).toBe(0);

      // The visitor's replay: their question and the answer, no working.
      expect(seen.transcript.map((m: any) => [m.role, m.content])).toEqual([
        ['user', 'Where is my order?'],
        ['assistant', 'Your order ships Monday.'],
      ]);
    });
  });

  it('answers with the draft, whole, when the answer call would pass maxSteps', async () => {
    const seen = await hostedChatRun({
      provider: 'anthropic',
      streams: [anthropicToolStep, anthropicText(120, DRAFT, 12)],
      maxSteps: 2,
    });

    expect(seen.bodies).toHaveLength(2);
    expect(seen.tokens).toEqual([DRAFT.join('')]);
    expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
    expect(seen.run.output).toBe(DRAFT.join(''));
    expect(seen.run.currentStep).toBe(2);
  });

  it('still stops a runaway run at maxSteps, with nothing sent and no answer call', async () => {
    const seen = await hostedChatRun({
      provider: 'openai',
      streams: [openaiToolStep, openaiToolStep, openaiToolStep, openaiToolStep],
      maxSteps: 3,
    });

    expect(seen.bodies).toHaveLength(3);
    expect(seen.bodies.every((b) => Array.isArray(b.tools) && b.tools.length > 0)).toBe(true);
    expect(seen.run.status).toBe(AgentRunStatus.FAILED);
    expect(seen.run.error).toMatch(/^MAX_STEPS_EXCEEDED/);
    expect(seen.tokens).toEqual([]);
    expect(seen.raw).not.toContain('4411');
    expect(seen.done).toEqual(['run.failed']);
  });

  it('answers with the draft when the answer call fails', async () => {
    const seen = await hostedChatRun({
      provider: 'openai',
      streams: [openaiToolStep, openaiText(120, DRAFT, 12), new Error('upstream 529')],
    });

    expect(seen.bodies).toHaveLength(3);
    expect(seen.bodies[2]).not.toHaveProperty('tools');
    expect(seen.tokens).toEqual([DRAFT.join('')]);
    expect(seen.run.status).toBe(AgentRunStatus.COMPLETED);
    expect(seen.run.output).toBe(DRAFT.join(''));
    const final = seen.run.steps.filter((st: any) => st.type === 'llm_call').pop() as any;
    expect(final.output.answerFallback).toBe('error');
    expect(final.error).toContain('upstream 529');
  });

  it('with a verify panel on the final output, sends nothing before the verdict and makes no answer call', async () => {
    const runPanel = jest.fn(async () => ({
      passed: true,
      verdict: 'pass',
      failures: [],
      checkers: [{ id: 'c-1' }],
      policy: 'all',
      cost: 0.0005,
      tokens: 40,
    }));
    const seen = await hostedChatRun({
      provider: 'anthropic',
      streams: [anthropicToolStep, anthropicText(120, ANSWER, 5)],
      agentConfig: { verify: { enabled: true, checkers: [{ providerId: 'p-anthropic', rubric: 'no account numbers' }] } },
      verifier: { runPanel },
    });

    expect(seen.tokens).toEqual([]);
    expect(seen.raw).not.toContain('Your order');
    expect(seen.done).toEqual(['run.completed']);
    // The panel judged the reply that became the answer, and no extra call
    // was made for a stream nobody would see.
    expect(seen.bodies).toHaveLength(2);
    expect(runPanel).toHaveBeenCalledWith(expect.objectContaining({ target: 'Your order ships Monday.' }), 'org-1', null);
    expect(seen.run.output).toBe('Your order ships Monday.');
  });

  it('leaves a run no hosted chat started as it was: its own reply is the answer, no extra call', async () => {
    const seen = await hostedChatRun({
      provider: 'anthropic',
      streams: [anthropicToolStep, anthropicText(120, ANSWER, 5)],
      compose: false,
    });

    expect(seen.bodies).toHaveLength(2);
    expect(seen.bodies.every((b) => Array.isArray(b.tools) && b.tools.length > 0)).toBe(true);
    expect(seen.run.output).toBe('Your order ships Monday.');
    expect(seen.run.currentStep).toBe(2);
    // No answer marks on its events: nothing about this run is new.
    const marked = seen.events.filter((e) => e.data && 'answer' in e.data);
    expect(marked).toEqual([]);
    expect(seen.run.steps.some((st: any) => st.output?.status === 'drafted')).toBe(false);
  });
});
