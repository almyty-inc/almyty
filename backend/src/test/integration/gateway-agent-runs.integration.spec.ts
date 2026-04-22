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
});
