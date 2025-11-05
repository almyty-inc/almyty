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
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
} from '@nestjs/swagger';

import { AuthService, AuthTokens } from './auth.service';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { LoginDto } from './dto/login.dto';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '../../entities/user.entity';

@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
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
      available,
      message: available
        ? 'Organization name is available'
        : 'Organization name is already taken',
    };
  }

  @Public()
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
  async register(@Body() createUserDto: CreateUserDto) {
    const tokens = await this.authService.register(createUserDto);
    
    return {
      ...tokens,
      message: 'User registered successfully',
    };
  }

  @Public()
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
  async login(@Request() req: any): Promise<AuthTokens> {
    return this.authService.generateTokens(req.user);
  }

  @Public()
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
  async refresh(@Body('refreshToken') refreshToken: string): Promise<AuthTokens> {
    if (!refreshToken) {
      throw new BadRequestException('Refresh token is required');
    }
    
    return this.authService.refreshToken(refreshToken);
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
      ...profile,
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
      ...profile,
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
      message: 'API key created successfully',
      apiKey, // This is the only time the full key is returned
      keyData: {
        id: keyData.id,
        name: keyData.name,
        keyPrefix: keyData.keyPrefix,
        scopes: keyData.scopes,
        expiresAt: keyData.expiresAt,
        createdAt: keyData.createdAt,
      },
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
      message: 'API key revoked successfully',
    };
  }

  @Public()
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
      message: 'Password reset successfully',
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Change user password' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        currentPassword: { type: 'string' },
        newPassword: { type: 'string', minLength: 8 },
      },
      required: ['currentPassword', 'newPassword'],
    },
  })
  @ApiResponse({ status: 200, description: 'Password changed successfully' })
  @ApiResponse({ status: 400, description: 'Current password is incorrect' })
  async changePassword(
    @CurrentUser() user: User,
    @Body('currentPassword') currentPassword: string,
    @Body('newPassword') newPassword: string,
  ) {
    if (!currentPassword || !newPassword) {
      throw new BadRequestException('Current password and new password are required');
    }
    
    await this.authService.changePassword(user.id, currentPassword, newPassword);
    
    return {
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
      message: 'Email verified successfully',
    };
  }
}