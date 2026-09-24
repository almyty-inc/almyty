import { NotFoundException } from '@nestjs/common';

import { CredentialsService } from '../credentials.service';
import { Credential, CredentialType } from '../../../entities/credential.entity';
import { ApiKey } from '../../../entities/api-key.entity';
import { Agent } from '../../../entities/agent.entity';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { makeOrgScopedRepo } from './org-scoped-repo.fixtures';

/**
 * Tenant scoping on the secrets vault.
 *
 * `credentials.service.spec.ts` drives every one of these methods through
 * a `findOne: jest.fn()` that hands its canned row back whatever `where`
 * it is given, and only `findById` asserts the arguments. Deleting
 * `organizationId` from the `where` in `update`, `delete`, `getUsage`,
 * `revokeAccessKey` and the access-key agent enrichment left all 194
 * tests in that module green — so nothing proved that one tenant cannot
 * read, edit, revoke or delete another tenant's secrets.
 *
 * These tests drive the same methods through a repository that actually
 * evaluates its criteria, so the org predicate has to be there.
 */
describe('CredentialsService tenant scoping', () => {
  const MINE = 'org-1';
  const THEIRS = 'org-2';

  const credential = (over: Partial<Credential> = {}): Credential =>
    Object.assign(new Credential(), {
      id: 'cred-mine',
      name: 'Mine',
      organizationId: MINE,
      type: CredentialType.API_KEY,
      config: { apiKey: 'sk-mine-0123456789' },
      isActive: true,
      visibility: 'org',
      teamId: null,
      ...over,
    });

  const accessKey = (over: Partial<ApiKey> = {}): ApiKey =>
    Object.assign(new ApiKey(), {
      id: 'key-mine',
      name: 'Mine',
      keyPrefix: 'almyty_sk_aaaa',
      organizationId: MINE,
      isActive: true,
      scopes: [],
      expiresAt: null,
      lastUsedAt: null,
      rateLimits: null,
      createdAt: new Date(),
      agentId: null,
      ...over,
    });

  function build(seed: {
    credentials?: Credential[];
    apiKeys?: ApiKey[];
    agents?: Agent[];
  } = {}) {
    const credentialRepo = makeOrgScopedRepo<Credential>(seed.credentials ?? []);
    const apiKeyRepo = makeOrgScopedRepo<ApiKey>(seed.apiKeys ?? []);
    const llmProviderRepo = makeOrgScopedRepo<any>([]);
    const apiRepo = makeOrgScopedRepo<any>([]);
    const gatewayRepo = makeOrgScopedRepo<any>([]);
    const agentRepo = makeOrgScopedRepo<any>(seed.agents ?? []);
    const auditLog = { log: jest.fn().mockResolvedValue(null) };
    const accessPolicy = {
      canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
      applyListFilter: jest.fn().mockResolvedValue({ bypass: true, teamIds: [] }),
      assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
    };

    const service = new CredentialsService(
      credentialRepo as any,
      apiKeyRepo as any,
      llmProviderRepo as any,
      apiRepo as any,
      gatewayRepo as any,
      agentRepo as any,
      auditLog as any,
      accessPolicy as any,
      makeEnvelopeCryptoMock() as any,
    );

    return { service, credentialRepo, apiKeyRepo, agentRepo };
  }

  it('findById does not hand out another organization’s credential', async () => {
    const { service } = build({ credentials: [credential({ id: 'cred-theirs', organizationId: THEIRS })] });

    await expect(service.findById('cred-theirs', MINE)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update does not touch another organization’s credential', async () => {
    const { service, credentialRepo } = build({
      credentials: [credential({ id: 'cred-theirs', name: 'Theirs', organizationId: THEIRS })],
    });

    await expect(
      service.update('cred-theirs', { name: 'pwned' }, MINE),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(credentialRepo.rows.find((r) => r.id === 'cred-theirs')!.name).toBe('Theirs');
  });

  it('delete does not remove another organization’s credential', async () => {
    const { service, credentialRepo } = build({
      credentials: [credential({ id: 'cred-theirs', organizationId: THEIRS })],
    });

    await expect(service.delete('cred-theirs', MINE)).rejects.toBeInstanceOf(NotFoundException);

    expect(credentialRepo.rows).toHaveLength(1);
  });

  it('getUsage does not report on another organization’s credential', async () => {
    const { service } = build({
      credentials: [credential({ id: 'cred-theirs', organizationId: THEIRS })],
    });

    await expect(service.getUsage('cred-theirs', MINE)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revokeAccessKey does not revoke another organization’s key', async () => {
    const { service, apiKeyRepo } = build({
      apiKeys: [accessKey({ id: 'key-theirs', organizationId: THEIRS })],
    });

    await expect(service.revokeAccessKey('key-theirs', MINE)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(apiKeyRepo.rows.find((r) => r.id === 'key-theirs')!.isActive).toBe(true);
  });

  it('findAllAccessKeys never names an agent from another organization', async () => {
    // A key row predating the org check in createAccessKey can still
    // carry a foreign agent id; the listing must not print its name.
    const { service } = build({
      apiKeys: [accessKey({ id: 'key-mine', agentId: 'agent-theirs' })],
      agents: [{ id: 'agent-theirs', name: 'Their Secret Agent', organizationId: THEIRS }],
    });

    const listed = await service.findAllAccessKeys(MINE);

    expect(listed).toHaveLength(1);
    expect(listed[0].agent).toBeNull();
  });

  it('findAllAccessKeys resolves an agent that is in the caller’s organization', async () => {
    const { service } = build({
      apiKeys: [accessKey({ id: 'key-mine', agentId: 'agent-mine' })],
      agents: [{ id: 'agent-mine', name: 'My Agent', organizationId: MINE }],
    });

    const listed = await service.findAllAccessKeys(MINE);

    expect(listed[0].agent).toEqual({ id: 'agent-mine', name: 'My Agent' });
  });
});
