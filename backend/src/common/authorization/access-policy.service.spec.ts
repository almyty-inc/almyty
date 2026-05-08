import { OrganizationRole } from '../../entities/user-organization.entity';
import { TeamRole } from '../../entities/user-team.entity';
import { AccessPolicyService } from './access-policy.service';

class FakeUserOrgsRepo {
  rows: Array<{ userId: string; organizationId: string; role: OrganizationRole; isActive: boolean }> = [];
  async findOne({ where }: any) {
    return this.rows.find(r =>
      r.userId === where.userId &&
      r.organizationId === where.organizationId &&
      r.isActive === (where.isActive ?? true),
    ) ?? null;
  }
}

class FakeUserTeamsRepo {
  rows: Array<{ userId: string; teamId: string; organizationId: string; role: TeamRole; isActive: boolean }> = [];
  createQueryBuilder() {
    const self = this;
    let userId = '';
    let organizationId = '';
    const qb: any = {
      innerJoin: (_t: string, _a: string, _on: string, p: any) => { organizationId = p.organizationId; return qb; },
      where: (_clause: string, p: any) => { userId = p.userId; return qb; },
      select: () => qb,
      getRawMany: async () => self.rows
        .filter(r => r.userId === userId && r.organizationId === organizationId && r.isActive)
        .map(r => ({ teamId: r.teamId, role: r.role })),
    };
    return qb;
  }
}

function makeService() {
  const userOrgs = new FakeUserOrgsRepo();
  const userTeams = new FakeUserTeamsRepo();
  const svc = new AccessPolicyService(userOrgs as any, userTeams as any);
  return { svc, userOrgs, userTeams };
}

describe('AccessPolicyService', () => {
  describe('canAccess', () => {
    it('rejects non-members', async () => {
      const { svc } = makeService();
      const decision = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1' }, 'read');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/not a member/);
    });

    it('org owner bypasses everything inside their org', async () => {
      const { svc, userOrgs } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.OWNER, isActive: true });
      const orgScoped = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'org' }, 'manage');
      const teamScoped = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'team', teamId: 't-x' }, 'manage');
      expect(orgScoped.allowed).toBe(true);
      expect(teamScoped.allowed).toBe(true);
    });

    it('org admin bypasses everything inside their org', async () => {
      const { svc, userOrgs } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.ADMIN, isActive: true });
      const decision = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'team', teamId: 't-x' }, 'manage');
      expect(decision.allowed).toBe(true);
    });

    it('org member can read/use org-wide resources', async () => {
      const { svc, userOrgs } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true });
      const r = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'org' }, 'read');
      expect(r.allowed).toBe(true);
    });

    it('org member cannot manage org-wide resources', async () => {
      const { svc, userOrgs } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true });
      const r = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'org' }, 'manage');
      expect(r.allowed).toBe(false);
    });

    it('team-scoped resource without teamId is rejected', async () => {
      const { svc, userOrgs } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true });
      const r = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'team' }, 'read');
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/teamId/);
    });

    it('non-team-member cannot access team-scoped resource', async () => {
      const { svc, userOrgs, userTeams } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true });
      userTeams.rows.push({ userId: 'u1', organizationId: 'org-1', teamId: 't-other', role: TeamRole.MEMBER, isActive: true });
      const r = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'team', teamId: 't-x' }, 'read');
      expect(r.allowed).toBe(false);
    });

    it('team_member can read/use but not manage team-scoped resources', async () => {
      const { svc, userOrgs, userTeams } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true });
      userTeams.rows.push({ userId: 'u1', organizationId: 'org-1', teamId: 't-x', role: TeamRole.MEMBER, isActive: true });
      const read = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'team', teamId: 't-x' }, 'read');
      const manage = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'team', teamId: 't-x' }, 'manage');
      expect(read.allowed).toBe(true);
      expect(manage.allowed).toBe(false);
    });

    it('team_admin (LEAD) can manage team-scoped resources', async () => {
      const { svc, userOrgs, userTeams } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true });
      userTeams.rows.push({ userId: 'u1', organizationId: 'org-1', teamId: 't-x', role: TeamRole.LEAD, isActive: true });
      const r = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1', visibility: 'team', teamId: 't-x' }, 'manage');
      expect(r.allowed).toBe(true);
    });

    it('treats missing visibility as org (back-compat)', async () => {
      const { svc, userOrgs } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true });
      const r = await svc.canAccess({ id: 'u1' }, { organizationId: 'org-1' }, 'use');
      expect(r.allowed).toBe(true);
    });
  });

  describe('applyListFilter', () => {
    function makeQb() {
      const calls: Array<{ method: string; args: any[] }> = [];
      const qb: any = {
        andWhere: (...args: any[]) => { calls.push({ method: 'andWhere', args }); return qb; },
      };
      return { qb, calls };
    }

    it('owner gets bypass, only orgId clause applied', async () => {
      const { svc, userOrgs } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.OWNER, isActive: true });
      const { qb, calls } = makeQb();
      const result = await svc.applyListFilter(qb, { id: 'u1' }, 'org-1', 'res');
      expect(result.bypass).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0].args[0]).toContain('"organizationId" = :_orgId');
    });

    it('member gets two andWhere calls — orgId + brackets visibility/teamId', async () => {
      const { svc, userOrgs, userTeams } = makeService();
      userOrgs.rows.push({ userId: 'u1', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true });
      userTeams.rows.push({ userId: 'u1', organizationId: 'org-1', teamId: 't-1', role: TeamRole.MEMBER, isActive: true });
      const { qb, calls } = makeQb();
      const result = await svc.applyListFilter(qb, { id: 'u1' }, 'org-1', 'res');
      expect(result.bypass).toBe(false);
      expect(result.teamIds).toEqual(['t-1']);
      expect(calls.length).toBe(2);
    });
  });
});
