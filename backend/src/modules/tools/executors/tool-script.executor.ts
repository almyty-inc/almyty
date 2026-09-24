/**
 * Script-family tool execution: LLM tools, SDK tools, and custom
 * JavaScript/TypeScript tools that run inside the node-sandbox.
 *
 * Extracted from the old tool-executor.service.ts monolith. Each
 * of these three paths has its own shape but they all share the
 * same pattern: gather inputs, resolve credentials, hand off to
 * a sandbox or LLM provider, record the result.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tool } from '../../../entities/tool.entity';
import { Api } from '../../../entities/api.entity';
import { Credential } from '../../../entities/credential.entity';
import { NodeSandboxService } from '../node-sandbox/node-sandbox.service';
import { SdkCodeAssemblerService } from '../node-sandbox/sdk-code-assembler.service';
import { ToolExecutionOptions, ToolExecutionResult } from '../tool-execution.types';
import { getByDotPath } from '../tool-execution-utils';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { ToolInvocationBudget } from './tool-invocation-budget';
import { sandboxHostPolicy } from '../../../common/security/gateway-tool-policy';

@Injectable()
export class ToolScriptExecutor {
  private readonly logger = new Logger(ToolScriptExecutor.name);

  constructor(
    @InjectRepository(Credential)
    private readonly credentialRepository: Repository<Credential>,
    private readonly nodeSandbox: NodeSandboxService,
    private readonly sdkCodeAssembler: SdkCodeAssemblerService,
    private readonly moduleRef: ModuleRef,
    private readonly envelopeCrypto: EnvelopeCryptoService,
  ) {}

  // ─── LLM tool ──────────────────────────────────────────────────

  async executeLlm(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    try {
      // Interpolate prompt template with parameters
      let prompt = tool.llmConfig!.promptTemplate!;
      for (const [key, value] of Object.entries(parameters)) {
        prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), String(value));
      }

      const messages: any[] = [];
      if (tool.llmConfig!.systemPrompt) {
        let sysPrompt = tool.llmConfig!.systemPrompt;
        if (tool.llmConfig!.outputMode === 'json' && tool.llmConfig!.outputSchema) {
          sysPrompt += `\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(tool.llmConfig!.outputSchema, null, 2)}`;
        }
        messages.push({ role: 'system', content: sysPrompt });
      } else if (tool.llmConfig!.outputMode === 'json' && tool.llmConfig!.outputSchema) {
        messages.push({
          role: 'system',
          content: `Respond with valid JSON matching this schema:\n${JSON.stringify(tool.llmConfig!.outputSchema, null, 2)}`,
        });
      }
      messages.push({ role: 'user', content: prompt });

      // Dynamic import to avoid a circular dependency between the
      // tools module and the llm-providers module (LLM providers
      // call the tool executor, tool executor calls LLM providers).
      const { LlmProvidersService } = await import('../../llm-providers/llm-providers.service');
      const llmService = this.moduleRef?.get(LlmProvidersService, { strict: false });
      if (!llmService) {
        throw new Error('Provider service not available');
      }

      const chatResponse = await llmService.chat(
        tool.llmConfig!.providerId!,
        {
          messages,
          model: tool.llmConfig!.model,
          maxTokens: tool.llmConfig!.maxTokens,
          temperature: tool.llmConfig!.temperature,
        },
        options.organizationId,
        options.userId,
      );

      let responseData: any = chatResponse.message?.content || '';

      if (tool.llmConfig!.outputMode === 'json' && typeof responseData === 'string') {
        try {
          const jsonMatch = responseData.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
          if (jsonMatch) {
            responseData = JSON.parse(jsonMatch[0]);
          }
        } catch {
          responseData = { raw: responseData, parseError: 'Could not parse as JSON' };
        }
      }

      return {
        success: true,
        data: responseData,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: {
          outputMode: tool.llmConfig!.outputMode,
          provider: tool.llmConfig!.providerId,
          model: tool.llmConfig!.model,
          usage: chatResponse.usage,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Model call failed',
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };
    }
  }

  // ─── SDK tool (package + structured config, assembled into sandbox code) ───

  async executeSdk(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    try {
      const api = tool.api ?? tool.operation?.api ?? null;
      const sdkConfig = tool.sdkConfig!;
      const dependencies = tool.dependencies ?? api?.dependencies ?? {};
      if (sdkConfig.packageName && !dependencies[sdkConfig.packageName]) {
        dependencies[sdkConfig.packageName] = '*';
      }
      const npmRegistry = tool.npmRegistry ?? api?.npmRegistry ?? undefined;
      const credentials = await this.resolveToolCredentials(tool, api);
      const code = this.sdkCodeAssembler.assemble(sdkConfig);

      const sandboxResult = await this.nodeSandbox.execute({
        code,
        parameters,
        credentials,
        dependencies,
        npmRegistry,
        timeoutMs: tool.configuration?.timeout ?? api?.timeoutMs ?? 30000,
        signal: options.signal,
        invokeTool: this.buildInvokeToolCallback(options),
        hostPolicy: sandboxHostPolicy(options.securityPolicy),
        ...this.sandboxTenancy(options),
      });

      let resultData = sandboxResult.data;
      if (sandboxResult.success && sdkConfig.responseMapping?.dataPath && resultData) {
        resultData = getByDotPath(resultData, sdkConfig.responseMapping.dataPath);
      }

      return {
        success: sandboxResult.success,
        data: resultData,
        error: sandboxResult.error,
        executionTime: sandboxResult.executionTimeMs,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: { executor: 'sdk-sandbox', package: sdkConfig.packageName },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };
    }
  }

  // ─── Custom JS code tool (runs raw tool.code in the sandbox) ───

  async executeCustomCode(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    try {
      const api = tool.api ?? tool.operation?.api ?? null;
      const dependencies = tool.dependencies ?? api?.dependencies ?? undefined;
      const npmRegistry = tool.npmRegistry ?? api?.npmRegistry ?? undefined;
      const credentials = await this.resolveToolCredentials(tool, api);

      const sandboxResult = await this.nodeSandbox.execute({
        code: tool.code!,
        parameters,
        credentials,
        dependencies: dependencies ?? undefined,
        npmRegistry: npmRegistry ?? undefined,
        timeoutMs: tool.configuration?.timeout ?? api?.timeoutMs ?? 30000,
        signal: options.signal,
        invokeTool: this.buildInvokeToolCallback(options),
        hostPolicy: sandboxHostPolicy(options.securityPolicy),
        ...this.sandboxTenancy(options),
      });

      return {
        success: sandboxResult.success,
        data: sandboxResult.data,
        error: sandboxResult.error,
        executionTime: sandboxResult.executionTimeMs,
        cached: false,
        rateLimited: false,
        retryCount: 0,
        metadata: { executor: 'node-sandbox' },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };
    }
  }

  // ─── Nested tool invocation from inside the sandbox ───────────

  /**
   * Build the `invokeTool` callback passed to the sandbox. When
   * user code inside the worker calls `tools.invoke(id, params)`,
   * the worker posts a message to the host, node-sandbox.service
   * routes it here, and we run the nested tool via the orchestrator
   * in the SAME context as the outer call: organization and user, and
   * -- when the outer call came through a gateway -- the gateway, the
   * caller's scopes and the policy that governed the outer tool, so the
   * nested tool's gateway access list and security policy apply to it
   * exactly as they would to a direct call.
   *
   * Every nested call draws on one ToolInvocationBudget shared by the
   * whole tree under the root execution (depth, total calls, calls in
   * flight). Without it a tool that invoked itself filled the shared
   * sandbox pool with its own ancestors and wedged it for every tenant.
   *
   * We use ModuleRef.get(..., { strict: false }) because importing
   * ToolExecutorService directly would introduce a circular import
   * (ToolExecutorService → ToolScriptExecutor → ToolExecutorService).
   * Lazy resolution through the Nest DI container breaks the cycle
   * at runtime.
   *
   * AbortSignal propagation: the sandbox hands us a signal that fires
   * when the CALLING worker ends for any reason (its own timeout, the
   * outer request being cancelled), so nested work never outlives the
   * tool that asked for it.
   */
  private buildInvokeToolCallback(
    options: ToolExecutionOptions,
  ): (toolId: string, params: Record<string, any>, signal?: AbortSignal) => Promise<any> {
    const depth = (options.invocation?.depth ?? 0) + 1;
    // One budget per root execution: created here for a root tool, and
    // handed down unchanged to everything beneath it.
    const budget = options.invocation?.budget ?? ToolInvocationBudget.fromEnv();

    return async (toolId: string, params: Record<string, any>, signal?: AbortSignal) => {
      const release = budget.claim(depth);
      try {
        // Lazy import to break the circular dependency — the
        // orchestrator (ToolExecutorService) injects us, so we
        // can't inject it back.
        const { ToolExecutorService } = await import('../tool-executor.service');
        const orchestrator = this.moduleRef.get(ToolExecutorService, { strict: false });
        if (!orchestrator) {
          throw new Error('Tool executor service not available for nested invocation');
        }
        const result = await orchestrator.executeTool(toolId, params, {
          userId: options.userId,
          organizationId: options.organizationId,
          signal: signal ?? options.signal,
          gatewayId: options.gatewayId ?? undefined,
          scopes: options.scopes,
          runId: options.runId ?? undefined,
          inheritedSecurityPolicy: options.securityPolicy ?? undefined,
          invocation: { depth, budget },
        });
        if (!result.success) {
          throw new Error(result.error ?? 'Nested tool invocation failed');
        }
        return result.data;
      } finally {
        release();
      }
    };
  }

  /**
   * Who a sandbox execution is for, as the pool needs to know it: the
   * organization (the pool caps how many workers and queue entries one
   * organization may hold) and whether this is a nested `tools.invoke`
   * call (which runs on its caller's slot rather than queueing for a new
   * one -- the caller is blocked on it, so queueing would deadlock).
   */
  private sandboxTenancy(
    options: ToolExecutionOptions,
  ): { organizationId: string; nested: boolean } {
    return {
      organizationId: options.organizationId,
      nested: (options.invocation?.depth ?? 0) > 0,
    };
  }

  // ─── Credential hydration for sandbox tools ────────────────────

  private async resolveToolCredentials(
    tool: Tool,
    api: Api | null,
  ): Promise<Record<string, any>> {
    const credentials: Record<string, any> = {};
    try {
      if (api) {
        const credential = await this.credentialRepository.findOne({
          where: { apiId: api.id, organizationId: tool.organizationId, isActive: true },
        });
        if (credential) {
          // Warm the org's DEK before the sync decrypt (no-op for non-KMS orgs).
          await this.envelopeCrypto.warmOrg(credential.organizationId);
          const decrypted = credential.getDecryptedConfig();
          Object.assign(credentials, decrypted);
        }
      }
      if (tool.authConfig?.config) {
        Object.assign(credentials, tool.authConfig.config);
      }
    } catch {
      // Don't fail execution for credential issues — let the
      // sandbox code handle its own auth errors. A missing
      // credential is often expected for tools that fall back
      // to a public API.
    }
    return credentials;
  }
}
