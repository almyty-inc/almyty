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
  let service: HostedChatService;
  let qb: any;

  beforeEach(() => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(async () => gateway()),
    };
    gatewayRepository = { createQueryBuilder: jest.fn(() => qb) };
    endUserRepository = {
      findOne: jest.fn(async () => null),
      create: jest.fn((row: any) => row),
      save: jest.fn(async (row: any) => ({ id: 'eu-1', ...row })),
    };
    conversationRepository = {
      find: jest.fn(async () => []),
      findOne: jest.fn(async () => null),
      create: jest.fn((row: any) => row),
      save: jest.fn(async (row: any) => ({ id: 'conv-1', ...row })),
    };
    service = new HostedChatService(gatewayRepository, endUserRepository, conversationRepository);
  });

  describe('findBySlug', () => {
    it('resolves a live surface and normalises the slug', async () => {
      await service.findBySlug('  ACME  ');
      expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), { slug: 'acme' });
    });

    it('404s for an unknown slug', async () => {
      qb.getOne.mockResolvedValueOnce(null);
      await expect(service.findBySlug('nope')).rejects.toThrow(NotFoundException);
    });

    it('404s rather than 403s for a real but inactive surface', async () => {
      // Whether acme.almyty.app exists is itself information; a public
      // endpoint should not confirm it while refusing to serve it.
      qb.getOne.mockResolvedValueOnce(gateway({ status: GatewayStatus.INACTIVE }));
      await expect(service.findBySlug('acme')).rejects.toThrow(NotFoundException);
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
});
