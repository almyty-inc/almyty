import { LlmModelsHelper } from '../llm-models.helper';
import { LlmProviderType } from '../../../entities/llm-provider.entity';
import { callLlmProviderHttp } from '../providers/safe-request';

jest.mock('../providers/safe-request', () => ({
  callLlmProviderHttp: jest.fn(),
}));

const mockedCall = callLlmProviderHttp as jest.Mock;

describe('LlmModelsHelper.fetchModelsByType', () => {
  const helper = new LlmModelsHelper();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('surfaces Codestral models for Mistral and filters out embedding/moderation models', async () => {
    // Shape of Mistral's OpenAI-compat GET /v1/models response.
    mockedCall.mockResolvedValue({
      data: {
        data: [
          { id: 'mistral-large-latest', created: 5 },
          { id: 'mistral-small-latest', created: 4 },
          { id: 'codestral-latest', created: 3 },
          { id: 'codestral-2501', created: 2 },
          { id: 'mistral-embed', created: 1 },
          { id: 'codestral-embed', created: 1 },
          { id: 'mistral-moderation-latest', created: 1 },
        ],
      },
    });

    const models = await helper.fetchModelsByType(LlmProviderType.MISTRAL, 'key');
    const ids = models.map((m) => m.id);

    // Per-type default base URL — a temp provider without a configured
    // apiUrl must probe Mistral, not OpenAI.
    expect(mockedCall).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://api.mistral.ai/v1/models' }),
    );

    expect(ids).toContain('codestral-latest');
    expect(ids).toContain('codestral-2501');
    expect(ids).toContain('mistral-large-latest');
    expect(ids).toContain('mistral-small-latest');
    expect(ids).not.toContain('mistral-embed');
    expect(ids).not.toContain('codestral-embed');
    expect(ids).not.toContain('mistral-moderation-latest');
  });

  it('keeps the GPT/o-series-only filter for OpenAI', async () => {
    mockedCall.mockResolvedValue({
      data: {
        data: [
          { id: 'gpt-4o', created: 3 },
          { id: 'o3', created: 3 },
          { id: 'text-embedding-3-small', created: 2 },
          { id: 'whisper-1', created: 1 },
          { id: 'davinci-002', created: 1 },
        ],
      },
    });

    const models = await helper.fetchModelsByType(LlmProviderType.OPENAI, 'key');
    const ids = models.map((m) => m.id);

    expect(ids).toEqual(expect.arrayContaining(['gpt-4o', 'o3']));
    expect(ids).not.toContain('text-embedding-3-small');
    expect(ids).not.toContain('whisper-1');
    expect(ids).not.toContain('davinci-002');
  });
});
