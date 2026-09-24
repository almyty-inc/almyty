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
import { effectiveMemberships, isEffectiveMembership } from '../../common/authorization/membership';
import { ORGANIZATION_ROLE_RANK } from '../organizations/organization-role-rank';

export interface PaginatedUsers {
  users: User[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/** Fields that must never leave the server on a User row. */
export const USER_SECRET_FIELDS = [
  'passwordHash',
  'resetPasswordToken',
  'resetPasswordExpires',
  'verificationToken',
  'twoFactorSecret',
] as const;

export function stripUserSecrets<T extends Record<string, any>>(user: T): T {
  for (const field of USER_SECRET_FIELDS) delete (user as any)[field];
  for (const membership of (user as any).organizationMemberships ?? []) {
    delete membership?.inviteToken;
  }
  return user;
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
      // Raw rows carry passwordHash, resetPasswordToken and the invite
      // tokens on each membership. The sibling routes in this service all
      // destructure those away; this one did not, so every admin page
      // load put bcrypt hashes into a browser cache and any HAR file.
      // @Exclude() on the entity does not help: no ClassSerializerInterceptor
      // is registered anywhere in this application.
      users: users.map(stripUserSecrets),
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

  /**
   * The membership that makes `userId` one of this organization's people.
   * A pending invite is not one -- an admin can invite any address on the
   * platform, so accepting its row here let them reach anyone -- and
   * neither is a revoked or deactivated row.
   */
  private async effectiveMembershipIn(userId: string, organizationId: string): Promise<UserOrganization> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { userId, organizationId },
    });
    if (!membership || !isEffectiveMembership(membership)) {
      throw new NotFoundException('User not found');
    }
    return membership;
  }

  private async assertUserInOrg(userId: string, organizationId: string): Promise<void> {
    await this.effectiveMembershipIn(userId, organizationId);
  }

  /** Does this person belong to any organization other than this one? */
  private async belongsElsewhere(userId: string, organizationId: string): Promise<boolean> {
    const rows = await this.userOrganizationRepository.find({ where: { userId } });
    return effectiveMemberships(rows).some((m) => m.organizationId !== organizationId);
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

    // The login address never changes here. This used to assign it
    // directly: no password, verification left set on an address nobody
    // had proved, and no word to the old mailbox. AuthService.changeEmail
    // is the one path that may move it; the controllers route there first.
    if (updateUserDto.email !== undefined && updateUserDto.email !== user.email) {
      throw new BadRequestException('Change the email address through the email change flow.');
    }

    if (updateUserDto.preferences) {
      user.preferences = { ...user.preferences, ...updateUserDto.preferences };
    }

    return this.userRepository.save(user);
  }

  /** Org-scoped variant for admin endpoints. */
  /**
   * Org-scoped variant for admin endpoints.
   *
   * The row is platform-wide, so an admin of this organization edits it
   * only as far as it is this organization's to edit. The login address
   * never is: repointing another person's email and then asking for a
   * password reset at the new mailbox is a takeover of every organization
   * they belong to. Their name is, only while this is their one
   * organization -- the rule SCIM follows for the same row. Preferences
   * are the person's own. Editing yourself is the self-service update.
   */
  async updateInOrg(
    id: string,
    organizationId: string,
    updateUserDto: UpdateUserDto,
    actorUserId?: string,
  ): Promise<User> {
    await this.assertUserInOrg(id, organizationId);
    if (actorUserId && actorUserId === id) {
      return this.update(id, updateUserDto);
    }
    if (updateUserDto.email !== undefined) {
      const current = await this.findOne(id);
      if (updateUserDto.email !== current.email) {
        throw new ForbiddenException("An organization admin cannot change a member's email address");
      }
    }
    if (await this.belongsElsewhere(id, organizationId)) {
      return this.findOne(id);
    }
    return this.update(id, {
      firstName: updateUserDto.firstName,
      lastName: updateUserDto.lastName,
    });
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

  /**
   * Take someone out of ONE organization: their membership here goes
   * inactive and so do the API keys minted in it. The account itself --
   * the row that signs them into every other organization they belong
   * to -- is not this org's to switch off. This used to set
   * `users.isActive = false` and kill every key the person held, so an
   * admin could lock anyone they had merely invited out of the whole
   * platform.
   */
  async deactivateInOrg(id: string, organizationId: string, actorUserId?: string): Promise<void> {
    const membership = await this.effectiveMembershipIn(id, organizationId);
    if (actorUserId) {
      const actor = await this.effectiveMembershipIn(actorUserId, organizationId);
      if (ORGANIZATION_ROLE_RANK[membership.role] < ORGANIZATION_ROLE_RANK[actor.role]) {
        throw new ForbiddenException('Cannot deactivate a member who outranks you');
      }
    }
    if (membership.role === OrganizationRole.OWNER) {
      const owners = await this.userOrganizationRepository.count({
        where: { organizationId, role: OrganizationRole.OWNER, isActive: true },
      });
      if (owners <= 1) {
        throw new ForbiddenException('Cannot deactivate the last owner of the organization');
      }
    }

    membership.isActive = false;
    await this.userOrganizationRepository.save(membership);
    await this.apiKeyRepository.update(
      { userId: id, organizationId },
      { isActive: false },
    );
  }

  async reactivate(id: string): Promise<void> {
    const user = await this.findOne(id);

    user.isActive = true;
    await this.userRepository.save(user);
  }

  /**
   * Undo `deactivateInOrg`: the membership here comes back. Only a
   * membership that was accepted -- a revoked invite (inactive, still
   * holding its token) is not one to bring back.
   */
  async reactivateInOrg(id: string, organizationId: string): Promise<void> {
    const membership = await this.userOrganizationRepository.findOne({
      where: { userId: id, organizationId },
    });
    if (!membership || !isEffectiveMembership({ ...membership, isActive: true })) {
      throw new NotFoundException('User not found');
    }
    membership.isActive = true;
    await this.userOrganizationRepository.save(membership);
  }

  /**
   * Delete the account of someone whose only organization is this one.
   * Anyone who also belongs elsewhere is not this organization's to
   * erase: removing them from here is the member-removal route.
   */
  async deleteInOrg(id: string, organizationId: string): Promise<void> {
    await this.assertUserInOrg(id, organizationId);
    if (await this.belongsElsewhere(id, organizationId)) {
      throw new ForbiddenException(
        'This person belongs to other organizations. Remove them from this organization instead of deleting their account.',
      );
    }
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

  async getUserActivity(id: string, _days: number = 30): Promise<any[]> {
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