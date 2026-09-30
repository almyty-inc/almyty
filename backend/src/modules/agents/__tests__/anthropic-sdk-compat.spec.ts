import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import { AgentAnthropicCompatController } from '../agent-anthropic-compat.controller';
import { COMPAT_RATE_LIMIT_RPM } from '../compat-rate-limit.helper';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { BudgetExceededException } from '../../budgets/budget-exceeded.exception';
import { CAST } from '../../../test/execution-access.fixture';
import { fakeRepository } from '../../../test/fake-repository';
import { compatToken as token, FakeLlm, FakeRuntime, ID, startCompatApp } from '../../../test/compat-sdk.fixture';

/**
 * The Anthropic-compatible surface, driven by the official `@anthropic-ai/sdk`.
 *
 * The same app the openai SDK spec drives (test/compat-sdk.fixture.ts):
 * everything below the socket is real except the model, the autonomous
 * worker and the tables. Both routes run agents through one invocation
 * path, so the behaviour asserted here -- which agents a key reaches, how an
 * autonomous agent answers, how a budget refusal reads, what streams -- is
 * the OpenAI route's behaviour in Anthropic's shapes.
 */
describe('the official anthropic SDK against /v1/messages', () => {
  let app: INestApplication;
  let origin: string;
  let llm: FakeLlm;
  let runtime: FakeRuntime;
  let runs: ReturnType<typeof fakeRepository<AgentRun>>;
  let budgets: { enforceForRun: jest.Mock };

  const client = (name = 'member', opts: Partial<ConstructorParameters<typeof Anthropic>[0]> = {}) =>
    new Anthropic({ apiKey: token(name), baseURL: origin, maxRetries: 0, timeout: 20_000, ...opts });

  const ask = (content = 'hi', over: Record<string, any> = {}, name = 'member') =>
    client(name).messages.create({
      model: `agent:${ID.echo}`,
      max_tokens: 256,
      messages: [{ role: 'user', content }],
      ...over,
    } as any) as Promise<Anthropic.Message>;

  /** The status and Anthropic error body a call failed with. */
  const failure = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        return { status: err.status, type: (err as any).type ?? (err.error as any)?.error?.type, message: err.message, headers: err.headers, err };
      }
      throw err;
    }
    throw new Error('expected the call to fail');
  };

  beforeEach(async () => {
    const started = await startCompatApp([AgentAnthropicCompatController]);
    ({ app, llm, runtime, runs, budgets } = started);
    origin = started.origin;
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('a message', () => {
    it('comes back in the shape the SDK types it as', async () => {
      const message = await ask('hi');
      expect(message).toMatchObject({
        type: 'message',
        role: 'assistant',
        model: `agent:${ID.echo}`,
        content: [{ type: 'text', text: 'saw: hi' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 7 },
      });
      expect(message.id).toMatch(/^msg_/);
    });

    it('answers 200, not the 201 Nest gives a POST', async () => {
      const { response } = await client().messages
        .create({ model: `agent:${ID.echo}`, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
        .withResponse();
      expect(response.status).toBe(200);
    });

    it('hands the agent the system prompt and the whole conversation', async () => {
      await ask('ignored', {
        system: 'Answer in French.',
        messages: [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: 'Four.' },
          { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }] },
        ],
      });
      const prompt = llm.calls[0].request.messages.find((m: any) => m.role === 'user').content;
      expect(prompt).toBe('[system]\nAnswer in French.\n\n[user]\nWhat is 2+2?\n\n[assistant]\nFour.\n\n[user]\nAnd 3+3?');
    });

    it('applies max_tokens and temperature to the model call', async () => {
      await ask('hi', { max_tokens: 33, temperature: 0.2 });
      expect(llm.calls[0].request).toMatchObject({ maxTokens: 33, temperature: 0.2 });
    });

    it('answers with the final step only, whatever ran before it', async () => {
      const message = await ask('x', { model: `agent:${ID.twoStep}` });
      expect(message.content).toEqual([{ type: 'text', text: 'saw: polish saw: draft x' }]);
    });

    it('takes the key as x-api-key, the way the SDK sends it, or as a bearer token', async () => {
      expect((await ask('hi')).content[0]).toMatchObject({ text: 'saw: hi' });
      const bearer = new Anthropic({ authToken: token('member'), apiKey: null, baseURL: origin, maxRetries: 0 });
      const message = await bearer.messages.create({ model: `agent:${ID.echo}`, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
      expect(message.content[0]).toMatchObject({ text: 'saw: hi' });
    });
  });

  describe('streaming', () => {
    const events = async (over: Record<string, any> = {}) => {
      const stream = await client().messages.create({
        model: `agent:${ID.echo}`,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        ...over,
      } as any);
      const seen: any[] = [];
      for await (const event of stream as any) seen.push(event);
      return seen;
    };
    const text = (seen: any[]) =>
      seen.filter((e) => e.type === 'content_block_delta').map((e) => e.delta.text).join('');

    it('is the Anthropic event sequence, carrying exactly the non-streaming answer once', async () => {
      const seen = await events();
      const types = seen.map((e) => e.type);
      expect(types[0]).toBe('message_start');
      expect(types[1]).toBe('content_block_start');
      expect(types.slice(-3)).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
      expect(types.slice(2, -3).every((t) => t === 'content_block_delta')).toBe(true);
      expect(seen[0].message).toMatchObject({ type: 'message', role: 'assistant', model: `agent:${ID.echo}`, content: [] });
      expect(seen.filter((e) => e.type === 'content_block_delta').every((e) => e.delta.type === 'text_delta' && e.index === 0)).toBe(true);
      expect(text(seen)).toBe('saw: hi');
      expect(seen[seen.length - 2]).toMatchObject({ delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7, input_tokens: 11 } });
    });

    it('works through the SDK stream helper, finalMessage and usage included', async () => {
      const stream = client().messages.stream({
        model: `agent:${ID.echo}`,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const final = await stream.finalMessage();
      expect(final.content).toHaveLength(1);
      expect(final.content[0]).toMatchObject({ type: 'text', text: 'saw: hi' });
      expect(final.stop_reason).toBe('end_turn');
      expect(final.usage).toMatchObject({ input_tokens: 11, output_tokens: 7 });
    });

    it('is text/event-stream with named events', async () => {
      const res = await fetch(`${origin}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': token('member'), 'content-type': 'application/json' },
        body: JSON.stringify({ model: `agent:${ID.echo}`, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const frames = (await res.text()).split('\n\n').filter(Boolean);
      expect(frames[0]).toMatch(/^event: message_start\ndata: /);
      expect(frames[frames.length - 1]).toMatch(/^event: message_stop\ndata: /);
    });

    it('streams the answering model call token by token, the first words arriving before the run finished', async () => {
      const hold = llm.holdAfterFirstToken();
      const stream = client().messages.stream({
        model: `agent:${ID.echo}`,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'tell me a story' }],
      });
      const deltas: string[] = [];
      let finishedAtFirstDelta: boolean | null = null;
      stream.on('text', (delta) => {
        if (finishedAtFirstDelta === null) {
          finishedAtFirstDelta = llm.state.finished;
          hold.release();
        }
        deltas.push(delta);
      });
      await stream.finalMessage();
      hold.release();
      expect(finishedAtFirstDelta).toBe(false);
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.join('')).toBe('saw: tell me a story');
    });

    it('never streams an intermediate step as if it were the answer', async () => {
      const seen = await events({ model: `agent:${ID.twoStep}` });
      expect(text(seen)).toBe('saw: polish saw: draft hi');
    });

    it('surfaces a failed run as an error event the SDK raises', async () => {
      llm.chat.mockRejectedValueOnce(new Error('upstream exploded'));
      llm.chatStream.mockRejectedValueOnce(new Error('upstream exploded'));
      const err = await failure(events());
      expect(err.type).toBe('api_error');
      expect(err.message).toMatch(/LLM call failed|did not complete|Pipeline failed/);
    });
  });

  describe('who may call what (the same key rules as /v1/chat/completions)', () => {
    const run = (name: string, id: string) => failure(ask('hi', { model: `agent:${id}` }, name));

    it('keeps a team agent to its team, a private agent to its owner and every agent to its org', async () => {
      for (const [name, id] of [
        ['nonmember', ID.team],
        ['member', ID.private],
        ['elsewhere', ID.echo],
        ['onlyecho', ID.twoStep],
      ]) {
        expect({ name, id, ...(await run(name, id)) }).toMatchObject({ name, id, status: 404, type: 'not_found_error' });
      }
      expect(llm.calls).toHaveLength(0);
    });

    it('refuses a gateway key and a key carrying scopes', async () => {
      expect(await run('gateway', ID.echo)).toMatchObject({ status: 401, type: 'authentication_error' });
      expect(await run('scoped', ID.echo)).toMatchObject({ status: 401, type: 'authentication_error' });
      expect(llm.calls).toHaveLength(0);
    });

    it('refuses a draft agent without running it', async () => {
      expect(await run('member', ID.draft)).toMatchObject({ status: 400, type: 'invalid_request_error' });
      expect(llm.calls).toHaveLength(0);
    });

    it('runs the one agent a single-agent key was minted for', async () => {
      expect((await ask('hi', {}, 'onlyecho')).content[0]).toMatchObject({ text: 'saw: hi' });
    });
  });

  describe('errors, in the Anthropic shape and status', () => {
    it('401 for a bad key, typed as the SDK AuthenticationError', async () => {
      await expect(ask('hi', {}, 'nobody')).rejects.toBeInstanceOf(Anthropic.AuthenticationError);
    });

    it('404 not_found_error for an unknown agent', async () => {
      const err = await failure(ask('hi', { model: 'agent:does-not-exist' }));
      expect(err.err).toBeInstanceOf(Anthropic.NotFoundError);
      expect(err.type).toBe('not_found_error');
    });

    it('400 for a missing max_tokens, which the Anthropic API requires', async () => {
      const err = await failure(ask('hi', { max_tokens: undefined }));
      expect(err).toMatchObject({ status: 400, type: 'invalid_request_error' });
      expect(err.message).toContain('max_tokens');
    });

    it('400, not a 500, when a spend budget refuses the run', async () => {
      budgets.enforceForRun.mockRejectedValueOnce(
        new BudgetExceededException({
          budgetId: 'b1', organizationId: CAST.org, agentId: null, spentCents: 1000, limitCents: 1000, periodType: 'month',
        }),
      );
      const err = await failure(ask('hi'));
      expect(err).toMatchObject({ status: 400, type: 'invalid_request_error' });
      expect(err.message).toContain('Spend budget exceeded');
      expect(llm.calls).toHaveLength(0);
    });

    it.each([
      ['tools', { tools: [{ name: 'f', input_schema: { type: 'object' } }] }],
      ['tool_choice', { tool_choice: { type: 'any' } }],
      ['top_p', { top_p: 0.5 }],
      ['top_k', { top_k: 5 }],
      ['stop_sequences', { stop_sequences: ['\n'] }],
      ['thinking', { thinking: { type: 'enabled', budget_tokens: 1024 } }],
    ])('400 naming %s, before anything runs', async (param, over) => {
      const err = await failure(ask('hi', over));
      expect(err).toMatchObject({ status: 400, type: 'invalid_request_error' });
      expect(err.message).toContain(param);
      expect(llm.calls).toHaveLength(0);
      expect(runtime.started).toHaveLength(0);
    });

    it('accepts the fields that change nothing (metadata, a tool_choice of none, thinking disabled)', async () => {
      const message = await ask('hi', {
        metadata: { user_id: 'u-1' },
        tool_choice: { type: 'none' },
        thinking: { type: 'disabled' },
      });
      expect(message.content[0]).toMatchObject({ text: 'saw: hi' });
    });

    it(`serves ${COMPAT_RATE_LIMIT_RPM} requests a minute per key, then 429 with a Retry-After`, async () => {
      const served: number[] = [];
      for (let i = 0; i < COMPAT_RATE_LIMIT_RPM; i++) {
        served.push((await ask('hi').then(() => 200, (e) => e.status)) as number);
      }
      expect(served.filter((s) => s === 200)).toHaveLength(COMPAT_RATE_LIMIT_RPM);
      const err = await failure(ask('hi'));
      expect(err.err).toBeInstanceOf(Anthropic.RateLimitError);
      expect(err.type).toBe('rate_limit_error');
      expect(Number(err.headers?.get('retry-after'))).toBeGreaterThan(0);
    }, 60_000);
  });

  describe('an autonomous agent', () => {
    it('runs on the autonomous runtime and answers with the run output', async () => {
      const message = await ask('plan a trip', { model: `agent:${ID.auto}` });
      expect(message.content).toEqual([{ type: 'text', text: 'autonomous saw: plan a trip' }]);
      expect(message.stop_reason).toBe('end_turn');
      expect(runtime.started).toHaveLength(1);
      expect(runtime.started[0].options.principal).toMatchObject({ userId: CAST.member });
      expect(llm.calls).toHaveLength(0);
    });

    it('streams the answer step token by token while the run works, and never the working step', async () => {
      const hold = runtime.streamAnswer();
      const stream = client().messages.stream({
        model: `agent:${ID.auto}`,
        max_tokens: 256,
        messages: [{ role: 'user', content: 'plan a trip' }],
      });
      const deltas: string[] = [];
      let finishedAtFirstDelta: boolean | null = null;
      stream.on('text', (delta) => {
        if (finishedAtFirstDelta === null) {
          finishedAtFirstDelta = runtime.state.finished;
          hold.release();
        }
        deltas.push(delta);
      });
      const final = await stream.finalMessage();
      hold.release();
      expect(finishedAtFirstDelta).toBe(false);
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.join('')).toBe('autonomous saw: plan a trip');
      expect(final.content[0]).toMatchObject({ type: 'text', text: 'autonomous saw: plan a trip' });
    });

    it('reports a failed run as an error', async () => {
      runtime.finishWith(() => ({ status: AgentRunStatus.FAILED, error: 'tool blew up' }));
      const err = await failure(ask('x', { model: `agent:${ID.auto}` }));
      expect(err).toMatchObject({ status: 502, type: 'api_error' });
      expect(err.message).toContain('tool blew up');
    });

    it('cancels a run that waits on a person, answering 409', async () => {
      runtime.finishWith(() => ({ status: AgentRunStatus.WAITING_INPUT }));
      const err = await failure(ask('x', { model: `agent:${ID.auto}` }));
      expect(err.err).toBeInstanceOf(Anthropic.ConflictError);
      expect(runtime.cancelRun).toHaveBeenCalledTimes(1);
      expect(runs.rows()[0].status).toBe(AgentRunStatus.CANCELLED);
    });
  });
});
