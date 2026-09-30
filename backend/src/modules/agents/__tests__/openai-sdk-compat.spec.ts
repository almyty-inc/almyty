import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import OpenAI from 'openai';

import { AgentOpenAICompatController } from '../agent-openai-compat.controller';
import { COMPAT_RATE_LIMIT_RPM } from '../compat-rate-limit.helper';
import { Agent } from '../../../entities/agent.entity';
import { AgentRun, AgentRunStatus } from '../../../entities/agent-run.entity';
import { ApiKey } from '../../../entities/api-key.entity';
import { BudgetExceededException } from '../../budgets/budget-exceeded.exception';
import { CAST } from '../../../test/execution-access.fixture';
import { fakeRepository } from '../../../test/fake-repository';
import {
  compatToken as token,
  FakeLlm,
  FakeRuntime,
  ID,
  keyRow,
  startCompatApp,
} from '../../../test/compat-sdk.fixture';

/**
 * The OpenAI-compatible surface, driven by the official `openai` SDK.
 *
 * Everything below the HTTP socket is real except the model and the tables
 * (test/compat-sdk.fixture.ts): the controller, the shared invocation path,
 * the pipeline engine and its node executor, the key policy and the
 * execution gate. The model is a fake that answers `saw: <what the prompt
 * said>`, so every assertion reads back what the agent was actually handed.
 *
 * The earlier compat specs call controller methods with hand-built req/res
 * doubles, which is how the stream could repeat the answer once per node
 * and still pass: nothing parsed it the way a client does.
 */

describe('the official openai SDK against /v1', () => {
  let app: INestApplication;
  let baseURL: string;
  let llm: FakeLlm;
  let runtime: FakeRuntime;
  let runs: ReturnType<typeof fakeRepository<AgentRun>>;
  let apiKeys: ReturnType<typeof fakeRepository<ApiKey>>;
  let agentsService: any;
  let budgets: { enforceForRun: jest.Mock };

  const client = (name = 'member', opts: Partial<ConstructorParameters<typeof OpenAI>[0]> = {}) =>
    new OpenAI({ apiKey: token(name), baseURL, maxRetries: 0, timeout: 20_000, ...opts });

  const ask = (content = 'hi', over: Record<string, any> = {}) =>
    client().chat.completions.create({
      model: `agent:${ID.echo}`,
      messages: [{ role: 'user', content }],
      ...over,
    } as any) as Promise<OpenAI.Chat.Completions.ChatCompletion>;

  /** The status and OpenAI error body a call failed with. */
  const failure = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        return { status: err.status, type: err.type, code: err.code, param: err.param, message: err.message, headers: err.headers };
      }
      throw err;
    }
    throw new Error('expected the call to fail');
  };

  beforeEach(async () => {
    const started = await startCompatApp([AgentOpenAICompatController]);
    ({ app, llm, runtime, runs, apiKeys, agentsService, budgets } = started);
    baseURL = `${started.origin}/v1`;
  });

  afterEach(async () => {
    await app?.close();
  });

  describe('a chat completion', () => {
    it('comes back in the shape the SDK types it as', async () => {
      const completion = await ask('hi');

      expect(completion.object).toBe('chat.completion');
      expect(completion.id).toMatch(/^chatcmpl-/);
      expect(completion.model).toBe(`agent:${ID.echo}`);
      expect(completion.choices).toHaveLength(1);
      expect(completion.choices[0]).toMatchObject({
        index: 0,
        message: { role: 'assistant', content: 'saw: hi' },
        finish_reason: 'stop',
      });
      expect(completion.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    });

    it('addresses an agent by id, by agent:name, by bare name and by slug', async () => {
      for (const model of [ID.echo, 'agent:Echo Agent', 'Echo Agent', 'echo-agent']) {
        const completion = await ask('hi', { model });
        expect(completion.choices[0].message.content).toBe('saw: hi');
      }
    });

    it('hands the agent the whole conversation, system instruction included, not just the last line', async () => {
      await ask('ignored', {
        messages: [
          { role: 'system', content: 'Answer in French.' },
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: 'Four.' },
          { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }] },
        ],
      });

      const prompt = llm.calls[0].request.messages.find((msg: any) => msg.role === 'user').content;
      expect(prompt).toBe(
        '[system]\nAnswer in French.\n\n[user]\nWhat is 2+2?\n\n[assistant]\nFour.\n\n[user]\nAnd 3+3?',
      );
    });

    it('passes temperature and max_tokens through to the model', async () => {
      await ask('hi', { temperature: 0.2, max_tokens: 33 });
      expect(llm.calls[0].request).toMatchObject({ temperature: 0.2, maxTokens: 33 });
    });

    it('honours max_completion_tokens, the name current SDKs send, as max_tokens', async () => {
      await ask('hi', { max_completion_tokens: 44 });
      expect(llm.calls[0].request.maxTokens).toBe(44);
    });

    it('answers with the final step only, whatever ran before it', async () => {
      const completion = await ask('x', { model: `agent:${ID.twoStep}` });
      expect(completion.choices[0].message.content).toBe('saw: polish saw: draft x');
    });

    it('accepts the defaults a client library sends unasked (n=1, top_p=1, zero penalties, user, metadata)', async () => {
      const completion = await ask('hi', {
        n: 1, top_p: 1, frequency_penalty: 0, presence_penalty: 0, user: 'end-user-7', metadata: { a: 'b' }, store: false,
      });
      expect(completion.choices[0].message.content).toBe('saw: hi');
    });
  });

  describe('streaming', () => {
    const collect = async (over: Record<string, any> = {}, model = `agent:${ID.echo}`) => {
      const stream = await client().chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        ...over,
      } as any);
      const chunks: OpenAI.Chat.Completions.ChatCompletionChunk[] = [];
      for await (const chunk of stream as any) chunks.push(chunk);
      return chunks;
    };
    const text = (chunks: OpenAI.Chat.Completions.ChatCompletionChunk[]) =>
      chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');

    it('streams exactly the answer the non-streaming call returns, once', async () => {
      const chunks = await collect();
      expect(text(chunks)).toBe('saw: hi');
    });

    it('never streams an intermediate step as if it were the answer', async () => {
      const chunks = await collect({}, `agent:${ID.twoStep}`);
      expect(text(chunks)).toBe('saw: polish saw: draft hi');
    });

    it('opens with the assistant role and ends with finish_reason stop, every chunk one completion id', async () => {
      const chunks = await collect();
      expect(chunks[0].choices[0].delta.role).toBe('assistant');
      const withChoices = chunks.filter((c) => c.choices.length > 0);
      expect(withChoices[withChoices.length - 1].choices[0].finish_reason).toBe('stop');
      expect(withChoices.slice(0, -1).every((c) => c.choices[0].finish_reason === null)).toBe(true);
      expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
      expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    });

    it('sends usage in a final empty-choices chunk only when stream_options.include_usage asks', async () => {
      const without = await collect();
      expect(without.some((c: any) => c.usage)).toBe(false);

      const withUsage = await collect({ stream_options: { include_usage: true } });
      const last = withUsage[withUsage.length - 1];
      expect(last.choices).toEqual([]);
      expect(last.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
    });

    it('answers 200, as OpenAI does, not the 201 Nest gives a POST', async () => {
      const { response } = await client().chat.completions
        .create({ model: `agent:${ID.echo}`, messages: [{ role: 'user', content: 'hi' }] })
        .withResponse();
      expect(response.status).toBe(200);
    });

    it('is the text/event-stream wire format, terminated by data: [DONE]', async () => {
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token('member')}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: `agent:${ID.echo}`, messages: [{ role: 'user', content: 'hi' }], stream: true }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
      const body = await res.text();
      const frames = body.split('\n\n').filter(Boolean);
      expect(frames.every((f) => f.startsWith('data: ') || f.startsWith(':'))).toBe(true);
      expect(frames[frames.length - 1]).toBe('data: [DONE]');
    });

    it('works through the SDK stream helper, finalChatCompletion included', async () => {
      const runner = client().chat.completions.stream({
        model: `agent:${ID.echo}`,
        messages: [{ role: 'user', content: 'hi' }],
      });
      const final = await runner.finalChatCompletion();
      expect(final.choices[0].message.content).toBe('saw: hi');
      expect(final.choices[0].finish_reason).toBe('stop');
    });

    it('surfaces a failed run as an error the SDK raises, not as a short answer', async () => {
      llm.chat.mockRejectedValueOnce(new Error('upstream exploded'));
      llm.chatStream.mockRejectedValueOnce(new Error('upstream exploded'));
      const err = await failure(collect());
      expect(err.message).toMatch(/Pipeline failed|LLM call failed|did not complete/);
    });

    it('surfaces a spend budget refusal in the stream as insufficient_quota', async () => {
      budgets.enforceForRun.mockRejectedValueOnce(
        new BudgetExceededException({
          budgetId: 'b1', organizationId: CAST.org, agentId: null, spentCents: 1000, limitCents: 1000, periodType: 'month',
        }),
      );
      const err = await failure(collect());
      expect(err).toMatchObject({ type: 'insufficient_quota', code: 'insufficient_quota' });
      expect(err.message).toContain('Spend budget exceeded');
    });

    /** Deltas as they arrive, and whether the model had finished when the first one did. */
    const watch = async (model: string, content = 'tell me a story', held = true) => {
      const hold = held ? llm.holdAfterFirstToken() : { release: () => undefined };
      const stream = await client().chat.completions.create({
        model,
        messages: [{ role: 'user', content }],
        stream: true,
      });
      const deltas: string[] = [];
      let finishedAtFirstDelta: boolean | null = null;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (!delta) continue;
        if (finishedAtFirstDelta === null) {
          finishedAtFirstDelta = llm.state.finished;
          hold.release();
        }
        deltas.push(delta);
      }
      hold.release();
      return { deltas, finishedAtFirstDelta };
    };

    it('streams the answering model call token by token, the first words arriving before the run finished', async () => {
      const { deltas, finishedAtFirstDelta } = await watch(`agent:${ID.echo}`);
      expect(finishedAtFirstDelta).toBe(false);
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.join('')).toBe('saw: tell me a story');
    });

    it('streams only the final step of a two-step pipeline, never the draft', async () => {
      const { deltas, finishedAtFirstDelta } = await watch(`agent:${ID.twoStep}`, 'x');
      expect(finishedAtFirstDelta).toBe(false);
      expect(deltas.join('')).toBe('saw: polish saw: draft x');
      expect(llm.calls.map((c) => c.streamed)).toEqual([false, true]);
    });

    it('sends the whole answer at the end when the output node reshapes the model text', async () => {
      const { deltas } = await watch(`agent:${ID.mapped}`, 'tell me a story', false);
      expect(deltas.join('')).toBe('Answer: saw: tell me a story');
      expect(llm.calls.every((c) => !c.streamed)).toBe(true);
    });

    it('does not stream the model call of a non-streaming request', async () => {
      await ask('hi');
      expect(llm.calls.every((c) => !c.streamed)).toBe(true);
    });
  });

  describe('models', () => {
    const listed = async (name: string) => (await client(name).models.list()).data.map((m) => m.id).sort();

    it('lists the active agents the key may run, and nothing else', async () => {
      expect(await listed('member')).toEqual(
        [`agent:${ID.echo}`, `agent:${ID.team}`, `agent:${ID.auto}`, `agent:${ID.twoStep}`, `agent:${ID.mapped}`].sort(),
      );
      expect(await listed('nonmember')).toEqual(
        [`agent:${ID.echo}`, `agent:${ID.auto}`, `agent:${ID.twoStep}`, `agent:${ID.mapped}`].sort(),
      );
      expect(await listed('owner')).toContain(`agent:${ID.private}`);
      expect(await listed('onlyecho')).toEqual([`agent:${ID.echo}`]);
      expect(await listed('elsewhere')).toEqual([]);
    });

    it('every model it lists answers a completion with a real answer', async () => {
      for (const name of ['member', 'nonmember', 'owner', 'onlyecho']) {
        for (const model of await listed(name)) {
          const completion = (await client(name).chat.completions.create({
            model,
            messages: [{ role: 'user', content: 'ping' }],
          })) as OpenAI.Chat.Completions.ChatCompletion;
          expect({ model, content: completion.choices[0].message.content }).toEqual({
            model,
            content: expect.stringContaining('ping'),
          });
        }
      }
    });

    it('lists each model in the OpenAI model shape', async () => {
      const [model] = (await client('onlyecho').models.list()).data;
      expect(model).toMatchObject({ id: `agent:${ID.echo}`, object: 'model', owned_by: 'almyty' });
      expect(typeof model.created).toBe('number');
    });

    it('retrieves one model the key may run, and 404s the rest', async () => {
      const model = await client().models.retrieve(`agent:${ID.echo}`);
      expect(model).toMatchObject({ id: `agent:${ID.echo}`, object: 'model' });

      for (const id of [`agent:${ID.private}`, `agent:${ID.draft}`, `agent:${ID.otherOrg}`, 'agent:nope']) {
        const err = await failure(client().models.retrieve(id));
        expect({ id, status: err.status, code: err.code }).toEqual({ id, status: 404, code: 'model_not_found' });
      }
    });
  });

  describe('who may call what', () => {
    const run = (name: string, id: string) =>
      failure(client(name).chat.completions.create({ model: `agent:${id}`, messages: [{ role: 'user', content: 'hi' }] }));

    it('keeps a team agent to its team, a private agent to its owner and every agent to its org', async () => {
      expect((await run('nonmember', ID.team)).status).toBe(404);
      expect((await run('member', ID.private)).status).toBe(404);
      expect((await run('elsewhere', ID.echo)).status).toBe(404);
      expect((await run('onlyecho', ID.twoStep)).status).toBe(404);
      expect(llm.calls).toHaveLength(0);
    });

    it('refuses a gateway key and a key carrying scopes, as the platform API does', async () => {
      expect(await run('gateway', ID.echo)).toMatchObject({ status: 401, type: 'authentication_error' });
      expect(await run('scoped', ID.echo)).toMatchObject({ status: 401, type: 'authentication_error' });
      expect(llm.calls).toHaveLength(0);
    });

    it('refuses a draft agent without running it', async () => {
      expect(await run('member', ID.draft)).toMatchObject({ status: 400 });
      expect(llm.calls).toHaveLength(0);
    });

    it('reads a key with no user as nobody: org-visible agents only, and the key itself is refused', async () => {
      // `api_keys.userId` is NOT NULL and cascades on user delete, so the row
      // cannot exist in a real table; if one did, it would still not reach
      // any agent -- the key is refused, and the listing rule for "nobody"
      // is org agents only.
      expect(
        (await agentsService.findAllActive(CAST.org, null)).map((a: Agent) => a.id).sort(),
      ).toEqual([ID.echo, ID.auto, ID.twoStep, ID.mapped].sort());
      await apiKeys.save(Object.assign(new ApiKey(), keyRow('userless', null as any, { user: null as any })));
      expect(await run('userless', ID.echo)).toMatchObject({ status: 401, type: 'authentication_error' });
    });
  });

  describe('errors, in the OpenAI shape and status', () => {
    it('401 for a bad key, typed as the SDK AuthenticationError', async () => {
      const call = client('nobody').chat.completions.create({ model: `agent:${ID.echo}`, messages: [{ role: 'user', content: 'hi' }] });
      await expect(call).rejects.toBeInstanceOf(OpenAI.AuthenticationError);
      expect(await failure(client('nobody').models.list())).toMatchObject({ status: 401, type: 'authentication_error', code: 'invalid_api_key' });
    });

    it('404 model_not_found for an unknown model', async () => {
      const call = ask('hi', { model: 'agent:does-not-exist' });
      await expect(call).rejects.toBeInstanceOf(OpenAI.NotFoundError);
      expect(await failure(ask('hi', { model: 'agent:does-not-exist' }))).toMatchObject({
        status: 404, type: 'invalid_request_error', code: 'model_not_found',
      });
    });

    it('400 for a malformed request', async () => {
      expect(await failure(ask('hi', { messages: [] }))).toMatchObject({ status: 400, type: 'invalid_request_error' });
      expect(await failure(ask('hi', { model: '' }))).toMatchObject({ status: 400, code: 'model_required' });
    });

    it('429 insufficient_quota when a spend budget refuses the run, not a 500', async () => {
      budgets.enforceForRun.mockRejectedValueOnce(
        new BudgetExceededException({
          budgetId: 'b1', organizationId: CAST.org, agentId: null, spentCents: 1000, limitCents: 1000, periodType: 'month',
        }),
      );
      const err = await failure(ask('hi'));
      expect(err).toMatchObject({ status: 429, type: 'insufficient_quota', code: 'insufficient_quota' });
      expect(err.message).toContain('Spend budget exceeded');
      expect(llm.calls).toHaveLength(0);
    });

    it.each([
      ['tools', { tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }] }],
      ['tool_choice', { tool_choice: 'required' }],
      ['n', { n: 2 }],
      ['response_format', { response_format: { type: 'json_object' } }],
      ['top_p', { top_p: 0.5 }],
      ['stop', { stop: ['\n'] }],
      ['logprobs', { logprobs: true }],
    ])('400 unsupported_parameter naming %s, before anything runs', async (param, over) => {
      const err = await failure(ask('hi', over));
      expect(err).toMatchObject({ status: 400, type: 'invalid_request_error', code: 'unsupported_parameter', param });
      expect(llm.calls).toHaveLength(0);
    });

    it(`serves ${COMPAT_RATE_LIMIT_RPM} requests a minute per key, then 429 with a Retry-After the SDK can honour`, async () => {
      const served: number[] = [];
      for (let i = 0; i < COMPAT_RATE_LIMIT_RPM; i++) {
        served.push((await ask('hi').then(() => 200, (e) => e.status)) as number);
      }
      expect(served.filter((s) => s === 200)).toHaveLength(COMPAT_RATE_LIMIT_RPM);

      const err = await failure(ask('hi'));
      expect(err).toMatchObject({ status: 429, type: 'rate_limit_error', code: 'rate_limit_exceeded' });
      const retryAfter = Number(err.headers?.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    }, 60_000);
  });

  describe('the ways people configure the client', () => {
    it('works with a trailing slash on base_url', async () => {
      const completion = (await client('member', { baseURL: `${baseURL}/` }).chat.completions.create({
        model: `agent:${ID.echo}`,
        messages: [{ role: 'user', content: 'hi' }],
      })) as OpenAI.Chat.Completions.ChatCompletion;
      expect(completion.choices[0].message.content).toBe('saw: hi');
    });

    it('needs /v1 in base_url, as OpenAI itself does: without it the route is not this API', async () => {
      const bare = client('member', { baseURL: baseURL.replace(/\/v1$/, '') });
      await expect(bare.models.list()).rejects.toBeInstanceOf(OpenAI.NotFoundError);
    });

    it('ignores OpenAI-Organization and OpenAI-Project headers', async () => {
      const completion = (await client('member', { organization: 'org-openai-xyz', project: 'proj_abc' }).chat.completions.create({
        model: `agent:${ID.echo}`,
        messages: [{ role: 'user', content: 'hi' }],
      })) as OpenAI.Chat.Completions.ChatCompletion;
      expect(completion.choices[0].message.content).toBe('saw: hi');
    });
  });

  describe('an autonomous agent', () => {
    it('runs on the autonomous runtime and answers with the run output', async () => {
      const completion = await ask('plan a trip', { model: `agent:${ID.auto}` });
      expect(completion.choices[0].message.content).toBe('autonomous saw: plan a trip');
      expect(completion.choices[0].finish_reason).toBe('stop');
      expect(runtime.started).toHaveLength(1);
      expect(runtime.started[0].options.principal).toMatchObject({ userId: CAST.member });
      expect(llm.calls).toHaveLength(0);
    });

    it('streams the run output', async () => {
      const stream = await client().chat.completions.create({
        model: `agent:${ID.auto}`,
        messages: [{ role: 'user', content: 'plan a trip' }],
        stream: true,
        stream_options: { include_usage: true },
      });
      const chunks: any[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('autonomous saw: plan a trip');
      expect(chunks[chunks.length - 1].usage).toMatchObject({ total_tokens: 42 });
    });

    it('reports a failed run as an error', async () => {
      runtime.finishWith(() => ({ status: AgentRunStatus.FAILED, error: 'tool blew up' }));
      expect(await failure(ask('x', { model: `agent:${ID.auto}` }))).toMatchObject({ status: 502, code: 'agent_execution_failed' });
    });

    it('does not leave a run waiting on a human that a stateless request can never answer', async () => {
      runtime.finishWith(() => ({ status: AgentRunStatus.WAITING_INPUT }));
      const err = await failure(ask('x', { model: `agent:${ID.auto}` }));
      expect(err).toMatchObject({ status: 409, code: 'agent_needs_input' });
      expect(runtime.cancelRun).toHaveBeenCalledTimes(1);
      expect(runs.rows()[0].status).toBe(AgentRunStatus.CANCELLED);
    });

    it('streams the answer step token by token while the run works, and never the working step', async () => {
      const hold = runtime.streamAnswer();
      const stream = await client().chat.completions.create({
        model: `agent:${ID.auto}`,
        messages: [{ role: 'user', content: 'plan a trip' }],
        stream: true,
      });
      const deltas: string[] = [];
      let finishedAtFirstDelta: boolean | null = null;
      for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (!content) continue;
        if (finishedAtFirstDelta === null) {
          finishedAtFirstDelta = runtime.state.finished;
          hold.release();
        }
        deltas.push(content);
      }
      expect(finishedAtFirstDelta).toBe(false);
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.join('')).toBe('autonomous saw: plan a trip');
      expect(runtime.started[0].options.metadata).toMatchObject({ composeFinalAnswer: true });
    });

    it('does not ask a non-streaming run for the extra answer call', async () => {
      await ask('plan a trip', { model: `agent:${ID.auto}` });
      expect(runtime.started[0].options.metadata?.composeFinalAnswer).toBeUndefined();
    });
  });
});
