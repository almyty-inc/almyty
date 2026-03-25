import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentOpenAICompatController } from '../agent-openai-compat.controller';
import { AgentsService } from '../agents.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { ApiKey } from '../../../entities/api-key.entity';
import { AgentExecutionStatus } from '../../../entities/agent-execution.entity';
import * as crypto from 'crypto';

// ─── Helpers ────────────────────────────────────────────────────────────

const TEST_API_KEY = 'sk-test-key-abcdef123456';
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

function makeReq(overrides: any = {}): any {
  return {
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function makeApiKey(overrides: any = {}): any {
  return {
    id: 'key-1',
    keyHash: TEST_KEY_HASH,
    organizationId: 'org-1',
    userId: 'user-1',
    isActive: true,
    lastUsedAt: null,
    isExpired: jest.fn().mockReturnValue(false),
    ...overrides,
  };
}

function makeAgent(overrides: any = {}): any {
  return {
    id: 'agent-abc-123',
    name: 'My Test Agent',
    status: 'active',
    createdAt: new Date('2026-01-15T00:00:00Z'),
    organizationId: 'org-1',
    ...overrides,
  };
}

// ─── Test suite ─────────────────────────────────────────────────────────

describe('OpenAI Compatibility', () => {
  let controller: AgentOpenAICompatController;
  let apiKeyRepo: jest.Mocked<any>;
  let agentsService: jest.Mocked<any>;
  let executionEngine: jest.Mocked<any>;

  beforeEach(async () => {
    apiKeyRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(k => Promise.resolve(k)),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentOpenAICompatController],
      providers: [
        {
          provide: AgentsService,
          useValue: {
            getAgent: jest.fn(),
            findByName: jest.fn(),
            findAllActive: jest.fn(),
          },
        },
        {
          provide: AgentExecutionEngine,
          useValue: { execute: jest.fn() },
        },
        {
          provide: getRepositoryToken(ApiKey),
          useValue: apiKeyRepo,
        },
      ],
    }).compile();

    controller = module.get(AgentOpenAICompatController);
    agentsService = module.get(AgentsService);
    executionEngine = module.get(AgentExecutionEngine);
  });

  afterEach(() => jest.clearAllMocks());

  // ── POST /v1/chat/completions — standard response format ──────────────

  describe('POST /v1/chat/completions', () => {
    it('should return standard OpenAI response format', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent());
      executionEngine.execute.mockResolvedValue({
        id: 'exec-42',
        output: 'Hello! How can I help you today?',
        status: AgentExecutionStatus.COMPLETED,
        totalTokens: 150,
      });

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'Hello' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(res.json).toHaveBeenCalledTimes(1);
      const body = res.json.mock.calls[0][0];

      // Top-level fields required by OpenAI SDK
      expect(body.id).toBe('chatcmpl-exec-42');
      expect(body.object).toBe('chat.completion');
      expect(typeof body.created).toBe('number');
      expect(body.model).toBe('agent:agent-abc-123');

      // choices array
      expect(Array.isArray(body.choices)).toBe(true);
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].index).toBe(0);
      expect(body.choices[0].message).toEqual({
        role: 'assistant',
        content: 'Hello! How can I help you today?',
      });
      expect(body.choices[0].finish_reason).toBe('stop');

      // usage object
      expect(body.usage).toBeDefined();
      expect(typeof body.usage.prompt_tokens).toBe('number');
      expect(typeof body.usage.completion_tokens).toBe('number');
      expect(typeof body.usage.total_tokens).toBe('number');
      expect(body.usage.total_tokens).toBe(150);
      expect(body.usage.prompt_tokens + body.usage.completion_tokens).toBeLessThanOrEqual(body.usage.total_tokens + 1);
    });

    it('should set finish_reason to error when execution fails', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent());
      executionEngine.execute.mockResolvedValue({
        id: 'exec-fail',
        output: null,
        status: AgentExecutionStatus.FAILED,
        totalTokens: 0,
      });

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'Hello' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      const body = res.json.mock.calls[0][0];
      expect(body.choices[0].finish_reason).toBe('error');
    });

    it('should handle zero tokens gracefully in usage field', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent());
      executionEngine.execute.mockResolvedValue({
        id: 'exec-zero',
        output: 'response',
        status: AgentExecutionStatus.COMPLETED,
        totalTokens: 0,
      });

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'Hello' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      const body = res.json.mock.calls[0][0];
      expect(body.usage.prompt_tokens).toBe(0);
      expect(body.usage.completion_tokens).toBe(0);
      expect(body.usage.total_tokens).toBe(0);
    });

    it('should return proper streaming SSE format', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent());

      // Mock execution engine to call the onEvent callback with streaming data
      executionEngine.execute.mockImplementation(
        async (agent: any, orgId: string, userId: string | null, opts: any, onEvent?: Function) => {
          if (onEvent) {
            onEvent({
              type: 'node.output',
              data: { output: 'Hello ' },
              timestamp: Date.now(),
            });
            onEvent({
              type: 'node.completed',
              data: { chunk: 'world!' },
              timestamp: Date.now(),
            });
          }
          return {
            id: 'exec-stream',
            output: 'Hello world!',
            status: AgentExecutionStatus.COMPLETED,
            totalTokens: 50,
          };
        },
      );

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      // Verify SSE headers
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');

      // Collect all written chunks
      const chunks: string[] = res._chunks;

      // Parse SSE data lines
      const sseData = chunks
        .filter((c: string) => c.startsWith('data: '))
        .map((c: string) => {
          const raw = c.replace('data: ', '').replace(/\n\n$/, '');
          if (raw === '[DONE]') return raw;
          return JSON.parse(raw);
        });

      // First chunk should be the role announcement
      const firstChunk = sseData[0];
      expect(firstChunk.object).toBe('chat.completion.chunk');
      expect(firstChunk.choices[0].delta).toEqual({ role: 'assistant' });
      expect(firstChunk.choices[0].finish_reason).toBeNull();

      // Content chunks should have delta.content
      const contentChunks = sseData.filter(
        (d: any) => d !== '[DONE]' && d.choices?.[0]?.delta?.content,
      );
      expect(contentChunks.length).toBeGreaterThanOrEqual(1);

      // Final chunk before [DONE] should have finish_reason: "stop"
      const finalChunk = sseData.filter((d: any) => d !== '[DONE]').pop();
      expect(finalChunk.choices[0].finish_reason).toBe('stop');
      expect(finalChunk.choices[0].delta).toEqual({});

      // Last line must be "data: [DONE]"
      expect(sseData[sseData.length - 1]).toBe('[DONE]');

      // Stream should be ended
      expect(res.end).toHaveBeenCalled();
    });

    it('should handle streaming error gracefully', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent());

      executionEngine.execute.mockImplementation(
        async (agent: any, orgId: string, userId: string | null, opts: any, onEvent?: Function) => {
          throw new Error('LLM provider crashed');
        },
      );

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      const chunks: string[] = res._chunks;
      const sseData = chunks
        .filter((c: string) => c.startsWith('data: '))
        .map((c: string) => {
          const raw = c.replace('data: ', '').replace(/\n\n$/, '');
          if (raw === '[DONE]') return raw;
          return JSON.parse(raw);
        });

      // Should still send [DONE] to close the stream cleanly
      expect(sseData[sseData.length - 1]).toBe('[DONE]');

      // Should have a chunk with finish_reason: "error"
      const errorChunk = sseData.find(
        (d: any) => d !== '[DONE]' && d.choices?.[0]?.finish_reason === 'error',
      );
      expect(errorChunk).toBeDefined();

      expect(res.end).toHaveBeenCalled();
    });
  });

  // ── GET /v1/models ────────────────────────────────────────────────────

  describe('GET /v1/models', () => {
    it('should return models in OpenAI list format', async () => {
      const res = makeRes();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.findAllActive.mockResolvedValue([
        makeAgent({ id: 'agent-1', name: 'Agent One', createdAt: new Date('2026-01-10T00:00:00Z') }),
        makeAgent({ id: 'agent-2', name: 'Agent Two', createdAt: new Date('2026-02-20T00:00:00Z') }),
      ]);

      await controller.listModels(`Bearer ${TEST_API_KEY}`, res);

      expect(res.json).toHaveBeenCalledTimes(1);
      const body = res.json.mock.calls[0][0];

      // Top-level structure
      expect(body.object).toBe('list');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(2);

      // Each model entry
      for (const model of body.data) {
        expect(model.id).toMatch(/^agent:/);
        expect(model.object).toBe('model');
        expect(typeof model.created).toBe('number');
        expect(model.owned_by).toBe('almyty');
        expect(Array.isArray(model.permission)).toBe(true);
        expect(model.root).toMatch(/^agent:/);
        expect(model.parent).toBeNull();
      }

      // Specific values
      expect(body.data[0].id).toBe('agent:agent-1');
      expect(body.data[1].id).toBe('agent:agent-2');
      expect(body.data[0].created).toBe(Math.floor(new Date('2026-01-10T00:00:00Z').getTime() / 1000));
    });

    it('should return empty list when no active agents', async () => {
      const res = makeRes();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.findAllActive.mockResolvedValue([]);

      await controller.listModels(`Bearer ${TEST_API_KEY}`, res);

      const body = res.json.mock.calls[0][0];
      expect(body.object).toBe('list');
      expect(body.data).toEqual([]);
    });
  });

  // ── Authentication errors (OpenAI error format) ───────────────────────

  describe('authentication errors', () => {
    it('should handle missing authorization with OpenAI error format', async () => {
      const res = makeRes();
      const req = makeReq();

      await controller.chatCompletions(
        { model: 'agent:1', messages: [{ role: 'user', content: 'hi' }] },
        undefined as any,
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
      const body = res.json.mock.calls[0][0];

      // OpenAI SDK expects this exact structure
      expect(body.error).toBeDefined();
      expect(typeof body.error.message).toBe('string');
      expect(body.error.type).toBe('authentication_error');
      expect(body.error.code).toBe('invalid_api_key');
    });

    it('should handle invalid API key with OpenAI error format', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(null);

      await controller.chatCompletions(
        { model: 'agent:1', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer bad-key',
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
      const body = res.json.mock.calls[0][0];
      expect(body.error.type).toBe('authentication_error');
      expect(body.error.code).toBe('invalid_api_key');
    });

    it('should handle expired API key with OpenAI error format', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(
        makeApiKey({ isExpired: jest.fn().mockReturnValue(true) }),
      );

      await controller.chatCompletions(
        { model: 'agent:1', messages: [{ role: 'user', content: 'hi' }] },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
      const body = res.json.mock.calls[0][0];
      expect(body.error.type).toBe('authentication_error');
    });

    it('should handle missing auth on /v1/models endpoint', async () => {
      const res = makeRes();

      await controller.listModels(undefined as any, res);

      expect(res.status).toHaveBeenCalledWith(401);
      const body = res.json.mock.calls[0][0];
      expect(body.error.type).toBe('authentication_error');
    });
  });

  // ── Invalid model (agent not found) ───────────────────────────────────

  describe('invalid model', () => {
    it('should handle invalid model with OpenAI error format', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockRejectedValue(new Error('Not found'));
      agentsService.findByName.mockResolvedValue(null);

      await controller.chatCompletions(
        {
          model: 'agent:nonexistent-uuid',
          messages: [{ role: 'user', content: 'hi' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.code).toBe('model_not_found');
      expect(typeof body.error.message).toBe('string');
    });

    it('should handle missing model field with OpenAI error format', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());

      await controller.chatCompletions(
        { messages: [{ role: 'user', content: 'hi' }] },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.code).toBe('model_required');
    });
  });

  // ── Rate limiting ─────────────────────────────────────────────────────

  describe('rate limiting', () => {
    it('should include X-RateLimit headers on all responses', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent());
      executionEngine.execute.mockResolvedValue({
        id: 'exec-1',
        output: 'ok',
        status: AgentExecutionStatus.COMPLETED,
        totalTokens: 10,
      });

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'hi' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '60');
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Remaining',
        expect.any(String),
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-RateLimit-Reset',
        expect.any(String),
      );

      // Remaining should be a number string
      const remainingCall = res.setHeader.mock.calls.find(
        (c: any[]) => c[0] === 'X-RateLimit-Remaining',
      );
      expect(parseInt(remainingCall[1], 10)).toBeLessThanOrEqual(60);
      expect(parseInt(remainingCall[1], 10)).toBeGreaterThanOrEqual(0);

      // Reset should be a unix timestamp
      const resetCall = res.setHeader.mock.calls.find(
        (c: any[]) => c[0] === 'X-RateLimit-Reset',
      );
      const resetTs = parseInt(resetCall[1], 10);
      expect(resetTs).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should return 429 when rate limit is exceeded', async () => {
      const apiKey = makeApiKey();

      // Exhaust the rate limit by making many requests
      for (let i = 0; i < 60; i++) {
        const res = makeRes();
        const req = makeReq();

        apiKeyRepo.findOne.mockResolvedValue(apiKey);
        agentsService.getAgent.mockResolvedValue(makeAgent());
        executionEngine.execute.mockResolvedValue({
          id: `exec-${i}`,
          output: 'ok',
          status: AgentExecutionStatus.COMPLETED,
          totalTokens: 10,
        });

        await controller.chatCompletions(
          {
            model: 'agent:agent-abc-123',
            messages: [{ role: 'user', content: 'hi' }],
          },
          `Bearer ${TEST_API_KEY}`,
          req,
          res,
        );
      }

      // 61st request should be rate limited
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(apiKey);

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'hi' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(429);
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe('rate_limit_error');
      expect(body.error.code).toBe('rate_limit_exceeded');

      // Should still have rate limit headers
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', '0');
    });
  });

  // ── Input mapping ─────────────────────────────────────────────────────

  describe('input mapping', () => {
    it('should map last user message to agent input', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent());

      let capturedInput: any;
      executionEngine.execute.mockImplementation(async (agent, orgId, userId, opts) => {
        capturedInput = opts.input;
        return {
          id: 'exec-1',
          output: 'response',
          status: AgentExecutionStatus.COMPLETED,
          totalTokens: 10,
        };
      });

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'First question' },
            { role: 'assistant', content: 'First answer' },
            { role: 'user', content: 'Follow up question' },
          ],
          temperature: 0.7,
          max_tokens: 500,
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      // Should map the last user message
      expect(capturedInput.message).toBe('Follow up question');

      // Should pass all messages
      expect(capturedInput.messages).toHaveLength(4);

      // Should pass model parameters
      expect(capturedInput.temperature).toBe(0.7);
      expect(capturedInput.max_tokens).toBe(500);
      expect(capturedInput.model).toBe('agent:agent-abc-123');
    });
  });

  // ── Agent resolution ──────────────────────────────────────────────────

  describe('agent resolution', () => {
    it('should resolve agent by ID with "agent:" prefix', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent());
      executionEngine.execute.mockResolvedValue({
        id: 'exec-1',
        output: 'ok',
        status: AgentExecutionStatus.COMPLETED,
        totalTokens: 0,
      });

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'hi' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      // Should strip the "agent:" prefix and look up by ID
      expect(agentsService.getAgent).toHaveBeenCalledWith('agent-abc-123', 'org-1');
    });

    it('should fall back to name-based lookup when ID lookup fails', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockRejectedValue(new Error('Not found'));
      agentsService.findByName.mockResolvedValue(makeAgent({ name: 'my-agent' }));
      executionEngine.execute.mockResolvedValue({
        id: 'exec-1',
        output: 'ok',
        status: AgentExecutionStatus.COMPLETED,
        totalTokens: 0,
      });

      await controller.chatCompletions(
        {
          model: 'agent:my-agent',
          messages: [{ role: 'user', content: 'hi' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(agentsService.findByName).toHaveBeenCalledWith('my-agent', 'org-1');
    });

    it('should reject inactive agents', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent({ status: 'draft' }));

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'hi' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.error.message).toContain('not active');
    });
  });

  // ── API key last used tracking ────────────────────────────────────────

  describe('API key tracking', () => {
    it('should update lastUsedAt on successful chat completion', async () => {
      const res = makeRes();
      const req = makeReq();
      const apiKey = makeApiKey();

      apiKeyRepo.findOne.mockResolvedValue(apiKey);
      agentsService.getAgent.mockResolvedValue(makeAgent());
      executionEngine.execute.mockResolvedValue({
        id: 'exec-1',
        output: 'ok',
        status: AgentExecutionStatus.COMPLETED,
        totalTokens: 0,
      });

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'hi' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(apiKeyRepo.save).toHaveBeenCalled();
      expect(apiKey.lastUsedAt).toBeInstanceOf(Date);
    });

    it('should update lastUsedAt on list models', async () => {
      const res = makeRes();
      const apiKey = makeApiKey();

      apiKeyRepo.findOne.mockResolvedValue(apiKey);
      agentsService.findAllActive.mockResolvedValue([]);

      await controller.listModels(`Bearer ${TEST_API_KEY}`, res);

      expect(apiKeyRepo.save).toHaveBeenCalled();
      expect(apiKey.lastUsedAt).toBeInstanceOf(Date);
    });
  });

  // ── Internal server errors ────────────────────────────────────────────

  describe('internal server errors', () => {
    it('should return 500 with OpenAI error format on unexpected errors', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue(makeAgent());
      executionEngine.execute.mockRejectedValue(new Error('Database connection lost'));

      await controller.chatCompletions(
        {
          model: 'agent:agent-abc-123',
          messages: [{ role: 'user', content: 'hi' }],
        },
        `Bearer ${TEST_API_KEY}`,
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.error.type).toBe('api_error');
      expect(body.error.code).toBe('internal_error');
      expect(typeof body.error.message).toBe('string');
    });

    it('should return 500 with OpenAI error format on /v1/models unexpected error', async () => {
      const res = makeRes();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.findAllActive.mockRejectedValue(new Error('DB query failed'));

      await controller.listModels(`Bearer ${TEST_API_KEY}`, res);

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.error.type).toBe('api_error');
      expect(body.error.code).toBe('internal_error');
    });
  });
});
