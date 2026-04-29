import { Test, TestingModule } from '@nestjs/testing';
import { ModuleRef } from '@nestjs/core';
import { AlmytyMcpService } from '../almyty-mcp.service';
import { ApisService } from '../../apis/apis.service';
import { ToolsService } from '../../tools/tools.service';
import { GatewaysService } from '../../gateways/gateways.service';
import { AgentsService } from '../../agents/agents.service';
import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
import { CanonicalMemoryService } from '../../memory/canonical/canonical-memory.service';

// Mock axios for import_schema URL fetching
const mockAxiosGet = jest.fn().mockResolvedValue({ data: '{"openapi":"3.0.0","info":{"title":"Test","version":"1.0"},"paths":{}}' });
jest.mock('axios', () => ({
  __esModule: true,
  default: { get: (...args: any[]) => mockAxiosGet(...args) },
  get: (...args: any[]) => mockAxiosGet(...args),
}));

describe('AlmytyMcpService', () => {
  let service: AlmytyMcpService;

  const mockApisService: any = {
    findAllByOrganization: jest.fn().mockResolvedValue({ apis: [], total: 0 }),
    create: jest.fn().mockResolvedValue({ id: 'api-1', name: 'Test' }),
    importSchema: jest.fn().mockResolvedValue({ api: {}, schema: {}, operations: [], resources: [], tools: [] }),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const mockToolsService: any = {
    getTools: jest.fn().mockResolvedValue({ tools: [], total: 0 }),
    deleteTool: jest.fn().mockResolvedValue(undefined),
  };
  const mockGatewaysService: any = {
    getGateways: jest.fn().mockResolvedValue({ gateways: [], total: 0 }),
    createGateway: jest.fn().mockResolvedValue({ id: 'gw-1' }),
    deleteGateway: jest.fn().mockResolvedValue(undefined),
  };
  const mockAgentsService = { getAgents: jest.fn().mockResolvedValue({ agents: [], total: 0 }), createAgent: jest.fn().mockResolvedValue({ id: 'agent-1' }) };
  const mockLlmProvidersService = { getProviders: jest.fn().mockResolvedValue([]), createProvider: jest.fn().mockResolvedValue({ id: 'prov-1' }) };
  const mockSchemaImportQueue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  const mockGatewayAuthService = { createGatewayAuth: jest.fn().mockResolvedValue({ id: 'auth-1', type: 'oauth2' }), deleteGatewayAuth: jest.fn().mockResolvedValue(undefined) };
  const mockGatewayToolService = { bulkAssociateTools: jest.fn().mockResolvedValue({ associated: [], skipped: [] }) };
  const mockMemoryService: any = {
    put: jest.fn().mockResolvedValue({
      id: 'mem-1', mode: 'memory', tier: 'short',
      embedding_status: 'pending', content_bytes: 11,
    }),
    search: jest.fn().mockResolvedValue([
      { item: { id: 'mem-1', content: 'hello', tier: 'short', tags: [], mode: 'memory' }, score: 0.9, signal: 'hybrid' },
    ]),
    list: jest.fn().mockResolvedValue({ items: [], total: 0, cursor: null }),
    get: jest.fn().mockResolvedValue({ id: 'mem-1', content: 'hello', mode: 'memory' }),
    delete: jest.fn().mockResolvedValue(true),
    supersede: jest.fn().mockResolvedValue({
      old: { id: 'mem-1', valid_until: new Date('2026-01-01') },
      new: { id: 'mem-2' },
    }),
  };

  const mockModuleRef = {
    get: jest.fn((cls: any) => {
      if (cls === ApisService) return mockApisService;
      if (cls === ToolsService) return mockToolsService;
      if (cls === GatewaysService) return mockGatewaysService;
      if (cls === AgentsService) return mockAgentsService;
      if (cls === LlmProvidersService) return mockLlmProvidersService;
      if (cls === CanonicalMemoryService) return mockMemoryService;
      if (typeof cls === 'string' && cls === 'BullQueue_schema-import') return mockSchemaImportQueue;
      // Dynamic require() imports resolve by class name
      if (cls?.name === 'GatewayAuthService') return mockGatewayAuthService;
      if (cls?.name === 'GatewayToolService') return mockGatewayToolService;
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

    it('assign_tools_to_gateway passes (gatewayId, {toolIds}, orgId, userId)', async () => {
      await call('tools/call', {
        name: 'assign_tools_to_gateway',
        arguments: { gatewayId: 'gw-1', toolIds: ['tool-1', 'tool-2'] },
      });
      expect(mockGatewayToolService.bulkAssociateTools).toHaveBeenCalledWith(
        'gw-1',
        { toolIds: ['tool-1', 'tool-2'] },
        'org-1',
        'user-1',
      );
    });

    it('add_auth_to_gateway passes (gatewayId, dto, orgId) not a single object', async () => {
      const res = await call('tools/call', {
        name: 'add_auth_to_gateway',
        arguments: { gatewayId: 'gw-1', type: 'oauth2' },
      });
      // Bug: was passing entire DTO as first arg, causing "invalid uuid" error
      expect(mockGatewayAuthService.createGatewayAuth).toHaveBeenCalledWith(
        'gw-1', // gatewayId as separate string arg
        { type: 'oauth2', configuration: {} },
        'org-1',
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.id).toBe('auth-1');
    });

    it('add_auth_to_gateway sets api_key config defaults', async () => {
      await call('tools/call', {
        name: 'add_auth_to_gateway',
        arguments: { gatewayId: 'gw-1', type: 'api_key' },
      });
      expect(mockGatewayAuthService.createGatewayAuth).toHaveBeenCalledWith(
        'gw-1',
        { type: 'api_key', configuration: { keyHeader: 'x-api-key', keyQuery: 'api_key' } },
        'org-1',
      );
    });

    it('update_api forwards (apiId, patch, orgId) to ApisService.update', async () => {
      mockApisService.update = jest.fn().mockResolvedValue({
        id: 'api-1',
        name: 'a',
        baseUrl: 'https://x',
        authentication: { type: 'api_key', config: {} },
      });
      await call('tools/call', {
        name: 'update_api',
        arguments: {
          apiId: 'api-1',
          authentication: { type: 'api_key', config: { parameter: 'X-Key' } },
        },
      });
      expect(mockApisService.update).toHaveBeenCalledWith(
        'api-1',
        { authentication: { type: 'api_key', config: { parameter: 'X-Key' } } },
        'org-1',
      );
    });

    it('import_schema accepts schemaContent inline (no URL needed)', async () => {
      const queueSpy = jest.fn().mockResolvedValue({ id: 'job-99' });
      (mockSchemaImportQueue as any).add = queueSpy;
      await call('tools/call', {
        name: 'import_schema',
        arguments: {
          apiId: 'api-1',
          schemaContent: '{"openapi":"3.0.0"}',
        },
      });
      expect(queueSpy).toHaveBeenCalledWith(
        'import',
        expect.objectContaining({
          apiId: 'api-1',
          schemaContent: '{"openapi":"3.0.0"}',
        }),
        expect.anything(),
      );
    });

    it('import_schema requires either schemaUrl or schemaContent', async () => {
      const res = await call('tools/call', {
        name: 'import_schema',
        arguments: { apiId: 'api-1' },
      });
      expect(res.result.isError).toBe(true);
      expect(res.result.content[0].text).toMatch(/schemaUrl or schemaContent/);
    });

    it('delete_gateway returns a serializable {deleted, gatewayId} (void Promise was producing invalid MCP content)', async () => {
      mockGatewaysService.deleteGateway = jest.fn().mockResolvedValue(undefined);
      const res = await call('tools/call', {
        name: 'delete_gateway',
        arguments: { gatewayId: 'gw-99' },
      });
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed).toEqual({ deleted: true, gatewayId: 'gw-99' });
      expect(mockGatewaysService.deleteGateway).toHaveBeenCalledWith('gw-99', 'org-1', 'user-1');
    });

    it('delete_tool and delete_api also return serializable confirmations (not undefined)', async () => {
      mockToolsService.deleteTool = jest.fn().mockResolvedValue(undefined);
      mockApisService.remove = jest.fn().mockResolvedValue(undefined);

      const tRes = await call('tools/call', { name: 'delete_tool', arguments: { toolId: 't-1' } });
      expect(JSON.parse(tRes.result.content[0].text)).toEqual({ deleted: true, toolId: 't-1' });

      const aRes = await call('tools/call', { name: 'delete_api', arguments: { apiId: 'a-1' } });
      expect(JSON.parse(aRes.result.content[0].text)).toEqual({ deleted: true, apiId: 'a-1' });
    });

    it('create_gateway defaults UTCP configuration to {protocol: http}', async () => {
      await call('tools/call', {
        name: 'create_gateway',
        arguments: { name: 'My UTCP', type: 'utcp' },
      });
      expect(mockGatewaysService.createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'utcp',
          configuration: { protocol: 'http' },
        }),
        'org-1',
        'user-1',
      );
    });

    it('create_gateway defaults MCP configuration to {transport: http}', async () => {
      await call('tools/call', {
        name: 'create_gateway',
        arguments: { name: 'My MCP', type: 'mcp' },
      });
      expect(mockGatewaysService.createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'mcp',
          configuration: { transport: 'http' },
        }),
        'org-1',
        'user-1',
      );
    });

    it('create_gateway respects explicit configuration override', async () => {
      await call('tools/call', {
        name: 'create_gateway',
        arguments: { name: 'TCP UTCP', type: 'utcp', configuration: { protocol: 'tcp' } },
      });
      expect(mockGatewaysService.createGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          configuration: { protocol: 'tcp' },
        }),
        'org-1',
        'user-1',
      );
    });

    it('remove_auth_from_gateway passes (authId, orgId)', async () => {
      const res = await call('tools/call', {
        name: 'remove_auth_from_gateway',
        arguments: { gatewayId: 'gw-1', authId: 'auth-99' },
      });
      expect(mockGatewayAuthService.deleteGatewayAuth).toHaveBeenCalledWith('auth-99', 'org-1');
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.deleted).toBe(true);
    });

    // ── Memory tools (canonical schema v1) ─────────────────────

    it('memory_put: defaults scope_type=workspace, scope_id=orgId; passes through to canonical service', async () => {
      const res = await call('tools/call', {
        name: 'memory_put',
        arguments: { mode: 'memory', content: 'a useful fact' },
      });
      expect(mockMemoryService.put).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'memory',
          content: 'a useful fact',
          scope: { scope_type: 'workspace', scope_id: 'org-1' },
          tier: 'short',
        }),
        { user_id: 'user-1' },
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.id).toBe('mem-1');
    });

    it('memory_put: forwards explicit scope and tier', async () => {
      await call('tools/call', {
        name: 'memory_put',
        arguments: {
          mode: 'memory',
          content: 'project note',
          scope_type: 'project',
          scope_id: 'proj_42',
          tier: 'project',
          tags: ['note'],
        },
      });
      expect(mockMemoryService.put).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { scope_type: 'project', scope_id: 'proj_42' },
          tier: 'project',
          tags: ['note'],
        }),
        { user_id: 'user-1' },
      );
    });

    it('memory_search: passes query + scope to canonical service and returns ranked items', async () => {
      const res = await call('tools/call', {
        name: 'memory_search',
        arguments: { query: 'cosine similarity' },
      });
      expect(mockMemoryService.search).toHaveBeenCalledWith(
        expect.objectContaining({
          query: 'cosine similarity',
          scope: { scope_type: 'workspace', scope_id: 'org-1' },
          top_k: 10,
        }),
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed[0]).toEqual(
        expect.objectContaining({ id: 'mem-1', score: 0.9, signal: 'hybrid' }),
      );
    });

    it('memory_list: pages with default limit + cursor null', async () => {
      await call('tools/call', { name: 'memory_list', arguments: { mode: 'memory' } });
      expect(mockMemoryService.list).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { scope_type: 'workspace', scope_id: 'org-1' },
          mode: 'memory',
          limit: 50,
          cursor: null,
        }),
      );
    });

    it('memory_get: returns the row when found', async () => {
      const res = await call('tools/call', {
        name: 'memory_get',
        arguments: { id: 'mem-1' },
      });
      expect(mockMemoryService.get).toHaveBeenCalledWith('mem-1');
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.id).toBe('mem-1');
    });

    it('memory_delete: defaults to soft mode', async () => {
      await call('tools/call', {
        name: 'memory_delete',
        arguments: { id: 'mem-1' },
      });
      expect(mockMemoryService.delete).toHaveBeenCalledWith('mem-1', 'soft', {
        user_id: 'user-1',
      });
    });

    it('memory_supersede: forwards old_id + new content as memory mode write', async () => {
      const res = await call('tools/call', {
        name: 'memory_supersede',
        arguments: { old_id: 'mem-1', content: 'corrected fact' },
      });
      expect(mockMemoryService.supersede).toHaveBeenCalledWith(
        'mem-1',
        expect.objectContaining({
          mode: 'memory',
          content: 'corrected fact',
          tier: 'long',
        }),
        { user_id: 'user-1' },
      );
      const parsed = JSON.parse(res.result.content[0].text);
      expect(parsed.old_id).toBe('mem-1');
      expect(parsed.new_id).toBe('mem-2');
    });
  });
});
