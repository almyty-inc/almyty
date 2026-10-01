import {
  Controller,
  Get,
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
import { AgentSchedulerService, ScheduleRequest } from './agent-scheduler.service';
import { AgentsService } from './agents.service';
import { describeTiming, timingOf } from './agent-schedule-spec';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrivateAgentGuard } from '../../common/authorization/private-resource.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/** The body the schedule endpoints take: the timing, the input, and where the result goes. */
type ScheduleBody = ScheduleRequest & { enabled?: boolean };

/**
 * A schedule request as the scheduler reads it. A body with no `kind` is
 * the original "every N minutes" shape, and keeps its original check.
 */
function scheduleRequestOf(body: ScheduleBody): ScheduleRequest {
  const kind = body?.kind ?? 'interval';
  if (kind === 'interval' && (!body?.intervalMinutes || body.intervalMinutes < 1)) {
    throw new HttpException(
      { success: false, message: 'intervalMinutes must be at least 1', error: 'INVALID_INTERVAL' },
      HttpStatus.BAD_REQUEST,
    );
  }
  return {
    kind,
    intervalMinutes: body.intervalMinutes,
    time: body.time,
    days: body.days,
    dayOfMonth: body.dayOfMonth,
    timezone: body.timezone,
    input: body.input || {},
    deliverTo: body.deliverTo ?? null,
  };
}

/** "Agent scheduled: Every weekday at 8:00, Europe/Berlin". */
function scheduledMessage(agent: any): string {
  try {
    return `Agent scheduled: ${describeTiming(timingOf(agent?.settings?.schedule))}`;
  } catch {
    return 'Agent scheduled';
  }
}

@Controller('agents')
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PrivateAgentGuard)
export class AgentScheduleController {
  constructor(
    private readonly runtimeService: AgentRuntimeService,
    private readonly schedulerService: AgentSchedulerService,
    private readonly agentsService: AgentsService,
  ) {}

  private organizationOf(req: any): string {
    const organizationId = req.user.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException(
        { success: false, message: 'No organization found', error: 'NO_ORGANIZATION' },
        HttpStatus.BAD_REQUEST,
      );
    }
    return organizationId;
  }

  @Get(':id/schedule')
  @ApiOperation({ summary: "The agent's schedule, in plain words, with its next run" })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async getSchedule(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const agent = await this.agentsService.getAgent(id, this.organizationOf(req));
      return { success: true, data: await this.schedulerService.describeSchedule(agent) };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'SCHEDULE_READ_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post(':id/schedule/preview')
  @ApiOperation({ summary: 'Describe a schedule and its next runs without saving it' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async previewSchedule(@Param('id', ParseUUIDPipe) id: string, @Body() body: ScheduleBody, @Request() req: any) {
    try {
      // Read for the same access check every schedule call makes.
      await this.agentsService.getAgent(id, this.organizationOf(req));
      return { success: true, data: await this.schedulerService.previewSchedule(scheduleRequestOf(body), req.user?.id) };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'SCHEDULE_PREVIEW_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get(':id/schedule/destinations')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: "Where a scheduled result can be sent: the agent's webhook and its channels" })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async destinations(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      return { success: true, data: await this.schedulerService.deliveryOptions(id, this.organizationOf(req)) };
    } catch (error) {
      throw new HttpException(
        { success: false, message: error.message, error: 'SCHEDULE_DESTINATIONS_FAILED' },
        error.status || HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Patch(':id/schedule')
  @Roles('admin', 'owner')
  @ApiOperation({ summary: 'Enable/disable agent schedule and update its timing' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({
    description:
      'enabled; kind (interval | days | monthly); intervalMinutes, or time + days/dayOfMonth + timezone; optional input and deliverTo',
  })
  @ApiResponse({ status: 200, description: 'Agent schedule updated successfully' })
  @ApiResponse({ status: 400, description: 'Invalid schedule configuration' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async updateSchedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ScheduleBody,
    @Request() req: any,
  ) {
    try {
      const organizationId = this.organizationOf(req);

      if (body.enabled) {
        const request = scheduleRequestOf(body);
        const agent = await this.schedulerService.scheduleAgent(id, organizationId, request, request.input, req.user?.id);
        return {
          success: true,
          data: agent,
          message: scheduledMessage(agent),
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
  @ApiBody({
    description:
      'kind (interval | days | monthly); intervalMinutes, or time + days/dayOfMonth + timezone; optional input and deliverTo',
  })
  @ApiResponse({ status: 200, description: 'Agent scheduled successfully' })
  @ApiResponse({ status: 400, description: 'Invalid schedule configuration' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  async scheduleAgent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ScheduleBody,
    @Request() req: any,
  ) {
    try {
      const organizationId = this.organizationOf(req);
      const request = scheduleRequestOf(body);
      const agent = await this.schedulerService.scheduleAgent(id, organizationId, request, request.input, req.user?.id);
      return {
        success: true,
        data: agent,
        message: scheduledMessage(agent),
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
      const organizationId = this.organizationOf(req);

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
