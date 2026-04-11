/**
 * SystemGatewayService — provisions the built-in "almyty" MCP gateway
 * that exposes the platform management API as MCP tools.
 *
 * When an organization is created, `provisionSystemGateway()` creates:
 *   1. A real Gateway row (isSystem=true, type=MCP, endpoint=/almyty)
 *   2. A set of Tool rows (isSystemTool=true) that map to internal
 *      service methods (list_apis, create_gateway, invoke_agent, etc.)
 *   3. GatewayTool associations linking each tool to the gateway
 *
 * Because the tools are real DB rows, the existing MCP serving
 * infrastructure (McpService.handleToolsList, handleToolCall) picks
 * them up automatically — no special-case code in the protocol layer.
 *
 * Tool execution is handled by the ToolExecutorService. System tools
 * use executionMethod=null (no HTTP/GraphQL/etc.) and are identified
 * by `isSystemTool=true`. The SystemToolExecutor (registered in the
 * ToolExecutorService dispatch chain) intercepts these and routes
 * them to the appropriate internal service method.
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Gateway, GatewayType, GatewayKind } from '../../entities/gateway.entity';
import { Tool, ToolType, ToolStatus, ToolExecutionMethod } from '../../entities/tool.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewaysService } from './gateways.service';

/** Describes a single management tool to register. */
interface SystemToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

/** The canonical list of management tools exposed on the system gateway. */
const SYSTEM_TOOLS: SystemToolDefinition[] = [
  {
    name: 'list_apis',
    description: 'List all connected APIs in the organization',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional search query to filter APIs by name' },
        page: { type: 'number', description: 'Page number (default 1)' },
        limit: { type: 'number', description: 'Results per page (default 20, max 100)' },
      },
    },
  },
  {
    name: 'create_api',
    description: 'Connect a new API to the organization. Provide the API name, type, and base URL.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the API connection' },
        type: { type: 'string', enum: ['rest', 'graphql', 'soap', 'grpc'], description: 'API type' },
        baseUrl: { type: 'string', description: 'Base URL of the API' },
        description: { type: 'string', description: 'Optional description' },
      },
      required: ['name', 'type', 'baseUrl'],
    },
  },
  {
    name: 'import_schema',
    description: 'Import an API schema (OpenAPI, GraphQL SDL, WSDL, Protobuf) and auto-generate tools from it',
    parameters: {
      type: 'object',
      properties: {
        apiId: { type: 'string', description: 'ID of the API to import the schema for' },
        schemaUrl: { type: 'string', description: 'URL to fetch the schema from (provide this OR schemaContent)' },
        schemaContent: { type: 'string', description: 'Raw schema content (provide this OR schemaUrl)' },
        format: { type: 'string', enum: ['openapi', 'graphql', 'wsdl', 'protobuf'], description: 'Schema format (auto-detected if not provided)' },
      },
      required: ['apiId'],
    },
  },
  {
    name: 'list_tools',
    description: 'List all tools in the organization',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional search query to filter tools' },
        status: { type: 'string', enum: ['active', 'draft', 'inactive'], description: 'Filter by status' },
        page: { type: 'number', description: 'Page number (default 1)' },
        limit: { type: 'number', description: 'Results per page (default 20, max 100)' },
      },
    },
  },
  {
    name: 'list_gateways',
    description: 'List all gateways in the organization',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional search query to filter gateways' },
        type: { type: 'string', enum: ['mcp', 'a2a', 'utcp', 'skills'], description: 'Filter by gateway type' },
        page: { type: 'number', description: 'Page number (default 1)' },
        limit: { type: 'number', description: 'Results per page (default 20, max 100)' },
      },
    },
  },
  {
    name: 'create_gateway',
    description: 'Create a new gateway to serve tools or agents via MCP, A2A, UTCP, or Skills protocols',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the gateway' },
        type: { type: 'string', enum: ['mcp', 'a2a', 'utcp', 'skills'], description: 'Gateway protocol type' },
        endpoint: { type: 'string', description: 'URL path for the gateway (e.g. /my-gateway)' },
        description: { type: 'string', description: 'Optional description' },
      },
      required: ['name', 'type', 'endpoint'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all agents in the organization',
    parameters: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional search query to filter agents' },
        page: { type: 'number', description: 'Page number (default 1)' },
        limit: { type: 'number', description: 'Results per page (default 20, max 100)' },
      },
    },
  },
  {
    name: 'create_agent',
    description: 'Create a new AI agent with a name, model, and optional system prompt',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the agent' },
        description: { type: 'string', description: 'What the agent does' },
        systemPrompt: { type: 'string', description: 'System prompt / instructions for the agent' },
        llmProviderId: { type: 'string', description: 'ID of the LLM provider to use' },
        model: { type: 'string', description: 'Model name (e.g. gpt-4, claude-3-opus)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'invoke_agent',
    description: 'Run an agent with the given input and return its response',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'ID of the agent to invoke' },
        input: { type: 'string', description: 'The input/prompt to send to the agent' },
      },
      required: ['agentId', 'input'],
    },
  },
  {
    name: 'add_provider',
    description: 'Add an LLM provider (OpenAI, Anthropic, etc.) by supplying an API key',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the provider' },
        type: { type: 'string', enum: ['openai', 'anthropic', 'azure_openai', 'google', 'custom'], description: 'Provider type' },
        apiKey: { type: 'string', description: 'API key for the provider' },
        baseUrl: { type: 'string', description: 'Custom base URL (optional, for self-hosted or Azure)' },
      },
      required: ['name', 'type', 'apiKey'],
    },
  },
];

@Injectable()
export class SystemGatewayService {
  private readonly logger = new Logger(SystemGatewayService.name);

  constructor(
    private readonly gatewaysService: GatewaysService,
    @InjectRepository(Tool)
    private readonly toolRepository: Repository<Tool>,
    @InjectRepository(GatewayTool)
    private readonly gatewayToolRepository: Repository<GatewayTool>,
  ) {}

  /**
   * Provision the system gateway and its management tools for an organization.
   * Safe to call multiple times — idempotent by endpoint uniqueness.
   */
  async provisionSystemGateway(organizationId: string): Promise<Gateway> {
    this.logger.log(`Provisioning system gateway for org=${organizationId}`);

    // 1. Create (or re-use) the system gateway
    const gateway = await this.gatewaysService.createSystemGateway(
      {
        name: 'almyty',
        description: 'Built-in management gateway — manage APIs, tools, gateways, and agents via MCP',
        type: GatewayType.MCP,
        kind: GatewayKind.TOOL,
        endpoint: '/almyty',
        configuration: { transport: 'http', system: true },
      },
      organizationId,
    );

    // 2. Register the management tools (idempotent — skips existing)
    await this.registerSystemTools(gateway.id, organizationId);

    this.logger.log(`System gateway provisioned: id=${gateway.id}, org=${organizationId}`);
    return gateway;
  }

  /**
   * Create Tool rows for each management tool and link them to the gateway.
   * Uses upsert-by-name logic so re-running is safe.
   */
  private async registerSystemTools(gatewayId: string, organizationId: string): Promise<void> {
    for (const def of SYSTEM_TOOLS) {
      // Check if the tool already exists for this org
      let tool = await this.toolRepository.findOne({
        where: { name: def.name, organizationId, isSystemTool: true },
      });

      if (!tool) {
        tool = this.toolRepository.create({
          name: def.name,
          description: def.description,
          type: ToolType.FUNCTION,
          executionMethod: ToolExecutionMethod.INTERNAL,
          parameters: def.parameters,
          organizationId,
          status: ToolStatus.ACTIVE,
          version: '1.0.0',
          createdBy: 'system',
          isSystemTool: true,
          metadata: {
            systemTool: true,
            managementAction: def.name,
          },
        });
        tool = await this.toolRepository.save(tool);
        this.logger.debug(`Created system tool: ${def.name} (id=${tool.id})`);
      }

      // Link tool to gateway if not already linked
      const existingLink = await this.gatewayToolRepository.findOne({
        where: { gatewayId, toolId: tool.id },
      });

      if (!existingLink) {
        const gatewayTool = this.gatewayToolRepository.create({
          gatewayId,
          toolId: tool.id,
          isActive: true,
          metadata: { systemTool: true },
        });
        await this.gatewayToolRepository.save(gatewayTool);
        this.logger.debug(`Linked system tool ${def.name} to gateway ${gatewayId}`);
      }
    }
  }
}
