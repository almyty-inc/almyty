import { AgentApp } from '../../../entities/agent-app.entity';
import {
  AppDistribution,
  DistributionTarget,
} from '../../../entities/agent-app-distribution.entity';
import { AgentAppsController } from '../agent-apps.controller';
import { AgentAppsService } from '../agent-apps.service';
import { MASKED_CHANNEL_SECRET } from '../../gateways/channels/channel-config.helper';
import { fakeRepository } from '../../../test/fake-repository';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { Credential } from '../../../entities/credential.entity';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { decryptField } from '../../../common/security/field-crypto';

/**
 * A distribution's platform credentials (a Slack bot token and signing
 * secret, a Twilio auth token, a Resend key) belong in its credential,
 * but a row written before that still carries them inline, as the seed
 * here does. GET /apps/:slug is readable by any member, so whatever the
 * row holds is masked on the way out, and the next write moves it into
 * the store.
 */

const ORG = 'org-1';
const SECRET = 'xoxb-real-bot-token';
const SIGNING = 'real-signing-secret';

function makeService() {
  const apps = fakeRepository<any>({
    make: () => new AgentApp(),
    seed: [{ id: 'app-1', organizationId: ORG, slug: 'acme-support', name: 'Acme', agentIds: [] }],
  });
  const distributions = fakeRepository<any>({
    make: () => new AppDistribution(),
    seed: [
      {
        id: 'dist-1',
        organizationId: ORG,
        appId: 'app-1',
        target: DistributionTarget.SLACK,
        configuration: { bot_token: SECRET, signing_secret: SIGNING, agentId: 'agent-1' },
      },
    ],
  });
  const credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
  const service = new AgentAppsService(
    apps as any,
    distributions as any,
    fakeRepository<any>() as any,
    fakeRepository<any>() as any,
    fakeRepository<any>() as any,
    {} as any,
    undefined,
    new CredentialRefResolver(credentials as any, makeEnvelopeCryptoMock()),
  );
  // findOne's relation load: attach the distributions the way TypeORM would.
  const findOne = service.findOne.bind(service);
  jest.spyOn(service, 'findOne').mockImplementation(async (org: string, slug: string) => {
    const app = await findOne(org, slug);
    (app as any).distributions = await distributions.find({ where: { appId: app.id } });
    return app;
  });
  return { service, distributions, credentials };
}

const req = { user: { id: 'user-1', currentOrganizationId: ORG } };

describe('distribution secrets never leave /apps in the clear', () => {
  it('masks platform credentials on GET /apps/:slug', async () => {
    const { service } = makeService();
    const controller = new AgentAppsController(service, {} as any);

    const { data } = await controller.findOne('acme-support', req);
    const body = JSON.stringify(data);

    expect(body).not.toContain(SECRET);
    expect(body).not.toContain(SIGNING);
    expect((data as any).distributions[0].configuration.bot_token).toBe(MASKED_CHANNEL_SECRET);
    // Non-secret settings are still readable.
    expect((data as any).distributions[0].configuration.agentId).toBe('agent-1');
  });

  it('masks them in the response to a settings write', async () => {
    const { service } = makeService();
    const controller = new AgentAppsController(service, {} as any);

    const { data } = await controller.addDistribution(
      'acme-support',
      { target: DistributionTarget.SLACK, configuration: { agentId: 'agent-1' } },
      req,
    );

    expect(JSON.stringify(data)).not.toContain(SECRET);
  });

  it('keeps the stored secret when a masked placeholder is sent back', async () => {
    const { service, distributions, credentials } = makeService();

    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, {
      bot_token: MASKED_CHANNEL_SECRET,
      signing_secret: 'rotated-secret',
    });

    // The row keeps a reference; the values are in the distribution's
    // credential, the kept one and the rotated one both.
    const [row] = await distributions.find({ where: { id: 'dist-1' } });
    expect(JSON.stringify(row.configuration)).not.toContain(SECRET);
    const credential = credentials.row(row.configuration.credentialId)!;
    expect(decryptField(credential.config.bot_token, ORG)).toBe(SECRET);
    expect(decryptField(credential.config.signing_secret, ORG)).toBe('rotated-secret');
  });
});
