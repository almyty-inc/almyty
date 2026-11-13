import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as crypto from 'crypto';

import { listenOnLoopback } from '../../../test/http';
import { ApiKey } from '../../../entities/api-key.entity';
import { GatewayKind, GatewayStatus } from '../../../entities/gateway.entity';
import { ExecutionAccessService } from '../../../common/authorization/execution-access.service';
import { AgentsService } from '../agents.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { CompatAgentInvoker } from '../compat-agent-invoker.service';
import { AgentOpenAIStreamHelper } from '../agent-openai-stream.helper';
import { AgentOpenAICompatController } from '../agent-openai-compat.controller';
import { AgentAnthropicCompatController } from '../agent-anthropic-compat.controller';
import { AgentApiAccessService } from '../agent-api-access.service';

/**
 * The Integration snippet names the agent as `agent:<name-slug>`; the
 * staging gate found an agent key worked only with `agent:<uuid>`. The slug
 * is now read as a check on the agent the presented key belongs to, over
 * both compatible APIs, and never reaches another agent.
 */
const AGENT_ID = '0a9e2b7c-0000-4000-8000-0000000000a1';
const OTHER_ID = '0a9e2b7c-0000-4000-8000-0000000000b2';
const AGENT_KEY = 'agent-key-for-weather-helper';
const OTHER_KEY = 'agent-key-for-other-bot';
const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

const match = <T extends Record<string, any>>(rows: T[]) => async ({ where }: any) =>
  rows.find(row => Object.entries(where).every(([field, value]) => row[field] === value)) ?? null;

describe('agent key with model "agent:<slug>" (OpenAI- and Anthropic-compatible)', () => {
  let app: INestApplication;
  const agents = [
    { id: AGENT_ID, organizationId: 'org-1', name: 'Weather Helper', status: 'active', visibility: 'org', apiGatewayId: 'gw-weather' },
    { id: OTHER_ID, organizationId: 'org-1', name: 'Other Bot', status: 'active', visibility: 'org', apiGatewayId: 'gw-other' },
  ];
  const gateways = [
    { id: 'gw-weather', organizationId: 'org-1', agentId: AGENT_ID, kind: GatewayKind.AGENT, status: GatewayStatus.ACTIVE, metadata: { agentApiTarget: true }, accessScope: 'org', authConfigs: [] },
    { id: 'gw-other', organizationId: 'org-1', agentId: OTHER_ID, kind: GatewayKind.AGENT, status: GatewayStatus.ACTIVE, metadata: { agentApiTarget: true }, accessScope: 'org', authConfigs: [] },
  ];
  const keys: any[] = [
    { id: 'k-weather', keyHash: hash(AGENT_KEY), organizationId: 'org-1', gatewayId: 'gw-weather', isActive: true, isExpired: () => false },
    { id: 'k-other', keyHash: hash(OTHER_KEY), organizationId: 'org-1', gatewayId: 'gw-other', isActive: true, isExpired: () => false },
  ];
  const apiKeys = { findOne: jest.fn(match(keys)), update: jest.fn(async () => ({ affected: 1 })) };
  // Stands in for the gateway's sign-in check: the presented key must be one of this gateway's keys.
  const gatewayAuth = {
    authenticateRequest: jest.fn(async (gatewayId: string, headers: Record<string, string>) => {
      const token = headers['x-api-key'] ?? headers.authorization?.replace(/^Bearer\s+/i, '');
      const row = keys.find(key => key.keyHash === hash(token ?? '') && key.isActive);
      return row?.gatewayId === gatewayId ? { isValid: true, userId: null } : { isValid: false, error: 'Invalid API key' };
    }),
  };
  const engine = { execute: jest.fn(async (..._args: any[]) => ({ id: 'e1', status: 'completed', output: 'sunny', totalTokens: 3, inputTokens: 2, outputTokens: 1 })) };
  const agentsService = { getAgent: jest.fn(), findByName: jest.fn(async () => null), findAllActive: jest.fn(async () => []) };

  beforeAll(async () => {
    const agentRepo = { findOne: jest.fn(match(agents)), manager: { getRepository: () => apiKeys } };
    const gatewayRepo = { findOne: jest.fn(match(gateways)) };
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentOpenAICompatController, AgentAnthropicCompatController],
      providers: [
        CompatAgentInvoker,
        AgentOpenAIStreamHelper,
        { provide: ExecutionAccessService, useValue: { canExecute: async () => ({ allowed: true }) } },
        { provide: AgentsService, useValue: agentsService },
        { provide: AgentExecutionEngine, useValue: engine },
        { provide: getRepositoryToken(ApiKey), useValue: apiKeys },
        { provide: AgentApiAccessService, useFactory: () => new AgentApiAccessService(agentRepo as any, gatewayRepo as any, {} as any, gatewayAuth as any) },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  });

  afterAll(async () => await app?.close());
  beforeEach(() => {
    jest.clearAllMocks();
    keys[0].isActive = true;
  });

  const ranAgent = () => JSON.stringify(engine.execute.mock.calls[0]).includes(AGENT_ID);
  const openai = (model: string, key: string) =>
    request(app.getHttpServer()).post('/v1/chat/completions').set('authorization', `Bearer ${key}`)
      .send({ model, messages: [{ role: 'user', content: 'weather?' }] });
  const anthropic = (model: string, key: string) =>
    request(app.getHttpServer()).post('/v1/messages').set('x-api-key', key)
      .send({ model, max_tokens: 50, messages: [{ role: 'user', content: 'weather?' }] });

  it('OpenAI: runs the key\'s agent named by its slug', async () => {
    const res = await openai('agent:weather-helper', AGENT_KEY).expect(200);
    expect(res.body.choices[0].message.content).toBe('sunny');
    expect(ranAgent()).toBe(true);
  });

  it('Anthropic: runs the key\'s agent named by its slug', async () => {
    const res = await anthropic('agent:weather-helper', AGENT_KEY).expect(200);
    expect(res.body.content[0].text).toBe('sunny');
    expect(ranAgent()).toBe(true);
  });

  it('still takes the agent id', async () => {
    await openai(`agent:${AGENT_ID}`, AGENT_KEY).expect(200);
    await anthropic(`agent:${AGENT_ID}`, AGENT_KEY).expect(200);
  });

  it('takes the exact name too', async () => {
    await anthropic('agent:Weather Helper', AGENT_KEY).expect(200);
  });

  it('refuses another agent\'s slug with this agent\'s key, on both paths', async () => {
    await openai('agent:other-bot', AGENT_KEY).expect(404);
    await anthropic('agent:other-bot', AGENT_KEY).expect(404);
    expect(engine.execute).not.toHaveBeenCalled();
    expect(agentsService.findByName).not.toHaveBeenCalled();
  });

  it('refuses this agent\'s slug with another agent\'s key', async () => {
    await openai('agent:weather-helper', OTHER_KEY).expect(404);
    await anthropic('agent:weather-helper', OTHER_KEY).expect(404);
    expect(engine.execute).not.toHaveBeenCalled();
  });

  it('refuses a revoked key named by slug', async () => {
    keys[0].isActive = false;
    await openai('agent:weather-helper', AGENT_KEY).expect(401);
    await anthropic('agent:weather-helper', AGENT_KEY).expect(401);
    expect(engine.execute).not.toHaveBeenCalled();
  });
});
