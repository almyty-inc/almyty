import { ExecutionAccessService } from '../../../common/authorization/execution-access.service';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { INestApplication, NotFoundException } from '@nestjs/common';
import request from 'supertest';
import { listenOnLoopback } from '../../../test/http';
import * as crypto from 'crypto';

import { ApiKey } from '../../../entities/api-key.entity';
import { AgentsService } from '../agents.service';
import { AgentExecutionEngine } from '../agent-execution.engine';
import { AgentAnthropicCompatController } from '../agent-anthropic-compat.controller';

/**
 * POST /v1/messages, over the wire.
 *
 * The translator under this was written and tested long before anything
 * called it, and docs claimed Claude Code support that no route provided.
 * The unit tests were green throughout, because a translator with no
 * endpoint still translates. This file is the one that fails if the route
 * disappears again.
 */
describe('POST /v1/messages', () => {
  let app: INestApplication;
  let execution: any;
  let agent: any;

  const TOKEN = 'ak_test_key';
  const keyHash = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const apiKeyRow = {
    id: 'k1',
    organizationId: 'org-1',
    user: { id: 'user-1', isActive: true, organizationMemberships: [{ organizationId: 'org-1', isActive: true }] },
    userId: 'u1',
    isActive: true,
    isExpired: () => false,
  };

  const engine = { execute: jest.fn(async (..._args: any[]) => execution) };
  const agents = {
    getAgent: jest.fn(async () => {
      if (!agent) throw new NotFoundException('nope');
      return agent;
    }),
    findByName: jest.fn(async () => agent),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AgentAnthropicCompatController],
      providers: [
        { provide: ExecutionAccessService, useValue: membershipFixture().executionAccess },
        { provide: AgentsService, useValue: agents },
        { provide: AgentExecutionEngine, useValue: engine },
        {
          provide: getRepositoryToken(ApiKey),
          useValue: { findOne: jest.fn(async ({ where }: any) => (where.keyHash === keyHash ? apiKeyRow : null)) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await listenOnLoopback(app);
  });

  afterAll(async () => await app?.close());

  beforeEach(() => {
    agent = { id: '0a9e2b7c-0000-4000-8000-0000000000a1', name: 'Helper', status: 'active' };
    execution = { id: 'e1', status: 'completed', output: 'hello back', totalTokens: 12, inputTokens: 9, outputTokens: 3 };
    jest.clearAllMocks();
  });

  const body = (over: Record<string, unknown> = {}) => ({
    model: 'agent:0a9e2b7c-0000-4000-8000-0000000000a1',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hello' }],
    ...over,
  });

  const post = (payload: unknown, headers: Record<string, string> = { 'x-api-key': TOKEN }) =>
    request(app.getHttpServer()).post('/v1/messages').set(headers).send(payload as object);

  it('answers in the Anthropic shape a client can actually parse', async () => {
    const { body: res } = await post(body()).expect(200);

    expect(res).toMatchObject({ type: 'message', role: 'assistant', model: 'agent:0a9e2b7c-0000-4000-8000-0000000000a1' });
    expect(res.content[0]).toEqual({ type: 'text', text: 'hello back' });
    expect(res.stop_reason).toBe('end_turn');
    expect(res.id).toMatch(/^msg_/);
  });

  it('takes the key as x-api-key, which is what an Anthropic client sends', async () => {
    await post(body(), { 'x-api-key': TOKEN }).expect(200);
  });

  it('also takes a bearer token, so an existing almyty key needs no second shape', async () => {
    await post(body(), { authorization: `Bearer ${TOKEN}` }).expect(200);
  });

  it('refuses an unknown key in the error shape the client expects', async () => {
    const { body: res } = await post(body(), { 'x-api-key': 'nope' }).expect(401);
    expect(res.type).toBe('error');
    expect(res.error.type).toBe('authentication_error');
  });

  it('refuses a request with no key at all', async () => {
    await request(app.getHttpServer()).post('/v1/messages').send(body()).expect(401);
  });

  it('requires max_tokens rather than inventing one, and says which field', async () => {
    const { body: res } = await post({ model: 'agent:0a9e2b7c-0000-4000-8000-0000000000a1', messages: [{ role: 'user', content: 'hi' }] }).expect(400);
    expect(res.error.type).toBe('invalid_request_error');
    expect(res.error.message).toContain('max_tokens');
  });

  it('carries a tool result through as a tool turn, not as user text', async () => {
    // This is the case that silently kills a client's loop: Anthropic
    // sends tool results as a USER message of tool_result blocks.
    await post(
      body({
        messages: [
          { role: 'user', content: 'what is the weather' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'weather', input: { city: 'Zagreb' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'sunny' }] },
        ],
      }),
    ).expect(200);

    const input = (engine.execute.mock.calls[0] as any[])[3].input;
    const roles = input.messages.map((m: any) => m.role);
    expect(roles).toContain('tool');
    expect(roles.filter((r: string) => r === 'user')).toHaveLength(1);
  });

  it('says the agent was not found in the client\'s error shape', async () => {
    agent = null;
    const { body: res } = await post(body({ model: 'agent:ghost' })).expect(404);
    expect(res.error.type).toBe('not_found_error');
  });

  it('reports a failed run as an error rather than an empty successful message', async () => {
    execution = { id: 'e2', status: 'failed', error: 'the model refused', output: null };
    const { body: res } = await post(body()).expect(502);
    expect(res.error.message).toContain('the model refused');
  });

  it('reports the split the run recorded, not the whole run as output', async () => {
    const { body: res } = await post(body()).expect(200);
    // output_tokens used to carry the entire run, which made the completion
    // look ~4x its real size to anyone attributing cost from it.
    expect(res.usage.input_tokens).toBe(9);
    expect(res.usage.output_tokens).toBe(3);
    expect(res.usage.output_tokens).not.toBe(12);
  });

  it('refuses a streaming request plainly instead of answering the wrong shape', async () => {
    // A client that asked for SSE and receives one JSON object fails to
    // parse with nothing to go on. Naming the limitation is debuggable.
    const { body: res } = await post(body({ stream: true })).expect(400);
    expect(res.error.message).toMatch(/streaming is not supported/i);
    expect(engine.execute).not.toHaveBeenCalled();
  });

  it('refuses client-declared tools, because an agent runs its own', async () => {
    // Nothing in the execution path produces tool calls for a caller to
    // run: a tool_call node executes inside the agent and the run returns
    // the finished answer. Accepting these and answering normally leaves
    // a client whose tools never fire and nothing to debug.
    const { body: res } = await post(
      body({
        tools: [{ name: 'weather', description: 'look up weather', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'auto' },
      }),
    ).expect(400)

    expect(res.error.type).toBe('invalid_request_error')
    expect(res.error.message).toMatch(/runs its own tools/i)
    expect(engine.execute).not.toHaveBeenCalled()
  })

  it('returns tool_use blocks and stop_reason tool_use when the run called a tool', async () => {
    // The half that was missing: results came IN as tool turns, and calls
    // could never go back OUT, so the loop stopped on the first turn.
    execution = {
      id: 'e3',
      status: 'completed',
      output: { content: '', toolCalls: [{ id: 'toolu_1', name: 'weather', arguments: '{"city":"Zagreb"}' }] },
      totalTokens: 5,
    }

    const { body: res } = await post(body()).expect(200)

    expect(res.stop_reason).toBe('tool_use')
    const use = res.content.find((b: any) => b.type === 'tool_use')
    expect(use).toMatchObject({ name: 'weather', id: 'toolu_1' })
    expect(use.input).toEqual({ city: 'Zagreb' })
  })

  it('reads a tool call recorded in the OpenAI shape too, since the engine may use either', async () => {
    execution = {
      id: 'e4',
      status: 'completed',
      output: { tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: '{"q":"x"}' } }] },
      totalTokens: 1,
    }

    const { body: res } = await post(body()).expect(200)
    expect(res.stop_reason).toBe('tool_use')
    expect(res.content.find((b: any) => b.type === 'tool_use')).toMatchObject({ name: 'search' })
  })

  it('still says end_turn for a plain text answer', async () => {
    const { body: res } = await post(body()).expect(200)
    expect(res.stop_reason).toBe('end_turn')
  })

  it('does not dump a JSON blob as the reply when the turn was tool calls', async () => {
    execution = { id: 'e5', status: 'completed', output: { toolCalls: [{ id: 't1', name: 'weather', arguments: '{}' }] }, totalTokens: 1 }

    const { body: res } = await post(body()).expect(200)
    const text = res.content.find((b: any) => b.type === 'text')
    expect(text?.text ?? '').not.toContain('toolCalls')
  })
});
