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

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization by ID' })
  @ApiResponse({ status: 200, description: 'Organization retrieved successfully' })
  async getOrganization(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const data = await this.organizationsService.findOne(id);
    return { success: true, data, message: 'Organization retrieved successfully' };
  }

  @Patch(':id')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update organization' })
  @ApiResponse({ status: 200, description: 'Organization updated successfully' })
  async updateOrganization(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateOrgDto: any,
    @Request() req: any,
  ) {
    const data = await this.organizationsService.update(id, updateOrgDto);
    return { success: true, data, message: 'Organization updated successfully' };
  }

  @Delete(':id')
  @Roles('owner')
  @ApiOperation({ summary: 'Delete organization' })
  @ApiResponse({ status: 200, description: 'Organization deleted successfully' })
  async deleteOrganization(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const data = await this.organizationsService.delete(id);
    return { success: true, data, message: 'Organization deleted successfully' };
  }

  // Member Management
  @Get(':id/members')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization members' })
  async getOrganizationMembers(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const data = await this.organizationsService.getMembers(id, req.user.id);
    return { success: true, data, message: 'Members retrieved successfully' };
  }

  @Post(':id/members')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Invite user to organization' })
  async inviteUserToOrganization(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() inviteData: InviteUserDto,
    @Request() req: any
  ) {
    const data = await this.organizationsService.inviteUser(id, inviteData, req.user.id);
    return { success: true, data, message: 'User invited successfully' };
  }

  @Put(':id/members/:userId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update member role' })
  async updateMemberRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() roleData: { role: OrganizationRole },
    @Request() req: any
  ) {
    const data = await this.organizationsService.updateMemberRole(id, userId, roleData.role, req.user.id);
    return { success: true, data, message: 'Member role updated successfully' };
  }

  @Delete(':id/members/:userId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Remove member from organization' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: any
  ) {
    const data = await this.organizationsService.removeMember(id, userId);
    return { success: true, data, message: 'Member removed successfully' };
  }

  // Team Management
  @Get(':id/teams')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization teams' })
  async getOrganizationTeams(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const data = await this.organizationsService.getTeams(id);
    return { success: true, data, message: 'Teams retrieved successfully' };
  }

  @Post(':id/teams')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create team in organization' })
  async createTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() teamData: CreateTeamDto,
    @Request() req: any
  ) {
    const data = await this.organizationsService.createTeam(id, teamData);
    return { success: true, data, message: 'Team created successfully' };
  }

  @Put(':id/teams/:teamId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update team' })
  async updateTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() teamData: { name: string; description?: string },
    @Request() req: any
  ) {
    const data = await this.organizationsService.updateTeam(teamId, teamData);
    return { success: true, data, message: 'Team updated successfully' };
  }

  @Post(':id/teams/:teamId/members')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Add member to team' })
  async addMemberToTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() memberData: { userId: string; role?: string },
    @Request() req: any
  ) {
    const data = await this.organizationsService.addTeamMember(teamId, memberData.userId);
    return { success: true, data, message: 'Member added to team successfully' };
  }

  @Put(':id/teams/:teamId/members/:userId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update team member role' })
  async updateTeamMemberRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() roleData: { role: string },
    @Request() req: any
  ) {
    const data = await this.organizationsService.updateTeamMemberRole(teamId, userId, roleData.role);
    return { success: true, data, message: 'Team member role updated successfully' };
  }

  @Delete(':id/teams/:teamId/members/:userId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Remove member from team' })
  async removeMemberFromTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: any
  ) {
    const data = await this.organizationsService.removeTeamMember(teamId, userId);
    return { success: true, data, message: 'Member removed from team successfully' };
  }
}