import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';

import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { UpdateUserDto } from './dto/update-user.dto';

export interface PaginatedUsers {
  users: User[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserOrganization)
    private userOrganizationRepository: Repository<UserOrganization>,
    @InjectRepository(ApiKey)
    private apiKeyRepository: Repository<ApiKey>,
  ) {}

  async findAll(options: {
    page?: number;
    limit?: number;
    search?: string;
    organizationId?: string;
  }): Promise<PaginatedUsers> {
    const { page = 1, limit = 10, search, organizationId } = options;

    // Required. Without it the join silently devolves into "every user in
    // every org", which is exactly the leak this method used to have.
    if (!organizationId) {
      throw new BadRequestException('organizationId is required');
    }

    const skip = (page - 1) * limit;

    let queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .innerJoin('user.organizationMemberships', 'membership', 'membership.organizationId = :organizationId', { organizationId })
      .leftJoinAndSelect('user.organizationMemberships', 'allMemberships')
      .leftJoinAndSelect('allMemberships.organization', 'allOrganization');

    // Apply search filter
    if (search) {
      queryBuilder = queryBuilder.andWhere(
        '(user.firstName ILIKE :search OR user.lastName ILIKE :search OR user.email ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    const [users, total] = await queryBuilder
      .skip(skip)
      .take(limit)
      .orderBy('user.createdAt', 'DESC')
      .getManyAndCount();

    return {
      users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Look up a user, but only if the caller and target share the given org.
   * Returns NotFoundException (not Forbidden) on a miss so the endpoint
   * can't be used to probe for user ids that exist in other orgs.
   */
  async findOneInOrg(id: string, organizationId: string): Promise<User> {
    if (!organizationId) {
      throw new BadRequestException('organizationId is required');
    }

    await this.assertUserInOrg(id, organizationId);
    return this.findOne(id);
  }

  private async assertUserInOrg(userId: string, organizationId: string): Promise<void> {
    const exists = await this.userOrganizationRepository.findOne({
      where: { userId, organizationId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('User not found');
    }
  }

  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: {
        organizationMemberships: { organization: true },
        apiKeys: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email },
      relations: {
        organizationMemberships: { organization: true },
      },
    });
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const user = await this.findOne(id);

    // Update basic fields
    if (updateUserDto.firstName) {
      user.firstName = updateUserDto.firstName;
    }

    if (updateUserDto.lastName) {
      user.lastName = updateUserDto.lastName;
    }

    if (updateUserDto.email) {
      // Check if email is already taken
      const existingUser = await this.findByEmail(updateUserDto.email);
      if (existingUser && existingUser.id !== id) {
        throw new BadRequestException('Email is already in use');
      }
      user.email = updateUserDto.email;
    }

    if (updateUserDto.preferences) {
      user.preferences = { ...user.preferences, ...updateUserDto.preferences };
    }

    return this.userRepository.save(user);
  }

  /** Org-scoped variant for admin endpoints. */
  async updateInOrg(id: string, organizationId: string, updateUserDto: UpdateUserDto): Promise<User> {
    await this.assertUserInOrg(id, organizationId);
    return this.update(id, updateUserDto);
  }

  async updatePassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id } });
    
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    // Hash new password
    const saltRounds = 12;
    user.passwordHash = await bcrypt.hash(newPassword, saltRounds);
    
    await this.userRepository.save(user);
  }

  async deactivate(id: string): Promise<void> {
    const user = await this.findOne(id);

    user.isActive = false;
    await this.userRepository.save(user);

    // Deactivate all user's API keys
    await this.apiKeyRepository.update(
      { userId: id },
      { isActive: false }
    );
  }

  async deactivateInOrg(id: string, organizationId: string): Promise<void> {
    await this.assertUserInOrg(id, organizationId);
    return this.deactivate(id);
  }

  async reactivate(id: string): Promise<void> {
    const user = await this.findOne(id);

    user.isActive = true;
    await this.userRepository.save(user);
  }

  async reactivateInOrg(id: string, organizationId: string): Promise<void> {
    await this.assertUserInOrg(id, organizationId);
    return this.reactivate(id);
  }

  async deleteInOrg(id: string, organizationId: string): Promise<void> {
    await this.assertUserInOrg(id, organizationId);
    return this.delete(id);
  }

  async delete(id: string): Promise<void> {
    const user = await this.findOne(id);
    
    // Check if user is the sole owner of any organizations
    const ownerships = user.organizationMemberships?.filter(
      m => m.role === 'owner'
    ) || [];

    for (const ownership of ownerships) {
      const orgOwners = await this.userOrganizationRepository.count({
        where: {
          organizationId: ownership.organizationId,
          role: OrganizationRole.OWNER,
        },
      });

      if (orgOwners <= 1) {
        throw new ForbiddenException(
          `Cannot delete user: they are the sole owner of organization "${ownership.organization.name}". ` +
          'Please transfer ownership or delete the organization first.'
        );
      }
    }

    await this.userRepository.remove(user);
  }

  async getUserStats(id: string): Promise<{
    apiKeysCount: number;
    organizationsCount: number;
    lastLoginAt: Date | null;
  }> {
    const user = await this.findOne(id);

    const apiKeysCount = await this.apiKeyRepository.count({
      where: { userId: id, isActive: true },
    });

    return {
      apiKeysCount,
      organizationsCount: user.organizationMemberships?.length || 0,
      lastLoginAt: user.lastLoginAt,
    };
  }

  async getUserStatsInOrg(id: string, organizationId: string): Promise<{
    apiKeysCount: number;
    organizationsCount: number;
    lastLoginAt: Date | null;
  }> {
    await this.assertUserInOrg(id, organizationId);
    return this.getUserStats(id);
  }

  async getUserActivity(id: string, days: number = 30): Promise<any[]> {
    // This would typically query activity logs or metrics
    // For now, return basic API key usage data
    const apiKeys = await this.apiKeyRepository.find({
      where: { userId: id },
      select: { id: true, name: true, lastUsedAt: true, createdAt: true },
      order: { lastUsedAt: 'DESC' },
    });

    return apiKeys.map(key => ({
      type: 'api_key_usage',
      apiKeyName: key.name,
      lastUsed: key.lastUsedAt,
      createdAt: key.createdAt,
    }));
  }

  async getUserActivityInOrg(id: string, organizationId: string, days: number = 30): Promise<any[]> {
    await this.assertUserInOrg(id, organizationId);
    return this.getUserActivity(id, days);
  }

  async bulkUpdate(
    userIds: string[],
    organizationId: string,
    updates: {
      isActive?: boolean;
      preferences?: Record<string, any>;
    }
  ): Promise<void> {
    if (!organizationId) {
      throw new BadRequestException('organizationId is required');
    }
    if (userIds.length === 0) return;

    // Filter to userIds that are members of the requested org. Caller-supplied
    // ids must NOT be trusted: a buggy frontend could pass cross-org ids and
    // we'd silently mass-mutate users in another org.
    const memberships = await this.userOrganizationRepository.find({
      where: { organizationId, userId: In(userIds) },
      select: { userId: true },
    });
    const allowedIds = memberships.map(m => m.userId);
    if (allowedIds.length === 0) return;

    // The previous shape used the Mongo `$in` syntax (`{ id: { $in: ids } as any }`)
    // which TypeORM treats as a literal-object comparison and matches zero
    // rows. The whole bulk operation has been silently a no-op for the
    // entirety of this method's life.
    await this.userRepository.update({ id: In(allowedIds) }, updates);
  }

  async searchUsers(query: string, organizationId: string): Promise<User[]> {
    if (!organizationId) {
      throw new BadRequestException('organizationId is required');
    }

    return this.userRepository
      .createQueryBuilder('user')
      .innerJoin('user.organizationMemberships', 'membership',
        'membership.organizationId = :organizationId', { organizationId })
      .where(
        '(user.firstName ILIKE :query OR user.lastName ILIKE :query OR user.email ILIKE :query)',
        { query: `%${query}%` }
      )
      .andWhere('user.isActive = :isActive', { isActive: true })
      .orderBy('user.firstName', 'ASC')
      .limit(50)
      .getMany();
  }
}