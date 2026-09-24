import * as crypto from 'crypto';

import { GatewayAuthValidators } from '../gateway-auth-validators.helper';
import { GatewayAuth, GatewayAuthType } from '../../../entities/gateway-auth.entity';
import { GatewayAuthService } from '../gateway-auth.service';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * The org-binding half of the OAuth2 gateway check has to actually run.
 *
 * `validateOAuth2` pins the token lookup to `authConfig.gatewayId` and
 * then re-checks that the token's org matches the gateway's owning org.
 * That second check was written as
 *
 *   oauthToken.organizationId !== authConfig.gateway?.organizationId
 *     && authConfig.gateway?.organizationId !== undefined
 *
 * and its only production caller loaded the auth configs without the
 * `gateway` relation, so the optional chain was undefined on every
 * request and the whole conjunction was false. The guard existed, was
 * covered by a comment calling it defence in depth, and never rejected
 * anything.
 */
describe('validateOAuth2 gateway/org binding', () => {
  const TOKEN = 'oauth-access-token';
  const tokenHash = crypto.createHash('sha256').update(TOKEN).digest('hex');
  const headers = { authorization: `Bearer ${TOKEN}` };

  function build(oauthToken: any) {
    const oauthRepo = { findOne: jest.fn().mockResolvedValue(oauthToken) };
    const apiKeyRepo = { findOne: jest.fn().mockResolvedValue(null) };
    // The holder is a current member of org-a: this suite is about the
    // gateway/org binding (oauth-token-holder-membership.spec.ts covers
    // the holder).
    const users = fakeRepository<any>([
      { id: 'user-1', isActive: true, organizationMemberships: [{ organizationId: 'org-a', isActive: true }] },
    ]);
    const validators = new GatewayAuthValidators(
      {} as any,
      users as any,
      apiKeyRepo as any,
      oauthRepo as any,
      {} as any,
    );
    return { validators, oauthRepo };
  }

  function authConfig(gateway: { organizationId: string } | undefined): GatewayAuth {
    return {
      id: 'auth-1',
      gatewayId: 'gateway-1',
      type: GatewayAuthType.OAUTH2,
      isRequired: true,
      isActive: true,
      configuration: {},
      gateway,
    } as unknown as GatewayAuth;
  }

  const validToken = {
    tokenHash,
    organizationId: 'org-a',
    gatewayId: 'gateway-1',
    userId: 'user-1',
    scope: 'read write',
    expiresAt: new Date(Date.now() + 60_000),
  };

  it('accepts a token whose organization owns the gateway', async () => {
    const { validators } = build(validToken);
    const result = await validators.validateOAuth2(authConfig({ organizationId: 'org-a' }), headers);
    expect(result.isValid).toBe(true);
    expect(result.organizationId).toBe('org-a');
  });

  it('refuses a token minted for another organization', async () => {
    const { validators } = build(validToken);
    const result = await validators.validateOAuth2(authConfig({ organizationId: 'org-b' }), headers);
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('OAUTH2_TOKEN_WRONG_GATEWAY');
  });

  it('refuses when the gateway relation is absent, instead of skipping the check', async () => {
    // The unloaded-relation case is exactly the one that used to pass:
    // no owning org to compare against must mean refuse, not allow.
    const { validators } = build(validToken);
    const result = await validators.validateOAuth2(authConfig(undefined), headers);
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('OAUTH2_TOKEN_WRONG_GATEWAY');
  });

  it('scopes the token lookup to the gateway the request arrived on', async () => {
    const { validators, oauthRepo } = build(validToken);
    await validators.validateOAuth2(authConfig({ organizationId: 'org-a' }), headers);
    expect(oauthRepo.findOne).toHaveBeenCalledWith({
      where: { tokenHash, tokenType: 'access', isRevoked: false, gatewayId: 'gateway-1' },
    });
  });
});

/**
 * End-to-end through the one production caller. The fake repository
 * behaves like TypeORM: it fills `gateway` only when the caller asks for
 * the relation. If `authenticateRequest` stops asking, the org check
 * upstream loses its input and this suite goes red.
 */
describe('GatewayAuthService.authenticateRequest loads the gateway for the org check', () => {
  const TOKEN = 'oauth-access-token';
  const tokenHash = crypto.createHash('sha256').update(TOKEN).digest('hex');

  function build() {
    const findCalls: any[] = [];
    const gatewayAuthRepository = {
      find: jest.fn(async (options: any) => {
        findCalls.push(options);
        const row: any = {
          id: 'auth-1',
          gatewayId: 'gateway-1',
          type: GatewayAuthType.OAUTH2,
          isRequired: true,
          isActive: true,
          configuration: {},
          createdAt: new Date(),
        };
        // TypeORM leaves a relation undefined unless it was requested.
        if (options?.relations?.gateway) row.gateway = { id: 'gateway-1', organizationId: 'org-a' };
        return [row];
      }),
    };
    const oauthAccessTokenRepository = {
      findOne: jest.fn().mockResolvedValue({
        tokenHash,
        // Minted for a different tenant than the gateway's owner.
        organizationId: 'org-b',
        gatewayId: 'gateway-1',
        userId: 'user-1',
        scope: 'read',
        expiresAt: new Date(Date.now() + 60_000),
      }),
    };
    const apiKeyRepository = { findOne: jest.fn().mockResolvedValue(null) };
    const validators = new GatewayAuthValidators(
      {} as any,
      {} as any,
      apiKeyRepository as any,
      oauthAccessTokenRepository as any,
      {} as any,
    );
    const service = new GatewayAuthService(
      gatewayAuthRepository as any,
      {} as any,
      apiKeyRepository as any,
      validators,
    );
    return { service, findCalls };
  }

  it('refuses a token from another organization', async () => {
    const { service, findCalls } = build();
    const result = await service.authenticateRequest(
      'gateway-1',
      { authorization: `Bearer ${TOKEN}` },
      {},
    );
    expect(findCalls[0]?.relations).toEqual({ gateway: true });
    expect(result.isValid).toBe(false);
    expect(result.errorCode).toBe('OAUTH2_TOKEN_WRONG_GATEWAY');
  });
});
