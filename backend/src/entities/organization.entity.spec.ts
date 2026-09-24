import { Organization } from './organization.entity';
import { UserOrganization, OrganizationRole } from './user-organization.entity';

describe('Organization Entity', () => {
  describe('generateSlug', () => {
    it('should generate slug from organization name', () => {
      const org = new Organization();
      org.name = 'Test Organization';

      org.generateSlug();

      expect(org.slug).toBeDefined();
      expect(org.slug).toContain('test-organization');
    });

    it('should handle special characters in name', () => {
      const org = new Organization();
      org.name = 'My Cool @ Organization #1!';

      org.generateSlug();

      expect(org.slug).toBeDefined();
      expect(org.slug).toContain('my-cool-organization-1');
      expect(org.slug).not.toContain('@');
      expect(org.slug).not.toContain('#');
      expect(org.slug).not.toContain('!');
    });

    it('should not regenerate slug if already set', () => {
      const org = new Organization();
      org.name = 'Test Organization';
      org.slug = 'existing-slug';

      org.generateSlug();

      expect(org.slug).toBe('existing-slug');
    });

    it('should generate deterministic slug from name', () => {
      const org1 = new Organization();
      org1.name = 'Test';
      org1.generateSlug();

      const org2 = new Organization();
      org2.name = 'Test';
      org2.generateSlug();

      // Slugs are deterministic - uniqueness is enforced by DB constraint
      expect(org1.slug).toBe('test');
      expect(org2.slug).toBe('test');
    });

    it('should not generate slug if name is not set', () => {
      const org = new Organization();
      org.generateSlug();
      expect(org.slug).toBeUndefined();
    });

    it('should handle name with leading/trailing hyphens', () => {
      const org = new Organization();
      org.name = '---Test Organization---';
      org.generateSlug();
      expect(org.slug).toBeDefined();
      expect(org.slug).not.toMatch(/^-/);
      expect(org.slug).not.toMatch(/-$/);
    });

    it('should handle name with consecutive special characters', () => {
      const org = new Organization();
      org.name = 'Test!!!Organization';
      org.generateSlug();
      expect(org.slug).toBeDefined();
      expect(org.slug).toContain('test-organization');
    });

    it('should convert uppercase to lowercase', () => {
      const org = new Organization();
      org.name = 'TEST ORGANIZATION';
      org.generateSlug();
      expect(org.slug).toMatch(/^[a-z0-9-]+$/);
    });
  });

  describe('getOwners', () => {
    it('should return only members with owner role', () => {
      const org = new Organization();
      org.members = [
        { role: OrganizationRole.OWNER } as UserOrganization,
        { role: OrganizationRole.ADMIN } as UserOrganization,
        { role: OrganizationRole.MEMBER } as UserOrganization,
        { role: OrganizationRole.OWNER } as UserOrganization,
      ];

      const owners = org.getOwners();

      expect(owners).toHaveLength(2);
      expect(owners.every(m => m.role === OrganizationRole.OWNER)).toBe(true);
    });

    it('should return empty array if no members', () => {
      const org = new Organization();
      org.members = [];

      const owners = org.getOwners();

      expect(owners).toEqual([]);
    });

    it('should return empty array if members is null', () => {
      const org = new Organization();
      org.members = null;

      const owners = org.getOwners();

      expect(owners).toEqual([]);
    });
  });

  describe('getAdmins', () => {
    it('should return members with owner or admin role', () => {
      const org = new Organization();
      org.members = [
        { role: OrganizationRole.OWNER } as UserOrganization,
        { role: OrganizationRole.ADMIN } as UserOrganization,
        { role: OrganizationRole.MEMBER } as UserOrganization,
        { role: OrganizationRole.OWNER } as UserOrganization,
      ];

      const admins = org.getAdmins();

      expect(admins).toHaveLength(3);
      expect(admins.every(m =>
        m.role === OrganizationRole.OWNER || m.role === OrganizationRole.ADMIN
      )).toBe(true);
    });

    it('should return empty array if only regular members', () => {
      const org = new Organization();
      org.members = [
        { role: OrganizationRole.MEMBER } as UserOrganization,
        { role: OrganizationRole.MEMBER } as UserOrganization,
      ];

      const admins = org.getAdmins();

      expect(admins).toEqual([]);
    });
  });

  it('has no relation-reading API / gateway / tool limit checks (they always passed)', () => {
    // Quotas are enforced by COUNT in api-quota.ts / gateway-quota.ts / tool-quota.ts.
    const org = new Organization() as any;
    expect(org.canAddMoreApis).toBeUndefined();
    expect(org.canAddMoreGateways).toBeUndefined();
    expect(org.canAddMoreTools).toBeUndefined();
  });

  describe('getAdmins edge cases', () => {
    it('should handle undefined members', () => {
      const org = new Organization();
      org.members = undefined;

      const admins = org.getAdmins();

      expect(admins).toEqual([]);
    });

    it('should handle null members', () => {
      const org = new Organization();
      org.members = null;

      const admins = org.getAdmins();

      expect(admins).toEqual([]);
    });

    it('should handle empty members array', () => {
      const org = new Organization();
      org.members = [];

      const admins = org.getAdmins();

      expect(admins).toEqual([]);
    });
  });

  describe('getOwners edge cases', () => {
    it('should handle undefined members', () => {
      const org = new Organization();
      org.members = undefined;

      const owners = org.getOwners();

      expect(owners).toEqual([]);
    });
  });
});
