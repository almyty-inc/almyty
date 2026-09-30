import {
  Controller,
  Post,
  Body,
  UseGuards,
  Request,
  Get,
  HttpCode,
  HttpStatus,
  Delete,
  Param,
  BadRequestException,
  Query,
  Patch,
  Res,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request as ExpressRequest, Response } from 'express';

import { AuthService, AuthTokens } from './auth.service';
import { assertMayChangeLoginEmail } from './sso-session';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { AccountThrottle, AccountThrottleGuard } from './guards/account-throttle.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../../entities/user.entity';
import { REFERRAL_COOKIE, clientIpOf } from '../referrals/referrals.constants';
import { effectiveMemberships } from '../../common/authorization/membership';

/** Shared cookie options for the access_token httpOnly cookie */
const ACCESS_TOKEN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
};

/**
 * What a browser login or registration returns in the body: nothing that
 * authenticates. Tokens are httpOnly-cookie only in the browser, so a
 * script on the page (an XSS, an extension) has no token to read from the
 * response it did or did not make. Non-browser clients use /auth/token.
 */
export function browserSession(tokens: AuthTokens): { expiresIn: number } {
  return { expiresIn: tokens.expiresIn };
}

/**
 * /auth/token and /auth/refresh answer with tokens in the body, so a page
 * must not be able to call them. Browsers send `Origin` on every POST
 * (fetch, XHR and form alike); a CLI, SDK or server does not.
 */
function refuseBrowserCaller(req: { headers?: Record<string, unknown> }): void {
  if (req?.headers?.origin !== undefined) {
    throw new BadRequestException({
      code: 'BROWSER_USE_LOGIN',
      message: 'This endpoint is for non-browser clients. Browsers sign in with /auth/login.',
    });
  }
}
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  // Rate limit the org-name check — without this, the endpoint
  // is an enumeration oracle that lets an unauthenticated caller
  // iterate a dictionary of organization names and learn which
  // ones exist on the platform (reconnaissance + targeted phishing
  // setup). 30/minute per IP is plenty for a real signup form
  // doing live availability checks as the user types.
  @Throttle({ default: { limit: 30, ttl: 60 * 1000 } })
  @Get('check-organization-name')
  @ApiOperation({ summary: 'Check if organization name is available' })
  @ApiResponse({
    status: 200,
    description: 'Organization name availability status',
    schema: {
      type: 'object',
      properties: {
        available: { type: 'boolean' },
        message: { type: 'string' },
      },
    },
  })
  async checkOrganizationName(@Query('name') name: string) {
    if (!name || name.trim().length < 2) {
      throw new BadRequestException('Organization name must be at least 2 characters long');
    }

    const available = await this.authService.isOrganizationNameAvailable(name.trim());

    return {
      success: true,
      data: { available },
      message: available
        ? 'Organization name is available'
        : 'Organization name is already taken',
    };
  }

  @Public()
  // Tight rate limit on register — 10 attempts / hour per IP is
  // more than enough for a real user and a hard stop for
  // automated signup abuse (bulk account creation, resource
  // squatting, reputation poisoning). The global throttler only
  // allows 100 req/60s which lets a script create thousands of
  // accounts per day.
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1000 } })
  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiResponse({
    status: 201,
    description: 'User registered; the session is the httpOnly cookie, the body carries no token',
    schema: {
      type: 'object',
      properties: {
        expiresIn: { type: 'number' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Bad request - user already exists or validation failed' })
  async register(
    @Body() createUserDto: CreateUserDto,
    @Res({ passthrough: true }) res: Response,
    @Req() req: ExpressRequest,
  ) {
    // Referral attribution: the /referrals/attribute/:code endpoint (reached
    // via /r/<code> share links) drops a short-lived cookie on this origin;
    // read it here so the signup is attributed server-side.
    const referralCode = req.cookies?.[REFERRAL_COOKIE];
    const tokens = await this.authService.register(createUserDto, {
      referralCode,
      ipAddress: clientIpOf(req),
    });

    // Attribution cookie is single-use — clear it once consumed.
    if (referralCode) {
      res.clearCookie(REFERRAL_COOKIE, { path: '/' });
    }

    // The session is the httpOnly cookie, and only the cookie.
    res.cookie('access_token', tokens.accessToken, ACCESS_TOKEN_COOKIE_OPTIONS);

    return {
      success: true,
      data: browserSession(tokens),
      message: 'Registration successful',
    };
  }

  @Public()
  // Tight rate limit on login — 10 attempts / 5 minutes per IP.
  // Login is the primary brute-force target (credential stuffing,
  // password spraying); the global 100 req/60s throttler is not
  // remotely tight enough for a surface that fans out to every
  // account. Attackers are slowed to 2/min per IP; legitimate
  // users with a typo have plenty of headroom.
  @Throttle({ default: { limit: 10, ttl: 5 * 60 * 1000 } })
  // Per account as well: a spray spread over many IPs stays under every
  // per-IP bucket while hammering one login. The account guard runs first,
  // so a blocked attempt costs no password hash.
  @AccountThrottle({ name: 'login', limit: 10, ttlMs: 15 * 60 * 1000 })
  @UseGuards(AccountThrottleGuard, LocalAuthGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Browser login: sets the httpOnly session cookie; the body carries no token' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 200,
    description: 'Successfully authenticated',
    schema: {
      type: 'object',
      properties: {
        expiresIn: { type: 'number' },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(
    @Request() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.completeLogin(req.user);

    // The session is the httpOnly cookie, and only the cookie: a token in
    // the body is readable by any script on the page.
    res.cookie('access_token', tokens.accessToken, ACCESS_TOKEN_COOKIE_OPTIONS);

    return {
      success: true,
      data: browserSession(tokens),
      message: 'Login successful',
    };
  }

  @Public()
  // Same limits as the browser login: it is the same password check.
  @Throttle({ default: { limit: 10, ttl: 5 * 60 * 1000 } })
  @AccountThrottle({ name: 'login', limit: 10, ttlMs: 15 * 60 * 1000 })
  @UseGuards(AccountThrottleGuard, LocalAuthGuard)
  @Post('token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Non-browser login: returns an access and a refresh token in the body and sets no cookie',
  })
  @ApiBody({ type: LoginDto })
  @ApiResponse({
    status: 200,
    description: 'Successfully authenticated',
    schema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        expiresIn: { type: 'number' },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Called from a browser page; use /auth/login' })
  async token(@Request() req: any) {
    refuseBrowserCaller(req);
    const tokens = await this.authService.completeLogin(req.user);
    return {
      success: true,
      data: tokens,
      message: 'Login successful',
    };
  }

  @Public()
  // Rate limit the refresh endpoint — without this, an attacker
  // with a stolen refresh token could pipeline refresh attempts
  // at the global 100/60s limit, trying variants until one
  // verifies.
  @Throttle({ default: { limit: 20, ttl: 5 * 60 * 1000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redeem a refresh token from /auth/token for a new pair (non-browser clients)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        refreshToken: { type: 'string' },
      },
      required: ['refreshToken'],
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Token refreshed successfully',
  })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  async refresh(
    @Body('refreshToken') refreshToken: string,
    @Req() req: ExpressRequest,
  ) {
    // Only /auth/token hands out a refresh token, and never to a page, so
    // a page has no business here either.
    refuseBrowserCaller(req);
    if (!refreshToken) {
      throw new BadRequestException('Refresh token is required');
    }

    const tokens = await this.authService.refreshToken(refreshToken);

    return {
      success: true,
      data: tokens,
      message: 'Token refreshed successfully',
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout: end the session and clear the auth cookie' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(@Req() req: ExpressRequest, @Res({ passthrough: true }) res: Response) {
    // End the server-side session first, so the token stops working
    // everywhere, not just in this browser. The cookie is the web client's
    // token; a programmatic client sends the same token as a bearer.
    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : undefined;
    await this.authService.logout(req.cookies?.access_token ?? bearer);
    res.clearCookie('access_token', { path: '/' });

    return {
      success: true,
      data: null,
      message: 'Logged out successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'User profile retrieved successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getProfile(@CurrentUser() user: User) {
    // Remove sensitive data
    const { passwordHash, resetPasswordToken, verificationToken, ...profile } = user;

    return {
      success: true,
      data: {
        ...profile,
        // Non-blocking email verification state — the UI shows a
        // "verify your email" banner while false.
        emailVerified: !!(user.verifiedAt || user.isVerified),
        // Only the rows that actually grant access. This list is not
        // decoration: the web client turns it into its organization
        // switcher, picks one as the current organization, and stamps
        // that id into `X-Organization-Id` on every subsequent request.
        // `user_organizations` also holds pending invites and revoked
        // ones (revocation deactivates the row rather than deleting it)
        // and the relation load has no filter, so mapping it verbatim
        // handed the client organizations `JwtStrategy` refuses — and,
        // because the payload dropped `isActive`/`inviteAccepted`, no
        // way to tell which. With no ORDER BY on the relation, whichever
        // row Postgres returned first became the client's default: when
        // that was an invite row, the first call after sign-in was
        // refused and the client read the refusal as a dead session.
        // Same predicate as the one JwtStrategy accepts the header with.
        organizationMemberships: effectiveMemberships(user.organizationMemberships).map(membership => ({
          id: membership.id,
          role: membership.role,
          joinedAt: membership.joinedAt,
          organization: {
            id: membership.organization.id,
            name: membership.organization.name,
            slug: membership.organization.slug,
          },
        })),
      },
      message: 'Profile retrieved successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Patch('profile')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update current user profile' })
  @ApiResponse({ status: 200, description: 'Profile updated successfully' })
  @ApiResponse({ status: 400, description: 'Bad request - validation failed' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async updateProfile(
    @CurrentUser() user: User,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    assertMayChangeLoginEmail(user, updateProfileDto.email);
    const updatedUser = await this.authService.updateProfile(user.id, updateProfileDto);

    // Remove sensitive data
    const { passwordHash, resetPasswordToken, verificationToken, ...profile } = updatedUser;

    return {
      success: true,
      data: {
        ...profile,
        emailVerified: !!(updatedUser.verifiedAt || updatedUser.isVerified),
      },
      message: 'Profile updated successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('api-keys')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create a new API key' })
  @ApiResponse({ status: 201, description: 'API key created successfully' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async createApiKey(
    @CurrentUser() user: User,
    @Body() createApiKeyDto: CreateApiKeyDto,
  ) {
    const { apiKey, keyData } = await this.authService.createApiKey(user.id, createApiKeyDto);

    return {
      success: true,
      data: {
        apiKey, // This is the only time the full key is returned
        keyData: {
          id: keyData.id,
          name: keyData.name,
          keyPrefix: keyData.keyPrefix,
          scopes: keyData.scopes,
          expiresAt: keyData.expiresAt,
          createdAt: keyData.createdAt,
        },
      },
      message: 'API key created successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('api-keys')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get user API keys' })
  @ApiResponse({ status: 200, description: 'API keys retrieved successfully' })
  async getApiKeys(@CurrentUser() user: User) {
    const apiKeys = await this.authService.getUserApiKeys(user.id);

    return {
      success: true,
      data: {
        apiKeys: apiKeys.map(key => ({
          id: key.id,
          name: key.name,
          keyPrefix: key.keyPrefix,
          scopes: key.scopes,
          isActive: key.isActive,
          expiresAt: key.expiresAt,
          lastUsedAt: key.lastUsedAt,
          createdAt: key.createdAt,
        })),
      },
      message: 'API keys retrieved successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('api-keys/:keyId')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Revoke an API key' })
  @ApiResponse({ status: 200, description: 'API key revoked successfully' })
  @ApiResponse({ status: 404, description: 'API key not found' })
  async revokeApiKey(
    @CurrentUser() user: User,
    @Param('keyId') keyId: string,
  ) {
    await this.authService.revokeApiKey(keyId, user.id);

    return {
      success: true,
      data: null,
      message: 'API key revoked successfully',
    };
  }

  @Public()
  // Tight rate limit on password reset — 5 attempts / hour per IP.
  // Without this, forgot-password is an email-enumeration oracle
  // (attacker iterates addresses, observes send/no-send side
  // effects via SMTP metrics or timing) and a spam vector for
  // the outbound mail relay.
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
  // And per account, so spreading the requests over many IPs does not
  // turn one mailbox into a spam target.
  @AccountThrottle({ name: 'forgot-password', limit: 3, ttlMs: 60 * 60 * 1000 })
  @UseGuards(AccountThrottleGuard)
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
      },
      required: ['email'],
    },
  })
  @ApiResponse({ status: 200, description: 'Password reset email sent if user exists' })
  async forgotPassword(@Body('email') email: string) {
    if (!email) {
      throw new BadRequestException('Email is required');
    }
    
    await this.authService.resetPassword(email);

    return {
      success: true,
      data: null,
      message: 'If a user with this email exists, a password reset link has been sent.',
    };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using reset token' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string' },
        password: { type: 'string', minLength: 8 },
      },
      required: ['token', 'password'],
    },
  })
  @ApiResponse({ status: 200, description: 'Password reset successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired reset token' })
  async resetPassword(
    @Body('token') token: string,
    @Body('password') password: string,
  ) {
    if (!token || !password) {
      throw new BadRequestException('Token and password are required');
    }
    
    await this.authService.confirmPasswordReset(token, password);

    return {
      success: true,
      data: null,
      message: 'Password reset successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  // The frontend calls PATCH /auth/change-password; this route was previously
  // registered as POST, so every password change 404'd in production.
  @Patch('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Change user password' })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Current password is incorrect' })
  async changePassword(
    @CurrentUser() user: User,
    @Body() changePasswordDto: ChangePasswordDto,
  ) {
    const { currentPassword, newPassword } = changePasswordDto;

    await this.authService.changePassword(user.id, currentPassword, newPassword);

    return {
      success: true,
      data: null,
      message: 'Password changed successfully',
    };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email using verification token' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        token: { type: 'string' },
      },
      required: ['token'],
    },
  })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid verification token' })
  async verifyEmail(@Body('token') token: string) {
    if (!token) {
      throw new BadRequestException('Verification token is required');
    }
    
    await this.authService.verifyEmail(token);

    return {
      success: true,
      data: null,
      message: 'Email verified successfully',
    };
  }

  /**
   * Link-click verification target (the email button lands on the
   * frontend page, which calls this). Same semantics as the POST
   * variant, exposed as GET so the token can travel in the query
   * string of a plain link.
   */
  @Public()
  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email using a token link (?token=)' })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid verification token' })
  async verifyEmailLink(@Query('token') token: string) {
    if (!token) {
      throw new BadRequestException('Verification token is required');
    }

    await this.authService.verifyEmail(token);

    return {
      success: true,
      data: null,
      message: 'Email verified successfully',
    };
  }

  /**
   * Re-send the verification email for the logged-in user.
   * Verification is non-blocking, so this is reachable while
   * unverified (normal JWT auth). Throttled tighter than the global
   * limit — it sends outbound email.
   */
  @UseGuards(JwtAuthGuard)
  // Two paths for the same action: the frozen frontend contract calls
  // POST /auth/resend-verification; the REST-nested form is kept too.
  @Post('resend-verification')
  @Post('verify-email/resend')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 300_000 } })
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Re-send the email verification link' })
  @ApiResponse({ status: 200, description: 'Verification email sent (or already verified)' })
  async resendVerification(@CurrentUser() user: User) {
    const result = await this.authService.requestEmailVerification(user.id);
    return {
      success: true,
      data: { alreadyVerified: result.alreadyVerified },
      message: result.alreadyVerified
        ? 'Email is already verified'
        : 'Verification email sent',
    };
  }

  @Public()
  // Unauthenticated resend for the login-blocked case: a user refused login
  // with EMAIL_NOT_VERIFIED has no token to reach the JWT resend route, so
  // this keys off the email. Non-enumerating (always the same neutral
  // response) and tightly throttled since it sends outbound mail.
  @Throttle({ default: { limit: 5, ttl: 60 * 60 * 1000 } })
  @AccountThrottle({ name: 'resend-verification', limit: 3, ttlMs: 60 * 60 * 1000 })
  @UseGuards(AccountThrottleGuard)
  @Post('resend-verification-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-send the verification link addressed by email (unauthenticated)' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { email: { type: 'string', format: 'email' } },
      required: ['email'],
    },
  })
  @ApiResponse({ status: 200, description: 'Verification email sent if an unverified account exists' })
  async resendVerificationByEmail(@Body('email') email: string) {
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    await this.authService.requestEmailVerificationByEmail(email);

    return {
      success: true,
      data: null,
      message: 'If an unverified account exists for this email, a verification link has been sent.',
    };
  }
}