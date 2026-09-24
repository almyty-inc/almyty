import { ForbiddenException } from '@nestjs/common';

import { RbacController } from '../rbac.controller';
import { CustomRoleService } from '../custom-role.service';
import { PolicyEvaluatorService } from '../policy-evaluator.service';
import { OrganizationRole } from '../../../../src/entities/user-organization.entity';

/**
 * Custom roles are additive: RolesGuard lets a `role:<name>` grant (or a
 * wildcard covering it) satisfy `@Roles(<name>)`. The rbac routes are open
 * to admins as well as owners, and nothing compared what a role grants
 * with what its author holds -- so an admin could create a role with
 * `role:owner` (or `*`), assign it to themselves, and pass every
 * owner-only check, deleting the organization among them. Everything
 * else about roles stays with admins; what only an owner holds, only an
 * owner can grant.
 */
describe('custom roles cannot grant what the grantor lacks', () => {
  const ORG = 'org-1';

  class Repo {
    rows: any[] = [];
    private n = 0;
    create(p: any) {
      return { id: `id_${++this.n}`, ...p };
    }
    async save(r: any) {
      const i = this.rows.findIndex((x) => x.id === r.id);
      if (i >= 0) this.rows[i] = r;
      else this.rows.push(r);
      return r;
    }
    async findOne({ where }: any) {
      return this.rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null;
    }
    async find({ where }: any = {}) {
      return this.rows.filter((r) => Object.entries(where ?? {}).every(([k, v]) => r[k] === v));
    }
    async remove(r: any) {
      this.rows = this.rows.filter((x) => x.id !== r.id);
    }
  }

  function setup() {
    const roles = new Repo();
    const assignments = new Repo();
    const service = new CustomRoleService(roles as any, assignments as any, new Repo() as any, new PolicyEvaluatorService());
    const controller = new RbacController(service);
    return { roles, assignments, controller };
  }

  const as = (role: OrganizationRole, id = `u-${role}`) => ({
    user: {
      id,
      currentOrganizationId: ORG,
      organizationMemberships: [{ organizationId: ORG, role, isActive: true, inviteAccepted: true, inviteToken: null }],
    },
  });

  it.each([['role:owner'], ['*'], ['role:*'], ['billing'], ['admin'], ['*:owner']])(
    'an admin cannot create a role granting %p',
    async (perm) => {
      const { controller, roles } = setup();
      await expect(
        controller.createRole(as(OrganizationRole.ADMIN), { name: 'x', permissions: [perm] }),
      ).rejects.toThrow(ForbiddenException);
      expect(roles.rows).toHaveLength(0);
    },
  );

  it('an admin can still create an ordinary role', async () => {
    const { controller } = setup();
    const out = await controller.createRole(as(OrganizationRole.ADMIN), {
      name: 'agents',
      permissions: ['agents:*', 'role:admin', 'connections:manage'],
    });
    expect(out.data.permissions).toContain('agents:*');
  });

  it('an owner can create a role granting owner', async () => {
    const { controller } = setup();
    const out = await controller.createRole(as(OrganizationRole.OWNER), { name: 'root', permissions: ['*'] });
    expect(out.data.permissions).toEqual(['*']);
  });

  it('an admin cannot widen an existing role to owner', async () => {
    const { controller } = setup();
    const created = await controller.createRole(as(OrganizationRole.ADMIN), { name: 'r', permissions: ['agents:read'] });
    await expect(
      controller.updateRole(as(OrganizationRole.ADMIN), created.data.id, { permissions: ['role:owner'] }),
    ).rejects.toThrow(ForbiddenException);
  });

  it("an admin cannot assign an owner's role, to themselves or anyone", async () => {
    const { controller, assignments } = setup();
    const root = await controller.createRole(as(OrganizationRole.OWNER), { name: 'root', permissions: ['*'] });
    const admin = as(OrganizationRole.ADMIN);
    await expect(controller.assign(admin, root.data.id, { userId: admin.user.id })).rejects.toThrow(
      ForbiddenException,
    );
    expect(assignments.rows).toHaveLength(0);
  });

  it('an owner can assign it', async () => {
    const { controller, assignments } = setup();
    const root = await controller.createRole(as(OrganizationRole.OWNER), { name: 'root', permissions: ['*'] });
    await controller.assign(as(OrganizationRole.OWNER), root.data.id, { userId: 'u-2' });
    expect(assignments.rows).toHaveLength(1);
  });
});
