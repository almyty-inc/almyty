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
  Res,
  ParseUUIDPipe,
  ValidationPipe,
  HttpStatus,
  HttpException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBearerAuth, ApiBody } from '@nestjs/swagger';
import { IsEnum, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Response } from 'express';

import { AgentsService } from './agents.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentSchedulerService } from './agent-scheduler.service';
import { AgentAuditService } from './agent-audit.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('agents')
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentManagementController {
  private readonly logger = new Logger(AgentManagementController.name);

  constructor(
    private readonly agentsService: AgentsService,
    private readonly runtimeService: AgentRuntimeService,
    private readonly schedulerService: AgentSchedulerService,
    private readonly auditService: AgentAuditService,
  ) {}

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
}
