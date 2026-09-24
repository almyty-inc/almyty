import { AgentApp } from '../../../entities/agent-app.entity';
import {
  AppDistribution,
  DistributionTarget,
} from '../../../entities/agent-app-distribution.entity';
import { AgentAppsController } from '../agent-apps.controller';
import { AgentAppsService } from '../agent-apps.service';
import { MASKED_CHANNEL_SECRET } from '../../gateways/channels/channel-config.helper';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A distribution's configuration is where the operator's platform
 * credentials live: a Slack bot token and signing secret, a Twilio auth
 * token, a Resend key. The gateway those same values are copied into
 * masks them on every response, and GET /apps/:slug is readable by any
 * member, so returning the distribution row verbatim handed every
 * member the tokens the gateway API refuses to show them.
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
  const service = new AgentAppsService(
    apps as any,
    distributions as any,
    fakeRepository<any>() as any,
    fakeRepository<any>() as any,
    fakeRepository<any>() as any,
    {} as any,
  );
  // findOne's relation load: attach the distributions the way TypeORM would.
  const findOne = service.findOne.bind(service);
  jest.spyOn(service, 'findOne').mockImplementation(async (org: string, slug: string) => {
    const app = await findOne(org, slug);
    (app as any).distributions = await distributions.find({ where: { appId: app.id } });
    return app;
  });
  return { service, distributions };
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
    const { service, distributions } = makeService();

    await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, {
      bot_token: MASKED_CHANNEL_SECRET,
      signing_secret: 'rotated-secret',
    });

    const [row] = await distributions.find({ where: { id: 'dist-1' } });
    expect(row.configuration.bot_token).toBe(SECRET);
    expect(row.configuration.signing_secret).toBe('rotated-secret');
  });
});
