import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { assertManageable } from '../../../common/authorization/read-rule';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { TeamRole } from '../../../entities/user-team.entity';
import { AgentsService } from '../agents.service';

/**
 * GET /agents/:id carries `viewerCanManage`, the backend's own manage rule
 * for the caller. A lead of the agent's team may manage it (delete a run,
 * edit channels) even though they are neither an org admin nor the owner;
 * the page used to guess from role and owner alone and hid the controls.
 */

const memberships = [
  { userId: 'lead', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true },
  { userId: 'other', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true },
  { userId: 'owner', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true },
  { userId: 'admin', organizationId: 'org-1', role: OrganizationRole.ADMIN, isActive: true },
];
const teams = [
  { userId: 'lead', organizationId: 'org-1', teamId: 'team-a', role: TeamRole.LEAD, isActive: true },
  { userId: 'owner', organizationId: 'org-1', teamId: 'team-a', role: TeamRole.MEMBER, isActive: true },
  { userId: 'other', organizationId: 'org-1', teamId: 'team-b', role: TeamRole.MEMBER, isActive: true },
];

function policy(): AccessPolicyService {
  const userOrgs = {
    findOne: async ({ where }: any) =>
      memberships.find(
        (r) => r.userId === where.userId && r.organizationId === where.organizationId && r.isActive === (where.isActive ?? true),
      ) ?? null,
  };
  const userTeams = {
    createQueryBuilder() {
      let userId = '';
      let organizationId = '';
      const qb: any = {
        innerJoin: (_t: string, _a: string, _on: string, p: any) => { organizationId = p.organizationId; return qb; },
        where: (_c: string, p: any) => { userId = p.userId; return qb; },
        select: () => qb,
        getRawMany: async () =>
          teams
            .filter((r) => r.userId === userId && r.organizationId === organizationId && r.isActive)
            .map((r) => ({ teamId: r.teamId, role: r.role })),
      };
      return qb;
    },
  };
  return new AccessPolicyService(userOrgs as any, userTeams as any);
}

const agent = {
  id: 'agent-1',
  organizationId: 'org-1',
  visibility: 'team',
  teamId: 'team-a',
  createdBy: 'owner',
} as any;

describe('AgentsService.viewerCanManage', () => {
  const accessPolicy = policy();
  const viewerCanManage = (userId: string | null) =>
    AgentsService.prototype.viewerCanManage.call({ accessPolicy }, agent, userId);

  it('is true for a lead of the agent team, who is neither org admin nor owner', async () => {
    await expect(viewerCanManage('lead')).resolves.toBe(true);
  });

  it('is false for a plain member of another team', async () => {
    await expect(viewerCanManage('other')).resolves.toBe(false);
  });

  it('is true for the owner and for an org admin, false for nobody', async () => {
    await expect(viewerCanManage('owner')).resolves.toBe(true);
    await expect(viewerCanManage('admin')).resolves.toBe(true);
    await expect(viewerCanManage(null)).resolves.toBe(false);
  });

  it('agrees with assertManageable, the rule the manage paths enforce', async () => {
    for (const userId of ['lead', 'other', 'owner', 'admin']) {
      const allowed = await viewerCanManage(userId);
      const enforced = await assertManageable(accessPolicy, userId, agent, 'Agent', { ownerManages: true })
        .then(() => true)
        .catch((e) => {
          if (e instanceof ForbiddenException || e instanceof NotFoundException) return false;
          throw e;
        });
      expect(allowed).toBe(enforced);
    }
  });
});
