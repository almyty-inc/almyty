import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';

import { HostedChatController } from '../hosted-chat.controller';
import { HostedChatService } from '../hosted-chat.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../../entities/gateway.entity';
import type { EndUser } from '../../../../entities/end-user.entity';

/**
 * The HTTP layer of the public chat API.
 *
 * Every route here is unauthenticated and reachable by anyone on the
 * internet, so these tests are less about happy paths than about what
 * the routes refuse: an id the caller supplied, a run they do not own,
 * a host that is not theirs.
 */
describe('HostedChatController', () => {
  let hostedChat: any;
  let gatewayRateLimit: any;
  let agentRuntimeService: any;
  let controller: HostedChatController;
  let res: any;

  const gateway = (): Gateway => {
    const gw = new Gateway();
    gw.id = 'gw-1';
    gw.name = 'Acme chat';
    gw.type = GatewayType.HOSTED_CHAT;
    gw.status = GatewayStatus.ACTIVE;
    gw.organizationId = 'org-1';
    gw.agentId = 'agent-1';
    gw.configuration = {
      bot_token: 'xoxb-secret',
      hostedChat: { slug: 'acme', appName: 'Acme Assistant' },
    };
    return gw;
  };

  const endUser = { id: 'eu-1' } as EndUser;

  const req = (overrides: any = {}) =>
    ({
      headers: {},
      cookies: {},
      ip: '203.0.113.9',
      on: jest.fn(),
      ...overrides,
    }) as any;

  beforeEach(() => {
    res = {
      cookie: jest.fn(),
      setHeader: jest.fn(),
      json: jest.fn(),
      write: jest.fn(),
      end: jest.fn(),
      flushHeaders: jest.fn(),
    };
    hostedChat = {
      findBySlug: jest.fn(async () => gateway()),
      findByCustomDomain: jest.fn(async () => null),
      publicBranding: jest.fn(() => ({ appName: 'Acme Assistant' })),
      resolveEndUser: jest.fn(async () => ({ endUser, issuedSessionKey: null })),
      listConversations: jest.fn(async () => []),
      findConversation: jest.fn(async () => ({ id: 'conv-1', title: 'New chat' })),
      startConversation: jest.fn(async () => ({ id: 'conv-1', title: 'hello' })),
      listMessages: jest.fn(async () => []),
      runBelongsToEndUser: jest.fn(async () => true),
    };
    gatewayRateLimit = { check: jest.fn(async () => ({ limited: false })) };
    agentRuntimeService = {
      startRun: jest.fn(async () => ({ id: 'run-1' })),
      getRunEmitter: jest.fn(() => null),
    };
    controller = new HostedChatController(hostedChat, gatewayRateLimit, agentRuntimeService);
  });

  describe('session cookie', () => {
    it('sets an httpOnly cookie with no Domain, so it is scoped per tenant host', async () => {
      hostedChat.resolveEndUser.mockResolvedValueOnce({ endUser, issuedSessionKey: 'fresh' });
      await controller.listConversations('acme', req(), res);

      const [name, value, options] = res.cookie.mock.calls[0];
      expect(name).toBe(HostedChatService.SESSION_COOKIE);
      expect(value).toBe('fresh');
      expect(options.httpOnly).toBe(true);
      // An explicit Domain would let one tenant's app read another's session.
      expect(options.domain).toBeUndefined();
    });

    it('does not reissue a cookie for a visitor who already has one', async () => {
      await controller.listConversations('acme', req({ cookies: { almyty_chat_session: 'known' } }), res);
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it('passes the caller cookie through to resolution', async () => {
      await controller.listConversations('acme', req({ cookies: { almyty_chat_session: 'abc' } }), res);
      expect(hostedChat.resolveEndUser).toHaveBeenCalledWith(expect.anything(), 'abc', '203.0.113.9');
    });

    it('prefers the forwarded client IP over the socket peer', async () => {
      // Behind the ingress, req.ip is the proxy, so per-IP limits would
      // otherwise bucket every visitor together.
      await controller.listConversations(
        'acme',
        req({ headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' } }),
        res,
      );
      expect(hostedChat.resolveEndUser).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        '198.51.100.4',
      );
    });
  });

  describe('branding', () => {
    it('returns presentation fields only', async () => {
      const result = await controller.branding('acme', res);
      expect(result.data).toEqual({ appName: 'Acme Assistant' });
      expect(JSON.stringify(result)).not.toContain('xoxb-secret');
    });

    it('propagates a 404 for an unknown slug', async () => {
      hostedChat.findBySlug.mockRejectedValueOnce(new NotFoundException('Chat app not found'));
      await expect(controller.branding('nope', res)).rejects.toThrow(NotFoundException);
    });
  });

  describe('by-host resolution', () => {
    it('resolves a tenant subdomain by slug', async () => {
      await controller.byHost(req({ headers: { host: 'acme.almyty.app' } }), res);
      expect(hostedChat.findBySlug).toHaveBeenCalledWith('acme');
      expect(hostedChat.findByCustomDomain).not.toHaveBeenCalled();
    });

    it('falls through to a custom domain for a host outside the base domain', async () => {
      hostedChat.findByCustomDomain.mockResolvedValueOnce(gateway());
      await controller.byHost(req({ headers: { host: 'chat.acme.com' } }), res);
      expect(hostedChat.findByCustomDomain).toHaveBeenCalledWith('chat.acme.com');
    });

    it('404s for a host belonging to nobody', async () => {
      await expect(
        controller.byHost(req({ headers: { host: 'evil.example' } }), res),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('varies on Host so a shared cache cannot mix tenants', async () => {
      await controller.byHost(req({ headers: { host: 'acme.almyty.app' } }), res);
      expect(res.setHeader).toHaveBeenCalledWith('Vary', 'Host, X-Forwarded-Host');
    });

    it('prefers the forwarded host, which is what the ingress sets', async () => {
      await controller.byHost(
        req({ headers: { host: 'internal-svc', 'x-forwarded-host': 'acme.almyty.app' } }),
        res,
      );
      expect(hostedChat.findBySlug).toHaveBeenCalledWith('acme');
    });
  });

  describe('sending a message', () => {
    it('starts a run attributed to the visitor, not a dashboard user', async () => {
      const result = await controller.postMessage('acme', { message: 'hello' }, req(), res);
      expect(agentRuntimeService.startRun).toHaveBeenCalledWith(
        'agent-1',
        'org-1',
        'eu-1',
        'hello',
        expect.objectContaining({ conversationId: 'conv-1' }),
      );
      expect(result.data).toEqual({ runId: 'run-1', conversationId: 'conv-1' });
    });

    it('rejects an empty or whitespace message', async () => {
      for (const message of ['', '   ', undefined]) {
        await expect(
          controller.postMessage('acme', { message } as any, req(), res),
        ).rejects.toThrow(BadRequestException);
      }
    });

    it('rejects a message past the length cap', async () => {
      await expect(
        controller.postMessage('acme', { message: 'x'.repeat(4001) }, req(), res),
      ).rejects.toThrow(BadRequestException);
    });

    it('returns 429 with Retry-After when the surface is rate limited', async () => {
      gatewayRateLimit.check.mockResolvedValueOnce({ limited: true, retryAfterSeconds: 30 });
      await expect(
        controller.postMessage('acme', { message: 'hello' }, req(), res),
      ).rejects.toMatchObject({ status: 429 });
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '30');
    });

    it('checks the rate limit before starting any run', async () => {
      gatewayRateLimit.check.mockResolvedValueOnce({ limited: true });
      await expect(
        controller.postMessage('acme', { message: 'hello' }, req(), res),
      ).rejects.toBeInstanceOf(HttpException);
      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
    });

    it('continues an existing conversation only through the ownership-scoped lookup', async () => {
      await controller.postMessage('acme', { message: 'hi', conversationId: 'conv-9' }, req(), res);
      // Never a bare findOne on the supplied id.
      expect(hostedChat.findConversation).toHaveBeenCalledWith(endUser, 'conv-9');
      expect(hostedChat.startConversation).not.toHaveBeenCalled();
    });

    it('refuses to continue another visitor conversation', async () => {
      hostedChat.findConversation.mockRejectedValueOnce(new NotFoundException());
      await expect(
        controller.postMessage('acme', { message: 'hi', conversationId: 'someone-elses' }, req(), res),
      ).rejects.toThrow(NotFoundException);
      expect(agentRuntimeService.startRun).not.toHaveBeenCalled();
    });
  });

  describe('streaming', () => {
    it('requires a runId', async () => {
      await expect(controller.stream('acme', '', req(), res)).rejects.toThrow(BadRequestException);
    });

    it('refuses to stream a run the visitor does not own', async () => {
      // A run id is a UUID, but it still arrives from the caller.
      hostedChat.runBelongsToEndUser.mockResolvedValueOnce(false);
      await expect(controller.stream('acme', 'run-9', req(), res)).rejects.toMatchObject({
        status: 404,
      });
      expect(res.setHeader).not.toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    });

    it('sets the SSE headers and disables proxy buffering', async () => {
      const emitter = { on: jest.fn(), off: jest.fn() };
      agentRuntimeService.getRunEmitter.mockReturnValueOnce(emitter);
      await controller.stream('acme', 'run-1', req(), res);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      // nginx would otherwise buffer the whole stream and deliver it at once.
      expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    });

    it('closes immediately when the run is not streaming here', async () => {
      agentRuntimeService.getRunEmitter.mockReturnValueOnce(null);
      await controller.stream('acme', 'run-1', req(), res);
      expect(res.write).toHaveBeenCalledWith(expect.stringContaining('not_streaming'));
      expect(res.end).toHaveBeenCalled();
    });
  });

  describe('replaying a conversation', () => {
    it('loads it through the ownership-scoped lookup', async () => {
      const result = await controller.messages('acme', 'conv-1', req(), res);
      expect(hostedChat.findConversation).toHaveBeenCalledWith(endUser, 'conv-1');
      expect(result.data.conversationId).toBe('conv-1');
    });

    it('404s on another visitor conversation', async () => {
      hostedChat.findConversation.mockRejectedValueOnce(new NotFoundException());
      await expect(controller.messages('acme', 'nope', req(), res)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
