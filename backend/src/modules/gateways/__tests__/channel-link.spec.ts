import { NotFoundException } from '@nestjs/common';

import { HostedChatService } from '../channels/hosted-chat.service';
import { ChannelLinkService, ownerOf } from '../channel-link.service';
import { widgetConfigFor } from '../channels/widget-script';
import { ChannelLinkController } from '../channel-link.controller';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { Agent } from '../../../entities/agent.entity';
import { AgentChannel, ChannelStatus, ChannelType, VisitorAuthMode } from '../../../entities/agent-channel.entity';
import { fakeRepository, type FakeRepository } from '../../../test/fake-repository';
import { ClauseModel, ExecutedQuery, RecordingQueryBuilder, matchingRows } from './recording-query-builder';

/**
 * Which agent channel owns a gateway, and the hosted chat reading its
 * branding from the agent (with the channel's overrides) and nowhere else.
 *
 * The channels table is a truthful fake: `findOne` evaluates the
 * organization and gateway predicates, so dropping either fails here.
 * Relations are not modelled, so each row is seeded with its agent.
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

const supportAgent = (overrides: Partial<Agent> = {}): Agent =>
  Object.assign(new Agent(), {
    id: 'agent-1',
    organizationId: 'org-1',
    name: 'Support agent',
    branding: { appName: 'Acme', primaryColor: '#0f766e', greeting: 'Hi from the agent', suggestedPrompts: ['Track my order'] },
    visitorRules: { authMode: VisitorAuthMode.EMAIL_OTP, privacy: { visitorCanExport: false } },
    ...overrides,
  });

const webChannel = (overrides: Partial<AgentChannel> = {}) => ({
  id: 'channel-1',
  organizationId: 'org-1',
  agentId: 'agent-1',
  type: ChannelType.WEB,
  status: ChannelStatus.LIVE,
  slug: 'acme',
  gatewayId: 'gw-1',
  configuration: {},
  branding: null,
  visitorRules: null,
  agent: supportAgent(),
  ...overrides,
});

describe('ChannelLinkService', () => {
  let channels: FakeRepository<any>;
  let link: ChannelLinkService;

  beforeEach(() => {
    channels = fakeRepository<any>([webChannel()]);
    link = new ChannelLinkService(channels as any);
  });

  it('names the agent and the channel a gateway answers for', async () => {
    await expect(link.managedBy('org-1', 'gw-1')).resolves.toEqual({
      agent: { id: 'agent-1', name: 'Support agent' },
      channel: { id: 'channel-1', type: ChannelType.WEB },
    });
  });

  it('is null for a gateway no channel owns', async () => {
    await expect(link.managedBy('org-1', 'gw-other')).resolves.toBeNull();
  });

  it('never answers across organizations', async () => {
    // Same gateway id asked for from another organization.
    await expect(link.managedBy('org-2', 'gw-1')).resolves.toBeNull();
    // A row whose agent belongs elsewhere is not an owner either.
    channels.seed(webChannel({ id: 'channel-2', gatewayId: 'gw-2', agent: supportAgent({ organizationId: 'org-2' }) }));
    await expect(link.managedBy('org-1', 'gw-2')).resolves.toBeNull();
  });
});

describe('the hosted chat reads branding from the agent and its channel only', () => {
  let channels: FakeRepository<any>;
  let surfaces: Gateway[];
  let service: HostedChatService;

  const hostedChat = () =>
    new HostedChatService(
      { createQueryBuilder: () => new RecordingQueryBuilder('gateway', { getMany: (q: ExecutedQuery) => matchingRows(q, surfaces, SURFACE_CLAUSES) }) } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      new ChannelLinkService(channels as any),
    );

  beforeEach(() => {
    channels = fakeRepository<any>([webChannel()]);
    surfaces = [surface()];
    service = hostedChat();
  });

  it('shows the agent branding, not the copy left on the gateway', async () => {
    const branding = await service.publicBranding(await service.findBySlug('acme'));
    expect(branding).toMatchObject({
      appName: 'Acme',
      primaryColor: '#0f766e',
      greeting: 'Hi from the agent',
      suggestedPrompts: ['Track my order'],
      visitorCanExport: false,
    });
    expect(JSON.stringify(branding)).not.toContain('Gateway copy');
    expect(JSON.stringify(branding)).not.toContain('xoxb-secret');
  });

  it("lets the channel override the agent's branding field by field", async () => {
    channels.seed(webChannel({ branding: { greeting: 'Hi from this chat' } }));
    const branding = await service.publicBranding(await service.findBySlug('acme'));
    expect(branding.greeting).toBe('Hi from this chat');
    expect(branding.appName).toBe('Acme');
    expect(branding.primaryColor).toBe('#0f766e');
  });

  it('applies an agent change on the next request, without republishing', async () => {
    const row = channels.rows()[0];
    channels.seed({ ...row, agent: supportAgent({ branding: { appName: 'Renamed', primaryColor: '#123456' } }) });
    const branding = await service.publicBranding(await service.findBySlug('acme'));
    expect(branding.appName).toBe('Renamed');
    expect(branding.primaryColor).toBe('#123456');
  });

  it("uses the agent's own name when its branding names nothing", async () => {
    channels.seed(webChannel({ agent: supportAgent({ branding: null }) }));
    expect((await service.publicBranding(await service.findBySlug('acme'))).appName).toBe('Support agent');
  });

  it('enforces the sign-in rule of the agent (or channel), not the one mirrored on the gateway', async () => {
    const gateway = await service.findBySlug('acme');
    expect(service.authMode(gateway)).toBe('email_otp');
    expect(service.requiresAuth(gateway)).toBe(true);
    channels.seed(webChannel({ visitorRules: { authMode: VisitorAuthMode.PUBLIC_LINK } }));
    expect(service.authMode(await service.findBySlug('acme'))).toBe('public_link');
  });

  it('keeps the gateway address', async () => {
    const gateway = await service.findBySlug('acme');
    expect(gateway.configuration.hostedChat.slug).toBe('acme');
    expect(gateway.isActive()).toBe(true);
  });

  it('gives a surface no channel owns the default look, and keeps its sign-in rule', async () => {
    channels = fakeRepository<any>([]);
    service = hostedChat();
    const gateway = await service.findBySlug('acme');
    const branding = await service.publicBranding(gateway);
    expect(branding.appName).toBe('Assistant');
    expect(branding.primaryColor).toBe('#8b5cf6');
    expect(branding.greeting).toBe('');
    expect(service.authMode(gateway)).toBe('public_link');
  });

  it('does not take branding from an agent in another organization', async () => {
    channels = fakeRepository<any>([webChannel({ organizationId: 'org-2', agent: supportAgent({ organizationId: 'org-2' }) })]);
    service = hostedChat();
    expect((await service.publicBranding(await service.findBySlug('acme'))).appName).toBe('Assistant');
  });

  it('answers the same on a custom domain', async () => {
    surfaces = [surface({ customDomain: { hostname: 'chat.acme.com', status: 'active' } as any })];
    const gateway = await service.findByCustomDomain('chat.acme.com');
    expect((await service.publicBranding(gateway!)).appName).toBe('Acme');
  });
});

describe('ChannelLinkController', () => {
  const req = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };

  it('answers with the owning channel after checking the caller can see the gateway', async () => {
    const gateways = { getGateway: jest.fn(async () => surface()) };
    const controller = new ChannelLinkController(gateways as any, new ChannelLinkService(fakeRepository<any>([webChannel()]) as any));
    await expect(controller.managedBy('gw-1', req)).resolves.toEqual({
      success: true,
      data: { agent: { id: 'agent-1', name: 'Support agent' }, channel: { id: 'channel-1', type: 'web' } },
    });
    expect(gateways.getGateway).toHaveBeenCalledWith('gw-1', 'org-1', false, { id: 'user-1' });
  });

  it('404s for a gateway the caller cannot see, without saying which agent owns it', async () => {
    const gateways = { getGateway: jest.fn(async () => { throw new NotFoundException('Gateway not found'); }) };
    const controller = new ChannelLinkController(gateways as any, new ChannelLinkService(fakeRepository<any>([webChannel()]) as any));
    await expect(controller.managedBy('gw-1', req)).rejects.toThrow(NotFoundException);
  });
});

/**
 * The per-channel AI disclosure switch, as the web chat and the widget
 * read it live. On by default; off (which only a white-label org can
 * store) is an empty disclosure line for the hosted chat and no line at
 * all in the widget. A channel with no people on it has no switch.
 */
describe('the AI disclosure switch of a web chat or widget', () => {
  const branding = { ...supportAgent().branding, aiDisclosure: 'An AI answers here.' };

  it('shows the branding line while the switch is on, as it is by default', () => {
    const owner = ownerOf(webChannel({ agent: supportAgent({ branding }) }) as any);
    expect(owner.disclosureOff).toBe(false);
    expect(owner.branding.aiDisclosure).toBe('An AI answers here.');
    expect(widgetConfigFor({}, owner).aiDisclosure).toBe('An AI answers here.');
  });

  it('removes the line when the switch is off', () => {
    const owner = ownerOf(webChannel({ agent: supportAgent({ branding }), configuration: { aiDisclosure: false } }) as any);
    expect(owner.disclosureOff).toBe(true);
    expect(owner.branding.aiDisclosure).toBe('');
    const widget = ownerOf(webChannel({ type: ChannelType.WIDGET, configuration: { aiDisclosure: false } }) as any);
    expect(widgetConfigFor({}, widget).aiDisclosure).toBeNull();
    expect(widgetConfigFor({}, ownerOf(webChannel({ type: ChannelType.WIDGET }) as any)).aiDisclosure).toBeTruthy();
  });

  it('has no switch on a channel no person talks to', () => {
    expect(ownerOf(webChannel({ type: ChannelType.A2A, configuration: { aiDisclosure: false } }) as any).disclosureOff).toBe(false);
  });
});
