import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  UseGuards,
  Request,
  ParseUUIDPipe,
  ValidationPipe,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsObject, IsOptional } from 'class-validator';

import { GatewaysService } from './gateways.service';
import { GatewayAuthService, CreateGatewayAuthDto } from './gateway-auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { GatewayAuthType } from '../../entities/gateway-auth.entity';

class CreateGatewayAuthBodyDto {
  @IsEnum(GatewayAuthType)
  type: GatewayAuthType;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsObject()
  configuration: Record<string, any>;

  @IsOptional()
  @IsObject()
  validationRules?: {
    keyFormat?: string;
    minKeyLength?: number;
    maxKeyLength?: number;
    allowedIpRanges?: string[];
    requiredHeaders?: string[];
    rateLimiting?: {
      enabled: boolean;
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };

  @IsOptional()
  @IsObject()
  errorResponses?: {
    unauthorized?: { code: number; message: string; details?: Record<string, any> };
    forbidden?: { code: number; message: string; details?: Record<string, any> };
    invalid?: { code: number; message: string; details?: Record<string, any> };
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

@Controller('gateways')
@ApiTags('Gateways')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class GatewayAuthController {
  private readonly logger = new Logger(GatewayAuthController.name);

  constructor(
    private readonly gatewayAuthService: GatewayAuthService,
    private readonly gatewaysService: GatewaysService,
  ) {}

  // Auth endpoints
  @Post(':gatewayId/auth')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create gateway authentication configuration' })
  @ApiResponse({ status: 201, description: 'Gateway auth created successfully' })
  async createGatewayAuth(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Body(ValidationPipe) createGatewayAuthDto: CreateGatewayAuthBodyDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const gatewayAuth = await this.gatewayAuthService.createGatewayAuth(
        gatewayId,
        createGatewayAuthDto as CreateGatewayAuthDto,
        organizationId
      );

      return {
        success: true,
        data: gatewayAuth,
        message: 'Gateway authentication created successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_AUTH_CREATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/auth')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get gateway authentication configurations' })
  @ApiResponse({ status: 200, description: 'Gateway auth configurations retrieved successfully' })
  async getGatewayAuths(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const auths = await this.gatewayAuthService.getGatewayAuths(gatewayId, organizationId);

      return {
        success: true,
        data: auths,
        message: 'Gateway auth configurations retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_AUTH_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // Auth config management
  @Delete(':gatewayId/auth/:authId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete gateway authentication configuration' })
  @ApiResponse({ status: 200, description: 'Gateway auth deleted successfully' })
  async deleteGatewayAuth(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Param('authId', ParseUUIDPipe) authId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.gatewayAuthService.deleteGatewayAuth(authId, organizationId);

      return {
        success: true,
        message: 'Gateway authentication deleted successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_AUTH_DELETION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // Gateway API key management
  @Post(':gatewayId/auth/api-keys')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Generate a new API key for a gateway' })
  @ApiResponse({ status: 201, description: 'API key generated successfully' })
  async generateGatewayApiKey(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Body() body: { name: string; scopes?: string[]; expiresAt?: string },
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      const userId = req.user.sub || req.user.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Verify gateway belongs to org
      const gateway = await this.gatewaysService.getGateway(gatewayId, organizationId);
      if (!gateway) {
        throw new HttpException(
          { success: false, message: 'Gateway not found', error: 'GATEWAY_NOT_FOUND' },
          HttpStatus.NOT_FOUND,
        );
      }

      const apiKey = await this.gatewayAuthService.generateApiKey(
        body.name || `${gateway.name} API Key`,
        organizationId,
        userId,
        body.scopes || ['gateway:use'],
        body.expiresAt ? new Date(body.expiresAt) : undefined,
        gatewayId,
      );

      return {
        success: true,
        data: {
          id: apiKey.id,
          name: apiKey.name,
          key: (apiKey as any).key, // Only returned once
          keyPrefix: apiKey.keyPrefix,
          scopes: apiKey.scopes,
          expiresAt: apiKey.expiresAt,
          createdAt: apiKey.createdAt,
        },
        message: 'API key generated. Save it now — it will not be shown again.',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'API_KEY_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/auth/api-keys')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'List API keys for a gateway' })
  @ApiResponse({ status: 200, description: 'API keys retrieved successfully' })
  async listGatewayApiKeys(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const keys = await this.gatewayAuthService.listGatewayApiKeys(gatewayId, organizationId);

      return {
        success: true,
        data: keys,
        message: `Found ${keys.length} API key(s)`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'API_KEY_LIST_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':gatewayId/auth/api-keys/:keyId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Revoke an API key for a gateway' })
  @ApiResponse({ status: 200, description: 'API key revoked successfully' })
  async revokeGatewayApiKey(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Param('keyId', ParseUUIDPipe) keyId: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.gatewayAuthService.revokeGatewayApiKey(keyId, gatewayId, organizationId);

      return {
        success: true,
        message: 'API key revoked successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'API_KEY_REVOCATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
