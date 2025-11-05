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
    return this.organizationsService.findAll(req.user.id);
  }

  @Post()
  @Roles('owner')
  @ApiOperation({ summary: 'Create organization' })
  @ApiResponse({ status: 201, description: 'Organization created successfully' })
  async createOrganization(@Body() createOrgDto: any, @Request() req: any) {
    return this.organizationsService.create(createOrgDto, req.user.id);
  }

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization by ID' })
  @ApiResponse({ status: 200, description: 'Organization retrieved successfully' })
  async getOrganization(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.organizationsService.findOne(id);
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
    return this.organizationsService.update(id, updateOrgDto);
  }

  @Delete(':id')
  @Roles('owner')
  @ApiOperation({ summary: 'Delete organization' })
  @ApiResponse({ status: 200, description: 'Organization deleted successfully' })
  async deleteOrganization(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.organizationsService.delete(id);
  }

  // Member Management
  @Get(':id/members')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get organization members' })
  async getOrganizationMembers(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.organizationsService.getMembers(id, req.user.id);
  }

  @Post(':id/members')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Invite user to organization' })
  async inviteUserToOrganization(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() inviteData: InviteUserDto,
    @Request() req: any
  ) {
    return this.organizationsService.inviteUser(id, inviteData, req.user.id);
  }

  @Put(':id/members/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Update member role' })
  async updateMemberRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() roleData: { role: OrganizationRole },
    @Request() req: any
  ) {
    return this.organizationsService.updateMemberRole(id, userId, roleData.role, req.user.id);
  }

  @Delete(':id/members/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Remove member from organization' })
  async removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: any
  ) {
    return this.organizationsService.removeMember(id, userId);
  }

  // Team Management  
  @Get(':id/teams')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get organization teams' })
  async getOrganizationTeams(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.organizationsService.getTeams(id);
  }

  @Post(':id/teams')
  @UseGuards(JwtAuthGuard) 
  @ApiOperation({ summary: 'Create team in organization' })
  async createTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() teamData: CreateTeamDto,
    @Request() req: any
  ) {
    return this.organizationsService.createTeam(id, teamData);
  }

  @Put(':id/teams/:teamId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Update team' })
  async updateTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() teamData: { name: string; description?: string },
    @Request() req: any
  ) {
    return this.organizationsService.updateTeam(teamId, teamData);
  }

  @Post(':id/teams/:teamId/members')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Add member to team' })
  async addMemberToTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() memberData: { userId: string; role?: string },
    @Request() req: any
  ) {
    return this.organizationsService.addTeamMember(teamId, memberData.userId);
  }

  @Put(':id/teams/:teamId/members/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Update team member role' })
  async updateTeamMemberRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() roleData: { role: string },
    @Request() req: any
  ) {
    return this.organizationsService.updateTeamMemberRole(teamId, userId, roleData.role);
  }

  @Delete(':id/teams/:teamId/members/:userId')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Remove member from team' })
  async removeMemberFromTeam(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: any
  ) {
    return this.organizationsService.removeTeamMember(teamId, userId);
  }
}