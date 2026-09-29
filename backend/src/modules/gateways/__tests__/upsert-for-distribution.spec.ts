import { GatewaysService } from '../gateways.service';
import { GatewayStatus, GatewayType } from '../../../entities/gateway.entity';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * Republishing an app's place re-syncs the gateway it already answers on.
 *
 * The gateways table is a truthful fake, so the lookup by id and by
 * endpoint is evaluated, organization included. createGateway and
 * updateGateway are the service's own write paths, spied rather than
 * re-tested here.
 */
describe('GatewaysService.upsertForDistribution', () => {
  const ORG = 'org-1';
  const dto = (configuration: Record<string, any>) => ({
    name: 'Acme (web)',
    type: GatewayType.HOSTED_CHAT,
    agentId: 'agent-1',
    endpoint: '/apps/acme/web',
    configuration,
  });

  const build = (rows: any[]) => {
    const gatewayRepository = fakeRepository<any>(rows);
    const service = Object.create(GatewaysService.prototype) as GatewaysService;
    (service as any).gatewayRepository = gatewayRepository;
    const updateGateway = jest
      .spyOn(service, 'updateGateway')
      .mockImplementation(async (id: string, update: any) => ({ id, status: GatewayStatus.ACTIVE, ...update }) as any);
    const createGateway = jest.spyOn(service, 'createGateway').mockImplementation(async () => ({ id: 'gw-new' }) as any);
    return { service, updateGateway, createGateway };
  };

  it('re-syncs the gateway the place already answers on, even under another endpoint', async () => {
    const { service, updateGateway, createGateway } = build([
      { id: 'gw-adopted', organizationId: ORG, endpoint: '/support-chat', configuration: {} },
    ]);
    await service.upsertForDistribution(dto({ hostedChat: { slug: 'acme' } }), ORG, 'user-1', { activate: false, gatewayId: 'gw-adopted' });
    expect(createGateway).not.toHaveBeenCalled();
    expect(updateGateway.mock.calls[0][0]).toBe('gw-adopted');
  });

  it('does not take another organization gateway by id', async () => {
    const { service, updateGateway, createGateway } = build([
      { id: 'gw-theirs', organizationId: 'org-2', endpoint: '/x', configuration: {} },
    ]);
    await service.upsertForDistribution(dto({}), ORG, 'user-1', { activate: false, gatewayId: 'gw-theirs' });
    expect(updateGateway).not.toHaveBeenCalled();
    expect(createGateway).toHaveBeenCalled();
  });

  it('keeps the allowed sites set on the web page across a republish', async () => {
    const { service, updateGateway } = build([
      {
        id: 'gw-1',
        organizationId: ORG,
        endpoint: '/apps/acme/web',
        configuration: { allowedOrigins: ['https://www.acme.com'], hostedChat: { slug: 'old' }, stale: true },
      },
    ]);
    await service.upsertForDistribution(dto({ hostedChat: { slug: 'acme' } }), ORG, 'user-1', { activate: false });
    expect(updateGateway.mock.calls[0][1].configuration).toEqual({
      allowedOrigins: ['https://www.acme.com'],
      hostedChat: { slug: 'acme' },
    });
  });
});
