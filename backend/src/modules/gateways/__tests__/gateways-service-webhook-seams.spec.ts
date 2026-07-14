import { GatewaysService } from '../gateways.service';
import { Gateway, GatewayStatus, GatewayType } from '../../../entities/gateway.entity';

/**
 * GatewaysService -> ChannelWebhookRegistrar seams. The registrar is
 * @Optional() and fire-and-forget: activate/deactivate/update must
 * call sync() with the persisted gateway, delete must call remove(),
 * and a rejecting registrar must never fail the CRUD operation.
 */
describe('GatewaysService — channel webhook registration seams', () => {
  let gatewayRepository: any;
  let accessPolicy: any;
  let auditLogService: any;
  let registrar: { sync: jest.Mock; remove: jest.Mock };
  let discordTransport: { sync: jest.Mock; stop: jest.Mock };

  const gateway = (over: Partial<Gateway> = {}): Gateway =>
    ({
      id: 'gw-1',
      name: 'tg-bot',
      type: GatewayType.TELEGRAM,
      status: GatewayStatus.INACTIVE,
      organizationId: 'org-1',
      endpoint: '/tg-bot',
      configuration: { bot_token: 't' },
      isSystem: false,
      ...over,
    } as unknown as Gateway);

  const makeService = () =>
    new GatewaysService(
      gatewayRepository,
      {} as any, // gatewayTool repo
      {} as any, // gatewayAuth repo
      {} as any, // user repo
      {} as any, // organization repo
      {} as any, // usageMetric repo
      auditLogService,
      {} as any, // stats helper
      {} as any, // init helper
      accessPolicy,
      discordTransport as any,
      registrar as any,
    );

  beforeEach(() => {
    gatewayRepository = {
      findOne: jest.fn(),
      save: jest.fn(async (g: Gateway) => g),
      remove: jest.fn(async (g: Gateway) => g),
    };
    accessPolicy = { canAccess: jest.fn().mockResolvedValue({ allowed: true }) };
    auditLogService = {
      log: jest.fn(),
      logDelete: jest.fn(),
      logUpdate: jest.fn(),
      logCreate: jest.fn(),
      computeChanges: jest.fn().mockReturnValue({}),
    };
    registrar = {
      sync: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    discordTransport = { sync: jest.fn(), stop: jest.fn() };
  });

  it('activateGateway syncs the webhook registration with the activated gateway', async () => {
    gatewayRepository.findOne.mockResolvedValue(gateway());
    const service = makeService();

    await service.activateGateway('gw-1', 'org-1', 'user-1');

    expect(registrar.sync).toHaveBeenCalledTimes(1);
    expect(registrar.sync.mock.calls[0][0]).toMatchObject({
      id: 'gw-1',
      status: GatewayStatus.ACTIVE,
    });
  });

  it('deactivateGateway syncs with the deactivated gateway (-> unregister path)', async () => {
    gatewayRepository.findOne.mockResolvedValue(gateway({ status: GatewayStatus.ACTIVE }));
    const service = makeService();

    await service.deactivateGateway('gw-1', 'org-1', 'user-1');

    expect(registrar.sync).toHaveBeenCalledTimes(1);
    expect(registrar.sync.mock.calls[0][0]).toMatchObject({
      id: 'gw-1',
      status: GatewayStatus.INACTIVE,
    });
  });

  it('deleteGateway removes the webhook registration', async () => {
    gatewayRepository.findOne.mockResolvedValue(gateway({ status: GatewayStatus.ACTIVE }));
    const service = makeService();

    await service.deleteGateway('gw-1', 'org-1', 'user-1');

    expect(registrar.remove).toHaveBeenCalledTimes(1);
  });

  it('a rejecting registrar never fails the CRUD call (fire-and-forget)', async () => {
    gatewayRepository.findOne.mockResolvedValue(gateway());
    registrar.sync.mockRejectedValue(new Error('twilio down'));
    const service = makeService();

    await expect(service.activateGateway('gw-1', 'org-1', 'user-1')).resolves.toMatchObject({
      status: GatewayStatus.ACTIVE,
    });
  });

  it('constructs and operates without a registrar (optional dependency)', async () => {
    gatewayRepository.findOne.mockResolvedValue(gateway());
    const service = new GatewaysService(
      gatewayRepository,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      auditLogService,
      {} as any,
      {} as any,
      accessPolicy,
    );

    await expect(service.activateGateway('gw-1', 'org-1', 'user-1')).resolves.toMatchObject({
      status: GatewayStatus.ACTIVE,
    });
  });
});
