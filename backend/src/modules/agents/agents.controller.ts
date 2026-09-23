import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  Request,
  ParseUUIDPipe,
  ValidationPipe,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IsString, IsOptional, IsEnum, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { Response } from 'express';

import { AgentsService, AgentSearchFilters } from './agents.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { InvokeAgentDto } from './dto/invoke-agent.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrivateAgentGuard } from '../../common/authorization/private-resource.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AgentStatus } from '../../entities/agent.entity';
import { AgentRole } from '../../entities/agent-role.entity';

class AgentSearchQueryDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(AgentStatus)
  status?: AgentStatus;

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
  @IsEnum(['name', 'createdAt', 'updatedAt', 'totalExecutions'])
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'totalExecutions';

  @IsOptional()
  @IsEnum(['ASC', 'DESC'])
  sortOrder?: 'ASC' | 'DESC';
}

@Controller('agents')
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PrivateAgentGuard)
export class AgentsController {
  private readonly logger = new Logger(AgentsController.name);

  constructor(
    private readonly agentsService: AgentsService,
    private readonly runtimeService: AgentRuntimeService,
    @InjectRepository(AgentRole) private readonly agentRoles: Repository<AgentRole>,
  ) {}

  /**
   * Make the queue agree with the heartbeat the agent was just saved with.
   *
   * The builder puts `heartbeat` on the ordinary create/update payload and
   * the service persists it, but the repeatable job is only ever enqueued
   * by PATCH /agents/:id/heartbeat -- which no frontend code calls. So the
   * row said heartbeat enabled, the builder reloaded it as enabled, and
   * the agent never woke up. Nothing restores heartbeat jobs at boot
   * either, unlike schedules.
   *
   * Best-effort: a queue that is briefly unreachable must not fail the
   * save that already succeeded, and the next save reconciles again.
   */
  private async reconcileHeartbeat(agent: any, organizationId: string, dtoHeartbeat: unknown): Promise<void> {
    if (dtoHeartbeat === undefined) return;
    try {
      const heartbeat = agent?.heartbeat;
      if (heartbeat?.enabled && heartbeat.intervalMinutes) {
        await this.runtimeService.enableHeartbeat(
          agent.id,
          organizationId,
          heartbeat.intervalMinutes,
          heartbeat.prompt ?? '',
        );
      } else {
        await this.runtimeService.disableHeartbeat(agent.id, organizationId);
      }
    } catch (err: any) {
      this.logger.warn(`Could not reconcile heartbeat for agent ${agent?.id}: ${err?.message ?? err}`);
    }
  }


  @Post()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Create a new agent' })
  @ApiBody({ description: 'Agent configuration including name, pipeline, and settings' })
  @ApiResponse({ status: 201, description: 'Agent created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async createAgent(
    @Body(ValidationPipe) createAgentDto: CreateAgentDto,
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
      const agent = await this.agentsService.createAgent(
        createAgentDto,
        organizationId,
        userId,
      );
      await this.reconcileHeartbeat(agent, organizationId, createAgentDto.heartbeat);

      return {
        success: true,
        data: agent,
        message: 'Agent created successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_CREATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get()
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get all agents for organization' })
  @ApiResponse({ status: 200, description: 'Agents retrieved successfully' })
  async getAgents(
    @Query(ValidationPipe) query: AgentSearchQueryDto,
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

      const filters: AgentSearchFilters = {
        ...query,
        organizationId,
        caller: { id: req.user.id },
      };

      const result = await this.agentsService.getAgents(filters);

      return {
        success: true,
        data: result.data,
        pagination: {
          total: result.total,
          page: result.page,
          limit: result.limit,
          totalPages: result.totalPages,
        },
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENTS_FETCH_FAILED',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('templates')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get pre-built agent templates' })
  @ApiResponse({ status: 200, description: 'Templates retrieved successfully' })
  getTemplates() {
    return {
      success: true,
      data: this.agentsService.getTemplates(),
    };
  }

  @Post('import')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Import an agent from JSON' })
  @ApiBody({ description: 'Exported agent JSON data' })
  @ApiResponse({ status: 201, description: 'Agent imported successfully' })
  @ApiResponse({ status: 400, description: 'Invalid import data' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async importAgent(
    @Body() body: any,
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
      const agent = await this.agentsService.importAgent(body, organizationId, userId);

      return {
        success: true,
        data: agent,
        message: 'Agent imported successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_IMPORT_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':id')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get agent by ID' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async getAgent(
    @Param('id', ParseUUIDPipe) id: string,
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

      const agent = await this.agentsService.getAgent(id, organizationId, { id: req.user.sub || req.user.id });

      return {
        success: true,
        data: agent,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_FETCH_FAILED',
        },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Patch(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Update agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Agent fields to update' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async updateAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) updateAgentDto: UpdateAgentDto,
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
      const agent = await this.agentsService.updateAgent(id, updateAgentDto, organizationId, userId);
      await this.reconcileHeartbeat(agent, organizationId, (updateAgentDto as any).heartbeat);

      return {
        success: true,
        data: agent,
        message: 'Agent updated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_UPDATE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Delete agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent deleted successfully' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async deleteAgent(
    @Param('id', ParseUUIDPipe) id: string,
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
      await this.agentsService.deleteAgent(id, organizationId, userId);

      return {
        success: true,
        message: 'Agent deleted successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_DELETE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':id/readiness')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Check workflow model setup without making a model call' })
  async getReadiness(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    const organizationId = req.user.currentOrganizationId;
    if (!organizationId) throw new HttpException('No organization found', HttpStatus.BAD_REQUEST);
    return { success: true, data: await this.agentsService.getReadiness(id, organizationId, req.user.sub || req.user.id) };
  }

  @Post(':id/activate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Activate agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent activated successfully' })
  @ApiResponse({ status: 400, description: 'Agent cannot be activated' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async activateAgent(
    @Param('id', ParseUUIDPipe) id: string,
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

      const agent = await this.agentsService.activateAgent(id, organizationId, req.user.sub || req.user.id);

      return {
        success: true,
        data: agent,
        message: 'Agent activated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_ACTIVATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':id/deactivate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Deactivate agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent deactivated successfully' })
  @ApiResponse({ status: 400, description: 'Agent cannot be deactivated' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async deactivateAgent(
    @Param('id', ParseUUIDPipe) id: string,
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

      const agent = await this.agentsService.deactivateAgent(id, organizationId, req.user.sub || req.user.id);

      return {
        success: true,
        data: agent,
        message: 'Agent deactivated successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_DEACTIVATION_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':id/duplicate')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Duplicate agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 201, description: 'Agent duplicated successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async duplicateAgent(
    @Param('id', ParseUUIDPipe) id: string,
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

      const original = await this.agentsService.getAgent(id, organizationId, { id: req.user.sub || req.user.id });
      if (!original) {
        throw new HttpException(
          { success: false, message: 'Agent not found', error: 'NOT_FOUND' },
          HttpStatus.NOT_FOUND,
        );
      }

      const duplicate = await this.agentsService.createAgent({
        name: `${original.name} (Copy)`,
        description: original.description,
        pipeline: original.pipeline,
        variables: original.variables,
        settings: original.settings,
        status: 'draft',
        // The copy keeps the original's scope, so a private agent's copy
        // (and the private tools it references) stays private to its owner.
        visibility: original.visibility,
        teamId: original.teamId,
      } as any, organizationId, req.user.id);

      // Roles live in their own table, so copying the agent row left them
      // behind -- while `settings.execution.strategyKey` came across. The
      // copy therefore kept the strategy and lost every role that
      // strategy needs, and opened on "No roles yet" with every strategy
      // reporting a missing slot. A duplicate that cannot run is not a
      // duplicate.
      const originalRoles = await this.agentRoles.find({ where: { organizationId, agentId: id } });
      if (originalRoles.length) {
        await this.agentRoles.save(
          originalRoles.map(role =>
            this.agentRoles.create({
              organizationId,
              agentId: duplicate.id,
              key: role.key,
              displayName: role.displayName,
              requirement: role.requirement,
              binding: role.binding,
            }),
          ),
        );
      }

      return {
        success: true,
        data: duplicate,
        message: 'Agent duplicated successfully',
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { success: false, message: error.message, error: 'AGENT_DUPLICATION_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
