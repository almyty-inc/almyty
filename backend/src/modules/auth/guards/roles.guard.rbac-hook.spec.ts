import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY, PERMISSIONS_KEY } from './roles.guard';
import { OrganizationRole } from '../../../entities/user-organization.entity';

/**
 * EE hook seam: the optional ADVANCED_RBAC_HOOK lets custom-role grants
 * ALLOW what built-in roles would deny (additive), and ABAC deny-overrides
 * DENY what built-ins would allow. Without the hook the guard is fully
 * synchronous and byte-for-byte the community behavior (covered by
 * roles.guard.spec.ts; a sample is re-asserted here).
 */
describe('RolesGuard — advanced RBAC hook', () => {
  let reflector: Reflector;

  const abstainHook = () => ({
    hasPermission: jest.fn(
      async (_org: string, _user: string, _perm: string): Promise<boolean> => false,
    ),
    evaluateAccess: jest.fn(
      async (_org: string, _action: string, _ctx: any): Promise<any> => ({ effect: 'abstain' }),
    ),
  });

  const createMockContext = (request: any): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: jest.fn(),
      getClass: jest.fn(),
    }) as any;

  const memberRequest = (overrides: any = {}) => ({
    method: 'POST',
    url: '/tools',
    user: {
      id: 'user-1',
      organizationMemberships: [
        {
          organization: { id: 'org-1' },
          role: OrganizationRole.MEMBER,
          hasPermission: (perm: string) => ['read'].includes(perm),
        },
      ],
    },
    params: { organizationId: 'org-1' },
    ...overrides,
  });

  const requires = (roles?: OrganizationRole[], permissions?: string[]) => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
      if (key === ROLES_KEY) return roles;
      if (key === PERMISSIONS_KEY) return permissions;
      return undefined;
    });
  };

  beforeEach(() => {
    reflector = new Reflector();
  });

  describe('community build (no hook): synchronous behavior preserved', () => {
    it('returns a plain boolean, not a promise', () => {
      const guard = new RolesGuard(reflector);
      requires([OrganizationRole.MEMBER]);
      const result = guard.canActivate(createMockContext(memberRequest()));
      expect(result).toBe(true);
    });

    it('throws synchronously on a denied permission', () => {
      const guard = new RolesGuard(reflector);
      requires(undefined, ['delete']);
      expect(() => guard.canActivate(createMockContext(memberRequest()))).toThrow(
        new ForbiddenException('Insufficient permissions'),
      );
    });
  });

  describe('additive custom-role grants', () => {
    it('allows a missing permission covered by a custom role', async () => {
      const hook = abstainHook();
      hook.hasPermission.mockImplementation(async (_o: any, _u: any, perm: any) => perm === 'delete');
      const guard = new RolesGuard(reflector, hook);
      requires(undefined, ['delete']);

      await expect(guard.canActivate(createMockContext(memberRequest()))).resolves.toBe(true);
      expect(hook.hasPermission).toHaveBeenCalledWith('org-1', 'user-1', 'delete');
    });

    it('still denies when the custom roles do not cover the permission', async () => {
      const guard = new RolesGuard(reflector, abstainHook());
      requires(undefined, ['delete']);

      await expect(guard.canActivate(createMockContext(memberRequest()))).rejects.toThrow(
        new ForbiddenException('Insufficient permissions'),
      );
    });

    it('satisfies a required role via the role:<name> pseudo-permission', async () => {
      const hook = abstainHook();
      hook.hasPermission.mockImplementation(async (_o: any, _u: any, perm: any) => perm === 'role:admin');
      const guard = new RolesGuard(reflector, hook);
      requires([OrganizationRole.ADMIN]);

      await expect(guard.canActivate(createMockContext(memberRequest()))).resolves.toBe(true);
      expect(hook.hasPermission).toHaveBeenCalledWith('org-1', 'user-1', 'role:admin');
    });

    it('still denies a required role without a matching grant', async () => {
      const guard = new RolesGuard(reflector, abstainHook());
      requires([OrganizationRole.ADMIN]);

      await expect(guard.canActivate(createMockContext(memberRequest()))).rejects.toThrow(
        new ForbiddenException('Insufficient role privileges'),
      );
    });

    it('does not consult the hook when the built-in checks pass', async () => {
      const hook = abstainHook();
      const guard = new RolesGuard(reflector, hook);
      requires([OrganizationRole.MEMBER], ['read']);

      await expect(guard.canActivate(createMockContext(memberRequest()))).resolves.toBe(true);
      expect(hook.hasPermission).not.toHaveBeenCalled();
    });

    it('a throwing hasPermission behaves like community (denied)', async () => {
      const hook = abstainHook();
      hook.hasPermission.mockRejectedValue(new Error('boom'));
      const guard = new RolesGuard(reflector, hook);
      requires(undefined, ['delete']);

      await expect(guard.canActivate(createMockContext(memberRequest()))).rejects.toThrow(
        new ForbiddenException('Insufficient permissions'),
      );
    });
  });

  describe('ABAC deny-overrides', () => {
    it('denies a request the built-in checks would allow', async () => {
      const hook = abstainHook();
      hook.evaluateAccess.mockResolvedValue({
        effect: 'deny' as const,
        reason: 'denied by policy "after-hours lockout"',
      });
      const guard = new RolesGuard(reflector, hook);
      requires([OrganizationRole.MEMBER], ['read']);

      await expect(guard.canActivate(createMockContext(memberRequest()))).rejects.toThrow(
        new ForbiddenException('denied by policy "after-hours lockout"'),
      );
      expect(hook.evaluateAccess).toHaveBeenCalledWith(
        'org-1',
        'read',
        expect.objectContaining({
          subject: { id: 'user-1', role: OrganizationRole.MEMBER },
          context: expect.objectContaining({ organizationId: 'org-1', method: 'POST' }),
        }),
      );
    });

    it('abstain leaves the built-in allow unchanged', async () => {
      const guard = new RolesGuard(reflector, abstainHook());
      requires([OrganizationRole.MEMBER]);

      await expect(guard.canActivate(createMockContext(memberRequest()))).resolves.toBe(true);
    });

    it('allow effect does not bypass built-in denials', async () => {
      const hook = abstainHook();
      hook.evaluateAccess.mockResolvedValue({ effect: 'allow' as const, reason: 'allowed' });
      const guard = new RolesGuard(reflector, hook);
      requires([OrganizationRole.OWNER]);

      await expect(guard.canActivate(createMockContext(memberRequest()))).rejects.toThrow(
        new ForbiddenException('Insufficient role privileges'),
      );
    });

    it('a throwing evaluateAccess behaves like community (allowed)', async () => {
      const hook = abstainHook();
      hook.evaluateAccess.mockRejectedValue(new Error('boom'));
      const guard = new RolesGuard(reflector, hook);
      requires([OrganizationRole.MEMBER]);

      await expect(guard.canActivate(createMockContext(memberRequest()))).resolves.toBe(true);
    });
  });
});
