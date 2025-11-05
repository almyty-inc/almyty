import { Test, TestingModule } from '@nestjs/testing';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

describe('McpController', () => {
  let controller: McpController;
  let mcpService: jest.Mocked<McpService>;

  beforeEach(async () => {
    const mockMcpService = {
      handleJsonRpc: jest.fn(),
      healthCheck: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [McpController],
      providers: [
        {
          provide: McpService,
          useValue: mockMcpService,
        },
      ],
    })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: jest.fn(() => true) })
    .compile();

    controller = module.get<McpController>(McpController);
    mcpService = module.get(McpService);
  });

  describe('handleMcp', () => {
    it('should handle MCP request successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'tools/list',
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: '1',
        result: { tools: [] },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.handleMcp(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
      expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(
        mockBody,
        'org-1',
        'user-1'
      );
    });
  });

  describe('initialize', () => {
    it('should handle initialization request', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'initialize',
        params: {
          protocolVersion: '1.0',
          capabilities: {},
        },
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: '1',
        result: {
          protocolVersion: '1.0',
          capabilities: {},
          serverInfo: {},
        },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.initialize(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });
  });

  describe('ping', () => {
    it('should handle ping request', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'ping',
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: '1',
        result: {},
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.ping(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });
  });

  describe('listTools', () => {
    it('should list tools successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'tools/list',
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: '1',
        result: {
          tools: [
            { name: 'tool-1', description: 'Test tool 1', inputSchema: {} },
          ],
        },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.listTools(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });
  });

  describe('callTool', () => {
    it('should call tool successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'tools/call',
        params: {
          name: 'test-tool',
          arguments: { param1: 'value1' },
        },
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: '1',
        result: {
          content: [{ type: 'text', text: 'Tool result' }],
          isError: false,
        },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.callTool(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });
  });

  describe('health', () => {
    it('should return health status', async () => {
      const mockHealth = {
        status: 'healthy',
        activeSessions: 5,
        serverInfo: { version: '1.0.0', uptime: 1000 },
      };

      mcpService.healthCheck.mockResolvedValue(mockHealth);

      const result = await controller.health();

      expect(result).toBe(mockHealth);
      expect(mcpService.healthCheck).toHaveBeenCalled();
    });
  });

  describe('handleNotifications', () => {
    it('should handle notifications successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        method: 'notifications/initialized',
      };

      const result = await controller.handleNotifications(mockRequest, mockBody);

      expect(result).toBeUndefined();
    });

    it('should throw error when organization context is missing', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const mockBody = {
        method: 'notifications/initialized',
      };

      await expect(controller.handleNotifications(mockRequest, mockBody)).rejects.toThrow('Organization context required');
    });
  });

  describe('listResources', () => {
    it('should list resources successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'resources/list',
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: '1',
        result: {
          resources: [
            { uri: 'resource-1', name: 'Test Resource', mimeType: 'application/json' },
          ],
        },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.listResources(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });
  });

  describe('readResource', () => {
    it('should read resource successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'resources/read',
        params: {
          uri: 'resource-1',
        },
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: '1',
        result: {
          contents: [{ uri: 'resource-1', mimeType: 'application/json', text: '{"data":"value"}' }],
        },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.readResource(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });
  });

  describe('listPrompts', () => {
    it('should list prompts successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'prompts/list',
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: '1',
        result: {
          prompts: [
            { name: 'prompt-1', description: 'Test Prompt' },
          ],
        },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.listPrompts(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });
  });

  describe('getPrompt', () => {
    it('should get prompt successfully', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'prompts/get',
        params: {
          name: 'test-prompt',
        },
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: '1',
        result: {
          description: 'Test Prompt',
          messages: [{ role: 'user', content: 'Test content' }],
        },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.getPrompt(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });
  });

  describe('wellKnown', () => {
    it('should return MCP server information', async () => {
      const result = await controller.wellKnown();

      expect(result).toBeDefined();
      expect(result.protocol).toBe('mcp');
      expect(result.version).toBe('2024-11-05');
      expect(result.server.name).toBe('apifai');
      expect(result.capabilities.tools).toBeDefined();
      expect(result.capabilities.resources).toBeDefined();
      expect(result.capabilities.prompts).toBeDefined();
      expect(result.transports.http).toContain('/api/mcp');
    });
  });

  describe('error cases', () => {
    it('should throw error when organization context is missing in handleMcp', async () => {
      const mockRequest = { user: { id: 'user-1' } };
      const mockBody = {
        jsonrpc: '2.0' as const,
        id: '1',
        method: 'tools/list',
      };

      await expect(controller.handleMcp(mockRequest, mockBody)).rejects.toThrow('Organization context required');
    });

    it('should use default id when not provided in initialize', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        params: {
          protocolVersion: '1.0',
          capabilities: {},
        },
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: {
          protocolVersion: '1.0',
          capabilities: {},
        },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.initialize(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
      expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 1,
          method: 'initialize',
        }),
        'org-1',
        'user-1'
      );
    });

    it('should use params directly when no id provided in callTool', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        name: 'test-tool',
        arguments: { param1: 'value1' },
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: { content: [] },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.callTool(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
      expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          params: mockBody,
        }),
        'org-1',
        'user-1'
      );
    });

    it('should handle ping without params', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = { };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: {},
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.ping(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
      expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          params: undefined,
        }),
        'org-1',
        'user-1'
      );
    });

    it('should handle listTools without params', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = { id: 5 };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: 5,
        result: { tools: [] },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.listTools(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
      expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 5,
          params: undefined,
        }),
        'org-1',
        'user-1'
      );
    });

    it('should handle listResources without params', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = { };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: { resources: [] },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.listResources(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });

    it('should handle listPrompts without params', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = { };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: { prompts: [] },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.listPrompts(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
    });

    it('should handle readResource without params object', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        uri: 'test-resource',
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: { contents: [] },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.readResource(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
      expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          params: mockBody,
        }),
        'org-1',
        'user-1'
      );
    });

    it('should handle getPrompt without params object', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        name: 'test-prompt',
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: { messages: [] },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.getPrompt(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
      expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          params: mockBody,
        }),
        'org-1',
        'user-1'
      );
    });

    it('should handle initialize without params object', async () => {
      const mockRequest = { user: { id: 'user-1', currentOrganizationId: 'org-1' } };
      const mockBody = {
        protocolVersion: '1.0',
        capabilities: {},
      };

      const mockResponse = {
        jsonrpc: '2.0' as const,
        id: 1,
        result: { protocolVersion: '1.0' },
      };

      mcpService.handleJsonRpc.mockResolvedValue(mockResponse);

      const result = await controller.initialize(mockRequest, mockBody);

      expect(result).toBe(mockResponse);
      expect(mcpService.handleJsonRpc).toHaveBeenCalledWith(
        expect.objectContaining({
          params: mockBody,
        }),
        'org-1',
        'user-1'
      );
    });
  });
});