import { User } from './user.entity';
import { UserOrganization, OrganizationRole } from './user-organization.entity';

describe('User Entity', () => {
  let user: User;

  beforeEach(() => {
    user = new User();
    user.id = 'user-1';
    user.email = 'test@example.com';
    user.firstName = 'John';
    user.lastName = 'Doe';
    user.passwordHash = 'hashed-password';
    user.isActive = true;
    user.isVerified = true;
    user.createdAt = new Date();
    user.updatedAt = new Date();
  });

  describe('fullName getter', () => {
    it('should return concatenated first and last name', () => {
      expect(user.fullName).toBe('John Doe');
    });

    it('should handle single character names', () => {
      user.firstName = 'J';
      user.lastName = 'D';
      expect(user.fullName).toBe('J D');
    });

    it('should handle empty first name', () => {
      user.firstName = '';
      user.lastName = 'Doe';
      expect(user.fullName).toBe(' Doe');
    });

    it('should handle empty last name', () => {
      user.firstName = 'John';
      user.lastName = '';
      expect(user.fullName).toBe('John ');
    });
  });

  describe('hasPermissionInOrganization', () => {
    it('should return false if user has no memberships', () => {
      user.organizationMemberships = undefined;
      const result = user.hasPermissionInOrganization('org-1', 'read');
      expect(result).toBe(false);
    });

    it('should return false if user not member of organization', () => {
      user.organizationMemberships = [
        { organizationId: 'org-2', role: OrganizationRole.MEMBER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'read');
      expect(result).toBe(false);
    });

    it('should return true for owner with admin permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.OWNER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'admin');
      expect(result).toBe(true);
    });

    it('should return true for owner with read permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.OWNER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'read');
      expect(result).toBe(true);
    });

    it('should return true for owner with write permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.OWNER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'write');
      expect(result).toBe(true);
    });

    it('should return true for owner with delete permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.OWNER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'delete');
      expect(result).toBe(true);
    });

    it('should return true for owner with create_gateways permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.OWNER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'create_gateways');
      expect(result).toBe(true);
    });

    it('should return true for admin with delete permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.ADMIN } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'delete');
      expect(result).toBe(true);
    });

    it('should return true for admin with manage_gateways permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.ADMIN } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'manage_gateways');
      expect(result).toBe(true);
    });

    it('should return false for admin with admin permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.ADMIN } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'admin');
      expect(result).toBe(false);
    });

    it('should return true for member with read permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.MEMBER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'read');
      expect(result).toBe(true);
    });

    it('should return true for member with write permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.MEMBER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'write');
      expect(result).toBe(true);
    });

    it('should return true for member with use_tools permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.MEMBER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'use_tools');
      expect(result).toBe(true);
    });

    it('should return false for member with delete permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.MEMBER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'delete');
      expect(result).toBe(false);
    });

    it('should return false for member with admin permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.MEMBER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'admin');
      expect(result).toBe(false);
    });

    it('should return true for viewer with read permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.VIEWER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'read');
      expect(result).toBe(true);
    });

    it('should return false for viewer with write permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.VIEWER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'write');
      expect(result).toBe(false);
    });

    it('should return false for viewer with delete permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.VIEWER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'delete');
      expect(result).toBe(false);
    });

    it('should return false for viewer with admin permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.VIEWER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'admin');
      expect(result).toBe(false);
    });

    it('should handle multiple memberships and find correct organization', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.VIEWER } as UserOrganization,
        { organizationId: 'org-2', role: OrganizationRole.OWNER } as UserOrganization,
        { organizationId: 'org-3', role: OrganizationRole.ADMIN } as UserOrganization,
      ];

      expect(user.hasPermissionInOrganization('org-1', 'write')).toBe(false);
      expect(user.hasPermissionInOrganization('org-2', 'admin')).toBe(true);
      expect(user.hasPermissionInOrganization('org-3', 'delete')).toBe(true);
    });

    it('should return false for unknown role', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: 'unknown' as any } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'read');
      expect(result).toBe(false);
    });

    it('should return false for null memberships', () => {
      user.organizationMemberships = null;
      const result = user.hasPermissionInOrganization('org-1', 'read');
      expect(result).toBe(false);
    });

    it('should return false for empty memberships array', () => {
      user.organizationMemberships = [];
      const result = user.hasPermissionInOrganization('org-1', 'read');
      expect(result).toBe(false);
    });

    it('should return true for owner with manage_llm_providers permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.OWNER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'manage_llm_providers');
      expect(result).toBe(true);
    });

    it('should return true for admin with manage_llm_providers permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.ADMIN } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'manage_llm_providers');
      expect(result).toBe(true);
    });

    it('should return false for member with manage_llm_providers permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.MEMBER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'manage_llm_providers');
      expect(result).toBe(false);
    });

    it('should return true for admin with create_tools permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.ADMIN } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'create_tools');
      expect(result).toBe(true);
    });

    it('should return true for admin with edit_tools permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.ADMIN } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'edit_tools');
      expect(result).toBe(true);
    });

    it('should return true for admin with delete_tools permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.ADMIN } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'delete_tools');
      expect(result).toBe(true);
    });

    it('should return true for admin with manage_gateway_tools permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.ADMIN } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'manage_gateway_tools');
      expect(result).toBe(true);
    });

    it('should return false for unknown permission', () => {
      user.organizationMemberships = [
        { organizationId: 'org-1', role: OrganizationRole.OWNER } as UserOrganization,
      ];
      const result = user.hasPermissionInOrganization('org-1', 'unknown_permission');
      expect(result).toBe(false); // Unknown permissions return false
    });
  });
});
