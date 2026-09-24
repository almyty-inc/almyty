import { NotFoundException } from '@nestjs/common';

import { CredentialsService } from '../credentials.service';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import { ApiKey } from '../../../entities/api-key.entity';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * Tenant scoping on the secrets vault and on inbound access keys.
 *
 * `credentials.service.spec.ts` drives these methods through `findOne`
 * doubles that hand back their canned row whatever `where` they get, so
 * the `organizationId` in each lookup was never evaluated. Here the
 * repositories keep tables, so a lookup that forgets the org finds the
 * other tenant's row and the test fails.
 */
describe('CredentialsService tenant scoping', () => {
  const MINE = 'org-1';
  const THEIRS = 'org-2';
  const USER = 'user-1';

  const credential = (over: Partial<Credential> = {}): Partial<Credential> => ({
    id: 'cred-mine',
    name: 'Mine',
    organizationId: MINE,
    type: CredentialType.API_KEY,
    config: { apiKey: 'sk-mine-0123456789' },
    isActive: true,
    visibility: 'org' as any,
    teamId: null,
    ...over,
  });

  const accessKey = (over: Partial<ApiKey> = {}): Partial<ApiKey> => ({
    id: 'key-mine',
    name: 'Mine',
    keyPrefix: 'almyty_sk_aaaa',
    organizationId: MINE,
    isActive: true,
    scopes: [],
    createdAt: new Date(),
    ...over,
  });

  function build(seed: { credentials?: any[]; apiKeys?: any[]; agents?: any[]; gateways?: any[] } = {}) {
    const credentials = fakeRepository<any>({ seed: seed.credentials ?? [], make: () => new Credential() });
    const apiKeys = fakeRepository<any>({ seed: seed.apiKeys ?? [], make: () => new ApiKey(), idPrefix: 'key' });
    const agents = fakeRepository<any>(seed.agents ?? []);
    const gateways = fakeRepository<any>(seed.gateways ?? []);
    const accessPolicy = {
      canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
      applyListFilter: jest.fn(),
      assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
    };

    const service = new CredentialsService(
      credentials as any,
      apiKeys as any,
      fakeRepository<any>() as any,
      fakeRepository<any>() as any,
      gateways as any,
      agents as any,
      { log: jest.fn() } as any,
      accessPolicy as any,
      makeEnvelopeCryptoMock(),
    );

    return { service, credentials, apiKeys };
  }

  describe('credentials', () => {
    it('update edits a credential of the caller’s organization', async () => {
      const { service, credentials } = build({ credentials: [credential()] });

      await service.update('cred-mine', { name: 'Renamed' }, MINE, USER);

      expect(credentials.row('cred-mine')!.name).toBe('Renamed');
    });

    it('update does not touch another organization’s credential', async () => {
      const { service, credentials } = build({
        credentials: [credential({ id: 'cred-theirs', name: 'Theirs', organizationId: THEIRS })],
      });

      await expect(service.update('cred-theirs', { name: 'pwned' }, MINE, USER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(credentials.row('cred-theirs')!.name).toBe('Theirs');
    });

    it('delete does not remove another organization’s credential', async () => {
      const { service, credentials } = build({
        credentials: [credential({ id: 'cred-theirs', organizationId: THEIRS })],
      });

      await expect(service.delete('cred-theirs', MINE, USER)).rejects.toBeInstanceOf(NotFoundException);
      expect(credentials.row('cred-theirs')).toBeDefined();
    });

    it('getUsage does not report on another organization’s credential', async () => {
      const { service } = build({ credentials: [credential({ id: 'cred-theirs', organizationId: THEIRS })] });

      await expect(service.getUsage('cred-theirs', MINE)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('access keys', () => {
    it('revokeAccessKey does not revoke another organization’s key', async () => {
      const { service, apiKeys } = build({ apiKeys: [accessKey({ id: 'key-theirs', organizationId: THEIRS })] });

      await expect(service.revokeAccessKey('key-theirs', MINE)).rejects.toBeInstanceOf(NotFoundException);
      expect(apiKeys.row('key-theirs')!.isActive).toBe(true);
    });

    it('revokeAccessKey deactivates the stored row of the caller’s key', async () => {
      const { service, apiKeys } = build({ apiKeys: [accessKey()] });

      await service.revokeAccessKey('key-mine', MINE);

      expect(apiKeys.row('key-mine')!.isActive).toBe(false);
    });

    it('findAllAccessKeys never names an agent from another organization', async () => {
      // A key row predating the org check in createAccessKey can still
      // carry a foreign agent id.
      const { service } = build({
        apiKeys: [accessKey({ agentId: 'agent-theirs' })],
        agents: [{ id: 'agent-theirs', name: 'Their Agent', organizationId: THEIRS }],
      });

      const listed = await service.findAllAccessKeys(MINE);

      expect(listed).toHaveLength(1);
      expect(listed[0].agent).toBeNull();
    });

    it('findAllAccessKeys names an agent of the caller’s organization', async () => {
      const { service } = build({
        apiKeys: [accessKey({ agentId: 'agent-mine' })],
        agents: [{ id: 'agent-mine', name: 'My Agent', organizationId: MINE }],
      });

      const listed = await service.findAllAccessKeys(MINE);

      expect(listed[0].agent).toEqual({ id: 'agent-mine', name: 'My Agent' });
    });

    it('createAccessKey refuses to bind another organization’s agent', async () => {
      const { service, apiKeys } = build({
        agents: [{ id: 'agent-theirs', name: 'Their Agent', organizationId: THEIRS }],
      });

      await expect(
        service.createAccessKey({ name: 'k', agentId: 'agent-theirs' }, MINE, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(apiKeys.rows()).toHaveLength(0);
    });

    it('createAccessKey binds a gateway and agent of the caller’s organization', async () => {
      const { service, apiKeys } = build({
        gateways: [{ id: 'gw-mine', organizationId: MINE, visibility: 'org' }],
        agents: [{ id: 'agent-mine', name: 'My Agent', organizationId: MINE }],
      });

      const { key } = await service.createAccessKey(
        { name: 'k', gatewayId: 'gw-mine', agentId: 'agent-mine' },
        MINE,
        USER,
      );

      expect(apiKeys.row(key.id)).toMatchObject({ gatewayId: 'gw-mine', agentId: 'agent-mine' });
    });
  });
});
