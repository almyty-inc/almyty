import { NotFoundException } from '@nestjs/common';

import { ChannelInstallationService } from '../channel-installation.service';
import { ChannelInstallation } from '../../../../entities/channel-installation.entity';
import { Gateway } from '../../../../entities/gateway.entity';
import { isEncrypted, decryptField, encryptField } from '../../../../common/security/field-crypto';
import { FakeCredentialStore, makeCredentialRefFake } from '../../../../test/credential-ref.fake';

/**
 * Platform-path envelope stub — mirrors EnvelopeCryptoService for a non-KMS
 * org (encrypt -> `encrypted:gcm:`, decrypt via prefix routing). Keeps these
 * store tests asserting the unchanged platform behavior without a live KMS.
 */
const platformEnvelope = {
  encryptForOrg: (_orgId: string, plaintext: string) => Promise.resolve(encryptField(plaintext)),
  decryptForOrg: (_orgId: string, value: string) => Promise.resolve(decryptField(value)),
  warmOrg: () => Promise.resolve(),
};

/**
 * Unit coverage for the multi-workspace installation store: upsert puts
 * the workspace token into the org's credential store and the row only
 * keeps the reference, resolution reads through the reference (or the
 * legacy blob for rows not yet moved), and revoke releases the row.
 */
describe('ChannelInstallationService', () => {
  let repo: any;
  let store: FakeCredentialStore;
  let service: ChannelInstallationService;

  const gateway = { id: 'gw-1', organizationId: 'org-1' } as unknown as Gateway;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((data: any) => Object.assign(new ChannelInstallation(), data)),
      save: jest.fn(async (inst: any) => Object.assign(inst, { id: inst.id ?? 'inst-1' })),
      count: jest.fn(),
    };
    store = makeCredentialRefFake(undefined, platformEnvelope as any);
    service = new ChannelInstallationService(repo, platformEnvelope as any, store.resolver);
  });

  describe('upsert', () => {
    it('creates a new installation whose bot token lives in the credential store, encrypted', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.upsert(gateway, {
        externalTenantId: 'T111',
        credentials: { bot_token: 'xoxb-plain-token' },
        metadata: { teamName: 'Acme' },
      });

      const first = repo.save.mock.calls[0][0];
      expect(first.gatewayId).toBe('gw-1');
      expect(first.organizationId).toBe('org-1');
      expect(first.externalTenantId).toBe('T111');
      expect(first.status).toBe('active');
      expect(first.metadata).toEqual({ teamName: 'Acme' });
      // Nothing secret on the row, ever.
      expect(first.credentials).toBeNull();
      const withRef = repo.save.mock.calls[1][0];
      expect(withRef.credentialId).toBe(store.rows[0].id);
      expect(store.rows[0].organizationId).toBe('org-1');
      expect(store.rows[0].metadata.managedBy).toEqual({ kind: 'channel_installation', id: 'inst-1' });
      expect(isEncrypted(store.rows[0].config.bot_token)).toBe(true);
      expect(decryptField(store.rows[0].config.bot_token)).toBe('xoxb-plain-token');
      expect(JSON.stringify(repo.save.mock.calls)).not.toContain('xoxb-plain-token');
    });

    it('reactivates a revoked installation with fresh credentials and installedAt', async () => {
      const old = Object.assign(new ChannelInstallation(), {
        id: 'inst-1',
        gatewayId: 'gw-1',
        organizationId: 'org-1',
        externalTenantId: 'T111',
        status: 'revoked',
        credentials: null,
        credentialId: null,
        metadata: { teamName: 'Old Name' },
        installedAt: new Date('2020-01-01T00:00:00Z'),
      });
      repo.findOne.mockResolvedValue(old);

      await service.upsert(gateway, {
        externalTenantId: 'T111',
        credentials: { bot_token: 'xoxb-new' },
        metadata: { teamName: 'New Name' },
      });

      expect(repo.create).not.toHaveBeenCalled();
      const saved = repo.save.mock.calls[1][0];
      expect(saved.id).toBe('inst-1');
      expect(saved.status).toBe('active');
      expect(saved.credentialId).toBe(store.rows[0].id);
      expect(decryptField(store.rows[0].config.bot_token)).toBe('xoxb-new');
      expect(saved.metadata.teamName).toBe('New Name');
      expect(saved.installedAt.getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00Z').getTime());
    });

    it('rotates the managed row in place on a reinstall instead of creating a second one', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.upsert(gateway, { externalTenantId: 'T111', credentials: { bot_token: 'xoxb-1' } });
      const stored = repo.save.mock.calls[1][0];
      repo.findOne.mockResolvedValue(stored);

      await service.upsert(gateway, { externalTenantId: 'T111', credentials: { bot_token: 'xoxb-2' } });

      expect(store.rows).toHaveLength(1);
      expect(decryptField(store.rows[0].config.bot_token)).toBe('xoxb-2');
      expect(stored.credentialId).toBe(store.rows[0].id);
    });

    it('leaves non-secret credential keys unencrypted in the store', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.upsert(gateway, {
        externalTenantId: 'T111',
        credentials: { bot_token: 'xoxb-1', bot_user_id: 'U42' },
      });
      expect(store.rows[0].config.bot_user_id).toBe('U42');
      expect(isEncrypted(store.rows[0].config.bot_token)).toBe(true);
    });
  });

  describe('resolveCredentials', () => {
    it('returns decrypted credentials for an active installation through the reference', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.upsert(gateway, {
        externalTenantId: 'T111',
        credentials: { bot_token: 'xoxb-workspace-token', bot_user_id: 'U42' },
      });
      const stored = repo.save.mock.calls[1][0];

      repo.findOne.mockResolvedValue(stored);
      const creds = await service.resolveCredentials('gw-1', 'T111');

      expect(repo.findOne).toHaveBeenLastCalledWith({
        where: { gatewayId: 'gw-1', externalTenantId: 'T111', status: 'active' },
      });
      expect(creds).toEqual({ bot_token: 'xoxb-workspace-token', bot_user_id: 'U42' });
    });

    it('reads the legacy blob for a row not yet moved (shim)', async () => {
      repo.findOne.mockResolvedValue(Object.assign(new ChannelInstallation(), {
        id: 'inst-9', gatewayId: 'gw-1', organizationId: 'org-1', externalTenantId: 'T9', status: 'active',
        credentialId: null, credentials: { bot_token: encryptField('xoxb-legacy') },
      }));
      expect(await service.resolveCredentials('gw-1', 'T9')).toEqual({ bot_token: 'xoxb-legacy' });
    });

    it('fails when the referenced credential is inactive', async () => {
      const row = store.seed({ organizationId: 'org-1', isActive: false, config: { bot_token: 'x' } });
      repo.findOne.mockResolvedValue(Object.assign(new ChannelInstallation(), {
        id: 'inst-1', gatewayId: 'gw-1', organizationId: 'org-1', externalTenantId: 'T111', status: 'active', credentialId: row.id, credentials: null,
      }));
      await expect(service.resolveCredentials('gw-1', 'T111')).rejects.toMatchObject({ response: { code: 'CREDENTIAL_INACTIVE' } });
    });

    it('returns null when the tenant never installed', async () => {
      repo.findOne.mockResolvedValue(null);
      expect(await service.resolveCredentials('gw-1', 'T404')).toBeNull();
    });

    it('returns null for a revoked installation (status filter in the query)', async () => {
      repo.findOne.mockResolvedValue(null); // revoked rows don't match status: 'active'
      expect(await service.resolveCredentials('gw-1', 'T111')).toBeNull();
    });
  });

  describe('revoke', () => {
    it('sets status=revoked, releases the credential row and clears the reference', async () => {
      const row = store.seed({
        organizationId: 'org-1', config: { bot_token: encryptField('x') },
        metadata: { managedBy: { kind: 'channel_installation', id: 'inst-1' } },
      });
      const installation = Object.assign(new ChannelInstallation(), {
        id: 'inst-1',
        gatewayId: 'gw-1',
        organizationId: 'org-1',
        externalTenantId: 'T111',
        status: 'active',
        credentialId: row.id,
        credentials: { bot_token: 'encrypted:gcm:aa:bb:cc' },
        metadata: { teamName: 'Acme' },
      });
      repo.findOne.mockResolvedValue(installation);

      const result = await service.revoke('gw-1', 'inst-1');

      const saved = repo.save.mock.calls[0][0];
      expect(saved.status).toBe('revoked');
      expect(saved.credentials).toBeNull();
      expect(saved.credentialId).toBeNull();
      expect(store.rows).toHaveLength(0);
      // Sanitized response — no credentials key at all.
      expect(result).not.toHaveProperty('credentials');
      expect(result.status).toBe('revoked');
    });

    it('404s for an unknown installation or wrong gateway', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.revoke('gw-1', 'nope')).rejects.toThrow(NotFoundException);
    });
  });

  describe('listForGateway', () => {
    it('lists installations without ever exposing credentials', async () => {
      repo.find.mockResolvedValue([
        Object.assign(new ChannelInstallation(), {
          id: 'inst-1',
          gatewayId: 'gw-1',
          externalTenantId: 'T111',
          status: 'active',
          credentialId: 'cred-1',
          credentials: { bot_token: 'encrypted:gcm:aa:bb:cc' },
          metadata: { teamName: 'Acme' },
          installedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      ]);

      const list = await service.listForGateway('gw-1');

      expect(list).toHaveLength(1);
      expect(list[0].externalTenantId).toBe('T111');
      expect(list[0].credentialId).toBe('cred-1');
      expect(list[0].metadata).toEqual({ teamName: 'Acme' });
      expect(list[0]).not.toHaveProperty('credentials');
    });
  });
});
