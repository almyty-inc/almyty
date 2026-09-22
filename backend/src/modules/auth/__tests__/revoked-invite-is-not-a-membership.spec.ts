import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User } from '../../../entities/user.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { RolesGuard, ROLES_KEY } from '../guards/roles.guard';
import { JwtStrategy } from '../strategies/jwt.strategy';

/**
 * An organization invites somebody, then revokes the invite.
 *
 * `revokePendingInvite` clears the token and sets `isActive = false`; the
 * row itself stays. `JwtStrategy` accepted `X-Organization-Id` for any org
 * a row existed for, and `RolesGuard` then handed out the role written on
 * that row — so the revoked invitee could act as an admin of an
 * organization they were never a member of, on every route that trusts
 * `currentOrganizationId` (the audit log, gateways, tools, agents...).
 *
 * The pending case is the same defect one step earlier: before this, a
 * membership row created by `inviteUser` granted full access the moment
 * the invite was sent, which made the accept endpoint and its seven-day
 * expiry decorative.
 */
describe('a revoked or pending invite is not a membership', () => {
  const VICTIM_ORG = 'org-victim';

  function userWith(membership: Record<string, unknown>): any {
    return {
      id: 'u-attacker',
      email: 'attacker@example.com',
      isActive: true,
      tokenVersion: 0,
      organizationMemberships: [membership],
    };
  }

  /** The row `revokePendingInvite` leaves behind. */
  const REVOKED_INVITE = {
    organizationId: VICTIM_ORG,
    role: OrganizationRole.ADMIN,
    isActive: false,
    inviteAccepted: false,
    inviteToken: null,
    organization: { id: VICTIM_ORG, name: 'Victim Corp' },
  };

  /** The row `inviteUser` writes for an existing account. */
  const PENDING_INVITE = {
    organizationId: VICTIM_ORG,
    role: OrganizationRole.ADMIN,
    isActive: true,
    inviteAccepted: false,
    inviteToken: 'tok-abc',
    organization: { id: VICTIM_ORG, name: 'Victim Corp' },
  };

  const ACCEPTED = {
    organizationId: VICTIM_ORG,
    role: OrganizationRole.ADMIN,
    isActive: true,
    inviteAccepted: true,
    inviteToken: null,
    organization: { id: VICTIM_ORG, name: 'Victim Corp' },
  };

  describe('JwtStrategy.validate', () => {
    let strategy: JwtStrategy;
    let userRepository: { findOne: jest.Mock };

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          JwtStrategy,
          { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test-secret') } },
          { provide: getRepositoryToken(User), useValue: { findOne: jest.fn() } },
        ],
      }).compile();
      strategy = module.get(JwtStrategy);
      userRepository = module.get(getRepositoryToken(User));
    });

    const payload = { sub: 'u-attacker', email: 'attacker@example.com' } as any;
    const withHeader = { headers: { 'x-organization-id': VICTIM_ORG } } as any;

    it('refuses X-Organization-Id naming an org whose invite was revoked', async () => {
      userRepository.findOne.mockResolvedValue(userWith(REVOKED_INVITE));
      await expect(strategy.validate(withHeader, payload)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('refuses X-Organization-Id naming an org whose invite is unaccepted', async () => {
      userRepository.findOne.mockResolvedValue(userWith(PENDING_INVITE));
      await expect(strategy.validate(withHeader, payload)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('accepts it once the invite has been accepted', async () => {
      userRepository.findOne.mockResolvedValue(userWith(ACCEPTED));
      const user: any = await strategy.validate(withHeader, payload);
      expect(user.currentOrganizationId).toBe(VICTIM_ORG);
    });

    it('does not fall back to a revoked invite as the single org', async () => {
      // No header, one row — but that row grants nothing, so the request
      // ends up with no org context rather than the victim's.
      userRepository.findOne.mockResolvedValue(userWith(REVOKED_INVITE));
      const user: any = await strategy.validate({ headers: {} } as any, payload);
      expect(user.currentOrganizationId).toBeUndefined();
    });

    it('leaves a revoked org out of the attached org list', async () => {
      userRepository.findOne.mockResolvedValue(userWith(REVOKED_INVITE));
      const user: any = await strategy.validate({ headers: {} } as any, payload);
      expect(user.organizations).toEqual([]);
    });
  });

  describe('RolesGuard', () => {
    function guardFor(membership: Record<string, unknown>) {
      const reflector = {
        getAllAndOverride: jest.fn((key: string) =>
          key === ROLES_KEY ? [OrganizationRole.ADMIN] : undefined,
        ),
      } as unknown as Reflector;
      const guard = new RolesGuard(reflector);
      const context = {
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({
          getRequest: () => ({
            user: { ...userWith(membership), currentOrganizationId: VICTIM_ORG },
            params: {},
          }),
        }),
      } as unknown as ExecutionContext;
      return { guard, context };
    }

    it('refuses the role written on a revoked invite', () => {
      const { guard, context } = guardFor(REVOKED_INVITE);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('refuses the role written on a pending invite', () => {
      const { guard, context } = guardFor(PENDING_INVITE);
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('allows a real member', () => {
      const { guard, context } = guardFor(ACCEPTED);
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('User.hasPermissionInOrganization', () => {
    function userEntity(membership: Record<string, unknown>): User {
      const user = new User();
      (user as any).organizationMemberships = [membership];
      return user;
    }

    it('grants nothing on a revoked invite', () => {
      expect(userEntity(REVOKED_INVITE).hasPermissionInOrganization(VICTIM_ORG, 'read')).toBe(
        false,
      );
    });

    it('grants nothing on a pending invite', () => {
      expect(userEntity(PENDING_INVITE).hasPermissionInOrganization(VICTIM_ORG, 'read')).toBe(
        false,
      );
    });

    it('grants on an accepted membership', () => {
      expect(userEntity(ACCEPTED).hasPermissionInOrganization(VICTIM_ORG, 'read')).toBe(true);
    });
  });
});
