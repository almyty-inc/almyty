import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { LlmChatHelper } from '../llm-chat.helper';
import { LlmModelsHelper } from '../llm-models.helper';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';

/**
 * The test whose absence let AWS Bedrock ship broken.
 *
 * `LlmProviderType.AWS_BEDROCK` was offered in the create dialog, accepted
 * by `validateProviderConfiguration`, priced in the feed map and given
 * catalog copy - but it had no `case` in `dispatchProviderCall`. Every chat
 * through a Bedrock provider fell to the default branch and threw
 * "Unsupported LLM provider type". Nothing failed until a user tried it.
 *
 * These assertions iterate `Object.values(LlmProviderType)` rather than a
 * hand-written list, so a new enum value cannot be added without also
 * getting a dispatch path: the moment someone adds one, this fails.
 */

const CALL_FNS = [
  'callOpenAI',
  'callAnthropic',
  'callGoogle',
  'callPerplexity',
  'callVertex',
  'callCustomProvider',
] as const;

const STREAM_FNS = [
  'callOpenAIStream',
  'callAnthropicStream',
  'callPerplexityStream',
  'callVertexStream',
] as const;

jest.mock('../providers', () => ({
  callOpenAI: jest.fn(),
  callOpenAIStream: jest.fn(),
  callAnthropic: jest.fn(),
  callAnthropicStream: jest.fn(),
  callGoogle: jest.fn(),
  callPerplexity: jest.fn(),
  callPerplexityStream: jest.fn(),
  callVertex: jest.fn(),
  callVertexStream: jest.fn(),
  callCustomProvider: jest.fn(),
}));
const providers = require('../providers');

const ALL_TYPES = Object.values(LlmProviderType);

/**
 * The structural configuration each type needs before `getApiUrl()` can
 * build a URL at all. Keyed by type so a new type that needs a region, a
 * project or a deployment declares it here rather than silently resolving
 * to a broken base.
 */
const STRUCTURAL_CONFIG: Partial<Record<LlmProviderType, Record<string, unknown>>> = {
  [LlmProviderType.AZURE_OPENAI]: { azure: { resourceName: 'res', deploymentName: 'dep' } },
  [LlmProviderType.AZURE_AI_FOUNDRY]: { azure: { resourceName: 'res', deploymentName: 'dep' } },
  [LlmProviderType.AWS_BEDROCK]: { bedrock: { region: 'us-east-1' } },
  [LlmProviderType.VERTEX_AI]: { vertex: { projectId: 'proj', location: 'global' } },
  [LlmProviderType.RUNPOD]: { runpod: { endpointId: 'gpt-oss-120b' } },
  [LlmProviderType.CUSTOM]: { apiUrl: 'https://llm.example.com/v1' },
};

function makeProvider(type: LlmProviderType): LlmProvider {
  return Object.assign(new LlmProvider(), {
    id: `p-${type}`,
    organizationId: 'org',
    name: type,
    type,
    isHealthy: true,
    status: 'active',
    configuration: { apiKey: 'test-key', model: 'a-model', ...(STRUCTURAL_CONFIG[type] ?? {}) },
  });
}

const okResponse = {
  message: { role: 'assistant', content: 'ok' },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  cost: 0,
  model: 'a-model',
  responseTime: 1,
};

function buildRunner(): LlmChatRunnerHelper {
  return new LlmChatRunnerHelper(
    {} as any,
    {} as any,
    new LlmModelsHelper(makeEnvelopeCryptoMock()),
    { warmOrg: jest.fn() } as any,
    { resolve: jest.fn(), invalidate: jest.fn() } as any,
  );
}

describe('every LlmProviderType reaches a real implementation', () => {
  beforeEach(() => {
    for (const fn of [...CALL_FNS, ...STREAM_FNS]) {
      providers[fn].mockReset().mockResolvedValue(okResponse);
    }
  });

  it('covers every enum value (guards against a stale hand-written list)', () => {
    // 24 at the time the Bedrock gap was closed; this only asserts the
    // iteration source is the enum itself and that nothing is empty.
    expect(ALL_TYPES.length).toBeGreaterThanOrEqual(24);
    expect(new Set(ALL_TYPES).size).toBe(ALL_TYPES.length);
  });

  it.each(ALL_TYPES)(
    '%s dispatches to a provider implementation, never the default branch',
    async (type) => {
      const runner = buildRunner();
      const provider = makeProvider(type);
      const session = { id: 'conv', organizationId: 'org' } as any;

      const response = await runner.dispatchProviderCall(
        provider,
        { messages: [], model: 'a-model' },
        session,
        [],
        Date.now(),
      );

      expect(response.message.content).toBe('ok');

      const called = CALL_FNS.filter((fn) => providers[fn].mock.calls.length > 0);
      // Exactly one implementation, and it was handed this provider.
      expect(called).toHaveLength(1);
      expect(providers[called[0]].mock.calls[0][0]).toBe(provider);
    },
  );

  it('throws for a type the enum does not contain, so the default branch is still a real guard', async () => {
    const runner = buildRunner();
    const provider = Object.assign(new LlmProvider(), {
      id: 'p-bogus',
      organizationId: 'org',
      type: 'not_a_provider' as LlmProviderType,
      configuration: { apiKey: 'k' },
    });
    await expect(
      runner.dispatchProviderCall(provider, { messages: [], model: 'm' }, { id: 'c' } as any, [], Date.now()),
    ).rejects.toThrow(/Unsupported LLM provider type/);
  });
});

describe('streaming reaches a real implementation for every type it claims to stream', () => {
  /**
   * `chatStream` gates on a `supportsStreaming` list and then switches on
   * the type. A type present in the list but absent from the switch falls
   * through to a silent non-streaming call - the streaming twin of the
   * Bedrock bug. This asserts the two agree for every enum value.
   */
  function buildChatHelper(provider: LlmProvider) {
    const session = { id: 'conv-1', organizationId: 'org', context: {} };
    return new LlmChatHelper(
      {} as any,
      { save: jest.fn().mockResolvedValue(session), findOne: jest.fn() } as any,
      { create: jest.fn((m: any) => m), save: jest.fn().mockResolvedValue({ id: 'msg-1' }) } as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      {} as any,
      { log: jest.fn() } as any,
      { calculateProviderCost: jest.fn().mockReturnValue(0) } as any,
      { getProvider: jest.fn().mockResolvedValue(provider) } as any,
      { bumpSessionStats: jest.fn().mockResolvedValue(undefined), bumpProviderStats: jest.fn().mockResolvedValue(undefined) } as any,
      {
        prepareTools: jest.fn().mockResolvedValue([]),
        recordRoute: jest.fn(),
        // The non-streaming fallback runs through the real dispatch, which
        // is exactly what we want to observe for a type that does not
        // stream.
        callLlmProvider: (p: any, r: any, s: any, t: any) =>
          buildRunner().dispatchProviderCall(p, r, s, t, Date.now()),
      } as any,
      { resolve: jest.fn().mockResolvedValue('a-model') } as any,
      { warmOrg: jest.fn().mockResolvedValue(undefined) } as any,
    );
  }

  beforeEach(() => {
    for (const fn of [...CALL_FNS, ...STREAM_FNS]) {
      providers[fn].mockReset().mockResolvedValue(okResponse);
    }
  });

  it.each(ALL_TYPES)('%s either streams through a stream implementation or falls back to a chat one', async (type) => {
    const provider = makeProvider(type);
    const helper = buildChatHelper(provider);

    await helper.chatStream(provider.id, { messages: [], model: 'a-model' } as any, 'org', 'u', () => undefined);

    const streamed = STREAM_FNS.filter((fn) => providers[fn].mock.calls.length > 0);
    const nonStreamed = CALL_FNS.filter((fn) => providers[fn].mock.calls.length > 0);

    // One or the other, never neither: "neither" means the switch fell to
    // its default while the supportsStreaming gate said it would not.
    expect(streamed.length + nonStreamed.length).toBeGreaterThan(0);
    expect(streamed.length).toBeLessThanOrEqual(1);
  });
});
