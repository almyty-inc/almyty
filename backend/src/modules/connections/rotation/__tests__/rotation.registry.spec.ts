import { builtInRotations } from '../providers';
import { ConnectorRotation, assertRotationContract } from '../rotation.interface';
import { buildRotationRegistry } from '../rotation.module';
import { RotationRegistry } from '../rotation.registry';
import { fixtureHttp } from './rotation-support';

const stub = (over: Partial<ConnectorRotation> = {}): ConnectorRotation => ({
  key: 'stub',
  capabilities: () => ({ create: true, revoke: true, metadata: false, refresh: false }),
  rotate: async () => ({ next: { apiKey: 'n' } }),
  revoke: async () => undefined,
  ...over,
});

describe('RotationRegistry', () => {
  it('registers, looks up, and describes providers as data', () => {
    const r = new RotationRegistry();
    r.register(stub({ requires: () => ['adminKey'] }));
    expect(r.get('stub')?.key).toBe('stub');
    expect(r.get('nope')).toBeUndefined();
    expect(r.describe()).toEqual([{ key: 'stub', capabilities: { create: true, revoke: true, metadata: false, refresh: false }, requires: ['adminKey'] }]);
    expect(r.capabilitiesOf('nope')).toEqual({ create: false, revoke: false, metadata: false, refresh: false });
  });

  it('refuses duplicates and contract violations', () => {
    const r = new RotationRegistry();
    r.register(stub());
    expect(() => r.register(stub())).toThrow(/registered twice/);
    expect(() => assertRotationContract(stub({ key: 'Bad Key' }))).toThrow(/lowercase/);
    expect(() => assertRotationContract(stub({ rotate: undefined }))).toThrow(/create capability without rotate/);
    expect(() => assertRotationContract(stub({ revoke: undefined }))).toThrow(/revoke capability without revoke/);
    expect(() => assertRotationContract(stub({ capabilities: () => ({ create: false, revoke: false, metadata: true, refresh: false }), describe: undefined }))).toThrow(/metadata capability without describe/);
    expect(() => assertRotationContract(stub({ capabilities: () => ({ create: false, revoke: false, metadata: false, refresh: false }) }))).toThrow(/no capability/);
  });

  it('ships every built-in under its connector key and every one honours the contract', () => {
    const registry = buildRotationRegistry(fixtureHttp([]).http);
    const keys = registry.list().map((p) => p.key).sort();
    expect(keys).toEqual(['anthropic', 'aws', 'azure', 'baseten', 'fireworks', 'gcp', 'huggingface', 'mistral', 'openai', 'openrouter', 'perplexity', 'registry-huggingface', 'xai']);
    for (const p of builtInRotations(fixtureHttp([]).http)) expect(() => assertRotationContract(p)).not.toThrow();
    // What the fact table promises per connector.
    const caps = Object.fromEntries(registry.describe().map((d) => [d.key, d.capabilities]));
    expect(caps.anthropic).toEqual({ create: false, revoke: true, metadata: true, refresh: false });
    expect(caps.huggingface).toEqual({ create: false, revoke: true, metadata: true, refresh: false });
    expect(caps.perplexity).toEqual({ create: true, revoke: true, metadata: false, refresh: false });
    for (const k of ['openrouter', 'openai', 'aws', 'gcp', 'azure', 'xai', 'mistral', 'fireworks', 'baseten']) expect(caps[k]).toEqual({ create: true, revoke: true, metadata: true, refresh: false });
    expect(Object.values(caps).every((c) => c.refresh === false)).toBe(true);
    const requires = Object.fromEntries(registry.describe().map((d) => [d.key, d.requires]));
    expect(requires).toMatchObject({ openrouter: ['provisioningKey'], openai: ['adminKey', 'projectId'], anthropic: ['adminKey'], xai: ['managementKey', 'teamId'], mistral: ['adminKey', 'workspaceId', 'userId'], fireworks: ['accountId', 'userId'], baseten: ['managementKey'], aws: [], gcp: [], azure: [], huggingface: [], perplexity: [] });
  });
});
