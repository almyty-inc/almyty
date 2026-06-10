import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard, ROLES_KEY, PERMISSIONS_KEY } from './roles.guard';
import { OrganizationRole } from '../../../entities/user-organization.entity';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  const createMockContext = (request: any): ExecutionContext => ({
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: jest.fn(),
    getClass: jest.fn(),
  } as any);

  describe('Real Business Logic - Authorization Checks', () => {
    describe('No roles or permissions required', () => {
      it('should allow access when no roles or permissions are required', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);

        const mockContext = createMockContext({});

        const result = guard.canActivate(mockContext);

        expect(result).toBe(true);
      });
    });

    describe('User authentication checks', () => {
      it('should throw ForbiddenException when user is not authenticated', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: null,
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('User not authenticated')
        );
      });

      it('should throw ForbiddenException when user is undefined', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({});

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('User not authenticated')
        );
      });
    });

    describe('Organization context checks', () => {
      it('should throw ForbiddenException when organization ID is missing', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: { id: 'user-1' },
          params: {},
          query: {},
          body: {},
          headers: {},
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('Organization context required')
        );
      });

      it('should extract organization ID from params', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.MEMBER,
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        const result = guard.canActivate(mockContext);
        expect(result).toBe(true);
      });

      it('should resolve organization from currentOrganizationId', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            currentOrganizationId: 'org-1',
            organizationMemberships: [
              { organization: { id: 'org-1' }, role: OrganizationRole.MEMBER },
            ],
          },
          params: {},
        });

        expect(guard.canActivate(mockContext)).toBe(true);
      });

      it('should resolve organization from path params', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              { organization: { id: 'org-1' }, role: OrganizationRole.MEMBER },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        expect(guard.canActivate(mockContext)).toBe(true);
      });

      it('should prioritize path params over currentOrganizationId', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            currentOrganizationId: 'org-other',
            organizationMemberships: [
              { organization: { id: 'org-from-params' }, role: OrganizationRole.MEMBER },
            ],
          },
          params: { organizationId: 'org-from-params' },
        });

        expect(guard.canActivate(mockContext)).toBe(true);
      });

      it('should NOT trust a query/body/header org id for the role check (cross-tenant escalation)', () => {
        // The attacker is OWNER of their own auto-created org (org-A) but only
        // a VIEWER of the victim org (org-B). The handler acts on
        // currentOrganizationId = org-B; the attacker tries to pass the role
        // check by pointing query/body/header at org-A where they are OWNER.
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.OWNER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'attacker',
            currentOrganizationId: 'org-B',
            organizationMemberships: [
              { organization: { id: 'org-A' }, role: OrganizationRole.OWNER },
              { organization: { id: 'org-B' }, role: OrganizationRole.VIEWER },
            ],
          },
          params: {},
          query: { organizationId: 'org-A' },
          body: { organizationId: 'org-A' },
          headers: { 'x-organization-id': 'org-A' },
        });

        // Must be checked against org-B (where they are only VIEWER), not org-A.
        expect(() => guard.canActivate(mockContext)).toThrow(ForbiddenException);
      });
    });

    describe('Organization membership checks', () => {
      it('should throw ForbiddenException when user is not a member of organization', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-2' },
                role: OrganizationRole.MEMBER,
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('User is not a member of this organization')
        );
      });

      it('should throw ForbiddenException when organizationMemberships is empty', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [],
          },
          params: { organizationId: 'org-1' },
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('User is not a member of this organization')
        );
      });

      it('should throw ForbiddenException when organizationMemberships is undefined', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
          },
          params: { organizationId: 'org-1' },
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('User is not a member of this organization')
        );
      });
    });

    describe('Role-based authorization', () => {
      it('should allow access when user has required role (OWNER)', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.OWNER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.OWNER,
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        const result = guard.canActivate(mockContext);
        expect(result).toBe(true);
      });

      it('should allow access when user has required role (ADMIN)', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.ADMIN, OrganizationRole.OWNER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.ADMIN,
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        const result = guard.canActivate(mockContext);
        expect(result).toBe(true);
      });

      it('should allow access when user has required role (MEMBER)', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.MEMBER, OrganizationRole.ADMIN];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.MEMBER,
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        const result = guard.canActivate(mockContext);
        expect(result).toBe(true);
      });

      it('should throw ForbiddenException when user role is insufficient', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.OWNER];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.MEMBER,
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('Insufficient role privileges')
        );
      });

      it('should throw ForbiddenException when MEMBER tries to access ADMIN-only resource', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.ADMIN];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.MEMBER,
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('Insufficient role privileges')
        );
      });
    });

    describe('Permission-based authorization', () => {
      it('should allow access when user has all required permissions', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === PERMISSIONS_KEY) return ['read:apis', 'write:tools'];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.ADMIN,
                hasPermission: (perm: string) => ['read:apis', 'write:tools'].includes(perm),
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        const result = guard.canActivate(mockContext);
        expect(result).toBe(true);
      });

      it('should throw ForbiddenException when user lacks one required permission', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === PERMISSIONS_KEY) return ['read:apis', 'write:tools', 'delete:apis'];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.MEMBER,
                hasPermission: (perm: string) => ['read:apis', 'write:tools'].includes(perm),
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('Insufficient permissions')
        );
      });

      it('should throw ForbiddenException when user has no permissions', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === PERMISSIONS_KEY) return ['read:apis'];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.MEMBER,
                hasPermission: () => false,
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('Insufficient permissions')
        );
      });
    });

    describe('Combined roles and permissions', () => {
      it('should allow access when user has both required role and permissions', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.ADMIN];
          if (key === PERMISSIONS_KEY) return ['read:apis', 'write:tools'];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.ADMIN,
                hasPermission: (perm: string) => ['read:apis', 'write:tools'].includes(perm),
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        const result = guard.canActivate(mockContext);
        expect(result).toBe(true);
      });

      it('should throw ForbiddenException when user has role but missing permissions', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.ADMIN];
          if (key === PERMISSIONS_KEY) return ['read:apis', 'delete:apis'];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.ADMIN,
                hasPermission: (perm: string) => perm === 'read:apis',
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('Insufficient permissions')
        );
      });

      it('should throw ForbiddenException when user has permissions but insufficient role', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key) => {
          if (key === ROLES_KEY) return [OrganizationRole.OWNER];
          if (key === PERMISSIONS_KEY) return ['read:apis'];
          return undefined;
        });

        const mockContext = createMockContext({
          user: {
            id: 'user-1',
            organizationMemberships: [
              {
                organization: { id: 'org-1' },
                role: OrganizationRole.MEMBER,
                hasPermission: () => true,
              },
            ],
          },
          params: { organizationId: 'org-1' },
        });

        expect(() => guard.canActivate(mockContext)).toThrow(
          new ForbiddenException('Insufficient role privileges')
        );
      });
    });
  });
});
