/**
 * Orchestrator for tool execution. Slim dispatcher — the heavy
 * per-type lifting lives in ./executors/*. This used to be a
 * 1,866-line monolith that mixed dispatch, HTTP plumbing, GraphQL
 * plumbing, SOAP templating, SDK sandboxing, LLM call building,
 * cache management, rate-limit bookkeeping, credential resolution,
 * and metrics persistence in one class. It was impossible to audit
 * in one pass and it was hiding four distinct security bugs
 * (pagination SSRF, JSON template injection, CRLF header injection,
 * metrics race). The refactor split concerns into:
 *
 *   - executors/tool-http.executor.ts     — HTTP family + pagination
 *   - executors/tool-protocol.executor.ts — GraphQL/SOAP/gRPC
 *   - executors/tool-script.executor.ts   — LLM/SDK/custom code
 *   - services/tool-auth.service.ts       — credential application
 *   - tool-execution-utils.ts             — pure helpers (fixes live here)
 *   - tool-execution.types.ts             — shared interfaces
 *
 * Public API (what other services import from this file) is
 * unchanged: the `ToolExecutorService` class and every interface
 * that used to live here are still exported from the same module
 * path. Types are re-exported below so no caller needs to update
 * its import path.
 */
import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import * as Redis from 'ioredis';
import { InjectRedis } from '@nestjs-modules/ioredis';

import { Tool, ToolStatus } from '../../entities/tool.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { User } from '../../entities/user.entity';
import { sanitizeToolParameters } from '../../common/security/input-sanitizer';
import { verifyToolIntegrity } from '../../common/security/tool-integrity';
import { AuditLogService } from '../audit-log/audit-log.service';

import {
  ToolExecutionOptions,
  ToolExecutionResult,
  GraphQLRequest,
  SOAPRequest,
} from './tool-execution.types';
import { hashCacheObject, sleep } from './tool-execution-utils';
import { ToolHttpExecutor } from './executors/tool-http.executor';
import { ToolProtocolExecutor } from './executors/tool-protocol.executor';
import { ToolScriptExecutor } from './executors/tool-script.executor';
import { ToolCacheRateLimitHelper } from './tool-cache-rate-limit.helper';

// Re-export shared types so existing callers keep working with
// `import { ToolExecutionResult, ToolExecutionOptions } from '…/tool-executor.service'`.
export {
  ToolExecutionOptions,
  ToolExecutionResult,
  GraphQLRequest,
  SOAPRequest,
};

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    @InjectRepository(ToolExecution)
    private readonly toolExecutionRepository: Repository<ToolExecution>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRedis() private readonly redis: Redis.Redis,
    private readonly httpExecutor: ToolHttpExecutor,
    private readonly protocolExecutor: ToolProtocolExecutor,
    private readonly scriptExecutor: ToolScriptExecutor,
    private readonly auditLogService: AuditLogService,
    private readonly cacheRateLimit: ToolCacheRateLimitHelper,
  ) {}

  // ─── Public entry point ────────────────────────────────────────

  async executeTool(
    toolId: string,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    let retryCount = 0;
    let cached = false;
    let rateLimited = false;

    // Short-circuit before any DB work if the caller already aborted
    // (e.g. the HTTP request was cancelled between queueing and
    // dispatch). Saves a tool load + audit write.
    if (options.signal?.aborted) {
      return this.abortedResult(startTime);
    }

    try {
      if (!options.organizationId) {
        throw new Error('Tool not found');
      }

      // Load the tool scoped to the caller's org. Without this filter
      // a user in org A with `use_tools` could execute any tool in
      // org B just by passing toolId — running HTTP requests against
      // that org's configured APIs, spending their credentials, and
      // returning the response. `options.organizationId` must be the
      // authenticated caller's currentOrganizationId; callers must
      // not forward a client-supplied value.
      const tool = await this.toolRepository.findOne({
        where: { id: toolId, organizationId: options.organizationId },
        relations: ['operation', 'operation.api', 'api', 'inputSchema', 'outputSchema'],
      });

      if (!tool) {
        throw new Error('Tool not found');
      }

      if (tool.status !== ToolStatus.ACTIVE) {
        throw new Error(`Tool is ${tool.status}, cannot execute`);
      }

      // User permission check (skipped for MCP unauthenticated sessions,
      // where gateway-level auth handles access control).
      if (options.userId) {
        const user = await this.userRepository.findOne({
          where: { id: options.userId },
          relations: ['organizationMemberships'],
        });

        if (!user?.hasPermissionInOrganization(options.organizationId, 'use_tools')) {
          throw new Error('User does not have permission to use tools in this organization');
        }
      }

      // Parameter schema validation (if the tool has one).
      const validation = await this.validateParameters(tool, parameters);
      if (!validation.isValid) {
        throw new BadRequestException(`Invalid parameters: ${validation.errors.join(', ')}`);
      }

      // Parameter sanitization — catches prototype pollution / NoSQL
      // operator injection / obvious script payloads.
      const sanitization = sanitizeToolParameters(parameters);
      if (!sanitization.safe) {
        this.logger.warn(
          `Blocked dangerous parameters for tool ${tool.name}: ${sanitization.warnings.join('; ')}`,
        );
        throw new BadRequestException(
          `Parameter security violation: ${sanitization.warnings.filter(w => w.startsWith('[block]')).join('; ')}`,
        );
      }
      if (sanitization.warnings.length > 0) {
        this.logger.warn(
          `Parameter warnings for tool ${tool.name}: ${sanitization.warnings.join('; ')}`,
        );
      }

      // Tool integrity: refuse to execute if the stored definitionHash
      // no longer matches the current definition. Catches tampered
      // tool rows at execution time.
      if (tool.definitionHash) {
        const integrity = verifyToolIntegrity(tool, tool.definitionHash);
        if (!integrity.valid) {
          this.logger.error(
            `Tool integrity check FAILED for ${tool.name} (${tool.id}). Stored hash does not match current definition.`,
          );
          throw new BadRequestException(
            'Tool integrity verification failed. The tool definition may have been tampered with.',
          );
        }
      }

      // Rate limit.
      if (!options.skipRateLimit) {
        const rateLimitResult = await this.cacheRateLimit.checkRateLimit(tool, options);
        if (rateLimitResult.limited) {
          rateLimited = true;
          return {
            success: false,
            error: `Rate limit exceeded: ${rateLimitResult.message}`,
            executionTime: Date.now() - startTime,
            cached,
            rateLimited,
            retryCount,
          };
        }
      }

      // Cache lookup.
      if (!options.skipCache && tool.configuration?.cache?.enabled) {
        const cachedResult = await this.cacheRateLimit.getCachedResult(tool, parameters);
        if (cachedResult) {
          cached = true;
          await this.recordExecution(tool, parameters, cachedResult, options, {
            cached: true,
            executionTime: Date.now() - startTime,
            retryCount: 0,
          });
          return {
            ...cachedResult,
            cached: true,
            rateLimited: false,
            retryCount: 0,
            executionTime: Date.now() - startTime,
          };
        }
      }

      // Second abort check before dispatch. validation / rate-limit /
      // cache all run synchronously or via short Redis ops, so this
      // is the last meaningful chance to bail before a potentially
      // long-running outbound HTTP call.
      if (options.signal?.aborted) {
        return this.abortedResult(startTime);
      }

      // ── Dispatch to the right executor ──────────────────────────

      let result: ToolExecutionResult | undefined;

      if (tool.llmConfig?.providerId && tool.llmConfig?.promptTemplate) {
        result = await this.scriptExecutor.executeLlm(tool, parameters, options);
      } else if (tool.sdkConfig) {
        result = await this.scriptExecutor.executeSdk(tool, parameters, options);
      } else if (tool.code) {
        result = await this.scriptExecutor.executeCustomCode(tool, parameters, options);
      } else if (tool.httpConfig) {
        result = await this.httpExecutor.executeHttpConfig(tool, parameters, options);
      } else if (tool.graphqlConfig) {
        result = await this.protocolExecutor.executeGraphQLConfig(tool, parameters, options);
      } else if (tool.soapConfig) {
        result = await this.protocolExecutor.executeSOAPConfig(tool, parameters, options);
      } else if (tool.grpcConfig) {
        result = await this.protocolExecutor.executeGrpcConfig(tool, parameters, options);
      }

      if (result !== undefined) {
        // Cache successful config-based tool results.
        if (tool.configuration?.cache?.enabled && result.success) {
          await this.cacheRateLimit.cacheResult(tool, parameters, result);
        }
        await this.recordExecution(tool, parameters, result, options, {
          executionTime: result.executionTime ?? Date.now() - startTime,
          cached,
          retryCount: 0,
        });
        return { ...result, cached, rateLimited, retryCount: 0 };
      }

      // Legacy API-operation path (spec-imported tools without a
      // structured *Config). Supports exponential-backoff retries.
      const maxRetries = options.retries ?? tool.configuration?.retries ?? 3;
      let lastError: Error | undefined;

      while (retryCount <= maxRetries) {
        try {
          const opResult = await this.executeOperation(tool, parameters, options);

          if (tool.configuration?.cache?.enabled && opResult.success) {
            await this.cacheRateLimit.cacheResult(tool, parameters, opResult);
          }

          await this.recordExecution(tool, parameters, opResult, options, {
            cached: false,
            executionTime: Date.now() - startTime,
            retryCount,
          });

          return {
            ...opResult,
            executionTime: Date.now() - startTime,
            cached,
            rateLimited,
            retryCount,
          };
        } catch (error: any) {
          lastError = error;
          retryCount++;

          if (retryCount <= maxRetries) {
            const delay = Math.pow(2, retryCount) * 1000;
            await sleep(delay);
            this.logger.warn(
              `Tool execution failed, retrying in ${delay}ms (attempt ${retryCount}/${maxRetries}): ${error.message}`,
            );
          }
        }
      }

      const failureResult: ToolExecutionResult = {
        success: false,
        error: `Execution failed after ${retryCount} attempts: ${lastError?.message ?? 'unknown'}`,
        executionTime: Date.now() - startTime,
        cached,
        rateLimited,
        retryCount,
      };

      await this.recordExecution(tool, parameters, failureResult, options, {
        cached: false,
        executionTime: Date.now() - startTime,
        retryCount,
      });

      return failureResult;
    } catch (error: any) {
      this.logger.error(`Tool execution error: ${error.message}`, error.stack);

      const errorResult: ToolExecutionResult = {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime,
        cached,
        rateLimited,
        retryCount,
      };

      try {
        // Scope to the caller's org here too — otherwise the error
        // path would load a cross-org tool just to write an audit
        // record against it, confirming the tool's existence and
        // polluting its execution stats.
        if (options.organizationId) {
          const tool = await this.toolRepository.findOne({
            where: { id: toolId, organizationId: options.organizationId },
          });
          if (tool) {
            await this.recordExecution(tool, parameters, errorResult, options, {
              cached: false,
              executionTime: Date.now() - startTime,
              retryCount,
            });
          }
        }
      } catch (recordError: any) {
        this.logger.error(`Failed to record failed execution: ${recordError.message}`);
      }

      return errorResult;
    }
  }

  // ─── Legacy operation-based dispatch ───────────────────────────

  private async executeOperation(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const operation = tool.operation!;
    const api = operation.api;

    switch (api.type) {
      case ApiType.OPENAPI:
        return this.httpExecutor.executeRestOperation(tool, operation, api, parameters, options);
      case ApiType.GRAPHQL:
        return this.protocolExecutor.executeGraphQLOperation(
          tool,
          operation,
          api,
          parameters,
          options,
        );
      case ApiType.SOAP:
        return this.protocolExecutor.executeSOAPOperation(
          tool,
          operation,
          api,
          parameters,
          options,
        );
      case ApiType.GRPC:
        return this.protocolExecutor.executeProtobufOperation(
          tool,
          operation,
          api,
          parameters,
          options,
        );
      default:
        throw new Error(`Unsupported API type: ${api.type}`);
    }
  }

  // ─── Validation / rate limit / cache ───────────────────────────

  private async validateParameters(
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


  // ─── Execution recording + atomic stats ────────────────────────

  private async recordExecution(
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

      // Audit log (fire-and-forget)
      this.auditLogService.logToolExecution(
        options.organizationId,
        options.userId,
        tool.id,
        tool.name,
        { success: result.success, executionTime: metadata.executionTime, parameters },
      );

      // Atomic stats bump. The old shape was `tool.incrementUsage() +
      // tool.updateMetrics() + toolRepository.save(tool)`, which is a
      // read-modify-write race: two concurrent executions on the same
      // tool both read the counter, both compute `+ 1`, both save,
      // and one increment is lost. Same class of bug we already
      // fixed on agent-execution.engine. Do a single conditional
      // SQL UPDATE with a Welford-style running average so the
      // result is atomic under concurrency.
      await this.bumpToolStats(
        tool.id,
        result.success,
        metadata.executionTime,
      );
    } catch (error: any) {
      this.logger.error(`Failed to record tool execution: ${error.message}`);
    }
  }

  /**
   * Atomic per-tool stats update. Single SQL UPDATE so two concurrent
   * calls can never lose an increment — the RHS of every SET clause
   * evaluates against the OLD column values, so we can reference
   * `"usageCount"` in multiple expressions and they all see the pre-
   * update value.
   *
   * Stats we maintain:
   *
   *   - usageCount — `"usageCount" + 1`
   *
   *   - lastUsedAt — clock time at row write
   *
   *   - averageResponseTime — incremental running average. New avg =
   *     (old_avg * old_count + x) / (old_count + 1). Special case when
   *     old_count is zero so we don't divide by… well, one anyway, but
   *     we'd still multiply an uninitialised 0 by 0 and end up with x
   *     which is what we want — the branch is just documentation.
   *
   *   - successRate — exponential moving average matching the shape
   *     of the old entity-method code:
   *       success: newRate = min(100, rate + (100 - rate) * 0.1)
   *       failure: newRate = max(0, rate * 0.9)
   *     The GREATEST/LEAST clamps mirror the Math.min/Math.max in the
   *     entity method.
   */
  private async bumpToolStats(
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

  // ─── Cancellation helper ───────────────────────────────────────

  /**
   * Shared ToolExecutionResult shape for a cancelled call. Returned
   * whenever `options.signal` fires before dispatch or when a
   * downstream executor throws an AbortError. We don't record an
   * audit row for cancelled calls — the caller's request was the
   * thing that cancelled, and logging a spurious "failed execution"
   * under their id would be misleading.
   */
  private abortedResult(startTime: number): ToolExecutionResult {
    return {
      success: false,
      error: 'Tool execution cancelled',
      executionTime: Date.now() - startTime,
      cached: false,
      rateLimited: false,
      retryCount: 0,
      metadata: { cancelled: true },
    };
  }

  // ─── Stats reader ──────────────────────────────────────────────

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
      where: {
        toolId,
        organizationId,
        createdAt: MoreThanOrEqual(since),
      },
    });

    const total = executions.length;
    const successful = executions.filter(e => e.success).length;
    const failed = total - successful;
    const avgTime =
      total > 0 ? executions.reduce((sum, e) => sum + e.executionTime, 0) / total : 0;
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
