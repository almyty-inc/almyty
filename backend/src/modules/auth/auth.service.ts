import { Injectable, UnauthorizedException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
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
import { NotificationsService } from '../notifications/notifications.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { CaptchaService } from './captcha.service';
import { normalizeEmail, isDisposableEmail } from './email-normalization';

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
    // CAPTCHA verification (ships dark; no-op unless a secret is configured).
    // @Optional() so unit tests and community builds that don't provide it
    // fall back to "no CAPTCHA enforced".
    @Optional()
    private readonly captchaService?: CaptchaService,
    // Notification pipeline (@Global module) — @Optional() so unit tests
    // and community builds without it keep working (welcome notification
    // is simply skipped).
    @Optional()
    private readonly notifications?: NotificationsService,
  ) {}

  async register(
    createUserDto: CreateUserDto,
    context?: { referralCode?: string; ipAddress?: string },
  ): Promise<AuthTokens> {
    // ── Signup abuse protection (runs before any DB write) ───────────────

    // 1. CAPTCHA gate. No-op when unconfigured (ships dark); when a secret is
    //    set, a missing/invalid token is rejected. Fails closed on verifier
    //    errors — see CaptchaService.
    if (this.captchaService && this.captchaService.isEnabled()) {
      const ok = await this.captchaService.verify(
        createUserDto.captchaToken,
        context?.ipAddress,
      );
      if (!ok) {
        throw new BadRequestException('CAPTCHA verification failed');
      }
    }

    // 2. Reject known disposable / throwaway mailbox domains outright.
    if (isDisposableEmail(createUserDto.email)) {
      throw new BadRequestException(
        'Disposable email addresses are not allowed. Please use a permanent email address.',
      );
    }

    // 3. Canonicalize the address (gmail dots + `+tag` stripped, domain
    //    aliases folded) and dedupe on it so a bot can't farm many accounts
    //    from one real inbox. The stored `email` remains the raw user input
    //    (that's what we deliver mail to); `normalizedEmail` is the identity
    //    key we enforce uniqueness on.
    const normalizedEmail = normalizeEmail(createUserDto.email);

    // Check if user already exists — on BOTH the raw address and its
    // normalized form. The unique DB index on normalizedEmail is the hard
    // guarantee; this is the friendly-error fast path.
    const existingUser = await this.userRepository.findOne({
      where: [{ email: createUserDto.email }, { normalizedEmail }],
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
    let savedUser: User;
    let savedOrganizationId: string;
    try {
      ({ savedUser, savedOrganizationId } = await this.userRepository.manager.transaction(async (tx) => {
      // Create user inside the transaction
      const user = tx.create(User, {
        email: createUserDto.email,
        normalizedEmail,
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
      }));
    } catch (err: any) {
      // Race: two alias signups (e.g. foo@ and f.o.o@) can pass the
      // pre-check simultaneously and collide on the unique index. Postgres
      // reports 23505; surface it as the same friendly duplicate error
      // rather than a raw 500.
      if (err?.code === '23505') {
        throw new BadRequestException('User with this email already exists');
      }
      throw err;
    }

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

    // Post-registration notifications (fire-and-forget, outside the
    // transaction): the verification link email and the welcome
    // notification must never fail a successful registration.
    //
    // VERIFICATION GATE (current behavior, deliberately left non-blocking):
    // a fresh account is unverified (verifiedAt = null) and login + the app
    // work fully while unverified — validateUser() only checks isActive. The
    // only feature gated on verification today is referral-reward payout
    // (referrals.service checks verifiedAt/isVerified). Making login itself
    // hard-require verification would lock out the entire existing unverified
    // user base and contradicts the documented non-blocking design, so the
    // gate here stays at "send the verification email + show the in-app
    // banner". The robust abuse defenses are the per-IP rate limit, disposable
    // rejection, gmail-alias dedupe, and (when enabled) CAPTCHA above.
    this.requestEmailVerification(savedUser.id).catch(() => {});
    if (this.notifications) {
      const baseUrl = process.env.FRONTEND_URL || 'https://app.staging.almyty.com';
      this.notifications
        .emit({
          type: 'account.welcome',
          organizationId: savedOrganizationId,
          userIds: [savedUser.id],
          title: 'Welcome to almyty',
          body: `Your organization ${createUserDto.organizationName} is ready. Connect an API and build your first agent.`,
          link: '/dashboard',
          email: {
            template: 'account.welcome',
            params: {
              organizationName: createUserDto.organizationName,
              dashboardUrl: `${baseUrl}/dashboard`,
            },
          },
        })
        .catch(() => {});
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

    // Email-verification gate. The password is proven correct at this point,
    // so surfacing a specific "not verified" error leaks nothing an
    // unauthenticated attacker couldn't already infer (they hold the
    // password). Unverified accounts are refused tokens; a distinct
    // ForbiddenException with a machine-readable code lets the frontend
    // offer a "resend verification" path instead of a dead "invalid
    // credentials" end. Verified users (verifiedAt set OR isVerified true)
    // are unaffected — this never locks out the existing verified base.
    if (!user.verifiedAt && !user.isVerified) {
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Please verify your email address before signing in.',
        // The address is echoed back so the login page can pre-fill the
        // resend-verification call without asking for it again. It is not
        // sensitive here — the caller already supplied it.
        email: user.email,
      });
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

  /**
   * Verify an email address from a token link. Primary path: a
   * purpose-scoped signed JWT minted by requestEmailVerification()
   * (carries its own expiry, no DB token storage needed). Legacy
   * fallback: match the stored `verificationToken` column so any
   * previously issued DB tokens keep working.
   *
   * Verification is NON-BLOCKING: login and every other flow work for
   * unverified users; only verification-gated features (e.g. referral
   * rewards) check `verifiedAt`.
   */
  async verifyEmail(token: string): Promise<void> {
    // Same defense-in-depth as confirmPasswordReset: an empty/null
    // token would `WHERE verificationToken IS NULL` under TypeORM
    // and match any user who has already verified (i.e. had their
    // token cleared to null). Reject empty tokens up front.
    if (!token || typeof token !== 'string') {
      throw new BadRequestException('Invalid verification token');
    }

    let user: User | null = null;

    // Signed-JWT path.
    try {
      const payload: any = this.jwtService.verify(token);
      if (payload?.purpose === 'email_verify' && payload?.sub) {
        user = await this.userRepository.findOne({ where: { id: payload.sub } });
        // The link is bound to the address it was sent to — if the user
        // changed their email since, the old link must not verify the
        // new address.
        if (user && payload.email && user.email !== payload.email) {
          throw new BadRequestException('Verification link is for a different email address');
        }
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Not a (valid) JWT — fall through to the legacy DB-token path.
    }

    if (!user) {
      user = await this.userRepository.findOne({
        where: { verificationToken: token },
      });
    }

    if (!user) {
      throw new BadRequestException('Invalid verification token');
    }

    user.isVerified = true;
    user.verifiedAt = user.verifiedAt ?? new Date();
    user.verificationToken = null;

    await this.userRepository.save(user);
  }

  /**
   * (Re-)send the email verification link for a user. Idempotent and
   * safe to call repeatedly: a fresh token is minted each time (JWTs
   * are stateless, previous links stay valid until their expiry).
   * No-op when the user is already verified.
   */
  async requestEmailVerification(userId: string): Promise<{ alreadyVerified: boolean }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new BadRequestException('User not found');
    }
    if (user.verifiedAt || user.isVerified) {
      return { alreadyVerified: true };
    }
    const token = this.mintEmailVerificationToken(user);
    await this.mailService.sendEmailVerification(user.email, token, user.firstName);
    return { alreadyVerified: false };
  }

  /**
   * (Re-)send the verification link addressed by email, for the
   * unauthenticated login-blocked case: a user who tried to log in and was
   * refused with EMAIL_NOT_VERIFIED has no token to authenticate the JWT
   * resend route, so this variant keys off the email instead.
   *
   * Deliberately non-enumerating: it always resolves without revealing
   * whether the address exists or is already verified. The caller (login
   * page) shows the same neutral "if an account exists, we've re-sent the
   * link" confirmation regardless.
   */
  async requestEmailVerificationByEmail(email: string): Promise<void> {
    if (!email) return;
    const user = await this.userRepository.findOne({ where: { email } });
    // Silently no-op for unknown or already-verified accounts — no oracle.
    if (!user || user.verifiedAt || user.isVerified) {
      return;
    }
    const token = this.mintEmailVerificationToken(user);
    await this.mailService.sendEmailVerification(user.email, token, user.firstName);
  }

  /** Purpose-scoped signed verification token (7 day expiry). */
  private mintEmailVerificationToken(user: User): string {
    return this.jwtService.sign(
      { sub: user.id, email: user.email, purpose: 'email_verify' },
      { expiresIn: '7d' },
    );
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