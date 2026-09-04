import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { AgentAppsService } from '../agent-apps.service';
import { AppAuthMode } from '../../../entities/agent-app.entity';
import {
  DistributionStatus,
  DistributionTarget,
} from '../../../entities/agent-app-distribution.entity';

describe('AgentAppsService', () => {
  let appRepository: any;
  let distributionRepository: any;
  let agentRepository: any;
  let gateways: any;
  let service: AgentAppsService;

  const ORG = 'org-1';

  const app = (overrides: any = {}) => ({
    id: 'h-1',
    organizationId: ORG,
    name: 'Acme Support',
    slug: 'acme-support',
    agentIds: ['agent-1'],
    branding: {},
    authMode: AppAuthMode.PUBLIC_LINK,
    capabilities: {},
    // Open to anyone, so the product rules demand these before it can
    // be published. Set here so publish tests exercise publishing
    // rather than re-testing the limits rule.
    limits: { costCapCents: 500, perUserRateLimit: 60, perIpRateLimit: 60 },
    isActive: true,
    ...overrides,
  });

  beforeEach(() => {
    appRepository = {
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => app()),
      create: jest.fn((row: any) => row),
      save: jest.fn(async (row: any) => ({ id: 'h-1', ...row })),
      remove: jest.fn(async () => undefined),
    };
    distributionRepository = {
      findOne: jest.fn(async () => null),
      create: jest.fn((row: any) => row),
      save: jest.fn(async (row: any) => ({ id: 'd-1', ...row })),
      remove: jest.fn(async () => undefined),
    };
    agentRepository = {
      find: jest.fn(async () => [{ id: 'agent-1' }]),
      // Publishing resolves the agent that will answer; a workflow one
      // would be refused, so the default fixture is conversational.
      findOne: jest.fn(async () => ({ id: 'agent-1', mode: 'autonomous' })),
    };
    gateways = {
      upsertForDistribution: jest.fn(async () => ({ id: 'gw-1' })),
      deactivateGateway: jest.fn(async () => ({ id: 'gw-1' })),
    };
    service = new AgentAppsService(
      appRepository,
      distributionRepository,
      agentRepository,
      gateways,
    );
  });

  describe('publish-time SSO entitlement', () => {
    const ssoApp = () => ({ id: 'app-1', organizationId: ORG, name: 'n', slug: 's', agentIds: ['agent-1'], authMode: 'sso', limits: { costCapCents: 100, perUserRateLimit: 10, perIpRateLimit: 10 }, isActive: true }) as any;

    it('refuses an SSO app when the org has no entitlement resolver (community build)', async () => {
      appRepository.findOne.mockResolvedValue(ssoApp());
      const result = await service.check(ORG, 's');

      expect(result.refusals.map((r: any) => r.code)).toContain('SSO_NOT_ENTITLED');
    });

    it('lets an entitled org publish an SSO app', async () => {
      const orgLicense = { hasForOrg: jest.fn(async () => true) };
      const entitled = new AgentAppsService(appRepository, distributionRepository, agentRepository, gateways, orgLicense as any);
      appRepository.findOne.mockResolvedValue(ssoApp());
      const result = await entitled.check(ORG, 's');

      expect(orgLicense.hasForOrg).toHaveBeenCalledWith(ORG, 'sso');
      expect(result.refusals.map((r: any) => r.code)).not.toContain('SSO_NOT_ENTITLED');
    });
  });

  describe('tenant scoping', () => {
    it('looks an app up by name, scoped to the organization in the query', async () => {
      await service.findOne(ORG, '  ACME-Support ');
      expect(appRepository.findOne).toHaveBeenCalledWith({
        where: { slug: 'acme-support', organizationId: ORG },
        relations: { distributions: true },
      });
    });

    it('404s rather than leaking another tenant product', async () => {
      appRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findOne(ORG, 'someone-elses')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('normalises the slug and defaults to the open auth mode', async () => {
      appRepository.findOne.mockResolvedValueOnce(null); // no clash
      const created = await service.create(ORG, { name: 'Acme', slug: '  ACME-Support ' });
      expect(created.slug).toBe('acme-support');
      expect(created.authMode).toBe(AppAuthMode.PUBLIC_LINK);
    });

    it('rejects an unusable slug before touching the database', async () => {
      await expect(service.create(ORG, { name: 'Acme', slug: 'a' })).rejects.toThrow(
        BadRequestException,
      );
      expect(appRepository.save).not.toHaveBeenCalled();
    });

    it('refuses a slug already used in this organization', async () => {
      appRepository.findOne.mockResolvedValueOnce(app());
      await expect(service.create(ORG, { name: 'Acme', slug: 'acme-support' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('refuses agents belonging to another organization', async () => {
      // Otherwise a product could serve another tenant's agent under
      // its own branding.
      agentRepository.find.mockResolvedValueOnce([{ id: 'agent-1' }]);
      await expect(
        service.create(ORG, { name: 'Acme', slug: 'acme', agentIds: ['agent-1', 'not-ours'] }),
      ).rejects.toThrow(/not-ours/);
    });

    it('allows a product with no agents yet, so it can be built up', async () => {
      appRepository.findOne.mockResolvedValueOnce(null); // no clash
      const created = await service.create(ORG, { name: 'Acme', slug: 'acme' });
      expect(created.agentIds).toEqual([]);
      // Publishing is what refuses an empty product, not creating one.
      expect(agentRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('checks ownership again when the agent list changes', async () => {
      agentRepository.find.mockResolvedValueOnce([]);
      await expect(service.update(ORG, 'acme-support', { agentIds: ['stolen'] })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('allows keeping the same slug', async () => {
      appRepository.findOne.mockResolvedValueOnce(app());
      const updated = await service.update(ORG, 'acme-support', { slug: 'acme-support' });
      expect(updated.slug).toBe('acme-support');
    });

    it('refuses a slug taken by another product', async () => {
      appRepository.findOne
        .mockResolvedValueOnce(app())
        .mockResolvedValueOnce(app({ id: 'h-2', slug: 'taken' }));
      await expect(service.update(ORG, 'acme-support', { slug: 'taken' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('leaves untouched fields alone', async () => {
      const updated = await service.update(ORG, 'acme-support', { name: 'Renamed' });
      expect(updated.name).toBe('Renamed');
      expect(updated.slug).toBe('acme-support');
      expect(updated.agentIds).toEqual(['agent-1']);
    });
  });

  describe('distributions', () => {
    it('creates one in draft', async () => {
      const created = await service.addDistribution(ORG, 'acme-support', DistributionTarget.WEB);
      expect(created.status).toBe(DistributionStatus.DRAFT);
      expect(created.appId).toBe('h-1');
    });

    it('keeps one distribution per target rather than adding a second', async () => {
      // Naming the platform rather than lumping them under "channel" is
      // what makes this simple: slack and telegram are separate targets.
      for (const target of [
        DistributionTarget.WEB,
        DistributionTarget.DESKTOP,
        DistributionTarget.BINARY,
        DistributionTarget.TUI,
        DistributionTarget.SLACK,
      ]) {
        appRepository.findOne.mockResolvedValueOnce(app());
        distributionRepository.findOne.mockResolvedValueOnce({ id: 'existing', configuration: {} });

        const result = await service.addDistribution(ORG, 'acme-support', target);

        expect(result.id).toBe('existing');
        expect(distributionRepository.create).not.toHaveBeenCalled();
      }
    });

    it('treats shipping somewhere it already ships as a settings change', async () => {
      // This used to be a 409, which meant every edit to an existing
      // distribution's settings failed.
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'existing',
        configuration: { bundleId: 'com.acme.assistant' },
      });

      const result = await service.addDistribution(ORG, 'acme-support', DistributionTarget.TUI, {
        signingCredentialId: 'cred-1',
      });

      expect(result.configuration).toEqual({
        bundleId: 'com.acme.assistant',
        signingCredentialId: 'cred-1',
      });
    });

    it('does not drop settings a partial update did not mention', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'existing',
        configuration: { bundleId: 'com.acme.assistant', signingCredentialId: 'cred-1' },
      });

      const result = await service.addDistribution(ORG, 'acme-support', DistributionTarget.TUI, {
        bundleId: 'com.acme.renamed',
      });

      expect(result.configuration.signingCredentialId).toBe('cred-1');
    });

    it('clears a setting when it is sent empty', async () => {
      // Choosing "ship it unsigned" has to be expressible.
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'existing',
        configuration: { signingCredentialId: 'cred-1' },
      });

      const result = await service.addDistribution(ORG, 'acme-support', DistributionTarget.TUI, {
        signingCredentialId: '',
      });

      expect(result.configuration.signingCredentialId).toBe('');
    });

    it('leaves the gateway alone when an update does not name one', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'existing',
        configuration: {},
        gatewayId: 'gw-1',
      });

      const result = await service.addDistribution(ORG, 'acme-support', DistributionTarget.SLACK, {
        bundleId: 'x',
      });

      expect(result.gatewayId).toBe('gw-1');
    });

    it('lets an app ship to several platforms at once', async () => {
      // Slack already exists; telegram is a different target, so it is
      // not a clash.
      distributionRepository.findOne.mockResolvedValueOnce(null);
      const created = await service.addDistribution(
        ORG,
        'acme-support',
        DistributionTarget.TELEGRAM,
        {},
        'gw-telegram',
      );
      expect(created.gatewayId).toBe('gw-telegram');
      expect(created.target).toBe(DistributionTarget.TELEGRAM);
    });

    // Slack cannot carry a message without these, so publishing refuses
    // without them and every publish fixture supplies them.
    const SLACK_CREDS = { bot_token: 'xoxb-1', signing_secret: 's3cret' };

    it('stands up a gateway and marks the distribution live', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: SLACK_CREDS,
      });

      const result = await service.publishDistribution(
        ORG,
        'acme-support',
        DistributionTarget.SLACK,
        'user-1',
      );

      expect(gateways.upsertForDistribution).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: '/apps/acme-support/slack', agentId: 'agent-1' }),
        ORG,
        'user-1',
      );
      expect(result.gatewayId).toBe('gw-1');
      expect(result.status).toBe(DistributionStatus.LIVE);
    });

    it('gives the surface the product branding rather than a copy to keep in step', async () => {
      appRepository.findOne.mockResolvedValueOnce(
        app({ branding: { appName: 'Acme', primaryColor: '#123456' } }),
      );
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: SLACK_CREDS,
      });

      await service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1');

      const dto = gateways.upsertForDistribution.mock.calls[0][0];
      expect(dto.configuration.branding).toEqual({ appName: 'Acme', primaryColor: '#123456' });
      // The credentials survive alongside the branding.
      expect(dto.configuration).toMatchObject(SLACK_CREDS);
    });

    it('refuses to publish in front of an agent that cannot hold a conversation', async () => {
      // The runtime turns every visitor away with "not in autonomous
      // mode", so the surface would be live and useless.
      agentRepository.findOne.mockResolvedValueOnce({ id: 'agent-1', mode: 'workflow' });
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: SLACK_CREDS,
      });

      await expect(
        service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1'),
      ).rejects.toThrow(/workflow/i);
      expect(gateways.upsertForDistribution).not.toHaveBeenCalled();
    });

    it('repoints the surface when the app changes which agent answers', async () => {
      // Republishing is how a settings change is applied, so a gateway
      // that kept pointing at the old agent would be silently stale.
      appRepository.findOne.mockResolvedValueOnce(app({ agentIds: ['agent-2'] }));
      agentRepository.findOne.mockResolvedValueOnce({ id: 'agent-2', mode: 'autonomous' });
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: SLACK_CREDS,
      });

      await service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1');

      expect(gateways.upsertForDistribution).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'agent-2' }),
        ORG,
        'user-1',
      );
    });

    it('resolves the agent scoped to the organization', async () => {
      // An agent id copied from another tenant must not be publishable.
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: SLACK_CREDS,
      });

      await service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1');

      expect(agentRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'agent-1', organizationId: ORG },
      });
    });

    it('refuses to publish a platform whose credentials are missing', async () => {
      // A gateway created without them says live and answers nothing.
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: { bot_token: 'xoxb-1' },
      });

      await expect(
        service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1'),
      ).rejects.toThrow(/signing_secret/);
      expect(gateways.upsertForDistribution).not.toHaveBeenCalled();
    });

    it('gives a published web surface the block the hosted chat finds it by', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: {},
      });

      await service.publishDistribution(ORG, 'acme-support', DistributionTarget.WEB, 'user-1');

      const dto = gateways.upsertForDistribution.mock.calls[0][0];
      expect(dto.configuration.hostedChat.slug).toBe('acme-support');
    });

    it('refuses to publish a product with no agent', async () => {
      appRepository.findOne.mockResolvedValueOnce(app({ agentIds: [] }));
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: SLACK_CREDS,
      });

      await expect(
        service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1'),
      ).rejects.toThrow(BadRequestException);
      expect(gateways.upsertForDistribution).not.toHaveBeenCalled();
    });

    it('refuses to publish a target that ships as a file', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({ id: 'd-1', appId: 'h-1' });

      await expect(
        service.publishDistribution(ORG, 'acme-support', DistributionTarget.TUI, 'user-1'),
      ).rejects.toThrow(/download/i);
    });

    it('refuses to publish a public product with no cost cap', async () => {
      // The rule exists because an open product is a way to hand a
      // stranger the customer's model spend.
      appRepository.findOne.mockResolvedValueOnce(app({ limits: null }));
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: SLACK_CREDS,
      });

      await expect(
        service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1'),
      ).rejects.toThrow(/cost cap/i);
    });

    it('carries the product rate limit onto the gateway it stands up', async () => {
      // Publishing with the limits dropped would make the check theatre.
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        configuration: SLACK_CREDS,
      });

      await service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1');

      const dto = gateways.upsertForDistribution.mock.calls[0][0];
      expect(dto.rateLimitConfig).toMatchObject({ enabled: true, requestsPerHour: 60 });
    });

    it('404s publishing a target this app does not ship to', async () => {
      distributionRepository.findOne.mockResolvedValueOnce(null);

      await expect(
        service.publishDistribution(ORG, 'acme-support', DistributionTarget.SLACK, 'user-1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('deactivates the gateway rather than deleting it when unpublishing', async () => {
      // Republishing has to keep the endpoint and whatever credentials
      // were attached: nobody should re-register a Slack app because
      // they took a product down for an afternoon.
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        gatewayId: 'gw-1',
      });

      const result = await service.unpublishDistribution(
        ORG,
        'acme-support',
        DistributionTarget.SLACK,
        'user-1',
      );

      expect(gateways.deactivateGateway).toHaveBeenCalledWith('gw-1', ORG, 'user-1');
      expect(result.status).toBe(DistributionStatus.DRAFT);
    });

    it('unpublishes a distribution that never had a gateway without failing', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        appId: 'h-1',
        gatewayId: null,
      });

      const result = await service.unpublishDistribution(
        ORG,
        'acme-support',
        DistributionTarget.SLACK,
        'user-1',
      );

      expect(gateways.deactivateGateway).not.toHaveBeenCalled();
      expect(result.status).toBe(DistributionStatus.DRAFT);
    });

    it('404s removing a target this app does not ship to', async () => {
      distributionRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.removeDistribution(ORG, 'acme-support', DistributionTarget.DESKTOP),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('check', () => {
    it('reports the unmet rules rather than throwing', async () => {
      appRepository.findOne.mockResolvedValueOnce(app({ agentIds: [] }));
      const result = await service.check(ORG, 'acme-support', {});
      expect(result.ok).toBe(false);
      expect(result.refusals.map((r) => r.code)).toContain('NO_AGENTS');
    });

    it('passes a product with caps in place', async () => {
      const result = await service.check(ORG, 'acme-support', {
        costCapCents: 500,
        perUserRateLimit: 10,
        perIpRateLimit: 30,
      });
      expect(result.ok).toBe(true);
    });

    it('combines app and target rules in one answer', async () => {
      appRepository.findOne.mockResolvedValueOnce(app({ agentIds: [] }));
      distributionRepository.findOne.mockResolvedValueOnce({
        id: 'd-1',
        organizationId: ORG,
        appId: 'h-1',
        target: DistributionTarget.DESKTOP,
        configuration: { bundleId: 'not-reverse-dns' },
      });
      const result = await service.checkDistribution(
        ORG,
        'acme-support',
        DistributionTarget.DESKTOP,
        {},
      );
      const codes = result.refusals.map((r) => r.code);
      expect(codes).toContain('NO_AGENTS');
      expect(codes).toContain('BUNDLE_ID_INVALID');
    });
  });

  describe('recordBuild', () => {
    it('marks a successful build and stamps the time', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({ id: 'd-1', organizationId: ORG });
      const updated = await service.recordBuild(ORG, 'acme-support', DistributionTarget.BINARY, {
        version: '1.0.0',
        platform: 'darwin-arm64',
        checksum: 'abc',
        signed: true,
      });
      expect(updated.status).toBe(DistributionStatus.BUILT);
      expect(updated.lastBuild?.builtAt).toEqual(expect.any(String));
    });

    it('marks a failed build as failed, keeping the reason', async () => {
      distributionRepository.findOne.mockResolvedValueOnce({ id: 'd-1', organizationId: ORG });
      const updated = await service.recordBuild(ORG, 'acme-support', DistributionTarget.DESKTOP, {
        error: 'notarisation rejected',
      });
      expect(updated.status).toBe(DistributionStatus.FAILED);
      expect(updated.lastBuild?.error).toBe('notarisation rejected');
    });
  });
});
