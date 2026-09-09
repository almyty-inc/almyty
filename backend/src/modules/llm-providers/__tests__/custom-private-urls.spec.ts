import { llmCallOptionsFor } from '../providers/safe-request';
import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';

/**
 * A self-hosted OpenAI-compatible server on the LAN is the normal case
 * for a custom provider or an endpoint card; the escape hatch mirrors the
 * Ollama one and stays off unless the operator turns it on.
 */
describe('private URLs for custom providers', () => {
  const provider = (type: LlmProviderType) => Object.assign(new LlmProvider(), { type, configuration: {} });
  const saved = { ollama: process.env.OLLAMA_ALLOW_PRIVATE_URLS, custom: process.env.LLM_ALLOW_PRIVATE_URLS };
  afterEach(() => {
    if (saved.ollama === undefined) delete process.env.OLLAMA_ALLOW_PRIVATE_URLS; else process.env.OLLAMA_ALLOW_PRIVATE_URLS = saved.ollama;
    if (saved.custom === undefined) delete process.env.LLM_ALLOW_PRIVATE_URLS; else process.env.LLM_ALLOW_PRIVATE_URLS = saved.custom;
  });

  it('stays blocked by default for every type', () => {
    delete process.env.OLLAMA_ALLOW_PRIVATE_URLS;
    delete process.env.LLM_ALLOW_PRIVATE_URLS;
    expect(llmCallOptionsFor(provider(LlmProviderType.CUSTOM)).allowPrivateUrls).toBe(false);
    expect(llmCallOptionsFor(provider(LlmProviderType.OLLAMA)).allowPrivateUrls).toBe(false);
    expect(llmCallOptionsFor(provider(LlmProviderType.OPENAI)).allowPrivateUrls).toBe(false);
  });

  it('LLM_ALLOW_PRIVATE_URLS opens custom providers only; OLLAMA_ALLOW_PRIVATE_URLS opens Ollama only', () => {
    process.env.LLM_ALLOW_PRIVATE_URLS = 'true';
    delete process.env.OLLAMA_ALLOW_PRIVATE_URLS;
    expect(llmCallOptionsFor(provider(LlmProviderType.CUSTOM)).allowPrivateUrls).toBe(true);
    expect(llmCallOptionsFor(provider(LlmProviderType.OLLAMA)).allowPrivateUrls).toBe(false);
    expect(llmCallOptionsFor(provider(LlmProviderType.OPENAI)).allowPrivateUrls).toBe(false);
    process.env.OLLAMA_ALLOW_PRIVATE_URLS = 'true';
    delete process.env.LLM_ALLOW_PRIVATE_URLS;
    expect(llmCallOptionsFor(provider(LlmProviderType.OLLAMA)).allowPrivateUrls).toBe(true);
    expect(llmCallOptionsFor(provider(LlmProviderType.CUSTOM)).allowPrivateUrls).toBe(false);
  });
});
