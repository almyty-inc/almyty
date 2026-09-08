import { ForbiddenException } from '@nestjs/common';

import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { encryptField, isEncrypted } from '../../../common/security/field-crypto';
import { makeCredentialRefFake } from '../../../test/credential-ref.fake';
import { LlmProviderSecretsHelper, MASKED_PROVIDER_KEY } from '../llm-provider-secrets.helper';

const provider = (over: Partial<LlmProvider> = {}): LlmProvider =>
  Object.assign(new LlmProvider(), {
    id: 'p-1', name: 'Main', type: LlmProviderType.OPENAI, organizationId: 'org-1', configuration: {},
    credentialId: null, usageCredentialId: null, credential: null, usageCredential: null,
    ...over,
  });

describe('LlmProviderSecretsHelper', () => {
  describe('applyKey', () => {
    it('turns a pasted key into a managed api_key row tagged with the vendor and points the provider at it', async () => {
      const store = makeCredentialRefFake();
      const helper = new LlmProviderSecretsHelper(store.resolver);
      const p = provider();

      await helper.applyKey(p, 'inference', { plaintext: 'sk-live' });

      expect(p.credentialId).toBe(store.rows[0].id);
      expect(p.credential).toBe(store.rows[0]);
      expect(store.rows[0].type).toBe('api_key');
      expect(store.rows[0].connectorKey).toBe('openai');
      expect(store.rows[0].metadata.managedBy).toEqual({ kind: 'llm_provider', id: 'p-1' });
      expect(isEncrypted(store.rows[0].config.apiKey)).toBe(true);
      expect(p.getDecryptedApiKey()).toBe('sk-live');
      expect(p.configuration.apiKey).toBeUndefined();
    });

    it('rotates the managed row in place on the next paste', async () => {
      const store = makeCredentialRefFake();
      const helper = new LlmProviderSecretsHelper(store.resolver);
      const p = provider();
      await helper.applyKey(p, 'inference', { plaintext: 'one' });
      await helper.applyKey(p, 'inference', { plaintext: 'two' });
      expect(store.rows).toHaveLength(1);
      expect(p.getDecryptedApiKey()).toBe('two');
    });

    it('ignores the mask marker and an empty paste', async () => {
      const store = makeCredentialRefFake();
      const helper = new LlmProviderSecretsHelper(store.resolver);
      const p = provider();
      await helper.applyKey(p, 'inference', { plaintext: MASKED_PROVIDER_KEY });
      await helper.applyKey(p, 'inference', { plaintext: '' });
      expect(store.rows).toHaveLength(0);
      expect(p.credentialId).toBeNull();
    });

    it('moves an inline (shim) key into a managed row when the provider is written without a paste', async () => {
      const store = makeCredentialRefFake();
      const helper = new LlmProviderSecretsHelper(store.resolver);
      const p = provider({ configuration: { apiKey: encryptField('legacy-key'), model: 'gpt-4o' } });

      await helper.applyKey(p, 'inference', {});

      expect(p.configuration.apiKey).toBeUndefined();
      expect(p.configuration.model).toBe('gpt-4o');
      expect(p.credentialId).toBe(store.rows[0].id);
      expect(p.getDecryptedApiKey()).toBe('legacy-key');
    });

    it('does not create a second managed row on a paste over a shared connection (paste wins, shared row kept)', async () => {
      const store = makeCredentialRefFake();
      const shared = store.seed({ organizationId: 'org-1', config: { apiKey: encryptField('shared') } });
      const helper = new LlmProviderSecretsHelper(store.resolver);
      const p = provider();
      await helper.applyKey(p, 'inference', { credentialId: shared.id });
      expect(p.getDecryptedApiKey()).toBe('shared');

      await helper.applyKey(p, 'inference', { plaintext: 'own' });
      expect(p.credentialId).not.toBe(shared.id);
      expect(p.getDecryptedApiKey()).toBe('own');
      expect(store.rows).toHaveLength(2);
    });

    it('keeps the usage key on a separate row', async () => {
      const store = makeCredentialRefFake();
      const helper = new LlmProviderSecretsHelper(store.resolver);
      const p = provider();
      await helper.applyKey(p, 'inference', { plaintext: 'inf' });
      await helper.applyKey(p, 'usage', { plaintext: 'adm' });
      expect(store.rows).toHaveLength(2);
      expect(p.usageCredentialId).not.toBe(p.credentialId);
      expect(p.getDecryptedApiKey()).toBe('inf');
      expect(p.getDecryptedUsageApiKey()).toBe('adm');
      expect(store.rows.find((r) => r.id === p.usageCredentialId)!.metadata.managedBy.kind).toBe('llm_provider_usage');
    });
  });

  describe('withResolvedSecrets', () => {
    it('attaches fresh credential rows through the use policy and leaves a reference-less provider alone', async () => {
      const policy = { assertCanUse: jest.fn(async () => undefined) };
      const store = makeCredentialRefFake(policy);
      const row = store.seed({ organizationId: 'org-1', config: { apiKey: encryptField('sk') } });
      const helper = new LlmProviderSecretsHelper(store.resolver);

      const p = provider({ credentialId: row.id });
      await helper.withResolvedSecrets(p, { principal: { id: 'u-1' } });
      expect(p.credential).toBe(row);
      expect(p.getDecryptedApiKey()).toBe('sk');
      expect(policy.assertCanUse).toHaveBeenCalledWith(expect.objectContaining({
        principal: { id: 'u-1' },
        context: expect.objectContaining({ purpose: 'llm_call', resourceId: 'p-1' }),
      }));

      const inline = provider({ configuration: { apiKey: encryptField('inline') } });
      await helper.withResolvedSecrets(inline);
      expect(inline.getDecryptedApiKey()).toBe('inline');
      expect(policy.assertCanUse).toHaveBeenCalledTimes(1);
    });

    it('propagates a policy denial so the call fails before any request is built', async () => {
      const store = makeCredentialRefFake({ assertCanUse: async () => { throw new ForbiddenException({ code: 'NO_GRANT' }); } });
      const row = store.seed({ organizationId: 'org-1', config: { apiKey: 'x' } });
      const helper = new LlmProviderSecretsHelper(store.resolver);
      await expect(helper.withResolvedSecrets(provider({ credentialId: row.id }))).rejects.toMatchObject({ response: { code: 'NO_GRANT' } });
    });
  });

  it('release deletes the managed rows and leaves a shared connection', async () => {
    const store = makeCredentialRefFake();
    const shared = store.seed({ organizationId: 'org-1', config: { apiKey: 'x' } });
    const helper = new LlmProviderSecretsHelper(store.resolver);
    const p = provider();
    await helper.applyKey(p, 'usage', { plaintext: 'adm' });
    await helper.applyKey(p, 'inference', { credentialId: shared.id });
    await helper.release(p);
    expect(store.rows).toEqual([shared]);
  });

  it('splitKeys strips both keys and rejects a non-string value', () => {
    expect(LlmProviderSecretsHelper.splitKeys({ apiKey: 'a', usageApiKey: 'u', model: 'm' } as any))
      .toEqual({ configuration: { model: 'm' }, apiKey: 'a', usageApiKey: 'u' });
    expect(LlmProviderSecretsHelper.splitKeys(undefined)).toEqual({ configuration: {}, apiKey: undefined, usageApiKey: undefined });
    expect(() => LlmProviderSecretsHelper.splitKeys({ apiKey: 42 } as any)).toThrow('configuration.apiKey must be a string');
  });
});
