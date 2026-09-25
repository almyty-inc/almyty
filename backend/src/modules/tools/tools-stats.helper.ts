import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository, SelectQueryBuilder } from 'typeorm';

import { Tool, ToolStatus } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';

export interface ToolUsageStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageExecutionTime: number;
  cacheHitRate: number;
  rateLimitedExecutions: number;
  uniqueUsers: number;
  executionTrend: Array<{ date: string; executions: number; success: number; failed: number }>;
}

/**
 * Stats / analytics queries lifted out of ToolsService:
 * per-tool usage rollup, org-wide totals, and the rolling
 * execution-trend computation. The whole class is a thin facade
 * over the tool + tool-execution repositories.
 */
/**
 * How many executions one tool's usage figures will look at.
 *
 * Mirrors METRIC_SAMPLE_LIMIT on the gateway side: enough to be
 * representative of a window, small enough that opening a busy tool's
 * detail page cannot take the pod down.
 */
const EXECUTION_SAMPLE_LIMIT = 50_000;

@Injectable()
export class ToolsStatsHelper {
  constructor(
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    @InjectRepository(ToolExecution)
    private readonly toolExecutionRepository: Repository<ToolExecution>,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  async getToolUsageStats(
    tool: Tool,
    organizationId: string,
    timeframe: 'hour' | 'day' | 'week' | 'month' = 'day',
  ): Promise<ToolUsageStats> {
    const timeframeDurations = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    };

    const since = new Date(Date.now() - timeframeDurations[timeframe]);

    // Only the columns these figures are computed from.
    //
    // This loaded `parameters` and `result` -- untruncated json, up to
    // 10MB apiece -- plus a whole User entity per row, to count
    // successes, average a duration, size a Set of user ids and bucket a
    // trend. The window is a caller-supplied param that goes up to a
    // month, so how much it loaded was chosen by whoever called it.
    const executions = await this.toolExecutionRepository.find({
      where: {
        toolId: tool.id,
        organizationId,
        createdAt: MoreThanOrEqual(since),
      },
      select: {
        id: true,
        success: true,
        executionTime: true,
        cached: true,
        userId: true,
        createdAt: true,
        metadata: true,
      },
      // And bounded. `timeframe` is caller-supplied up to a month, and
      // nothing else caps this table -- its retention window defaults to
      // keep-forever, like every sibling data class. One tool at 1 req/s
      // over a month is ~2.6M rows, reached by opening that tool's
      // detail page.
      order: { createdAt: 'DESC' },
      take: EXECUTION_SAMPLE_LIMIT,
    });

    const total = executions.length;
    const successful = executions.filter((e) => e.success).length;
    const failed = total - successful;
    const avgTime = total > 0 ? executions.reduce((sum, e) => sum + e.executionTime, 0) / total : 0;
    const cached = executions.filter((e) => e.cached).length;
    const cacheHitRate = total > 0 ? (cached / total) * 100 : 0;
    const rateLimited = executions.filter((e) => e.metadata?.rateLimited).length;
    const uniqueUsers = new Set(executions.map((e) => e.userId)).size;

    const trendData = this.calculateExecutionTrend(executions, timeframe);

    return {
      totalExecutions: total,
      successfulExecutions: successful,
      failedExecutions: failed,
      averageExecutionTime: Math.round(avgTime),
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      rateLimitedExecutions: rateLimited,
      uniqueUsers,
      executionTrend: trendData,
    };
  }

  async getOrganizationToolStats(organizationId: string, callerId?: string | null): Promise<{
    totalTools: number;
    activeTools: number;
    draftTools: number;
    inactiveTools: number;
    totalExecutions: number;
    averageExecutionTime: number;
    topUsedTools: Array<{ tool: Tool; executionCount: number }>;
  }> {
    // Only the tools this caller may see are part of their numbers: another
    // member's private tools and other teams' tools are not -- a count
    // that moves when someone else adds one is a leak.
    const countQuery = this.toolRepository
      .createQueryBuilder('tool')
      .select('tool.status')
      .addSelect('COUNT(*)', 'count')
      .where('tool.organizationId = :organizationId', { organizationId });
    await this.scopeToCaller(countQuery, 'tool', organizationId, callerId);
    const toolCounts = await countQuery.groupBy('tool.status').getRawMany();

    const statusCounts: Record<string, number> = toolCounts.reduce((acc, row) => {
      acc[row.tool_status] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    const totalTools = Object.values(statusCounts).reduce(
      (sum: number, count: number) => sum + count,
      0,
    );

    // Counted and averaged by the database, not in heap.
    //
    // This loaded every tool_executions row the organization had ever
    // written, with `relations: { tool: true }` dragging a full Tool
    // entity alongside each -- to produce a count, a mean and a top ten.
    // A ToolExecution carries `parameters` and `result` as untruncated
    // json, and the HTTP executor allows 10MB responses, so individual
    // rows can be megabytes. This is the rawSchema OOM verbatim.
    const visibleTools = await this.visibleToolIds(organizationId, callerId);
    const [totals, usageRows] = await Promise.all([
      this.toolExecutionRepository
        .createQueryBuilder('execution')
        .select('COUNT(*)', 'count')
        .addSelect('AVG(execution.executionTime)', 'avg')
        .where('execution.organizationId = :organizationId', { organizationId })
        .andWhere(`execution."toolId" IN (${visibleTools.getQuery()})`, visibleTools.getParameters())
        .getRawOne<{ count: string; avg: string | null }>(),
      this.toolExecutionRepository
        .createQueryBuilder('execution')
        .select('execution.toolId', 'toolId')
        .addSelect('COUNT(*)', 'count')
        .where('execution.organizationId = :organizationId', { organizationId })
        .andWhere(`execution."toolId" IN (${visibleTools.getQuery()})`, visibleTools.getParameters())
        .groupBy('execution.toolId')
        .orderBy('COUNT(*)', 'DESC')
        .limit(10)
        .getRawMany<{ toolId: string; count: string }>(),
    ]);

    const totalExecutions = Number(totals?.count ?? 0);
    const averageExecutionTime = totals?.avg ? Math.round(Number(totals.avg)) : 0;

    const toolUsage: Record<string, number> = Object.fromEntries(
      usageRows.map((row) => [row.toolId, Number(row.count)]),
    );
    const topToolIds = usageRows.map((row) => row.toolId);

    const topTools = await this.toolRepository.find({
      where: { id: In(topToolIds), organizationId },
    });

    const topUsedTools = topTools.map((tool) => ({
      tool,
      executionCount: toolUsage[tool.id] || 0,
    }));

    return {
      totalTools,
      activeTools: statusCounts[ToolStatus.ACTIVE] || 0,
      draftTools: statusCounts[ToolStatus.DRAFT] || 0,
      inactiveTools: statusCounts[ToolStatus.INACTIVE] || 0,
      totalExecutions,
      averageExecutionTime,
      topUsedTools,
    };
  }

  /**
   * The caller's view of the org's tools, the rule the tools list applies
   * (AccessPolicyService.applyListFilter): org-wide tools, their teams'
   * tools, their own private tools; an org admin every non-private tool.
   * With no caller, org-wide tools only.
   */
  private async scopeToCaller(
    qb: SelectQueryBuilder<Tool>,
    alias: string,
    organizationId: string,
    callerId: string | null | undefined,
  ): Promise<void> {
    if (callerId) {
      await this.accessPolicy.applyListFilter(qb, { id: callerId }, organizationId, alias, { ownerColumn: 'createdBy' });
    } else {
      qb.andWhere(`${alias}.visibility = 'org'`);
    }
  }

  /** A subquery of the ids of the tools scopeToCaller admits. */
  private async visibleToolIds(
    organizationId: string,
    callerId: string | null | undefined,
  ): Promise<SelectQueryBuilder<Tool>> {
    const sub = this.toolRepository
      .createQueryBuilder('visible_tool')
      .select('visible_tool.id')
      .where('visible_tool.organizationId = :visibleToolOrg', { visibleToolOrg: organizationId });
    await this.scopeToCaller(sub, 'visible_tool', organizationId, callerId);
    return sub;
  }

  /**
   * The bucket a timestamp falls in, for a given timeframe. Same grouping
   * the per-bucket `filter` used to express inline.
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

  private calculateExecutionTrend(
    executions: ToolExecution[],
    timeframe: 'hour' | 'day' | 'week' | 'month',
  ): Array<{ date: string; executions: number; success: number; failed: number }> {
    const intervals = { hour: 24, day: 30, week: 12, month: 12 };
    const interval = intervals[timeframe];
    const trend: Array<{ date: string; executions: number; success: number; failed: number }> = [];

    // One pass over the rows, bucketed by key. This used to re-scan the whole
    // array once per bucket: 30 buckets x the 50,000-row cap meant 1.5M Date
    // constructions and 1.5M toDateString() calls per page view.
    const buckets = new Map<string, { total: number; successful: number }>();
    for (const e of executions) {
      const key = this.trendBucketKey(new Date(e.createdAt), timeframe);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { total: 0, successful: 0 };
        buckets.set(key, bucket);
      }
      bucket.total += 1;
      if (e.success) bucket.successful += 1;
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
      const total = bucket?.total ?? 0;
      const successful = bucket?.successful ?? 0;

      trend.push({ date: dateKey, executions: total, success: successful, failed: total - successful });
    }

    return trend;
  }

  private getWeekNumber(date: Date): number {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    return Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
  }
}
