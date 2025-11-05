import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
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
import { CreateTeamDto } from './dto/create-team.dto';

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

  async inviteUser(organizationId: string, inviteUserDto: InviteUserDto, invitedBy: string): Promise<void> {
    // Check if user exists
    const user = await this.userRepository.findOne({
      where: { email: inviteUserDto.email },
    });

    if (!user) {
      // User doesn't exist yet - in a real app, we'd create a pending invitation
      // For now, just log and return success (invitation would be sent via email)
      this.logger.log(`Invitation sent to non-registered user: ${inviteUserDto.email}`);
      // TODO: Implement pending invitations table and email sending
      return;
    }

    // Check if user is already a member
    const existingMembership = await this.userOrganizationRepository.findOne({
      where: {
        userId: user.id,
        organizationId,
      },
    });

    if (existingMembership) {
      if (existingMembership.isActive) {
        throw new ConflictException('User is already a member of this organization');
      } else {
        // Reactivate existing membership
        existingMembership.isActive = true;
        existingMembership.role = inviteUserDto.role;
        existingMembership.invitedBy = invitedBy;
        existingMembership.permissions = inviteUserDto.permissions;
        await this.userOrganizationRepository.save(existingMembership);
        return;
      }
    }

    // Create new membership
    const membership = this.userOrganizationRepository.create({
      userId: user.id,
      organizationId,
      role: inviteUserDto.role,
      invitedBy,
      permissions: inviteUserDto.permissions,
      isActive: true,
      inviteAccepted: false, // User needs to accept invitation
    });

    await this.userOrganizationRepository.save(membership);

    // TODO: Send invitation email
  }

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

  async updateTeam(teamId: string, updateData: { name?: string; description?: string }): Promise<Team> {
    const team = await this.teamRepository.findOne({
      where: { id: teamId },
    });

    if (!team) {
      throw new NotFoundException('Team not found');
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
    return this.teamRepository.find({
      where: { organizationId, isActive: true },
      relations: ['members', 'members.user'],
      order: { createdAt: 'DESC' },
    });
  }

  async addTeamMember(teamId: string, userId: string, role: TeamRole = TeamRole.MEMBER): Promise<void> {
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

  async updateTeamMemberRole(teamId: string, userId: string, newRole: string): Promise<void> {
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

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    const membership = await this.userTeamRepository.findOne({
      where: { teamId, userId },
    });

    if (!membership) {
      throw new NotFoundException('User is not a member of this team');
    }

    await this.userTeamRepository.remove(membership);
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