import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Tool } from '../../entities/tool.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

import { ToolExecutionOptions, ToolExecutionResult } from './tool-execution.types';
import { getRequestContext } from '../../common/request-context';

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
      // Correlation, from the scope rather than from the signature.
      //
      // `gatewayId` has been a column on this table all along and nothing
      // populated it; `runId` had no column at all, so an agent run's
      // step and the tool_executions row it produced could not be joined
      // — "the agent said the lookup failed" had no path to the row with
      // the parameters, the upstream status and the error. Both are known
      // by the code that opened the scope (the unified endpoint resolves
      // the gateway, the execution engine opens the run), so neither has
      // to be threaded through every signature in between. An explicit
      // option still wins where a caller has better information.
      const scope = getRequestContext();
      const gatewayId = options.gatewayId ?? scope?.gatewayId ?? null;
      const runId = options.runId ?? scope?.runId ?? null;

      const execution = this.toolExecutionRepository.create({
        toolId: tool.id,
        userId: options.userId,
        organizationId: options.organizationId,
        gatewayId,
        runId,
        parameters,
        result: result.data,
        success: result.success,
        error: result.error,
        executionTime: metadata.executionTime,
        cached: metadata.cached,
        retryCount: metadata.retryCount,
        metadata: {
          httpStatus: result.metadata?.httpStatus,
          // The upstream API's own request id when it returned one, else
          // ours — so a row always has something to correlate on.
          requestId: result.metadata?.requestId ?? scope?.requestId,
          rateLimited: result.rateLimited,
          ...(scope?.nodeId ? { nodeId: scope.nodeId } : {}),
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

    // Counted and averaged by the database, not in heap.
    //
    // This used to `find()` every matching row with no `select` and no
    // `take`. A ToolExecution carries `parameters` and `result` as
    // untruncated json and the HTTP executor allows 10MB responses, so
    // the six scalars below cost the full window in memory. One tool at
    // 1 req/s over a month is ~2.6M rows, reached by opening that tool's
    // detail page -- and `timeframe` is caller-supplied up to `month`.
    //
    // A sample cap is not available here the way it is for a top-N list:
    // these are totals, and a capped sample would quietly answer a
    // different question. All six are single-pass aggregates over
    // IDX(toolId, organizationId, createdAt), so the database computes
    // them without materialising a row.
    const row = await this.toolExecutionRepository
      .createQueryBuilder('execution')
      .select('COUNT(*)', 'total')
      .addSelect('COUNT(*) FILTER (WHERE execution.success)', 'successful')
      .addSelect('AVG(execution.executionTime)', 'avgTime')
      .addSelect('COUNT(*) FILTER (WHERE execution.cached)', 'cachedCount')
      .addSelect(
        "COUNT(*) FILTER (WHERE execution.metadata->>'rateLimited' = 'true')",
        'rateLimited',
      )
      .where('execution.toolId = :toolId', { toolId })
      .andWhere('execution.organizationId = :organizationId', { organizationId })
      .andWhere('execution.createdAt >= :since', { since })
      .getRawOne<{
        total: string;
        successful: string;
        avgTime: string | null;
        cachedCount: string;
        rateLimited: string;
      }>();

    const total = Number(row?.total ?? 0);
    const successful = Number(row?.successful ?? 0);
    const cached = Number(row?.cachedCount ?? 0);
    const avgTime = row?.avgTime ? Number(row.avgTime) : 0;
    const cacheHitRate = total > 0 ? (cached / total) * 100 : 0;

    return {
      totalExecutions: total,
      successfulExecutions: successful,
      failedExecutions: total - successful,
      averageExecutionTime: Math.round(avgTime),
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      rateLimitedExecutions: Number(row?.rateLimited ?? 0),
    };
  }
}
