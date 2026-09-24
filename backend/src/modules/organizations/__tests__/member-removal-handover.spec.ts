import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { OrganizationsService } from '../organizations.service';
import { OrganizationRole, UserOrganization } from '../../../entities/user-organization.entity';
import { Team } from '../../../entities/team.entity';

/**
 * Member removal hands the departed member's private resources over, and
 * team deletion widens the team's resources, each in one transaction with
 * the removal itself. The SQL is proven against Postgres in
 * test/integration/resource-handover.integration.spec.ts; this pins the
 * service's side: who receives, what runs inside the transaction, and
 * that nothing is half-done when a step fails.
 */
describe('OrganizationsService: resource handover', () => {
  const org = 'org-1';

  function build(opts: { target: any; actor: any; ownerCount?: number; longestOwner?: any }) {
    const calls: string[] = [];
    const qb: any = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(opts.longestOwner ?? null),
    };
    const txMembership = {
      remove: jest.fn(async () => { calls.push('membership.remove'); }),
      createQueryBuilder: jest.fn(() => qb),
    };
    const txTeam = { remove: jest.fn(async () => { calls.push('team.remove'); }) };
    const manager: any = {
      getRepository: jest.fn((entity: any) => (entity === UserOrganization ? txMembership : entity === Team ? txTeam : null)),
    };
    const transaction = jest.fn(async (cb: any) => {
      calls.push('begin');
      const result = await cb(manager);
      calls.push('commit');
      return result;
    });
    const memberships: any = {
      findOne: jest.fn()
        .mockResolvedValueOnce(opts.target)
        .mockResolvedValueOnce(opts.actor),
      count: jest.fn().mockResolvedValue(opts.ownerCount ?? 2),
      remove: jest.fn(),
      manager: { transaction },
    };
    const teams: any = { findOne: jest.fn(), remove: jest.fn(), manager: { transaction } };
    const auditRows = [{ id: 'audit-1' }];
    const handover = {
      handOverPrivateResources: jest.fn(async () => { calls.push('handover'); return auditRows; }),
      demoteTeamResources: jest.fn(async () => { calls.push('demote'); return auditRows; }),
    };
    const audit = { publishCommitted: jest.fn(() => { calls.push('publish'); }) };
    const service = new OrganizationsService(
      {} as any, memberships, teams, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      undefined, undefined, undefined,
      handover as any,
      audit as any,
    );
    return { service, memberships, teams, handover, audit, manager, txMembership, txTeam, qb, calls, auditRows };
  }

  describe('removeMember', () => {
    it('hands the private resources to the remover inside the removal transaction, then publishes the audit', async () => {
      const target = { id: 'm-1', userId: 'leaver', role: OrganizationRole.MEMBER };
      const t = build({ target, actor: { id: 'm-2', role: OrganizationRole.ADMIN } });

      await t.service.removeMember(org, 'leaver', 'admin-1');

      expect(t.handover.handOverPrivateResources).toHaveBeenCalledWith(t.manager, {
        organizationId: org,
        fromUserId: 'leaver',
        toUserId: 'admin-1',
        actorUserId: 'admin-1',
        reason: 'member_removed',
      });
      expect(t.txMembership.remove).toHaveBeenCalledWith(target);
      // Handover and removal in one transaction; audit streamed after commit.
      expect(t.calls).toEqual(['begin', 'handover', 'membership.remove', 'commit', 'publish']);
      expect(t.audit.publishCommitted).toHaveBeenCalledWith(t.auditRows);
      // The membership goes through the transaction's manager, not the bare repository.
      expect(t.memberships.remove).not.toHaveBeenCalled();
    });

    it('a member leaving on their own hands over to the longest-standing other owner', async () => {
      const target = { id: 'm-1', userId: 'quitter', role: OrganizationRole.MEMBER };
      const t = build({
        target,
        actor: target,
        longestOwner: { userId: 'founder', role: OrganizationRole.OWNER },
      });

      await t.service.removeMember(org, 'quitter', 'quitter');

      expect(t.handover.handOverPrivateResources).toHaveBeenCalledWith(
        t.manager,
        expect.objectContaining({ fromUserId: 'quitter', toUserId: 'founder', actorUserId: 'quitter', reason: 'member_left' }),
      );
      expect(t.qb.andWhere).toHaveBeenCalledWith('m.role = :role', { role: OrganizationRole.OWNER });
      expect(t.qb.andWhere).toHaveBeenCalledWith('m.isActive = true');
      expect(t.qb.andWhere).toHaveBeenCalledWith('m.userId <> :excludeUserId', { excludeUserId: 'quitter' });
      expect(t.qb.orderBy).toHaveBeenCalledWith('m.joinedAt', 'ASC', 'NULLS LAST');
    });

    it('refuses to remove anyone when there is no other owner to receive', async () => {
      const target = { id: 'm-1', userId: 'quitter', role: OrganizationRole.MEMBER };
      const t = build({ target, actor: target, longestOwner: null });

      await expect(t.service.removeMember(org, 'quitter', 'quitter')).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.handover.handOverPrivateResources).not.toHaveBeenCalled();
      expect(t.txMembership.remove).not.toHaveBeenCalled();
    });

    it('does not remove the member or publish audit when the handover fails', async () => {
      const target = { id: 'm-1', userId: 'leaver', role: OrganizationRole.MEMBER };
      const t = build({ target, actor: { id: 'm-2', role: OrganizationRole.OWNER } });
      t.handover.handOverPrivateResources.mockRejectedValueOnce(new Error('db down'));

      await expect(t.service.removeMember(org, 'leaver', 'owner-1')).rejects.toThrow('db down');
      expect(t.txMembership.remove).not.toHaveBeenCalled();
      expect(t.audit.publishCommitted).not.toHaveBeenCalled();
    });

    it('hands nothing over when the removal itself is refused', async () => {
      const t = build({
        target: { id: 'm-1', role: OrganizationRole.OWNER },
        actor: { id: 'm-2', role: OrganizationRole.ADMIN },
      });

      await expect(t.service.removeMember(org, 'owner-2', 'admin-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.handover.handOverPrivateResources).not.toHaveBeenCalled();
    });
  });

  describe('deleteTeam', () => {
    it('widens the team resources to the org in the same transaction as the delete', async () => {
      const t = build({ target: null, actor: null });
      const team = { id: 'team-1', name: 'Platform', organizationId: org, isDefault: false };
      t.teams.findOne.mockResolvedValue(team);

      await t.service.deleteTeam(org, 'team-1');

      expect(t.handover.demoteTeamResources).toHaveBeenCalledWith(t.manager, {
        organizationId: org,
        teamId: 'team-1',
        teamName: 'Platform',
        actorUserId: null,
      });
      expect(t.txTeam.remove).toHaveBeenCalledWith(team);
      expect(t.calls).toEqual(['begin', 'demote', 'team.remove', 'commit', 'publish']);
      expect(t.teams.remove).not.toHaveBeenCalled();
    });

    it('does not touch resources for the default team', async () => {
      const t = build({ target: null, actor: null });
      t.teams.findOne.mockResolvedValue({ id: 'team-1', organizationId: org, isDefault: true });

      await expect(t.service.deleteTeam(org, 'team-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(t.handover.demoteTeamResources).not.toHaveBeenCalled();
    });
  });

  it('fails loudly rather than skip the handover when the helper is not wired', async () => {
    const memberships: any = {
      findOne: jest.fn()
        .mockResolvedValueOnce({ id: 'm-1', role: OrganizationRole.MEMBER })
        .mockResolvedValueOnce({ id: 'm-2', role: OrganizationRole.OWNER }),
      manager: { transaction: (cb: any) => cb({ getRepository: () => ({ remove: jest.fn() }) }) },
    };
    const service = new OrganizationsService(
      {} as any, memberships, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
    );
    await expect(service.removeMember(org, 'leaver', 'owner-1')).rejects.toThrow(/not wired/);
  });
});
