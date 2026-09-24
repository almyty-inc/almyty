import { NotFoundException } from '@nestjs/common';

import { fakeRepository, FakeRepository } from '../../../test/fake-repository';
import { User } from '../../../entities/user.entity';
import { GatewayToolTransferHelper } from '../gateway-tool-transfer.helper';
import { GatewayToolQueriesHelper } from '../gateway-tool-queries.helper';
import { GatewayToolService } from '../gateway-tool.service';
import { GatewayToolStatsHelper } from '../gateway-tool-stats.helper';

/**
 * Gateway-tool operations only reach gateways of the caller's organization.
 *
 * `gateway-tool.service.spec.ts` stubs `gatewayRepository.findOne` and
 * `gatewayToolRepository.findOne` with canned rows, so the
 * `organizationId` in those lookups -- and the org check after the
 * association lookup -- could be deleted with it green. Here the tables
 * evaluate the `where`, and a foreign org's gateway sits next to ours.
 */
describe('gateway-tool operations are scoped to the caller organization', () => {
  const ORG = 'org-mine';
  const OTHER = 'org-other';
  const USER = 'user-1';

  let gateways: FakeRepository<any>;
  let gatewayTools: FakeRepository<any>;
  let tools: FakeRepository<any>;
  let users: FakeRepository<User>;
  let transfer: GatewayToolTransferHelper;
  let queries: GatewayToolQueriesHelper;
  let service: GatewayToolService;

  beforeEach(() => {
    const mineGw = { id: 'gw-mine', organizationId: ORG, name: 'Mine', visibility: 'org' };
    const mine2Gw = { id: 'gw-mine-2', organizationId: ORG, name: 'Mine 2', visibility: 'org' };
    const foreignGw = { id: 'gw-foreign', organizationId: OTHER, name: 'Theirs', visibility: 'org' };
    gateways = fakeRepository<any>([mineGw, mine2Gw, foreignGw]);
    tools = fakeRepository<any>([
      { id: 'tool-mine', organizationId: ORG, name: 'mine', visibility: 'org' },
      { id: 'tool-foreign', organizationId: OTHER, name: 'theirs', visibility: 'org' },
    ]);
    gatewayTools = fakeRepository<any>([
      { id: 'gt-mine', gatewayId: 'gw-mine', toolId: 'tool-mine', isActive: true, gateway: mineGw, tool: { id: 'tool-mine', name: 'mine', visibility: 'org' } },
      { id: 'gt-foreign', gatewayId: 'gw-foreign', toolId: 'tool-foreign', isActive: true, gateway: foreignGw, tool: { id: 'tool-foreign', name: 'theirs', visibility: 'org' } },
    ]);
    users = fakeRepository<User>({
      seed: [{ id: USER, organizationMemberships: [{ organizationId: ORG, role: 'owner', isActive: true } as any] }],
      make: () => new User(),
    });
    const redis = { del: jest.fn(async () => 1) } as any;
    const audit = { log: jest.fn() } as any;

    transfer = new GatewayToolTransferHelper(gatewayTools as any, gateways as any, users as any, audit, redis);
    queries = new GatewayToolQueriesHelper(gatewayTools as any, gateways as any, tools as any, users as any, redis);
    service = new GatewayToolService(
      gatewayTools as any, gateways as any, tools as any, users as any, audit, redis,
      transfer, {} as any, queries,
    );
  });

  const foreignRowsIntact = () =>
    expect(gatewayTools.rows().filter((r) => r.gatewayId === 'gw-foreign').map((r) => r.id)).toEqual(['gt-foreign']);

  describe('copyToolsFromGateway', () => {
    it('copies between two gateways of the caller organization', async () => {
      const result = await transfer.copyToolsFromGateway('gw-mine', 'gw-mine-2', ORG, USER);

      expect(result.copied).toHaveLength(1);
      expect(gatewayTools.rows().filter((r) => r.gatewayId === 'gw-mine-2')).toHaveLength(1);
    });

    it('will not read the tools of another organization gateway', async () => {
      await expect(
        transfer.copyToolsFromGateway('gw-foreign', 'gw-mine', ORG, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(gatewayTools.rows().filter((r) => r.gatewayId === 'gw-mine').map((r) => r.toolId)).toEqual(['tool-mine']);
    });

    it('will not write into another organization gateway', async () => {
      await expect(
        transfer.copyToolsFromGateway('gw-mine', 'gw-foreign', ORG, USER),
      ).rejects.toBeInstanceOf(NotFoundException);
      foreignRowsIntact();
    });
  });

  describe('removeTool / removeAllTools', () => {
    it('removes a tool from a gateway of the caller organization', async () => {
      await transfer.removeTool('gw-mine', 'tool-mine', ORG);
      expect(gatewayTools.row('gt-mine')).toBeUndefined();
    });

    it('will not remove a tool from another organization gateway', async () => {
      await expect(transfer.removeTool('gw-foreign', 'tool-foreign', ORG)).rejects.toBeInstanceOf(NotFoundException);
      foreignRowsIntact();
    });

    it('will not clear another organization gateway', async () => {
      await expect(transfer.removeAllTools('gw-foreign', ORG)).rejects.toBeInstanceOf(NotFoundException);
      foreignRowsIntact();
    });
  });

  describe('reads', () => {
    it('will not list the tools of another organization gateway', async () => {
      await expect(
        queries.getGatewayTools({ gatewayId: 'gw-foreign', organizationId: ORG }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('will not offer tools for another organization gateway', async () => {
      await expect(queries.getAvailableTools('gw-foreign', ORG)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('will not report usage stats for another organization gateway', async () => {
      const stats = new GatewayToolStatsHelper(gatewayTools as any, gateways as any);
      await expect(stats.getGatewayToolStats('gw-foreign', ORG)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('will not load another organization association', async () => {
      await expect(queries.getGatewayTool('gt-foreign', ORG)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('bulkAssociateTools', () => {
    it('will not associate tools onto another organization gateway', async () => {
      await expect(
        queries.bulkAssociateTools('gw-foreign', { toolIds: ['tool-mine'] }, ORG, USER, async () => undefined),
      ).rejects.toBeInstanceOf(NotFoundException);
      foreignRowsIntact();
    });
  });

  describe('dissociateTool', () => {
    it('dissociates an association of the caller organization', async () => {
      await service.dissociateTool('gt-mine', ORG, USER);
      expect(gatewayTools.row('gt-mine')).toBeUndefined();
    });

    it('will not dissociate another organization association', async () => {
      await expect(service.dissociateTool('gt-foreign', ORG, USER)).rejects.toBeInstanceOf(NotFoundException);
      foreignRowsIntact();
    });
  });
});
