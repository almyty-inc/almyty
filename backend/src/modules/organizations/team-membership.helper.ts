import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';

/**
 * Single source of truth for default-team membership.
 *
 * Every org has exactly one team flagged isDefault=true (the "Everyone"
 * team — see migration 1745330000000). Every user who joins the org
 * is auto-joined to that team. Org owners get TeamRole.LEAD (=team_admin);
 * everyone else gets TeamRole.MEMBER.
 *
 * Three call sites (org-create, invite-accept-existing, invite-accept-pending)
 * all funnel through this helper so the rule stays consistent.
 */
@Injectable()
export class TeamMembershipHelper {
  private readonly logger = new Logger(TeamMembershipHelper.name);

  constructor(
    @InjectRepository(Team)
    private readonly teamRepository: Repository<Team>,
    @InjectRepository(UserTeam)
    private readonly userTeamRepository: Repository<UserTeam>,
  ) {}

  /**
   * Join `userId` to `organizationId`'s default team. Idempotent —
   * if the user is already a member of that team, this is a no-op.
   * If the org has no default team yet (a pre-Phase-0 org that
   * never ran the backfill, or a race), creates one inline.
   */
  async joinDefaultTeam(
    organizationId: string,
    userId: string,
    orgRole: OrganizationRole,
  ): Promise<void> {
    let defaultTeam = await this.teamRepository.findOne({
      where: { organizationId, isDefault: true },
    });
    if (!defaultTeam) {
      // Self-heal: the migration should have covered this, but never
      // lose the invariant "every org has a default team."
      this.logger.warn(`No default team for org ${organizationId}; creating now`);
      defaultTeam = await this.teamRepository.save(this.teamRepository.create({
        name: 'Everyone',
        description: 'Default team — every organization member is automatically a member.',
        organizationId,
        isDefault: true,
      }));
    }

    const existing = await this.userTeamRepository.findOne({
      where: { userId, teamId: defaultTeam.id },
    });
    if (existing) return;

    const role = orgRole === OrganizationRole.OWNER ? TeamRole.LEAD : TeamRole.MEMBER;
    await this.userTeamRepository.save(this.userTeamRepository.create({
      userId,
      teamId: defaultTeam.id,
      role,
      isActive: true,
    }));
  }
}
