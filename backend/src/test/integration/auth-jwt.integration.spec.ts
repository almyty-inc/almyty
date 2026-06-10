/**
 * Real-JWT integration spec for AuthService.
 *
 * The main auth.service.spec.ts in this module mocks JwtService.sign
 * and JwtService.verify with `jest.fn()` and asserts the mock was
 * called. That's fine for the flow-level tests (register/login/refresh
 * return what they should) but it means the real JWT plumbing — the
 * signing algorithm, the claim structure, the tamper-detection, the
 * refresh-vs-access type discrimination, the expiry enforcement — is
 * completely unexercised by the suite. A "change payload.sub when
 * re-signing" bug, a wrong-secret bug, or a forgotten `type === 'refresh'`
 * check on the refresh path could all slip past the mocked tests and
 * only surface in production.
 *
 * This file closes that gap. It instantiates a REAL JwtService with
 * a real test secret and exercises the sign → verify round trip,
 * the tamper-detection behaviour, the expiry behaviour, and the
 * refresh-token type gate. The repositories are still mocked because
 * this spec cares about JWTs, not DB queries — the cross-tenant DB
 * behaviour is covered by src/test/integration/cross-tenant-isolation
 * and the bump-stats spec.
 */
// src/test/setup.ts installs a global `jest.mock('jsonwebtoken', ...)`
// that short-circuits sign/verify with a stub. That stub is fine for
// most specs in the repo but it's the entire point of this file to
// prove the REAL signing/verifying behaviour, so undo it here. Must
// run BEFORE the imports below since `@nestjs/jwt` pulls jsonwebtoken
// transitively and will otherwise capture the mocked version.
jest.unmock('jsonwebtoken');
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';

import { AuthService, JwtPayload } from '../../modules/auth/auth.service';
import { User } from '../../entities/user.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';

const TEST_SECRET = 'test-jwt-secret-0123456789abcdef';

// Build an AuthService that:
//   - uses a REAL @nestjs/jwt JwtService (with a test secret)
//   - uses throwaway repository stubs (findOne returns the user we plant)
// The minimal shape mirrors what the real AuthService constructor
// expects; we only need enough for the JWT code paths.
function buildService(opts: {
  planteduser?: Partial<User> & { id: string };
  planteduserActive?: boolean;
}): { service: AuthService; jwt: JwtService } {
  const jwt = new JwtService({
    secret: TEST_SECRET,
    signOptions: { expiresIn: '24h' },
  });

  const userRepo: any = {
    findOne: jest.fn().mockImplementation(async (args: any) => {
      if (!opts.planteduser) return null;
      const active = opts.planteduserActive ?? true;
      if (!active) return null;
      // Mimic the shape AuthService.generateTokens / validateJwtPayload
      // / refreshToken expect when `relations` is set.
      return {
        id: opts.planteduser.id,
        email: opts.planteduser.email ?? 'u@example.com',
        firstName: opts.planteduser.firstName ?? 'Test',
        lastName: opts.planteduser.lastName ?? 'User',
        isActive: true,
        organizationMemberships: [
          {
            role: OrganizationRole.OWNER,
            organization: { id: 'org-1', name: 'Org One' },
          },
          {
            role: OrganizationRole.MEMBER,
            organization: { id: 'org-2', name: 'Org Two' },
          },
        ],
      };
    }),
    save: jest.fn().mockImplementation(async (u: any) => u),
  };

  const service = new AuthService(
    userRepo,
    { findOne: jest.fn() } as any, // apiKeyRepository
    { findOne: jest.fn() } as any, // organizationRepository
    { findOne: jest.fn() } as any, // userOrganizationRepository
    jwt,
    { log: jest.fn(), logCreate: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn() } as any,
    { sendPasswordReset: jest.fn().mockResolvedValue(true) } as any, // mailService
  );

  return { service, jwt };
}

describe('AuthService — real JWT integration', () => {
  const plantedUser = { id: 'user-abc', email: 'alice@example.com', firstName: 'Alice', lastName: 'A' };

  // ── generateTokens → real sign → verify round-trip ────────────

  describe('generateTokens', () => {
    it('signs an access token that verifies against the configured secret', async () => {
      const { service, jwt } = buildService({ planteduser: plantedUser });
      const tokens = await service.generateTokens(plantedUser as any);

      expect(tokens.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/); // real JWT structure
      expect(tokens.expiresIn).toBe(86_400);

      const decoded = jwt.verify<JwtPayload>(tokens.accessToken);
      expect(decoded.sub).toBe('user-abc');
      expect(decoded.email).toBe('alice@example.com');
      expect(decoded.firstName).toBe('Alice');
      expect(decoded.lastName).toBe('A');
      expect(decoded.organizations).toHaveLength(2);
      expect(decoded.organizations[0]).toMatchObject({
        id: 'org-1',
        name: 'Org One',
        role: OrganizationRole.OWNER,
      });
      expect(decoded.iat).toBeGreaterThan(0);
      expect(decoded.exp).toBeGreaterThan(decoded.iat!);
    });

    it('signs a refresh token with type=refresh so refreshToken() accepts it', async () => {
      const { service, jwt } = buildService({ planteduser: plantedUser });
      const tokens = await service.generateTokens(plantedUser as any);

      const refreshDecoded = jwt.verify<any>(tokens.refreshToken);
      expect(refreshDecoded.sub).toBe('user-abc');
      expect(refreshDecoded.type).toBe('refresh');
    });
  });

  // ── refreshToken() type gate — critical security check ───────

  describe('refreshToken', () => {
    it('accepts a legitimate refresh token and issues new tokens', async () => {
      const { service } = buildService({ planteduser: plantedUser });
      const first = await service.generateTokens(plantedUser as any);

      const second = await service.refreshToken(first.refreshToken);
      expect(second.accessToken).toBeTruthy();
      expect(second.refreshToken).toBeTruthy();
      // The new access token may or may not be identical to the old
      // one (same payload + same iat second) — we don't pin equality.
    });

    it('rejects an ACCESS token presented as a refresh token', async () => {
      // Critical: without the payload.type === 'refresh' check, any
      // access token could be used to refresh itself indefinitely,
      // bypassing the short-expiry-access / long-expiry-refresh
      // design. Prove the check works end-to-end.
      const { service } = buildService({ planteduser: plantedUser });
      const tokens = await service.generateTokens(plantedUser as any);

      await expect(service.refreshToken(tokens.accessToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a tampered refresh token (signature invalid)', async () => {
      const { service } = buildService({ planteduser: plantedUser });
      const tokens = await service.generateTokens(plantedUser as any);

      // Flip one character in the signature segment. A proper HMAC
      // check must refuse this regardless of what the payload says.
      const parts = tokens.refreshToken.split('.');
      const tamperedSig = parts[2].replace(/./, (c) => (c === 'a' ? 'b' : 'a'));
      const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;

      await expect(service.refreshToken(tampered)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a refresh token signed by a different secret', async () => {
      // An attacker forging their own refresh token with a secret
      // they control would fail JwtService.verify because the HMAC
      // computation uses the server's secret. Prove it.
      const foreignJwt = new JwtService({ secret: 'attacker-controlled-secret' });
      const forged = foreignJwt.sign({ sub: 'user-abc', type: 'refresh' });

      const { service } = buildService({ planteduser: plantedUser });
      await expect(service.refreshToken(forged)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an expired refresh token', async () => {
      // Build a JwtService that produces already-expired tokens, use
      // it to mint a refresh token, then present it to the real
      // AuthService's refreshToken() — which uses the real (non-
      // expired) JwtService to verify and must refuse.
      const backdatedJwt = new JwtService({
        secret: TEST_SECRET,
        signOptions: { expiresIn: '-1s' }, // already expired
      });
      const expired = backdatedJwt.sign({ sub: 'user-abc', type: 'refresh' });

      const { service } = buildService({ planteduser: plantedUser });
      await expect(service.refreshToken(expired)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a refresh token whose user no longer exists', async () => {
      const { service } = buildService({ planteduser: plantedUser });
      const tokens = await service.generateTokens(plantedUser as any);

      // Rebuild the service with no planted user so the repo findOne
      // returns null — simulating a user that's been deleted since
      // the refresh token was issued.
      const { service: service2 } = buildService({ planteduser: undefined });
      await expect(service2.refreshToken(tokens.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a refresh token whose user has been deactivated', async () => {
      const { service } = buildService({ planteduser: plantedUser });
      const tokens = await service.generateTokens(plantedUser as any);

      const { service: service2 } = buildService({
        planteduser: plantedUser,
        planteduserActive: false,
      });
      await expect(service2.refreshToken(tokens.refreshToken)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  // ── validateJwtPayload direct entry (what the JWT strategy uses) ──

  describe('validateJwtPayload', () => {
    it('returns the user when the payload sub matches a real row', async () => {
      const { service, jwt } = buildService({ planteduser: plantedUser });
      const tokens = await service.generateTokens(plantedUser as any);
      const decoded = jwt.verify<JwtPayload>(tokens.accessToken);

      const user = await service.validateJwtPayload(decoded);
      expect(user?.id).toBe('user-abc');
    });

    it('returns null when the user is inactive', async () => {
      const { service } = buildService({
        planteduser: plantedUser,
        planteduserActive: false,
      });

      const user = await service.validateJwtPayload({
        sub: 'user-abc',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'A',
        organizations: [],
      });
      expect(user).toBeNull();
    });
  });

  // ── Expiry of the access token itself ────────────────────────

  describe('access token expiry', () => {
    it('access tokens expire after exp', async () => {
      // Build a JWT service with a 1 second expiry, sign, sleep, verify.
      const shortJwt = new JwtService({
        secret: TEST_SECRET,
        signOptions: { expiresIn: '1s' },
      });

      // We can't reuse AuthService here because its JwtService is
      // configured with a 24h default — but the point of this test
      // is to pin the contract that the underlying jsonwebtoken
      // library honours the exp claim. If that guarantee ever
      // breaks, every downstream test in this file is lying.
      const tok = shortJwt.sign({ sub: 'user-abc' });
      await new Promise((r) => setTimeout(r, 1_100));
      expect(() => shortJwt.verify(tok)).toThrow(/expired/i);
    });
  });
});
