import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { User } from '../../entities/user.entity';
import { CanonicalMemory } from '../memory/canonical/canonical-memory.entity';
import { CanonicalMemoryWorkspaceConfig } from '../memory/canonical/canonical-memory-config.entity';
import { CanonicalMemorySoftcapWarning } from '../memory/canonical/canonical-memory-softcap-warning.entity';

import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsInvitesHelper } from './organizations-invites.helper';
import { TeamMembershipHelper } from './team-membership.helper';
import { CreateTeamDto } from './dto/create-team.dto';
import { MailService } from '../mail/mail.service';
import { GatewaysService } from '../gateways/gateways.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ResourceHandoverHelper } from './resource-handover.helper';

import { ORGANIZATION_ROLE_RANK } from './organization-role-rank';

/** Fields on a User row that must never reach another user. */
export const USER_SECRET_FIELDS = [
  'passwordHash',
  'resetPasswordToken',
  'resetPasswordExpires',
  'verificationToken',
  'twoFactorSecret',
] as const;

/** Remove user credentials from anything carrying loaded member relations. */
export function stripMemberSecrets<T extends { members?: any[]; settings?: any }>(organization: T): T {
  for (const membership of organization.members ?? []) {
    if (membership?.user) for (const field of USER_SECRET_FIELDS) delete membership.user[field];
    // The membership row carries its own invite token.
    delete (membership as any).inviteToken;
  }
  // Pending invites live in settings and carry single-use invite tokens,
  // which are as good as a password to whoever holds one.
  const pending = (organization as any).settings?.pendingInvites;
  if (Array.isArray(pending)) {
    (organization as any).settings.pendingInvites = pending.map(({ inviteToken, ...rest }: any) => rest);
  }
  return organization;
}

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(Team)
    private teamRepository: Repository<Team>,
    @InjectRepository(UserTeam)
    private userTeamRepository: Repository<UserTeam>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private readonly mailService: MailService,
    @Inject(forwardRef(() => GatewaysService))
    private readonly gatewaysService: GatewaysService,
    private readonly invitesHelper: OrganizationsInvitesHelper,
    private readonly teamMembershipHelper: TeamMembershipHelper,
    // Canonical memory has no organizationId column, so org deletion
    // clears it by scope_id. @Optional() keeps the unit tests that
    // construct this service positionally working.
    @Optional()
    @InjectRepository(CanonicalMemory)
    private readonly memoryRepository?: Repository<CanonicalMemory>,
    @Optional()
    @InjectRepository(CanonicalMemoryWorkspaceConfig)
    private readonly memoryConfigRepository?: Repository<CanonicalMemoryWorkspaceConfig>,
    @Optional()
    @InjectRepository(CanonicalMemorySoftcapWarning)
    private readonly memorySoftcapWarningRepository?: Repository<CanonicalMemorySoftcapWarning>,
    // Not @Optional(): Nest must inject these. Typed optional only so the
    // specs that build this service positionally still compile.
    private readonly handover?: ResourceHandoverHelper,
    private readonly auditLogService?: AuditLogService,
  ) {}

  async create(createOrganizationDto: CreateOrganizationDto, ownerId: string): Promise<Organization> {
    // Use the value we will persist for the duplicate check as well.
    // The UI omits this optional field; strict TypeORM rejects an
    // undefined WHERE value before the first organization can be saved.
    const slug = createOrganizationDto.slug || this.generateSlug(createOrganizationDto.name);
    // Check if organization name or slug already exists
    const existingOrg = await this.organizationRepository.findOne({
      where: [
        { name: createOrganizationDto.name },
        { slug },
      ],
    });

    if (existingOrg) {
      throw new ConflictException('Organization with this name or slug already exists');
    }

    // Create organization
    const organization = this.organizationRepository.create({
      ...createOrganizationDto,
      slug,
    });

    const savedOrganization = await this.organizationRepository.save(organization);

    // Add creator as owner
    const membership = this.userOrganizationRepository.create({
      userId: ownerId,
      organizationId: savedOrganization.id,
      role: OrganizationRole.OWNER,
      isActive: true,
      inviteAccepted: true,
    });

    await this.userOrganizationRepository.save(membership);

    // Auto-provision default "Everyone" team and join the owner.
    // Helper handles creation idempotently and assigns TeamRole.LEAD
    // for owners (= team_admin in the GitHub-style two-tier model).
    await this.teamMembershipHelper.joinDefaultTeam(
      savedOrganization.id,
      ownerId,
      OrganizationRole.OWNER,
    );


    // Provision the system gateway so MCP OAuth works out of the box
    try {
      await this.gatewaysService.ensureSystemGateway(savedOrganization.id);
    } catch (err) {
      this.logger.warn(`Failed to provision system gateway for org ${savedOrganization.id}: ${err.message}`);
    }

    return this.findOne(savedOrganization.id);
  }

  /**
   * The organizations this user belongs to, each carrying how many active
   * members it has.
   *
   * The count is not decoration: the list page prints "N members" per row
   * and the detail header repeats it. Nothing here loaded `members`, so
   * `org.members?.length` was undefined and every organization claimed
   * zero members -- including ones the caller could see a full member
   * table for on the next tab. Counted with a grouped COUNT rather than
   * by hydrating the relation, because the rows themselves are not wanted
   * and each one drags a User with it.
   */
  async findAll(userId: string): Promise<Organization[]> {
    const memberships = await this.userOrganizationRepository.find({
      where: { userId, isActive: true },
      relations: { organization: true },
      order: { joinedAt: 'DESC' },
    });

    const organizations = memberships.map(membership => membership.organization);
    if (organizations.length === 0) {
      return organizations;
    }

    const counts = await this.userOrganizationRepository
      .createQueryBuilder('membership')
      .select('membership.organizationId', 'organizationId')
      .addSelect('COUNT(*)', 'count')
      .where('membership.organizationId IN (:...ids)', {
        ids: organizations.map(organization => organization.id),
      })
      .andWhere('membership.isActive = :isActive', { isActive: true })
      .groupBy('membership.organizationId')
      .getRawMany<{ organizationId: string; count: string }>();

    const byId = new Map(counts.map(row => [row.organizationId, Number(row.count)]));
    for (const organization of organizations) {
      (organization as Organization & { memberCount: number }).memberCount =
        byId.get(organization.id) ?? 0;
    }

    return organizations;
  }

  /**
   * Strip every member's credentials from an organization payload.
   *
   * `members: { user: true }` loads whole User rows, and this route is
   * open to `member`. That put each colleague's bcrypt `passwordHash` and,
   * worse, their live `resetPasswordToken` in the hands of anyone in the
   * organization -- a token that is a direct account takeover of the
   * owner, no cracking required. @Exclude() on the entity does nothing
   * here because no ClassSerializerInterceptor is registered anywhere in
   * this application, so the decorator has never masked anything.
   *
   * Done by deletion rather than by a select list on purpose: a new
   * secret column added to User later is dropped by the deny-list only if
   * someone remembers, so the list of what must never ship is kept in one
   * place and asserted by a test.
   */
  async findOne(id: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({
      where: { id },
      relations: {
        members: { user: true },
        teams: true,
        apis: true,
        gateways: true,
      },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return stripMemberSecrets(organization);
  }

  async findBySlug(slug: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({
      where: { slug },
      relations: {
        members: { user: true },
        teams: true,
      },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    // Same deny-list as findOne. This loads whole User rows through
    // `members: { user: true }` and returned them raw -- every member's
    // bcrypt hash and, worse, their live resetPasswordToken. No route
    // reaches this today, which is exactly why it is worth closing now:
    // the next caller inherits the leak silently.
    return stripMemberSecrets(organization);
  }

  async update(id: string, updateOrganizationDto: UpdateOrganizationDto): Promise<Organization> {
    const organization = await this.findOne(id);

    // Check for conflicts if name or slug is being updated
    if (updateOrganizationDto.name || updateOrganizationDto.slug) {
      const conflictWhere: any[] = [];

      // Only check for conflicts if the name is actually changing
      if (updateOrganizationDto.name && updateOrganizationDto.name !== organization.name) {
        conflictWhere.push({ name: updateOrganizationDto.name });
      }

      // Only check for conflicts if the slug is actually changing
      if (updateOrganizationDto.slug && updateOrganizationDto.slug !== organization.slug) {
        conflictWhere.push({ slug: updateOrganizationDto.slug });
      }

      // Only perform the conflict check if there are fields to check
      if (conflictWhere.length > 0) {
        const existingOrg = await this.organizationRepository.findOne({
          where: conflictWhere,
        });

        if (existingOrg && existingOrg.id !== id) {
          throw new ConflictException('Organization with this name or slug already exists');
        }
      }
    }

    // Settings are patched, not replaced: a client sending only
    // { settings: { defaultRouting } } must not wipe the limits or the
    // pending invites other features keep in the same column. A key set
    // to null clears it.
    const { settings, ...rest } = updateOrganizationDto;
    Object.assign(organization, rest);
    if (settings) {
      organization.settings = { ...(organization.settings ?? {}), ...settings };
    }

    return this.organizationRepository.save(organization);
  }

  /**
   * Delete the organization and the data no database cascade can reach.
   *
   * Almost everything an organization owns hangs off an `organizationId`
   * foreign key and goes with the row. Canonical memory does not: the
   * `memories`, `memory_workspace_config` and `memory_softcap_warnings`
   * tables are keyed by (scope_type, scope_id) with no organizationId
   * column and no foreign key, because scope_id is polymorphic. Nothing
   * else would ever remove those rows — the TTL sweeper only sets
   * valid_until, and RetentionPolicy has no memory class — so a deleted
   * tenant's memory content and embeddings would sit in the database
   * indefinitely.
   *
   * scope_id is the organization id for every scope_type
   * (scopeToOrganizationId is the identity), so one predicate covers all
   * of them.
   */
  async delete(id: string): Promise<void> {
    const organization = await this.findOne(id);

    // Check if organization has any active APIs or gateways
    if (organization.apis?.length > 0) {
      throw new ForbiddenException('Cannot delete organization with active APIs');
    }

    if (organization.gateways?.length > 0) {
      throw new ForbiddenException('Cannot delete organization with active gateways');
    }

    await this.deleteCanonicalMemory(id);
    await this.organizationRepository.remove(organization);
  }

  private async deleteCanonicalMemory(organizationId: string): Promise<void> {
    // Softcap warnings first, then the config, then the memories
    // themselves: the warnings name a memory_id and the memories
    // self-reference, so the content goes last.
    for (const repository of [
      this.memorySoftcapWarningRepository,
      this.memoryConfigRepository,
      this.memoryRepository,
    ]) {
      if (!repository) continue;
      try {
        await repository.delete({ scopeId: organizationId } as any);
      } catch (err: any) {
        // A failed memory delete must not leave the organization row
        // behind: a half-deleted tenant is worse than a stranded table,
        // and the next attempt can retry this.
        this.logger.error(
          `Failed to delete canonical memory for organization ${organizationId}: ${err.message}`,
        );
        throw err;
      }
    }
  }

  async getMembers(organizationId: string, requestingUserId: string): Promise<any[]> {
    // Verify user has access to this organization
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId: requestingUserId, isActive: true },
    });

    if (!membership) {
      throw new ForbiddenException('User is not a member of this organization');
    }

    // Get all members
    const members = await this.userOrganizationRepository.find({
      where: { organizationId, isActive: true },
      relations: { user: true },
      order: { joinedAt: 'ASC' },
    });

    return members.map(member => ({
      id: member.id,
      userId: member.user.id,
      email: member.user.email,
      firstName: member.user.firstName,
      lastName: member.user.lastName,
      role: member.role,
      joinedAt: member.joinedAt,
      invitedBy: member.invitedBy,
      isActive: member.isActive,
    }));
  }


  // ── Delegations to OrganizationsInvitesHelper ──
  inviteUser(...args: Parameters<OrganizationsInvitesHelper['inviteUser']>) { return this.invitesHelper.inviteUser(...args); }
  acceptInvite(...args: Parameters<OrganizationsInvitesHelper['acceptInvite']>) { return this.invitesHelper.acceptInvite(...args); }
  getInviteDetails(...args: Parameters<OrganizationsInvitesHelper['getInviteDetails']>) { return this.invitesHelper.getInviteDetails(...args); }
  listPendingInvites(...args: Parameters<OrganizationsInvitesHelper['listPendingInvites']>) { return this.invitesHelper.listPendingInvites(...args); }
  revokePendingInvite(...args: Parameters<OrganizationsInvitesHelper['revokePendingInvite']>) { return this.invitesHelper.revokePendingInvite(...args); }

  async removeMember(organizationId: string, userId: string, actorUserId: string): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new NotFoundException('User is not a member of this organization');
    }

    // An actor may not evict somebody who outranks them.
    //
    // updateMemberRole states this rule and this sibling did not, so the
    // route reached by `@Roles('admin','owner')` let an admin delete the
    // organization's owners outright -- everything the rank check on the
    // role route prevents, reached by removing the owner instead of
    // demoting them. The last-owner floor below was the only thing in the
    // way, and it stops at one.
    const actorMembership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId: actorUserId, isActive: true },
    });
    if (!actorMembership) {
      throw new ForbiddenException('You are not a member of this organization');
    }
    if (
      userId !== actorUserId &&
      ORGANIZATION_ROLE_RANK[membership.role] < ORGANIZATION_ROLE_RANK[actorMembership.role]
    ) {
      throw new ForbiddenException('Cannot remove a member who outranks you');
    }

    // Check if user is the last owner
    if (membership.role === OrganizationRole.OWNER) {
      const ownerCount = await this.userOrganizationRepository.count({
        where: {
          organizationId,
          role: OrganizationRole.OWNER,
          isActive: true,
        },
      });

      if (ownerCount <= 1) {
        throw new ForbiddenException('Cannot remove the last owner of the organization');
      }
    }

    // The departed member's private resources would otherwise be nobody's:
    // visible to no one, deletable by no one. They move to whoever removed
    // them -- or, when the member leaves on their own, to the organization's
    // longest-standing remaining owner -- and stay private. Their runners
    // are deregistered, their own connections revoked and grants naming
    // them removed (ResourceHandoverHelper says why). Same transaction as
    // the membership removal, so neither happens alone.
    const reason = userId === actorUserId ? 'member_left' : 'member_removed';
    const audit = await this.userOrganizationRepository.manager.transaction(async (manager) => {
      const toUserId =
        reason === 'member_removed'
          ? actorUserId
          : await this.longestStandingOtherOwner(manager, organizationId, userId);
      const entries = await this.requireHandover().handOverPrivateResources(manager, {
        organizationId,
        fromUserId: userId,
        toUserId,
        actorUserId,
        reason,
      });
      await manager.getRepository(UserOrganization).remove(membership);
      return entries;
    });
    this.auditLogService?.publishCommitted(audit);
  }

  /**
   * The owner who has been in the organization longest, other than
   * `excludeUserId`. There always is one: the last owner cannot leave.
   */
  private async longestStandingOtherOwner(
    manager: EntityManager,
    organizationId: string,
    excludeUserId: string,
  ): Promise<string> {
    const owner = await manager
      .getRepository(UserOrganization)
      .createQueryBuilder('m')
      .where('m.organizationId = :organizationId', { organizationId })
      .andWhere('m.role = :role', { role: OrganizationRole.OWNER })
      .andWhere('m.isActive = true')
      .andWhere('m.userId <> :excludeUserId', { excludeUserId })
      .orderBy('m.joinedAt', 'ASC', 'NULLS LAST')
      .addOrderBy('m.id', 'ASC')
      .getOne();
    if (!owner) {
      throw new ForbiddenException('Cannot remove the last owner of the organization');
    }
    return owner.userId;
  }

  private requireHandover(): ResourceHandoverHelper {
    // Nest always injects it; only a hand-built instance can lack it, and
    // silently skipping the handover would strand private resources.
    if (!this.handover) throw new Error('ResourceHandoverHelper is not wired into OrganizationsService');
    return this.handover;
  }

  async updateMemberRole(
    organizationId: string,
    userId: string,
    role: OrganizationRole,
    actorUserId: string,
  ): Promise<void> {
    // Lower rank value = more privilege. See ORGANIZATION_ROLE_RANK.
    const RANK = ORGANIZATION_ROLE_RANK;

    const actorMembership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId: actorUserId, isActive: true },
    });
    if (!actorMembership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });
    if (!membership) {
      throw new NotFoundException('User is not a member of this organization');
    }

    // An actor may never grant a role more privileged than their own,
    // nor act on a member who already outranks them. This stops an
    // admin from self-escalating (or promoting anyone) to owner.
    if (RANK[role] < RANK[actorMembership.role]) {
      throw new ForbiddenException('Cannot assign a role higher than your own');
    }
    if (RANK[membership.role] < RANK[actorMembership.role]) {
      throw new ForbiddenException('Cannot change the role of a member who outranks you');
    }

    // Check if trying to remove last owner
    if (membership.role === OrganizationRole.OWNER && role !== OrganizationRole.OWNER) {
      const ownerCount = await this.userOrganizationRepository.count({
        where: {
          organizationId,
          role: OrganizationRole.OWNER,
          isActive: true,
        },
      });

      if (ownerCount <= 1) {
        throw new ForbiddenException('Cannot change role of the last owner');
      }
    }

    membership.role = role;
    await this.userOrganizationRepository.save(membership);
  }


  async createTeam(organizationId: string, createTeamDto: CreateTeamDto): Promise<Team> {
    const team = this.teamRepository.create({
      ...createTeamDto,
      organizationId,
    });

    return this.teamRepository.save(team);
  }

  /**
   * Ensure `teamId` actually belongs to `organizationId`. Every team
   * mutation endpoint on this service used to look teams up by id
   * only — so an admin of org A could call any team endpoint with a
   * team id that belongs to org B (and the RolesGuard, which before
   * this rename was scoped to the caller's own org, would let them
   * through). Throw NotFound (not Forbidden) so we don't expose the
   * existence of teams outside the caller's org.
   */
  private async assertTeamInOrg(teamId: string, organizationId: string): Promise<Team> {
    const team = await this.teamRepository.findOne({
      where: { id: teamId, organizationId },
    });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    return team;
  }

  /**
   * RBAC for team mutations. Two paths grant access:
   *
   *   1. Caller is an `owner` or `admin` of the organization the team
   *      belongs to. They can do anything (rename, delete, member CRUD).
   *   2. Caller has TeamRole.LEAD on this specific team (= 'team_admin'
   *      in the GitHub-style two-tier model). They can rename the team
   *      and manage members within it, but cannot delete the team.
   *
   * The action scope distinguishes (1) from (2):
   *   - 'rename' / 'manage-members' — team_admin allowed
   *   - 'delete' — org admin/owner only
   *
   * Throws ForbiddenException on denial. Caller is expected to have
   * already proven the team belongs to the org via assertTeamInOrg().
   *
   * Implemented inline (rather than via AccessPolicyService) to avoid
   * a forwardRef cycle between OrganizationsModule and AuthModule.
   */
  private async assertCanManageTeam(
    actingUserId: string,
    organizationId: string,
    teamId: string,
    action: 'rename' | 'manage-members' | 'delete',
  ): Promise<void> {
    // Org-level grant: owner/admin of THIS org can do anything.
    const orgMembership = await this.userOrganizationRepository.findOne({
      where: { userId: actingUserId, organizationId, isActive: true },
    });

    if (
      orgMembership &&
      (orgMembership.role === OrganizationRole.OWNER ||
        orgMembership.role === OrganizationRole.ADMIN)
    ) {
      return;
    }

    // 'delete' is gated to org admin/owner only — team_admin cannot
    // delete its own team. The RolesGuard normally catches this at
    // the controller level, but enforce it here too in case an internal
    // caller hits the service with a non-admin user.
    if (action === 'delete') {
      throw new ForbiddenException('Only organization admins or owners can delete teams');
    }

    // Team-level grant: lead of THIS team passes for rename + member
    // management. Lookup is scoped by teamId, so a lead of team A
    // cannot affect team B even within the same org.
    const teamMembership = await this.userTeamRepository.findOne({
      where: { userId: actingUserId, teamId, isActive: true },
    });

    if (teamMembership && teamMembership.role === TeamRole.LEAD) {
      return;
    }

    throw new ForbiddenException('Insufficient privileges to manage this team');
  }

  async updateTeam(
    organizationId: string,
    teamId: string,
    updateData: { name?: string; description?: string },
    actingUserId?: string,
  ): Promise<Team> {
    const team = await this.assertTeamInOrg(teamId, organizationId);

    // RBAC: org owner/admin OR team_admin (lead) of THIS team.
    // actingUserId is optional so internal callers (no HTTP request)
    // bypass the check; HTTP callers always pass it.
    if (actingUserId) {
      await this.assertCanManageTeam(actingUserId, organizationId, teamId, 'rename');
    }

    if (updateData.name) {
      team.name = updateData.name;
    }

    if (updateData.description !== undefined) {
      team.description = updateData.description;
    }

    return this.teamRepository.save(team);
  }

  async getTeams(organizationId: string): Promise<Team[]> {
    // Self-heal: if an org somehow has no default team (the migration
    // missed it, or the org was created via a code path that didn't
    // call joinDefaultTeam — both gaps now fixed but pre-existing
    // orgs remain affected until they hit this endpoint), provision
    // one before returning. Joins every active org owner as LEAD so
    // the UI shows the right team_admin badge on the first paint.
    const hasDefault = (await this.teamRepository.count({
      where: { organizationId, isDefault: true, isActive: true },
    })) > 0;
    if (!hasDefault) {
      const owners = await this.userOrganizationRepository.find({
        where: { organizationId, role: OrganizationRole.OWNER, isActive: true },
      });
      for (const owner of owners) {
        await this.teamMembershipHelper.joinDefaultTeam(
          organizationId,
          owner.userId,
          OrganizationRole.OWNER,
        );
      }
    }

    return this.teamRepository.find({
      where: { organizationId, isActive: true },
      relations: { members: { user: true } },
      order: { createdAt: 'DESC' },
    });
  }

  async addTeamMember(
    organizationId: string,
    teamId: string,
    userId: string,
    role: TeamRole = TeamRole.MEMBER,
    actingUserId?: string,
  ): Promise<void> {
    await this.assertTeamInOrg(teamId, organizationId);

    // A team membership for somebody who is not in the organization is
    // a row that means nothing today -- access still goes through the
    // org role first -- and a live hole the day anything trusts
    // user_teams on its own.
    const orgMembership = await this.userOrganizationRepository.findOne({
      where: { userId, organizationId, isActive: true },
    });
    if (!orgMembership) {
      throw new NotFoundException('User not found in this organization');
    }

    if (actingUserId) {
      await this.assertCanManageTeam(actingUserId, organizationId, teamId, 'manage-members');
    }

    // Check if user is already a team member
    const existingMembership = await this.userTeamRepository.findOne({
      where: { teamId, userId },
    });

    if (existingMembership) {
      throw new ConflictException('User is already a member of this team');
    }

    const membership = this.userTeamRepository.create({
      teamId,
      userId,
      role,
    });

    await this.userTeamRepository.save(membership);
  }

  async updateTeamMemberRole(
    organizationId: string,
    teamId: string,
    userId: string,
    newRole: string,
    actingUserId?: string,
  ): Promise<void> {
    await this.assertTeamInOrg(teamId, organizationId);

    if (actingUserId) {
      await this.assertCanManageTeam(actingUserId, organizationId, teamId, 'manage-members');
    }

    const teamMembership = await this.userTeamRepository.findOne({
      where: { teamId, userId },
    });

    if (!teamMembership) {
      throw new NotFoundException('User is not a member of this team');
    }

    // Validate role
    if (!['member', 'lead'].includes(newRole)) {
      throw new BadRequestException('Invalid team role. Must be "member" or "lead"');
    }

    teamMembership.role = newRole as any;
    await this.userTeamRepository.save(teamMembership);
  }

  async removeTeamMember(
    organizationId: string,
    teamId: string,
    userId: string,
    actingUserId?: string,
  ): Promise<void> {
    await this.assertTeamInOrg(teamId, organizationId);

    if (actingUserId) {
      await this.assertCanManageTeam(actingUserId, organizationId, teamId, 'manage-members');
    }

    const membership = await this.userTeamRepository.findOne({
      where: { teamId, userId },
    });

    if (!membership) {
      throw new NotFoundException('User is not a member of this team');
    }

    await this.userTeamRepository.remove(membership);
  }

  async deleteTeam(
    organizationId: string,
    teamId: string,
    actingUserId?: string,
  ): Promise<void> {
    const team = await this.assertTeamInOrg(teamId, organizationId);

    // RBAC: org owner/admin only — team_admin cannot delete a team.
    if (actingUserId) {
      await this.assertCanManageTeam(actingUserId, organizationId, teamId, 'delete');
    }

    // Default 'Everyone' team is a permanent fixture per migration
    // 1745330000000 — every org member is auto-joined to it. Refuse
    // to delete so that invariant cannot be broken from the API.
    if (team.isDefault) {
      throw new BadRequestException('Cannot delete the default team');
    }

    // The team's resources become org-wide before the team goes: the
    // teamId FK would set them to NULL and the CHECK ('team' needs a
    // teamId) refuses that. The deleter is an org owner/admin who could
    // already see them all. The BEFORE DELETE trigger on teams does the
    // same for any other path; this one is audited.
    const audit = await this.teamRepository.manager.transaction(async (manager) => {
      const entries = await this.requireHandover().demoteTeamResources(manager, {
        organizationId,
        teamId: team.id,
        teamName: team.name,
        actorUserId: actingUserId ?? null,
      });
      await manager.getRepository(Team).remove(team);
      return entries;
    });
    this.auditLogService?.publishCommitted(audit);
  }

  async getTeamMembers(
    organizationId: string,
    teamId: string,
  ): Promise<any[]> {
    await this.assertTeamInOrg(teamId, organizationId);

    const memberships = await this.userTeamRepository.find({
      where: { teamId, isActive: true },
      relations: { user: true },
      order: { joinedAt: 'ASC' },
    });

    return memberships.map(m => ({
      id: m.id,
      userId: m.userId,
      email: m.user?.email,
      firstName: m.user?.firstName,
      lastName: m.user?.lastName,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
  }

  async getOrganizationStats(id: string): Promise<{
    membersCount: number;
    teamsCount: number;
    apisCount: number;
    gatewaysCount: number;
    plan: string;
  }> {
    const organization = await this.findOne(id);

    const membersCount = await this.userOrganizationRepository.count({
      where: { organizationId: id, isActive: true },
    });

    const teamsCount = await this.teamRepository.count({
      where: { organizationId: id, isActive: true },
    });

    return {
      membersCount,
      teamsCount,
      apisCount: organization.apis?.length || 0,
      gatewaysCount: organization.gateways?.length || 0,
      plan: organization.plan,
    };
  }

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 50);
  }

  async userHasPermission(userId: string, organizationId: string, permission: string): Promise<boolean> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { userId, organizationId, isActive: true },
    });

    if (!membership) {
      return false;
    }

    return membership.hasPermission(permission);
  }

  async userHasRole(userId: string, organizationId: string, roles: OrganizationRole[]): Promise<boolean> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { userId, organizationId, isActive: true },
    });

    if (!membership) {
      return false;
    }

    return roles.includes(membership.role);
  }
}
