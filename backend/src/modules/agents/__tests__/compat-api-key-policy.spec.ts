import * as crypto from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

import { AgentOpenAICompatController } from '../agent-openai-compat.controller';
import { AgentAnthropicCompatController } from '../agent-anthropic-compat.controller';
import { ApiKey } from '../../../entities/api-key.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { membershipFixture } from '../../../test/execution-access.fixture';

/**
 * Which API keys the /v1 compat endpoints accept, and what they may run.
 *
 * Both controllers looked a key up by hash and checked only that it was
 * active and unexpired. Everything ApiKeyStrategy refuses on the platform
 * API was accepted here:
 *   - a gateway key, minted for one gateway's protocol surface and handed
 *     to a third-party MCP client, ran any org-visible agent;
 *   - a key whose user had been removed from the organization kept
 *     running the organization's agents (removal never deactivates keys);
 *   - an access key minted FOR one agent (`agentId`) ran every other one,
 *     and /v1/models listed them all.
 * And a model named by name rather than id reached a uuid column with a
 * non-uuid, which Postgres answers with an error, not "no rows" -- a 500.
 */
const ORG = 'org-1';
const SUPPORT = '11111111-1111-4111-8111-111111111111';
const BILLING = '22222222-2222-4222-8222-222222222222';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const agents = [
  { id: SUPPORT, name: 'support', status: 'active', organizationId: ORG, createdAt: new Date() },
  { id: BILLING, name: 'billing', status: 'active', organizationId: ORG, createdAt: new Date() },
];

/** Answers the way AgentsService does over Postgres: a non-uuid id is a query error. */
const agentsService = {
  async getAgent(id: string, organizationId: string) {
    if (!UUID_RE.test(id)) {
      throw new QueryFailedError('SELECT', [id], new Error(`invalid input syntax for type uuid: "${id}"`));
    }
    const agent = agents.find((a) => a.id === id && a.organizationId === organizationId);
    if (!agent) throw new NotFoundException(`Agent not found: ${id}`);
    return agent;
  },
  async findByName(name: string, organizationId: string) {
    return agents.find((a) => a.name === name && a.organizationId === organizationId) ?? null;
  },
  async findAllActive(organizationId: string) {
    return agents.filter((a) => a.organizationId === organizationId);
  },
};

const member = { id: 'user-1', isActive: true, organizationMemberships: [{ organizationId: ORG, isActive: true }] };

function key(token: string, overrides: Record<string, any> = {}) {
  return Object.assign(new ApiKey(), {
    id: `key-${token}`,
    keyHash: crypto.createHash('sha256').update(token).digest('hex'),
    organizationId: ORG,
    userId: 'user-1',
    user: member,
    gatewayId: null,
    agentId: null,
    scopes: [],
    isActive: true,
    expiresAt: null,
    lastUsedAt: new Date(),
    ...overrides,
  });
}

const KEYS = [
  key('platform'),
  key('gateway', { gatewayId: 'gw-1', scopes: ['gateway:use'] }),
  key('departed', { user: { ...member, organizationMemberships: [{ organizationId: 'org-elsewhere', isActive: true }] } }),
  key('deactivated', { user: { ...member, isActive: false } }),
  key('orgless', { organizationId: null }),
  key('support-only', { agentId: SUPPORT }),
];

function res(): any {
  const r: any = { statusCode: 200, body: undefined, headers: {} };
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.json = (body: any) => { r.body = body; return r; };
  r.setHeader = (name: string, value: any) => { r.headers[name] = value; };
  return r;
}

function openai() {
  const ran: string[] = [];
  const stream = {
    handleSync: async (agent: any, _input: any, _key: any, response: any) => {
      ran.push(agent.id);
      return response.status(200).json({ ran: agent.id });
    },
  };
  const controller = new AgentOpenAICompatController(
    agentsService as any,
    {} as any,
    fakeRepository<ApiKey>({ seed: KEYS, make: () => new ApiKey() }) as any,
    stream as any,
    undefined, // redis
    membershipFixture().executionAccess, // the real execution gate
  );
  const chat = async (token: string, model: string) => {
    const r = res();
    await controller.chatCompletions(
      { model, messages: [{ role: 'user', content: 'hi' }] },
      `Bearer ${token}`,
      { ip: '127.0.0.1' } as any,
      r,
    );
    return r;
  };
  const models = async (token: string) => {
    const r = res();
    await controller.listModels(`Bearer ${token}`, r);
    return r;
  };
  return { chat, models, ran };
}

function anthropic() {
  const ran: string[] = [];
  const engine = {
    execute: async (agent: any) => {
      ran.push(agent.id);
      return { status: 'failed', error: 'stub' };
    },
  };
  const controller = new AgentAnthropicCompatController(
    agentsService as any,
    engine as any,
    fakeRepository<ApiKey>({ seed: KEYS, make: () => new ApiKey() }) as any,
    undefined, // redis
    membershipFixture().executionAccess, // the real execution gate
  );
  const messages = async (token: string, model: string) => {
    const r = res();
    await controller.messages(
      { model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] } as any,
      undefined as any,
      token,
      {} as any,
      r,
    );
    return r;
  };
  return { messages, ran };
}

describe('compat endpoints refuse keys the platform API refuses', () => {
  it.each(['gateway', 'departed', 'deactivated', 'orgless'])('/v1/chat/completions refuses the %s key', async (token) => {
    const { chat, ran } = openai();
    const r = await chat(token, `agent:${SUPPORT}`);
    expect(r.statusCode).toBe(401);
    expect(ran).toEqual([]);
  });

  it.each(['gateway', 'departed', 'deactivated', 'orgless'])('/v1/models refuses the %s key', async (token) => {
    const { models } = openai();
    const r = await models(token);
    expect(r.statusCode).toBe(401);
    expect(r.body?.data).toBeUndefined();
  });

  it.each(['gateway', 'departed', 'deactivated', 'orgless'])('/v1/messages refuses the %s key', async (token) => {
    const { messages, ran } = anthropic();
    const r = await messages(token, `agent:${SUPPORT}`);
    expect(r.statusCode).toBe(401);
    expect(ran).toEqual([]);
  });

  it('a current member\'s platform key still runs an agent', async () => {
    const { chat, ran } = openai();
    const r = await chat('platform', `agent:${BILLING}`);
    expect(r.statusCode).toBe(200);
    expect(ran).toEqual([BILLING]);
  });
});

describe('an access key minted for one agent runs that agent only', () => {
  it('runs its own agent', async () => {
    const { chat, ran } = openai();
    const r = await chat('support-only', `agent:${SUPPORT}`);
    expect(r.statusCode).toBe(200);
    expect(ran).toEqual([SUPPORT]);
  });

  it('answers any other agent as not found, by id or by name', async () => {
    const { chat, ran } = openai();
    expect((await chat('support-only', `agent:${BILLING}`)).statusCode).toBe(404);
    expect((await chat('support-only', 'billing')).statusCode).toBe(404);
    expect(ran).toEqual([]);

    const a = anthropic();
    expect((await a.messages('support-only', `agent:${BILLING}`)).statusCode).toBe(404);
    expect(a.ran).toEqual([]);
  });

  it('lists only its own agent', async () => {
    const { models } = openai();
    const r = await models('support-only');
    expect(r.body.data.map((m: any) => m.id)).toEqual([`agent:${SUPPORT}`]);
  });
});

describe('naming an agent by name', () => {
  it('resolves on /v1/chat/completions instead of failing on the uuid column', async () => {
    const { chat, ran } = openai();
    const r = await chat('platform', 'support');
    expect(r.statusCode).toBe(200);
    expect(ran).toEqual([SUPPORT]);
  });

  it('resolves on /v1/messages too', async () => {
    const { messages, ran } = anthropic();
    await messages('platform', 'agent:billing');
    expect(ran).toEqual([BILLING]);
  });

  it('answers an unknown name with 404, not 500', async () => {
    const { chat } = openai();
    expect((await chat('platform', 'nobody')).statusCode).toBe(404);
  });
});
