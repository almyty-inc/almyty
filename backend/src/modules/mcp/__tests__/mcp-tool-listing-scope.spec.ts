import 'reflect-metadata';

import { McpToolHandler } from '../services/mcp-tool.handler';

// `bypassTeamFilter: true` is documented as safe in tools.dto.ts *because*
// gateway-tool resolution gates access by gateway membership. On the
// gateway-less MCP path there is no gateway -- gatewayId is undefined on every
// call from McpController and from the transports -- so nothing compensated:
// tools.service.ts filtered on organization alone, skipped
// AccessPolicyService.applyListFilter, and served every tool in the org
// including team-scoped tools the caller holds no membership for.
describe('MCP tool listing scope', () => {
  let toolsService: any;
  let gatewayToolRepository: any;
  let redis: any;
  let handler: McpToolHandler;

  beforeEach(() => {
    toolsService = {
      getTools: jest.fn().mockResolvedValue({ tools: [], total: 0 }),
      findByName: jest.fn().mockResolvedValue(null),
    };
    gatewayToolRepository = { find: jest.fn().mockResolvedValue([]) };
    redis = { get: jest.fn().mockResolvedValue(null), setex: jest.fn().mockResolvedValue('OK') };

    handler = new McpToolHandler(
      { find: jest.fn().mockResolvedValue([]) } as any,
      gatewayToolRepository as any,
      { find: jest.fn().mockResolvedValue([]) } as any,
      toolsService as any,
      { executeTool: jest.fn() } as any,
      redis as any,
    );
  });

  it('scopes a gateway-less tools/list to the caller instead of bypassing the team filter', async () => {
    await handler.handleToolsList({}, 'org-1', undefined, { id: 'u-1' });

    expect(toolsService.getTools).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', caller: { id: 'u-1' } }),
    );
    expect(toolsService.getTools.mock.calls[0][0].bypassTeamFilter).toBeUndefined();
  });

  it('refuses a gateway-less tools/list with no caller rather than falling back to the org-wide read', async () => {
    await expect(handler.handleToolsList({}, 'org-1')).rejects.toMatchObject({
      code: -32600,
    });
    expect(toolsService.getTools).not.toHaveBeenCalled();
  });

  it('refuses a gateway-less tools/search with no caller', async () => {
    await expect(handler.handleToolsSearch({ query: 'x' }, 'org-1')).rejects.toMatchObject({
      code: -32600,
    });
    expect(toolsService.getTools).not.toHaveBeenCalled();
  });

  it('refuses a gateway-less getToolsForScope with no caller', async () => {
    await expect(handler.getToolsForScope('org-1')).rejects.toMatchObject({ code: -32600 });
    expect(toolsService.getTools).not.toHaveBeenCalled();
  });

  it('scopes a gateway-less tools/search to the caller', async () => {
    await handler.handleToolsSearch({ query: 'x' }, 'org-1', undefined, { id: 'u-1' });

    expect(toolsService.getTools).toHaveBeenCalledWith(
      expect.objectContaining({ caller: { id: 'u-1' } }),
    );
    expect(toolsService.getTools.mock.calls[0][0].bypassTeamFilter).toBeUndefined();
  });

  it('keeps the bypass on the gateway path, where gateway membership gates access', async () => {
    await handler.handleToolsList({}, 'org-1', 'gw-1');

    expect(gatewayToolRepository.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gatewayId: 'gw-1', isActive: true } }),
    );
    expect(toolsService.getTools).not.toHaveBeenCalled();
  });

  it('does not let one caller read another caller cached scoped listing', async () => {
    await handler.handleToolsList({}, 'org-1', undefined, { id: 'u-1' });
    await handler.handleToolsList({}, 'org-1', undefined, { id: 'u-2' });

    const keys = redis.setex.mock.calls.map((c: any[]) => c[0]);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain('u-1');
    expect(keys[1]).toContain('u-2');
  });
});
