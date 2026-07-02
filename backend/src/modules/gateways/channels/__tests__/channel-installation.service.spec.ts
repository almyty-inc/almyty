import { NotFoundException } from '@nestjs/common';

import { ChannelInstallationService } from '../channel-installation.service';
import { ChannelInstallation } from '../../../../entities/channel-installation.entity';
import { Gateway } from '../../../../entities/gateway.entity';
import { isEncrypted, decryptField } from '../../../../common/security/field-crypto';

/**
 * Unit coverage for the multi-workspace installation store: upsert
 * encrypts secret credentials at rest, resolution decrypts only for
 * active installations, and revoke clears the stored token.
 */
describe('ChannelInstallationService', () => {
  let repo: any;
  let service: ChannelInstallationService;

  const gateway = { id: 'gw-1', organizationId: 'org-1' } as unknown as Gateway;

  beforeEach(() => {
    repo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((data: any) => Object.assign(new ChannelInstallation(), data)),
      save: jest.fn(async (inst: any) => ({ id: 'inst-1', ...inst })),
      count: jest.fn(),
    };
    service = new ChannelInstallationService(repo);
  });

  describe('upsert', () => {
    it('creates a new installation with the bot token encrypted at rest', async () => {
      repo.findOne.mockResolvedValue(null);

      await service.upsert(gateway, {
        externalTenantId: 'T111',
        credentials: { bot_token: 'xoxb-plain-token' },
        metadata: { teamName: 'Acme' },
      });

      const saved = repo.save.mock.calls[0][0];
      expect(saved.gatewayId).toBe('gw-1');
      expect(saved.organizationId).toBe('org-1');
      expect(saved.externalTenantId).toBe('T111');
      expect(saved.status).toBe('active');
      expect(saved.metadata).toEqual({ teamName: 'Acme' });
      // Token is never stored in plaintext.
      expect(saved.credentials.bot_token).not.toBe('xoxb-plain-token');
      expect(isEncrypted(saved.credentials.bot_token)).toBe(true);
      expect(decryptField(saved.credentials.bot_token)).toBe('xoxb-plain-token');
    });

    it('reactivates a revoked installation with fresh credentials and installedAt', async () => {
      const old = Object.assign(new ChannelInstallation(), {
        id: 'inst-1',
        gatewayId: 'gw-1',
        externalTenantId: 'T111',
        status: 'revoked',
        credentials: null,
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
      const saved = repo.save.mock.calls[0][0];
      expect(saved.id).toBe('inst-1');
      expect(saved.status).toBe('active');
      expect(decryptField(saved.credentials.bot_token)).toBe('xoxb-new');
      expect(saved.metadata.teamName).toBe('New Name');
      expect(saved.installedAt.getTime()).toBeGreaterThan(new Date('2020-01-01T00:00:00Z').getTime());
    });

    it('leaves non-secret credential keys unencrypted', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.upsert(gateway, {
        externalTenantId: 'T111',
        credentials: { bot_token: 'xoxb-1', bot_user_id: 'U42' },
      });
      const saved = repo.save.mock.calls[0][0];
      expect(saved.credentials.bot_user_id).toBe('U42');
      expect(isEncrypted(saved.credentials.bot_token)).toBe(true);
    });
  });

  describe('resolveCredentials', () => {
    it('returns decrypted credentials for an active installation', async () => {
      repo.findOne.mockResolvedValue(null);
      await service.upsert(gateway, {
        externalTenantId: 'T111',
        credentials: { bot_token: 'xoxb-workspace-token' },
      });
      const stored = repo.save.mock.calls[0][0];

      repo.findOne.mockResolvedValue(stored);
      const creds = await service.resolveCredentials('gw-1', 'T111');

      expect(repo.findOne).toHaveBeenLastCalledWith({
        where: { gatewayId: 'gw-1', externalTenantId: 'T111', status: 'active' },
      });
      expect(creds).toEqual({ bot_token: 'xoxb-workspace-token' });
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
    it('sets status=revoked and clears the stored credentials', async () => {
      const installation = Object.assign(new ChannelInstallation(), {
        id: 'inst-1',
        gatewayId: 'gw-1',
        externalTenantId: 'T111',
        status: 'active',
        credentials: { bot_token: 'encrypted:gcm:aa:bb:cc' },
        metadata: { teamName: 'Acme' },
      });
      repo.findOne.mockResolvedValue(installation);

      const result = await service.revoke('gw-1', 'inst-1');

      const saved = repo.save.mock.calls[0][0];
      expect(saved.status).toBe('revoked');
      expect(saved.credentials).toBeNull();
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
          credentials: { bot_token: 'encrypted:gcm:aa:bb:cc' },
          metadata: { teamName: 'Acme' },
          installedAt: new Date('2026-01-01T00:00:00Z'),
        }),
      ]);

      const list = await service.listForGateway('gw-1');

      expect(list).toHaveLength(1);
      expect(list[0].externalTenantId).toBe('T111');
      expect(list[0].metadata).toEqual({ teamName: 'Acme' });
      expect(list[0]).not.toHaveProperty('credentials');
    });
  });
});
