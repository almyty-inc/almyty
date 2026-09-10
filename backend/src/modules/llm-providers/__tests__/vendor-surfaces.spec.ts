import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { LlmModelsHelper } from '../llm-models.helper';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { readVertexCredential, VertexCredentialError } from '../providers/vertex.provider';
import { chatCompletionsUrl } from '../providers/openai.provider';

/**
 * Base URL, auth header and capability facts for every surface corrected or
 * added on 2026-09-09. Each row is traceable to the matrix in
 * docs/design/call-only-vendors.md, which carries the source URL.
 *
 * These are the assertions that would have caught the shipped defects:
 * Bedrock with no dispatch, Azure sending an API key as a Bearer token
 * against a URL with a query string in the middle of it, Hugging Face
 * pointed at a host that no longer resolves, Cohere sending a v1 body to a
 * v2 path, and Together on an undocumented alias host.
 */
function makeProvider(type: LlmProviderType, configuration: Record<string, unknown> = {}): LlmProvider {
  return Object.assign(new LlmProvider(), {
    id: `p-${type}`,
    organizationId: 'org',
    name: type,
    type,
    configuration: { apiKey: 'test-key', ...configuration },
  });
}

describe('corrected vendor surfaces (verified 2026-09-09)', () => {
  it.each([
    // [type, extra config, expected chat base]
    [LlmProviderType.DEEPSEEK, {}, 'https://api.deepseek.com'],
    [LlmProviderType.TOGETHER, {}, 'https://api.together.ai/v1'],
    [LlmProviderType.HUGGINGFACE, {}, 'https://router.huggingface.co/v1'],
    [LlmProviderType.COHERE, {}, 'https://api.cohere.ai/compatibility/v1'],
    [LlmProviderType.NOVITA, {}, 'https://api.novita.ai/openai/v1'],
    [LlmProviderType.AWS_BEDROCK, { bedrock: { region: 'eu-west-1' } }, 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1'],
    [LlmProviderType.AZURE_OPENAI, { azure: { resourceName: 'res', deploymentName: 'dep' } }, 'https://res.openai.azure.com/openai/v1'],
    [LlmProviderType.AZURE_AI_FOUNDRY, { azure: { resourceName: 'res', deploymentName: 'dep' } }, 'https://res.services.ai.azure.com/openai/v1'],
    [LlmProviderType.MOONSHOT, {}, 'https://api.moonshot.ai/v1'],
    [LlmProviderType.QWEN, {}, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'],
    [LlmProviderType.DIGITALOCEAN, {}, 'https://inference.do-ai.run/v1'],
    [LlmProviderType.RUNPOD, { runpod: { endpointId: 'gpt-oss-120b' } }, 'https://api.runpod.ai/v2/gpt-oss-120b/openai/v1'],
    [LlmProviderType.MODAL, {}, 'https://inference.us-west.modal.direct/v1'],
    [LlmProviderType.VERTEX_AI, { vertex: { projectId: 'proj' } }, 'https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi'],
    [LlmProviderType.MINIMAX, {}, 'https://api.minimax.io/v1'],
    [LlmProviderType.UPSTAGE, {}, 'https://api.upstage.ai/v1'],
    [LlmProviderType.WRITER, {}, 'https://api.writer.com/v1'],
    [LlmProviderType.QIANFAN, {}, 'https://qianfan.baidubce.com/v2'],
    [LlmProviderType.HUNYUAN, {}, 'https://tokenhub-intl.tencentcloudmaas.com/v1'],
    [LlmProviderType.VOLCENGINE, {}, 'https://ark.ap-southeast.bytepluses.com/api/v3'],
    [LlmProviderType.VOLCENGINE, { ark: { edition: 'mainland' } }, 'https://ark.cn-beijing.volces.com/api/v3'],
  ])('%s resolves its documented chat base', (type, config, expected) => {
    expect(makeProvider(type, config).getApiUrl()).toBe(expected);
  });

  it('builds a regional Vertex host when a location is set', () => {
    const provider = makeProvider(LlmProviderType.VERTEX_AI, { vertex: { projectId: 'proj', location: 'us-central1' } });
    expect(provider.getApiUrl()).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/endpoints/openapi',
    );
  });

  it('never leaves a query string in the middle of the Azure base', () => {
    // The old shape produced ".../deployments/dep?api-version=2024-10-21",
    // and the shared OpenAI client appended "/chat/completions" AFTER the
    // query string. That URL could not have answered.
    const url = makeProvider(LlmProviderType.AZURE_OPENAI, { azure: { resourceName: 'res', deploymentName: 'dep' } }).getApiUrl();
    expect(url).not.toContain('?');
    expect(`${url}/chat/completions`).toBe('https://res.openai.azure.com/openai/v1/chat/completions');
  });

  it('sends an Azure API key in api-key, never as a Bearer token', () => {
    // On the dated deployments surface Bearer means an Entra ID token, so a
    // key sent that way 401s; api-key is correct on both surfaces.
    const headers = makeProvider(LlmProviderType.AZURE_OPENAI, { azure: { resourceName: 'r', deploymentName: 'd' } }).getAuthHeaders();
    expect(headers['api-key']).toBe('test-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('sends a Bedrock API key as a bearer token, with no SigV4 material required', () => {
    const headers = makeProvider(LlmProviderType.AWS_BEDROCK, { bedrock: { region: 'us-east-1' } }).getAuthHeaders();
    expect(headers['Authorization']).toBe('Bearer test-key');
  });

  it('sends the Gemini key in x-goog-api-key rather than a URL query parameter', () => {
    const headers = makeProvider(LlmProviderType.GOOGLE).getAuthHeaders();
    expect(headers['x-goog-api-key']).toBe('test-key');
  });

  it('uses the current OpenRouter app-attribution header', () => {
    const headers = makeProvider(LlmProviderType.OPENROUTER).getAuthHeaders();
    expect(headers['X-OpenRouter-Title']).toBe('almyty');
    expect(headers['HTTP-Referer']).toBe('https://almyty.com');
  });

  it('never emits the Vertex credential as a bearer token', () => {
    // The stored credential is a service-account private key. Putting it on
    // the wire would be a key disclosure; the adapter mints a token instead.
    const headers = makeProvider(LlmProviderType.VERTEX_AI, { vertex: { projectId: 'p' } }).getAuthHeaders();
    expect(headers['Authorization']).toBeUndefined();
  });
});

describe('AWS Bedrock is callable end to end', () => {
  const modelsHelper = new LlmModelsHelper(makeEnvelopeCryptoMock());
  const runner = () => new LlmChatRunnerHelper(
    {} as any, {} as any, modelsHelper,
    { warmOrg: jest.fn() } as any,
    { resolve: jest.fn(), invalidate: jest.fn() } as any,
  );

  it('requires both a region and a key at save time', () => {
    expect(() => runner().validateProviderConfiguration(LlmProviderType.AWS_BEDROCK, {})).toThrow(/requires region/);
    expect(() => runner().validateProviderConfiguration(LlmProviderType.AWS_BEDROCK, { bedrock: { region: 'us-east-1' } }))
      .toThrow(/requires a Bedrock API key/);
    expect(() => runner().validateProviderConfiguration(LlmProviderType.AWS_BEDROCK, { apiKey: 'k', bedrock: { region: 'us-east-1' } }))
      .not.toThrow();
  });

  it('claims tool calling and streaming, which the surface documents', () => {
    const caps = modelsHelper.getDefaultCapabilities(LlmProviderType.AWS_BEDROCK);
    expect(caps.supportsStreaming).toBe(true);
    expect(caps.supportsToolUse).toBe(true);
    expect(caps.supportedToolFormats).toEqual(['openai']);
  });
});

describe('Vertex credential handling', () => {
  it('accepts a service-account JSON key', () => {
    const credential = readVertexCredential(JSON.stringify({
      client_email: 'sa@proj.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
    }));
    expect(credential).toEqual({
      kind: 'service_account',
      clientEmail: 'sa@proj.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
    });
  });

  it('passes a pasted access token through unchanged', () => {
    expect(readVertexCredential('ya29.some-token')).toEqual({ kind: 'access_token', token: 'ya29.some-token' });
  });

  it('rejects an empty or malformed credential with an actionable message', () => {
    expect(() => readVertexCredential(undefined)).toThrow(VertexCredentialError);
    expect(() => readVertexCredential('{not json')).toThrow(/whole service-account key file/);
    expect(() => readVertexCredential('{"client_email":"a@b"}')).toThrow(/missing client_email or private_key/);
  });

  it('requires a project and an explicit model at save time', () => {
    const runner = new LlmChatRunnerHelper(
      {} as any, {} as any, new LlmModelsHelper(makeEnvelopeCryptoMock()),
      { warmOrg: jest.fn() } as any,
      { resolve: jest.fn(), invalidate: jest.fn() } as any,
    );
    expect(() => runner.validateProviderConfiguration(LlmProviderType.VERTEX_AI, { apiKey: '{}' }))
      .toThrow(/project id/);
    expect(() => runner.validateProviderConfiguration(LlmProviderType.VERTEX_AI, { apiKey: '{}', vertex: { projectId: 'p' } }))
      .toThrow(/serves no model list/);
    expect(() => runner.validateProviderConfiguration(LlmProviderType.VERTEX_AI, {
      apiKey: '{}', vertex: { projectId: 'p' }, model: 'google/gemini-3.5-flash',
    })).not.toThrow();
  });
});

describe('RunPod always names an endpoint', () => {
  it('refuses to save without one, because there is no shared base', () => {
    const runner = new LlmChatRunnerHelper(
      {} as any, {} as any, new LlmModelsHelper(makeEnvelopeCryptoMock()),
      { warmOrg: jest.fn() } as any,
      { resolve: jest.fn(), invalidate: jest.fn() } as any,
    );
    expect(() => runner.validateProviderConfiguration(LlmProviderType.RUNPOD, { apiKey: 'rpa_x' }))
      .toThrow(/requires an endpoint/);
  });
});

/**
 * Vendors added 2026-09-10, verified in docs/design/call-only-vendors.md.
 */
describe('MiniMax, Upstage and Writer', () => {
  it('sends all three keys as a plain bearer token', () => {
    for (const type of [LlmProviderType.MINIMAX, LlmProviderType.UPSTAGE, LlmProviderType.WRITER]) {
      expect(makeProvider(type).getAuthHeaders()).toMatchObject({ Authorization: 'Bearer test-key' });
    }
  });

  it('posts Writer chat to <base>/chat, not <base>/chat/completions', () => {
    // Writer's body and response are verbatim OpenAI; only the path
    // differs. Appending /chat/completions gives a 404 on every call, so
    // this single assertion is the whole of Writer working or not.
    expect(chatCompletionsUrl(makeProvider(LlmProviderType.WRITER))).toBe('https://api.writer.com/v1/chat');
  });

  it('leaves every other vendor on /chat/completions', () => {
    expect(chatCompletionsUrl(makeProvider(LlmProviderType.MINIMAX))).toBe('https://api.minimax.io/v1/chat/completions');
    expect(chatCompletionsUrl(makeProvider(LlmProviderType.UPSTAGE))).toBe('https://api.upstage.ai/v1/chat/completions');
    expect(chatCompletionsUrl(makeProvider(LlmProviderType.OPENAI))).toBe('https://api.openai.com/v1/chat/completions');
  });
});
