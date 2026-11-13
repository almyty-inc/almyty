import { OutputLimitResolver, outputLimitFor, stoppedAtOutputLimit } from '../output-limit';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { LlmProviderType } from '../../../entities/llm-provider.entity';
import { callCustomProvider } from '../providers/google.provider';
import { ANTHROPIC_UNCARDED_MAX_TOKENS } from '../providers/anthropic.provider';
import * as safeRequest from '../providers/safe-request';

/**
 * Every call writes with the room its model has: the model card's
 * maxOutputTokens, unless the call (an agent role, a node) or the provider
 * names a limit. The main role of an autonomous agent names none, and
 * Claude calls without one went out at 1024 tokens: 6 of 10 runs stopped
 * there with no answer (model comparison, 2026-11-13).
 */
describe('outputLimitFor', () => {
  const provider = (maxTokens?: number) => ({ configuration: { maxTokens } }) as any;

  it("is the card's most when nothing else names a limit", () => {
    expect(outputLimitFor({}, provider(), 128_000)).toBe(128_000);
  });

  it("is the caller's limit when one is given", () => {
    expect(outputLimitFor({ maxTokens: 16_000 }, provider(), 128_000)).toBe(16_000);
  });

  it("is the provider's own setting before the card", () => {
    expect(outputLimitFor({}, provider(32_000), 128_000)).toBe(32_000);
  });

  it("lowers a limit above the card's to the card's", () => {
    expect(outputLimitFor({ maxTokens: 200_000 }, provider(), 64_000)).toBe(64_000);
  });

  it('is undefined with no card and no setting (the adapter decides, never a low default)', () => {
    expect(outputLimitFor({}, provider(), null)).toBeUndefined();
  });
});

describe('stoppedAtOutputLimit', () => {
  it.each(['max_tokens', 'length', 'MAX_TOKENS', 'max_output_tokens', 'model_context_window_exceeded'])('%s is the output limit', (reason) => {
    expect(stoppedAtOutputLimit(reason)).toBe(true);
  });
  it.each(['end_turn', 'stop', 'tool_use', 'STOP', '', undefined])('%s is not', (reason) => {
    expect(stoppedAtOutputLimit(reason as any)).toBe(false);
  });
});

describe('the runner sends the card limit on a call that names none', () => {
  const card = { maxOutputTokens: 128_000 };
  const models = { findOne: jest.fn(async () => card) };
  const provider: any = {
    id: 'p1',
    organizationId: 'org1',
    type: LlmProviderType.ANTHROPIC,
    configuration: { model: 'claude-opus-5-5' },
  };
  const envelope: any = { warmOrg: jest.fn(async () => undefined) };
  const runner = new LlmChatRunnerHelper(
    {} as any,
    {} as any,
    {} as any,
    envelope,
    { resolve: jest.fn(async () => 'claude-opus-5-5') } as any,
    undefined,
    undefined,
    undefined,
    new OutputLimitResolver(models as any),
  );

  it('callWithRetries hands the adapter the card limit', async () => {
    const dispatch = jest.spyOn(runner, 'dispatchProviderCall').mockResolvedValue({ message: {} } as any);
    await runner.callWithRetries(provider, { messages: [], model: 'claude-opus-5-5' } as any, { organizationId: 'org1' } as any, []);
    expect(dispatch.mock.calls[0][1].maxTokens).toBe(128_000);
    expect(models.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org1', providerId: 'p1', vendorModelId: 'claude-opus-5-5' } }),
    );
  });

  it("keeps the agent's own setting", async () => {
    const dispatch = jest.spyOn(runner, 'dispatchProviderCall').mockResolvedValue({ message: {} } as any);
    await runner.callWithRetries(provider, { messages: [], model: 'claude-opus-5-5', maxTokens: 9_000 } as any, { organizationId: 'org1' } as any, []);
    expect(dispatch.mock.calls[0][1].maxTokens).toBe(9_000);
  });
});

describe('a custom endpoint in the Anthropic format', () => {
  afterEach(() => jest.restoreAllMocks());

  it('always sends max_tokens, which that format requires, and never a low one', async () => {
    const sent: any[] = [];
    jest.spyOn(safeRequest, 'callLlmProviderHttp').mockImplementation(async (cfg: any) => {
      sent.push(cfg.data);
      return { data: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } } as any;
    });
    const custom: any = {
      type: LlmProviderType.CUSTOM,
      getApiUrl: () => 'https://llm.example.test/v1/messages',
      getAuthHeaders: () => ({}),
      configuration: { model: 'claude-on-my-proxy', custom: { requestFormat: 'anthropic' } },
    };
    await callCustomProvider(custom, { messages: [{ role: 'user', content: 'hi' }] } as any, { id: 'c', context: {} } as any, [], Date.now());
    expect(sent[0].max_tokens).toBe(ANTHROPIC_UNCARDED_MAX_TOKENS);
  });
});
