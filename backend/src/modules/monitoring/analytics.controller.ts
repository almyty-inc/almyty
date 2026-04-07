import {
  Controller,
  Get,
  Query,
  Request,
  Res,
  UseGuards,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics endpoints. Every handler below resolves the org from
 * `req.user.currentOrganizationId` (set by JwtStrategy from the
 * `X-Organization-Id` header for multi-org users). We refuse the
 * request when that's undefined — previously we passed `undefined`
 * straight through to the service layer, which then returned data
 * from whichever orgs matched (or, in the broken `getRequestLogs`
 * path, every org in the database).
 *
 * RolesGuard was added to gate analytics on explicit member+ role.
 * Previously the controller only had JwtAuthGuard, so any
 * authenticated user — even one without explicit org membership —
 * could call /analytics/*.
 */
@Controller('analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  private requireOrg(req: any): string {
    const orgId = req.user?.currentOrganizationId;
    if (!orgId) {
      throw new HttpException(
        {
          success: false,
          message:
            'Organization context required. Multi-org users must send the X-Organization-Id header.',
          error: 'NO_ORGANIZATION',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
    return orgId;
  }

  @Get('/overview')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getOverview(@Request() req) {
    const orgId = this.requireOrg(req);
    const data = await this.analyticsService.getOverview(orgId);
    return { success: true, data, message: 'Analytics overview retrieved successfully' };
  }

  @Get('/requests')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getRequestLogs(
    @Request() req,
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '50',
    @Query('gatewayId') gatewayId?: string,
    @Query('toolId') toolId?: string,
    @Query('protocol') protocol?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const orgId = this.requireOrg(req);
    const data = await this.analyticsService.getRequestLogs({
      organizationId: orgId,
      page: parseInt(page, 10),
      limit: Math.min(parseInt(limit, 10), 100),
      gatewayId,
      toolId,
      protocol,
      statusFilter: status,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
    return { success: true, data, message: 'Request logs retrieved successfully' };
  }

  @Get('/tool-usage')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getToolUsage(
    @Request() req,
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const orgId = this.requireOrg(req);
    const data = await this.analyticsService.getToolUsage(orgId, timeframe);
    return { success: true, data, message: 'Tool usage retrieved successfully' };
  }

  @Get('/gateway-usage')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getGatewayUsage(
    @Request() req,
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const orgId = this.requireOrg(req);
    const data = await this.analyticsService.getGatewayUsage(orgId, timeframe);
    return { success: true, data, message: 'Gateway usage retrieved successfully' };
  }

  @Get('/llm-usage')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getLlmUsage(
    @Request() req,
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const orgId = this.requireOrg(req);
    const data = await this.analyticsService.getLlmUsage(orgId, timeframe);
    return { success: true, data, message: 'LLM usage retrieved successfully' };
  }

  @Get('/timeline')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getTimeline(
    @Request() req,
    @Query('timeframe') timeframe: string = '24h',
    @Query('granularity') granularity: string = 'hour',
  ) {
    const orgId = this.requireOrg(req);
    const data = await this.analyticsService.getTimeline(orgId, timeframe, granularity);
    return { success: true, data, message: 'Timeline data retrieved successfully' };
  }

  @Get('/audit-summary')
  @Roles('admin', 'owner')
  async getAuditSummary(@Request() req) {
    const orgId = this.requireOrg(req);
    const data = await this.analyticsService.getAuditSummary(orgId);
    return { success: true, data, message: 'Audit summary retrieved successfully' };
  }

  @Get('/agent-runs')
  @Roles('viewer', 'member', 'admin', 'owner')
  async getAgentRuns(@Request() req) {
    const orgId = this.requireOrg(req);
    const data = await this.analyticsService.getAgentRunsSummary(orgId);
    return { success: true, data, message: 'Agent runs summary retrieved successfully' };
  }

  @Get('/export')
  @Roles('admin', 'owner')
  async exportLogs(
    @Request() req,
    @Res() res: Response,
    @Query('format') format: string = 'json',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('type') type: string = 'requests',
  ) {
    const orgId = this.requireOrg(req);
    const data = await this.analyticsService.exportData({
      organizationId: orgId,
      format: format as 'json' | 'csv',
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      type: type as 'requests' | 'tool-executions' | 'llm-sessions',
    });

    // Sanitize filename components before interpolating into the
    // Content-Disposition header. Same class of bug as the files
    // controller — if `type` contained `"` or CR/LF, an attacker
    // could inject additional headers. `type` comes from a query
    // string so it's user-controlled.
    const safeType = String(type).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 64);
    const dateStr = new Date().toISOString().split('T')[0];

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${safeType}-${dateStr}.csv"`);
      return res.send(data);
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${safeType}-${dateStr}.json"`);
    return res.send(JSON.stringify(data, null, 2));
  }
}
