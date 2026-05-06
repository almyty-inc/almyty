import {
  Controller,
  Get,
  Post,
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
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsObject, IsOptional, IsString, IsEnum, IsNumber, Min, Max } from 'class-validator';
import { Transform, Type } from 'class-transformer';

import {
  GatewayToolService,
  CreateGatewayToolDto,
  UpdateGatewayToolDto,
  BulkAssociateToolsDto,
  GatewayToolSearchFilters,
} from './gateway-tool.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

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
export class GatewayToolsController {
  private readonly logger = new Logger(GatewayToolsController.name);

  constructor(private readonly gatewayToolService: GatewayToolService) {}


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

}
