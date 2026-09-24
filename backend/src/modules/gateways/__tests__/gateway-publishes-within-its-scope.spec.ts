import { BadRequestException, NotFoundException } from '@nestjs/common';

import { GatewaysService } from '../gateways.service';
import { GatewayToolService } from '../gateway-tool.service';
import { Agent } from '../../../entities/agent.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { GatewayTool } from '../../../entities/gateway-tool.entity';
import { Tool, ToolStatus } from '../../../entities/tool.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { CAST, castFixture, MembershipFixture } from '../../../test/execution-access.fixture';

/**
 * The publish-time half of the gateway rule: a gateway can only serve what
 * its own scope covers, and only someone who may run a resource may put it
 * on a gateway. (The call-time half -- the same rule, re-checked on every
 * call -- is in agents/__tests__/team-scope-runtime-and-gateway-paths.)
 *
 * - a team agent or tool: only on a gateway scoped to that team (or private
 *   to someone who may run it);
 * - a private one: only on a gateway private to its owner;
 * - the person publishing must be able to run it: another team's resource
 *   is "not found" to them, exactly as a missing one is.
 *
 * Real GatewaysService.assertContentsServable and
 * GatewayToolService.associateTool over the real ExecutionAccessService;
 * membership rows and tables are in memory.
 */
describe('a gateway publishes only what its scope covers', () => {
  let m: MembershipFixture;
  const agents = () =>
    fakeRepository<Agent>([
      { id: 'team-agent', name: 'team-agent', organizationId: CAST.org, visibility: 'team', teamId: CAST.team, createdBy: CAST.member },
      { id: 'org-agent', name: 'org-agent', organizationId: CAST.org, visibility: 'org', teamId: null, createdBy: CAST.member },
    ] as any);

  beforeEach(() => {
    m = castFixture();
  });

  describe('an agent-kind gateway (create / update)', () => {
    function service() {
      const agentRows = agents();
      // The one manager call assertContentsServable makes, answered from the table.
      const manager = { findOne: (_entity: unknown, options: any) => agentRows.findOne(options) };
      const gateways = Object.assign(fakeRepository<Gateway>([]), { manager });
      return new GatewaysService(
        gateways as any,
        fakeRepository<GatewayTool>([]) as any,
        {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
        m.accessPolicy,
      );
    }
    const gateway = (scope: Partial<Gateway>, agentId = 'team-agent') =>
      ({ organizationId: CAST.org, agentId, visibility: 'org', teamId: null, ownerUserId: CAST.member, ...scope }) as Gateway;

    it('refuses a team agent on an org-wide gateway with a 400 that says what to change', async () => {
      await expect(service().assertContentsServable(gateway({}), CAST.member)).rejects.toThrow(
        /visible to its team only; it can only be served through a gateway scoped to that team/,
      );
    });

    it('refuses a team agent on another team\'s gateway', async () => {
      await expect(
        service().assertContentsServable(gateway({ visibility: 'team', teamId: CAST.otherTeam }), CAST.member),
      ).rejects.toThrow(BadRequestException);
    });

    it.each([
      ['a member of the team', CAST.member],
      ['an org admin', CAST.admin],
    ])('lets %s publish a team agent on a gateway scoped to its team', async (_l, who) => {
      await expect(
        service().assertContentsServable(gateway({ visibility: 'team', teamId: CAST.team, ownerUserId: who }), who),
      ).resolves.toBeUndefined();
    });

    it('a non-member cannot publish a team agent anywhere: it is not found to them', async () => {
      await expect(
        service().assertContentsServable(gateway({ visibility: 'team', teamId: CAST.team, ownerUserId: CAST.nonMember }), CAST.nonMember),
      ).rejects.toThrow(new NotFoundException('Agent not found'));
    });

    it('lets a member publish a team agent on their own private gateway', async () => {
      await expect(
        service().assertContentsServable(gateway({ visibility: 'private', ownerUserId: CAST.member }), CAST.member),
      ).resolves.toBeUndefined();
    });

    it('any gateway of the org may serve an org agent', async () => {
      await expect(service().assertContentsServable(gateway({}, 'org-agent'), CAST.nonMember)).resolves.toBeUndefined();
    });
  });

  describe('attaching a tool to a gateway', () => {
    const GATEWAYS = [
      { id: 'gw-org', name: 'org', organizationId: CAST.org, type: GatewayType.MCP, status: GatewayStatus.ACTIVE, visibility: 'org', teamId: null, ownerUserId: CAST.member },
      { id: 'gw-team', name: 'team', organizationId: CAST.org, type: GatewayType.MCP, status: GatewayStatus.ACTIVE, visibility: 'team', teamId: CAST.team, ownerUserId: CAST.member },
      { id: 'gw-private-nonmember', name: 'mine', organizationId: CAST.org, type: GatewayType.MCP, status: GatewayStatus.ACTIVE, visibility: 'private', teamId: null, ownerUserId: CAST.nonMember },
    ];
    const TOOLS = [
      { id: 'team-tool', name: 'team-tool', organizationId: CAST.org, status: ToolStatus.ACTIVE, visibility: 'team', teamId: CAST.team, createdBy: CAST.member },
    ];

    function service() {
      const gatewayTools = fakeRepository<GatewayTool>([]);
      const svc = new GatewayToolService(
        gatewayTools as any,
        fakeRepository<Gateway>(GATEWAYS as any) as any,
        fakeRepository<Tool>(TOOLS as any) as any,
        { findOne: async () => ({ hasPermissionInOrganization: () => true }) } as any,
        { log: jest.fn() } as any,
        { del: jest.fn().mockResolvedValue(1) } as any,
        {} as any,
        {} as any,
        {} as any,
        m.executionAccess,
      );
      return { svc, gatewayTools };
    }
    const attach = (svc: GatewayToolService, gatewayId: string, who: string) =>
      svc.associateTool(gatewayId, { toolId: 'team-tool' }, CAST.org, who);

    it.each([
      ['a member of the team', CAST.member],
      ['an org admin', CAST.admin],
    ])('lets %s attach a team tool to the gateway scoped to its team', async (_l, who) => {
      const { svc, gatewayTools } = service();
      await attach(svc, 'gw-team', who);
      expect(gatewayTools.rows().map((r) => r.toolId)).toEqual(['team-tool']);
    });

    it('refuses a team tool on an org-wide gateway', async () => {
      const { svc, gatewayTools } = service();
      await expect(attach(svc, 'gw-org', CAST.member)).rejects.toThrow(/visible to its team only/);
      expect(gatewayTools.rows()).toHaveLength(0);
    });

    it('a non-member cannot attach a team tool, even to their own private gateway: not found', async () => {
      const { svc, gatewayTools } = service();
      await expect(attach(svc, 'gw-private-nonmember', CAST.nonMember)).rejects.toThrow(new NotFoundException('Tool not found'));
      expect(gatewayTools.rows()).toHaveLength(0);
    });

    it('fails closed when the gate is not wired', async () => {
      const svc = new GatewayToolService(
        fakeRepository<GatewayTool>([]) as any,
        fakeRepository<Gateway>(GATEWAYS as any) as any,
        fakeRepository<Tool>(TOOLS as any) as any,
        {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      );
      await expect(attach(svc, 'gw-team', CAST.member)).rejects.toThrow(/not configured/);
    });
  });
});
