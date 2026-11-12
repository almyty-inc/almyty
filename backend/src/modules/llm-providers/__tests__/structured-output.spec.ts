import { callOpenAI } from '../providers/openai.provider';
import { callGoogle } from '../providers/google.provider';
import * as safeRequest from '../providers/safe-request';
import { LlmProviderType } from '../../../entities/llm-provider.entity';
import { VERDICT_SCHEMA } from '../../agents/agent-verifier.helper';

/**
 * A checker's verdict is asked for in a JSON schema where the API takes
 * one (structured-output.ts): real failures and confirmations in separate
 * lists. A host that does not take it would answer 400, so it is sent to
 * those APIs only.
 */
describe('structured output on the wire', () => {
  let sent: any[];
  beforeEach(() => {
    sent = [];
    jest.spyOn(safeRequest, 'callLlmProviderHttp').mockImplementation(async (cfg: any) => {
      sent.push(cfg.data);
      if (String(cfg.url).includes('generateContent')) {
        return { data: { candidates: [{ content: { parts: [{ text: '{}' }] } }], usageMetadata: {} } } as any;
      }
      return { data: { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } } as any;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const conversation: any = { id: 'c1', context: {} };
  const request: any = { messages: [{ role: 'user', content: 'check' }], responseFormat: { name: 'checker_verdict', schema: VERDICT_SCHEMA } };
  const chatCompletions = (type: LlmProviderType): any => ({
    type,
    getApiUrl: () => 'https://api.example.com/v1',
    getAuthHeaders: () => ({ Authorization: 'Bearer k' }),
    configuration: { model: 'gpt-4.1-mini' },
  });

  it('OpenAI gets a strict json_schema response_format', async () => {
    await callOpenAI(chatCompletions(LlmProviderType.OPENAI), request, conversation, [], Date.now(), () => 0);
    expect(sent[0].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'checker_verdict', schema: VERDICT_SCHEMA, strict: true } });
  });

  it('an OpenAI-compatible host that may not take it gets the request without it', async () => {
    await callOpenAI(chatCompletions(LlmProviderType.GROQ), request, conversation, [], Date.now(), () => 0);
    expect(sent[0].response_format).toBeUndefined();
  });

  it('a request without a format sends none', async () => {
    await callOpenAI(chatCompletions(LlmProviderType.OPENAI), { messages: request.messages }, conversation, [], Date.now(), () => 0);
    expect(sent[0].response_format).toBeUndefined();
  });

  it('Gemini gets responseMimeType and the schema without additionalProperties', async () => {
    const provider: any = {
      type: LlmProviderType.GOOGLE,
      getApiUrl: () => 'https://generativelanguage.googleapis.com/v1beta',
      getDecryptedApiKey: () => 'k',
      configuration: { model: 'gemini-2.5-flash' },
    };
    await callGoogle(provider, request, conversation, [], Date.now(), () => 0);
    const config = sent[0].generationConfig;
    expect(config.responseMimeType).toBe('application/json');
    expect(config.responseSchema.properties.confirmed).toEqual({ type: 'array', items: { type: 'string' } });
    expect(JSON.stringify(config.responseSchema)).not.toContain('additionalProperties');
  });
});
