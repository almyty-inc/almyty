import { ModelDeployment } from '../../../../entities/model-deployment.entity';
import { AdapterRegistry } from '../../adapters/adapter.registry';
import { assertAdapterContract } from '../../adapters/adapter.interface';
import { ModelDeploymentsModule } from '../../model-deployments.module';

// The global test setup mocks axios without `create`; the module builds
// adapters with their default HTTP clients, so give it one that is inert.
jest.mock('axios', () => ({ __esModule: true, default: { create: () => ({}) }, create: () => ({}) }));

/**
 * Gate (3), conformance half: every adapter the module registers honours
 * the frozen contract and declares its secrets, so the form masks them and
 * the deployment row encrypts them. The list comes from the module itself
 * (onModuleInit against a fresh registry), so a new adapter is covered the
 * moment it is registered. Each adapter's behaviour is proved by its own
 * conformance spec under __tests__/conformance/; this spec is the roll-call.
 */

/** Adapters that legitimately declare no x-secret field, with the reason. */
const NO_SECRET_FIELD_OK: Record<string, string> = {
  // (none today: even the Ollama wrapper takes an optional bearer token for a proxy in front of it)
};

/**
 * x-secret keys the ModelDeployment secret-key pattern (token, secret,
 * password, apikey, api_key, credential) does not recognise, so they are
 * stored without encryption today and are not passed as credentials.
 * Listed so a new gap fails this spec instead of shipping silently. The
 * fix is one regex in model-deployment.entity.ts (add accesskey|access_key
 * |serviceaccount); once it lands these entries are dead weight and can go.
 * Adapters not yet registered by the module are listed ahead of time.
 */
const KNOWN_UNENCRYPTED_SECRET_KEYS: Record<string, string[]> = {
  'huggingface-endpoints': ['registryAccessKeyId'],
  modal: ['registryAccessKeyId'],
  baseten: ['registryAccessKeyId'],
  runpod: ['registryAccessKeyId'],
  'azure-foundry': ['registryAccessKeyId'],
  vertex: ['serviceAccountJson', 'registryAccessKeyId'],
  'aws-bedrock-import': ['accessKeyId'],
  sagemaker: ['accessKeyId'],
};

function secretFields(schema: Record<string, any>): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([, def]: [string, any]) => def && def['x-secret'] === true)
    .map(([key]) => key);
}

describe('gate 3: every registered adapter is contract-clean in fixture mode', () => {
  const registry = new AdapterRegistry();
  const previousEnv = process.env.NODE_ENV;

  beforeAll(() => {
    process.env.NODE_ENV = 'test';
    new ModelDeploymentsModule(registry).onModuleInit();
  });

  afterAll(() => {
    process.env.NODE_ENV = previousEnv;
  });

  it('registers the Phase A adapters plus the wrappers and the stub outside production', () => {
    const keys = registry.list().map((a) => a.key).sort();
    expect(keys).toEqual(expect.arrayContaining(['huggingface-endpoints', 'modal', 'ollama', 'custom-endpoint', 'stub'].sort()));
    // The describe() payload is what GET /model-adapters serves; every entry is form-ready.
    for (const entry of registry.describe()) {
      expect(entry.displayName).toBeTruthy();
      expect(entry.capabilities.registrySources.length).toBeGreaterThan(0);
      expect(entry.configSchema.type).toBe('object');
    }
  });

  it('passes assertAdapterContract for every adapter', () => {
    expect(registry.list().length).toBeGreaterThan(0);
    for (const adapter of registry.list()) {
      expect(() => assertAdapterContract(adapter)).not.toThrow();
      expect(adapter.key).toMatch(/^[a-z][a-z0-9-]*$/);
      const caps = adapter.capabilities();
      expect(Array.isArray(caps.architectures) || caps.architectures === 'any').toBe(true);
      expect(['merged', 'multi', 'none']).toContain(caps.lora);
      expect(Array.isArray(caps.regions)).toBe(true);
      // Reserved slots stay unimplemented in Phase A.
      expect((adapter as any).train).toBeUndefined();
      expect((adapter as any).jobStatus).toBeUndefined();
    }
  });

  it('marks at least one x-secret field on every adapter, or documents why not', () => {
    for (const adapter of registry.list()) {
      const secrets = secretFields(adapter.configSchema());
      if (secrets.length === 0) {
        expect(NO_SECRET_FIELD_OK[adapter.key]).toEqual(expect.any(String));
      } else {
        expect(NO_SECRET_FIELD_OK[adapter.key]).toBeUndefined();
        for (const key of secrets) expect(adapter.configSchema().properties[key].type).toBe('string');
      }
    }
  });

  it('encrypts every x-secret field at rest, except the gaps recorded above', () => {
    for (const adapter of registry.list()) {
      const unencrypted = secretFields(adapter.configSchema()).filter((key) => !ModelDeployment.isSecretKey(key));
      const known = KNOWN_UNENCRYPTED_SECRET_KEYS[adapter.key] ?? [];
      const unexpected = unencrypted.filter((key) => !known.includes(key));
      // A ratchet: a closed gap passes without an edit here, a new one fails.
      expect({ adapter: adapter.key, unexpected }).toEqual({ adapter: adapter.key, unexpected: [] });
    }
  });

  it('never registers the same key twice and never lets an adapter reach another', () => {
    for (const adapter of registry.list()) {
      expect(() => registry.register(adapter)).toThrow(/registered twice/);
      // An adapter holds no reference to the registry or to a sibling adapter.
      for (const value of Object.values(adapter as any)) {
        expect(value).not.toBeInstanceOf(AdapterRegistry);
        expect(registry.list().filter((other) => other !== adapter)).not.toContain(value);
      }
    }
  });
});
