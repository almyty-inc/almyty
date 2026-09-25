import * as crypto from 'crypto';

import { GatewaysController } from '../gateways.controller';
import { GatewayAuthService } from '../gateway-auth.service';
import { GatewayToolService } from '../gateway-tool.service';
import { GatewayToolQueriesHelper } from '../gateway-tool-queries.helper';
import { Gateway, GatewayKind, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { ApiKey } from '../../../entities/api-key.entity';
import { Tool, ToolStatus, ToolType } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture } from '../../../test/execution-access.fixture';

/**
 * Share tools is one step: POST /gateways with the picked tools creates the
 * shared-tools gateway, attaches the tools and mints its access key, and the
 * answer carries the key and what was (and was not) attached.
 *
 * The attach half is the real GatewayToolService over truthful tables, so a
 * picked tool that may not be served (a draft, a team tool on an org-wide
 * gateway) is refused by the same rule the Tools tab applies and reported
 * with its reason; the gateway itself still exists and serves the rest.
 */
describe('POST /gateways with toolIds: share tools in one step', () => {
  const tool = (id: string, name: string, extra: Partial<Tool> = {}) =>
    Object.assign(new Tool(), {
      id,
      name,
      organizationId: CAST.org,
      status: ToolStatus.ACTIVE,
      type: ToolType.API,
      visibility: 'org',
      teamId: null,
      createdBy: CAST.member,
      ...extra,
    });
  const TOOLS = {
    ready: tool('0d000000-0000-4000-8000-000000000001', 'get_weather'),
    alsoReady: tool('0d000000-0000-4000-8000-000000000002', 'list_cities'),
    draft: tool('0d000000-0000-4000-8000-000000000003', 'draft_tool', { status: ToolStatus.DRAFT }),
    team: tool('0d000000-0000-4000-8000-000000000004', 'team_tool', { visibility: 'team', teamId: CAST.team }),
    elsewhere: tool('0d000000-0000-4000-8000-000000000005', 'their_tool', { organizationId: CAST.otherOrg }),
  };

  let gateways: ReturnType<typeof fakeRepository<Gateway>>;
  let gatewayTools: ReturnType<typeof fakeRepository<GatewayTool>>;
  let apiKeys: ReturnType<typeof fakeRepository<ApiKey>>;
  let created: any[];
  let controller: GatewaysController;

  beforeEach(() => {
    const m = castFixture();
    gateways = fakeRepository<Gateway>({ make: () => new Gateway() });
    gatewayTools = fakeRepository<GatewayTool>({ make: () => new GatewayTool() });
    apiKeys = fakeRepository<ApiKey>({ make: () => new ApiKey() });
    const tools = fakeRepository<Tool>({ seed: Object.values(TOOLS), make: () => new Tool() });
    const users = { findOne: async () => ({ hasPermissionInOrganization: () => true }) };
    const redis = { del: jest.fn().mockResolvedValue(1) };
    created = [];

    // Creating the row is GatewaysService's job and has its own specs; here
    // it writes the row it was asked to, so what reached it is inspectable.
    const gatewaysService = {
      createGateway: async (dto: any, organizationId: string, userId: string) => {
        created.push(dto);
        return gateways.save(
          Object.assign(new Gateway(), {
            ...dto,
            id: '0e000000-0000-4000-8000-000000000001',
            kind: Gateway.kindForType(dto.type),
            organizationId,
            ownerUserId: userId,
            status: GatewayStatus.ACTIVE,
            visibility: dto.visibility ?? 'org',
            teamId: dto.teamId ?? null,
          }),
        );
      },
    };
    const queries = new GatewayToolQueriesHelper(
      gatewayTools as any,
      gateways as any,
      tools as any,
      users as any,
      redis as any,
      m.executionAccess,
    );
    const gatewayToolService = new GatewayToolService(
      gatewayTools as any,
      gateways as any,
      tools as any,
      users as any,
      { log: jest.fn() } as any,
      redis as any,
      {} as any,
      {} as any,
      queries,
      m.executionAccess,
    );
    const auth = new GatewayAuthService({} as any, gateways as any, apiKeys as any, {} as any);
    controller = new GatewaysController(gatewaysService as any, auth, gatewayToolService, {} as any, {} as any, {} as any, {} as any);
  });

  const share = (toolIds: string[] | undefined, extra: Record<string, any> = {}) =>
    controller.createGateway(
      { name: 'Weather', type: GatewayType.TOOLS, endpoint: '/weather', configuration: {}, toolIds, ...extra } as any,
      { user: { id: CAST.member, sub: CAST.member, currentOrganizationId: CAST.org } },
    );

  it('creates the gateway, attaches the picked tools and returns a working key at once', async () => {
    const out = await share([TOOLS.ready.id, TOOLS.alsoReady.id]);

    expect(out.data.type).toBe(GatewayType.TOOLS);
    expect(out.data.kind).toBe(GatewayKind.TOOL);
    expect(out.data.sharedTools).toEqual({ associated: 2, skipped: [] });
    const rows = await gatewayTools.find({ where: { gatewayId: out.data.id } });
    expect(rows.map((r) => r.toolId).sort()).toEqual([TOOLS.ready.id, TOOLS.alsoReady.id].sort());
    expect(rows.every((r) => r.isActive)).toBe(true);

    // The key comes back once, in the clear; only its hash is stored, bound
    // to this gateway.
    expect(out.data.initialApiKey).toEqual(expect.any(String));
    const [stored] = await apiKeys.find({ where: { gatewayId: out.data.id } });
    expect(stored.keyHash).toBe(crypto.createHash('sha256').update(out.data.initialApiKey!).digest('hex'));
    expect(stored.organizationId).toBe(CAST.org);
  });

  it('reports each tool it could not share, with the reason, and shares the rest', async () => {
    const out = await share([TOOLS.ready.id, TOOLS.draft.id, TOOLS.team.id, TOOLS.elsewhere.id]);

    expect(out.data.sharedTools!.associated).toBe(1);
    const skipped = Object.fromEntries(out.data.sharedTools!.skipped.map((s) => [s.toolId, s.reason]));
    expect(skipped[TOOLS.draft.id]).toMatch(/draft; a gateway only serves active tools/);
    expect(skipped[TOOLS.team.id]).toMatch(/visible to its team only/);
    expect(skipped[TOOLS.elsewhere.id]).toMatch(/not found in this organization/);
    const rows = await gatewayTools.find({ where: { gatewayId: out.data.id } });
    expect(rows.map((r) => r.toolId)).toEqual([TOOLS.ready.id]);
  });

  it('never writes toolIds onto the gateway row itself', async () => {
    await share([TOOLS.ready.id]);
    expect(created).toHaveLength(1);
    expect(created[0]).not.toHaveProperty('toolIds');
  });

  it('creates a gateway with no tools when none are picked', async () => {
    const out = await share(undefined);
    expect(out.data.sharedTools).toBeUndefined();
    expect(out.data.initialApiKey).toEqual(expect.any(String));
    expect(await gatewayTools.find({ where: { gatewayId: out.data.id } })).toEqual([]);
  });
});
