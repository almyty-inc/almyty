import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { VisitorOAuthConfigService, VisitorOAuthStore, visitorOAuthManagedBy } from '../visitor-oauth-config.service';
import { Gateway, GatewayStatus, GatewayType, VisitorOAuthConfig } from '../../../../entities/gateway.entity';
import { Credential } from '../../../../entities/credential.entity';
import { CredentialRefResolver } from '../../../credentials/credential-ref.resolver';
import { fakeRepository } from '../../../../test/fake-repository';
import { FakeIdp } from '../../../../test/fake-oidc-provider';
import { makeEnvelopeCryptoMock } from '../../../../test/envelope-crypto.mock';
import { emailDomainAllowed, normalizeEmailDomains, presetEndpoints } from '../visitor-oauth';

/**
 * The admin half of visitor OAuth. What it must never do: keep a client
 * secret anywhere but `credentials`, return one, accept an endpoint that
 * is not https, or trust a discovery document that names another issuer.
 */

const SECRET = 'very-secret-client-secret';

function setup() {
  process.env.HOSTED_CHAT_BASE_DOMAIN = 'almyty.app';
  const gateways: Gateway[] = [
    Object.assign(new Gateway(), {
      id: 'gw-a',
      organizationId: 'org-a',
      name: 'Acme',
      type: GatewayType.HOSTED_CHAT,
      status: GatewayStatus.ACTIVE,
      configuration: { hostedChat: { slug: 'acme', authMode: 'oauth' } },
      customDomain: null,
      visitorOAuth: null,
    }),
    Object.assign(new Gateway(), {
      id: 'gw-w',
      organizationId: 'org-a',
      name: 'Widget',
      type: GatewayType.CHAT_WIDGET,
      status: GatewayStatus.ACTIVE,
      configuration: {},
      customDomain: null,
      visitorOAuth: null,
    }),
  ];
  const writes: Array<VisitorOAuthConfig | null> = [];
  const store: VisitorOAuthStore = {
    async write(id, organizationId, config) {
      const g = gateways.find((x) => x.id === id && x.organizationId === organizationId);
      if (!g) return;
      g.visitorOAuth = config ? JSON.parse(JSON.stringify(config)) : null;
      writes.push(g.visitorOAuth);
    },
  };
  const credentials = fakeRepository<Credential>({ make: () => new Credential(), idPrefix: 'cred' });
  const refs = new CredentialRefResolver(credentials as any, makeEnvelopeCryptoMock());
  const idp = new FakeIdp();
  const gatewaysService = {
    findManageable: async (id: string, organizationId: string, userId: string) => {
      const g = gateways.find((x) => x.id === id && x.organizationId === organizationId);
      if (!g) throw new NotFoundException('Gateway not found');
      if (userId === 'viewer') throw new ForbiddenException();
      return JSON.parse(JSON.stringify(g));
    },
  };
  const service = new VisitorOAuthConfigService(gatewaysService as any, store, refs, idp.fetch as any);
  return { service, gateways, writes, credentials, refs, idp };
}

const google = { preset: 'google', clientId: 'gid.apps.googleusercontent.com', clientSecret: SECRET };

describe('VisitorOAuthConfigService', () => {
  it('stores the client secret in a managed credential and only its id on the gateway', async () => {
    const { service, gateways, credentials, refs } = setup();
    const view = await service.set('gw-a', 'org-a', 'u1', google);

    const stored = gateways[0].visitorOAuth!;
    expect(JSON.stringify(stored)).not.toContain(SECRET);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(view.provider!.hasClientSecret).toBe(true);

    const [row] = credentials.rows();
    expect(stored.credentialId).toBe(row.id);
    expect(CredentialRefResolver.isManagedBy(row, visitorOAuthManagedBy('gw-a'))).toBe(true);
    // Encrypted at rest, and it resolves back to the pasted value.
    expect(JSON.stringify(row.config)).not.toContain(SECRET);
    const resolved = await refs.resolve('org-a', row.id);
    expect(resolved.config.client_secret).toBe(SECRET);
  });

  it('fills the Google endpoints and shows the exact redirect URIs to register', async () => {
    const { service, gateways } = setup();
    gateways[0].customDomain = { hostname: 'chat.acme.com', status: 'active', verificationToken: 't', verifiedAt: null, lastCheckedAt: null, lastError: null };
    // The URIs are there before a provider is: the provider asks for them
    // when the OAuth app is created, which is where the client ID comes from.
    await expect(service.get('gw-a', 'org-a', 'u1')).resolves.toEqual({
      provider: null,
      redirectUris: [
        'https://acme.almyty.app/api/public/chat/acme/auth/oauth/callback',
        'https://chat.acme.com/api/public/chat/acme/auth/oauth/callback',
      ],
    });
    const view = await service.set('gw-a', 'org-a', 'u1', google);
    expect(view).toMatchObject({
      provider: {
        preset: 'google',
        providerLabel: 'Google',
        issuer: 'https://accounts.google.com',
        scopes: ['openid', 'email', 'profile'],
      },
      redirectUris: [
        'https://acme.almyty.app/api/public/chat/acme/auth/oauth/callback',
        'https://chat.acme.com/api/public/chat/acme/auth/oauth/callback',
      ],
    });
  });

  it('rotates the same credential when a new secret is pasted, and keeps it when none is sent', async () => {
    const { service, gateways, credentials, refs } = setup();
    await service.set('gw-a', 'org-a', 'u1', google);
    const firstId = gateways[0].visitorOAuth!.credentialId;

    await service.set('gw-a', 'org-a', 'u1', { ...google, clientSecret: undefined, allowedEmailDomains: ['acme.com'] });
    expect(gateways[0].visitorOAuth!.credentialId).toBe(firstId);
    expect((await refs.resolve('org-a', firstId!)).config.client_secret).toBe(SECRET);

    await service.set('gw-a', 'org-a', 'u1', { ...google, clientSecret: 'rotated' });
    expect(gateways[0].visitorOAuth!.credentialId).toBe(firstId);
    expect(credentials.rows()).toHaveLength(1);
    expect((await refs.resolve('org-a', firstId!)).config.client_secret).toBe('rotated');
  });

  it('refuses a first save without a secret', async () => {
    const { service, gateways } = setup();
    await expect(service.set('gw-a', 'org-a', 'u1', { ...google, clientSecret: '' })).rejects.toBeInstanceOf(BadRequestException);
    expect(gateways[0].visitorOAuth).toBeNull();
  });

  it('never adopts a credential it does not manage', async () => {
    const { service, gateways, credentials } = setup();
    const shared = credentials.seed({ id: 'cred-shared', organizationId: 'org-a', config: { client_secret: 'x' }, metadata: {}, isActive: true } as any);
    // A provider row pointing at a shared connection (not one it manages).
    gateways[0].visitorOAuth = { credentialId: shared.id } as any;
    await service.set('gw-a', 'org-a', 'u1', google);
    expect(gateways[0].visitorOAuth!.credentialId).not.toBe('cred-shared');
    expect(credentials.row('cred-shared')!.config).toEqual({ client_secret: 'x' });
  });

  it('removing the provider releases its secret', async () => {
    const { service, gateways, credentials } = setup();
    await service.set('gw-a', 'org-a', 'u1', google);
    await service.remove('gw-a', 'org-a', 'u1');
    expect(gateways[0].visitorOAuth).toBeNull();
    expect(credentials.rows()).toHaveLength(0);
    await expect(service.get('gw-a', 'org-a', 'u1')).resolves.toMatchObject({ provider: null });
  });

  describe('generic OpenID Connect', () => {
    it('reads the discovery document through the injected fetch', async () => {
      const { service, idp } = setup();
      const view = await service.set('gw-a', 'org-a', 'u1', { preset: 'oidc', discoveryUrl: idp.issuer, clientId: 'c', clientSecret: SECRET });
      expect(idp.requests).toEqual(['https://idp.test/.well-known/openid-configuration']);
      expect(view.provider).toMatchObject({
        issuer: 'https://idp.test',
        authorizationEndpoint: 'https://idp.test/authorize',
        tokenEndpoint: 'https://idp.test/token',
        jwksUri: 'https://idp.test/jwks',
        discoveryUrl: 'https://idp.test/.well-known/openid-configuration',
      });
    });

    it('refuses a discovery document that names another issuer', async () => {
      const { service, idp } = setup();
      const doc = idp.discovery();
      const lying = async () => new Response(JSON.stringify({ ...doc, issuer: 'https://accounts.google.com' }), { status: 200 });
      const s = new VisitorOAuthConfigService((service as any).gatewaysService, (service as any).store, (service as any).credentialRefs, lying as any);
      await expect(s.set('gw-a', 'org-a', 'u1', { preset: 'oidc', discoveryUrl: idp.issuer, clientId: 'c', clientSecret: SECRET })).rejects.toMatchObject({
        response: { message: expect.stringMatching(/different issuer/) },
      });
    });

    it('refuses discovered endpoints that are not https', async () => {
      const { service, idp } = setup();
      const doc = idp.discovery();
      const downgraded = async () => new Response(JSON.stringify({ ...doc, token_endpoint: 'http://idp.test/token' }), { status: 200 });
      const s = new VisitorOAuthConfigService((service as any).gatewaysService, (service as any).store, (service as any).credentialRefs, downgraded as any);
      await expect(s.set('gw-a', 'org-a', 'u1', { preset: 'oidc', discoveryUrl: idp.issuer, clientId: 'c', clientSecret: SECRET })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('with the production fetch, a discovery URL on a private address is refused', async () => {
      const { service } = setup();
      const s = new VisitorOAuthConfigService((service as any).gatewaysService, (service as any).store, (service as any).credentialRefs);
      await expect(
        s.set('gw-a', 'org-a', 'u1', { preset: 'oidc', discoveryUrl: 'https://169.254.169.254', clientId: 'c', clientSecret: SECRET }),
      ).rejects.toMatchObject({ response: { message: expect.stringMatching(/Could not read the discovery document/) } });
    });

    it('takes manual endpoints, https only, and insists on the openid scope', async () => {
      const { service } = setup();
      const manual = {
        preset: 'oidc',
        issuer: 'https://login.example.com',
        authorizationEndpoint: 'https://login.example.com/authorize',
        tokenEndpoint: 'https://login.example.com/token',
        jwksUri: 'https://login.example.com/keys',
        clientId: 'c',
        clientSecret: SECRET,
      };
      await expect(service.set('gw-a', 'org-a', 'u1', manual)).resolves.toMatchObject({ provider: { issuer: 'https://login.example.com' } });
      await expect(service.set('gw-a', 'org-a', 'u1', { ...manual, tokenEndpoint: 'http://login.example.com/token' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.set('gw-a', 'org-a', 'u1', { ...manual, scopes: 'email profile' })).rejects.toMatchObject({
        response: { message: expect.stringMatching(/openid scope/) },
      });
    });
  });

  it('Microsoft needs one tenant; the shared multi-tenant endpoints are refused', async () => {
    const { service } = setup();
    for (const tenant of ['common', 'organizations', 'consumers', '', 'not a tenant']) {
      await expect(service.set('gw-a', 'org-a', 'u1', { preset: 'microsoft', tenant, clientId: 'c', clientSecret: SECRET })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      service.set('gw-a', 'org-a', 'u1', { preset: 'microsoft', tenant: 'contoso.onmicrosoft.com', clientId: 'c', clientSecret: SECRET }),
    ).resolves.toMatchObject({ provider: { issuer: 'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0' } });
  });

  it('is for hosted chat surfaces the caller may manage in their own organization', async () => {
    const { service } = setup();
    await expect(service.set('gw-w', 'org-a', 'u1', google)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.set('gw-a', 'org-b', 'u1', google)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.set('gw-a', 'org-a', 'viewer', google)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('visitor OAuth rules', () => {
  it('a domain rule only counts provider-verified addresses', () => {
    expect(emailDomainAllowed([], null, false)).toBe(true);
    expect(emailDomainAllowed(['acme.com'], 'ada@acme.com', true)).toBe(true);
    expect(emailDomainAllowed(['acme.com'], 'ada@acme.com', false)).toBe(false);
    expect(emailDomainAllowed(['acme.com'], 'ada@evil-acme.com', true)).toBe(false);
    expect(emailDomainAllowed(['acme.com'], 'ada@sub.acme.com', true)).toBe(false);
    expect(emailDomainAllowed(['acme.com'], null, true)).toBe(false);
  });

  it('normalises allowed domains and refuses junk', () => {
    expect(normalizeEmailDomains(' @Acme.com, acme.com beta.io ')).toEqual({ domains: ['acme.com', 'beta.io'], error: null });
    expect(normalizeEmailDomains(['not a domain']).error).toMatch(/not a domain/);
  });

  it('Microsoft presets are single-tenant', () => {
    expect(presetEndpoints('microsoft', 'common')).toBeNull();
    expect(presetEndpoints('microsoft', '72f988bf-86f1-41af-91ab-2d7cd011db47')?.issuer).toBe(
      'https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0',
    );
  });
});
