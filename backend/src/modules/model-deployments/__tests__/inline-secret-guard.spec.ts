import { BadRequestException } from '@nestjs/common';

import { inlineSecretKeys, ModelDeploymentsService, schemaWithoutSecretRequirements } from '../model-deployments.service';
import { AdapterRegistry } from '../adapters/adapter.registry';
import { StubAdapter } from '../adapters/stub.adapter';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';

/**
 * A deployment names its secret once: on the connection (credentialId).
 * With a credentialId the schema's x-secret fields are satisfied by the
 * connection and refused inline; without one they may still be pasted
 * (encrypted in place on the row).
 */
describe('deployment inline secret guard', () => {
  it('inlineSecretKeys finds x-secret schema fields and secret-looking names, ignoring credentialId and empties', () => {
    const schema = { properties: { apiKey: { type: 'string', 'x-secret': true }, region: { type: 'string' } } };
    expect(inlineSecretKeys({ apiKey: 'sk', region: 'eu', hfToken: 'hf', password: '', credentialId: 'c' }, schema)).toEqual(['apiKey', 'hfToken']);
    expect(inlineSecretKeys({ region: 'eu' }, schema)).toEqual([]);
  });

  it('schemaWithoutSecretRequirements drops only the x-secret fields from required', () => {
    const schema = { properties: { token: { 'x-secret': true }, image: {} }, required: ['token', 'image'] };
    expect(schemaWithoutSecretRequirements(schema).required).toEqual(['image']);
    expect(schema.required).toEqual(['token', 'image']);
  });

  describe('ModelDeploymentsService.create (stub adapter: token is x-secret and required)', () => {
    const build = () => {
      const registry = new AdapterRegistry();
      registry.register(new StubAdapter({ architectures: 'any' }));
      const key = registry.list()[0].key;
      const versions = { findOne: jest.fn(async () => ({ id: 'v-1', base: 'llama', organizationId: 'org-1', registryUri: 'hf://x' })) };
      const deployments = { create: jest.fn((d: any) => ({ ...d, encryptSensitiveDataForOrg: async () => undefined })), save: jest.fn(async (d: any) => ({ id: 'd-1', ...d })) };
      const queue = { add: jest.fn(async () => undefined) };
      const service = new ModelDeploymentsService(deployments as any, versions as any, {} as any, queue as any, registry, makeEnvelopeCryptoMock(), { log: jest.fn(async () => null) } as any);
      return { service, deployments, key };
    };

    it('refuses a pasted secret next to a credentialId', async () => {
      const { service, deployments, key } = build();
      await expect(service.create('org-1', 'u-1', { modelVersionId: 'v-1', providerType: key, credentialId: 'c-1', providerConfig: { token: 'pasted' } }))
        .rejects.toMatchObject({ response: { code: 'PROVIDER_CONFIG_INLINE_SECRET' } });
      await expect(service.create('org-1', 'u-1', { modelVersionId: 'v-1', providerType: key, credentialId: 'c-1', providerConfig: { hfToken: 'other' } }))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(deployments.save).not.toHaveBeenCalled();
    });

    it('a credentialId satisfies the required secret field', async () => {
      const { service, deployments, key } = build();
      const saved = await service.create('org-1', 'u-1', { modelVersionId: 'v-1', providerType: key, credentialId: 'c-1', providerConfig: { image: 'x' } });
      expect(saved.providerConfig).toEqual({ image: 'x', credentialId: 'c-1' });
      expect(deployments.save).toHaveBeenCalledTimes(1);
    });

    it('without a credentialId the required secret must still be pasted', async () => {
      const { service, deployments, key } = build();
      await expect(service.create('org-1', 'u-1', { modelVersionId: 'v-1', providerType: key, providerConfig: { image: 'x' } }))
        .rejects.toMatchObject({ response: { code: 'PROVIDER_CONFIG_INVALID' } });
      await expect(service.create('org-1', 'u-1', { modelVersionId: 'v-1', providerType: key, providerConfig: { token: 'pasted' } })).resolves.toBeDefined();
      expect(deployments.save).toHaveBeenCalledTimes(1);
    });
  });
});
