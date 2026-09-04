import { NotFoundException } from '@nestjs/common';

import { HostedChatService } from '../hosted-chat.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import type { EndUser } from '../../../../entities/end-user.entity';

const gateway = (overrides: Partial<Gateway> = {}): Gateway => {
  const gw = new Gateway();
  gw.id = 'gw-1';
  gw.type = GatewayType.CHAT_WIDGET;
  gw.status = GatewayStatus.ACTIVE;
  gw.organizationId = 'org-1';
  gw.agentId = 'agent-1';
  gw.configuration = {
    // Credentials live in the same jsonb blob as the branding, which is
    // exactly why publicBranding is a whitelist.
    bot_token: 'xoxb-super-secret',
    resend_api_key: 're_secret',
    hostedChat: { slug: 'acme', appName: 'Acme Assistant', primaryColor: '#22d3ee' },
  };
  return Object.assign(gw, overrides);
};

describe('HostedChatService', () => {
  let gatewayRepository: any;
  let endUserRepository: any;
  let conversationRepository: any;
  let messageRepository: any;
  let runRepository: any;
  let auditLogService: any;
  let service: HostedChatService;
  let qb: any;

  beforeEach(() => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => gateway()),
      getMany: jest.fn(async () => [gateway()]),
    };
    gatewayRepository = { createQueryBuilder: jest.fn(() => qb) };
    endUserRepository = {
      findOne: jest.fn(async () => null),
      create: jest.fn((row: any) => row),
      save: jest.fn(async (row: any) => ({ id: 'eu-1', ...row })),
      delete: jest.fn(async () => undefined),

    };
    conversationRepository = {
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
      create: jest.fn((row: any) => row),
      save: jest.fn(async (row: any) => ({ id: 'conv-1', ...row })),
    };
    messageRepository = { find: jest.fn(async () => []) };
    runRepository = { findOne: jest.fn(async () => null) };
    auditLogService = { log: jest.fn(async () => null) };
    service = new HostedChatService(
      gatewayRepository,
      endUserRepository,
      conversationRepository,
      messageRepository,
      runRepository,
      auditLogService as any,
    );
  });

  describe('findBySlug', () => {
    it('resolves a live surface and normalises the slug', async () => {
      await service.findBySlug('  ACME  ');
      expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), { slug: 'acme' });
    });

    it('404s for an unknown slug', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      await expect(service.findBySlug('nope')).rejects.toThrow(NotFoundException);
    });

    it('404s rather than 403s for a real but inactive surface', async () => {
      // Whether acme.almyty.app exists is itself information; a public
      // endpoint should not confirm it while refusing to serve it.
      qb.getMany.mockResolvedValueOnce([gateway({ status: GatewayStatus.INACTIVE })]);
      await expect(service.findBySlug('acme')).rejects.toThrow(NotFoundException);
    });

    it('fails closed when two organizations claim the same live slug', async () => {
      qb.getMany.mockResolvedValueOnce([
        gateway({ id: 'gw-org-1', organizationId: 'org-1' }),
        gateway({ id: 'gw-org-2', organizationId: 'org-2' }),
      ]);

      await expect(service.findBySlug('acme')).rejects.toThrow(NotFoundException);
    });

    it('ignores an inactive historic claimant when one live surface remains', async () => {
      const live = gateway({ id: 'gw-live', organizationId: 'org-1' });
      qb.getMany.mockResolvedValueOnce([
        gateway({ id: 'gw-old', organizationId: 'org-2', status: GatewayStatus.INACTIVE }),
        live,
      ]);

      await expect(service.findBySlug('acme')).resolves.toBe(live);
    });

    it('404s on an empty slug without touching the database', async () => {
      await expect(service.findBySlug('')).rejects.toThrow(NotFoundException);
      expect(gatewayRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('publicBranding', () => {
    it('returns presentation fields only', () => {
      const branding = service.publicBranding(gateway());
      expect(branding.appName).toBe('Acme Assistant');
      expect(branding.primaryColor).toBe('#22d3ee');
    });

    it('never leaks a credential from the same configuration blob', () => {
      const serialised = JSON.stringify(service.publicBranding(gateway()));
      expect(serialised).not.toContain('xoxb-super-secret');
      expect(serialised).not.toContain('re_secret');
      expect(serialised).not.toContain('bot_token');
    });

    it('falls back to defaults for a surface with no hosted chat block', () => {
      const bare = gateway();
      bare.configuration = { bot_token: 'xoxb' };
      expect(service.publicBranding(bare).appName).toBe('Assistant');
    });
  });

  describe('visitor authentication', () => {
    const ssoGateway = () => {
      const gw = gateway();
      gw.configuration = { hostedChat: { slug: 'acme', appName: 'Acme', authMode: 'sso' } };
      return gw;
    };

    it('does not require auth on a public-link surface', () => {
      expect(service.requiresAuth(gateway())).toBe(false);
      expect(service.isAuthorized(gateway(), { authProvider: null } as any)).toBe(true);
    });

    it('requires the provider the surface currently uses, not just any sign-in', () => {
      const gw = ssoGateway();
      expect(service.requiresAuth(gw)).toBe(true);
      expect(service.isAuthorized(gw, { authProvider: null } as any)).toBe(false);
      expect(service.isAuthorized(gw, { authProvider: 'email_otp' } as any)).toBe(false);
      expect(service.isAuthorized(gw, { authProvider: 'sso' } as any)).toBe(true);
    });

    it('treats SSO as unavailable when no entitlement resolver is wired', async () => {
      await expect(service.authModeAvailable(ssoGateway())).resolves.toBe(false);
      await expect(service.authModeAvailable(gateway())).resolves.toBe(true);
    });

    it('upgrades the current anonymous visitor in place and rotates the session key', async () => {
      const current: any = { id: 'eu-1', gatewayId: 'gw-1', sessionKey: 'old', authProvider: null, externalId: null };
      endUserRepository.findOne.mockResolvedValue(null);

      const { endUser, issuedSessionKey } = await service.bindAuthenticatedVisitor(ssoGateway(), current, {
        provider: 'sso',
        externalId: 'okta|123',
        email: 'ava@northwind.example',
        displayName: 'Ava Chen',
      });

      expect(endUser).toMatchObject({ id: 'eu-1', authProvider: 'sso', externalId: 'okta|123', email: 'ava@northwind.example', displayName: 'Ava Chen' });
      expect(issuedSessionKey).not.toBe('old');
      expect(issuedSessionKey).toHaveLength(64);
      expect(endUserRepository.delete).not.toHaveBeenCalled();
    });

    it('reuses the row of a person who signed in before, and drops the anonymous one', async () => {
      const current: any = { id: 'eu-anon', gatewayId: 'gw-1', sessionKey: 'old', authProvider: null };
      const previous: any = { id: 'eu-ava', gatewayId: 'gw-1', sessionKey: 'older', authProvider: 'sso', externalId: 'okta|123' };
      endUserRepository.findOne.mockResolvedValue(previous);

      const { endUser } = await service.bindAuthenticatedVisitor(ssoGateway(), current, { provider: 'sso', externalId: 'okta|123' });

      expect(endUserRepository.findOne).toHaveBeenCalledWith({ where: { gatewayId: 'gw-1', externalId: 'okta|123', authProvider: 'sso' } });
      expect(endUser.id).toBe('eu-ava');
      expect(endUser.sessionKey).not.toBe('older');
      expect(endUserRepository.delete).toHaveBeenCalledWith({ id: 'eu-anon' });
    });
  });

  describe('resolveEndUser', () => {
    it('creates an anonymous visitor and issues a session key', async () => {
      const { endUser, issuedSessionKey } = await service.resolveEndUser(gateway(), undefined);
      expect(issuedSessionKey).toMatch(/^[0-9a-f]{64}$/);
      expect(endUser.authProvider).toBeNull();
      expect(endUser.externalId).toBeNull();
      expect(endUser.gatewayId).toBe('gw-1');
    });

    it('reuses the visitor behind a known cookie without reissuing', async () => {
      const existing = { id: 'eu-9', gatewayId: 'gw-1', sessionKey: 'known' } as EndUser;
      endUserRepository.findOne.mockResolvedValueOnce(existing);
      const { endUser, issuedSessionKey } = await service.resolveEndUser(gateway(), 'known');
      expect(endUser.id).toBe('eu-9');
      expect(issuedSessionKey).toBeNull();
    });

    it('treats an unrecognised cookie as a new visitor rather than an error', async () => {
      const { issuedSessionKey } = await service.resolveEndUser(gateway(), 'forged-or-stale');
      expect(issuedSessionKey).toMatch(/^[0-9a-f]{64}$/);
    });

    it('scopes the lookup to the surface, so one browser is two people across tenants', async () => {
      await service.resolveEndUser(gateway(), 'shared-cookie');
      expect(endUserRepository.findOne).toHaveBeenCalledWith({
        where: { gatewayId: 'gw-1', sessionKey: 'shared-cookie' },
      });
    });

    it('stores the client fingerprint hashed, never the raw IP', async () => {
      const { endUser } = await service.resolveEndUser(gateway(), undefined, '203.0.113.7');
      expect(endUser.clientHash).toMatch(/^[0-9a-f]{32}$/);
      expect(JSON.stringify(endUser)).not.toContain('203.0.113.7');
    });

    it('mints a different session key every time', async () => {
      const a = await service.resolveEndUser(gateway(), undefined);
      const b = await service.resolveEndUser(gateway(), undefined);
      expect(a.issuedSessionKey).not.toBe(b.issuedSessionKey);
    });
  });

  describe('conversations', () => {
    it('scopes a lookup to the owning visitor in the query itself', async () => {
      conversationRepository.findOne.mockResolvedValueOnce({ id: 'conv-1' });
      await service.findConversation({ id: 'eu-1' } as EndUser, 'conv-1');
      expect(conversationRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'conv-1', endUserId: 'eu-1' },
      });
    });

    it('404s on another visitor conversation rather than leaking it', async () => {
      await expect(
        service.findConversation({ id: 'eu-1' } as EndUser, 'someone-elses'),
      ).rejects.toThrow(NotFoundException);
    });

    it('starts a conversation bound to visitor, agent and surface', async () => {
      const conversation = await service.startConversation(gateway(), { id: 'eu-1' } as EndUser);
      expect(conversation).toMatchObject({
        endUserId: 'eu-1',
        agentId: 'agent-1',
        gatewayId: 'gw-1',
        organizationId: 'org-1',
        title: 'New chat',
      });
    });

    it('caps a supplied title', async () => {
      const conversation = await service.startConversation(
        gateway(),
        { id: 'eu-1' } as EndUser,
        'x'.repeat(300),
      );
      expect(conversation.title).toHaveLength(120);
    });
  });

  describe('runBelongsToEndUser', () => {
    it('accepts a run whose conversation belongs to this visitor', async () => {
      runRepository.findOne.mockResolvedValueOnce({ id: 'run-1', conversationId: 'conv-1' });
      conversationRepository.findOne.mockResolvedValueOnce({ id: 'conv-1' });
      await expect(
        service.runBelongsToEndUser('run-1', { id: 'eu-1' } as EndUser),
      ).resolves.toBe(true);
      expect(conversationRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'conv-1', endUserId: 'eu-1' },
      });
    });

    it('rejects another visitor run rather than streaming it', async () => {
      runRepository.findOne.mockResolvedValueOnce({ id: 'run-1', conversationId: 'conv-9' });
      conversationRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.runBelongsToEndUser('run-1', { id: 'eu-1' } as EndUser),
      ).resolves.toBe(false);
    });

    it('rejects an unknown run id', async () => {
      await expect(
        service.runBelongsToEndUser('made-up', { id: 'eu-1' } as EndUser),
      ).resolves.toBe(false);
    });

    it('rejects a run with no conversation, which cannot be owned', async () => {
      runRepository.findOne.mockResolvedValueOnce({ id: 'run-1', conversationId: null });
      await expect(
        service.runBelongsToEndUser('run-1', { id: 'eu-1' } as EndUser),
      ).resolves.toBe(false);
    });
  });

  describe('listMessages', () => {
    it('returns only the turns a person should see', async () => {
      messageRepository.find.mockResolvedValueOnce([
        { id: 'm1', role: 'user', content: 'hi', createdAt: new Date() },
        { id: 'm2', role: 'assistant', content: 'hello', createdAt: new Date() },
        // Tool and system turns are scaffolding, not transcript.
        { id: 'm3', role: 'tool', content: '{"rows":[]}', createdAt: new Date() },
        { id: 'm4', role: 'system', content: 'You are...', createdAt: new Date() },
        // Verifier drafts and synthetic feedback are runtime scaffolding too.
        { id: 'm5', role: 'assistant', content: 'rejected draft', metadata: { internal: true }, createdAt: new Date() },
        { id: 'm6', role: 'user', content: 'verification feedback', metadata: { internal: true }, createdAt: new Date() },
      ]);
      const messages = await service.listMessages({ id: 'conv-1' } as any);
      expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    });

    it('prefers the entity text accessor when parts are present', async () => {
      messageRepository.find.mockResolvedValueOnce([
        {
          id: 'm1',
          role: 'assistant',
          content: '',
          getTextContent: () => 'from parts',
          createdAt: new Date(),
        },
      ]);
      const [message] = await service.listMessages({ id: 'conv-1' } as any);
      expect(message.content).toBe('from parts');
    });
  });

  describe('findByCustomDomain', () => {
    it('resolves an active, verified custom domain', async () => {
      const gw = gateway();
      qb.getOne.mockResolvedValueOnce(gw);
      await expect(service.findByCustomDomain('chat.acme.com')).resolves.toBe(gw);
      expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), {
        hostname: 'chat.acme.com',
      });
    });

    it('only matches domains whose status is active', async () => {
      // A row exists for an unverified domain so the tenant can see the
      // record to publish, but serving under it would mean hosting a
      // hostname nobody proved they own.
      await service.findByCustomDomain('chat.acme.com');
      expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), { status: 'active' });
    });

    it('returns null rather than throwing for an unknown domain', async () => {
      qb.getOne.mockResolvedValueOnce(null);
      await expect(service.findByCustomDomain('nope.example')).resolves.toBeNull();
    });

    it('returns null for an empty hostname without touching the database', async () => {
      await expect(service.findByCustomDomain('')).resolves.toBeNull();
      expect(gatewayRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('recordDisclosureRemoval', () => {
    it('records who removed the Art. 50 disclosure and when', async () => {
      // Publishing already gated this on the entitlement; the audit row
      // is what a deployer shows a regulator later.
      await service.recordDisclosureRemoval(gateway(), 'user-1');
      expect(auditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          userId: 'user-1',
          details: expect.objectContaining({
            change: 'ai_disclosure_removed',
            article: 'EU AI Act Art. 50',
          }),
        }),
      );
    });

    it('never lets a failed audit write break the save', async () => {
      auditLogService.log.mockRejectedValueOnce(new Error('audit sink down'));
      await expect(service.recordDisclosureRemoval(gateway(), 'user-1')).resolves.toBeUndefined();
    });

    it('works without an audit service wired at all', async () => {
      const bare = new HostedChatService(
        gatewayRepository,
        endUserRepository,
        conversationRepository,
        messageRepository,
        runRepository,
      );
      await expect(bare.recordDisclosureRemoval(gateway(), null)).resolves.toBeUndefined();
    });
  });
});
