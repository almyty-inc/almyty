import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { OrganizationsService } from '../organizations.service';
import { OrganizationRole, UserOrganization } from '../../../entities/user-organization.entity';
import { Team } from '../../../entities/team.entity';
import { UserTeam } from '../../../entities/user-team.entity';
import { ResourceHandoverHelper } from '../resource-handover.helper';

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
    const txTeam = {
      remove: jest.fn(async () => { calls.push('team.remove'); }),
      find: jest.fn(async () => [{ id: 'everyone-team' }, { id: 'platform-team' }]),
    };
    const txUserTeam = { delete: jest.fn(async (_criteria: any) => { calls.push('teams.leave'); }) };
    const manager: any = {
      getRepository: jest.fn((entity: any) => (
        entity === UserOrganization ? txMembership : entity === Team ? txTeam : entity === UserTeam ? txUserTeam : null
      )),
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
    // A connection the handover wiped, secrets as they were.
    const wiped = { id: 'conn-1', organizationId: 'org-1', connectorKey: 'github', previousConfig: { accessToken: 'encrypted:x' } };
    const handover = {
      handOverPrivateResources: jest.fn(async (_m: any, args: any) => {
        calls.push('handover');
        args.wipedConnections?.push(wiped);
        args.afterCommit?.push(async () => { calls.push('after commit'); });
        return auditRows;
      }),
      revokeWipedConnectionsAtProviders: jest.fn(async () => { calls.push('provider revoke'); }),
      demoteTeamResources: jest.fn(async (_m: any, args: any) => {
        calls.push('demote');
        args.afterCommit?.push(async () => { calls.push('after commit'); });
        return auditRows;
      }),
      // The real lookup, against the transaction's membership repository.
      longestStandingOtherOwner: jest.fn((m: any, orgId: string, exclude: string) =>
        ResourceHandoverHelper.prototype.longestStandingOtherOwner.call(null, m, orgId, exclude)),
    };
    const audit = { publishCommitted: jest.fn(() => { calls.push('publish'); }) };
    const service = new OrganizationsService(
      {} as any, memberships, teams, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      undefined, undefined, undefined,
      handover as any,
      audit as any,
    );
    return { service, memberships, teams, handover, audit, manager, txMembership, txTeam, txUserTeam, qb, calls, auditRows, wiped };
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
        wipedConnections: [t.wiped],
        afterCommit: [expect.any(Function)],
      });
      expect(t.txMembership.remove).toHaveBeenCalledWith(target);
      // Handover and removal in one transaction; audit streamed after
      // commit; the wiped connections revoked at their providers last,
      // where a provider failing cannot undo the removal.
      // What the hosted-environment handover left for after commit (stopping
      // the leaver's pods, telling the new owner) runs only once it committed.
      expect(t.calls).toEqual(['begin', 'handover', 'teams.leave', 'membership.remove', 'commit', 'publish', 'after commit', 'provider revoke']);
      expect(t.audit.publishCommitted).toHaveBeenCalledWith(t.auditRows);
      expect(t.handover.revokeWipedConnectionsAtProviders).toHaveBeenCalledWith([t.wiped], {
        userId: 'leaver',
        actorUserId: 'admin-1',
        reason: 'member_removed',
      });
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
      // Nothing was wiped, so nothing is revoked at a provider either.
      expect(t.handover.revokeWipedConnectionsAtProviders).not.toHaveBeenCalled();
    });

    it('hands nothing over when the removal itself is refused', async () => {
      const t = build({
        target: { id: 'm-1', role: OrganizationRole.OWNER },
        actor: { id: 'm-2', role: OrganizationRole.ADMIN },
      });

      await expect(t.service.removeMember(org, 'owner-2', 'admin-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.handover.handOverPrivateResources).not.toHaveBeenCalled();
    });

    /**
     * Removing (or leaving) the organization left the person's user_teams
     * rows behind, so the "Everyone" team on staging counted 9 people in
     * an organization of 1. The team rows in this organization's teams go
     * in the same transaction as the membership, and only those.
     */
    it('takes the member out of every team of this organization, inside the removal transaction', async () => {
      const target = { id: 'm-1', userId: 'leaver', role: OrganizationRole.MEMBER };
      const t = build({ target, actor: { id: 'm-2', role: OrganizationRole.OWNER } });

      await t.service.removeMember(org, 'leaver', 'owner-1');

      expect(t.txTeam.find).toHaveBeenCalledWith({ where: { organizationId: org }, select: { id: true } });
      expect(t.txUserTeam.delete).toHaveBeenCalledTimes(1);
      const [criteria] = t.txUserTeam.delete.mock.calls[0] as any[];
      expect(criteria.userId).toBe('leaver');
      expect(criteria.teamId.value).toEqual(['everyone-team', 'platform-team']);
      expect(t.calls.indexOf('teams.leave')).toBeGreaterThan(t.calls.indexOf('begin'));
      expect(t.calls.indexOf('teams.leave')).toBeLessThan(t.calls.indexOf('commit'));
    });

    it('takes the member out of no team when the removal is refused', async () => {
      const t = build({
        target: { id: 'm-1', role: OrganizationRole.OWNER },
        actor: { id: 'm-2', role: OrganizationRole.ADMIN },
      });

      await expect(t.service.removeMember(org, 'owner-2', 'admin-1')).rejects.toBeInstanceOf(ForbiddenException);
      expect(t.txUserTeam.delete).not.toHaveBeenCalled();
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
        afterCommit: [expect.any(Function)],
      });
      expect(t.txTeam.remove).toHaveBeenCalledWith(team);
      // Owners of environments the team shared are told after commit.
      expect(t.calls).toEqual(['begin', 'demote', 'team.remove', 'commit', 'publish', 'after commit']);
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
