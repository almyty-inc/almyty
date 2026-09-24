import * as crypto from 'crypto';
import { UnauthorizedException } from '@nestjs/common';

import { McpOAuthTokensHelper } from '../services/mcp-oauth-tokens.helper';
import { GatewayAuthValidators } from '../../gateways/gateway-auth-validators.helper';
import { GatewayAuth, GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * An MCP OAuth token is a member's delegation, and it ends when the
 * membership does.
 *
 * Removing a member deregisters their runners, revokes their connections
 * and drops their grants -- and left every gateway access token and
 * refresh token they had authorized untouched. validateOAuth2 checked the
 * token's gateway and organization, never whether its holder still
 * belonged to that organization (the Basic and JWT validators beside it
 * both do), and the refresh grant rotated a departed member's refresh
 * token into a fresh pair every time: 30-day refresh tokens, renewed on
 * use, so gateway access that never ended.
 */
const ORG = 'org-a';
const GATEWAY = 'gw-1';
const CLIENT = 'mcp_client_1';
const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

function user(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    isActive: true,
    organizationMemberships: [{ organizationId: ORG, isActive: true, role: 'member' }],
    ...overrides,
  };
}

const departed = user('bob', { organizationMemberships: [{ organizationId: 'org-elsewhere', isActive: true }] });

describe('gateway OAuth2 validation checks the token holder is still a member', () => {
  const TOKEN = 'almyty_at_live';

  function build(holder: any) {
    const tokens = fakeRepository<any>([
      {
        id: 't-1',
        tokenHash: hash(TOKEN),
        tokenType: 'access',
        clientId: CLIENT,
        userId: holder.id,
        gatewayId: GATEWAY,
        organizationId: ORG,
        scope: 'mcp:*',
        isRevoked: false,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const users = fakeRepository<any>([holder]);
    const apiKeys = fakeRepository<any>();
    const validators = new GatewayAuthValidators({} as any, users as any, apiKeys as any, tokens as any, {} as any);
    const config = {
      id: 'auth-1',
      gatewayId: GATEWAY,
      type: GatewayAuthType.OAUTH2,
      isActive: true,
      configuration: {},
      gateway: { id: GATEWAY, organizationId: ORG },
    } as unknown as GatewayAuth;
    return () => validators.validateOAuth2(config, { authorization: `Bearer ${TOKEN}` });
  }

  it('accepts a current member', async () => {
    const result = await build(user('alice'))();
    expect(result.isValid).toBe(true);
    expect(result.userId).toBe('alice');
  });

  it('refuses a member who has left the organization', async () => {
    const result = await build(departed)();
    expect(result.isValid).toBe(false);
  });

  it('refuses a deactivated user', async () => {
    const result = await build(user('carol', { isActive: false }))();
    expect(result.isValid).toBe(false);
  });

  it('refuses a membership that is only a revoked invite', async () => {
    const result = await build(
      user('dave', { organizationMemberships: [{ organizationId: ORG, isActive: false }] }),
    )();
    expect(result.isValid).toBe(false);
  });
});

describe('the refresh grant stops for a departed member', () => {
  const RAW_RT = 'almyty_rt_live';

  function build(holder: any) {
    const clients = fakeRepository<any>([
      {
        id: 'c-1',
        clientId: CLIENT,
        clientSecretHash: null,
        tokenEndpointAuthMethod: 'none',
        gatewayId: GATEWAY,
        organizationId: ORG,
        isActive: true,
      },
    ]);
    const tokens = fakeRepository<any>({
      idPrefix: 'token',
      seed: [
        {
          id: 'rt-1',
          tokenHash: hash(RAW_RT),
          tokenType: 'refresh',
          clientId: CLIENT,
          userId: holder.id,
          gatewayId: GATEWAY,
          organizationId: ORG,
          scope: 'mcp:*',
          resource: null,
          isRevoked: false,
          parentTokenId: null,
          expiresAt: new Date(Date.now() + 3600_000),
        },
      ],
    });
    const users = fakeRepository<any>([holder]);
    const helper = new McpOAuthTokensHelper(
      clients as any,
      fakeRepository() as any,
      tokens as any,
      users as any,
    );
    return { helper, tokens };
  }

  it('rotates a current member\'s refresh token', async () => {
    const { helper, tokens } = build(user('alice'));
    const pair = await helper.refreshToken(RAW_RT, CLIENT, GATEWAY);
    expect(pair.access_token).toMatch(/^almyty_at_/);
    expect(tokens.rows()).toHaveLength(3);
  });

  it('refuses a departed member and mints nothing', async () => {
    const { helper, tokens } = build(departed);
    await expect(helper.refreshToken(RAW_RT, CLIENT, GATEWAY)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.rows()).toHaveLength(1);
    expect(tokens.row('rt-1')!.isRevoked).toBe(true);
  });

  it('refuses a deactivated user', async () => {
    const { helper, tokens } = build(user('carol', { isActive: false }));
    await expect(helper.refreshToken(RAW_RT, CLIENT, GATEWAY)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tokens.rows()).toHaveLength(1);
  });
});
