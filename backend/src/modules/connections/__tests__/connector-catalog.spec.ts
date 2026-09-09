import { CredentialType } from '../../../entities/credential.entity';
import { LlmProviderType } from '../../../entities/llm-provider.entity';
import { AdapterRegistry } from '../../model-deployments/adapters/adapter.registry';
import { StubAdapter } from '../../model-deployments/adapters/stub.adapter';
import { BUILTIN_CONNECTORS, OPENROUTER_CONNECTOR, REGISTRY_S3_CONNECTOR, connectorFromAdapter } from '../connector-catalog';
import { ConnectorCatalogService } from '../connector-catalog.service';
import { schemaViolations, secretFieldsOf, validateConnectorDefinition } from '../connector-schema';
import { CONNECTOR_KINDS, REDIRECT_METHODS } from '../connector.types';
import { fakeAudit, fakeRepo } from './test-support';

describe('built-in connector catalog', () => {
  it.each(BUILTIN_CONNECTORS.map((c) => [c.key, c] as const))('%s is a well-formed connector', (_key, connector) => {
    expect(validateConnectorDefinition(connector)).toEqual([]);
    expect(connector.connect.length).toBeGreaterThan(0);
    expect(connector.validation).toBeDefined();
    expect(CONNECTOR_KINDS).toContain(connector.kind);
    for (const method of connector.connect) {
      if (!REDIRECT_METHODS.includes(method.type)) {
        expect(method.schema).toBeDefined();
        // A form method that stores a secret must mark it so it is encrypted and never echoed.
        const secrets = secretFieldsOf(method.schema);
        const names = Object.keys(method.schema!.properties);
        for (const n of names) {
          if (/key|secret|token|password/i.test(n) && !/id$|url$/i.test(n)) expect(secrets).toContain(n);
        }
      }
    }
  });

  it('has unique keys and every kind is represented', () => {
    const keys = BUILTIN_CONNECTORS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const kind of CONNECTOR_KINDS) {
      expect(BUILTIN_CONNECTORS.some((c) => c.kind === kind)).toBe(true);
    }
  });

  it('ships the connectors gate 1 promised', () => {
    const keys = new Set(BUILTIN_CONNECTORS.map((c) => c.key));
    for (const k of ['openrouter', 'openai', 'anthropic', 'google', 'mistral', 'groq', 'together', 'xai', 'deepseek', 'cohere', 'huggingface', 'ollama', 'fireworks', 'cerebras', 'deepinfra', 'perplexity', 'modal', 'baseten', 'runpod', 'aws', 'gcp', 'azure', 'digitalocean', 'nebius', 'openai-compatible', 'mcp-custom', 'registry-s3', 'memory-custom', 'channel-webhook']) {
      expect(keys.has(k)).toBe(true);
    }
  });

  it('ranks OpenRouter PKCE first, with the verified endpoints and no client id', () => {
    const pkce = OPENROUTER_CONNECTOR.connect[0];
    expect(pkce.type).toBe('oauth2_pkce');
    expect(pkce.oauth).toMatchObject({
      authorizeUrl: 'https://openrouter.ai/auth',
      tokenUrl: 'https://openrouter.ai/api/v1/auth/keys',
      pkce: true,
      callbackParam: 'callback_url',
      stateVia: 'callback_query',
      clientId: 'none',
      tokenRequest: 'json',
      tokenField: 'key',
      headlessCode: true,
    });
    expect(OPENROUTER_CONNECTOR.validation).toMatchObject({ kind: 'http', url: 'https://openrouter.ai/api/v1/key', accountLabelPath: 'data.label' });
    expect(OPENROUTER_CONNECTOR.connect[1].type).toBe('api_key');
  });

  it('reuses the LLM provider catalog for inference key pages, docs and base URLs', () => {
    const hf = BUILTIN_CONNECTORS.find((c) => c.key === LlmProviderType.HUGGINGFACE)!;
    expect(hf.keyPageUrl).toBe('https://huggingface.co/settings/tokens');
    expect(hf.validation).toMatchObject({ url: 'https://huggingface.co/api/whoami-v2', accountLabelPath: 'name' });
    const groq = BUILTIN_CONNECTORS.find((c) => c.key === LlmProviderType.GROQ)!;
    expect(groq.validation).toMatchObject({ url: 'https://api.groq.com/openai/v1/models' });
    const anthropic = BUILTIN_CONNECTORS.find((c) => c.key === LlmProviderType.ANTHROPIC)!;
    expect(anthropic.validation).toMatchObject({ auth: 'header', headerName: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' } });
  });

  it('defines the S3-compatible registry connector on CredentialType.S3_COMPATIBLE with both keys secret', () => {
    expect(REGISTRY_S3_CONNECTOR.kind).toBe('registry');
    const method = REGISTRY_S3_CONNECTOR.connect[0];
    expect(method.credentialType).toBe(CredentialType.S3_COMPATIBLE);
    expect(CredentialType.S3_COMPATIBLE).toBe('s3_compatible');
    expect(secretFieldsOf(method.schema).sort()).toEqual(['accessKeyId', 'secretAccessKey']);
    expect(method.schema!.required).toEqual(expect.arrayContaining(['region', 'bucket', 'accessKeyId', 'secretAccessKey']));
    expect(Object.keys(method.schema!.properties)).toEqual(expect.arrayContaining(['endpoint', 'prefix']));
    expect(REGISTRY_S3_CONNECTOR.validation).toEqual({ kind: 's3_bucket' });
  });
});

describe('schemaViolations', () => {
  const schema = REGISTRY_S3_CONNECTOR.connect[0].schema!;

  it('reports missing, mistyped, malformed and unknown fields', () => {
    expect(schemaViolations({ bucket: 'B AD', region: 1, extra: true }, schema)).toEqual(
      expect.arrayContaining(['accessKeyId is required', 'secretAccessKey is required', 'region must be a string', 'bucket has an unexpected format', 'extra is not a known field']),
    );
    expect(schemaViolations({ region: 'us-east-1', bucket: 'weights', accessKeyId: 'AKIA', secretAccessKey: 's', endpoint: 'not a url' }, schema)).toEqual(['endpoint must be a URL']);
    expect(schemaViolations({ region: 'us-east-1', bucket: 'weights', accessKeyId: 'AKIA', secretAccessKey: 's' }, schema)).toEqual([]);
  });
});

describe('validateConnectorDefinition', () => {
  const base = { key: 'my-endpoint', kind: 'inference', displayName: 'Mine', connect: [{ type: 'api_key', schema: { type: 'object', properties: { apiKey: { type: 'string', 'x-secret': true } }, required: ['apiKey'] } }], validation: { kind: 'http', url: 'https://example.com/v1/models' } };

  it('accepts a minimal custom connector', () => {
    expect(validateConnectorDefinition(base)).toEqual([]);
  });

  it('rejects bad keys, kinds, missing methods, oauth without endpoints and non-http validation URLs', () => {
    expect(validateConnectorDefinition({ ...base, key: 'Bad Key' })).toContain('key must be lowercase letters, digits and dashes (2-64 chars)');
    expect(validateConnectorDefinition({ ...base, kind: 'weird' })[0]).toMatch(/kind must be one of/);
    expect(validateConnectorDefinition({ ...base, connect: [] })).toContain('connect must list at least one method');
    expect(validateConnectorDefinition({ ...base, connect: [{ type: 'oauth2_pkce' }] })).toContain('connect[0]: oauth2_pkce needs oauth endpoints');
    expect(validateConnectorDefinition({ ...base, connect: [{ type: 'api_key' }] })).toContain('connect[0]: api_key needs a form schema');
    expect(validateConnectorDefinition({ ...base, validation: { kind: 'http', url: 'ftp://x' } })).toContain('validation.url must be http(s) or start with a {{field}} template');
    expect(validateConnectorDefinition({ ...base, validation: { kind: 'nope' } })[0]).toMatch(/validation.kind must be one of/);
  });
});

describe('deployment connectors derived from the adapter registry', () => {
  it('turns an adapter with x-secret config fields into an api_key connector without copying the schema', () => {
    const derived = connectorFromAdapter({ key: 'acme', displayName: 'Acme GPUs', configSchema: { type: 'object', properties: { token: { type: 'string', 'x-secret': true, title: 'Token' }, region: { type: 'string' } }, required: ['token', 'region'] } })!;
    expect(derived.key).toBe('deploy-acme');
    expect(derived.kind).toBe('deployment');
    expect(derived.adapterKey).toBe('acme');
    expect(Object.keys(derived.connect[0].schema!.properties)).toEqual(['token']);
    expect(derived.connect[0].schema!.required).toEqual(['token']);
    expect(validateConnectorDefinition(derived)).toEqual([]);
    expect(connectorFromAdapter({ key: 'open', displayName: 'Open', configSchema: { type: 'object', properties: { url: { type: 'string' } } } })).toBeNull();
  });

  it('the catalog service reads the registry at runtime and skips adapters a built-in connector already covers', async () => {
    const registry = new AdapterRegistry();
    registry.register(new StubAdapter({ architectures: 'any' }));
    const service = new ConnectorCatalogService(fakeRepo<any>() as any, fakeAudit(), registry);
    const keys = service.builtIn().map((c) => c.key);
    expect(keys).toContain('modal');
    expect(keys).not.toContain('deploy-modal');
    const stubSecrets = Object.values(new StubAdapter({ architectures: 'any' }).configSchema().properties ?? {}).some((p: any) => p['x-secret']);
    expect(keys.includes('deploy-stub')).toBe(stubSecrets);
    for (const c of service.builtIn()) expect(validateConnectorDefinition(c)).toEqual([]);
  });
});

describe('custom connectors', () => {
  it('stores a valid definition per org, refuses built-in keys, duplicates and broken definitions, and audits', async () => {
    const repo = fakeRepo<any>();
    const audit = fakeAudit();
    const service = new ConnectorCatalogService(repo as any, audit);
    const def = { key: 'my-vllm', kind: 'inference', displayName: 'My vLLM', connect: [{ type: 'api_key', schema: { type: 'object', properties: { apiKey: { type: 'string', 'x-secret': true } } } }], validation: { kind: 'http', url: 'https://vllm.example.com/v1/models' } } as any;
    const created = await service.createCustom('org-1', 'u-1', def);
    expect(created.organizationId).toBe('org-1');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'connector_create', resourceName: 'my-vllm' }));
    expect((await service.list('org-1')).some((c) => c.key === 'my-vllm')).toBe(true);
    expect((await service.list('org-2')).some((c) => c.key === 'my-vllm')).toBe(false);
    expect((await service.list('org-1', 'inference')).every((c) => c.kind === 'inference')).toBe(true);
    await expect(service.createCustom('org-1', 'u-1', def)).rejects.toMatchObject({ response: { code: 'CONNECTOR_KEY_TAKEN' } });
    await expect(service.createCustom('org-1', 'u-1', { ...def, key: 'openai' })).rejects.toMatchObject({ response: { code: 'CONNECTOR_KEY_TAKEN' } });
    await expect(service.createCustom('org-1', 'u-1', { ...def, key: 'x', validation: {} })).rejects.toMatchObject({ response: { code: 'CONNECTOR_INVALID' } });
    await expect(service.require('org-2', 'my-vllm')).rejects.toMatchObject({ response: { code: 'CONNECTOR_UNKNOWN' } });
  });
});
