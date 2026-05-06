import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';

import { Tool } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

import { ToolExecutionOptions, ToolExecutionResult } from './tool-execution.types';

@Injectable()
export class ToolStatsHelper {
  private readonly logger = new Logger(ToolStatsHelper.name);

  constructor(
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    @InjectRepository(ToolExecution)
    private readonly toolExecutionRepository: Repository<ToolExecution>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async validateParameters(
    tool: Tool,
    parameters: Record<string, any>,
  ): Promise<{ isValid: boolean; errors: string[] }> {
    try {
      if (tool.inputSchema) {
        return tool.inputSchema.validate(parameters);
      }

      const errors: string[] = [];
      const toolParams = tool.parameters;
      if (toolParams?.required) {
        for (const requiredParam of toolParams.required) {
          if (!(requiredParam in parameters)) {
            errors.push(`Missing required parameter: ${requiredParam}`);
          }
        }
      }
      return { isValid: errors.length === 0, errors };
    } catch (error: any) {
      return { isValid: false, errors: [`Parameter validation error: ${error.message}`] };
    }
  }

  async recordExecution(
    tool: Tool,
    parameters: Record<string, any>,
    result: ToolExecutionResult,
    options: ToolExecutionOptions,
    metadata: { cached: boolean; executionTime: number; retryCount: number },
  ): Promise<void> {
    try {
      const execution = this.toolExecutionRepository.create({
        toolId: tool.id,
        userId: options.userId,
        organizationId: options.organizationId,
        parameters,
        result: result.data,
        success: result.success,
        error: result.error,
        executionTime: metadata.executionTime,
        cached: metadata.cached,
        retryCount: metadata.retryCount,
        metadata: {
          httpStatus: result.metadata?.httpStatus,
          requestId: result.metadata?.requestId,
          rateLimited: result.rateLimited,
        },
      });

      await this.toolExecutionRepository.save(execution);

      this.auditLogService.logToolExecution(
        options.organizationId,
        options.userId,
        tool.id,
        tool.name,
        { success: result.success, executionTime: metadata.executionTime, parameters },
      );

      // Atomic stats bump. Single conditional SQL UPDATE so concurrent
      // executions can't lose increments — same pattern as agent stats.
      await this.bumpToolStats(tool.id, result.success, metadata.executionTime);
    } catch (error: any) {
      this.logger.error(`Failed to record tool execution: ${error.message}`);
    }
  }

  /**
   * Atomic per-tool stats update via a single SQL UPDATE. RHS clauses
   * see the pre-update column values, so concurrent calls can't race.
   *
   *   - usageCount        — `"usageCount" + 1`
   *   - lastUsedAt        — clock time at row write
   *   - averageResponseTime — incremental running average
   *     (oldAvg*oldCount + x) / (oldCount + 1)
   *   - successRate       — exponential moving average matching the
   *     old entity-method shape:
   *       success: rate + (100 - rate) * 0.1, clamped to [0,100]
   *       failure: rate * 0.9, clamped to [0,100]
   */
  async bumpToolStats(
    toolId: string,
    success: boolean,
    executionTime: number,
  ): Promise<void> {
    const execTime = Number(executionTime) || 0;
    await this.toolRepository
      .createQueryBuilder()
      .update(Tool)
      .set({
        usageCount: () => '"usageCount" + 1',
        averageResponseTime: () =>
          `CASE WHEN "usageCount" = 0 THEN ${execTime} ELSE ROUND(("averageResponseTime" * "usageCount" + ${execTime}) / ("usageCount" + 1)) END`,
        successRate: success
          ? () => `LEAST(100, "successRate" + (100 - "successRate") * 0.1)`
          : () => `GREATEST(0, "successRate" * 0.9)`,
        lastUsedAt: new Date(),
      })
      .where('id = :id', { id: toolId })
      .execute();
  }

  async getToolExecutionStats(
    toolId: string,
    organizationId: string,
    timeframe: 'hour' | 'day' | 'week' | 'month' = 'day',
  ): Promise<{
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    averageExecutionTime: number;
    cacheHitRate: number;
    rateLimitedExecutions: number;
  }> {
    const timeframeDurations = {
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
      week: 7 * 24 * 60 * 60 * 1000,
      month: 30 * 24 * 60 * 60 * 1000,
    };

    const since = new Date(Date.now() - timeframeDurations[timeframe]);

    const executions = await this.toolExecutionRepository.find({
      where: { toolId, organizationId, createdAt: MoreThanOrEqual(since) },
    });

    const total = executions.length;
    const successful = executions.filter(e => e.success).length;
    const failed = total - successful;
    const avgTime = total > 0 ? executions.reduce((sum, e) => sum + e.executionTime, 0) / total : 0;
    const cached = executions.filter(e => e.cached).length;
    const cacheHitRate = total > 0 ? (cached / total) * 100 : 0;
    const rateLimited = executions.filter(e => (e.metadata as any)?.rateLimited).length;

    return {
      totalExecutions: total,
      successfulExecutions: successful,
      failedExecutions: failed,
      averageExecutionTime: Math.round(avgTime),
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      rateLimitedExecutions: rateLimited,
    };
  }
}
