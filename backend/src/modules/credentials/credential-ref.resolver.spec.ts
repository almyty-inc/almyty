import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { CredentialType } from '../../entities/credential.entity';
import { encryptField, isEncrypted } from '../../common/security/field-crypto';
import { makeCredentialRefFake } from '../../test/credential-ref.fake';
import { CredentialRefResolver } from './credential-ref.resolver';

describe('CredentialRefResolver', () => {
  describe('resolve', () => {
    it('returns the decrypted config and the well-known secrets of an active org credential', async () => {
      const store = makeCredentialRefFake();
      const row = store.seed({
        organizationId: 'org-1',
        type: CredentialType.API_KEY,
        config: { apiKey: encryptField('sk-plain'), baseUrl: 'https://api.example.com' },
      });

      const resolved = await store.resolver.resolve('org-1', row.id, { context: { purpose: 'spec' } });

      expect(resolved.config).toEqual({ apiKey: 'sk-plain', baseUrl: 'https://api.example.com' });
      expect(resolved.secrets).toEqual({ apiKey: 'sk-plain' });
      expect(resolved.credential.id).toBe(row.id);
    });

    it('decrypts nested maps one level down (MCP custom headers)', async () => {
      const store = makeCredentialRefFake();
      const row = store.seed({
        organizationId: 'org-1',
        type: CredentialType.CUSTOM,
        config: { headers: { 'X-Api-Key': encryptField('k-123'), 'X-Plain': 'v' } },
      });
      const resolved = await store.resolver.resolve('org-1', row.id);
      expect(resolved.config.headers).toEqual({ 'X-Api-Key': 'k-123', 'X-Plain': 'v' });
    });

    it('throws CREDENTIAL_NOT_FOUND for a missing row and for a row of another org', async () => {
      const store = makeCredentialRefFake();
      const other = store.seed({ organizationId: 'org-2', type: CredentialType.API_KEY, config: { apiKey: 'x' } });
      await expect(store.resolver.resolve('org-1', 'nope')).rejects.toMatchObject({
        response: { code: 'CREDENTIAL_NOT_FOUND' },
      });
      await expect(store.resolver.resolve('org-1', other.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws CREDENTIAL_INACTIVE and CREDENTIAL_EXPIRED', async () => {
      const store = makeCredentialRefFake();
      const inactive = store.seed({ organizationId: 'org-1', isActive: false, config: { apiKey: 'x' } });
      const expired = store.seed({ organizationId: 'org-1', expiresAt: new Date(Date.now() - 1000), config: { apiKey: 'x' } });
      await expect(store.resolver.resolve('org-1', inactive.id)).rejects.toMatchObject({ response: { code: 'CREDENTIAL_INACTIVE' } });
      await expect(store.resolver.resolve('org-1', expired.id)).rejects.toMatchObject({ response: { code: 'CREDENTIAL_EXPIRED' } });
    });

    it('asks the use policy before decrypting and propagates its denial', async () => {
      const policy = { assertCanUse: jest.fn(async () => { throw new ForbiddenException({ code: 'CONNECTION_FORBIDDEN' }); }) };
      const store = makeCredentialRefFake(policy);
      const row = store.seed({ organizationId: 'org-1', config: { apiKey: encryptField('sk') } });
      await expect(store.resolver.resolve('org-1', row.id, { principal: { id: 'u-1' }, context: { purpose: 'llm_call' } }))
        .rejects.toMatchObject({ response: { code: 'CONNECTION_FORBIDDEN' } });
      expect(policy.assertCanUse).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: 'org-1',
        principal: { id: 'u-1' },
        context: { purpose: 'llm_call' },
      }));
    });

    it('usePolicy() swaps the policy at runtime (the gate 2 seam)', async () => {
      const store = makeCredentialRefFake();
      const row = store.seed({ organizationId: 'org-1', config: { apiKey: encryptField('sk') } });
      await expect(store.resolver.resolve('org-1', row.id)).resolves.toBeDefined();
      store.resolver.usePolicy({ assertCanUse: async () => { throw new ForbiddenException({ code: 'NO_GRANT' }); } });
      await expect(store.resolver.resolve('org-1', row.id)).rejects.toMatchObject({ response: { code: 'NO_GRANT' } });
    });

    it('tryResolve returns null for a missing or inactive row and rethrows a policy denial', async () => {
      const store = makeCredentialRefFake();
      const inactive = store.seed({ organizationId: 'org-1', isActive: false, config: {} });
      expect(await store.resolver.tryResolve('org-1', undefined)).toBeNull();
      expect(await store.resolver.tryResolve('org-1', 'missing')).toBeNull();
      expect(await store.resolver.tryResolve('org-1', inactive.id)).toBeNull();
      const row = store.seed({ organizationId: 'org-1', config: { apiKey: 'x' } });
      store.resolver.usePolicy({ assertCanUse: async () => { throw new ForbiddenException({ code: 'NO_GRANT' }); } });
      await expect(store.resolver.tryResolve('org-1', row.id)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('secretsOf', () => {
    it('picks only the well-known secret fields', () => {
      expect(CredentialRefResolver.secretsOf({ apiKey: 'a', bot_token: 'b', baseUrl: 'u', model: 'm', token: '' }))
        .toEqual({ apiKey: 'a', bot_token: 'b' });
    });
  });

  describe('managed rows', () => {
    it('createManaged encrypts every declared secret key, nested maps included, and records the owner', async () => {
      const store = makeCredentialRefFake();
      const saved = await store.resolver.createManaged('org-1', {
        name: 'weather MCP auth',
        type: CredentialType.CUSTOM,
        config: { headers: { 'X-Api-Key': 'k-123' }, bot_token: 'xoxb-1', bot_user_id: 'U1', apiKey: 'sk' },
        secretKeys: ['headers', 'bot_token'],
        connectorKey: 'slack',
        managedBy: { kind: 'channel_installation', id: 'inst-1' },
      });
      expect(isEncrypted(saved.config.headers['X-Api-Key'])).toBe(true);
      expect(isEncrypted(saved.config.bot_token)).toBe(true);
      expect(isEncrypted(saved.config.apiKey)).toBe(true);
      expect(saved.config.bot_user_id).toBe('U1');
      expect(saved.metadata.managedBy).toEqual({ kind: 'channel_installation', id: 'inst-1' });
      expect(saved.connectorKey).toBe('slack');
      expect(saved.visibility).toBe('org');

      const resolved = await store.resolver.resolve('org-1', saved.id);
      expect(resolved.config).toEqual({ headers: { 'X-Api-Key': 'k-123' }, bot_token: 'xoxb-1', bot_user_id: 'U1', apiKey: 'sk' });
    });

    it('rotateManaged replaces secrets in place, keeps the other keys and resets health', async () => {
      const store = makeCredentialRefFake();
      const row = await store.resolver.createManaged('org-1', {
        name: 'p', type: CredentialType.API_KEY, config: { apiKey: 'old', baseUrl: 'u' },
        managedBy: { kind: 'llm_provider', id: 'p-1' },
      });
      row.healthStatus = 'failed';
      const rotated = await store.resolver.rotateManaged('org-1', row.id, {
        config: { apiKey: 'new' }, managedBy: { kind: 'llm_provider', id: 'p-1' },
      });
      expect(rotated.healthStatus).toBe('unknown');
      expect(isEncrypted(rotated.config.apiKey)).toBe(true);
      const resolved = await store.resolver.resolve('org-1', row.id);
      expect(resolved.config).toEqual({ apiKey: 'new', baseUrl: 'u' });
    });

    it('rotateManaged refuses a row managed by someone else', async () => {
      const store = makeCredentialRefFake();
      const shared = store.seed({ organizationId: 'org-1', config: { apiKey: 'x' }, metadata: null });
      const foreign = await store.resolver.createManaged('org-1', {
        name: 'p', type: CredentialType.API_KEY, config: { apiKey: 'x' }, managedBy: { kind: 'llm_provider', id: 'p-2' },
      });
      for (const id of [shared.id, foreign.id]) {
        await expect(store.resolver.rotateManaged('org-1', id, { config: { apiKey: 'y' }, managedBy: { kind: 'llm_provider', id: 'p-1' } }))
          .rejects.toMatchObject({ response: { code: 'CREDENTIAL_NOT_MANAGED' } });
      }
    });

    it('releaseManaged deletes only a row the caller manages', async () => {
      const store = makeCredentialRefFake();
      const shared = store.seed({ organizationId: 'org-1', config: { apiKey: 'x' } });
      const mine = await store.resolver.createManaged('org-1', {
        name: 'p', type: CredentialType.API_KEY, config: { apiKey: 'x' }, managedBy: { kind: 'mcp_source', id: 's-1' },
      });
      expect(await store.resolver.releaseManaged('org-1', shared.id, { kind: 'mcp_source', id: 's-1' })).toBe(false);
      expect(await store.resolver.releaseManaged('org-1', mine.id, { kind: 'mcp_source', id: 's-1' })).toBe(true);
      expect(await store.resolver.releaseManaged('org-1', null, { kind: 'mcp_source' })).toBe(false);
      expect(store.rows).toContain(shared);
      expect(store.rows).not.toContain(mine);
    });
  });
});
