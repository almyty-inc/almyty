/**
 * SystemToolExecutor — dispatches system/internal tool calls to the
 * appropriate NestJS service method.
 *
 * System tools are regular Tool rows with `isSystemTool=true`. They
 * live in the database like any other tool and are served via the
 * normal MCP/gateway infrastructure. The only difference is that
 * when ToolExecutorService encounters one, it delegates here instead
 * of making an HTTP call or running sandboxed JS.
 *
 * Each tool's `metadata.managementAction` string maps to a handler
 * method below. Services are resolved lazily via ModuleRef to avoid
 * circular dependency issues (tools module <-> apis/gateways/agents).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { Tool } from '../../../entities/tool.entity';
import { ToolExecutionOptions, ToolExecutionResult } from '../tool-execution.types';

@Injectable()
export class SystemToolExecutor {
  private readonly logger = new Logger(SystemToolExecutor.name);

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * Returns true if this tool should be handled by the system executor.
   */
  canHandle(tool: Tool): boolean {
    return tool.isSystemTool === true;
  }

  /**
   * Execute a system tool by routing to the internal service method.
   */
  async execute(
    tool: Tool,
    parameters: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const action = tool.metadata?.managementAction || tool.name;

    this.logger.debug(
      `Executing system tool: ${action} for org=${options.organizationId}`,
    );

    try {
      const data = await this.dispatch(action, parameters, options);

      return {
        success: true,
        data,
        executionTime: Date.now() - startTime,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };
    } catch (error: any) {
      this.logger.error(
        `System tool '${action}' failed: ${error.message}`,
        error.stack,
      );

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

  // ─── Dispatch ──────────────────────────────────────────────────

  private async dispatch(
    action: string,
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    switch (action) {
      case 'list_apis':
        return this.handleListApis(params, options);
      case 'create_api':
        return this.handleCreateApi(params, options);
      case 'import_schema':
        return this.handleImportSchema(params, options);
      case 'list_tools':
        return this.handleListTools(params, options);
      case 'list_gateways':
        return this.handleListGateways(params, options);
      case 'create_gateway':
        return this.handleCreateGateway(params, options);
      case 'list_agents':
        return this.handleListAgents(params, options);
      case 'create_agent':
        return this.handleCreateAgent(params, options);
      case 'invoke_agent':
        return this.handleInvokeAgent(params, options);
      case 'add_provider':
        return this.handleAddProvider(params, options);
      default:
        throw new Error(`Unknown system tool action: ${action}`);
    }
  }

  // ─── Service resolution (lazy, avoids circular deps) ──────────

  private getService<T>(token: any): T {
    return this.moduleRef.get(token, { strict: false });
  }

  private get apisService() {
    // Lazy import to break the circular dependency chain.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ApisService } = require('../../apis/apis.service');
    return this.getService(ApisService);
  }

  private get toolsService() {
    const { ToolsService } = require('../tools.service');
    return this.getService(ToolsService);
  }

  private get gatewaysService() {
    const { GatewaysService } = require('../../gateways/gateways.service');
    return this.getService(GatewaysService);
  }

  private get agentsService() {
    const { AgentsService } = require('../../agents/agents.service');
    return this.getService(AgentsService);
  }

  private get agentExecutionEngine() {
    const { AgentExecutionEngine } = require('../../agents/agent-execution.engine');
    return this.getService(AgentExecutionEngine);
  }

  private get llmProvidersService() {
    const { LlmProvidersService } = require('../../llm-providers/llm-providers.service');
    return this.getService(LlmProvidersService);
  }

  // ─── Handlers ─────────────────────────────────────────────────

  private async handleListApis(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const service: any = this.apisService;
    const result = await service.findAllByOrganization(
      options.organizationId,
      {
        page: params.page || 1,
        limit: params.limit || 20,
      },
    );
    return {
      apis: result.apis.map((api: any) => ({
        id: api.id,
        name: api.name,
        description: api.description,
        type: api.type,
        baseUrl: api.baseUrl,
        status: api.status,
        operationCount: api.operations?.length || 0,
      })),
      total: result.total,
    };
  }

  private async handleCreateApi(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const service: any = this.apisService;
    const typeMap: Record<string, string> = {
      rest: 'openapi',
      graphql: 'graphql',
      soap: 'soap',
      grpc: 'grpc',
    };
    const api = await service.create({
      name: params.name,
      type: typeMap[params.type] || params.type,
      baseUrl: params.baseUrl,
      description: params.description,
      organizationId: options.organizationId,
    });
    return {
      id: api.id,
      name: api.name,
      type: api.type,
      baseUrl: api.baseUrl,
      status: api.status,
    };
  }

  private async handleImportSchema(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const service: any = this.apisService;

    let schemaContent = params.schemaContent;
    if (!schemaContent && params.schemaUrl) {
      schemaContent = await service.fetchSchemaFromUrl(params.schemaUrl);
    }

    if (!schemaContent) {
      throw new Error('Either schemaUrl or schemaContent must be provided');
    }

    const result = await service.importSchema(
      params.apiId,
      options.organizationId,
      schemaContent,
      params.format,
    );

    // Also generate tools from the imported schema
    const tools = await service.generateToolsFromApi(
      params.apiId,
      options.organizationId,
    );

    return {
      schema: {
        id: result?.id,
        format: result?.format,
        operationCount: result?.operations?.length || 0,
      },
      generatedTools: tools?.length || 0,
    };
  }

  private async handleListTools(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const service: any = this.toolsService;
    const result = await service.getTools({
      organizationId: options.organizationId,
      search: params.search,
      status: params.status,
      page: params.page || 1,
      limit: params.limit || 20,
    });
    return {
      tools: result.tools.map((t: any) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        type: t.type,
        status: t.status,
        usageCount: t.usageCount,
        isSystemTool: t.isSystemTool,
      })),
      total: result.total,
      page: result.page,
    };
  }

  private async handleListGateways(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const service: any = this.gatewaysService;
    const result = await service.getGateways({
      organizationId: options.organizationId,
      search: params.search,
      type: params.type,
      page: params.page || 1,
      limit: params.limit || 20,
    });
    return {
      gateways: result.gateways.map((g: any) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        kind: g.kind,
        type: g.type,
        status: g.status,
        endpoint: g.endpoint,
        isSystem: g.isSystem,
        toolCount: g.tools?.length || 0,
      })),
      total: result.total,
    };
  }

  private async handleCreateGateway(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const service: any = this.gatewaysService;
    const gateway = await service.createGateway(
      {
        name: params.name,
        type: params.type,
        endpoint: params.endpoint,
        description: params.description,
        configuration: {},
      },
      options.organizationId,
      options.userId,
    );
    return {
      id: gateway.id,
      name: gateway.name,
      type: gateway.type,
      endpoint: gateway.endpoint,
      status: gateway.status,
    };
  }

  private async handleListAgents(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const service: any = this.agentsService;
    const result = await service.getAgents({
      organizationId: options.organizationId,
      search: params.search,
      page: params.page || 1,
      limit: params.limit || 20,
    });
    return {
      agents: result.agents.map((a: any) => ({
        id: a.id,
        name: a.name,
        description: a.description,
        status: a.status,
        mode: a.mode,
      })),
      total: result.total,
    };
  }

  private async handleCreateAgent(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const service: any = this.agentsService;
    const agent = await service.createAgent(
      {
        name: params.name,
        description: params.description,
        instructions: params.systemPrompt,
        modelConfig: params.llmProviderId || params.model
          ? {
              providerId: params.llmProviderId,
              model: params.model,
            }
          : undefined,
      },
      options.organizationId,
      options.userId,
    );
    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      mode: agent.mode,
    };
  }

  private async handleInvokeAgent(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const agentsService: any = this.agentsService;
    const engine: any = this.agentExecutionEngine;

    const agent = await agentsService.getAgent(
      params.agentId,
      options.organizationId,
    );

    const execution = await engine.execute(
      agent,
      options.organizationId,
      options.userId,
      { input: { message: params.input } },
    );

    return {
      executionId: execution.id,
      status: execution.status,
      output: execution.output,
    };
  }

  private async handleAddProvider(
    params: Record<string, any>,
    options: ToolExecutionOptions,
  ): Promise<any> {
    const service: any = this.llmProvidersService;
    const provider = await service.createProvider(
      {
        name: params.name,
        type: params.type,
        apiKey: params.apiKey,
        baseUrl: params.baseUrl,
      },
      options.organizationId,
      options.userId,
    );
    return {
      id: provider.id,
      name: provider.name,
      type: provider.type,
      status: provider.status,
    };
  }
}
