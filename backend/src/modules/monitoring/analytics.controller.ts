import {
  Controller,
  Get,
  Query,
  Request,
  Res,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
@UseGuards(JwtAuthGuard)
export class AnalyticsController {
  private readonly logger = new Logger(AnalyticsController.name);

  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('/overview')
  async getOverview(@Request() req) {
    const orgId = req.user?.currentOrganizationId;
    const data = await this.analyticsService.getOverview(orgId);
    return { success: true, data, message: 'Analytics overview retrieved successfully' };
  }

  @Get('/requests')
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
    const orgId = req.user?.currentOrganizationId;
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
  async getToolUsage(
    @Request() req,
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const orgId = req.user?.currentOrganizationId;
    const data = await this.analyticsService.getToolUsage(orgId, timeframe);
    return { success: true, data, message: 'Tool usage retrieved successfully' };
  }

  @Get('/gateway-usage')
  async getGatewayUsage(
    @Request() req,
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const orgId = req.user?.currentOrganizationId;
    const data = await this.analyticsService.getGatewayUsage(orgId, timeframe);
    return { success: true, data, message: 'Gateway usage retrieved successfully' };
  }

  @Get('/llm-usage')
  async getLlmUsage(
    @Request() req,
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const orgId = req.user?.currentOrganizationId;
    const data = await this.analyticsService.getLlmUsage(orgId, timeframe);
    return { success: true, data, message: 'LLM usage retrieved successfully' };
  }

  @Get('/timeline')
  async getTimeline(
    @Request() req,
    @Query('timeframe') timeframe: string = '24h',
    @Query('granularity') granularity: string = 'hour',
  ) {
    const orgId = req.user?.currentOrganizationId;
    const data = await this.analyticsService.getTimeline(orgId, timeframe, granularity);
    return { success: true, data, message: 'Timeline data retrieved successfully' };
  }

  @Get('/audit-summary')
  async getAuditSummary(@Request() req) {
    const orgId = req.user?.currentOrganizationId;
    const data = await this.analyticsService.getAuditSummary(orgId);
    return { success: true, data, message: 'Audit summary retrieved successfully' };
  }

  @Get('/agent-runs')
  async getAgentRuns(@Request() req) {
    const orgId = req.user?.currentOrganizationId;
    const data = await this.analyticsService.getAgentRunsSummary(orgId);
    return { success: true, data, message: 'Agent runs summary retrieved successfully' };
  }

  @Get('/export')
  async exportLogs(
    @Request() req,
    @Res() res: Response,
    @Query('format') format: string = 'json',
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('type') type: string = 'requests',
  ) {
    const orgId = req.user?.currentOrganizationId;
    const data = await this.analyticsService.exportData({
      organizationId: orgId,
      format: format as 'json' | 'csv',
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      type: type as 'requests' | 'tool-executions' | 'llm-sessions',
    });

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${type}-${new Date().toISOString().split('T')[0]}.csv"`);
      return res.send(data);
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${type}-${new Date().toISOString().split('T')[0]}.json"`);
    return res.send(JSON.stringify(data, null, 2));
  }
}
