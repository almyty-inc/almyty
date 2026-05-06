import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';

import { Tool, ToolStatus } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';

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
@Injectable()
export class ToolsStatsHelper {
  constructor(
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    @InjectRepository(ToolExecution)
    private readonly toolExecutionRepository: Repository<ToolExecution>,
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

    const executions = await this.toolExecutionRepository.find({
      where: {
        toolId: tool.id,
        organizationId,
        createdAt: MoreThanOrEqual(since),
      },
      relations: ['user'],
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

  async getOrganizationToolStats(organizationId: string): Promise<{
    totalTools: number;
    activeTools: number;
    draftTools: number;
    inactiveTools: number;
    totalExecutions: number;
    averageExecutionTime: number;
    topUsedTools: Array<{ tool: Tool; executionCount: number }>;
  }> {
    const toolCounts = await this.toolRepository
      .createQueryBuilder('tool')
      .select('tool.status')
      .addSelect('COUNT(*)', 'count')
      .where('tool.organizationId = :organizationId', { organizationId })
      .groupBy('tool.status')
      .getRawMany();

    const statusCounts: Record<string, number> = toolCounts.reduce((acc, row) => {
      acc[row.tool_status] = parseInt(row.count);
      return acc;
    }, {} as Record<string, number>);

    const totalTools = Object.values(statusCounts).reduce(
      (sum: number, count: number) => sum + count,
      0,
    );

    const executions = await this.toolExecutionRepository.find({
      where: { organizationId },
      relations: ['tool'],
    });

    const totalExecutions = executions.length;
    const averageExecutionTime =
      totalExecutions > 0
        ? Math.round(executions.reduce((sum, e) => sum + e.executionTime, 0) / totalExecutions)
        : 0;

    const toolUsage = executions.reduce<Record<string, number>>((acc, execution) => {
      const toolId = execution.toolId;
      acc[toolId] = (acc[toolId] || 0) + 1;
      return acc;
    }, {});

    const topToolIds = Object.entries(toolUsage)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .slice(0, 10)
      .map(([toolId]) => toolId);

    const topTools = await this.toolRepository.find({
      where: { id: In(topToolIds) },
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

  private calculateExecutionTrend(
    executions: ToolExecution[],
    timeframe: 'hour' | 'day' | 'week' | 'month',
  ): Array<{ date: string; executions: number; success: number; failed: number }> {
    const intervals = { hour: 24, day: 30, week: 12, month: 12 };
    const interval = intervals[timeframe];
    const trend: Array<{ date: string; executions: number; success: number; failed: number }> = [];

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

      const periodExecutions = executions.filter((e) => {
        const executionDate = new Date(e.createdAt);
        switch (timeframe) {
          case 'hour':
            return (
              executionDate.getHours() === date.getHours() &&
              executionDate.toDateString() === date.toDateString()
            );
          case 'day':
            return executionDate.toDateString() === date.toDateString();
          case 'week':
            return (
              this.getWeekNumber(executionDate) === this.getWeekNumber(date) &&
              executionDate.getFullYear() === date.getFullYear()
            );
          case 'month':
            return (
              executionDate.getMonth() === date.getMonth() &&
              executionDate.getFullYear() === date.getFullYear()
            );
          default:
            return false;
        }
      });

      const total = periodExecutions.length;
      const successful = periodExecutions.filter((e) => e.success).length;
      const failed = total - successful;

      trend.push({ date: dateKey, executions: total, success: successful, failed });
    }

    return trend;
  }

  private getWeekNumber(date: Date): number {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    return Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
  }
}
