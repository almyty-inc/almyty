import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';

import { fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { McpOAuthService, MCP_OAUTH_SCOPES } from '../services/mcp-oauth.service';
import { McpOAuthTokensHelper } from '../services/mcp-oauth-tokens.helper';

/**
 * What an MCP OAuth token may claim, and who it is for.
 *
 * Scope: the client asked for a scope string and got it verbatim. The
 * consent screen defaulted to `mcp:*` and so did POST /authorize, nothing
 * compared the request with what the client registered, and registration
 * itself accepted any string. A token could therefore carry whatever the
 * caller typed, including a scope that a gateway tool's `requiredScopes`
 * names -- which only admins can put on a gateway key.
 *
 * Resource (RFC 8707): the authorize step dropped `resource`, and the
 * token exchange wrote the client's redirect URI into the token's
 * `resource` column, so every token claimed an audience that was the
 * client's own callback.
 */
describe('MCP OAuth scope bounding and resource binding', () => {
  const GATEWAY = 'gateway-1';
  const ORG = 'org-1';
  const USER = 'user-1';
  const CLIENT = 'mcp_client_abc123';
  const REDIRECT_URI = 'https://client.example/callback';
  const RESOURCE = 'https://api.almyty.test/acme/weather';
  const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CHALLENGE = crypto.createHash('sha256').update(VERIFIER).digest('base64url');

  let clients: FakeRepository<any>;
  let codes: FakeRepository<any>;
  let tokens: FakeRepository<any>;
  let service: McpOAuthService;

  function build(clientScope = 'mcp:tools mcp:resources') {
    clients = fakeRepository<any>({
      seed: [
        {
          id: 'client-row-1',
          clientId: CLIENT,
          clientSecretHash: null,
          clientName: 'Test Client',
          redirectUris: [REDIRECT_URI],
          tokenEndpointAuthMethod: 'none',
          scope: clientScope,
          gatewayId: GATEWAY,
          organizationId: ORG,
          isActive: true,
        },
      ],
    });
    codes = fakeRepository<any>({ idPrefix: 'code' });
    tokens = fakeRepository<any>({ idPrefix: 'token' });
    // The code's holder has to still be a member when the code is redeemed.
    const users = fakeRepository<any>([
      { id: USER, isActive: true, organizationMemberships: [{ organizationId: ORG, role: 'member', isActive: true }] },
    ]);
    const helper = new McpOAuthTokensHelper(clients as any, codes as any, tokens as any, users as any);
    service = new McpOAuthService(clients as any, codes as any, helper);
  }

  const authorize = (extra: { scope?: string; resource?: string } = {}) =>
    service.createAuthorizationCode(CLIENT, USER, GATEWAY, ORG, {
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
      ...extra,
    });

  describe('scope', () => {
    it('refuses a scope the client never registered', async () => {
      build();
      await expect(authorize({ scope: 'finance:admin' })).rejects.toThrow(BadRequestException);
      await expect(authorize({ scope: 'mcp:tools mcp:*' })).rejects.toThrow(BadRequestException);
      expect(codes.rows()).toHaveLength(0);
    });

    it('grants a subset of the registered scope as asked', async () => {
      build();
      await authorize({ scope: 'mcp:tools' });
      expect(codes.rows()[0].scope).toBe('mcp:tools');
    });

    it('grants the registered scope when none is asked for', async () => {
      build();
      await authorize();
      expect(codes.rows()[0].scope).toBe('mcp:tools mcp:resources');
    });

    it('shows the consent screen the scope that would be granted, not mcp:*', async () => {
      build();
      const info = await service.getConsentInfo(CLIENT, GATEWAY, REDIRECT_URI);
      expect(info.scopes).toEqual(['mcp:tools', 'mcp:resources']);
      await expect(
        service.getConsentInfo(CLIENT, GATEWAY, REDIRECT_URI, 'finance:admin'),
      ).rejects.toThrow(BadRequestException);
    });

    it('only registers scopes from the advertised vocabulary', async () => {
      build();
      await expect(
        service.registerClient(GATEWAY, ORG, {
          client_name: 'c',
          redirect_uris: [REDIRECT_URI],
          scope: 'mcp:tools finance:admin',
        }),
      ).rejects.toThrow(BadRequestException);

      const registered = await service.registerClient(GATEWAY, ORG, {
        client_name: 'c',
        redirect_uris: [REDIRECT_URI],
      });
      expect(registered.scope.split(' ')).toEqual(MCP_OAUTH_SCOPES);
    });
  });

  describe('resource', () => {
    async function exchange(resource?: string) {
      const code = await authorize({ resource: RESOURCE });
      return service.exchangeCode(code, CLIENT, VERIFIER, REDIRECT_URI, GATEWAY, undefined, resource);
    }

    it('keeps the requested resource on the authorization code', async () => {
      build();
      await authorize({ resource: RESOURCE });
      expect(codes.rows()[0].resource).toBe(RESOURCE);
    });

    it('stamps the code resource on both tokens, never the redirect URI', async () => {
      build();
      await exchange();
      const rows = tokens.rows();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.resource).toBe(RESOURCE);
        expect(row.resource).not.toBe(REDIRECT_URI);
      }
    });

    it('refuses a token request naming a different resource than was authorized', async () => {
      build();
      await expect(exchange('https://evil.example/other')).rejects.toThrow(BadRequestException);
      expect(tokens.rows()).toHaveLength(0);
    });

    it('accepts a token request repeating the authorized resource', async () => {
      build();
      await exchange(RESOURCE);
      expect(tokens.rows().every((row) => row.resource === RESOURCE)).toBe(true);
    });
  });
});
