import {
  Controller,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Request,
  ParseUUIDPipe,
  HttpStatus,
  HttpException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiBody, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';

import { AgentRuntimeService } from './agent-runtime.service';
import { AgentSchedulerService } from './agent-scheduler.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('agents')
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
export class AgentScheduleController {
  constructor(
    private readonly runtimeService: AgentRuntimeService,
    private readonly schedulerService: AgentSchedulerService,
  ) {}

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

        const agent = await this.schedulerService.scheduleAgent(id, organizationId, intervalMinutes, body.input || {});
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
        { success: false, message: error.message, error: 'SCHEDULE_UPDATE_FAILED' },
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

      const agent = await this.schedulerService.scheduleAgent(id, organizationId, body.intervalMinutes, body.input || {});
      return {
        success: true,
        data: agent,
        message: `Agent scheduled to run every ${body.intervalMinutes} minute(s)`,
      };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'SCHEDULE_FAILED' },
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
        { success: false, message: error.message, error: 'UNSCHEDULE_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

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
        { success: false, message: error.message, error: 'HEARTBEAT_UPDATE_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }
}
