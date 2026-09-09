import { LlmChatHelper } from '../llm-chat.helper';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../entities/llm-provider.entity';

jest.mock('../providers', () => ({
  ...jest.requireActual('../providers'),
  callOpenAIStream: jest.fn(),
}));
const { callOpenAIStream } = require('../providers');

/**
 * The streaming path cannot walk a route once tokens are out, so it takes
 * the head of the plan up front and stamps the same attribution the
 * non-streaming walk would for attempt 1.
 */
describe('LlmChatHelper.chatStream with a routing policy', () => {
  const provider = Object.assign(new LlmProvider(), {
    id: 'p-head', organizationId: 'org', name: 'head', type: LlmProviderType.OPENAI, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: { model: 'cfg-model' },
  });
  const candidate = { modelId: 'card-1', modelVersionId: 'v-1', vendorModelId: 'gpt-cheap', providerId: 'p-head', rationale: 'cheapest ($0.10/M blended), rank 1', card: { providerId: 'p-head' }, provider };

  function build() {
    const savedMessage = { id: 'msg-1' };
    const session = { id: 'conv-1', organizationId: 'org', userId: 'u', context: {} };
    const runner = {
      planRouteHead: jest.fn().mockResolvedValue({ provider, candidate, rejected: [{ modelId: 'card-2', reason: 'lacks tools' }] }),
      recordRoute: jest.fn(),
      prepareTools: jest.fn().mockResolvedValue([]),
    };
    const providers = { getProvider: jest.fn() };
    const helper = new LlmChatHelper(
      {} as any,
      { save: jest.fn().mockResolvedValue(session), findOne: jest.fn() } as any,
      { create: jest.fn((m: any) => m), save: jest.fn().mockResolvedValue(savedMessage) } as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      { log: jest.fn() } as any,
      { calculateProviderCost: jest.fn().mockReturnValue(0) } as any,
      providers as any,
      { bumpSessionStats: jest.fn().mockResolvedValue(undefined), bumpProviderStats: jest.fn().mockResolvedValue(undefined) } as any,
      runner as any,
      { resolve: jest.fn() } as any,
      { warmOrg: jest.fn().mockResolvedValue(undefined) } as any,
    );
    return { helper, runner, providers };
  }

  it('streams from the head candidate with its vendor model id and stamps attribution', async () => {
    const { helper, runner, providers } = build();
    callOpenAIStream.mockResolvedValue({ message: { role: 'assistant', content: 'hi' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: 0, model: 'gpt-cheap', responseTime: 5 });
    const res = await helper.chatStream(undefined, { messages: [], routing: { objective: 'cheapest' } } as any, 'org', 'u', () => undefined);
    expect(runner.planRouteHead).toHaveBeenCalledWith('org', expect.objectContaining({ routing: { objective: 'cheapest' } }), { id: 'u' });
    expect(providers.getProvider).not.toHaveBeenCalled();
    const [calledProvider, calledRequest] = callOpenAIStream.mock.calls[0];
    expect(calledProvider.id).toBe('p-head');
    expect(calledRequest.model).toBe('gpt-cheap');
    expect(calledRequest.routing).toBeUndefined();
    expect(res.routing).toEqual({ modelId: 'card-1', modelVersionId: 'v-1', vendorModelId: 'gpt-cheap', providerId: 'p-head', rationale: candidate.rationale, attempt: 1, tried: [], rejected: [{ modelId: 'card-2', reason: 'lacks tools' }] });
    expect(runner.recordRoute).toHaveBeenCalledWith('org', res.routing, { userId: 'u', conversationId: 'conv-1' });
  });

  it('surfaces NO_ROUTE before opening any stream', async () => {
    const { helper, runner } = build();
    runner.planRouteHead.mockRejectedValue(Object.assign(new Error('no route'), { code: 'NO_ROUTE' }));
    await expect(helper.chatStream(undefined, { messages: [], routing: {} } as any, 'org', 'u', () => undefined)).rejects.toMatchObject({ code: 'NO_ROUTE' });
    expect(callOpenAIStream).not.toHaveBeenCalledTimes(2);
  });
});
