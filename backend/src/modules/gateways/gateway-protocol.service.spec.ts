import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as WebSocket from 'ws';
import { GatewayProtocolService, ProtocolRequest, MCPRequest, UTCPRequest } from './gateway-protocol.service';
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

  describe('MCP Protocol - error response creation', () => {
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