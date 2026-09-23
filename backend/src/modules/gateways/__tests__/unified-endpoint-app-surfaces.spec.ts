import { HttpException } from '@nestjs/common';

import { UnifiedEndpointController, appSurfaceSlug } from '../unified-endpoint.controller';
import { GatewayStatus, GatewayType } from '../../../entities/gateway.entity';

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

  const build = (gateways: any[]) => {
    const gatewayRepository = {
      findOne: jest.fn(async ({ where }: any) =>
        gateways.find((g) => g.endpoint === where.endpoint && g.organizationId === where.organizationId) ?? null,
      ),
    };
    const agentRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      }),
    };
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
      { handleAgentRequest: jest.fn() } as any,
      delegation as any,
    );
    return { controller, gatewayRepository, delegation };
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

  it('does not resolve another organization\'s app surface', async () => {
    const { controller, delegation } = build([{ ...appGateway, organizationId: 'org-2' }]);
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
