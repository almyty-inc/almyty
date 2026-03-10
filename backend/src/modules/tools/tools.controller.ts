import {
  Controller,
  Get,
  Post,
  Put,
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
import { IsString, IsOptional, IsEnum, IsArray, IsObject, IsNumber, Min, Max } from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { ToolsService, CreateToolDto, UpdateToolDto, ToolSearchFilters } from './tools.service';
import { ToolGeneratorService, ToolGenerationOptions } from './tool-generator.service';
import { ToolExecutorService, ToolExecutionOptions } from './tool-executor.service';
import { SkillGeneratorService } from './skill-generator.service';
import { CliGeneratorService } from './cli-generator.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ToolType, ToolStatus, ToolExecutionMethod } from '../../entities/tool.entity';

class CreateToolBodyDto {
  @IsString()
  name: string;

  @IsString()
  description: string;

  @IsEnum(ToolType)
  type: ToolType;

  @IsObject()
  parameters: Record<string, any>;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsEnum(ToolExecutionMethod)
  executionMethod?: ToolExecutionMethod;

  @IsOptional()
  @IsObject()
  authConfig?: any;

  @IsOptional()
  @IsObject()
  configuration?: {
    timeout?: number;
    retries?: number;
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  operationId?: string;

  @IsOptional()
  @IsString()
  inputSchemaId?: string;

  @IsOptional()
  @IsString()
  outputSchemaId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

class UpdateToolBodyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsObject()
  parameters?: Record<string, any>;

  @IsOptional()
  @IsObject()
  configuration?: {
    timeout?: number;
    retries?: number;
    cache?: {
      enabled: boolean;
      ttl?: number;
    };
    rateLimit?: {
      requestsPerMinute?: number;
      requestsPerHour?: number;
    };
  };

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

class GenerateToolsFromApiDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  includeOperations?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeOperations?: string[];

  @IsOptional()
  @IsString()
  namePrefix?: string;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  defaultTimeout?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  defaultRetries?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categoryIds?: string[];
}

class ExecuteToolDto {
  @IsObject()
  parameters: Record<string, any>;

  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(300000)
  timeout?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  retries?: number;

  @IsOptional()
  skipCache?: boolean;

  @IsOptional()
  skipRateLimit?: boolean;
}

class ToolSearchQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(ToolType)
  type?: ToolType;

  @IsOptional()
  @IsEnum(ToolStatus)
  status?: ToolStatus;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => typeof value === 'string' ? value.split(',') : value)
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  apiId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => typeof value === 'string' ? value.split(',') : value)
  tags?: string[];

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
  @IsEnum(['name', 'createdAt', 'updatedAt', 'usage'])
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'usage';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

@Controller('organizations/:organizationId/tools')
@ApiTags('Tools')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ToolsController {
  constructor(
    private readonly toolsService: ToolsService,
    private readonly toolGeneratorService: ToolGeneratorService,
    private readonly toolExecutorService: ToolExecutorService,
    private readonly skillGeneratorService: SkillGeneratorService,
    private readonly cliGeneratorService: CliGeneratorService,
  ) {}

  @Post()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Create a new tool' })
  @ApiResponse({ status: 201, description: 'Tool created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async createTool(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body(ValidationPipe) createToolDto: CreateToolBodyDto,
    @Request() req: any,
  ) {
    try {
      const tool = await this.toolsService.createTool(
        createToolDto as CreateToolDto,
        organizationId,
        req.user.id
      );

      return {
        success: true,
        data: tool,
        message: 'Tool created successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_CREATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get all tools for organization' })
  @ApiResponse({ status: 200, description: 'Tools retrieved successfully' })
  async getTools(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query(ValidationPipe) query: ToolSearchQueryDto,
    @Request() req: any,
  ) {
    try {
      const filters: ToolSearchFilters = {
        ...query,
        organizationId,
      };

      const result = await this.toolsService.getTools(filters);

      return {
        success: true,
        data: result,
        message: 'Tools retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOLS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':toolId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get tool by ID' })
  @ApiResponse({ status: 200, description: 'Tool retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Tool not found' })
  async getTool(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Request() req: any,
  ) {
    try {
      const tool = await this.toolsService.getTool(toolId, organizationId);

      return {
        success: true,
        data: tool,
        message: 'Tool retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_NOT_FOUND',
        },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Put(':toolId')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Update tool' })
  @ApiResponse({ status: 200, description: 'Tool updated successfully' })
  @ApiResponse({ status: 404, description: 'Tool not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async updateTool(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Body(ValidationPipe) updateToolDto: UpdateToolBodyDto,
    @Request() req: any,
  ) {
    try {
      const tool = await this.toolsService.updateTool(
        toolId,
        updateToolDto as UpdateToolDto,
        organizationId,
        req.user.id
      );

      return {
        success: true,
        data: tool,
        message: 'Tool updated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_UPDATE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':toolId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete tool' })
  @ApiResponse({ status: 200, description: 'Tool deleted successfully' })
  @ApiResponse({ status: 404, description: 'Tool not found' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async deleteTool(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Request() req: any,
  ) {
    try {
      await this.toolsService.deleteTool(toolId, organizationId, req.user.id);

      return {
        success: true,
        message: 'Tool deleted successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_DELETION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':toolId/activate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Activate tool' })
  @ApiResponse({ status: 200, description: 'Tool activated successfully' })
  async activateTool(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Request() req: any,
  ) {
    try {
      const tool = await this.toolsService.activateTool(toolId, organizationId, req.user.id);

      return {
        success: true,
        data: tool,
        message: 'Tool activated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_ACTIVATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':toolId/deactivate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Deactivate tool' })
  @ApiResponse({ status: 200, description: 'Tool deactivated successfully' })
  async deactivateTool(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Request() req: any,
  ) {
    try {
      const tool = await this.toolsService.deactivateTool(toolId, organizationId, req.user.id);

      return {
        success: true,
        data: tool,
        message: 'Tool deactivated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_DEACTIVATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':toolId/execute')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Execute tool' })
  @ApiResponse({ status: 200, description: 'Tool executed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid parameters or tool execution failed' })
  async executeTool(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Body(ValidationPipe) executeDto: ExecuteToolDto,
    @Request() req: any,
  ) {
    try {
      const options: ToolExecutionOptions = {
        userId: req.user.id,
        organizationId,
        timeout: executeDto.timeout,
        retries: executeDto.retries,
        skipCache: executeDto.skipCache,
        skipRateLimit: executeDto.skipRateLimit,
      };

      const result = await this.toolExecutorService.executeTool(
        toolId,
        executeDto.parameters,
        options
      );

      return {
        success: result.success,
        data: result.data,
        error: result.error,
        metadata: {
          executionTime: result.executionTime,
          cached: result.cached,
          rateLimited: result.rateLimited,
          retryCount: result.retryCount,
          ...result.metadata,
        },
        message: result.success ? 'Tool executed successfully' : 'Tool execution failed',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_EXECUTION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':toolId/versions')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get tool versions' })
  @ApiResponse({ status: 200, description: 'Tool versions retrieved successfully' })
  async getToolVersions(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Request() req: any,
  ) {
    try {
      const versions = await this.toolsService.getToolVersions(toolId, organizationId);

      return {
        success: true,
        data: versions,
        message: 'Tool versions retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_VERSIONS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':toolId/stats')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get tool usage statistics' })
  @ApiQuery({ name: 'timeframe', enum: ['hour', 'day', 'week', 'month'], required: false })
  @ApiResponse({ status: 200, description: 'Tool statistics retrieved successfully' })
  async getToolStats(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Query('timeframe') timeframe: 'hour' | 'day' | 'week' | 'month' = 'day',
    @Request() req: any,
  ) {
    try {
      const stats = await this.toolsService.getToolUsageStats(toolId, organizationId, timeframe);

      return {
        success: true,
        data: stats,
        message: 'Tool statistics retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_STATS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('generate-from-api/:apiId')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Generate tools from API operations' })
  @ApiResponse({ status: 201, description: 'Tools generated successfully' })
  @ApiResponse({ status: 404, description: 'API not found' })
  async generateToolsFromApi(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('apiId', ParseUUIDPipe) apiId: string,
    @Body(ValidationPipe) generateDto: GenerateToolsFromApiDto,
    @Request() req: any,
  ) {
    try {
      // Get the API
      const api = await this.toolsService['apiRepository'].findOne({
        where: { id: apiId, organizationId },
      });

      if (!api) {
        throw new HttpException(
          {
            success: false,
            message: 'API not found',
            error: 'API_NOT_FOUND',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      const options: ToolGenerationOptions = {
        includeOperations: generateDto.includeOperations,
        excludeOperations: generateDto.excludeOperations,
        namePrefix: generateDto.namePrefix,
        defaultTimeout: generateDto.defaultTimeout,
        defaultRetries: generateDto.defaultRetries,
        categoryIds: generateDto.categoryIds,
      };

      const result = await this.toolGeneratorService.generateToolsFromApi(api, options);

      return {
        success: true,
        data: result,
        message: `Generated ${result.summary.generated} tools successfully`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':toolId/regenerate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Regenerate tool from operation' })
  @ApiResponse({ status: 200, description: 'Tool regenerated successfully' })
  async regenerateTool(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Request() req: any,
  ) {
    try {
      const tool = await this.toolGeneratorService.regenerateToolFromOperation(toolId);

      return {
        success: true,
        data: tool,
        message: 'Tool regenerated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'TOOL_REGENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('stats/overview')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get organization tool overview statistics' })
  @ApiResponse({ status: 200, description: 'Organization tool statistics retrieved successfully' })
  async getOrganizationStats(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Request() req: any,
  ) {
    try {
      const stats = await this.toolsService.getOrganizationToolStats(organizationId);

      return {
        success: true,
        data: stats,
        message: 'Organization tool statistics retrieved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'ORG_STATS_RETRIEVAL_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':toolId/skill')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate skill file for a tool' })
  @ApiResponse({ status: 200, description: 'Skill generated successfully' })
  async getToolSkill(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Request() req: any,
  ) {
    try {
      const skill = await this.skillGeneratorService.generateToolSkill(toolId);

      return {
        success: true,
        data: skill,
        message: 'Skill generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SKILL_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':toolId/cli')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Generate CLI script for a tool' })
  @ApiQuery({ name: 'format', enum: ['bash', 'node'], required: false })
  @ApiResponse({ status: 200, description: 'CLI script generated successfully' })
  async getToolCli(
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('toolId', ParseUUIDPipe) toolId: string,
    @Query('format') format: 'bash' | 'node' = 'bash',
    @Request() req: any,
  ) {
    try {
      const cli = await this.cliGeneratorService.generateToolCli(toolId, format);

      return {
        success: true,
        data: cli,
        message: 'CLI script generated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'CLI_GENERATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}