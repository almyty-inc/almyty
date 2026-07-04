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
import { maskChannelConfigSecrets } from './channels/channel-config.helper';

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

  /**
   * Channel secrets (bot tokens, signing secrets, ...) never leave the
   * API in the clear — replace them with a fixed placeholder on every
   * endpoint that returns a gateway. The update path swaps the
   * placeholder back for the stored value, so round-tripping a masked
   * configuration is safe.
   */
  private maskGatewaySecrets<T extends { configuration?: Record<string, any> | null }>(gateway: T): T {
    if (!gateway || !gateway.configuration) return gateway;
    return { ...gateway, configuration: maskChannelConfigSecrets(gateway.configuration) } as T;
  }

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
          ...this.maskGatewaySecrets(gateway),
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
        caller: { id: req.user.id },
      };

      const result = await this.gatewaysService.getGateways(filters);

      return {
        success: true,
        data: {
          ...result,
          gateways: result.gateways.map((g) => this.maskGatewaySecrets(g)),
        },
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
        data: this.maskGatewaySecrets(gateway),
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
        data: this.maskGatewaySecrets(gateway),
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
        data: this.maskGatewaySecrets(gateway),
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
        data: this.maskGatewaySecrets(gateway),
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
}