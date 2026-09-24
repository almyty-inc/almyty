import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';

import { HostedChatSsoController } from '../hosted-chat-sso.controller';
import { HostedChatSsoSettingsController } from '../hosted-chat-sso-settings.controller';
import { GatewayType } from '../../../../src/entities/gateway.entity';

/**
 * The URLs an organization registers at its IdP for hosted-chat visitor
 * sign-in, answered on the gateway page from the same functions the
 * sign-in routes use -- so what the admin copies is what the IdP will be
 * sent and what the assertion consumer is mounted at.
 */
describe('HostedChatSsoSettingsController', () => {
  const ORG = 'org-1';
  const USER = 'user-1';
  let gateways: { findManageable: jest.Mock };
  let sso: { protocolFor: jest.Mock };
  let controller: HostedChatSsoSettingsController;

  const surface = (overrides: Record<string, any> = {}) => ({
    id: 'gw-1',
    organizationId: ORG,
    type: GatewayType.HOSTED_CHAT,
    configuration: { hostedChat: { slug: 'acme', authMode: 'sso' } },
    customDomain: null,
    ...overrides,
  });
  const req = { user: { id: USER, currentOrganizationId: ORG } };

  beforeEach(() => {
    process.env.HOSTED_CHAT_BASE_DOMAIN = 'staging.almyty.app';
    gateways = { findManageable: jest.fn(async () => surface()) };
    sso = { protocolFor: jest.fn(async () => 'saml') };
    controller = new HostedChatSsoSettingsController(gateways as any, sso as any);
  });

  afterEach(() => {
    delete process.env.HOSTED_CHAT_BASE_DOMAIN;
    delete process.env.HOSTED_CHAT_API_PREFIX;
  });

  it('answers the ACS URL on the tenant host, the one the SAML login sends to the IdP', async () => {
    const { data } = await controller.get('gw-1', req);

    expect(gateways.findManageable).toHaveBeenCalledWith('gw-1', ORG, USER);
    expect(data.protocol).toBe('saml');
    expect(data.samlAcsUrls).toEqual([
      'https://acme.staging.almyty.app/api/public/chat/acme/auth/sso/saml/acs',
    ]);
    expect(data.samlAcsUrls[0]).toBe(
      HostedChatSsoController.samlAcsUrl(surface(), 'acme', 'acme.staging.almyty.app'),
    );
    expect(data.oidcRedirectUri).toBe(HostedChatSsoController.callbackUrl('acme'));
  });

  it('is the path the assertion consumer route is mounted at', async () => {
    const { data } = await controller.get('gw-1', req);
    const base = Reflect.getMetadata(PATH_METADATA, HostedChatSsoController);
    const route = Reflect.getMetadata(PATH_METADATA, HostedChatSsoController.prototype.samlAcs);
    const mounted = `/api/${base}/${String(route).replace(':slug', 'acme')}`;
    expect(new URL(data.samlAcsUrls[0]).pathname).toBe(mounted);
  });

  it('adds the verified custom domain, which the login uses when the visitor is on it', async () => {
    const withDomain = surface({ customDomain: { hostname: 'chat.acme.example', status: 'active' } });
    gateways.findManageable.mockResolvedValue(withDomain);

    const { data } = await controller.get('gw-1', req);

    expect(data.samlAcsUrls).toEqual([
      'https://acme.staging.almyty.app/api/public/chat/acme/auth/sso/saml/acs',
      'https://chat.acme.example/api/public/chat/acme/auth/sso/saml/acs',
    ]);
    expect(data.samlAcsUrls[1]).toBe(HostedChatSsoController.samlAcsUrl(withDomain, 'acme', 'chat.acme.example'));
  });

  it('leaves out a custom domain that is not verified yet', async () => {
    gateways.findManageable.mockResolvedValue(
      surface({ customDomain: { hostname: 'chat.acme.example', status: 'pending' } }),
    );
    const { data } = await controller.get('gw-1', req);
    expect(data.samlAcsUrls).toHaveLength(1);
  });

  it('follows the configured api prefix', async () => {
    process.env.HOSTED_CHAT_API_PREFIX = '/edge/api';
    const { data } = await controller.get('gw-1', req);
    expect(data.samlAcsUrls[0]).toBe('https://acme.staging.almyty.app/edge/api/public/chat/acme/auth/sso/saml/acs');
  });

  it('answers no URLs before the surface has a subdomain', async () => {
    gateways.findManageable.mockResolvedValue(surface({ configuration: { hostedChat: {} } }));
    const { data } = await controller.get('gw-1', req);
    expect(data.samlAcsUrls).toEqual([]);
    expect(data.oidcRedirectUri).toBeNull();
  });

  it('refuses a gateway that is not a hosted chat, and one the caller cannot manage', async () => {
    gateways.findManageable.mockResolvedValueOnce(surface({ type: GatewayType.MCP }));
    await expect(controller.get('gw-1', req)).rejects.toBeInstanceOf(BadRequestException);

    gateways.findManageable.mockRejectedValueOnce(new NotFoundException('Gateway not found'));
    await expect(controller.get('gw-1', req)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('needs an organization context', async () => {
    await expect(controller.get('gw-1', { user: { id: USER } })).rejects.toBeInstanceOf(BadRequestException);
  });
});
