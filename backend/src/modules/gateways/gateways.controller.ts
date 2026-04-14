import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ParseUUIDPipe,
  ValidationPipe,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsObject, IsBoolean, IsNumber, Min, Max, IsArray } from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { GatewaysService, CreateGatewayDto, UpdateGatewayDto, GatewaySearchFilters } from './gateways.service';
import { GatewayAuthService, CreateGatewayAuthDto, UpdateGatewayAuthDto } from './gateway-auth.service';
import { GatewayToolService, CreateGatewayToolDto, UpdateGatewayToolDto, BulkAssociateToolsDto, GatewayToolSearchFilters } from './gateway-tool.service';
import { SkillGeneratorService } from '../tools/skill-generator.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { CliGeneratorService } from '../tools/cli-generator.service';
import { CodegenService } from '../tools/codegen.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { batchAsync } from '../../common/utils/batch-async';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { GatewayKind, GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { GatewayAuthType } from '../../entities/gateway-auth.entity';

class CreateGatewayBodyDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(GatewayKind)
  kind?: GatewayKind;

  @IsEnum(GatewayType)
  type: GatewayType;

  @IsOptional()
  @IsString()
  agentId?: string;

  @IsString()
  endpoint: string;

  @IsObject()
  configuration: Record<string, any>;

  @IsOptional()
  @IsObject()
  rateLimitConfig?: {
    enabled: boolean;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
    burstLimit?: number;
    windowSize?: number;
  };

  @IsOptional()
  @IsObject()
  corsConfig?: {
    origins: string[];
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };

  @IsOptional()
  @IsObject()
  webhooks?: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      events: string[];
      secret?: string;
    }>;
  };

  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  requestTimeout?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  maxRetries?: number;

  @IsOptional()
  @IsObject()
  customHeaders?: Record<string, string>;

  @IsOptional()
  @IsObject()
  healthCheck?: {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

class UpdateGatewayBodyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  endpoint?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsObject()
  configuration?: Record<string, any>;

  @IsOptional()
  @IsObject()
  rateLimitConfig?: {
    enabled: boolean;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
    burstLimit?: number;
    windowSize?: number;
  };

  @IsOptional()
  @IsObject()
  corsConfig?: {
    origins: string[];
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };

  @IsOptional()
  @IsObject()
  webhooks?: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      events: string[];
      secret?: string;
    }>;
  };

  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  requestTimeout?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  maxRetries?: number;

  @IsOptional()
  @IsObject()
  customHeaders?: Record<string, string>;

  @IsOptional()
  @IsObject()
  healthCheck?: {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

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
    unauthorized?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
    forbidden?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
    invalid?: {
      code: number;
      message: string;
      details?: Record<string, any>;
    };
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

class CreateGatewayToolBodyDto {
  @IsString()
  toolId: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  overrides?: {
    name?: string;
    description?: string;
    parameters?: Record<string, any>;
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
    timeout?: number;
    retries?: number;
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
  };

  @IsOptional()
  @IsObject()
  permissions?: {
    allowedUsers?: string[];
    allowedRoles?: string[];
    allowedOrganizations?: string[];
    requiredScopes?: string[];
  };

  @IsOptional()
  @IsObject()
  transformations?: {
    inputMapping?: Record<string, string>;
    outputMapping?: Record<string, string>;
    headerMapping?: Record<string, string>;
  };

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

class BulkAssociateToolsBodyDto {
  @IsArray()
  @IsString({ each: true })
  toolIds: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsObject()
  permissions?: {
    allowedUsers?: string[];
    allowedRoles?: string[];
    allowedOrganizations?: string[];
    requiredScopes?: string[];
  };
}

class GatewaySearchQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(GatewayType)
  type?: GatewayType;

  @IsOptional()
  @IsEnum(GatewayStatus)
  status?: GatewayStatus;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsEnum(['name', 'createdAt', 'updatedAt', 'totalRequests'])
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'totalRequests';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

class GatewayToolSearchQueryDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => typeof value === 'string' ? value.split(',') : value)
  toolIds?: string[];

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsEnum(['name', 'associatedAt', 'lastUsedAt', 'usageCount'])
  sortBy?: 'name' | 'associatedAt' | 'lastUsedAt' | 'usageCount';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

@Controller('gateways')
@ApiTags('Gateways')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class GatewaysController {
  private readonly logger = new Logger(GatewaysController.name);

  constructor(
    private readonly gatewaysService: GatewaysService,
    private readonly gatewayAuthService: GatewayAuthService,
    private readonly gatewayToolService: GatewayToolService,
    private readonly skillGeneratorService: SkillGeneratorService,
    private readonly toolExecutorService: ToolExecutorService,
    private readonly cliGeneratorService: CliGeneratorService,
    private readonly codegenService: CodegenService,
  ) {}

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a new gateway' })
  @ApiResponse({ status: 201, description: 'Gateway created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async createGateway(
    @Body(ValidationPipe) createGatewayDto: CreateGatewayBodyDto,
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

      const userId = req.user.sub || req.user.id;
      const gateway = await this.gatewaysService.createGateway(
        createGatewayDto as CreateGatewayDto,
        organizationId,
        userId,
      );

      // Auto-generate an API key for non-Skills gateways
      let initialApiKey: string | undefined;
      if (gateway.type !== 'skills') {
        try {
          const apiKey = await this.gatewayAuthService.generateApiKey(
            `${gateway.name} Default Key`,
            organizationId,
            userId,
            ['gateway:use'],
            undefined,
            gateway.id,
          );
          initialApiKey = (apiKey as any).key;
        } catch (e) {
          this.logger.warn(`Failed to auto-generate API key for gateway ${gateway.id}: ${e.message}`);
        }
      }

      return {
        success: true,
        data: {
          ...gateway,
          initialApiKey, // Only returned once at creation time
        },
        message: initialApiKey
          ? 'Gateway created with API key. Save the key — it will not be shown again.'
          : 'Gateway created successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_CREATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get all gateways for organization' })
  @ApiResponse({ status: 200, description: 'Gateways retrieved successfully' })
  async getGateways(
    @Query(ValidationPipe) query: GatewaySearchQueryDto,
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

      const filters: GatewaySearchFilters = {
        ...query,
        organizationId,
      };

      const result = await this.gatewaysService.getGateways(filters);

      return {
        success: true,
        data: result,
        message: 'Gateways retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAYS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // === Skills CLI Endpoints (must be before :gatewayId parameterized routes) ===

  @Get('skills/search')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Search skills across all user gateways' })
  @ApiQuery({ name: 'q', required: true, description: 'Search query for tool name or description' })
  @ApiResponse({ status: 200, description: 'Skills search results' })
  async searchSkills(
    @Query('q') query: string,
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

      const results = await this.gatewaysService.searchSkillsAcrossGateways(organizationId, query || '');

      return {
        success: true,
        data: results,
        message: `Found ${results.length} skill(s) matching "${query}"`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SKILLS_SEARCH_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('all-skills')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Fetch all skills across all user gateways (for daemon mode)' })
  @ApiResponse({ status: 200, description: 'All skills retrieved successfully' })
  async getAllSkills(
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

      const gateways = await this.gatewaysService.getAllUserGateways(organizationId);

      const result = await batchAsync(gateways, 5, async (gateway) => {
        const orgSlug = gateway.organization?.slug || gateway.organization?.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
        const gatewaySlug = gateway.endpoint?.replace(/^\//, '') || gateway.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const skills = await this.skillGeneratorService.generateIndividualSkills(gateway.id, organizationId, { orgSlug, gatewaySlug });
        return {
          gatewayId: gateway.id,
          gatewayName: gateway.name,
          orgSlug,
          gatewaySlug,
          skills,
        };
      });

      return {
        success: true,
        data: result,
        message: `Retrieved skills from ${result.length} gateway(s)`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'ALL_SKILLS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get gateway by ID' })
  @ApiResponse({ status: 200, description: 'Gateway retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Gateway not found' })
  async getGateway(
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

      const gateway = await this.gatewaysService.getGateway(gatewayId, organizationId);

      return {
        success: true,
        data: gateway,
        message: 'Gateway retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_NOT_FOUND',
        },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Patch(':gatewayId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update gateway' })
  @ApiResponse({ status: 200, description: 'Gateway updated successfully' })
  @ApiResponse({ status: 404, description: 'Gateway not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async updateGateway(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Body(ValidationPipe) updateGatewayDto: UpdateGatewayBodyDto,
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

      const gateway = await this.gatewaysService.updateGateway(
        gatewayId,
        updateGatewayDto as UpdateGatewayDto,
        organizationId,
        req.user.id
      );

      return {
        success: true,
        data: gateway,
        message: 'Gateway updated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_UPDATE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':gatewayId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete gateway' })
  @ApiResponse({ status: 200, description: 'Gateway deleted successfully' })
  @ApiResponse({ status: 404, description: 'Gateway not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async deleteGateway(
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

      await this.gatewaysService.deleteGateway(gatewayId, organizationId, req.user.id);

      return {
        success: true,
        message: 'Gateway deleted successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_DELETION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':gatewayId/activate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Activate gateway' })
  @ApiResponse({ status: 200, description: 'Gateway activated successfully' })
  async activateGateway(
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

      const gateway = await this.gatewaysService.activateGateway(gatewayId, organizationId, req.user.id);

      return {
        success: true,
        data: gateway,
        message: 'Gateway activated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_ACTIVATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':gatewayId/deactivate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Deactivate gateway' })
  @ApiResponse({ status: 200, description: 'Gateway deactivated successfully' })
  async deactivateGateway(
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

      const gateway = await this.gatewaysService.deactivateGateway(gatewayId, organizationId, req.user.id);

      return {
        success: true,
        data: gateway,
        message: 'Gateway deactivated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_DEACTIVATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/stats')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get gateway usage statistics' })
  @ApiQuery({ name: 'timeframe', enum: ['hour', 'day', 'week', 'month'], required: false })
  @ApiResponse({ status: 200, description: 'Gateway statistics retrieved successfully' })
  async getGatewayStats(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Query('timeframe') timeframe: 'hour' | 'day' | 'week' | 'month' = 'day',
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

      const stats = await this.gatewaysService.getGatewayStats(gatewayId, organizationId, timeframe);

      return {
        success: true,
        data: stats,
        message: 'Gateway statistics retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_STATS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':gatewayId/health-check')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Perform gateway health check' })
  @ApiResponse({ status: 200, description: 'Health check performed successfully' })
  async performHealthCheck(
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

      const healthResult = await this.gatewaysService.performHealthCheck(gatewayId, organizationId);

      return {
        success: true,
        data: healthResult,
        message: 'Health check performed successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'HEALTH_CHECK_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

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

  // Tool association endpoints
  @Post(':gatewayId/tools')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Associate tool with gateway' })
  @ApiResponse({ status: 201, description: 'Tool associated successfully' })
  async associateTool(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Body(ValidationPipe) createGatewayToolDto: CreateGatewayToolBodyDto,
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

      const gatewayTool = await this.gatewayToolService.associateTool(
        gatewayId,
        createGatewayToolDto as CreateGatewayToolDto,
        organizationId,
        req.user.id
      );

      return {
        success: true,
        data: gatewayTool,
        message: 'Tool associated with gateway successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_ASSOCIATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':gatewayId/tools/bulk')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Bulk associate tools with gateway' })
  @ApiResponse({ status: 201, description: 'Tools associated successfully' })
  async bulkAssociateTools(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Body(ValidationPipe) bulkAssociateDto: BulkAssociateToolsBodyDto,
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

      const result = await this.gatewayToolService.bulkAssociateTools(
        gatewayId,
        bulkAssociateDto as BulkAssociateToolsDto,
        organizationId,
        req.user.id
      );

      return {
        success: true,
        data: result,
        message: `${result.associated.length} tools associated, ${result.skipped.length} skipped`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'BULK_ASSOCIATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':gatewayId/tools/:toolId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Remove tool from gateway' })
  @ApiResponse({ status: 200, description: 'Tool removed successfully' })
  async removeToolFromGateway(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
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

      await this.gatewayToolService.removeTool(gatewayId, toolId, organizationId);

      return {
        success: true,
        message: 'Tool removed from gateway successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_REMOVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch(':gatewayId/tools/:gatewayToolId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update gateway tool configuration (security policy, overrides, etc.)' })
  @ApiResponse({ status: 200, description: 'Gateway tool updated successfully' })
  async updateGatewayTool(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Param('gatewayToolId', ParseUUIDPipe) gatewayToolId: string,
    @Body() updateDto: any,
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

      const updated = await this.gatewayToolService.updateGatewayTool(
        gatewayToolId,
        updateDto as UpdateGatewayToolDto,
        organizationId,
        req.user.id,
      );

      return {
        success: true,
        data: updated,
        message: 'Gateway tool updated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_TOOL_UPDATE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':gatewayId/tools')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Remove all tools from gateway' })
  @ApiResponse({ status: 200, description: 'All tools removed successfully' })
  async removeAllToolsFromGateway(
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

      await this.gatewayToolService.removeAllTools(gatewayId, organizationId);

      return {
        success: true,
        message: 'All tools removed from gateway successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'ALL_TOOLS_REMOVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/tools')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get gateway tools' })
  @ApiResponse({ status: 200, description: 'Gateway tools retrieved successfully' })
  async getGatewayTools(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Query(ValidationPipe) query: GatewayToolSearchQueryDto,
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

      const filters: GatewayToolSearchFilters = {
        ...query,
        gatewayId,
        organizationId,
      };

      const result = await this.gatewayToolService.getGatewayTools(filters);

      return {
        success: true,
        data: result,
        message: 'Gateway tools retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_TOOLS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/tools/available')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get available tools for gateway' })
  @ApiResponse({ status: 200, description: 'Available tools retrieved successfully' })
  async getAvailableTools(
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

      const tools = await this.gatewayToolService.getAvailableTools(gatewayId, organizationId);

      return {
        success: true,
        data: tools,
        message: 'Available tools retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AVAILABLE_TOOLS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/tools/stats')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get gateway tool statistics' })
  @ApiResponse({ status: 200, description: 'Gateway tool statistics retrieved successfully' })
  async getGatewayToolStats(
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

      const stats = await this.gatewayToolService.getGatewayToolStats(gatewayId, organizationId);

      return {
        success: true,
        data: stats,
        message: 'Gateway tool statistics retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_TOOL_STATS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('stats/overview')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization gateway overview statistics' })
  @ApiResponse({ status: 200, description: 'Organization gateway statistics retrieved successfully' })
  async getOrganizationStats(
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

      const stats = await this.gatewaysService.getOrganizationGatewayStats(organizationId);

      return {
        success: true,
        data: stats,
        message: 'Organization gateway statistics retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'ORG_GATEWAY_STATS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // === Gateway Resolution ===

  @Get('resolve/:orgSlug/:gatewaySlug')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Resolve a gateway by @org/name slug' })
  async resolveGateway(
    @Param('orgSlug') orgSlug: string,
    @Param('gatewaySlug') gatewaySlug: string,
  ) {
    try {
      const gateway = await this.gatewaysService.resolveGateway(orgSlug, gatewaySlug);
      return {
        success: true,
        data: {
          id: gateway.id,
          name: gateway.name,
          type: gateway.type,
          endpoint: gateway.endpoint,
          organizationId: gateway.organizationId,
        },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  // === Gateway Export Endpoints ===

  @Get(':gatewayId/skills')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate skill bundle for all tools in a gateway' })
  @ApiResponse({ status: 200, description: 'Gateway skills generated successfully' })
  async getGatewaySkills(
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
      const skills = await this.skillGeneratorService.generateGatewaySkills(gatewayId, organizationId);
      return {
        success: true,
        data: skills,
        message: 'Gateway skills generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_SKILLS_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/skills/individual')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate individual SKILL.md files for each tool in a gateway' })
  @ApiResponse({ status: 200, description: 'Individual skills generated successfully' })
  async getGatewayIndividualSkills(
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

      let context: { orgSlug?: string; gatewaySlug?: string } | undefined;
      const gateway = await this.gatewaysService.getGateway(gatewayId, organizationId, false);
      const gateways = await this.gatewaysService.getAllUserGateways(organizationId);
      const org = gateways[0]?.organization;
      if (org && gateway) {
        const orgSlug = org.slug || org.name?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
        const gatewaySlug = gateway.endpoint?.replace(/^\//, '') || gateway.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        context = { orgSlug, gatewaySlug };
      }

      const skills = await this.skillGeneratorService.generateIndividualSkills(gatewayId, organizationId, context);
      return {
        success: true,
        data: { skills },
        message: `Generated ${skills.length} individual skills`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_INDIVIDUAL_SKILLS_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':gatewayId/skills/:toolId/execute')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Execute a skill via CLI' })
  @ApiParam({ name: 'gatewayId', description: 'Gateway ID' })
  @ApiParam({ name: 'toolId', description: 'Tool ID' })
  @ApiResponse({ status: 200, description: 'Skill executed successfully' })
  @ApiResponse({ status: 404, description: 'Tool not found in gateway' })
  async executeSkill(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Body() body: { parameters: Record<string, any> },
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

      const userId = req.user.sub || req.user.id;

      // Verify the tool belongs to the gateway
      const gateway = await this.gatewaysService.getGateway(gatewayId, organizationId, true);
      const gatewayTool = gateway.tools?.find(gt => gt.toolId === toolId && gt.isActive);
      if (!gatewayTool) {
        throw new HttpException(
          { success: false, message: 'Tool not found in this gateway or is inactive', error: 'TOOL_NOT_IN_GATEWAY' },
          HttpStatus.NOT_FOUND,
        );
      }

      const result = await this.toolExecutorService.executeTool(
        toolId,
        body.parameters || {},
        { userId, organizationId },
      );

      return {
        success: true,
        data: result,
        message: result.success ? 'Skill executed successfully' : 'Skill execution failed',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SKILL_EXECUTION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/cli-bundle')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate CLI bundle for all tools in a gateway' })
  @ApiResponse({ status: 200, description: 'Gateway CLI bundle generated successfully' })
  async getGatewayCliBundle(
    @Param('gatewayId', ParseUUIDPipe) gatewayId: string,
    @Query('format') format: 'bash' | 'node' = 'bash',
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
      const cli = await this.cliGeneratorService.generateGatewayCliBunde(gatewayId, format, organizationId);
      return {
        success: true,
        data: cli,
        message: 'Gateway CLI bundle generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_CLI_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':gatewayId/sdk')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate TypeScript SDK for all tools in a gateway' })
  @ApiResponse({ status: 200, description: 'Gateway SDK generated successfully' })
  async getGatewaySdk(
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
      const sdk = await this.codegenService.generateGatewaySdk(gatewayId, organizationId);
      return {
        success: true,
        data: sdk,
        message: 'Gateway SDK generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'GATEWAY_SDK_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}