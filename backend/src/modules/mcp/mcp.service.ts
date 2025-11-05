import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
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
  McpToolsListResult,
  McpCallToolRequest,
  McpCallToolResult,
  McpResource,
  McpResourcesListResult,
  McpReadResourceRequest,
  McpReadResourceResult,
  McpPrompt,
  McpPromptsListResult,
  McpGetPromptRequest,
  McpGetPromptResult,
  McpContent,
  McpTextContent,
} from './types/mcp.types';

import { Tool } from '../../entities/tool.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';
import { ToolsService } from '../tools/tools.service';
import { ToolExecutorService, ToolExecutionResult } from '../tools/tool-executor.service';

@Injectable()
export class McpService {
  private readonly logger = new Logger(McpService.name);
  private readonly sessions = new Map<string, McpSession>();
  private readonly serverInfo = {
    name: 'apifai',
    version: '1.0.0',
  };

  constructor(
    @InjectRepository(Tool)
    private toolRepository: Repository<Tool>,
    @InjectRepository(Resource) 
    private resourceRepository: Repository<Resource>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    private toolsService: ToolsService,
    private toolExecutorService: ToolExecutorService,
  ) {}

  // Core JSON-RPC Handler
  async handleJsonRpc(requestBody: any, organizationId: string, userId?: string): Promise<JsonRpcResponse> {
    try {
      const request = this.validateJsonRpcRequest(requestBody);
      
      this.logger.debug(`Handling MCP method: ${request.method} for org: ${organizationId}`);
      
      let result: any;
      
      switch (request.method) {
        case 'initialize':
          result = await this.handleInitialize(request.params as McpInitializeRequest, organizationId, userId);
          break;
          
        case 'ping':
          result = await this.handlePing();
          break;
          
        case 'tools/list':
          result = await this.handleToolsList(request.params, organizationId);
          break;
          
        case 'tools/call':
          result = await this.handleToolCall(request.params as McpCallToolRequest, organizationId, userId);
          break;
          
        case 'resources/list':
          result = await this.handleResourcesList(request.params, organizationId);
          break;
          
        case 'resources/read':
          result = await this.handleResourceRead(request.params as McpReadResourceRequest, organizationId);
          break;
          
        case 'prompts/list':
          result = await this.handlePromptsList(request.params, organizationId);
          break;
          
        case 'prompts/get':
          result = await this.handlePromptGet(request.params as McpGetPromptRequest, organizationId);
          break;
          
        default:
          throw this.createJsonRpcError(
            JsonRpcErrorCode.METHOD_NOT_FOUND,
            `Method not found: ${request.method}`,
            request.id
          );
      }
      
      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
      
    } catch (error) {
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
          data: error.message,
        },
      };
    }
  }

  // MCP Protocol Handlers
  private async handleInitialize(
    params: McpInitializeRequest,
    organizationId: string,
    userId?: string,
  ): Promise<McpInitializeResult> {
    // Validate protocol version
    if (!params.protocolVersion || params.protocolVersion < '2024-11-05') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_PARAMS,
        'Unsupported protocol version',
      );
    }

    // Create session
    const sessionId = uuidv4();
    const session: McpSession = {
      id: sessionId,
      clientInfo: params.clientInfo,
      capabilities: params.capabilities,
      transport: 'http',
      isInitialized: true,
      createdAt: new Date(),
      lastActivity: new Date(),
      organizationId,
      userId,
    };

    this.sessions.set(sessionId, session);

    this.logger.log(`MCP session initialized: ${sessionId} for org: ${organizationId}`);

    // Return server capabilities
    const serverCapabilities: McpCapabilities = {
      tools: {
        listChanged: true,
      },
      resources: {
        subscribe: false,
        listChanged: true,
      },
      prompts: {
        listChanged: true,
      },
      logging: {},
      experimental: {
        apifai: {
          universalApiTranslation: true,
          multiProtocolSupport: ['mcp', 'utcp', 'a2a'],
          apiFormats: ['openapi', 'graphql', 'soap', 'protobuf'],
        },
      },
    };

    return {
      protocolVersion: '2024-11-05',
      capabilities: serverCapabilities,
      serverInfo: this.serverInfo,
    };
  }

  private async handlePing(): Promise<{}> {
    return {};
  }

  private async handleToolsList(params: any, organizationId: string): Promise<McpToolsListResult> {
    const { tools } = await this.toolsService.getTools({ organizationId });
    
    const mcpTools: McpTool[] = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters || {
        type: 'object',
        properties: {},
      },
    }));

    return {
      tools: mcpTools,
    };
  }

  private async handleToolCall(
    params: McpCallToolRequest,
    organizationId: string,
    userId?: string,
  ): Promise<McpCallToolResult> {
    if (!params.name) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_PARAMS,
        'Tool name is required',
      );
    }

    // Find the tool
    const tool = await this.toolsService.findByName(params.name, organizationId);
    if (!tool) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.TOOL_NOT_FOUND,
        `Tool not found: ${params.name}`,
      );
    }

    try {
      // Execute the tool using our existing tool execution service
      const result = await this.toolExecutorService.executeTool(
        tool.id,
        params.arguments || {},
        {
          userId: userId || 'mcp-session',
          organizationId,
        }
      );

      // Convert result to MCP content format
      const content: McpContent[] = [
        {
          type: 'text',
          text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2),
        } as McpTextContent,
      ];

      return {
        content,
        isError: !result.success,
      };
    } catch (error) {
      const content: McpContent[] = [
        {
          type: 'text',
          text: `Tool execution failed: ${error.message}`,
        } as McpTextContent,
      ];

      return {
        content,
        isError: true,
      };
    }
  }

  private async handleResourcesList(params: any, organizationId: string): Promise<McpResourcesListResult> {
    // Get resources from APIs in this organization
    const resources = await this.resourceRepository.find({
      where: {
        api: {
          organizationId,
        },
      },
      relations: ['api'],
    });

    const mcpResources: McpResource[] = resources.map(resource => ({
      uri: `apifai://resources/${resource.id}`,
      name: resource.name,
      description: resource.description,
      mimeType: 'application/json',
    }));

    return {
      resources: mcpResources,
    };
  }

  private async handleResourceRead(
    params: McpReadResourceRequest,
    organizationId: string,
  ): Promise<McpReadResourceResult> {
    // Extract resource ID from URI
    const match = params.uri.match(/apifai:\/\/resources\/(.+)/);
    if (!match) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.RESOURCE_NOT_FOUND,
        'Invalid resource URI format',
      );
    }

    const resourceId = match[1];
    const resource = await this.resourceRepository.findOne({
      where: {
        id: resourceId,
        api: {
          organizationId,
        },
      },
      relations: ['api'],
    });

    if (!resource) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.RESOURCE_NOT_FOUND,
        'Resource not found',
      );
    }

    const content: McpContent[] = [
      {
        type: 'text',
        text: JSON.stringify(resource.schema || resource.properties, null, 2),
      } as McpTextContent,
    ];

    return {
      contents: content,
    };
  }

  private async handlePromptsList(params: any, organizationId: string): Promise<McpPromptsListResult> {
    // For now, return empty prompts - we can enhance this later
    return {
      prompts: [],
    };
  }

  private async handlePromptGet(
    params: McpGetPromptRequest,
    organizationId: string,
  ): Promise<McpGetPromptResult> {
    throw this.createJsonRpcError(
      JsonRpcErrorCode.METHOD_NOT_FOUND,
      'Prompts not implemented yet',
    );
  }

  // Utility Methods
  private validateJsonRpcRequest(body: any): JsonRpcRequest {
    if (!body || typeof body !== 'object') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_REQUEST,
        'Invalid request body',
      );
    }

    if (body.jsonrpc !== '2.0') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_REQUEST,
        'Invalid JSON-RPC version',
      );
    }

    if (!body.method || typeof body.method !== 'string') {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_REQUEST,
        'Missing or invalid method',
      );
    }

    if (body.id === undefined) {
      throw this.createJsonRpcError(
        JsonRpcErrorCode.INVALID_REQUEST,
        'Missing request ID',
      );
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
      session => session.organizationId === organizationId
    );
  }

  // Notification Broadcasting  
  async broadcastNotification(
    organizationId: string,
    method: string,
    params?: any,
  ): Promise<void> {
    const sessions = await this.getActiveSessions(organizationId);
    
    for (const session of sessions) {
      // In a real implementation, we'd send this to the client via their transport
      this.logger.debug(`Broadcasting notification ${method} to session ${session.id}`);
    }
  }

  // Convert our tools to MCP format
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

  // Health check
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