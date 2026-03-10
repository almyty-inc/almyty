import { Organization } from './organization.entity';
import { UserOrganization, OrganizationRole } from './user-organization.entity';
import { Api } from './api.entity';
import { Gateway } from './gateway.entity';
import { Tool } from './tool.entity';

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

  describe('canAddMoreApis', () => {
    it('should return true if no limit set', () => {
      const org = new Organization();
      org.settings = {};
      org.apis = [{} as Api, {} as Api];

      expect(org.canAddMoreApis()).toBe(true);
    });

    it('should return true if under limit', () => {
      const org = new Organization();
      org.settings = { maxApis: 5 };
      org.apis = [{} as Api, {} as Api];

      expect(org.canAddMoreApis()).toBe(true);
    });

    it('should return false if at limit', () => {
      const org = new Organization();
      org.settings = { maxApis: 2 };
      org.apis = [{} as Api, {} as Api];

      expect(org.canAddMoreApis()).toBe(false);
    });

    it('should return false if over limit', () => {
      const org = new Organization();
      org.settings = { maxApis: 1 };
      org.apis = [{} as Api, {} as Api];

      expect(org.canAddMoreApis()).toBe(false);
    });

    it('should handle null apis array', () => {
      const org = new Organization();
      org.settings = { maxApis: 5 };
      org.apis = null;

      expect(org.canAddMoreApis()).toBe(true);
    });
  });

  describe('canAddMoreGateways', () => {
    it('should return true if no limit set', () => {
      const org = new Organization();
      org.settings = {};
      org.gateways = [{} as Gateway];

      expect(org.canAddMoreGateways()).toBe(true);
    });

    it('should return true if under limit', () => {
      const org = new Organization();
      org.settings = { maxGateways: 3 };
      org.gateways = [{} as Gateway];

      expect(org.canAddMoreGateways()).toBe(true);
    });

    it('should return false if at or over limit', () => {
      const org = new Organization();
      org.settings = { maxGateways: 1 };
      org.gateways = [{} as Gateway, {} as Gateway];

      expect(org.canAddMoreGateways()).toBe(false);
    });
  });

  describe('canAddMoreTools', () => {
    it('should return true if no limit set', () => {
      const org = new Organization();
      org.settings = {};
      org.tools = [{} as Tool, {} as Tool, {} as Tool];

      expect(org.canAddMoreTools()).toBe(true);
    });

    it('should return true if under limit', () => {
      const org = new Organization();
      org.settings = { maxTools: 10 };
      org.tools = [{} as Tool, {} as Tool];

      expect(org.canAddMoreTools()).toBe(true);
    });

    it('should return false if at limit', () => {
      const org = new Organization();
      org.settings = { maxTools: 2 };
      org.tools = [{} as Tool, {} as Tool];

      expect(org.canAddMoreTools()).toBe(false);
    });

    it('should return false if over limit', () => {
      const org = new Organization();
      org.settings = { maxTools: 1 };
      org.tools = [{} as Tool, {} as Tool, {} as Tool];

      expect(org.canAddMoreTools()).toBe(false);
    });

    it('should handle null tools array', () => {
      const org = new Organization();
      org.settings = { maxTools: 5 };
      org.tools = null;

      expect(org.canAddMoreTools()).toBe(true);
    });

    it('should handle undefined tools array', () => {
      const org = new Organization();
      org.settings = { maxTools: 5 };
      org.tools = undefined;

      expect(org.canAddMoreTools()).toBe(true);
    });

    it('should return true if settings is null', () => {
      const org = new Organization();
      org.settings = null;
      org.tools = [{} as Tool];

      expect(org.canAddMoreTools()).toBe(true);
    });

    it('should return true if maxTools is undefined', () => {
      const org = new Organization();
      org.settings = { maxApis: 5 };
      org.tools = [{} as Tool];

      expect(org.canAddMoreTools()).toBe(true);
    });

    it('should handle edge case with zero tools', () => {
      const org = new Organization();
      org.settings = { maxTools: 1 };
      org.tools = [];

      expect(org.canAddMoreTools()).toBe(true);
    });

    it('should handle edge case with maxTools zero', () => {
      const org = new Organization();
      org.settings = { maxTools: 0 };
      org.tools = [];

      expect(org.canAddMoreTools()).toBe(true); // 0 < 0 is false, so returns true
    });
  });

  describe('canAddMoreGateways edge cases', () => {
    it('should handle null settings', () => {
      const org = new Organization();
      org.settings = null;
      org.gateways = [{} as Gateway];

      expect(org.canAddMoreGateways()).toBe(true);
    });

    it('should handle undefined gateways array', () => {
      const org = new Organization();
      org.settings = { maxGateways: 5 };
      org.gateways = undefined;

      expect(org.canAddMoreGateways()).toBe(true);
    });

    it('should handle maxGateways zero', () => {
      const org = new Organization();
      org.settings = { maxGateways: 0 };
      org.gateways = [];

      expect(org.canAddMoreGateways()).toBe(true); // 0 < 0 is false, so returns true
    });
  });

  describe('canAddMoreApis edge cases', () => {
    it('should handle undefined settings', () => {
      const org = new Organization();
      org.settings = undefined;
      org.apis = [{} as Api];

      expect(org.canAddMoreApis()).toBe(true);
    });

    it('should handle empty apis array', () => {
      const org = new Organization();
      org.settings = { maxApis: 5 };
      org.apis = [];

      expect(org.canAddMoreApis()).toBe(true);
    });

    it('should handle maxApis zero', () => {
      const org = new Organization();
      org.settings = { maxApis: 0 };
      org.apis = [];

      expect(org.canAddMoreApis()).toBe(true); // 0 < 0 is false, so returns true
    });
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
