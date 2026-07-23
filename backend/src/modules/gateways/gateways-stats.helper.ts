import { Injectable, Logger, NotFoundException, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoreThanOrEqual } from 'typeorm';
import { GatewayStats } from './gateways.service';

import { Gateway, GatewayKind, GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { Organization } from '../../entities/organization.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { GatewaysService } from './gateways.service';

@Injectable()
export class GatewaysStatsHelper {
  private readonly logger = new Logger(GatewaysStatsHelper.name);

  constructor(
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(UsageMetric)
    private usageMetricRepository: Repository<UsageMetric>,
    @Inject(forwardRef(() => GatewaysService))
    private readonly service: GatewaysService,
  ) {}

  async getGatewayStats(
    gatewayId: string,
    organizationId: string,
    timeframe: 'hour' | 'day' | 'week' | 'month' = 'day'
  ): Promise<GatewayStats> {
    const gateway = await this.service.getGateway(gatewayId, organizationId, true);

    const timeframeDurations = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    };

    const since = new Date(Date.now() - timeframeDurations[timeframe]);

    // Get usage metrics. Previously this used the MongoDB-style
    // `{ $gte: since }` operator, which TypeORM treats as a literal
    // object comparison and matches zero rows — so this method was
    // silently returning empty metrics for its entire life.
    // Same class of dead code as the `{$in: ...}` fix in
    // users.service.bulkUpdate and tool-executor.service.
    const metrics = await this.usageMetricRepository.find({
      where: {
        gatewayId: gateway.id,
        createdAt: MoreThanOrEqual(since),
      },
    });

    const requestMetrics = metrics.filter(m => m.type === 'request_count');
    const responseTimeMetrics = metrics.filter(m => m.type === 'response_time');
    
    const totalRequests = requestMetrics.reduce((sum, m) => sum + m.value, 0);
    const successfulRequests = requestMetrics.filter(m => m.status === 'success').reduce((sum, m) => sum + m.value, 0);
    const failedRequests = totalRequests - successfulRequests;
    const averageResponseTime = responseTimeMetrics.length > 0
      ? responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length
      : 0;
    const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;
    const activeTools = gateway.getActiveTools().length;
    const uniqueUsers = new Set(metrics.map(m => m.userId).filter(Boolean)).size;

    // Calculate trend data
    const requestTrend = this.calculateRequestTrend(metrics, timeframe);

    return {
      totalRequests,
      successfulRequests,
      failedRequests,
      averageResponseTime: Math.round(averageResponseTime),
      successRate: Math.round(successRate * 100) / 100,
      activeTools,
      uniqueUsers,
      requestTrend,
    };
  }

  async getOrganizationGatewayStats(organizationId: string): Promise<{
    totalGateways: number;
    activeGateways: number;
    inactiveGateways: number;
    totalRequests: number;
    averageResponseTime: number;
    successRate: number;
    topGateways: Array<{
      gateway: Gateway;
      requestCount: number;
    }>;
  }> {
    // Get gateway counts
    const gatewayCounts = await this.gatewayRepository
      .createQueryBuilder('gateway')
      .select('gateway.status')
      .addSelect('COUNT(*)', 'count')
      .where('gateway.organizationId = :organizationId', { organizationId })
      .groupBy('gateway.status')
      .getRawMany();

    const statusCounts: Record<string, number> = gatewayCounts.reduce((acc, row) => {
      acc[row.gateway_status] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    const totalGateways = Object.values(statusCounts).reduce((sum: number, count) => sum + (count as number), 0);

    // Get all gateways for organization
    const gateways = await this.gatewayRepository.find({
      where: { organizationId },
    });

    const totalRequests = gateways.reduce((sum, g) => sum + g.totalRequests, 0);
    const successfulRequests = gateways.reduce((sum, g) => sum + g.successfulRequests, 0);
    const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;

    // Get usage metrics for average response time
    const metrics = await this.usageMetricRepository.find({
      where: { organizationId },
    });

    const responseTimeMetrics = metrics.filter(m => m.type === 'response_time');
    const averageResponseTime = responseTimeMetrics.length > 0
      ? responseTimeMetrics.reduce((sum, m) => sum + m.value, 0) / responseTimeMetrics.length
      : 0;

    // Get top gateways by request count
    const topGateways = gateways
      .sort((a, b) => b.totalRequests - a.totalRequests)
      .slice(0, 10)
      .map(gateway => ({
        gateway,
        requestCount: gateway.totalRequests,
      }));

    return {
      totalGateways,
      activeGateways: statusCounts[GatewayStatus.ACTIVE] || 0,
      inactiveGateways: statusCounts[GatewayStatus.INACTIVE] || 0,
      totalRequests,
      averageResponseTime: Math.round(averageResponseTime),
      successRate: Math.round(successRate * 100) / 100,
      topGateways,
    };
  }

  async performHealthCheck(gatewayId: string, organizationId: string): Promise<{
    isHealthy: boolean;
    responseTime?: number;
    error?: string;
    details?: Record<string, any>;
  }> {
    const gateway = await this.service.getGateway(gatewayId, organizationId, false);

    if (!gateway.healthCheck?.enabled) {
      return { isHealthy: true };
    }

    const startTime = Date.now();

    try {
      // Perform health check based on gateway type
      const healthResult = await this.performTypeSpecificHealthCheck(gateway);
      const responseTime = Date.now() - startTime;

      // Update gateway health status
      gateway.updateHealthStatus(healthResult.isHealthy);
      await this.gatewayRepository.save(gateway);

      return {
        ...healthResult,
        responseTime,
      };

    } catch (error) {
      const responseTime = Date.now() - startTime;
      
      gateway.updateHealthStatus(false);
      await this.gatewayRepository.save(gateway);

      return {
        isHealthy: false,
        responseTime,
        error: error.message,
      };
    }
  }

  async searchSkillsAcrossGateways(organizationId: string, query: string): Promise<Array<{
    toolId: string;
    toolName: string;
    toolDescription: string;
    gatewayId: string;
    gatewayName: string;
    orgSlug: string;
    gatewaySlug: string;
    skillRef: string;
  }>> {
    const organization = await this.organizationRepository.findOne({
      where: { id: organizationId },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const orgSlug = organization.slug || organization.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    const gateways = await this.gatewayRepository.find({
      where: { organizationId, status: GatewayStatus.ACTIVE },
      relations: { tools: { tool: true } },
    });

    const results: Array<{
      toolId: string;
      toolName: string;
      toolDescription: string;
      gatewayId: string;
      gatewayName: string;
      orgSlug: string;
      gatewaySlug: string;
      skillRef: string;
    }> = [];

    const searchLower = query.toLowerCase();

    for (const gateway of gateways) {
      const gatewaySlug = gateway.endpoint?.replace(/^\//, '') || gateway.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const activeTools = gateway.tools?.filter(gt => gt.isActive && gt.tool) || [];

      for (const gt of activeTools) {
        const tool = gt.tool;
        const nameMatch = tool.name?.toLowerCase().includes(searchLower);
        const descMatch = tool.description?.toLowerCase().includes(searchLower);

        if (nameMatch || descMatch) {
          const toolSlug = tool.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          results.push({
            toolId: tool.id,
            toolName: tool.name,
            toolDescription: tool.description || '',
            gatewayId: gateway.id,
            gatewayName: gateway.name,
            orgSlug,
            gatewaySlug,
            skillRef: `${orgSlug}/${gatewaySlug}/${toolSlug}`,
          });
        }
      }
    }

    return results;
  }


  async performTypeSpecificHealthCheck(gateway: Gateway): Promise<{
    isHealthy: boolean;
    details?: Record<string, any>;
  }> {
    // Basic health check - can be extended for specific gateway types
    const activeTools = gateway.getActiveTools();
    const hasActiveTools = activeTools.length > 0;

    return {
      isHealthy: hasActiveTools && gateway.canAcceptRequests(),
      details: {
        activeToolsCount: activeTools.length,
        status: gateway.status,
        canAcceptRequests: gateway.canAcceptRequests(),
      },
    };
  }

  calculateRequestTrend(
    metrics: UsageMetric[],
    timeframe: 'hour' | 'day' | 'week' | 'month'
  ): Array<{ date: string; requests: number; success: number; failed: number }> {
    const intervals = {
      hour: 24,  // Last 24 hours
      day: 30,   // Last 30 days
      week: 12,  // Last 12 weeks
      month: 12, // Last 12 months
    };

    const interval = intervals[timeframe];
    const trend: Array<{ date: string; requests: number; success: number; failed: number }> = [];

    for (let i = interval - 1; i >= 0; i--) {
      let date: Date;
      let dateKey: string;

      switch (timeframe) {
        case 'hour':
          date = new Date(Date.now() - i * 60 * 60 * 1000);
          dateKey = date.toISOString().slice(0, 13) + ':00:00Z';
          break;
        case 'day':
          date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
          dateKey = date.toISOString().slice(0, 10);
          break;
        case 'week':
          date = new Date(Date.now() - i * 7 * 24 * 60 * 60 * 1000);
          dateKey = `${date.getFullYear()}-W${this.getWeekNumber(date)}`;
          break;
        case 'month':
          date = new Date(Date.now() - i * 30 * 24 * 60 * 60 * 1000);
          dateKey = date.toISOString().slice(0, 7);
          break;
      }

      const periodMetrics = metrics.filter(m => {
        const metricDate = new Date(m.createdAt);
        switch (timeframe) {
          case 'hour':
            return metricDate.getHours() === date.getHours() &&
                   metricDate.toDateString() === date.toDateString();
          case 'day':
            return metricDate.toDateString() === date.toDateString();
          case 'week':
            return this.getWeekNumber(metricDate) === this.getWeekNumber(date) &&
                   metricDate.getFullYear() === date.getFullYear();
          case 'month':
            return metricDate.getMonth() === date.getMonth() &&
                   metricDate.getFullYear() === date.getFullYear();
          default:
            return false;
        }
      });

      const requestMetrics = periodMetrics.filter(m => m.type === 'request_count');
      const requests = requestMetrics.reduce((sum, m) => sum + m.value, 0);
      const success = requestMetrics.filter(m => m.status === 'success').reduce((sum, m) => sum + m.value, 0);
      const failed = requests - success;

      trend.push({
        date: dateKey,
        requests,
        success,
        failed,
      });
    }

    return trend;
  }

  getWeekNumber(date: Date): number {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    return Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
  }

  async getAllUserGateways(organizationId: string): Promise<Gateway[]> {
    return this.gatewayRepository.find({
      where: { organizationId, status: GatewayStatus.ACTIVE },
      relations: { tools: { tool: true }, organization: true },
    });
  }

}
