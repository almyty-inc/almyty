import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';

import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { QueryUsersDto } from './dto/query-users.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { User } from '../../entities/user.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth('JWT-auth')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /**
   * Pull the caller's resolved current org out of the JWT strategy. This is
   * the same field RolesGuard uses, set from X-Organization-Id (or the
   * caller's single membership when unambiguous). Throws if missing rather
   * than passing `undefined` down to the service layer.
   */
  private requireOrg(req: any): string {
    const orgId = req?.user?.currentOrganizationId;
    if (!orgId) {
      throw new BadRequestException('Organization context required. Send X-Organization-Id.');
    }
    return orgId;
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(OrganizationRole.ADMIN, OrganizationRole.OWNER)
  @ApiOperation({ summary: 'Get users in the current organization (admin only)' })
  @ApiResponse({
    status: 200,
    description: 'Users retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        users: { type: 'array', items: { type: 'object' } },
        total: { type: 'number' },
        page: { type: 'number' },
        limit: { type: 'number' },
        totalPages: { type: 'number' },
      },
    },
  })
  async findAll(@Query() queryDto: QueryUsersDto, @Req() req: any) {
    // The DTO's organizationId field is ignored. Without this an admin in
    // org A could pass `?organizationId=ORG_B` (or omit it entirely) and
    // page through every user in ORG_B / the whole DB.
    const organizationId = this.requireOrg(req);
    return this.usersService.findAll({ ...queryDto, organizationId });
  }

  @Get('search')
  @ApiOperation({ summary: 'Search users in the current organization' })
  @ApiQuery({ name: 'q', description: 'Search query' })
  @ApiResponse({ status: 200, description: 'Search results' })
  async searchUsers(
    @Query('q') query: string,
    @Req() req: any,
  ) {
    if (!query || query.length < 2) {
      return { users: [] };
    }

    // Same fix as findAll: ignore any caller-supplied org id and force the
    // search to the caller's current org. The previous shape accepted an
    // arbitrary organizationId query param.
    const organizationId = this.requireOrg(req);
    const users = await this.usersService.searchUsers(query, organizationId);

    return {
      users: users.map(user => ({
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        isActive: user.isActive,
      })),
    };
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile retrieved' })
  async getCurrentUser(@CurrentUser() user: User) {
    const userWithStats = await this.usersService.findOne(user.id);
    const stats = await this.usersService.getUserStats(user.id);
    
    const { passwordHash, resetPasswordToken, verificationToken, ...profile } = userWithStats;
    
    return {
      ...profile,
      stats,
      organizationMemberships: userWithStats.organizationMemberships?.map(membership => ({
        id: membership.id,
        role: membership.role,
        joinedAt: membership.joinedAt,
        isActive: membership.isActive,
        organization: {
          id: membership.organization.id,
          name: membership.organization.name,
          slug: membership.organization.slug,
          description: membership.organization.description,
        },
      })),
    };
  }

  @Get('me/activity')
  @ApiOperation({ summary: 'Get current user activity' })
  @ApiQuery({ name: 'days', description: 'Number of days to look back', required: false })
  @ApiResponse({ status: 200, description: 'User activity retrieved' })
  async getCurrentUserActivity(
    @CurrentUser() user: User,
    @Query('days') days?: number,
  ) {
    const activity = await this.usersService.getUserActivity(user.id, days);
    
    return { activity };
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @RequirePermissions('read')
  @ApiOperation({ summary: 'Get user by ID (must share the current organization)' })
  @ApiResponse({ status: 200, description: 'User found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() currentUser: User,
    @Req() req: any,
  ) {
    // Self-lookup short-circuit so users can always read their own profile.
    if (id === currentUser.id) {
      const self = await this.usersService.findOne(id);
      const stats = await this.usersService.getUserStats(id);
      const { passwordHash, resetPasswordToken, verificationToken, apiKeys, ...profile } = self as any;
      return { ...profile, stats };
    }

    // For everyone else, the lookup is gated on shared org membership in
    // the caller's CURRENT org — not "the caller has admin role somewhere",
    // which used to let an admin of org A read any user in any other org.
    const organizationId = this.requireOrg(req);
    const user = await this.usersService.findOneInOrg(id, organizationId);
    const stats = await this.usersService.getUserStatsInOrg(id, organizationId);

    const { passwordHash, resetPasswordToken, verificationToken, apiKeys, ...profile } = user as any;
    return { ...profile, stats };
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  async updateCurrentUser(
    @CurrentUser() user: User,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    const updatedUser = await this.usersService.update(user.id, updateUserDto);
    
    const { passwordHash, resetPasswordToken, verificationToken, ...profile } = updatedUser;
    
    return {
      message: 'Profile updated successfully',
      user: profile,
    };
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(OrganizationRole.ADMIN, OrganizationRole.OWNER)
  @ApiOperation({ summary: 'Update user by ID (admin only, current org)' })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @Req() req: any,
  ) {
    const organizationId = this.requireOrg(req);
    const updatedUser = await this.usersService.updateInOrg(id, organizationId, updateUserDto);

    const { passwordHash, resetPasswordToken, verificationToken, ...profile } = updatedUser;

    return {
      message: 'User updated successfully',
      user: profile,
    };
  }

  @Post(':id/deactivate')
  @UseGuards(RolesGuard)
  @Roles(OrganizationRole.ADMIN, OrganizationRole.OWNER)
  @ApiOperation({ summary: 'Deactivate user (admin only, current org)' })
  @ApiResponse({ status: 200, description: 'User deactivated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deactivate(@Param('id') id: string, @Req() req: any) {
    const organizationId = this.requireOrg(req);
    await this.usersService.deactivateInOrg(id, organizationId);

    return {
      message: 'User deactivated successfully',
    };
  }

  @Post(':id/reactivate')
  @UseGuards(RolesGuard)
  @Roles(OrganizationRole.ADMIN, OrganizationRole.OWNER)
  @ApiOperation({ summary: 'Reactivate user (admin only, current org)' })
  @ApiResponse({ status: 200, description: 'User reactivated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async reactivate(@Param('id') id: string, @Req() req: any) {
    const organizationId = this.requireOrg(req);
    await this.usersService.reactivateInOrg(id, organizationId);

    return {
      message: 'User reactivated successfully',
    };
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(OrganizationRole.OWNER)
  @ApiOperation({ summary: 'Delete user (owner only, current org)' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 403, description: 'Cannot delete user - they are sole owner of organization(s)' })
  async remove(@Param('id') id: string, @Req() req: any) {
    const organizationId = this.requireOrg(req);
    await this.usersService.deleteInOrg(id, organizationId);

    return {
      message: 'User deleted successfully',
    };
  }

  @Get(':id/stats')
  @UseGuards(RolesGuard)
  @RequirePermissions('read')
  @ApiOperation({ summary: 'Get user statistics (current org)' })
  @ApiResponse({ status: 200, description: 'User statistics retrieved' })
  async getUserStats(@Param('id') id: string, @Req() req: any) {
    const organizationId = this.requireOrg(req);
    const stats = await this.usersService.getUserStatsInOrg(id, organizationId);

    return { stats };
  }

  @Get(':id/activity')
  @UseGuards(RolesGuard)
  @RequirePermissions('read')
  @ApiOperation({ summary: 'Get user activity (current org)' })
  @ApiQuery({ name: 'days', description: 'Number of days to look back', required: false })
  @ApiResponse({ status: 200, description: 'User activity retrieved' })
  async getUserActivity(
    @Param('id') id: string,
    @Req() req: any,
    @Query('days') days?: number,
  ) {
    const organizationId = this.requireOrg(req);
    const activity = await this.usersService.getUserActivityInOrg(id, organizationId, days);

    return { activity };
  }
}