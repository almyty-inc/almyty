import { HttpException } from '@nestjs/common';

import { UnifiedEndpointController, appSurfaceSlug } from '../unified-endpoint.controller';
import { GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { ClauseModel, ExecutedQuery, RecordingQueryBuilder, matchingRows } from './recording-query-builder';

/**
 * A published app surface answers on the URL the dashboard shows for it.
 *
 * Publishing a distribution creates a gateway whose endpoint is
 * `/apps/<app>/<target>`, and the channel webhook registrar tells Telegram
 * and Twilio to call `<api>/<org>/apps/<app>/<target>`. The unified
 * controller only ever looked up `/<resourceSlug>` -- here `/apps` -- so
 * every inbound message to an app's Slack, WhatsApp or Teams surface 404'd
 * and Meta's callback verification could never succeed.
 */
describe('unified endpoint -- app surfaces', () => {
  const organization = { id: 'org-1', slug: 'acme', name: 'Acme' };
  const appGateway = {
    id: 'gw-app',
    endpoint: '/apps/support/whatsapp_cloud',
    type: GatewayType.WHATSAPP_CLOUD,
    status: GatewayStatus.ACTIVE,
    organizationId: 'org-1',
  };

  /**
   * Another organization's agents, one per lookup `resolveAgent` makes:
   * `apps` for the exact-name findOne, `APPS` for the case-insensitive
   * query. With any of their organization predicates gone, the 404 below
   * turns into this tenant being served org-2's agent. The chain that
   * stood here answered null whatever it was asked, so it could not tell.
   */
  const foreignAgents = [
    { id: 'agent-foreign-exact', organizationId: 'org-2', name: 'apps' },
    { id: 'agent-foreign-upper', organizationId: 'org-2', name: 'APPS' },
  ];
  const AGENT_CLAUSES: ClauseModel = {
    'agent.organizationId = :organizationId': (row, p) => row.organizationId === p.organizationId,
    'LOWER(agent.name) = LOWER(:name)': (row, p) => row.name.toLowerCase() === p.name.toLowerCase(),
  };

  const build = (gateways: any[]) => {
    const gatewayRepository = fakeRepository<any>(gateways);
    const agents = fakeRepository<any>(foreignAgents);
    const agentRepository = {
      findOne: agents.findOne,
      find: agents.find,
      createQueryBuilder: jest.fn(
        (alias: string) =>
          new RecordingQueryBuilder(alias, {
            getOne: (query: ExecutedQuery) => matchingRows(query, agents.rows(), AGENT_CLAUSES)[0] ?? null,
          }),
      ),
    };
    const agentHelper = { handleAgentRequest: jest.fn().mockResolvedValue('agent') };
    const delegation = { handleGatewayRequest: jest.fn().mockResolvedValue('delegated') };
    const resolver = { resolveOrganization: jest.fn().mockResolvedValue(organization) };
    const controller = new UnifiedEndpointController(
      {} as any,
      gatewayRepository as any,
      agentRepository as any,
      {} as any,
      resolver as any,
      {} as any,
      {} as any,
      {} as any,
      agentHelper as any,
      delegation as any,
    );
    return { controller, gatewayRepository, delegation, agentHelper };
  };

  const req = (path: string) => ({ method: 'GET', path, headers: {}, query: {} }) as any;

  it('routes /<org>/apps/<app>/<target> to the app surface gateway', async () => {
    const { controller, delegation } = build([appGateway]);
    const request = req('/acme/apps/support/whatsapp_cloud');
    await controller.handleSubPathRequest('acme', 'apps', request, {} as any, {});
    expect(delegation.handleGatewayRequest).toHaveBeenCalledWith(
      organization,
      appGateway,
      'acme',
      'apps/support/whatsapp_cloud',
      request,
      {},
      {},
    );
  });

  it('does not resolve another organization\'s app surface, nor its agent', async () => {
    const { controller, delegation, agentHelper } = build([{ ...appGateway, organizationId: 'org-2' }]);
    await expect(
      controller.handleSubPathRequest('acme', 'apps', req('/acme/apps/support/whatsapp_cloud'), {} as any, {}),
    ).rejects.toBeInstanceOf(HttpException);
    expect(delegation.handleGatewayRequest).not.toHaveBeenCalled();
    expect(agentHelper.handleAgentRequest).not.toHaveBeenCalled();
  });

  it('does not route to an app surface that is not active', async () => {
    const { controller, delegation } = build([{ ...appGateway, status: GatewayStatus.INACTIVE }]);
    await expect(
      controller.handleSubPathRequest('acme', 'apps', req('/acme/apps/support/whatsapp_cloud'), {} as any, {}),
    ).rejects.toBeInstanceOf(HttpException);
    expect(delegation.handleGatewayRequest).not.toHaveBeenCalled();
  });

  it('a hand-made gateway sub-path still takes exactly one lookup', async () => {
    const mcp = { ...appGateway, id: 'gw-mcp', endpoint: '/tools', type: GatewayType.MCP };
    const { controller, gatewayRepository, delegation } = build([mcp]);
    await controller.handleSubPathRequest('acme', 'tools', req('/acme/tools/manifest'), {} as any, {});
    expect(gatewayRepository.findOne).toHaveBeenCalledTimes(1);
    expect(delegation.handleGatewayRequest.mock.calls[0][3]).toBe('tools');
  });

  describe('appSurfaceSlug', () => {
    it('reads the app and target', () => {
      expect(appSurfaceSlug('/acme/apps/support/slack', 'acme', 'apps')).toBe('apps/support/slack');
      expect(appSurfaceSlug('/acme/apps/support/slack/extra', 'acme', 'apps')).toBe('apps/support/slack');
    });
    it('ignores anything that is not a full app surface path', () => {
      expect(appSurfaceSlug('/acme/apps/support', 'acme', 'apps')).toBeNull();
      expect(appSurfaceSlug('/acme/tools/x/y', 'acme', 'tools')).toBeNull();
      expect(appSurfaceSlug('/other/apps/a/b', 'acme', 'apps')).toBeNull();
    });
  });
});
