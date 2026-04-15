import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { AlmytyMcpService } from '../almyty-mcp.service';
import { ApisService } from '../../apis/apis.service';
import { ToolsService } from '../../tools/tools.service';
import { GatewaysService } from '../../gateways/gateways.service';
import { AgentsService } from '../../agents/agents.service';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';

// Mock axios for import_schema URL fetching
const mockAxiosGet = jest.fn().mockResolvedValue({ data: '{"openapi":"3.0.0","info":{"title":"Test","version":"1.0"},"paths":{}}' });
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...args: any[]) => mockAxiosGet(...args) },
  get: (...args: any[]) => mockAxiosGet(...args),
}));

describe('AlmytyMcpService', () => {
  let service: AlmytyMcpService;

  const mockApisService = {
    findAllByOrganization: jest.fn().mockResolvedValue({ apis: [], total: 0 }),
    create: jest.fn().mockResolvedValue({ id: 'api-1', name: 'Test' }),
    importSchema: jest.fn().mockResolvedValue({ api: {}, schema: {}, operations: [], resources: [], tools: [] }),
  };
  const mockToolsService = { getTools: jest.fn().mockResolvedValue({ tools: [], total: 0 }) };
  const mockGatewaysService = { getGateways: jest.fn().mockResolvedValue({ gateways: [], total: 0 }), createGateway: jest.fn().mockResolvedValue({ id: 'gw-1' }) };
  const mockAgentsService = { getAgents: jest.fn().mockResolvedValue({ agents: [], total: 0 }), createAgent: jest.fn().mockResolvedValue({ id: 'agent-1' }) };
  const mockLlmProvidersService = { getProviders: jest.fn().mockResolvedValue([]), createProvider: jest.fn().mockResolvedValue({ id: 'prov-1' }) };
  const mockSchemaImportQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

  const mockModuleRef = {
    get: jest.fn((cls: any) => {
      if (cls === ApisService) return mockApisService;
      if (cls === ToolsService) return mockToolsService;
      if (cls === GatewaysService) return mockGatewaysService;
      if (cls === AgentsService) return mockAgentsService;
      if (cls === LlmProvidersService) return mockLlmProvidersService;
      if (typeof cls === 'string' && cls === 'BullQueue_schema-import') return mockSchemaImportQueue;
      throw new Error(`Unknown service: ${typeof cls === 'string' ? cls : cls?.name}`);
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlmytyMcpService,
        { provide: ModuleRef, useValue: mockModuleRef },
      ],
    }).compile();

    service = module.get(AlmytyMcpService);
  });

  const call = (method: string, params?: any) =>
    service.handleJsonRpc({ jsonrpc: '2.0', id: 1, method, params }, 'org-1', 'user-1');

  describe('initialize', () => {
    it('returns server info and capabilities', async () => {
      const res = await call('initialize');
      expect(res.result.serverInfo.name).toBe('almyty');
      expect(res.result.capabilities.tools).toBeDefined();
      expect(res.result.protocolVersion).toBe('2024-11-05');
    });
  });

  describe('tools/list', () => {
    it('returns all built-in tools', async () => {
      const res = await call('tools/list');
      expect(res.result.tools.length).toBeGreaterThan(0);
      expect(res.result.tools[0]).toHaveProperty('name');
      expect(res.result.tools[0]).toHaveProperty('description');
      expect(res.result.tools[0]).toHaveProperty('inputSchema');
    });

    it('includes expected tool names', async () => {
      const res = await call('tools/list');
      const names = res.result.tools.map((t: any) => t.name);
      expect(names).toContain('list_apis');
      expect(names).toContain('list_tools');
      expect(names).toContain('list_gateways');
      expect(names).toContain('list_agents');
      expect(names).toContain('create_agent');
    });
  });

  describe('resources/list', () => {
    it('returns empty resources array', async () => {
      const res = await call('resources/list');
      expect(res.result.resources).toEqual([]);
    });
  });

  describe('resources/read', () => {
    it('returns error for any resource', async () => {
      const res = await call('resources/read', { uri: 'test://foo' });
      expect(res.error.code).toBe(-32602);
    });
  });

  describe('prompts/list', () => {
    it('returns empty prompts array', async () => {
      const res = await call('prompts/list');
      expect(res.result.prompts).toEqual([]);
    });
  });

  describe('prompts/get', () => {
    it('returns valid message response', async () => {
      const res = await call('prompts/get', { name: 'test-prompt' });
      expect(res.result.messages).toBeDefined();
      expect(res.result.messages[0].role).toBe('user');
    });
  });

  describe('ping', () => {
    it('returns empty result', async () => {
      const res = await call('ping');
      expect(res.result).toEqual({});
    });
  });

  describe('notifications/initialized', () => {
    it('returns empty result', async () => {
      const res = await call('notifications/initialized');
      expect(res.result).toEqual({});
    });
  });

  describe('unknown method', () => {
    it('returns -32601 error', async () => {
      const res = await call('bogus/method');
      expect(res.error.code).toBe(-32601);
      expect(res.error.message).toContain('bogus/method');
    });
  });

  describe('tools/call', () => {
    it('returns error for unknown tool', async () => {
      const res = await call('tools/call', { name: 'nonexistent_tool', arguments: {} });
      expect(res.result.content[0].text).toContain('Unknown tool');
      expect(res.result.isError).toBe(true);
    });

    it('list_apis calls ApisService.findAllByOrganization', async () => {
      const res = await call('tools/call', { name: 'list_apis', arguments: {} });
      expect(mockApisService.findAllByOrganization).toHaveBeenCalledWith('org-1', { limit: 50 });
      expect(res.result.isError).toBeUndefined();
    });

    it('import_schema fetches URL and passes content to ApisService', async () => {
      const res = await call('tools/call', {
        name: 'import_schema',
        arguments: { apiId: 'api-1', schemaUrl: 'https://example.com/openapi.json', generateTools: true },
      });
      // Verifies: URL is fetched, then job is queued (not sync import)
      expect(mockAxiosGet).toHaveBeenCalledWith('https://example.com/openapi.json', { timeout: 30000 });
      expect(mockSchemaImportQueue.add).toHaveBeenCalledWith(
        'import',
        expect.objectContaining({
          apiId: 'api-1',
          organizationId: 'org-1',
          schemaContent: expect.any(String),
          options: { generateTools: true },
        }),
        expect.any(Object),
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.jobId).toBe('job-1');
      expect(parsed.status).toBe('queued');
    });

    it('list_gateways calls GatewaysService.getGateways', async () => {
      await call('tools/call', { name: 'list_gateways', arguments: {} });
      expect(mockGatewaysService.getGateways).toHaveBeenCalledWith({ organizationId: 'org-1', limit: 50 });
    });

    it('create_agent calls AgentsService.createAgent with correct args', async () => {
      await call('tools/call', { name: 'create_agent', arguments: { name: 'My Agent' } });
      expect(mockAgentsService.createAgent).toHaveBeenCalledWith(
        { name: 'My Agent' },
        'org-1',
        'user-1',
      );
    });
  });
});
