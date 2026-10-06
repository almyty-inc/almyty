import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { PrivateAgentGuard } from '../../../common/authorization/private-resource.guard';
import { AgentsService } from '../agents.service';
import { AlwaysOnService } from './always-on.service';
import type { AlwaysOnInput } from './always-on.types';

/**
 * Always on (docs/always-on.md): read and change an agent's settings, see
 * what woke it, and wake it now. The standing thread and pauses are the
 * system's; a request can set everything else.
 */
@Controller('agents')
@ApiTags('Agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PrivateAgentGuard)
export class AlwaysOnController {
  constructor(
    private readonly alwaysOn: AlwaysOnService,
    private readonly agentsService: AgentsService,
  ) {}

  private organizationOf(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  private fail(error: any, code: string): never {
    throw new HttpException(
      { success: false, message: error?.response?.message ?? error?.message ?? 'Something went wrong', error: code },
      error?.status || HttpStatus.BAD_REQUEST,
    );
  }

  @Get(':id/always-on')
  @ApiOperation({ summary: "The agent's Always on settings, what its plan allows, its last wake and next timer" })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async get(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      const [view, tools] = await Promise.all([
        this.alwaysOn.view(id, organizationId),
        this.alwaysOn.suggestedAskFirst(id, organizationId),
      ]);
      return { success: true, data: { ...view, tools } };
    } catch (error) {
      this.fail(error, 'ALWAYS_ON_READ_FAILED');
    }
  }

  @Patch(':id/always-on')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Change Always on: on or off, what it keeps doing, what wakes it, what it asks first, where it reports' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  @ApiBody({ description: 'Any of: enabled, brief, wakeOn, ownerChannel, actMode, askFirstToolIds, reportTo, report, maxWakesPerHour' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: AlwaysOnInput, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      const view = await this.alwaysOn.configure(id, organizationId, body ?? {}, req.user?.id ?? null);
      return { success: true, data: view, message: view.alwaysOn?.enabled ? 'Always on is on' : 'Always on is off' };
    } catch (error) {
      this.fail(error, 'ALWAYS_ON_UPDATE_FAILED');
    }
  }

  @Post(':id/always-on/wake')
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Wake the agent now' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async wakeNow(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      const wake = await this.alwaysOn.wakeNow(id, organizationId, req.user?.id ?? null);
      return { success: true, data: wake, message: 'It will wake in a moment' };
    } catch (error) {
      this.fail(error, 'ALWAYS_ON_WAKE_FAILED');
    }
  }

  @Get(':id/always-on/wakes')
  @ApiOperation({ summary: 'What woke the agent recently, newest first' })
  @ApiParam({ name: 'id', description: 'Agent ID' })
  async wakes(@Param('id', ParseUUIDPipe) id: string, @Query('limit') limit: string | undefined, @Request() req: any) {
    try {
      const organizationId = this.organizationOf(req);
      await this.agentsService.getAgent(id, organizationId);
      const rows = await this.alwaysOn.recentWakes(id, organizationId, Number(limit) || 20);
      return {
        success: true,
        data: rows.map((w) => ({
          id: w.id,
          source: w.source,
          summary: w.summary,
          status: w.status,
          runId: w.runId,
          note: w.note,
          createdAt: w.createdAt,
          consumedAt: w.consumedAt,
        })),
      };
    } catch (error) {
      this.fail(error, 'ALWAYS_ON_WAKES_FAILED');
    }
  }
}
