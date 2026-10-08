import 'reflect-metadata';

import { McpToolHandler } from '../services/mcp-tool.handler';
import { ToolStatus } from '../../../entities/tool.entity';

/**
 * tools/search and tools/get, now the search_tools ranking and get_tool's
 * full detail over exactly the tools/list set (docs/design/code-mode.md,
 * part B), in the shapes these methods have always answered with.
 */
describe('MCP tools/search and tools/get over the tools/list set', () => {
  const gateway = { id: 'gw-1', organizationId: 'org-1', visibility: 'org', teamId: null, ownerUserId: null, isSystem: false };
  const tool = (over: Record<string, any>) => ({
    id: `t-${over.name}`,
    organizationId: 'org-1',
    status: ToolStatus.ACTIVE,
    visibility: 'org',
    sideEffect: 'read',
    openWorld: true,
    parameters: { type: 'object', properties: { petId: { type: 'integer' } }, required: ['petId'] },
    metadata: { sourceApi: { name: 'Petstore' } },
    ...over,
  });

  let served: any[];
  let handler: McpToolHandler;

  beforeEach(() => {
    served = [
      tool({ name: 'petstore_get_pet_by_id', description: 'Find a pet by id.', metadata: { sourceApi: { name: 'Petstore' }, sourceOperation: { name: 'getPetById' } } }),
      tool({ name: 'petstore_delete_pet', description: 'Deletes a pet.', sideEffect: 'destructive' }),
    ];
    const gatewayToolRepository: any = {
      find: jest.fn(async () => served.map((t) => ({ isActive: true, tool: t, gateway }))),
      manager: { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(gateway) }) },
    };
    handler = new McpToolHandler(
      { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } as any,
      gatewayToolRepository,
      { find: jest.fn().mockResolvedValue([]) } as any,
      // An org-wide tool the gateway does not serve: the off-gateway path only.
      { getTools: jest.fn(async () => ({ tools: [tool({ name: 'petstore_admin_reset' })], total: 1 })), findByName: jest.fn() } as any,
      { executeTool: jest.fn() } as any,
      { get: jest.fn().mockResolvedValue(null), setex: jest.fn() } as any,
    );
  });

  it('ranks only what the gateway serves, and says what each hit does to data', async () => {
    const result = await handler.handleToolsSearch({ query: 'delete pet' }, 'org-1', 'gw-1');
    expect(result.tools[0]).toMatchObject({ name: 'petstore_delete_pet', sideEffect: 'destructive' });
    expect(result.tools.map((t: any) => t.name)).not.toContain('petstore_admin_reset');
    expect(await handler.handleToolsSearch({ query: 'admin reset' }, 'org-1', 'gw-1')).toMatchObject({ tools: [], total: 0 });
  });

  it('pages a ranking as tools/search always has', async () => {
    const first = await handler.handleToolsSearch({ query: 'pet', limit: 1 }, 'org-1', 'gw-1');
    const second = await handler.handleToolsSearch({ query: 'pet', limit: 1, page: 2 }, 'org-1', 'gw-1');
    expect([first.total, first.hasMore, second.hasMore]).toEqual([2, true, false]);
    expect(first.tools[0].name).not.toBe(second.tools[0].name);
  });

  it('describes a served tool with its class, code name and signature', async () => {
    const result = await handler.handleToolGet({ name: 'petstore_get_pet_by_id' }, 'org-1', undefined, 'gw-1');
    expect(result).toMatchObject({
      name: 'petstore_get_pet_by_id',
      sideEffect: 'read',
      code: { namespace: 'petstore', function: 'getPetById' },
      signature: '/** Find a pet by id. */\npetstore.getPetById(args: { petId: number }): Promise<unknown>',
    });
  });

  it('answers a tool the gateway does not serve as unknown, like tools/call (-32602)', async () => {
    await expect(handler.handleToolGet({ name: 'petstore_admin_reset' }, 'org-1', undefined, 'gw-1')).rejects.toMatchObject({ code: -32602 });
  });

  it('pages through every tool of the caller off a gateway', async () => {
    const getTools = jest.fn(async ({ page }: any) => ({
      tools: page === 1 ? Array.from({ length: 100 }, (_, i) => tool({ name: `bulk_${i}` })) : [tool({ name: 'last_one' })],
      total: 101,
    }));
    (handler as any).toolsService = { getTools };
    const result = await handler.handleToolsSearch({ query: 'last' }, 'org-1', undefined, { id: 'u-1' });
    expect(result.tools.map((t: any) => t.name)).toEqual(['last_one']);
    expect(getTools).toHaveBeenCalledTimes(2);
    expect(getTools.mock.calls[0][0]).toMatchObject({ caller: { id: 'u-1' }, status: ToolStatus.ACTIVE, page: 1, limit: 100 });
  });
});
