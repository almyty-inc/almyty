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

import {
  CreateGatewayBodyDto,
  UpdateGatewayBodyDto,
  GatewaySearchQueryDto,
} from './dto/controller-body.dto';


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

}