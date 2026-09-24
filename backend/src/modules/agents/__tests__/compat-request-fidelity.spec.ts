import { ExecutionAccessService } from '../../../common/authorization/execution-access.service';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as crypto from 'crypto';

import { AgentOpenAICompatController } from '../agent-openai-compat.controller';
import { AgentAnthropicCompatController } from '../agent-anthropic-compat.controller';
import { AgentsService } from '../agents.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentOpenAIStreamHelper, USAGE_SPLIT_HEADER } from '../agent-openai-stream.helper';
import { ApiKey } from '../../../entities/api-key.entity';

/**
 * What the two compat routes do with a request, end to end.
 *
 * Every case here is a field a caller sent that the endpoint accepted and then
 * silently did nothing with: the conversation itself, the sampling, the OpenAI
 * fields with no almyty equivalent, and the way a failed stream used to end
 * exactly like a successful one.
 */

const TEST_API_KEY = 'sk-fidelity-key-123456';
const TEST_KEY_HASH = crypto.createHash('sha256').update(TEST_API_KEY).digest('hex');

function makeRes(): any {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    write: jest.fn((chunk: string) => {
      chunks.push(chunk);
    }),
    end: jest.fn(),
    headersSent: false,
    _headers: headers,
    _chunks: chunks,
  };
  return res;
}

function makeReq(): any {
  const listeners: Record<string, Function[]> = {};
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    on: jest.fn((event: string, cb: Function) => {
      (listeners[event] ||= []).push(cb);
    }),
    off: jest.fn((event: string, cb: Function) => {
      if (!listeners[event]) return;
      listeners[event] = listeners[event].filter((l) => l !== cb);
    }),
    emit: (event: string, ...args: any[]) => {
      (listeners[event] || []).forEach((cb) => cb(...args));
    },
  };
}

function makeApiKey(): any {
  return {
    id: 'key-1',
    keyHash: TEST_KEY_HASH,
    organizationId: 'org-1',
    userId: 'user-1',
    user: { id: 'user-1', isActive: true, organizationMemberships: [{ organizationId: 'org-1', isActive: true }] },
    isActive: true,
    lastUsedAt: null,
    isExpired: jest.fn().mockReturnValue(false),
  };
}

function makeAgent(): any {
  return {
    id: '0a9e2b7c-0000-4000-8000-000000000123',
    name: 'My Test Agent',
    status: 'active',
    createdAt: new Date('2026-01-15T00:00:00Z'),
    organizationId: 'org-1',
    modelConfig: { providerId: 'p1', temperature: 0.9 },
    pipeline: {
      nodes: [
        { id: 'in', type: 'input' },
        { id: 'llm', type: 'llm_call', data: { providerId: 'p1', userPromptTemplate: '{{input.message}}', temperature: 0.9 } },
        { id: 'out', type: 'output' },
      ],
      edges: [],
    },
  };
}

/** SSE frames a stream wrote, parsed. */
function sseFrames(res: any): any[] {
  return (res._chunks as string[])
    .filter((c) => c.startsWith('data: '))
    .map((c) => {
      const raw = c.replace('data: ', '').replace(/\n\n$/, '');
      return raw === '[DONE]' ? raw : JSON.parse(raw);
    });
}

describe('compat request fidelity', () => {
  let openai: AgentOpenAICompatController;
  let anthropic: AgentAnthropicCompatController;
  let apiKeyRepo: any;
  let agentsService: any;
  let executionEngine: any;

  beforeEach(async () => {
    apiKeyRepo = {
      findOne: jest.fn().mockResolvedValue(makeApiKey()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentOpenAICompatController, AgentAnthropicCompatController],
      providers: [
        { provide: ExecutionAccessService, useValue: membershipFixture().executionAccess },
        {
          provide: AgentsService,
          useValue: { getAgent: jest.fn().mockResolvedValue(makeAgent()), findByName: jest.fn(), findAllActive: jest.fn() },
        },
        { provide: AgentExecutionEngine, useValue: { execute: jest.fn() } },
        { provide: getRepositoryToken(ApiKey), useValue: apiKeyRepo },
        AgentOpenAIStreamHelper,
      ],
    }).compile();

    openai = module.get(AgentOpenAICompatController);
    anthropic = module.get(AgentAnthropicCompatController);
    agentsService = module.get(AgentsService);
    executionEngine = module.get(AgentExecutionEngine);
  });

  afterEach(() => jest.clearAllMocks());

  /** Run one OpenAI request; returns what the engine was handed and the response. */
  async function chat(body: any, execution: any = { id: 'exec-1', output: 'ok', status: 'completed', totalTokens: 30 }) {
    const res = makeRes();
    const req = makeReq();
    let captured: { agent: any; input: any } | undefined;
    executionEngine.execute.mockImplementation(async (agent: any, _org: string, _user: any, opts: any) => {
      captured = { agent, input: opts.input };
      return execution;
    });
    await openai.chatCompletions(body, `Bearer ${TEST_API_KEY}`, req, res);
    return { res, req, captured };
  }

  // ── Finding 1 ────────────────────────────────────────────────────────

  describe('the conversation reaches the agent', () => {
    it('hands the whole multi-turn conversation to the agent, not just the last line', async () => {
      // /v1/chat/completions is stateless: the SDK's chat loop, LangChain's
      // ChatOpenAI and any web chat UI resend the full history every turn.
      // Only the last user line used to survive, so the agent was amnesiac
      // with no error and no header to diagnose it from.
      const { captured } = await chat({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        messages: [
          { role: 'system', content: 'Answer only in French.' },
          { role: 'user', content: 'My name is Frane.' },
          { role: 'assistant', content: 'Enchante, Frane.' },
          { role: 'user', content: 'What is my name?' },
        ],
      });

      expect(captured!.input.message).toContain('My name is Frane.');
      expect(captured!.input.message).toContain('Enchante, Frane.');
      expect(captured!.input.message).toContain('Answer only in French.');
      expect(captured!.input.message).toContain('What is my name?');
    });

    it('binds through the field every stock agent template actually reads', async () => {
      // agent-templates.ts binds {{input.message}} in every template, so a fix
      // that parked the conversation anywhere else would reach nothing.
      const { captured } = await chat({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        messages: [
          { role: 'user', content: 'alpha' },
          { role: 'assistant', content: 'beta' },
          { role: 'user', content: 'gamma' },
        ],
      });
      expect(typeof captured!.input.message).toBe('string');
      expect(captured!.input.message).toContain('beta');
      expect(captured!.input.latestMessage).toBe('gamma');
    });

    it('leaves a single-turn request exactly as it was', async () => {
      const { captured } = await chat({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(captured!.input.message).toBe('Hello');
    });

    it('flattens content parts instead of handing a prompt an object', async () => {
      const { captured } = await chat({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'describe this' }] }],
      });
      expect(captured!.input.message).toBe('describe this');
    });
  });

  // ── Finding 2 ────────────────────────────────────────────────────────

  describe('sampling the caller asked for is honoured', () => {
    it('puts temperature 0 where the engine reads it', async () => {
      const { captured } = await chat({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
      });
      const llm = captured!.agent.pipeline.nodes.find((n: any) => n.type === 'llm_call');
      expect(llm.data.temperature).toBe(0);
      expect(captured!.agent.modelConfig.temperature).toBe(0);
    });

    it('puts max_tokens where the engine reads it', async () => {
      const { captured } = await chat({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 48,
      });
      const llm = captured!.agent.pipeline.nodes.find((n: any) => n.type === 'llm_call');
      expect(llm.data.maxTokens).toBe(48);
    });

    it('does not touch the stored agent', async () => {
      const stored = makeAgent();
      agentsService.getAgent.mockResolvedValue(stored);
      await chat({ model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }], temperature: 0 });
      expect(stored.pipeline.nodes[1].data.temperature).toBe(0.9);
      expect(stored.modelConfig.temperature).toBe(0.9);
    });

    it('leaves the agent untouched when the caller asked for nothing', async () => {
      const stored = makeAgent();
      agentsService.getAgent.mockResolvedValue(stored);
      const { captured } = await chat({ model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }] });
      expect(captured!.agent).toBe(stored);
    });
  });

  // ── Finding 3 ────────────────────────────────────────────────────────

  describe('unsupported OpenAI fields are refused by name', () => {
    it.each([
      ['tools', { tools: [{ type: 'function', function: { name: 'get_weather' } }] }],
      ['tool_choice', { tool_choice: 'auto' }],
      ['response_format', { response_format: { type: 'json_object' } }],
      ['n', { n: 3 }],
      ['stop', { stop: ['\n'] }],
      ['seed', { seed: 7 }],
      ['top_p', { top_p: 0.2 }],
      ['logprobs', { logprobs: true }],
    ])('refuses %s with a 400 that names the field', async (param, extra) => {
      const { res } = await chat({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        messages: [{ role: 'user', content: 'hi' }],
        ...(extra as any),
      });

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[res.json.mock.calls.length - 1][0];
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.code).toBe('unsupported_parameter');
      expect(body.error.param).toBe(param);
      expect(typeof body.error.message).toBe('string');
      // A refusal has to actually stop the run, not merely annotate it.
      expect(executionEngine.execute).not.toHaveBeenCalled();
    });

    it('still runs a request carrying only the defaults a client library sends', async () => {
      const { res } = await chat({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        n: 1,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
      });
      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(executionEngine.execute).toHaveBeenCalled();
    });

    it('carries param on every error body, which the OpenAI shape requires', async () => {
      const { res } = await chat({ messages: [{ role: 'user', content: 'hi' }] } as any);
      const body = res.json.mock.calls[res.json.mock.calls.length - 1][0];
      expect(body.error).toHaveProperty('param');
    });
  });

  // ── Findings 4 and 5 ─────────────────────────────────────────────────

  describe('a stream that failed does not end like one that succeeded', () => {
    it('emits an SSE frame carrying an error object when the engine throws', async () => {
      const res = makeRes();
      const req = makeReq();
      executionEngine.execute.mockRejectedValue(new Error('LLM provider crashed'));

      await openai.chatCompletions(
        { model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }], stream: true },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      const frames = sseFrames(res);
      const errorFrame = frames.find((f) => f !== '[DONE]' && f.error);
      expect(errorFrame).toBeDefined();
      expect(errorFrame.error.message).toContain('LLM provider crashed');
      expect(errorFrame.error.type).toBe('api_error');
    });

    it('never sends finish_reason "error", which is not an OpenAI value', async () => {
      const res = makeRes();
      const req = makeReq();
      executionEngine.execute.mockRejectedValue(new Error('boom'));

      await openai.chatCompletions(
        { model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }], stream: true },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      const reasons = sseFrames(res)
        .filter((f) => f !== '[DONE]')
        .flatMap((f) => (f.choices || []).map((c: any) => c.finish_reason))
        .filter((r: any) => r != null);
      expect(reasons).not.toContain('error');
      reasons.forEach((r: string) =>
        expect(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']).toContain(r),
      );
    });

    it('ends a run that came back incomplete as an error too', async () => {
      const res = makeRes();
      const req = makeReq();
      executionEngine.execute.mockResolvedValue({ id: 'e', status: 'failed', error: 'node blew up', totalTokens: 0 });

      await openai.chatCompletions(
        { model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }], stream: true },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      const errorFrame = sseFrames(res).find((f) => f !== '[DONE]' && f.error);
      expect(errorFrame).toBeDefined();
      expect(errorFrame.error.message).toContain('node blew up');
    });

    it('reports a failed non-streaming run as an error status, not a 200 with finish_reason error', async () => {
      const { res } = await chat(
        { model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }] },
        { id: 'e', status: 'failed', error: 'node blew up', totalTokens: 0, output: null },
      );
      expect(res.status).toHaveBeenCalledWith(502);
      const body = res.json.mock.calls[res.json.mock.calls.length - 1][0];
      expect(body.error.code).toBe('agent_execution_failed');
    });

    it('a successful stream still finishes with stop and [DONE]', async () => {
      const res = makeRes();
      const req = makeReq();
      executionEngine.execute.mockResolvedValue({ id: 'e', status: 'completed', output: 'ok', totalTokens: 5 });

      await openai.chatCompletions(
        { model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }], stream: true },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      const frames = sseFrames(res);
      expect(frames[frames.length - 1]).toBe('[DONE]');
      expect(frames.some((f) => f !== '[DONE]' && f.choices?.[0]?.finish_reason === 'stop')).toBe(true);
      expect(frames.some((f) => f !== '[DONE]' && f.error)).toBe(false);
    });
  });

  // ── Finding 3, stream_options ────────────────────────────────────────

  describe('stream_options.include_usage', () => {
    it('sends a final usage-bearing chunk with empty choices before [DONE]', async () => {
      const res = makeRes();
      const req = makeReq();
      executionEngine.execute.mockResolvedValue({ id: 'e', status: 'completed', output: 'ok', totalTokens: 77 });

      await openai.chatCompletions(
        {
          model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          stream_options: { include_usage: true },
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      const frames = sseFrames(res);
      const usageFrame = frames.find((f) => f !== '[DONE]' && f.usage);
      expect(usageFrame).toBeDefined();
      expect(usageFrame.choices).toEqual([]);
      expect(usageFrame.usage.total_tokens).toBe(77);
      expect(frames.indexOf(usageFrame)).toBeLessThan(frames.length - 1);
      expect(frames[frames.length - 1]).toBe('[DONE]');
    });

    it('sends no usage chunk when the caller did not ask for one', async () => {
      const res = makeRes();
      const req = makeReq();
      executionEngine.execute.mockResolvedValue({ id: 'e', status: 'completed', output: 'ok', totalTokens: 77 });

      await openai.chatCompletions(
        { model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }], stream: true },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(sseFrames(res).some((f) => f !== '[DONE]' && f.usage)).toBe(false);
    });
  });

  // ── Finding 6 ────────────────────────────────────────────────────────

  describe('usage is not invented', () => {
    it('reports the measured split, never the total apportioned 60/40', async () => {
      const { res } = await chat(
        { model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }] },
        { id: 'e', status: 'completed', output: 'ok', totalTokens: 100, inputTokens: 82, outputTokens: 18 },
      );
      const body = res.json.mock.calls[res.json.mock.calls.length - 1][0];
      expect(body.usage.total_tokens).toBe(100);
      // The numbers the provider reported, not a ratio of the total. 82/18
      // is deliberately nothing like 60/40 so an apportioning regression
      // cannot pass this by coincidence.
      expect(body.usage.prompt_tokens).toBe(82);
      expect(body.usage.completion_tokens).toBe(18);
      expect(body.usage.prompt_tokens).not.toBe(60);
      expect(body.usage.completion_tokens).not.toBe(40);
      expect(res._headers[USAGE_SPLIT_HEADER]).toBe('measured');
    });

    it('reports zeros and says unavailable for a run that recorded no split', async () => {
      const { res } = await chat(
        { model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }] },
        { id: 'e', status: 'completed', output: 'ok', totalTokens: 100 },
      );
      const body = res.json.mock.calls[res.json.mock.calls.length - 1][0];
      // A tool-only pipeline genuinely has no split. Zeros are the honest
      // answer here, and the header is what tells the caller which case
      // the zeros are.
      expect(body.usage.total_tokens).toBe(100);
      expect(body.usage.prompt_tokens).toBe(0);
      expect(body.usage.completion_tokens).toBe(0);
      expect(res._headers[USAGE_SPLIT_HEADER]).toBe('unavailable');
    });

    it('points a stream at its final usage chunk, since headers go out first', async () => {
      const res = makeRes();
      const req = makeReq();
      executionEngine.execute.mockResolvedValue({ id: 'e', status: 'completed', output: 'ok', totalTokens: 5 });
      await openai.chatCompletions(
        { model: 'agent:0a9e2b7c-0000-4000-8000-000000000123', messages: [{ role: 'user', content: 'hi' }], stream: true },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );
      // A stream must flush its headers before the run starts, so whether the
      // split was measured is not knowable at header time. 'unavailable'
      // would be a claim about the run; 'in-stream' points at where the
      // answer actually is.
      expect(res._headers[USAGE_SPLIT_HEADER]).toBe('in-stream');
    });
  });

  // ── The Anthropic route ──────────────────────────────────────────────

  describe('POST /v1/messages carries the same fields through', () => {
    async function messages(body: any) {
      const res = makeRes();
      const req = makeReq();
      let captured: { agent: any; input: any } | undefined;
      executionEngine.execute.mockImplementation(async (agent: any, _org: string, _user: any, opts: any) => {
        captured = { agent, input: opts.input };
        return { id: 'e1', status: 'completed', output: 'hi back', totalTokens: 12 };
      });
      await anthropic.messages(body, undefined as any, TEST_API_KEY, req, res);
      return { res, captured };
    }

    it('gets the system prompt to the model instead of dropping it', async () => {
      // fromAnthropicRequest lifted `system` out correctly and the controller
      // forwarded it; nothing downstream read input.systemPrompt, so the most
      // load-bearing field an Anthropic client sends never reached a model.
      const { captured } = await messages({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        max_tokens: 100,
        system: 'You are a pirate. Always say arr.',
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(captured!.input.message).toContain('You are a pirate. Always say arr.');
      expect(captured!.input.systemPrompt).toBe('You are a pirate. Always say arr.');
    });

    it('gets the whole conversation to the model', async () => {
      const { captured } = await messages({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        max_tokens: 100,
        messages: [
          { role: 'user', content: 'My name is Frane.' },
          { role: 'assistant', content: 'Hello Frane.' },
          { role: 'user', content: 'What is my name?' },
        ],
      });
      expect(captured!.input.message).toContain('My name is Frane.');
      expect(captured!.input.message).toContain('Hello Frane.');
    });

    it('honours temperature and max_tokens', async () => {
      const { captured } = await messages({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        max_tokens: 64,
        temperature: 0,
        messages: [{ role: 'user', content: 'hello' }],
      });
      const llm = captured!.agent.pipeline.nodes.find((n: any) => n.type === 'llm_call');
      expect(llm.data.temperature).toBe(0);
      expect(llm.data.maxTokens).toBe(64);
    });

    it('says unavailable when the run recorded no split', async () => {
      const { res } = await messages({
        model: 'agent:0a9e2b7c-0000-4000-8000-000000000123',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(res._headers[USAGE_SPLIT_HEADER]).toBe('unavailable');
    });
  });
});
