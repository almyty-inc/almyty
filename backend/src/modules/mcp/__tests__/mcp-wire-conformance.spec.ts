import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { McpService } from '../mcp.service';
import { McpToolHandler } from '../services/mcp-tool.handler';
import { McpContentHandler } from '../services/mcp-content.handler';
import { McpServerRequestService } from '../services/mcp-server-request.service';
import { Tool } from '../../../entities/tool.entity';
import { Resource } from '../../../entities/resource.entity';
import { Organization } from '../../../entities/organization.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { ToolCategory } from '../../../entities/tool-category.entity';
import { ToolsService } from '../../tools/tools.service';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { SkillGeneratorService } from '../../tools/skill-generator.service';
import { PromotedSkillsService } from '../../promoted-skills/promoted-skills.service';

/**
 * MCP wire conformance of McpService and the tools/list handler.
 *
 * Everything here pins a rule of JSON-RPC 2.0 or of the MCP revision this
 * server negotiates (2025-03-26 for a modern client), not an implementation
 * detail.
 */
describe('MCP wire conformance', () => {
  let service: McpService;
  let toolsService: any;
  let redis: any;

  beforeEach(async () => {
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      setex: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      keys: jest.fn().mockResolvedValue([]),
      lpush: jest.fn().mockResolvedValue(1),
      ltrim: jest.fn().mockResolvedValue('OK'),
      llen: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpToolHandler,
        McpContentHandler,
        McpServerRequestService,
        McpService,
        { provide: PromotedSkillsService, useValue: { listForServing: jest.fn().mockResolvedValue([]), get: jest.fn() } },
        { provide: getRepositoryToken(Tool), useValue: { find: jest.fn(), findOne: jest.fn() } },
        { provide: getRepositoryToken(Resource), useValue: { find: jest.fn(), findOne: jest.fn() } },
        { provide: getRepositoryToken(Organization), useValue: { findOne: jest.fn() } },
        { provide: getRepositoryToken(Gateway), useValue: { find: jest.fn(), findOne: jest.fn() } },
        { provide: getRepositoryToken(GatewayTool), useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } },
        { provide: getRepositoryToken(ToolCategory), useValue: { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } },
        { provide: ToolsService, useValue: { getTools: jest.fn(), getTool: jest.fn(), findByName: jest.fn() } },
        { provide: ToolExecutorService, useValue: { executeTool: jest.fn() } },
        { provide: SkillGeneratorService, useValue: { generateToolSkill: jest.fn(), generateGatewaySkills: jest.fn() } },
        { provide: 'default_IORedisModuleConnectionToken', useValue: redis },
      ],
    }).compile();

    service = module.get(McpService);
    toolsService = module.get(ToolsService);
  });

  const makeTools = (n: number, offset = 0) =>
    Array.from({ length: n }, (_, i) => ({
      id: `t-${offset + i}`,
      name: `tool_${offset + i}`,
      description: 'd',
      parameters: { type: 'object', properties: {} },
    }));

  // ── Notifications (JSON-RPC 2.0 §4.1) ───────────────────────────────

  // A notification is ANY message with no `id`. Keying off a
  // `notifications/` method prefix answered `{"jsonrpc":"2.0","method":"ping"}`
  // with a -32600 error — wrong, and itself a reply to a notification.
  it('never answers an id-less message, whatever its method name', async () => {
    await expect(service.handleJsonRpc({ jsonrpc: '2.0', method: 'ping' }, 'org-1', 'u-1')).resolves.toBeNull();
  });

  it('never answers an id-less message whose method does not exist', async () => {
    await expect(
      service.handleJsonRpc({ jsonrpc: '2.0', method: 'no/such/method' }, 'org-1', 'u-1'),
    ).resolves.toBeNull();
  });

  it('still answers a request that does carry an id', async () => {
    const res: any = await service.handleJsonRpc({ jsonrpc: '2.0', id: 3, method: 'ping' }, 'org-1', 'u-1');
    expect(res).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
  });

  // ── id coercion ─────────────────────────────────────────────────────

  // `0` is a legal JSON-RPC id. `requestBody?.id || null` rewrote it to
  // null, so the client could not correlate the error and its call hung.
  it('preserves id 0 on an error response', async () => {
    const res: any = await service.handleJsonRpc({ jsonrpc: '2.0', id: 0, method: 'no/such/method' }, 'org-1', 'u-1');
    expect(res.id).toBe(0);
    expect(res.error.code).toBe(-32601);
  });

  // ── Batch (required by the 2025-03-26 revision) ─────────────────────

  it('accepts a JSON-RPC batch and answers with an array in order', async () => {
    const res: any = await service.handleJsonRpcMessage(
      [
        { jsonrpc: '2.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: 2, method: 'ping' },
      ],
      'org-1',
      'u-1',
    );
    expect(Array.isArray(res)).toBe(true);
    expect(res).toEqual([
      { jsonrpc: '2.0', id: 1, result: {} },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });

  it('omits the notification members of a batch from the response array', async () => {
    const res: any = await service.handleJsonRpcMessage(
      [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 9, method: 'ping' },
      ],
      'org-1',
      'u-1',
    );
    expect(res).toEqual([{ jsonrpc: '2.0', id: 9, result: {} }]);
  });

  it('returns nothing at all for a batch of nothing but notifications', async () => {
    await expect(
      service.handleJsonRpcMessage([{ jsonrpc: '2.0', method: 'notifications/initialized' }], 'org-1', 'u-1'),
    ).resolves.toBeNull();
  });

  // JSON-RPC 2.0 §6: an empty array is an Invalid Request, answered with a
  // single (non-array) error response.
  it('answers an empty batch with a single -32600 error, not an array', async () => {
    const res: any = await service.handleJsonRpcMessage([], 'org-1', 'u-1');
    expect(Array.isArray(res)).toBe(false);
    expect(res).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: expect.any(String) } });
  });

  // ── tools/list paging ───────────────────────────────────────────────

  // getTools' own default limit is 20, so the org-wide listing was
  // truncated to 20 rows and — because 20 never exceeds the page size of
  // 100 — no nextCursor was ever emitted. The client could not reach the
  // rest of its tools at all.
  it('asks the database for a full page of tools, not getTools default of 20', async () => {
    toolsService.getTools.mockResolvedValue({ tools: makeTools(100), total: 250 });

    const res: any = await service.handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      'org-1',
      'u-1',
    );

    expect(toolsService.getTools).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', page: 1, limit: 100 }),
    );
    expect(res.result.tools).toHaveLength(100);
    expect(res.result.nextCursor).toBe('100');
  });

  it('serves the second page from the database and keeps paging until the end', async () => {
    toolsService.getTools.mockResolvedValue({ tools: makeTools(100, 100), total: 250 });

    const res: any = await service.handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: '100' } },
      'org-1',
      'u-1',
    );

    expect(toolsService.getTools).toHaveBeenCalledWith(expect.objectContaining({ page: 2, limit: 100 }));
    expect(res.result.tools[0].name).toBe('tool_100');
    expect(res.result.nextCursor).toBe('200');
  });

  it('stops emitting nextCursor on the last page', async () => {
    toolsService.getTools.mockResolvedValue({ tools: makeTools(50, 200), total: 250 });

    const res: any = await service.handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: '200' } },
      'org-1',
      'u-1',
    );

    expect(res.result.tools).toHaveLength(50);
    expect(res.result.nextCursor).toBeUndefined();
  });

  // The cached VALUE is one page, so the key has to name the page.
  it('keys the tools/list cache by cursor, so page 2 is not served page 1', async () => {
    toolsService.getTools.mockResolvedValue({ tools: makeTools(100), total: 250 });
    await service.handleJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'org-1', 'u-1');

    toolsService.getTools.mockResolvedValue({ tools: makeTools(100, 100), total: 250 });
    await service.handleJsonRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { cursor: '100' } },
      'org-1',
      'u-1',
    );

    const readKeys = redis.get.mock.calls.map((c: any[]) => c[0]);
    const writtenKeys = redis.setex.mock.calls.map((c: any[]) => c[0]);
    expect(new Set(readKeys).size).toBe(2);
    expect(new Set(writtenKeys).size).toBe(2);
    expect(writtenKeys[0]).toContain('cursor:0');
    expect(writtenKeys[1]).toContain('cursor:100');
  });

  // MCP: a cursor the server did not issue is -32602 Invalid params.
  it('rejects a cursor it never minted with -32602', async () => {
    toolsService.getTools.mockResolvedValue({ tools: [], total: 0 });

    const res: any = await service.handleJsonRpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: 'not-a-cursor' } },
      'org-1',
      'u-1',
    );

    expect(res.error.code).toBe(-32602);
    expect(toolsService.getTools).not.toHaveBeenCalled();
  });
});
