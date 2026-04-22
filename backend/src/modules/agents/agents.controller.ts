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
import { IsString, IsOptional, IsEnum, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { Response } from 'express';

import { AgentsService, AgentSearchFilters } from './agents.service';
import { AgentExecutionEngine, StreamEvent } from './agent-execution.engine';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentSchedulerService } from './agent-scheduler.service';
import { AgentAuditService } from './agent-audit.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { InvokeAgentDto } from './dto/invoke-agent.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AgentStatus } from '../../entities/agent.entity';

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
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentsController {
  private readonly logger = new Logger(AgentsController.name);

  constructor(
    private readonly agentsService: AgentsService,
    private readonly executionEngine: AgentExecutionEngine,
    private readonly runtimeService: AgentRuntimeService,
    private readonly schedulerService: AgentSchedulerService,
    private readonly auditService: AgentAuditService,
  ) {}

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

      const agent = await this.agentsService.getAgent(id, organizationId);

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

      const agent = await this.agentsService.activateAgent(id, organizationId);

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

      const agent = await this.agentsService.deactivateAgent(id, organizationId);

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

      const original = await this.agentsService.getAgent(id, organizationId);
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
      } as any, organizationId, req.user.id);

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

  @Post(':id/invoke')
  @Roles('member', 'admin', 'owner')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Invoke/execute an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Agent invocation input, variables, and metadata' })
  @ApiResponse({ status: 200, description: 'Agent executed successfully' })
  @ApiResponse({ status: 400, description: 'Agent not active or invalid input' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (30 requests per minute)' })
  async invokeAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) invokeDto: InvokeAgentDto,
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
      const agent = await this.agentsService.getAgent(id, organizationId);

      if (agent.status !== AgentStatus.ACTIVE) {
        throw new HttpException(
          { success: false, message: 'Agent must be active to invoke', error: 'AGENT_NOT_ACTIVE' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const execution = await this.executionEngine.execute(
        agent,
        organizationId,
        userId,
        {
          input: invokeDto.input,
          variables: invokeDto.variables,
          metadata: invokeDto.metadata,
        },
      );

      return {
        success: execution.status === 'completed',
        data: execution,
        message: execution.status === 'completed'
          ? 'Agent executed successfully'
          : `Agent execution ${execution.status}: ${execution.error || ''}`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_INVOKE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':id/stream')
  @Roles('member', 'admin', 'owner')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Stream agent execution via SSE' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Agent invocation input, variables, and metadata' })
  @ApiResponse({ status: 200, description: 'SSE stream of execution events' })
  @ApiResponse({ status: 400, description: 'Agent not active or invalid input' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded (30 requests per minute)' })
  async streamAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) invokeDto: InvokeAgentDto,
    @Request() req: any,
    @Res() res: Response,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          message: 'No organization found',
          error: 'NO_ORGANIZATION',
        });
        return;
      }

      const userId = req.user.sub || req.user.id;
      const agent = await this.agentsService.getAgent(id, organizationId);

      if (agent.status !== AgentStatus.ACTIVE) {
        res.status(HttpStatus.BAD_REQUEST).json({
          success: false,
          message: 'Agent must be active to invoke',
          error: 'AGENT_NOT_ACTIVE',
        });
        return;
      }

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Client disconnect handling. Two responsibilities:
      //   1. suppress further res.write() so EPIPE doesn't bubble
      //      into the engine's error path
      //   2. fire an AbortController whose signal is threaded all
      //      the way down through the engine, LLM provider calls,
      //      and tool HTTP calls, so a browser tab close actually
      //      cancels the real work instead of running the pipeline
      //      to completion and discarding the output
      let clientClosed = false;
      const abortController = new AbortController();
      const markClosed = () => {
        clientClosed = true;
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      };
      req.on('close', markClosed);
      req.on('aborted', markClosed);

      const onEvent = (event: StreamEvent) => {
        if (clientClosed) return;
        const data = JSON.stringify(event);
        try {
          res.write(`event: ${event.type}\ndata: ${data}\n\n`);
        } catch {
          clientClosed = true;
        }
      };

      const execution = await this.executionEngine.execute(
        agent,
        organizationId,
        userId,
        {
          input: invokeDto.input,
          variables: invokeDto.variables,
          metadata: invokeDto.metadata,
          signal: abortController.signal,
        },
        onEvent,
      );

      // Send final result (only if the client is still listening)
      if (!clientClosed) {
        res.write(`event: done\ndata: ${JSON.stringify({ executionId: execution.id, status: execution.status })}\n\n`);
        res.end();
      }
    } catch (error) {
      this.logger.error(`[STREAM] Agent stream failed: ${error.message}`, error.stack);
      // If headers haven't been sent yet, send error as JSON
      if (!res.headersSent) {
        res.status(error.status || HttpStatus.BAD_REQUEST).json({
          success: false,
          message: error.message,
          error: 'AGENT_STREAM_FAILED',
        });
      } else {
        // Headers already sent (SSE started), send error as SSE event
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
          res.end();
        } catch {
          // Client already gone — nothing to do.
        }
      }
    }
  }

  @Get(':id/executions')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get agent execution history' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Executions retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async getAgentExecutions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Request() req?: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.agentsService.getAgentExecutions(
        id,
        organizationId,
        page ? Number(page) : 1,
        limit ? Number(limit) : 20,
      );

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
          error: 'EXECUTIONS_FETCH_FAILED',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Audit Log ──

  @Get(':id/audit-log')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get agent audit log' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Audit log retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async getAuditLog(
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

      // Verify agent exists
      await this.agentsService.getAgent(id, organizationId);

      const auditLog = await this.auditService.getAuditLog(id, organizationId);

      return {
        success: true,
        data: auditLog,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AUDIT_LOG_FETCH_FAILED',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Version Management ──

  @Post(':id/versions')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Save current agent state as a version' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Optional changelog for the version' })
  @ApiResponse({ status: 201, description: 'Version saved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async saveVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { changelog?: string },
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
      await this.agentsService.saveVersion(id, organizationId, body?.changelog, userId);

      return {
        success: true,
        message: 'Version saved successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'VERSION_SAVE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':id/versions')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get agent version history' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Version history retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async getVersionHistory(
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

      const versions = await this.agentsService.getVersionHistory(id, organizationId);

      return {
        success: true,
        data: versions,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'VERSION_HISTORY_FAILED',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post(':id/versions/:index/rollback')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Rollback agent to a specific version' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiParam({ name: 'index', description: 'Version index to rollback to' })
  @ApiResponse({ status: 200, description: 'Agent rolled back successfully' })
  @ApiResponse({ status: 400, description: 'Invalid version index' })
  @ApiResponse({ status: 404, description: 'Agent or version not found' })
  async rollbackToVersion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index') index: string,
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

      const versionIndex = parseInt(index, 10);
      if (isNaN(versionIndex)) {
        throw new HttpException(
          { success: false, message: 'Invalid version index', error: 'INVALID_INDEX' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const userId = req.user.sub || req.user.id;
      const agent = await this.agentsService.rollbackToVersion(id, organizationId, versionIndex, userId);

      return {
        success: true,
        data: agent,
        message: 'Agent rolled back successfully',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'ROLLBACK_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ── Export / Import ──

  @Get(':id/export')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Export agent as JSON' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent exported successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async exportAgent(
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

      const exportData = await this.agentsService.exportAgent(id, organizationId);

      return {
        success: true,
        data: exportData,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'AGENT_EXPORT_FAILED',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Cost Estimation ──

  @Get(':id/cost-estimate')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get cost estimate for an agent pipeline' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Cost estimate retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async getCostEstimate(
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

      const estimate = await this.agentsService.estimateCost(id, organizationId);

      return {
        success: true,
        data: estimate,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'COST_ESTIMATE_FAILED',
        },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ── Scheduling ──

  @Patch(':id/schedule')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Enable/disable agent schedule and update interval' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Schedule configuration: enabled, intervalMinutes, and optional input' })
  @ApiResponse({ status: 200, description: 'Agent schedule updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid schedule configuration' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async updateSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { enabled: boolean; intervalMinutes?: number; input?: Record<string, any> },
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

      if (body.enabled) {
        const intervalMinutes = body.intervalMinutes;
        if (!intervalMinutes || intervalMinutes < 1) {
          throw new HttpException(
            { success: false, message: 'intervalMinutes must be at least 1 when enabling schedule', error: 'INVALID_INTERVAL' },
            HttpStatus.BAD_REQUEST,
          );
        }

        const agent = await this.schedulerService.scheduleAgent(
          id,
          organizationId,
          intervalMinutes,
          body.input || {},
        );

        return {
          success: true,
          data: agent,
          message: `Agent scheduled to run every ${intervalMinutes} minute(s)`,
        };
      } else {
        const agent = await this.schedulerService.unscheduleAgent(id, organizationId);

        return {
          success: true,
          data: agent,
          message: 'Agent schedule disabled',
        };
      }
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SCHEDULE_UPDATE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':id/schedule')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Schedule agent for periodic execution' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Schedule configuration: intervalMinutes and optional input' })
  @ApiResponse({ status: 200, description: 'Agent scheduled successfully' })
  @ApiResponse({ status: 400, description: 'Invalid schedule configuration' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async scheduleAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { intervalMinutes: number; input?: Record<string, any> },
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

      if (!body.intervalMinutes || body.intervalMinutes < 1) {
        throw new HttpException(
          { success: false, message: 'intervalMinutes must be at least 1', error: 'INVALID_INTERVAL' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const agent = await this.schedulerService.scheduleAgent(
        id,
        organizationId,
        body.intervalMinutes,
        body.input || {},
      );

      return {
        success: true,
        data: agent,
        message: `Agent scheduled to run every ${body.intervalMinutes} minute(s)`,
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'SCHEDULE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Delete(':id/schedule')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Remove agent schedule' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent unscheduled successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async unscheduleAgent(
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

      const agent = await this.schedulerService.unscheduleAgent(id, organizationId);

      return {
        success: true,
        data: agent,
        message: 'Agent schedule removed',
      };
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'UNSCHEDULE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ── Heartbeat ──

  @Patch(':id/heartbeat')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Enable/disable agent heartbeat (periodic wake-up)' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Heartbeat configuration: enabled, intervalMinutes, prompt' })
  @ApiResponse({ status: 200, description: 'Agent heartbeat updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid heartbeat configuration' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async updateHeartbeat(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { enabled: boolean; intervalMinutes?: number; prompt?: string },
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

      if (body.enabled) {
        const intervalMinutes = body.intervalMinutes;
        if (!intervalMinutes || intervalMinutes < 1) {
          throw new HttpException(
            { success: false, message: 'intervalMinutes must be at least 1 when enabling heartbeat', error: 'INVALID_INTERVAL' },
            HttpStatus.BAD_REQUEST,
          );
        }
        if (!body.prompt || !body.prompt.trim()) {
          throw new HttpException(
            { success: false, message: 'prompt is required when enabling heartbeat', error: 'MISSING_PROMPT' },
            HttpStatus.BAD_REQUEST,
          );
        }

        const agent = await this.runtimeService.enableHeartbeat(id, organizationId, intervalMinutes, body.prompt);
        return {
          success: true,
          data: agent,
          message: `Heartbeat enabled: every ${intervalMinutes} minute(s)`,
        };
      } else {
        const agent = await this.runtimeService.disableHeartbeat(id, organizationId);
        return {
          success: true,
          data: agent,
          message: 'Heartbeat disabled',
        };
      }
    } catch (error) {
      throw new HttpException(
        {
          success: false,
          message: error.message,
          error: 'HEARTBEAT_UPDATE_FAILED',
        },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ── Autonomous Agent Runs ──

  @Post(':id/runs')
  @Roles('member', 'admin', 'owner')
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({ summary: 'Start a new autonomous agent run' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Run input and optional limits' })
  @ApiResponse({ status: 201, description: 'Run started, returns runId' })
  async startRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { input: any; maxSteps?: number; maxCostCents?: number; maxDurationMs?: number; conversationId?: string },
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
      const run = await this.runtimeService.startRun(id, organizationId, userId, body.input, {
        maxSteps: body.maxSteps,
        maxCostCents: body.maxCostCents,
        maxDurationMs: body.maxDurationMs,
        conversationId: body.conversationId,
      });

      return {
        success: true,
        data: run,
        message: 'Agent run started',
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUN_START_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':id/runs')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'List runs for an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async listRuns(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Request() req?: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.runtimeService.listRuns(
        id,
        organizationId,
        page ? Number(page) : 1,
        limit ? Number(limit) : 20,
      );

      return {
        success: true,
        data: result.data,
        pagination: { total: result.total, page: result.page, limit: result.limit, totalPages: result.totalPages },
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUNS_FETCH_FAILED' },
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':id/runs/:runId')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get run status and steps' })
  async getRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
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

      // Pass the :id path segment so the service asserts the run
      // actually belongs to this agent. Previously the :id was
      // decorative — any runId in the caller's org resolved through
      // any /agents/:id/runs/:runId URL.
      const run = await this.runtimeService.getRun(runId, organizationId, id);
      return { success: true, data: run };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUN_FETCH_FAILED' },
        error.status || HttpStatus.NOT_FOUND,
      );
    }
  }

  @Get(':id/runs/:runId/stream')
  @Roles('viewer', 'member', 'admin', 'owner')
  @ApiOperation({ summary: 'SSE stream of run progress' })
  async streamRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Request() req: any,
    @Res() res: Response,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId;
      if (!organizationId) {
        res.status(HttpStatus.BAD_REQUEST).json({ success: false, message: 'No organization found' });
        return;
      }

      // Verify run exists AND belongs to this agent path segment.
      await this.runtimeService.getRun(runId, organizationId, id);

      // Set SSE headers
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Stream events via Redis Streams (cross-pod)
      const abortController = new AbortController();
      req.on('close', () => abortController.abort());

      try {
        await this.runtimeService.subscribeRunEvents(
          runId,
          (event) => {
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          },
          abortController.signal,
        );
      } catch {
        // Stream ended or aborted
      }

      res.write(`event: done\ndata: {}\n\n`);
      if (!res.writableEnded) res.end();
    } catch (error) {
      if (!res.headersSent) {
        res.status(error.status || HttpStatus.BAD_REQUEST).json({ success: false, message: error.message });
      }
    }
  }

  @Post(':id/runs/:runId/input')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Send input to a waiting run (human-in-the-loop)' })
  async sendRunInput(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Body() body: { input: string },
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

      const run = await this.runtimeService.sendInput(runId, organizationId, body.input, id);
      return { success: true, data: run, message: 'Input sent to run' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUN_INPUT_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':id/runs/:runId/cancel')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Cancel a running run' })
  async cancelRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
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

      const run = await this.runtimeService.cancelRun(runId, organizationId, id);
      return { success: true, data: run, message: 'Run cancelled' };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'RUN_CANCEL_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
