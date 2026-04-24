import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcErrorCode,
  McpInitializeRequest,
  McpInitializeResult,
  McpCapabilities,
  McpSession,
  McpTool,
  McpCallToolRequest,
  McpReadResourceRequest,
  McpGetPromptRequest,
} from './types/mcp.types';

import { Tool } from '../../entities/tool.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Organization } from '../../entities/organization.entity';
import { ToolsService } from '../tools/tools.service';
import { McpToolHandler } from './services/mcp-tool.handler';
import { McpContentHandler } from './services/mcp-content.handler';
import { McpServerRequestService } from './services/mcp-server-request.service';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly sessions = new Map<string, McpSession>();
  private readonly serverInfo = {
    name: 'almyty',
    version: '1.0.0',
  };

  constructor(
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    private toolsService: ToolsService,
    private toolHandler: McpToolHandler,
    private contentHandler: McpContentHandler,
    private serverRequestService: McpServerRequestService,
  ) {}

  async handleJsonRpc(requestBody: any, organizationId: string, userId?: string, gatewayId?: string): Promise<JsonRpcResponse> {
    try {
      const request = this.validateJsonRpcRequest(requestBody);

      this.logger.debug(`Handling MCP method: ${request.method} for org: ${organizationId}`);

      let result: any;

      switch (request.method) {
        case 'initialize':
          result = await this.handleInitialize(request.params as McpInitializeRequest, organizationId, userId, gatewayId);
          break;

        case 'ping':
          result = {};
          break;

        // Tool methods
        case 'tools/list':
          result = await this.toolHandler.handleToolsList(request.params, organizationId, gatewayId);
          break;

        case 'tools/discover':
          result = await this.toolHandler.handleToolsDiscover(request.params, organizationId, gatewayId);
          break;

        case 'tools/search':
          result = await this.toolHandler.handleToolsSearch(request.params, organizationId, gatewayId);
          break;

        case 'tools/get':
          result = await this.toolHandler.handleToolGet(request.params, organizationId);
          break;

        case 'tools/call':
          result = await this.toolHandler.handleToolCall(request.params as McpCallToolRequest, organizationId, userId);
          break;

        case 'completion/complete':
          result = await this.toolHandler.handleCompletionComplete(request.params, organizationId, gatewayId);
          break;

        // Resource methods
        case 'resources/list':
          result = await this.contentHandler.handleResourcesList(request.params, organizationId);
          break;

        case 'resources/read':
          result = await this.contentHandler.handleResourceRead(request.params as McpReadResourceRequest, organizationId);
          break;

        case 'resources/templates/list':
          result = await this.contentHandler.handleResourceTemplatesList();
          break;

        case 'resources/subscribe':
        case 'resources/unsubscribe':
          result = {};
          break;

        // Prompt methods
        case 'prompts/list':
          result = await this.contentHandler.handlePromptsList(request.params, organizationId);
          break;

        case 'prompts/get':
          result = await this.contentHandler.handlePromptGet(request.params as McpGetPromptRequest, organizationId);
          break;

        // Skills methods
        case 'skills/list':
          result = await this.contentHandler.handleSkillsList(request.params, organizationId, gatewayId);
          break;

        case 'skills/get':
          result = await this.contentHandler.handleSkillGet(request.params, organizationId);
          break;

        // Logging
        case 'logging/setLevel':
          result = {};
          break;

        // Client→server notifications (fire-and-forget, no response per JSON-RPC 2.0)
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/progress':
        case 'notifications/roots/list_changed':
          return null;

        default:
          throw this.createJsonRpcError(
            JsonRpcErrorCode.METHOD_NOT_FOUND,
            `Method not found: ${request.method}`,
            request.id,
          );
      }

      const response: JsonRpcResponse = {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };

      if (gatewayId) {
        await this.bumpGatewayMetrics(gatewayId, organizationId, true);
      }

      return response;

    } catch (error) {
      if (gatewayId) {
        await this.bumpGatewayMetrics(gatewayId, organizationId, false);
      }

      if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
        return {
          jsonrpc: '2.0',
          id: requestBody?.id || null,
          error,
        };
      }

      this.logger.error(`MCP JSON-RPC error: ${error.message}`, error.stack);
      return {
        jsonrpc: '2.0',
        id: requestBody?.id || null,
        error: {
          code: JsonRpcErrorCode.INTERNAL_ERROR,
          message: 'Internal server error',
        },
      };
    }
  }

  private async bumpGatewayMetrics(
    gatewayId: string,
    organizationId: string,
    success: boolean,
  ): Promise<void> {
    try {
      await this.gatewayRepository
        .createQueryBuilder()
        .update(Gateway)
        .set({
          totalRequests: () => '"totalRequests" + 1',
          successfulRequests: success
            ? () => '"successfulRequests" + 1'
            : () => '"successfulRequests"',
          lastRequestAt: new Date(),
        })
        .where('id = :gatewayId', { gatewayId })
        .andWhere('organizationId = :organizationId', { organizationId })
        .execute();
    } catch (metricsError: any) {
      this.logger.error(`Failed to update gateway metrics: ${metricsError.message}`);
    }
  }

  private async handleInitialize(
    params: McpInitializeRequest,
    organizationId: string,
    userId?: string,
    gatewayId?: string,
  ): Promise<McpInitializeResult> {
    const SUPPORTED_VERSIONS = ['2024-11-05', '2025-03-26'];
    if (!params.protocolVersion || params.protocolVersion < '2024-11-05') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_PARAMS,
        `Unsupported protocol version: ${params.protocolVersion}. Supported: ${SUPPORTED_VERSIONS.join(', ')}`,
      );
    }

    const sessionId = uuidv4();
    const session: McpSession = {
      id: sessionId,
      clientInfo: params.clientInfo,
      capabilities: params.capabilities,
      clientCapabilities: params.capabilities as any,
      transport: 'http',
      isInitialized: true,
      createdAt: new Date(),
      lastActivity: new Date(),
      organizationId,
      userId,
    };

    this.sessions.set(sessionId, session);
    this.logger.log(`MCP session initialized: ${sessionId} for org: ${organizationId}`);

    // Resolve gateway name for serverInfo
    let serverName = 'almyty';
    if (gatewayId) {
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });
      if (gateway) {
        serverName = gateway.name;
      }
    }

    const serverCapabilities: McpCapabilities = {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
      completions: {},
      logging: {},
      experimental: {
        almyty: {
          universalApiTranslation: true,
          multiProtocolSupport: ['mcp', 'utcp', 'a2a'],
          apiFormats: ['openapi', 'graphql', 'soap', 'protobuf'],
          progressiveDiscovery: {
            methods: ['tools/discover', 'tools/search', 'tools/get'],
            description: 'Use tools/discover for categories, tools/search for filtered results, tools/get for full schema',
          },
          skills: {
            methods: ['skills/list', 'skills/get'],
            description: 'Generate procedural skill files (YAML frontmatter + markdown) for tools and gateways',
          },
        },
      },
    };

    const negotiatedVersion = params.protocolVersion >= '2025-03-26'
      ? '2025-03-26'
      : '2024-11-05';

    return {
      protocolVersion: negotiatedVersion,
      capabilities: serverCapabilities,
      serverInfo: { name: serverName, version: '1.0.0' },
    };
  }

  private validateJsonRpcRequest(body: any): JsonRpcRequest {
    if (!body || typeof body !== 'object') {
      throw this.createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, 'Invalid request body');
    }

    if (body.jsonrpc !== '2.0') {
      throw this.createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC version');
    }

    if (!body.method || typeof body.method !== 'string') {
      throw this.createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, 'Missing or invalid method');
    }

    const isNotification = body.method.startsWith('notifications/');
    if (!isNotification && body.id === undefined) {
      throw this.createJsonRpcError(JsonRpcErrorCode.INVALID_REQUEST, 'Missing request ID');
    }

    return body as JsonRpcRequest;
  }

  private createJsonRpcError(code: JsonRpcErrorCode, message: string, id?: string | number): JsonRpcError {
    const error = new Error() as any;
    error.code = code;
    error.message = message;
    error.id = id;
    return error;
  }

  // Session Management
  async getSession(sessionId: string): Promise<McpSession | null> {
    return this.sessions.get(sessionId) || null;
  }

  async removeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.logger.log(`MCP session removed: ${sessionId}`);
  }

  async getActiveSessions(organizationId: string): Promise<McpSession[]> {
    return Array.from(this.sessions.values()).filter(
      session => session.organizationId === organizationId,
    );
  }

  async broadcastNotification(
    organizationId: string,
    method: string,
    params?: any,
  ): Promise<void> {
    const sessions = await this.getActiveSessions(organizationId);
    for (const session of sessions) {
      this.logger.debug(`Broadcasting notification ${method} to session ${session.id}`);
    }
  }

  async getToolsAsMcp(organizationId: string): Promise<McpTool[]> {
    const { tools } = await this.toolsService.getTools({ organizationId });

    return tools.map(tool => ({
      name: tool.name,
      description: tool.description || `AI tool generated from ${tool.metadata?.sourceApi?.name || 'API'}`,
      inputSchema: tool.parameters || {
        type: 'object',
        properties: {},
        description: tool.description,
      },
    }));
  }

  // Server-to-client requests
  get serverRequests(): McpServerRequestService {
    return this.serverRequestService;
  }

  async healthCheck(): Promise<{
    status: string;
    activeSessions: number;
    serverInfo: any;
  }> {
    return {
      status: 'healthy',
      activeSessions: this.sessions.size,
      serverInfo: this.serverInfo,
    };
  }
}
