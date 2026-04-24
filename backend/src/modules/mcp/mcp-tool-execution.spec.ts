import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { McpService } from './mcp.service';
import { McpToolHandler } from './services/mcp-tool.handler';
import { McpContentHandler } from './services/mcp-content.handler';
import { McpServerRequestService } from './services/mcp-server-request.service';
import { Tool } from '../../entities/tool.entity';
import { Resource } from '../../entities/resource.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { ToolCategory } from '../../entities/tool-category.entity';
import { ToolsService } from '../tools/tools.service';
import { ToolExecutorService } from '../tools/tool-executor.service';
import { SkillGeneratorService } from '../tools/skill-generator.service';

describe('McpService - Tool Execution', () => {
  let service: McpService;
  let toolsService: any;
  let toolExecutorService: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpToolHandler,
        McpContentHandler,
        McpServerRequestService,
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
          provide: getRepositoryToken(Gateway),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(GatewayTool),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(ToolCategory),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn(),
          },
        },
        {
          provide: ToolsService,
          useValue: {
            getTools: jest.fn(),
            getTool: jest.fn(),
            findByName: jest.fn(),
          },
        },
        {
          provide: ToolExecutorService,
          useValue: {
            executeTool: jest.fn(),
          },
        },
        {
          provide: SkillGeneratorService,
          useValue: {
            generateToolSkill: jest.fn(),
            generateGatewaySkills: jest.fn(),
          },
        },
        {
          provide: 'default_IORedisModuleConnectionToken',
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
            exists: jest.fn(),
            expire: jest.fn(),
            keys: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<McpService>(McpService);
    toolsService = module.get(ToolsService);
    toolExecutorService = module.get(ToolExecutorService);
  });

  describe('Tool execution without user authentication', () => {
    it('should execute tool with null userId for MCP sessions', async () => {
      const mockTool = {
        id: 'tool-123',
        name: 'test_tool',
        description: 'Test tool',
        parameters: { type: 'object', properties: {} }
      };

      const mockExecutionResult = {
        success: true,
        data: { message: 'Tool executed successfully' },
        executionTime: 100,
      };

      toolsService.findByName.mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockResolvedValue(mockExecutionResult);

      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: 'test_tool',
          arguments: { param1: 'value1' },
        },
      };

      const result = await service.handleJsonRpc(request, 'org-123', undefined);

      expect(result.result.content).toHaveLength(1);
      expect(result.result.content[0].type).toBe('text');
      expect(result.result.content[0].text).toContain('Tool executed successfully');
      expect(result.result.isError).toBe(false);

      // Verify executeTool was called with null userId
      expect(toolExecutorService.executeTool).toHaveBeenCalledWith(
        'tool-123',
        { param1: 'value1' },
        {
          userId: null,
          organizationId: 'org-123',
        }
      );
    });

    it('should skip permission check when userId is null', async () => {
      const mockTool = {
        id: 'tool-123',
        name: 'public_tool',
        description: 'Public tool accessible without auth',
        parameters: { type: 'object', properties: {} }
      };

      const mockExecutionResult = {
        success: true,
        data: { result: 'executed without user auth' },
        executionTime: 50,
      };

      toolsService.findByName.mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockResolvedValue(mockExecutionResult);

      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: 'public_tool',
          arguments: {},
        },
      };

      // Call without userId (undefined)
      const result = await service.handleJsonRpc(request, 'org-123', undefined);

      expect(result.result.isError).toBe(false);
      expect(toolExecutorService.executeTool).toHaveBeenCalledWith(
        'tool-123',
        {},
        {
          userId: null,
          organizationId: 'org-123',
        }
      );
    });

    it('should handle tool execution errors gracefully', async () => {
      const mockTool = {
        id: 'tool-123',
        name: 'failing_tool',
        description: 'Tool that fails',
        parameters: { type: 'object', properties: {} }
      };

      toolsService.findByName.mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockRejectedValue(new Error('Execution failed'));

      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: 'failing_tool',
          arguments: {},
        },
      };

      const result = await service.handleJsonRpc(request, 'org-123', undefined);

      expect(result.result.content).toHaveLength(1);
      expect(result.result.content[0].type).toBe('text');
      expect(result.result.content[0].text).toContain('Tool execution failed');
      expect(result.result.isError).toBe(true);
    });

    it('should return proper MCP content structure', async () => {
      const mockTool = {
        id: 'tool-123',
        name: 'test_tool',
        description: 'Test tool',
        parameters: { type: 'object', properties: {} }
      };

      const mockExecutionResult = {
        success: true,
        data: { orderId: 123, status: 'placed' },
        executionTime: 150,
      };

      toolsService.findByName.mockResolvedValue(mockTool);
      toolExecutorService.executeTool.mockResolvedValue(mockExecutionResult);

      const request = {
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/call',
        params: {
          name: 'test_tool',
          arguments: {},
        },
      };

      const result = await service.handleJsonRpc(request, 'org-123', undefined);

      // Verify MCP response structure
      expect(result.jsonrpc).toBe('2.0');
      expect(result.id).toBe('1');
      expect(result.result).toHaveProperty('content');
      expect(result.result).toHaveProperty('isError');

      // Verify content structure matches MCP spec
      const content = result.result.content[0];
      expect(content).toHaveProperty('type');
      expect(content).toHaveProperty('text');
      expect(content.type).toBe('text');
      expect(typeof content.text).toBe('string');

      // Verify text contains the result data
      const parsedText = JSON.parse(content.text);
      expect(parsedText).toEqual({ orderId: 123, status: 'placed' });
    });
  });
});
