import { ConflictException, NotFoundException } from '@nestjs/common';
import { CustomRoleService } from '../custom-role.service';
import { PolicyEvaluatorService } from '../policy-evaluator.service';

/** Minimal in-memory repo covering the subset of TypeORM used here. */
class FakeRepo<T extends { id: string }> {
  rows: T[] = [];
  private idc = 0;
  create(partial: any) {
    return { id: `id_${++this.idc}`, createdAt: new Date(), updatedAt: new Date(), ...partial } as T;
  }
  async save(row: T) {
    const i = this.rows.findIndex((r) => r.id === row.id);
    if (i >= 0) this.rows[i] = row;
    else this.rows.push(row);
    return row;
  }
  async findOne({ where }: any) {
    return this.rows.find((r) => this.match(r, where)) ?? null;
  }
  async find({ where }: any = {}) {
    if (!where) return [...this.rows];
    return this.rows.filter((r) => this.match(r, where));
  }
  async remove(row: T) {
    this.rows = this.rows.filter((r) => r.id !== row.id);
    return row;
  }
  private match(row: any, where: any): boolean {
    return Object.entries(where).every(([k, v]: [string, any]) => {
      // Real TypeORM In() is a FindOperator whose type is 'in' and whose
      // value is the array — honor it without mocking the module.
      if (v && typeof v === 'object' && v._type === 'in' && Array.isArray(v._value)) {
        return v._value.includes(row[k]);
      }
      return row[k] === v;
    });
  }
}

function makeService() {
  const roles = new FakeRepo<any>();
  const assignments = new FakeRepo<any>();
  const policies = new FakeRepo<any>();
  const svc = new CustomRoleService(
    roles as any,
    assignments as any,
    policies as any,
    new PolicyEvaluatorService(),
  );
  return { svc, roles, assignments, policies };
}

describe('CustomRoleService', () => {
  describe('roles', () => {
    it('creates a role with normalized (deduped, sorted) permissions', async () => {
      const { svc } = makeService();
      const role = await svc.createRole({
        organizationId: 'org',
        name: '  release-manager ',
        permissions: ['agents:read', 'agents:read', 'tools:manage'],
      });
      expect(role.name).toBe('release-manager');
      expect(role.permissions).toEqual(['agents:read', 'tools:manage']);
    });

    it('rejects duplicate role names in the same org', async () => {
      const { svc } = makeService();
      await svc.createRole({ organizationId: 'org', name: 'auditor' });
      await expect(svc.createRole({ organizationId: 'org', name: 'auditor' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('scopes get by org', async () => {
      const { svc } = makeService();
      const role = await svc.createRole({ organizationId: 'org-a', name: 'r' });
      await expect(svc.getRole('org-b', role.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('assignments + effective permissions', () => {
    it('unions permissions across assigned active roles', async () => {
      const { svc } = makeService();
      const a = await svc.createRole({ organizationId: 'org', name: 'a', permissions: ['agents:read'] });
      const b = await svc.createRole({ organizationId: 'org', name: 'b', permissions: ['tools:manage'] });
      await svc.assign('org', a.id, 'user-1');
      await svc.assign('org', b.id, 'user-1');

      const perms = await svc.getEffectivePermissions('org', 'user-1');
      expect(perms).toEqual(['agents:read', 'tools:manage']);
      expect(await svc.hasPermission('org', 'user-1', 'tools:manage')).toBe(true);
      expect(await svc.hasPermission('org', 'user-1', 'gateways:delete')).toBe(false);
    });

    it('assign is idempotent per (role,user)', async () => {
      const { svc } = makeService();
      const a = await svc.createRole({ organizationId: 'org', name: 'a' });
      const first = await svc.assign('org', a.id, 'user-1');
      const second = await svc.assign('org', a.id, 'user-1');
      expect(second.id).toBe(first.id);
    });

    it('excludes inactive roles from the effective set', async () => {
      const { svc } = makeService();
      const a = await svc.createRole({ organizationId: 'org', name: 'a', permissions: ['agents:read'] });
      await svc.assign('org', a.id, 'user-1');
      await svc.updateRole('org', a.id, { active: false });
      expect(await svc.getEffectivePermissions('org', 'user-1')).toEqual([]);
    });
  });

  describe('ABAC policy CRUD + evaluation', () => {
    it('creates then evaluates a deny policy', async () => {
      const { svc } = makeService();
      await svc.createPolicy({
        organizationId: 'org',
        name: 'no-prod-deletes',
        effect: 'deny',
        action: 'tools:delete',
        conditions: [{ attr: 'resource.env', op: 'eq', value: 'production' }],
      });
      const decision = await svc.evaluateAccess('org', 'tools:delete', {
        resource: { env: 'production' },
      });
      expect(decision.allowed).toBe(false);
      expect(decision.effect).toBe('deny');
    });
  });
});
