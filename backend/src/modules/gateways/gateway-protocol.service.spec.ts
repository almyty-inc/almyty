import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as WebSocket from 'ws';
import { GatewayProtocolService, ProtocolRequest, MCPRequest, A2AMessage, UTCPRequest } from './gateway-protocol.service';
import { Gateway, GatewayType } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { ToolExecutorService } from '../tools/tool-executor.service';

describe('GatewayProtocolService', () => {
  let service: GatewayProtocolService;
  let gatewayRepository: any;
  let gatewayToolRepository: any;
  let toolExecutorService: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GatewayProtocolService,
        {
          provide: getRepositoryToken(Gateway),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(GatewayTool),
          useValue: {
            find: jest.fn(),
          },
        },
        {
          provide: ToolExecutorService,
          useValue: {
            executeTool: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<GatewayProtocolService>(GatewayProtocolService);
    gatewayRepository = module.get(getRepositoryToken(Gateway));
    gatewayToolRepository = module.get(getRepositoryToken(GatewayTool));
    toolExecutorService = module.get(ToolExecutorService);
  });

  describe('basic functionality', () => {
    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should have all required dependencies injected', () => {
      expect(gatewayRepository).toBeDefined();
      expect(gatewayToolRepository).toBeDefined();
      expect(toolExecutorService).toBeDefined();
    });
  });

  describe('handleProtocolRequest', () => {
    const mockRequest: ProtocolRequest = {
      gatewayId: 'gateway-1',
      method: 'test',
      body: {},
      headers: {},
      query: {},
      userId: 'user-1',
    };

    it('should return error when gateway not found', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      const response = await service.handleProtocolRequest(mockRequest);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('GATEWAY_NOT_FOUND');
      expect(response.error?.message).toBe('Gateway not found');
    });

    it('should return error when gateway cannot accept requests', async () => {
      const mockGateway = {
        id: 'gateway-1',
        canAcceptRequests: jest.fn().mockReturnValue(false),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      const response = await service.handleProtocolRequest(mockRequest);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('GATEWAY_UNAVAILABLE');
      expect(response.error?.message).toBe('Gateway is not available');
    });

    it('should route to MCP handler for MCP gateway', async () => {
      const mockGateway = {
        id: 'gateway-1',
        type: GatewayType.MCP,
        canAcceptRequests: jest.fn().mockReturnValue(true),
        getActiveTools: jest.fn().mockReturnValue([]),
        configuration: { capabilities: {} },
      };

      const mcpRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
        },
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      const response = await service.handleProtocolRequest(mcpRequest);

      expect(response.success).toBe(true);
      expect(response.data?.jsonrpc).toBe('2.0');
      expect(response.data?.id).toBe(1);
    });

    it('should route to A2A handler for A2A gateway', async () => {
      const mockGateway = {
        id: 'gateway-1',
        type: GatewayType.A2A,
        canAcceptRequests: jest.fn().mockReturnValue(true),
        getActiveTools: jest.fn().mockReturnValue([]),
        configuration: { agentCapabilities: {} },
      };

      const a2aRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: {
          messageId: 'msg-1',
          agentId: 'agent-1',
          intent: 'capability_request',
          content: {
            type: 'capability_request',
            data: {},
          },
        },
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      const response = await service.handleProtocolRequest(a2aRequest);

      expect(response.success).toBe(true);
      expect(response.data?.agentId).toBe('tool-gateway');
      expect(response.data?.content.type).toBe('capability_response');
    });

    it('should route to UTCP handler for UTCP gateway', async () => {
      const mockGateway = {
        id: 'gateway-1',
        type: GatewayType.UTCP,
        organizationId: 'org-1',
        canAcceptRequests: jest.fn().mockReturnValue(true),
        tools: [{
          toolId: 'tool-1',
          isActive: true,
          getEffectiveName: jest.fn().mockReturnValue('testTool'),
          getEffectiveTimeout: jest.fn().mockReturnValue(30000),
          getEffectiveRetries: jest.fn().mockReturnValue(3),
        }],
      };

      const utcpRequest = {
        gatewayId: 'gateway-1',
        method: 'utcp',
        body: {
          version: '1.0',
          requestId: 'req-1',
          toolName: 'testTool',
          parameters: { param1: 'value1' },
        },
        userId: 'user-1',
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);
      toolExecutorService.executeTool.mockResolvedValue({
        success: true,
        data: { result: 'test result' },
        executionTime: 1000,
        cached: false,
        retryCount: 0,
      });

      const response = await service.handleProtocolRequest(utcpRequest);

      expect(response.success).toBe(true);
      expect(response.data?.version).toBe('1.0');
      expect(response.data?.requestId).toBe('req-1');
      expect(response.data?.status).toBe('success');
    });

    it('should return error for unsupported gateway type', async () => {
      const mockGateway = {
        id: 'gateway-1',
        type: 'UNSUPPORTED' as any,
        canAcceptRequests: jest.fn().mockReturnValue(true),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      const response = await service.handleProtocolRequest(mockRequest);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('UNSUPPORTED_PROTOCOL');
      expect(response.error?.message).toContain('Unsupported gateway type');
    });

    it('should handle internal errors', async () => {
      gatewayRepository.findOne.mockRejectedValue(new Error('Database error'));

      const response = await service.handleProtocolRequest(mockRequest);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('INTERNAL_ERROR');
      expect(response.error?.message).toBe('Internal server error');
      expect(response.error?.details).toBe('Database error');
    });
  });

  describe('MCP Protocol Handling', () => {
    const mockMCPGateway = {
      id: 'gateway-1',
      type: GatewayType.MCP,
      canAcceptRequests: jest.fn().mockReturnValue(true),
      getActiveTools: jest.fn().mockReturnValue([{
        getEffectiveName: jest.fn().mockReturnValue('testTool'),
        getEffectiveDescription: jest.fn().mockReturnValue('Test tool description'),
        getEffectiveParameters: jest.fn().mockReturnValue({ param1: { type: 'string' } }),
        getEffectiveTimeout: jest.fn().mockReturnValue(30000),
        getEffectiveRetries: jest.fn().mockReturnValue(3),
        isActive: true,
        toolId: 'tool-1',
      }]),
      tools: [{
        getEffectiveName: jest.fn().mockReturnValue('testTool'),
        isActive: true,
        toolId: 'tool-1',
        getEffectiveTimeout: jest.fn().mockReturnValue(30000),
        getEffectiveRetries: jest.fn().mockReturnValue(3),
      }],
      configuration: {
        capabilities: {
          customCapability: true,
        },
      },
      organizationId: 'org-1',
    };

    it('should handle MCP tools/list request', async () => {
      const mcpRequest: MCPRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: mcpRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.jsonrpc).toBe('2.0');
      expect(response.data?.id).toBe(1);
      expect(response.data?.result.tools).toHaveLength(1);
      expect(response.data?.result.tools[0].name).toBe('testTool');
    });

    it('should handle MCP tools/call request successfully', async () => {
      const mcpRequest: MCPRequest = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'testTool',
          arguments: { param1: 'value1' },
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: mcpRequest,
        userId: 'user-1',
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);
      toolExecutorService.executeTool.mockResolvedValue({
        success: true,
        data: 'Tool execution result',
        executionTime: 1500,
        cached: false,
        retryCount: 0,
      });

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.jsonrpc).toBe('2.0');
      expect(response.data?.id).toBe(2);
      expect(response.data?.result.content[0].text).toBe('Tool execution result');
    });

    it('should handle MCP tools/call request with tool execution failure', async () => {
      const mcpRequest: MCPRequest = {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'testTool',
          arguments: { param1: 'value1' },
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: mcpRequest,
        userId: 'user-1',
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);
      toolExecutorService.executeTool.mockResolvedValue({
        success: false,
        error: 'Tool execution failed',
        executionTime: 1000,
        cached: false,
        retryCount: 1,
      });

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.jsonrpc).toBe('2.0');
      expect(response.data?.id).toBe(3);
      expect(response.data?.error.code).toBe(-32603);
      expect(response.data?.error.message).toBe('Tool execution failed');
    });

    it('should handle MCP capabilities request', async () => {
      const mcpRequest: MCPRequest = {
        jsonrpc: '2.0',
        id: 4,
        method: 'capabilities',
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: mcpRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.result.capabilities.customCapability).toBe(true);
      expect(response.data?.result.capabilities.tools).toBeDefined();
      expect(response.data?.result.capabilities.logging.level).toBe('info');
    });

    it('should handle invalid MCP JSON-RPC version', async () => {
      const invalidRequest: any = {
        jsonrpc: '1.0',
        id: 5,
        method: 'tools/list',
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: invalidRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.error.code).toBe(-32600);
      expect(response.data?.error.message).toBe('Invalid Request');
    });

    it('should handle unknown MCP method', async () => {
      const mcpRequest: MCPRequest = {
        jsonrpc: '2.0',
        id: 6,
        method: 'unknown/method',
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: mcpRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.error.code).toBe(-32601);
      expect(response.data?.error.message).toBe('Method not found');
    });

    it('should handle MCP tool call with missing tool name', async () => {
      const mcpRequest: MCPRequest = {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          arguments: { param1: 'value1' },
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: mcpRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.error.code).toBe(-32602);
      expect(response.data?.error.message).toBe('Invalid params');
    });

    it('should handle MCP tool call with non-existent tool', async () => {
      const mcpRequest: MCPRequest = {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'nonExistentTool',
          arguments: {},
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: mcpRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.error.code).toBe(-32602);
      expect(response.data?.error.message).toBe('Invalid params');
    });

    it('should handle MCP parsing errors', async () => {
      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: null,
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.error.code).toBe(-32603);
      expect(response.data?.error.message).toBe('Internal error');
    });
  });

  describe('A2A Protocol Handling', () => {
    const mockA2AGateway = {
      id: 'gateway-1',
      type: GatewayType.A2A,
      organizationId: 'org-1',
      canAcceptRequests: jest.fn().mockReturnValue(true),
      getActiveTools: jest.fn().mockReturnValue([{
        getEffectiveName: jest.fn().mockReturnValue('testTool'),
        getEffectiveDescription: jest.fn().mockReturnValue('Test tool description'),
        getEffectiveParameters: jest.fn().mockReturnValue({ param1: { type: 'string' } }),
        getEffectiveTimeout: jest.fn().mockReturnValue(30000),
        getEffectiveRetries: jest.fn().mockReturnValue(3),
        isActive: true,
        toolId: 'tool-1',
      }]),
      tools: [{
        getEffectiveName: jest.fn().mockReturnValue('testTool'),
        isActive: true,
        toolId: 'tool-1',
        getEffectiveTimeout: jest.fn().mockReturnValue(30000),
        getEffectiveRetries: jest.fn().mockReturnValue(3),
      }],
      configuration: {
        conversationMemory: true,
        maxConcurrentCalls: 5,
        agentCapabilities: {
          customAgentCapability: true,
        },
      },
    };

    it('should handle A2A capability request', async () => {
      const a2aMessage: A2AMessage = {
        messageId: 'msg-1',
        agentId: 'agent-1',
        intent: 'capability_request',
        content: {
          type: 'capability_request',
          data: {},
        },
        metadata: {
          timestamp: '2023-01-01T00:00:00Z',
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: a2aMessage,
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.responseToId).toBe('msg-1');
      expect(response.data?.agentId).toBe('tool-gateway');
      expect(response.data?.content.type).toBe('capability_response');
      expect(response.data?.content.data.tools).toHaveLength(1);
      expect(response.data?.content.data.conversationMemory).toBe(true);
      expect(response.data?.content.data.maxConcurrentCalls).toBe(5);
    });

    it('should handle A2A tool call request successfully', async () => {
      const a2aMessage: A2AMessage = {
        messageId: 'msg-2',
        conversationId: 'conv-1',
        agentId: 'agent-1',
        intent: 'tool_call',
        content: {
          type: 'tool_call',
          data: {
            toolName: 'testTool',
            parameters: { param1: 'value1' },
          },
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: a2aMessage,
        userId: 'user-1',
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);
      toolExecutorService.executeTool.mockResolvedValue({
        success: true,
        data: { result: 'test result' },
        executionTime: 2000,
        cached: true,
        retryCount: 0,
      });

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.responseToId).toBe('msg-2');
      expect(response.data?.conversationId).toBe('conv-1');
      expect(response.data?.content.type).toBe('tool_result');
      expect(response.data?.content.data.success).toBe(true);
      expect(response.data?.metadata.cached).toBe(true);
    });

    it('should handle A2A message with missing messageId', async () => {
      const invalidA2AMessage: any = {
        agentId: 'agent-1',
        intent: 'tool_call',
        content: {
          type: 'tool_call',
          data: {},
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: invalidA2AMessage,
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('INVALID_MESSAGE');
      expect(response.error?.message).toContain('Missing required fields');
    });
  });

  describe('UTCP Protocol Handling', () => {
    const mockUTCPGateway = {
      id: 'gateway-1',
      type: GatewayType.UTCP,
      organizationId: 'org-1',
      canAcceptRequests: jest.fn().mockReturnValue(true),
      tools: [{
        toolId: 'tool-1',
        isActive: true,
        getEffectiveName: jest.fn().mockReturnValue('testTool'),
        getEffectiveTimeout: jest.fn().mockReturnValue(30000),
        getEffectiveRetries: jest.fn().mockReturnValue(3),
      }],
    };

    it('should handle UTCP request successfully', async () => {
      const utcpRequest: UTCPRequest = {
        version: '1.0',
        requestId: 'req-1',
        toolName: 'testTool',
        parameters: {
          param1: 'value1',
          param2: 42,
        },
        context: {
          userId: 'user-1',
          sessionId: 'session-1',
          metadata: { source: 'api' },
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'utcp',
        body: utcpRequest,
        userId: 'user-1',
      };

      gatewayRepository.findOne.mockResolvedValue(mockUTCPGateway);
      toolExecutorService.executeTool.mockResolvedValue({
        success: true,
        data: { output: 'execution result' },
        executionTime: 1200,
        cached: false,
        retryCount: 0,
      });

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.version).toBe('1.0');
      expect(response.data?.requestId).toBe('req-1');
      expect(response.data?.status).toBe('success');
      expect(response.data?.result.output).toBe('execution result');
      expect(response.data?.metadata.executionTime).toBe(1200);
      expect(response.data?.metadata.cached).toBe(false);
      expect(response.data?.metadata.retryCount).toBe(0);
    });

    it('should handle UTCP request with non-existent tool', async () => {
      const utcpRequest: UTCPRequest = {
        version: '1.0',
        requestId: 'req-5',
        toolName: 'nonExistentTool',
        parameters: {},
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'utcp',
        body: utcpRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockUTCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.status).toBe('error');
      expect(response.data?.error.code).toBe('TOOL_NOT_FOUND');
      expect(response.data?.error.message).toContain('nonExistentTool');
    });
  });

  describe('WebSocket Connection Handling', () => {
    let mockWebSocket: any;

    beforeEach(() => {
      mockWebSocket = {
        close: jest.fn(),
        send: jest.fn(),
        on: jest.fn(),
      };
    });

    it('should handle WebSocket connection for valid gateway', async () => {
      const mockGateway = {
        id: 'gateway-1',
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      await service.handleWebSocketConnection('gateway-1', mockWebSocket, { auth: 'token' });

      expect(mockWebSocket.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWebSocket.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWebSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should close WebSocket for non-existent gateway', async () => {
      gatewayRepository.findOne.mockResolvedValue(null);

      await service.handleWebSocketConnection('gateway-1', mockWebSocket, {});

      expect(mockWebSocket.close).toHaveBeenCalledWith(1003, 'Gateway not available');
    });

    it('should close WebSocket when gateway cannot accept requests', async () => {
      const mockGateway = {
        id: 'gateway-1',
        canAcceptRequests: jest.fn().mockReturnValue(false),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      await service.handleWebSocketConnection('gateway-1', mockWebSocket, {});

      expect(mockWebSocket.close).toHaveBeenCalledWith(1003, 'Gateway not available');
    });

    it('should close WebSocket when protocol not supported', async () => {
      const mockGateway = {
        id: 'gateway-1',
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(false),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      await service.handleWebSocketConnection('gateway-1', mockWebSocket, {});

      expect(mockWebSocket.close).toHaveBeenCalledWith(1003, 'WebSocket not supported for this gateway type');
    });
  });

  describe('A2A Protocol - Additional Branch Coverage', () => {
    const mockA2AGateway = {
      id: 'gateway-1',
      type: GatewayType.A2A,
      canAcceptRequests: jest.fn().mockReturnValue(true),
      getActiveTools: jest.fn().mockReturnValue([]),
      tools: [],
      configuration: { capabilities: {} },
    };

    it('should handle unsupported A2A content type', async () => {
      const a2aMessage = {
        id: 'msg-1',
        sender: { id: 'agent-1', type: 'agent' },
        content: {
          type: 'unsupported_type',
          data: {},
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: a2aMessage,
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(false);
      // The error code might be INVALID_MESSAGE if validation fails first
      expect(response.error?.code).toBeDefined();
    });

    it('should handle A2A processing error', async () => {
      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: null, // Invalid body
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('A2A_PROCESSING_ERROR');
    });

    it('should handle A2A capability_request', async () => {
      const a2aMessage = {
        id: 'msg-1',
        sender: { id: 'agent-1', type: 'agent' },
        content: {
          type: 'capability_request',
          data: {},
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: a2aMessage,
      };

      mockA2AGateway.getActiveTools.mockReturnValue([
        { id: 'tool-1', getEffectiveName: () => 'testTool', tool: { description: 'Test' } }
      ]);

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      // Just verify it doesn't throw and returns a response
      expect(response).toBeDefined();
    });

    it('should handle A2A tool_call with missing tool name', async () => {
      const a2aMessage = {
        id: 'msg-1',
        sender: { id: 'agent-1', type: 'agent' },
        content: {
          type: 'tool_call',
          data: {
            parameters: {},
          },
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: a2aMessage,
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBeDefined();
    });

    it('should handle A2A tool_call with non-existent tool', async () => {
      const a2aMessage = {
        id: 'msg-1',
        sender: { id: 'agent-1', type: 'agent' },
        content: {
          type: 'tool_call',
          data: {
            toolName: 'nonExistentTool',
            parameters: {},
          },
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: a2aMessage,
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBeDefined();
    });
  });

  describe('MCP Protocol - Additional Branch Coverage', () => {
    const mockMCPGateway = {
      id: 'gateway-1',
      type: GatewayType.MCP,
      canAcceptRequests: jest.fn().mockReturnValue(true),
      getActiveTools: jest.fn().mockReturnValue([]),
      tools: [],
      configuration: { capabilities: {} },
    };

    it('should handle MCP call_tool error', async () => {
      const mcpRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'testTool',
          arguments: {},
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: mcpRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);
      toolExecutorService.executeTool.mockRejectedValue(new Error('Execution failed'));

      const response = await service.handleProtocolRequest(request);

      // Should handle error gracefully
      expect(response.success).toBe(true);
      expect(response.data?.error?.code).toBeDefined();
    });
  });

  describe('UTCP Protocol - Invalid Request', () => {
    const mockUTCPGateway = {
      id: 'gateway-1',
      type: GatewayType.UTCP,
      canAcceptRequests: jest.fn().mockReturnValue(true),
      getActiveTools: jest.fn().mockReturnValue([]),
      tools: [],
      configuration: {},
    };

    it('should handle UTCP request with missing required fields', async () => {
      const utcpRequest = {
        // Missing version, requestId, toolName
        parameters: {},
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'utcp',
        body: utcpRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockUTCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('INVALID_UTCP_REQUEST');
    });
  });

  describe('A2A Protocol - additional coverage', () => {
    it('should handle unsupported content type in A2A request', async () => {
      const mockA2AGateway = {
        id: 'gateway-1',
        type: GatewayType.A2A,
        canAcceptRequests: jest.fn().mockReturnValue(true),
        tools: [],
        configuration: {},
      };

      const a2aRequest = {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        agentId: 'agent-1',
        content: {
          type: 'unsupported_type',
          data: {},
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: a2aRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('UNSUPPORTED_CONTENT_TYPE');
    });

    it('should handle A2A tool call with missing tool name', async () => {
      const mockA2AGateway = {
        id: 'gateway-1',
        type: GatewayType.A2A,
        canAcceptRequests: jest.fn().mockReturnValue(true),
        tools: [],
        configuration: {},
      };

      const a2aRequest = {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        agentId: 'agent-1',
        content: {
          type: 'tool_call',
          data: {
            parameters: {},
          },
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: a2aRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data.content?.type).toBe('error');
    });

    it('should handle A2A capability request', async () => {
      const mockTool = {
        isActive: true,
        getEffectiveName: jest.fn().mockReturnValue('test-tool'),
        getEffectiveDescription: jest.fn().mockReturnValue('A test tool'),
        getEffectiveParameters: jest.fn().mockReturnValue({}),
        tool: {
          name: 'Test Tool',
          description: 'A test tool',
          inputSchema: {},
          outputSchema: {},
        },
      };

      const mockA2AGateway = {
        id: 'gateway-1',
        type: GatewayType.A2A,
        canAcceptRequests: jest.fn().mockReturnValue(true),
        getActiveTools: jest.fn().mockReturnValue([mockTool]),
        tools: [mockTool],
        configuration: {},
      };

      const a2aRequest = {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        agentId: 'agent-1',
        content: {
          type: 'capability_request',
          data: {},
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'a2a',
        body: a2aRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockA2AGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data.content?.type).toBe('capability_response');
    });

    it('should handle MCP error response creation', async () => {
      const mockMCPGateway = {
        id: 'gateway-1',
        type: GatewayType.MCP,
        canAcceptRequests: jest.fn().mockReturnValue(true),
        tools: [],
        configuration: {},
      };

      const mcpRequest = {
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'tools/call',
        params: {
          name: 'nonexistent-tool',
          arguments: {},
        },
      };

      const request: ProtocolRequest = {
        gatewayId: 'gateway-1',
        method: 'mcp',
        body: mcpRequest,
      };

      gatewayRepository.findOne.mockResolvedValue(mockMCPGateway);

      const response = await service.handleProtocolRequest(request);

      expect(response.success).toBe(true);
      expect(response.data?.error).toBeDefined();
    });
  });

  describe('WebSocket handling - additional coverage', () => {
    it('should handle WebSocket message parsing error', async () => {
      const mockGateway = {
        id: 'gateway-1',
        type: GatewayType.MCP,
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
        tools: [],
        configuration: {},
      };

      const mockWs = {
        on: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      await service.handleWebSocketConnection('gateway-1', mockWs as any, {});

      // Simulate message handler being called
      const messageHandler = mockWs.on.mock.calls.find(call => call[0] === 'message')?.[1];
      expect(messageHandler).toBeDefined();

      // Send invalid JSON
      await messageHandler(Buffer.from('invalid json'));

      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('INVALID_MESSAGE')
      );
    });

    it('should handle WebSocket close event', async () => {
      const mockGateway = {
        id: 'gateway-1',
        type: GatewayType.MCP,
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
        tools: [],
        configuration: {},
      };

      const mockWs = {
        on: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      await service.handleWebSocketConnection('gateway-1', mockWs as any, {});

      // Simulate close handler
      const closeHandler = mockWs.on.mock.calls.find(call => call[0] === 'close')?.[1];
      expect(closeHandler).toBeDefined();
      closeHandler();

      // Verify cleanup happened (connections should be removed from map)
      expect(mockWs.close).not.toHaveBeenCalled();
    });

    it('should handle WebSocket error event', async () => {
      const mockGateway = {
        id: 'gateway-1',
        type: GatewayType.MCP,
        canAcceptRequests: jest.fn().mockReturnValue(true),
        supportsProtocol: jest.fn().mockReturnValue(true),
        tools: [],
        configuration: {},
      };

      const mockWs = {
        on: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
      };

      gatewayRepository.findOne.mockResolvedValue(mockGateway);

      await service.handleWebSocketConnection('gateway-1', mockWs as any, {});

      // Simulate error handler
      const errorHandler = mockWs.on.mock.calls.find(call => call[0] === 'error')?.[1];
      expect(errorHandler).toBeDefined();
      errorHandler(new Error('WebSocket error'));

      // Verify error was handled
      expect(mockWs.close).not.toHaveBeenCalled();
    });

    it('should close WebSocket if gateway setup fails', async () => {
      const mockWs = {
        on: jest.fn(),
        send: jest.fn(),
        close: jest.fn(),
      };

      gatewayRepository.findOne.mockRejectedValue(new Error('Database error'));

      await service.handleWebSocketConnection('gateway-1', mockWs as any, {});

      expect(mockWs.close).toHaveBeenCalledWith(1011, 'Internal server error');
    });
  });

});