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
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsObject, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { Response } from 'express';

import { AgentsService, AgentSearchFilters } from './agents.service';
import { AgentExecutionEngine, StreamEvent } from './agent-execution.engine';
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
  ) {}

  @Post()
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Create a new agent' })
  @ApiResponse({ status: 201, description: 'Agent created successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input data' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  async createAgent(
    @Body(ValidationPipe) createAgentDto: CreateAgentDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
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
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get all agents for organization' })
  @ApiResponse({ status: 200, description: 'Agents retrieved successfully' })
  async getAgents(
    @Query(ValidationPipe) query: AgentSearchQueryDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
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

  @Get(':id')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get agent by ID' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent retrieved successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async getAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
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
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Update agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent updated successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async updateAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) updateAgentDto: UpdateAgentDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      const agent = await this.agentsService.updateAgent(id, updateAgentDto, organizationId);

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
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Delete agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent deleted successfully' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async deleteAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
      if (!organizationId) {
        throw new HttpException(
          { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.agentsService.deleteAgent(id, organizationId);

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
  async activateAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
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
  async deactivateAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
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

  @Post(':id/invoke')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Invoke/execute an agent' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Agent executed successfully' })
  @ApiResponse({ status: 400, description: 'Agent not active or invalid input' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async invokeAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) invokeDto: InvokeAgentDto,
    @Request() req: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
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
  @ApiOperation({ summary: 'Stream agent execution via SSE' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'SSE stream of execution events' })
  @ApiResponse({ status: 400, description: 'Agent not active or invalid input' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async streamAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(ValidationPipe) invokeDto: InvokeAgentDto,
    @Request() req: any,
    @Res() res: Response,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
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

      const onEvent = (event: StreamEvent) => {
        const data = JSON.stringify(event);
        res.write(`event: ${event.type}\ndata: ${data}\n\n`);
      };

      const execution = await this.executionEngine.execute(
        agent,
        organizationId,
        userId,
        {
          input: invokeDto.input,
          variables: invokeDto.variables,
          metadata: invokeDto.metadata,
        },
        onEvent,
      );

      // Send final result
      res.write(`event: done\ndata: ${JSON.stringify({ executionId: execution.id, status: execution.status })}\n\n`);
      res.end();
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
        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
      }
    }
  }

  @Get(':id/executions')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Get agent execution history' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiResponse({ status: 200, description: 'Executions retrieved successfully' })
  async getAgentExecutions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Request() req?: any,
  ) {
    try {
      const organizationId = req.user.currentOrganizationId || req.user.organizations?.[0]?.id;
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
}
