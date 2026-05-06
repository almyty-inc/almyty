import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { AgentOpenAICompatController } from '../agent-openai-compat.controller';
import { AgentsService } from '../agents.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentOpenAIStreamHelper } from '../agent-openai-stream.helper';
import { ApiKey } from '../../../entities/api-key.entity';
import * as crypto from 'crypto';

// ─── Helpers ────────────────────────────────────────────────────────────

function makeRes(): any {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    headersSent: false,
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
    keyHash: crypto.createHash('sha256').update('test-key-123').digest('hex'),
    organizationId: 'org-1',
    userId: 'user-1',
    isActive: true,
    lastUsedAt: null,
    isExpired: jest.fn().mockReturnValue(false),
    ...overrides,
  };
}

// ─── Test suite ─────────────────────────────────────────────────────────

describe('AgentOpenAICompatController', () => {
  let controller: AgentOpenAICompatController;
  let apiKeyRepo: jest.Mocked<any>;
  let agentsService: jest.Mocked<any>;
  let executionEngine: jest.Mocked<any>;

  beforeEach(async () => {
    apiKeyRepo = {
      findOne: jest.fn(),
      save: jest.fn().mockImplementation(k => Promise.resolve(k)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentOpenAICompatController],
      providers: [
        { provide: AgentsService, useValue: { getAgent: jest.fn(), findByName: jest.fn(), findAllActive: jest.fn() } },
        { provide: AgentExecutionEngine, useValue: { execute: jest.fn() } },
        { provide: getRepositoryToken(ApiKey), useValue: apiKeyRepo },
        { provide: AgentOpenAIStreamHelper, useValue: { handleSync: jest.fn(), handleStreaming: jest.fn() } },
      ],
    }).compile();

    controller = module.get(AgentOpenAICompatController);
    agentsService = module.get(AgentsService);
    executionEngine = module.get(AgentExecutionEngine);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Request body size validation ────────────────────────────────────

  describe('request body size validation', () => {
    it('should reject body larger than 1MB', async () => {
      const res = makeRes();
      const req = makeReq();
      const bigBody = { model: 'agent:1', messages: [{ role: 'user', content: 'x'.repeat(1.1 * 1024 * 1024) }] };

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());

      await controller.chatCompletions(bigBody, 'Bearer test-key-123', req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('exceeds maximum') }),
        }),
      );
    });
  });

  // ── Messages validation ─────────────────────────────────────────────

  describe('messages validation', () => {
    it('should reject missing messages array', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());

      await controller.chatCompletions(
        { model: 'agent:1' },
        'Bearer test-key-123',
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('messages') }),
        }),
      );
    });

    it('should reject too many messages (> 100)', async () => {
      const res = makeRes();
      const req = makeReq();
      const messages = Array.from({ length: 101 }, (_, i) => ({
        role: 'user',
        content: `Message ${i}`,
      }));

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());

      await controller.chatCompletions(
        { model: 'agent:1', messages },
        'Bearer test-key-123',
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('exceeds maximum') }),
        }),
      );
    });

    it('should reject a message with content > 100KB', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());

      await controller.chatCompletions(
        {
          model: 'agent:1',
          messages: [{ role: 'user', content: 'x'.repeat(101 * 1024) }],
        },
        'Bearer test-key-123',
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('content length') }),
        }),
      );
    });

    it('should reject a message without role', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());

      await controller.chatCompletions(
        {
          model: 'agent:1',
          messages: [{ content: 'hello' }],
        },
        'Bearer test-key-123',
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ message: expect.stringContaining('role') }),
        }),
      );
    });
  });

  // ── Authentication ──────────────────────────────────────────────────

  describe('authentication', () => {
    it('should return 401 for missing Authorization header', async () => {
      const res = makeRes();
      const req = makeReq();

      await controller.chatCompletions(
        { model: 'agent:1', messages: [{ role: 'user', content: 'hi' }] },
        undefined as any,
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should return 401 for invalid API key', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(null);

      await controller.chatCompletions(
        { model: 'agent:1', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer invalid-key',
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('should return 401 for expired API key', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey({ isExpired: jest.fn().mockReturnValue(true) }));

      await controller.chatCompletions(
        { model: 'agent:1', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer test-key-123',
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  // ── Rate limit headers ──────────────────────────────────────────────

  describe('rate limit headers', () => {
    it('should set rate limit headers on successful request', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockResolvedValue({
        id: 'agent-1',
        name: 'Test',
        status: 'active',
      });
      executionEngine.execute.mockResolvedValue({
        id: 'exec-1',
        output: 'Hello!',
        status: 'completed',
        totalTokens: 50,
      });

      await controller.chatCompletions(
        { model: 'agent:agent-1', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer test-key-123',
        req,
        res,
      );

      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', '60');
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
      expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
    });
  });

  // ── HTTP status codes ───────────────────────────────────────────────

  describe('HTTP status codes', () => {
    it('should return 404 when agent is not found', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      agentsService.getAgent.mockRejectedValue(new NotFoundException('Not found'));
      agentsService.findByName.mockResolvedValue(null);

      await controller.chatCompletions(
        { model: 'agent:nonexistent', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer test-key-123',
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should return 400 when model is missing', async () => {
      const res = makeRes();
      const req = makeReq();

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());

      await controller.chatCompletions(
        { messages: [{ role: 'user', content: 'hi' }] },
        'Bearer test-key-123',
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // ── lastUsedAt throttling + partial update ─────────────────────────

  describe('lastUsedAt throttling', () => {
    function setupHappyPath() {
      agentsService.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Test', status: 'active' });
      executionEngine.execute.mockResolvedValue({
        id: 'exec-1',
        output: 'Hello!',
        status: 'completed',
        totalTokens: 50,
      });
    }

    it('uses partial update() instead of full save() for lastUsedAt', async () => {
      setupHappyPath();
      apiKeyRepo.findOne.mockResolvedValue(makeApiKey({ lastUsedAt: null }));

      await controller.chatCompletions(
        { model: 'agent:agent-1', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer test-key-123',
        makeReq(),
        makeRes(),
      );

      expect(apiKeyRepo.update).toHaveBeenCalledWith(
        { id: 'key-1' },
        expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      );
      expect(apiKeyRepo.save).not.toHaveBeenCalled();
    });

    it('skips the update when lastUsedAt is within the throttle window', async () => {
      setupHappyPath();
      const recent = new Date(Date.now() - 5_000); // 5s ago
      apiKeyRepo.findOne.mockResolvedValue(makeApiKey({ lastUsedAt: recent }));

      await controller.chatCompletions(
        { model: 'agent:agent-1', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer test-key-123',
        makeReq(),
        makeRes(),
      );

      expect(apiKeyRepo.update).not.toHaveBeenCalled();
    });

    it('does the update once the throttle window has passed', async () => {
      setupHappyPath();
      const old = new Date(Date.now() - 90_000); // 90s ago
      apiKeyRepo.findOne.mockResolvedValue(makeApiKey({ lastUsedAt: old }));

      await controller.chatCompletions(
        { model: 'agent:agent-1', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer test-key-123',
        makeReq(),
        makeRes(),
      );

      expect(apiKeyRepo.update).toHaveBeenCalledTimes(1);
    });
  });

  // ── resolveAgent error narrowing ───────────────────────────────────

  describe('resolveAgent error narrowing', () => {
    it('rethrows non-NotFoundException errors instead of falling through to findByName', async () => {
      apiKeyRepo.findOne.mockResolvedValue(makeApiKey());
      const dbErr = new Error('connection refused');
      agentsService.getAgent.mockRejectedValue(dbErr);

      const res = makeRes();
      await controller.chatCompletions(
        { model: 'agent:agent-1', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer test-key-123',
        makeReq(),
        res,
      );

      // Real DB errors must NOT be misreported as 404
      expect(res.status).toHaveBeenCalledWith(500);
      expect(agentsService.findByName).not.toHaveBeenCalled();
    });
  });

  // ── Rate-limit map bound ───────────────────────────────────────────

  describe('requestCounts map cap', () => {
    it('does not grow past MAX_TRACKED_KEYS even with key churn', async () => {
      // Reach into the private map and pre-populate it past the cap. Then
      // hit the controller with a fresh key id and assert eviction kicked in.
      const map: Map<string, { count: number; resetAt: number }> = (controller as any).requestCounts;
      map.clear();

      // Fill with already-expired entries — these should be cleared on next call
      for (let i = 0; i < 10_001; i++) {
        map.set(`old-${i}`, { count: 1, resetAt: Date.now() - 1000 });
      }
      expect(map.size).toBe(10_001);

      apiKeyRepo.findOne.mockResolvedValue(makeApiKey({ id: 'fresh-key' }));
      agentsService.getAgent.mockResolvedValue({ id: 'agent-1', name: 'Test', status: 'active' });
      executionEngine.execute.mockResolvedValue({
        id: 'exec-1', output: 'hi', status: 'completed', totalTokens: 1,
      });

      await controller.chatCompletions(
        { model: 'agent:agent-1', messages: [{ role: 'user', content: 'hi' }] },
        'Bearer test-key-123',
        makeReq(),
        makeRes(),
      );

      expect(map.size).toBeLessThanOrEqual(10_000);
      expect(map.has('fresh-key')).toBe(true);
    });
  });
});
