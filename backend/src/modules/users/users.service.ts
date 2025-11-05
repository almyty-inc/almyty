import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindManyOptions } from 'typeorm';
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
    const skip = (page - 1) * limit;

    let queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.organizationMemberships', 'membership')
      .leftJoinAndSelect('membership.organization', 'organization');

    // Apply search filter
    if (search) {
      queryBuilder = queryBuilder.where(
        '(user.firstName ILIKE :search OR user.lastName ILIKE :search OR user.email ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    // Apply organization filter
    if (organizationId) {
      queryBuilder = queryBuilder.andWhere('organization.id = :organizationId', {
        organizationId,
      });
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

  async findOne(id: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: [
        'organizationMemberships',
        'organizationMemberships.organization',
        'apiKeys',
      ],
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email },
      relations: [
        'organizationMemberships',
        'organizationMemberships.organization',
      ],
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

  async reactivate(id: string): Promise<void> {
    const user = await this.findOne(id);
    
    user.isActive = true;
    await this.userRepository.save(user);
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

  async getUserActivity(id: string, days: number = 30): Promise<any[]> {
    // This would typically query activity logs or metrics
    // For now, return basic API key usage data
    const apiKeys = await this.apiKeyRepository.find({
      where: { userId: id },
      select: ['id', 'name', 'lastUsedAt', 'createdAt'],
      order: { lastUsedAt: 'DESC' },
    });

    return apiKeys.map(key => ({
      type: 'api_key_usage',
      apiKeyName: key.name,
      lastUsed: key.lastUsedAt,
      createdAt: key.createdAt,
    }));
  }

  async bulkUpdate(
    userIds: string[],
    updates: {
      isActive?: boolean;
      preferences?: Record<string, any>;
    }
  ): Promise<void> {
    await this.userRepository.update(
      { id: { $in: userIds } as any },
      updates
    );
  }

  async searchUsers(query: string, organizationId?: string): Promise<User[]> {
    let queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.organizationMemberships', 'membership')
      .leftJoinAndSelect('membership.organization', 'organization')
      .where(
        '(user.firstName ILIKE :query OR user.lastName ILIKE :query OR user.email ILIKE :query)',
        { query: `%${query}%` }
      )
      .andWhere('user.isActive = :isActive', { isActive: true });

    if (organizationId) {
      queryBuilder = queryBuilder.andWhere('organization.id = :organizationId', {
        organizationId,
      });
    }

    return queryBuilder
      .orderBy('user.firstName', 'ASC')
      .limit(50) // Limit search results
      .getMany();
  }
}