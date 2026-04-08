import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as WebSocket from 'ws';

import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { ToolExecutorService, ToolExecutionOptions, ToolExecutionResult } from '../tools/tool-executor.service';

export interface ProtocolRequest {
  gatewayId: string;
  method: string;
  params?: any;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: any;
  userId?: string;
  userRoles?: string[];
  userOrg?: string;
  scopes?: string[];
}

export interface ProtocolResponse {
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata?: Record<string, any>;
}

// MCP (Model Context Protocol) interfaces
export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

// A2A (Agent-to-Agent) interfaces
export interface A2AMessage {
  messageId: string;
  conversationId?: string;
  agentId: string;
  intent: string;
  content: {
    type: 'text' | 'tool_call' | 'tool_result' | 'capability_request';
    data: any;
  };
  metadata?: {
    timestamp: string;
    priority?: 'low' | 'normal' | 'high';
    capabilities?: string[];
    context?: Record<string, any>;
  };
}

export interface A2AResponse {
  messageId: string;
  conversationId?: string;
  responseToId: string;
  agentId: string;
  content: {
    type: 'text' | 'tool_result' | 'capability_response' | 'error';
    data: any;
  };
  metadata?: Record<string, any>;
}

// UTCP (Universal Tool Call Protocol) interfaces
export interface UTCPRequest {
  version: '1.0';
  requestId: string;
  toolName: string;
  parameters: Record<string, any>;
  context?: {
    userId?: string;
    sessionId?: string;
    metadata?: Record<string, any>;
  };
}

export interface UTCPResponse {
  version: '1.0';
  requestId: string;
  status: 'success' | 'error';
  result?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata?: {
    executionTime: number;
    cached: boolean;
    retryCount: number;
  };
}

@Injectable()
export class GatewayProtocolService {
  private readonly logger = new Logger(GatewayProtocolService.name);
  private websocketConnections = new Map<string, WebSocket>();

  constructor(
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    private toolExecutorService: ToolExecutorService,
  ) {}

  async handleProtocolRequest(request: ProtocolRequest): Promise<ProtocolResponse> {
    try {
      const gateway = await this.gatewayRepository.findOne({
        where: { id: request.gatewayId },
        relations: ['tools', 'tools.tool', 'authConfigs'],
      });

      if (!gateway) {
        return {
          success: false,
          error: {
            code: 'GATEWAY_NOT_FOUND',
            message: 'Gateway not found',
          },
        };
      }

      if (!gateway.canAcceptRequests()) {
        return {
          success: false,
          error: {
            code: 'GATEWAY_UNAVAILABLE',
            message: 'Gateway is not available',
          },
        };
      }

      // Route to appropriate protocol handler
      let response: ProtocolResponse;
      switch (gateway.type) {
        case GatewayType.MCP:
          response = await this.handleMCPRequest(gateway, request);
          break;
        case GatewayType.A2A:
          response = await this.handleA2ARequest(gateway, request);
          break;
        case GatewayType.UTCP:
          response = await this.handleUTCPRequest(gateway, request);
          break;
        default:
          return {
            success: false,
            error: {
              code: 'UNSUPPORTED_PROTOCOL',
              message: `Unsupported gateway type: ${gateway.type}`,
            },
          };
      }

      // Update gateway request metrics via an atomic SQL UPDATE
      // rather than the previous read-modify-write (load the entity,
      // call incrementRequest, save). Concurrent requests against
      // the same gateway used to lose increments under the race.
      try {
        const success = response.success;
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
          .where('id = :id', { id: gateway.id })
          .execute();
      } catch (metricsError) {
        this.logger.error(`Failed to update gateway metrics: ${metricsError.message}`);
      }

      return response;
    } catch (error) {
      this.logger.error(`Protocol request error: ${error.message}`, error.stack);
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: error.message,
        },
      };
    }
  }

  private async handleMCPRequest(gateway: Gateway, request: ProtocolRequest): Promise<ProtocolResponse> {
    try {
      const mcpRequest = request.body as MCPRequest;
      
      if (!mcpRequest.jsonrpc || mcpRequest.jsonrpc !== '2.0') {
        return this.createMCPErrorResponse(mcpRequest?.id, -32600, 'Invalid Request', 'Invalid JSON-RPC version');
      }

      switch (mcpRequest.method) {
        case 'tools/list':
          return this.handleMCPToolsList(gateway, mcpRequest);
        case 'tools/call':
          return this.handleMCPToolCall(gateway, mcpRequest, request);
        case 'capabilities':
          return this.handleMCPCapabilities(gateway, mcpRequest);
        default:
          return this.createMCPErrorResponse(mcpRequest.id, -32601, 'Method not found', `Unknown method: ${mcpRequest.method}`);
      }
    } catch (error) {
      return this.createMCPErrorResponse(null, -32603, 'Internal error', error.message);
    }
  }

  private async handleA2ARequest(gateway: Gateway, request: ProtocolRequest): Promise<ProtocolResponse> {
    try {
      const a2aMessage = request.body as A2AMessage;
      
      if (!a2aMessage.messageId || !a2aMessage.agentId) {
        return {
          success: false,
          error: {
            code: 'INVALID_MESSAGE',
            message: 'Missing required fields: messageId or agentId',
          },
        };
      }

      switch (a2aMessage.content.type) {
        case 'tool_call':
          return this.handleA2AToolCall(gateway, a2aMessage, request);
        case 'capability_request':
          return this.handleA2ACapabilityRequest(gateway, a2aMessage);
        default:
          return {
            success: false,
            error: {
              code: 'UNSUPPORTED_CONTENT_TYPE',
              message: `Unsupported content type: ${a2aMessage.content.type}`,
            },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'A2A_PROCESSING_ERROR',
          message: error.message,
        },
      };
    }
  }

  private async handleUTCPRequest(gateway: Gateway, request: ProtocolRequest): Promise<ProtocolResponse> {
    try {
      const utcpRequest = request.body as UTCPRequest;
      
      if (!utcpRequest.version || !utcpRequest.requestId || !utcpRequest.toolName) {
        return {
          success: false,
          error: {
            code: 'INVALID_UTCP_REQUEST',
            message: 'Missing required fields: version, requestId, or toolName',
          },
        };
      }

      // Find the tool
      const gatewayTool = gateway.tools.find(gt => gt.getEffectiveName() === utcpRequest.toolName && gt.isActive);
      
      if (!gatewayTool) {
        const utcpResponse: UTCPResponse = {
          version: utcpRequest.version,
          requestId: utcpRequest.requestId,
          status: 'error',
          error: {
            code: 'TOOL_NOT_FOUND',
            message: `Tool '${utcpRequest.toolName}' not found`,
          },
        };
        return { success: true, data: utcpResponse };
      }

      // Execute the tool
      const executionOptions: ToolExecutionOptions = {
        userId: request.userId || 'system',
        organizationId: gateway.organizationId,
        timeout: gatewayTool.getEffectiveTimeout(),
        retries: gatewayTool.getEffectiveRetries(),
      };

      const result = await this.toolExecutorService.executeTool(
        gatewayTool.toolId,
        utcpRequest.parameters,
        executionOptions
      );

      const utcpResponse: UTCPResponse = {
        version: utcpRequest.version,
        requestId: utcpRequest.requestId,
        status: result.success ? 'success' : 'error',
        result: result.success ? result.data : undefined,
        error: result.success ? undefined : {
          code: 'EXECUTION_FAILED',
          message: result.error || 'Tool execution failed',
        },
        metadata: {
          executionTime: result.executionTime,
          cached: result.cached,
          retryCount: result.retryCount,
        },
      };

      return { success: true, data: utcpResponse };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'UTCP_PROCESSING_ERROR',
          message: error.message,
        },
      };
    }
  }


  private async handleMCPToolsList(gateway: Gateway, mcpRequest: MCPRequest): Promise<ProtocolResponse> {
    const tools: MCPToolDefinition[] = gateway.getActiveTools().map(gatewayTool => ({
      name: gatewayTool.getEffectiveName(),
      description: gatewayTool.getEffectiveDescription(),
      inputSchema: gatewayTool.getEffectiveParameters(),
    }));

    const mcpResponse: MCPResponse = {
      jsonrpc: '2.0',
      id: mcpRequest.id,
      result: { tools },
    };

    return { success: true, data: mcpResponse };
  }

  private async handleMCPToolCall(gateway: Gateway, mcpRequest: MCPRequest, request: ProtocolRequest): Promise<ProtocolResponse> {
    const { name, arguments: args } = mcpRequest.params;
    
    if (!name) {
      return this.createMCPErrorResponse(mcpRequest.id, -32602, 'Invalid params', 'Missing tool name');
    }

    const gatewayTool = gateway.tools.find(gt => gt.getEffectiveName() === name && gt.isActive);
    
    if (!gatewayTool) {
      return this.createMCPErrorResponse(mcpRequest.id, -32602, 'Invalid params', `Tool '${name}' not found`);
    }

    try {
      const executionOptions: ToolExecutionOptions = {
        userId: request.userId || 'system',
        organizationId: gateway.organizationId,
        timeout: gatewayTool.getEffectiveTimeout(),
        retries: gatewayTool.getEffectiveRetries(),
      };

      const result = await this.toolExecutorService.executeTool(
        gatewayTool.toolId,
        args || {},
        executionOptions
      );

      const mcpResponse: MCPResponse = {
        jsonrpc: '2.0',
        id: mcpRequest.id,
        result: result.success ? {
          content: [
            {
              type: 'text',
              text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2),
            },
          ],
        } : undefined,
        error: result.success ? undefined : {
          code: -32603,
          message: 'Tool execution failed',
          data: result.error,
        },
      };

      return { success: true, data: mcpResponse };
    } catch (error) {
      return this.createMCPErrorResponse(mcpRequest.id, -32603, 'Internal error', error.message);
    }
  }

  private async handleMCPCapabilities(gateway: Gateway, mcpRequest: MCPRequest): Promise<ProtocolResponse> {
    const capabilities = {
      tools: {
        listChanged: false,
      },
      resources: {
        subscribe: false,
        listChanged: false,
      },
      prompts: {
        listChanged: false,
      },
      logging: {
        level: 'info',
      },
      ...gateway.configuration.capabilities,
    };

    const mcpResponse: MCPResponse = {
      jsonrpc: '2.0',
      id: mcpRequest.id,
      result: { capabilities },
    };

    return { success: true, data: mcpResponse };
  }

  private async handleA2AToolCall(gateway: Gateway, a2aMessage: A2AMessage, request: ProtocolRequest): Promise<ProtocolResponse> {
    const { toolName, parameters } = a2aMessage.content.data;
    
    if (!toolName) {
      return this.createA2AErrorResponse(a2aMessage, 'MISSING_TOOL_NAME', 'Tool name is required');
    }

    const gatewayTool = gateway.tools.find(gt => gt.getEffectiveName() === toolName && gt.isActive);
    
    if (!gatewayTool) {
      return this.createA2AErrorResponse(a2aMessage, 'TOOL_NOT_FOUND', `Tool '${toolName}' not found`);
    }

    try {
      const executionOptions: ToolExecutionOptions = {
        userId: request.userId || a2aMessage.agentId,
        organizationId: gateway.organizationId,
        timeout: gatewayTool.getEffectiveTimeout(),
        retries: gatewayTool.getEffectiveRetries(),
      };

      const result = await this.toolExecutorService.executeTool(
        gatewayTool.toolId,
        parameters || {},
        executionOptions
      );

      const a2aResponse: A2AResponse = {
        messageId: this.generateMessageId(),
        conversationId: a2aMessage.conversationId,
        responseToId: a2aMessage.messageId,
        agentId: 'tool-gateway',
        content: {
          type: 'tool_result',
          data: {
            success: result.success,
            result: result.data,
            error: result.error,
            executionTime: result.executionTime,
          },
        },
        metadata: {
          timestamp: new Date().toISOString(),
          cached: result.cached,
          retryCount: result.retryCount,
        },
      };

      return { success: true, data: a2aResponse };
    } catch (error) {
      return this.createA2AErrorResponse(a2aMessage, 'EXECUTION_ERROR', error.message);
    }
  }

  private async handleA2ACapabilityRequest(gateway: Gateway, a2aMessage: A2AMessage): Promise<ProtocolResponse> {
    const capabilities = {
      tools: gateway.getActiveTools().map(gt => ({
        name: gt.getEffectiveName(),
        description: gt.getEffectiveDescription(),
        inputSchema: gt.getEffectiveParameters(),
      })),
      conversationMemory: gateway.configuration.conversationMemory || false,
      maxConcurrentCalls: gateway.configuration.maxConcurrentCalls || 10,
      ...gateway.configuration.agentCapabilities,
    };

    const a2aResponse: A2AResponse = {
      messageId: this.generateMessageId(),
      conversationId: a2aMessage.conversationId,
      responseToId: a2aMessage.messageId,
      agentId: 'tool-gateway',
      content: {
        type: 'capability_response',
        data: capabilities,
      },
      metadata: {
        timestamp: new Date().toISOString(),
      },
    };

    return { success: true, data: a2aResponse };
  }

  private createMCPErrorResponse(id: string | number | null, code: number, message: string, data?: any): ProtocolResponse {
    const mcpResponse: MCPResponse = {
      jsonrpc: '2.0',
      id: id || 0,
      error: { code, message, data },
    };

    return { success: true, data: mcpResponse };
  }

  private createA2AErrorResponse(originalMessage: A2AMessage, errorCode: string, errorMessage: string): ProtocolResponse {
    const a2aResponse: A2AResponse = {
      messageId: this.generateMessageId(),
      conversationId: originalMessage.conversationId,
      responseToId: originalMessage.messageId,
      agentId: 'tool-gateway',
      content: {
        type: 'error',
        data: {
          code: errorCode,
          message: errorMessage,
        },
      },
      metadata: {
        timestamp: new Date().toISOString(),
      },
    };

    return { success: true, data: a2aResponse };
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // WebSocket support for MCP and A2A
  async handleWebSocketConnection(gatewayId: string, ws: WebSocket, query: Record<string, string>): Promise<void> {
    try {
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId },
        relations: ['tools', 'authConfigs'],
      });

      if (!gateway || !gateway.canAcceptRequests()) {
        ws.close(1003, 'Gateway not available');
        return;
      }

      if (!gateway.supportsProtocol('websocket')) {
        ws.close(1003, 'WebSocket not supported for this gateway type');
        return;
      }

      const connectionId = `${gatewayId}_${Date.now()}_${Math.random()}`;
      this.websocketConnections.set(connectionId, ws);

      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          const request: ProtocolRequest = {
            gatewayId,
            method: 'websocket',
            body: message,
            headers: {},
            query,
          };

          const response = await this.handleProtocolRequest(request);
          ws.send(JSON.stringify(response.data || response));
        } catch (error) {
          ws.send(JSON.stringify({
            error: {
              code: 'INVALID_MESSAGE',
              message: error.message,
            },
          }));
        }
      });

      ws.on('close', () => {
        this.websocketConnections.delete(connectionId);
      });

      ws.on('error', (error) => {
        this.logger.error(`WebSocket error for gateway ${gatewayId}: ${error.message}`);
        this.websocketConnections.delete(connectionId);
      });

    } catch (error) {
      this.logger.error(`WebSocket connection error: ${error.message}`);
      ws.close(1011, 'Internal server error');
    }
  }
}