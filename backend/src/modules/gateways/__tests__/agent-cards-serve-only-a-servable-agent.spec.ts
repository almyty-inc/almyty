import * as crypto from 'crypto';

import { A2AAgentCardService } from '../../a2a/a2a-agent-card.service';
import { AcpDiscoveryService } from '../../acp/acp-discovery.service';
import { Agent, AgentStatus } from '../../../entities/agent.entity';
import { ApiKey } from '../../../entities/api-key.entity';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { Organization } from '../../../entities/organization.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { UnifiedEndpointController } from '../unified-endpoint.controller';
import { UnifiedGatewayDelegation } from '../unified-gateway-delegation.helper';

/**
 * A discovery card is a publication: it tells anyone who asks that this
 * gateway serves this agent, with its name, description and skills. So a
 * card is served only for an agent the gateway could actually run: active,
 * of the gateway's organization, and within the gateway's scope. A draft,
 * inactive or errored agent, another member's private agent, or a team
 * agent behind an org-wide gateway gets the same 404 an agent that does
 * not exist gets.
 *
 * The per-gateway A2A card (both well-known paths and GET /), the ACP
 * discovery document and the API-keyed root card all used to look the
 * agent up by id and organization only.
 */
describe('agent cards are served only for an active agent the gateway may serve', () => {
  const ORG = 'org-1';
  const organization = Object.assign(new Organization(), { id: ORG, slug: 'acme', name: 'Acme' });
  const agentRow = (id: string, extra: Partial<Agent> = {}) =>
    Object.assign(new Agent(), {
      id,
      name: id,
      description: `the ${id} agent`,
      organizationId: ORG,
      status: AgentStatus.ACTIVE,
      visibility: 'org',
      teamId: null,
      createdBy: 'owner-1',
      toolIds: [],
      ...extra,
    });

  const AGENTS = [
    agentRow('active'),
    agentRow('draft', { status: AgentStatus.DRAFT }),
    agentRow('inactive', { status: AgentStatus.INACTIVE }),
    agentRow('errored', { status: AgentStatus.ERROR }),
    agentRow('someones-private', { visibility: 'private', createdBy: 'someone-else' } as any),
    agentRow('team-only', { visibility: 'team', teamId: 'team-1' } as any),
    agentRow('other-org', { organizationId: 'org-2' }),
  ];

  const gatewayFor = (type: GatewayType, agentId: string): Gateway =>
    Object.assign(new Gateway(), {
      id: `gw-${type}-${agentId}`,
      organizationId: ORG,
      type,
      status: GatewayStatus.ACTIVE,
      agentId,
      visibility: 'org',
      teamId: null,
      ownerUserId: null,
      endpoint: `/${agentId}`,
      name: `${agentId} gateway`,
      authConfigs: [],
      configuration: {},
    });

  const response = () => {
    const res: any = { body: undefined, statusCode: 200 };
    res.json = jest.fn((b: any) => (res.body = b));
    res.setHeader = jest.fn();
    res.status = jest.fn((s: number) => ((res.statusCode = s), res));
    return res;
  };
  const outcome = (p: Promise<any>, res: any) =>
    p.then(
      () => ({ status: res.statusCode, name: res.body?.name ?? null }),
      (e: any) => ({ status: e.getStatus?.() ?? 500, name: null }),
    );

  const config = { get: () => 'https://api.example.com' } as any;
  let delegation: UnifiedGatewayDelegation;

  beforeEach(() => {
    const agents = fakeRepository<Agent>({ seed: AGENTS, make: () => new Agent() });
    // The request counters are bumped fire-and-forget after the answer; not under test.
    const counterBump: any = { update: () => counterBump, set: () => counterBump, where: () => counterBump, execute: async () => ({ affected: 1 }) };
    delegation = new UnifiedGatewayDelegation(
      agents as any,
      { createQueryBuilder: () => counterBump } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      new A2AAgentCardService(),
      {} as any,
      new AcpDiscoveryService(),
      config,
      { check: async () => ({ limited: false }) } as any,
      {} as any,
    );
  });

  const discover = (type: GatewayType, agentId: string, action: string, method = 'GET') => {
    const gw = gatewayFor(type, agentId);
    const res = response();
    const req: any = {
      method,
      path: `/acme${gw.endpoint}${action ? `/${action}` : ''}`,
      protocol: 'https',
      get: () => 'api.example.com',
      headers: {},
      query: {},
    };
    return outcome(delegation.handleGatewayRequest(organization, gw, 'acme', agentId, req, res, undefined), res);
  };

  const CARD_PATHS: Array<[string, GatewayType, string]> = [
    ['A2A agent-card.json', GatewayType.A2A, '.well-known/agent-card.json'],
    ['A2A agent.json', GatewayType.A2A, '.well-known/agent.json'],
    ['A2A GET /', GatewayType.A2A, ''],
    ['ACP discovery', GatewayType.ACP, '.well-known/acp'],
  ];

  describe.each(CARD_PATHS)('%s', (_label, type, action) => {
    it('serves the card of an active agent the gateway publishes', async () => {
      expect(await discover(type, 'active', action)).toMatchObject({ status: 200, name: expect.any(String) });
    });

    it.each([['draft'], ['inactive'], ['errored'], ['someones-private'], ['team-only'], ['other-org']])(
      'a %s agent gets the not-found a missing agent gets',
      async (agentId) => {
        const missing = await discover(type, 'no-such-agent', action);
        expect(missing).toEqual({ status: 404, name: null });
        expect(await discover(type, agentId, action)).toEqual(missing);
      },
    );
  });

  describe('the API-keyed root card (/.well-known/agent-card.json)', () => {
    const keyFor = (raw: string) => crypto.createHash('sha256').update(raw).digest('hex');
    let controller: UnifiedEndpointController;

    beforeEach(() => {
      const gateways = fakeRepository<Gateway>({
        make: () => new Gateway(),
        seed: AGENTS.map((a) => gatewayFor(GatewayType.A2A, a.id)),
      });
      const apiKeys = fakeRepository<ApiKey>({
        make: () => new ApiKey(),
        seed: AGENTS.map((a) => ({
          id: `k-${a.id}`,
          keyHash: keyFor(`key-${a.id}`),
          gatewayId: `gw-${GatewayType.A2A}-${a.id}`,
          organizationId: ORG,
          userId: 'user-1',
          isActive: true,
          expiresAt: null,
        })) as any,
      });
      controller = new UnifiedEndpointController(
        fakeRepository<Organization>({ seed: [organization], make: () => new Organization() }) as any,
        gateways as any,
        fakeRepository<Agent>({ seed: AGENTS, make: () => new Agent() }) as any,
        apiKeys as any,
        {} as any,
        {} as any,
        new A2AAgentCardService(),
        config,
        {} as any,
        {} as any,
      );
    });

    const rootCard = (agentId: string) => {
      const res = response();
      const req: any = { method: 'GET', headers: { 'x-api-key': `key-${agentId}` }, query: {}, protocol: 'https', get: () => 'api.example.com' };
      return outcome(controller.handleRootAgentCard(req, res), res);
    };

    it('serves the card of an active agent', async () => {
      expect(await rootCard('active')).toEqual({ status: 200, name: expect.any(String) });
    });

    it.each([['draft'], ['inactive'], ['errored'], ['someones-private'], ['team-only']])(
      'a %s agent is not found',
      async (agentId) => {
        expect(await rootCard(agentId)).toEqual({ status: 404, name: null });
      },
    );
  });
});
