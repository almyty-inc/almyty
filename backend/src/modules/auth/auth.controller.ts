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

import { AuthService } from './auth.service';
import { LocalAuthGuard } from './guards/local-auth.guard';
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

/** Shared cookie options for the access_token httpOnly cookie */
const ACCESS_TOKEN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
};

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
    description: 'User successfully registered',
    schema: {
      type: 'object',
      properties: {
        accessToken: { type: 'string' },
        refreshToken: { type: 'string' },
        expiresIn: { type: 'number' },
        user: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
          },
        },
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

    // Set httpOnly cookie for web UI security
    res.cookie('access_token', tokens.accessToken, ACCESS_TOKEN_COOKIE_OPTIONS);

    return {
      success: true,
      data: tokens,
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
  @UseGuards(LocalAuthGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
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
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(
    @Request() req: any,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.generateTokens(req.user);

    // Set httpOnly cookie for web UI security
    res.cookie('access_token', tokens.accessToken, ACCESS_TOKEN_COOKIE_OPTIONS);

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
  // verifies. 20 per 5 minutes is still headroom for the web UI
  // (which refreshes every ~23 hours) and for mobile apps that
  // go offline and reconnect repeatedly.
  @Throttle({ default: { limit: 20, ttl: 5 * 60 * 1000 } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Refresh access token using refresh token' })
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
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!refreshToken) {
      throw new BadRequestException('Refresh token is required');
    }

    const tokens = await this.authService.refreshToken(refreshToken);

    // Update httpOnly cookie with new access token
    res.cookie('access_token', tokens.accessToken, ACCESS_TOKEN_COOKIE_OPTIONS);

    return {
      success: true,
      data: tokens,
      message: 'Token refreshed successfully',
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Logout and clear auth cookie' })
  @ApiResponse({ status: 200, description: 'Logged out successfully' })
  async logout(@Res({ passthrough: true }) res: Response) {
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
        organizationMemberships: user.organizationMemberships?.map(membership => ({
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
}