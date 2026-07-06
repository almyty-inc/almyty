import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { LlmModelsHelper } from '../llm-models.helper';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { MessageRole } from '../../../entities/message.entity';

jest.mock('../providers/safe-request', () => {
  const actual = jest.requireActual('../providers/safe-request');
  return {
    ...actual,
    callLlmProviderHttp: jest.fn(),
    callLlmProviderHttpStream: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { callLlmProviderHttp } = require('../providers/safe-request');

/**
 * Ollama provider type: keyless local inference over the OpenAI-compat
 * /v1 surface for chat, native /api/tags for models, zero-cost pricing.
 * All HTTP is mocked; the SSRF/env-gate behavior of the real
 * safe-request module is covered separately in ollama-ssrf.spec.ts.
 */

function ollamaProvider(overrides: Partial<LlmProvider['configuration']> = {}): LlmProvider {
  const p = new LlmProvider();
  p.type = LlmProviderType.OLLAMA;
  p.configuration = { ...overrides } as any;
  return p;
}

const chatResponse = {
  data: {
    id: 'chatcmpl-1',
    model: 'llama3.2',
    choices: [{ message: { content: 'hello from llama' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  },
};

describe('ollama URL resolution', () => {
  it('getApiUrl defaults to the local server with the /v1 compat suffix', () => {
    expect(ollamaProvider().getApiUrl()).toBe('http://localhost:11434/v1');
  });

  it('getApiUrl appends /v1 to a configured server root', () => {
    const p = ollamaProvider({ apiUrl: 'https://ollama.example.com' });
    expect(p.getApiUrl()).toBe('https://ollama.example.com/v1');
  });

  it('getApiUrl does not double a /v1 suffix the user already included', () => {
    const p = ollamaProvider({ apiUrl: 'https://ollama.example.com/v1' });
    expect(p.getApiUrl()).toBe('https://ollama.example.com/v1');
  });

  it('getOllamaBaseUrl strips a configured /v1 suffix for the native endpoints', () => {
    expect(ollamaProvider().getOllamaBaseUrl()).toBe('http://localhost:11434');
    expect(ollamaProvider({ apiUrl: 'https://ollama.example.com/v1' }).getOllamaBaseUrl())
      .toBe('https://ollama.example.com');
    expect(ollamaProvider({ apiUrl: 'https://ollama.example.com/' }).getOllamaBaseUrl())
      .toBe('https://ollama.example.com');
  });
});

describe('ollama keyless auth', () => {
  it('sends no Authorization header when no key is configured', () => {
    const headers = ollamaProvider().getAuthHeaders();
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('sends a Bearer token when a key is configured (auth proxy in front of Ollama)', () => {
    const headers = ollamaProvider({ apiKey: 'proxy-token' }).getAuthHeaders();
    expect(headers['Authorization']).toBe('Bearer proxy-token');
  });
});

describe('ollama chat dispatch (OpenAI-compat path)', () => {
  const runner = new LlmChatRunnerHelper({} as any, {} as any, new LlmModelsHelper());
  const session = { context: {} } as any;
  const request = {
    messages: [{ role: MessageRole.USER, content: 'hi' }],
    model: 'llama3.2',
  } as any;

  beforeEach(() => {
    (callLlmProviderHttp as jest.Mock).mockReset();
    (callLlmProviderHttp as jest.Mock).mockResolvedValue(chatResponse);
  });

  it('routes chat to <base>/v1/chat/completions without an auth header when keyless', async () => {
    const provider = ollamaProvider({ apiUrl: 'https://ollama.example.com' });
    const response = await runner.dispatchProviderCall(provider, request, session, [], Date.now());

    expect(callLlmProviderHttp).toHaveBeenCalledTimes(1);
    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.url).toBe('https://ollama.example.com/v1/chat/completions');
    expect(cfg.method).toBe('POST');
    expect(cfg.headers['Authorization']).toBeUndefined();
    expect(cfg.data.model).toBe('llama3.2');
    expect(response.message.content).toBe('hello from llama');
  });

  it('sends a Bearer token on chat when a key is configured', async () => {
    const provider = ollamaProvider({ apiUrl: 'https://ollama.example.com', apiKey: 'proxy-token' });
    await runner.dispatchProviderCall(provider, request, session, [], Date.now());

    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.headers['Authorization']).toBe('Bearer proxy-token');
  });

  it('passes the per-call SSRF options for the provider to the safe-request gate', async () => {
    const provider = ollamaProvider({ apiUrl: 'https://ollama.example.com' });
    await runner.dispatchProviderCall(provider, request, session, [], Date.now());

    // Second arg is the LlmCallOptions computed by llmCallOptionsFor —
    // gate closed here because OLLAMA_ALLOW_PRIVATE_URLS is unset.
    const opts = (callLlmProviderHttp as jest.Mock).mock.calls[0][1];
    expect(opts).toEqual({ allowPrivateUrls: false });
  });

  it('reports zero cost for ollama chat usage', async () => {
    const provider = ollamaProvider({ apiUrl: 'https://ollama.example.com', model: 'mistral-large' });
    const response = await runner.dispatchProviderCall(provider, request, session, [], Date.now());
    expect(response.cost).toBe(0);
  });
});

describe('ollama models list (/api/tags)', () => {
  const helper = new LlmModelsHelper();

  const tagsResponse = {
    data: {
      models: [
        { name: 'llama3.2:latest', model: 'llama3.2:latest', modified_at: '2026-05-01T10:00:00Z' },
        { name: 'qwen3:8b', model: 'qwen3:8b', modified_at: '2026-06-01T10:00:00Z' },
      ],
    },
  };

  beforeEach(() => {
    (callLlmProviderHttp as jest.Mock).mockReset();
    (callLlmProviderHttp as jest.Mock).mockResolvedValue(tagsResponse);
  });

  it('fetchModelsFromProvider hits <base>/api/tags without auth when keyless', async () => {
    const provider = ollamaProvider({ apiUrl: 'https://ollama.example.com/v1' });
    const models = await helper.fetchModelsFromProvider(provider);

    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.url).toBe('https://ollama.example.com/api/tags');
    expect(cfg.headers['Authorization']).toBeUndefined();

    // Sorted newest first, parsed into id/name/owned_by.
    expect(models.map(m => m.id)).toEqual(['qwen3:8b', 'llama3.2:latest']);
    expect(models[0].owned_by).toBe('ollama');
  });

  it('fetchModelsFromProvider sends a Bearer token when a key is configured', async () => {
    const provider = ollamaProvider({ apiUrl: 'https://ollama.example.com', apiKey: 'proxy-token' });
    await helper.fetchModelsFromProvider(provider);
    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.headers['Authorization']).toBe('Bearer proxy-token');
  });

  it('fetchModelsByType works with an empty apiKey (keyless pre-creation probe)', async () => {
    const models = await helper.fetchModelsByType(LlmProviderType.OLLAMA, '');

    const cfg = (callLlmProviderHttp as jest.Mock).mock.calls[0][0];
    expect(cfg.url).toBe('http://localhost:11434/api/tags');
    expect(cfg.headers['Authorization']).toBeUndefined();
    expect(models).toHaveLength(2);
  });

  it('propagates a failed tags call so test-connection reports the failure', async () => {
    // Same contract as every other provider type: the async rejection
    // surfaces to the caller (the /test-connection endpoint turns it
    // into ok:false; the controller's models endpoint into a 4xx).
    (callLlmProviderHttp as jest.Mock).mockRejectedValue(new Error('connection refused'));
    await expect(helper.fetchModelsFromProvider(ollamaProvider())).rejects.toThrow('connection refused');
  });
});

describe('ollama capabilities and pricing', () => {
  const helper = new LlmModelsHelper();

  it('defaults to the OpenAI-compat capability set (tools + streaming)', () => {
    const caps = helper.getDefaultCapabilities(LlmProviderType.OLLAMA);
    expect(caps.supportsToolUse).toBe(true);
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsFunctionCalling).toBe(true);
    expect(caps.supportedToolFormats).toEqual(['openai']);
  });
});
