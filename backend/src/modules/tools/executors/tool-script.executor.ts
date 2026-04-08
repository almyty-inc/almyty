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

@Injectable()
export class ToolScriptExecutor {
  private readonly logger = new Logger(ToolScriptExecutor.name);

  constructor(
    @InjectRepository(Credential)
    private readonly credentialRepository: Repository<Credential>,
    private readonly nodeSandbox: NodeSandboxService,
    private readonly sdkCodeAssembler: SdkCodeAssemblerService,
    private readonly moduleRef: ModuleRef,
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
        throw new Error('LLM providers service not available');
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
        error: error.message || 'LLM execution failed',
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
    _options: ToolExecutionOptions,
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
    _options: ToolExecutionOptions,
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
