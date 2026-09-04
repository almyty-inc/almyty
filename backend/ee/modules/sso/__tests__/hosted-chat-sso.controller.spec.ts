import { HttpException } from '@nestjs/common';

import { HostedChatSsoController } from '../hosted-chat-sso.controller';
import { HostedChatService } from '../../../../src/modules/gateways/channels/hosted-chat.service';

describe('HostedChatSsoController', () => {
  let hostedChat: any;
  let sso: any;
  let orgLicense: any;
  let controller: HostedChatSsoController;

  const gateway = (authMode = 'sso') => ({ id: 'gw-1', organizationId: 'org-1', configuration: { hostedChat: { slug: 'acme', authMode } } });
  const res = () => ({ cookie: jest.fn(), clearCookie: jest.fn(), redirect: jest.fn() }) as any;
  const req = (cookies: Record<string, string> = {}) => ({ headers: {}, cookies, ip: '203.0.113.9' }) as any;

  beforeEach(() => {
    process.env.HOSTED_CHAT_BASE_DOMAIN = 'staging.almyty.app';
    hostedChat = {
      findBySlug: jest.fn(async () => gateway()),
      authMode: jest.fn((gw: any) => gw.configuration.hostedChat.authMode),
      resolveEndUser: jest.fn(async () => ({ endUser: { id: 'eu-anon' }, issuedSessionKey: null })),
      bindAuthenticatedVisitor: jest.fn(async () => ({ endUser: { id: 'eu-1' }, issuedSessionKey: 'new-session-key' })),
    };
    sso = {
      getOidcLoginUrl: jest.fn(async () => ({ url: 'https://idp.example/authorize?x=1', state: 'st4te' })),
      resolveOidcClaims: jest.fn(async () => ({ sub: 'okta|123', email: 'ava@northwind.example', name: 'Ava Chen' })),
    };
    orgLicense = { hasForOrg: jest.fn(async () => true) };
    controller = new HostedChatSsoController(hostedChat, sso, orgLicense);
  });

  afterEach(() => {
    delete process.env.HOSTED_CHAT_BASE_DOMAIN;
  });

  it('builds a deterministic callback on the tenant host under the api prefix', () => {
    expect(HostedChatSsoController.callbackUrl('acme')).toBe('https://acme.staging.almyty.app/api/public/chat/acme/auth/sso/callback');
  });

  describe('login', () => {
    it('redirects to the IdP with a per-surface redirect uri and a slug-bound state cookie', async () => {
      const r = res();
      await controller.login('acme', req(), r);
      expect(sso.getOidcLoginUrl).toHaveBeenCalledWith('org-1', {
        redirectUri: 'https://acme.staging.almyty.app/api/public/chat/acme/auth/sso/callback',
      });
      const [name, value, opts] = r.cookie.mock.calls[0];
      expect(name).toBe(HostedChatSsoController.STATE_COOKIE);
      expect(value).toMatch(/^st4te\.acme\./);
      expect(opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
      expect(r.redirect).toHaveBeenCalledWith(302, 'https://idp.example/authorize?x=1');
    });

    it('refuses a surface that does not use SSO', async () => {
      hostedChat.findBySlug.mockResolvedValue(gateway('public_link'));
      const failure = await controller.login('acme', req(), res()).catch((e) => e);
      expect(failure).toBeInstanceOf(HttpException);
      expect(failure.getStatus()).toBe(400);
    });

    it('refuses an organization without the SSO entitlement', async () => {
      orgLicense.hasForOrg.mockResolvedValue(false);
      const failure = await controller.login('acme', req(), res()).catch((e) => e);
      expect(failure.getStatus()).toBe(503);
      expect(sso.getOidcLoginUrl).not.toHaveBeenCalled();
    });
  });

  describe('callback', () => {
    const cookies = { [HostedChatSsoController.STATE_COOKIE]: 'st4te.acme.n0nce', [HostedChatService.SESSION_COOKIE]: 'anon-cookie' };

    it('binds the verified identity to the visitor and rotates the session cookie', async () => {
      const r = res();
      await controller.callback('acme', { code: 'c0de', state: 'st4te' }, req(cookies), r);

      expect(sso.resolveOidcClaims).toHaveBeenCalledWith(
        'org-1',
        { code: 'c0de', state: 'st4te' },
        'st4te',
        'https://acme.staging.almyty.app/api/public/chat/acme/auth/sso/callback',
      );
      expect(hostedChat.resolveEndUser).toHaveBeenCalledWith(expect.anything(), 'anon-cookie', '203.0.113.9');
      expect(hostedChat.bindAuthenticatedVisitor).toHaveBeenCalledWith(expect.anything(), { id: 'eu-anon' }, {
        provider: 'sso',
        externalId: 'okta|123',
        email: 'ava@northwind.example',
        displayName: 'Ava Chen',
      });
      expect(r.clearCookie).toHaveBeenCalledWith(HostedChatSsoController.STATE_COOKIE, { path: '/' });
      expect(r.cookie).toHaveBeenCalledWith(HostedChatService.SESSION_COOKIE, 'new-session-key', expect.objectContaining({ httpOnly: true }));
      expect(r.redirect).toHaveBeenCalledWith(302, '/');
    });

    it('rejects a state that does not match the cookie', async () => {
      const failure = await controller.callback('acme', { code: 'c0de', state: 'other' }, req(cookies), res()).catch((e) => e);
      expect(failure.getStatus()).toBe(401);
      expect(sso.resolveOidcClaims).not.toHaveBeenCalled();
    });

    it('rejects a state cookie minted for another surface', async () => {
      const foreign = { ...cookies, [HostedChatSsoController.STATE_COOKIE]: 'st4te.other-tenant.n0nce' };
      const failure = await controller.callback('acme', { code: 'c0de', state: 'st4te' }, req(foreign), res()).catch((e) => e);
      expect(failure.getStatus()).toBe(401);
    });

    it('does not bind anything when the token exchange fails', async () => {
      sso.resolveOidcClaims.mockRejectedValue(new HttpException('OIDC token exchange failed', 401));
      await expect(controller.callback('acme', { code: 'bad', state: 'st4te' }, req(cookies), res())).rejects.toBeInstanceOf(HttpException);
      expect(hostedChat.bindAuthenticatedVisitor).not.toHaveBeenCalled();
    });
  });
});
