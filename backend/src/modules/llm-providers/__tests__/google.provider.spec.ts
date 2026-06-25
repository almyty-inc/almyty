import { callGoogle } from '../providers/google.provider';
import * as safeRequest from '../providers/safe-request';

/**
 * Regression: the Gemini call path hardcoded a dead `gemini-pro` default and
 * never read provider.configuration.model, and the base defaulted to /v1 where
 * current models 404. It must use the configured model on /v1beta.
 */
describe('callGoogle (Gemini)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses the configured model on the v1beta endpoint, not the dead gemini-pro default', async () => {
    let captured: any;
    jest.spyOn(safeRequest, 'callLlmProviderHttp').mockImplementation(async (cfg: any) => {
      captured = cfg;
      return {
        data: {
          candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        },
      } as any;
    });

    const provider: any = {
      getApiUrl: () => 'https://generativelanguage.googleapis.com/v1beta',
      getDecryptedApiKey: () => 'test-key',
      configuration: { model: 'gemini-2.0-flash' },
    };
    const request: any = { messages: [{ role: 'user', content: 'hi' }] }; // no per-request model
    const conversation: any = { id: 'c1', context: {} };

    const res = await callGoogle(provider, request, conversation, [], Date.now(), () => 0);

    expect(captured.url).toContain('/v1beta/models/gemini-2.0-flash:generateContent');
    expect(captured.url).not.toContain('gemini-pro');
    expect(res.message.content).toBe('ok');
  });
});
