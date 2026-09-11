import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { ModelNotFoundError } from '../model-errors';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../entities/llm-provider.entity';

/**
 * The routed walk: candidates in plan order, advance on failures that are
 * not the request's fault, stop on the ones that are, attribution on the
 * answer.
 */
describe('LlmChatRunnerHelper.callRouted', () => {
  const provider = (id: string) => Object.assign(new LlmProvider(), {
    id, organizationId: 'org', name: id, type: LlmProviderType.CUSTOM, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: {},
  });
  const candidate = (modelId: string, vendorModelId: string, rationale = 'cheapest') => ({
    modelId, vendorModelId, modelVersionId: 'v-' + modelId, providerId: 'p-' + modelId, rationale,
    card: { providerId: 'p-' + modelId } as any, provider: provider('p-' + modelId),
  });
  const session = { id: 'conv', organizationId: 'org', userId: 'u' } as any;
  const ok = (model: string) => ({ message: { role: 'assistant', content: 'hi' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: 0, model, conversationId: 'conv', messageId: 'm', responseTime: 1 });

  function build(plan: { candidates: any[]; rejected: any[] }, dispatch: jest.Mock) {
    const router = { plan: jest.fn().mockResolvedValue(plan), recordRoute: jest.fn(), recordLatency: jest.fn().mockResolvedValue(undefined) };
    const runner = new LlmChatRunnerHelper(
      {} as any, {} as any, {} as any,
      { warmOrg: jest.fn().mockResolvedValue(undefined) } as any,
      { resolve: jest.fn(), invalidate: jest.fn() } as any,
      router as any,
    );
    runner.dispatchProviderCall = dispatch as any;
    runner.sleep = jest.fn().mockResolvedValue(undefined);
    return { runner, router };
  }

  it('answers from the first candidate and stamps attribution', async () => {
    const dispatch = jest.fn().mockResolvedValue(ok('cheap'));
    const { runner, router } = build({ candidates: [candidate('a', 'cheap'), candidate('b', 'dear')], rejected: [{ modelId: 'z', reason: 'lacks vision' }] }, dispatch);
    const res = await runner.callLlmProvider(provider('ignored'), { messages: [], routing: { objective: 'cheapest' } }, session, []);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].id).toBe('p-a');
    expect(dispatch.mock.calls[0][1].model).toBe('cheap');
    expect(dispatch.mock.calls[0][1].routing).toBeUndefined();
    expect(res.routing).toEqual({
      modelId: 'a', modelVersionId: 'v-a', vendorModelId: 'cheap', providerId: 'p-a', rationale: 'cheapest', attempt: 1, tried: [], rejected: [{ modelId: 'z', reason: 'lacks vision' }],
    });
    expect(router.recordRoute).toHaveBeenCalledWith('org', res.routing, { userId: 'u', conversationId: 'conv' });
    expect(router.recordLatency).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'p-a' }), 1);
  });

  it('moves to the next candidate when a model is retired', async () => {
    const dispatch = jest.fn()
      .mockRejectedValueOnce({ response: { status: 404, data: { error: { message: 'model not found' } } } })
      .mockResolvedValueOnce(ok('dear'));
    const { runner } = build({ candidates: [candidate('a', 'cheap'), candidate('b', 'dear', 'rank 2')], rejected: [] }, dispatch);
    const res = await runner.callLlmProvider(provider('x'), { messages: [], routing: {} }, session, []);
    expect(res.routing?.attempt).toBe(2);
    expect(res.routing?.modelId).toBe('b');
    expect(res.routing?.tried).toEqual([{ modelId: 'a', reason: 'MODEL_NOT_FOUND' }]);
  });

  it('moves on after retries are exhausted on an outage', async () => {
    const dispatch = jest.fn()
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce(ok('dear'));
    const { runner } = build({ candidates: [candidate('a', 'cheap'), candidate('b', 'dear')], rejected: [] }, dispatch);
    const res = await runner.callLlmProvider(provider('x'), { messages: [], routing: {} }, session, []);
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(res.routing?.modelId).toBe('b');
    expect(res.routing?.tried[0]).toEqual({ modelId: 'a', reason: '503' });
  });

  it('stops on a request-shaped failure instead of walking the chain', async () => {
    const dispatch = jest.fn().mockRejectedValue({ response: { status: 400, data: { error: { message: 'bad prompt' } } } });
    const { runner } = build({ candidates: [candidate('a', 'cheap'), candidate('b', 'dear')], rejected: [] }, dispatch);
    await expect(runner.callLlmProvider(provider('x'), { messages: [], routing: {} }, session, [])).rejects.toMatchObject({ response: { status: 400 } });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('fails with NO_ROUTE when nothing is eligible', async () => {
    const { runner } = build({ candidates: [], rejected: [{ modelId: 'a', reason: 'not usable yet' }] }, jest.fn());
    await expect(runner.callLlmProvider(provider('x'), { messages: [], routing: {} }, session, [])).rejects.toMatchObject({ code: 'NO_ROUTE' });
  });

  it('reports exhaustion with the whole trail when every candidate fails', async () => {
    const dispatch = jest.fn().mockRejectedValue(new ModelNotFoundError('m', 'p', 'custom'));
    const { runner } = build({ candidates: [candidate('a', 'x'), candidate('b', 'y')], rejected: [] }, dispatch);
    await expect(runner.callLlmProvider(provider('x'), { messages: [], routing: {} }, session, [])).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND', tried: [{ modelId: 'a', reason: 'MODEL_NOT_FOUND' }, { modelId: 'b', reason: 'MODEL_NOT_FOUND' }],
    });
  });

  it('refuses routing when the router is not wired', async () => {
    const runner = new LlmChatRunnerHelper({} as any, {} as any, {} as any, { warmOrg: jest.fn() } as any, { resolve: jest.fn() } as any);
    await expect(runner.callLlmProvider(provider('x'), { messages: [], routing: {} }, session, [])).rejects.toMatchObject({ response: { code: 'ROUTING_UNAVAILABLE' } });
  });
});
