import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication, NotFoundException } from '@nestjs/common';
import request from 'supertest';
import * as crypto from 'crypto';

import { ApiKey } from '../../../entities/api-key.entity';
import { AgentsService } from '../agents.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentAnthropicCompatController } from '../agent-anthropic-compat.controller';
import { AgentOpenAICompatController } from '../agent-openai-compat.controller';
import { AgentOpenAIStreamHelper } from '../agent-openai-stream.helper';
import { COMPAT_RATE_LIMIT_RPM } from '../compat-rate-limit.helper';

// POST /v1/messages carried no @Throttle and no per-key counter, while its
// OpenAI sibling ran a Redis-backed per-key window and emitted the
// X-RateLimit-* headers. Only the global 100/60s default stood between a valid
// key and unbounded agent runs on the org's account. Both routes authenticate
// the same api-keys and spend the same budget, so they share one limiter.
describe('compat-route rate limit parity', () => {
  const TOKEN = 'ak_test_key';
  const keyHash = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const apiKeyRow = {
    id: 'k1',
    organizationId: 'org-1',
    userId: 'u1',
    isActive: true,
    isExpired: () => false,
  };
  const agent = { id: 'a1', name: 'Test', status: 'active', organizationId: 'org-1' };
  const execution = { id: 'e1', output: 'hi', status: 'completed', totalTokens: 1 };

  const buildApp = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentAnthropicCompatController, AgentOpenAICompatController],
      providers: [
        {
          provide: AgentsService,
          useValue: {
            getAgent: jest.fn(async () => agent),
            findByName: jest.fn(async () => agent),
            getAgents: jest.fn(async () => ({ agents: [agent] })),
          },
        },
        { provide: AgentExecutionEngine, useValue: { execute: jest.fn(async () => execution) } },
        { provide: AgentOpenAIStreamHelper, useValue: { stream: jest.fn() } },
        {
          provide: getRepositoryToken(ApiKey),
          useValue: {
            findOne: jest.fn(async ({ where }: any) => (where.keyHash === keyHash ? apiKeyRow : null)),
            update: jest.fn(async () => ({})),
          },
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return app;
  };

  let app: INestApplication;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app?.close();
  });

  const post = () =>
    request(app.getHttpServer())
      .post('/v1/messages')
      .set('x-api-key', TOKEN)
      .send({
        model: `agent:${agent.id}`,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      });

  it('emits the rate-limit headers the OpenAI route emits', async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe(String(COMPAT_RATE_LIMIT_RPM));
    expect(res.headers['x-ratelimit-remaining']).toBe(String(COMPAT_RATE_LIMIT_RPM - 1));
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('counts down per key across requests', async () => {
    await post();
    const second = await post();
    expect(second.headers['x-ratelimit-remaining']).toBe(String(COMPAT_RATE_LIMIT_RPM - 2));
  });

  it('refuses the request that exhausts the per-key window, in the Anthropic error shape', async () => {
    for (let i = 0; i < COMPAT_RATE_LIMIT_RPM; i++) {
      await post();
    }

    const refused = await post();

    expect(refused.status).toBe(429);
    expect(refused.body.type).toBe('error');
    expect(refused.body.error.type).toBe('rate_limit_error');
    expect(refused.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('does not let one key spend another key window', async () => {
    for (let i = 0; i < COMPAT_RATE_LIMIT_RPM; i++) {
      await post();
    }
    expect((await post()).status).toBe(429);

    // A second key is a separate bucket.
    const otherHash = crypto.createHash('sha256').update('ak_other').digest('hex');
    const repo: any = app.get(getRepositoryToken(ApiKey));
    repo.findOne.mockImplementation(async ({ where }: any) =>
      where.keyHash === otherHash ? { ...apiKeyRow, id: 'k2' } : null,
    );

    const other = await request(app.getHttpServer())
      .post('/v1/messages')
      .set('x-api-key', 'ak_other')
      .send({ model: `agent:${agent.id}`, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

    expect(other.status).toBe(200);
    expect(other.headers['x-ratelimit-remaining']).toBe(String(COMPAT_RATE_LIMIT_RPM - 1));
  });
});
