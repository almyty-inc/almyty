import { UtcpService } from '../utcp.service';
import { ToolStatus } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { utcpMetaToolName } from '../../gateways/unified-gateway-delegation.helper';

/**
 * A UTCP gateway in `code` or `both` exposure (docs/design/code-mode.md,
 * part E): the manual lists the meta-tools with this gateway's call
 * templates, and UTCP code-mode's names are accepted for the same tools
 * (decision 2). The work itself is the MCP handler's.
 */
describe('UTCP gateway exposure', () => {
  const gateway = (exposure?: string) => ({
    id: 'gw-1',
    name: 'Pets',
    type: 'utcp',
    endpoint: '/pets',
    organizationId: 'org-1',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
    configuration: exposure ? { exposure } : {},
    authConfigs: [{ type: 'api_key', isActive: true, configuration: { headerName: 'X-API-Key' } }],
  });
  const tool = { id: 'tool-1', organizationId: 'org-1', name: 'find_pets', description: 'Find pets.', parameters: { type: 'object' }, status: ToolStatus.ACTIVE, visibility: 'org', metadata: {} };

  function build(exposure: string) {
    const gw = gateway(exposure);
    const callGatewayMetaTool = jest.fn(async (params: any) => ({ content: [{ type: 'text', text: '{}' }], structuredContent: { ran: params.name }, isError: false }));
    const mcpTools = { exposureOf: jest.fn(async () => ({ exposure: exposure === 'tools' ? 'tools' : exposure, gateway: gw })), callGatewayMetaTool };
    const service = new UtcpService(
      {} as any,
      {} as any,
      { findOne: jest.fn().mockResolvedValue(null) } as any,
      { findOne: jest.fn().mockResolvedValue({ id: 'org-1' }) } as any,
      fakeRepository<any>([{ gatewayId: 'gw-1', toolId: 'tool-1', isActive: true, tool, gateway: gw }]) as any,
      {} as any,
      { executeTool: jest.fn() } as any,
      { get: jest.fn().mockResolvedValue(null), setex: jest.fn() } as any,
      mcpTools as any,
    );
    return { service, gw, callGatewayMetaTool };
  }

  it('lists the three meta-tools in code exposure, each called at this gateway with its auth', async () => {
    const { service, gw } = build('code');
    const manual = await service.generateManual({ baseUrl: 'https://api.test', orgSlug: 'acme', organizationId: 'org-1', gateway: gw as any });
    expect(manual.tools.map((t) => t.name)).toEqual(['search_tools', 'get_tool', 'run_code']);
    const runCode = manual.tools.find((t) => t.name === 'run_code')!;
    expect(runCode.tool_call_template).toMatchObject({ url: 'https://api.test/acme/pets/execute/meta/run_code', http_method: 'POST' });
    expect((runCode.tool_call_template as any).auth).toBeDefined();
  });

  it('lists the tools then the meta-tools in both, and the tools alone in tools', async () => {
    const both = build('both');
    const names = (await both.service.generateManual({ baseUrl: 'https://api.test', orgSlug: 'acme', organizationId: 'org-1', gateway: both.gw as any })).tools.map((t) => t.name);
    expect(names).toEqual(['find_pets', 'search_tools', 'get_tool', 'call_tool', 'run_code']);
    const plain = build('tools');
    const only = (await plain.service.generateManual({ baseUrl: 'https://api.test', orgSlug: 'acme', organizationId: 'org-1', gateway: plain.gw as any })).tools.map((t) => t.name);
    expect(only).toEqual(['find_pets']);
  });

  it("runs UTCP code-mode's call_tool_chain and tool_info as run_code and get_tool", async () => {
    const { service, callGatewayMetaTool } = build('code');
    const chained = await service.executeMetaTool('call_tool_chain', { code: 'return 1' }, 'org-1', 'u-1', 'gw-1');
    expect(chained).toMatchObject({ success: true, data: { ran: 'run_code' } });
    expect(callGatewayMetaTool.mock.calls[0][0]).toEqual({ name: 'run_code', arguments: { code: 'return 1' } });
    await service.executeMetaTool('tool_info', { name: 'find_pets' }, 'org-1', 'u-1', 'gw-1');
    expect(callGatewayMetaTool.mock.calls[1][0]).toEqual({ name: 'get_tool', arguments: { name: 'find_pets' } });
  });

  it('has no meta-tools in tools exposure, and no call_tool in code', async () => {
    const plain = build('tools');
    expect(await plain.service.executeMetaTool('run_code', { code: 'return 1' }, 'org-1', 'u-1', 'gw-1')).toMatchObject({ success: false, error: { code: 'TOOL_NOT_FOUND' } });
    const code = build('code');
    expect(await code.service.executeMetaTool('call_tool', { name: 'find_pets' }, 'org-1', 'u-1', 'gw-1')).toMatchObject({ success: false });
    expect(code.callGatewayMetaTool).not.toHaveBeenCalled();
  });

  it('routes execute/meta/<name> and nothing else to the meta-tools', () => {
    expect(utcpMetaToolName('execute/meta/run_code')).toBe('run_code');
    expect(utcpMetaToolName('execute/meta/call_tool_chain')).toBe('call_tool_chain');
    expect(utcpMetaToolName('execute/tool-1')).toBeNull();
    expect(utcpMetaToolName('execute/meta/../x')).toBeNull();
  });
});
