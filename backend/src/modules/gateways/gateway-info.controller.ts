import {
  Controller,
  Get,
  Param,
  Query,
  Post,
  Request,
  ParseUUIDPipe,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';

import { GatewaysService } from './gateways.service';
import { SkillGeneratorService } from '../tools/skill-generator.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { batchAsync } from '../../common/utils/batch-async';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('gateways')
@ApiTags('Gateways')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class GatewayInfoController {
  constructor(
    private readonly gatewaysService: GatewaysService,
    private readonly skillGeneratorService: SkillGeneratorService,
  ) {}

  @Get('skills/search')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Search skills across all user gateways' })
  @ApiResponse({ status: 200, description: 'Skills retrieved successfully' })
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
        { success: false, message: error.message, error: 'SKILLS_SEARCH_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('all-skills')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Fetch all skills across all user gateways (for daemon mode)' })
  @ApiResponse({ status: 200, description: 'All skills retrieved successfully' })
  async getAllSkills(@Request() req: any) {
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
        return { gatewayId: gateway.id, gatewayName: gateway.name, orgSlug, gatewaySlug, skills };
      });

      return {
        success: true,
        data: result,
        message: `Retrieved skills from ${result.length} gateway(s)`,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'ALL_SKILLS_RETRIEVAL_FAILED' },
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
        { success: false, message: error.message, error: 'GATEWAY_STATS_RETRIEVAL_FAILED' },
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
        { success: false, message: error.message, error: 'HEALTH_CHECK_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('stats/overview')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization gateway overview statistics' })
  @ApiResponse({ status: 200, description: 'Organization gateway statistics retrieved successfully' })
  async getOrganizationStats(@Request() req: any) {
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
        { success: false, message: error.message, error: 'ORG_GATEWAY_STATS_RETRIEVAL_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

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
