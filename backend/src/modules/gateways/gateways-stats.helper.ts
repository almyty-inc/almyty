import { Injectable, Logger, NotFoundException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { MoreThanOrEqual } from 'typeorm';
import { GatewayStats } from './gateways.service';

import { Gateway, GatewayStatus } from '../../entities/gateway.entity';
import { Organization } from '../../entities/organization.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { GatewaysService } from './gateways.service';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

/**
 * How many metric rows one gateway's stats will look at.
 *
 * Enough to be representative of a window, small enough that a busy
 * gateway cannot take the pod down by having its detail page opened.
 */
const METRIC_SAMPLE_LIMIT = 50_000;

/**
 * How many skill matches one search will answer with.
 *
 * The search runs over every tool in the organization; a Stripe-class
 * import is thousands of them and a one-letter query matches most.
 */
const SKILL_SEARCH_LIMIT = 200;

/**
 * A `gateway` alias row the caller may see: anything not private, or a
 * private gateway of their own. Binds `:callerId`.
 */
const PRIVATE_GATEWAY_CLAUSE =
  `(gateway.visibility <> 'private' OR gateway."ownerUserId" = :callerId)`;

/** The slug form used for org, gateway and tool segments of a skillRef. */
function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

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
    private readonly accessPolicy: AccessPolicyService,
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
    // Windowed, and bounded. At two metric rows per HTTP request a busy
    // gateway writes ~1.7M rows for a `day` window and ~50M for `month`,
    // all of which were loaded and then filtered in JS -- on the query
    // the gateway detail page runs on every visit.
    const metrics = await this.usageMetricRepository.find({
      where: {
        gatewayId: gateway.id,
        createdAt: MoreThanOrEqual(since),
      },
      select: { id: true, type: true, value: true, status: true, userId: true, createdAt: true },
      order: { createdAt: 'DESC' },
      take: METRIC_SAMPLE_LIMIT,
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

  async getOrganizationGatewayStats(organizationId: string, callerId: string): Promise<{
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
    // Only the gateways this caller may see are part of their numbers, by
    // the rule the gateway list applies: another member's private gateway
    // and another team's gateway are not counted -- a number that moves
    // when someone else adds one is a way to learn that it exists.
    const caller = { id: callerId };
    const countQuery = this.gatewayRepository
      .createQueryBuilder('gateway')
      .select('gateway.status')
      .addSelect('COUNT(*)', 'count')
      .where('gateway.organizationId = :organizationId', { organizationId });
    await this.accessPolicy.applyListFilter(countQuery, caller, organizationId, 'gateway', { ownerColumn: 'ownerUserId' });
    const gatewayCounts = await countQuery.groupBy('gateway.status').getRawMany();

    const statusCounts: Record<string, number> = gatewayCounts.reduce((acc, row) => {
      acc[row.gateway_status] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    const totalGateways = Object.values(statusCounts).reduce((sum: number, count) => sum + (count as number), 0);

    // The same gateways, for the request totals and the top ten.
    const gateways = await this.gatewayRepository.find({
      where: await this.accessPolicy.visibleWhere<Gateway>(caller, organizationId, {}, { ownerColumn: 'ownerUserId' }),
    });

    const totalRequests = gateways.reduce((sum, g) => sum + g.totalRequests, 0);
    const successfulRequests = gateways.reduce((sum, g) => sum + g.successfulRequests, 0);
    const successRate = totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0;

    // One average, computed by the database, over the response times of
    // those gateways only. The org's other response_time rows carry the
    // latency of gateways the caller cannot see and of non-gateway
    // requests; a figure that moves with their traffic is another leak.
    const gatewayIds = gateways.map((g) => g.id);
    const { avg } = gatewayIds.length === 0
      ? { avg: null }
      : (await this.usageMetricRepository
          .createQueryBuilder('metric')
          .select('AVG(metric.value)', 'avg')
          .where('metric.organizationId = :organizationId', { organizationId })
          .andWhere('metric.type = :type', { type: 'response_time' })
          .andWhere('metric.gatewayId IN (:...gatewayIds)', { gatewayIds })
          .getRawOne<{ avg: string | null }>()) ?? { avg: null };
    const averageResponseTime = avg ? Number(avg) : 0;

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

  async searchSkillsAcrossGateways(organizationId: string, query: string, callerId: string): Promise<Array<{
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

    const orgSlug = organization.slug || slugify(organization.name);

    // Match in SQL, and bound the answer.
    //
    // This loaded every active gateway with `relations: { tools: { tool:
    // true } }` -- every Tool entity in the organization, `code`,
    // `parameters` and `examples` included -- and then did
    // `toLowerCase().includes()` over them in JS. One ILIKE over the two
    // columns actually being matched does the same thing on the index
    // side of the wire, and returns only the columns the result shape
    // needs.
    const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);

    const rows = await this.gatewayRepository
      .createQueryBuilder('gateway')
      .innerJoin('gateway.tools', 'gatewayTool')
      .innerJoin('gatewayTool.tool', 'tool')
      .select('gateway.id', 'gatewayId')
      .addSelect('gateway.name', 'gatewayName')
      .addSelect('gateway.endpoint', 'gatewayEndpoint')
      .addSelect('tool.id', 'toolId')
      .addSelect('tool.name', 'toolName')
      .addSelect('tool.description', 'toolDescription')
      .where('gateway.organizationId = :organizationId', { organizationId })
      .andWhere('gateway.status = :status', { status: GatewayStatus.ACTIVE })
      .andWhere('gatewayTool.isActive = true')
      // Another user's private gateway is not searched, and neither is
      // another user's private tool sitting behind a shared one.
      .andWhere(PRIVATE_GATEWAY_CLAUSE, { callerId })
      .andWhere(`(tool.visibility <> 'private' OR tool."createdBy" = :callerId)`, { callerId })
      .andWhere('(tool.name ILIKE :q OR tool.description ILIKE :q)', { q: `%${escaped}%` })
      .orderBy('gateway.name', 'ASC')
      .addOrderBy('tool.name', 'ASC')
      .limit(SKILL_SEARCH_LIMIT)
      .getRawMany<{
        gatewayId: string;
        gatewayName: string;
        gatewayEndpoint: string | null;
        toolId: string;
        toolName: string;
        toolDescription: string | null;
      }>();

    return rows.map((row) => {
      const gatewaySlug = row.gatewayEndpoint?.replace(/^\//, '') || slugify(row.gatewayName);
      const toolSlug = slugify(row.toolName);
      return {
        toolId: row.toolId,
        toolName: row.toolName,
        toolDescription: row.toolDescription || '',
        gatewayId: row.gatewayId,
        gatewayName: row.gatewayName,
        orgSlug,
        gatewaySlug,
        skillRef: `${orgSlug}/${gatewaySlug}/${toolSlug}`,
      };
    });
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

  /**
   * The bucket a timestamp falls in, for a given timeframe.
   *
   * Same grouping the per-bucket `filter` used to express inline: local
   * date + hour, local date, ISO-ish year + week number, or year + month.
   */
  private trendBucketKey(d: Date, timeframe: 'hour' | 'day' | 'week' | 'month'): string {
    switch (timeframe) {
      case 'hour':
        return `${d.toDateString()}#${d.getHours()}`;
      case 'day':
        return d.toDateString();
      case 'week':
        return `${d.getFullYear()}#W${this.getWeekNumber(d)}`;
      case 'month':
        return `${d.getFullYear()}#${d.getMonth()}`;
    }
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

    // One pass over the rows, bucketed by key. This used to re-scan the
    // whole array once per bucket: a `day` timeframe against the 50,000-row
    // cap meant 30 x 50,000 Date constructions and toDateString() calls per
    // page view, synchronous, on the event loop.
    const buckets = new Map<string, { requests: number; success: number }>();
    for (const m of metrics) {
      if (m.type !== 'request_count') continue;
      const key = this.trendBucketKey(new Date(m.createdAt), timeframe);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { requests: 0, success: 0 };
        buckets.set(key, bucket);
      }
      bucket.requests += m.value;
      if (m.status === 'success') bucket.success += m.value;
    }

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

      const bucket = buckets.get(this.trendBucketKey(date, timeframe));
      const requests = bucket?.requests ?? 0;
      const success = bucket?.success ?? 0;

      trend.push({
        date: dateKey,
        requests,
        success,
        failed: requests - success,
      });
    }

    return trend;
  }

  getWeekNumber(date: Date): number {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    return Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
  }

  /**
   * Every active gateway of an organization, with the organization.
   *
   * Without its tools: this carried `relations: { tools: { tool: true } }`
   * and neither caller ever read them. `gateway-info`'s all-skills route
   * uses id/name/endpoint and `gateway.organization`, then asks the skill
   * generator, which loads the tools it needs itself; `gateway-skills`
   * used the list for `gateways[0]?.organization` alone and now asks for
   * the organization directly.
   */
  async getAllUserGateways(organizationId: string, callerId: string): Promise<Gateway[]> {
    return this.gatewayRepository.find({
      where: [
        { organizationId, status: GatewayStatus.ACTIVE, visibility: Not('private') },
        // Private gateways: the caller's own only.
        { organizationId, status: GatewayStatus.ACTIVE, visibility: 'private', ownerUserId: callerId },
      ],
      relations: { organization: true },
    });
  }

  /**
   * The organization a skillRef's `orgSlug` segment comes from.
   *
   * Its own lookup because the caller used to reach it through
   * `getAllUserGateways(...)[0].organization` -- every active gateway,
   * every tool on each, to read one row that a primary-key lookup
   * answers. It also stops the slug depending on whether the org happens
   * to have an active gateway.
   */
  async getSkillContextOrganization(organizationId: string): Promise<Organization | null> {
    return this.organizationRepository.findOne({ where: { id: organizationId } });
  }

}
