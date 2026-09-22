import { GatewaysService } from '../gateways.service';
import { GatewayStatus, GatewayType } from '../../../entities/gateway.entity';

/**
 * createGateway is four writes across two tables plus the credential
 * store, with `(organizationId, endpoint)` uniquely indexed. If a
 * later write failed, the caller got a 500 and believed nothing had
 * been created, but an ACTIVE row was left holding the endpoint — so
 * the gateway could neither be used (no auth config, no secrets) nor
 * recreated ("Endpoint already exists in your organization").
 */
describe('GatewaysService - createGateway leaves nothing behind when it fails', () => {
  let gatewayRepository: any;
  let init: any;
  let channelCredentials: any;

  const makeService = () =>
    new GatewaysService(
      gatewayRepository,
      {} as any, // gatewayTool repo
      {} as any, // gatewayAuth repo
      { findOne: jest.fn().mockResolvedValue({ hasPermissionInOrganization: () => true }) } as any,
      {
        findOne: jest.fn().mockResolvedValue({ id: 'org-1', canAddMoreGateways: () => true }),
      } as any,
      {} as any, // usageMetric repo
      { logCreate: jest.fn(), logUpdate: jest.fn(), computeChanges: jest.fn().mockReturnValue({}) } as any,
      {} as any, // stats helper
      init,
      {
        assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
        canAccess: jest.fn().mockResolvedValue({ allowed: true }),
      } as any,
      undefined, // discord transport
      undefined, // webhook registrar
      undefined, // email provisioner
      undefined, // envelope crypto
      channelCredentials,
    );

  const create = (service: GatewaysService) =>
    service.createGateway(
      {
        name: 'support-bot',
        type: GatewayType.TELEGRAM,
        agentId: 'agent-1',
        endpoint: '/support-bot',
        configuration: { bot_token: '123456:plain-token', aiDisclosure: true },
      } as any,
      'org-1',
      'user-1',
    );

  beforeEach(() => {
    gatewayRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((dto: any) => ({ ...dto })),
      save: jest.fn(async (g: any) => ({ ...g, id: 'gw-1' })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    init = {
      validateGatewayConfiguration: jest.fn(),
      createDefaultAuth: jest.fn().mockResolvedValue(undefined),
    };
    channelCredentials = undefined;
  });

  it('frees the endpoint when the default auth config cannot be written', async () => {
    init.createDefaultAuth = jest.fn().mockRejectedValue(new Error('auth table unavailable'));
    const service = makeService();

    await expect(create(service)).rejects.toThrow('auth table unavailable');

    expect(gatewayRepository.delete).toHaveBeenCalledWith({ id: 'gw-1' });
  });

  it('frees the endpoint and releases the credential when the secret store fails', async () => {
    channelCredentials = {
      persistSecrets: jest.fn().mockRejectedValue(new Error('credential store unavailable')),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const service = makeService();

    await expect(create(service)).rejects.toThrow('credential store unavailable');

    expect(gatewayRepository.delete).toHaveBeenCalledWith({ id: 'gw-1' });
    expect(channelCredentials.release).toHaveBeenCalled();
  });

  it('keeps the gateway when every write succeeds', async () => {
    const service = makeService();

    const gateway = await create(service);

    expect(gateway.id).toBe('gw-1');
    expect(gateway.status).toBe(GatewayStatus.ACTIVE);
    expect(gatewayRepository.delete).not.toHaveBeenCalled();
  });

  it('creates the gateway inactive when the caller asks for one that does not answer yet', async () => {
    const service = makeService();

    const gateway = await service.createGateway(
      {
        name: 'support-bot',
        type: GatewayType.TELEGRAM,
        agentId: 'agent-1',
        endpoint: '/support-bot',
        configuration: { bot_token: '123456:plain-token', aiDisclosure: true },
      } as any,
      'org-1',
      'user-1',
      GatewayStatus.INACTIVE,
    );

    expect(gateway.status).toBe(GatewayStatus.INACTIVE);
  });
});
