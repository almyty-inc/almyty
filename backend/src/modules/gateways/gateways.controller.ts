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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsObject, IsBoolean, IsNumber, Min, Max, IsArray } from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { GatewaysService, CreateGatewayDto, UpdateGatewayDto, GatewaySearchFilters } from './gateways.service';
import { GatewayAuthService, CreateGatewayAuthDto, UpdateGatewayAuthDto } from './gateway-auth.service';
import { GatewayToolService, CreateGatewayToolDto, UpdateGatewayToolDto, BulkAssociateToolsDto, GatewayToolSearchFilters } from './gateway-tool.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { GatewayAuthType } from '../../entities/gateway-auth.entity';

class CreateGatewayBodyDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(GatewayType)
  type: GatewayType;

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
  constructor(
    private readonly gatewaysService: GatewaysService,
    private readonly gatewayAuthService: GatewayAuthService,
    private readonly gatewayToolService: GatewayToolService,
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
      const organizationId = req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const gateway = await this.gatewaysService.createGateway(
        createGatewayDto as CreateGatewayDto,
        organizationId,
        req.user.id
      );

      return {
        success: true,
        data: gateway,
        message: 'Gateway created successfully',
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
      const organizationId = req.user.organizations?.[0]?.id;
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
}