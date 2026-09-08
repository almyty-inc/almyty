import { Credential, CredentialType } from '../credential.entity';
import { LlmProvider, LlmProviderType } from '../llm-provider.entity';
import { encryptField } from '../../common/security/field-crypto';

/**
 * The sync key getters read through the eager `credential` relation and
 * fall back to the inline configuration only while no reference exists.
 */
describe('LlmProvider credential read-through', () => {
  const credential = (config: Record<string, any>, over: Partial<Credential> = {}): Credential =>
    Object.assign(new Credential(), { id: 'c-1', organizationId: 'org-1', type: CredentialType.API_KEY, isActive: true, config, name: 'Team key', connectorKey: 'openai', healthStatus: 'valid', ...over });

  const provider = (over: Partial<LlmProvider>): LlmProvider =>
    Object.assign(new LlmProvider(), { type: LlmProviderType.OPENAI, organizationId: 'org-1', configuration: {}, ...over });

  it('reads the inference key from the referenced credential (apiKey, then token, key, bearer)', () => {
    expect(provider({ credentialId: 'c-1', credential: credential({ apiKey: encryptField('sk-ref') }) }).getDecryptedApiKey()).toBe('sk-ref');
    expect(provider({ credentialId: 'c-1', credential: credential({ token: encryptField('tok') }, { type: CredentialType.BEARER_TOKEN }) }).getDecryptedApiKey()).toBe('tok');
    expect(provider({ credentialId: 'c-1', credential: credential({ apiKey: encryptField('sk-ref') }) }).getAuthHeaders().Authorization).toBe('Bearer sk-ref');
  });

  it('falls back to the inline configuration only while no reference is set (shim)', () => {
    expect(provider({ configuration: { apiKey: encryptField('inline') } }).getDecryptedApiKey()).toBe('inline');
    expect(provider({ configuration: { apiKey: 'plain-legacy' } }).getDecryptedApiKey()).toBe('plain-legacy');
    // A reference without its row loaded never falls back to a stale inline value.
    expect(provider({ credentialId: 'c-1', credential: null, configuration: { apiKey: encryptField('stale') } }).getDecryptedApiKey()).toBeUndefined();
  });

  it('returns nothing for an inactive referenced credential', () => {
    expect(provider({ credentialId: 'c-1', credential: credential({ apiKey: encryptField('sk') }, { isActive: false }) }).getDecryptedApiKey()).toBeUndefined();
  });

  it('reads the usage key from its own credential row', () => {
    const p = provider({
      credentialId: 'c-1', credential: credential({ apiKey: encryptField('inf') }),
      usageCredentialId: 'c-2', usageCredential: credential({ apiKey: encryptField('adm') }, { id: 'c-2' }),
    });
    expect(p.getDecryptedApiKey()).toBe('inf');
    expect(p.getDecryptedUsageApiKey()).toBe('adm');
    expect(provider({ configuration: { usageApiKey: encryptField('legacy-adm') } }).getDecryptedUsageApiKey()).toBe('legacy-adm');
  });

  it('masks with a marker and a credential reference, never the row', () => {
    const p = provider({ credentialId: 'c-1', credential: credential({ apiKey: encryptField('sk') }), usageCredentialId: null, usageCredential: null });
    const masked = p.maskSensitiveData();
    expect(masked.configuration.apiKey).toBe('***masked***');
    expect(masked.configuration.usageApiKey).toBeUndefined();
    expect(masked.credentialRef).toEqual({ id: 'c-1', name: 'Team key', connectorKey: 'openai', healthStatus: 'valid' });
    expect(masked.usageCredentialRef).toBeNull();
    expect((masked as any).credential).toBeUndefined();
    expect(JSON.stringify(masked)).not.toContain('encrypted:');
    expect(JSON.stringify(p.toPublicView())).not.toContain('encrypted:');
    expect(p.toPublicView().credentialRef?.id).toBe('c-1');
  });

  it('hasInferenceKey / hasUsageKey see both the reference and the shim', () => {
    expect(provider({ credentialId: 'c-1' }).hasInferenceKey()).toBe(true);
    expect(provider({ configuration: { apiKey: 'x' } }).hasInferenceKey()).toBe(true);
    expect(provider({}).hasInferenceKey()).toBe(false);
    expect(provider({ usageCredentialId: 'c-2' }).hasUsageKey()).toBe(true);
  });
});
