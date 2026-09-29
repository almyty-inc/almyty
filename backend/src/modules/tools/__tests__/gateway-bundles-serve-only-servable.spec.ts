import { CodegenService } from '../codegen.service';
import { CliGeneratorService } from '../cli-generator.service';
import { Tool, ToolStatus, ToolType } from '../../../entities/tool.entity';
import { GatewayType, GatewayStatus } from '../../../entities/gateway.entity';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * A generated SDK or CLI bundle is a listing of the gateway: it names every
 * tool the gateway serves and wires a call to each. It must be the same set
 * MCP tools/list and UTCP /tools answer (gateway-servable): attached and
 * enabled, the tool itself active, and in the gateway's scope. A draft,
 * retired or disabled tool, or one the gateway's scope does not reach, is
 * not in the bundle.
 */
describe('gateway SDK and CLI bundles serve only what the gateway serves', () => {
  const ORG = 'org-1';
  const OWNER = 'user-owner';

  const gateway = {
    id: 'gw-team-a',
    organizationId: ORG,
    name: 'Team A Gateway',
    type: GatewayType.MCP,
    status: GatewayStatus.ACTIVE,
    visibility: 'team',
    teamId: 'team-a',
    ownerUserId: null,
  };

  const tool = (name: string, extra: Partial<Tool> = {}): Partial<Tool> => ({
    id: `tool-${name}`,
    name,
    organizationId: ORG,
    description: `${name} tool`,
    type: ToolType.QUERY,
    status: ToolStatus.ACTIVE,
    visibility: 'org',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    operation: { id: `op-${name}`, method: 'GET', endpoint: `/${name}` } as any,
    ...extra,
  });

  const rows = [
    { tool: tool('servedorg'), isActive: true },
    { tool: tool('servedteam', { visibility: 'team', teamId: 'team-a' } as any), isActive: true },
    { tool: tool('drafttool', { status: ToolStatus.DRAFT }), isActive: true },
    { tool: tool('retiredtool', { status: ToolStatus.DEPRECATED }), isActive: true },
    { tool: tool('inactivetool', { status: ToolStatus.INACTIVE }), isActive: true },
    { tool: tool('detachedtool'), isActive: false },
    { tool: tool('otherteamtool', { visibility: 'team', teamId: 'team-b' } as any), isActive: true },
    { tool: tool('privatetool', { visibility: 'private', ownerUserId: OWNER, createdBy: OWNER } as any), isActive: true },
  ];

  const HIDDEN = ['drafttool', 'retiredtool', 'inactivetool', 'detachedtool', 'otherteamtool', 'privatetool'];

  function repos() {
    const gateways = fakeRepository([gateway as any]);
    const gatewayTools = fakeRepository(
      rows.map((r, i) => ({ id: `gt-${i}`, gatewayId: gateway.id, toolId: r.tool.id, isActive: r.isActive, tool: r.tool, gateway })),
    );
    const tools = fakeRepository(rows.map((r) => r.tool));
    return { gateways, gatewayTools, tools };
  }

  it('the SDK has the servable tools and nothing else', async () => {
    const { gateways, gatewayTools, tools } = repos();
    const service = new CodegenService(tools as any, gateways as any, gatewayTools as any);

    const sdk = await service.generateGatewaySdk(gateway.id, ORG);

    expect(sdk.toolCount).toBe(2);
    const paths = sdk.files.map((f) => f.path);
    expect(paths).toContain('src/servedorg.ts');
    expect(paths).toContain('src/servedteam.ts');
    const everything = sdk.files.map((f) => `${f.path}\n${f.content}`).join('\n');
    for (const name of HIDDEN) expect(everything).not.toContain(name);
  });

  it.each(['bash', 'node'] as const)('the %s CLI bundle has the servable tools and nothing else', async (format) => {
    const { gateways, gatewayTools, tools } = repos();
    const service = new CliGeneratorService(tools as any, gateways as any, gatewayTools as any);

    const cli = await service.generateGatewayCliBunde(gateway.id, format, ORG);

    expect(cli.toolCount).toBe(2);
    expect(cli.content).toContain('servedorg');
    expect(cli.content).toContain('servedteam');
    for (const name of HIDDEN) expect(cli.content).not.toContain(name);
  });
});
