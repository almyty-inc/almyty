import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';

import { Team } from '../../../src/entities/team.entity';
import { UserOrganization } from '../../../src/entities/user-organization.entity';
import { UserTeam } from '../../../src/entities/user-team.entity';
import { ScimService } from '../sso/scim.service';
import { ConnectionPrincipalSource, UserPrincipals } from './seams';

/**
 * Team and role principals for connection grants. Nothing new is
 * stored: SCIM groups already land as `teams` + `user_teams` rows
 * (`ScimService.createGroup` / `patchGroup`), and grants to a `team` or
 * `role` principal match through `GrantPrincipal.teamIds` / `roles`.
 * This service is the one place that answers "which teams and roles
 * does this user hold right now", so a user removed from an IdP group
 * stops matching the team's grants on the next resolve.
 *
 * Bound under `CONNECTION_PRINCIPAL_SOURCE`.
 * TODO(lead): have `GrantsService.principalFor` read teamIds / roles from
 * this source when it is bound (`@Optional() @Inject(CONNECTION_PRINCIPAL_SOURCE)`),
 * falling back to its own `teamIdsOf` otherwise.
 */
@Injectable()
export class GroupPrincipalSyncService implements ConnectionPrincipalSource {
  private readonly logger = new Logger(GroupPrincipalSyncService.name);

  constructor(
    @InjectRepository(UserTeam) private readonly userTeams: Repository<UserTeam>,
    @InjectRepository(Team) private readonly teams: Repository<Team>,
    @InjectRepository(UserOrganization) private readonly memberships: Repository<UserOrganization>,
    // Group membership is read through SCIM's view of the org's groups so
    // this module and the provisioning endpoint never disagree.
    @Optional() private readonly scim?: ScimService,
  ) {}

  /** The user's active org roles and active team ids in the organization. */
  async principalsFor(user: { id: string }, organizationId: string): Promise<UserPrincipals> {
    const membership = await this.memberships.findOne({ where: { userId: user.id, organizationId, isActive: true } });
    if (!membership) return { teamIds: [], roles: [] };
    const rows = await this.userTeams.find({ where: { userId: user.id, isActive: true } });
    let teamIds: string[] = [];
    if (rows.length) {
      const orgTeams = await this.teams.find({ where: { id: In(rows.map((r) => r.teamId)), organizationId, isActive: true } });
      teamIds = orgTeams.map((t) => t.id);
    }
    return { teamIds, roles: [String(membership.role)] };
  }

  /**
   * Align `user_teams` with the IdP's group membership as SCIM reports
   * it: users the IdP lists are (re)activated on the team, users it no
   * longer lists are deactivated so team grants stop applying to them.
   * Returns how many memberships changed.
   */
  async syncGroups(organizationId: string): Promise<{ groups: number; added: number; removed: number }> {
    if (!this.scim) return { groups: 0, added: 0, removed: 0 };
    const listing = await this.scim.listGroups(organizationId);
    let added = 0;
    let removed = 0;
    for (const group of listing.Resources ?? []) {
      const wanted = new Set((group.members ?? []).map((m: { value: string }) => m.value));
      const current = await this.userTeams.find({ where: { teamId: group.id } });
      for (const row of current) {
        const shouldBeActive = wanted.has(row.userId);
        if (row.isActive !== shouldBeActive) {
          row.isActive = shouldBeActive;
          await this.userTeams.save(row);
          if (shouldBeActive) added++;
          else removed++;
        }
        wanted.delete(row.userId);
      }
      for (const userId of wanted) {
        await this.userTeams.save(this.userTeams.create({ teamId: group.id, userId, isActive: true }));
        added++;
      }
    }
    if (added || removed) this.logger.log(`group sync for ${organizationId}: ${added} added, ${removed} removed`);
    return { groups: (listing.Resources ?? []).length, added, removed };
  }
}
