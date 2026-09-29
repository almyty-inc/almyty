import { NotFoundException } from '@nestjs/common';

import { HostedChatService } from '../channels/hosted-chat.service';
import { GatewayAppLinkService } from '../gateway-app-link.service';
import { GatewayAppLinkController } from '../gateway-app-link.controller';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { AgentApp, AppAuthMode } from '../../../entities/agent-app.entity';
import { AppDistribution, DistributionStatus, DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import { fakeRepository, type FakeRepository } from '../../../test/fake-repository';
import { ClauseModel, ExecutedQuery, RecordingQueryBuilder, matchingRows } from './recording-query-builder';

/**
 * Which app owns a gateway, and the hosted chat reading its branding
 * from that app and nowhere else.
 *
 * The distributions table is a truthful fake: `findOne` evaluates the
 * organization and gateway predicates, so dropping either fails here.
 * Relations are not modelled, so each row is seeded with its app.
 */
const SURFACE_CLAUSES: ClauseModel = {
  'gateway.type = :type': (row, p) => row.type === p.type,
  "gateway.configuration -> 'hostedChat' ->> 'slug' = :slug": (row, p) => row.configuration?.hostedChat?.slug === p.slug,
  "gateway.customDomain ->> 'hostname' = :hostname": (row, p) => row.customDomain?.hostname === p.hostname,
  "gateway.customDomain ->> 'status' = :status": (row, p) => row.customDomain?.status === p.status,
};

const surface = (overrides: Partial<Gateway> = {}): Gateway =>
  Object.assign(new Gateway(), {
    id: 'gw-1',
    type: GatewayType.HOSTED_CHAT,
    status: GatewayStatus.ACTIVE,
    organizationId: 'org-1',
    agentId: 'agent-1',
    configuration: {
      bot_token: 'xoxb-secret',
      // A leftover copy on the gateway. The page must never show it.
      hostedChat: { slug: 'acme', authMode: 'public_link', appName: 'Gateway copy', primaryColor: '#000000', greeting: 'old' },
    },
    ...overrides,
  });

const acmeApp = (overrides: Partial<AgentApp> = {}): AgentApp =>
  Object.assign(new AgentApp(), {
    id: 'app-1',
    organizationId: 'org-1',
    name: 'Acme support',
    slug: 'acme-support',
    agentIds: ['agent-1'],
    branding: { appName: 'Acme', primaryColor: '#0f766e', greeting: 'Hi from the app', suggestedPrompts: ['Track my order'] },
    authMode: AppAuthMode.EMAIL_OTP,
    privacy: { visitorCanExport: false },
    ...overrides,
  });

const place = (overrides: Partial<AppDistribution> = {}) => ({
  id: 'dist-1',
  organizationId: 'org-1',
  appId: 'app-1',
  target: DistributionTarget.WEB,
  status: DistributionStatus.LIVE,
  gatewayId: 'gw-1',
  configuration: {},
  app: acmeApp(),
  ...overrides,
});

describe('GatewayAppLinkService', () => {
  let distributions: FakeRepository<any>;
  let link: GatewayAppLinkService;

  beforeEach(() => {
    distributions = fakeRepository<any>([place()]);
    link = new GatewayAppLinkService(distributions as any);
  });

  it('names the app and the place a gateway was published as', async () => {
    await expect(link.managedBy('org-1', 'gw-1')).resolves.toEqual({
      app: { id: 'app-1', slug: 'acme-support', name: 'Acme' },
      target: DistributionTarget.WEB,
    });
  });

  it('is null for a gateway no app owns', async () => {
    await expect(link.managedBy('org-1', 'gw-other')).resolves.toBeNull();
  });

  it('never answers across organizations', async () => {
    // Same gateway id asked for from another organization.
    await expect(link.managedBy('org-2', 'gw-1')).resolves.toBeNull();
    // A row whose app belongs elsewhere is not an owner either.
    distributions.seed(place({ id: 'dist-2', gatewayId: 'gw-2', app: acmeApp({ organizationId: 'org-2' }) }));
    await expect(link.managedBy('org-1', 'gw-2')).resolves.toBeNull();
  });

  it('falls back to the app name when no display name is set', async () => {
    distributions.seed(place({ id: 'dist-3', gatewayId: 'gw-3', target: DistributionTarget.SLACK, app: acmeApp({ branding: {} as any }) }));
    await expect(link.managedBy('org-1', 'gw-3')).resolves.toMatchObject({
      app: { name: 'Acme support' },
      target: DistributionTarget.SLACK,
    });
  });
});

describe('the hosted chat reads branding from the app only', () => {
  let distributions: FakeRepository<any>;
  let surfaces: Gateway[];
  let service: HostedChatService;

  beforeEach(() => {
    distributions = fakeRepository<any>([place()]);
    surfaces = [surface()];
    const gateways = {
      createQueryBuilder: jest.fn(
        (alias: string) =>
          new RecordingQueryBuilder(alias, {
            getMany: (query: ExecutedQuery) => matchingRows(query, surfaces, SURFACE_CLAUSES),
          }),
      ),
    };
    service = new HostedChatService(
      gateways as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      new GatewayAppLinkService(distributions as any),
    );
  });

  it('shows the app branding, not the copy left on the gateway', async () => {
    const branding = await service.publicBranding(await service.findBySlug('acme'));
    expect(branding).toMatchObject({
      appName: 'Acme',
      primaryColor: '#0f766e',
      greeting: 'Hi from the app',
      suggestedPrompts: ['Track my order'],
      visitorCanExport: false,
    });
    expect(JSON.stringify(branding)).not.toContain('Gateway copy');
    expect(JSON.stringify(branding)).not.toContain('xoxb-secret');
  });

  it('applies an app change on the next request, without republishing', async () => {
    const row = distributions.rows()[0];
    distributions.seed({ ...row, app: acmeApp({ branding: { appName: 'Renamed', primaryColor: '#123456' } }) });
    const branding = await service.publicBranding(await service.findBySlug('acme'));
    expect(branding.appName).toBe('Renamed');
    expect(branding.primaryColor).toBe('#123456');
  });

  it('enforces the app sign-in rule, not the one mirrored on the gateway', async () => {
    const gateway = await service.findBySlug('acme');
    expect(service.authMode(gateway)).toBe('email_otp');
    expect(service.requiresAuth(gateway)).toBe(true);
  });

  it('keeps the gateway address', async () => {
    const gateway = await service.findBySlug('acme');
    expect(gateway.configuration.hostedChat.slug).toBe('acme');
    expect(gateway.isActive()).toBe(true);
  });

  it('gives a surface no app owns the default look, and keeps its sign-in rule', async () => {
    distributions = fakeRepository<any>([]);
    service = new HostedChatService(
      { createQueryBuilder: () => new RecordingQueryBuilder('gateway', { getMany: (q: ExecutedQuery) => matchingRows(q, surfaces, SURFACE_CLAUSES) }) } as any,
      {} as any, {} as any, {} as any, {} as any, undefined, undefined,
      new GatewayAppLinkService(distributions as any),
    );
    const gateway = await service.findBySlug('acme');
    const branding = await service.publicBranding(gateway);
    expect(branding.appName).toBe('Assistant');
    expect(branding.primaryColor).toBe('#8b5cf6');
    expect(branding.greeting).toBe('');
    expect(service.authMode(gateway)).toBe('public_link');
  });

  it('does not take branding from an app in another organization', async () => {
    distributions = fakeRepository<any>([place({ organizationId: 'org-2', app: acmeApp({ organizationId: 'org-2' }) })]);
    service = new HostedChatService(
      { createQueryBuilder: () => new RecordingQueryBuilder('gateway', { getMany: (q: ExecutedQuery) => matchingRows(q, surfaces, SURFACE_CLAUSES) }) } as any,
      {} as any, {} as any, {} as any, {} as any, undefined, undefined,
      new GatewayAppLinkService(distributions as any),
    );
    expect((await service.publicBranding(await service.findBySlug('acme'))).appName).toBe('Assistant');
  });

  it('answers the same on a custom domain', async () => {
    surfaces = [surface({ customDomain: { hostname: 'chat.acme.com', status: 'active' } as any })];
    const gateway = await service.findByCustomDomain('chat.acme.com');
    expect((await service.publicBranding(gateway!)).appName).toBe('Acme');
  });
});

describe('GatewayAppLinkController', () => {
  const req = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };

  it('answers with the owning app after checking the caller can see the gateway', async () => {
    const gateways = { getGateway: jest.fn(async () => surface()) };
    const controller = new GatewayAppLinkController(gateways as any, new GatewayAppLinkService(fakeRepository<any>([place()]) as any));
    await expect(controller.managedBy('gw-1', req)).resolves.toEqual({
      success: true,
      data: { app: { id: 'app-1', slug: 'acme-support', name: 'Acme' }, target: 'web' },
    });
    expect(gateways.getGateway).toHaveBeenCalledWith('gw-1', 'org-1', false, { id: 'user-1' });
  });

  it('404s for a gateway the caller cannot see, without saying which app owns it', async () => {
    const gateways = { getGateway: jest.fn(async () => { throw new NotFoundException('Gateway not found'); }) };
    const controller = new GatewayAppLinkController(gateways as any, new GatewayAppLinkService(fakeRepository<any>([place()]) as any));
    await expect(controller.managedBy('gw-1', req)).rejects.toThrow(NotFoundException);
  });
});
