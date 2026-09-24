import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

import { fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { McpOAuthTokensHelper } from '../services/mcp-oauth-tokens.helper';

/**
 * An authorization code and a refresh token are each good exactly once.
 *
 * `mcp-oauth-tokens.helper.ts` enforces both with a compare-and-set: a
 * conditional `UPDATE ... WHERE id = ? AND isUsed = false` (resp.
 * `isRevoked = false`) and a refusal unless exactly one row changed.
 *
 * `mcp-oauth.service.spec.ts` drives the helper through doubles whose
 * `update` answers `{ affected: 1 }` whatever the criteria, so a lost race
 * is only visible where a test stubs `affected: 0` by hand. Here the
 * tables evaluate the criteria, so single-use is proved by the state the
 * writes leave behind.
 */
describe('OAuth single-use semantics (table-backed)', () => {
  const GATEWAY = 'gateway-1';
  const ORG = 'org-1';
  const USER = 'user-1';
  const CLIENT = 'mcp_client_abc123';

  const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

  const RAW_CODE = 'test-authorization-code';
  const RAW_RT = 'almyty_rt_seed';
  const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CODE_CHALLENGE = crypto.createHash('sha256').update(CODE_VERIFIER).digest('base64url');
  const REDIRECT_URI = 'https://example.com/callback';

  let codes: FakeRepository<any>;
  let tokens: FakeRepository<any>;
  let helper: McpOAuthTokensHelper;

  function authCodeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'code-1',
      codeHash: sha256(RAW_CODE),
      clientId: CLIENT,
      userId: USER,
      gatewayId: GATEWAY,
      organizationId: ORG,
      redirectUri: REDIRECT_URI,
      scope: 'tools:read tools:execute',
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: 'S256',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      isUsed: false,
      ...overrides,
    };
  }

  function refreshRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'refresh-1',
      tokenHash: sha256(RAW_RT),
      tokenType: 'refresh',
      clientId: CLIENT,
      userId: USER,
      gatewayId: GATEWAY,
      organizationId: ORG,
      scope: 'tools:read tools:execute',
      resource: REDIRECT_URI,
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
      isRevoked: false,
      parentTokenId: null,
      ...overrides,
    };
  }

  function build(codeRows: any[] = [], tokenRows: any[] = []) {
    const clients = fakeRepository<any>({
      seed: [
        {
          id: 'client-row-1',
          clientId: CLIENT,
          clientSecretHash: null,
          tokenEndpointAuthMethod: 'none',
          gatewayId: GATEWAY,
          organizationId: ORG,
          isActive: true,
        },
      ],
    });
    codes = fakeRepository<any>({ seed: codeRows, idPrefix: 'code' });
    tokens = fakeRepository<any>({ seed: tokenRows, idPrefix: 'token' });
    // The holder is a current member: this suite is about single use, not
    // about membership (oauth-token-holder-membership.spec.ts).
    const users = fakeRepository<any>([
      { id: USER, isActive: true, organizationMemberships: [{ organizationId: ORG, isActive: true }] },
    ]);
    helper = new McpOAuthTokensHelper(clients as any, codes as any, tokens as any, users as any);
  }

  const exchange = () => helper.exchangeCode(RAW_CODE, CLIENT, CODE_VERIFIER, REDIRECT_URI, GATEWAY);
  const refresh = () => helper.refreshToken(RAW_RT, CLIENT, GATEWAY);

  describe('authorization code', () => {
    it('marks the stored row used', async () => {
      build([authCodeRow()]);

      await exchange();

      expect(codes.row('code-1')!.isUsed).toBe(true);
    });

    it('refuses a second redemption and mints only the first pair', async () => {
      build([authCodeRow()]);

      await exchange();
      await expect(exchange()).rejects.toThrow('Authorization code has already been used');

      expect(tokens.rows().map((t) => t.tokenType).sort()).toEqual(['access', 'refresh']);
    });

    it('revokes what the first redemption issued when the code is replayed', async () => {
      build([authCodeRow()]);

      await exchange();
      expect(tokens.rows().every((t) => t.isRevoked === false)).toBe(true);

      await expect(exchange()).rejects.toThrow(UnauthorizedException);

      expect(tokens.rows()).toHaveLength(2);
      expect(tokens.rows().every((t) => t.isRevoked === true)).toBe(true);
    });

    // The reader saw an unused code; by the time it claimed it, another
    // redemption had taken it. The loser is refused and mints nothing.
    it('refuses a redemption that lost the claim race', async () => {
      build([authCodeRow()]);
      codes.findOne.mockImplementationOnce(async () => {
        await codes.update({ id: 'code-1', isUsed: false }, { isUsed: true });
        return authCodeRow();
      });

      await expect(exchange()).rejects.toThrow('Authorization code has already been used');
      expect(tokens.rows()).toHaveLength(0);
    });
  });

  describe('refresh token rotation', () => {
    it('revokes the stored row it rotated out and links the new pair to it', async () => {
      build([], [refreshRow()]);

      await refresh();

      expect(tokens.row('refresh-1')!.isRevoked).toBe(true);
      const minted = tokens.rows().filter((t) => t.id !== 'refresh-1');
      expect(minted).toHaveLength(2);
      expect(minted.every((t) => t.parentTokenId === 'refresh-1' && !t.isRevoked)).toBe(true);
    });

    it('refuses a second rotation of the same token and burns the lineage', async () => {
      build([], [refreshRow()]);

      await refresh();
      await expect(refresh()).rejects.toThrow('Refresh token has been revoked');

      expect(tokens.rows()).toHaveLength(3);
      expect(tokens.rows().every((t) => t.isRevoked === true)).toBe(true);
    });

    // Without the `claim.affected !== 1` refusal, two callers racing one
    // stolen refresh token both walk away with a valid pair.
    it('refuses a rotation that lost the race and mints nothing', async () => {
      build([], [refreshRow()]);
      tokens.findOne.mockImplementationOnce(async () => {
        await tokens.update({ id: 'refresh-1', isRevoked: false }, { isRevoked: true });
        return refreshRow();
      });

      await expect(refresh()).rejects.toThrow('Refresh token has been revoked');
      expect(tokens.rows()).toHaveLength(1);
    });
  });

  describe('scoping', () => {
    it('will not redeem a code issued for another gateway', async () => {
      build([authCodeRow({ gatewayId: 'gateway-2' })]);

      await expect(exchange()).rejects.toThrow('Invalid authorization code');
      expect(codes.row('code-1')!.isUsed).toBe(false);
    });

    it('will not redeem a code issued to another client', async () => {
      build([authCodeRow({ clientId: 'mcp_client_other' })]);

      await expect(exchange()).rejects.toThrow('Invalid authorization code');
    });

    it('will not rotate a refresh token issued for another gateway', async () => {
      build([], [refreshRow({ gatewayId: 'gateway-2' })]);

      await expect(refresh()).rejects.toThrow('Invalid refresh token');
      expect(tokens.row('refresh-1')!.isRevoked).toBe(false);
    });

    it('will not rotate an access token presented as a refresh token', async () => {
      build([], [refreshRow({ tokenType: 'access' })]);

      await expect(refresh()).rejects.toThrow('Invalid refresh token');
    });
  });
});
