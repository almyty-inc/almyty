import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  ForbiddenException,
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

  @Get()
  @UseGuards(RolesGuard)
  @Roles(OrganizationRole.ADMIN, OrganizationRole.OWNER)
  @ApiOperation({ summary: 'Get all users (admin only)' })
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
  async findAll(@Query() queryDto: QueryUsersDto) {
    return this.usersService.findAll(queryDto);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search users by name or email' })
  @ApiQuery({ name: 'q', description: 'Search query' })
  @ApiQuery({ name: 'organizationId', description: 'Organization ID', required: false })
  @ApiResponse({ status: 200, description: 'Search results' })
  async searchUsers(
    @Query('q') query: string,
    @Query('organizationId') organizationId?: string,
  ) {
    if (!query || query.length < 2) {
      return { users: [] };
    }

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
  @ApiOperation({ summary: 'Get user by ID' })
  @ApiResponse({ status: 200, description: 'User found' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() currentUser: User,
  ) {
    // Users can only view their own profile unless they have admin permissions
    if (id !== currentUser.id) {
      const hasAdminRole = currentUser.organizationMemberships?.some(
        m => [OrganizationRole.ADMIN, OrganizationRole.OWNER].includes(m.role)
      );
      
      if (!hasAdminRole) {
        throw new ForbiddenException('You can only view your own profile');
      }
    }

    const user = await this.usersService.findOne(id);
    const stats = await this.usersService.getUserStats(id);
    
    const { passwordHash, resetPasswordToken, verificationToken, ...profile } = user;
    
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
  @ApiOperation({ summary: 'Update user by ID (admin only)' })
  @ApiResponse({ status: 200, description: 'User updated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async update(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    const updatedUser = await this.usersService.update(id, updateUserDto);
    
    const { passwordHash, resetPasswordToken, verificationToken, ...profile } = updatedUser;
    
    return {
      message: 'User updated successfully',
      user: profile,
    };
  }

  @Post(':id/deactivate')
  @UseGuards(RolesGuard)
  @Roles(OrganizationRole.ADMIN, OrganizationRole.OWNER)
  @ApiOperation({ summary: 'Deactivate user (admin only)' })
  @ApiResponse({ status: 200, description: 'User deactivated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deactivate(@Param('id') id: string) {
    await this.usersService.deactivate(id);
    
    return {
      message: 'User deactivated successfully',
    };
  }

  @Post(':id/reactivate')
  @UseGuards(RolesGuard)
  @Roles(OrganizationRole.ADMIN, OrganizationRole.OWNER)
  @ApiOperation({ summary: 'Reactivate user (admin only)' })
  @ApiResponse({ status: 200, description: 'User reactivated successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async reactivate(@Param('id') id: string) {
    await this.usersService.reactivate(id);
    
    return {
      message: 'User reactivated successfully',
    };
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(OrganizationRole.OWNER)
  @ApiOperation({ summary: 'Delete user (owner only)' })
  @ApiResponse({ status: 200, description: 'User deleted successfully' })
  @ApiResponse({ status: 404, description: 'User not found' })
  @ApiResponse({ status: 403, description: 'Cannot delete user - they are sole owner of organization(s)' })
  async remove(@Param('id') id: string) {
    await this.usersService.delete(id);
    
    return {
      message: 'User deleted successfully',
    };
  }

  @Get(':id/stats')
  @UseGuards(RolesGuard)
  @RequirePermissions('read')
  @ApiOperation({ summary: 'Get user statistics' })
  @ApiResponse({ status: 200, description: 'User statistics retrieved' })
  async getUserStats(@Param('id') id: string) {
    const stats = await this.usersService.getUserStats(id);
    
    return { stats };
  }

  @Get(':id/activity')
  @UseGuards(RolesGuard)
  @RequirePermissions('read')
  @ApiOperation({ summary: 'Get user activity' })
  @ApiQuery({ name: 'days', description: 'Number of days to look back', required: false })
  @ApiResponse({ status: 200, description: 'User activity retrieved' })
  async getUserActivity(
    @Param('id') id: string,
    @Query('days') days?: number,
  ) {
    const activity = await this.usersService.getUserActivity(id, days);
    
    return { activity };
  }
}