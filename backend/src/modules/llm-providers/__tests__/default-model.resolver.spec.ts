import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { DefaultModelResolver, NoModelAvailableError, pickPreferredModel } from '../default-model.resolver';

function provider(type: LlmProviderType, model?: string, id = 'p1'): LlmProvider {
  return { id, name: 'Test', type, configuration: model ? { model } : {}, getApiUrl: () => '' } as unknown as LlmProvider;
}

describe('pickPreferredModel', () => {
  it('picks the newest Sonnet alias over dated snapshots and other families', () => {
    const ids = ['claude-opus-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514', 'claude-sonnet-4-5', 'claude-sonnet-5', 'claude-3-5-sonnet-20241022'];
    expect(pickPreferredModel(LlmProviderType.ANTHROPIC, ids)).toBe('claude-sonnet-5');
  });

  it('falls through to the next family when the vendor lists no Sonnet', () => {
    expect(pickPreferredModel(LlmProviderType.ANTHROPIC, ['claude-opus-4-1-20250805', 'claude-opus-5'])).toBe('claude-opus-5');
  });

  it('prefers a plain gpt-N over mini/nano, snapshots and non-chat models', () => {
    const ids = ['gpt-5-nano', 'gpt-5-mini', 'gpt-5', 'gpt-4o-2024-08-06', 'gpt-4o', 'text-embedding-3-large', 'whisper-1', 'gpt-4.1'];
    expect(pickPreferredModel(LlmProviderType.OPENAI, ids)).toBe('gpt-5');
  });

  it('never returns an embedding or audio model even when nothing else matches', () => {
    expect(pickPreferredModel(LlmProviderType.OPENAI, ['text-embedding-3-small', 'whisper-1'])).toBeUndefined();
  });

  it('picks Gemini flash, ignoring preview and image variants', () => {
    const ids = ['gemini-2.5-pro', 'gemini-2.5-flash-preview-04-17', 'gemini-2.5-flash-image', 'gemini-2.5-flash', 'gemini-2.0-flash'];
    expect(pickPreferredModel(LlmProviderType.GOOGLE, ids)).toBe('gemini-2.5-flash');
  });

  it('uses the vendor "-latest" alias for Mistral', () => {
    expect(pickPreferredModel(LlmProviderType.MISTRAL, ['mistral-small-latest', 'mistral-large-2411', 'mistral-large-latest'])).toBe('mistral-large-latest');
  });

  it('takes whatever a local or custom endpoint serves first', () => {
    expect(pickPreferredModel(LlmProviderType.OLLAMA, ['llama3.2:3b', 'qwen2.5'])).toBe('llama3.2:3b');
    expect(pickPreferredModel(LlmProviderType.CUSTOM, ['my-model'])).toBe('my-model');
  });

  it('contains no model ids of its own', () => {
    // The whole point: nothing in the resolver can rot. If a vendor lists
    // only ids we have never heard of, family regexes still match them.
    expect(pickPreferredModel(LlmProviderType.ANTHROPIC, ['claude-sonnet-9'])).toBe('claude-sonnet-9');
    expect(pickPreferredModel(LlmProviderType.OPENAI, ['gpt-12'])).toBe('gpt-12');
  });
});

describe('DefaultModelResolver', () => {
  let fetchModels: jest.Mock;
  let resolver: DefaultModelResolver;

  beforeEach(() => {
    fetchModels = jest.fn();
    resolver = new DefaultModelResolver({ fetchModelsFromProvider: fetchModels } as any);
  });

  it('returns the configured model without asking the vendor', async () => {
    await expect(resolver.resolve(provider(LlmProviderType.ANTHROPIC, 'claude-opus-5'))).resolves.toBe('claude-opus-5');
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it('asks the vendor once and caches the pick per provider', async () => {
    fetchModels.mockResolvedValue([{ id: 'claude-sonnet-5' }, { id: 'claude-opus-5' }]);
    const p = provider(LlmProviderType.ANTHROPIC);
    await expect(resolver.resolve(p)).resolves.toBe('claude-sonnet-5');
    await expect(resolver.resolve(p)).resolves.toBe('claude-sonnet-5');
    expect(fetchModels).toHaveBeenCalledTimes(1);
  });

  it('re-asks after invalidate', async () => {
    fetchModels.mockResolvedValueOnce([{ id: 'claude-sonnet-4-5' }]).mockResolvedValueOnce([{ id: 'claude-sonnet-5' }]);
    const p = provider(LlmProviderType.ANTHROPIC);
    await expect(resolver.resolve(p)).resolves.toBe('claude-sonnet-4-5');
    resolver.invalidate('p1');
    await expect(resolver.resolve(p)).resolves.toBe('claude-sonnet-5');
  });

  it('fails with an actionable error when the vendor lists nothing', async () => {
    fetchModels.mockResolvedValue([]);
    await expect(resolver.resolve(provider(LlmProviderType.OPENAI))).rejects.toBeInstanceOf(NoModelAvailableError);
    await expect(resolver.resolve(provider(LlmProviderType.OPENAI))).rejects.toThrow(/Set a model on the provider/);
  });

  it('fails rather than guessing when nothing the vendor lists is a chat model', async () => {
    fetchModels.mockResolvedValue([{ id: 'text-embedding-3-large' }]);
    await expect(resolver.resolve(provider(LlmProviderType.OPENAI))).rejects.toBeInstanceOf(NoModelAvailableError);
  });
});
