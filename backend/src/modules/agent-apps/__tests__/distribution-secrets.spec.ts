import { ServiceUnavailableException } from '@nestjs/common';

import { AgentAppsService } from '../agent-apps.service';
import { AppAuthMode } from '../../../entities/agent-app.entity';
import { AppDistribution, DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import { Credential } from '../../../entities/credential.entity';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { fakeRepository } from '../../../test/fake-repository';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { decryptField, isEncrypted } from '../../../common/security/field-crypto';
import { MASKED_CHANNEL_SECRET } from '../../gateways/channels/channel-config.helper';
import { splitDistributionSecrets } from '../distribution-secrets';
import { publicApp, publicDistribution } from '../agent-apps.controller';

/**
 * A distribution's platform secrets live in `credentials`, never on the
 * distribution row, and are never read back.
 *
 * Every table here is a truthful in-memory repository, so "the row has no
 * secret" is a statement about what was written, not about a mock's
 * return value.
 */
describe('distribution secrets', () => {
  const ORG = 'org-1';
  const SLACK = { bot_token: 'xoxb-live-1', signing_secret: 'sign-live-1' };

  let apps: ReturnType<typeof fakeRepository>;
  let distributions: ReturnType<typeof fakeRepository<AppDistribution>>;
  let credentials: ReturnType<typeof fakeRepository<Credential>>;
  let gatewayCalls: any[];
  let service: AgentAppsService;

  const build = (withStore = true) =>
    new AgentAppsService(
      apps as any,
      distributions as any,
      fakeRepository([{ id: 'agent-1', organizationId: ORG, visibility: 'org', mode: 'autonomous' }]) as any,
      fakeRepository() as any,
      fakeRepository() as any,
      {
        upsertForDistribution: async (dto: any) => {
          gatewayCalls.push(dto);
          return { id: 'gw-1' };
        },
        activateGateway: async () => ({ id: 'gw-1', status: 'active' }),
        deactivateGateway: async () => ({ id: 'gw-1' }),
      } as any,
      undefined,
      withStore ? new CredentialRefResolver(credentials as any, makeEnvelopeCryptoMock()) : undefined,
    );

  beforeEach(() => {
    apps = fakeRepository([
      {
        id: 'app-1',
        organizationId: ORG,
        name: 'Acme Support',
        slug: 'acme-support',
        agentIds: ['agent-1'],
        branding: {},
        authMode: AppAuthMode.PUBLIC_LINK,
        capabilities: {},
        limits: { costCapCents: 500, perUserRateLimit: 60, perIpRateLimit: 60 },
        isActive: true,
      },
    ]);
    distributions = fakeRepository<AppDistribution>({ idPrefix: 'dist' });
    credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
    gatewayCalls = [];
    service = build();
  });

  const stored = () => distributions.rows()[0];
  const plaintextOf = (credentialId: string, key: string) =>
    decryptField(credentials.row(credentialId)!.config[key], ORG);

  it('keeps pasted secrets off the distribution row and in one managed credential', async () => {
    const result = await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, { ...SLACK, agentId: 'agent-1' });

    const row = stored();
    expect(row.configuration).toEqual({
      agentId: 'agent-1',
      credentialId: expect.any(String),
      credentialKeys: expect.arrayContaining(['bot_token', 'signing_secret']),
    });
    expect(JSON.stringify(row)).not.toContain('xoxb-live-1');
    expect(JSON.stringify(result)).not.toContain('xoxb-live-1');

    const credential = credentials.row(row.configuration.credentialId)!;
    expect(credential.organizationId).toBe(ORG);
    expect(credential.metadata.managedBy).toEqual({ kind: 'app_distribution', id: row.id });
    expect(isEncrypted(credential.config.bot_token)).toBe(true);
    expect(plaintextOf(credential.id, 'bot_token')).toBe('xoxb-live-1');
  });

  it('rotates the same credential in place on a later edit, and clears a key sent empty', async () => {
    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, SLACK);
    const credentialId = stored().configuration.credentialId;

    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, { bot_token: 'xoxb-live-2' });
    expect(stored().configuration.credentialId).toBe(credentialId);
    expect(credentials.rows()).toHaveLength(1);
    expect(plaintextOf(credentialId, 'bot_token')).toBe('xoxb-live-2');
    expect(plaintextOf(credentialId, 'signing_secret')).toBe('sign-live-1');

    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, { signing_secret: '' });
    expect(stored().configuration.credentialKeys).toEqual(['bot_token']);
  });

  it('ignores a masked value sent back, and a credentialId the client tries to set', async () => {
    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, SLACK);
    const credentialId = stored().configuration.credentialId;

    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, {
      bot_token: MASKED_CHANNEL_SECRET,
      credentialId: 'someone-elses-credential',
    });
    expect(stored().configuration.credentialId).toBe(credentialId);
    expect(plaintextOf(credentialId, 'bot_token')).toBe('xoxb-live-1');
  });

  it('moves a secret still inline on an older row into the store on the next write', async () => {
    distributions.seed({
      id: 'dist-old',
      organizationId: ORG,
      appId: 'app-1',
      target: DistributionTarget.SLACK,
      status: 'draft' as any,
      gatewayId: null,
      configuration: { ...SLACK, agentId: 'agent-1' },
    });

    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, { agentId: 'agent-1' });

    const row = distributions.row('dist-old')!;
    expect(JSON.stringify(row.configuration)).not.toContain('xoxb-live-1');
    expect(plaintextOf(row.configuration.credentialId, 'bot_token')).toBe('xoxb-live-1');
  });

  it('publishes with a reference the gateway resolves, not a copy of the secret', async () => {
    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, SLACK);
    expect((await service.checkDistribution(ORG, 'acme-support', DistributionTarget.SLACK)).refusals.map((r) => r.code)).not.toContain(
      'MISSING_CREDENTIALS',
    );

    await service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1');

    const dto = gatewayCalls[0];
    expect(dto.configuration.credentialId).toBe(stored().configuration.credentialId);
    expect(JSON.stringify(dto)).not.toContain('xoxb-live-1');
  });

  it('deletes the managed credential with the distribution', async () => {
    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, SLACK);
    expect(credentials.rows()).toHaveLength(1);

    await service.removeDistribution(ORG, 'acme-support', DistributionTarget.SLACK);
    expect(credentials.rows()).toHaveLength(0);
  });

  it('refuses a secret rather than writing it to the row when the store is missing', async () => {
    const withoutStore = build(false);
    await expect(withoutStore.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, SLACK)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(JSON.stringify(distributions.rows())).not.toContain('xoxb-live-1');
  });

  describe('on the way out', () => {
    it('masks inline values and the keys the credential holds', () => {
      expect(
        publicDistribution({ configuration: { bot_token: 'xoxb-legacy', credentialId: 'c', credentialKeys: ['signing_secret'], agentId: 'a' } }),
      ).toEqual({
        configuration: {
          bot_token: MASKED_CHANNEL_SECRET,
          signing_secret: MASKED_CHANNEL_SECRET,
          credentialId: 'c',
          credentialKeys: ['signing_secret'],
          agentId: 'a',
        },
      });
      const app = publicApp({ distributions: [{ configuration: { app_secret: 'x' } }] });
      expect(app.distributions![0].configuration).toEqual({ app_secret: MASKED_CHANNEL_SECRET });
    });

    it('splits secrets from public settings, legacy spellings included', () => {
      expect(splitDistributionSecrets({ botToken: 'b', phone_number: '+1', twilio_auth_token: '', credentialKeys: ['x'] })).toEqual({
        secrets: { bot_token: 'b' },
        cleared: ['twilio_auth_token'],
        publicConfig: { phone_number: '+1' },
      });
    });
  });
});
