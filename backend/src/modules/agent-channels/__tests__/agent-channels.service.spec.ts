import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { AgentChannelsService } from '../agent-channels.service';
import { AgentChannel, ChannelStatus, ChannelType, VisitorAuthMode } from '../../../entities/agent-channel.entity';
import { Credential } from '../../../entities/credential.entity';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { fakeRepository, type FakeRepository } from '../../../test/fake-repository';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { decryptField, isEncrypted } from '../../../common/security/field-crypto';
import { MASKED_CHANNEL_SECRET } from '../../gateways/channels/channel-config.helper';
import { splitChannelSecrets } from '../channel-secrets';
import { publicChannel } from '../agent-channels.controller';

/**
 * Channels on an agent, end to end through the service: who may read and
 * change them, where their platform keys go, what publishing stands up,
 * and what the agent's public settings do to the channels that inherit
 * them.
 *
 * Every table is a truthful in-memory repository (the `where` is
 * evaluated), so "the row has no secret" is a statement about what was
 * written, not about a mock's return value.
 */
describe('AgentChannelsService', () => {
  const ORG = 'org-1';
  const ME = { id: 'user-1' };
  const SLACK = { bot_token: 'xoxb-live-1', signing_secret: 'sign-live-1' };

  let agents: FakeRepository<any>;
  let channels: FakeRepository<AgentChannel>;
  let gatewayRows: FakeRepository<any>;
  let credentials: FakeRepository<Credential>;
  let gateways: any;
  let accessPolicy: any;
  let hostedChatSlugsTaken: string[];

  const agent = (over: any = {}) => ({
    id: 'agent-1',
    organizationId: ORG,
    name: 'Support agent',
    description: 'Answers customers',
    visibility: 'org',
    teamId: null,
    mode: 'autonomous',
    createdBy: 'user-1',
    branding: null,
    visitorRules: null,
    ...over,
  });

  const build = (opts: { withStore?: boolean; licensed?: string[] } = {}) => {
    const gatewayRepository = Object.assign(gatewayRows, {
      createQueryBuilder: jest.fn(() => {
        let slug = '';
        const qb: any = {
          where: (_sql: string, params: any) => ((slug = params.slug), qb),
          getCount: async () => (hostedChatSlugsTaken.includes(slug) ? 1 : 0),
        };
        return qb;
      }),
    });
    return new AgentChannelsService(
      channels as any,
      agents as any,
      gatewayRepository as any,
      gateways,
      accessPolicy,
      { hasForOrg: async (_org: string, key: string) => (opts.licensed ?? []).includes(key) } as any,
      opts.withStore === false ? undefined : new CredentialRefResolver(credentials as any, makeEnvelopeCryptoMock()),
    );
  };

  beforeEach(() => {
    agents = fakeRepository<any>([agent(), agent({ id: 'agent-theirs', organizationId: 'org-2' })]);
    channels = fakeRepository<AgentChannel>({ make: () => new AgentChannel(), idPrefix: 'channel' });
    gatewayRows = fakeRepository<any>({ idPrefix: 'gw' });
    credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
    hostedChatSlugsTaken = [];
    gateways = {
      upsertForChannel: jest.fn(async (dto: any, _org: string, _user: string, options: any) => {
        const row = gatewayRows.seed({ id: options.gatewayId ?? undefined, organizationId: ORG, endpoint: dto.endpoint, status: 'inactive' });
        return row;
      }),
      activateGateway: jest.fn(async (id: string) => ({ id, status: 'active' })),
      deactivateGateway: jest.fn(async (id: string) => ({ id, status: 'inactive' })),
      deleteGateway: jest.fn(async () => undefined),
    };
    accessPolicy = { canAccess: jest.fn(async () => ({ allowed: true })) };
  });

  const stored = () => channels.rows()[0];
  const plaintextOf = (credentialId: string, key: string) => decryptField(credentials.row(credentialId)!.config[key], ORG);

  describe('who may see and change channels', () => {
    it('is a 404 for an agent of another organization', async () => {
      await expect(build().list(ORG, 'agent-theirs', ME)).rejects.toBeInstanceOf(NotFoundException);
      await expect(build().add(ORG, 'agent-theirs', ME, { type: ChannelType.WEB })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a 404 for an agent the caller may not read, and a 403 for one they may read but not manage', async () => {
      accessPolicy.canAccess = jest.fn(async () => ({ allowed: false }));
      await expect(build().list(ORG, 'agent-1', { id: 'someone-else' })).rejects.toBeInstanceOf(NotFoundException);

      accessPolicy.canAccess = jest.fn(async (_c: any, _r: any, action: string) => ({ allowed: action === 'read', reason: 'no' }));
      await expect(build().add(ORG, 'agent-1', { id: 'someone-else' }, { type: ChannelType.WEB })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(build().list(ORG, 'agent-1', { id: 'someone-else' })).resolves.toEqual([]);
    });

    it("never lists or opens another agent's channel", async () => {
      agents.seed(agent({ id: 'agent-2', name: 'Billing' }));
      channels.seed({ id: 'c-other', organizationId: ORG, agentId: 'agent-2', type: ChannelType.SLACK, status: ChannelStatus.DRAFT });
      await expect(build().list(ORG, 'agent-1', ME)).resolves.toEqual([]);
      await expect(build().get(ORG, 'agent-1', 'c-other', ME)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a channel on an agent private to its owner', async () => {
      agents.seed(agent({ id: 'agent-private', visibility: 'private' }));
      await expect(build().add(ORG, 'agent-private', ME, { type: ChannelType.WEB })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('adding a channel', () => {
    it('starts it as a draft on the agent', async () => {
      const view = await build().add(ORG, 'agent-1', ME, { type: ChannelType.SLACK });
      expect(view).toMatchObject({ agentId: 'agent-1', type: 'slack', status: 'draft', gatewayId: null, slug: null });
      expect(view.endpoint).toBe(`/channels/${view.id}`);
    });

    it('lets one agent have several channels of the same kind', async () => {
      const service = build();
      await service.add(ORG, 'agent-1', ME, { type: ChannelType.SLACK });
      await service.add(ORG, 'agent-1', ME, { type: ChannelType.SLACK });
      expect(await service.list(ORG, 'agent-1', ME)).toHaveLength(2);
    });

    it('gives a web chat a free address made from the agent name, across every organization', async () => {
      hostedChatSlugsTaken = ['support-agent'];
      channels.seed({ id: 'c-x', organizationId: 'org-2', agentId: 'x', type: ChannelType.WEB, slug: 'support-agent-2' });
      const view = await build().add(ORG, 'agent-1', ME, { type: ChannelType.WEB });
      expect(view.slug).toBe('support-agent-3');
    });

    it('takes an address the owner picked, or says it is taken or unusable', async () => {
      const service = build();
      await expect(service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'Acme Help' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' })).resolves.toMatchObject({ slug: 'acme-help' });
      await expect(service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' })).rejects.toBeInstanceOf(ConflictException);
    });

    it('starts a desktop app with a bundle id and pointed at the agent first web chat', async () => {
      const service = build();
      const web = await service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' });
      const desktop = await service.add(ORG, 'agent-1', ME, { type: ChannelType.DESKTOP });
      expect(desktop.configuration).toEqual({ bundleId: 'app.almyty.supportagent', webChatChannelId: web.id });
    });

    it('keeps typed keys off the row, in one credential the channel manages', async () => {
      const view = await build().add(ORG, 'agent-1', ME, { type: ChannelType.SLACK, configuration: SLACK });
      const row = stored();
      expect(row.configuration).toEqual({
        credentialId: expect.any(String),
        credentialKeys: expect.arrayContaining(['bot_token', 'signing_secret']),
      });
      expect(JSON.stringify(row)).not.toContain('xoxb-live-1');
      expect(JSON.stringify(view)).not.toContain('xoxb-live-1');
      const credential = credentials.row(row.configuration!.credentialId)!;
      expect(credential.metadata.managedBy).toEqual({ kind: 'agent_channel', id: row.id });
      expect(isEncrypted(credential.config.bot_token)).toBe(true);
      expect(plaintextOf(credential.id, 'bot_token')).toBe('xoxb-live-1');
    });

    it('takes the keys from a credential picked on Credentials, without copying them', async () => {
      credentials.seed({
        id: 'cred-shared',
        organizationId: ORG,
        name: 'Our Slack app',
        config: { bot_token: 'enc', signing_secret: 'enc' },
        visibility: 'org',
        isActive: true,
        metadata: {},
      } as any);
      const view = await build().add(ORG, 'agent-1', ME, { type: ChannelType.SLACK, credentialId: 'cred-shared' });
      expect(view.configuration).toEqual({ credentialId: 'cred-shared', credentialKeys: ['bot_token', 'signing_secret'] });
      expect(credentials.rows()).toHaveLength(1);
    });

    it('refuses a credential of another organization', async () => {
      credentials.seed({ id: 'cred-theirs', organizationId: 'org-2', config: {}, visibility: 'org', metadata: {} } as any);
      await expect(build().add(ORG, 'agent-1', ME, { type: ChannelType.SLACK, credentialId: 'cred-theirs' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a key rather than writing it to the row when the store is missing', async () => {
      await expect(build({ withStore: false }).add(ORG, 'agent-1', ME, { type: ChannelType.SLACK, configuration: SLACK })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('changing a channel', () => {
    it('rotates its own credential in place, clears a key sent empty, and ignores a masked value sent back', async () => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.SLACK, configuration: SLACK });
      const credentialId = stored().configuration!.credentialId;

      await service.update(ORG, 'agent-1', view.id, ME, { configuration: { bot_token: 'xoxb-live-2' } });
      expect(stored().configuration!.credentialId).toBe(credentialId);
      expect(plaintextOf(credentialId, 'bot_token')).toBe('xoxb-live-2');
      expect(plaintextOf(credentialId, 'signing_secret')).toBe('sign-live-1');

      await service.update(ORG, 'agent-1', view.id, ME, { configuration: { bot_token: MASKED_CHANNEL_SECRET, credentialId: 'someone-elses' } });
      expect(stored().configuration!.credentialId).toBe(credentialId);
      expect(plaintextOf(credentialId, 'bot_token')).toBe('xoxb-live-2');

      await service.update(ORG, 'agent-1', view.id, ME, { configuration: { signing_secret: '' } });
      expect(stored().configuration!.credentialKeys).toEqual(['bot_token']);
    });

    it('does not drop settings a partial update did not mention', async () => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.SMS, configuration: { phone_number: '+1555' } });
      await service.update(ORG, 'agent-1', view.id, ME, { configuration: { twilio_account_sid: 'AC1' } });
      expect(stored().configuration).toMatchObject({ phone_number: '+1555', twilio_account_sid: 'AC1' });
    });

    it('switching to a picked credential releases the one the channel made', async () => {
      credentials.seed({ id: 'cred-shared', organizationId: ORG, config: { bot_token: 'enc' }, visibility: 'org', metadata: {} } as any);
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.TELEGRAM, configuration: { bot_token: '123:abc' } });
      expect(credentials.rows()).toHaveLength(2);
      await service.update(ORG, 'agent-1', view.id, ME, { credentialId: 'cred-shared' });
      expect(credentials.rows().map((c) => c.id)).toEqual(['cred-shared']);
      expect(stored().configuration).toEqual({ credentialId: 'cred-shared', credentialKeys: ['bot_token'] });
    });

    it("stores the channel's own branding and visitor rules, and null inherits again", async () => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' });
      const changed = await service.update(ORG, 'agent-1', view.id, ME, {
        branding: { greeting: 'Hi from the web', junk: 1 } as any,
        visitorRules: { authMode: VisitorAuthMode.EMAIL_OTP },
      });
      expect(stored().branding).toEqual({ greeting: 'Hi from the web' });
      expect(changed.effective.visitorRules.authMode).toBe('email_otp');
      expect(changed.effective.branding.appName).toBe('Support agent');

      await service.update(ORG, 'agent-1', view.id, ME, { branding: null, visitorRules: null });
      expect(stored().branding).toBeNull();
      expect(stored().visitorRules).toBeNull();
    });

    it('refuses visitor rules it cannot keep', async () => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' });
      await expect(service.update(ORG, 'agent-1', view.id, ME, { visitorRules: { limits: { costCapCents: -5 } } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('publishing', () => {
    it('stands up the gateway quiet, records it, and only then lets it answer', async () => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.SLACK, configuration: SLACK });
      gateways.activateGateway.mockImplementation(async (id: string) => {
        // By the time it answers, the channel already points at it.
        expect(channels.row(view.id)!.gatewayId).toBe(id);
        expect(channels.row(view.id)!.status).toBe('live');
        return { id, status: 'active' };
      });

      const live = await service.publish(ORG, 'agent-1', view.id, ME);

      expect(live.status).toBe('live');
      const [dto, org, user, options] = gateways.upsertForChannel.mock.calls[0];
      expect(org).toBe(ORG);
      expect(user).toBe('user-1');
      expect(options).toEqual({ channelId: view.id, activate: false, gatewayId: null });
      expect(dto).toMatchObject({
        name: 'Support agent (slack)',
        type: 'slack',
        agentId: 'agent-1',
        endpoint: `/channels/${view.id}`,
        visibility: 'org',
        // The defaults a nobody-configured agent is capped with.
        rateLimitConfig: { enabled: true, perVisitorPerHour: 60, perIpPerHour: 120 },
      });
      expect(dto.configuration).toMatchObject({ channelId: view.id, authMode: 'public_link', credentialId: expect.any(String) });
      expect(JSON.stringify(dto)).not.toContain('xoxb-live-1');
    });

    it('re-syncs the gateway it already answers on rather than making a second', async () => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' });
      await service.publish(ORG, 'agent-1', view.id, ME);
      const gatewayId = stored().gatewayId;
      await service.publish(ORG, 'agent-1', view.id, ME);
      expect(gateways.upsertForChannel.mock.calls[1][3].gatewayId).toBe(gatewayId);
    });

    it('gives the web chat the address block the hosted chat finds it by', async () => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' });
      await service.publish(ORG, 'agent-1', view.id, ME);
      expect(gateways.upsertForChannel.mock.calls[0][0].configuration.hostedChat).toEqual({ slug: 'acme-help', authMode: 'public_link' });
    });

    it('publishes a team agent through a gateway scoped to its team', async () => {
      agents.seed(agent({ id: 'agent-team', visibility: 'team', teamId: 'team-1' }));
      const service = build();
      const view = await service.add(ORG, 'agent-team', ME, { type: ChannelType.A2A });
      await service.publish(ORG, 'agent-team', view.id, ME);
      expect(gateways.upsertForChannel.mock.calls[0][0]).toMatchObject({ visibility: 'team', teamId: 'team-1' });
    });

    it.each([
      ['a platform whose keys are missing', ChannelType.SLACK, {}, /still needs its keys/],
      ['a download, which has nothing to publish', ChannelType.TUI, {}, /file people download/],
    ])('refuses %s', async (_label, type, configuration, message) => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type, configuration });
      await expect(service.publish(ORG, 'agent-1', view.id, ME)).rejects.toThrow(message);
      expect(gateways.upsertForChannel).not.toHaveBeenCalled();
    });

    it('refuses a workflow agent, which answers a call rather than a person', async () => {
      agents.seed(agent({ id: 'agent-flow', mode: 'workflow' }));
      const service = build();
      const view = await service.add(ORG, 'agent-flow', ME, { type: ChannelType.WEB, slug: 'flow-chat' });
      await expect(service.publish(ORG, 'agent-flow', view.id, ME)).rejects.toThrow(/holds a conversation/);
    });

    it('refuses an open channel once the owner cleared its cost cap', async () => {
      agents.seed(agent({ id: 'agent-open', visitorRules: { limits: { costCapCents: null } } }));
      const service = build();
      const view = await service.add(ORG, 'agent-open', ME, { type: ChannelType.WEB, slug: 'open-chat' });
      await expect(service.publish(ORG, 'agent-open', view.id, ME)).rejects.toThrow(/spend limit per run/);
    });

    it('checks SSO against the organization licence', async () => {
      agents.seed(agent({ id: 'agent-sso', visitorRules: { authMode: VisitorAuthMode.SSO } }));
      const unlicensed = build();
      const view = await unlicensed.add(ORG, 'agent-sso', ME, { type: ChannelType.WEB, slug: 'sso-chat' });
      await expect(unlicensed.publish(ORG, 'agent-sso', view.id, ME)).rejects.toThrow(/commercial licence/);
      await expect(build({ licensed: ['sso'] }).publish(ORG, 'agent-sso', view.id, ME)).resolves.toMatchObject({ status: 'live' });
    });

    it('says a desktop app needs a web chat to open', async () => {
      const service = build();
      const desktop = await service.add(ORG, 'agent-1', ME, { type: ChannelType.DESKTOP });
      const check = await service.check(ORG, 'agent-1', desktop.id, ME);
      expect(check.refusals.map((r) => r.code)).toContain('DESKTOP_NEEDS_WEB_CHAT');
      await service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' });
      expect((await service.check(ORG, 'agent-1', desktop.id, ME)).ok).toBe(true);
    });

    it('unpublishing deactivates the gateway rather than deleting it', async () => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' });
      await service.publish(ORG, 'agent-1', view.id, ME);
      const off = await service.unpublish(ORG, 'agent-1', view.id, ME);
      expect(off.status).toBe('draft');
      expect(gateways.deactivateGateway).toHaveBeenCalledWith(stored().gatewayId, ORG, 'user-1');
      expect(gateways.deleteGateway).not.toHaveBeenCalled();
    });
  });

  describe('deleting a channel', () => {
    it('takes its gateway and its own keys with it', async () => {
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.SLACK, configuration: SLACK });
      await service.publish(ORG, 'agent-1', view.id, ME);
      const gatewayId = stored().gatewayId;

      await service.remove(ORG, 'agent-1', view.id, ME);

      expect(channels.rows()).toHaveLength(0);
      expect(credentials.rows()).toHaveLength(0);
      expect(gateways.deleteGateway).toHaveBeenCalledWith(gatewayId, ORG, 'user-1');
    });

    it('leaves a credential picked from Credentials alone', async () => {
      credentials.seed({ id: 'cred-shared', organizationId: ORG, config: { bot_token: 'enc' }, visibility: 'org', metadata: {} } as any);
      const service = build();
      const view = await service.add(ORG, 'agent-1', ME, { type: ChannelType.TELEGRAM, credentialId: 'cred-shared' });
      await service.remove(ORG, 'agent-1', view.id, ME);
      expect(credentials.row('cred-shared')).toBeDefined();
    });
  });

  describe("the agent's public settings", () => {
    it('reads what is stored and what it resolves to', async () => {
      const settings = await build().publicSettings(ORG, 'agent-1', ME);
      expect(settings.branding).toBeNull();
      expect(settings.effective.branding.appName).toBe('Support agent');
      expect(settings.effective.visitorRules.limits).toEqual({ costCapCents: 50, perUserRateLimit: 60, perIpRateLimit: 120 });
    });

    it('stores the known fields only, and refuses what it cannot keep', async () => {
      const service = build();
      await service.updatePublicSettings(ORG, 'agent-1', ME, {
        branding: { appName: 'Acme', rogue: true } as any,
        visitorRules: { authMode: VisitorAuthMode.EMAIL_OTP, limits: { perUserRateLimit: 10 } },
      });
      expect(agents.row('agent-1')).toMatchObject({
        branding: { appName: 'Acme' },
        visitorRules: { authMode: 'email_otp', limits: { perUserRateLimit: 10 } },
      });
      await expect(service.updatePublicSettings(ORG, 'agent-1', ME, { visitorRules: { authMode: 'anyone' as any } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('re-syncs every live channel so a new limit applies without republishing', async () => {
      const service = build();
      const web = await service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' });
      await service.add(ORG, 'agent-1', ME, { type: ChannelType.A2A });
      await service.publish(ORG, 'agent-1', web.id, ME);
      gateways.upsertForChannel.mockClear();

      await service.updatePublicSettings(ORG, 'agent-1', ME, { visitorRules: { limits: { perUserRateLimit: 5 } } });

      expect(gateways.upsertForChannel).toHaveBeenCalledTimes(1);
      expect(gateways.upsertForChannel.mock.calls[0][0].rateLimitConfig).toMatchObject({ perVisitorPerHour: 5 });
      expect(gateways.upsertForChannel.mock.calls[0][3]).toMatchObject({ channelId: web.id, activate: true });
    });

    it('leaves a live channel as it was when the new settings no longer pass its checks', async () => {
      const service = build();
      const web = await service.add(ORG, 'agent-1', ME, { type: ChannelType.WEB, slug: 'acme-help' });
      await service.publish(ORG, 'agent-1', web.id, ME);
      gateways.upsertForChannel.mockClear();
      await service.updatePublicSettings(ORG, 'agent-1', ME, { visitorRules: { limits: { costCapCents: null } } });
      expect(gateways.upsertForChannel).not.toHaveBeenCalled();
    });

    it('may only be changed by someone who can manage the agent', async () => {
      accessPolicy.canAccess = jest.fn(async (_c: any, _r: any, action: string) => ({ allowed: action === 'read', reason: 'no' }));
      await expect(build().updatePublicSettings(ORG, 'agent-1', { id: 'viewer' }, { branding: {} })).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('on the way out', () => {
    it('masks inline values and the keys the credential holds', () => {
      expect(publicChannel({ configuration: { bot_token: 'xoxb-legacy', credentialId: 'c', credentialKeys: ['signing_secret'] } })).toEqual({
        configuration: {
          bot_token: MASKED_CHANNEL_SECRET,
          signing_secret: MASKED_CHANNEL_SECRET,
          credentialId: 'c',
          credentialKeys: ['signing_secret'],
        },
      });
    });

    it('splits keys from public settings, legacy spellings included', () => {
      expect(splitChannelSecrets({ botToken: 'b', phone_number: '+1', twilio_auth_token: '', credentialKeys: ['x'] })).toEqual({
        secrets: { bot_token: 'b' },
        cleared: ['twilio_auth_token'],
        publicConfig: { phone_number: '+1' },
      });
    });
  });
});
