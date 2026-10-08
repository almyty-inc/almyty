import 'reflect-metadata';

import * as fs from 'fs';
import * as path from 'path';

import { McpToolHandler } from '../services/mcp-tool.handler';
import { ToolStatus } from '../../../entities/tool.entity';
import { CodeModeService } from '../../code-mode/code-mode.service';
import { snapshotEnv } from '../../../test/env';

/**
 * A tool gateway in `code` or `both` exposure over MCP
 * (docs/design/code-mode.md, part E, decisions 1, 3 and 12): what
 * tools/list shows, and how tools/call answers the meta-tools, over exactly
 * the set tools/list serves.
 */
describe('MCP gateway exposure', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotEnv('CODE_MODE_GATEWAYS', 'MCP_TOOLS_LIST_CACHE_SECONDS');
    process.env.CODE_MODE_GATEWAYS = 'true';
    process.env.MCP_TOOLS_LIST_CACHE_SECONDS = '0';
  });
  afterEach(() => restore());

  const tool = (over: Record<string, any>) => ({
    id: `t-${over.name}`,
    organizationId: 'org-1',
    status: ToolStatus.ACTIVE,
    visibility: 'org',
    sideEffect: 'read',
    parameters: { type: 'object', properties: { petId: { type: 'integer' } } },
    metadata: { sourceApi: { name: 'Petstore' } },
    ...over,
  });

  function build(configuration: Record<string, any>, authConfigs: any[] = [{ type: 'api_key', isActive: true }]) {
    const gateway = { id: 'gw-1', organizationId: 'org-1', type: 'mcp', visibility: 'org', teamId: null, ownerUserId: null, isSystem: false, configuration, authConfigs };
    const served: any[] = [
      tool({ name: 'petstore_get_pet_by_id', description: 'Find a pet by id.' }),
      tool({ name: 'petstore_delete_pet', description: 'Deletes a pet.', sideEffect: 'destructive' }),
    ];
    const gatewayToolRepository: any = {
      find: jest.fn(async () => served.map((t) => ({ isActive: true, tool: t, gateway }))),
      findOne: jest.fn(async ({ where }: any) => {
        const t = served.find((s) => s.name === where?.tool?.name || s.id === where?.toolId);
        return t ? { isActive: true, tool: t, gateway } : null;
      }),
      manager: { getRepository: () => ({ findOne: jest.fn().mockResolvedValue(gateway) }) },
    };
    const runOnGateway = jest.fn(async () => ({ forModel: { status: 'completed', result: 2, calls: { made: 1, ran: 1, failed: 0, staged: 0, refused: 0 } }, isError: false }));
    const executeTool = jest.fn(async () => ({ success: true, data: { id: 7 }, executionTime: 1, cached: false, rateLimited: false, retryCount: 0 }));
    const moduleRef = { get: jest.fn((cls: any) => (cls === CodeModeService ? { runOnGateway } : null)) };
    const handler = new McpToolHandler(
      { find: jest.fn().mockResolvedValue([]), findOne: jest.fn() } as any,
      gatewayToolRepository,
      { find: jest.fn().mockResolvedValue([]) } as any,
      { getTools: jest.fn(async () => ({ tools: [], total: 0 })), findByName: jest.fn() } as any,
      { executeTool } as any,
      { get: jest.fn().mockResolvedValue(null), setex: jest.fn() } as any,
      undefined,
      moduleRef as any,
    );
    return { handler, runOnGateway, executeTool, served };
  }

  const names = async (handler: McpToolHandler) => (await handler.handleToolsList({}, 'org-1', 'gw-1')).tools.map((t: any) => t.name);

  it('lists exactly three tools in code exposure, the tools then four in both, and the tools alone otherwise', async () => {
    expect(await names(build({ exposure: 'code' }).handler)).toEqual(['search_tools', 'get_tool', 'run_code']);
    expect(await names(build({ exposure: 'both' }).handler)).toEqual([
      'petstore_delete_pet',
      'petstore_get_pet_by_id',
      'search_tools',
      'get_tool',
      'call_tool',
      'run_code',
    ]);
    expect(await names(build({}).handler)).toEqual(['petstore_delete_pet', 'petstore_get_pet_by_id']);
  });

  it('serves only its tools while scripts are off for the install, or the gateway admits anyone', async () => {
    expect(await names(build({ exposure: 'code' }, [{ type: 'none', isActive: true }]).handler)).toEqual(['petstore_delete_pet', 'petstore_get_pet_by_id']);
    process.env.CODE_MODE_GATEWAYS = 'false';
    expect(await names(build({ exposure: 'code' }).handler)).toEqual(['petstore_delete_pet', 'petstore_get_pet_by_id']);
    // ...and run_code is then just a name no tool has.
    await expect(build({ exposure: 'code' }).handler.handleToolCall({ name: 'run_code', arguments: { code: 'return 1' } } as any, 'org-1', 'u-1', 'gw-1')).rejects.toMatchObject({ code: -32602 });
  });

  it('runs a script over exactly what the gateway serves, as the gateway', async () => {
    const { handler, runOnGateway, served } = build({ exposure: 'code' });
    const result: any = await handler.handleToolCall({ name: 'run_code', arguments: { code: 'return 2' } } as any, 'org-1', 'u-1', 'gw-1');
    expect(result).toMatchObject({ isError: false, structuredContent: { status: 'completed', result: 2 } });
    const call = (runOnGateway.mock.calls[0] as any[])[0];
    expect(call.gateway).toMatchObject({ id: 'gw-1' });
    expect(call.userId).toBe('u-1');
    expect(call.params).toEqual({ code: 'return 2' });
    expect(call.scope.map((t: any) => t.id).sort()).toEqual(served.map((t) => t.id).sort());
  });

  it('answers search_tools and get_tool from the served set, and keeps call_tool to both', async () => {
    const { handler, executeTool } = build({ exposure: 'code' });
    const found: any = await handler.handleToolCall({ name: 'search_tools', arguments: { query: 'delete pet' } } as any, 'org-1', 'u-1', 'gw-1');
    expect(found.structuredContent.tools[0]).toMatchObject({ name: 'petstore_delete_pet', sideEffect: 'destructive' });
    const got: any = await handler.handleToolCall({ name: 'get_tool', arguments: { name: 'petstore_get_pet_by_id' } } as any, 'org-1', 'u-1', 'gw-1');
    expect(got.structuredContent).toMatchObject({ name: 'petstore_get_pet_by_id', code: { namespace: 'petstore', function: 'getPetById' } });
    const missing: any = await handler.handleToolCall({ name: 'get_tool', arguments: { name: 'nope' } } as any, 'org-1', 'u-1', 'gw-1');
    expect(missing).toMatchObject({ isError: true });
    // No call_tool in code exposure: it is not a tool here.
    await expect(handler.handleToolCall({ name: 'call_tool', arguments: { name: 'petstore_get_pet_by_id' } } as any, 'org-1', 'u-1', 'gw-1')).rejects.toMatchObject({ code: -32602 });
    expect(executeTool).not.toHaveBeenCalled();

    const both = build({ exposure: 'both' });
    const ran: any = await both.handler.handleToolCall({ name: 'call_tool', arguments: { name: 'petstore_get_pet_by_id', arguments: { petId: 7 } } } as any, 'org-1', 'u-1', 'gw-1');
    expect(ran).toMatchObject({ isError: false });
    expect(both.executeTool).toHaveBeenCalledWith('t-petstore_get_pet_by_id', { petId: 7 }, expect.objectContaining({ gatewayId: 'gw-1' }));
  });

  it('resolves run_code against the same scope function tools/call and tools/list use (guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'mcp-tool.handler.ts'), 'utf8');
    const runCode = source.slice(source.indexOf('case RUN_CODE: {'), source.indexOf('codeMode.runOnGateway('));
    expect(runCode).toContain('await this.discoveryScope(organizationId, gateway.id, caller)');
    expect(source).toMatch(/return servableToolsOnGateway\(this\.gatewayToolRepository, gatewayId, \{ operation: true, outputSchema: true, api: true, categories: true \}\);/);
  });
});
