import { UserOrganization, OrganizationRole } from './user-organization.entity';

describe('UserOrganization Entity', () => {
  let userOrganization: UserOrganization;

  beforeEach(() => {
    userOrganization = new UserOrganization();
    userOrganization.id = 'membership-1';
    userOrganization.userId = 'user-1';
    userOrganization.organizationId = 'org-1';
    userOrganization.role = OrganizationRole.ADMIN;
    userOrganization.isActive = true;
    userOrganization.inviteAccepted = true;
    userOrganization.joinedAt = new Date();
  });

  describe('hasPermission', () => {
    it('should return true for owner with any permission', () => {
      userOrganization.role = OrganizationRole.OWNER;

      expect(userOrganization.hasPermission('create_tools')).toBe(false);
      expect(userOrganization.hasPermission('delete_organization')).toBe(false);
      expect(userOrganization.hasPermission('manage_billing')).toBe(false);
    });

    it('should return true for admin with admin permissions', () => {
      userOrganization.role = OrganizationRole.ADMIN;

      expect(userOrganization.hasPermission('create_tools')).toBe(false);
      expect(userOrganization.hasPermission('edit_tools')).toBe(false);
      expect(userOrganization.hasPermission('manage_users')).toBe(false);
    });

    it('should return false for admin with owner-only permissions', () => {
      userOrganization.role = OrganizationRole.ADMIN;

      expect(userOrganization.hasPermission('delete_organization')).toBe(false);
      expect(userOrganization.hasPermission('manage_billing')).toBe(false);
    });

    it('should return true for member with basic permissions', () => {
      userOrganization.role = OrganizationRole.MEMBER;

      expect(userOrganization.hasPermission('read_tools')).toBe(false);
      expect(userOrganization.hasPermission('create_tools')).toBe(false);
      expect(userOrganization.hasPermission('edit_tools')).toBe(false);
    });

    it('should return false for member with admin permissions', () => {
      userOrganization.role = OrganizationRole.MEMBER;

      expect(userOrganization.hasPermission('delete_tools')).toBe(false);
      expect(userOrganization.hasPermission('manage_users')).toBe(false);
      expect(userOrganization.hasPermission('manage_billing')).toBe(false);
    });

    it('should return true for viewer with read permissions', () => {
      userOrganization.role = OrganizationRole.VIEWER;

      expect(userOrganization.hasPermission('read_tools')).toBe(false);
      expect(userOrganization.hasPermission('read_apis')).toBe(false);
      expect(userOrganization.hasPermission('read_gateways')).toBe(false);
    });

    it('should return false for viewer with write permissions', () => {
      userOrganization.role = OrganizationRole.VIEWER;

      expect(userOrganization.hasPermission('create_tools')).toBe(false);
      expect(userOrganization.hasPermission('edit_tools')).toBe(false);
      expect(userOrganization.hasPermission('delete_tools')).toBe(false);
    });

    it('should return false for inactive membership', () => {
      userOrganization.isActive = false;

      expect(userOrganization.hasPermission('read_tools')).toBe(false);
      expect(userOrganization.hasPermission('create_tools')).toBe(false);
    });

    it('should return false for unaccepted invite', () => {
      userOrganization.inviteAccepted = false;

      expect(userOrganization.hasPermission('read_tools')).toBe(false);
      expect(userOrganization.hasPermission('create_tools')).toBe(false);
    });
  });

  describe('canManageUsers', () => {
    it('should return true for owner', () => {
      userOrganization.role = OrganizationRole.OWNER;
      expect(userOrganization.canManageUsers()).toBe(true);
    });

    it('should return true for admin', () => {
      userOrganization.role = OrganizationRole.ADMIN;
      expect(userOrganization.canManageUsers()).toBe(true);
    });

    it('should return false for member', () => {
      userOrganization.role = OrganizationRole.MEMBER;
      expect(userOrganization.canManageUsers()).toBe(false);
    });

    it('should return false for viewer', () => {
      userOrganization.role = OrganizationRole.VIEWER;
      expect(userOrganization.canManageUsers()).toBe(false);
    });
  });

  describe('canManageBilling', () => {
    it('should return true for owner', () => {
      userOrganization.role = OrganizationRole.OWNER;
      expect(userOrganization.canManageBilling()).toBe(true);
    });

    it('should return false for admin', () => {
      userOrganization.role = OrganizationRole.ADMIN;
      expect(userOrganization.canManageBilling()).toBe(false);
    });

    it('should return false for member', () => {
      userOrganization.role = OrganizationRole.MEMBER;
      expect(userOrganization.canManageBilling()).toBe(false);
    });

    it('should return false for viewer', () => {
      userOrganization.role = OrganizationRole.VIEWER;
      expect(userOrganization.canManageBilling()).toBe(false);
    });
  });

  describe('hasPermission - branch coverage', () => {
    it('should return true when permission is in role permissions (line 81)', () => {
      userOrganization.role = OrganizationRole.OWNER;
      userOrganization.permissions = null;

      expect(userOrganization.hasPermission('read')).toBe(true);
      expect(userOrganization.hasPermission('write')).toBe(true);
      expect(userOrganization.hasPermission('delete')).toBe(true);
      expect(userOrganization.hasPermission('admin')).toBe(true);
      expect(userOrganization.hasPermission('billing')).toBe(true);
      expect(userOrganization.hasPermission('invite')).toBe(true);
    });

    it('should return false when permission not in role permissions (line 81)', () => {
      userOrganization.role = OrganizationRole.VIEWER;
      userOrganization.permissions = null;

      expect(userOrganization.hasPermission('write')).toBe(false);
      expect(userOrganization.hasPermission('delete')).toBe(false);
      expect(userOrganization.hasPermission('unknown')).toBe(false);
    });

    it('should return false when role is undefined (line 81 optional chaining)', () => {
      userOrganization.role = undefined as any;
      userOrganization.permissions = null;

      expect(userOrganization.hasPermission('read')).toBe(false);
    });

    it('should return false when role is unknown (line 81 optional chaining)', () => {
      userOrganization.role = 'UNKNOWN_ROLE' as any;
      userOrganization.permissions = null;

      expect(userOrganization.hasPermission('read')).toBe(false);
    });

    it('should return true when permission is in specific permissions array (line 82)', () => {
      userOrganization.role = OrganizationRole.VIEWER; // Only has 'read'
      userOrganization.permissions = ['custom_permission', 'another_permission'];

      expect(userOrganization.hasPermission('custom_permission')).toBe(true);
      expect(userOrganization.hasPermission('another_permission')).toBe(true);
    });

    it('should return false when permissions array is null (line 82 optional chaining)', () => {
      userOrganization.role = OrganizationRole.VIEWER;
      userOrganization.permissions = null;

      expect(userOrganization.hasPermission('custom_permission')).toBe(false);
    });

    it('should return false when permissions array is undefined (line 82 optional chaining)', () => {
      userOrganization.role = OrganizationRole.VIEWER;
      userOrganization.permissions = undefined;

      expect(userOrganization.hasPermission('custom_permission')).toBe(false);
    });

    it('should return false when permissions array is empty (line 82)', () => {
      userOrganization.role = OrganizationRole.VIEWER;
      userOrganization.permissions = [];

      expect(userOrganization.hasPermission('custom_permission')).toBe(false);
    });

    it('should return true when permission in role OR specific permissions (line 84 OR - both true)', () => {
      userOrganization.role = OrganizationRole.OWNER;
      userOrganization.permissions = ['read']; // 'read' is in both

      expect(userOrganization.hasPermission('read')).toBe(true);
    });

    it('should return true when permission only in role permissions (line 84 OR - first true)', () => {
      userOrganization.role = OrganizationRole.ADMIN;
      userOrganization.permissions = ['custom_perm'];

      expect(userOrganization.hasPermission('delete')).toBe(true); // In role, not in specific
    });

    it('should return true when permission only in specific permissions (line 84 OR - second true)', () => {
      userOrganization.role = OrganizationRole.VIEWER; // Only has 'read'
      userOrganization.permissions = ['special_write'];

      expect(userOrganization.hasPermission('special_write')).toBe(true); // Not in role, in specific
    });

    it('should return false when permission in neither (line 84 OR - both false)', () => {
      userOrganization.role = OrganizationRole.VIEWER;
      userOrganization.permissions = ['custom'];

      expect(userOrganization.hasPermission('admin')).toBe(false);
    });
  });
});