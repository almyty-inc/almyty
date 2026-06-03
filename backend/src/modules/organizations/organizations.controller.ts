import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { OrganizationsService } from './organizations.service';
import { InviteUserDto } from './dto/invite-user.dto';
import { CreateTeamDto } from './dto/create-team.dto';
import { OrganizationRole } from '../../entities/user-organization.entity';

@Controller('organizations')
@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)  // Only JWT auth, no roles guard
  @ApiOperation({ summary: 'Get user organizations' })
  @ApiResponse({ status: 200, description: 'Organizations retrieved successfully' })
  async getUserOrganizations(@Request() req: any) {
    const data = await this.organizationsService.findAll(req.user.id);
    return { success: true, data, message: 'Organizations retrieved successfully' };
  }

  @Post()
  @UseGuards(JwtAuthGuard)  // Any authenticated user can create an org (no roles guard)
  @ApiOperation({ summary: 'Create organization' })
  @ApiResponse({ status: 201, description: 'Organization created successfully' })
  async createOrganization(@Body() createOrgDto: any, @Request() req: any) {
    const data = await this.organizationsService.create(createOrgDto, req.user.id);
    return { success: true, data, message: 'Organization created successfully' };
  }

  // NOTE: every org-scoped route below takes `:organizationId` rather
  // than `:id` so the global RolesGuard can extract it via
  // `request.params.organizationId` and verify that the caller is a
  // member of *that specific org* with the required role. Before this
  // rename the guard fell back to `currentOrganizationId` from the
  // JWT, which is the caller's own current org — meaning an admin of
  // org A could PATCH/DELETE org B, invite themselves as owner into
  // org B, or mutate any team in org B just by sending a different
  // URL path. The URL shape is unchanged (`/organizations/<uuid>/...`),
  // only the server-side param name changes, so no frontend callers
  // are affected.

  @Get(':organizationId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization by ID' })
  @ApiResponse({ status: 200, description: 'Organization retrieved successfully' })
  async getOrganization(@Param('organizationId', ParseUUIDPipe) organizationId: string, @Request() req: any) {
    const data = await this.organizationsService.findOne(organizationId);
    return { success: true, data, message: 'Organization retrieved successfully' };
  }

  @Patch(':organizationId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update organization' })
  @ApiResponse({ status: 200, description: 'Organization updated successfully' })
  async updateOrganization(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() updateOrgDto: any,
    @Request() req: any,
  ) {
    const data = await this.organizationsService.update(organizationId, updateOrgDto);
    return { success: true, data, message: 'Organization updated successfully' };
  }

  @Delete(':organizationId')
  @Roles('owner')
  @ApiOperation({ summary: 'Delete organization' })
  @ApiResponse({ status: 200, description: 'Organization deleted successfully' })
  async deleteOrganization(@Param('organizationId', ParseUUIDPipe) organizationId: string, @Request() req: any) {
    const data = await this.organizationsService.delete(organizationId);
    return { success: true, data, message: 'Organization deleted successfully' };
  }

  // Member Management
  @Get(':organizationId/members')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization members' })
  async getOrganizationMembers(@Param('organizationId', ParseUUIDPipe) organizationId: string, @Request() req: any) {
    const data = await this.organizationsService.getMembers(organizationId, req.user.id);
    return { success: true, data, message: 'Members retrieved successfully' };
  }

  @Post(':organizationId/members')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Invite user to organization' })
  async inviteUserToOrganization(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() inviteData: InviteUserDto,
    @Request() req: any
  ) {
    const data = await this.organizationsService.inviteUser(organizationId, inviteData, req.user.id);
    return { success: true, data, message: 'User invited successfully' };
  }

  @Get(':organizationId/invites')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'List pending invites for the organization' })
  async listPendingInvites(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    const data = await this.organizationsService.listPendingInvites(organizationId);
    return { success: true, data, message: 'Pending invites retrieved successfully' };
  }

  @Delete(':organizationId/invites/:inviteId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Revoke a pending invite' })
  async revokePendingInvite(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('inviteId') inviteId: string,
  ) {
    const data = await this.organizationsService.revokePendingInvite(organizationId, inviteId);
    return { success: true, data, message: 'Invite revoked' };
  }

  @Put(':organizationId/members/:userId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update member role' })
  async updateMemberRole(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() roleData: { role: OrganizationRole },
    @Request() req: any
  ) {
    const data = await this.organizationsService.updateMemberRole(organizationId, userId, roleData.role, req.user.id);
    return { success: true, data, message: 'Member role updated successfully' };
  }

  @Delete(':organizationId/members/:userId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Remove member from organization' })
  async removeMember(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: any
  ) {
    const data = await this.organizationsService.removeMember(organizationId, userId);
    return { success: true, data, message: 'Member removed successfully' };
  }

  // Team Management
  @Get(':organizationId/teams')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization teams' })
  async getOrganizationTeams(@Param('organizationId', ParseUUIDPipe) organizationId: string, @Request() req: any) {
    const data = await this.organizationsService.getTeams(organizationId);
    return { success: true, data, message: 'Teams retrieved successfully' };
  }

  @Post(':organizationId/teams')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create team in organization' })
  async createTeam(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() teamData: CreateTeamDto,
    @Request() req: any
  ) {
    const data = await this.organizationsService.createTeam(organizationId, teamData);
    return { success: true, data, message: 'Team created successfully' };
  }

  @Put(':organizationId/teams/:teamId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Update team' })
  async updateTeam(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() teamData: { name: string; description?: string },
    @Request() req: any
  ) {
    // 'member' is permitted at the guard level so a team_admin (org
    // role=member, team role=lead) can reach this handler. The service
    // re-checks via assertCanManageTeam — owner/admin pass at the org
    // level; otherwise the caller must be lead of THIS team.
    const data = await this.organizationsService.updateTeam(
      organizationId,
      teamId,
      teamData,
      req.user.id,
    );
    return { success: true, data, message: 'Team updated successfully' };
  }

  @Delete(':organizationId/teams/:teamId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete a team' })
  async deleteTeam(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Request() req: any,
  ) {
    // Deletion is gated to org owner/admin; team_admin cannot delete.
    const data = await this.organizationsService.deleteTeam(organizationId, teamId, req.user.id);
    return { success: true, data, message: 'Team deleted successfully' };
  }

  @Get(':organizationId/teams/:teamId/members')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List team members' })
  async getTeamMembers(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Request() req: any,
  ) {
    const data = await this.organizationsService.getTeamMembers(organizationId, teamId);
    return { success: true, data, message: 'Team members retrieved successfully' };
  }

  @Post(':organizationId/teams/:teamId/members')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Add member to team' })
  async addMemberToTeam(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() memberData: { userId: string; role?: string },
    @Request() req: any
  ) {
    // 'member' permitted at guard level so team_admin can add members
    // to their own team; service re-checks via assertCanManageTeam.
    const data = await this.organizationsService.addTeamMember(
      organizationId,
      teamId,
      memberData.userId,
      undefined,
      req.user.id,
    );
    return { success: true, data, message: 'Member added to team successfully' };
  }

  @Put(':organizationId/teams/:teamId/members/:userId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Update team member role' })
  async updateTeamMemberRole(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() roleData: { role: string },
    @Request() req: any
  ) {
    const data = await this.organizationsService.updateTeamMemberRole(
      organizationId,
      teamId,
      userId,
      roleData.role,
      req.user.id,
    );
    return { success: true, data, message: 'Team member role updated successfully' };
  }

  @Delete(':organizationId/teams/:teamId/members/:userId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Remove member from team' })
  async removeMemberFromTeam(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: any
  ) {
    const data = await this.organizationsService.removeTeamMember(
      organizationId,
      teamId,
      userId,
      req.user.id,
    );
    return { success: true, data, message: 'Member removed from team successfully' };
  }
}
