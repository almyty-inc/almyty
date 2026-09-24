import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

import { McpOAuthTokensHelper } from '../services/mcp-oauth-tokens.helper';
import { fakeRepo, FakeRepo } from './oauth-repo.fixtures';

/**
 * An authorization code and a refresh token are each good exactly once.
 *
 * Both are enforced by a compare-and-set in `mcp-oauth-tokens.helper.ts`:
 * a conditional `UPDATE ... WHERE id = ? AND isUsed = false` (resp.
 * `isRevoked = false`), and a rejection when it reports anything other than
 * one affected row. That branch is the whole point of the shape — it is
 * what makes a redemption that lost a race fail instead of minting a second
 * valid token pair.
 *
 * `mcp-oauth.service.spec.ts` drives the same helper through repository
 * doubles whose `update` answers `{ affected: 1 }` regardless of criteria,
 * so the CAS there can only ever be observed succeeding. One of its tests
 * pins the code branch by stubbing `affected: 0` by hand; nothing pinned
 * the refresh-rotation branch at all, and deleting it left that suite at
 * 80/80.
 *
 * This suite runs the helper against tables that actually evaluate the
 * criteria, so single-use is proved by the state the writes leave behind
 * rather than by the arguments they were called with.
 */
describe('OAuth single-use semantics (store-backed)', () => {
  const GATEWAY = 'gateway-1';
  const ORG = 'org-1';
  const USER = 'user-1';
  const CLIENT = 'mcp_client_abc123';

  const sha256 = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

  let clients: FakeRepo<any>;
  let codes: FakeRepo<any>;
  let tokens: FakeRepo<any>;
  let helper: McpOAuthTokensHelper;

  const RAW_CODE = 'test-authorization-code';
  const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const CODE_CHALLENGE = crypto
    .createHash('sha256')
    .update(CODE_VERIFIER)
    .digest('base64url');
  const REDIRECT_URI = 'https://example.com/callback';

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
      tokenHash: sha256('almyty_rt_seed'),
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
    clients = fakeRepo<any>(
      [
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
      'client',
    );
    codes = fakeRepo<any>(codeRows, 'code');
    tokens = fakeRepo<any>(tokenRows, 'token');
    helper = new McpOAuthTokensHelper(clients as any, codes as any, tokens as any);
  }

  const exchange = () =>
    helper.exchangeCode(RAW_CODE, CLIENT, CODE_VERIFIER, REDIRECT_URI, GATEWAY);

  // -------------------------------------------------------------------------
  // Authorization code
  // -------------------------------------------------------------------------

  describe('authorization code', () => {
    it('marks the stored row used, not just the entity it was handed', async () => {
      build([authCodeRow()]);

      await exchange();

      expect(codes.row('code-1').isUsed).toBe(true);
    });

    it('refuses the second redemption of the same code', async () => {
      build([authCodeRow()]);

      await exchange();

      await expect(exchange()).rejects.toThrow('Authorization code has already been used');
    });

    it('mints exactly one token pair across a redemption and a replay', async () => {
      build([authCodeRow()]);

      await exchange();
      await expect(exchange()).rejects.toThrow(UnauthorizedException);

      // Two rows: the access token and the refresh token of the one
      // successful exchange. A replay that got past the guard would have
      // left four.
      const issued = tokens.rows();
      expect(issued).toHaveLength(2);
      expect(issued.map((t: any) => t.tokenType).sort()).toEqual(['access', 'refresh']);
    });

    it('revokes the tokens already issued for that user+gateway when a code is replayed', async () => {
      build([authCodeRow()]);

      await exchange();
      await expect(exchange()).rejects.toThrow(UnauthorizedException);

      // Replay is treated as a stolen code: everything the first
      // redemption minted is burned, not left live alongside the refusal.
      expect(tokens.rows().every((t: any) => t.isRevoked === true)).toBe(true);
    });

    /**
     * The compare-and-set branch itself: the reader saw an unused code, and
     * by the time it went to claim it another redemption had taken it. The
     * loser must be refused, and must not mint a pair.
     */
    it('refuses a redemption that lost the claim race', async () => {
      build([authCodeRow()]);

      // Hand out the pre-race snapshot, then let the other racer win.
      const stale = authCodeRow();
      codes.findOne.mockImplementationOnce(async () => {
        await codes.update({ id: 'code-1', isUsed: false }, { isUsed: true });
        return { ...stale };
      });

      await expect(exchange()).rejects.toThrow('Authorization code has already been used');
      expect(tokens.rows()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Refresh token rotation
  // -------------------------------------------------------------------------

  describe('refresh token rotation', () => {
    const RAW_RT = 'almyty_rt_seed';

    const refresh = (raw = RAW_RT) => helper.refreshToken(raw, CLIENT, GATEWAY);

    it('revokes the stored row it rotated out', async () => {
      build([], [refreshRow()]);

      await refresh();

      expect(tokens.row('refresh-1').isRevoked).toBe(true);
    });

    it('refuses a second rotation of the same refresh token', async () => {
      build([], [refreshRow()]);

      await refresh();

      await expect(refresh()).rejects.toThrow('Refresh token has been revoked');
    });

    it('burns the whole lineage when a rotated refresh token is presented again', async () => {
      build([], [refreshRow()]);

      await refresh();
      await expect(refresh()).rejects.toThrow(UnauthorizedException);

      // Reuse of a rotated token is the classic stolen-token signal, so
      // every live token for this (client, user, gateway) goes with it.
      expect(tokens.rows().every((t: any) => t.isRevoked === true)).toBe(true);
    });

    /**
     * The branch that had nothing holding it: `claim.affected !== 1` on the
     * rotation. Replacing it with a condition that never fires left
     * `mcp-oauth.service.spec.ts` at 80 passed, 80 total.
     *
     * Without it, two callers racing a single stolen refresh token both
     * walk away with a valid, unrelated token pair.
     */
    it('refuses a rotation that lost the race and mints nothing', async () => {
      build([], [refreshRow()]);

      const stale = refreshRow();
      tokens.findOne.mockImplementationOnce(async () => {
        await tokens.update({ id: 'refresh-1', isRevoked: false }, { isRevoked: true });
        return { ...stale };
      });

      await expect(refresh()).rejects.toThrow('Refresh token has been revoked');

      // Only the seeded row is in the table: the loser minted no pair.
      expect(tokens.rows()).toHaveLength(1);
      expect(tokens.row('refresh-1').isRevoked).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Cross-gateway scoping, against a table rather than a call recorder
  // -------------------------------------------------------------------------

  describe('cross-gateway scoping', () => {
    it('will not redeem a code issued for another gateway', async () => {
      build([authCodeRow({ gatewayId: 'gateway-2' })]);

      await expect(exchange()).rejects.toThrow('Invalid authorization code');
      expect(codes.row('code-1').isUsed).toBe(false);
    });

    it('will not rotate a refresh token issued for another gateway', async () => {
      build([], [refreshRow({ gatewayId: 'gateway-2' })]);

      await expect(helper.refreshToken(RAW_CODE, CLIENT, GATEWAY)).rejects.toThrow(
        'Invalid refresh token',
      );
    });

    it('will not redeem a code belonging to another client', async () => {
      build([authCodeRow({ clientId: 'mcp_client_other' })]);

      await expect(exchange()).rejects.toThrow('Invalid authorization code');
    });
  });
});
