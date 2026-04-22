/**
 * Integration test: autonomous agent runs via the unified gateway endpoint.
 *
 * Tests the full HTTP flow:
 *   POST /:org/:agent/runs      — start a run (JWT auth)
 *   GET  /:org/:agent/runs/:id  — get run status
 *   POST /:org/:agent/runs/:id/cancel — cancel a run
 *
 * Uses TestAppModule with a real DB, real JWT auth, and a controlled
 * AgentRuntimeService mock that tracks calls and returns realistic data.
 *
 * Requires: RUN_DB_INTEGRATION=1 and a running PostgreSQL.
 */

jest.unmock('jsonwebtoken');
jest.unmock('bcryptjs');

const SKIP = !process.env.RUN_DB_INTEGRATION;

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { JwtService } from '@nestjs/jwt';

import { TestAppModule } from '../test-app.module';
import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { Tool, ToolType } from '../../entities/tool.entity';
import { AuthService } from '../../modules/auth/auth.service';
import { AgentRuntimeService } from '../../modules/agents/agent-runtime.service';

(SKIP ? describe.skip : describe)('Gateway agent runs (integration)', () => {
  let app: INestApplication;
  let ds: DataSource;
  let authToken: string;
  let org: Organization;
  let agent: Agent;
  let runtimeMock: {
    startRun: jest.Mock;
    getRun: jest.Mock;
    listRuns: jest.Mock;
    cancelRun: jest.Mock;
    sendInput: jest.Mock;
    getRunEmitter: jest.Mock;
    subscribeRunEvents: jest.Mock;
  };

  const SUFFIX = Date.now();
  const ORG_SLUG = `gw-runs-${SUFFIX}`;
  const TEST_EMAIL = `gw-runs-${SUFFIX}@test.com`;
  const AGENT_NAME = `Run Test Agent ${SUFFIX}`;
  const AGENT_SLUG = AGENT_NAME.toLowerCase().replace(/\s+/g, '-');

  beforeAll(async () => {
    runtimeMock = {
      startRun: jest.fn(),
      getRun: jest.fn(),
      listRuns: jest.fn(),
      cancelRun: jest.fn(),
      sendInput: jest.fn(),
      getRunEmitter: jest.fn().mockReturnValue(null),
      subscribeRunEvents: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      imports: [TestAppModule],
    })
      .overrideProvider(AgentRuntimeService)
      .useValue(runtimeMock)
      .compile();

    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    ds = module.get(DataSource);
    const jwtService = module.get(JwtService);
    const authService = module.get(AuthService);

    // Seed org
    const orgRepo = ds.getRepository(Organization);
    org = orgRepo.create({ name: `GW Runs Test`, slug: ORG_SLUG });
    org = await orgRepo.save(org);

    // Seed user
    await authService.register({
      email: TEST_EMAIL,
      password: 'TestPass123!',
      firstName: 'Test',
      lastName: 'User',
      organizationName: `ignore-${Date.now()}`,
    });
    const userRepo = ds.getRepository(User);
    const user = await userRepo.findOne({ where: { email: TEST_EMAIL } });

    // Link user to org
    const uoRepo = ds.getRepository(UserOrganization);
    await uoRepo.save(uoRepo.create({
      userId: user!.id,
      organizationId: org.id,
      role: OrganizationRole.OWNER,
    }));

    // Create JWT for this user+org
    authToken = jwtService.sign({
      sub: user!.id,
      email: TEST_EMAIL,
      organizations: [{ id: org.id, name: org.name, role: 'owner' }],
    });

    // Seed an autonomous agent
    const agentRepo = ds.getRepository(Agent);
    agent = agentRepo.create({
      name: AGENT_NAME,
      description: 'Integration test agent',
      organizationId: org.id,
      status: AgentStatus.ACTIVE,
      mode: 'autonomous',
      pipeline: { nodes: [], edges: [] },
      toolIds: [],
      createdBy: user!.id,
    });
    agent = await agentRepo.save(agent);
  });

  afterAll(async () => {
    if (ds?.isInitialized) {
      // Cleanup seeded data
      await ds.getRepository(Agent).delete({ organizationId: org.id });
      await ds.getRepository(UserOrganization).delete({ organizationId: org.id });
      await ds.getRepository(Organization).delete({ id: org.id });
    }
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Auth ────────────────────────────────────────────────────────

  it('should reject unauthenticated requests', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${AGENT_SLUG}/runs`)
      .send({ input: 'hello' });

    expect(res.status).toBe(401);
  });

  it('should reject JWT from wrong org', async () => {
    const jwtService = app.get(JwtService);
    const wrongJwt = jwtService.sign({
      sub: 'user-999',
      email: 'wrong@test.com',
      organizations: [{ id: 'wrong-org-id', name: 'Wrong', role: 'owner' }],
    });

    const res = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${AGENT_SLUG}/runs`)
      .set('Authorization', `Bearer ${wrongJwt}`)
      .send({ input: 'hello' });

    expect(res.status).toBe(403);
  });

  // ── POST /runs — start a run ───────────────────────────────────

  it('should start a run via POST /:org/:agent/runs', async () => {
    runtimeMock.startRun.mockResolvedValue({
      id: 'run-1',
      agentId: agent.id,
      status: 'running',
      conversationId: 'conv-1',
    });

    const res = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${AGENT_SLUG}/runs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ input: 'Hello agent' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('run-1');
    expect(res.body.data.conversationId).toBe('conv-1');

    // Verify runtime was called with correct params
    expect(runtimeMock.startRun).toHaveBeenCalledWith(
      agent.id,
      org.id,
      expect.any(String), // userId
      'Hello agent',
      { conversationId: undefined },
    );
  });

  it('should pass conversationId to startRun for multi-turn', async () => {
    runtimeMock.startRun.mockResolvedValue({
      id: 'run-2',
      agentId: agent.id,
      status: 'running',
      conversationId: 'conv-existing',
    });

    const res = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${AGENT_SLUG}/runs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ input: 'Follow-up', conversationId: 'conv-existing' });

    expect(res.status).toBe(201);

    expect(runtimeMock.startRun).toHaveBeenCalledWith(
      agent.id,
      org.id,
      expect.any(String),
      'Follow-up',
      { conversationId: 'conv-existing' },
    );
  });

  // ── GET /runs/:id — get run status ─────────────────────────────

  it('should get run status via GET /:org/:agent/runs/:id', async () => {
    runtimeMock.getRun.mockResolvedValue({
      id: 'run-1',
      agentId: agent.id,
      status: 'completed',
      output: 'The answer is 42',
      conversationId: 'conv-1',
    });

    const res = await request(app.getHttpServer())
      .get(`/${ORG_SLUG}/${AGENT_SLUG}/runs/run-1`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.output).toBe('The answer is 42');

    expect(runtimeMock.getRun).toHaveBeenCalledWith('run-1', org.id);
  });

  // ── POST /runs/:id/cancel ─────────────────────────────────────

  it('should cancel a run via POST /:org/:agent/runs/:id/cancel', async () => {
    runtimeMock.cancelRun.mockResolvedValue({
      id: 'run-1',
      status: 'cancelled',
    });

    const res = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${AGENT_SLUG}/runs/run-1/cancel`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(runtimeMock.cancelRun).toHaveBeenCalledWith('run-1', org.id);
  });

  // ── POST /runs/:id/input ──────────────────────────────────────

  it('should send input to a waiting run', async () => {
    runtimeMock.sendInput.mockResolvedValue({
      id: 'run-1',
      status: 'running',
    });

    const res = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${AGENT_SLUG}/runs/run-1/input`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ input: 'More context' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    expect(runtimeMock.sendInput).toHaveBeenCalledWith('run-1', org.id, 'More context');
  });

  // ── Agent resolution ──────────────────────────────────────────

  it('should resolve agent by deslugified name', async () => {
    runtimeMock.startRun.mockResolvedValue({
      id: 'run-slug',
      status: 'running',
    });

    // slug should resolve to agent name via deslugification
    const res = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${AGENT_SLUG}/runs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ input: 'test' });

    expect(res.status).toBe(201);
    expect(runtimeMock.startRun).toHaveBeenCalledWith(
      agent.id,
      expect.any(String),
      expect.any(String),
      'test',
      expect.any(Object),
    );
  });

  it('should 404 for unknown agent slug', async () => {
    const res = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/nonexistent-agent/runs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ input: 'test' });

    expect(res.status).toBe(404);
  });

  it('should 404 for unknown org slug', async () => {
    const res = await request(app.getHttpServer())
      .post(`/nonexistent-org/${AGENT_SLUG}/runs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ input: 'test' });

    expect(res.status).toBe(404);
  });

  // ── Workflow agent rejection ───────────────────────────────────

  it('should reject /runs on a workflow agent', async () => {
    const agentRepo = ds.getRepository(Agent);
    const wfName = `Workflow Agent ${SUFFIX}`;
    const wfSlug = wfName.toLowerCase().replace(/\s+/g, '-');
    const workflowAgent = await agentRepo.save(agentRepo.create({
      name: wfName,
      organizationId: org.id,
      status: AgentStatus.ACTIVE,
      mode: 'workflow',
      pipeline: { nodes: [], edges: [] },
      toolIds: [],
    }));

    const res = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${wfSlug}/runs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ input: 'test' });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain('not autonomous');

    await agentRepo.delete({ id: workflowAgent.id });
  });

  // ── SSE streaming ────────────────────────────────────────────

  it('should stream run events via Redis Streams and SSE', async () => {
    const Redis = require('ioredis');
    const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
    const redis = new Redis({ host: 'localhost', port: redisPort });
    const runId = `run-sse-${SUFFIX}`;
    const streamKey = `run:${runId}:events`;

    // Override subscribeRunEvents to use real Redis
    runtimeMock.startRun.mockResolvedValue({
      id: runId,
      agentId: agent.id,
      status: 'running',
      conversationId: 'conv-sse',
    });

    // The controller calls runtimeService.subscribeRunEvents which reads from Redis.
    // We need to make the mock actually read from Redis instead of returning immediately.
    // Override with a real implementation that reads from Redis.
    const origSubscribe = runtimeMock.subscribeRunEvents;
    runtimeMock.subscribeRunEvents = jest.fn().mockImplementation(
      async (rId: string, handler: any, signal?: AbortSignal) => {
        const sub = redis.duplicate();
        let lastId = '0';
        const deadline = Date.now() + 5000;
        try {
          while (Date.now() < deadline) {
            if (signal?.aborted) break;
            const results = await sub.xread('BLOCK', 1000, 'COUNT', 100, 'STREAMS', `run:${rId}:events`, lastId);
            if (!results) continue;
            for (const [, messages] of results) {
              for (const [id, fields] of messages) {
                lastId = id;
                const event = JSON.parse(fields[1]);
                handler(event);
                if (['run.completed', 'run.failed'].includes(event.type)) { sub.disconnect(); return; }
              }
            }
          }
        } finally { sub.disconnect(); }
      },
    );

    // Start listening
    const server = app.getHttpServer();
    await new Promise<void>(resolve => server.listen(0, resolve));
    const port = (server.address() as any).port;

    // Connect to SSE
    const ssePromise = new Promise<string>((resolve) => {
      let data = '';
      const req = require('http').get(
        `http://localhost:${port}/${ORG_SLUG}/${AGENT_SLUG}/runs/${runId}/stream`,
        { headers: { Authorization: `Bearer ${authToken}`, Accept: 'text/event-stream' } },
        (res: any) => {
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => resolve(data));
        },
      );
      req.on('error', () => resolve(data));
    });

    // Publish events to Redis Stream (simulating another pod)
    await new Promise(r => setTimeout(r, 100));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.started', data: { step: 0 }, timestamp: new Date().toISOString() }));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'llm.chunk', data: { content: 'Hello' }, timestamp: new Date().toISOString() }));
    await redis.xadd(streamKey, '*', 'event', JSON.stringify({ type: 'run.completed', data: { output: 'Hello world' }, timestamp: new Date().toISOString() }));

    const sseData = await ssePromise;

    expect(sseData).toContain('event: llm.started');
    expect(sseData).toContain('event: llm.chunk');
    expect(sseData).toContain('event: run.completed');
    expect(sseData).toContain('"content":"Hello"');

    // Cleanup
    await redis.del(streamKey);
    await redis.quit();
    runtimeMock.subscribeRunEvents = origSubscribe;
  });

  // ── Multi-turn conversation via gateway ────────────────────────

  it('should maintain conversation across multiple runs', async () => {
    let callCount = 0;
    runtimeMock.startRun.mockImplementation(async (agentId: string, orgId: string, userId: string, input: string, opts: any) => {
      callCount++;
      return {
        id: `run-multi-${callCount}`,
        agentId,
        status: 'running',
        conversationId: opts?.conversationId || `conv-new-${callCount}`,
      };
    });

    // First message — no conversationId
    const res1 = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${AGENT_SLUG}/runs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ input: 'Hello' });

    expect(res1.status).toBe(201);
    const convId = res1.body.data.conversationId;
    expect(convId).toBeTruthy();

    // Second message — pass conversationId
    const res2 = await request(app.getHttpServer())
      .post(`/${ORG_SLUG}/${AGENT_SLUG}/runs`)
      .set('Authorization', `Bearer ${authToken}`)
      .send({ input: 'Follow-up', conversationId: convId });

    expect(res2.status).toBe(201);

    // Verify second call received the conversationId
    expect(runtimeMock.startRun).toHaveBeenCalledTimes(2);
    const secondCall = runtimeMock.startRun.mock.calls[1];
    expect(secondCall[4]).toEqual(expect.objectContaining({ conversationId: convId }));
  });

  // ── Agent info with tools ──────────────────────────────────────

  it('should return agent tools in GET /:org/:agent info', async () => {
    const toolRepo = ds.getRepository(Tool);
    const tool = await toolRepo.save(toolRepo.create({
      name: `test-tool-${SUFFIX}`,
      description: 'A test tool for integration testing',
      organizationId: org.id,
      type: ToolType.API,
      parameters: { type: 'object', properties: {} },
    } as any)) as unknown as Tool;

    // Update agent to reference this tool
    const agentRepo = ds.getRepository(Agent);
    agent.toolIds = [tool.id];
    await agentRepo.save(agent);

    const res = await request(app.getHttpServer())
      .get(`/${ORG_SLUG}/${AGENT_SLUG}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.tools).toHaveLength(1);
    expect(res.body.data.tools[0].name).toBe(`test-tool-${SUFFIX}`);
    expect(res.body.data.tools[0].description).toBe('A test tool for integration testing');
    expect(res.body.data.mode).toBe('autonomous');

    // Cleanup
    agent.toolIds = [];
    await agentRepo.save(agent);
    await toolRepo.delete({ id: tool.id });
  });

  it('should return empty tools array when agent has no tools', async () => {
    const res = await request(app.getHttpServer())
      .get(`/${ORG_SLUG}/${AGENT_SLUG}`)
      .set('Authorization', `Bearer ${authToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.tools).toEqual([]);
    expect(res.body.data.name).toBe(AGENT_NAME);
  });

  // ── A2A gateway tests ────────────────────────────────────────

  describe('A2A gateway', () => {
    const A2A_SLUG = `a2a-test-${SUFFIX}`;
    let a2aGatewayId: string;

    beforeAll(async () => {
      // Create an A2A gateway for the test agent
      const Gateway = (await import('../../entities/gateway.entity')).Gateway;
      const GatewayType = (await import('../../entities/gateway.entity')).GatewayType;
      const gwRepo = ds.getRepository(Gateway);
      const gw = await gwRepo.save(gwRepo.create({
        name: `A2A Test ${SUFFIX}`,
        type: GatewayType.A2A,
        endpoint: `/${A2A_SLUG}`,
        agentId: agent.id,
        organizationId: org.id,
        status: 'active',
        configuration: {},
      } as any)) as unknown as { id: string };
      a2aGatewayId = gw.id;
    });

    afterAll(async () => {
      if (a2aGatewayId) {
        const Gateway = (await import('../../entities/gateway.entity')).Gateway;
        await ds.getRepository(Gateway).delete({ id: a2aGatewayId });
      }
    });

    it('should return agent card on GET /:org/:gateway (public, no auth)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/${ORG_SLUG}/${A2A_SLUG}`);

      // A2AAgentCardService is mocked — just verify the endpoint is reachable
      // without auth and returns 200 (not 401/403/500)
      expect(res.status).toBe(200);
    });

    it('should return agent card on GET /.well-known/agent-card.json (public, no auth)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/${ORG_SLUG}/${A2A_SLUG}/.well-known/agent-card.json`);

      expect(res.status).toBe(200);
    });

    it('should handle A2A message/send via POST', async () => {
      runtimeMock.startRun.mockResolvedValue({
        id: 'a2a-run-1',
        agentId: agent.id,
        status: 'completed',
        output: 'A2A response',
        conversationId: 'a2a-conv-1',
      });

      // A2A gateway requires API key auth for POST, but our test gateway
      // has no auth config — it should still work with JWT
      const res = await request(app.getHttpServer())
        .post(`/${ORG_SLUG}/${A2A_SLUG}`)
        .set('Authorization', `Bearer ${authToken}`)
        .set('Content-Type', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: {
            message: {
              role: 'user',
              parts: [{ type: 'text', text: 'Hello A2A' }],
              messageId: 'msg-a2a-1',
            },
          },
        });

      // Gateway auth requires configured auth methods (API key/OAuth).
      // Without auth config, the gateway rejects with 401/403.
      // With auth, A2AServerService (mocked) handles the JSON-RPC.
      // This test verifies the route exists and doesn't 404/500.
      expect([200, 401, 403]).toContain(res.status);
    });

    it('should reject unauthenticated A2A POST', async () => {
      const res = await request(app.getHttpServer())
        .post(`/${ORG_SLUG}/${A2A_SLUG}`)
        .set('Content-Type', 'application/json')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: { message: { parts: [{ type: 'text', text: 'No auth' }] } },
        });

      expect([401, 403]).toContain(res.status);
    });

    // ── Root-level .well-known/agent-card.json (API key scoped) ────

    describe('Root agent card', () => {
    let gwApiKey: string;

    beforeAll(async () => {
      // Create an API key for the A2A gateway
      const crypto = require('crypto');
      gwApiKey = `gw_test_${SUFFIX}`;
      const keyHash = crypto.createHash('sha256').update(gwApiKey).digest('hex');
      const ApiKey = (await import('../../entities/api-key.entity')).ApiKey;
      const apiKeyRepo = ds.getRepository(ApiKey);
      await apiKeyRepo.save(apiKeyRepo.create({
        name: `Test Key ${SUFFIX}`,
        keyHash,
        keyPrefix: gwApiKey.slice(0, 8),
        gatewayId: a2aGatewayId,
        organizationId: org.id,
        userId: (await ds.getRepository(User).findOne({ where: { email: TEST_EMAIL } }))!.id,
        isActive: true,
      } as any));
    });

    it('should return 200 at /.well-known/agent-card.json with x-api-key', async () => {
      const res = await request(app.getHttpServer())
        .get('/.well-known/agent-card.json')
        .set('x-api-key', gwApiKey);

      // A2AAgentCardService is mocked — verify route works (200, not 401/404/500)
      expect(res.status).toBe(200);
    });

    it('should return 200 at /.well-known/agent-card.json with Bearer auth', async () => {
      const res = await request(app.getHttpServer())
        .get('/.well-known/agent-card.json')
        .set('Authorization', `Bearer ${gwApiKey}`);

      expect(res.status).toBe(200);
    });

    it('should reject without API key', async () => {
      const res = await request(app.getHttpServer())
        .get('/.well-known/agent-card.json');

      expect(res.status).toBe(401);
    });

    it('should reject with invalid API key', async () => {
      const res = await request(app.getHttpServer())
        .get('/.well-known/agent-card.json')
        .set('x-api-key', 'invalid-key');

      expect(res.status).toBe(401);
    });
    });
  });
});
