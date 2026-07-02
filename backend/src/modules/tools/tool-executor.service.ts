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
import { ToolStatsHelper } from './tool-stats.helper';
import { RunnerCallService, RUNNER_CALL_ERRORS, RunnerCallError } from '../runner/runner-call.service';
import { CanonicalMemoryService } from '../memory/canonical/canonical-memory.service';
import { McpSourcesService } from '../mcp-sources/mcp-sources.service';
import { McpClientError } from '../mcp-sources/mcp-client.service';
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
    private readonly stats: ToolStatsHelper,
    private readonly runnerCalls: RunnerCallService,
    private readonly memoryService: CanonicalMemoryService,
    private readonly mcpSources: McpSourcesService,
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
      const validation = await this.stats.validateParameters(tool, parameters);
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
          await this.stats.recordExecution(tool, parameters, cachedResult, options, {
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

      // runnerConfig wins before any other dispatch path. The presence
      // of runnerConfig is the signal that this tool is owned by a
      // registered runner; falling through to the script/HTTP paths
      // would invoke executors that have no idea what to do with it.
      if (tool.runnerConfig) {
        result = await this.executeRunnerCall(tool, parameters, options);
      } else if (tool.memoryConfig) {
        result = await this.executeMemoryCall(tool, parameters, options);
      } else if (tool.configuration?.mcp) {
        result = await this.executeMcpCall(tool, parameters, options);
      } else if (tool.llmConfig?.providerId && tool.llmConfig?.promptTemplate) {
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
        await this.stats.recordExecution(tool, parameters, result, options, {
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

          await this.stats.recordExecution(tool, parameters, opResult, options, {
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

      await this.stats.recordExecution(tool, parameters, failureResult, options, {
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
            await this.stats.recordExecution(tool, parameters, errorResult, options, {
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
    // A tool reaches this legacy path only when none of the structured
    // *Config dispatch branches matched. If it also has no operation/api
    // (e.g. a custom tool whose config was never set or was lost), the old
    // `tool.operation!` assertion crashed with a cryptic
    // "Cannot read properties of null (reading 'api')" that surfaced into
    // agent runs. Fail with a clear, typed error instead of a null-deref.
    const operation = tool.operation;
    if (!operation || !operation.api) {
      throw new BadRequestException(
        `Tool '${tool.name}' has no executable configuration ` +
          `(no HTTP/JS/GraphQL/SOAP/gRPC/LLM/SDK/runner config and no imported API operation). ` +
          `Re-import its API or set a tool configuration.`,
      );
    }
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

  getToolExecutionStats(...args: Parameters<ToolStatsHelper['getToolExecutionStats']>) {
    return this.stats.getToolExecutionStats(...args);
  }

  /**
   * Dispatch a runner-backed tool. Maps RunnerCallError codes onto
   * ToolExecutionResult so the caller (controllers, agent runtime,
   * MCP handlers) sees uniform shape regardless of how dispatch
   * failed.
   *
   * Workspace handling: tools whose runnerConfig.requiresWorkspace
   * is true require parameters.workspaceId to be set by the caller.
   * The runner resolves workspaceId to a process-bound workspace dir
   * and refuses if the workspace isn't ACTIVE for that runner. We
   * surface the missing-workspace case here so the runner doesn't
   * have to guess what the caller intended.
   */
  private async executeRunnerCall(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const cfg = tool.runnerConfig!;
    const workspaceId = typeof parameters.workspaceId === 'string' ? parameters.workspaceId : undefined;

    if (cfg.requiresWorkspace && !workspaceId) {
      return {
        success: false,
        error: `Tool '${tool.name}' requires a workspaceId parameter; runner-backed methods scoped to a workspace cannot run without one.`,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };
    }

    // Strip workspaceId from the params payload — it travels in the
    // envelope frame, not the inner method params. Otherwise the
    // runner-side handler sees an unexpected field.
    const { workspaceId: _ws, ...callParams } = parameters;

    try {
      const response = await this.runnerCalls.dispatch(
        cfg.runnerId,
        cfg.method,
        callParams,
        workspaceId,
        { signal: options.signal, timeoutMs: tool.configuration?.timeout },
      );
      if (!response.ok) {
        return {
          success: false,
          error: response.error?.message ?? `runner method ${cfg.method} reported failure`,
          data: response.error,
          executionTime: Date.now() - startTime,
          cached: false,
          rateLimited: false,
          retryCount: 0,
        };
      }
      return {
        success: true,
        data: response.result,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };
    } catch (err: any) {
      if (err instanceof RunnerCallError) {
        return {
          success: false,
          error: `${err.code}: ${err.message}`,
          executionTime: Date.now() - startTime,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: { runnerErrorCode: err.code, cause: err.cause },
        };
      }
      throw err;
    }
  }

  /**
   * Dispatch a memory-backed tool. Maps the tool's memoryConfig
   * (method + scope) onto a CanonicalMemoryService call. The tool's
   * input parameters carry the per-call args (content/query/tags/...);
   * scope comes from the Tool row, not the caller.
   */
  private async executeMemoryCall(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const cfg = tool.memoryConfig!;
    try {
      const actor = { user_id: options.userId };
      let data: any;
      switch (cfg.method) {
        case 'store': {
          if (typeof parameters.content !== 'string' || !parameters.content.trim()) {
            throw new BadRequestException("memory.store requires non-empty 'content'");
          }
          data = await this.memoryService.put({
            mode: cfg.mode ?? 'memory',
            scope: cfg.scope,
            content: parameters.content,
            tier: parameters.tier,
            tags: parameters.tags,
            confidence: parameters.confidence,
            ttl_seconds: parameters.ttl_seconds,
          } as any, actor);
          break;
        }
        case 'recall': {
          if (typeof parameters.query !== 'string' || !parameters.query.trim()) {
            throw new BadRequestException("memory.recall requires non-empty 'query'");
          }
          data = await this.memoryService.search({
            scope: cfg.scope,
            query: parameters.query,
            top_k: parameters.top_k,
            tags: parameters.tags,
            tier: parameters.tier,
          } as any);
          break;
        }
        case 'list': {
          data = await this.memoryService.list({
            scope: cfg.scope,
            tier: parameters.tier,
            tags: parameters.tags,
            limit: parameters.limit,
            cursor: parameters.cursor ?? null,
          } as any);
          break;
        }
        case 'search': {
          if (typeof parameters.query !== 'string' || !parameters.query.trim()) {
            throw new BadRequestException("memory.search requires non-empty 'query'");
          }
          data = await this.memoryService.search({
            scope: cfg.scope,
            query: parameters.query,
            top_k: parameters.top_k,
            fts_only: true,
          } as any);
          break;
        }
        default:
          throw new BadRequestException(`unknown memory method: ${cfg.method}`);
      }
      return {
        success: true,
        data,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err?.message ?? String(err),
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };
    }
  }

  /**
   * Dispatch an MCP-backed tool (materialized from an external MCP
   * source). Bridges to McpSourcesService which runs tools/call over
   * streamable HTTP. Remote/transport failures come back as typed
   * McpClientError codes and are mapped onto a failed
   * ToolExecutionResult — a flaky remote server must never surface as
   * a raw 500 to the caller.
   */
  private async executeMcpCall(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const cfg = tool.configuration!.mcp!;
    try {
      const mapped = await this.mcpSources.executeToolCall(
        tool.organizationId,
        cfg,
        parameters,
        { timeoutMs: tool.configuration?.timeout, signal: options.signal },
      );
      return {
        success: mapped.success,
        data: mapped.data,
        error: mapped.error,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: { mcpSourceId: cfg.sourceId, remoteName: cfg.remoteName },
      };
    } catch (err: any) {
      if (err instanceof McpClientError) {
        return {
          success: false,
          error: `${err.code}: ${err.message}`,
          executionTime: Date.now() - startTime,
          cached: false,
          rateLimited: false,
          retryCount: 0,
          metadata: { mcpErrorCode: err.code, mcpSourceId: cfg.sourceId, remoteName: cfg.remoteName },
        };
      }
      throw err;
    }
  }

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
}
