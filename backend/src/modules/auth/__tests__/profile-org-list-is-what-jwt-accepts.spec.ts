import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { User } from '../../../entities/user.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { AuthController } from '../auth.controller';
import { AuthService } from '../auth.service';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { LocalAuthGuard } from '../guards/local-auth.guard';
import { JwtStrategy } from '../strategies/jwt.strategy';

/**
 * The "double login": sign in, watch the dashboard paint, get bounced
 * straight back to the login page.
 *
 * `GET /auth/profile` is where the web client learns which organizations
 * it may talk to: `initializeFromUser` in the frontend org store maps the
 * payload's `organizationMemberships`, picks one as the current
 * organization, and the axios request interceptor stamps that id into
 * `X-Organization-Id` on every subsequent call.
 *
 * `user_organizations` holds rows that are not memberships — a pending
 * invite, and a revoked one, which revocation deactivates rather than
 * deletes. The relation load has no filter, and this route used to map
 * the relation verbatim while dropping `isActive`/`inviteAccepted`, so
 * the client was handed organizations it could not use AND no way to
 * tell which. Whichever row Postgres happened to return first became
 * `organizations[0]`; when that was an invite row, the very next request
 * carried an org id `JwtStrategy` refuses, the client read the refusal as
 * a dead session and redirected to /auth/login.
 *
 * The invariant: the org list the profile hands out is exactly the set
 * `JwtStrategy` will accept in `X-Organization-Id`. One predicate, both
 * ends.
 */
describe('the profile org list is exactly what JwtStrategy accepts', () => {
  const HOME_ORG = 'org-home';
  const INVITED_ORG = 'org-invited';
  const REVOKED_ORG = 'org-revoked';

  /** The row `inviteUser` writes for an existing account. */
  const PENDING_INVITE = {
    id: 'm-pending',
    organizationId: INVITED_ORG,
    role: OrganizationRole.ADMIN,
    isActive: true,
    inviteAccepted: false,
    inviteToken: 'tok-abc',
    joinedAt: new Date('2026-01-01'),
    organization: { id: INVITED_ORG, name: 'Invited Corp', slug: 'invited-corp' },
  };

  /** The row `revokePendingInvite` leaves behind. */
  const REVOKED_INVITE = {
    id: 'm-revoked',
    organizationId: REVOKED_ORG,
    role: OrganizationRole.ADMIN,
    isActive: false,
    inviteAccepted: false,
    inviteToken: null,
    joinedAt: new Date('2026-01-02'),
    organization: { id: REVOKED_ORG, name: 'Revoked Corp', slug: 'revoked-corp' },
  };

  /** A real membership. */
  const REAL_MEMBERSHIP = {
    id: 'm-home',
    organizationId: HOME_ORG,
    role: OrganizationRole.OWNER,
    isActive: true,
    inviteAccepted: true,
    inviteToken: null,
    joinedAt: new Date('2026-01-03'),
    organization: { id: HOME_ORG, name: 'Home Corp', slug: 'home-corp' },
  };

  /**
   * Rows in the order Postgres returned them on the day this was
   * reported: the invite first, the real membership last. There is no
   * ORDER BY on the relation load, so this order is not stable — which
   * is why the bug looked intermittent.
   */
  const user: any = {
    id: 'u-1',
    email: 'owner@example.com',
    isActive: true,
    tokenVersion: 0,
    passwordHash: 'x',
    resetPasswordToken: null,
    verificationToken: null,
    verifiedAt: new Date('2026-01-01'),
    isVerified: true,
    organizationMemberships: [PENDING_INVITE, REVOKED_INVITE, REAL_MEMBERSHIP],
  };

  let controller: AuthController;
  let strategy: JwtStrategy;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        JwtStrategy,
        { provide: AuthService, useValue: {} },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('test-secret') } },
        {
          provide: getRepositoryToken(User),
          useValue: { findOne: jest.fn().mockResolvedValue(user) },
        },
      ],
    })
      .overrideGuard(LocalAuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get(AuthController);
    strategy = module.get(JwtStrategy);
  });

  async function profileOrgIds(): Promise<string[]> {
    const response: any = await controller.getProfile(user);
    return (response.data.organizationMemberships ?? []).map(
      (membership: any) => membership.organization.id,
    );
  }

  it('leaves a pending invite out of the org list it hands the client', async () => {
    expect(await profileOrgIds()).not.toContain(INVITED_ORG);
  });

  it('leaves a revoked invite out of the org list it hands the client', async () => {
    expect(await profileOrgIds()).not.toContain(REVOKED_ORG);
  });

  it('hands out only real memberships', async () => {
    expect(await profileOrgIds()).toEqual([HOME_ORG]);
  });

  /**
   * The load-bearing one. The client picks `organizations[0]` when it has
   * no prior selection, so the first entry must be an org the very next
   * request can actually be made against.
   */
  it('never puts an org JwtStrategy refuses first in the list', async () => {
    const [first] = await profileOrgIds();
    const payload = { sub: user.id, email: user.email, tv: 0 } as any;

    await expect(
      strategy.validate({ headers: { 'x-organization-id': first } } as any, payload),
    ).resolves.toMatchObject({ currentOrganizationId: first });
  });

  it('every org the profile lists is one JwtStrategy accepts', async () => {
    const payload = { sub: user.id, email: user.email, tv: 0 } as any;
    for (const orgId of await profileOrgIds()) {
      await expect(
        strategy.validate({ headers: { 'x-organization-id': orgId } } as any, payload),
      ).resolves.toMatchObject({ currentOrganizationId: orgId });
    }
  });

  it('still refuses an org id the profile did not list', async () => {
    const payload = { sub: user.id, email: user.email, tv: 0 } as any;
    await expect(
      strategy.validate({ headers: { 'x-organization-id': INVITED_ORG } } as any, payload),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * The status has to survive the guard, not just leave the strategy.
   *
   * `JwtAuthGuard` is `AuthGuard(['jwt', 'api-key'])`, and its
   * `handleRequest` rethrows whatever the strategy raised rather than
   * flattening it — which is the only reason a 403 here reaches the
   * client as a 403. If that ever became `new UnauthorizedException()`,
   * the strategy's careful choice would be undone one layer up and the
   * sign-out bounce would come back.
   */
  it('the guard passes the 403 through rather than flattening it to 401', () => {
    const guard = new JwtAuthGuard({
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    } as any);
    const refusal = new ForbiddenException({
      code: 'ORGANIZATION_CONTEXT_INVALID',
      message: 'Not a member of the requested organization',
    });

    expect(() => guard.handleRequest(refusal, null, undefined, {} as any)).toThrow(refusal);
  });
});
