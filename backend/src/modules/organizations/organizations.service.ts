import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { User } from '../../entities/user.entity';

import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { InviteUserDto } from './dto/invite-user.dto';
import { OrganizationsInvitesHelper } from './organizations-invites.helper';
import { TeamMembershipHelper } from './team-membership.helper';
import { CreateTeamDto } from './dto/create-team.dto';
import { MailService } from '../mail/mail.service';
import { GatewaysService } from '../gateways/gateways.service';
import * as crypto from 'crypto';

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
    @Inject(forwardRef(() => GatewaysService))
    private readonly gatewaysService: GatewaysService,
    private readonly invitesHelper: OrganizationsInvitesHelper,
    private readonly teamMembershipHelper: TeamMembershipHelper,
  ) {}

  async create(createOrganizationDto: CreateOrganizationDto, ownerId: string): Promise<Organization> {
    // Check if organization name or slug already exists
    const existingOrg = await this.organizationRepository.findOne({
      where: [
        { name: createOrganizationDto.name },
        { slug: createOrganizationDto.slug },
      ],
    });

    if (existingOrg) {
      throw new ConflictException('Organization with this name or slug already exists');
    }

    // Create organization
    const organization = this.organizationRepository.create({
      ...createOrganizationDto,
      slug: createOrganizationDto.slug || this.generateSlug(createOrganizationDto.name),
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

  async findAll(userId: string): Promise<Organization[]> {
    const memberships = await this.userOrganizationRepository.find({
      where: { userId, isActive: true },
      relations: ['organization'],
      order: { joinedAt: 'DESC' },
    });

    return memberships.map(membership => membership.organization);
  }

  async findOne(id: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({
      where: { id },
      relations: [
        'members',
        'members.user',
        'teams',
        'apis',
        'gateways',
      ],
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return organization;
  }

  async findBySlug(slug: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({
      where: { slug },
      relations: [
        'members',
        'members.user',
        'teams',
      ],
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return organization;
  }

  async update(id: string, updateOrganizationDto: UpdateOrganizationDto): Promise<Organization> {
    const organization = await this.findOne(id);

    console.log('[UPDATE_ORG] Updating org:', {
      id,
      currentName: organization.name,
      currentSlug: organization.slug,
      newName: updateOrganizationDto.name,
      newSlug: updateOrganizationDto.slug,
    });

    // Check for conflicts if name or slug is being updated
    if (updateOrganizationDto.name || updateOrganizationDto.slug) {
      const conflictWhere: any[] = [];

      // Only check for conflicts if the name is actually changing
      if (updateOrganizationDto.name && updateOrganizationDto.name !== organization.name) {
        console.log('[UPDATE_ORG] Name is changing, will check for conflicts');
        conflictWhere.push({ name: updateOrganizationDto.name });
      } else if (updateOrganizationDto.name) {
        console.log('[UPDATE_ORG] Name NOT changing (same value), skip conflict check');
      }

      // Only check for conflicts if the slug is actually changing
      if (updateOrganizationDto.slug && updateOrganizationDto.slug !== organization.slug) {
        console.log('[UPDATE_ORG] Slug is changing, will check for conflicts');
        conflictWhere.push({ slug: updateOrganizationDto.slug });
      } else if (updateOrganizationDto.slug) {
        console.log('[UPDATE_ORG] Slug NOT changing (same value), skip conflict check');
      }

      console.log('[UPDATE_ORG] conflictWhere array length:', conflictWhere.length);

      // Only perform the conflict check if there are fields to check
      if (conflictWhere.length > 0) {
        const existingOrg = await this.organizationRepository.findOne({
          where: conflictWhere,
        });

        console.log('[UPDATE_ORG] Conflict check result:', existingOrg ? `Found org ${existingOrg.id}` : 'No conflict');

        if (existingOrg && existingOrg.id !== id) {
          console.log('[UPDATE_ORG] ERROR: Conflict detected!');
          throw new ConflictException('Organization with this name or slug already exists');
        }
      }
    }

    // Update organization
    Object.assign(organization, updateOrganizationDto);

    return this.organizationRepository.save(organization);
  }

  async delete(id: string): Promise<void> {
    const organization = await this.findOne(id);
    
    // Check if organization has any active APIs or gateways
    if (organization.apis?.length > 0) {
      throw new ForbiddenException('Cannot delete organization with active APIs');
    }

    if (organization.gateways?.length > 0) {
      throw new ForbiddenException('Cannot delete organization with active gateways');
    }

    await this.organizationRepository.remove(organization);
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
      relations: ['user'],
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

  async removeMember(organizationId: string, userId: string): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new NotFoundException('User is not a member of this organization');
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

    await this.userOrganizationRepository.remove(membership);
  }

  async updateMemberRole(
    organizationId: string,
    userId: string,
    role: OrganizationRole,
    permissions?: string[],
  ): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { organizationId, userId },
    });

    if (!membership) {
      throw new NotFoundException('User is not a member of this organization');
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
    if (permissions) {
      membership.permissions = permissions;
    }

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
      relations: ['members', 'members.user'],
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

    await this.teamRepository.remove(team);
  }

  async getTeamMembers(
    organizationId: string,
    teamId: string,
  ): Promise<any[]> {
    await this.assertTeamInOrg(teamId, organizationId);

    const memberships = await this.userTeamRepository.find({
      where: { teamId, isActive: true },
      relations: ['user'],
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