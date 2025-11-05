import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { McpService } from './mcp.service';
import { Tool } from '../../entities/tool.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';
import { ToolsService } from '../tools/tools.service';
import { ToolExecutorService } from '../tools/tool-executor.service';

describe('McpService', () => {
  let service: McpService;
  let toolRepository: any;
  let resourceRepository: any;
  let organizationRepository: any;
  let toolsService: any;
  let toolExecutorService: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpService,
        {
          provide: getRepositoryToken(Tool),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Resource),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Organization),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: ToolsService,
          useValue: {
            getTools: jest.fn(),
            getTool: jest.fn(),
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

    service = module.get<McpService>(McpService);
    toolRepository = module.get(getRepositoryToken(Tool));
    resourceRepository = module.get(getRepositoryToken(Resource));
    organizationRepository = module.get(getRepositoryToken(Organization));
    toolsService = module.get(ToolsService);
    toolExecutorService = module.get(ToolExecutorService);
  });

  describe('handleJsonRpc', () => {
    it('should handle initialize request with valid protocol version', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          clientInfo: { name: 'Test Client', version: '1.0' },
          capabilities: {},
        },
      };

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('1');
      expect(result.result.protocolVersion).toBe('2024-11-05');
      expect(result.result.serverInfo).toBeDefined();
      expect(result.result.capabilities).toBeDefined();
    });

    it('should reject initialize with unsupported protocol version', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: {
          protocolVersion: '2020-01-01',
          clientInfo: { name: 'Test Client', version: '1.0' },
          capabilities: {},
        },
      };

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32602);
      expect(result.error.message).toContain('Unsupported protocol version');
    });

    it('should reject initialize with missing protocol version', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'initialize',
        params: {
          clientInfo: { name: 'Test Client', version: '1.0' },
          capabilities: {},
        },
      };

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32602);
    });

    it('should handle ping request', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '2',
        method: 'ping',
      };

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('2');
      expect(result.result).toEqual({});
    });

    it('should handle tools/list request successfully', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
      };

      const mockTools = [
        {
          id: 'tool-1',
          name: 'getUser',
          description: 'Get user by ID',
        },
      ];

      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 1 });

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('1');
      expect(result.result.tools).toBeDefined();
    });

    it('should handle tools/list with tools without parameters', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
      };

      const mockTools = [
        {
          id: 'tool-1',
          name: 'getUser',
          description: 'Get user by ID',
          parameters: null,
        },
      ];

      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 1 });

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.result.tools[0].inputSchema).toEqual({
        type: 'object',
        properties: {},
      });
    });

    it('should handle tools/call request successfully', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/call',
        params: {
          name: 'getUser',
          arguments: { id: 'user-123' },
        },
      };

      const mockTool = {
        id: 'tool-1',
        name: 'getUser',
        organizationId: 'org-1',
      };

      const mockExecutionResult = {
        success: true,
        data: { id: 'user-123', name: 'John Doe' },
        executionTime: 200,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };

      // Mock the findByName method that's called internally
      toolsService.findByName = jest.fn().mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockResolvedValue(mockExecutionResult);

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('2');
      expect(result.result).toBeDefined();
    });

    it('should handle tools/call without tool name', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/call',
        params: {
          arguments: { id: 'user-123' },
        },
      };

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32602);
      expect(result.error.message).toContain('Tool name is required');
    });

    it('should handle tools/call with non-existent tool', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/call',
        params: {
          name: 'nonExistentTool',
          arguments: { id: 'user-123' },
        },
      };

      toolsService.findByName = jest.fn().mockResolvedValue(null);

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32002);
      expect(result.error.message).toContain('Tool not found');
    });

    it('should handle tools/call execution error', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/call',
        params: {
          name: 'getUser',
          arguments: { id: 'user-123' },
        },
      };

      const mockTool = {
        id: 'tool-1',
        name: 'getUser',
        organizationId: 'org-1',
      };

      toolsService.findByName = jest.fn().mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockRejectedValue(new Error('Execution failed'));

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.result.isError).toBe(true);
      expect(result.result.content[0].text).toContain('Tool execution failed');
    });

    it('should handle tools/call with string result data', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/call',
        params: {
          name: 'getUser',
          arguments: { id: 'user-123' },
        },
      };

      const mockTool = {
        id: 'tool-1',
        name: 'getUser',
        organizationId: 'org-1',
      };

      const mockExecutionResult = {
        success: true,
        data: 'Simple string result',
        executionTime: 200,
        cached: false,
        rateLimited: false,
        retryCount: 0,
      };

      toolsService.findByName = jest.fn().mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockResolvedValue(mockExecutionResult);

      const result = await service.handleJsonRpc(request, 'org-1', 'user-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.result.content[0].text).toBe('Simple string result');
    });


    it('should handle resources/list request successfully', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '5',
        method: 'resources/list',
      };

      const mockResources = [
        {
          id: 'resource-1',
          name: 'User Schema',
          description: 'User resource schema',
          api: { organizationId: 'org-1' },
        },
        {
          id: 'resource-2',
          name: 'Product Schema',
          description: 'Product resource schema',
          api: { organizationId: 'org-1' },
        },
      ];

      resourceRepository.find.mockResolvedValue(mockResources);

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('5');
      expect(result.result.resources).toHaveLength(2);
      expect(result.result.resources[0].uri).toBe('apifai://resources/resource-1');
      expect(result.result.resources[0].name).toBe('User Schema');
    });

    it('should handle resources/read request successfully', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '6',
        method: 'resources/read',
        params: {
          uri: 'apifai://resources/resource-1',
        },
      };

      const mockResource = {
        id: 'resource-1',
        name: 'User Schema',
        description: 'User resource',
        schema: { type: 'object', properties: { id: { type: 'string' } } },
        api: { organizationId: 'org-1' },
      };

      resourceRepository.findOne.mockResolvedValue(mockResource);

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('6');
      expect(result.result.contents).toBeDefined();
      expect(result.result.contents[0].type).toBe('text');
    });

    it('should handle prompts/list request successfully', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '7',
        method: 'prompts/list',
      };

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('7');
      expect(result.result.prompts).toEqual([]);
    });

    it('should handle prompts/get request with error', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '8',
        method: 'prompts/get',
        params: { name: 'test-prompt' },
      };

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('8');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32601);
    });

    it('should handle unknown method with error', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '4',
        method: 'unknown/method',
      };

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('4');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32601);
    });

    it('should handle invalid JSON-RPC request with error', async () => {
      const request = {
        id: '9',
        method: 'test',
      };

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32600);
    });

    it('should handle missing method with error', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '10',
      };

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32600);
    });

    it('should handle null request body with error', async () => {
      const result = await service.handleJsonRpc(null, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBeNull();
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32600);
    });

    it('should handle non-object request body with error', async () => {
      const result = await service.handleJsonRpc('invalid', 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32600);
    });

    it('should handle missing request ID with error', async () => {
      const request = {
        jsonrpc: '2.0',
        method: 'test',
      };

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32600);
    });

    it('should handle invalid method type with error', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '10',
        method: 123,
      };

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32600);
    });

    it('should handle general error with internal error code', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '11',
        method: 'tools/list',
      };

      toolsService.getTools.mockRejectedValue(new Error('Database connection failed'));

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32603);
      expect(result.error.message).toBe('Internal server error');
    });

    it('should handle invalid resource URI format with error', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '11',
        method: 'resources/read',
        params: {
          uri: 'invalid://uri',
        },
      };

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32001); // RESOURCE_NOT_FOUND
    });

    it('should handle resource not found with error', async () => {
      const request = {
        jsonrpc: '2.0',
        id: '12',
        method: 'resources/read',
        params: {
          uri: 'apifai://resources/non-existent',
        },
      };

      resourceRepository.findOne.mockResolvedValue(null);

      const result = await service.handleJsonRpc(request, 'org-1');

      expect(result.jsonrpc).toBe('2.0');
      expect(result.error).toBeDefined();
      expect(result.error.code).toBe(-32001); // RESOURCE_NOT_FOUND
    });
  });

  describe('getToolsAsMcp', () => {
    it('should return tools in MCP format', async () => {
      const mockTools = [
        {
          id: 'tool-1',
          name: 'getUser',
          description: 'Get user by ID',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
        {
          id: 'tool-2',
          name: 'createUser',
          description: 'Create new user',
          parameters: { type: 'object', properties: { name: { type: 'string' } } },
        },
      ];

      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 2 });

      const result = await service.getToolsAsMcp('org-1');

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('getUser');
      expect(result[0].description).toBe('Get user by ID');
      expect(result[0].inputSchema).toBeDefined();
    });

    it('should return empty array when no tools', async () => {
      toolsService.getTools.mockResolvedValue({ tools: [], total: 0 });

      const result = await service.getToolsAsMcp('org-1');

      expect(result).toEqual([]);
    });

    it('should generate description when missing', async () => {
      const mockTools = [
        {
          id: 'tool-1',
          name: 'getUser',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
          metadata: { sourceApi: { name: 'UserAPI' } },
        },
      ];

      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 1 });

      const result = await service.getToolsAsMcp('org-1');

      expect(result[0].description).toContain('AI tool generated from UserAPI');
    });

    it('should use default description when no metadata', async () => {
      const mockTools = [
        {
          id: 'tool-1',
          name: 'getUser',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
        },
      ];

      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 1 });

      const result = await service.getToolsAsMcp('org-1');

      expect(result[0].description).toContain('AI tool generated from API');
    });

    it('should use default parameters when missing', async () => {
      const mockTools = [
        {
          id: 'tool-1',
          name: 'getUser',
          description: 'Get user',
        },
      ];

      toolsService.getTools.mockResolvedValue({ tools: mockTools, total: 1 });

      const result = await service.getToolsAsMcp('org-1');

      expect(result[0].inputSchema).toEqual({
        type: 'object',
        properties: {},
        description: 'Get user',
      });
    });
  });

  describe('healthCheck', () => {
    it('should return health status', async () => {
      const result = await service.healthCheck();

      expect(result.status).toBeDefined();
      expect(result.activeSessions).toEqual(expect.any(Number));
      expect(result.serverInfo).toBeDefined();
    });
  });

  describe('getSession', () => {
    it('should return null for non-existent session', async () => {
      const result = await service.getSession('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('removeSession', () => {
    it('should remove session successfully', async () => {
      await service.removeSession('session-1');

      // Should not throw
      expect(service).toBeDefined();
    });
  });

  describe('getActiveSessions', () => {
    it('should return active sessions for organization', async () => {
      const result = await service.getActiveSessions('org-1');

      expect(result).toEqual(expect.any(Array));
    });
  });

  describe('broadcastNotification', () => {
    it('should broadcast notification successfully', async () => {
      const notification = 'Tool update: tool-1 activated';

      await service.broadcastNotification('org-1', notification);

      // Should not throw
      expect(service).toBeDefined();
    });
  });
});