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
    return this.analyticsService.getOverview(orgId);
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
    return this.analyticsService.getRequestLogs({
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
  }

  @Get('/tool-usage')
  async getToolUsage(
    @Request() req,
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const orgId = req.user?.currentOrganizationId;
    return this.analyticsService.getToolUsage(orgId, timeframe);
  }

  @Get('/gateway-usage')
  async getGatewayUsage(
    @Request() req,
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const orgId = req.user?.currentOrganizationId;
    return this.analyticsService.getGatewayUsage(orgId, timeframe);
  }

  @Get('/llm-usage')
  async getLlmUsage(
    @Request() req,
    @Query('timeframe') timeframe: string = '7d',
  ) {
    const orgId = req.user?.currentOrganizationId;
    return this.analyticsService.getLlmUsage(orgId, timeframe);
  }

  @Get('/timeline')
  async getTimeline(
    @Request() req,
    @Query('timeframe') timeframe: string = '24h',
    @Query('granularity') granularity: string = 'hour',
  ) {
    const orgId = req.user?.currentOrganizationId;
    return this.analyticsService.getTimeline(orgId, timeframe, granularity);
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
