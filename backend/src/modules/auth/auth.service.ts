import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';

import { User } from '../../entities/user.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { Organization } from '../../entities/organization.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ReferralsService } from '../referrals/referrals.service';
import { MailService } from '../mail/mail.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';

export interface JwtPayload {
  sub: string;
  email: string;
  firstName: string;
  lastName: string;
  organizations: Array<{
    id: string;
    name: string;
    role: OrganizationRole;
  }>;
  /** Token version — see User.tokenVersion. Absent on legacy tokens (=> 0). */
  tv?: number;
  iat?: number;
  exp?: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(ApiKey)
    private apiKeyRepository: Repository<ApiKey>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(UserOrganization)
    private userOrganizationRepository: Repository<UserOrganization>,
    private jwtService: JwtService,
    private readonly auditLogService: AuditLogService,
    private readonly mailService: MailService,
    private readonly referralsService: ReferralsService,
  ) {}

  async register(
    createUserDto: CreateUserDto,
    context?: { referralCode?: string; ipAddress?: string },
  ): Promise<AuthTokens> {
    // Check if user already exists
    const existingUser = await this.userRepository.findOne({
      where: { email: createUserDto.email },
    });

    if (existingUser) {
      throw new BadRequestException('User with this email already exists');
    }

    // Check if organization name is available BEFORE creating user
    const isOrgNameAvailable = await this.isOrganizationNameAvailable(createUserDto.organizationName);
    if (!isOrgNameAvailable) {
      throw new BadRequestException('Organization name is already taken');
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(createUserDto.password, saltRounds);

    // Wrap user + organization + membership creation in a single DB
    // transaction. The previous shape saved the user FIRST, then tried
    // to save the org and membership separately, and on failure
    // compensated via `userRepository.remove(savedUser)`. Two ways
    // that went wrong:
    //
    //   1. If the organization row saved but the membership row
    //      failed, the compensation removed the user but left the
    //      organization orphaned. A subsequent re-register with the
    //      same org name would fail with "Organization name is
    //      already taken" even though the caller never successfully
    //      registered.
    //   2. If the process crashed (OOM, redeploy) between any of the
    //      three saves, whatever was persisted stayed behind with no
    //      compensation at all.
    //
    // A transaction makes the three writes atomic: either all three
    // commit, or the DB rolls them all back.
    const { savedUser, savedOrganizationId } = await this.userRepository.manager.transaction(async (tx) => {
      // Create user inside the transaction
      const user = tx.create(User, {
        email: createUserDto.email,
        passwordHash,
        firstName: createUserDto.firstName,
        lastName: createUserDto.lastName,
        isVerified: false,
      });
      const saved = await tx.save(User, user);

      // Create organization with user-provided name
      const organization = tx.create(Organization, {
        name: createUserDto.organizationName,
        description: `Organization managed by ${createUserDto.firstName} ${createUserDto.lastName}`,
        plan: 'free',
        isActive: true,
      });
      const savedOrganization = await tx.save(Organization, organization);

      // Create organization membership (user as owner)
      const userOrganization = tx.create(UserOrganization, {
        userId: saved.id,
        organizationId: savedOrganization.id,
        role: OrganizationRole.OWNER,
        isActive: true,
        inviteAccepted: true,
      });
      await tx.save(UserOrganization, userOrganization);

      // Auto-provision the default "Everyone" team and join the owner
      // as team_admin (LEAD). Stays inside the same transaction so a
      // failure here rolls back the user + org creation cleanly. The
      // helper in OrganizationsModule does the equivalent for orgs
      // created via the dashboard's createOrganization() path; we
      // inline the logic here to avoid an AuthModule -> OrganizationsModule
      // dependency. Both code paths converge on the same invariant:
      // every org has exactly one team where isDefault=true, and every
      // org member is automatically a member of it.
      const defaultTeam = tx.create(Team, {
        organizationId: savedOrganization.id,
        name: 'Everyone',
        description: 'Default team — every organization member is automatically a member.',
        isDefault: true,
      });
      const savedTeam = await tx.save(Team, defaultTeam);
      await tx.save(UserTeam, tx.create(UserTeam, {
        userId: saved.id,
        teamId: savedTeam.id,
        role: TeamRole.LEAD,
        isActive: true,
      }));

      return { savedUser: saved, savedOrganizationId: savedOrganization.id };
    });

    // Referral attribution (outside the transaction, additive): a failure
    // here must never fail or roll back a successful registration.
    if (context?.referralCode) {
      try {
        await this.referralsService.attributeSignup({
          userId: savedUser.id,
          organizationId: savedOrganizationId,
          email: savedUser.email,
          referralCode: context.referralCode,
          ipAddress: context.ipAddress,
        });
      } catch (err) {
        // swallow — registration already succeeded
      }
    }

    // Generate tokens (outside the transaction — purely read-side)
    return this.generateTokens(savedUser);
  }

  async login(loginDto: LoginDto): Promise<AuthTokens> {
    const user = await this.validateUser(loginDto.email, loginDto.password);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Update last login
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    // Audit log (fire-and-forget) — log to user's first organization
    const orgId = user.organizationMemberships?.[0]?.organizationId;
    if (orgId) {
      this.auditLogService.log({ organizationId: orgId, userId: user.id, userEmail: user.email, action: AuditAction.LOGIN, resourceType: AuditResource.USER, resourceId: user.id, resourceName: user.email });
    }

    return this.generateTokens(user);
  }

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.userRepository.findOne({
      where: { email },
      relations: ['organizationMemberships', 'organizationMemberships.organization'],
    });

    if (!user || !user.isActive) {
      return null;
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      return null;
    }

    return user;
  }

  async validateJwtPayload(payload: JwtPayload): Promise<User | null> {
    const user = await this.userRepository.findOne({
      where: { id: payload.sub },
      relations: ['organizationMemberships', 'organizationMemberships.organization'],
    });

    if (!user || !user.isActive) {
      return null;
    }

    return user;
  }

  async validateApiKey(keyHash: string): Promise<ApiKey | null> {
    const apiKey = await this.apiKeyRepository.findOne({
      where: { keyHash },
      relations: ['user', 'user.organizationMemberships', 'user.organizationMemberships.organization', 'organization'],
    });

    if (!apiKey || !apiKey.canMakeRequest()) {
      return null;
    }

    // Update last used timestamp
    apiKey.updateLastUsed();
    await this.apiKeyRepository.save(apiKey);

    return apiKey;
  }

  async generateTokens(user: User): Promise<AuthTokens> {
    // Load user organizations for JWT payload
    const userWithOrgs = await this.userRepository.findOne({
      where: { id: user.id },
      relations: ['organizationMemberships', 'organizationMemberships.organization'],
    });

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizations: userWithOrgs.organizationMemberships.map(membership => ({
        id: membership.organization.id,
        name: membership.organization.name,
        role: membership.role,
      })),
      tv: userWithOrgs.tokenVersion ?? 0,
    };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(
      { sub: user.id, type: 'refresh', tv: userWithOrgs.tokenVersion ?? 0 },
      { expiresIn: '7d' }
    );

    return {
      accessToken,
      refreshToken,
      expiresIn: 24 * 60 * 60, // 24 hours in seconds
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthTokens> {
    try {
      const payload = this.jwtService.verify(refreshToken);
      
      if (payload.type !== 'refresh') {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const user = await this.userRepository.findOne({
        where: { id: payload.sub },
        relations: ['organizationMemberships', 'organizationMemberships.organization'],
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('User not found or inactive');
      }

      // Reject refresh tokens minted before a tokenVersion bump (password
      // change/reset). Missing claim => 0 for legacy-token compatibility.
      if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
        throw new UnauthorizedException('Refresh token has been revoked');
      }

      return this.generateTokens(user);
    } catch (error) {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async createApiKey(userId: string, createApiKeyDto: CreateApiKeyDto): Promise<{ apiKey: string; keyData: ApiKey }> {
    // Default the org scope to the user's single org when the caller
    // doesn't provide one (e.g. the CLI login flow mints a key from
    // the frontend without an explicit org ID).
    let orgId = createApiKeyDto.organizationId;
    if (!orgId) {
      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: ['organizationMemberships'],
      });
      if (user?.organizationMemberships?.length === 1) {
        orgId = user.organizationMemberships[0].organizationId;
      }
    }

    const keyValue = this.generateApiKeyValue();
    const keyHash = this.hashApiKey(keyValue);
    const keyPrefix = keyValue.substring(0, 8);

    const apiKey = this.apiKeyRepository.create({
      name: createApiKeyDto.name,
      keyHash,
      keyPrefix,
      userId,
      organizationId: orgId,
      scopes: createApiKeyDto.scopes,
      expiresAt: createApiKeyDto.expiresAt,
      rateLimits: createApiKeyDto.rateLimits,
      metadata: createApiKeyDto.metadata,
    });

    const savedApiKey = await this.apiKeyRepository.save(apiKey);

    return {
      apiKey: keyValue, // Return the actual key only once
      keyData: savedApiKey,
    };
  }

  async revokeApiKey(keyId: string, userId: string): Promise<void> {
    const apiKey = await this.apiKeyRepository.findOne({
      where: { id: keyId, userId },
    });

    if (!apiKey) {
      throw new BadRequestException('API key not found');
    }

    apiKey.isActive = false;
    await this.apiKeyRepository.save(apiKey);
  }

  async getUserApiKeys(userId: string): Promise<ApiKey[]> {
    return this.apiKeyRepository.find({
      where: { userId },
      order: { createdAt: 'DESC' },
    });
  }

  private generateApiKeyValue(): string {
    return `almyty_${crypto.randomBytes(32).toString('hex')}`;
  }

  private hashApiKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  async resetPassword(email: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { email } });
    
    if (!user) {
      // Don't reveal whether user exists
      return;
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date();
    resetExpires.setHours(resetExpires.getHours() + 1); // 1 hour expiry

    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = resetExpires;
    
    await this.userRepository.save(user);

    // Deliver the reset link. MailService fails soft (logs in dev, returns
    // false on provider error, never throws), so a mail outage can't break
    // the request or leak whether the address exists.
    await this.mailService.sendPasswordReset(user.email, resetToken);
  }

  async confirmPasswordReset(token: string, newPassword: string): Promise<void> {
    // Defense-in-depth: an empty/null token would `WHERE resetPasswordToken IS NULL`
    // and match any user that doesn't currently have a reset in flight. That
    // attack only works if such a user ALSO has a non-null resetPasswordExpires
    // (which today is guarded by the null-expires check below) — but the
    // invariant is brittle and easy to violate later. Reject empty tokens up
    // front so the brittle invariant is never the only thing protecting us.
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const user = await this.userRepository.findOne({
      where: {
        resetPasswordToken: token,
      },
    });

    if (!user || !user.resetPasswordExpires || user.resetPasswordExpires < new Date()) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const saltRounds = 12;
    user.passwordHash = await bcrypt.hash(newPassword, saltRounds);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    // Revoke all outstanding access/refresh tokens for this user.
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;

    await this.userRepository.save(user);
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    
    if (!user) {
      throw new BadRequestException('User not found');
    }

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const saltRounds = 12;
    user.passwordHash = await bcrypt.hash(newPassword, saltRounds);
    // Revoke all outstanding access/refresh tokens for this user.
    user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    
    await this.userRepository.save(user);
  }

  async verifyEmail(token: string): Promise<void> {
    // Same defense-in-depth as confirmPasswordReset: an empty/null
    // token would `WHERE verificationToken IS NULL` under TypeORM
    // and match any user who has already verified (i.e. had their
    // token cleared to null). That would let an unauthenticated
    // caller with no token silently "verify" an arbitrary already-
    // verified account's verification state — harmless today but
    // exactly the kind of brittle invariant that bites later when a
    // verification flow is added that depends on re-entering the
    // unverified state. Reject empty tokens up front.
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Invalid verification token');
    }

    const user = await this.userRepository.findOne({
      where: { verificationToken: token },
    });

    if (!user) {
      throw new BadRequestException('Invalid verification token');
    }

    user.isVerified = true;
    user.verificationToken = null;

    await this.userRepository.save(user);
  }

  async updateProfile(userId: string, updateProfileDto: UpdateProfileDto): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      relations: ['organizationMemberships', 'organizationMemberships.organization'],
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Update name if provided (split into firstName and lastName)
    if (updateProfileDto.name) {
      const nameParts = updateProfileDto.name.trim().split(' ');
      if (nameParts.length === 1) {
        user.firstName = nameParts[0];
        user.lastName = '';
      } else {
        user.firstName = nameParts[0];
        user.lastName = nameParts.slice(1).join(' ');
      }
    }

    // Update email if provided
    if (updateProfileDto.email) {
      // Check if email is already in use by another user
      const existingUser = await this.userRepository.findOne({
        where: { email: updateProfileDto.email },
      });

      if (existingUser && existingUser.id !== userId) {
        throw new BadRequestException('Email is already in use');
      }

      user.email = updateProfileDto.email;
    }

    // Save and return updated user
    return this.userRepository.save(user);
  }

  // Check if organization name is available
  async isOrganizationNameAvailable(name: string): Promise<boolean> {
    const existingOrg = await this.organizationRepository.findOne({
      where: { name: name.trim() }
    });
    return !existingOrg;
  }
}