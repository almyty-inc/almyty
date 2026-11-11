import { ForbiddenException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

import { AuthService } from '../auth.service';
import { AuthController } from '../auth.controller';
import { AuthSessionService } from '../auth-session.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

/**
 * Settings > Security > "Sign out other devices".
 *
 * Every other session has to stop working, the person asking has to stay
 * signed in, and it has to be on the record. An API key must not be able
 * to do it: re-issuing a session to a key would hand the key a browser
 * login.
 */
describe('sign out other devices', () => {
  const tokens = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 86400 };

  function build() {
    const order: string[] = [];
    const userRepository: any = {
      increment: jest.fn(async () => {
        order.push('bump');
        return { affected: 1 };
      }),
    };
    const authSessions: any = {
      revokeAllForUser: jest.fn(async () => {
        order.push('revoke');
        return 3;
      }),
    };
    const auditLogService: any = { log: jest.fn(async () => null) };
    const service = new AuthService(
      userRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      auditLogService,
      {} as any,
      {} as any,
      authSessions,
    );
    const generateTokens = jest.spyOn(service, 'generateTokens').mockImplementation(async () => {
      order.push('mint');
      return tokens;
    });
    return { service, userRepository, authSessions, auditLogService, generateTokens, order };
  }

  const member = {
    id: 'u-1',
    email: 'dana@example.com',
    organizationMemberships: [
      { organizationId: 'org-1', isActive: true, inviteAccepted: true, organization: { id: 'org-1' } },
    ],
  } as any;

  describe('AuthService.revokeOtherSessions', () => {
    it('bumps tokenVersion, ends every session, then mints a new one for the caller', async () => {
      const { service, userRepository, authSessions, generateTokens, order } = build();

      const result = await service.revokeOtherSessions(member, { sessionId: 's-here', organizationId: 'org-1' });

      expect(userRepository.increment).toHaveBeenCalledWith({ id: 'u-1' }, 'tokenVersion', 1);
      expect(authSessions.revokeAllForUser).toHaveBeenCalledWith('u-1', 'signed_out_elsewhere');
      // Minted after the bump, so the new token carries the new version.
      expect(order).toEqual(['bump', 'revoke', 'mint']);
      expect(generateTokens).toHaveBeenCalledWith(member, { ssoOrganizationId: undefined });
      // Three live sessions, one of them the caller's.
      expect(result).toEqual({ tokens, signedOut: 2 });
    });

    it('keeps a single sign-on session scoped to its organization', async () => {
      const { service, generateTokens } = build();
      const ssoUser = { ...member, ssoOrganizationId: 'org-1' };

      await service.revokeOtherSessions(ssoUser, { sessionId: 's-here' });

      expect(generateTokens).toHaveBeenCalledWith(ssoUser, { ssoOrganizationId: 'org-1' });
    });

    it('works for an account without a password', async () => {
      const { service, userRepository } = build();
      const noPassword = { ...member, hasPassword: false, passwordHash: null };

      const result = await service.revokeOtherSessions(noPassword, { sessionId: 's-here' });

      expect(userRepository.increment).toHaveBeenCalled();
      expect(result.tokens).toBe(tokens);
    });

    it('records it in the audit trail of the organization the caller is in', async () => {
      const { service, auditLogService } = build();

      await service.revokeOtherSessions(member, {
        sessionId: 's-here',
        organizationId: 'org-1',
        ipAddress: '203.0.113.9',
        userAgent: 'Firefox',
      });

      expect(auditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          userId: 'u-1',
          action: AuditAction.SESSIONS_REVOKE,
          resourceType: AuditResource.USER,
          resourceId: 'u-1',
          details: { signedOut: 2 },
          ipAddress: '203.0.113.9',
          userAgent: 'Firefox',
        }),
      );
    });

    it('falls back to the first organization when no organization is selected', async () => {
      const { service, auditLogService } = build();

      await service.revokeOtherSessions(member, { sessionId: 's-here' });

      expect(auditLogService.log).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
    });

    it('refuses a caller without a session (an API key), before touching anything', async () => {
      const { service, userRepository, authSessions, generateTokens } = build();

      await expect(service.revokeOtherSessions(member, {})).rejects.toThrow(ForbiddenException);
      expect(userRepository.increment).not.toHaveBeenCalled();
      expect(authSessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(generateTokens).not.toHaveBeenCalled();
    });
  });

  describe('AuthSessionService.revokeAllForUser', () => {
    it('ends every open session of the user and counts the live ones', async () => {
      const repo: any = { count: jest.fn(async () => 4), update: jest.fn(async () => ({ affected: 5 })) };
      const sessions = new AuthSessionService(repo);

      await expect(sessions.revokeAllForUser('u-1', 'signed_out_elsewhere')).resolves.toBe(4);

      const [criteria, values] = repo.update.mock.calls[0];
      expect(criteria.userId).toBe('u-1');
      expect(criteria).toHaveProperty('revokedAt');
      expect(values).toEqual({ revokedAt: expect.any(Date), revokedReason: 'signed_out_elsewhere' });
    });
  });

  describe('POST /auth/sessions/revoke-others', () => {
    function call(user: any) {
      const authService: any = { revokeOtherSessions: jest.fn(async () => ({ tokens, signedOut: 2 })) };
      const controller = new AuthController(authService);
      const res: any = { cookie: jest.fn() };
      const req: any = { headers: { 'user-agent': 'Firefox', 'x-forwarded-for': '203.0.113.9' }, ip: '127.0.0.1' };
      return { authService, res, run: () => controller.revokeOtherSessions(user, req, res) };
    }

    it('passes the session, organization and client to the service', async () => {
      const { authService, run } = call({ ...member, sessionId: 's-here', currentOrganizationId: 'org-1' });
      await run();

      expect(authService.revokeOtherSessions).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'u-1' }),
        { sessionId: 's-here', organizationId: 'org-1', ipAddress: '203.0.113.9', userAgent: 'Firefox' },
      );
    });

    it('sets the new session as an httpOnly cookie and puts no token in the body', async () => {
      const { res, run } = call({ ...member, sessionId: 's-here' });
      const body = await run();

      expect(res.cookie).toHaveBeenCalledWith('access_token', 'new-access', expect.objectContaining({ httpOnly: true, path: '/' }));
      expect(body.data).toEqual({ signedOut: 2, expiresIn: 86400 });
      expect(JSON.stringify(body)).not.toContain('new-access');
      expect(JSON.stringify(body)).not.toContain('new-refresh');
    });

    it('is signed-in only and rate limited', () => {
      const source = readFileSync(join(__dirname, '..', 'auth.controller.ts'), 'utf8');
      const route = source.slice(source.lastIndexOf('@UseGuards', source.indexOf("@Post('sessions/revoke-others')")));
      const decorators = route.slice(0, route.indexOf('async revokeOtherSessions'));
      expect(decorators).toContain('@UseGuards(JwtAuthGuard)');
      expect(decorators).toMatch(/@Throttle\(\{ default: \{ limit: \d+, ttl: [^}]+\} \}\)/);
      expect(decorators).not.toContain('@Public()');
    });
  });
});
